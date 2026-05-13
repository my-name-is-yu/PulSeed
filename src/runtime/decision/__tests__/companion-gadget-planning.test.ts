import { describe, expect, it } from "vitest";
import type { CapabilityReadinessSnapshot } from "../../../platform/observation/types/capability.js";
import {
  evaluateAdmissionPolicy,
  type AdmissionPolicyEvaluation,
} from "../../control/admission-policy.js";
import {
  evaluateAutonomyDecision,
  type AutonomyDecision,
  type AutonomyOperationPlanInput,
} from "../../control/autonomy-governor.js";
import {
  projectCompanionAction,
  type CompanionActionProjection,
} from "../../control/companion-action-projection.js";
import type { CapabilityOperationPlanCandidateInput } from "../../types/capability-operation-plan.js";
import {
  CompanionGadgetPlanSchema,
  createCompanionGadgetPlan,
} from "../companion-gadget-planning.js";

const NOW = "2026-05-09T00:00:00.000Z";

function actor() {
  return {
    surface: "chat" as const,
    platform: "slack",
    conversation_id: "conversation:inbound",
    identity_key: "user:yu",
    user_id: "user:yu",
  };
}

function normalContext() {
  return {
    surface_ref: "surface:chat:slack",
    surface_kind: "normal_companion" as const,
  };
}

function operation(overrides: Partial<AutonomyOperationPlanInput> = {}): AutonomyOperationPlanInput {
  return {
    operation_id: "workspace.search",
    capability_id: "capability:workspace-search",
    operation_kind: "read",
    provider_ref: "tool:workspace-search",
    payload_class: "workspace_search_query",
    side_effect_profile: "read",
    risk_class: "low",
    privacy_profile: "workspace_private",
    reversibility: "reversible",
    external_action_authority: false,
    target_refs: ["workspace:/repo"],
    local_only: true,
    inspectable: true,
    expected_user_visible_effect: false,
    ...overrides,
  };
}

function readiness(
  op: AutonomyOperationPlanInput,
  overrides: Partial<CapabilityReadinessSnapshot> = {}
): CapabilityReadinessSnapshot {
  const state = overrides.state ?? "executable_verified";
  return {
    schema_version: "capability-readiness-snapshot/v1",
    snapshot_id: `readiness:${op.operation_id}`,
    capability_id: op.capability_id ?? `capability:${op.operation_id}`,
    provider_ref: op.provider_ref,
    asset_ref: op.provider_ref,
    operation_id: op.operation_id,
    operation_kind: op.operation_kind,
    tool_name: op.operation_id,
    payload_class: op.payload_class,
    risk_class: op.risk_class ?? "medium",
    side_effect_profile: op.side_effect_profile,
    evaluated_at: NOW,
    state,
    passed_gates: state === "executable_verified"
      ? ["stored", "discoverable", "loadable", "compatible", "configured", "authenticated", "executable_verified"]
      : state === "authenticated"
        ? ["stored", "discoverable", "loadable", "compatible", "configured", "authenticated"]
        : [],
    failed_gates: state === "blocked" ? ["blocked"] : [],
    degraded_gates: state === "degraded" ? ["degraded"] : [],
    missing_config_refs: [],
    missing_auth_refs: [],
    verification_refs: [`verify:${op.operation_id}`],
    evidence_refs: [`audit:${op.operation_id}`],
    stale_refs: [],
    safe_user_visible_label: state === "executable_verified"
      ? "Execution substrate verified"
      : state === "degraded"
        ? "Degraded"
        : state === "blocked"
          ? "Blocked"
          : "Configured, verification required",
    metadata: {},
    ...overrides,
  };
}

function operationCandidate(
  op: AutonomyOperationPlanInput,
  snapshot: CapabilityReadinessSnapshot
): CapabilityOperationPlanCandidateInput {
  return {
    plan_id: `operation-plan:${op.operation_id}`,
    source_ref: "companion-decision:turn",
    operation_plan: op,
    admission_scope: {
      operation_id: op.operation_id,
      capability_id: op.capability_id,
      operation_kind: op.operation_kind,
      provider_ref: op.provider_ref,
      asset_ref: op.provider_ref,
      payload_class: op.payload_class,
      payload_epoch: NOW,
      side_effect_profile: op.side_effect_profile,
      external_action_authority: op.external_action_authority,
      requires_runtime_control: false,
      required_permission_capabilities: [],
      target_refs: op.target_refs,
      target_epoch_refs: {
        [op.provider_ref]: NOW,
      },
      provider_epoch: NOW,
    },
    readiness_snapshot_refs: [snapshot.snapshot_id],
    required_approvals: [],
    reversible_preparation_steps: [
      "Prepare an inspectable plan without running the tool.",
    ],
    not_allowed_steps: [
      "Do not infer initiation authority from model text.",
    ],
    user_visible_summary: "Workspace search is available only through downstream readiness, admission, autonomy, and projection gates.",
    audit_seed: {
      source: "test",
    },
  };
}

