import * as http from "node:http";
import type { ChannelAdapter, EnvelopeHandler, TypingIndicatorCapability } from "./channel-adapter.js";
import { loadGatewayConfigJson } from "./config-json.js";
import {
  GATEWAY_CHAT_DISPATCH_FAILURE_MESSAGE,
  dispatchGatewayChatInputResult,
  formatGatewayChatDispatchFailure,
  type GatewayChatDispatchInput,
} from "./chat-session-dispatch.js";
import { formatPlaintextNotification, supportsCoreGatewayNotification } from "./core-channel-notification.js";
import { buildChannelPolicyMetadata, buildExternalSurfaceDecision, evaluateChannelAccess, resolveChannelRoute } from "./channel-policy.js";
import { createRefreshingTypingIndicator } from "./typing-indicator.js";
import { DISCORD_GATEWAY_DISPLAY_CONTRACT, createGatewayDisplayPolicy } from "./channel-display-policy.js";
import { DISCORD_SEEDY_PRESENCE_CONTRACT, resolveGatewayChannelPresenceContract } from "./channel-presence-policy.js";
import { NonTuiDisplayProjector, type NonTuiDisplayMessageRef, type NonTuiDisplayTransport } from "./non-tui-display-projector.js";
import { SeedyPresenceProjector, createSeedyPresenceTransportFromNonTuiDisplay } from "./seedy-presence-projector.js";
import {
  formatExternalAdapterHttpFailure,
  parseExternalAdapterJson,
  readExternalAdapterHttpBody,
  respondExternalAdapterJson,
  singleHeaderValue,
  verifyOptionalEd25519Signature,
} from "./external-adapter-shell.js";
import type { INotifier, NotificationEvent, NotificationEventType } from "../../base/types/plugin.js";
import type { ChatEvent } from "../../interface/chat/chat-events.js";
import { createUserVisibleSeedyTurnPresence } from "../../interface/chat/seedy-turn-presence.js";

let discordSyntheticMessageId = 0;
const MIN_PORT = 1;
const MAX_PORT = 65_535;

interface DiscordInteractionOption {
  name: string;
  value?: unknown;
}

interface DiscordInteractionPayload {
  id?: string;
  type?: number;
  token?: string;
  application_id?: string;
  channel_id?: string;
  guild_id?: string;
  member?: {
    user?: {
      id?: string;
    };
  };
  user?: {
    id?: string;
  };
  data?: {
    name?: string;
    options?: DiscordInteractionOption[];
  };
}

export interface DiscordGatewayConfig {
  application_id: string;
  public_key_hex?: string;
  bot_token: string;
  channel_id: string;
  identity_key: string;
  allowed_sender_ids: string[];
  denied_sender_ids: string[];
  allowed_conversation_ids: string[];
  denied_conversation_ids: string[];
  runtime_control_allowed_sender_ids: string[];
  conversation_goal_map: Record<string, string>;
  sender_goal_map: Record<string, string>;
  default_goal_id?: string;
  command_name: string;
  host: string;
  port: number;
  ephemeral: boolean;
}

export class DiscordGatewayNotifier implements INotifier {
  readonly name = "discord-bot";

  constructor(
    private readonly api: DiscordAPI,
    private readonly config: DiscordGatewayConfig
  ) {}

  supports(eventType: NotificationEventType): boolean {
    return supportsCoreGatewayNotification(eventType);
  }

  async notify(event: NotificationEvent): Promise<void> {
    await this.api.sendChannelMessage(this.config.channel_id, formatPlaintextNotification(event));
  }
}

export class DiscordGatewayAdapter implements ChannelAdapter {
  readonly name = "discord";
  readonly typingIndicator: TypingIndicatorCapability;
  readonly displayContract = DISCORD_GATEWAY_DISPLAY_CONTRACT;
  readonly presenceContract = DISCORD_SEEDY_PRESENCE_CONTRACT;

  private handler: EnvelopeHandler | null = null;
  private server: http.Server | null = null;
  private readonly api: DiscordAPI;
  private readonly notifier: DiscordGatewayNotifier;

