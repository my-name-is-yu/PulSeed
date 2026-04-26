import { randomUUID } from "node:crypto";
import type { ChatEventHandler } from "./chat-events.js";
import { recognizeRuntimeControlIntent, type RuntimeControlIntent } from "../../runtime/control/index.js";
import type {
  RuntimeControlActor,
  RuntimeControlReplyTarget,
} from "../../runtime/store/runtime-operation-schemas.js";

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
  actor: RuntimeControlActor;
  runtimeControl: ChatIngressRuntimeControl;
  deliveryMode?: IngressDeliveryMode;
  metadata: Record<string, unknown>;
  replyTarget: IngressReplyTarget;
  cwd?: string;
  timeoutMs?: number;
  onEvent?: ChatEventHandler;
}

export type SelectedChatRoute =
  | {
      kind: "agent_loop" | "tool_loop" | "adapter";
      reason: "agent_loop_available" | "tool_loop_available" | "adapter_fallback";
      replyTargetPolicy: ReplyTargetPolicy;
      eventProjectionPolicy: EventProjectionPolicy;
      concurrencyPolicy: ConcurrencyPolicy;
    }
  | {
      kind: "runtime_control";
      reason: "runtime_control_intent";
      intent: RuntimeControlIntent;
      replyTargetPolicy: ReplyTargetPolicy;
      eventProjectionPolicy: EventProjectionPolicy;
      concurrencyPolicy: ConcurrencyPolicy;
    };

export interface IngressRouterCapabilities {
  hasAgentLoop: boolean;
  hasToolLoop: boolean;
  hasRuntimeControlService?: boolean;
}

function selectRouteForText(
  text: string,
  runtimeControl: ChatIngressRuntimeControl,
  deps: IngressRouterCapabilities
): SelectedChatRoute {
  const baseTurnPolicy = {
    replyTargetPolicy: "turn_reply_target" as const,
    eventProjectionPolicy: "turn_only" as const,
    concurrencyPolicy: "session_serial" as const,
  };
  const runtimeControlPolicy = {
    replyTargetPolicy: "turn_reply_target" as const,
    eventProjectionPolicy: "latest_active_reply_target" as const,
    concurrencyPolicy: "session_serial" as const,
  };
  const canUseDurableControl =
    runtimeControl.allowed && runtimeControl.approvalMode !== "disallowed";

  if (canUseDurableControl) {
    const intent = recognizeRuntimeControlIntent(text);
    if (intent !== null) {
      return {
        kind: "runtime_control",
        reason: "runtime_control_intent",
        intent,
        ...runtimeControlPolicy,
      };
    }
  }

  if (deps.hasAgentLoop) {
    return {
      kind: "agent_loop",
      reason: "agent_loop_available",
      ...baseTurnPolicy,
    };
  }

  if (deps.hasToolLoop) {
    return {
      kind: "tool_loop",
      reason: "tool_loop_available",
      ...baseTurnPolicy,
    };
  }

  return {
    kind: "adapter",
    reason: "adapter_fallback",
    ...baseTurnPolicy,
  };
}

export class IngressRouter {
  selectRoute(message: ChatIngressMessage, capabilities: IngressRouterCapabilities): SelectedChatRoute {
    return selectRouteForText(message.text, message.runtimeControl, capabilities);
  }
}

export function selectLegacyChatRoute(
  input: string,
  deps: IngressRouterCapabilities
): SelectedChatRoute {
  return selectRouteForText(input, { allowed: true, approvalMode: "interactive" }, deps);
}

function normalizePlatform(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLowerCase() : undefined;
}