function allowedAdmission(op: AutonomyOperationPlanInput): AdmissionPolicyEvaluation {
  return evaluateAdmissionPolicy({
    operation: {
      operation_id: op.operation_id,
      capability_id: op.capability_id,
      operation_kind: op.operation_kind,
      provider_ref: op.provider_ref,
      asset_ref: op.provider_ref,
      payload_class: op.payload_class,
      side_effect_profile: op.side_effect_profile,
      external_action_authority: op.external_action_authority,
      required_permission_capabilities: [],
      target_refs: op.target_refs,
    },
    actor: actor(),
    surface: {
      surface_ref: "surface:chat:slack",
      channel: "chat",
      platform: "slack",
      session_ref: "session:chat",
    },
    authState: {
      ref: "auth:current",
      status: "valid",
    },
    evaluatedAt: NOW,
  });
}

function approvalRequiredAdmission(op: AutonomyOperationPlanInput): AdmissionPolicyEvaluation {
  return evaluateAdmissionPolicy({
    operation: {
      operation_id: op.operation_id,
      capability_id: op.capability_id,
      operation_kind: op.operation_kind,
      provider_ref: op.provider_ref,
      asset_ref: op.provider_ref,
      payload_class: op.payload_class,
      side_effect_profile: op.side_effect_profile,
      external_action_authority: op.external_action_authority,
      required_permission_capabilities: ["prepare_draft"],
      target_refs: op.target_refs,
    },
    actor: actor(),
    surface: {
      surface_ref: "surface:chat:slack",
      channel: "chat",
      platform: "slack",
      session_ref: "session:chat",
    },
    authState: {
      ref: "auth:current",
      status: "valid",
    },
    evaluatedAt: NOW,
  });
}

function autonomy(
  op: AutonomyOperationPlanInput,
  snapshotOrSnapshots: CapabilityReadinessSnapshot | CapabilityReadinessSnapshot[],
  admission: AdmissionPolicyEvaluation,
  options: { userDirected?: boolean } = {}
): AutonomyDecision {
  const readinessSnapshots = Array.isArray(snapshotOrSnapshots) ? snapshotOrSnapshots : [snapshotOrSnapshots];
  return evaluateAutonomyDecision({
    operation_plan: op,
    readiness_snapshots: readinessSnapshots,
    admission_evaluation: admission,
    user_directed: options.userDirected ?? false,
    active_surface_ref: "surface:chat:slack",
    auth_state: {
      ref: "auth:current",
      status: "valid",
    },
    blast_radius: "workspace",
    privacy_sensitivity: "low",
    evaluated_at: NOW,
  });
}

function projection(decision: AutonomyDecision): CompanionActionProjection {
  return projectCompanionAction({
    decision,
    context: normalContext(),
    approval_request_ref: decision.required_user_approval ? "approval:workspace-search" : undefined,
    evaluated_at: NOW,
  });
}

