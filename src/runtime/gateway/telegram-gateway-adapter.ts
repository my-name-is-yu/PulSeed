import * as path from "node:path";
import type { ChannelAdapter, EnvelopeHandler, TypingIndicatorCapability } from "./channel-adapter.js";
import { loadGatewayConfigJson } from "./config-json.js";
import {
  GATEWAY_CHAT_DISPATCH_FAILURE_MESSAGE,
  dispatchGatewayChatInputResult,
  formatGatewayChatDispatchFailure,
} from "./chat-session-dispatch.js";
import { formatTelegramNotification, supportsCoreGatewayNotification } from "./core-channel-notification.js";
import { buildChannelPolicyMetadata, buildExternalSurfaceDecision, evaluateChannelAccess, resolveChannelRoute } from "./channel-policy.js";
import { createRefreshingTypingIndicator } from "./typing-indicator.js";
import { TELEGRAM_GATEWAY_DISPLAY_CONTRACT, createGatewayDisplayPolicy } from "./channel-display-policy.js";
import { TELEGRAM_SEEDY_PRESENCE_CONTRACT, resolveGatewayChannelPresenceContract } from "./channel-presence-policy.js";
import { NonTuiDisplayProjector, type NonTuiDisplayMessageRef, type NonTuiDisplayTransport } from "./non-tui-display-projector.js";
import { SeedyPresenceProjector, createSeedyPresenceTransportFromNonTuiDisplay, type SeedyPresenceTransport } from "./seedy-presence-projector.js";
import { PluginChannelRuntimeStateStore, type GatewayChannelTimingSnapshot } from "../store/plugin-channel-runtime-state-store.js";
import type { INotifier, NotificationEvent, NotificationEventType } from "../../base/types/plugin.js";
import type { ChatEvent } from "../../interface/chat/chat-events.js";
import { createUserVisibleSeedyTurnPresence } from "../../interface/chat/seedy-turn-presence.js";

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

interface TelegramGatewayRuntimeOptions {
  channelName?: string;
  runtimeStateStore?: PluginChannelRuntimeStateStore;
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
  readonly presenceContract = TELEGRAM_SEEDY_PRESENCE_CONTRACT;

  private handler: EnvelopeHandler | null = null;
  private readonly api: TelegramAPI;
  private readonly config: TelegramGatewayConfig;
  private readonly channelName: string;
  private readonly runtimeStateStore: PluginChannelRuntimeStateStore;
  private readonly timing: TelegramGatewayTimingRecorder;
  private readonly homeChatStore: TelegramHomeChatStore;
  private readonly notifier: TelegramGatewayNotifier;
  private running = false;
  private loopPromise: Promise<void> | null = null;
  private handlingUpdate = false;
  private offset = 0;

  constructor(pluginDir: string, config: TelegramGatewayConfig, options: TelegramGatewayRuntimeOptions = {}) {
    this.config = config;
    this.channelName = options.channelName ?? inferGatewayChannelName(pluginDir);
    this.runtimeStateStore = options.runtimeStateStore ?? new PluginChannelRuntimeStateStore(inferGatewayRuntimeBaseDir(pluginDir));
    this.timing = new TelegramGatewayTimingRecorder(this.name);
    this.api = new TelegramAPI(config.bot_token);
    this.typingIndicator = createRefreshingTypingIndicator({
      intervalMs: 4_000,
      refresh: async (context) => {
        const chatId = parseTelegramIntegerId(context.conversation_id);
        if (chatId === null) return;
        try {
          await this.timing.recordOutbound("typing", () => this.api.sendChatAction(chatId, "typing"));
        } finally {
          await this.recordTiming();
        }
      },
      onError: (err) => console.warn("TelegramGatewayAdapter: typing indicator failed", err),
    });
    this.homeChatStore = new TelegramHomeChatStore(this.channelName, this.runtimeStateStore, config.chat_id);
    this.notifier = new TelegramGatewayNotifier(this.api, this.homeChatStore);
  }

  static fromConfigDir(configDir: string): TelegramGatewayAdapter {
    return new TelegramGatewayAdapter(configDir, loadTelegramGatewayConfig(configDir), {
      channelName: inferGatewayChannelName(configDir),
      runtimeStateStore: new PluginChannelRuntimeStateStore(inferGatewayRuntimeBaseDir(configDir)),
    });
  }

  getNotifier(): INotifier {
    return this.notifier;
  }

