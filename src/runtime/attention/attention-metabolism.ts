import {
  SurfaceInvalidationEventSchema,
  type SurfaceInvalidationAction,
  type SurfaceInvalidationEvent,
} from "../../grounding/surface-contracts.js";
import {
  renderVisibilityPolicyForSurface,
  type CompanionVisibilitySurface,
} from "../visibility/index.js";
export {
  AttentionFeedbackKindValues,
  applyAttentionFeedbackConservatively,
} from "./attention-feedback.js";
export type {
  AttentionFeedbackEvent,
  AttentionFeedbackKind,
  AttentionFeedbackPolicyAdjustment,
} from "./attention-feedback.js";
import {
  DEFAULT_REVISIT_CONDITION,
  INTERNAL_PRE_GATE_MOVES,
  OUTWARD_PRE_GATE_FORBIDDEN_MOVES,
  intersectMoves,
  mergeUrgesIntoAgenda,
  runtimeItemsForAgenda,
  uniqueMoves,
} from "./attention-agenda.js";
import type {
  AdvanceMaturationInput,
  AdvanceMaturationResult,
  AttentionReevaluationContext,
  AttentionReevaluationResult,
  AttentionSignalRefInput,
  AttentionSurfaceInvalidationInput,
  AttentionSurfaceInvalidationResult,
  ExpressionDecisionCreationInput,
  InhibitionDecisionInput,
  InitiativeGateSelectionInput,
  RuntimeAdmissionInput,
  SchedulerWakeReevaluationInput,
  SignalContextAssemblyInput,
  SurfaceDecisionInvalidationInput,
  SurfaceDecisionInvalidationRecord,
  SurfaceDecisionInvalidationResult,
  SurfaceDecisionReadmissionCheckKind,
  SurfaceDecisionRender,
  SurfaceDecisionRenderInput,
  UrgeCandidateAssemblyInput,
} from "./attention-metabolism-types.js";
export {
  mergeUrgesIntoAgenda,
  projectClustersToAgenda,
  runtimeItemsForAgenda,
} from "./attention-agenda.js";
export type {
  MergeUrgesIntoAgendaInput,
} from "./attention-agenda.js";
import {
  missingRequiredRefs,
  ref,
  refKey,
  sourceRef,
  stableId,
  uniqueBy,
  uniqueRefs,
  uniqueSourceRefs,
} from "./attention-refs.js";
import { deriveAttentionScopeFromSignalContext } from "./attention-scope.js";
import {
  AgentAgendaItemSchema,
  AutonomyCheckSchema,
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
  type AttentionMaturation,
  type AttentionMaturationState,
  type AttentionMaturationTransitionCause,
  type AttentionRevisitCondition,
  type AttentionRiskAssessment,
  type AutonomyCheck,
  type CompanionAutonomyRef,
  type CompanionAutonomySourceRef,
  type CompanionStateEffect,
  type ExpressionDecision,
  type ExpressionDecisionStatus,
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
  type SurfaceFacingOutcomeClass,
  type UrgeCandidate,
  type VisibilityPolicy,
} from "../types/companion-autonomy.js";

export { ref, sourceRef } from "./attention-refs.js";
export type {
  AdvanceMaturationInput,
  AdvanceMaturationResult,
  AttentionReevaluationContext,
  AttentionReevaluationPort,
  AttentionReevaluationResult,
  AttentionSignalRefInput,
  AttentionSurfaceInvalidationInput,
  AttentionSurfaceInvalidationResult,
  ExpressionDecisionCreationInput,
  InhibitionDecisionInput,
  InitiativeGateSelectionInput,
  RuntimeAdmissionInput,
  SchedulerWakeReevaluationInput,
  SignalContextAssemblyInput,
  SurfaceDecisionInvalidationInput,
  SurfaceDecisionInvalidationRecord,
  SurfaceDecisionInvalidationResult,
  SurfaceDecisionReadmissionCheckKind,
  SurfaceDecisionRender,
  SurfaceDecisionRenderInput,
  SurfaceExpressionInvalidationDisposition,
  SurfaceOutcomeInvalidationDisposition,
  UrgeCandidateAssemblyInput,
} from "./attention-metabolism-types.js";

