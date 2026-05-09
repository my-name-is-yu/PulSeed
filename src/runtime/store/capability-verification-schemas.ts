import { z } from "zod";

export const CapabilityVerificationClassSchema = z.enum([
  "parse_validation",
  "manifest_validation",
  "configuration_validation",
  "auth_probe",
  "permission_probe",
  "smoke_execution",
  "production_caller_path",
  "post_execution_verification",
  "reuse_outcome",
  "operator_review",
]);
export type CapabilityVerificationClass = z.infer<typeof CapabilityVerificationClassSchema>;

export const CapabilityVerificationResultSchema = z.enum([
  "passed",
  "failed",
  "degraded",
  "revoked",
  "corrected",
]);
export type CapabilityVerificationResult = z.infer<typeof CapabilityVerificationResultSchema>;

export const CapabilityEvidenceStageSchema = z.enum([
  "imported",
  "parsed",
  "loaded",
  "configured",
  "smoke_verified",
  "production_succeeded",
  "production_failed",
  "user_corrected",
  "revoked",
]);
export type CapabilityEvidenceStage = z.infer<typeof CapabilityEvidenceStageSchema>;

export const CapabilityOperationKindSchema = z.enum([
  "read",
  "search",
  "hint",
  "prepare",
  "send",
  "write",
  "publish",
  "delete",
  "mutate",
  "run",
]);
export type CapabilityOperationKind = z.infer<typeof CapabilityOperationKindSchema>;

export const CapabilityRiskClassSchema = z.enum(["low", "medium", "high"]);
export type CapabilityRiskClass = z.infer<typeof CapabilityRiskClassSchema>;

export const CapabilitySideEffectProfileSchema = z.enum([
  "none",
  "read",
  "send",
  "write",
  "publish",
  "delete",
  "mutate",
]);
export type CapabilitySideEffectProfile = z.infer<typeof CapabilitySideEffectProfileSchema>;

export const CapabilityVerificationRefSchema = z.object({
  schema_version: z.literal("capability-verification-ref/v1"),
  verification_id: z.string().min(1),
  provider_ref: z.string().min(1),
  asset_ref: z.string().min(1),
  capability_id: z.string().min(1),
  operation_kind: CapabilityOperationKindSchema,
  tool_name: z.string().min(1),
  payload_class: z.string().min(1),
  risk_class: CapabilityRiskClassSchema,
  side_effect_profile: CapabilitySideEffectProfileSchema,
  verification_class: CapabilityVerificationClassSchema,
  result: CapabilityVerificationResultSchema,
  evidence_stage: CapabilityEvidenceStageSchema,
  evidence_ref: z.string().min(1).optional(),
  expires_at: z.string().min(1).optional(),
  created_at: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).default({}),
}).strict();
export type CapabilityVerificationRef = z.infer<typeof CapabilityVerificationRefSchema>;

export const CapabilityAuditResultSchema = z.enum([
  "succeeded",
  "failed",
  "blocked",
  "degraded",
  "corrected",
  "revoked",
]);
export type CapabilityAuditResult = z.infer<typeof CapabilityAuditResultSchema>;

export const CapabilityAuditRecordSchema = z.object({
  schema_version: z.literal("capability-audit-record/v1"),
  audit_id: z.string().min(1),
  operation_id: z.string().min(1),
  user_directed: z.boolean(),
  initiated_by: z.string().min(1),
  source_surface: z.string().min(1),
  capability_refs: z.array(z.string().min(1)).default([]),
  provider_refs: z.array(z.string().min(1)).default([]),
  readiness_snapshot_refs: z.array(z.string().min(1)).default([]),
  autonomy_decision_ref: z.string().min(1).optional(),
  approval_refs: z.array(z.string().min(1)).default([]),
  execution_refs: z.array(z.string().min(1)).default([]),
  verification_refs: z.array(z.string().min(1)).default([]),
  result: CapabilityAuditResultSchema,
  side_effect_summary: z.string().min(1),
  user_visible_effect: z.string().min(1),
  follow_up_policy_effect: z.enum([
    "none",
    "record_only",
    "degrade_readiness_evidence",
    "revoke_readiness_evidence",
    "requires_operator_review",
  ]),
  created_at: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).default({}),
}).strict();
export type CapabilityAuditRecord = z.infer<typeof CapabilityAuditRecordSchema>;

export const CapabilityReadinessEvidenceEffectSchema = z.enum([
  "none",
  "supports_readiness",
  "degrades_readiness",
  "revokes_readiness",
]);
export type CapabilityReadinessEvidenceEffect = z.infer<typeof CapabilityReadinessEvidenceEffectSchema>;

export const CapabilityVerificationEvidenceSummarySchema = z.object({
  verification_id: z.string().min(1),
  capability_id: z.string().min(1),
  provider_ref: z.string().min(1),
  asset_ref: z.string().min(1),
  operation_kind: CapabilityOperationKindSchema,
  tool_name: z.string().min(1),
  payload_class: z.string().min(1),
  risk_class: CapabilityRiskClassSchema,
  side_effect_profile: CapabilitySideEffectProfileSchema,
  verification_class: CapabilityVerificationClassSchema,
  evidence_stage: CapabilityEvidenceStageSchema,
  result: CapabilityVerificationResultSchema,
  readiness_effect: CapabilityReadinessEvidenceEffectSchema,
  expires_at: z.string().min(1).optional(),
}).strict();
export type CapabilityVerificationEvidenceSummary = z.infer<typeof CapabilityVerificationEvidenceSummarySchema>;

export function readinessEvidenceEffect(
  record: CapabilityVerificationRef
): CapabilityReadinessEvidenceEffect {
  if (record.verification_class === "permission_probe") return "none";
  if (record.result === "revoked") return "revokes_readiness";
  if (record.evidence_stage === "revoked") return "revokes_readiness";
  if (record.evidence_stage === "production_failed") return "degrades_readiness";
  if (record.result === "failed" || record.result === "degraded") return "degrades_readiness";
  if (
    record.evidence_stage === "smoke_verified"
    || record.evidence_stage === "production_succeeded"
    || record.evidence_stage === "configured"
    || record.evidence_stage === "loaded"
    || record.evidence_stage === "parsed"
  ) {
    return "supports_readiness";
  }
  return "none";
}
