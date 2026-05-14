import { describe, expect, it } from "vitest";
import { analyzeForeignPluginManifest } from "../../foreign-plugins/compatibility.js";
import {
  CandidateToolAcquisitionSchema,
  CredentialRequirementSchema,
  McpServerAcquisitionProposalSchema,
  ToolAcquisitionLifecycleRecordSchema,
  adaptAcquisitionToRuntime,
  candidateToolAcquisitionFromForeignPluginCompatibility,
  computeAcquisitionProposalFingerprint,
  createCandidateToolAcquisition,
  createToolAcquisitionApprovalEnvelope,
  renderToolAcquisitionSurfaceProjection,
  validateToolAcquisitionApproval,
  type CandidateToolAcquisition,
} from "../index.js";
import { evaluateAdmissionPolicy } from "../../control/admission-policy.js";
import { evaluateAutonomyDecision } from "../../control/autonomy-governor.js";
import { projectCompanionAction } from "../../control/companion-action-projection.js";
import { createCompanionGadgetPlan } from "../../decision/companion-gadget-planning.js";

const NOW = "2026-05-14T00:00:00.000Z";

function baseCredential() {
  return CredentialRequirementSchema.parse({
    credential_id: "credential:calendar-oauth",
    provider: "calendar-provider",
    requested_scopes: ["calendar.readonly"],
    storage_owner: "external_oauth",
    user_must_supply: true,
    can_be_inferred_or_scraped: false,
    secret_material_stored_in_pulseed_records: false,
    rotation_guidance_ref: "rotation:calendar-oauth",
  });
}

function baseAcquisition(overrides: Partial<CandidateToolAcquisition> = {}): CandidateToolAcquisition {
  return createCandidateToolAcquisition({
    candidate_id: "acquisition:mcp-calendar-read",
    source: "mcp_server",
    source_ref: "mcp:calendar",
    manifest_ref: "manifest:mcp-calendar",
    manifest_digest: "sha256:manifest-v1",
    operation_scope: {
      provider_ref: "mcp:calendar",
      capability_id: "calendar-read",
      asset_ref: "mcp-server:calendar",
      operation_id: "calendar.read",
      operation_kind: "read",
      tool_name: "calendar.read",
      payload_class: "calendar.query",
      risk_profile: "low",
      side_effect_profile: "read",
      privacy_profile: "external_service",
      reversibility: "reversible",
      authority_scope: "requires_runtime_selection",
      external_action_authority: false,
      cognition_side_effect_profile: "read",
      cognition_privacy_profile: "external_service",
      permission_capabilities: ["inspect_runtime"],
    },
    side_effect_profile: "read",
    privacy_profile: "external_service",
    trust_boundary_ref: "trust-boundary:mcp-calendar",
    credential_requirements: [baseCredential()],
    cost_profile: {
      billing_owner: "user",
      cost_kind: "none",
      requires_user_cost_ack: false,
    },
    rollback_plan_ref: "rollback:mcp-calendar",
    audit_refs: [{ kind: "audit", ref: "audit:mcp-calendar" }],
    default_runtime_loadable: false,
    ...overrides,
  });
}