const SURFACE_DECISION_READMISSION_CHECK_KINDS = [
  "surface",
  "permission",
  "staleness",
  "companion_state",
  "runtime_control",
  "visibility",
] as const satisfies readonly AutonomyCheck["kind"][];

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
  const scope = input.scope ?? deriveAttentionScopeFromSignalContext({
    signalContext: input.signal_context,
    policyEpoch: input.policyEpoch,
    sensitivity: input.sensitivity,
  });
  const signalRefs = uniqueSourceRefs(input.signalRefs ?? evidenceRefs);
  const structuredRefs = input.structuredRefs ?? [
    { ref: input.target, relation: "about", strength: 1 },
    ...input.signal_context.current_goal_refs.map((goalRef) => ({ ref: goalRef, relation: "about" as const, strength: 0.8 })),
    ...input.signal_context.runtime_state_refs.map((runtimeRef) => ({ ref: runtimeRef, relation: "caused_by" as const, strength: 0.7 })),
  ];

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
    scope,
    signalRefs,
    structuredRefs,
    semanticFingerprint: input.semanticFingerprint ?? null,
    semanticProviderId: input.semanticProviderId ?? null,
    semanticProviderVersion: input.semanticProviderVersion ?? null,
    sourceDiversity: {
      sourceKinds: unique(input.signal_context.signal_sources),
      independentSourceCount: signalRefs.length,
      repeatedSourceCount: Math.max(0, evidenceRefs.length - signalRefs.length),
    },
    stalenessSnapshot: {
      state: input.signal_context.stale_target_context.needs_regrounding_refs.length > 0
        ? "needs_regrounding"
        : input.signal_context.stale_target_context.stale_refs.length > 0
          ? "stale"
          : "fresh",
      observedAt: input.signal_context.assembled_at,
      sourceHighWatermark: input.signal_context.signal_context_id,
      reason: input.signal_context.stale_target_context.needs_regrounding_refs.length > 0
        ? "signal context requested regrounding"
        : input.signal_context.stale_target_context.stale_refs.length > 0
          ? "signal context carries stale refs"
          : "signal context is current for this attention cycle",
    },
    evidenceStrength: input.evidenceStrength ?? (
      input.strength >= 0.75 && signalRefs.length > 1 ? "strong" : input.strength >= 0.45 ? "moderate" : "weak"
    ),
    uncertainty: input.uncertainty ?? Number((1 - input.confidence).toFixed(4)),
    conflictMarkers: [],
    policyEpoch: scope.policyEpoch,
    priority_evidence: input.priority_evidence,
    modelOrClassifierVersion: input.modelOrClassifierVersion ?? null,
    replayableInputRefs: input.replayableInputRefs ?? [ref("signal_context", input.signal_context.signal_context_id)],
    audit_refs: input.audit_refs ?? [],
  });
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
      visibility_checks: input.visibility_checks ?? [],
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
      visibility_checks: input.visibility_checks ?? [],
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
      visibility_checks: input.visibility_checks ?? [],
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
      visibility_checks: input.visibility_checks ?? [],
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
      visibility_checks: input.visibility_checks ?? [],
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
    visibility_checks: input.visibility_checks ?? [],
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

