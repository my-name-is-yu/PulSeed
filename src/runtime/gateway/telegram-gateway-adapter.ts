import * as fs from "node:fs";
import * as path from "node:path";
import type { ChannelAdapter, EnvelopeHandler, TypingIndicatorCapability } from "./channel-adapter.js";
import { dispatchGatewayChatInput } from "./chat-session-dispatch.js";
import { formatTelegramNotification, supportsCoreGatewayNotification } from "./core-channel-notification.js";
import { writeJsonFileAtomic } from "../../base/utils/json-io.js";
import { buildChannelPolicyMetadata, buildExternalSurfaceDecision, evaluateChannelAccess, resolveChannelRoute } from "./channel-policy.js";
import { createRefreshingTypingIndicator, withTypingIndicator } from "./typing-indicator.js";
import { TELEGRAM_GATEWAY_DISPLAY_CONTRACT, createGatewayDisplayPolicy } from "./channel-display-policy.js";
import { NonTuiDisplayProjector, type NonTuiDisplayMessageRef, type NonTuiDisplayTransport } from "./non-tui-display-projector.js";
import type { INotifier, NotificationEvent, NotificationEventType } from "../../base/types/plugin.js";
import type { ChatEvent } from "../../interface/chat/chat-events.js";

const BACKOFF_STEPS_MS = [5_000, 10_000, 20_000, 40_000, 60_000];
const TELEGRAM_INTEGER_ID_TOKEN = /^-?(?:0|[1-9]\d*)$/;
const MIN_POLLING_TIMEOUT_SECONDS = 1;
const MAX_POLLING_TIMEOUT_SECONDS = 60;

