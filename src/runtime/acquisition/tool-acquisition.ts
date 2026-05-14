import { createHash } from "node:crypto";
import { z } from "zod";
import {
  CapabilityAuthorityScopeEnum,
  CapabilityOperationContractSchema,
  CapabilityOperationKindEnum,
  CapabilityPrivacyProfileEnum,
  CapabilityReadinessSnapshotSchema,
  CapabilityReversibilityProfileEnum,
  CapabilityRiskProfileEnum,
  CapabilitySideEffectProfileEnum,
  CapabilityVerificationRefSchema,
  type CapabilityOperationContract,
  type CapabilityReadinessSnapshot,
  type CapabilityVerificationRef,
} from "../../platform/observation/types/capability.js";
import {
  CognitionEventRefSchema,
  CognitionRefSchema,
  ExternalDataScopeGrantSchema,
  PrivacyProfileSchema,
  SideEffectProfileSchema,
  type CognitionRef,
} from "../cognition/index.js";
import {
  AdmissionOperationScopeSchema,
  type AdmissionOperationScope,
} from "../control/admission-policy.js";
import {
  AutonomyOperationPlanSchema,
  type AutonomyOperationPlan,
} from "../control/autonomy-governor.js";
import { PermissionGrantCapabilitySchema } from "../store/permission-grant-store.js";
import {
  CapabilityOperationPlanCandidateSchema,
  type CapabilityOperationPlanCandidate,
} from "../types/capability-operation-plan.js";
import {
  ForeignPluginCompatibilityReportSchema,
  type ForeignPluginCompatibilityReport,
} from "../foreign-plugins/types.js";

export const ToolNeedSchema = z.object({
  need_id: z.string().min(1),
  goal_ref: CognitionRefSchema.optional(),
  task_ref: CognitionRefSchema.optional(),
  missing_capability: z.string().min(1),
  evidence_refs: z.array(CognitionEventRefSchema).min(1),
  acceptable_alternatives: z.array(z.string().min(1)).default([]),
  stop_if_unavailable: z.boolean(),
}).strict();
export type ToolNeed = z.infer<typeof ToolNeedSchema>;

export const CredentialRequirementSchema = z.object({
  credential_id: z.string().min(1),
  provider: z.string().min(1),
  requested_scopes: z.array(z.string().min(1)).min(1),
  storage_owner: z.enum(["user_keychain", "external_oauth", "env_exception", "pulseed_config_exception"]),
  user_must_supply: z.literal(true),
  can_be_inferred_or_scraped: z.literal(false),
  secret_material_stored_in_pulseed_records: z.literal(false),
  rotation_guidance_ref: z.string().min(1).optional(),
}).strict();
export type CredentialRequirement = z.infer<typeof CredentialRequirementSchema>;

export const CostProfileSchema = z.object({
  billing_owner: z.enum(["user", "workspace", "unknown"]),
  cost_kind: z.enum(["none", "one_time", "metered", "subscription", "unknown"]),
  hard_limit: z.string().min(1).optional(),
  requires_user_cost_ack: z.boolean(),
}).strict().superRefine((profile, ctx) => {
  if (
    (profile.billing_owner === "unknown" || profile.cost_kind === "unknown" || profile.cost_kind === "metered" || profile.cost_kind === "subscription")
    && !profile.requires_user_cost_ack
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["requires_user_cost_ack"],
      message: "unknown, metered, or subscription cost requires explicit user cost acknowledgment",
    });
  }
});
export type CostProfile = z.infer<typeof CostProfileSchema>;

export const CandidateToolAcquisitionSourceSchema = z.enum([
  "native_plugin",
  "foreign_plugin",
  "mcp_server",
  "cli_tool",
  "local_build",
  "external_service",
]);
export type CandidateToolAcquisitionSource = z.infer<typeof CandidateToolAcquisitionSourceSchema>;