export function applySurfaceInvalidationToDecisions(
  input: SurfaceDecisionInvalidationInput
): SurfaceDecisionInvalidationResult {
  const event = SurfaceInvalidationEventSchema.parse(input.surface_invalidation_event);
  const invalidatedSurfaceRef = ref("surface", event.surface_ref);
  const invalidationCheck = surfaceInvalidationStalenessCheck(event);
  const invalidationAuditRef = ref("audit_trace", event.audit_ref);
  const auditRefs = uniqueRefs([...(input.audit_refs ?? []), invalidationAuditRef]);
  const visibilityPolicies = (input.visibility_policies ?? []).map((policy) =>
    VisibilityPolicySchema.parse(policy)
  );

  const invalidatedOutcomes = (input.outcome_decisions ?? [])
    .map((decision) => OutcomeDecisionSchema.parse(decision))
    .filter((decision) => outcomeUsesInvalidatedSurface(decision, event))
    .map((decision) =>
      invalidateOutcomeDecisionAfterSurfaceEvent({
        decision,
        event,
        invalidation_check: invalidationCheck,
        current_surface_ref: input.current_surface_ref ?? null,
        readmission_checks: input.readmission_checks_by_outcome_id?.[decision.outcome_decision_id] ?? [],
        visibility_policies: visibilityPolicies,
        now: input.now,
        audit_refs: auditRefs,
      })
    );
  const invalidatedOutcomeById = new Map(
    invalidatedOutcomes.map((record) => [record.decision.outcome_decision_id, record])
  );

  const allOutcomesById = new Map<string, OutcomeDecision>();
  for (const decision of input.outcome_decisions ?? []) {
    const parsed = OutcomeDecisionSchema.parse(decision);
    allOutcomesById.set(parsed.outcome_decision_id, invalidatedOutcomeById.get(parsed.outcome_decision_id)?.decision ?? parsed);
  }

  const invalidatedExpressions = (input.expression_decisions ?? [])
    .map((decision) => ExpressionDecisionSchema.parse(decision))
    .filter((decision) => expressionUsesInvalidatedSurface(decision, event, invalidatedOutcomeById))
    .map((decision) =>
      invalidateExpressionDecisionAfterSurfaceEvent({
        decision,
        linked_outcome: allOutcomesById.get(decision.outcome_decision_ref.id) ?? null,
        event,
        current_surface_ref: input.current_surface_ref ?? null,
        readmission_checks: input.readmission_checks_by_expression_id?.[decision.expression_decision_id]
          ?? input.readmission_checks_by_outcome_id?.[decision.outcome_decision_ref.id]
          ?? [],
        visibility_policies: visibilityPolicies,
        now: input.now,
        audit_refs: auditRefs,
      })
    );

  return {
    surface_ref: invalidatedSurfaceRef,
    invalidation_check: invalidationCheck,
    invalidated_outcome_decisions: invalidatedOutcomes,
    invalidated_expression_decisions: invalidatedExpressions,
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
  if (
    outcome.admission_status !== "admitted" &&
    outcome.admission_status !== "downgraded"
  ) {
    return null;
  }
  if (!outcome.final_outcome) return null;
  if (!input.expression_decision) return null;

  const expression = ExpressionDecisionSchema.parse(input.expression_decision);
  if (expression.decision_status !== "active") return null;
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
  if (!visibilityPolicyAllowsExpressionSurface(visibilityPolicy, input.surface_class)) return null;

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

function risk(level: AttentionRiskAssessment["level"], reason: string): AttentionRiskAssessment {
  return {
    level,
    reason,
    evidence_refs: [],
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

function visibilityPolicyAllowsExpressionSurface(
  policy: VisibilityPolicy,
  surfaceClass: ExpressionSurfaceClass
): boolean {
  const decision = renderVisibilityPolicyForSurface(
    policy,
    companionVisibilitySurfaceForExpressionSurface(surfaceClass)
  );
  return decision.visible && !decision.redacted;
}

function companionVisibilitySurfaceForExpressionSurface(
  surfaceClass: ExpressionSurfaceClass
): CompanionVisibilitySurface {
  switch (surfaceClass) {
    case "notification":
      return "gateway";
    case "chat":
    case "tui":
    case "cli":
    case "digest":
    case "daemon_snapshot":
    case "gui":
    case "gateway":
      return surfaceClass;
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

type SurfaceDecisionReadmissionEvaluation = {
  checks: AutonomyCheck[];
  missing_check_kinds: SurfaceDecisionReadmissionCheckKind[];
  failed_check_kinds: SurfaceDecisionReadmissionCheckKind[];
  visibility_policy?: VisibilityPolicy;
  can_readmit: boolean;
};

function invalidateOutcomeDecisionAfterSurfaceEvent(input: {
  decision: OutcomeDecision;
  event: SurfaceInvalidationEvent;
  invalidation_check: AutonomyCheck;
  current_surface_ref: CompanionAutonomyRef | null;
  readmission_checks: AutonomyCheck[];
  visibility_policies: VisibilityPolicy[];
  now: string;
  audit_refs: CompanionAutonomyRef[];
}): SurfaceDecisionInvalidationRecord<OutcomeDecision> {
  const evaluation = evaluateSurfaceDecisionReadmission({
    event: input.event,
    current_surface_ref: input.current_surface_ref,
    readmission_checks: input.readmission_checks,
    visibility_policies: input.visibility_policies,
    outcome_decision: input.decision,
  });
  const finalOutcome = input.decision.final_outcome ?? input.decision.requested_outcome;
  const invalidationEvidence = surfaceInvalidationEvidenceRef(input.event);
  const auditRef = input.audit_refs[0] ?? ref("audit_trace", input.event.audit_ref);

  if (evaluation.can_readmit && outcomeActionAllowsReadmission(input.event.action)) {
    const readmitted = OutcomeDecisionSchema.parse({
      ...input.decision,
      decided_at: input.now,
      admission_status: "admitted",
      final_outcome: finalOutcome,
      expression_decision_ref: undefined,
      downgrade_or_rejection_reason: undefined,
      visibility_policy_ref: visibilityPolicyRefForReadmission(evaluation.visibility_policy, input.decision, finalOutcome),
      authority_checks: uniqueChecks([
        ...input.decision.authority_checks,
        ...checksOfKinds(evaluation.checks, ["permission", "runtime_control"]),
      ]),
      staleness_checks: uniqueChecks([
        ...input.decision.staleness_checks,
        input.invalidation_check,
        ...checksOfKinds(evaluation.checks, ["surface", "staleness"]),
      ]),
      companion_control_checks: uniqueChecks([
        ...input.decision.companion_control_checks,
        ...checksOfKinds(evaluation.checks, ["companion_state"]),
      ]),
      visibility_checks: uniqueChecks([
        ...input.decision.visibility_checks,
        ...checksOfKinds(evaluation.checks, ["visibility"]),
      ]),
      audit_ref: auditRef,
    });

    return {
      original_ref: ref("outcome_decision", input.decision.outcome_decision_id),
      disposition: "readmitted",
      decision: readmitted,
      missing_check_kinds: [],
      failed_check_kinds: [],
      audit_refs: input.audit_refs,
    };
  }

  const admissionStatus = outcomeAdmissionStatusForInvalidationAction(input.event.action);
  const invalidated = OutcomeDecisionSchema.parse({
    ...input.decision,
    decided_at: input.now,
    admission_status: admissionStatus,
    final_outcome: undefined,
    expression_decision_ref: undefined,
    visibility_policy_ref: undefined,
    authority_checks: uniqueChecks([
      ...input.decision.authority_checks,
      ...checksOfKinds(evaluation.checks, ["permission", "runtime_control"]),
    ]),
    staleness_checks: uniqueChecks([
      ...input.decision.staleness_checks,
      input.invalidation_check,
      ...checksOfKinds(evaluation.checks, ["surface", "staleness"]),
    ]),
    companion_control_checks: uniqueChecks([
      ...input.decision.companion_control_checks,
      ...checksOfKinds(evaluation.checks, ["companion_state"]),
    ]),
    visibility_checks: uniqueChecks([
      ...input.decision.visibility_checks,
      ...checksOfKinds(evaluation.checks, ["visibility"]),
    ]),
    safety_checks: input.decision.safety_checks,
    downgrade_or_rejection_reason: {
      code: "invalid_surface",
      detail: outcomeInvalidationReason(input.event, evaluation),
      evidence_refs: [invalidationEvidence],
    },
    audit_ref: auditRef,
  });

  return {
    original_ref: ref("outcome_decision", input.decision.outcome_decision_id),
    disposition: admissionStatus === "expired"
      ? "expired"
      : admissionStatus === "rejected"
        ? "rejected"
        : "needs_readmission",
    decision: invalidated,
    missing_check_kinds: evaluation.missing_check_kinds,
    failed_check_kinds: evaluation.failed_check_kinds,
    audit_refs: input.audit_refs,
  };
}

function invalidateExpressionDecisionAfterSurfaceEvent(input: {
  decision: ExpressionDecision;
  linked_outcome: OutcomeDecision | null;
  event: SurfaceInvalidationEvent;
  current_surface_ref: CompanionAutonomyRef | null;
  readmission_checks: AutonomyCheck[];
  visibility_policies: VisibilityPolicy[];
  now: string;
  audit_refs: CompanionAutonomyRef[];
}): SurfaceDecisionInvalidationRecord<ExpressionDecision> {
  const evaluation = evaluateSurfaceDecisionReadmission({
    event: input.event,
    current_surface_ref: input.current_surface_ref,
    readmission_checks: input.readmission_checks,
    visibility_policies: input.visibility_policies,
    outcome_decision: input.linked_outcome,
    expression_decision: input.decision,
  });
  const auditRef = input.audit_refs[0] ?? ref("audit_trace", input.event.audit_ref);
  const canRegenerate = evaluation.can_readmit
    && expressionActionAllowsRegeneration(input.event.action)
    && input.linked_outcome !== null
    && outcomeIsRenderableForExpression(input.linked_outcome, input.decision)
    && evaluation.visibility_policy !== undefined;

  if (canRegenerate) {
    const regenerated = ExpressionDecisionSchema.parse({
      ...input.decision,
      expression_decision_id: `${input.decision.expression_decision_id}:regenerated:${stableId(input.event.id)}`,
      created_at: input.now,
      visibility_policy_ref: ref("visibility_policy", evaluation.visibility_policy!.visibility_policy_id),
      decision_status: "active",
      audit_ref: auditRef,
    });

    return {
      original_ref: ref("expression_decision", input.decision.expression_decision_id),
      disposition: "regenerated",
      decision: regenerated,
      missing_check_kinds: [],
      failed_check_kinds: [],
      audit_refs: input.audit_refs,
    };
  }

  const decisionStatus = expressionDecisionStatusForInvalidationAction(input.event.action);
  const invalidated = ExpressionDecisionSchema.parse({
    ...input.decision,
    decision_status: decisionStatus,
    suppressed_detail_refs: uniqueRefs([
      ...input.decision.suppressed_detail_refs,
      ref("surface", input.event.surface_ref),
      ref("audit_trace", input.event.audit_ref),
    ]),
    audit_ref: auditRef,
  });

  return {
    original_ref: ref("expression_decision", input.decision.expression_decision_id),
    disposition: decisionStatus === "withdrawn" ? "withdrawn" : "held",
    decision: invalidated,
    missing_check_kinds: evaluation.missing_check_kinds,
    failed_check_kinds: evaluation.failed_check_kinds,
    audit_refs: input.audit_refs,
  };
}

function evaluateSurfaceDecisionReadmission(input: {
  event: SurfaceInvalidationEvent;
  current_surface_ref: CompanionAutonomyRef | null;
  readmission_checks: AutonomyCheck[];
  visibility_policies: VisibilityPolicy[];
  outcome_decision: OutcomeDecision | null;
  expression_decision?: ExpressionDecision;
}): SurfaceDecisionReadmissionEvaluation {
  const checks = uniqueChecks(input.readmission_checks.map((check) => AutonomyCheckSchema.parse(check)));
  const requiredKinds = requiredSurfaceDecisionReadmissionCheckKinds(input.event);
  const presentKinds = new Set(checks.map((check) => check.kind));
  const missingKinds = requiredKinds.filter((kind) => !presentKinds.has(kind));
  const failedKinds = checks
    .filter((check) =>
      requiredKinds.includes(check.kind as SurfaceDecisionReadmissionCheckKind)
      && (check.status === "failed" || check.status === "unknown")
    )
    .map((check) => check.kind);

  if (
    !input.current_surface_ref ||
    input.current_surface_ref.kind !== "surface" ||
    input.current_surface_ref.id === input.event.surface_ref
  ) {
    failedKinds.push("surface");
  }

  const visibilityPolicy = findCurrentVisibilityPolicy(
    input.visibility_policies,
    input.outcome_decision,
    input.expression_decision
  );
  const needsPolicy = input.expression_decision !== undefined
    || (input.outcome_decision !== null && outcomeNeedsVisibilityPolicy(input.outcome_decision));
  if (needsPolicy && !visibilityPolicy) {
    missingKinds.push("visibility");
  } else if (
    visibilityPolicy &&
    !visibilityPolicyCurrentlyAllowsDecision(visibilityPolicy, input.outcome_decision, input.expression_decision)
  ) {
    failedKinds.push("visibility");
  }

  const missing_check_kinds = uniqueRequiredReadmissionKinds(missingKinds, requiredKinds);
  const failed_check_kinds = uniqueRequiredReadmissionKinds(failedKinds, requiredKinds);
  return {
    checks,
    missing_check_kinds,
    failed_check_kinds,
    visibility_policy: visibilityPolicy,
    can_readmit: missing_check_kinds.length === 0 && failed_check_kinds.length === 0,
  };
}

function outcomeUsesInvalidatedSurface(decision: OutcomeDecision, event: SurfaceInvalidationEvent): boolean {
  return event.affected_dependencies.some((dependency) =>
    dependency.kind === "outcome_decision" && dependency.ref === decision.outcome_decision_id
  ) || decision.staleness_checks.some((check) =>
    check.evidence_refs.some((evidence) => sourceEvidenceMatchesInvalidation(evidence, event))
  );
}

function expressionUsesInvalidatedSurface(
  decision: ExpressionDecision,
  event: SurfaceInvalidationEvent,
  invalidatedOutcomeById: Map<string, SurfaceDecisionInvalidationRecord<OutcomeDecision>>
): boolean {
  return event.affected_dependencies.some((dependency) =>
    dependency.kind === "expression_decision" && dependency.ref === decision.expression_decision_id
  ) || invalidatedOutcomeById.has(decision.outcome_decision_ref.id)
    || decision.suppressed_detail_refs.some((candidate) =>
      (candidate.kind === "surface" && candidate.id === event.surface_ref)
      || (candidate.kind === "memory" && candidate.id === event.source_ref.memory_id)
    );
}

function outcomeAdmissionStatusForInvalidationAction(action: SurfaceInvalidationAction): OutcomeAdmissionStatus {
  switch (action) {
    case "expire":
      return "expired";
    case "reject":
    case "redact":
      return "rejected";
    case "hold":
    case "regate":
    case "withdraw":
    case "needs_review":
      return "held";
  }
}

function outcomeActionAllowsReadmission(action: SurfaceInvalidationAction): boolean {
  return action === "hold" || action === "regate" || action === "needs_review";
}

function expressionDecisionStatusForInvalidationAction(action: SurfaceInvalidationAction): ExpressionDecisionStatus {
  switch (action) {
    case "expire":
    case "reject":
    case "redact":
    case "withdraw":
      return "withdrawn";
    case "hold":
    case "regate":
    case "needs_review":
      return "held";
  }
}

function expressionActionAllowsRegeneration(action: SurfaceInvalidationAction): boolean {
  return action === "hold" || action === "regate" || action === "needs_review";
}

function outcomeInvalidationReason(
  event: SurfaceInvalidationEvent,
  evaluation: SurfaceDecisionReadmissionEvaluation
): string {
  const missing = evaluation.missing_check_kinds.length > 0
    ? ` missing rechecks: ${evaluation.missing_check_kinds.join(", ")}.`
    : "";
  const failed = evaluation.failed_check_kinds.length > 0
    ? ` failed rechecks: ${evaluation.failed_check_kinds.join(", ")}.`
    : "";
  return `Surface ${event.surface_ref} was invalidated by ${event.trigger}; outcome requires re-admission.${missing}${failed}`.trim();
}

function findCurrentVisibilityPolicy(
  policies: readonly VisibilityPolicy[],
  outcome: OutcomeDecision | null,
  expression?: ExpressionDecision
): VisibilityPolicy | undefined {
  const outcomeRef = outcome ? ref("outcome_decision", outcome.outcome_decision_id) : null;
  const expressionRef = expression ? ref("expression_decision", expression.expression_decision_id) : null;
  const expectedPolicyRef = expression?.visibility_policy_ref ?? outcome?.visibility_policy_ref;
  if (!expectedPolicyRef) return undefined;

  return policies.find((policy) =>
    policy.visibility_policy_id === expectedPolicyRef.id &&
    policy.applies_to.some((candidate) =>
      (outcomeRef && refKey(candidate) === refKey(outcomeRef))
      || (expressionRef && refKey(candidate) === refKey(expressionRef))
    )
  );
}

function visibilityPolicyCurrentlyAllowsDecision(
  policy: VisibilityPolicy,
  outcome: OutcomeDecision | null,
  expression?: ExpressionDecision
): boolean {
  if (policy.redaction_required || policy.content_lifecycle !== "active") return false;
  if (expression) {
    const outcomeRef = outcome ? ref("outcome_decision", outcome.outcome_decision_id) : expression.outcome_decision_ref;
    const expressionRef = ref("expression_decision", expression.expression_decision_id);
    return visibilityPolicyAppliesToDecision(policy, outcomeRef, expressionRef)
      && expression.target_surface_classes.some((surfaceClass) =>
        visibilityPolicyAllowsExpressionSurface(policy, surfaceClass)
      );
  }

  if (!outcome) return false;
  const outcomeRef = ref("outcome_decision", outcome.outcome_decision_id);
  return policy.applies_to.some((candidate) => refKey(candidate) === refKey(outcomeRef));
}

function outcomeNeedsVisibilityPolicy(outcome: OutcomeDecision): boolean {
  const finalOutcome = outcome.final_outcome ?? outcome.requested_outcome;
  return SurfaceFacingOutcomeClassSchema.safeParse(finalOutcome).success;
}

function visibilityPolicyRefForReadmission(
  policy: VisibilityPolicy | undefined,
  decision: OutcomeDecision,
  finalOutcome: OutcomeClass
): CompanionAutonomyRef | undefined {
  if (policy) return ref("visibility_policy", policy.visibility_policy_id);
  if (SurfaceFacingOutcomeClassSchema.safeParse(finalOutcome).success) return undefined;
  return decision.visibility_policy_ref;
}

function outcomeIsRenderableForExpression(outcome: OutcomeDecision, expression: ExpressionDecision): boolean {
  return (outcome.admission_status === "admitted" || outcome.admission_status === "downgraded")
    && outcome.final_outcome === expression.outcome_class
    && !!outcome.visibility_policy_ref
    && refKey(outcome.visibility_policy_ref) === refKey(expression.visibility_policy_ref);
}

function checksOfKinds(
  checks: readonly AutonomyCheck[],
  kinds: readonly AutonomyCheck["kind"][]
): AutonomyCheck[] {
  return checks.filter((check) => kinds.includes(check.kind));
}

function uniqueChecks(checks: readonly AutonomyCheck[]): AutonomyCheck[] {
  return uniqueBy(checks, (check) => check.check_id);
}

function uniqueRequiredReadmissionKinds(
  kinds: readonly AutonomyCheck["kind"][],
  requiredKinds: readonly SurfaceDecisionReadmissionCheckKind[]
): SurfaceDecisionReadmissionCheckKind[] {
  return unique(kinds.filter((kind): kind is SurfaceDecisionReadmissionCheckKind =>
    requiredKinds.includes(kind as SurfaceDecisionReadmissionCheckKind)
  ));
}

function requiredSurfaceDecisionReadmissionCheckKinds(
  event: SurfaceInvalidationEvent
): SurfaceDecisionReadmissionCheckKind[] {
  return unique([
    ...event.required_rechecks,
    ...SURFACE_DECISION_READMISSION_CHECK_KINDS,
  ]);
}

function unique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
