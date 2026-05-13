import { z } from "zod";
import {
  CapabilityOperationKindEnum,
  CapabilityReadinessSnapshotSchema,
  CapabilityReadinessStateEnum,
  CapabilitySideEffectProfileEnum,
  type CapabilityReadinessSnapshot,
} from "../../platform/observation/types/capability.js";
import {
  AdmissionPolicyEvaluationSchema,
  type AdmissionPolicyEvaluation,
} from "../control/admission-policy.js";
import {
  AutonomyDecisionSchema,
  AutonomyOperationPlanSchema,
  type AutonomyDecision,
  type AutonomyOperationPlan,
} from "../control/autonomy-governor.js";
import {
  CompanionActionProjectionSchema,
  CompanionUserFacingPolicyProjectionSchema,
  CompanionUserVisibleActionKindSchema,
  toCompanionUserFacingPolicyProjection,
  type CompanionActionProjection,
  type CompanionUserFacingPolicyProjection,
} from "../control/companion-action-projection.js";
import {
  CapabilityOperationPlanCandidateSchema,
  type CapabilityOperationPlanCandidate,
  type CapabilityOperationPlanCandidateInput,
} from "../types/capability-operation-plan.js";
import { CompanionDecisionInputRefSchema } from "./companion-decision-contract.js";

export const CompanionGadgetAssetKindSchema = z.enum([
  "capability",
  "tool",
  "skill",
  "plugin",
  "integration",
  "surface",
]);
export type CompanionGadgetAssetKind = z.infer<typeof CompanionGadgetAssetKindSchema>;

export const CompanionGadgetPlanningRefKindSchema = z.enum([
  "companion_decision_frame",
  "core_memory_projection",
  "capability_graph",
  "operation_plan_assembly",
  "operation_plan",
  "readiness_snapshot",
  "admission_evaluation",
  "autonomy_decision",
  "action_projection",
  "approval_request",
  "audit_record",
  "active_goal",
  "current_surface",
  "runtime_control",
  "user_request",
  "feedback_signal",
]);
export type CompanionGadgetPlanningRefKind = z.infer<typeof CompanionGadgetPlanningRefKindSchema>;

export const CompanionGadgetPlanningSourceRefSchema = z.object({
  kind: CompanionGadgetPlanningRefKindSchema,
  ref: z.string().min(1),
  role: z.enum(["situation", "candidate", "policy", "runtime", "memory", "surface", "audit", "outcome"])
    .optional(),
}).strict();
export type CompanionGadgetPlanningSourceRef = z.infer<typeof CompanionGadgetPlanningSourceRefSchema>;

export const CompanionGadgetReadinessSummaryStateSchema = z.union([
  CapabilityReadinessStateEnum,
  z.literal("missing"),
]);
export type CompanionGadgetReadinessSummaryState = z.infer<typeof CompanionGadgetReadinessSummaryStateSchema>;

export const CompanionGadgetPlanningBlockReasonSchema = z.enum([
  "readiness_missing",
  "readiness_unverified",
  "readiness_degraded",
  "readiness_blocked",
  "readiness_stale",
  "admission_approval_required",
  "admission_not_allowed",
  "autonomy_not_initiable",
  "approval_required",
  "projection_not_executable",
  "surface_not_safe_for_execution_advertisement",
  "operation_scope_mismatch",
]);
export type CompanionGadgetPlanningBlockReason = z.infer<typeof CompanionGadgetPlanningBlockReasonSchema>;

const READINESS_BLOCK_REASONS = new Set<CompanionGadgetPlanningBlockReason>([
  "readiness_missing",
  "readiness_unverified",
  "readiness_degraded",
  "readiness_blocked",
  "readiness_stale",
]);

export const CompanionGadgetOutcomeFeedbackAdjustmentSchema = z.enum([
  "reduce_frequency",
  "require_confirmation",
  "narrow_scope",
  "avoid_sensitive_context",
]);
export type CompanionGadgetOutcomeFeedbackAdjustment = z.infer<typeof CompanionGadgetOutcomeFeedbackAdjustmentSchema>;

