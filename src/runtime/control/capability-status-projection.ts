import { z } from "zod";
import {
  CapabilityReadinessSnapshotSchema,
  CapabilityReadinessStateEnum,
  CapabilitySafeUserVisibleLabelEnum,
  CapabilityStatusEnum,
  type CapabilityReadinessSnapshot,
  type CapabilityStatus,
} from "../../platform/observation/types/capability.js";
import {
  AdmissionPolicyEvaluationSchema,
  AdmissionPolicyResultSchema,
  type AdmissionPolicyEvaluation,
} from "./admission-policy.js";
import {
  AutonomyDecisionLevelSchema,
  AutonomyDecisionSchema,
  type AutonomyDecision,
} from "./autonomy-governor.js";
import {
  CompanionUserFacingPolicyProjectionSchema,
  projectCompanionUserFacingPolicy,
} from "./companion-action-projection.js";

export const CapabilityOperatorStatusSurfaceKindSchema = z.enum([
  "operator",
  "debug",
  "status",
]);
export type CapabilityOperatorStatusSurfaceKind = z.infer<typeof CapabilityOperatorStatusSurfaceKindSchema>;

export const CapabilityProjectionReadinessLabelSchema = z.enum([
  "recorded_not_executable",
  "setup_required",
  "auth_required",
  "verification_required",
  "execution_substrate_verified",
  "degraded",
  "blocked",
]);
export type CapabilityProjectionReadinessLabel = z.infer<typeof CapabilityProjectionReadinessLabelSchema>;

export const CapabilityProjectionAdmissionLabelSchema = z.enum([
  "not_evaluated",
  "admitted",
  "approval_required",
  "suppressed",
  "prohibited",
]);
export type CapabilityProjectionAdmissionLabel = z.infer<typeof CapabilityProjectionAdmissionLabelSchema>;

export const CapabilityProjectionAutonomyLabelSchema = z.enum([
  "not_evaluated",
  "advisory_only",
  "prepare_only",
  "user_directed_execute",
  "autonomous_low_risk",
  "approval_required",
  "prohibited",
]);
export type CapabilityProjectionAutonomyLabel = z.infer<typeof CapabilityProjectionAutonomyLabelSchema>;

export const CapabilityProjectionExecutionLabelSchema = z.enum([
  "not_executable",
  "execution_verified_admission_not_granted",
  "execution_verified_policy_not_granted",
  "admitted_user_directed_execution",
  "admitted_autonomous_low_risk_internal",
]);
export type CapabilityProjectionExecutionLabel = z.infer<typeof CapabilityProjectionExecutionLabelSchema>;

export const CapabilityOperatorStatusProjectionInputSchema = z.object({
  readiness: CapabilityReadinessSnapshotSchema,
  admission_evaluation: AdmissionPolicyEvaluationSchema.optional(),
  autonomy_decision: AutonomyDecisionSchema.optional(),
  surface_kind: CapabilityOperatorStatusSurfaceKindSchema.default("status"),
  surface_ref: z.string().min(1).optional(),
  registry_status: CapabilityStatusEnum.optional(),
  evaluated_at: z.string().min(1).optional(),
  projection_id: z.string().min(1).optional(),
}).strict();
export type CapabilityOperatorStatusProjectionInput = z.input<typeof CapabilityOperatorStatusProjectionInputSchema>;

export const CapabilityOperatorStatusProjectionSchema = z.object({
  schema_version: z.literal("capability-operator-status-projection/v1"),
  projection_id: z.string().min(1),
  surface_kind: CapabilityOperatorStatusSurfaceKindSchema,
  surface_ref: z.string().min(1),
  evaluated_at: z.string().min(1),
  capability_id: z.string().min(1),
  operation_id: z.string().min(1),
  provider_ref: z.string().min(1),
  tool_name: z.string().min(1),
  readiness: z.object({
    state: CapabilityReadinessStateEnum,
    label: CapabilityProjectionReadinessLabelSchema,
    safe_user_visible_label: CapabilitySafeUserVisibleLabelEnum,
    can_execute: z.boolean(),
    evidence_refs: z.array(z.string().min(1)).default([]),
    verification_refs: z.array(z.string().min(1)).default([]),
    missing_config_refs: z.array(z.string().min(1)).default([]),
    missing_auth_refs: z.array(z.string().min(1)).default([]),
    stale_refs: z.array(z.string().min(1)).default([]),
  }).strict(),
  admission: z.object({
    result: z.union([AdmissionPolicyResultSchema, z.literal("not_evaluated")]),
    label: CapabilityProjectionAdmissionLabelSchema,
    evaluation_ref: z.string().min(1).optional(),
    allowed: z.boolean(),
    requires_approval: z.boolean(),
  }).strict(),
  autonomy: z.object({
    level: z.union([AutonomyDecisionLevelSchema, z.literal("not_evaluated")]),
    label: CapabilityProjectionAutonomyLabelSchema,
    decision_ref: z.string().min(1).optional(),
    may_user_directed_execute: z.boolean(),
    may_initiate_autonomously: z.boolean(),
    requires_approval: z.boolean(),
  }).strict(),
  execution: z.object({
    label: CapabilityProjectionExecutionLabelSchema,
    can_execute: z.boolean(),
    may_execute_now: z.boolean(),
    may_initiate_autonomously: z.boolean(),
  }).strict(),
  surface_expression: z.object({
    capability_catalog_visible: z.boolean(),
    raw_policy_state_visible: z.boolean(),
  }).strict(),
  audit_refs: z.array(z.string().min(1)).default([]),
  warnings: z.array(z.string().min(1)).default([]),
  metadata: z.object({
    registry_status: CapabilityStatusEnum.optional(),
  }).strict(),
}).strict();
export type CapabilityOperatorStatusProjection = z.infer<typeof CapabilityOperatorStatusProjectionSchema>;

