import { z } from "zod";
import {
  PermissionGrantCapabilitySchema,
  PermissionGrantExcludedCapabilitySchema,
} from "../store/permission-grant-store.js";

const CompanionAutonomyRefKinds = [
  "runtime_item",
  "runtime_event",
  "runtime_control",
  "surface",
  "memory",
  "memory_candidate",
  "permission_grant",
  "relationship_permission",
  "approval",
  "tool_call",
  "conversation",
  "goal",
  "task",
  "session",
  "schedule_tick",
  "wait",
  "drive",
  "curiosity",
  "dream_artifact",
  "soil_retrieval",
  "correction",
  "automation",
  "guardrail",
  "backpressure",
  "user_activity",
  "feedback",
  "companion_state",
  "signal_context",
  "urge_candidate",
  "agent_agenda_item",
  "inhibition_decision",
  "initiative_gate_decision",
  "outcome_decision",
  "expression_decision",
  "audit_trace",
  "visibility_policy",
  "authority_check",
  "staleness_check",
  "safety_check",
  "control_policy",
  "surface_update_candidate",
  "action_candidate",
  "digest",
  "policy",
] as const;

export const CompanionAutonomyRefKindSchema = z.enum(CompanionAutonomyRefKinds);
export type CompanionAutonomyRefKind = z.infer<typeof CompanionAutonomyRefKindSchema>;

export const CompanionAutonomyRefSchema = z.object({
  kind: CompanionAutonomyRefKindSchema,
  id: z.string().min(1),
  version: z.string().min(1).optional(),
}).strict();
export type CompanionAutonomyRef = z.infer<typeof CompanionAutonomyRefSchema>;

function refWithKind(...allowedKinds: CompanionAutonomyRefKind[]) {
  return CompanionAutonomyRefSchema.refine((ref) => allowedKinds.includes(ref.kind), {
    message: `ref kind must be one of: ${allowedKinds.join(", ")}`,
  });
}

const AuditTraceRefSchema = refWithKind("audit_trace");
const InitiativeGateDecisionRefSchema = refWithKind("initiative_gate_decision");
const OutcomeDecisionRefSchema = refWithKind("outcome_decision");
const UrgeCandidateRefSchema = refWithKind("urge_candidate");
const VisibilityPolicyRefSchema = refWithKind("visibility_policy");

export const CompanionAutonomyContentLifecycleSchema = z.enum([
  "active",
  "redacted",
  "tombstone",
  "deleted",
]);
export type CompanionAutonomyContentLifecycle = z.infer<typeof CompanionAutonomyContentLifecycleSchema>;

export const CompanionAutonomySourceRefSchema = z.object({
  ref: CompanionAutonomyRefSchema,
  lifecycle: CompanionAutonomyContentLifecycleSchema.default("active"),
  redaction_reason: z.string().min(1).optional(),
}).strict();
export type CompanionAutonomySourceRef = z.infer<typeof CompanionAutonomySourceRefSchema>;

export const AttentionPrioritySchema = z.enum(["low", "normal", "high", "critical"]);
export type AttentionPriority = z.infer<typeof AttentionPrioritySchema>;

export const AttentionRiskLevelSchema = z.enum(["none", "low", "medium", "high", "critical"]);
export type AttentionRiskLevel = z.infer<typeof AttentionRiskLevelSchema>;

export const AttentionRiskAssessmentSchema = z.object({
  level: AttentionRiskLevelSchema,
  reason: z.string().min(1),
  evidence_refs: z.array(CompanionAutonomySourceRefSchema).default([]),
}).strict();
export type AttentionRiskAssessment = z.infer<typeof AttentionRiskAssessmentSchema>;

export const AttentionSensitivitySchema = z.enum([
  "public",
  "internal",
  "sensitive",
  "restricted",
]);
export type AttentionSensitivity = z.infer<typeof AttentionSensitivitySchema>;

export const SignalSourceSchema = z.enum([
  "runtime_event",
  "goal",
  "task",
  "session",
  "schedule_tick",
  "wait_expiry",
  "drive",
  "curiosity",
  "dream_artifact",
  "soil_retrieval",
  "correction",
  "automation",
  "guardrail",
  "backpressure",
]);
export type SignalSource = z.infer<typeof SignalSourceSchema>;

export const TimingContextSchema = z.object({
  observed_at: z.string().datetime(),
  local_time_zone: z.string().min(1).optional(),
  quiet_hours_active: z.boolean().default(false),
  cooldown_refs: z.array(CompanionAutonomyRefSchema).default([]),
  due_refs: z.array(CompanionAutonomyRefSchema).default([]),
}).strict();
export type TimingContext = z.infer<typeof TimingContextSchema>;