export const CandidateToolAcquisitionOperationScopeSchema = z.object({
  provider_ref: z.string().min(1),
  capability_id: z.string().min(1),
  asset_ref: z.string().min(1),
  operation_id: z.string().min(1),
  operation_kind: CapabilityOperationKindEnum,
  tool_name: z.string().min(1),
  payload_class: z.string().min(1),
  risk_profile: CapabilityRiskProfileEnum,
  side_effect_profile: CapabilitySideEffectProfileEnum,
  privacy_profile: CapabilityPrivacyProfileEnum,
  reversibility: CapabilityReversibilityProfileEnum,
  authority_scope: CapabilityAuthorityScopeEnum,
  external_action_authority: z.boolean(),
  cognition_side_effect_profile: SideEffectProfileSchema,
  cognition_privacy_profile: PrivacyProfileSchema,
  permission_capabilities: z.array(PermissionGrantCapabilitySchema).default([]),
}).strict();
export type CandidateToolAcquisitionOperationScope = z.infer<typeof CandidateToolAcquisitionOperationScopeSchema>;

export const CandidateToolAcquisitionSchema = z.object({
  candidate_id: z.string().min(1),
  source: CandidateToolAcquisitionSourceSchema,
  source_ref: z.string().min(1),
  manifest_ref: z.string().min(1).optional(),
  manifest_digest: z.string().min(1).optional(),
  operation_scope: CandidateToolAcquisitionOperationScopeSchema,
  side_effect_profile: SideEffectProfileSchema,
  privacy_profile: PrivacyProfileSchema,
  capability_operation_contract_ref: CognitionRefSchema.optional(),
  admission_operation_scope_ref: CognitionRefSchema.optional(),
  trust_boundary_ref: z.string().min(1),
  credential_requirements: z.array(CredentialRequirementSchema).default([]),
  cost_profile: CostProfileSchema,
  cost_ack_ref: CognitionRefSchema.optional(),
  rollback_plan_ref: z.string().min(1),
  audit_refs: z.array(CognitionRefSchema).default([]),
  default_runtime_loadable: z.literal(false),
}).strict().superRefine((candidate, ctx) => {
  if (candidate.side_effect_profile !== candidate.operation_scope.cognition_side_effect_profile) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["side_effect_profile"],
      message: "top-level acquisition side effect profile must match operation-scope cognition classification",
    });
  }
  if (candidate.privacy_profile !== candidate.operation_scope.cognition_privacy_profile) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["privacy_profile"],
      message: "top-level acquisition privacy profile must match operation-scope cognition classification",
    });
  }
  if (candidate.source === "external_service" && candidate.privacy_profile !== "external_service") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["privacy_profile"],
      message: "external service acquisitions must carry external_service privacy",
    });
  }
});
export type CandidateToolAcquisition = z.infer<typeof CandidateToolAcquisitionSchema>;

export const McpServerAcquisitionProposalSchema = z.object({
  schema_version: z.literal("mcp-server-acquisition-proposal/v1"),
  proposal_id: z.string().min(1),
  candidate: CandidateToolAcquisitionSchema,
  command_ref: z.string().min(1),
  command_display: z.string().min(1),
  args: z.array(z.string()).default([]),
  config_fingerprint: z.string().min(1),
  process_lifecycle: z.enum(["one_shot", "persistent", "user_started"]),
  credential_requirements: z.array(CredentialRequirementSchema).default([]),
  data_scope_grants: z.array(ExternalDataScopeGrantSchema).default([]),
  secret_values_present: z.literal(false),
  default_runtime_loadable: z.literal(false),
}).strict().superRefine((proposal, ctx) => {
  if (proposal.candidate.source !== "mcp_server") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["candidate", "source"],
      message: "MCP server acquisition proposals require an mcp_server candidate",
    });
  }
});
export type McpServerAcquisitionProposal = z.infer<typeof McpServerAcquisitionProposalSchema>;

export const ToolAcquisitionApprovalEnvelopeSchema = z.object({
  schema_version: z.literal("tool-acquisition-approval-envelope/v1"),
  approval_ref: CognitionRefSchema,
  approval_kind: z.enum([
    "install_or_enable_code",
    "start_persistent_process",
    "credential_use",
    "external_data_transfer",
    "cost_acknowledgment",
    "promote_runtime_loadable",
  ]),
  proposal_ref: z.string().min(1),
  proposal_fingerprint: z.string().min(1),
  approved_at: z.string().datetime(),
  expires_at: z.string().datetime(),
  approver_ref: CognitionRefSchema,
  runtime_authority: z.literal(false).default(false),
}).strict();
export type ToolAcquisitionApprovalEnvelope = z.infer<typeof ToolAcquisitionApprovalEnvelopeSchema>;