export const CompanionGadgetOutcomeFeedbackPolicySchema = z.object({
  rejection_or_overreach_makes_future_planning_more_conservative: z.literal(true).default(true),
  carries_to_autonomy_feedback_signal: z.literal(true).default(true),
  default_rejection_adjustment: CompanionGadgetOutcomeFeedbackAdjustmentSchema.default("require_confirmation"),
  default_overreach_adjustment: CompanionGadgetOutcomeFeedbackAdjustmentSchema.default("avoid_sensitive_context"),
  allowed_adjustments: z.array(CompanionGadgetOutcomeFeedbackAdjustmentSchema).default([
    "reduce_frequency",
    "require_confirmation",
    "narrow_scope",
    "avoid_sensitive_context",
  ]),
}).strict();
export type CompanionGadgetOutcomeFeedbackPolicy = z.infer<typeof CompanionGadgetOutcomeFeedbackPolicySchema>;

export const CompanionGadgetCandidateSchema = z.object({
  candidate_id: z.string().min(1),
  asset_kind: CompanionGadgetAssetKindSchema,
  capability_id: z.string().min(1).optional(),
  operation_id: z.string().min(1),
  operation_kind: CapabilityOperationKindEnum,
  provider_ref: z.string().min(1),
  payload_class: z.string().min(1),
  side_effect_profile: CapabilitySideEffectProfileEnum,
  tool_name: z.string().min(1).optional(),
  operation_plan_ref: z.string().min(1),
  readiness_state: CompanionGadgetReadinessSummaryStateSchema,
  readiness_refs: z.array(z.string().min(1)).default([]),
  safe_user_visible_label: z.string().min(1),
  can_execute: z.boolean(),
  may_initiate: z.literal(false).default(false),
  normal_surface_advertises_executable: z.literal(false).default(false),
  model_text_is_authority: z.literal(false).default(false),
  blocked_reasons: z.array(CompanionGadgetPlanningBlockReasonSchema).default([]),
  source_refs: z.array(CompanionGadgetPlanningSourceRefSchema).default([]),
}).strict().superRefine((candidate, ctx) => {
  if (candidate.can_execute && candidate.readiness_state !== "executable_verified") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["can_execute"],
      message: "gadget candidates can_execute only when readiness is executable_verified",
    });
  }
  if (candidate.can_execute && candidate.blocked_reasons.some((reason) => READINESS_BLOCK_REASONS.has(reason))) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["blocked_reasons"],
      message: "executable gadget candidates cannot carry readiness block reasons",
    });
  }
});
export type CompanionGadgetCandidate = z.infer<typeof CompanionGadgetCandidateSchema>;

export const CompanionGadgetActionCandidateSchema = z.object({
  action_candidate_id: z.string().min(1),
  action_kind: CompanionUserVisibleActionKindSchema,
  operation_id: z.string().min(1),
  capability_id: z.string().min(1).optional(),
  can_execute: z.boolean(),
  may_initiate: z.boolean(),
  requires_approval: z.boolean(),
  executes_operation: z.boolean(),
  normal_surface_advertises_executable: z.boolean(),
  model_text_is_authority: z.literal(false).default(false),
  readiness_refs: z.array(z.string().min(1)).default([]),
  admission_evaluation_ref: z.string().min(1),
  autonomy_decision_ref: z.string().min(1),
  action_projection_ref: z.string().min(1),
  blocked_reasons: z.array(CompanionGadgetPlanningBlockReasonSchema).default([]),
  conservative_feedback_adjustments: z.array(CompanionGadgetOutcomeFeedbackAdjustmentSchema).default([]),
}).strict().superRefine((candidate, ctx) => {
  if (candidate.may_initiate && !candidate.can_execute) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["may_initiate"],
      message: "may_initiate requires executable readiness substrate",
    });
  }
  if (candidate.may_initiate && candidate.requires_approval) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["requires_approval"],
      message: "approval-required actions cannot initiate until approval is granted",
    });
  }
  if (candidate.executes_operation && !candidate.may_initiate) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["executes_operation"],
      message: "action candidates cannot execute unless initiation is allowed",
    });
  }
  if (candidate.normal_surface_advertises_executable && !candidate.may_initiate) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["normal_surface_advertises_executable"],
      message: "normal surfaces may advertise execution only for actions that may initiate",
    });
  }
  if (candidate.may_initiate && candidate.blocked_reasons.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["blocked_reasons"],
      message: "initiable action candidates cannot carry block reasons",
    });
  }
});
export type CompanionGadgetActionCandidate = z.infer<typeof CompanionGadgetActionCandidateSchema>;