export const SignalSafetyContextSchema = z.object({
  safety_refs: z.array(CompanionAutonomyRefSchema).default([]),
  guardrail_refs: z.array(refWithKind("guardrail")).default([]),
  backpressure_refs: z.array(refWithKind("backpressure")).default([]),
  hard_blocked: z.boolean().default(false),
  reason: z.string().min(1).optional(),
}).strict();
export type SignalSafetyContext = z.infer<typeof SignalSafetyContextSchema>;

export const StaleTargetContextSchema = z.object({
  stale_refs: z.array(CompanionAutonomyRefSchema).default([]),
  rejected_refs: z.array(CompanionAutonomyRefSchema).default([]),
  needs_regrounding_refs: z.array(CompanionAutonomyRefSchema).default([]),
  reason: z.string().min(1).optional(),
}).strict();
export type StaleTargetContext = z.infer<typeof StaleTargetContextSchema>;

export const SignalContextSchema = z.object({
  schema_version: z.literal("signal-context-v1").default("signal-context-v1"),
  signal_context_id: z.string().min(1),
  assembled_at: z.string().datetime(),
  signal_sources: z.array(SignalSourceSchema).min(1),
  signal_refs: z.array(CompanionAutonomySourceRefSchema).min(1),
  active_surface_ref: refWithKind("surface").nullable(),
  current_session_refs: z.array(refWithKind("session")).default([]),
  current_goal_refs: z.array(refWithKind("goal")).default([]),
  runtime_state_refs: z.array(refWithKind("runtime_item", "runtime_event")).default([]),
  relationship_permission_refs: z.array(refWithKind("relationship_permission", "permission_grant")).default([]),
  user_activity_refs: z.array(refWithKind("user_activity")).default([]),
  timing_context: TimingContextSchema,
  safety_context: SignalSafetyContextSchema,
  stale_target_context: StaleTargetContextSchema,
  audit_refs: z.array(AuditTraceRefSchema).default([]),
}).strict();
export type SignalContext = z.infer<typeof SignalContextSchema>;

export const UrgeOriginSchema = z.enum([
  "goal",
  "memory",
  "schedule",
  "runtime_event",
  "world_change",
  "user_pattern",
  "curiosity",
  "drive",
  "risk",
  "guardrail",
  "backpressure",
  "correction",
]);
export type UrgeOrigin = z.infer<typeof UrgeOriginSchema>;

export const UrgeFeelingSchema = z.enum([
  "curiosity",
  "concern",
  "care",
  "opportunity",
  "friction",
  "completion_pressure",
  "boundary_pressure",
  "staleness_pressure",
  "repair_pressure",
]);
export type UrgeFeeling = z.infer<typeof UrgeFeelingSchema>;

export const AttentionMoveSchema = z.enum([
  "notice",
  "watch",
  "hold",
  "prepare",
  "ask",
  "speak",
  "run_authorized_work",
  "delegate_bounded_work",
  "write_memory_candidate",
  "update_surface_candidate",
  "escalate",
  "external_side_effect",
]);
export type AttentionMove = z.infer<typeof AttentionMoveSchema>;

export const AttentionMaturationStateSchema = z.enum([
  "new",
  "warming",
  "mature",
  "held",
  "prepared",
  "decayed",
  "suppressed",
  "expressed",
  "expired",
  "rejected_stale",
]);
export type AttentionMaturationState = z.infer<typeof AttentionMaturationStateSchema>;

export const AttentionDecayRuleSchema = z.object({
  kind: z.enum(["fixed_deadline", "evidence_decay", "staleness_decay", "manual_recheck"]),
  due_at: z.string().datetime().optional(),
  reason: z.string().min(1),
}).strict();
export type AttentionDecayRule = z.infer<typeof AttentionDecayRuleSchema>;

export const AttentionMaturationSchema = z.object({
  state: AttentionMaturationStateSchema,
  first_seen_at: z.string().datetime(),
  last_reinforced_at: z.string().datetime().optional(),
  expires_at: z.string().datetime().optional(),
  decay_rule: AttentionDecayRuleSchema.optional(),
  reinforcement_refs: z.array(CompanionAutonomySourceRefSchema).default([]),
  blocker_refs: z.array(CompanionAutonomySourceRefSchema).default([]),
}).strict();
export type AttentionMaturation = z.infer<typeof AttentionMaturationSchema>;

export const AttentionMaturationTransitionCauseSchema = z.enum([
  "repeated_evidence",
  "goal_relevance",
  "time_sensitivity",
  "promise",
  "safety_pressure",
  "user_authorized_work",
  "staleness_risk",
  "low_confidence",
  "high_interruption_cost",
  "stale_target",
  "sensitivity",
  "missing_permission",
  "dismissal",
  "overload",
  "boundary",
  "anti_memory",
  "expressed",
  "expired",
]);
export type AttentionMaturationTransitionCause = z.infer<typeof AttentionMaturationTransitionCauseSchema>;

