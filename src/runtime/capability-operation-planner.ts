import type { ScheduleEntry, ScheduleInternalAttentionProjection } from "./types/schedule.js";
import type { CapabilityReadinessSnapshot } from "../platform/observation/types/capability.js";
import {
  evaluateAdmissionPolicy,
  type AdmissionAuthState,
  type AdmissionPermissionGrantEvidenceInput,
  type AdmissionPolicyEvaluation,
  type AdmissionPolicySignal,
  type AdmissionSurfaceScopeInput,
} from "./control/admission-policy.js";
import {
  evaluateAutonomyDecision,
  type AutonomyCacheInvalidationEvidence,
  type AutonomyCompanionState,
  type AutonomyContextAuthorityEvidence,
  type AutonomyDecision,
  type AutonomyFeedbackSignal,
  type AutonomyPolicySignal,
  type AutonomyRuntimeControlState,
  type AutonomyTrustProfile,
  type AutonomyVerificationProfile,
} from "./control/autonomy-governor.js";
import {
  CapabilityOperationPlanAssemblySchema,
  type CapabilityOperationPlanAssembly,
  type CapabilityOperationPlanCandidateInput,
  type CapabilityOperationPlanSource,
} from "./types/capability-operation-plan.js";
import type { RuntimeControlActor } from "./store/runtime-operation-schemas.js";

const WAIT_RESUME_CAPABILITY_ID = "capability:schedule_wait_resume_attention";
const WAIT_RESUME_PAYLOAD_CLASS = "schedule_wait_resume_attention_projection";
const RESIDENT_DAEMON_SURFACE_REF = "surface:resident-daemon";

export type ResidentOperationPlanAction =
  | "sleep"
  | "suggest_goal"
  | "investigate"
  | "preemptive_check"
  | "peer_initiative"
  | "commitment"
  | "curiosity"
  | "curiosity_noop";

export interface ResidentAttentionOperationProjection {
  action: ResidentOperationPlanAction;
  source_kind: "resident_proactive_maintenance" | "resident_curiosity";
  attention_input_id: string;
  signal_context_id: string;
  urge_id: string;
  agenda_item_id: string;
  inhibition_decision_id: string;
  initiative_gate_decision_id: string;
  outcome_decision_id?: string;
  requested_outcome: string;
  admission_status: string;
  final_outcome?: string;
  branch_admitted: boolean;
}

export interface ResidentOperationPlanAssemblyInput {
  admission: ResidentAttentionOperationProjection;
  assembledAt: string;
  goalId?: string | null;
  details?: Record<string, unknown>;
  surfaceRef?: string | null;
}

export interface ResidentOperationBoundaryInput extends ResidentOperationPlanAssemblyInput {
  actor?: RuntimeControlActor;
  surface?: AdmissionSurfaceScopeInput;
  readinessSnapshots?: CapabilityReadinessSnapshot[];
  permissionGrants?: AdmissionPermissionGrantEvidenceInput[];
  relationshipPolicy?: AdmissionPolicySignal[];
  quietingPolicy?: AdmissionPolicySignal[];
  privacyPolicy?: AdmissionPolicySignal[];
  runtimeControlPolicy?: AdmissionPolicySignal[];
  notificationPolicy?: AdmissionPolicySignal[];
  authState?: AdmissionAuthState;
  runtimeControlState?: AutonomyRuntimeControlState;
  companionState?: AutonomyCompanionState;
  trustProfile?: AutonomyTrustProfile;
  verificationProfile?: AutonomyVerificationProfile;
  recentFeedback?: AutonomyFeedbackSignal[];
  contextAuthorityEvidence?: AutonomyContextAuthorityEvidence[];
  invalidationEvidence?: AutonomyCacheInvalidationEvidence[];
  autonomyRelationshipPolicy?: AutonomyPolicySignal[];
  autonomyQuietingPolicy?: AutonomyPolicySignal[];
  autonomyPrivacyContext?: AutonomyPolicySignal[];
  autonomyGuardrailState?: AutonomyPolicySignal[];
  autonomyBackpressureState?: AutonomyPolicySignal[];
}

export interface ResidentOperationBoundaryResult {
  assembly: CapabilityOperationPlanAssembly;
  admission_evaluation?: AdmissionPolicyEvaluation;
  autonomy_decision?: AutonomyDecision;
  preparation_allowed: boolean;
  execution_allowed: boolean;
}

type ResidentPlanConfig = {
  capabilityId: string;
  operationIdPrefix: string;
  operationKind: "hint" | "prepare" | "read" | "send" | "write" | "mutate";
  providerRef: string;
  payloadClass: string;
  sideEffectProfile: "none" | "read" | "send" | "write" | "mutate";
  riskClass: "low" | "medium";
  privacyProfile: "workspace_private" | "local_private" | "external_service";
  reversibility: "reversible" | "append_only" | "draft_only";
  advisoryOnly: boolean;
  preparableWhenBlocked: boolean;
  requiresRuntimeControl: boolean;
  requiredPermissionCapabilities: Array<"read_workspace" | "prepare_draft">;
  requiredApprovals: string[];
  externalActionAuthority: boolean;
  userVisibleSummary: string;
};

