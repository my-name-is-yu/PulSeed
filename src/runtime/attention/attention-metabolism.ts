import type { z } from "zod";
import {
  SurfaceInvalidationEventSchema,
  type SurfaceInvalidationAction,
  type SurfaceInvalidationEvent,
} from "../../grounding/surface-contracts.js";
import {
  AgentAgendaItemSchema,
  AttentionMaturationTransitionSchema,
  ExpressionDecisionSchema,
  InhibitionDecisionSchema,
  InitiativeGateDecisionSchema,
  OutcomeDecisionSchema,
  SignalContextSchema,
  SurfaceFacingOutcomeClassSchema,
  UrgeCandidateSchema,
  VisibilityPolicySchema,
  type AgentAgendaItem,
  type AgentAgendaItemKind,
  type AgendaPosture,
  type AttentionMaturation,
  type AttentionMaturationState,
  type AttentionMaturationTransition,
  type AttentionMaturationTransitionCause,
  type AttentionMove,
  type AttentionPriority,
  type AttentionRevisitCondition,
  type AttentionRiskAssessment,
  type AttentionSensitivity,
  type AutonomyCheck,
  type CompanionAutonomyContentLifecycle,
  type CompanionAutonomyRef,
  type CompanionAutonomyRefKind,
  type CompanionAutonomySourceRef,
  type CompanionStateEffect,
  type ExpressionDecision,
  type ExpressionMode,
  type ExpressionSurfaceClass,
  type InhibitionDecision,
  type InhibitionDecisionKind,
  type InitiativeGateDecision,
  type OutcomeAdmissionStatus,
  type OutcomeClass,
  type OutcomeDecision,
  type OutcomeDecisionReasonCode,
  type SignalContext,
  type SignalSafetyContext,
  type SurfaceFacingOutcomeClass,
  type SignalSource,
  type StaleTargetContext,
  type TimingContext,
  type UrgeCandidate,
  type UrgeFeeling,
  type UrgeOrigin,
  type VisibilityPolicy,
} from "../types/companion-autonomy.js";
import type {
  CompanionStateSnapshot,
  RuntimeItem,
} from "../types/companion-state.js";

const INTERNAL_PRE_GATE_MOVES: readonly AttentionMove[] = [
  "notice",
  "watch",
  "hold",
  "prepare",
];

const OUTWARD_PRE_GATE_FORBIDDEN_MOVES: readonly AttentionMove[] = [
  "ask",
  "speak",
  "run_authorized_work",
  "delegate_bounded_work",
  "write_memory_candidate",
  "update_surface_candidate",
  "escalate",
  "external_side_effect",
];

const DEFAULT_REVISIT_CONDITION: AttentionRevisitCondition = {
  kind: "runtime_event",
  refs: [],
  reason: "re-evaluate when fresh typed runtime evidence arrives",
};

export type AttentionSignalRefInput = {
  source: SignalSource;
  ref: CompanionAutonomyRef;
  lifecycle?: CompanionAutonomyContentLifecycle;
  redaction_reason?: string;
};

export type SignalContextAssemblyInput = {
  signal_context_id: string;
  assembled_at: string;
  signals: AttentionSignalRefInput[];
  active_surface_ref?: CompanionAutonomyRef | null;
  current_session_refs?: CompanionAutonomyRef[];
  current_goal_refs?: CompanionAutonomyRef[];
  runtime_state_refs?: CompanionAutonomyRef[];
  relationship_permission_refs?: CompanionAutonomyRef[];
  user_activity_refs?: CompanionAutonomyRef[];
  timing_context?: Partial<TimingContext>;
  safety_context?: Partial<SignalSafetyContext>;
  stale_target_context?: Partial<StaleTargetContext>;
  audit_refs?: CompanionAutonomyRef[];
};

export type SchedulerWakeReevaluationInput =
  Omit<SignalContextAssemblyInput, "signals" | "timing_context"> & {
    schedule_tick_ref: CompanionAutonomyRef;
    wait_ref?: CompanionAutonomyRef;
    timing_context?: Partial<TimingContext>;
  };

export type AttentionReevaluationContext = {
  entry_id: string;
  entry_name: string;
  activation_kind?: "wait_resume";
  fired_at: string;
};

export type AttentionReevaluationPort = {
  reevaluate(signal_context: SignalContext, context: AttentionReevaluationContext): Promise<unknown>;
};

export type AttentionReevaluationResult = {
  signal_context: SignalContext;
  urge_candidates: UrgeCandidate[];
  agenda_items: AgentAgendaItem[];
  inhibition_decisions: InhibitionDecision[];
  gate_decisions: InitiativeGateDecision[];
  runtime_items: RuntimeItem[];
};

export type UrgeCandidateAssemblyInput = {
  urge_id: string;
  signal_context: SignalContext;
  origin: UrgeOrigin;
  target: CompanionAutonomyRef;
  feeling: UrgeFeeling;
  subject: string;
  strength: number;
  confidence: number;
  urgency?: AttentionPriority;
  expected_user_benefit: string;
  user_cost?: AttentionRiskAssessment;
  relationship_risk?: AttentionRiskAssessment;
  side_effect_risk?: AttentionRiskAssessment;
  sensitivity?: AttentionSensitivity;
  surface_ref?: CompanionAutonomyRef | null;
  companion_state_ref?: CompanionAutonomyRef | null;
  allowed_moves?: AttentionMove[];
  forbidden_moves?: AttentionMove[];
  maturation_state?: AttentionMaturationState;
  expires_at?: string;
  decay_rule?: AttentionMaturation["decay_rule"];
  audit_refs?: CompanionAutonomyRef[];
};

export type MergeUrgesIntoAgendaInput = {
  urges: UrgeCandidate[];
  existing_agenda_items?: AgentAgendaItem[];
  now: string;
};

export type AdvanceMaturationInput = {
  transition_id: string;
  candidate_ref: CompanionAutonomyRef;
  current_state: AttentionMaturationState;
  now: string;
  first_seen_at: string;
  evidence_refs: CompanionAutonomySourceRef[];
  confidence?: number;
  expires_at?: string;
  reinforcement_causes?: AttentionMaturationTransitionCause[];
  blocker_causes?: AttentionMaturationTransitionCause[];
  prepare_allowed?: boolean;
  audit_refs?: CompanionAutonomyRef[];
};

export type AdvanceMaturationResult = {
  transition: AttentionMaturationTransition;
  maturation: AttentionMaturation;
};

export type InhibitionDecisionInput = {
  decision_id: string;
  decided_at: string;
  candidate: UrgeCandidate | AgentAgendaItem;
  companion_state?: Pick<CompanionStateSnapshot, "mode" | "control_overlays" | "blocked_refs" | "stale_refs">;
  permission_checks?: AutonomyCheck[];
  staleness_checks?: AutonomyCheck[];
  safety_checks?: AutonomyCheck[];
  recent_feedback_refs?: CompanionAutonomySourceRef[];
  policy_refs?: CompanionAutonomyRef[];
  audit_refs?: CompanionAutonomyRef[];
};

export type InitiativeGateSelectionInput = {
  decision_id: string;
  decided_at: string;
  candidate: UrgeCandidate | AgentAgendaItem;
  inhibition_decision: InhibitionDecision;
  companion_state?: Pick<CompanionStateSnapshot, "mode" | "control_overlays">;
  requested_outcome?: OutcomeClass;
  permission_checks?: AutonomyCheck[];
  staleness_checks?: AutonomyCheck[];
  sensitivity_checks?: AutonomyCheck[];
  side_effect_checks?: AutonomyCheck[];
  required_runtime_control_refs?: CompanionAutonomyRef[];
  required_approval?: boolean;
  audit_refs?: CompanionAutonomyRef[];
};

export type RuntimeAdmissionInput = {
  outcome_decision_id: string;
  decided_at: string;
  gate_decision: InitiativeGateDecision;
  admitted_runtime_control_refs?: CompanionAutonomyRef[];
  approval_ref?: CompanionAutonomyRef;
  runtime_item_refs?: CompanionAutonomyRef[];
  authority_checks?: AutonomyCheck[];
  staleness_checks?: AutonomyCheck[];
  companion_control_checks?: AutonomyCheck[];
  safety_checks?: AutonomyCheck[];
  visibility_policy_ref?: CompanionAutonomyRef;
  audit_ref?: CompanionAutonomyRef;
};

export type AttentionSurfaceInvalidationInput = {
  surface_invalidation_event: SurfaceInvalidationEvent | z.input<typeof SurfaceInvalidationEventSchema>;
  urge_candidates?: UrgeCandidate[];
  agenda_items?: AgentAgendaItem[];
  current_surface_ref?: CompanionAutonomyRef | null;
  now: string;
  audit_refs?: CompanionAutonomyRef[];
};

export type AttentionSurfaceInvalidationResult = {
  surface_ref: CompanionAutonomyRef;
  invalidation_check: AutonomyCheck;
  invalidated_urge_candidates: UrgeCandidate[];
  invalidated_agenda_items: AgentAgendaItem[];
  audit_refs: CompanionAutonomyRef[];
};