export const ToolAcquisitionLifecycleRecordSchema = z.object({
  schema_version: z.literal("tool-acquisition-lifecycle/v1"),
  acquisition_ref: z.string().min(1),
  state: z.enum([
    "proposed",
    "approved",
    "quarantine_installed",
    "verification_recorded",
    "readiness_derived",
    "retired",
  ]),
  proposal: CandidateToolAcquisitionSchema,
  approval_refs: z.array(CognitionRefSchema).default([]),
  verification_refs: z.array(z.string().min(1)).default([]),
  readiness_refs: z.array(z.string().min(1)).default([]),
  rollback_plan_ref: z.string().min(1),
  runtime_loadable: z.literal(false),
  capability_registry_authority: z.literal(false),
  execution_authority: z.literal(false),
  audit_refs: z.array(CognitionRefSchema).default([]),
}).strict();
export type ToolAcquisitionLifecycleRecord = z.infer<typeof ToolAcquisitionLifecycleRecordSchema>;

export const ToolAcquisitionApprovalValidationSchema = z.object({
  valid: z.boolean(),
  reason: z.string().min(1),
  runtime_authority: z.literal(false).default(false),
}).strict();
export type ToolAcquisitionApprovalValidation = z.infer<typeof ToolAcquisitionApprovalValidationSchema>;

export const ToolAcquisitionSurfaceProjectionSchema = z.object({
  schema_version: z.literal("tool-acquisition-surface-projection/v1"),
  surface_target: z.enum(["normal_user", "operator_debug"]),
  candidate_id: z.string().min(1),
  source: CandidateToolAcquisitionSourceSchema,
  operation_id: z.string().min(1),
  approval_required: z.literal(true),
  cost_ack_required: z.boolean(),
  rollback_plan_ref: z.string().min(1),
  secret_material_visible: z.literal(false),
  normal_runtime_loadable: z.literal(false),
  operator_refs: z.object({
    trust_boundary_ref: z.string().min(1),
    audit_refs: z.array(CognitionRefSchema).default([]),
    credential_requirement_ids: z.array(z.string().min(1)).default([]),
  }).strict().optional(),
}).strict();
export type ToolAcquisitionSurfaceProjection = z.infer<typeof ToolAcquisitionSurfaceProjectionSchema>;

export interface RuntimeAcquisitionAdapterOutput {
  capability_operation_contract: CapabilityOperationContract;
  capability_verification_ref: CapabilityVerificationRef;
  readiness_snapshot: CapabilityReadinessSnapshot;
  admission_operation_scope: AdmissionOperationScope;
  autonomy_operation_plan: AutonomyOperationPlan;
  operation_plan_candidate: CapabilityOperationPlanCandidate;
}

export function createCandidateToolAcquisition(input: z.input<typeof CandidateToolAcquisitionSchema>): CandidateToolAcquisition {
  return CandidateToolAcquisitionSchema.parse(input);
}

