import { randomUUID } from "node:crypto";
import type { ChannelAdapter, EnvelopeHandler, TypingIndicatorCapability } from "./channel-adapter.js";
import { loadGatewayConfigJson } from "./config-json.js";
import { dispatchGatewayChatInput } from "./chat-session-dispatch.js";
import { formatPlaintextNotification, supportsCoreGatewayNotification } from "./core-channel-notification.js";
import { buildChannelPolicyMetadata, buildExternalSurfaceDecision, evaluateChannelAccess, resolveChannelRoute } from "./channel-policy.js";
import { createUnsupportedTypingIndicator } from "./typing-indicator.js";
import { SIGNAL_GATEWAY_DISPLAY_CONTRACT } from "./channel-display-policy.js";
import { SIGNAL_SEEDY_PRESENCE_CONTRACT, resolveGatewayChannelPresenceContract } from "./channel-presence-policy.js";
import { NonTuiDisplayProjector, type NonTuiDisplayMessageRef, type NonTuiDisplayTransport } from "./non-tui-display-projector.js";
import { SeedyPresenceProjector, createSeedyPresenceTransportFromNonTuiDisplay } from "./seedy-presence-projector.js";
import type { INotifier, NotificationEvent, NotificationEventType } from "../../base/types/plugin.js";
import type { ChatEvent } from "../../interface/chat/chat-events.js";
import { createUserVisibleSeedyTurnPresence } from "../../interface/chat/seedy-turn-presence.js";

const MIN_POLL_INTERVAL_MS = 1_000;
const MIN_RECEIVE_TIMEOUT_MS = 250;
const MAX_SIGNAL_TIMER_MS = 60_000;

export interface SignalGatewayConfig {
  bridge_url: string;
  account: string;
  recipient_id: string;
  identity_key: string;
  allowed_sender_ids: string[];
  denied_sender_ids: string[];
  allowed_conversation_ids: string[];
  denied_conversation_ids: string[];
  runtime_control_allowed_sender_ids: string[];
  conversation_goal_map: Record<string, string>;
  sender_goal_map: Record<string, string>;
  default_goal_id?: string;
  poll_interval_ms: number;
  receive_timeout_ms: number;
}

interface SignalReceivedMessage {
  id?: string;
  sender?: string;
  sender_number?: string;
  source?: string;
  message?: string;
  body?: string;
  timestamp?: number;
  conversationId?: string;
  groupId?: string;
}

export class SignalGatewayNotifier implements INotifier {
  readonly name = "signal-bridge";

  constructor(
    private readonly client: SignalBridgeClient,
    private readonly config: SignalGatewayConfig
  ) {}

  supports(eventType: NotificationEventType): boolean {
    return supportsCoreGatewayNotification(eventType);
  }

  async notify(event: NotificationEvent): Promise<void> {
    await this.client.sendTextMessage({
      recipient: this.config.recipient_id,
      body: formatPlaintextNotification(event),
    });
  }
}

export class SignalGatewayAdapter implements ChannelAdapter {
  readonly name = "signal";
  readonly displayContract = SIGNAL_GATEWAY_DISPLAY_CONTRACT;
  readonly presenceContract = SIGNAL_SEEDY_PRESENCE_CONTRACT;
  readonly typingIndicator: TypingIndicatorCapability = createUnsupportedTypingIndicator(
    "signal-bridge adapter has no configured typing endpoint"
  );

  private handler: EnvelopeHandler | null = null;
  private readonly client: SignalBridgeClient;
  private readonly notifier: SignalGatewayNotifier;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly seenMessageIds = new Set<string>();

  constructor(private readonly config: SignalGatewayConfig) {
    this.client = new SignalBridgeClient(config.bridge_url, config.account);
    this.notifier = new SignalGatewayNotifier(this.client, config);
  }

  static fromConfigDir(configDir: string): SignalGatewayAdapter {
    return new SignalGatewayAdapter(loadSignalGatewayConfig(configDir));
  }

  getNotifier(): INotifier {
    return this.notifier;
  }