export const AttentionMaturationTransitionSchema = z.object({
  schema_version: z.literal("attention-maturation-transition-v1").default("attention-maturation-transition-v1"),
  transition_id: z.string().min(1),
  candidate_ref: refWithKind("urge_candidate", "agent_agenda_item"),
  from_state: AttentionMaturationStateSchema,
  to_state: AttentionMaturationStateSchema,
  cause: AttentionMaturationTransitionCauseSchema,
  evidence_refs: z.array(CompanionAutonomySourceRefSchema).min(1),
  audit_refs: z.array(AuditTraceRefSchema).default([]),
}).strict();
export type AttentionMaturationTransition = z.infer<typeof AttentionMaturationTransitionSchema>;

export const UrgeCandidateSchema = z.object({
  schema_version: z.literal("urge-candidate-v1").default("urge-candidate-v1"),
  urge_id: z.string().min(1),
  origin: UrgeOriginSchema,
  target: CompanionAutonomyRefSchema,
  feeling: UrgeFeelingSchema,
  subject: z.string().min(1),
  strength: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  urgency: AttentionPrioritySchema,
  expected_user_benefit: z.string().min(1),
  user_cost: AttentionRiskAssessmentSchema,
  relationship_risk: AttentionRiskAssessmentSchema,
  side_effect_risk: AttentionRiskAssessmentSchema,
  sensitivity: AttentionSensitivitySchema,
  evidence_refs: z.array(CompanionAutonomySourceRefSchema).min(1),
  surface_ref: refWithKind("surface").nullable().default(null),
  companion_state_ref: refWithKind("companion_state").nullable().default(null),
  allowed_moves: z.array(AttentionMoveSchema).default([]),
  forbidden_moves: z.array(AttentionMoveSchema).default([]),
  maturation: AttentionMaturationSchema,
  audit_refs: z.array(AuditTraceRefSchema).default([]),
}).strict().superRefine((urge, ctx) => {
  const overlap = urge.allowed_moves.filter((move) => urge.forbidden_moves.includes(move));
  if (overlap.length > 0) {
    ctx.addIssue({
      code: "custom",
      path: ["allowed_moves"],
      message: `attention moves cannot be both allowed and forbidden: ${overlap.join(", ")}`,
    });
  }
});
export type UrgeCandidate = z.infer<typeof UrgeCandidateSchema>;

export const AgentAgendaItemKindSchema = z.enum([
  "goal_stewardship",
  "project_drift",
  "commitment_guard",
  "memory_conflict",
  "preparation_opportunity",
  "stall_concern",
  "decay_risk",
  "curiosity_followup",
  "unresolved_decision",
  "permission_boundary",
  "surface_staleness",
  "user_overload",
  "self_maintenance",
]);
export type AgentAgendaItemKind = z.infer<typeof AgentAgendaItemKindSchema>;

export const AgendaPostureSchema = z.enum([
  "new",
  "warming",
  "held",
  "prepared",
  "ready_for_gate",
  "admitted",
  "suppressed",
  "expired",
  "rejected_stale",
]);
export type AgendaPosture = z.infer<typeof AgendaPostureSchema>;

export const AgendaControlStateSchema = z.enum([
  "active",
  "held",
  "paused",
  "stopped",
  "suppressed",
  "expired",
]);
export type AgendaControlState = z.infer<typeof AgendaControlStateSchema>;

export const AttentionRevisitConditionSchema = z.object({
  kind: z.enum([
    "none",
    "time",
    "user_activity",
    "surface_refresh",
    "permission_change",
    "staleness_change",
    "runtime_event",
    "cooldown_elapsed",
    "manual_review",
  ]),
  due_at: z.string().datetime().optional(),
  refs: z.array(CompanionAutonomyRefSchema).default([]),
  reason: z.string().min(1).optional(),
}).strict().superRefine((condition, ctx) => {
  if (condition.kind === "time" && !condition.due_at) {
    ctx.addIssue({
      code: "custom",
      path: ["due_at"],
      message: "time revisit conditions require due_at",
    });
  }
});
export type AttentionRevisitCondition = z.infer<typeof AttentionRevisitConditionSchema>;