  constructor(private readonly config: DiscordGatewayConfig) {
    this.api = new DiscordAPI(config.bot_token);
    this.typingIndicator = createRefreshingTypingIndicator({
      intervalMs: 8_000,
      refresh: async (context) => {
        const channelId = typeof context.metadata?.["channel_id"] === "string"
          ? context.metadata["channel_id"]
          : context.conversation_id;
        if (!channelId) return;
        await this.api.triggerTyping(channelId);
      },
      onError: (err) => console.warn("DiscordGatewayAdapter: typing indicator failed", err),
    });
    this.notifier = new DiscordGatewayNotifier(this.api, config);
  }

  static fromConfigDir(configDir: string): DiscordGatewayAdapter {
    return new DiscordGatewayAdapter(loadDiscordGatewayConfig(configDir));
  }

  getNotifier(): INotifier {
    return this.notifier;
  }

  onEnvelope(handler: EnvelopeHandler): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    if (this.server !== null) return;
    this.server = http.createServer((req, res) => {
      void this.handleRequest(req, res);
    });
    await new Promise<void>((resolve) => {
      this.server!.listen(this.config.port, this.config.host, resolve);
    });
  }

  async stop(): Promise<void> {
    if (this.server === null) return;
    await new Promise<void>((resolve) => {
      this.server!.close(() => resolve());
    });
    this.server = null;
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== "POST") {
      respondExternalAdapterJson(res, 405, { error: "method_not_allowed" });
      return;
    }

    const bodyResult = await readExternalAdapterHttpBody(req);
    if (bodyResult.status !== "ok") {
      respondExternalAdapterJson(res, bodyResult.statusCode, bodyResult.payload);
      return;
    }

    if (!(await this.verifyRequest(req, bodyResult.body))) {
      respondExternalAdapterJson(res, 401, { error: "invalid_signature" });
      return;
    }

    const parsed = parseExternalAdapterJson<DiscordInteractionPayload>(bodyResult.body);
    if (parsed.status !== "ok") {
      respondExternalAdapterJson(res, parsed.statusCode, parsed.payload);
      return;
    }
    const payload = parsed.value;

    if (payload.type === 1) {
      respondExternalAdapterJson(res, 200, { type: 1 });
      return;
    }

    if (
      payload.type !== 2 ||
      payload.token === undefined ||
      payload.application_id === undefined ||
      payload.data?.name !== this.config.command_name
    ) {
      respondExternalAdapterJson(res, 400, { error: "unsupported_interaction" });
      return;
    }

    const text = this.extractCommandText(payload);
    if (text === null) {
      respondExternalAdapterJson(res, 400, { error: "missing_message_text" });
      return;
    }

    const senderId = payload.member?.user?.id ?? payload.user?.id ?? "discord-user";
    const conversationId = payload.channel_id ?? payload.guild_id ?? payload.id ?? senderId;
    const channelContext = {
      platform: "discord",
      senderId,
      conversationId,
      channelId: payload.channel_id,
    };
    const access = evaluateChannelAccess(
      {
        allowedSenderIds: this.config.allowed_sender_ids,
        deniedSenderIds: this.config.denied_sender_ids,
        allowedConversationIds: this.config.allowed_conversation_ids,
        deniedConversationIds: this.config.denied_conversation_ids,
        runtimeControlAllowedSenderIds: this.config.runtime_control_allowed_sender_ids,
      },
      channelContext
    );
    if (!access.allowed) {
      respondExternalAdapterJson(res, 403, { error: access.reason ?? "forbidden" });
      return;
    }

    const route = resolveChannelRoute(
      {
        identityKey: this.config.identity_key,
        conversationGoalMap: this.config.conversation_goal_map,
        senderGoalMap: this.config.sender_goal_map,
        defaultGoalId: this.config.default_goal_id,
      },
      channelContext
    );
    const externalSurface = buildExternalSurfaceDecision(channelContext, access, route);

    void this.processIncomingMessage(payload, {
      text,
      platform: "discord",
      identity_key: route.identityKey ?? this.config.identity_key,
      conversation_id: conversationId,
      sender_id: senderId,
      message_id: payload.id,
      goal_id: route.goalId,
      externalSurface,
      metadata: {
        ...buildChannelPolicyMetadata(channelContext, access, route, externalSurface),
        interaction_type: payload.type,
        command_name: payload.data?.name,
        channel_id: payload.channel_id,
        guild_id: payload.guild_id,
        ...(route.goalId ? { goal_id: route.goalId } : {}),
      },
    }).catch(() => undefined);

    respondExternalAdapterJson(res, 200, {
      type: 5,
      data: this.config.ephemeral ? { flags: 64 } : undefined,
    });
  }

  private async processIncomingMessage(
    payload: DiscordInteractionPayload,
    input: GatewayChatDispatchInput
  ): Promise<void> {
    const displayTransport = payload.application_id !== undefined && payload.token !== undefined
      ? new DiscordInteractionDisplayTransport(this.api, payload.application_id, payload.token, this.config.ephemeral)
      : null;
    const projector = displayTransport !== null
      ? new NonTuiDisplayProjector({
        display: {
          capabilities: DISCORD_GATEWAY_DISPLAY_CONTRACT.capabilities,
          policy: {
            ...createGatewayDisplayPolicy(DISCORD_GATEWAY_DISPLAY_CONTRACT.capabilities),
            progressSurface: "editable",
            finalSurface: "edit_stream",
            cleanupPolicy: "delete",
          },
        },
        transport: displayTransport,
      })
      : null;
    const presenceProjector = new SeedyPresenceProjector({
      presence: resolveGatewayChannelPresenceContract(this.presenceContract),
      transport: displayTransport !== null ? createSeedyPresenceTransportFromNonTuiDisplay(displayTransport) : undefined,
      typingIndicator: this.typingIndicator,
      typingContext: {
        platform: "discord",
        conversation_id: input.conversation_id,
        sender_id: input.sender_id,
        message_id: input.message_id,
        metadata: input.metadata,
      },
      onError: (error, operation) => console.warn("DiscordGatewayAdapter: presence projector failed", { operation, error }),
    });
    let reply: string | null = null;
    let dispatchCompleted = false;
    try {
      await presenceProjector.update(createUserVisibleSeedyTurnPresence({
        turn_id: `discord:${input.message_id ?? input.conversation_id}`,
        phase: "received",
      }));
      const dispatchResult = await dispatchGatewayChatInputResult({
        ...input,
        onEvent: async (event) => {
          const chatEvent = event as unknown as ChatEvent;
          await presenceProjector.prepareForEvent(chatEvent);
          await projector?.handle(chatEvent);
          await presenceProjector.handle(chatEvent, {
            assistantOutputRendered: projector?.deliveredAssistantOutput ?? false,
            meaningfulProgressRendered: projector?.deliveredProgressOutput ?? false,
          });
        },
      });
      reply = dispatchResult.status === "ok"
        ? dispatchResult.text
        : formatGatewayChatDispatchFailure(dispatchResult.error);
      dispatchCompleted = true;
    } finally {
      try {
        const content = reply ?? GATEWAY_CHAT_DISPATCH_FAILURE_MESSAGE;
        if (dispatchCompleted && projector !== null && !projector.renderedAssistantOutput) {
          const fallbackEvent = {
            type: "assistant_final" as const,
            runId: "fallback",
            turnId: "fallback",
            createdAt: new Date().toISOString(),
            text: content,
            persisted: false,
          };
          await presenceProjector.prepareForEvent(fallbackEvent);
          await projector.handle(fallbackEvent);
        }
      } finally {
        await presenceProjector.stop();
      }
    }
  }

  private extractCommandText(payload: DiscordInteractionPayload): string | null {
    for (const option of payload.data?.options ?? []) {
      if (
        (option.name === "message" || option.name === "text" || option.name === "content") &&
        typeof option.value === "string" &&
        option.value.trim().length > 0
      ) {
        return option.value;
      }
    }
    return null;
  }

  private async verifyRequest(req: http.IncomingMessage, body: string): Promise<boolean> {
    if (!this.config.public_key_hex) {
      return true;
    }
    const timestamp = singleHeaderValue(req.headers["x-signature-timestamp"]);
    if (timestamp === undefined) {
      return false;
    }

    return verifyOptionalEd25519Signature({
      publicKeyHex: this.config.public_key_hex,
      signatureHeader: req.headers["x-signature-ed25519"],
      signedPayload: `${timestamp}${body}`,
    });
  }
}