  onEnvelope(handler: EnvelopeHandler): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    if (this.running) return;
    await this.homeChatStore.load();
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
        const poll = this.timing.beginPoll(this.offset, this.config.polling_timeout);
        const updates = await this.api.getUpdates(this.offset, this.config.polling_timeout);
        this.timing.completePoll(poll, { updateCount: updates.length, ok: true });
        await this.recordTiming();
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
              await this.processMessage(msg.text, fromId, chatId, msg.message_id, update.update_id);
              continue;
            }
            if (!this.config.allow_all && !this.effectiveAllowedUserIds().includes(fromId)) continue;
            await this.recordHealth({ last_inbound_at: new Date().toISOString(), last_error: null });
            await this.processMessage(msg.text, fromId, chatId, msg.message_id, update.update_id);
          } finally {
            this.handlingUpdate = false;
          }
        }
      } catch (err) {
        this.timing.completeOpenPoll({ ok: false, error: err });
        await this.recordHealth({
          last_error: err instanceof Error ? err.message : String(err),
          last_timing: this.timing.snapshot(),
        });
        if (!this.running) break;
        const delay = BACKOFF_STEPS_MS[Math.min(backoffIndex, BACKOFF_STEPS_MS.length - 1)];
        backoffIndex++;
        await sleep(delay);
      }
    }
  }

  private async processMessage(text: string, fromUserId: number, chatId: number, messageId: number, updateId?: number): Promise<void> {
    this.timing.beginTurn({ updateId, messageId });
    await this.recordTiming();
    const normalized = text.trim().toLowerCase();
    if (normalized === "/sethome" || normalized.startsWith("/sethome@")) {
      const firstBinding = this.config.allowed_user_ids.length === 0 && this.homeChatStore.get() === undefined && !this.config.allow_all;
      await this.homeChatStore.set(chatId, firstBinding ? fromUserId : undefined);
      await this.timing.recordOutbound("sethome_send", () => this.api.sendPlainMessage(
        chatId,
        firstBinding
          ? "This chat is now the home channel for PulSeed notifications, and this Telegram user is allowed for normal chat. Runtime control still requires its own allow list."
          : "This chat is now the home channel for PulSeed notifications."
      ));
      this.timing.markLifecycleEnd();
      await this.recordTiming();
      await this.recordHealth({ last_outbound_at: new Date().toISOString(), last_error: null });
      return;
    }

    const eventAdapter = new TelegramChatEventAdapter(this.api, chatId, this.timing, () => this.recordTiming());
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
        allowedSenderIds: this.config.allow_all ? undefined : this.effectiveAllowedUserIds().map(String),
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

    const presenceProjector = new SeedyPresenceProjector({
      presence: resolveGatewayChannelPresenceContract(this.presenceContract),
      transport: eventAdapter.presenceTransport,
      typingIndicator: this.typingIndicator,
      typingContext: {
        platform: "telegram",
        conversation_id: String(chatId),
        sender_id: String(fromUserId),
        message_id: String(messageId),
      },
      onError: (error, operation) => console.warn("TelegramGatewayAdapter: presence projector failed", { operation, error }),
    });

    let reply: string | null = null;
    let dispatchCompleted = false;
    let dispatchError: unknown = null;
    try {
      await presenceProjector.update(createUserVisibleSeedyTurnPresence({
        turn_id: `telegram:${chatId}:${messageId}`,
        phase: "received",
      }));
      const dispatchResult = await dispatchGatewayChatInputResult({
        text,
        platform: "telegram",
        identity_key: route.identityKey ?? this.config.identity_key,
        conversation_id: String(chatId),
        sender_id: String(fromUserId),
        message_id: String(messageId),
        goal_id: route.goalId,
        cwd: process.cwd(),
        onEvent: async (event) => {
          const chatEvent = event as unknown as ChatEvent;
          const shouldRender = eventAdapter.shouldRender(chatEvent);
          if (shouldRender) {
            await presenceProjector.prepareForEvent(chatEvent);
            await eventAdapter.handle(chatEvent);
          }
          await presenceProjector.handle(chatEvent, {
            assistantOutputRendered: eventAdapter.deliveredAssistantOutput,
            meaningfulProgressRendered: eventAdapter.deliveredProgressOutput,
          });
        },
        externalSurface,
        metadata: {
          ...buildChannelPolicyMetadata(context, access, route, externalSurface),
          chat_id: chatId,
          ...(route.goalId ? { goal_id: route.goalId } : {}),
        },
      });
      if (dispatchResult.status === "ok") {
        reply = dispatchResult.text;
      } else {
        reply = formatGatewayChatDispatchFailure(dispatchResult.error);
        dispatchError = dispatchResult.error;
      }
      dispatchCompleted = true;
    } catch (error) {
      dispatchError = error;
      reply = formatGatewayChatDispatchFailure(error instanceof Error ? error.message : String(error));
      dispatchCompleted = true;
    } finally {
      try {
        if (dispatchCompleted && !eventAdapter.renderedAssistantOutput) {
          const fallbackText = reply ?? GATEWAY_CHAT_DISPATCH_FAILURE_MESSAGE;
          await presenceProjector.prepareForEvent({
            type: "assistant_final",
            runId: "fallback",
            turnId: "fallback",
            createdAt: new Date().toISOString(),
            text: fallbackText,
            persisted: false,
          });
          await eventAdapter.sendFinalFallback(fallbackText);
        }
      } finally {
        await presenceProjector.stop();
      }
    }
    this.timing.markLifecycleEnd();
    await this.recordTiming();
    await this.recordHealth({
      last_outbound_at: new Date().toISOString(),
      last_error: reply === null
        ? GATEWAY_CHAT_DISPATCH_FAILURE_MESSAGE
        : dispatchError instanceof Error
          ? dispatchError.message
          : dispatchError === null
            ? null
            : String(dispatchError),
    });
  }

  private isFirstHomeBindingCommand(text: string, fromUserId: number): boolean {
    const normalized = text.trim().toLowerCase();
    return (normalized === "/sethome" || normalized.startsWith("/sethome@"))
      && !this.config.allow_all
      && this.homeChatStore.get() === undefined
      && this.config.allowed_user_ids.length === 0
      && !this.config.denied_user_ids.includes(fromUserId);
  }

  private async recordHealth(update: Partial<{ last_inbound_at: string; last_outbound_at: string; last_error: string | null; last_timing: GatewayChannelTimingSnapshot }>): Promise<void> {
    await this.runtimeStateStore.saveChannelHealth(this.channelName, update);
  }

  private async recordTiming(): Promise<void> {
    try {
      await this.recordHealth({ last_timing: this.timing.snapshot() });
    } catch (error) {
      console.warn("TelegramGatewayAdapter: timing instrumentation failed", error);
    }
  }

  private effectiveAllowedUserIds(): number[] {
    if (this.config.allowed_user_ids.length > 0) return this.config.allowed_user_ids;
    const firstBoundUserId = this.homeChatStore.getFirstBoundUserId();
    return firstBoundUserId !== undefined ? [firstBoundUserId] : [];
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
  private chatId: number | undefined;
  private firstBoundUserId: number | undefined;

  constructor(
    private readonly channelName: string,
    private readonly runtimeStateStore: PluginChannelRuntimeStateStore,
    private readonly initialChatId?: number
  ) {
    this.chatId = initialChatId;
  }

  async load(): Promise<void> {
    const binding = await this.runtimeStateStore.loadChannelBinding(this.channelName);
    if (binding?.home_target_id !== null && binding?.home_target_id !== undefined) {
      const parsedChatId = parseTelegramIntegerId(binding.home_target_id);
      if (parsedChatId !== null) this.chatId = parsedChatId;
    } else {
      this.chatId = this.initialChatId;
    }
    if (binding?.first_bound_actor_id !== null && binding?.first_bound_actor_id !== undefined) {
      const parsedUserId = parseTelegramIntegerId(binding.first_bound_actor_id);
      if (parsedUserId !== null) this.firstBoundUserId = parsedUserId;
    }
  }

  get(): number | undefined {
    return this.chatId;
  }

  getFirstBoundUserId(): number | undefined {
    return this.firstBoundUserId;
  }

  async set(chatId: number, firstAllowedUserId?: number): Promise<void> {
    this.chatId = chatId;
    if (firstAllowedUserId !== undefined) this.firstBoundUserId = firstAllowedUserId;
    await this.runtimeStateStore.saveChannelBinding(this.channelName, {
      home_target_id: String(chatId),
      first_bound_actor_id: firstAllowedUserId !== undefined ? String(firstAllowedUserId) : undefined,
    });
  }
}