  onEnvelope(handler: EnvelopeHandler): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    if (this.timer !== null) return;
    void this.pollOnce().catch(() => undefined);
    this.timer = setInterval(() => {
      void this.pollOnce().catch(() => undefined);
    }, this.config.poll_interval_ms);
  }

  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async pollOnce(): Promise<void> {
    const messages = await this.client.receiveMessages(this.config.receive_timeout_ms);
    for (const message of messages) {
      const normalized = this.normalizeMessage(message);
      if (normalized === null || this.seenMessageIds.has(normalized.messageId)) {
        continue;
      }
      this.seenMessageIds.add(normalized.messageId);
      const channelContext = {
        platform: "signal",
        senderId: normalized.senderId,
        conversationId: normalized.conversationId,
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
      if (!access.allowed) continue;
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
      const transport = new SignalDisplayTransport(this.client, normalized.senderId);
      const projector = new NonTuiDisplayProjector({
        display: {
          capabilities: SIGNAL_GATEWAY_DISPLAY_CONTRACT.capabilities,
          policy: {
            progressSurface: "off",
            finalSurface: "chunked",
            cleanupPolicy: "none",
            toolProgress: "off",
            showReasoning: false,
            progressMaxItems: 0,
            progressMaxChars: 0,
          },
        },
        transport,
      });
      const presenceProjector = new SeedyPresenceProjector({
        presence: resolveGatewayChannelPresenceContract(this.presenceContract),
        transport: createSeedyPresenceTransportFromNonTuiDisplay(transport),
        onError: (error, operation) => console.warn("SignalGatewayAdapter: presence projector failed", { operation, error }),
      });
      let reply: string | null = null;
      try {
        await presenceProjector.update(createUserVisibleSeedyTurnPresence({
          turn_id: `signal:${normalized.conversationId}:${normalized.messageId}`,
          phase: "received",
        }));
        reply = await dispatchGatewayChatInput({
          text: normalized.text,
          platform: "signal",
          identity_key: route.identityKey ?? this.config.identity_key,
          conversation_id: normalized.conversationId,
          sender_id: normalized.senderId,
          message_id: normalized.messageId,
          goal_id: route.goalId,
          externalSurface,
          onEvent: async (event) => {
            const chatEvent = event as unknown as ChatEvent;
            await projector.handle(chatEvent);
            await presenceProjector.handle(chatEvent, {
              assistantOutputRendered: projector.deliveredAssistantOutput,
              meaningfulProgressRendered: projector.deliveredProgressOutput,
            });
          },
          metadata: {
            ...buildChannelPolicyMetadata(channelContext, access, route, externalSurface),
            ...normalized.metadata,
            ...(route.goalId ? { goal_id: route.goalId } : {}),
          },
        });
      } finally {
        await presenceProjector.stop();
      }

      if (!projector.renderedAssistantOutput && (reply !== null || presenceProjector.hasSentFallbackAck)) {
        await projector.handle({
          type: "assistant_final",
          runId: "fallback",
          turnId: "fallback",
          createdAt: new Date().toISOString(),
          text: reply ?? "Received.",
          persisted: false,
        });
      }
    }
  }

  private normalizeMessage(message: SignalReceivedMessage): {
    messageId: string;
    conversationId: string;
    senderId: string;
    text: string;
    metadata: Record<string, unknown>;
  } | null {
    const text = typeof message.message === "string"
      ? message.message
      : typeof message.body === "string"
        ? message.body
        : null;
    const senderId = message.sender ?? message.sender_number ?? message.source ?? null;
    if (text === null || senderId === null) {
      return null;
    }
    const messageId = message.id ?? `${senderId}:${message.timestamp ?? Date.now()}:${randomUUID()}`;
    const conversationId = message.groupId ?? message.conversationId ?? senderId;
    return {
      messageId,
      conversationId,
      senderId,
      text,
      metadata: {
        source: message.source,
        timestamp: message.timestamp,
        group_id: message.groupId,
      },
    };
  }
}

class SignalDisplayTransport implements NonTuiDisplayTransport {
  private nextId = 0;

  constructor(
    private readonly client: SignalBridgeClient,
    private readonly recipientId: string,
  ) {}

  async sendProgress(text: string): Promise<NonTuiDisplayMessageRef> {
    return this.sendFinal(text);
  }

  async editProgress(): Promise<void> {}

  async deleteProgress(): Promise<void> {}

  async sendFinal(text: string): Promise<NonTuiDisplayMessageRef> {
    await this.client.sendTextMessage({ recipient: this.recipientId, body: text });
    this.nextId += 1;
    return { id: `signal-${this.nextId}` };
  }

  async editFinal(): Promise<void> {}
}