export const CapabilityNormalCompanionStatusProjectionInputSchema = z.object({
  decision: AutonomyDecisionSchema,
  surface_ref: z.string().min(1),
  prepared_artifact_refs: z.array(z.string().min(1)).default([]),
  approval_request_ref: z.string().min(1).optional(),
  alternative_action_refs: z.array(z.string().min(1)).default([]),
  evaluated_at: z.string().min(1).optional(),
  projection_id: z.string().min(1).optional(),
}).strict();
export type CapabilityNormalCompanionStatusProjectionInput = z.input<typeof CapabilityNormalCompanionStatusProjectionInputSchema>;

export const CapabilityNormalCompanionStatusProjectionSchema = CompanionUserFacingPolicyProjectionSchema.extend({
  schema_version: z.literal("capability-normal-companion-status-projection/v1"),
}).strict();
export type CapabilityNormalCompanionStatusProjection = z.infer<typeof CapabilityNormalCompanionStatusProjectionSchema>;

export function projectCapabilityOperatorStatus(
  input: CapabilityOperatorStatusProjectionInput
): CapabilityOperatorStatusProjection {
  const parsed = CapabilityOperatorStatusProjectionInputSchema.parse(input);
  const evaluatedAt = validTimeString(parsed.evaluated_at) ? parsed.evaluated_at : new Date().toISOString();
  const surfaceRef = parsed.surface_ref ?? `capability-status:${parsed.readiness.snapshot_id}`;
  const admissionExpired = parsed.admission_evaluation !== undefined
    && isExpired(parsed.admission_evaluation.expires_at, evaluatedAt);
  const admission = admissionExpired
    ? undefined
    : matchingAdmission(parsed.admission_evaluation, parsed.readiness);
  const admissionMismatch = parsed.admission_evaluation !== undefined
    && !admissionExpired
    && admission === undefined;
  const autonomyExpired = parsed.autonomy_decision !== undefined
    && isExpired(parsed.autonomy_decision.expires_at, evaluatedAt);
  const autonomy = autonomyExpired
    ? undefined
    : matchingAutonomy(
      parsed.autonomy_decision,
      parsed.readiness,
      admission,
      parsed.admission_evaluation !== undefined && admission === undefined
    );
  const autonomyMismatch = parsed.autonomy_decision !== undefined
    && !autonomyExpired
    && autonomy === undefined;
  const readinessCanExecute = parsed.readiness.state === "executable_verified";
  const admissionAllowed = admission?.result === "allowed";
  const autonomyMayUserDirectedExecute = readinessCanExecute
    && admissionAllowed
    && autonomy?.level === "user_directed_execute"
    && autonomy.metadata.user_directed === true;
  const autonomyMayInitiate = readinessCanExecute
    && admissionAllowed
    && autonomy?.level === "autonomous_low_risk"
    && autonomy.metadata.user_directed === false
    && autonomy.metadata.external_side_effect === false;
  const auditRefs = unique([
    parsed.readiness.snapshot_id,
    ...parsed.readiness.evidence_refs,
    ...parsed.readiness.verification_refs,
    ...(admission ? [admission.evaluation_id] : []),
    ...(autonomy ? [autonomy.decision_id, ...autonomy.audit_refs] : []),
  ]);
  const warnings = projectionWarnings({
    registryStatus: parsed.registry_status,
    admissionExpired,
    admissionMismatch,
    autonomyExpired,
    autonomyMismatch,
    autonomy,
  });

  return CapabilityOperatorStatusProjectionSchema.parse({
    schema_version: "capability-operator-status-projection/v1",
    projection_id: parsed.projection_id ?? `capability-status:${parsed.readiness.snapshot_id}:${surfaceRef}:${evaluatedAt}`,
    surface_kind: parsed.surface_kind,
    surface_ref: surfaceRef,
    evaluated_at: evaluatedAt,
    capability_id: parsed.readiness.capability_id,
    operation_id: parsed.readiness.operation_id,
    provider_ref: parsed.readiness.provider_ref,
    tool_name: parsed.readiness.tool_name,
    readiness: {
      state: parsed.readiness.state,
      label: readinessLabel(parsed.readiness),
      safe_user_visible_label: parsed.readiness.safe_user_visible_label,
      can_execute: readinessCanExecute,
      evidence_refs: parsed.readiness.evidence_refs,
      verification_refs: parsed.readiness.verification_refs,
      missing_config_refs: parsed.readiness.missing_config_refs,
      missing_auth_refs: parsed.readiness.missing_auth_refs,
      stale_refs: parsed.readiness.stale_refs,
    },
    admission: {
      result: admission?.result ?? "not_evaluated",
      label: admissionLabel(admission),
      ...(admission ? { evaluation_ref: admission.evaluation_id } : {}),
      allowed: admissionAllowed,
      requires_approval: admission?.result === "approval_required",
    },
    autonomy: {
      level: autonomy?.level ?? "not_evaluated",
      label: autonomyLabel(autonomy),
      ...(autonomy ? { decision_ref: autonomy.decision_id } : {}),
      may_user_directed_execute: autonomyMayUserDirectedExecute,
      may_initiate_autonomously: autonomyMayInitiate,
      requires_approval: autonomy?.required_user_approval ?? false,
    },
    execution: {
      label: executionLabel({
        readinessCanExecute,
        admissionAllowed,
        autonomyMayUserDirectedExecute,
        autonomyMayInitiate,
      }),
      can_execute: readinessCanExecute,
      may_execute_now: autonomyMayUserDirectedExecute || autonomyMayInitiate,
      may_initiate_autonomously: autonomyMayInitiate,
    },
    surface_expression: {
      capability_catalog_visible: true,
      raw_policy_state_visible: true,
    },
    audit_refs: auditRefs,
    warnings,
    metadata: {
      ...(parsed.registry_status ? { registry_status: parsed.registry_status } : {}),
    },
  });
}