export function candidateToolAcquisitionFromForeignPluginCompatibility(input: {
  candidateId: string;
  report: ForeignPluginCompatibilityReport;
  trustBoundaryRef: string;
  rollbackPlanRef: string;
  costProfile?: CostProfile;
  auditRefs?: CognitionRef[];
}): CandidateToolAcquisition {
  const report = ForeignPluginCompatibilityReportSchema.parse(input.report);
  const manifest = report.manifest;
  const capabilityId = manifest?.name ?? `${report.source}:foreign-plugin`;
  const sideEffect = manifest?.type === "notifier" ? "send" : manifest?.type === "data_source" ? "read" : "mutate";
  const riskProfile = sideEffect === "read" ? "low" : "medium";
  return CandidateToolAcquisitionSchema.parse({
    candidate_id: input.candidateId,
    source: "foreign_plugin",
    source_ref: report.source_provenance?.imported_path ?? report.manifestPath ?? `${report.source}:${capabilityId}`,
    manifest_ref: report.manifestPath,
    manifest_digest: report.source_provenance?.directory_checksum,
    operation_scope: {
      provider_ref: `foreign-plugin:${report.source}`,
      capability_id: capabilityId,
      asset_ref: report.source_provenance?.imported_path ?? report.manifestPath ?? capabilityId,
      operation_id: `${capabilityId}:review-import`,
      operation_kind: sideEffect === "read" ? "read" : "prepare",
      tool_name: capabilityId,
      payload_class: "foreign_plugin_manifest",
      risk_profile: riskProfile,
      side_effect_profile: sideEffect,
      privacy_profile: report.permissions.network ? "external_service" : "workspace_private",
      reversibility: "draft_only",
      authority_scope: "requires_runtime_selection",
      external_action_authority: false,
      cognition_side_effect_profile: report.permissions.network ? "cloud_compute" : "read",
      cognition_privacy_profile: report.permissions.network ? "external_service" : "workspace_private",
    },
    side_effect_profile: report.permissions.network ? "cloud_compute" : "read",
    privacy_profile: report.permissions.network ? "external_service" : "workspace_private",
    trust_boundary_ref: input.trustBoundaryRef,
    credential_requirements: [],
    cost_profile: input.costProfile ?? {
      billing_owner: "user",
      cost_kind: "none",
      requires_user_cost_ack: false,
    },
    rollback_plan_ref: input.rollbackPlanRef,
    audit_refs: input.auditRefs ?? [],
    default_runtime_loadable: false,
  });
}

export function computeAcquisitionProposalFingerprint(proposal: CandidateToolAcquisition): string {
  const parsed = CandidateToolAcquisitionSchema.parse(proposal);
  return createHash("sha256").update(stableStringify(parsed)).digest("hex");
}

export function createToolAcquisitionApprovalEnvelope(input: {
  proposal: CandidateToolAcquisition;
  approvalRef: CognitionRef;
  approvalKind: ToolAcquisitionApprovalEnvelope["approval_kind"];
  approvedAt: string;
  expiresAt: string;
  approverRef: CognitionRef;
}): ToolAcquisitionApprovalEnvelope {
  const proposal = CandidateToolAcquisitionSchema.parse(input.proposal);
  return ToolAcquisitionApprovalEnvelopeSchema.parse({
    schema_version: "tool-acquisition-approval-envelope/v1",
    approval_ref: input.approvalRef,
    approval_kind: input.approvalKind,
    proposal_ref: proposal.candidate_id,
    proposal_fingerprint: computeAcquisitionProposalFingerprint(proposal),
    approved_at: input.approvedAt,
    expires_at: input.expiresAt,
    approver_ref: input.approverRef,
    runtime_authority: false,
  });
}

export function validateToolAcquisitionApproval(input: {
  proposal: CandidateToolAcquisition;
  envelope: ToolAcquisitionApprovalEnvelope;
  now: string;
}): ToolAcquisitionApprovalValidation {
  const proposal = CandidateToolAcquisitionSchema.parse(input.proposal);
  const envelope = ToolAcquisitionApprovalEnvelopeSchema.parse(input.envelope);
  if (envelope.proposal_ref !== proposal.candidate_id) {
    return approvalValidation(false, "approval proposal ref does not match acquisition proposal");
  }
  if (envelope.proposal_fingerprint !== computeAcquisitionProposalFingerprint(proposal)) {
    return approvalValidation(false, "approval proposal fingerprint is stale");
  }
  if (Date.parse(input.now) > Date.parse(envelope.expires_at)) {
    return approvalValidation(false, "approval envelope expired");
  }
  if (proposal.cost_profile.requires_user_cost_ack && !proposal.cost_ack_ref && envelope.approval_kind !== "cost_acknowledgment") {
    return approvalValidation(false, "cost acknowledgment is required before acquisition can proceed");
  }
  return approvalValidation(true, "approval envelope matches current acquisition proposal fingerprint");
}