export type ExpressionDecisionCreationInput = {
  expression_decision_id: string;
  created_at: string;
  outcome_decision: OutcomeDecision;
  target_surface_classes: ExpressionSurfaceClass[];
  visibility_policy_ref?: CompanionAutonomyRef;
  expression_mode?: ExpressionMode;
  user_facing_rationale?: string;
  suppressed_detail_refs?: CompanionAutonomyRef[];
  audit_ref?: CompanionAutonomyRef;
};

export type SurfaceDecisionRenderInput = {
  render_id: string;
  rendered_at: string;
  surface_class: ExpressionSurfaceClass;
  outcome_decision: OutcomeDecision;
  expression_decision?: ExpressionDecision | null;
  visibility_policy: VisibilityPolicy;
  audit_ref?: CompanionAutonomyRef;
};

export type SurfaceDecisionRender = {
  schema_version: "surface-decision-render-v1";
  render_id: string;
  rendered_at: string;
  surface_class: ExpressionSurfaceClass;
  outcome_decision_ref: CompanionAutonomyRef;
  expression_decision_ref: CompanionAutonomyRef;
  outcome_class: SurfaceFacingOutcomeClass;
  expression_mode: ExpressionMode;
  visibility_policy_ref: CompanionAutonomyRef;
  user_facing_rationale: string;
  suppressed_detail_refs: CompanionAutonomyRef[];
  audit_ref?: CompanionAutonomyRef;
};

export const AttentionFeedbackKindValues = [
  "accepted",
  "dismissed",
  "correction",
  "overreach",
  "permission_revoked",
  "surface_narrowed",
] as const;
export type AttentionFeedbackKind = typeof AttentionFeedbackKindValues[number];

export type AttentionFeedbackEvent = {
  feedback_ref: CompanionAutonomyRef;
  kind: AttentionFeedbackKind;
  agenda_kind?: AgentAgendaItemKind;
  urge_origin?: UrgeOrigin;
  route?: OutcomeClass;
  surface_ref?: CompanionAutonomyRef;
  permission_ref?: CompanionAutonomyRef;
  sensitivity?: AttentionSensitivity;
};

export type AttentionFeedbackPolicyAdjustment = {
  cooldown_refs: CompanionAutonomyRef[];
  suppressed_agenda_kinds: AgentAgendaItemKind[];
  approval_required_outcomes: OutcomeClass[];
  narrowed_surface_refs: CompanionAutonomyRef[];
  sensitive_urge_origins: UrgeOrigin[];
  permission_update_refs: CompanionAutonomyRef[];
  audit_refs: CompanionAutonomyRef[];
  threshold_effects: Array<"raise_expression_threshold" | "raise_attention_threshold" | "preserve_thresholds">;
};

export function ref(kind: CompanionAutonomyRefKind, id: string, version?: string): CompanionAutonomyRef {
  return version ? { kind, id, version } : { kind, id };
}

export function sourceRef(
  kind: CompanionAutonomyRefKind,
  id: string,
  lifecycle: CompanionAutonomyContentLifecycle = "active"
): CompanionAutonomySourceRef {
  return { ref: ref(kind, id), lifecycle };
}

export function assembleSignalContext(input: SignalContextAssemblyInput): SignalContext {
  const signals = input.signals.map((signal) => ({
    ref: signal.ref,
    lifecycle: signal.lifecycle ?? "active",
    redaction_reason: signal.redaction_reason,
  }));

  return SignalContextSchema.parse({
    signal_context_id: input.signal_context_id,
    assembled_at: input.assembled_at,
    signal_sources: unique(input.signals.map((signal) => signal.source)),
    signal_refs: signals,
    active_surface_ref: input.active_surface_ref ?? null,
    current_session_refs: input.current_session_refs ?? [],
    current_goal_refs: input.current_goal_refs ?? [],
    runtime_state_refs: input.runtime_state_refs ?? [],
    relationship_permission_refs: input.relationship_permission_refs ?? [],
    user_activity_refs: input.user_activity_refs ?? [],
    timing_context: {
      observed_at: input.assembled_at,
      quiet_hours_active: false,
      cooldown_refs: [],
      due_refs: [],
      ...input.timing_context,
    },
    safety_context: {
      safety_refs: [],
      guardrail_refs: [],
      backpressure_refs: [],
      hard_blocked: false,
      ...input.safety_context,
    },
    stale_target_context: {
      stale_refs: [],
      rejected_refs: [],
      needs_regrounding_refs: [],
      ...input.stale_target_context,
    },
    audit_refs: input.audit_refs ?? [],
  });
}

export function buildSchedulerWakeSignalContext(input: SchedulerWakeReevaluationInput): SignalContext {
  const signals: AttentionSignalRefInput[] = [
    {
      source: "schedule_tick",
      ref: input.schedule_tick_ref,
    },
  ];
  if (input.wait_ref) {
    signals.push({
      source: "wait_expiry",
      ref: input.wait_ref,
    });
  }

  return assembleSignalContext({
    ...input,
    signals,
    timing_context: {
      ...input.timing_context,
      due_refs: uniqueRefs([
        ...(input.timing_context?.due_refs ?? []),
        input.schedule_tick_ref,
        ...(input.wait_ref ? [input.wait_ref] : []),
      ]),
    },
  });
}

export function reevaluateSchedulerWakeThroughAttention(
  signalContext: SignalContext,
  context: AttentionReevaluationContext
): AttentionReevaluationResult {
  const waitRef = signalContext.signal_refs.find((candidate) => candidate.ref.kind === "wait")?.ref
    ?? signalContext.timing_context.due_refs.find((candidate) => candidate.kind === "wait")
    ?? ref("wait", context.entry_id);
  const urge = createUrgeCandidate({
    urge_id: `urge:schedule-wake:${context.entry_id}`,
    signal_context: signalContext,
    origin: "schedule",
    target: waitRef,
    feeling: "staleness_pressure",
    subject: `Re-evaluate scheduled wait ${context.entry_name}.`,
    strength: 0.55,
    confidence: 0.7,
    expected_user_benefit: "PulSeed can revisit waiting state without notifying the user.",
    maturation_state: "warming",
  });
  const agendaItems = mergeUrgesIntoAgenda({
    urges: [urge],
    now: context.fired_at,
  });
  const inhibitionDecisions = agendaItems.map((agendaItem) =>
    decideInhibition({
      decision_id: `inhibition:schedule-wake:${context.entry_id}`,
      decided_at: context.fired_at,
      candidate: agendaItem,
      permission_checks: [passedCheck("permission", "schedule wake only re-evaluates internal attention")],
      staleness_checks: [passedCheck("staleness", "scheduler wake requires attention to re-check staleness later")],
      safety_checks: [passedCheck("safety", "scheduler wake does not create expression or action")],
    })
  );
  const gateDecisions = agendaItems.map((agendaItem, index) =>
    selectInitiativeGateDecision({
      decision_id: `gate:schedule-wake:${context.entry_id}`,
      decided_at: context.fired_at,
      candidate: agendaItem,
      inhibition_decision: inhibitionDecisions[index]!,
    })
  );

  return {
    signal_context: signalContext,
    urge_candidates: [urge],
    agenda_items: agendaItems,
    inhibition_decisions: inhibitionDecisions,
    gate_decisions: gateDecisions,
    runtime_items: runtimeItemsForAgenda(agendaItems, context.fired_at),
  };
}

export function createUrgeCandidate(input: UrgeCandidateAssemblyInput): UrgeCandidate {
  const evidenceRefs = uniqueSourceRefs([
    sourceRef("signal_context", input.signal_context.signal_context_id),
    ...input.signal_context.signal_refs,
  ]);
  const allowedMoves = intersectMoves(input.allowed_moves ?? INTERNAL_PRE_GATE_MOVES, INTERNAL_PRE_GATE_MOVES);
  const forbiddenMoves = uniqueMoves([
    ...(input.forbidden_moves ?? []),
    ...OUTWARD_PRE_GATE_FORBIDDEN_MOVES,
  ]);
  const firstSeenAt = input.signal_context.assembled_at;
  const maturationState = input.maturation_state ?? (
    input.confidence >= 0.65 && input.strength >= 0.5 ? "warming" : "new"
  );

  return UrgeCandidateSchema.parse({
    urge_id: input.urge_id,
    origin: input.origin,
    target: input.target,
    feeling: input.feeling,
    subject: input.subject,
    strength: input.strength,
    confidence: input.confidence,
    urgency: input.urgency ?? "normal",
    expected_user_benefit: input.expected_user_benefit,
    user_cost: input.user_cost ?? risk("low", "candidate remains internal before attention gates"),
    relationship_risk: input.relationship_risk ?? risk("low", "candidate remains scoped to current Surface and permissions"),
    side_effect_risk: input.side_effect_risk ?? risk("none", "urge candidates have no side effects"),
    sensitivity: input.sensitivity ?? "internal",
    evidence_refs: evidenceRefs,
    surface_ref: input.surface_ref ?? input.signal_context.active_surface_ref ?? null,
    companion_state_ref: input.companion_state_ref ?? null,
    allowed_moves: allowedMoves,
    forbidden_moves: forbiddenMoves,
    maturation: {
      state: maturationState,
      first_seen_at: firstSeenAt,
      expires_at: input.expires_at,
      decay_rule: input.decay_rule,
      reinforcement_refs: evidenceRefs,
      blocker_refs: [],
    },
    audit_refs: input.audit_refs ?? [],
  });
}