export function projectCapabilityNormalCompanionStatusAction(
  input: CapabilityNormalCompanionStatusProjectionInput
): CapabilityNormalCompanionStatusProjection {
  const parsed = CapabilityNormalCompanionStatusProjectionInputSchema.parse(input);
  const evaluatedAt = validTimeString(parsed.evaluated_at) ? parsed.evaluated_at : new Date().toISOString();
  if (isExpired(parsed.decision.expires_at, evaluatedAt)) {
    const actionKind = parsed.prepared_artifact_refs.length > 0 ? "prepare_draft" : "suggest";
    return CapabilityNormalCompanionStatusProjectionSchema.parse({
      schema_version: "capability-normal-companion-status-projection/v1",
      evaluated_at: evaluatedAt,
      user_visible_action_kind: actionKind,
      ordinary_action_policy: "suggest",
      next_best_safe_action: actionKind === "prepare_draft"
        ? "Prepare an inspectable draft without executing the operation."
        : "Suggest a safe next step without executing.",
      brief_reason: "The previous safety decision is no longer current.",
      executes_operation: false,
    });
  }
  const projection = projectCompanionUserFacingPolicy({
    decision: parsed.decision,
    context: {
      surface_ref: parsed.surface_ref,
      surface_kind: "normal_companion",
    },
    prepared_artifact_refs: parsed.prepared_artifact_refs,
    ...(parsed.approval_request_ref ? { approval_request_ref: parsed.approval_request_ref } : {}),
    alternative_action_refs: parsed.alternative_action_refs,
    evaluated_at: evaluatedAt,
    ...(parsed.projection_id ? { projection_id: parsed.projection_id } : {}),
  });

  return CapabilityNormalCompanionStatusProjectionSchema.parse({
    schema_version: "capability-normal-companion-status-projection/v1",
    evaluated_at: projection.evaluated_at,
    user_visible_action_kind: projection.user_visible_action_kind,
    ordinary_action_policy: projection.ordinary_action_policy,
    next_best_safe_action: projection.next_best_safe_action,
    ...(projection.brief_reason ? { brief_reason: projection.brief_reason } : {}),
    executes_operation: projection.executes_operation,
  });
}

function readinessLabel(readiness: CapabilityReadinessSnapshot): CapabilityProjectionReadinessLabel {
  switch (readiness.safe_user_visible_label) {
    case "Recorded, not executable":
      return "recorded_not_executable";
    case "Setup required":
      return "setup_required";
    case "Auth required":
      return "auth_required";
    case "Configured, verification required":
      return "verification_required";
    case "Execution substrate verified":
      return "execution_substrate_verified";
    case "Degraded":
      return "degraded";
    case "Blocked":
      return "blocked";
  }
}