function parseTelegramIntegerId(value: string): number | null {
  const normalized = value.trim();
  if (!TELEGRAM_INTEGER_ID_TOKEN.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseTelegramMessageRef(ref: NonTuiDisplayMessageRef): number {
  const messageId = parseTelegramIntegerId(ref.id);
  if (messageId === null) {
    throw new Error(`telegram-display: invalid message reference "${ref.id}"`);
  }
  return messageId;
}

export interface TelegramGatewayConfig {
  bot_token: string;
  chat_id?: number;
  allowed_user_ids: number[];
  denied_user_ids: number[];
  allowed_chat_ids: number[];
  denied_chat_ids: number[];
  runtime_control_allowed_user_ids: number[];
  chat_goal_map: Record<string, string>;
  user_goal_map: Record<string, string>;
  default_goal_id?: string;
  allow_all: boolean;
  polling_timeout: number;
  identity_key?: string;
}

export class TelegramGatewayNotifier implements INotifier {
  readonly name = "telegram-bot";

  constructor(
    private readonly api: TelegramAPI,
    private readonly homeChatStore: TelegramHomeChatStore
  ) {}

  supports(eventType: NotificationEventType): boolean {
    return supportsCoreGatewayNotification(eventType);
  }

  async notify(event: NotificationEvent): Promise<void> {
    const chatId = this.homeChatStore.get();
    if (chatId === undefined) {
      throw new Error("telegram-bot: no home chat configured. Send /sethome from the target Telegram chat.");
    }
    await this.api.sendMessage(chatId, formatTelegramNotification(event));
  }
}

export class TelegramGatewayAdapter implements ChannelAdapter {
  readonly name = "telegram";
  readonly typingIndicator: TypingIndicatorCapability;
  readonly displayContract = TELEGRAM_GATEWAY_DISPLAY_CONTRACT;

  private handler: EnvelopeHandler | null = null;
  private readonly api: TelegramAPI;
  private readonly config: TelegramGatewayConfig;
  private readonly pluginDir: string;
  private readonly homeChatStore: TelegramHomeChatStore;
  private readonly notifier: TelegramGatewayNotifier;
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private handlingUpdate = false;
  private offset = 0;

  constructor(pluginDir: string, config: TelegramGatewayConfig) {
    this.pluginDir = pluginDir;
    this.config = config;
    this.api = new TelegramAPI(config.bot_token);
    this.typingIndicator = createRefreshingTypingIndicator({
      intervalMs: 4_000,
      refresh: async (context) => {
        const chatId = parseTelegramIntegerId(context.conversation_id);
        if (chatId === null) return;
        await this.api.sendChatAction(chatId, "typing");
      },
      onError: (err) => console.warn("TelegramGatewayAdapter: typing indicator failed", err),
    });
    this.homeChatStore = new TelegramHomeChatStore(pluginDir, config.chat_id);
    this.notifier = new TelegramGatewayNotifier(this.api, this.homeChatStore);
  }

  static fromConfigDir(configDir: string): TelegramGatewayAdapter {
    return new TelegramGatewayAdapter(configDir, loadTelegramGatewayConfig(configDir));
  }

  getNotifier(): INotifier {
    return this.notifier;
  }

  onEnvelope(handler: EnvelopeHandler): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    if (this.running) return;
    await this.api.getMe();
    this.running = true;
    this.loopPromise = this.loop().catch(() => undefined);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.handlingUpdate) return;
    await this.loopPromise;
    this.loopPromise = null;
  }

  private async loop(): Promise<void> {
    let backoffIndex = 0;
    while (this.running) {
      try {
        const updates = await this.api.getUpdates(this.offset, this.config.polling_timeout);
        backoffIndex = 0;
        for (const update of updates) {
          this.offset = update.update_id + 1;
          const msg = update.message;
          if (!msg?.text) continue;
          const fromId = msg.from?.id;
          const chatId = msg.chat?.id;
          if (!Number.isInteger(fromId) || !Number.isInteger(chatId)) continue;
          if (this.config.denied_user_ids.includes(fromId)) continue;
          if (this.config.denied_chat_ids.includes(chatId)) continue;
          if (this.config.allowed_chat_ids.length > 0 && !this.config.allowed_chat_ids.includes(chatId)) continue;
          this.handlingUpdate = true;
          try {
            if (this.isFirstHomeBindingCommand(msg.text, fromId)) {
              await this.recordHealth({ last_inbound_at: new Date().toISOString(), last_error: null });
              await this.processMessage(msg.text, fromId, chatId, msg.message_id);
              continue;
            }
            if (!this.config.allow_all && !this.config.allowed_user_ids.includes(fromId)) continue;
            await this.recordHealth({ last_inbound_at: new Date().toISOString(), last_error: null });
            await this.processMessage(msg.text, fromId, chatId, msg.message_id);
          } finally {
            this.handlingUpdate = false;
          }
        }
      } catch (err) {
        await this.recordHealth({ last_error: err instanceof Error ? err.message : String(err) });
        if (!this.running) break;
        const delay = BACKOFF_STEPS_MS[Math.min(backoffIndex, BACKOFF_STEPS_MS.length - 1)];
        backoffIndex++;
        await sleep(delay);
      }
    }
  }

  private async processMessage(text: string, fromUserId: number, chatId: number, messageId: number): Promise<void> {
    const normalized = text.trim().toLowerCase();
    if (normalized === "/sethome" || normalized.startsWith("/sethome@")) {
      const firstBinding = this.config.allowed_user_ids.length === 0 && this.config.chat_id === undefined && !this.config.allow_all;
      await this.homeChatStore.set(chatId, firstBinding ? fromUserId : undefined);
      this.config.chat_id = chatId;
      if (firstBinding) this.config.allowed_user_ids.push(fromUserId);
      await this.api.sendPlainMessage(
        chatId,
        firstBinding
          ? "This chat is now the home channel for PulSeed notifications, and this Telegram user is allowed for normal chat. Runtime control still requires its own allow list."
          : "This chat is now the home channel for PulSeed notifications."
      );
      await this.recordHealth({ last_outbound_at: new Date().toISOString(), last_error: null });
      return;
    }

    const eventAdapter = new TelegramChatEventAdapter(this.api, chatId);
    const context = {
      platform: "telegram",
      senderId: String(fromUserId),
      conversationId: String(chatId),
      channelId: String(chatId),
    };
    const route = resolveChannelRoute(
      {
        identityKey: this.config.identity_key,
        conversationGoalMap: this.config.chat_goal_map,
        senderGoalMap: this.config.user_goal_map,
        defaultGoalId: this.config.default_goal_id,
      },
      context
    );
    const access = evaluateChannelAccess(
      {
        allowedSenderIds: this.config.allow_all ? undefined : this.config.allowed_user_ids.map(String),
        deniedSenderIds: this.config.denied_user_ids.map(String),
        allowedConversationIds: this.config.allowed_chat_ids.map(String),
        deniedConversationIds: this.config.denied_chat_ids.map(String),
        runtimeControlAllowedSenderIds: this.config.runtime_control_allowed_user_ids.map(String),
      },
      context
    );
    if (!access.allowed) {
      return;
    }
    const externalSurface = buildExternalSurfaceDecision(context, access, route);

    const reply = await withTypingIndicator(
      this.typingIndicator,
      {
        platform: "telegram",
        conversation_id: String(chatId),
        sender_id: String(fromUserId),
        message_id: String(messageId),
      },
      () => dispatchGatewayChatInput({
        text,
        platform: "telegram",
        identity_key: route.identityKey ?? this.config.identity_key,
        conversation_id: String(chatId),
        sender_id: String(fromUserId),
        message_id: String(messageId),
        goal_id: route.goalId,
        cwd: process.cwd(),
        onEvent: (event) => eventAdapter.handle(event as unknown as ChatEvent),
        externalSurface,
        metadata: {
          ...buildChannelPolicyMetadata(context, access, route, externalSurface),
          chat_id: chatId,
          ...(route.goalId ? { goal_id: route.goalId } : {}),
        },
      })
    );

    if (!eventAdapter.renderedAssistantOutput) {
      await eventAdapter.sendFinalFallback(reply ?? "Received.");
    }
    await this.recordHealth({ last_outbound_at: new Date().toISOString(), last_error: null });
  }

  private isFirstHomeBindingCommand(text: string, fromUserId: number): boolean {
    const normalized = text.trim().toLowerCase();
    return (normalized === "/sethome" || normalized.startsWith("/sethome@"))
      && !this.config.allow_all
      && this.config.chat_id === undefined
      && this.config.allowed_user_ids.length === 0
      && !this.config.denied_user_ids.includes(fromUserId);
  }

  private async recordHealth(update: Partial<{ last_inbound_at: string; last_outbound_at: string; last_error: string | null }>): Promise<void> {
    const healthPath = path.join(this.pluginDir, "health.json");
    let current: Record<string, unknown> = {};
    try {
      current = JSON.parse(fs.readFileSync(healthPath, "utf-8")) as Record<string, unknown>;
    } catch {
      current = {};
    }
    await writeJsonFileAtomic(healthPath, {
      ...current,
      ...update,
      updated_at: new Date().toISOString(),
    });
  }
}

