import type {
  ChatIngressChannel,
  ChatIngressMessage,
  ChatIngressReplyTarget,
  ChatIngressRuntimeControl,
} from "./ingress-types.js";
import type {
  CompanionPresenceState,
  CompanionRuntimeContract,
  CompanionTurnPolicy,
  ConversationInputModality,
  ConversationOutputMode,
} from "../../runtime/types/companion.js";
import type { RuntimeControlActor } from "../../runtime/store/runtime-operation-schemas.js";
import type { ExternalSurfaceDecision } from "../../runtime/gateway/channel-policy.js";
import type { ChatEventHandler } from "./chat-events.js";
import type { UserInput } from "./user-input.js";

export interface CrossPlatformChatSessionOptions {
  /**
   * Stable cross-platform join key.
   * When present, sessions with the same identity_key share one ChatRunner session.
   */
  identity_key?: string;
  /** Platform or transport name, e.g. "slack", "discord", "web". */
  platform?: string;
  /** Conversation/thread identifier on the transport. */
  conversation_id?: string;
  /** Human-readable conversation title or thread name. */
  conversation_name?: string;
  /** User identifier on the transport. */
  user_id?: string;
  /** Human-readable user name. */
  user_name?: string;
  /** Channel family for ingress normalization. */
  channel?: ChatIngressChannel;
  /** Optional per-turn message id from the transport. */
  message_id?: string;
  /** Optional goal selected by gateway routing for this turn. */
  goal_id?: string;
  /** Explicit typed actor override for routing/runtime control. */
  actor?: Partial<RuntimeControlActor>;
  /** Explicit reply target override for outbound routing. */
  replyTarget?: Partial<ChatIngressReplyTarget>;
  /** Explicit runtime-control policy for the turn. */
  runtimeControl?: Partial<ChatIngressRuntimeControl>;
  /** Typed external surface policy attached by gateway/channel ingress. */
  externalSurface?: ExternalSurfaceDecision;
  /** Shared companion presence/policy contract overrides for this turn. */
  companion?: {
    presence?: Partial<CompanionPresenceState>;
    turnPolicy?: Partial<CompanionTurnPolicy>;
    inputModality?: ConversationInputModality;
    outputMode?: ConversationOutputMode;
  };
  /** Workspace root or working directory used when the session is created. */
  cwd?: string;
  /** Per-turn timeout forwarded to ChatRunner. */
  timeoutMs?: number;
  /** Extra transport metadata for plugins to retain alongside the session. */
  metadata?: Record<string, unknown>;
  /** Optional streaming callback for ChatEvent updates. */
  onEvent?: ChatEventHandler;
  /** Canonical typed user input. If omitted, text is preserved as one text item. */
  userInput?: UserInput;
}

export interface CrossPlatformIncomingChatMessage {
  text: string;
  userInput?: UserInput;
  channel?: ChatIngressChannel;
  identity_key?: string;
  platform?: string;
  conversation_id?: string;
  conversation_name?: string;
  sender_id?: string;
  user_id?: string;
  user_name?: string;
  message_id?: string;
  goal_id?: string;
  cwd?: string;
  timeoutMs?: number;
  actor?: Partial<RuntimeControlActor>;
  replyTarget?: Partial<ChatIngressReplyTarget>;
  runtimeControl?: Partial<ChatIngressRuntimeControl>;
  externalSurface?: ExternalSurfaceDecision;
  companion?: {
    presence?: Partial<CompanionPresenceState>;
    turnPolicy?: Partial<CompanionTurnPolicy>;
    inputModality?: ConversationInputModality;
    outputMode?: ConversationOutputMode;
  };
  metadata?: Record<string, unknown>;
  approvalResponse?: {
    approval_id: string;
    approved: boolean;
  };
  onEvent?: ChatEventHandler;
}

export type CrossPlatformIngressMessage = ChatIngressMessage;

export interface CrossPlatformChatSessionInfo {
  session_key: string;
  identity_key?: string;
  platform?: string;
  conversation_id?: string;
  conversation_name?: string;
  user_id?: string;
  user_name?: string;
  cwd: string;
  created_at: string;
  last_used_at: string;
  last_message_id?: string;
  chat_session_id?: string;
  active_reply_target?: ChatIngressReplyTarget;
  active_companion_contract?: CompanionRuntimeContract;
  metadata: Record<string, unknown>;
}