export interface ScheduleOperationPlanAssemblyInput {
  entry: ScheduleEntry;
  firedAt: string;
  scheduledFor?: string | null;
  projection?: ScheduleInternalAttentionProjection;
}

export function assembleScheduleOperationPlans(
  input: ScheduleOperationPlanAssemblyInput
): CapabilityOperationPlanAssembly {
  const sourceRef = `schedule:${input.entry.id}`;
  const source = {
    kind: "schedule_tick" as const,
    source_ref: sourceRef,
    source_epoch: input.entry.updated_at,
    emitted_at: input.firedAt,
    metadata: {
      entry_id: input.entry.id,
      layer: input.entry.layer,
      activation_kind: input.entry.metadata?.activation_kind ?? null,
    },
  };

  if (input.entry.metadata?.activation_kind !== "wait_resume") {
    return CapabilityOperationPlanAssemblySchema.parse({
      schema_version: "capability-operation-plan-assembly/v1",
      assembly_id: `operation-plan-assembly:schedule:${input.entry.id}:${input.firedAt}`,
      assembled_at: input.firedAt,
      source,
      status: "no_supported_plan",
      reason: "Schedule entry is not a supported non-chat operation proposal source.",
      candidate_plans: [],
    });
  }

  const triggerGoalId = input.entry.goal_trigger?.goal_id;
  const metadataGoalId = input.entry.metadata.goal_id;
  if (!input.entry.goal_trigger || !triggerGoalId || !metadataGoalId || metadataGoalId !== triggerGoalId) {
    return failClosed(input, source, "Wait-resume schedule entry is missing a stable goal trigger context.");
  }
  if (!input.projection) {
    return failClosed(input, source, "Wait-resume schedule entry did not produce a structured attention projection.");
  }
  const expectedSignalContextId = `signal:schedule-wake:${input.entry.id}:${input.scheduledFor ?? input.firedAt}`;
  if (input.projection.signal_context_id !== expectedSignalContextId) {
    return failClosed(input, source, "Wait-resume attention projection does not match the schedule tick context.");
  }

  const operationId = `schedule.wait_resume.attention.${input.entry.id}`;
  const providerRef = sourceRef;
  const targetRefs = [
    `goal:${triggerGoalId}`,
    input.projection.signal_context_id,
    ...input.projection.urge_candidate_refs,
    ...input.projection.agenda_item_refs,
    ...input.projection.runtime_items.map((item) => item.ref),
  ];
  const candidate: CapabilityOperationPlanCandidateInput = {
    plan_id: `operation-plan:${operationId}:${input.firedAt}`,
    source_ref: sourceRef,
    operation_plan: {
      operation_id: operationId,
      capability_id: WAIT_RESUME_CAPABILITY_ID,
      operation_kind: "hint",
      provider_ref: providerRef,
      payload_class: WAIT_RESUME_PAYLOAD_CLASS,
      side_effect_profile: "none",
      risk_class: "low",
      privacy_profile: "workspace_private",
      reversibility: "reversible",
      external_action_authority: false,
      target_refs: targetRefs,
      advisory_only: true,
      preparable_when_blocked: true,
      local_only: true,
      inspectable: true,
      expected_user_visible_effect: false,
    },
    admission_scope: {
      operation_id: operationId,
      capability_id: WAIT_RESUME_CAPABILITY_ID,
      operation_kind: "hint",
      provider_ref: providerRef,
      asset_ref: providerRef,
      payload_class: WAIT_RESUME_PAYLOAD_CLASS,
      payload_epoch: input.projection.projected_at,
      side_effect_profile: "none",
      external_action_authority: false,
      requires_runtime_control: false,
      required_permission_capabilities: [],
      target_refs: targetRefs,
      target_epoch_refs: {
        [providerRef]: input.entry.updated_at,
        [input.projection.signal_context_id]: input.projection.projected_at,
      },
      provider_epoch: input.entry.updated_at,
    },
    readiness_snapshot_refs: [],
    required_approvals: [],
    reversible_preparation_steps: [
      "Record the attention projection as inspectable planning context.",
    ],
    not_allowed_steps: [
      "Do not run the goal from this planner output.",
      "Do not send external notifications from this planner output.",
      "Do not treat the attention projection as runtime-control admission.",
    ],
    user_visible_summary: "Wait-resume attention projection is available as a candidate planning hint; downstream gates decide any action.",
    audit_seed: {
      schedule_entry_id: input.entry.id,
      goal_id: triggerGoalId,
      signal_context_id: input.projection.signal_context_id,
      urge_candidate_refs: input.projection.urge_candidate_refs,
      agenda_item_refs: input.projection.agenda_item_refs,
      runtime_item_refs: input.projection.runtime_items.map((item) => item.ref),
    },
  };

  return CapabilityOperationPlanAssemblySchema.parse({
    schema_version: "capability-operation-plan-assembly/v1",
    assembly_id: `operation-plan-assembly:schedule:${input.entry.id}:${input.firedAt}`,
    assembled_at: input.firedAt,
    source,
    status: "planned",
    reason: "Wait-resume schedule attention projection assembled into an advisory candidate operation plan.",
    candidate_plans: [candidate],
  });
}