export const AgendaMergeTraceSchema = z.object({
  dedupe_key: z.string().min(1),
  basis: z.object({
    target: z.boolean(),
    evidence: z.boolean(),
    surface: z.boolean(),
    kind: z.boolean(),
    current_posture: z.boolean(),
  }).strict(),
  merged_urge_refs: z.array(UrgeCandidateRefSchema).default([]),
  reinforced_by_refs: z.array(CompanionAutonomySourceRefSchema).default([]),
  audit_refs: z.array(AuditTraceRefSchema).default([]),
}).strict();
export type AgendaMergeTrace = z.infer<typeof AgendaMergeTraceSchema>;

export const AgentAgendaItemSchema = z.object({
  schema_version: z.literal("agent-agenda-item-v1").default("agent-agenda-item-v1"),
  agenda_item_id: z.string().min(1),
  origin: UrgeOriginSchema,
  kind: AgentAgendaItemKindSchema,
  subject: z.string().min(1),
  why_pulseed_cares: z.string().min(1),
  expected_user_benefit: z.string().min(1),
  related_goal_refs: z.array(refWithKind("goal")).default([]),
  related_memory_refs: z.array(refWithKind("memory")).default([]),
  related_surface_refs: z.array(refWithKind("surface")).default([]),
  related_runtime_refs: z.array(refWithKind("runtime_item", "runtime_event")).default([]),
  source_urge_refs: z.array(UrgeCandidateRefSchema).default([]),
  drive_basis: z.string().min(1).optional(),
  curiosity_basis: z.string().min(1).optional(),
  confidence: z.number().min(0).max(1),
  intrusion_cost: AttentionRiskAssessmentSchema,
  relationship_risk: AttentionRiskAssessmentSchema,
  staleness_state: z.enum(["current", "needs_review", "needs_regrounding", "stale", "rejected"]),
  allowed_moves: z.array(AttentionMoveSchema).default([]),
  forbidden_moves: z.array(AttentionMoveSchema).default([]),
  current_posture: AgendaPostureSchema,
  maturation: AttentionMaturationSchema,
  revisit_condition: AttentionRevisitConditionSchema,
  control_state: AgendaControlStateSchema,
  merge_trace: AgendaMergeTraceSchema.optional(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  audit_refs: z.array(AuditTraceRefSchema).default([]),
}).strict().superRefine((item, ctx) => {
  const overlap = item.allowed_moves.filter((move) => item.forbidden_moves.includes(move));
  if (overlap.length > 0) {
    ctx.addIssue({
      code: "custom",
      path: ["allowed_moves"],
      message: `agenda moves cannot be both allowed and forbidden: ${overlap.join(", ")}`,
    });
  }
});
export type AgentAgendaItem = z.infer<typeof AgentAgendaItemSchema>;

export const InhibitionDecisionKindSchema = z.enum([
  "suppress",
  "hold",
  "watch",
  "wait_for_opportunity",
  "decay",
  "reject_stale",
  "allow_to_gate",
]);
export type InhibitionDecisionKind = z.infer<typeof InhibitionDecisionKindSchema>;

export const CompanionStateEffectSchema = z.enum([
  "none",
  "raise_thresholds",
  "lower_thresholds",
  "hold_back",
  "cooldown",
  "needs_user",
  "overloaded",
]);
export type CompanionStateEffect = z.infer<typeof CompanionStateEffectSchema>;

const MaturationStatesByInhibitionDecision: Record<
  InhibitionDecisionKind,
  readonly AttentionMaturationState[]
> = {
  suppress: ["suppressed"],
  hold: ["held"],
  watch: ["held", "warming"],
  wait_for_opportunity: ["held", "warming"],
  decay: ["decayed"],
  reject_stale: ["rejected_stale"],
  allow_to_gate: ["mature", "prepared"],
};

export const OutcomeClassSchema = z.enum([
  "silence",
  "keep_watching",
  "hold_in_agenda",
  "prepare_silently",
  "run_authorized_work",
  "delegate_bounded_work",
  "prepare_action_candidate",
  "request_approval",
  "write_governed_memory_candidate",
  "update_surface_candidate",
  "add_to_digest",
  "express_to_user",
  "escalate",
]);
export type OutcomeClass = z.infer<typeof OutcomeClassSchema>;

export const SurfaceFacingOutcomeClassSchema = z.enum([
  "add_to_digest",
  "express_to_user",
  "request_approval",
  "escalate",
]);
export type SurfaceFacingOutcomeClass = z.infer<typeof SurfaceFacingOutcomeClassSchema>;

export const InhibitionDecisionSchema = z.object({
  schema_version: z.literal("inhibition-decision-v1").default("inhibition-decision-v1"),
  decision_id: z.string().min(1),
  target_ref: refWithKind("urge_candidate", "agent_agenda_item"),
  decided_at: z.string().datetime(),
  decision: InhibitionDecisionKindSchema,
  reason: z.string().min(1),
  companion_state_effect: CompanionStateEffectSchema,
  updated_maturation_state: AttentionMaturationStateSchema,
  revisit_condition: AttentionRevisitConditionSchema,
  suppressed_alternatives: z.array(OutcomeClassSchema).default([]),
  evidence_refs: z.array(CompanionAutonomySourceRefSchema).min(1),
  policy_refs: z.array(CompanionAutonomyRefSchema).default([]),
  audit_refs: z.array(AuditTraceRefSchema).default([]),
}).strict().superRefine((decision, ctx) => {
  const allowedStates = MaturationStatesByInhibitionDecision[decision.decision];
  if (!allowedStates.includes(decision.updated_maturation_state)) {
    ctx.addIssue({
      code: "custom",
      path: ["updated_maturation_state"],
      message: `${decision.decision} cannot update maturation to ${decision.updated_maturation_state}`,
    });
  }
});
export type InhibitionDecision = z.infer<typeof InhibitionDecisionSchema>;

export const AutonomyCheckStatusSchema = z.enum(["passed", "failed", "unknown", "not_required"]);
export type AutonomyCheckStatus = z.infer<typeof AutonomyCheckStatusSchema>;

export const AutonomyCheckKindSchema = z.enum([
  "scope",
  "lifecycle",
  "permission",
  "staleness",
  "sensitivity",
  "surface",
  "allowed_use",
  "forbidden_use",
  "projection",
  "audit",
  "authority",
  "safety",
  "guardrail",
  "runtime_control",
  "companion_state",
  "companion_control",
  "backpressure",
  "capacity",
  "cooldown",
  "visibility",
]);
export type AutonomyCheckKind = z.infer<typeof AutonomyCheckKindSchema>;

export const AutonomyCheckSchema = z.object({
  check_id: z.string().min(1),
  kind: AutonomyCheckKindSchema,
  status: AutonomyCheckStatusSchema,
  reason: z.string().min(1),
  evidence_refs: z.array(CompanionAutonomySourceRefSchema).default([]),
}).strict();
export type AutonomyCheck = z.infer<typeof AutonomyCheckSchema>;

export const InitiativeGateDecisionSchema = z.object({
  schema_version: z.literal("initiative-gate-decision-v1").default("initiative-gate-decision-v1"),
  decision_id: z.string().min(1),
  decided_at: z.string().datetime(),
  status: z.enum(["selected", "blocked", "delayed", "narrowed"]),
  input_refs: z.array(refWithKind("urge_candidate", "agent_agenda_item", "inhibition_decision")).min(1),
  selected_outcome: OutcomeClassSchema.optional(),
  reason: z.string().min(1),
  why_this: z.string().min(1).optional(),
  why_now: z.string().min(1).optional(),
  why_this_route: z.string().min(1).optional(),
  permission_checks: z.array(AutonomyCheckSchema).default([]),
  staleness_checks: z.array(AutonomyCheckSchema).default([]),
  sensitivity_checks: z.array(AutonomyCheckSchema).default([]),
  side_effect_checks: z.array(AutonomyCheckSchema).default([]),
  alternatives_considered: z.array(OutcomeClassSchema).default([]),
  suppressed_alternatives: z.array(OutcomeClassSchema).default([]),
  required_runtime_control_refs: z.array(CompanionAutonomyRefSchema).default([]),
  required_approval: z.boolean().default(false),
  audit_refs: z.array(AuditTraceRefSchema).default([]),
}).strict().superRefine((decision, ctx) => {
  if (decision.status === "selected" && !decision.selected_outcome) {
    ctx.addIssue({
      code: "custom",
      path: ["selected_outcome"],
      message: "selected initiative gate decisions require selected_outcome",
    });
  }
  if (decision.status !== "selected" && decision.selected_outcome) {
    ctx.addIssue({
      code: "custom",
      path: ["selected_outcome"],
      message: "blocked, delayed, and narrowed gate decisions must not create an outcome",
    });
  }
});
export type InitiativeGateDecision = z.infer<typeof InitiativeGateDecisionSchema>;

export const OutcomeAdmissionStatusSchema = z.enum([
  "admitted",
  "rejected",
  "downgraded",
  "expired",
  "held",
]);
export type OutcomeAdmissionStatus = z.infer<typeof OutcomeAdmissionStatusSchema>;

export const OutcomeDecisionReasonCodeSchema = z.enum([
  "stale_target",
  "missing_permission",
  "invalid_surface",
  "guardrail_blocked",
  "backpressure",
  "approval_required",
  "overloaded",
  "cooling_down",
  "control_suppressed",
  "authority_unknown",
  "expired",
  "safety_blocked",
]);
export type OutcomeDecisionReasonCode = z.infer<typeof OutcomeDecisionReasonCodeSchema>;

export const OutcomeDecisionReasonSchema = z.object({
  code: OutcomeDecisionReasonCodeSchema,
  detail: z.string().min(1),
  evidence_refs: z.array(CompanionAutonomySourceRefSchema).default([]),
}).strict();
export type OutcomeDecisionReason = z.infer<typeof OutcomeDecisionReasonSchema>;

export const OutcomeDecisionSchema = z.object({
  schema_version: z.literal("outcome-decision-v1").default("outcome-decision-v1"),
  outcome_decision_id: z.string().min(1),
  initiative_decision_ref: InitiativeGateDecisionRefSchema,
  decided_at: z.string().datetime(),
  requested_outcome: OutcomeClassSchema,
  admission_status: OutcomeAdmissionStatusSchema,
  final_outcome: OutcomeClassSchema.optional(),
  runtime_item_refs: z.array(refWithKind("runtime_item")).default([]),
  authority_checks: z.array(AutonomyCheckSchema).default([]),
  staleness_checks: z.array(AutonomyCheckSchema).default([]),
  companion_control_checks: z.array(AutonomyCheckSchema).default([]),
  safety_checks: z.array(AutonomyCheckSchema).default([]),
  visibility_checks: z.array(AutonomyCheckSchema).default([]),
  downgrade_or_rejection_reason: OutcomeDecisionReasonSchema.optional(),
  visibility_policy_ref: VisibilityPolicyRefSchema.optional(),
  expression_decision_ref: refWithKind("expression_decision").optional(),
  audit_ref: AuditTraceRefSchema.optional(),
}).strict().superRefine((decision, ctx) => {
  if (
    (decision.admission_status === "admitted" || decision.admission_status === "downgraded") &&
    !decision.final_outcome
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["final_outcome"],
      message: "admitted and downgraded outcome decisions require a final outcome class",
    });
  }
  if (
    (decision.admission_status === "rejected" ||
      decision.admission_status === "expired" ||
      decision.admission_status === "held") &&
    decision.final_outcome
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["final_outcome"],
      message: "rejected, expired, and held outcome decisions must not invent a final outcome",
    });
  }
  if (
    (decision.admission_status === "rejected" ||
      decision.admission_status === "expired" ||
      decision.admission_status === "held") &&
    decision.expression_decision_ref
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["expression_decision_ref"],
      message: "rejected, expired, and held outcome decisions must not reference expression decisions",
    });
  }
  if (
    (decision.admission_status === "rejected" ||
      decision.admission_status === "downgraded" ||
      decision.admission_status === "expired") &&
    !decision.downgrade_or_rejection_reason
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["downgrade_or_rejection_reason"],
      message: "rejected, downgraded, and expired outcomes require recorded reason evidence",
    });
  }
  if (decision.expression_decision_ref && decision.final_outcome) {
    const expressionAllowed = SurfaceFacingOutcomeClassSchema.safeParse(decision.final_outcome).success;
    if (!expressionAllowed) {
      ctx.addIssue({
        code: "custom",
        path: ["expression_decision_ref"],
        message: "only surface-facing final outcomes can reference an expression decision",
      });
    }
  }
});
export type OutcomeDecision = z.infer<typeof OutcomeDecisionSchema>;