describe("tool acquisition proposals", () => {
  it("keeps foreign plugin imports as non-runtime-loadable acquisition evidence", () => {
    const report = analyzeForeignPluginManifest("openclaw", {
      name: "calendar-bridge",
      version: "1.0.0",
      type: "data_source",
      capabilities: ["calendar.read"],
      description: "Read calendar availability.",
      entry_point: "dist/index.js",
      permissions: { network: true },
    }, {
      manifestPath: "quarantine/calendar-bridge/plugin.json",
      sourceProvenance: {
        imported_path: "quarantine/calendar-bridge",
        directory_checksum: "sha256:foreign-plugin",
      },
    });
    const proposal = candidateToolAcquisitionFromForeignPluginCompatibility({
      candidateId: "acquisition:foreign-calendar-bridge",
      report,
      trustBoundaryRef: "trust-boundary:foreign-plugin",
      rollbackPlanRef: "rollback:foreign-plugin",
    });
    const lifecycle = ToolAcquisitionLifecycleRecordSchema.parse({
      schema_version: "tool-acquisition-lifecycle/v1",
      acquisition_ref: proposal.candidate_id,
      state: "proposed",
      proposal,
      rollback_plan_ref: proposal.rollback_plan_ref,
      runtime_loadable: false,
      capability_registry_authority: false,
      execution_authority: false,
    });

    expect(report.runtime_loadable).toBe(false);
    expect(proposal).toMatchObject({
      source: "foreign_plugin",
      default_runtime_loadable: false,
      privacy_profile: "external_service",
    });
    expect(lifecycle).toMatchObject({
      runtime_loadable: false,
      capability_registry_authority: false,
      execution_authority: false,
    });
  });

  it("classifies schedule-source foreign plugin imports as read-only acquisition evidence", () => {
    const report = analyzeForeignPluginManifest("openclaw", {
      name: "calendar-schedule-source",
      version: "1.0.0",
      type: "schedule_source",
      capabilities: ["schedule.read"],
      description: "Read schedule entries from a foreign plugin.",
      entry_point: "dist/index.js",
      permissions: { network: false },
    }, {
      manifestPath: "quarantine/calendar-schedule-source/plugin.json",
      sourceProvenance: {
        imported_path: "quarantine/calendar-schedule-source",
        directory_checksum: "sha256:schedule-source",
      },
    });
    const proposal = candidateToolAcquisitionFromForeignPluginCompatibility({
      candidateId: "acquisition:foreign-calendar-schedule-source",
      report,
      trustBoundaryRef: "trust-boundary:foreign-plugin",
      rollbackPlanRef: "rollback:foreign-plugin",
    });

    expect(proposal.operation_scope).toMatchObject({
      operation_kind: "read",
      side_effect_profile: "read",
      risk_profile: "low",
      privacy_profile: "workspace_private",
    });
  });

  it("invalidates stale approval fingerprints when proposal fields change", () => {
    const proposal = baseAcquisition();
    const envelope = createToolAcquisitionApprovalEnvelope({
      proposal,
      approvalRef: { kind: "approval", ref: "approval:install-calendar" },
      approvalKind: "install_or_enable_code",
      approvedAt: NOW,
      expiresAt: "2026-05-14T01:00:00.000Z",
      approverRef: { kind: "user", ref: "user:yu" },
    });
    const modified = baseAcquisition({ manifest_digest: "sha256:manifest-v2" });

    expect(validateToolAcquisitionApproval({
      proposal,
      envelope,
      approvalKind: "install_or_enable_code",
      now: NOW,
    })).toMatchObject({ valid: true });
    expect(validateToolAcquisitionApproval({
      proposal: modified,
      envelope,
      approvalKind: "install_or_enable_code",
      now: NOW,
    })).toMatchObject({
      valid: false,
      reason: "approval proposal fingerprint is stale",
      runtime_authority: false,
    });
    expect(validateToolAcquisitionApproval({
      proposal,
      envelope,
      approvalKind: "credential_use",
      now: NOW,
    })).toMatchObject({
      valid: false,
      reason: "approval kind does not match requested acquisition step",
      runtime_authority: false,
    });
    const futureEnvelope = createToolAcquisitionApprovalEnvelope({
      proposal,
      approvalRef: { kind: "approval", ref: "approval:future-install-calendar" },
      approvalKind: "install_or_enable_code",
      approvedAt: "2026-05-14T02:00:00.000Z",
      expiresAt: "2026-05-14T03:00:00.000Z",
      approverRef: { kind: "user", ref: "user:yu" },
    });

    expect(validateToolAcquisitionApproval({
      proposal,
      envelope: futureEnvelope,
      approvalKind: "install_or_enable_code",
      now: NOW,
    })).toMatchObject({
      valid: false,
      reason: "approval envelope is not active yet",
      runtime_authority: false,
    });
    expect(validateToolAcquisitionApproval({
      proposal,
      envelope,
      approvalKind: "install_or_enable_code",
      now: "not-a-date",
    })).toMatchObject({
      valid: false,
      reason: "approval validation time is invalid",
      runtime_authority: false,
    });
  });

  it("requires real cost acknowledgment approval evidence before cost-bearing acquisition steps", () => {
    const costAckRef = { kind: "approval", ref: "approval:cost-calendar" };
    const costBearingProposal = baseAcquisition({
      cost_profile: {
        billing_owner: "user",
        cost_kind: "metered",
        requires_user_cost_ack: true,
      },
      cost_ack_ref: costAckRef,
    });
    const installEnvelope = createToolAcquisitionApprovalEnvelope({
      proposal: costBearingProposal,
      approvalRef: { kind: "approval", ref: "approval:install-calendar" },
      approvalKind: "install_or_enable_code",
      approvedAt: NOW,
      expiresAt: "2026-05-14T01:00:00.000Z",
      approverRef: { kind: "user", ref: "user:yu" },
    });
    const costAcknowledgmentEnvelope = createToolAcquisitionApprovalEnvelope({
      proposal: costBearingProposal,
      approvalRef: costAckRef,
      approvalKind: "cost_acknowledgment",
      approvedAt: NOW,
      expiresAt: "2026-05-14T01:00:00.000Z",
      approverRef: { kind: "user", ref: "user:yu" },
    });
    const wrongCostAcknowledgmentEnvelope = createToolAcquisitionApprovalEnvelope({
      proposal: costBearingProposal,
      approvalRef: { kind: "approval", ref: "approval:wrong-cost-calendar" },
      approvalKind: "cost_acknowledgment",
      approvedAt: NOW,
      expiresAt: "2026-05-14T01:00:00.000Z",
      approverRef: { kind: "user", ref: "user:yu" },
    });

    expect(validateToolAcquisitionApproval({
      proposal: costBearingProposal,
      envelope: installEnvelope,
      approvalKind: "install_or_enable_code",
      now: NOW,
    })).toMatchObject({
      valid: false,
      reason: "cost acknowledgment approval is required before acquisition can proceed",
      runtime_authority: false,
    });
    expect(validateToolAcquisitionApproval({
      proposal: costBearingProposal,
      envelope: installEnvelope,
      approvalKind: "install_or_enable_code",
      costAcknowledgmentEnvelope: wrongCostAcknowledgmentEnvelope,
      now: NOW,
    })).toMatchObject({
      valid: false,
      reason: "cost acknowledgment ref does not match cost acknowledgment approval",
      runtime_authority: false,
    });
    expect(validateToolAcquisitionApproval({
      proposal: costBearingProposal,
      envelope: installEnvelope,
      approvalKind: "install_or_enable_code",
      costAcknowledgmentEnvelope,
      now: NOW,
    })).toMatchObject({ valid: true });
  });

  it("canonicalizes undefined optional proposal fields before fingerprinting", () => {
    const proposal = baseAcquisition();
    const withUndefined = CandidateToolAcquisitionSchema.parse({
      ...proposal,
      manifest_ref: undefined,
      manifest_digest: undefined,
      capability_operation_contract_ref: undefined,
    });
    const persistedRoundTrip = CandidateToolAcquisitionSchema.parse(JSON.parse(JSON.stringify(withUndefined)));

    expect(computeAcquisitionProposalFingerprint(withUndefined))
      .toBe(computeAcquisitionProposalFingerprint(persistedRoundTrip));
  });

  it("requires declarative credentials and never stores or projects secret material", () => {
    expect(() => CredentialRequirementSchema.parse({
      credential_id: "credential:bad",
      provider: "calendar-provider",
      requested_scopes: ["calendar.readonly"],
      storage_owner: "external_oauth",
      user_must_supply: true,
      can_be_inferred_or_scraped: true,
      secret_material_stored_in_pulseed_records: false,
    })).toThrow(/false/);
    expect(() => McpServerAcquisitionProposalSchema.parse({
      schema_version: "mcp-server-acquisition-proposal/v1",
      proposal_id: "mcp-proposal:bad-secret",
      candidate: baseAcquisition(),
      command_ref: "command:mcp-calendar",
      command_display: "calendar-mcp --stdio",
      config_fingerprint: "sha256:mcp-config",
      process_lifecycle: "persistent",
      credential_requirements: [baseCredential()],
      data_scope_grants: [],
      secret_values_present: true,
      default_runtime_loadable: false,
    })).toThrow(/false/);

    const projection = renderToolAcquisitionSurfaceProjection({
      proposal: baseAcquisition(),
      surfaceTarget: "normal_user",
    });
    expect(JSON.stringify(projection)).not.toContain("calendar.readonly");
    expect(JSON.stringify(projection)).not.toContain("sk-");
    expect(projection).toMatchObject({
      approval_required: true,
      secret_material_visible: false,
      normal_runtime_loadable: false,
    });
  });

  it("fails closed for unknown cost until an explicit cost acknowledgment exists", () => {
    const unknownCost = baseAcquisition({
      cost_profile: {
        billing_owner: "unknown",
        cost_kind: "unknown",
        requires_user_cost_ack: true,
      },
    });
    const blocked = adaptAcquisitionToRuntime({
      acquisition: unknownCost,
      verificationRef: "verification:calendar",
      verificationResult: "pass",
      evidenceRef: "evidence:calendar-smoke",
      evaluatedAt: NOW,
    });
    const costAckRef = { kind: "approval", ref: "approval:cost-calendar" };
    const costAcknowledgedProposal = baseAcquisition({
      cost_profile: {
        billing_owner: "unknown",
        cost_kind: "unknown",
        requires_user_cost_ack: true,
      },
      cost_ack_ref: costAckRef,
    });
    const costAcknowledgmentEnvelope = createToolAcquisitionApprovalEnvelope({
      proposal: costAcknowledgedProposal,
      approvalRef: costAckRef,
      approvalKind: "cost_acknowledgment",
      approvedAt: NOW,
      expiresAt: "2026-05-14T01:00:00.000Z",
      approverRef: { kind: "user", ref: "user:yu" },
    });
    const placeholderOnly = adaptAcquisitionToRuntime({
      acquisition: costAcknowledgedProposal,
      verificationRef: "verification:calendar",
      verificationResult: "pass",
      evidenceRef: "evidence:calendar-smoke",
      evaluatedAt: NOW,
    });
    const acknowledged = adaptAcquisitionToRuntime({
      acquisition: costAcknowledgedProposal,
      costAcknowledgmentEnvelope,
      verificationRef: "verification:calendar",
      verificationResult: "pass",
      evidenceRef: "evidence:calendar-smoke",
      evaluatedAt: NOW,
    });

    expect(blocked.readiness_snapshot).toMatchObject({
      state: "blocked",
      failed_gates: ["blocked"],
      metadata: { cost_ack_required: true },
    });
    expect(renderToolAcquisitionSurfaceProjection({
      proposal: unknownCost,
      surfaceTarget: "normal_user",
    }).cost_ack_required).toBe(true);
    expect(placeholderOnly.readiness_snapshot).toMatchObject({
      state: "blocked",
      metadata: {
        cost_ack_required: true,
        cost_ack_validation_reason: "cost acknowledgment approval envelope is required before acquisition can proceed",
      },
    });
    expect(acknowledged.readiness_snapshot.state).toBe("executable_verified");
  });

  it("preserves operation scope through capability, verification, admission, autonomy, and gadget planning", () => {
    const proposal = baseAcquisition();
    const adapted = adaptAcquisitionToRuntime({
      acquisition: proposal,
      verificationRef: "verification:calendar",
      verificationResult: "pass",
      evidenceRef: "evidence:calendar-smoke",
      evaluatedAt: NOW,
    });
    const preserved = {
      provider_ref: "mcp:calendar",
      capability_id: "calendar-read",
      asset_ref: "mcp-server:calendar",
      operation_id: "calendar.read",
      operation_kind: "read",
      tool_name: "calendar.read",
      payload_class: "calendar.query",
      side_effect_profile: "read",
      risk_profile: "low",
    };

    expect(adapted.capability_operation_contract).toMatchObject({
      id: preserved.operation_id,
      operation_kind: preserved.operation_kind,
      side_effect_profile: preserved.side_effect_profile,
      risk_profile: preserved.risk_profile,
      privacy_profile: "external_service",
      authority_scope: "requires_runtime_selection",
      external_action_authority: false,
    });
    const { risk_profile: _riskProfile, ...runtimePreserved } = preserved;
    expect(adapted.capability_verification_ref).toMatchObject({
      ...runtimePreserved,
      risk_class: preserved.risk_profile,
    });
    expect(adapted.readiness_snapshot).toMatchObject({
      ...runtimePreserved,
      risk_class: preserved.risk_profile,
    });
    expect(adapted.admission_operation_scope).toMatchObject({
      ...runtimePreserved,
      requires_runtime_control: true,
      required_permission_capabilities: ["inspect_runtime"],
    });
    expect(adapted.autonomy_operation_plan).toMatchObject({
      provider_ref: preserved.provider_ref,
      capability_id: preserved.capability_id,
      operation_id: preserved.operation_id,
      operation_kind: preserved.operation_kind,
      payload_class: preserved.payload_class,
      side_effect_profile: preserved.side_effect_profile,
      privacy_profile: "external_service",
      reversibility: "reversible",
      external_action_authority: false,
    });

    const admission = evaluateAdmissionPolicy({
      operation: adapted.admission_operation_scope,
      actor: {
        surface: "gateway",
        platform: "telegram",
        conversation_id: "conversation:calendar",
        identity_key: "user:yu",
        user_id: "user:yu",
      },
      surface: {
        surface_ref: "surface:gateway-calendar",
        channel: "gateway",
        platform: "telegram",
        session_ref: "session:calendar",
      },
      readiness: adapted.readiness_snapshot,
      authState: {
        ref: "auth:calendar",
        status: "missing",
      },
      evaluatedAt: NOW,
      expiresAt: "2026-05-14T00:05:00.000Z",
    });
    const autonomy = evaluateAutonomyDecision({
      operation_plan: adapted.autonomy_operation_plan,
      readiness_snapshots: [adapted.readiness_snapshot],
      admission_evaluation: admission,
      evaluated_at: NOW,
      expires_at: "2026-05-14T00:05:00.000Z",
    });
    const projection = projectCompanionAction({
      decision: autonomy,
      context: {
        surface_ref: "surface:gateway-calendar",
        surface_kind: "normal_companion",
      },
      evaluated_at: NOW,
    });
    const plan = createCompanionGadgetPlan({
      assetKind: "plugin",
      operationCandidate: adapted.operation_plan_candidate,
      readinessSnapshots: [adapted.readiness_snapshot],
      admissionEvaluation: admission,
      autonomyDecision: autonomy,
      actionProjection: projection,
      generatedAt: NOW,
    });

    expect(admission.result).toBe("approval_required");
    expect(autonomy.metadata.admission_evaluation_ref).toBe(admission.evaluation_id);
    expect(plan.candidate.can_execute).toBe(true);
    expect(plan.action_candidates[0]).toMatchObject({
      can_execute: true,
      may_initiate: false,
      executes_operation: false,
      normal_surface_advertises_executable: false,
    });
    expect(plan.action_candidates[0]?.blocked_reasons).toEqual(expect.arrayContaining([
      "admission_approval_required",
      "autonomy_not_initiable",
      "approval_required",
    ]));
  });
});