export function assembleResidentOperationPlans(
  input: ResidentOperationPlanAssemblyInput,
): CapabilityOperationPlanAssembly {
  const sourceRef = input.admission.outcome_decision_id
    ?? input.admission.agenda_item_id
    ?? input.admission.attention_input_id;
  const source = residentOperationPlanSource(input, sourceRef);
  const config = residentPlanConfig(input.admission.action, input.goalId ?? "", input.details);

  if (!config) {
    return CapabilityOperationPlanAssemblySchema.parse({
      schema_version: "capability-operation-plan-assembly/v1",
      assembly_id: residentOperationPlanAssemblyId(input, sourceRef),
      assembled_at: input.assembledAt,
      source,
      status: "no_supported_plan",
      reason: "Resident attention outcome does not require a capability operation plan.",
      candidate_plans: [],
    });
  }

  const failedReason = residentOperationPlanFailClosedReason(input, config);
  if (failedReason) {
    return CapabilityOperationPlanAssemblySchema.parse({
      schema_version: "capability-operation-plan-assembly/v1",
      assembly_id: residentOperationPlanAssemblyId(input, sourceRef),
      assembled_at: input.assembledAt,
      source,
      status: "fail_closed",
      reason: failedReason,
      candidate_plans: [],
    });
  }

  const operationId = `${config.operationIdPrefix}.${residentOperationPlanToken(sourceRef)}`;
  const targetRefs = residentOperationPlanTargetRefs(input);
  const providerRef = config.providerRef;
  const candidate: CapabilityOperationPlanCandidateInput = {
    plan_id: `operation-plan:${operationId}`,
    source_ref: sourceRef,
    operation_plan: {
      operation_id: operationId,
      capability_id: config.capabilityId,
      operation_kind: config.operationKind,
      provider_ref: providerRef,
      payload_class: config.payloadClass,
      side_effect_profile: config.sideEffectProfile,
      risk_class: config.riskClass,
      privacy_profile: config.privacyProfile,
      reversibility: config.reversibility,
      external_action_authority: config.externalActionAuthority,
      target_refs: targetRefs,
      advisory_only: config.advisoryOnly,
      preparable_when_blocked: config.preparableWhenBlocked,
      local_only: true,
      inspectable: true,
      expected_user_visible_effect: false,
    },
    admission_scope: {
      operation_id: operationId,
      capability_id: config.capabilityId,
      operation_kind: config.operationKind,
      provider_ref: providerRef,
      asset_ref: providerRef,
      payload_class: config.payloadClass,
      payload_epoch: input.admission.outcome_decision_id ?? input.admission.agenda_item_id,
      side_effect_profile: config.sideEffectProfile,
      external_action_authority: config.externalActionAuthority,
      requires_runtime_control: config.requiresRuntimeControl,
      required_permission_capabilities: config.requiredPermissionCapabilities,
      target_refs: targetRefs,
      target_epoch_refs: {
        [input.admission.attention_input_id]: input.admission.attention_input_id,
        [input.admission.agenda_item_id]: input.admission.agenda_item_id,
        ...(input.admission.outcome_decision_id
          ? { [input.admission.outcome_decision_id]: input.admission.outcome_decision_id }
          : {}),
      },
      provider_epoch: input.admission.source_kind,
    },
    readiness_snapshot_refs: [],
    required_approvals: config.requiredApprovals,
    reversible_preparation_steps: residentPreparationSteps(input.admission.action),
    not_allowed_steps: [
      "Do not start, resume, or finalize runtime work from this resident operation plan.",
      "Do not notify or speak from this resident operation plan.",
      "Do not infer initiation authority from Dream hints, notification routes, authenticated sessions, MCP enablement, or past success.",
      "Require a matching admission evaluation and autonomy decision before any executor or user-visible delivery path.",
    ],
    user_visible_summary: config.userVisibleSummary,
    audit_seed: {
      action: input.admission.action,
      attention_input_id: input.admission.attention_input_id,
      signal_context_id: input.admission.signal_context_id,
      agenda_item_id: input.admission.agenda_item_id,
      outcome_decision_id: input.admission.outcome_decision_id ?? null,
      goal_id: input.goalId ?? null,
      source_kind: input.admission.source_kind,
    },
  };

  return CapabilityOperationPlanAssemblySchema.parse({
    schema_version: "capability-operation-plan-assembly/v1",
    assembly_id: residentOperationPlanAssemblyId(input, sourceRef),
    assembled_at: input.assembledAt,
    source,
    status: "planned",
    reason: "Resident attention proposal assembled into a bounded candidate operation plan.",
    candidate_plans: [candidate],
  });
}

