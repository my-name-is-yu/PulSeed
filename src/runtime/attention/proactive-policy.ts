import { z } from "zod";
import {
  CognitionRefSchema,
  ProactiveDeliveryKindSchema,
  deliveryKindRank,
  type CognitionRef,
  type ProactiveDeliveryKind,
} from "../cognition/index.js";

export const ProactivePolicyModeSchema = z.enum(["active", "quiet", "suspended"]);
export type ProactivePolicyMode = z.infer<typeof ProactivePolicyModeSchema>;

const DateTimeStringSchema = z.string().datetime();

export const ProactivePolicyStateSchema = z.object({
  schema_version: z.literal("proactive-policy-state/v1"),
  policy_id: z.string().min(1),
  mode: ProactivePolicyModeSchema,
  max_delivery_kind: ProactiveDeliveryKindSchema,
  cooldown_refs: z.array(CognitionRefSchema).default([]),
  feedback_refs: z.array(CognitionRefSchema).default([]),
  no_backlog_flush_after_quiet_lift_at: z.string().datetime().optional(),
  updated_at: z.string().datetime(),
  runtime_authority: z.literal(false).default(false),
}).strict();
export type ProactivePolicyState = z.infer<typeof ProactivePolicyStateSchema>;

export const ProactivePolicyEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("feedback"),
    feedback_ref: CognitionRefSchema,
    feedback_kind: z.enum(["accepted", "dismissed", "overreach", "correction", "permission_revoked"]),
    recorded_at: z.string().datetime(),
  }).strict(),
  z.object({
    kind: z.literal("quiet_entered"),
    control_ref: CognitionRefSchema,
    recorded_at: z.string().datetime(),
  }).strict(),
  z.object({
    kind: z.literal("quiet_lifted"),
    control_ref: CognitionRefSchema,
    recorded_at: z.string().datetime(),
  }).strict(),
]);
export type ProactivePolicyEvent = z.infer<typeof ProactivePolicyEventSchema>;

export const ProactiveDeliveryPolicyDecisionSchema = z.object({
  requested_delivery_kind: ProactiveDeliveryKindSchema,
  allowed_delivery_kind: ProactiveDeliveryKindSchema,
  reason: z.enum([
    "allowed",
    "quiet_or_suspended",
    "cooldown",
    "no_backlog_flush",
  ]),
  reason_refs: z.array(CognitionRefSchema).default([]),
  runtime_authority: z.literal(false).default(false),
}).strict();
export type ProactiveDeliveryPolicyDecision = z.infer<typeof ProactiveDeliveryPolicyDecisionSchema>;

export function createProactivePolicyState(input: {
  policyId: string;
  now: string;
  mode?: ProactivePolicyMode;
  maxDeliveryKind?: ProactiveDeliveryKind;
}): ProactivePolicyState {
  return ProactivePolicyStateSchema.parse({
    schema_version: "proactive-policy-state/v1",
    policy_id: input.policyId,
    mode: input.mode ?? "active",
    max_delivery_kind: input.maxDeliveryKind ?? "suggest",
    cooldown_refs: [],
    feedback_refs: [],
    updated_at: input.now,
    runtime_authority: false,
  });
}

export function reduceProactivePolicyState(
  state: ProactivePolicyState,
  event: ProactivePolicyEvent
): ProactivePolicyState {
  const parsedState = ProactivePolicyStateSchema.parse(state);
  const parsedEvent = ProactivePolicyEventSchema.parse(event);
  if (parsedEvent.kind === "quiet_entered") {
    return ProactivePolicyStateSchema.parse({
      ...parsedState,
      mode: "quiet",
      max_delivery_kind: minDelivery(parsedState.max_delivery_kind, "digest"),
      updated_at: parsedEvent.recorded_at,
    });
  }
  if (parsedEvent.kind === "quiet_lifted") {
    return ProactivePolicyStateSchema.parse({
      ...parsedState,
      mode: "active",
      no_backlog_flush_after_quiet_lift_at: parsedEvent.recorded_at,
      updated_at: parsedEvent.recorded_at,
    });
  }
  const feedbackRefs = [...parsedState.feedback_refs, parsedEvent.feedback_ref];
  if (parsedEvent.feedback_kind === "accepted") {
    return ProactivePolicyStateSchema.parse({
      ...parsedState,
      feedback_refs: uniqueRefs(feedbackRefs),
      updated_at: parsedEvent.recorded_at,
    });
  }
  return ProactivePolicyStateSchema.parse({
    ...parsedState,
    max_delivery_kind: minDelivery(parsedState.max_delivery_kind, parsedEvent.feedback_kind === "overreach" ? "hold" : "digest"),
    cooldown_refs: uniqueRefs([...parsedState.cooldown_refs, parsedEvent.feedback_ref]),
    feedback_refs: uniqueRefs(feedbackRefs),
    updated_at: parsedEvent.recorded_at,
  });
}

export function decideProactiveDelivery(input: {
  state: ProactivePolicyState;
  requestedDeliveryKind: ProactiveDeliveryKind;
  candidateCreatedAt: string;
}): ProactiveDeliveryPolicyDecision {
  const state = ProactivePolicyStateSchema.parse(input.state);
  const candidateCreatedAtMs = instantMs(input.candidateCreatedAt);
  if (state.mode !== "active") {
    return decision(input.requestedDeliveryKind, "hold", "quiet_or_suspended", state.cooldown_refs);
  }
  if (
    state.no_backlog_flush_after_quiet_lift_at
    && candidateCreatedAtMs < instantMs(state.no_backlog_flush_after_quiet_lift_at)
  ) {
    return decision(input.requestedDeliveryKind, "hold", "no_backlog_flush", []);
  }
  if (state.cooldown_refs.length > 0 && deliveryKindRank(state.max_delivery_kind) <= deliveryKindRank("digest")) {
    return decision(input.requestedDeliveryKind, minDelivery(input.requestedDeliveryKind, state.max_delivery_kind), "cooldown", state.cooldown_refs);
  }
  return decision(input.requestedDeliveryKind, minDelivery(input.requestedDeliveryKind, state.max_delivery_kind), "allowed", []);
}

function decision(
  requested: ProactiveDeliveryKind,
  allowed: ProactiveDeliveryKind,
  reason: ProactiveDeliveryPolicyDecision["reason"],
  reasonRefs: CognitionRef[]
): ProactiveDeliveryPolicyDecision {
  return ProactiveDeliveryPolicyDecisionSchema.parse({
    requested_delivery_kind: requested,
    allowed_delivery_kind: allowed,
    reason,
    reason_refs: reasonRefs,
    runtime_authority: false,
  });
}

function minDelivery(left: ProactiveDeliveryKind, right: ProactiveDeliveryKind): ProactiveDeliveryKind {
  return deliveryKindRank(left) <= deliveryKindRank(right) ? left : right;
}

function instantMs(value: string): number {
  return Date.parse(DateTimeStringSchema.parse(value));
}

function uniqueRefs(refs: CognitionRef[]): CognitionRef[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.kind}:${ref.ref}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