export const ExpressionDecisionStatusSchema = z.enum(["active", "held", "withdrawn"]);
export type ExpressionDecisionStatus = z.infer<typeof ExpressionDecisionStatusSchema>;

export const ExpressionModeSchema = z.enum([
  "ambient_presence",
  "digest_item",
  "soft_ping",
  "direct_message",
  "approval_request",
  "urgent_alert",
  "intervention",
]);
export type ExpressionMode = z.infer<typeof ExpressionModeSchema>;

export const ExpressionSurfaceClassSchema = z.enum([
  "chat",
  "tui",
  "cli",
  "digest",
  "daemon_snapshot",
  "gui",
  "gateway",
  "notification",
]);
export type ExpressionSurfaceClass = z.infer<typeof ExpressionSurfaceClassSchema>;

export const ExpressionDecisionSchema = z.object({
  schema_version: z.literal("expression-decision-v1").default("expression-decision-v1"),
  expression_decision_id: z.string().min(1),
  outcome_decision_ref: OutcomeDecisionRefSchema,
  outcome_class: SurfaceFacingOutcomeClassSchema,
  created_at: z.string().datetime(),
  expression_mode: ExpressionModeSchema,
  target_surface_classes: z.array(ExpressionSurfaceClassSchema).min(1),
  visibility_policy_ref: VisibilityPolicyRefSchema,
  decision_status: ExpressionDecisionStatusSchema.default("active"),
  user_facing_rationale: z.string().min(1),
  suppressed_detail_refs: z.array(CompanionAutonomyRefSchema).default([]),
  audit_ref: AuditTraceRefSchema.optional(),
}).strict().superRefine((decision, ctx) => {
  if (decision.outcome_class === "add_to_digest" && decision.expression_mode !== "digest_item") {
    ctx.addIssue({
      code: "custom",
      path: ["expression_mode"],
      message: "add_to_digest outcomes must render through digest_item expression mode",
    });
  }
  if (decision.outcome_class === "request_approval" && decision.expression_mode !== "approval_request") {
    ctx.addIssue({
      code: "custom",
      path: ["expression_mode"],
      message: "request_approval outcomes must render through approval_request expression mode",
    });
  }
  if (
    decision.outcome_class === "escalate" &&
    decision.expression_mode !== "urgent_alert" &&
    decision.expression_mode !== "intervention"
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["expression_mode"],
      message: "escalate outcomes require urgent_alert or intervention expression mode",
    });
  }
});
export type ExpressionDecision = z.infer<typeof ExpressionDecisionSchema>;