export function evaluateResidentOperationBoundary(
  input: ResidentOperationBoundaryInput,
): ResidentOperationBoundaryResult {
  const assembly = assembleResidentOperationPlans(input);
  const candidate = assembly.candidate_plans[0];
  if (!candidate) {
    return {
      assembly,
      preparation_allowed: false,
      execution_allowed: false,
    };
  }

  const actor = input.actor ?? {
    surface: "cli" as const,
    identity_key: "resident-daemon",
  };
  const surface = input.surface ?? {
    surface_ref: input.surfaceRef ?? RESIDENT_DAEMON_SURFACE_REF,
    channel: "daemon",
    platform: "resident",
    epoch: input.admission.outcome_decision_id ?? input.admission.agenda_item_id,
  };
  const evaluatedAt = input.assembledAt;
  const readinessSnapshots = input.readinessSnapshots ?? [];
  const admission = evaluateAdmissionPolicy({
    operation: candidate.admission_scope,
    actor,
    surface,
    authState: input.authState,
    readiness: readinessSnapshots.find((snapshot) =>
      snapshot.operation_id === candidate.operation_plan.operation_id
        && snapshot.capability_id === candidate.operation_plan.capability_id
        && snapshot.provider_ref === candidate.operation_plan.provider_ref
        && snapshot.payload_class === candidate.operation_plan.payload_class
    ),
    permissionGrants: input.permissionGrants ?? [],
    relationshipPolicy: input.relationshipPolicy ?? [],
    quietingPolicy: input.quietingPolicy ?? [],
    privacyPolicy: input.privacyPolicy ?? [],
    runtimeControlPolicy: input.runtimeControlPolicy ?? [],
    notificationPolicy: input.notificationPolicy ?? [],
    evaluatedAt,
    evaluationId: `admission:${candidate.operation_plan.operation_id}:${residentOperationPlanToken(surface.surface_ref)}`,
  });
  const autonomyDecision = evaluateAutonomyDecision({
    operation_plan: candidate.operation_plan,
    readiness_snapshots: readinessSnapshots,
    admission_evaluation: admission,
    user_directed: false,
    active_surface_ref: surface.surface_ref,
    auth_state: input.authState,
    relationship_permissions: input.autonomyRelationshipPolicy ?? [],
    quieting_policy: input.autonomyQuietingPolicy ?? [],
    privacy_context: input.autonomyPrivacyContext ?? [],
    runtime_control_state: input.runtimeControlState,
    companion_state: input.companionState,
    guardrail_state: input.autonomyGuardrailState ?? [],
    backpressure_state: input.autonomyBackpressureState ?? [],
    trust_profile: input.trustProfile,
    verification_profile: input.verificationProfile,
    recent_feedback: input.recentFeedback ?? [],
    context_authority_evidence: input.contextAuthorityEvidence ?? [],
    invalidation_evidence: input.invalidationEvidence ?? [],
    blast_radius: candidate.operation_plan.side_effect_profile === "read" ? "workspace" : "local",
    privacy_sensitivity: candidate.operation_plan.privacy_profile === "local_private" ? "low" : "medium",
    evaluated_at: evaluatedAt,
    decision_id: `autonomy:${candidate.operation_plan.operation_id}:${residentOperationPlanToken(admission.evaluation_id)}`,
  });

  return {
    assembly,
    admission_evaluation: admission,
    autonomy_decision: autonomyDecision,
    preparation_allowed: autonomyDecision.allowed_steps.includes("prepare")
      || autonomyDecision.allowed_steps.includes("advise"),
    execution_allowed: autonomyDecision.allowed_steps.some((step) => step.includes("execute")),
  };
}

export function residentOperationBoundaryActivityMetadata(
  boundary: ResidentOperationBoundaryResult,
): {
  operation_plan_assembly_id: string;
  operation_plan_status: CapabilityOperationPlanAssembly["status"];
  operation_plan_reason: string;
  operation_plan_id?: string;
  operation_admission_evaluation_id?: string;
  autonomy_decision_id?: string;
  autonomy_decision_level?: AutonomyDecision["level"];
  operation_preparation_allowed: boolean;
  operation_execution_allowed: boolean;
} {
  const candidate = boundary.assembly.candidate_plans[0];
  return {
    operation_plan_assembly_id: boundary.assembly.assembly_id,
    operation_plan_status: boundary.assembly.status,
    operation_plan_reason: boundary.assembly.reason,
    ...(candidate ? { operation_plan_id: candidate.plan_id } : {}),
    ...(boundary.admission_evaluation
      ? { operation_admission_evaluation_id: boundary.admission_evaluation.evaluation_id }
      : {}),
    ...(boundary.autonomy_decision
      ? {
          autonomy_decision_id: boundary.autonomy_decision.decision_id,
          autonomy_decision_level: boundary.autonomy_decision.level,
        }
      : {}),
    operation_preparation_allowed: boundary.preparation_allowed,
    operation_execution_allowed: boundary.execution_allowed,
  };
}