export function mergeUrgesIntoAgenda(input: MergeUrgesIntoAgendaInput): AgentAgendaItem[] {
  const agendaByKey = new Map<string, AgentAgendaItem>();

  for (const item of input.existing_agenda_items ?? []) {
    agendaByKey.set(dedupeKeyForAgenda(item), item);
  }

  for (const urge of input.urges) {
    const kind = agendaKindForUrge(urge);
    const key = dedupeKeyForUrge(urge, kind);
    const existing = agendaByKey.get(key);
    if (!existing) {
      const created = createAgendaItemFromUrge(urge, kind, input.now, key);
      agendaByKey.set(key, created);
      continue;
    }

    const mergedUrgeRefs = uniqueRefs([
      ...existing.source_urge_refs,
      ref("urge_candidate", urge.urge_id),
    ]);
    const reinforcedByRefs = uniqueSourceRefs([
      ...(existing.merge_trace?.reinforced_by_refs ?? []),
      ...urge.evidence_refs,
    ]);
    const maturation = reinforceMaturation(existing.maturation, urge, input.now);
    const currentPosture = agendaPostureForMaturation(maturation.state);
    const updatedDedupeKey = [
      `target:${refKey(urge.target)}`,
      `surface:${urge.surface_ref ? refKey(urge.surface_ref) : "none"}`,
      `kind:${existing.kind}`,
      `posture:${currentPosture}`,
    ].join("|");
    const evidenceOverlap = urge.evidence_refs.some((evidence) =>
      (existing.merge_trace?.reinforced_by_refs ?? []).some((existingEvidence) =>
        sourceRefKey(existingEvidence) === sourceRefKey(evidence)
      )
    );

    agendaByKey.set(key, AgentAgendaItemSchema.parse({
      ...existing,
      confidence: Math.max(existing.confidence, urge.confidence),
      updated_at: input.now,
      source_urge_refs: mergedUrgeRefs,
      current_posture: currentPosture,
      control_state: currentPosture === "expired" ? "expired" : currentPosture === "suppressed" ? "suppressed" : "held",
      maturation,
      merge_trace: {
        dedupe_key: updatedDedupeKey,
        basis: {
          target: true,
          evidence: evidenceOverlap || existing.source_urge_refs.length > 0,
          surface: true,
          kind: true,
          current_posture: true,
        },
        merged_urge_refs: mergedUrgeRefs,
        reinforced_by_refs: reinforcedByRefs,
        audit_refs: existing.merge_trace?.audit_refs ?? [],
      },
    }));
  }

  return [...agendaByKey.values()];
}

export function advanceAttentionMaturation(input: AdvanceMaturationInput): AdvanceMaturationResult {
  const cause = selectMaturationCause(input);
  const toState = nextMaturationState(input.current_state, cause, input.prepare_allowed ?? false);
  const transition = AttentionMaturationTransitionSchema.parse({
    transition_id: input.transition_id,
    candidate_ref: input.candidate_ref,
    from_state: input.current_state,
    to_state: toState,
    cause,
    evidence_refs: input.evidence_refs,
    audit_refs: input.audit_refs ?? [],
  });

  return {
    transition,
    maturation: {
      state: toState,
      first_seen_at: input.first_seen_at,
      last_reinforced_at: isReinforcementCause(cause) ? input.now : undefined,
      expires_at: input.expires_at,
      reinforcement_refs: isReinforcementCause(cause) ? input.evidence_refs : [],
      blocker_refs: isReinforcementCause(cause) ? [] : input.evidence_refs,
    },
  };
}

export function decideInhibition(input: InhibitionDecisionInput): InhibitionDecision {
  const failedStaleness = firstFailed(input.staleness_checks ?? []);
  const failedSafety = firstFailed(input.safety_checks ?? []);
  const failedPermission = firstFailed(input.permission_checks ?? []);
  const maturation = candidateMaturation(input.candidate);
  const stateMode = input.companion_state?.mode ?? "resting";
  const controlOverlays = input.companion_state?.control_overlays ?? [];
  const targetRef = candidateRef(input.candidate);
  const evidenceRefs = uniqueSourceRefs([
    ...candidateEvidenceRefs(input.candidate),
    ...(input.recent_feedback_refs ?? []),
  ]);

  let decision: InhibitionDecisionKind = "allow_to_gate";
  let companionStateEffect: CompanionStateEffect = "none";
  let updatedMaturationState: AttentionMaturationState = maturation.state === "prepared" ? "prepared" : "mature";
  let reason = "candidate is mature enough for Initiative Gate checks";
  let revisitCondition: AttentionRevisitCondition = DEFAULT_REVISIT_CONDITION;
  let suppressedAlternatives: OutcomeClass[] = [];

  if (failedStaleness) {
    decision = "reject_stale";
    updatedMaturationState = "rejected_stale";
    companionStateEffect = "hold_back";
    reason = failedStaleness.reason;
    suppressedAlternatives = ["express_to_user", "run_authorized_work", "delegate_bounded_work"];
    revisitCondition = { kind: "staleness_change", refs: [], reason: "re-ground stale target before reconsidering" };
  } else if (failedSafety || stateMode === "suspended" || controlOverlays.includes("suspend_companion")) {
    decision = "suppress";
    updatedMaturationState = "suppressed";
    companionStateEffect = "raise_thresholds";
    reason = failedSafety?.reason ?? "companion is suspended and cannot admit initiative";
    suppressedAlternatives = ["express_to_user", "run_authorized_work", "delegate_bounded_work", "escalate"];
    revisitCondition = { kind: "manual_review", refs: [], reason: "requires explicit control or safety review" };
  } else if (failedPermission || controlOverlays.includes("pause_proactivity")) {
    decision = "hold";
    updatedMaturationState = "held";
    companionStateEffect = "needs_user";
    reason = failedPermission?.reason ?? "proactivity is paused before runtime admission";
    suppressedAlternatives = ["express_to_user", "run_authorized_work", "delegate_bounded_work"];
    revisitCondition = { kind: "permission_change", refs: [], reason: "permission or control state must change" };
  } else if (
    stateMode === "quieted"
    || stateMode === "cooling_down"
    || stateMode === "overloaded"
    || controlOverlays.includes("enter_quiet_mode")
  ) {
    decision = "wait_for_opportunity";
    updatedMaturationState = maturation.state === "new" ? "warming" : "held";
    companionStateEffect = "raise_thresholds";
    reason = "current companion state requires restraint before visibility";
    suppressedAlternatives = ["express_to_user", "escalate"];
    revisitCondition = { kind: "cooldown_elapsed", refs: [], reason: "try again after cooldown or quieter timing" };
  } else if (candidateConfidence(input.candidate) < 0.35) {
    decision = "decay";
    updatedMaturationState = "decayed";
    companionStateEffect = "none";
    reason = "confidence is too low to keep warming";
    suppressedAlternatives = ["express_to_user", "request_approval"];
    revisitCondition = { kind: "runtime_event", refs: [], reason: "fresh evidence may create a new candidate" };
  } else if (maturation.state !== "mature" && maturation.state !== "prepared") {
    decision = "watch";
    updatedMaturationState = maturation.state === "new" ? "warming" : "held";
    companionStateEffect = "hold_back";
    reason = "candidate remains internal until maturation reaches the gate boundary";
    suppressedAlternatives = ["express_to_user", "request_approval", "run_authorized_work"];
    revisitCondition = { kind: "runtime_event", refs: [], reason: "watch for repeated or stronger evidence" };
  }

  return InhibitionDecisionSchema.parse({
    decision_id: input.decision_id,
    target_ref: targetRef,
    decided_at: input.decided_at,
    decision,
    reason,
    companion_state_effect: companionStateEffect,
    updated_maturation_state: updatedMaturationState,
    revisit_condition: revisitCondition,
    suppressed_alternatives: suppressedAlternatives,
    evidence_refs: evidenceRefs,
    policy_refs: input.policy_refs ?? [],
    audit_refs: input.audit_refs ?? [],
  });
}

