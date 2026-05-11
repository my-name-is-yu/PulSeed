import { randomUUID } from "node:crypto";
import {
  EXTERNAL_SURFACE_METADATA_KEY,
  type ExternalSurfaceDecision,
} from "../../runtime/gateway/channel-policy.js";
import type { RuntimeControlActor } from "../../runtime/store/runtime-operation-schemas.js";
import type {
  ChatIngressChannel,
  ChatIngressReplyTarget,
  ChatIngressRuntimeControl,
} from "./ingress-router.js";

export interface CrossPlatformSessionKeyParts {
  identity_key?: string;
  platform?: string;
  conversation_id?: string;
  user_id?: string;
}

export interface CrossPlatformSessionMetadataInput {
  metadata?: Record<string, unknown>;
  platform?: string;
  conversation_id?: string;
  conversation_name?: string;
  user_id?: string;
  user_name?: string;
  channel?: ChatIngressChannel;
}

export function normalizeIdentity(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function normalizePlatform(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLowerCase() : null;
}

export function buildSessionKeyFromParts(params: CrossPlatformSessionKeyParts): string {
  const identityKey = normalizeIdentity(params.identity_key);
  if (identityKey) {
    return `identity:${identityKey}`;
  }

  const platform = normalizePlatform(params.platform);
  const conversationId = normalizeIdentity(params.conversation_id);
  if (platform && conversationId) {
    return `platform:${platform}:conversation:${conversationId}`;
  }

  const userId = normalizeIdentity(params.user_id);
  if (platform && userId) {
    return `platform:${platform}:user:${userId}`;
  }

  return `ephemeral:${randomUUID()}`;
}

export function cloneMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  return metadata ? { ...metadata } : {};
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function cloneReplyTarget(target: Record<string, unknown> | ChatIngressReplyTarget): ChatIngressReplyTarget {
  return {
    ...target,
    metadata: isRecord(target.metadata) ? cloneMetadata(target.metadata) : {},
  } as ChatIngressReplyTarget;
}

export function stringField(value: Record<string, unknown> | undefined, field: string): string | undefined {
  const fieldValue = value?.[field];
  return typeof fieldValue === "string" && fieldValue.trim() ? fieldValue : undefined;
}

export function buildSessionMetadata(options: CrossPlatformSessionMetadataInput): Record<string, unknown> {
  return {
    ...(options.metadata ?? {}),
    ...(options.channel ? { channel: options.channel } : {}),
    ...(options.platform ? { platform: options.platform } : {}),
    ...(options.conversation_id ? { conversation_id: options.conversation_id } : {}),
    ...(options.conversation_name ? { conversation_name: options.conversation_name } : {}),
    ...(options.user_id ? { user_id: options.user_id } : {}),
    ...(options.user_name ? { user_name: options.user_name } : {}),
  };
}

export function resolveChannel(
  input: { channel?: ChatIngressChannel; platform?: string }
): ChatIngressChannel {
  if (input.channel) return input.channel;
  return input.platform ? "plugin_gateway" : "cli";
}

export function resolveActorSurface(channel: ChatIngressChannel): RuntimeControlActor["surface"] {
  switch (channel) {
    case "plugin_gateway":
      return "gateway";
    case "cli":
      return "cli";
    case "tui":
      return "tui";
    default:
      return "chat";
  }
}

export function resolveRuntimeControl(
  channel: ChatIngressChannel,
  runtimeControl: Partial<ChatIngressRuntimeControl> | undefined,
  metadata: Record<string, unknown> | undefined,
  externalSurface: ExternalSurfaceDecision | undefined
): ChatIngressRuntimeControl {
  const surfacePreapproved = externalSurface?.runtime_control_policy.allowed === true
    && externalSurface.runtime_control_policy.approval_mode === "preapproved";
  const surfaceDenied = externalSurface?.runtime_control_policy.approval_mode === "disallowed";
  const approvalMode = runtimeControl?.approvalMode
    ?? (externalSurface
      ? surfacePreapproved ? "preapproved" : "disallowed"
      : metadata?.["runtime_control_approved"] === true
        ? "preapproved"
        : surfaceDenied || metadata?.["runtime_control_denied"] === true
          ? "disallowed"
          : channel === "tui" || channel === "cli"
            ? "interactive"
            : "disallowed");
  return {
    allowed: runtimeControl?.allowed ?? approvalMode !== "disallowed",
    approvalMode,
    ...(runtimeControl?.explicit === true ? { explicit: true } : {}),
  };
}

export function normalizeReplyTarget(
  channel: ChatIngressChannel,
  input: {
    platform?: string;
    conversation_id?: string;
    identity_key?: string;
    user_id?: string;
    message_id?: string;
    replyTarget?: Partial<ChatIngressReplyTarget>;
    metadata?: Record<string, unknown>;
    externalSurface?: ExternalSurfaceDecision;
  }
): ChatIngressReplyTarget {
  const platform = normalizePlatform(input.replyTarget?.platform ?? input.platform) ?? undefined;
  const conversationId = normalizeIdentity(input.replyTarget?.conversation_id ?? input.conversation_id) ?? undefined;
  const identityKey = normalizeIdentity(input.replyTarget?.identity_key ?? input.identity_key) ?? undefined;
  const userId = normalizeIdentity(input.replyTarget?.user_id ?? input.user_id) ?? undefined;
  const messageId = normalizeIdentity(input.replyTarget?.message_id ?? input.message_id) ?? undefined;
  const metadata: Record<string, unknown> = {
    ...(input.metadata ?? {}),
    ...(input.replyTarget?.metadata ?? {}),
    ...(input.externalSurface ? { [EXTERNAL_SURFACE_METADATA_KEY]: input.externalSurface } : {}),
  };
  if (input.externalSurface) {
    delete metadata["notification_route_id"];
  } else {
    delete metadata[EXTERNAL_SURFACE_METADATA_KEY];
  }

  return {
    surface: input.replyTarget?.surface ?? resolveActorSurface(channel),
    ...(platform ? { platform } : {}),
    ...(conversationId ? { conversation_id: conversationId } : {}),
    ...(identityKey ? { identity_key: identityKey } : {}),
    ...(userId ? { user_id: userId } : {}),
    ...(messageId ? { message_id: messageId } : {}),
    deliveryMode: input.replyTarget?.deliveryMode ?? "reply",
    ...input.replyTarget,
    metadata,
  };
}

export function normalizeActor(
  channel: ChatIngressChannel,
  input: {
    platform?: string;
    conversation_id?: string;
    identity_key?: string;
    user_id?: string;
    actor?: Partial<RuntimeControlActor>;
  }
): RuntimeControlActor {
  const platform = normalizePlatform(input.actor?.platform ?? input.platform) ?? undefined;
  const conversationId = normalizeIdentity(input.actor?.conversation_id ?? input.conversation_id) ?? undefined;
  const identityKey = normalizeIdentity(input.actor?.identity_key ?? input.identity_key) ?? undefined;
  const userId = normalizeIdentity(input.actor?.user_id ?? input.user_id) ?? undefined;

  return {
    surface: input.actor?.surface ?? resolveActorSurface(channel),
    ...(platform ? { platform } : {}),
    ...(conversationId ? { conversation_id: conversationId } : {}),
    ...(identityKey ? { identity_key: identityKey } : {}),
    ...(userId ? { user_id: userId } : {}),
    ...input.actor,
  };
}
