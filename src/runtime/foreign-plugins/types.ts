export type ForeignPluginSource = "hermes" | "openclaw";

export type ForeignPluginCompatibilityStatus = "convertible" | "quarantined" | "incompatible";

export type ForeignPluginReviewStatus =
  | "pending_operator_review"
  | "approved_for_conversion"
  | "rejected"
  | "needs_changes";

export type ForeignPluginExecutionBlocker =
  | "foreign_plugin_imported_disabled"
  | "manifest_incompatible"
  | "operator_review_required"
  | "adapter_required"
  | "smoke_verification_required"
  | "requested_network_permission"
  | "requested_file_read_permission"
  | "requested_file_write_permission"
  | "requested_shell_permission";

export type ForeignPluginAdapterRequirementKind =
  | "native_plugin_conversion"
  | "compatibility_adapter"
  | "mcp_or_cli_bridge";

export type ForeignPluginSideEffectProfile =
  | "read"
  | "send"
  | "write"
  | "publish"
  | "delete"
  | "mutate";

export interface ForeignPluginPermissions {
  network: boolean;
  file_read: boolean;
  file_write: boolean;
  shell: boolean;
}

export interface ForeignPluginManifestSummary {
  name: string;
  version: string;
  type: string;
  capabilities: string[];
  description: string;
  entry_point: string;
}

export interface ForeignPluginSourceProvenance {
  source_path?: string;
  imported_path?: string;
  directory_checksum?: string;
  manifest_path?: string;
  recorded_at?: string;
}

export interface ForeignPluginAdapterRequirement {
  kind: ForeignPluginAdapterRequirementKind;
  required: true;
  reason: string;
}

export interface ForeignPluginSmokeRequirement {
  operation_kind: string;
  payload_class: string;
  risk_class: "low" | "medium" | "high";
  side_effect_profile: ForeignPluginSideEffectProfile;
  required: true;
}

export interface ForeignPluginCompatibilityReport {
  schema_version: "foreign-plugin-compatibility/v1";
  source: ForeignPluginSource;
  status: ForeignPluginCompatibilityStatus;
  runtime_loadable: false;
  issues: string[];
  permissions: ForeignPluginPermissions;
  execution_blockers: ForeignPluginExecutionBlocker[];
  adapter_requirements: ForeignPluginAdapterRequirement[];
  smoke_requirements: ForeignPluginSmokeRequirement[];
  source_provenance?: ForeignPluginSourceProvenance;
  manifestPath?: string;
  manifest?: ForeignPluginManifestSummary;
}

export interface CompatibilityReviewRecord {
  schema_version: "foreign-plugin-review/v1";
  source: ForeignPluginSource;
  plugin_name: string;
  status: ForeignPluginReviewStatus;
  report_ref: string;
  runtime_loadable: false;
  load_authority: "not_granted";
  requested_permissions: ForeignPluginPermissions;
  execution_blockers: ForeignPluginExecutionBlocker[];
  created_at: string;
  reviewed_at?: string;
  reviewer?: string;
  notes?: string;
}