function admissionLabel(admission: AdmissionPolicyEvaluation | undefined): CapabilityProjectionAdmissionLabel {
  if (!admission) return "not_evaluated";
  return admission.result === "allowed" ? "admitted" : admission.result;
}

function autonomyLabel(autonomy: AutonomyDecision | undefined): CapabilityProjectionAutonomyLabel {
  if (!autonomy) return "not_evaluated";
  switch (autonomy.level) {
    case "advisory":
      return "advisory_only";
    case "prepare_only":
      return "prepare_only";
    case "user_directed_execute":
      return "user_directed_execute";
    case "autonomous_low_risk":
      return "autonomous_low_risk";
    case "approval_required":
      return "approval_required";
    case "prohibited":
      return "prohibited";
  }
}

function executionLabel(input: {
  readinessCanExecute: boolean;
  admissionAllowed: boolean;
  autonomyMayUserDirectedExecute: boolean;
  autonomyMayInitiate: boolean;
}): CapabilityProjectionExecutionLabel {
  if (!input.readinessCanExecute) return "not_executable";
  if (!input.admissionAllowed) return "execution_verified_admission_not_granted";
  if (input.autonomyMayUserDirectedExecute) return "admitted_user_directed_execution";
  if (input.autonomyMayInitiate) return "admitted_autonomous_low_risk_internal";
  return "execution_verified_policy_not_granted";
}

function matchingAdmission(
  admission: AdmissionPolicyEvaluation | undefined,
  readiness: CapabilityReadinessSnapshot
): AdmissionPolicyEvaluation | undefined {
  if (!admission) return undefined;
  if (admission.operation_id !== readiness.operation_id) return undefined;
  if (admission.provider_ref !== readiness.provider_ref) return undefined;
  if (admission.payload_class !== readiness.payload_class) return undefined;
  if (admission.metadata.operation_kind !== readiness.operation_kind) return undefined;
  if (admission.metadata.side_effect_profile !== readiness.side_effect_profile) return undefined;
  if (admission.capability_id && admission.capability_id !== readiness.capability_id) return undefined;
  if (admission.readiness_ref && admission.readiness_ref !== readiness.snapshot_id) return undefined;
  return admission;
}

function matchingAutonomy(
  autonomy: AutonomyDecision | undefined,
  readiness: CapabilityReadinessSnapshot,
  admission: AdmissionPolicyEvaluation | undefined,
  admissionMismatch: boolean
): AutonomyDecision | undefined {
  if (!autonomy) return undefined;
  if (admissionMismatch) return undefined;
  if (autonomy.operation_id !== readiness.operation_id) return undefined;
  if (autonomy.capability_id && autonomy.capability_id !== readiness.capability_id) return undefined;
  if (!new Set(autonomy.metadata.readiness_refs).has(readiness.snapshot_id)) return undefined;
  if (admission && autonomy.metadata.admission_evaluation_ref !== admission.evaluation_id) return undefined;
  return autonomy;
}

function projectionWarnings(input: {
  registryStatus: CapabilityStatus | undefined;
  admissionExpired: boolean;
  admissionMismatch: boolean;
  autonomyExpired: boolean;
  autonomyMismatch: boolean;
  autonomy: AutonomyDecision | undefined;
}): string[] {
  return unique([
    ...(input.registryStatus
      ? [`Registry status ${input.registryStatus} is evidence only and does not grant execution or autonomy.`]
      : []),
    ...(input.admissionExpired
      ? ["Admission evaluation expired and was ignored."]
      : []),
    ...(input.admissionMismatch
      ? ["Admission evaluation did not match this readiness snapshot and was ignored."]
      : []),
    ...(input.autonomyExpired
      ? ["Autonomy decision expired and was ignored."]
      : []),
    ...(input.autonomyMismatch
      ? ["Autonomy decision did not match this readiness/admission scope and was ignored."]
      : []),
    ...(input.autonomy?.level === "autonomous_low_risk" && input.autonomy.metadata.external_side_effect
      ? ["Autonomous low-risk projection requires internal non-external-effect evidence; execution was not elevated."]
      : []),
    ...(input.autonomy?.level === "user_directed_execute" && !input.autonomy.metadata.user_directed
      ? ["User-directed execution projection requires explicit user-directed evidence; execution was not elevated."]
      : []),
  ]);
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function isExpired(expiresAt: string, evaluatedAt: string): boolean {
  const expiresMs = Date.parse(expiresAt);
  const evaluatedMs = Date.parse(evaluatedAt);
  if (!Number.isFinite(expiresMs) || !Number.isFinite(evaluatedMs)) return true;
  return expiresMs <= evaluatedMs;
}

function validTimeString(value: string | undefined): value is string {
  return value !== undefined && Number.isFinite(Date.parse(value));
}
