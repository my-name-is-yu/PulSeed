export interface ChannelAccessPolicy {
  /** When true, every sender is accepted unless denylist rejects it. */
  allowAll?: boolean;
  /** Sender/user allowlist. Empty means no allowlist restriction. */
  allowedSenderIds?: string[];
  /** Sender/user denylist. Denylist wins over allowAll and allowlist. */
  deniedSenderIds?: string[];
  /** Conversation/channel allowlist. Empty means no conversation restriction. */
  allowedConversationIds?: string[];
  /** Conversation/channel denylist. Denylist wins over allowlist. */
  deniedConversationIds?: string[];
  /** Senders allowed to run runtime-control commands from this channel. */
  runtimeControlAllowedSenderIds?: string[];
}

export interface ChannelRoutingPolicy {
  defaultGoalId?: string;
  conversationGoalMap?: Record<string, string>;
  channelGoalMap?: Record<string, string>;
  senderGoalMap?: Record<string, string>;
  identityKey?: string;
}

export interface ChannelMessageContext {
  platform: string;
  senderId?: string;
  conversationId?: string;
  channelId?: string;
}

export const EXTERNAL_SURFACE_METADATA_KEY = "external_surface";

export type ExternalSurfaceOperationKind = "turn_reply" | "runtime_control_execute";
export type ExternalSurfaceAccessReason =
  | "sender_denied"
  | "sender_not_allowed"
  | "conversation_denied"
  | "conversation_not_allowed";

export interface ExternalSurfaceDecision {
  schema_version: "external-surface-v1";
  surface_id: string;
  channel: string;
  direction: "inbound";
  actor_scope: "identified_external_actor" | "anonymous_external_actor";
  conversation_scope: {
    sender_id?: string;
    conversation_id?: string;
    channel_id?: string;
    identity_key?: string;
    goal_id?: string;
  };
  inbound_access: {
    allowed: boolean;
    reason?: ExternalSurfaceAccessReason;
  };
  reply_target_policy: {
    available: boolean;
    policy: "current_turn_only";
    delivery_mode: "reply";
    conversation_id?: string;
    channel_id?: string;
  };
  notification_route_policy: {
    configured: boolean;
    may_notify: false;
    reason: "route_config_is_not_notification_permission";
    identity_key?: string;
    goal_id?: string;
  };
  runtime_control_policy: {
    configured: boolean;
    allowed: boolean;
    approval_mode: "preapproved" | "disallowed";
    reason:
      | "sender_preapproved"
      | "sender_not_preapproved"
      | "inbound_denied"
      | "not_configured";
  };
  autonomy_authority: {
    may_initiate: false;
    reason: "external_surface_never_grants_autonomy";
  };
  auth_state_ref: string | null;
  quieting_policy_ref: string | null;
  allowed_operation_kinds: ExternalSurfaceOperationKind[];
  audit_policy: {
    record: true;
    event_family: "external_surface_ingress";
  };
}

export interface ChannelAccessDecision {
  allowed: boolean;
  reason?: "sender_denied" | "sender_not_allowed" | "conversation_denied" | "conversation_not_allowed";
  runtimeControlApproved: boolean;
  runtimeControlConfigured: boolean;
}

export interface ChannelRouteDecision {
  goalId?: string;
  identityKey?: string;
  metadata: Record<string, unknown>;
}

function normalizeList(values: readonly string[] | undefined): string[] {
  return (values ?? []).map((value) => value.trim()).filter(Boolean);
}

function includes(values: readonly string[] | undefined, value: string | undefined): boolean {
  if (!value) return false;
  return normalizeList(values).includes(value);
}

function isRestrictedByAllowlist(values: readonly string[] | undefined): boolean {
  return normalizeList(values).length > 0;
}

function surfaceSegment(value: string | undefined, fallback: string): string {
  return encodeURIComponent(value?.trim() || fallback);
}

export function evaluateChannelAccess(
  policy: ChannelAccessPolicy | undefined,
  context: ChannelMessageContext
): ChannelAccessDecision {
  const denySenders = policy?.deniedSenderIds;
  if (includes(denySenders, context.senderId)) {
    return { allowed: false, reason: "sender_denied", runtimeControlApproved: false, runtimeControlConfigured: false };
  }

  const denyConversations = policy?.deniedConversationIds;
  if (
    includes(denyConversations, context.conversationId) ||
    includes(denyConversations, context.channelId)
  ) {
    return { allowed: false, reason: "conversation_denied", runtimeControlApproved: false, runtimeControlConfigured: false };
  }

  const allowAll = policy?.allowAll ?? false;
  const allowSenders = policy?.allowedSenderIds;
  if (!allowAll && isRestrictedByAllowlist(allowSenders) && !includes(allowSenders, context.senderId)) {
    return { allowed: false, reason: "sender_not_allowed", runtimeControlApproved: false, runtimeControlConfigured: false };
  }

  const allowConversations = policy?.allowedConversationIds;
  if (
    isRestrictedByAllowlist(allowConversations) &&
    !includes(allowConversations, context.conversationId) &&
    !includes(allowConversations, context.channelId)
  ) {
    return { allowed: false, reason: "conversation_not_allowed", runtimeControlApproved: false, runtimeControlConfigured: false };
  }
  const runtimeControlConfigured = isRestrictedByAllowlist(policy?.runtimeControlAllowedSenderIds);

  return {
    allowed: true,
    runtimeControlApproved: includes(policy?.runtimeControlAllowedSenderIds, context.senderId),
    runtimeControlConfigured,
  };
}

