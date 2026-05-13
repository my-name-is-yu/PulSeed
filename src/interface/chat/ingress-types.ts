import type { ChatEventHandler } from "./chat-events.js";
import type { UserInput } from "./user-input.js";
import type {
  RuntimeControlActor,
  RuntimeControlReplyTarget,
} from "../../runtime/store/runtime-operation-schemas.js";
import type { CompanionRuntimeContract } from "../../runtime/types/companion.js";
import type { CompanionDecisionFrame } from "../../runtime/decision/index.js";
import type { ExternalSurfaceDecision } from "../../runtime/gateway/channel-policy.js";

export type IngressChannel = "tui" | "plugin_gateway" | "cli" | "web";
export type IngressDeliveryMode = "reply" | "notify" | "thread_reply";
export type IngressApprovalMode = "interactive" | "preapproved" | "disallowed";
export type ReplyTargetPolicy = "turn_reply_target";
export type EventProjectionPolicy = "turn_only" | "latest_active_reply_target";
export type ConcurrencyPolicy = "session_serial";

export interface ChatIngressRuntimeControl {
  allowed: boolean;
  approvalMode: IngressApprovalMode;
  approval_mode?: IngressApprovalMode;
  explicit?: boolean;
}

export interface IngressReplyTarget extends RuntimeControlReplyTarget {
  channel?: IngressChannel;
  message_id?: string;
  deliveryMode?: IngressDeliveryMode;
  metadata?: Record<string, unknown>;
}

export interface ChatIngressMessage {
  ingress_id?: string;
  received_at?: string;
  channel: IngressChannel;
  platform?: string;
  identity_key?: string;
  conversation_id?: string;
  message_id?: string;
  goal_id?: string;
  user_id?: string;
  user_name?: string;
  text: string;
  userInput: UserInput;
  actor: RuntimeControlActor;
  runtimeControl: ChatIngressRuntimeControl;
  companion?: CompanionRuntimeContract;
  companionDecisionFrame?: CompanionDecisionFrame;
  externalSurface?: ExternalSurfaceDecision;
  deliveryMode?: IngressDeliveryMode;
  metadata: Record<string, unknown>;
  replyTarget: IngressReplyTarget;
  cwd?: string;
  timeoutMs?: number;
  onEvent?: ChatEventHandler;
}

export type IngressMessage = ChatIngressMessage;
export type IngressRuntimeControl = ChatIngressRuntimeControl;
export type ChatIngressChannel = IngressChannel;
export type ChatIngressReplyTarget = IngressReplyTarget;