export function selectInitiativeGateDecision(input: InitiativeGateSelectionInput): InitiativeGateDecision {
  const inputRefs = uniqueRefs([
    candidateRef(input.candidate),
    ref("inhibition_decision", input.inhibition_decision.decision_id),
  ]);

  if (input.inhibition_decision.decision !== "allow_to_gate") {
    return InitiativeGateDecisionSchema.parse({
      decision_id: input.decision_id,
      decided_at: input.decided_at,
      status: input.inhibition_decision.decision === "reject_stale" || input.inhibition_decision.decision === "suppress"
        ? "blocked"
        : "delayed",
      input_refs: inputRefs,
      reason: input.inhibition_decision.reason,
      permission_checks: input.permission_checks ?? [],
      staleness_checks: input.staleness_checks ?? [],
      sensitivity_checks: input.sensitivity_checks ?? [],
      side_effect_checks: input.side_effect_checks ?? [],
      alternatives_considered: ["hold_in_agenda", "add_to_digest", "express_to_user"],
      suppressed_alternatives: input.inhibition_decision.suppressed_alternatives,
      required_runtime_control_refs: input.required_runtime_control_refs ?? [],
      required_approval: input.required_approval ?? false,
      audit_refs: input.audit_refs ?? [],
    });
  }

  const failedCheck = firstFailed([
    ...(input.permission_checks ?? []),
    ...(input.staleness_checks ?? []),
    ...(input.sensitivity_checks ?? []),
    ...(input.side_effect_checks ?? []),
  ]);
  if (failedCheck) {
    return InitiativeGateDecisionSchema.parse({
      decision_id: input.decision_id,
      decided_at: input.decided_at,
      status: "blocked",
      input_refs: inputRefs,
      reason: failedCheck.reason,
      permission_checks: input.permission_checks ?? [],
      staleness_checks: input.staleness_checks ?? [],
      sensitivity_checks: input.sensitivity_checks ?? [],
      side_effect_checks: input.side_effect_checks ?? [],
      alternatives_considered: ["hold_in_agenda", "add_to_digest", "express_to_user"],
      suppressed_alternatives: ["express_to_user", "run_authorized_work", "delegate_bounded_work"],
      required_runtime_control_refs: input.required_runtime_control_refs ?? [],
      required_approval: input.required_approval ?? false,
      audit_refs: input.audit_refs ?? [],
    });
  }

  const selectedOutcome = selectOutcomeClass(input);
  return InitiativeGateDecisionSchema.parse({
    decision_id: input.decision_id,
    decided_at: input.decided_at,
    status: "selected",
    input_refs: inputRefs,
    selected_outcome: selectedOutcome,
    reason: "candidate passed inhibition and typed gate checks",
    why_this: candidateSubject(input.candidate),
    why_now: input.companion_state?.mode
      ? `companion_state:${input.companion_state.mode}`
      : "no blocking companion state",
    why_this_route: `selected_outcome:${selectedOutcome}`,
    permission_checks: input.permission_checks ?? [],
    staleness_checks: input.staleness_checks ?? [],
    sensitivity_checks: input.sensitivity_checks ?? [],
    side_effect_checks: input.side_effect_checks ?? [],
    alternatives_considered: ["hold_in_agenda", "add_to_digest", "express_to_user", "request_approval"],
    suppressed_alternatives: selectedOutcome === "express_to_user" ? ["escalate"] : ["express_to_user", "escalate"],
    required_runtime_control_refs: input.required_runtime_control_refs ?? [],
    required_approval: input.required_approval ?? selectedOutcome === "request_approval",
    audit_refs: input.audit_refs ?? [],
  });
}

export function admitInitiativeGateDecision(input: RuntimeAdmissionInput): OutcomeDecision | null {
  if (input.gate_decision.status !== "selected" || !input.gate_decision.selected_outcome) {
    return null;
  }

  const requested = input.gate_decision.selected_outcome;
  const requiredRuntimeControlRefs = input.gate_decision.required_runtime_control_refs;
  const admittedRuntimeControlRefs = (input.admitted_runtime_control_refs ?? []).filter((candidate) =>
    candidate.kind === "runtime_control"
  );
  const invalidRequiredRuntimeControlRefs = requiredRuntimeControlRefs.filter((candidate) =>
    candidate.kind !== "runtime_control"
  );
  if (invalidRequiredRuntimeControlRefs.length > 0) {
    return OutcomeDecisionSchema.parse({
      outcome_decision_id: input.outcome_decision_id,
      initiative_decision_ref: ref("initiative_gate_decision", input.gate_decision.decision_id),
      decided_at: input.decided_at,
      requested_outcome: requested,
      admission_status: "held",
      runtime_item_refs: input.runtime_item_refs ?? [],
      authority_checks: input.authority_checks ?? [],
      staleness_checks: input.staleness_checks ?? [],
      companion_control_checks: input.companion_control_checks ?? [],
      safety_checks: input.safety_checks ?? [],
      downgrade_or_rejection_reason: {
        code: "authority_unknown",
        detail: `required runtime control refs must use kind runtime_control: ${invalidRequiredRuntimeControlRefs.map(refKey).join(", ")}`,
      },
      audit_ref: input.audit_ref,
    });
  }

  const missingRuntimeControlRefs = missingRequiredRefs(
    requiredRuntimeControlRefs,
    admittedRuntimeControlRefs
  );
  if (missingRuntimeControlRefs.length > 0) {
    return OutcomeDecisionSchema.parse({
      outcome_decision_id: input.outcome_decision_id,
      initiative_decision_ref: ref("initiative_gate_decision", input.gate_decision.decision_id),
      decided_at: input.decided_at,
      requested_outcome: requested,
      admission_status: "held",
      runtime_item_refs: input.runtime_item_refs ?? [],
      authority_checks: input.authority_checks ?? [],
      staleness_checks: input.staleness_checks ?? [],
      companion_control_checks: input.companion_control_checks ?? [],
      safety_checks: input.safety_checks ?? [],
      downgrade_or_rejection_reason: {
        code: "authority_unknown",
        detail: `required runtime control refs were not admitted: ${missingRuntimeControlRefs.map(refKey).join(", ")}`,
      },
      audit_ref: input.audit_ref,
    });
  }
  if (input.gate_decision.required_approval && !input.approval_ref && requested !== "request_approval") {
    const finalOutcome = downgradeForRuntimeAdmissionFailure(requested, "approval_required");
    return OutcomeDecisionSchema.parse({
      outcome_decision_id: input.outcome_decision_id,
      initiative_decision_ref: ref("initiative_gate_decision", input.gate_decision.decision_id),
      decided_at: input.decided_at,
      requested_outcome: requested,
      admission_status: finalOutcome ? "downgraded" : "held",
      final_outcome: finalOutcome,
      runtime_item_refs: input.runtime_item_refs ?? [],
      authority_checks: input.authority_checks ?? [],
      staleness_checks: input.staleness_checks ?? [],
      companion_control_checks: input.companion_control_checks ?? [],
      safety_checks: input.safety_checks ?? [],
      downgrade_or_rejection_reason: {
        code: "approval_required",
        detail: "initiative gate required approval before runtime admission",
      },
      visibility_policy_ref: finalOutcome ? input.visibility_policy_ref : undefined,
      audit_ref: input.audit_ref,
    });
  }

  const failed = firstRuntimeAdmissionFailure(input);
  if (failed) {
    const finalOutcome = downgradeForRuntimeAdmissionFailure(requested, failed.code);
    const admissionStatus = admissionStatusForRuntimeFailure(failed.code, finalOutcome);
    return OutcomeDecisionSchema.parse({
      outcome_decision_id: input.outcome_decision_id,
      initiative_decision_ref: ref("initiative_gate_decision", input.gate_decision.decision_id),
      decided_at: input.decided_at,
      requested_outcome: requested,
      admission_status: admissionStatus,
      final_outcome: finalOutcome,
      runtime_item_refs: input.runtime_item_refs ?? [],
      authority_checks: input.authority_checks ?? [],
      staleness_checks: input.staleness_checks ?? [],
      companion_control_checks: input.companion_control_checks ?? [],
      safety_checks: input.safety_checks ?? [],
      downgrade_or_rejection_reason: {
        code: failed.code,
        detail: failed.reason,
        evidence_refs: failed.evidence_refs,
      },
      visibility_policy_ref: finalOutcome ? input.visibility_policy_ref : undefined,
      audit_ref: input.audit_ref,
    });
  }

  if (
    outcomeRequiresRuntimeControl(requested) &&
    requiredRuntimeControlRefs.length === 0 &&
    admittedRuntimeControlRefs.length === 0
  ) {
    return OutcomeDecisionSchema.parse({
      outcome_decision_id: input.outcome_decision_id,
      initiative_decision_ref: ref("initiative_gate_decision", input.gate_decision.decision_id),
      decided_at: input.decided_at,
      requested_outcome: requested,
      admission_status: "held",
      runtime_item_refs: input.runtime_item_refs ?? [],
      authority_checks: input.authority_checks ?? [],
      staleness_checks: input.staleness_checks ?? [],
      companion_control_checks: input.companion_control_checks ?? [],
      safety_checks: input.safety_checks ?? [],
      downgrade_or_rejection_reason: {
        code: "authority_unknown",
        detail: `runtime-control admission evidence is required for ${requested}`,
      },
      audit_ref: input.audit_ref,
    });
  }

  return OutcomeDecisionSchema.parse({
    outcome_decision_id: input.outcome_decision_id,
    initiative_decision_ref: ref("initiative_gate_decision", input.gate_decision.decision_id),
    decided_at: input.decided_at,
    requested_outcome: requested,
    admission_status: "admitted",
    final_outcome: requested,
    runtime_item_refs: input.runtime_item_refs ?? [],
    authority_checks: input.authority_checks ?? [],
    staleness_checks: input.staleness_checks ?? [],
    companion_control_checks: input.companion_control_checks ?? [],
    safety_checks: input.safety_checks ?? [],
    visibility_policy_ref: input.visibility_policy_ref,
    audit_ref: input.audit_ref,
  });
}