export const VisibilityPolicySchema = z.object({
  schema_version: z.literal("visibility-policy-v1").default("visibility-policy-v1"),
  visibility_policy_id: z.string().min(1),
  applies_to: z.array(CompanionAutonomyRefSchema).min(1),
  hidden_by_default: z.boolean(),
  visible_in_gui: z.boolean(),
  visible_in_chat: z.boolean(),
  visible_in_tui: z.boolean(),
  visible_in_cli: z.boolean(),
  visible_in_audit: z.boolean(),
  visible_in_debug: z.boolean(),
  digest_only: z.boolean(),
  visible_in_digest: z.boolean().default(false),
  never_directly_show: z.boolean(),
  content_lifecycle: CompanionAutonomyContentLifecycleSchema.default("active"),
  redaction_required: z.boolean().default(false),
  raw_content_allowed: z.boolean().default(false),
  inspectable_summary: z.string().min(1).optional(),
  rationale: z.string().min(1),
  audit_refs: z.array(AuditTraceRefSchema).default([]),
}).strict().superRefine((policy, ctx) => {
  if (
    (policy.content_lifecycle === "deleted" || policy.content_lifecycle === "tombstone") &&
    policy.raw_content_allowed
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["raw_content_allowed"],
      message: "deleted and tombstone content cannot be exposed through visibility policy",
    });
  }
  if (
    (policy.content_lifecycle === "deleted" || policy.content_lifecycle === "tombstone") &&
    !policy.redaction_required
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["redaction_required"],
      message: "deleted and tombstone content require redaction",
    });
  }
  if (
    policy.never_directly_show &&
    (policy.visible_in_gui ||
      policy.visible_in_chat ||
      policy.visible_in_tui ||
      policy.visible_in_cli ||
      policy.visible_in_digest)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["never_directly_show"],
      message: "never_directly_show content cannot be visible in normal surfaces or digest",
    });
  }
  if (
    policy.digest_only &&
    (policy.visible_in_chat || policy.visible_in_tui || policy.visible_in_cli || !policy.visible_in_digest)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["digest_only"],
      message: "digest_only content must be digest-visible and hidden from immediate chat, TUI, and CLI surfaces",
    });
  }
});
export type VisibilityPolicy = z.infer<typeof VisibilityPolicySchema>;

