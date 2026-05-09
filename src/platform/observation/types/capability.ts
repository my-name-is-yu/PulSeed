import { z } from "zod";

// --- Capability ---

export const CapabilityTypeEnum = z.enum(["tool", "permission", "service", "data_source"]);
export type CapabilityType = z.infer<typeof CapabilityTypeEnum>;

export const CapabilityStatusEnum = z.enum(["available", "missing", "requested", "acquiring", "verification_failed"]);
export type CapabilityStatus = z.infer<typeof CapabilityStatusEnum>;

// --- Acquisition Context (defined before CapabilitySchema to allow reference) ---

export const AcquisitionMethodEnum = z.enum(["tool_creation", "permission_request", "service_setup", "data_source_setup"]);
export type AcquisitionMethod = z.infer<typeof AcquisitionMethodEnum>;

export const AcquisitionContextSchema = z.object({
  goal_id: z.string(),
  originating_task_id: z.string().optional(),
  acquired_at: z.string(),
  notes: z.string().optional(),
});
export type AcquisitionContext = z.infer<typeof AcquisitionContextSchema>;

export const CapabilitySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  type: CapabilityTypeEnum,
  status: CapabilityStatusEnum,
  provider: z.string().optional(),
  acquired_at: z.string().optional(),
  acquisition_context: AcquisitionContextSchema.optional(),
});
export type Capability = z.infer<typeof CapabilitySchema>;

// --- Capability Registry ---

export const CapabilityRegistrySchema = z.object({
  capabilities: z.array(CapabilitySchema),
  last_checked: z.string(), // ISO timestamp
});
export type CapabilityRegistry = z.infer<typeof CapabilityRegistrySchema>;

// --- Capability Gap ---

export const CapabilityGapSchema = z.object({
  missing_capability: z.object({
    name: z.string(),
    type: CapabilityTypeEnum,
  }),
  reason: z.string(),
  alternatives: z.array(z.string()),
  impact_description: z.string(),
  related_task_id: z.string().optional(),
});
export type CapabilityGap = z.infer<typeof CapabilityGapSchema>;

// --- Capability Acquisition ---

export const CapabilityAcquisitionTaskSchema = z.object({
  gap: CapabilityGapSchema,
  method: AcquisitionMethodEnum,
  task_description: z.string(),
  success_criteria: z.array(z.string()),
  verification_attempts: z.number().default(0),
  max_verification_attempts: z.number().default(3),
});
export type CapabilityAcquisitionTask = z.infer<typeof CapabilityAcquisitionTaskSchema>;

export const CapabilityDependencySchema = z.object({
  capability_id: z.string(),
  depends_on: z.array(z.string()),
});
export type CapabilityDependency = z.infer<typeof CapabilityDependencySchema>;

export const CapabilityVerificationResultEnum = z.enum(["pass", "fail", "escalate"]);
export type CapabilityVerificationResult = z.infer<typeof CapabilityVerificationResultEnum>;

// --- Companion Capability Graph ---

export const CapabilityGraphProviderKindEnum = z.enum([
  "asset",
  "builtin_integration",
  "native_plugin",
  "foreign_plugin",
  "mcp_server",
  "interactive_automation_provider",
  "notifier",
  "soil_surface",
  "knowledge_surface",
  "dream_procedural_hint",
  "runtime_tool",
  "legacy_capability",
]);
export type CapabilityGraphProviderKind = z.infer<typeof CapabilityGraphProviderKindEnum>;

export const CapabilityOperationKindEnum = z.enum([
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
export type CapabilityOperationKind = z.infer<typeof CapabilityOperationKindEnum>;

export const CapabilitySideEffectProfileEnum = z.enum([
  "none",
  "read",
  "send",
  "write",
  "publish",
  "delete",
  "mutate",
]);
export type CapabilitySideEffectProfile = z.infer<typeof CapabilitySideEffectProfileEnum>;

export const CapabilityPrivacyProfileEnum = z.enum([
  "local_private",
  "workspace_private",
  "external_service",
  "user_visible",
]);
export type CapabilityPrivacyProfile = z.infer<typeof CapabilityPrivacyProfileEnum>;

export const CapabilityRiskProfileEnum = z.enum(["low", "medium", "high"]);
export type CapabilityRiskProfile = z.infer<typeof CapabilityRiskProfileEnum>;

export const CapabilityReversibilityProfileEnum = z.enum([
  "reversible",
  "append_only",
  "draft_only",
  "irreversible",
  "unknown",
]);
export type CapabilityReversibilityProfile = z.infer<typeof CapabilityReversibilityProfileEnum>;

export const CapabilityAuthorityScopeEnum = z.enum([
  "planning_hint_only",
  "internal_knowledge_only",
  "requires_runtime_selection",
]);
export type CapabilityAuthorityScope = z.infer<typeof CapabilityAuthorityScopeEnum>;

export const CapabilityVerificationProfileSchema = z.object({
  required: z.boolean(),
  profile: z.enum([
    "none",
    "operation_specific_smoke",
    "operation_specific_production_evidence",
    "audit_record",
  ]),
  evidence_ref: z.string().optional(),
});
export type CapabilityVerificationProfile = z.infer<typeof CapabilityVerificationProfileSchema>;

export const CapabilityProviderRefSchema = z.object({
  provider_id: z.string(),
  provider_kind: CapabilityGraphProviderKindEnum,
  asset_id: z.string().optional(),
  runtime_ref: z.string().optional(),
  status_ref: z.string().optional(),
});
export type CapabilityProviderRef = z.infer<typeof CapabilityProviderRefSchema>;

export const CapabilityRequirementRefSchema = z.object({
  kind: z.enum(["asset", "config", "auth", "admission", "permission", "verification", "runtime_state", "policy"]),
  ref: z.string(),
  reason: z.string(),
});
export type CapabilityRequirementRef = z.infer<typeof CapabilityRequirementRefSchema>;

export const CapabilityOperationContractSchema = z.object({
  id: z.string(),
  operation_kind: CapabilityOperationKindEnum,
  side_effect_profile: CapabilitySideEffectProfileEnum,
  privacy_profile: CapabilityPrivacyProfileEnum,
  risk_profile: CapabilityRiskProfileEnum,
  reversibility: CapabilityReversibilityProfileEnum,
  verification: CapabilityVerificationProfileSchema,
  authority_scope: CapabilityAuthorityScopeEnum,
  external_action_authority: z.boolean(),
  payload_class: z.string(),
  required: z.array(CapabilityRequirementRefSchema).default([]),
});
export type CapabilityOperationContract = z.infer<typeof CapabilityOperationContractSchema>;

export const CapabilityCandidateSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  providers: z.array(CapabilityProviderRefSchema).min(1),
  operations: z.array(CapabilityOperationContractSchema).min(1),
  source_refs: z.array(z.string()).default([]),
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type CapabilityCandidate = z.infer<typeof CapabilityCandidateSchema>;

export const CapabilityDependencyEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  kind: z.enum(["requires", "provides", "derived_from"]),
  reason: z.string(),
});
export type CapabilityDependencyEdge = z.infer<typeof CapabilityDependencyEdgeSchema>;

export const CapabilityGraphSchema = z.object({
  schema_version: z.literal("companion-capability-graph/v1"),
  generated_at: z.string(),
  candidates: z.array(CapabilityCandidateSchema),
  dependency_edges: z.array(CapabilityDependencyEdgeSchema),
});
export type CapabilityGraph = z.infer<typeof CapabilityGraphSchema>;