class SignalBridgeClient {
  constructor(
    private readonly bridgeUrl: string,
    private readonly account: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async sendTextMessage(message: { recipient: string; body: string }): Promise<void> {
    const response = await this.fetchImpl(`${this.bridgeUrl}/v2/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: message.body,
        recipients: [message.recipient],
        number: this.account,
      }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "(unreadable)");
      throw new Error(`signal-bridge: send failed with ${response.status}: ${body}`);
    }
  }

  async receiveMessages(timeoutMs: number): Promise<SignalReceivedMessage[]> {
    const endpoints = [
      `${this.bridgeUrl}/v1/receive/${encodeURIComponent(this.account)}?timeout=${timeoutMs}`,
      `${this.bridgeUrl}/v2/receive/${encodeURIComponent(this.account)}?timeout=${timeoutMs}`,
      `${this.bridgeUrl}/v1/receive`,
    ];
    for (const endpoint of endpoints) {
      const response = await this.fetchImpl(endpoint, {
        method: endpoint.endsWith("/v1/receive") ? "POST" : "GET",
        headers: {
          "Content-Type": "application/json",
        },
        body: endpoint.endsWith("/v1/receive")
          ? JSON.stringify({ number: this.account, timeout: timeoutMs })
          : undefined,
      });
      if (!response.ok) {
        continue;
      }
      const payload = (await response.json().catch(() => null)) as unknown;
      const messages = normalizeReceiveResponse(payload);
      if (messages !== null) {
        return messages;
      }
    }
    return [];
  }
}

function normalizeReceiveResponse(payload: unknown): SignalReceivedMessage[] | null {
  if (Array.isArray(payload)) {
    return payload as SignalReceivedMessage[];
  }
  if (typeof payload === "object" && payload !== null) {
    const record = payload as Record<string, unknown>;
    if (Array.isArray(record["messages"])) {
      return record["messages"] as SignalReceivedMessage[];
    }
    if (Array.isArray(record["data"])) {
      return record["data"] as SignalReceivedMessage[];
    }
    if (typeof record["message"] === "string" || typeof record["sender"] === "string") {
      return [record as SignalReceivedMessage];
    }
  }
  return null;
}

function loadSignalGatewayConfig(pluginDir: string): SignalGatewayConfig {
  const raw = loadGatewayConfigJson(pluginDir, "signal-bridge");
  const pollInterval = raw["poll_interval_ms"] ?? 5000;
  const receiveTimeout = raw["receive_timeout_ms"] ?? 2000;
  const runtimeControlAllowedSenderIds = raw["runtime_control_allowed_sender_ids"] ?? [];
  const allowedSenderIds = raw["allowed_sender_ids"] ?? raw["allow_from"] ?? [];
  const deniedSenderIds = raw["denied_sender_ids"] ?? raw["deny_from"] ?? [];
  const allowedConversationIds = raw["allowed_conversation_ids"] ?? [];
  const deniedConversationIds = raw["denied_conversation_ids"] ?? [];
  const conversationGoalMap = raw["conversation_goal_map"] ?? raw["goal_routes"] ?? {};
  const senderGoalMap = raw["sender_goal_map"] ?? {};

  assertNonEmptyString(raw["bridge_url"], "signal-bridge: bridge_url must be a non-empty string");
  assertNonEmptyString(raw["account"], "signal-bridge: account must be a non-empty string");
  assertNonEmptyString(raw["recipient_id"], "signal-bridge: recipient_id must be a non-empty string");
  assertNonEmptyString(raw["identity_key"], "signal-bridge: identity_key must be a non-empty string");
  assertIntegerInRange(
    pollInterval,
    MIN_POLL_INTERVAL_MS,
    MAX_SIGNAL_TIMER_MS,
    `signal-bridge: poll_interval_ms must be a safe integer between ${MIN_POLL_INTERVAL_MS} and ${MAX_SIGNAL_TIMER_MS}`,
  );
  assertIntegerInRange(
    receiveTimeout,
    MIN_RECEIVE_TIMEOUT_MS,
    MAX_SIGNAL_TIMER_MS,
    `signal-bridge: receive_timeout_ms must be a safe integer between ${MIN_RECEIVE_TIMEOUT_MS} and ${MAX_SIGNAL_TIMER_MS}`,
  );
  assertStringArray(runtimeControlAllowedSenderIds, "signal-bridge: runtime_control_allowed_sender_ids must be an array of non-empty strings");
  assertStringArray(allowedSenderIds, "signal-bridge: allowed_sender_ids must be an array of non-empty strings");
  assertStringArray(deniedSenderIds, "signal-bridge: denied_sender_ids must be an array of non-empty strings");
  assertStringArray(allowedConversationIds, "signal-bridge: allowed_conversation_ids must be an array of non-empty strings");
  assertStringArray(deniedConversationIds, "signal-bridge: denied_conversation_ids must be an array of non-empty strings");
  assertGoalMap(conversationGoalMap, "signal-bridge: conversation_goal_map must map IDs to goal IDs");
  assertGoalMap(senderGoalMap, "signal-bridge: sender_goal_map must map IDs to goal IDs");
  if (raw["default_goal_id"] !== undefined) {
    assertNonEmptyString(raw["default_goal_id"], "signal-bridge: default_goal_id must be a non-empty string when set");
  }

  return {
    bridge_url: raw["bridge_url"] as string,
    account: raw["account"] as string,
    recipient_id: raw["recipient_id"] as string,
    identity_key: raw["identity_key"] as string,
    allowed_sender_ids: allowedSenderIds as string[],
    denied_sender_ids: deniedSenderIds as string[],
    allowed_conversation_ids: allowedConversationIds as string[],
    denied_conversation_ids: deniedConversationIds as string[],
    runtime_control_allowed_sender_ids: runtimeControlAllowedSenderIds as string[],
    conversation_goal_map: conversationGoalMap as Record<string, string>,
    sender_goal_map: senderGoalMap as Record<string, string>,
    default_goal_id: raw["default_goal_id"] as string | undefined,
    poll_interval_ms: pollInterval as number,
    receive_timeout_ms: receiveTimeout as number,
  };
}

function assertNonEmptyString(value: unknown, message: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
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