class TelegramChatEventAdapter {
  private readonly projector: NonTuiDisplayProjector;
  readonly presenceTransport: SeedyPresenceTransport;

  constructor(
    private readonly api: TelegramAPI,
    private readonly chatId: number,
    private readonly timing: TelegramGatewayTimingRecorder,
    private readonly onTimingUpdated: () => Promise<void>,
  ) {
    const transport = new TelegramDisplayTransport(api, chatId, timing, onTimingUpdated);
    this.presenceTransport = createSeedyPresenceTransportFromNonTuiDisplay(transport);
    this.projector = new NonTuiDisplayProjector({
      display: {
        capabilities: TELEGRAM_GATEWAY_DISPLAY_CONTRACT.capabilities,
        policy: {
          ...createGatewayDisplayPolicy(TELEGRAM_GATEWAY_DISPLAY_CONTRACT.capabilities),
          progressSurface: "editable",
          finalSurface: "edit_stream",
          cleanupPolicy: "collapse",
        },
      },
      transport,
    });
  }

  get renderedAssistantOutput(): boolean {
    return this.projector.renderedAssistantOutput;
  }

  get deliveredAssistantOutput(): boolean {
    return this.projector.deliveredAssistantOutput;
  }

  get deliveredProgressOutput(): boolean {
    return this.projector.deliveredProgressOutput;
  }