class DiscordAPI {
  constructor(
    private readonly botToken: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async sendChannelMessage(channelId: string, content: string): Promise<void> {
    const response = await this.fetchImpl(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${this.botToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content,
        allowed_mentions: { parse: [] as string[] },
      }),
    });
    if (!response.ok) {
      throw new Error(await formatExternalAdapterHttpFailure(response, {
        service: "discord-bot",
        operation: "channel send failed",
        statusVerb: "with",
      }));
    }
  }

  async sendInteractionFollowUp(applicationId: string, interactionToken: string, content: string): Promise<void> {
    const response = await this.fetchImpl(`https://discord.com/api/v10/webhooks/${applicationId}/${interactionToken}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content,
        allowed_mentions: { parse: [] as string[] },
      }),
    });
    if (!response.ok) {
      throw new Error(await formatExternalAdapterHttpFailure(response, {
        service: "discord-bot",
        operation: "follow-up send failed",
        statusVerb: "with",
      }));
    }
  }

  async sendInteractionFollowUpMessage(applicationId: string, interactionToken: string, content: string, ephemeral: boolean): Promise<string> {
    const response = await this.fetchImpl(`https://discord.com/api/v10/webhooks/${applicationId}/${interactionToken}?wait=true`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content,
        ...(ephemeral ? { flags: 64 } : {}),
        allowed_mentions: { parse: [] as string[] },
      }),
    });
    if (!response.ok) {
      throw new Error(await formatExternalAdapterHttpFailure(response, {
        service: "discord-bot",
        operation: "follow-up send failed",
        statusVerb: "with",
      }));
    }
    const json = await response.json().catch(() => ({})) as { id?: string };
    discordSyntheticMessageId += 1;
    return json.id ?? `discord-followup-${discordSyntheticMessageId}`;
  }

  async editInteractionFollowUp(applicationId: string, interactionToken: string, messageId: string, content: string): Promise<void> {
    const response = await this.fetchImpl(`https://discord.com/api/v10/webhooks/${applicationId}/${interactionToken}/messages/${messageId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        content,
        allowed_mentions: { parse: [] as string[] },
      }),
    });
    if (!response.ok) {
      throw new Error(await formatExternalAdapterHttpFailure(response, {
        service: "discord-bot",
        operation: "follow-up edit failed",
        statusVerb: "with",
      }));
    }
  }

  async deleteInteractionFollowUp(applicationId: string, interactionToken: string, messageId: string): Promise<void> {
    const response = await this.fetchImpl(`https://discord.com/api/v10/webhooks/${applicationId}/${interactionToken}/messages/${messageId}`, {
      method: "DELETE",
    });
    if (!response.ok) {
      throw new Error(await formatExternalAdapterHttpFailure(response, {
        service: "discord-bot",
        operation: "follow-up delete failed",
        statusVerb: "with",
      }));
    }
  }

  async triggerTyping(channelId: string): Promise<void> {
    const response = await this.fetchImpl(`https://discord.com/api/v10/channels/${channelId}/typing`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${this.botToken}`,
      },
    });
    if (!response.ok) {
      throw new Error(await formatExternalAdapterHttpFailure(response, {
        service: "discord-bot",
        operation: "typing failed",
        statusVerb: "with",
      }));
    }
  }
}

function loadDiscordGatewayConfig(pluginDir: string): DiscordGatewayConfig {
  const raw = loadGatewayConfigJson(pluginDir, "discord-bot");
  const commandName = raw["command_name"] ?? "pulseed";
  const host = raw["host"] ?? "127.0.0.1";
  const port = raw["port"] ?? 8787;
  const ephemeral = raw["ephemeral"] ?? false;
  const runtimeControlAllowedSenderIds = raw["runtime_control_allowed_sender_ids"] ?? [];
  const allowedSenderIds = raw["allowed_sender_ids"] ?? raw["allow_from"] ?? [];
  const deniedSenderIds = raw["denied_sender_ids"] ?? raw["deny_from"] ?? [];
  const allowedConversationIds = raw["allowed_conversation_ids"] ?? [];
  const deniedConversationIds = raw["denied_conversation_ids"] ?? [];
  const conversationGoalMap = raw["conversation_goal_map"] ?? raw["goal_routes"] ?? {};
  const senderGoalMap = raw["sender_goal_map"] ?? {};

  assertNonEmptyString(raw["application_id"], "discord-bot: application_id must be a non-empty string");
  assertNonEmptyString(raw["bot_token"], "discord-bot: bot_token must be a non-empty string");
  assertNonEmptyString(raw["channel_id"], "discord-bot: channel_id must be a non-empty string");
  assertNonEmptyString(raw["identity_key"], "discord-bot: identity_key must be a non-empty string");
  assertNonEmptyString(commandName, "discord-bot: command_name must be a non-empty string");
  assertNonEmptyString(host, "discord-bot: host must be a non-empty string");
  assertPort(port, `discord-bot: port must be a safe integer between ${MIN_PORT} and ${MAX_PORT}`);
  assertBoolean(ephemeral, "discord-bot: ephemeral must be a boolean");
  assertStringArray(runtimeControlAllowedSenderIds, "discord-bot: runtime_control_allowed_sender_ids must be an array of non-empty strings");
  assertStringArray(allowedSenderIds, "discord-bot: allowed_sender_ids must be an array of non-empty strings");
  assertStringArray(deniedSenderIds, "discord-bot: denied_sender_ids must be an array of non-empty strings");
  assertStringArray(allowedConversationIds, "discord-bot: allowed_conversation_ids must be an array of non-empty strings");
  assertStringArray(deniedConversationIds, "discord-bot: denied_conversation_ids must be an array of non-empty strings");
  assertGoalMap(conversationGoalMap, "discord-bot: conversation_goal_map must map IDs to goal IDs");
  assertGoalMap(senderGoalMap, "discord-bot: sender_goal_map must map IDs to goal IDs");
  if (raw["default_goal_id"] !== undefined) {
    assertNonEmptyString(raw["default_goal_id"], "discord-bot: default_goal_id must be a non-empty string when set");
  }
  if (raw["public_key_hex"] !== undefined && typeof raw["public_key_hex"] !== "string") {
    throw new Error("discord-bot: public_key_hex must be a string when set");
  }

  return {
    application_id: raw["application_id"] as string,
    public_key_hex: raw["public_key_hex"] as string | undefined,
    bot_token: raw["bot_token"] as string,
    channel_id: raw["channel_id"] as string,
    identity_key: raw["identity_key"] as string,
    allowed_sender_ids: allowedSenderIds as string[],
    denied_sender_ids: deniedSenderIds as string[],
    allowed_conversation_ids: allowedConversationIds as string[],
    denied_conversation_ids: deniedConversationIds as string[],
    runtime_control_allowed_sender_ids: runtimeControlAllowedSenderIds as string[],
    conversation_goal_map: conversationGoalMap as Record<string, string>,
    sender_goal_map: senderGoalMap as Record<string, string>,
    default_goal_id: raw["default_goal_id"] as string | undefined,
    command_name: commandName as string,
    host: host as string,
    port: port as number,
    ephemeral: ephemeral as boolean,
  };
}

class DiscordInteractionDisplayTransport implements NonTuiDisplayTransport {
  constructor(
    private readonly api: DiscordAPI,
    private readonly applicationId: string,
    private readonly interactionToken: string,
    private readonly ephemeral: boolean,
  ) {}

  async sendProgress(text: string): Promise<NonTuiDisplayMessageRef> {
    return {
      id: await this.api.sendInteractionFollowUpMessage(this.applicationId, this.interactionToken, text, this.ephemeral),
    };
  }

  async editProgress(ref: NonTuiDisplayMessageRef, text: string): Promise<void> {
    await this.api.editInteractionFollowUp(this.applicationId, this.interactionToken, ref.id, text);
  }

  async deleteProgress(ref: NonTuiDisplayMessageRef): Promise<void> {
    await this.api.deleteInteractionFollowUp(this.applicationId, this.interactionToken, ref.id);
  }

  async sendFinal(text: string): Promise<NonTuiDisplayMessageRef> {
    return {
      id: await this.api.sendInteractionFollowUpMessage(this.applicationId, this.interactionToken, text, this.ephemeral),
    };
  }

  async editFinal(ref: NonTuiDisplayMessageRef, text: string): Promise<void> {
    await this.api.editInteractionFollowUp(this.applicationId, this.interactionToken, ref.id, text);
  }
}

function assertNonEmptyString(value: unknown, message: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(message);
  }
}

function assertPort(value: unknown, message: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < MIN_PORT || value > MAX_PORT) {
    throw new Error(message);
  }
}

function assertBoolean(value: unknown, message: string): asserts value is boolean {
  if (typeof value !== "boolean") {
    throw new Error(message);
  }
}

function assertStringArray(value: unknown, message: string): asserts value is string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.length > 0)) {
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