interface TelegramMessage {
  message_id: number;
  from: { id: number };
  chat: { id: number };
  text?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

interface SendMessageResult {
  message_id: number;
}

class TelegramAPI {
  private readonly baseUrl: string;

  constructor(botToken: string) {
    this.baseUrl = `https://api.telegram.org/bot${botToken}`;
  }

  async getMe(): Promise<unknown> {
    return this.call("getMe");
  }

  async getUpdates(offset: number, timeout: number): Promise<TelegramUpdate[]> {
    return this.call("getUpdates", {
      offset,
      timeout,
      allowed_updates: ["message"],
    });
  }

  async sendMessage(chatId: number, text: string): Promise<void> {
    await this.sendMessageInternal(chatId, text, "Markdown");
  }

  async sendPlainMessage(chatId: number, text: string): Promise<number> {
    return this.sendMessageInternal(chatId, text, null);
  }

  async sendChatAction(chatId: number, action: "typing"): Promise<void> {
    await this.call("sendChatAction", {
      chat_id: chatId,
      action,
    });
  }

  async editMessageText(chatId: number, messageId: number, text: string): Promise<void> {
    const chunks = splitMessage(text, 4096);
    if (chunks.length === 0) return;
    await this.call("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: chunks[0],
    });
    for (const chunk of chunks.slice(1)) {
      await this.call("sendMessage", {
        chat_id: chatId,
        text: chunk,
      });
    }
  }

  async deleteMessage(chatId: number, messageId: number): Promise<void> {
    await this.call("deleteMessage", {
      chat_id: chatId,
      message_id: messageId,
    });
  }

  private async sendMessageInternal(chatId: number, text: string, parseMode: "Markdown" | null): Promise<number> {
    const chunks = splitMessage(text, 4096);
    let firstMessageId = -1;
    for (const [index, chunk] of chunks.entries()) {
      const result = await this.call<SendMessageResult>("sendMessage", {
        chat_id: chatId,
        text: chunk,
        ...(parseMode ? { parse_mode: parseMode } : {}),
      });
      if (index === 0) {
        firstMessageId = result.message_id;
      }
    }
    return firstMessageId;
  }