function failClosed(
  input: ScheduleOperationPlanAssemblyInput,
  source: CapabilityOperationPlanSource,
  reason: string
): CapabilityOperationPlanAssembly {
  return CapabilityOperationPlanAssemblySchema.parse({
    schema_version: "capability-operation-plan-assembly/v1",
    assembly_id: `operation-plan-assembly:schedule:${input.entry.id}:${input.firedAt}`,
    assembled_at: input.firedAt,
    source,
    status: "fail_closed",
    reason,
    candidate_plans: [],
  });
}

function residentOperationPlanSource(
  input: ResidentOperationPlanAssemblyInput,
  sourceRef: string,
): CapabilityOperationPlanSource {
  return {
    kind: "attention_projection",
    source_ref: sourceRef,
    source_epoch: input.admission.outcome_decision_id ?? input.admission.agenda_item_id,
    emitted_at: input.assembledAt,
    metadata: {
      action: input.admission.action,
      source_kind: input.admission.source_kind,
      attention_input_id: input.admission.attention_input_id,
      signal_context_id: input.admission.signal_context_id,
      agenda_item_id: input.admission.agenda_item_id,
      outcome_decision_id: input.admission.outcome_decision_id ?? null,
      goal_id: input.goalId ?? null,
    },
  };
}

function residentPlanConfig(
  action: ResidentOperationPlanAction,
  goalId: string,
  details?: Record<string, unknown>,
): ResidentPlanConfig | null {
  switch (action) {
    case "suggest_goal":
      return {
        capabilityId: "capability:resident_goal_suggestion_preparation",
        operationIdPrefix: "resident.goal_suggestion.prepare",
        operationKind: "prepare",
        providerRef: "resident:goal-negotiator",
        payloadClass: "resident.goal_suggestion",
        sideEffectProfile: "write",
        riskClass: "low",
        privacyProfile: "workspace_private",
        reversibility: "draft_only",
        advisoryOnly: false,
        preparableWhenBlocked: true,
        requiresRuntimeControl: false,
        requiredPermissionCapabilities: [],
        requiredApprovals: [],
        externalActionAuthority: false,
        userVisibleSummary: "Resident goal suggestion may prepare a local draft only; downstream gates decide whether to ask or act.",
      };
    case "investigate":
    case "curiosity":
      return {
        capabilityId: "capability:resident_curiosity_preparation",
        operationIdPrefix: "resident.curiosity.prepare",
        operationKind: "prepare",
        providerRef: "resident:curiosity-engine",
        payloadClass: "resident.curiosity_proposal",
        sideEffectProfile: "write",
        riskClass: "low",
        privacyProfile: "workspace_private",
        reversibility: "draft_only",
        advisoryOnly: false,
        preparableWhenBlocked: true,
        requiresRuntimeControl: false,
        requiredPermissionCapabilities: [],
        requiredApprovals: [],
        externalActionAuthority: false,
        userVisibleSummary: "Resident curiosity may prepare an inspectable proposal only; it cannot start work or notify.",
      };
    case "preemptive_check":
      return {
        capabilityId: "capability:resident_preemptive_check_preparation",
        operationIdPrefix: "resident.preemptive_check.prepare",
        operationKind: "read",
        providerRef: "resident:preemptive-check",
        payloadClass: "resident.preemptive_check",
        sideEffectProfile: "read",
        riskClass: "medium",
        privacyProfile: "workspace_private",
        reversibility: "reversible",
        advisoryOnly: false,
        preparableWhenBlocked: true,
        requiresRuntimeControl: true,
        requiredPermissionCapabilities: ["read_workspace"],
        requiredApprovals: [`runtime-control:resident-preemptive-check:${goalId || "unknown"}`],
        externalActionAuthority: false,
        userVisibleSummary: "Resident preemptive check is only a prepared read candidate until runtime-control admission is granted.",
      };
    case "peer_initiative":
      return residentPeerInitiativePlanConfig(details, goalId);
    case "commitment":
      return residentCommitmentPlanConfig(details);
    case "sleep":
    case "curiosity_noop":
      return null;
  }
}