  async handle(event: ChatEvent): Promise<void> {
    if (!this.shouldRender(event)) return;
    await this.projector.handle(event);
  }

  shouldRender(event: ChatEvent): boolean {
    if (event.type === "operation_progress" && event.item.metadata?.["source"] === "agent_timeline_activity_summary") return false;
    if (event.type === "agent_timeline" && event.item.visibility !== "user") return false;
    if (this.projector.deliveredAssistantOutput && isNonTerminalProgressEvent(event)) return false;
    return true;
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
    private readonly timing: TelegramGatewayTimingRecorder,
    private readonly onTimingUpdated: () => Promise<void>,
  ) {}

  async sendProgress(text: string): Promise<NonTuiDisplayMessageRef> {
    const messageId = await this.record("progress_send", () => this.api.sendPlainMessage(this.chatId, text));
    return { id: String(messageId) };
  }

  async editProgress(ref: NonTuiDisplayMessageRef, text: string): Promise<void> {
    await this.record("progress_edit", () => this.api.editMessageText(this.chatId, parseTelegramMessageRef(ref), text));
  }

  async deleteProgress(ref: NonTuiDisplayMessageRef): Promise<void> {
    await this.record("progress_delete", () => this.api.deleteMessage(this.chatId, parseTelegramMessageRef(ref)));
  }

  async sendFinal(text: string): Promise<NonTuiDisplayMessageRef> {
    const messageId = await this.record("final_send", () => this.api.sendPlainMessage(this.chatId, text));
    return { id: String(messageId) };
  }

  async editFinal(ref: NonTuiDisplayMessageRef, text: string): Promise<void> {
    await this.record("final_edit", () => this.api.editMessageText(this.chatId, parseTelegramMessageRef(ref), text));
  }

  private async record<T>(kind: TelegramGatewayOutboundKind, fn: () => Promise<T>): Promise<T> {
    try {
      return await this.timing.recordOutbound(kind, fn);
    } finally {
      await this.onTimingUpdated();
    }
  }
}

function isNonTerminalProgressEvent(event: ChatEvent): boolean {
  switch (event.type) {
    case "operation_progress":
    case "activity":
    case "agent_timeline":
    case "tool_start":
    case "tool_update":
    case "tool_end":
      return true;
    case "assistant_delta":
    case "assistant_final":
    case "lifecycle_error":
    case "surface_delivery":
    case "lifecycle_end":
    case "lifecycle_start":
    case "presence_update":
    case "turn_steer":
    case "user_feedback":
      return false;
  }
}

type TelegramGatewayOutboundKind =
  | "typing"
  | "progress_send"
  | "progress_edit"
  | "progress_delete"
  | "final_send"
  | "final_edit"
  | "sethome_send";

interface TelegramGatewayPollToken {
  readonly startedAtMs: number;
  readonly startedAt: string;
  readonly offset: number;
  readonly timeoutSeconds: number;
}

class TelegramGatewayTimingRecorder {
  private openPoll: TelegramGatewayPollToken | null = null;
  private lastPoll: GatewayChannelTimingSnapshot["poll"] | undefined;
  private turn: GatewayChannelTimingSnapshot["turn"] | undefined;

  constructor(private readonly channel: string) {}

  beginPoll(offset: number, timeoutSeconds: number): TelegramGatewayPollToken {
    const token = {
      startedAtMs: Date.now(),
      startedAt: new Date().toISOString(),
      offset,
      timeoutSeconds,
    };
    this.openPoll = token;
    return token;
  }