  private async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${this.baseUrl}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: params !== undefined ? JSON.stringify(params) : undefined,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "(unreadable)");
      throw new Error(`telegram-api: ${method} returned ${response.status}: ${body}`);
    }
    const json = (await response.json()) as { ok: boolean; result: T; description?: string };
    if (!json.ok) {
      throw new Error(`telegram-api: ${method} error: ${json.description ?? "unknown"}`);
    }
    return json.result;
  }
}

class TelegramHomeChatStore {
  private readonly configPath: string;
  private chatId: number | undefined;

  constructor(pluginDir: string, initialChatId?: number) {
    this.configPath = path.join(pluginDir, "config.json");
    this.chatId = initialChatId;
  }

  get(): number | undefined {
    return this.chatId;
  }

  async set(chatId: number, firstAllowedUserId?: number): Promise<void> {
    this.chatId = chatId;
    let current: Record<string, unknown> = {};
    try {
      current = JSON.parse(fs.readFileSync(this.configPath, "utf-8")) as Record<string, unknown>;
    } catch {
      current = {};
    }
    current["chat_id"] = chatId;
    if (firstAllowedUserId !== undefined && !Array.isArray(current["allowed_user_ids"])) {
      current["allowed_user_ids"] = [firstAllowedUserId];
    } else if (firstAllowedUserId !== undefined) {
      const ids = current["allowed_user_ids"] as unknown[];
      if (!ids.includes(firstAllowedUserId)) current["allowed_user_ids"] = [...ids, firstAllowedUserId];
    }
    await writeJsonFileAtomic(this.configPath, current);
  }
}

class TelegramChatEventAdapter {
  private readonly projector: NonTuiDisplayProjector;

  constructor(
    private readonly api: TelegramAPI,
    private readonly chatId: number
  ) {
    this.projector = new NonTuiDisplayProjector({
      display: {
        capabilities: TELEGRAM_GATEWAY_DISPLAY_CONTRACT.capabilities,
        policy: {
          ...createGatewayDisplayPolicy(TELEGRAM_GATEWAY_DISPLAY_CONTRACT.capabilities),
          progressSurface: "editable",
          finalSurface: "edit_stream",
          cleanupPolicy: "delete",
        },
      },
      transport: new TelegramDisplayTransport(api, chatId),
    });
  }

  get renderedAssistantOutput(): boolean {
    return this.projector.renderedAssistantOutput;
  }

  async handle(event: ChatEvent): Promise<void> {
    if (event.type === "operation_progress" && event.item.metadata?.["source"] === "agent_timeline_activity_summary") return;
    if (event.type === "agent_timeline" && event.item.visibility !== "user") return;
    await this.projector.handle(event);
  }

  async sendFinalFallback(text: string): Promise<void> {
    if (!text.trim()) return;
    await this.projector.handle({
      type: "assistant_final",
      runId: "fallback",
      turnId: "fallback",
      createdAt: new Date().toISOString(),
      text,
      persisted: false,
    });
  }
}

class TelegramDisplayTransport implements NonTuiDisplayTransport {
  constructor(
    private readonly api: TelegramAPI,
    private readonly chatId: number,
  ) {}

  async sendProgress(text: string): Promise<NonTuiDisplayMessageRef> {
    const messageId = await this.api.sendPlainMessage(this.chatId, text);
    return { id: String(messageId) };
  }

  async editProgress(ref: NonTuiDisplayMessageRef, text: string): Promise<void> {
    await this.api.editMessageText(this.chatId, parseTelegramMessageRef(ref), text);
  }

  async deleteProgress(ref: NonTuiDisplayMessageRef): Promise<void> {
    await this.api.deleteMessage(this.chatId, parseTelegramMessageRef(ref));
  }

  async sendFinal(text: string): Promise<NonTuiDisplayMessageRef> {
    const messageId = await this.api.sendPlainMessage(this.chatId, text);
    return { id: String(messageId) };
  }

  async editFinal(ref: NonTuiDisplayMessageRef, text: string): Promise<void> {
    await this.api.editMessageText(this.chatId, parseTelegramMessageRef(ref), text);
  }
}