function residentCommitmentPlanConfig(details: Record<string, unknown> | undefined): ResidentPlanConfig {
  const family = commitmentOperationFamily(details);
  switch (family) {
    case "attention.commitment.watch":
      return {
        capabilityId: "capability:attention_commitment_watch",
        operationIdPrefix: "attention.commitment.watch",
        operationKind: "hint",
        providerRef: "attention:commitment-operation-adapter",
        payloadClass: "attention.commitment.watch",
        sideEffectProfile: "none",
        riskClass: "low",
        privacyProfile: "local_private",
        reversibility: "reversible",
        advisoryOnly: true,
        preparableWhenBlocked: true,
        requiresRuntimeControl: false,
        requiredPermissionCapabilities: [],
        requiredApprovals: [],
        externalActionAuthority: false,
        userVisibleSummary: "Commitment watch remains trace-only and cannot notify or write memory.",
      };
    case "attention.commitment.prepare_followup":
      return {
        capabilityId: "capability:attention_commitment_prepare_followup",
        operationIdPrefix: "attention.commitment.prepare_followup",
        operationKind: "prepare",
        providerRef: "attention:commitment-operation-adapter",
        payloadClass: "attention.commitment.prepare_followup",
        sideEffectProfile: "write",
        riskClass: "low",
        privacyProfile: "local_private",
        reversibility: "draft_only",
        advisoryOnly: false,
        preparableWhenBlocked: true,
        requiresRuntimeControl: false,
        requiredPermissionCapabilities: [],
        requiredApprovals: [],
        externalActionAuthority: false,
        userVisibleSummary: "Commitment follow-up may prepare a local reminder or follow-up candidate only.",
      };
    case "attention.commitment.digest":
      return {
        capabilityId: "capability:attention_commitment_digest",
        operationIdPrefix: "attention.commitment.digest",
        operationKind: "hint",
        providerRef: "attention:commitment-operation-adapter",
        payloadClass: "attention.commitment.digest",
        sideEffectProfile: "none",
        riskClass: "low",
        privacyProfile: "local_private",
        reversibility: "reversible",
        advisoryOnly: true,
        preparableWhenBlocked: true,
        requiresRuntimeControl: false,
        requiredPermissionCapabilities: [],
        requiredApprovals: [],
        externalActionAuthority: false,
        userVisibleSummary: "Commitment digest may add a low-pressure digest candidate after attention gates allow it.",
      };
    case "attention.commitment.ask_if_still_relevant":
      return {
        capabilityId: "capability:attention_commitment_ask_relevance",
        operationIdPrefix: "attention.commitment.ask_if_still_relevant",
        operationKind: "hint",
        providerRef: "attention:commitment-operation-adapter",
        payloadClass: "attention.commitment.ask_if_still_relevant",
        sideEffectProfile: "none",
        riskClass: "low",
        privacyProfile: "local_private",
        reversibility: "reversible",
        advisoryOnly: true,
        preparableWhenBlocked: true,
        requiresRuntimeControl: false,
        requiredPermissionCapabilities: [],
        requiredApprovals: [],
        externalActionAuthority: false,
        userVisibleSummary: "Commitment relevance check may only prepare a low-pressure ask candidate after boundary gates allow it.",
      };
    case "attention.unresolved_decision.prepare_options":
    case "attention.capability_fit.prepare_once":
      return {
        capabilityId: "capability:attention_commitment_prepare_once",
        operationIdPrefix: family,
        operationKind: "prepare",
        providerRef: "attention:commitment-operation-adapter",
        payloadClass: family,
        sideEffectProfile: "write",
        riskClass: "low",
        privacyProfile: "local_private",
        reversibility: "draft_only",
        advisoryOnly: false,
        preparableWhenBlocked: true,
        requiresRuntimeControl: false,
        requiredPermissionCapabilities: [],
        requiredApprovals: [],
        externalActionAuthority: false,
        userVisibleSummary: "Attention may prepare a one-time local option or capability-fit artifact without execution authority.",
      };
    case "attention.memory_conflict.ask_correction":
      return {
        capabilityId: "capability:attention_memory_conflict_ask_correction",
        operationIdPrefix: "attention.memory_conflict.ask_correction",
        operationKind: "hint",
        providerRef: "attention:commitment-operation-adapter",
        payloadClass: "attention.memory_conflict.ask_correction",
        sideEffectProfile: "none",
        riskClass: "medium",
        privacyProfile: "local_private",
        reversibility: "reversible",
        advisoryOnly: true,
        preparableWhenBlocked: true,
        requiresRuntimeControl: false,
        requiredPermissionCapabilities: [],
        requiredApprovals: [],
        externalActionAuthority: false,
        userVisibleSummary: "Memory conflict can prepare a correction question only; accepted memory writes remain with the owning store.",
      };
  }
}

