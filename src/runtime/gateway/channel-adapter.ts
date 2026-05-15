import type { Envelope } from "../types/envelope.js";
import type { GatewayChannelDisplayContract } from "./channel-display-policy.js";
import type { GatewayChannelPresenceContract } from "./channel-presence-policy.js";
import type { GatewayOutboundConversationPort } from "./outbound-conversation.js";

export interface ReplyChannel {
  send(data: unknown): void;
  close(): void;
}

export type EnvelopeHandler = (envelope: Envelope, reply?: ReplyChannel) => void | Promise<void>;

export type TypingIndicatorStatus = "native" | "fallback" | "unsupported";

export interface TypingIndicatorContext {
  platform: string;
  conversation_id: string;
  sender_id?: string;
  message_id?: string;
  metadata?: Record<string, unknown>;
}

export interface TypingIndicatorSession {
  readonly status: TypingIndicatorStatus;
  stop(): Promise<void>;
}

export interface TypingIndicatorCapability {
  readonly status: TypingIndicatorStatus;
  readonly reason?: string;
  start(context: TypingIndicatorContext): Promise<TypingIndicatorSession>;
}

/**
 * A ChannelAdapter receives protocol-specific input and emits Envelopes.
 * Each adapter handles one external protocol (HTTP, WebSocket, CLI, MCP, Slack, etc.).
 */
export interface ChannelAdapter {
  /** Unique adapter name (e.g., "http", "websocket", "cli", "slack") */
  readonly name: string;

  /** Start accepting input from this channel */
  start(): Promise<void>;

  /** Stop accepting input and clean up resources */
  stop(): Promise<void>;

  /** Register the handler that receives Envelopes from this adapter */
  onEnvelope(handler: EnvelopeHandler): void;

  /** Optional platform typing/presence feedback while a chat turn is active */
  readonly typingIndicator?: TypingIndicatorCapability;

  /** Optional non-TUI chat display capabilities and policy defaults */
  readonly displayContract?: GatewayChannelDisplayContract;

  /** Optional Seedy turn-presence surface capabilities and timing defaults */
  readonly presenceContract?: GatewayChannelPresenceContract;

  /** Optional proactive outbound conversation capability for lightweight direct messages */
  readonly outboundConversation?: GatewayOutboundConversationPort;
}