export const CompanionGadgetPlanSchema = z.object({
  schema_version: z.literal("companion-gadget-plan/v1"),
  plan_id: z.string().min(1),
  generated_at: z.string().min(1),
  situation_refs: z.array(CompanionGadgetPlanningSourceRefSchema).default([]),
  decision_input_refs: z.array(CompanionDecisionInputRefSchema).default([]),
  candidate: CompanionGadgetCandidateSchema,
  operation_plan_candidate: CapabilityOperationPlanCandidateSchema,
  admission_evaluation: AdmissionPolicyEvaluationSchema,
  autonomy_decision: AutonomyDecisionSchema,
  action_projection: CompanionActionProjectionSchema,
  user_facing_policy_projection: CompanionUserFacingPolicyProjectionSchema.optional(),
  action_candidates: z.array(CompanionGadgetActionCandidateSchema).min(1),
  outcome_feedback_policy: CompanionGadgetOutcomeFeedbackPolicySchema.default({}),
  model_text_is_authority: z.literal(false).default(false),
  audit_refs: z.array(z.string().min(1)).default([]),
  metadata: z.object({
    uses_capability_runtime: z.literal(true).default(true),
    uses_admission_policy: z.literal(true).default(true),
    uses_autonomy_governor: z.literal(true).default(true),
    uses_action_projection: z.literal(true).default(true),
    can_execute_is_not_may_initiate: z.literal(true).default(true),
  }).strict().default({}),
}).strict().superRefine((plan, ctx) => {
  const scopeMismatch = operationScopeMismatch({
    operationPlan: plan.operation_plan_candidate.operation_plan,
    admission: plan.admission_evaluation,
    autonomy: plan.autonomy_decision,
    projection: plan.action_projection,
  });
  if (scopeMismatch) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["operation_plan_candidate"],
      message: scopeMismatch,
    });
  }

  const initiableActions = plan.action_candidates.filter((candidate) => candidate.may_initiate);
  if (initiableActions.length > 0 && !plan.candidate.can_execute) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["candidate", "can_execute"],
      message: "gadget plan cannot initiate from a candidate whose execution substrate is not verified",
    });
  }
  if (plan.user_facing_policy_projection?.executes_operation === true && initiableActions.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["user_facing_policy_projection", "executes_operation"],
      message: "user-facing execution projection requires an initiable action candidate",
    });
  }
});
export type CompanionGadgetPlan = z.infer<typeof CompanionGadgetPlanSchema>;

export interface CreateCompanionGadgetPlanInput {
  planId?: string;
  generatedAt?: string;
  assetKind: CompanionGadgetAssetKind;
  operationCandidate: CapabilityOperationPlanCandidateInput;
  readinessSnapshots?: CapabilityReadinessSnapshot[];
  admissionEvaluation: AdmissionPolicyEvaluation;
  autonomyDecision: AutonomyDecision;
  actionProjection: CompanionActionProjection;
  situationRefs?: CompanionGadgetPlanningSourceRef[];
  decisionInputRefs?: Array<z.input<typeof CompanionDecisionInputRefSchema>>;
}