export function renderToolAcquisitionSurfaceProjection(input: {
  proposal: CandidateToolAcquisition;
  surfaceTarget: "normal_user" | "operator_debug";
}): ToolAcquisitionSurfaceProjection {
  const proposal = CandidateToolAcquisitionSchema.parse(input.proposal);
  return ToolAcquisitionSurfaceProjectionSchema.parse({
    schema_version: "tool-acquisition-surface-projection/v1",
    surface_target: input.surfaceTarget,
    candidate_id: proposal.candidate_id,
    source: proposal.source,
    operation_id: proposal.operation_scope.operation_id,
    approval_required: true,
    cost_ack_required: proposal.cost_profile.requires_user_cost_ack && !proposal.cost_ack_ref,
    rollback_plan_ref: proposal.rollback_plan_ref,
    secret_material_visible: false,
    normal_runtime_loadable: false,
    ...(input.surfaceTarget === "operator_debug" ? {
      operator_refs: {
        trust_boundary_ref: proposal.trust_boundary_ref,
        audit_refs: proposal.audit_refs,
        credential_requirement_ids: proposal.credential_requirements.map((credential) => credential.credential_id),
      },
    } : {}),
  });
}

export function adaptAcquisitionToRuntime(input: {
  acquisition: CandidateToolAcquisition;
  verificationRef: string;
  verificationResult: "pass" | "fail" | "escalate";
  evidenceRef: string;
  evaluatedAt: string;
}): RuntimeAcquisitionAdapterOutput {
  const acquisition = CandidateToolAcquisitionSchema.parse(input.acquisition);
  const scope = acquisition.operation_scope;
  const capabilityOperationContract = CapabilityOperationContractSchema.parse({
    id: scope.operation_id,
    operation_kind: scope.operation_kind,
    side_effect_profile: scope.side_effect_profile,
    privacy_profile: scope.privacy_profile,
    risk_profile: scope.risk_profile,
    reversibility: scope.reversibility,
    verification: {
      required: true,
      profile: "operation_specific_smoke",
      evidence_ref: input.evidenceRef,
    },
    authority_scope: scope.authority_scope,
    external_action_authority: scope.external_action_authority,
    payload_class: scope.payload_class,
    required: requiredRefsForAcquisition(acquisition, input.verificationRef),
  });
  const capabilityVerificationRef = CapabilityVerificationRefSchema.parse({
    schema_version: "capability-verification-ref/v1",
    verification_ref: input.verificationRef,
    provider_ref: scope.provider_ref,
    asset_ref: scope.asset_ref,
    capability_id: scope.capability_id,
    operation_id: scope.operation_id,
    operation_kind: scope.operation_kind,
    tool_name: scope.tool_name,
    payload_class: scope.payload_class,
    risk_class: scope.risk_profile,
    side_effect_profile: scope.side_effect_profile,
    result: input.verificationResult,
    evidence_ref: input.evidenceRef,
  });
  const blockedByCost = acquisition.cost_profile.requires_user_cost_ack && !acquisition.cost_ack_ref;
  const verified = input.verificationResult === "pass" && !blockedByCost;
  const readinessSnapshot = CapabilityReadinessSnapshotSchema.parse({
    schema_version: "capability-readiness-snapshot/v1",
    snapshot_id: `${scope.operation_id}:readiness:${input.evaluatedAt}`,
    capability_id: scope.capability_id,
    provider_ref: scope.provider_ref,
    asset_ref: scope.asset_ref,
    operation_id: scope.operation_id,
    operation_kind: scope.operation_kind,
    tool_name: scope.tool_name,
    payload_class: scope.payload_class,
    risk_class: scope.risk_profile,
    side_effect_profile: scope.side_effect_profile,
    evaluated_at: input.evaluatedAt,
    state: verified ? "executable_verified" : "blocked",
    passed_gates: verified
      ? ["stored", "discoverable", "loadable", "compatible", "configured", "authenticated", "executable_verified"]
      : ["stored", "discoverable", "compatible"],
    failed_gates: verified ? [] : ["blocked"],
    verification_refs: [input.verificationRef],
    evidence_refs: [input.evidenceRef],
    safe_user_visible_label: verified ? "Execution substrate verified" : "Blocked",
    metadata: {
      acquisition_candidate_id: acquisition.candidate_id,
      approval_is_runtime_authority: false,
      cost_ack_required: blockedByCost,
    },
  });
  const admissionOperationScope = AdmissionOperationScopeSchema.parse({
    operation_id: scope.operation_id,
    capability_id: scope.capability_id,
    operation_kind: scope.operation_kind,
    provider_ref: scope.provider_ref,
    asset_ref: scope.asset_ref,
    tool_name: scope.tool_name,
    payload_class: scope.payload_class,
    payload_epoch: acquisition.manifest_digest,
    side_effect_profile: scope.side_effect_profile,
    external_action_authority: scope.external_action_authority,
    requires_runtime_control: true,
    required_permission_capabilities: scope.permission_capabilities,
    target_refs: [scope.asset_ref],
    target_epoch_refs: acquisition.manifest_digest ? { [scope.asset_ref]: acquisition.manifest_digest } : {},
  });
  const autonomyOperationPlan = AutonomyOperationPlanSchema.parse({
    operation_id: scope.operation_id,
    capability_id: scope.capability_id,
    operation_kind: scope.operation_kind,
    provider_ref: scope.provider_ref,
    payload_class: scope.payload_class,
    side_effect_profile: scope.side_effect_profile,
    risk_class: scope.risk_profile,
    privacy_profile: scope.privacy_profile,
    reversibility: scope.reversibility,
    external_action_authority: scope.external_action_authority,
    target_refs: [scope.asset_ref],
    advisory_only: false,
    preparable_when_blocked: true,
    setup_guidance_ref: acquisition.rollback_plan_ref,
    local_only: acquisition.privacy_profile !== "external_service",
    inspectable: true,
    expected_user_visible_effect: scope.side_effect_profile !== "none",
  });
  const operationPlanCandidate = CapabilityOperationPlanCandidateSchema.parse({
    plan_id: `${scope.operation_id}:acquisition-runtime-plan`,
    source_ref: acquisition.candidate_id,
    operation_plan: autonomyOperationPlan,
    admission_scope: admissionOperationScope,
    readiness_snapshot_refs: [readinessSnapshot.snapshot_id],
    required_approvals: [
      ...acquisition.credential_requirements.map((credential) => credential.credential_id),
      ...(blockedByCost ? ["cost_acknowledgment"] : []),
    ],
    reversible_preparation_steps: ["quarantine_install_or_build", "smoke_verify", "derive_readiness_snapshot"],
    not_allowed_steps: [
      "install_without_user_approval",
      "credential_inference_or_scraping",
      "runtime_execution_without_admission_and_autonomy",
    ],
    user_visible_summary: `Review ${scope.tool_name} before it becomes available through runtime admission.`,
    audit_seed: {
      acquisition_candidate_id: acquisition.candidate_id,
      rollback_plan_ref: acquisition.rollback_plan_ref,
    },
  });
  return {
    capability_operation_contract: capabilityOperationContract,
    capability_verification_ref: capabilityVerificationRef,
    readiness_snapshot: readinessSnapshot,
    admission_operation_scope: admissionOperationScope,
    autonomy_operation_plan: autonomyOperationPlan,
    operation_plan_candidate: operationPlanCandidate,
  };
}

