import type { z } from "zod/v3";
import type {
  SurfaceInvalidationEvent,
  SurfaceInvalidationEventSchema,
  SurfaceGateKind,
} from "../../grounding/surface-contracts.js";
import type {
  AgentAgendaItem,
  AttentionScope,
  AttentionSignalRef,
  AttentionStructuredRef,
  AttentionEvidenceStrength,
  AttentionMaturation,
  AttentionMaturationState,
  AttentionMaturationTransition,
  AttentionMaturationTransitionCause,
  AttentionMove,
  AttentionPriority,
  AttentionPriorityEvidence,
  AttentionRiskAssessment,
  AttentionSensitivity,
  AutonomyCheck,
  CompanionAutonomyContentLifecycle,
  CompanionAutonomyRef,
  CompanionAutonomySourceRef,
  ExpressionDecision,
  ExpressionMode,
  ExpressionSurfaceClass,
  InhibitionDecision,
  InitiativeGateDecision,
  OutcomeClass,
  OutcomeDecision,
  SignalContext,
  SignalSafetyContext,
  SignalSource,
  StaleTargetContext,
  SurfaceFacingOutcomeClass,
  TimingContext,
  UrgeCandidate,
  UrgeFeeling,
  UrgeOrigin,
  VisibilityPolicy,
} from "../types/companion-autonomy.js";
import type {
  CompanionStateSnapshot,
  RuntimeItem,
} from "../types/companion-state.js";

export type SurfaceDecisionReadmissionCheckKind =
  | SurfaceGateKind
  | "surface"
  | "permission"
  | "staleness"
  | "companion_state"
  | "runtime_control"
  | "visibility";

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
  scheduled_for?: string | null;
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
  scope?: AttentionScope;
  signalRefs?: AttentionSignalRef[];
  structuredRefs?: AttentionStructuredRef[];
  semanticFingerprint?: string | null;
  semanticProviderId?: string | null;
  semanticProviderVersion?: string | null;
  evidenceStrength?: AttentionEvidenceStrength;
  uncertainty?: number;
  policyEpoch?: string;
  priority_evidence?: AttentionPriorityEvidence;
  modelOrClassifierVersion?: string | null;
  replayableInputRefs?: CompanionAutonomyRef[];
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
  visibility_checks?: AutonomyCheck[];
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

export type SurfaceOutcomeInvalidationDisposition =
  | "expired"
  | "rejected"
  | "needs_readmission"
  | "readmitted";

export type SurfaceExpressionInvalidationDisposition =
  | "held"
  | "withdrawn"
  | "regenerated";

export type SurfaceDecisionInvalidationRecord<TDecision> = {
  original_ref: CompanionAutonomyRef;
  disposition: SurfaceOutcomeInvalidationDisposition | SurfaceExpressionInvalidationDisposition;
  decision: TDecision;
  missing_check_kinds: SurfaceDecisionReadmissionCheckKind[];
  failed_check_kinds: SurfaceDecisionReadmissionCheckKind[];
  audit_refs: CompanionAutonomyRef[];
};

export type SurfaceDecisionInvalidationInput = {
  surface_invalidation_event: SurfaceInvalidationEvent | z.input<typeof SurfaceInvalidationEventSchema>;
  outcome_decisions?: OutcomeDecision[];
  expression_decisions?: ExpressionDecision[];
  current_surface_ref?: CompanionAutonomyRef | null;
  readmission_checks_by_outcome_id?: Record<string, AutonomyCheck[]>;
  readmission_checks_by_expression_id?: Record<string, AutonomyCheck[]>;
  visibility_policies?: VisibilityPolicy[];
  now: string;
  audit_refs?: CompanionAutonomyRef[];
};

export type SurfaceDecisionInvalidationResult = {
  surface_ref: CompanionAutonomyRef;
  invalidation_check: AutonomyCheck;
  invalidated_outcome_decisions: Array<SurfaceDecisionInvalidationRecord<OutcomeDecision>>;
  invalidated_expression_decisions: Array<SurfaceDecisionInvalidationRecord<ExpressionDecision>>;
  audit_refs: CompanionAutonomyRef[];
};