export function createCompanionGadgetPlan(input: CreateCompanionGadgetPlanInput): CompanionGadgetPlan {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const operationCandidate = CapabilityOperationPlanCandidateSchema.parse(input.operationCandidate);
  const readinessSnapshots = (input.readinessSnapshots ?? []).map((snapshot) =>
    CapabilityReadinessSnapshotSchema.parse(snapshot)
  );
  const admission = AdmissionPolicyEvaluationSchema.parse(input.admissionEvaluation);
  const autonomy = AutonomyDecisionSchema.parse(input.autonomyDecision);
  const projection = CompanionActionProjectionSchema.parse(input.actionProjection);
  const matchingReadiness = readinessSnapshots.filter((snapshot) =>
    readinessMatchesOperation(snapshot, operationCandidate.operation_plan)
  );
  const readinessState = readinessSummaryState(matchingReadiness);
  const readinessRefs = matchingReadiness.map((snapshot) => snapshot.snapshot_id).sort();
  const readinessBlocks = readinessBlockReasons(readinessState, matchingReadiness);
  const canExecute = readinessState === "executable_verified" && readinessBlocks.length === 0;
  const mayInitiate = mayInitiateAction({
    canExecute,
    admission,
    autonomy,
    projection,
  });
  const actionBlocks = actionBlockReasons({
    canExecute,
    readinessBlocks,
    admission,
    autonomy,
    projection,
  });
  const requiresApproval = admission.result === "approval_required"
    || autonomy.required_user_approval
    || projection.user_visible_action_kind === "ask_for_approval";
  const normalSurfaceCanAdvertiseExecutable = projection.surface_expression_policy.surface_kind === "normal_companion"
    && mayInitiate;
  const userFacingPolicy = userFacingPolicyFor(projection);
  const operation = operationCandidate.operation_plan;
  const capabilityIdPart = operation.capability_id ? { capability_id: operation.capability_id } : {};
  const toolName = matchingReadiness.find((snapshot) => snapshot.tool_name)?.tool_name;
  const candidate = CompanionGadgetCandidateSchema.parse({
    candidate_id: `${operationCandidate.plan_id}:gadget-candidate`,
    asset_kind: input.assetKind,
    ...capabilityIdPart,
    operation_id: operation.operation_id,
    operation_kind: operation.operation_kind,
    provider_ref: operation.provider_ref,
    payload_class: operation.payload_class,
    side_effect_profile: operation.side_effect_profile,
    ...(toolName ? { tool_name: toolName } : {}),
    operation_plan_ref: operationCandidate.plan_id,
    readiness_state: readinessState,
    readiness_refs: readinessRefs,
    safe_user_visible_label: safeLabelFor(readinessState, matchingReadiness),
    can_execute: canExecute,
    may_initiate: false,
    normal_surface_advertises_executable: false,
    model_text_is_authority: false,
    blocked_reasons: readinessBlocks,
    source_refs: [
      {
        kind: "operation_plan",
        ref: operationCandidate.plan_id,
        role: "candidate",
      },
      ...readinessRefs.map((ref) => ({
        kind: "readiness_snapshot" as const,
        ref,
        role: "policy" as const,
      })),
    ],
  });

  const actionCandidate = CompanionGadgetActionCandidateSchema.parse({
    action_candidate_id: `${operationCandidate.plan_id}:action-candidate:${projection.user_visible_action_kind}`,
    action_kind: projection.user_visible_action_kind,
    operation_id: operation.operation_id,
    ...capabilityIdPart,
    can_execute: canExecute,
    may_initiate: mayInitiate,
    requires_approval: requiresApproval,
    executes_operation: projection.executes_operation && mayInitiate,
    normal_surface_advertises_executable: normalSurfaceCanAdvertiseExecutable,
    model_text_is_authority: false,
    readiness_refs: readinessRefs,
    admission_evaluation_ref: admission.evaluation_id,
    autonomy_decision_ref: autonomy.decision_id,
    action_projection_ref: projection.projection_id,
    blocked_reasons: actionBlocks,
    conservative_feedback_adjustments: conservativeFeedbackAdjustments(actionBlocks),
  });

  return CompanionGadgetPlanSchema.parse({
    schema_version: "companion-gadget-plan/v1",
    plan_id: input.planId ?? `${operationCandidate.plan_id}:gadget-plan`,
    generated_at: generatedAt,
    situation_refs: (input.situationRefs ?? []).map((ref) => CompanionGadgetPlanningSourceRefSchema.parse(ref)),
    decision_input_refs: (input.decisionInputRefs ?? []).map((ref) => CompanionDecisionInputRefSchema.parse(ref)),
    candidate,
    operation_plan_candidate: operationCandidate,
    admission_evaluation: admission,
    autonomy_decision: autonomy,
    action_projection: projection,
    ...(userFacingPolicy ? { user_facing_policy_projection: userFacingPolicy } : {}),
    action_candidates: [actionCandidate],
    outcome_feedback_policy: {
      rejection_or_overreach_makes_future_planning_more_conservative: true,
      carries_to_autonomy_feedback_signal: true,
      default_rejection_adjustment: "require_confirmation",
      default_overreach_adjustment: "avoid_sensitive_context",
      allowed_adjustments: [
        "reduce_frequency",
        "require_confirmation",
        "narrow_scope",
        "avoid_sensitive_context",
      ],
    },
    model_text_is_authority: false,
    audit_refs: auditRefsFor({
      operationCandidate,
      readinessRefs,
      admission,
      autonomy,
      projection,
    }),
    metadata: {
      uses_capability_runtime: true,
      uses_admission_policy: true,
      uses_autonomy_governor: true,
      uses_action_projection: true,
      can_execute_is_not_may_initiate: true,
    },
  });
}

