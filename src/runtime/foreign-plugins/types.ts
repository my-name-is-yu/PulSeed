import { z } from "zod/v3";

export const ForeignPluginSourceSchema = z.enum(["hermes", "openclaw"]);
export type ForeignPluginSource = z.infer<typeof ForeignPluginSourceSchema>;

export const ForeignPluginCompatibilityStatusSchema = z.enum(["convertible", "quarantined", "incompatible"]);
export type ForeignPluginCompatibilityStatus = z.infer<typeof ForeignPluginCompatibilityStatusSchema>;

export const ForeignPluginReviewStatusSchema = z.enum([
  "pending_operator_review",
  "approved_for_conversion",
  "rejected",
  "needs_changes",
]);
export type ForeignPluginReviewStatus = z.infer<typeof ForeignPluginReviewStatusSchema>;

export const ForeignPluginExecutionBlockerSchema = z.enum([
  "foreign_plugin_imported_disabled",
  "manifest_incompatible",
  "operator_review_required",
  "adapter_required",
  "smoke_verification_required",
  "requested_network_permission",
  "requested_file_read_permission",
  "requested_file_write_permission",
  "requested_shell_permission",
]);
export type ForeignPluginExecutionBlocker = z.infer<typeof ForeignPluginExecutionBlockerSchema>;

export const ForeignPluginAdapterRequirementKindSchema = z.enum([
  "native_plugin_conversion",
  "compatibility_adapter",
  "mcp_or_cli_bridge",
]);
export type ForeignPluginAdapterRequirementKind = z.infer<typeof ForeignPluginAdapterRequirementKindSchema>;

export const ForeignPluginSideEffectProfileSchema = z.enum(["read", "send", "write", "publish", "delete", "mutate"]);
export type ForeignPluginSideEffectProfile = z.infer<typeof ForeignPluginSideEffectProfileSchema>;

export const ForeignPluginPermissionsSchema = z.object({
  network: z.boolean(),
  file_read: z.boolean(),
  file_write: z.boolean(),
  shell: z.boolean(),
});
export type ForeignPluginPermissions = z.infer<typeof ForeignPluginPermissionsSchema>;

export const ForeignPluginManifestSummarySchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  type: z.string().min(1),
  capabilities: z.array(z.string().min(1)).min(1),
  description: z.string().min(1),
  entry_point: z.string().min(1),
});
export type ForeignPluginManifestSummary = z.infer<typeof ForeignPluginManifestSummarySchema>;

export const ForeignPluginSourceProvenanceSchema = z.object({
  source_path: z.string().min(1).optional(),
  imported_path: z.string().min(1).optional(),
  directory_checksum: z.string().min(1).optional(),
  manifest_path: z.string().min(1).optional(),
  recorded_at: z.string().datetime().optional(),
});
export type ForeignPluginSourceProvenance = z.infer<typeof ForeignPluginSourceProvenanceSchema>;

export const ForeignPluginAdapterRequirementSchema = z.object({
  kind: ForeignPluginAdapterRequirementKindSchema,
  required: z.literal(true),
  reason: z.string().min(1),
});
export type ForeignPluginAdapterRequirement = z.infer<typeof ForeignPluginAdapterRequirementSchema>;

export const ForeignPluginSmokeRequirementSchema = z.object({
  operation_kind: z.string().min(1),
  payload_class: z.string().min(1),
  risk_class: z.enum(["low", "medium", "high"]),
  side_effect_profile: ForeignPluginSideEffectProfileSchema,
  required: z.literal(true),
});
export type ForeignPluginSmokeRequirement = z.infer<typeof ForeignPluginSmokeRequirementSchema>;

export const ForeignPluginCompatibilityReportSchema = z.object({
  schema_version: z.literal("foreign-plugin-compatibility/v1"),
  source: ForeignPluginSourceSchema,
  status: ForeignPluginCompatibilityStatusSchema,
  runtime_loadable: z.literal(false),
  issues: z.array(z.string()),
  permissions: ForeignPluginPermissionsSchema,
  execution_blockers: z.array(ForeignPluginExecutionBlockerSchema),
  adapter_requirements: z.array(ForeignPluginAdapterRequirementSchema),
  smoke_requirements: z.array(ForeignPluginSmokeRequirementSchema),
  source_provenance: ForeignPluginSourceProvenanceSchema.optional(),
  manifestPath: z.string().min(1).optional(),
  manifest: ForeignPluginManifestSummarySchema.optional(),
});
export type ForeignPluginCompatibilityReport = z.infer<typeof ForeignPluginCompatibilityReportSchema>;

export const CompatibilityReviewRecordSchema = z.object({
  schema_version: z.literal("foreign-plugin-review/v1"),
  source: ForeignPluginSourceSchema,
  plugin_name: z.string().min(1),
  status: ForeignPluginReviewStatusSchema,
  report_ref: z.string().min(1),
  runtime_loadable: z.literal(false),
  load_authority: z.literal("not_granted"),
  requested_permissions: ForeignPluginPermissionsSchema,
  execution_blockers: z.array(ForeignPluginExecutionBlockerSchema),
  created_at: z.string().datetime(),
  reviewed_at: z.string().datetime().optional(),
  reviewer: z.string().min(1).optional(),
  notes: z.string().min(1).optional(),
});
export type CompatibilityReviewRecord = z.infer<typeof CompatibilityReviewRecordSchema>;