export function resolveChannelRoute(
  policy: ChannelRoutingPolicy | undefined,
  context: ChannelMessageContext
): ChannelRouteDecision {
  const goalId =
    (context.conversationId ? policy?.conversationGoalMap?.[context.conversationId] : undefined) ??
    (context.channelId ? policy?.channelGoalMap?.[context.channelId] : undefined) ??
    (context.senderId ? policy?.senderGoalMap?.[context.senderId] : undefined) ??
    policy?.defaultGoalId;

  return {
    goalId,
    identityKey: policy?.identityKey,
    metadata: {
      platform: context.platform,
      ...(context.senderId ? { sender_id: context.senderId } : {}),
      ...(context.conversationId ? { conversation_id: context.conversationId } : {}),
      ...(context.channelId ? { channel_id: context.channelId } : {}),
      ...(goalId ? { routed_goal_id: goalId } : {}),
    },
  };
}

export function buildExternalSurfaceDecision(
  context: ChannelMessageContext,
  access: ChannelAccessDecision,
  route: ChannelRouteDecision
): ExternalSurfaceDecision {
  const hasReplyTarget = Boolean(context.conversationId ?? context.channelId ?? context.senderId);
  const routeConfigured = Boolean(route.goalId ?? route.identityKey);
  const runtimeControlAllowed = access.allowed && access.runtimeControlApproved;
  const allowedOperationKinds: ExternalSurfaceOperationKind[] = [];
  if (access.allowed && hasReplyTarget) {
    allowedOperationKinds.push("turn_reply");
  }
  if (runtimeControlAllowed) {
    allowedOperationKinds.push("runtime_control_execute");
  }

  return {
    schema_version: "external-surface-v1",
    surface_id: [
      "external",
      surfaceSegment(context.platform, "unknown-channel"),
      surfaceSegment(context.conversationId ?? context.channelId, "unknown-conversation"),
      surfaceSegment(context.senderId, "unknown-actor"),
    ].join(":"),
    channel: context.platform,
    direction: "inbound",
    actor_scope: context.senderId ? "identified_external_actor" : "anonymous_external_actor",
    conversation_scope: {
      ...(context.senderId ? { sender_id: context.senderId } : {}),
      ...(context.conversationId ? { conversation_id: context.conversationId } : {}),
      ...(context.channelId ? { channel_id: context.channelId } : {}),
      ...(route.identityKey ? { identity_key: route.identityKey } : {}),
      ...(route.goalId ? { goal_id: route.goalId } : {}),
    },
    inbound_access: {
      allowed: access.allowed,
      ...(access.reason ? { reason: access.reason } : {}),
    },
    reply_target_policy: {
      available: access.allowed && hasReplyTarget,
      policy: "current_turn_only",
      delivery_mode: "reply",
      ...(context.conversationId ? { conversation_id: context.conversationId } : {}),
      ...(context.channelId ? { channel_id: context.channelId } : {}),
    },
    notification_route_policy: {
      configured: routeConfigured,
      may_notify: false,
      reason: "route_config_is_not_notification_permission",
      ...(route.identityKey ? { identity_key: route.identityKey } : {}),
      ...(route.goalId ? { goal_id: route.goalId } : {}),
    },
    runtime_control_policy: {
      configured: access.runtimeControlConfigured,
      allowed: runtimeControlAllowed,
      approval_mode: runtimeControlAllowed ? "preapproved" : "disallowed",
      reason: !access.allowed
        ? "inbound_denied"
        : runtimeControlAllowed
          ? "sender_preapproved"
          : access.runtimeControlConfigured
            ? "sender_not_preapproved"
            : "not_configured",
    },
    autonomy_authority: {
      may_initiate: false,
      reason: "external_surface_never_grants_autonomy",
    },
    auth_state_ref: context.senderId ? `${context.platform}:sender:${context.senderId}` : null,
    quieting_policy_ref: null,
    allowed_operation_kinds: allowedOperationKinds,
    audit_policy: {
      record: true,
      event_family: "external_surface_ingress",
    },
  };
}

export function buildChannelPolicyMetadata(
  context: ChannelMessageContext,
  access: ChannelAccessDecision,
  route: ChannelRouteDecision,
  surface: ExternalSurfaceDecision = buildExternalSurfaceDecision(context, access, route)
): Record<string, unknown> {
  return {
    ...route.metadata,
    [EXTERNAL_SURFACE_METADATA_KEY]: surface,
    external_surface_id: surface.surface_id,
    ...(access.runtimeControlApproved ? { runtime_control_approved: true } : {}),
    ...(access.runtimeControlConfigured && !access.runtimeControlApproved ? { runtime_control_denied: true } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeExternalSurfaceDecision(value: unknown): ExternalSurfaceDecision | undefined {
  if (!isRecord(value)) return undefined;
  if (value["schema_version"] !== "external-surface-v1") return undefined;
  if (typeof value["surface_id"] !== "string" || typeof value["channel"] !== "string") return undefined;
  if (value["direction"] !== "inbound") return undefined;
  const runtimeControlPolicy = value["runtime_control_policy"];
  const notificationRoutePolicy = value["notification_route_policy"];
  const autonomyAuthority = value["autonomy_authority"];
  if (!isRecord(runtimeControlPolicy) || !isRecord(notificationRoutePolicy) || !isRecord(autonomyAuthority)) {
    return undefined;
  }
  if (notificationRoutePolicy["may_notify"] !== false || autonomyAuthority["may_initiate"] !== false) {
    return undefined;
  }
  return value as unknown as ExternalSurfaceDecision;
}