export const AuditRepairOptionSchema = z.enum([
  "stop",
  "narrow",
  "revoke",
  "forget",
  "reground",
  "suppress",
  "inspect",
  "retry",
]);
export type AuditRepairOption = z.infer<typeof AuditRepairOptionSchema>;

export const AuditTraceRecordSchema = z.object({
  record_id: z.string().min(1),
  summary: z.string().min(1),
  source_refs: z.array(CompanionAutonomySourceRefSchema).default([]),
  redacted: z.boolean().default(false),
}).strict();
export type AuditTraceRecord = z.infer<typeof AuditTraceRecordSchema>;

export const AuditRedactionStateSchema = z.object({
  state: z.enum(["none", "redacted", "tombstone_metadata", "deleted_source_removed"]),
  redaction_applied: z.boolean().default(false),
  deleted_content_visible: z.boolean().default(false),
  reason: z.string().min(1).optional(),
}).strict();
export type AuditRedactionState = z.infer<typeof AuditRedactionStateSchema>;

export const AuditTraceSchema = z.object({
  schema_version: z.literal("audit-trace-v1").default("audit-trace-v1"),
  trace_id: z.string().min(1),
  subject_ref: CompanionAutonomyRefSchema,
  trigger_refs: z.array(CompanionAutonomySourceRefSchema).min(1),
  surface_refs: z.array(refWithKind("surface")).default([]),
  memory_refs: z.array(CompanionAutonomySourceRefSchema).default([]),
  permission_checks: z.array(AutonomyCheckSchema).default([]),
  staleness_checks: z.array(AutonomyCheckSchema).default([]),
  authority_checks: z.array(AutonomyCheckSchema).default([]),
  safety_checks: z.array(AutonomyCheckSchema).default([]),
  redaction_state: AuditRedactionStateSchema,
  attention_decision_refs: z.array(refWithKind(
    "inhibition_decision",
    "initiative_gate_decision",
    "outcome_decision",
    "expression_decision"
  )).default([]),
  companion_state_refs: z.array(refWithKind("companion_state")).default([]),
  actions_taken: z.array(AuditTraceRecordSchema).default([]),
  actions_withheld: z.array(AuditTraceRecordSchema).default([]),
  quiet_work: z.array(AuditTraceRecordSchema).default([]),
  suppressed_alternatives: z.array(AuditTraceRecordSchema).default([]),
  user_visible_outputs: z.array(AuditTraceRecordSchema).default([]),
  repair_options: z.array(AuditRepairOptionSchema).default([]),
  visibility_policy_refs: z.array(VisibilityPolicyRefSchema).default([]),
  created_at: z.string().datetime(),
}).strict().superRefine((trace, ctx) => {
  const allContentRefs = [
    ...trace.trigger_refs,
    ...trace.memory_refs,
    ...trace.actions_taken.flatMap((record) => record.source_refs),
    ...trace.actions_withheld.flatMap((record) => record.source_refs),
    ...trace.quiet_work.flatMap((record) => record.source_refs),
    ...trace.suppressed_alternatives.flatMap((record) => record.source_refs),
    ...trace.user_visible_outputs.flatMap((record) => record.source_refs),
    ...trace.permission_checks.flatMap((check) => check.evidence_refs),
    ...trace.staleness_checks.flatMap((check) => check.evidence_refs),
    ...trace.authority_checks.flatMap((check) => check.evidence_refs),
    ...trace.safety_checks.flatMap((check) => check.evidence_refs),
  ];
  const hasDeletedOrTombstoneContent = allContentRefs.some((ref) =>
    ref.lifecycle === "deleted" || ref.lifecycle === "tombstone"
  );
  if (hasDeletedOrTombstoneContent && !trace.redaction_state.redaction_applied) {
    ctx.addIssue({
      code: "custom",
      path: ["redaction_state", "redaction_applied"],
      message: "audit traces referencing deleted or tombstone content require redaction",
    });
  }
  if (hasDeletedOrTombstoneContent && trace.redaction_state.state === "none") {
    ctx.addIssue({
      code: "custom",
      path: ["redaction_state", "state"],
      message: "audit traces referencing deleted or tombstone content cannot use redaction state none",
    });
  }
  if (trace.redaction_state.deleted_content_visible) {
    ctx.addIssue({
      code: "custom",
      path: ["redaction_state", "deleted_content_visible"],
      message: "audit traces must not expose deleted content",
    });
  }
  trace.user_visible_outputs.forEach((output, outputIndex) => {
    const outputUsesDeletedContent = output.source_refs.some((ref) =>
      ref.lifecycle === "deleted" || ref.lifecycle === "tombstone"
    );
    if (outputUsesDeletedContent && !output.redacted) {
      ctx.addIssue({
        code: "custom",
        path: ["user_visible_outputs", outputIndex, "redacted"],
        message: "user-visible audit outputs that reference deleted or tombstone content must be redacted",
      });
    }
  });
});
export type AuditTrace = z.infer<typeof AuditTraceSchema>;

export const PermissionGrantBoundarySchema = z.object({
  schema_version: z.literal("permission-grant-boundary-v1").default("permission-grant-boundary-v1"),
  grant_id: z.string().min(1),
  state: z.enum(["proposed", "active", "expired", "revoked", "superseded"]),
  capabilities: z.array(PermissionGrantCapabilitySchema).min(1),
  excluded_capabilities: z.array(PermissionGrantExcludedCapabilitySchema).min(1),
  visibility_policy_ref: CompanionAutonomyRefSchema.optional(),
  audit_refs: z.array(z.string().min(1)).default([]),
}).strict();
export type PermissionGrantBoundary = z.infer<typeof PermissionGrantBoundarySchema>;

export function canVisibilityPolicyExposeRawContent(policy: VisibilityPolicy): boolean {
  if (policy.content_lifecycle === "deleted" || policy.content_lifecycle === "tombstone") return false;
  if (policy.never_directly_show) return false;
  if (policy.redaction_required) return false;
  return policy.raw_content_allowed;
}