function readinessSummaryState(
  snapshots: CapabilityReadinessSnapshot[]
): CompanionGadgetReadinessSummaryState {
  if (snapshots.length === 0) return "missing";
  if (snapshots.some((snapshot) => snapshot.state === "blocked")) return "blocked";
  if (snapshots.some((snapshot) => snapshot.state === "degraded")) return "degraded";
  if (snapshots.every((snapshot) => snapshot.state === "executable_verified")) {
    return "executable_verified";
  }
  return snapshots[0]?.state ?? "missing";
}

function readinessBlockReasons(
  state: CompanionGadgetReadinessSummaryState,
  snapshots: CapabilityReadinessSnapshot[]
): CompanionGadgetPlanningBlockReason[] {
  const reasons = new Set<CompanionGadgetPlanningBlockReason>();
  if (state === "missing") reasons.add("readiness_missing");
  if (state === "blocked") reasons.add("readiness_blocked");
  if (state === "degraded") reasons.add("readiness_degraded");
  if (state !== "missing" && state !== "blocked" && state !== "degraded" && state !== "executable_verified") {
    reasons.add("readiness_unverified");
  }
  if (snapshots.some((snapshot) => snapshot.stale_refs.length > 0)) {
    reasons.add("readiness_stale");
  }
  return [...reasons].sort();
}

function mayInitiateAction(input: {
  canExecute: boolean;
  admission: AdmissionPolicyEvaluation;
  autonomy: AutonomyDecision;
  projection: CompanionActionProjection;
}): boolean {
  return input.canExecute
    && input.admission.result === "allowed"
    && (input.autonomy.level === "user_directed_execute" || input.autonomy.level === "autonomous_low_risk")
    && !input.autonomy.required_user_approval
    && input.projection.user_visible_action_kind === "execute_now"
    && input.projection.executes_operation;
}

function actionBlockReasons(input: {
  canExecute: boolean;
  readinessBlocks: CompanionGadgetPlanningBlockReason[];
  admission: AdmissionPolicyEvaluation;
  autonomy: AutonomyDecision;
  projection: CompanionActionProjection;
}): CompanionGadgetPlanningBlockReason[] {
  const reasons = new Set<CompanionGadgetPlanningBlockReason>(input.readinessBlocks);
  if (!input.canExecute && input.readinessBlocks.length === 0) {
    reasons.add("readiness_unverified");
  }
  if (input.admission.result === "approval_required") {
    reasons.add("admission_approval_required");
    reasons.add("approval_required");
  }
  if (input.admission.result === "suppressed" || input.admission.result === "prohibited") {
    reasons.add("admission_not_allowed");
  }
  if (
    input.autonomy.level !== "user_directed_execute"
    && input.autonomy.level !== "autonomous_low_risk"
  ) {
    reasons.add("autonomy_not_initiable");
  }
  if (input.autonomy.required_user_approval) {
    reasons.add("approval_required");
  }
  if (!input.projection.executes_operation || input.projection.user_visible_action_kind !== "execute_now") {
    reasons.add("projection_not_executable");
  }
  if (
    input.projection.surface_expression_policy.surface_kind === "normal_companion"
    && (
      input.projection.surface_expression_policy.capability_catalog_visible
      || input.projection.surface_expression_policy.raw_policy_state_visible
      || input.projection.surface_expression_policy.hidden_reasons_visible
    )
  ) {
    reasons.add("surface_not_safe_for_execution_advertisement");
  }
  return [...reasons].sort();
}

function conservativeFeedbackAdjustments(
  blockedReasons: CompanionGadgetPlanningBlockReason[]
): CompanionGadgetOutcomeFeedbackAdjustment[] {
  if (blockedReasons.includes("approval_required") || blockedReasons.includes("admission_approval_required")) {
    return ["require_confirmation"];
  }
  if (blockedReasons.includes("readiness_degraded") || blockedReasons.includes("readiness_stale")) {
    return ["narrow_scope", "require_confirmation"];
  }
  if (blockedReasons.includes("surface_not_safe_for_execution_advertisement")) {
    return ["reduce_frequency"];
  }
  return [];
}

