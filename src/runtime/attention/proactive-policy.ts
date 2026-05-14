import { z } from "zod";
import {
  CognitionRefSchema,
  ProactiveDeliveryKindSchema,
  PrivacyProfileSchema,
  SideEffectProfileSchema,
  deliveryKindRank,
  type CognitionRef,
  type ProactiveDeliveryKind,
} from "../cognition/index.js";

export const ProactivePolicyModeSchema = z.enum(["active", "quiet", "suspended"]);
export type ProactivePolicyMode = z.infer<typeof ProactivePolicyModeSchema>;

const DateTimeStringSchema = z.string().datetime();

const ProactivityDefaultProfileSchema = z.object({
  profile_id: z.literal("helpful_nudge"),
  default_max_delivery_kind: z.literal("suggest"),
  digest_bias: z.literal("low_value_or_recently_dismissed"),
  notify_requires: z.literal("high_urgency_or_deadline_risk"),
  ask_requires: z.literal("missing_user_decision_or_exact_approval"),
  prepare_requires: z.literal("local_reversible_current_boundary"),
  execute_requires: z.literal("preauthorized_downstream_owner"),
}).strict();
export type ProactivityDefaultProfile = z.infer<typeof ProactivityDefaultProfileSchema>;

export const HelpfulNudgeProactivityProfile: ProactivityDefaultProfile = {
  profile_id: "helpful_nudge",
  default_max_delivery_kind: "suggest",
  digest_bias: "low_value_or_recently_dismissed",
  notify_requires: "high_urgency_or_deadline_risk",
  ask_requires: "missing_user_decision_or_exact_approval",
  prepare_requires: "local_reversible_current_boundary",
  execute_requires: "preauthorized_downstream_owner",
};

export const ProactiveDisplayDeliveryKindSchema = z.enum([
  "hold",
  "digest",
  "suggest",
  "notify",
  "ask",
  "prepare",
  "execute",
]);
export type ProactiveDisplayDeliveryKind = z.infer<typeof ProactiveDisplayDeliveryKindSchema>;

export const ProactiveInterruptionBudgetScopeSchema = z.enum([
  "global",
  "goal",
  "surface",
  "relationship_boundary",
]);
export type ProactiveInterruptionBudgetScope = z.infer<typeof ProactiveInterruptionBudgetScopeSchema>;

export const ProactiveInterruptionBudgetSurfaceSchema = z.enum([
  "cli",
  "tui",
  "gateway",
  "gui",
  "daemon",
]);
export type ProactiveInterruptionBudgetSurface = z.infer<typeof ProactiveInterruptionBudgetSurfaceSchema>;

export const ProactiveInterruptionBudgetSchema = z.object({
  budget_id: z.string().min(1),
  scope: ProactiveInterruptionBudgetScopeSchema,
  surface: ProactiveInterruptionBudgetSurfaceSchema,
  window_started_at: z.string().datetime(),
  window_ends_at: z.string().datetime(),
  max_notify: z.number().int().nonnegative(),
  max_ask: z.number().int().nonnegative(),
  max_prepare: z.number().int().nonnegative(),
  current_debits: z.number().int().nonnegative(),
  quiet_mode_active: z.boolean(),
  no_backlog_flush_after: z.string().datetime().optional(),
}).strict();
export type ProactiveInterruptionBudget = z.infer<typeof ProactiveInterruptionBudgetSchema>;

