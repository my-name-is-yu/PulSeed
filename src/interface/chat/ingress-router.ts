import { randomUUID } from "node:crypto";
import type { ChatEventHandler } from "./chat-events.js";
import type { RuntimeControlIntent } from "../../runtime/control/index.js";
import type { FreeformRouteIntent } from "./freeform-route-classifier.js";
import type { SetupSecretIntakeResult } from "./setup-secret-intake.js";
import type { RunSpec } from "../../runtime/run-spec/index.js";
import { normalizeUserInput, type UserInput } from "./user-input.js";
import type {
  RuntimeControlActor,
  RuntimeControlReplyTarget,
} from "../../runtime/store/runtime-operation-schemas.js";
import type { CompanionRuntimeContract } from "../../runtime/types/companion.js";
import {
  EXTERNAL_SURFACE_METADATA_KEY,
  type ExternalSurfaceDecision,
} from "../../runtime/gateway/channel-policy.js";

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
  userInput: UserInput;
  actor: RuntimeControlActor;
  runtimeControl: ChatIngressRuntimeControl;
  companion?: CompanionRuntimeContract;
  externalSurface?: ExternalSurfaceDecision;
  deliveryMode?: IngressDeliveryMode;
  metadata: Record<string, unknown>;
  replyTarget: IngressReplyTarget;
  cwd?: string;
  timeoutMs?: number;
  onEvent?: ChatEventHandler;
}

export type SelectedChatRoute =
  | {
      kind: "assist" | "configure" | "clarify";
      reason: "freeform_semantic_route";
      intent: FreeformRouteIntent;
      replyTargetPolicy: ReplyTargetPolicy;
      eventProjectionPolicy: EventProjectionPolicy;
      concurrencyPolicy: ConcurrencyPolicy;
    }
  | {
      kind: "agent_loop" | "tool_loop" | "adapter";
      reason: "agent_loop_available" | "tool_loop_available" | "adapter_fallback";
      replyTargetPolicy: ReplyTargetPolicy;
      eventProjectionPolicy: EventProjectionPolicy;
      concurrencyPolicy: ConcurrencyPolicy;
    }
  | {
      kind: "run_spec_draft";
      reason: "run_spec_draft_intent";
      draft: RunSpec;
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
    }
  | {
      kind: "runtime_control_blocked";
      reason: "runtime_control_unavailable" | "runtime_control_disallowed" | "runtime_control_unclassified";
      intent?: RuntimeControlIntent;
      replyTargetPolicy: ReplyTargetPolicy;
      eventProjectionPolicy: EventProjectionPolicy;
      concurrencyPolicy: ConcurrencyPolicy;
    };

export interface IngressRouterCapabilities {
  hasAgentLoop: boolean;
  hasToolLoop: boolean;
  hasRuntimeControlService?: boolean;
  runtimeControlIntent?: RuntimeControlIntent | null;
  runtimeControlUnclassified?: boolean;
  freeformRouteIntent?: FreeformRouteIntent | null;
  setupSecretIntake?: SetupSecretIntakeResult | null;
  runSpecDraft?: RunSpec | null;
}