function residentPeerInitiativePlanConfig(details: Record<string, unknown> | undefined, goalId: string): ResidentPlanConfig {
  const actionPlan = peerActionPlanDetails(details);
  if (actionPlan.mode === "permissioned_external_action") {
    return {
      capabilityId: "capability:resident_peer_permissioned_action",
      operationIdPrefix: "resident.peer_initiative.permissioned",
      operationKind: operationKindForPeerExternalAction(actionPlan.proposed_action_kind),
      providerRef: "resident:peer-initiative",
      payloadClass: "resident.peer_initiative.permissioned_external_action",
      sideEffectProfile: sideEffectForPeerExternalAction(actionPlan.proposed_action_kind),
      riskClass: "medium",
      privacyProfile: "external_service",
      reversibility: "draft_only",
      advisoryOnly: false,
      preparableWhenBlocked: true,
      requiresRuntimeControl: false,
      requiredPermissionCapabilities: [],
      requiredApprovals: [`approval:peer-initiative:${goalId || "daemon"}`],
      externalActionAuthority: true,
      userVisibleSummary: "Resident peer initiative may prepare the external action only; execution requires the existing approval path.",
    };
  }
  if (actionPlan.mode === "internal_preparation") {
    return {
      capabilityId: "capability:resident_peer_internal_preparation",
      operationIdPrefix: "resident.peer_initiative.prepare",
      operationKind: "prepare",
      providerRef: "resident:peer-initiative",
      payloadClass: "resident.peer_initiative.internal_preparation",
      sideEffectProfile: "write",
      riskClass: "low",
      privacyProfile: "local_private",
      reversibility: "draft_only",
      advisoryOnly: false,
      preparableWhenBlocked: true,
      requiresRuntimeControl: false,
      requiredPermissionCapabilities: [],
      requiredApprovals: [],
      externalActionAuthority: false,
      userVisibleSummary: "Resident peer initiative may prepare a local reversible artifact before asking the user to inspect it.",
    };
  }
  if (actionPlan.mode === "contextual_capability_disclosure" && actionPlan.permission_required === true) {
    return {
      capabilityId: "capability:resident_peer_capability_disclosure",
      operationIdPrefix: "resident.peer_initiative.capability.ask",
      operationKind: "mutate",
      providerRef: "resident:peer-initiative",
      payloadClass: "resident.peer_initiative.contextual_capability_disclosure",
      sideEffectProfile: "mutate",
      riskClass: "medium",
      privacyProfile: "workspace_private",
      reversibility: "draft_only",
      advisoryOnly: false,
      preparableWhenBlocked: true,
      requiresRuntimeControl: false,
      requiredPermissionCapabilities: [],
      requiredApprovals: [`approval:peer-initiative-capability:${goalId || "daemon"}`],
      externalActionAuthority: true,
      userVisibleSummary: "Resident peer initiative may disclose the capability and ask before enabling or externalizing it.",
    };
  }
  return {
    capabilityId: "capability:resident_peer_care_presence",
    operationIdPrefix: "resident.peer_initiative.care",
    operationKind: "hint",
    providerRef: "resident:peer-initiative",
    payloadClass: "resident.peer_initiative.care_presence",
    sideEffectProfile: "none",
    riskClass: "low",
    privacyProfile: "local_private",
    reversibility: "reversible",
    advisoryOnly: true,
    preparableWhenBlocked: true,
    requiresRuntimeControl: false,
    requiredPermissionCapabilities: [],
    requiredApprovals: [],
    externalActionAuthority: false,
    userVisibleSummary: "Resident peer initiative may offer low-pressure care or contextual capability help without execution authority.",
  };
}

function residentOperationPlanFailClosedReason(
  input: ResidentOperationPlanAssemblyInput,
  config: ResidentPlanConfig,
): string | null {
  if (!input.admission.attention_input_id || !input.admission.agenda_item_id) {
    return "Resident operation plan context is missing attention or agenda refs.";
  }
  if (!input.admission.outcome_decision_id) {
    return "Resident operation plan context is missing an outcome decision ref.";
  }
  if (input.admission.action === "preemptive_check" && !(input.goalId ?? "").trim()) {
    return "Resident preemptive operation plan requires a current goal target.";
  }
  const requested = input.admission.requested_outcome;
  const finalOutcome = input.admission.final_outcome ?? requested;
  if (input.admission.action === "preemptive_check") {
    if (requested !== "prepare_action_candidate") {
      return "Resident preemptive operation plan requires a prepare_action_candidate attention outcome.";
    }
    return null;
  }
  if (input.admission.action === "peer_initiative") {
    if (!input.admission.branch_admitted) {
      return "Resident peer initiative operation plan requires an admitted attention outcome before delivery.";
    }
    if (
      finalOutcome !== "express_to_user"
      && finalOutcome !== "add_to_digest"
      && finalOutcome !== "request_approval"
    ) {
      return `Resident peer initiative cannot prepare from attention outcome ${finalOutcome}.`;
    }
    return null;
  }
  if (input.admission.action === "commitment") {
    if (!input.admission.branch_admitted) {
      return "Commitment operation requires admitted attention evidence before any peer or digest projection.";
    }
    const family = commitmentOperationFamily(input.details);
    if (family === "attention.commitment.watch") return null;
    if (
      finalOutcome !== "prepare_silently"
      && finalOutcome !== "add_to_digest"
      && finalOutcome !== "express_to_user"
      && finalOutcome !== "request_approval"
      && finalOutcome !== "keep_watching"
    ) {
      return `Commitment operation cannot prepare from attention outcome ${finalOutcome}.`;
    }
    if (finalOutcome === "request_approval" && input.details?.["explicit_permission"] !== true) {
      return "Commitment action candidate requires explicit permission evidence before approval request preparation.";
    }
    return null;
  }
  if (!input.admission.branch_admitted) {
    return "Resident operation plan requires an admitted attention outcome before preparing a proposal.";
  }
  if (finalOutcome !== "prepare_silently") {
    return `Resident operation plan cannot prepare from attention outcome ${finalOutcome}.`;
  }
  if (config.requiresRuntimeControl && input.admission.admission_status === "admitted") {
    return "Resident runtime-control operation cannot bypass downstream runtime-control admission.";
  }
  return null;
}