function normalizeIdentity(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function inferActorSurface(channel: IngressChannel): RuntimeControlActor["surface"] {
  switch (channel) {
    case "plugin_gateway":
      return "gateway";
    case "tui":
      return "tui";
    case "cli":
      return "cli";
    case "web":
      return "chat";
  }
}

export interface NormalizeLegacyIngressInput {
  text: string;
  channel?: IngressChannel;
  ingress_id?: string;
  received_at?: string;
  identity_key?: string;
  platform?: string;
  conversation_id?: string;
  user_id?: string;
  user_name?: string;
  sender_id?: string;
  message_id?: string;
  goal_id?: string;
  cwd?: string;
  timeoutMs?: number;
  metadata?: Record<string, unknown>;
  onEvent?: ChatEventHandler;
  deliveryMode?: IngressDeliveryMode;
  actor?: RuntimeControlActor;
  replyTarget?: Partial<IngressReplyTarget>;
  runtimeControl?: Partial<ChatIngressRuntimeControl>;
}

export function normalizeLegacyIngressInput(input: NormalizeLegacyIngressInput): ChatIngressMessage {
  const channel = input.channel ?? (input.platform ? "plugin_gateway" : "cli");
  const platform = normalizePlatform(input.platform ?? (channel === "tui" ? "local_tui" : undefined));
  const identityKey = normalizeIdentity(input.identity_key);
  const conversationId = normalizeIdentity(input.conversation_id);
  const userId = normalizeIdentity(input.user_id ?? input.sender_id);
  const metadataGoalId = typeof input.metadata?.["goal_id"] === "string"
    ? input.metadata["goal_id"].trim()
    : typeof input.metadata?.["routed_goal_id"] === "string"
      ? input.metadata["routed_goal_id"].trim()
      : "";
  const goalId = normalizeIdentity(input.goal_id ?? metadataGoalId);
  const actorSurface = inferActorSurface(channel);
  const metadata: Record<string, unknown> = {
    ...(input.metadata ?? {}),
    ...(goalId ? { goal_id: goalId } : {}),
  };
  const preapproved = input.runtimeControl?.approvalMode === "preapproved"
    || input.runtimeControl?.approval_mode === "preapproved"
    || metadata["runtime_control_approved"] === true;
  const interactiveDefault = channel === "tui" || channel === "cli";
  const allowed = input.runtimeControl?.allowed ?? (preapproved || interactiveDefault);
  const approvalMode = input.runtimeControl?.approvalMode
    ?? input.runtimeControl?.approval_mode
    ?? (preapproved ? "preapproved" : interactiveDefault ? "interactive" : "disallowed");

  const actor: RuntimeControlActor = input.actor ?? {
    surface: actorSurface,
    ...(platform ? { platform } : {}),
    ...(conversationId ? { conversation_id: conversationId } : {}),
    ...(identityKey ? { identity_key: identityKey } : {}),
    ...(userId ? { user_id: userId } : {}),
  };
  const replyTarget: IngressReplyTarget = {
    surface: actor.surface,
    channel,
    ...(platform ? { platform } : {}),
    ...(conversationId ? { conversation_id: conversationId } : {}),
    ...(identityKey ? { identity_key: identityKey } : {}),
    ...(userId ? { user_id: userId } : {}),
    ...(input.message_id ? { message_id: input.message_id } : {}),
    metadata,
    ...(input.replyTarget ?? {}),
  };

  return {
    ingress_id: input.ingress_id ?? randomUUID(),
    received_at: input.received_at ?? new Date().toISOString(),
    channel,
    ...(platform ? { platform } : {}),
    ...(identityKey ? { identity_key: identityKey } : {}),
    ...(conversationId ? { conversation_id: conversationId } : {}),
    ...(input.message_id ? { message_id: input.message_id } : {}),
    ...(goalId ? { goal_id: goalId } : {}),
    ...(userId ? { user_id: userId } : {}),
    ...(input.user_name ? { user_name: input.user_name } : {}),
    text: input.text,
    actor,
    runtimeControl: {
      allowed,
      approvalMode,
      approval_mode: approvalMode,
    },
    ...(input.deliveryMode ? { deliveryMode: input.deliveryMode } : {}),
    metadata,
    replyTarget,
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.onEvent ? { onEvent: input.onEvent } : {}),
  };
}

export function buildStandaloneIngressMessage(input: NormalizeLegacyIngressInput): ChatIngressMessage {
  return normalizeLegacyIngressInput(input);
}

export function createIngressRouter(): IngressRouter {
  return new IngressRouter();
}

export function describeSelectedRoute(route: SelectedChatRoute): string {
  return `${route.kind} (${route.reason}, reply=${route.replyTargetPolicy}, events=${route.eventProjectionPolicy}, concurrency=${route.concurrencyPolicy})`;
}

export type IngressMessage = ChatIngressMessage;
export type IngressRuntimeControl = ChatIngressRuntimeControl;
export type ChatSelectedRoute = SelectedChatRoute;
export type ChatIngressChannel = IngressChannel;
export type ChatIngressReplyTarget = IngressReplyTarget;