export function applySurfaceInvalidationToAttention(
  input: AttentionSurfaceInvalidationInput
): AttentionSurfaceInvalidationResult {
  const event = SurfaceInvalidationEventSchema.parse(input.surface_invalidation_event);
  const invalidatedSurfaceRef = ref("surface", event.surface_ref);
  const currentSurfaceRef = input.current_surface_ref ?? null;
  const invalidationEvidence = surfaceInvalidationEvidenceRef(event);
  const invalidationAuditRef = ref("audit_trace", event.audit_ref);
  const auditRefs = uniqueRefs([...(input.audit_refs ?? []), invalidationAuditRef]);

  const invalidatedUrges = (input.urge_candidates ?? [])
    .filter((urge) => urgeUsesInvalidatedSurface(urge, event))
    .map((urge) =>
      UrgeCandidateSchema.parse({
        ...urge,
        surface_ref: null,
        companion_state_ref: null,
        evidence_refs: [invalidationEvidence],
        allowed_moves: intersectMoves(urge.allowed_moves, ["notice", "watch", "hold"]),
        forbidden_moves: uniqueMoves([...urge.forbidden_moves, ...OUTWARD_PRE_GATE_FORBIDDEN_MOVES]),
        maturation: invalidatedMaturation(urge.maturation, event.action, input.now, invalidationEvidence),
        audit_refs: uniqueRefs([...urge.audit_refs, ...auditRefs]),
      })
    );
  const invalidatedUrgeRefKeys = new Set(invalidatedUrges.map((urge) => refKey(ref("urge_candidate", urge.urge_id))));

  const invalidatedAgendaItems = (input.agenda_items ?? [])
    .filter((item) => agendaUsesInvalidatedSurface(item, event, invalidatedUrgeRefKeys))
    .map((item) => {
      const canReground = currentSurfaceRef !== null
        && currentSurfaceRef.id !== event.surface_ref
        && item.related_surface_refs.some((surfaceRef) => refKey(surfaceRef) === refKey(currentSurfaceRef));
      const currentPosture = canReground ? "held" : "expired";
      const maturationState = canReground ? "held" : "expired";
      const auditOnlyAgendaId = `agenda-history:${stableId(`${item.agenda_item_id}:${event.id}`)}`;
      const redactedAgendaHistory = event.redaction_ref !== undefined;
      return AgentAgendaItemSchema.parse({
        ...item,
        agenda_item_id: canReground ? item.agenda_item_id : auditOnlyAgendaId,
        subject: canReground || !redactedAgendaHistory
          ? item.subject
          : "Invalidated Surface-derived agenda history",
        why_pulseed_cares: canReground
          ? item.why_pulseed_cares
          : "invalidated Surface dependency is retained only as audit history",
        expected_user_benefit: canReground
          ? item.expected_user_benefit
          : "Prevents stale Surface-derived agenda from reaching the Initiative Gate",
        related_goal_refs: canReground ? item.related_goal_refs : [],
        related_memory_refs: canReground ? item.related_memory_refs : [],
        related_surface_refs: canReground ? uniqueRefs([currentSurfaceRef]) : [],
        related_runtime_refs: canReground ? item.related_runtime_refs : [],
        source_urge_refs: canReground ? item.source_urge_refs : [],
        staleness_state: canReground ? "needs_regrounding" : "rejected",
        allowed_moves: canReground ? item.allowed_moves : [],
        current_posture: currentPosture,
        control_state: canReground ? "held" : "expired",
        maturation: {
          ...item.maturation,
          state: maturationState,
          expires_at: canReground ? item.maturation.expires_at : input.now,
          reinforcement_refs: canReground ? item.maturation.reinforcement_refs : [],
          blocker_refs: canReground
            ? uniqueSourceRefs([...item.maturation.blocker_refs, invalidationEvidence])
            : [invalidationEvidence],
        },
        revisit_condition: canReground
          ? {
              kind: "surface_refresh",
              refs: [currentSurfaceRef],
              reason: "re-ground agenda item against current Surface before attention can infer state",
            }
          : {
              kind: "none",
              refs: [],
              reason: "agenda item depended on invalid Surface and has no current Surface re-grounding",
            },
        merge_trace: item.merge_trace
          ? {
              ...item.merge_trace,
              dedupe_key: canReground ? item.merge_trace.dedupe_key : `audit-only:${auditOnlyAgendaId}`,
              merged_urge_refs: canReground ? item.merge_trace.merged_urge_refs : [],
              reinforced_by_refs: canReground ? item.merge_trace.reinforced_by_refs : [],
              audit_refs: uniqueRefs([...item.merge_trace.audit_refs, ...auditRefs]),
            }
          : undefined,
        updated_at: input.now,
        audit_refs: uniqueRefs([...item.audit_refs, ...auditRefs]),
      });
    });

  return {
    surface_ref: invalidatedSurfaceRef,
    invalidation_check: surfaceInvalidationStalenessCheck(event),
    invalidated_urge_candidates: invalidatedUrges,
    invalidated_agenda_items: invalidatedAgendaItems,
    audit_refs: auditRefs,
  };
}

export function createExpressionDecisionForOutcome(
  input: ExpressionDecisionCreationInput
): ExpressionDecision | null {
  const outcome = OutcomeDecisionSchema.parse(input.outcome_decision);
  if (
    outcome.admission_status !== "admitted" &&
    outcome.admission_status !== "downgraded"
  ) {
    return null;
  }

  if (!outcome.final_outcome) return null;

  const surfaceFacing = SurfaceFacingOutcomeClassSchema.safeParse(outcome.final_outcome);
  if (!surfaceFacing.success) return null;

  const visibilityPolicyRef = outcome.visibility_policy_ref;
  if (!visibilityPolicyRef) return null;
  if (input.visibility_policy_ref && refKey(input.visibility_policy_ref) !== refKey(visibilityPolicyRef)) {
    throw new Error("ExpressionDecision must use the OutcomeDecision visibility policy");
  }

  return ExpressionDecisionSchema.parse({
    expression_decision_id: input.expression_decision_id,
    outcome_decision_ref: ref("outcome_decision", outcome.outcome_decision_id),
    outcome_class: surfaceFacing.data,
    created_at: input.created_at,
    expression_mode: input.expression_mode ?? defaultExpressionModeForOutcome(surfaceFacing.data),
    target_surface_classes: input.target_surface_classes,
    visibility_policy_ref: visibilityPolicyRef,
    user_facing_rationale: input.user_facing_rationale ?? defaultExpressionRationale(surfaceFacing.data),
    suppressed_detail_refs: input.suppressed_detail_refs ?? [],
    audit_ref: input.audit_ref,
  });
}

export function renderExpressionDecisionForSurface(
  input: SurfaceDecisionRenderInput
): SurfaceDecisionRender | null {
  const outcome = OutcomeDecisionSchema.parse(input.outcome_decision);
  if (!input.expression_decision) return null;

  const expression = ExpressionDecisionSchema.parse(input.expression_decision);
  const visibilityPolicy = VisibilityPolicySchema.parse(input.visibility_policy);
  const outcomeRef = ref("outcome_decision", outcome.outcome_decision_id);
  const expressionRef = ref("expression_decision", expression.expression_decision_id);

  if (expression.outcome_decision_ref.id !== outcome.outcome_decision_id) {
    throw new Error("ExpressionDecision must reference the supplied OutcomeDecision");
  }
  if (outcome.final_outcome !== expression.outcome_class) {
    throw new Error("ExpressionDecision outcome_class must match OutcomeDecision.final_outcome");
  }
  if (expression.visibility_policy_ref.id !== visibilityPolicy.visibility_policy_id) {
    throw new Error("ExpressionDecision visibility_policy_ref must reference the supplied VisibilityPolicy");
  }
  if (!outcome.visibility_policy_ref || refKey(outcome.visibility_policy_ref) !== refKey(expression.visibility_policy_ref)) {
    throw new Error("ExpressionDecision must use the OutcomeDecision visibility policy");
  }
  if (!visibilityPolicyAppliesToDecision(visibilityPolicy, outcomeRef, expressionRef)) {
    throw new Error("VisibilityPolicy must apply to the rendered outcome or expression decision");
  }
  if (!expression.target_surface_classes.includes(input.surface_class)) return null;
  if (!visibilityAllowsSurface(visibilityPolicy, input.surface_class)) return null;

  return {
    schema_version: "surface-decision-render-v1",
    render_id: input.render_id,
    rendered_at: input.rendered_at,
    surface_class: input.surface_class,
    outcome_decision_ref: outcomeRef,
    expression_decision_ref: expressionRef,
    outcome_class: expression.outcome_class,
    expression_mode: expression.expression_mode,
    visibility_policy_ref: expression.visibility_policy_ref,
    user_facing_rationale: expression.user_facing_rationale,
    suppressed_detail_refs: expression.suppressed_detail_refs,
    audit_ref: input.audit_ref ?? expression.audit_ref,
  };
}