function userFacingPolicyFor(
  projection: CompanionActionProjection
): CompanionUserFacingPolicyProjection | undefined {
  if (projection.surface_expression_policy.surface_kind !== "normal_companion") {
    return undefined;
  }
  return toCompanionUserFacingPolicyProjection(projection);
}

function safeLabelFor(
  state: CompanionGadgetReadinessSummaryState,
  snapshots: CapabilityReadinessSnapshot[]
): string {
  const explicit = snapshots.find((snapshot) => snapshot.safe_user_visible_label)?.safe_user_visible_label;
  if (explicit) return explicit;
  if (state === "blocked") return "Blocked";
  if (state === "degraded") return "Degraded";
  if (state === "authenticated") return "Configured, verification required";
  if (state === "missing") return "Recorded, not executable";
  if (state === "executable_verified") return "Execution substrate verified";
  return "Setup required";
}

function auditRefsFor(input: {
  operationCandidate: CapabilityOperationPlanCandidate;
  readinessRefs: string[];
  admission: AdmissionPolicyEvaluation;
  autonomy: AutonomyDecision;
  projection: CompanionActionProjection;
}): string[] {
  return unique([
    input.operationCandidate.plan_id,
    input.operationCandidate.source_ref,
    ...input.operationCandidate.readiness_snapshot_refs,
    ...input.readinessRefs,
    input.admission.evaluation_id,
    ...input.admission.permission_grant_refs,
    ...input.admission.runtime_control_refs,
    ...input.admission.notification_policy_refs,
    input.autonomy.decision_id,
    ...input.autonomy.audit_refs,
    input.projection.projection_id,
    ...input.projection.audit_refs,
  ]);
}

function readinessMatchesOperation(
  snapshot: CapabilityReadinessSnapshot,
  operation: AutonomyOperationPlan
): boolean {
  return operation.capability_id !== undefined
    && snapshot.capability_id === operation.capability_id
    && snapshot.operation_id === operation.operation_id
    && snapshot.provider_ref === operation.provider_ref
    && snapshot.payload_class === operation.payload_class
    && snapshot.operation_kind === operation.operation_kind
    && snapshot.side_effect_profile === operation.side_effect_profile
    && snapshot.risk_class === operation.risk_class;
}

function operationScopeMismatch(input: {
  operationPlan: AutonomyOperationPlan;
  admission: AdmissionPolicyEvaluation;
  autonomy: AutonomyDecision;
  projection: CompanionActionProjection;
}): string | null {
  const operation = AutonomyOperationPlanSchema.parse(input.operationPlan);
  if (operation.operation_id !== input.admission.operation_id) {
    return "admission evaluation operation_id does not match the gadget operation plan";
  }
  if (operation.provider_ref !== input.admission.provider_ref) {
    return "admission evaluation provider_ref does not match the gadget operation plan";
  }
  if (operation.payload_class !== input.admission.payload_class) {
    return "admission evaluation payload_class does not match the gadget operation plan";
  }
  if (operation.operation_kind !== input.admission.metadata.operation_kind) {
    return "admission evaluation operation_kind does not match the gadget operation plan";
  }
  if (operation.side_effect_profile !== input.admission.metadata.side_effect_profile) {
    return "admission evaluation side_effect_profile does not match the gadget operation plan";
  }
  if (operation.capability_id !== input.admission.capability_id) {
    return "admission evaluation capability binding does not match the gadget operation plan";
  }
  if (operation.operation_id !== input.autonomy.operation_id) {
    return "autonomy decision operation_id does not match the gadget operation plan";
  }
  if (operation.capability_id !== input.autonomy.capability_id) {
    return "autonomy decision capability binding does not match the gadget operation plan";
  }
  if (input.admission.evaluation_id !== input.autonomy.metadata.admission_evaluation_ref) {
    return "autonomy decision does not reference the supplied admission evaluation";
  }
  if (input.autonomy.decision_id !== input.projection.decision_id) {
    return "action projection does not reference the supplied autonomy decision";
  }
  if (operation.operation_id !== input.projection.operation_id) {
    return "action projection operation_id does not match the gadget operation plan";
  }
  return null;
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}