function loadTelegramGatewayConfig(pluginDir: string): TelegramGatewayConfig {
  const raw = JSON.parse(fs.readFileSync(path.join(pluginDir, "config.json"), "utf-8")) as Record<string, unknown>;
  const allowedUserIds = raw["allowed_user_ids"] ?? [];
  const deniedUserIds = raw["denied_user_ids"] ?? raw["deny_from"] ?? [];
  const allowedChatIds = raw["allowed_chat_ids"] ?? [];
  const deniedChatIds = raw["denied_chat_ids"] ?? [];
  const runtimeControlAllowedUserIds = raw["runtime_control_allowed_user_ids"] ?? [];
  const allowAll = raw["allow_all"] ?? false;
  const pollingTimeout = raw["polling_timeout"] ?? 30;
  const chatGoalMap = raw["chat_goal_map"] ?? raw["goal_routes"] ?? {};
  const userGoalMap = raw["user_goal_map"] ?? {};

  assertNonEmptyString(raw["bot_token"], "telegram-bot: bot_token must be a non-empty string");
  if (raw["chat_id"] !== undefined) {
    assertInteger(raw["chat_id"], "telegram-bot: chat_id must be a safe integer when set");
  }
  assertIntegerArray(allowedUserIds, "telegram-bot: allowed_user_ids must be an array of safe integers");
  assertIntegerArray(deniedUserIds, "telegram-bot: denied_user_ids must be an array of safe integers");
  assertIntegerArray(allowedChatIds, "telegram-bot: allowed_chat_ids must be an array of safe integers");
  assertIntegerArray(deniedChatIds, "telegram-bot: denied_chat_ids must be an array of safe integers");
  assertIntegerArray(runtimeControlAllowedUserIds, "telegram-bot: runtime_control_allowed_user_ids must be an array of safe integers");
  if (typeof allowAll !== "boolean") {
    throw new Error("telegram-bot: allow_all must be a boolean");
  }
  assertIntegerInRange(
    pollingTimeout,
    MIN_POLLING_TIMEOUT_SECONDS,
    MAX_POLLING_TIMEOUT_SECONDS,
    `telegram-bot: polling_timeout must be a safe integer between ${MIN_POLLING_TIMEOUT_SECONDS} and ${MAX_POLLING_TIMEOUT_SECONDS}`,
  );
  if (raw["identity_key"] !== undefined) {
    assertNonEmptyString(raw["identity_key"], "telegram-bot: identity_key must be a non-empty string when set");
  }
  assertGoalMap(chatGoalMap, "telegram-bot: chat_goal_map must map IDs to goal IDs");
  assertGoalMap(userGoalMap, "telegram-bot: user_goal_map must map IDs to goal IDs");
  if (raw["default_goal_id"] !== undefined) {
    assertNonEmptyString(raw["default_goal_id"], "telegram-bot: default_goal_id must be a non-empty string when set");
  }

  return {
    bot_token: raw["bot_token"] as string,
    chat_id: raw["chat_id"] as number | undefined,
    allowed_user_ids: allowedUserIds as number[],
    denied_user_ids: deniedUserIds as number[],
    allowed_chat_ids: allowedChatIds as number[],
    denied_chat_ids: deniedChatIds as number[],
    runtime_control_allowed_user_ids: runtimeControlAllowedUserIds as number[],
    chat_goal_map: chatGoalMap as Record<string, string>,
    user_goal_map: userGoalMap as Record<string, string>,
    default_goal_id: raw["default_goal_id"] as string | undefined,
    allow_all: allowAll as boolean,
    polling_timeout: pollingTimeout as number,
    identity_key: raw["identity_key"] as string | undefined,
  };
}

function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    const slice = remaining.slice(0, maxLen);
    const lastNewline = slice.lastIndexOf("\n");
    const splitAt = lastNewline > 0 ? lastNewline + 1 : maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertNonEmptyString(value: unknown, message: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(message);
  }
}

function assertInteger(value: unknown, message: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(message);
  }
}

function assertIntegerInRange(
  value: unknown,
  min: number,
  max: number,
  message: string,
): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(message);
  }
}

function assertIntegerArray(value: unknown, message: string): asserts value is number[] {
  if (!Array.isArray(value) || !value.every((item) => Number.isSafeInteger(item))) {
    throw new Error(message);
  }
}

function assertGoalMap(value: unknown, message: string): asserts value is Record<string, string> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !Object.values(value).every((goalId) => typeof goalId === "string" && goalId.length > 0)
  ) {
    throw new Error(message);
  }
}