export function applyAttentionFeedbackConservatively(
  feedbackEvents: AttentionFeedbackEvent[]
): AttentionFeedbackPolicyAdjustment {
  const cooldownRefs: CompanionAutonomyRef[] = [];
  const suppressedAgendaKinds = new Set<AgentAgendaItemKind>();
  const approvalRequiredOutcomes = new Set<OutcomeClass>();
  const narrowedSurfaceRefs: CompanionAutonomyRef[] = [];
  const sensitiveUrgeOrigins = new Set<UrgeOrigin>();
  const permissionUpdateRefs: CompanionAutonomyRef[] = [];
  const auditRefs: CompanionAutonomyRef[] = [];
  const thresholdEffects = new Set<AttentionFeedbackPolicyAdjustment["threshold_effects"][number]>();
  const dismissalsByAgendaKind = new Map<AgentAgendaItemKind, number>();

  for (const event of feedbackEvents) {
    auditRefs.push(event.feedback_ref);

    switch (event.kind) {
      case "accepted": {
        thresholdEffects.add("preserve_thresholds");
        break;
      }
      case "dismissed":
      case "overreach": {
        cooldownRefs.push(event.feedback_ref);
        thresholdEffects.add("raise_expression_threshold");
        if (event.route) approvalRequiredOutcomes.add(event.route);
        if (event.agenda_kind) {
          dismissalsByAgendaKind.set(event.agenda_kind, (dismissalsByAgendaKind.get(event.agenda_kind) ?? 0) + 1);
        }
        if (event.urge_origin) sensitiveUrgeOrigins.add(event.urge_origin);
        break;
      }
      case "correction": {
        thresholdEffects.add("raise_attention_threshold");
        if (event.route) approvalRequiredOutcomes.add(event.route);
        if (event.urge_origin) sensitiveUrgeOrigins.add(event.urge_origin);
        break;
      }
      case "permission_revoked": {
        if (event.permission_ref) permissionUpdateRefs.push(event.permission_ref);
        if (event.route) approvalRequiredOutcomes.add(event.route);
        thresholdEffects.add("raise_expression_threshold");
        break;
      }
      case "surface_narrowed": {
        if (event.surface_ref) narrowedSurfaceRefs.push(event.surface_ref);
        thresholdEffects.add("raise_attention_threshold");
        break;
      }
    }
  }

  for (const [kind, count] of dismissalsByAgendaKind) {
    if (count >= 2) suppressedAgendaKinds.add(kind);
  }

  if (thresholdEffects.size === 0) thresholdEffects.add("preserve_thresholds");

  return {
    cooldown_refs: uniqueRefs(cooldownRefs),
    suppressed_agenda_kinds: [...suppressedAgendaKinds],
    approval_required_outcomes: [...approvalRequiredOutcomes],
    narrowed_surface_refs: uniqueRefs(narrowedSurfaceRefs),
    sensitive_urge_origins: [...sensitiveUrgeOrigins],
    permission_update_refs: uniqueRefs(permissionUpdateRefs),
    audit_refs: uniqueRefs(auditRefs),
    threshold_effects: [...thresholdEffects],
  };
}

export function runtimeItemsForAgenda(items: AgentAgendaItem[], now: string): RuntimeItem[] {
  return items.map((item) => ({
    schema_version: "runtime-item-v1",
    item_id: item.agenda_item_id,
    type: "agent_agenda_item",
    status: item.current_posture === "ready_for_gate" ? "mature" : "active",
    posture: agendaPostureToRuntimePosture(item.current_posture),
    source: "attention-metabolism",
    created_at: item.created_at,
    updated_at: now,
    related_goal_refs: item.related_goal_refs.map((candidate) => candidate.id),
    related_task_refs: [],
    related_session_refs: [],
    related_memory_refs: item.related_memory_refs.map((candidate) => candidate.id),
    related_surface_refs: item.related_surface_refs.map((candidate) => candidate.id),
    related_agenda_refs: [item.agenda_item_id],
    companion_state_refs: [],
    companion_control_state: {
      active_controls: [],
      global_control_refs: [],
      held_by_controls: [],
      rejected_by_controls: [],
      reason: "agenda runtime item awaits runtime-control admission",
    },
    authority: {
      inspectable: true,
      resumable: false,
      actionable: false,
      speakable: false,
      can_create_urge: false,
      can_update_surface: false,
      can_write_memory: false,
      can_delegate_work: false,
      requires_confirmation: true,
      approval_scope: "inspect_only",
      authority_reason: "attention agenda is inspect-only before runtime admission",
    },
    staleness: currentStaleness("agenda item derived from current typed attention evidence"),
    visibility_policy: {
      display: "hidden",
      inspectable: true,
      auditable: true,
      policy_ref: null,
      reason: "agenda remains hidden from normal display until admitted by runtime control",
    },
    visibility_policy_ref: null,
    control_policy: {
      allowed_controls: ["inspect_item"],
      forbidden_controls: [
        "pause_item",
        "resume_item",
        "cancel_item",
        "finalize_item",
        "forget_item",
        "reground_item",
        "revoke_permission",
        "narrow_permission",
        "require_confirmation",
      ],
      required_confirmation: ["require_confirmation"],
      repair_options: ["reground_item", "require_confirmation"],
      reason: "agenda runtime mirror is inspection-only before admission",
    },
    audit_trace_refs: item.audit_refs.map((candidate) => candidate.id),
  }));
}

function createAgendaItemFromUrge(
  urge: UrgeCandidate,
  kind: AgentAgendaItemKind,
  now: string,
  dedupeKey: string
): AgentAgendaItem {
  const sourceUrgeRef = ref("urge_candidate", urge.urge_id);
  const posture = agendaPostureForMaturation(urge.maturation.state);
  const evidenceRefs = uniqueSourceRefs(urge.evidence_refs);

  return AgentAgendaItemSchema.parse({
    agenda_item_id: `agenda:${stableId(dedupeKey)}`,
    origin: urge.origin,
    kind,
    subject: urge.subject,
    why_pulseed_cares: `typed ${urge.origin} ${urge.feeling} pressure requires internal attention`,
    expected_user_benefit: urge.expected_user_benefit,
    related_goal_refs: refsOfKind([urge.target, ...evidenceRefs.map((evidence) => evidence.ref)], "goal"),
    related_memory_refs: refsOfKind([urge.target, ...evidenceRefs.map((evidence) => evidence.ref)], "memory"),
    related_surface_refs: uniqueRefs([
      ...(urge.surface_ref ? [urge.surface_ref] : []),
      ...refsOfKind(evidenceRefs.map((evidence) => evidence.ref), "surface"),
    ]),
    related_runtime_refs: refsOfKind(
      [urge.target, ...evidenceRefs.map((evidence) => evidence.ref)],
      "runtime_item",
      "runtime_event"
    ),
    source_urge_refs: [sourceUrgeRef],
    drive_basis: urge.origin === "drive" ? "drive contributes care pressure only" : undefined,
    curiosity_basis: urge.origin === "curiosity" || urge.feeling === "curiosity"
      ? "curiosity contributes exploration pressure only"
      : undefined,
    confidence: urge.confidence,
    intrusion_cost: urge.user_cost,
    relationship_risk: urge.relationship_risk,
    staleness_state: stalenessStateForEvidence(evidenceRefs),
    allowed_moves: intersectMoves(urge.allowed_moves, INTERNAL_PRE_GATE_MOVES),
    forbidden_moves: uniqueMoves([...urge.forbidden_moves, ...OUTWARD_PRE_GATE_FORBIDDEN_MOVES]),
    current_posture: posture,
    maturation: urge.maturation,
    revisit_condition: posture === "ready_for_gate"
      ? { kind: "manual_review", refs: [], reason: "ready for Initiative Gate evaluation" }
      : DEFAULT_REVISIT_CONDITION,
    control_state: posture === "expired" ? "expired" : posture === "suppressed" ? "suppressed" : "held",
    merge_trace: {
      dedupe_key: dedupeKey,
      basis: {
        target: true,
        evidence: true,
        surface: true,
        kind: true,
        current_posture: true,
      },
      merged_urge_refs: [sourceUrgeRef],
      reinforced_by_refs: evidenceRefs,
    },
    created_at: now,
    updated_at: now,
    audit_refs: urge.audit_refs,
  });
}