function residentOperationPlanAssemblyId(
  input: ResidentOperationPlanAssemblyInput,
  sourceRef: string,
): string {
  return `operation-plan-assembly:resident:${input.admission.action}:${residentOperationPlanToken(sourceRef)}`;
}

function residentOperationPlanToken(value: string): string {
  return encodeURIComponent(value).replace(/%/g, "_");
}

function residentOperationPlanTargetRefs(input: ResidentOperationPlanAssemblyInput): string[] {
  return [
    input.admission.attention_input_id,
    input.admission.signal_context_id,
    input.admission.urge_id,
    input.admission.agenda_item_id,
    input.admission.inhibition_decision_id,
    input.admission.initiative_gate_decision_id,
    ...(input.admission.outcome_decision_id ? [input.admission.outcome_decision_id] : []),
    ...(input.goalId ? [`goal:${input.goalId}`] : []),
    ...(input.surfaceRef ? [input.surfaceRef] : []),
  ];
}

function residentPreparationSteps(action: ResidentOperationPlanAction): string[] {
  switch (action) {
    case "suggest_goal":
      return [
        "Prepare an inspectable local goal suggestion draft.",
        "Leave runtime start, negotiation, notification, and user-visible delivery to later admitted surfaces.",
      ];
    case "investigate":
    case "curiosity":
      return [
        "Prepare an inspectable curiosity proposal.",
        "Keep the proposal local until shared delivery or runtime-control admission chooses a route.",
      ];
    case "preemptive_check":
      return [
        "Record the preemptive check as a read candidate.",
        "Wait for runtime-control admission before any runtime executor or user-visible route.",
      ];
    case "peer_initiative":
      return [
        "Prepare only the local peer initiative artifact or conversation suggestion.",
        "Route visible delivery through attention outcome, proactive threshold, expression, visibility, and gateway outbound conversation gates.",
        "Do not execute external actions from the peer initiative operation plan.",
      ];
    case "commitment":
      return [
        "Keep watch and silence outcomes trace-only.",
        "Prepare follow-up, digest, or ask candidates only after admission and autonomy boundary evidence exists.",
        "Do not send notifications, write memory, or execute external actions from the commitment operation adapter.",
      ];
    case "sleep":
    case "curiosity_noop":
      return [];
  }
}

function peerActionPlanDetails(details?: Record<string, unknown>): {
  mode: "care_only" | "internal_preparation" | "permissioned_external_action" | "contextual_capability_disclosure";
  proposed_action_kind?: string;
  permission_required?: boolean;
} {
  const peer = details?.["peer_initiative"];
  const peerRecord = peer && typeof peer === "object" && !Array.isArray(peer)
    ? peer as Record<string, unknown>
    : details ?? {};
  const actionPlan = peerRecord["action_plan"];
  if (!actionPlan || typeof actionPlan !== "object" || Array.isArray(actionPlan)) {
    return { mode: "care_only" };
  }
  const actionPlanRecord = actionPlan as Record<string, unknown>;
  const mode = actionPlanRecord["mode"];
  if (
    mode === "internal_preparation"
    || mode === "permissioned_external_action"
    || mode === "contextual_capability_disclosure"
  ) {
    return {
      mode,
      proposed_action_kind: typeof actionPlanRecord["proposed_action_kind"] === "string"
        ? actionPlanRecord["proposed_action_kind"]
        : undefined,
      permission_required: actionPlanRecord["permission_required"] === true,
    };
  }
  return { mode: "care_only" };
}

function commitmentOperationFamily(details?: Record<string, unknown>):
  | "attention.commitment.watch"
  | "attention.commitment.prepare_followup"
  | "attention.commitment.digest"
  | "attention.commitment.ask_if_still_relevant"
  | "attention.unresolved_decision.prepare_options"
  | "attention.memory_conflict.ask_correction"
  | "attention.capability_fit.prepare_once" {
  const raw = details?.["commitment_operation_family"];
  switch (raw) {
    case "attention.commitment.watch":
    case "attention.commitment.prepare_followup":
    case "attention.commitment.digest":
    case "attention.commitment.ask_if_still_relevant":
    case "attention.unresolved_decision.prepare_options":
    case "attention.memory_conflict.ask_correction":
    case "attention.capability_fit.prepare_once":
      return raw;
    default:
      return "attention.commitment.watch";
  }
}

function operationKindForPeerExternalAction(actionKind?: string): ResidentPlanConfig["operationKind"] {
  switch (actionKind) {
    case "send_message":
    case "share_artifact":
      return "send";
    case "create_calendar_event":
    case "schedule_reminder":
    case "commit_setting":
      return "mutate";
    default:
      return "write";
  }
}

function sideEffectForPeerExternalAction(actionKind?: string): ResidentPlanConfig["sideEffectProfile"] {
  switch (actionKind) {
    case "send_message":
    case "share_artifact":
      return "send";
    case "create_calendar_event":
    case "schedule_reminder":
    case "commit_setting":
      return "mutate";
    default:
      return "write";
  }
}
