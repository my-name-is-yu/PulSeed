import { ExternalAdapterIntervalPoller } from "pulseed";
import { SignalBridgeClient, type SignalReceivedMessage } from "./signal-client.js";
import { dispatchChatInput, type ChatContinuationInput } from "./shared-manager.js";
import type { SignalBridgeConfig } from "./config.js";
import {
  buildChannelPolicyMetadata,
  buildExternalSurfaceDecision,
  evaluateChannelAccess,
  resolveChannelRoute,
} from "pulseed";

export class SignalBridgePoller {
  private readonly poller: ExternalAdapterIntervalPoller;
  private readonly seenMessageIds = new Set<string>();

  constructor(
    private readonly config: SignalBridgeConfig,
    private readonly client: SignalBridgeClient,
    private readonly fetchChatReply: typeof dispatchChatInput = dispatchChatInput
  ) {
    this.poller = new ExternalAdapterIntervalPoller({
      intervalMs: this.config.poll_interval_ms,
      pollOnce: () => this.pollOnce(),
      onError: (err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[signal-bridge] poll failed: ${msg}`);
      },
    });
  }

  start(): void {
    this.poller.start();
  }

  stop(): void {
    this.poller.stop();
  }

  async pollOnce(): Promise<void> {
    const messages = await this.client.receiveMessages(this.config.receive_timeout_ms);
    for (const message of messages) {
      const normalized = this.normalizeMessage(message);
      if (normalized === null) {
        continue;
      }

      if (this.seenMessageIds.has(normalized.messageId)) {
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
      if (!access.allowed) {
        continue;
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

      const reply = await this.fetchChatReply({
        platform: "signal",
        identity_key: route.identityKey ?? this.config.identity_key,
        conversation_id: normalized.conversationId,
        sender_id: normalized.senderId,
        message_id: normalized.messageId,
        text: normalized.text,
        externalSurface,
        metadata: {
          ...buildChannelPolicyMetadata(channelContext, access, route, externalSurface),
          ...normalized.metadata,
          ...(route.goalId ? { goal_id: route.goalId } : {}),
        },
      });

      if (reply !== null) {
        await this.client.sendTextMessage({
          recipient: normalized.senderId,
          body: reply,
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

    const messageId = message.id ?? `${senderId}:${message.timestamp ?? Date.now()}:${text}`;
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