function selectRouteForText(
  _text: string,
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
  const canUseRuntimeControlRoute =
    runtimeControl.allowed && runtimeControl.approvalMode !== "disallowed";

  if (deps.hasAgentLoop) {
    const intent = deps.runtimeControlIntent ?? null;
    if (intent === null && deps.runtimeControlUnclassified === true) {
      return {
        kind: "runtime_control_blocked",
        reason: "runtime_control_unclassified",
        ...runtimeControlPolicy,
      };
    }
    if (intent !== null && !canUseRuntimeControlRoute) {
      return {
        kind: "runtime_control_blocked",
        reason: "runtime_control_disallowed",
        intent,
        ...runtimeControlPolicy,
      };
    }
    if (intent !== null && deps.hasRuntimeControlService !== true) {
      return {
        kind: "runtime_control_blocked",
        reason: "runtime_control_unavailable",
        intent,
        ...runtimeControlPolicy,
      };
    }
    if (intent !== null) {
      return {
        kind: "runtime_control",
        reason: "runtime_control_intent",
        intent,
        ...runtimeControlPolicy,
      };
    }
    return {
      kind: "agent_loop",
      reason: "agent_loop_available",
      ...baseTurnPolicy,
    };
  }

  if (canUseRuntimeControlRoute) {
    const intent = deps.runtimeControlIntent ?? null;
    if (intent === null && deps.runtimeControlUnclassified === true) {
      return {
        kind: "runtime_control_blocked",
        reason: "runtime_control_unclassified",
        ...runtimeControlPolicy,
      };
    }
    if (intent !== null && deps.hasRuntimeControlService === true) {
      return {
        kind: "runtime_control",
        reason: "runtime_control_intent",
        intent,
        ...runtimeControlPolicy,
      };
    }
    if (intent !== null) {
      return {
        kind: "runtime_control_blocked",
        reason: "runtime_control_unavailable",
        intent,
        ...runtimeControlPolicy,
      };
    }
  } else {
    const intent = deps.runtimeControlIntent ?? null;
    if (intent === null && deps.runtimeControlUnclassified === true) {
      return {
        kind: "runtime_control_blocked",
        reason: "runtime_control_unclassified",
        ...runtimeControlPolicy,
      };
    }
    if (intent !== null) {
      return {
        kind: "runtime_control_blocked",
        reason: "runtime_control_disallowed",
        intent,
        ...runtimeControlPolicy,
      };
    }
  }

  const setupSecretKinds = new Set((deps.setupSecretIntake?.suppliedSecrets ?? []).map((secret) => secret.kind));
  if (setupSecretKinds.has("telegram_bot_token")) {
    return {
      kind: "configure",
      reason: "freeform_semantic_route",
      intent: {
        kind: "configure",
        confidence: 1,
        configure_target: "telegram_gateway",
        rationale: "typed setup secret intake detected a Telegram bot token",
      },
      ...baseTurnPolicy,
    };
  }
  if (setupSecretKinds.has("discord_bot_token")) {
    return {
      kind: "configure",
      reason: "freeform_semantic_route",
      intent: {
        kind: "configure",
        confidence: 1,
        configure_target: "gateway",
        rationale: "typed setup secret intake detected a Discord bot token",
      },
      ...baseTurnPolicy,
    };
  }

  const runSpecDraft = deps.runSpecDraft ?? null;
  if (runSpecDraft) {
    return {
      kind: "run_spec_draft",
      reason: "run_spec_draft_intent",
      draft: runSpecDraft,
      ...baseTurnPolicy,
    };
  }

  const freeformIntent = deps.freeformRouteIntent ?? null;
  if (freeformIntent && freeformIntent.confidence >= 0.7) {
    if (freeformIntent.kind === "assist" || freeformIntent.kind === "configure" || freeformIntent.kind === "clarify") {
      return {
        kind: freeformIntent.kind,
        reason: "freeform_semantic_route",
        intent: freeformIntent,
        ...baseTurnPolicy,
      };
    }
  }
  if (freeformIntent && freeformIntent.kind !== "execute") {
    return {
      kind: "clarify",
      reason: "freeform_semantic_route",
      intent: { ...freeformIntent, kind: "clarify" },
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
  userInput?: UserInput;
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
  companion?: CompanionRuntimeContract;
  externalSurface?: ExternalSurfaceDecision;
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
  const externalSurface = input.externalSurface;
  const metadata: Record<string, unknown> = {
    ...(input.metadata ?? {}),
    ...(externalSurface ? { [EXTERNAL_SURFACE_METADATA_KEY]: externalSurface } : {}),
    ...(goalId ? { goal_id: goalId } : {}),
  };
  if (!externalSurface) {
    delete metadata[EXTERNAL_SURFACE_METADATA_KEY];
  }
  const userInput = normalizeUserInput(input.userInput, input.text);
  const surfacePreapproved = externalSurface?.runtime_control_policy.allowed === true
    && externalSurface.runtime_control_policy.approval_mode === "preapproved";
  const surfaceDenied = externalSurface?.runtime_control_policy.approval_mode === "disallowed";
  const preapproved = input.runtimeControl?.approvalMode === "preapproved"
    || input.runtimeControl?.approval_mode === "preapproved"
    || (externalSurface ? surfacePreapproved : metadata["runtime_control_approved"] === true);
  const disallowedByMetadata = metadata["runtime_control_denied"] === true || surfaceDenied;
  const interactiveDefault = channel === "tui" || channel === "cli";
  const allowed = input.runtimeControl?.allowed ?? (preapproved || interactiveDefault);
  const approvalMode = input.runtimeControl?.approvalMode
    ?? input.runtimeControl?.approval_mode
    ?? (externalSurface
      ? surfacePreapproved ? "preapproved" : "disallowed"
      : preapproved ? "preapproved" : disallowedByMetadata ? "disallowed" : interactiveDefault ? "interactive" : "disallowed");

  const actor: RuntimeControlActor = input.actor ?? {
    surface: actorSurface,
    ...(platform ? { platform } : {}),
    ...(conversationId ? { conversation_id: conversationId } : {}),
    ...(identityKey ? { identity_key: identityKey } : {}),
    ...(userId ? { user_id: userId } : {}),
  };
  const replyTargetMetadata: Record<string, unknown> = {
    ...metadata,
    ...(input.replyTarget?.metadata ?? {}),
    ...(externalSurface ? { [EXTERNAL_SURFACE_METADATA_KEY]: externalSurface } : {}),
  };
  if (externalSurface) {
    delete replyTargetMetadata["notification_route_id"];
  }
  const replyTarget: IngressReplyTarget = {
    surface: actor.surface,
    channel,
    ...(platform ? { platform } : {}),
    ...(conversationId ? { conversation_id: conversationId } : {}),
    ...(identityKey ? { identity_key: identityKey } : {}),
    ...(userId ? { user_id: userId } : {}),
    ...(input.message_id ? { message_id: input.message_id } : {}),
    ...(input.replyTarget ?? {}),
    metadata: replyTargetMetadata,
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
    userInput,
    actor,
    runtimeControl: {
      allowed,
      approvalMode,
      approval_mode: approvalMode,
    },
    companion: input.companion ?? {
      schema_version: "companion-runtime-contract-v1",
      presence: {
        schema_version: "companion-presence-state-v1",
        mode: "available",
        interruptible: true,
        last_user_activity_at: input.received_at ?? new Date().toISOString(),
        current_context: "unknown",
        current_target: {
          session_key: null,
          conversation_id: conversationId ?? null,
          message_id: input.message_id ?? null,
          run_id: null,
          goal_id: goalId ?? null,
          reply_target_id: conversationId ?? identityKey ?? null,
        },
      },
      turn_policy: {
        schema_version: "companion-turn-policy-v1",
        dialogue_kind: "direct_turn",
        input_modality: "text",
        output_mode: "reply",
        can_interrupt: true,
        latency_budget_ms: 120_000,
        urgency: "normal",
        quieting: "allow",
        requires_explicit_interruption: false,
        current_target: {
          session_key: null,
          conversation_id: conversationId ?? null,
          message_id: input.message_id ?? null,
          run_id: null,
          goal_id: goalId ?? null,
          reply_target_id: conversationId ?? identityKey ?? null,
        },
      },
    },
    ...(externalSurface ? { externalSurface } : {}),
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