function risk(level: AttentionRiskAssessment["level"], reason: string): AttentionRiskAssessment {
  return {
    level,
    reason,
    evidence_refs: [],
  };
}

function agendaKindForUrge(urge: UrgeCandidate): AgentAgendaItemKind {
  const byOrigin: Record<UrgeOrigin, AgentAgendaItemKind> = {
    goal: "goal_stewardship",
    memory: "memory_conflict",
    schedule: "preparation_opportunity",
    runtime_event: "stall_concern",
    world_change: "project_drift",
    user_pattern: "preparation_opportunity",
    curiosity: "curiosity_followup",
    drive: "goal_stewardship",
    risk: "permission_boundary",
    guardrail: "permission_boundary",
    backpressure: "user_overload",
    correction: "unresolved_decision",
  };
  if (urge.feeling === "staleness_pressure") return "surface_staleness";
  if (urge.feeling === "repair_pressure") return "commitment_guard";
  return byOrigin[urge.origin];
}

function dedupeKeyForUrge(urge: UrgeCandidate, kind: AgentAgendaItemKind): string {
  return [
    `target:${refKey(urge.target)}`,
    `surface:${urge.surface_ref ? refKey(urge.surface_ref) : "none"}`,
    `kind:${kind}`,
    `posture:${agendaPostureForMaturation(urge.maturation.state)}`,
  ].join("|");
}

function dedupeKeyForAgenda(item: AgentAgendaItem): string {
  if (item.merge_trace) return item.merge_trace.dedupe_key;
  return [
    `target:${item.related_goal_refs[0] ? refKey(item.related_goal_refs[0]) : item.agenda_item_id}`,
    `surface:${item.related_surface_refs[0] ? refKey(item.related_surface_refs[0]) : "none"}`,
    `kind:${item.kind}`,
    `posture:${item.current_posture}`,
  ].join("|");
}

function reinforceMaturation(
  existing: AttentionMaturation,
  urge: UrgeCandidate,
  now: string
): AttentionMaturation {
  const state = existing.state === "new"
    ? "warming"
    : existing.state === "warming"
      ? "held"
      : existing.state;

  return {
    ...existing,
    state,
    last_reinforced_at: now,
    reinforcement_refs: uniqueSourceRefs([...existing.reinforcement_refs, ...urge.evidence_refs]),
  };
}

function selectMaturationCause(input: AdvanceMaturationInput): AttentionMaturationTransitionCause {
  if (input.blocker_causes?.includes("stale_target")) return "stale_target";
  if (input.expires_at && Date.parse(input.expires_at) <= Date.parse(input.now)) return "expired";
  if ((input.confidence !== undefined && input.confidence < 0.35) || input.blocker_causes?.includes("low_confidence")) {
    return "low_confidence";
  }
  if (input.blocker_causes && input.blocker_causes.length > 0) return input.blocker_causes[0] ?? "boundary";
  if (input.reinforcement_causes && input.reinforcement_causes.length > 0) return input.reinforcement_causes[0] ?? "repeated_evidence";
  return "repeated_evidence";
}

function nextMaturationState(
  current: AttentionMaturationState,
  cause: AttentionMaturationTransitionCause,
  prepareAllowed: boolean
): AttentionMaturationState {
  switch (cause) {
    case "stale_target":
      return "rejected_stale";
    case "expired":
      return "expired";
    case "low_confidence":
      return "decayed";
    case "missing_permission":
    case "high_interruption_cost":
    case "sensitivity":
    case "dismissal":
    case "overload":
    case "boundary":
    case "anti_memory":
      return "held";
    case "expressed":
      return "expressed";
    case "time_sensitivity":
    case "promise":
    case "safety_pressure":
    case "user_authorized_work":
      return prepareAllowed ? "prepared" : "mature";
    case "repeated_evidence":
    case "goal_relevance":
    case "staleness_risk":
      if (prepareAllowed) return "prepared";
      if (current === "new") return "warming";
      if (current === "warming") return "held";
      if (current === "held") return "mature";
      return current;
  }
}

function isReinforcementCause(cause: AttentionMaturationTransitionCause): boolean {
  return cause === "repeated_evidence"
    || cause === "goal_relevance"
    || cause === "time_sensitivity"
    || cause === "promise"
    || cause === "safety_pressure"
    || cause === "user_authorized_work"
    || cause === "staleness_risk";
}

function selectOutcomeClass(input: InitiativeGateSelectionInput): OutcomeClass {
  if (input.required_approval) return "request_approval";
  if (input.requested_outcome) return input.requested_outcome;
  if ("kind" in input.candidate) {
    if (input.candidate.current_posture === "prepared") return "prepare_silently";
    if (input.candidate.kind === "curiosity_followup") return "prepare_silently";
    if (input.candidate.kind === "user_overload") return "hold_in_agenda";
  }
  return "hold_in_agenda";
}

function outcomeRequiresRuntimeControl(outcome: OutcomeClass): boolean {
  return outcome === "run_authorized_work"
    || outcome === "delegate_bounded_work"
    || outcome === "prepare_action_candidate"
    || outcome === "request_approval"
    || outcome === "write_governed_memory_candidate"
    || outcome === "update_surface_candidate"
    || outcome === "add_to_digest"
    || outcome === "express_to_user"
    || outcome === "escalate";
}

function firstRuntimeAdmissionFailure(input: RuntimeAdmissionInput): {
  code: OutcomeDecisionReasonCode;
  reason: string;
  evidence_refs: CompanionAutonomySourceRef[];
} | null {
  const safety = firstFailed(input.safety_checks ?? []);
  if (safety) {
    return {
      code: safety.kind === "guardrail" ? "guardrail_blocked" : "safety_blocked",
      reason: safety.reason,
      evidence_refs: safety.evidence_refs,
    };
  }
  const staleness = firstFailed(input.staleness_checks ?? []);
  if (staleness) {
    return {
      code: staleness.kind === "surface" ? "invalid_surface" : "stale_target",
      reason: staleness.reason,
      evidence_refs: staleness.evidence_refs,
    };
  }
  const authority = firstFailed(input.authority_checks ?? []);
  if (authority) {
    return {
      code: authority.kind === "permission" ? "missing_permission" : "authority_unknown",
      reason: authority.reason,
      evidence_refs: authority.evidence_refs,
    };
  }
  const control = firstFailed(input.companion_control_checks ?? []);
  if (control) {
    return {
      code: companionControlFailureCode(control.kind),
      reason: control.reason,
      evidence_refs: control.evidence_refs,
    };
  }
  return null;
}

function companionControlFailureCode(kind: AutonomyCheck["kind"]): OutcomeDecisionReasonCode {
  switch (kind) {
    case "backpressure":
      return "backpressure";
    case "capacity":
      return "overloaded";
    case "cooldown":
      return "cooling_down";
    default:
      return "control_suppressed";
  }
}

function admissionStatusForRuntimeFailure(
  code: OutcomeDecisionReasonCode,
  finalOutcome: OutcomeClass | undefined
): OutcomeAdmissionStatus {
  if (finalOutcome) return "downgraded";
  if (code === "invalid_surface" || code === "backpressure" || code === "overloaded" || code === "cooling_down") {
    return "held";
  }
  return "rejected";
}

function downgradeForRuntimeAdmissionFailure(
  requested: OutcomeClass,
  code: OutcomeDecisionReasonCode
): OutcomeClass | undefined {
  if (code === "approval_required") {
    if (requested === "prepare_action_candidate" || requested === "escalate") return "request_approval";
    return undefined;
  }
  if (
    code !== "control_suppressed" &&
    code !== "backpressure" &&
    code !== "overloaded" &&
    code !== "cooling_down"
  ) {
    return undefined;
  }

  switch (requested) {
    case "run_authorized_work":
    case "add_to_digest":
    case "escalate":
      return "hold_in_agenda";
    case "delegate_bounded_work":
      return "prepare_silently";
    case "prepare_action_candidate":
      return code === "control_suppressed" ? undefined : "hold_in_agenda";
    case "express_to_user":
      return "add_to_digest";
    default:
      return undefined;
  }
}

function defaultExpressionModeForOutcome(outcome: SurfaceFacingOutcomeClass): ExpressionMode {
  switch (outcome) {
    case "add_to_digest":
      return "digest_item";
    case "request_approval":
      return "approval_request";
    case "escalate":
      return "urgent_alert";
    case "express_to_user":
      return "direct_message";
  }
}

function defaultExpressionRationale(outcome: SurfaceFacingOutcomeClass): string {
  switch (outcome) {
    case "add_to_digest":
      return "Add the admitted outcome to the shared digest.";
    case "request_approval":
      return "Ask the user before continuing the blocked action.";
    case "escalate":
      return "Escalate the admitted outcome to the user-visible surface.";
    case "express_to_user":
      return "Express the admitted outcome to the user.";
  }
}