export const ProactivePolicyStateSchema = z.object({
  schema_version: z.literal("proactive-policy-state/v1"),
  policy_id: z.string().min(1),
  mode: ProactivePolicyModeSchema,
  max_delivery_kind: ProactiveDeliveryKindSchema,
  default_profile: ProactivityDefaultProfileSchema.default(HelpfulNudgeProactivityProfile),
  interruption_budget: ProactiveInterruptionBudgetSchema.optional(),
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
  budget?: ProactiveInterruptionBudget;
}): ProactivePolicyState {
  return ProactivePolicyStateSchema.parse({
    schema_version: "proactive-policy-state/v1",
    policy_id: input.policyId,
    mode: input.mode ?? "active",
    max_delivery_kind: input.maxDeliveryKind ?? "suggest",
    default_profile: HelpfulNudgeProactivityProfile,
    ...(input.budget ? { interruption_budget: input.budget } : {}),
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

export const ProactiveUrgencySchema = z.enum(["none", "low", "medium", "high", "deadline"]);
export type ProactiveUrgency = z.infer<typeof ProactiveUrgencySchema>;

export const ProactiveReversibilitySchema = z.enum(["none", "easy", "moderate", "hard", "irreversible"]);
export type ProactiveReversibility = z.infer<typeof ProactiveReversibilitySchema>;

export const ProactiveOperationBoundarySchema = z.enum(["allowed", "held", "blocked", "unavailable"]);
export type ProactiveOperationBoundary = z.infer<typeof ProactiveOperationBoundarySchema>;

export const ProactiveThresholdInputSchema = z.object({
  candidate_ref: CognitionRefSchema,
  expected_user_value: z.number().min(0).max(1),
  interruption_cost: z.number().min(0).max(1),
  urgency: ProactiveUrgencySchema,
  confidence: z.number().min(0).max(1),
  reversibility: ProactiveReversibilitySchema,
  operation_boundary: ProactiveOperationBoundarySchema,
  side_effect_profile: SideEffectProfileSchema,
  privacy_profile: PrivacyProfileSchema,
  recent_feedback_refs: z.array(CognitionRefSchema).default([]),
  channel_budget_ref: CognitionRefSchema,
  quieting_active: z.boolean(),
  requires_user_decision_ref: CognitionRefSchema.optional(),
  requires_approval_ref: CognitionRefSchema.optional(),
  target_ref: CognitionRefSchema.optional(),
  stale_target_refs: z.array(CognitionRefSchema).default([]),
  prepared_artifact_ref: CognitionRefSchema.optional(),
  downstream_authorization_refs: z.array(CognitionRefSchema).default([]),
  requested_delivery_kind: ProactiveDeliveryKindSchema.optional(),
}).strict();
export type ProactiveThresholdInput = z.infer<typeof ProactiveThresholdInputSchema>;

export const ProactiveThresholdDecisionSchema = z.object({
  requested_delivery_kind: ProactiveDeliveryKindSchema,
  allowed_delivery_kind: ProactiveDeliveryKindSchema,
  display_delivery_kind: ProactiveDisplayDeliveryKindSchema,
  downgrade_reasons: z.array(z.string().min(1)).default([]),
  budget_debit: z.number().int().nonnegative(),
  feedback_policy_refs: z.array(CognitionRefSchema).default([]),
  budget_ref: CognitionRefSchema,
  requires_approval_ref: CognitionRefSchema.optional(),
  runtime_authority: z.literal(false).default(false),
}).strict();
export type ProactiveThresholdDecision = z.infer<typeof ProactiveThresholdDecisionSchema>;

export const ProactiveThresholdSurfaceProjectionSchema = z.object({
  schema_version: z.literal("proactive-threshold-surface-projection/v1"),
  surface_target: z.enum(["normal_user", "operator_debug"]),
  display_delivery_kind: ProactiveDisplayDeliveryKindSchema,
  allowed_delivery_kind: ProactiveDeliveryKindSchema,
  downgrade_reasons: z.array(z.string().min(1)).default([]),
  budget_status: z.object({
    budget_ref: CognitionRefSchema,
    budget_debit: z.number().int().nonnegative(),
    exhausted: z.boolean(),
  }).strict(),
  operator_refs: z.object({
    feedback_policy_refs: z.array(CognitionRefSchema).default([]),
    requires_approval_ref: CognitionRefSchema.optional(),
  }).strict().optional(),
  runtime_authority: z.literal(false).default(false),
}).strict();
export type ProactiveThresholdSurfaceProjection = z.infer<typeof ProactiveThresholdSurfaceProjectionSchema>;

export function decideProactiveThreshold(input: {
  state: ProactivePolicyState;
  thresholdInput: ProactiveThresholdInput;
  candidateCreatedAt: string;
}): ProactiveThresholdDecision {
  const state = ProactivePolicyStateSchema.parse(input.state);
  const thresholdInput = ProactiveThresholdInputSchema.parse(input.thresholdInput);
  const downgradeReasons: string[] = [];
  const requested = thresholdInput.requested_delivery_kind ?? requestedKindForThreshold(thresholdInput, downgradeReasons);
  let allowed = requested;

  const safetyCap = safetyDeliveryCap(thresholdInput, downgradeReasons);
  allowed = minDelivery(allowed, safetyCap);

  const budget = state.interruption_budget;
  if (thresholdInput.quieting_active || budget?.quiet_mode_active) {
    allowed = minDelivery(allowed, "hold");
    downgradeReasons.push("quieting_active");
  }

  const budgetCap = budgetDeliveryCap(thresholdInput, allowed, budget, downgradeReasons);
  allowed = minDelivery(allowed, budgetCap);

  const policyDecision = decideProactiveDelivery({
    state,
    requestedDeliveryKind: allowed,
    candidateCreatedAt: input.candidateCreatedAt,
  });
  if (policyDecision.reason !== "allowed") {
    downgradeReasons.push(policyDecision.reason);
  }
  allowed = policyDecision.allowed_delivery_kind;

  if (requested === "execute" || allowed === "execute") {
    allowed = "hold";
    downgradeReasons.push("resident_cognition_cannot_grant_execute");
  }

  const budgetDebit = budgetDebitFor(allowed);
  const feedbackPolicyRefs = uniqueRefs([
    ...thresholdInput.recent_feedback_refs,
    ...state.feedback_refs,
    ...policyDecision.reason_refs,
  ]);

  return ProactiveThresholdDecisionSchema.parse({
    requested_delivery_kind: requested,
    allowed_delivery_kind: allowed,
    display_delivery_kind: displayDeliveryKind(allowed),
    downgrade_reasons: uniqueStrings(downgradeReasons),
    budget_debit: budgetDebit,
    feedback_policy_refs: feedbackPolicyRefs,
    budget_ref: thresholdInput.channel_budget_ref,
    ...(thresholdInput.requires_approval_ref ? { requires_approval_ref: thresholdInput.requires_approval_ref } : {}),
    runtime_authority: false,
  });
}

export function projectProactiveThresholdDecisionForSurface(input: {
  decision: ProactiveThresholdDecision;
  surfaceTarget: "normal_user" | "operator_debug";
  budget?: ProactiveInterruptionBudget;
}): ProactiveThresholdSurfaceProjection {
  const decision = ProactiveThresholdDecisionSchema.parse(input.decision);
  const budget = input.budget ? ProactiveInterruptionBudgetSchema.parse(input.budget) : undefined;
  const exhausted = budget
    ? budget.current_debits + decision.budget_debit > budgetCapacityFor(decision.allowed_delivery_kind, budget)
    : false;

  return ProactiveThresholdSurfaceProjectionSchema.parse({
    schema_version: "proactive-threshold-surface-projection/v1",
    surface_target: input.surfaceTarget,
    display_delivery_kind: decision.display_delivery_kind,
    allowed_delivery_kind: decision.allowed_delivery_kind,
    downgrade_reasons: decision.downgrade_reasons,
    budget_status: {
      budget_ref: decision.budget_ref,
      budget_debit: decision.budget_debit,
      exhausted,
    },
    ...(input.surfaceTarget === "operator_debug" ? {
      operator_refs: {
        feedback_policy_refs: decision.feedback_policy_refs,
        ...(decision.requires_approval_ref ? { requires_approval_ref: decision.requires_approval_ref } : {}),
      },
    } : {}),
    runtime_authority: false,
  });
}

export function displayDeliveryKind(kind: ProactiveDeliveryKind): ProactiveDisplayDeliveryKind {
  return kind === "speak" ? "ask" : kind;
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

function requestedKindForThreshold(
  input: ProactiveThresholdInput,
  downgradeReasons: string[]
): ProactiveDeliveryKind {
  if (input.confidence < 0.45) {
    downgradeReasons.push("confidence_below_hold_floor");
    return "hold";
  }
  if (input.expected_user_value >= 0.75 && input.confidence >= 0.75 && input.interruption_cost <= 0.5) {
    if (
      input.operation_boundary === "allowed"
      && (input.reversibility === "easy" || input.reversibility === "moderate")
      && (input.side_effect_profile === "read" || input.side_effect_profile === "local_write")
      && input.privacy_profile !== "external_service"
      && input.privacy_profile !== "sensitive"
      && input.prepared_artifact_ref
    ) {
      return "prepare";
    }
    if (input.prepared_artifact_ref) {
      downgradeReasons.push("prepare_requires_local_reversible_current_boundary");
    }
  }
  if ((input.requires_user_decision_ref || input.requires_approval_ref) && passesAskCutoff(input)) {
    if (input.target_ref && hasRef(input.stale_target_refs, input.target_ref)) {
      downgradeReasons.push("stale_target_rejected");
      return "hold";
    }
    return "speak";
  }
  if ((input.urgency === "high" || input.urgency === "deadline") && passesNotifyCutoff(input)) {
    return "notify";
  }
  if (passesSuggestCutoff(input)) {
    return "suggest";
  }
  if (passesDigestCutoff(input)) {
    return "digest";
  }
  downgradeReasons.push("below_digest_threshold");
  return "hold";
}

function safetyDeliveryCap(
  input: ProactiveThresholdInput,
  downgradeReasons: string[]
): ProactiveDeliveryKind {
  if (input.operation_boundary === "blocked" || input.operation_boundary === "unavailable") {
    downgradeReasons.push("operation_boundary_blocked");
    return "hold";
  }
  if (input.privacy_profile === "sensitive") {
    downgradeReasons.push("sensitive_privacy_profile");
    return "hold";
  }
  if (input.requested_delivery_kind === "execute" && input.downstream_authorization_refs.length === 0) {
    downgradeReasons.push("missing_downstream_execute_authorization");
    return "hold";
  }
  if (
    input.requested_delivery_kind === "prepare"
    && !(
      input.operation_boundary === "allowed"
      && (input.reversibility === "easy" || input.reversibility === "moderate")
      && (input.side_effect_profile === "read" || input.side_effect_profile === "local_write")
    )
  ) {
    downgradeReasons.push("prepare_requires_local_reversible_current_boundary");
    return "suggest";
  }
  return "execute";
}

function budgetDeliveryCap(
  input: ProactiveThresholdInput,
  current: ProactiveDeliveryKind,
  budget: ProactiveInterruptionBudget | undefined,
  downgradeReasons: string[]
): ProactiveDeliveryKind {
  void input;
  if (!budget) return "execute";
  const parsedBudget = ProactiveInterruptionBudgetSchema.parse(budget);
  const capacity = budgetCapacityFor(current, parsedBudget);
  const debit = budgetDebitFor(current);
  if (debit > 0 && parsedBudget.current_debits + debit > capacity) {
    downgradeReasons.push("interruption_budget_exhausted");
    return current === "notify" ? "digest" : "hold";
  }
  return "execute";
}

function budgetCapacityFor(kind: ProactiveDeliveryKind, budget: ProactiveInterruptionBudget): number {
  if (kind === "notify") return budget.max_notify;
  if (kind === "speak") return budget.max_ask;
  if (kind === "prepare") return budget.max_prepare;
  return Number.MAX_SAFE_INTEGER;
}

function budgetDebitFor(kind: ProactiveDeliveryKind): number {
  return kind === "notify" || kind === "speak" || kind === "prepare" ? 1 : 0;
}

function passesDigestCutoff(input: ProactiveThresholdInput): boolean {
  return input.expected_user_value >= 0.35 && input.confidence >= 0.5 && input.interruption_cost <= 0.75;
}

function passesSuggestCutoff(input: ProactiveThresholdInput): boolean {
  return input.expected_user_value >= 0.55 && input.confidence >= 0.6 && input.interruption_cost <= 0.65;
}

function passesNotifyCutoff(input: ProactiveThresholdInput): boolean {
  return input.expected_user_value >= 0.65 && input.confidence >= 0.7 && input.interruption_cost <= 0.8;
}

function passesAskCutoff(input: ProactiveThresholdInput): boolean {
  return input.expected_user_value >= 0.6 && input.confidence >= 0.65 && input.interruption_cost <= 0.75;
}

function hasRef(refs: CognitionRef[], needle: CognitionRef): boolean {
  return refs.some((ref) => ref.kind === needle.kind && ref.ref === needle.ref);
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

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