  completePoll(
    token: TelegramGatewayPollToken,
    result: { updateCount: number; ok: boolean; error?: unknown },
  ): void {
    this.lastPoll = {
      started_at: token.startedAt,
      completed_at: new Date().toISOString(),
      duration_ms: elapsedMs(token.startedAtMs),
      offset: token.offset,
      timeout_seconds: token.timeoutSeconds,
      update_count: result.updateCount,
      ok: result.ok,
      ...(result.error ? { error_class: errorClass(result.error) } : {}),
    };
    if (this.openPoll === token) this.openPoll = null;
  }

  completeOpenPoll(result: { ok: boolean; error?: unknown }): void {
    if (this.openPoll === null) return;
    this.completePoll(this.openPoll, {
      updateCount: 0,
      ok: result.ok,
      error: result.error,
    });
  }

  beginTurn(input: { updateId?: number; messageId: number }): void {
    this.turn = {
      turn_ref: `telegram:message:${input.messageId}`,
      ...(input.updateId !== undefined ? { update_id: input.updateId } : {}),
      message_id: input.messageId,
      inbound_admitted_at: new Date().toISOString(),
      outbound_calls: [],
    };
  }

  markLifecycleEnd(): void {
    if (!this.turn) return;
    this.turn = {
      ...this.turn,
      lifecycle_end_at: new Date().toISOString(),
    };
  }

  async recordOutbound<T>(kind: TelegramGatewayOutboundKind, fn: () => Promise<T>): Promise<T> {
    const startedAtMs = Date.now();
    const startedAt = new Date().toISOString();
    try {
      const result = await fn();
      this.appendOutbound({
        kind,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        duration_ms: elapsedMs(startedAtMs),
        ok: true,
      });
      return result;
    } catch (error) {
      this.appendOutbound({
        kind,
        started_at: startedAt,
        completed_at: new Date().toISOString(),
        duration_ms: elapsedMs(startedAtMs),
        ok: false,
        error_class: errorClass(error),
      });
      throw error;
    }
  }

  snapshot(): GatewayChannelTimingSnapshot {
    return {
      schema_version: "gateway-channel-timing-v1",
      channel: this.channel,
      ...(this.lastPoll ? { poll: this.lastPoll } : {}),
      ...(this.turn ? { turn: this.turn } : {}),
    };
  }

  private appendOutbound(call: NonNullable<GatewayChannelTimingSnapshot["turn"]>["outbound_calls"][number]): void {
    if (!this.turn) return;
    const firstAt = firstOutboundTimestamp(this.turn, call.kind);
    this.turn = {
      ...this.turn,
      ...(call.ok && call.kind === "typing" && firstAt === undefined ? { first_typing_at: call.completed_at } : {}),
      ...(call.ok && call.kind === "progress_send" && firstAt === undefined ? { first_progress_at: call.completed_at } : {}),
      ...(call.ok && (call.kind === "final_send" || call.kind === "final_edit") && firstAt === undefined ? { first_final_at: call.completed_at } : {}),
      outbound_calls: [...this.turn.outbound_calls, call].slice(-32),
    };
  }
}

function firstOutboundTimestamp(
  turn: NonNullable<GatewayChannelTimingSnapshot["turn"]>,
  kind: string,
): string | undefined {
  if (kind === "typing") return turn.first_typing_at;
  if (kind === "progress_send") return turn.first_progress_at;
  if (kind === "final_send" || kind === "final_edit") return turn.first_final_at;
  return undefined;
}

function elapsedMs(startedAtMs: number): number {
  return Math.max(0, Date.now() - startedAtMs);
}

function errorClass(error: unknown): string {
  if (error instanceof Error && error.name) return error.name;
  return typeof error;
}

function loadTelegramGatewayConfig(pluginDir: string): TelegramGatewayConfig {
  const raw = loadGatewayConfigJson(pluginDir, "telegram-bot");
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

function inferGatewayChannelName(configDir: string): string {
  return path.basename(path.resolve(configDir));
}

function inferGatewayRuntimeBaseDir(configDir: string): string {
  const parts = path.resolve(configDir).split(path.sep);
  const gatewayIndex = parts.lastIndexOf("gateway");
  if (gatewayIndex > 0 && parts[gatewayIndex + 1] === "channels") {
    return parts.slice(0, gatewayIndex).join(path.sep) || path.sep;
  }
  return path.resolve(configDir);
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