function visibilityPolicyAppliesToDecision(
  policy: VisibilityPolicy,
  outcomeRef: CompanionAutonomyRef,
  expressionRef: CompanionAutonomyRef
): boolean {
  return policy.applies_to.some((candidate) =>
    refKey(candidate) === refKey(outcomeRef) || refKey(candidate) === refKey(expressionRef)
  );
}

function visibilityAllowsSurface(policy: VisibilityPolicy, surfaceClass: ExpressionSurfaceClass): boolean {
  if (policy.never_directly_show) return false;
  if (policy.digest_only && surfaceClass !== "digest") return false;

  switch (surfaceClass) {
    case "chat":
    case "gateway":
    case "notification":
      return policy.visible_in_chat;
    case "tui":
      return policy.visible_in_tui;
    case "cli":
      return policy.visible_in_cli;
    case "digest":
      return policy.visible_in_digest;
    case "daemon_snapshot":
      return policy.visible_in_debug || policy.visible_in_audit;
    case "gui":
      return policy.visible_in_gui;
  }
}

function firstFailed(checks: AutonomyCheck[]): AutonomyCheck | null {
  return checks.find((check) => check.status === "failed" || check.status === "unknown") ?? null;
}

function passedCheck(kind: AutonomyCheck["kind"], reason: string): AutonomyCheck {
  return {
    check_id: `${kind}:schedule-wake`,
    kind,
    status: "passed",
    reason,
    evidence_refs: [],
  };
}

function candidateMaturation(candidate: UrgeCandidate | AgentAgendaItem): AttentionMaturation {
  return candidate.maturation;
}

function candidateEvidenceRefs(candidate: UrgeCandidate | AgentAgendaItem): CompanionAutonomySourceRef[] {
  if ("evidence_refs" in candidate) return candidate.evidence_refs;
  return uniqueSourceRefs([
    ...(candidate.merge_trace?.reinforced_by_refs ?? []),
    ...candidate.source_urge_refs.map((sourceUrge) => ({
      ref: sourceUrge,
      lifecycle: "active" as const,
    })),
  ]);
}

function candidateRef(candidate: UrgeCandidate | AgentAgendaItem): CompanionAutonomyRef {
  if ("urge_id" in candidate) return ref("urge_candidate", candidate.urge_id);
  return ref("agent_agenda_item", candidate.agenda_item_id);
}

function candidateConfidence(candidate: UrgeCandidate | AgentAgendaItem): number {
  return candidate.confidence;
}

function candidateSubject(candidate: UrgeCandidate | AgentAgendaItem): string {
  return candidate.subject;
}

function surfaceInvalidationStalenessCheck(event: SurfaceInvalidationEvent): AutonomyCheck {
  return {
    check_id: `surface-invalidation:${event.id}`,
    kind: "staleness",
    status: "failed",
    reason: `Surface ${event.surface_ref} invalidated by ${event.trigger}`,
    evidence_refs: [surfaceInvalidationEvidenceRef(event)],
  };
}

function surfaceInvalidationEvidenceRef(event: SurfaceInvalidationEvent): CompanionAutonomySourceRef {
  return {
    ref: ref("surface", event.surface_ref),
    lifecycle: "redacted",
    redaction_reason: `surface invalidated by ${event.trigger}`,
  };
}

function invalidatedMaturation(
  maturation: AttentionMaturation,
  action: SurfaceInvalidationAction,
  now: string,
  invalidationEvidence: CompanionAutonomySourceRef
): AttentionMaturation {
  const state = maturationStateForSurfaceInvalidation(action);
  return {
    ...maturation,
    state,
    expires_at: state === "expired" || state === "rejected_stale" ? now : maturation.expires_at,
    reinforcement_refs: [],
    blocker_refs: [invalidationEvidence],
  };
}

function maturationStateForSurfaceInvalidation(action: SurfaceInvalidationAction): AttentionMaturationState {
  switch (action) {
    case "hold":
    case "regate":
    case "withdraw":
    case "needs_review":
      return "held";
    case "expire":
      return "expired";
    case "reject":
    case "redact":
      return "rejected_stale";
  }
}

function urgeUsesInvalidatedSurface(urge: UrgeCandidate, event: SurfaceInvalidationEvent): boolean {
  return urge.surface_ref?.id === event.surface_ref
    || urge.evidence_refs.some((evidence) => sourceEvidenceMatchesInvalidation(evidence, event));
}

function agendaUsesInvalidatedSurface(
  item: AgentAgendaItem,
  event: SurfaceInvalidationEvent,
  invalidatedUrgeRefKeys: Set<string>
): boolean {
  return item.related_surface_refs.some((surfaceRef) => surfaceRef.id === event.surface_ref)
    || item.related_memory_refs.some((memoryRef) => memoryRef.id === event.source_ref.memory_id)
    || item.source_urge_refs.some((urgeRef) => invalidatedUrgeRefKeys.has(refKey(urgeRef)))
    || (item.merge_trace?.reinforced_by_refs ?? []).some((evidence) => sourceEvidenceMatchesInvalidation(evidence, event));
}

function sourceEvidenceMatchesInvalidation(
  evidence: CompanionAutonomySourceRef,
  event: SurfaceInvalidationEvent
): boolean {
  return (evidence.ref.kind === "surface" && evidence.ref.id === event.surface_ref)
    || (evidence.ref.kind === "memory" && evidence.ref.id === event.source_ref.memory_id);
}

function agendaPostureForMaturation(state: AttentionMaturationState): AgendaPosture {
  switch (state) {
    case "new":
      return "new";
    case "warming":
      return "warming";
    case "mature":
      return "ready_for_gate";
    case "held":
      return "held";
    case "prepared":
      return "prepared";
    case "suppressed":
      return "suppressed";
    case "expired":
      return "expired";
    case "rejected_stale":
      return "rejected_stale";
    case "decayed":
      return "held";
    case "expressed":
      return "admitted";
  }
}

function agendaPostureToRuntimePosture(posture: AgendaPosture): RuntimeItem["posture"] {
  switch (posture) {
    case "new":
    case "warming":
    case "held":
      return "holding";
    case "prepared":
      return "watching";
    case "ready_for_gate":
      return "proposed";
    case "admitted":
      return "committed";
    case "suppressed":
      return "suppressed";
    case "expired":
      return "safe_to_forget";
    case "rejected_stale":
      return "stale";
  }
}

function stalenessStateForEvidence(evidenceRefs: CompanionAutonomySourceRef[]): AgentAgendaItem["staleness_state"] {
  if (evidenceRefs.some((evidence) => evidence.lifecycle === "deleted" || evidence.lifecycle === "tombstone")) {
    return "rejected";
  }
  if (evidenceRefs.some((evidence) => evidence.lifecycle === "redacted")) {
    return "needs_regrounding";
  }
  return "current";
}

function refsOfKind(
  refs: CompanionAutonomyRef[],
  ...kinds: CompanionAutonomyRefKind[]
): CompanionAutonomyRef[] {
  return uniqueRefs(refs.filter((candidate) => kinds.includes(candidate.kind)));
}

function missingRequiredRefs(
  requiredRefs: readonly CompanionAutonomyRef[],
  admittedRefs: readonly CompanionAutonomyRef[]
): CompanionAutonomyRef[] {
  const admitted = new Set(admittedRefs.map(refKey));
  return requiredRefs.filter((required) => !admitted.has(refKey(required)));
}

function intersectMoves(moves: readonly AttentionMove[], allowed: readonly AttentionMove[]): AttentionMove[] {
  return uniqueMoves(moves.filter((move) => allowed.includes(move)));
}

function uniqueMoves(moves: readonly AttentionMove[]): AttentionMove[] {
  return unique(moves);
}

function uniqueRefs(refs: readonly CompanionAutonomyRef[]): CompanionAutonomyRef[] {
  return uniqueBy(refs, refKey);
}

function uniqueSourceRefs(refs: readonly CompanionAutonomySourceRef[]): CompanionAutonomySourceRef[] {
  return uniqueBy(refs, sourceRefKey);
}

function unique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function uniqueBy<T>(values: readonly T[], keyForValue: (value: T) => string): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const value of values) {
    const key = keyForValue(value);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function refKey(value: CompanionAutonomyRef): string {
  return `${value.kind}:${value.id}:${value.version ?? ""}`;
}

function sourceRefKey(value: CompanionAutonomySourceRef): string {
  return `${refKey(value.ref)}:${value.lifecycle}`;
}

function stableId(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}

function currentStaleness(reason: string): RuntimeItem["staleness"] {
  const dimension = { outcome: "current" as const, reason };
  return {
    temporal: dimension,
    world: dimension,
    project: dimension,
    permission: dimension,
    relationship: dimension,
    surface: dimension,
    goal: dimension,
    assumption: dimension,
    session: dimension,
    browser_session: dimension,
    auth_handoff: dimension,
  };
}