describe("CompanionGadgetPlanning", () => {
  it("keeps executable readiness separate from initiation when approval is still required", () => {
    const op = operation();
    const snapshot = readiness(op);
    const admission = approvalRequiredAdmission(op);
    const decision = autonomy(op, snapshot, admission);
    const actionProjection = projection(decision);

    const plan = createCompanionGadgetPlan({
      assetKind: "tool",
      operationCandidate: operationCandidate(op, snapshot),
      readinessSnapshots: [snapshot],
      admissionEvaluation: admission,
      autonomyDecision: decision,
      actionProjection,
      generatedAt: NOW,
    });

    expect(plan.candidate.can_execute).toBe(true);
    expect(plan.candidate.may_initiate).toBe(false);
    expect(plan.candidate.normal_surface_advertises_executable).toBe(false);
    expect(plan.action_candidates[0]).toMatchObject({
      can_execute: true,
      may_initiate: false,
      requires_approval: true,
      executes_operation: false,
      normal_surface_advertises_executable: false,
    });
    expect(plan.action_candidates[0]?.blocked_reasons).toEqual([
      "admission_approval_required",
      "approval_required",
      "autonomy_not_initiable",
      "projection_not_executable",
    ]);
    expect(plan.user_facing_policy_projection?.executes_operation).toBe(false);
    expect(JSON.stringify(plan.user_facing_policy_projection)).not.toContain("readiness");
    expect(JSON.stringify(plan.user_facing_policy_projection)).not.toContain("admission");
    expect(JSON.stringify(plan.user_facing_policy_projection)).not.toContain("autonomy");
  });

  it("allows initiation only when readiness, admission, autonomy, and projection all agree", () => {
    const op = operation();
    const snapshot = readiness(op);
    const admission = allowedAdmission(op);
    const decision = autonomy(op, snapshot, admission, { userDirected: true });
    const actionProjection = projection(decision);

    const plan = createCompanionGadgetPlan({
      assetKind: "tool",
      operationCandidate: operationCandidate(op, snapshot),
      readinessSnapshots: [snapshot],
      admissionEvaluation: admission,
      autonomyDecision: decision,
      actionProjection,
      generatedAt: NOW,
    });

    expect(actionProjection.user_visible_action_kind).toBe("execute_now");
    expect(plan.action_candidates[0]).toMatchObject({
      can_execute: true,
      may_initiate: true,
      requires_approval: false,
      executes_operation: true,
      normal_surface_advertises_executable: true,
      blocked_reasons: [],
    });
    expect(plan.user_facing_policy_projection?.executes_operation).toBe(true);
    expect(plan.metadata.can_execute_is_not_may_initiate).toBe(true);
  });

  it("does not let model text select an authenticated but unverified capability as executable", () => {
    const op = operation();
    const snapshot = readiness(op, {
      state: "authenticated",
      safe_user_visible_label: "Configured, verification required",
    });
    const admission = allowedAdmission(op);
    const decision = autonomy(op, snapshot, admission, { userDirected: true });
    const actionProjection = projection(decision);

    const plan = createCompanionGadgetPlan({
      assetKind: "tool",
      operationCandidate: operationCandidate(op, snapshot),
      readinessSnapshots: [snapshot],
      admissionEvaluation: admission,
      autonomyDecision: decision,
      actionProjection,
      situationRefs: [{
        kind: "user_request",
        ref: "turn:user-said-run-it",
        role: "situation",
      }],
      generatedAt: NOW,
    });

    expect(plan.model_text_is_authority).toBe(false);
    expect(plan.candidate.model_text_is_authority).toBe(false);
    expect(plan.candidate.readiness_state).toBe("authenticated");
    expect(plan.candidate.can_execute).toBe(false);
    expect(plan.candidate.safe_user_visible_label).toBe("Configured, verification required");
    expect(plan.action_candidates[0]).toMatchObject({
      can_execute: false,
      may_initiate: false,
      executes_operation: false,
      normal_surface_advertises_executable: false,
      model_text_is_authority: false,
    });
    expect(plan.action_candidates[0]?.blocked_reasons).toContain("readiness_unverified");
    expect(plan.user_facing_policy_projection?.executes_operation).toBe(false);
  });

  it("fails closed when matching readiness snapshots mix executable and unverified states", () => {
    const op = operation();
    const verified = readiness(op, {
      snapshot_id: "readiness:workspace-search:verified",
    });
    const authenticated = readiness(op, {
      snapshot_id: "readiness:workspace-search:authenticated",
      state: "authenticated",
      safe_user_visible_label: "Configured, verification required",
    });
    const admission = allowedAdmission(op);

    const createPlan = (readinessSnapshots: CapabilityReadinessSnapshot[]) => {
      const decision = autonomy(op, readinessSnapshots, admission, { userDirected: true });
      return createCompanionGadgetPlan({
        assetKind: "tool",
        operationCandidate: operationCandidate(op, verified),
        readinessSnapshots,
        admissionEvaluation: admission,
        autonomyDecision: decision,
        actionProjection: projection(decision),
        generatedAt: NOW,
      });
    };

    for (const plan of [
      createPlan([verified, authenticated]),
      createPlan([authenticated, verified]),
    ]) {
      expect(plan.candidate.readiness_state).toBe("authenticated");
      expect(plan.candidate.safe_user_visible_label).toBe("Configured, verification required");
      expect(plan.candidate.can_execute).toBe(false);
      expect(plan.action_candidates[0]?.may_initiate).toBe(false);
      expect(plan.action_candidates[0]?.normal_surface_advertises_executable).toBe(false);
      expect(plan.action_candidates[0]?.blocked_reasons).toContain("readiness_unverified");
    }
  });

  it("rejects normal-surface executable advertising when the action may not initiate", () => {
    const op = operation();
    const snapshot = readiness(op);
    const admission = approvalRequiredAdmission(op);
    const decision = autonomy(op, snapshot, admission);
    const plan = createCompanionGadgetPlan({
      assetKind: "tool",
      operationCandidate: operationCandidate(op, snapshot),
      readinessSnapshots: [snapshot],
      admissionEvaluation: admission,
      autonomyDecision: decision,
      actionProjection: projection(decision),
      generatedAt: NOW,
    });

    expect(() => CompanionGadgetPlanSchema.parse({
      ...plan,
      action_candidates: [{
        ...plan.action_candidates[0],
        normal_surface_advertises_executable: true,
      }],
    })).toThrow(/advertise execution/);
  });

  it("rejects mismatched admission, autonomy, or projection scope instead of reinterpreting it", () => {
    const op = operation();
    const snapshot = readiness(op);
    const admission = allowedAdmission(op);
    const decision = autonomy(op, snapshot, admission, { userDirected: true });

    expect(() => createCompanionGadgetPlan({
      assetKind: "tool",
      operationCandidate: operationCandidate(operation({
        provider_ref: "tool:other-search",
      }), snapshot),
      readinessSnapshots: [snapshot],
      admissionEvaluation: admission,
      autonomyDecision: decision,
      actionProjection: projection(decision),
      generatedAt: NOW,
    })).toThrow(/provider_ref/);
  });
});