function requiredRefsForAcquisition(
  acquisition: CandidateToolAcquisition,
  verificationRef: string
): CapabilityOperationContract["required"] {
  return [
    { kind: "asset", ref: acquisition.operation_scope.asset_ref, reason: "Acquired asset must remain present and match the proposal fingerprint." },
    { kind: "verification", ref: verificationRef, reason: "Acquired capability requires operation-specific verification evidence." },
    { kind: "policy", ref: acquisition.rollback_plan_ref, reason: "Acquired capability requires a rollback and retirement plan." },
    ...acquisition.credential_requirements.map((credential) => ({
      kind: "auth" as const,
      ref: credential.credential_id,
      reason: "Credential requirement must be satisfied by a user-supplied secret handle, not model text.",
    })),
    ...(acquisition.cost_profile.requires_user_cost_ack ? [{
      kind: "policy" as const,
      ref: acquisition.cost_ack_ref?.ref ?? "cost_acknowledgment:missing",
      reason: "Unknown, metered, or subscription cost requires explicit user acknowledgment.",
    }] : []),
  ];
}

function approvalValidation(valid: boolean, reason: string): ToolAcquisitionApprovalValidation {
  return ToolAcquisitionApprovalValidationSchema.parse({
    valid,
    reason,
    runtime_authority: false,
  });
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
