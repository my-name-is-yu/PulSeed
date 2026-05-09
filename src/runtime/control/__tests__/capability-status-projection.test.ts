import { describe, expect, it } from "vitest";
import type { CapabilityReadinessSnapshot } from "../../../platform/observation/types/capability.js";
import type { AdmissionPolicyEvaluation } from "../admission-policy.js";
import type { AutonomyDecision, AutonomyDecisionLevel } from "../autonomy-governor.js";
import {
  projectCapabilityNormalCompanionStatusAction,
  projectCapabilityOperatorStatus,
} from "../capability-status-projection.js";

const NOW = "2026-05-09T00:00:00.000Z";

function readiness(overrides: Partial<CapabilityReadinessSnapshot> = {}): CapabilityReadinessSnapshot {
  return {
    schema_version: "capability-readiness-snapshot/v1",
    snapshot_id: "readiness:notify:slack:send",
    capability_id: "capability:notify",
    provider_ref: "asset:notifier/slack",
    asset_ref: "asset:notifier/slack",
    operation_id: "notify.send",
    operation_kind: "send",
    tool_name: "notify.send",
    payload_class: "notification_payload",
    risk_class: "medium",
    side_effect_profile: "send",
    evaluated_at: NOW,
    state: "executable_verified",
    passed_gates: [
      "stored",
      "discoverable",
      "loadable",
      "compatible",
      "configured",
      "authenticated",
      "executable_verified",
    ],
    failed_gates: [],
    degraded_gates: [],
    missing_config_refs: [],
    missing_auth_refs: [],
    verification_refs: ["verify:notify:smoke"],
    evidence_refs: ["evidence:notify:smoke"],
    stale_refs: [],
    safe_user_visible_label: "Execution substrate verified",
    metadata: {},
    ...overrides,
  };
}

function admission(overrides: Partial<AdmissionPolicyEvaluation> = {}): AdmissionPolicyEvaluation {
  return {
    schema_version: "admission-policy-evaluation/v1",
    evaluation_id: "admission:notify:allowed",
    operation_id: "notify.send",
    capability_id: "capability:notify",
    evaluated_at: NOW,
    actor_ref: "operator:user-1",
    surface_ref: "surface:chat",
    provider_ref: "asset:notifier/slack",
    payload_class: "notification_payload",
    target_refs: ["slack:channel:ops"],
    permission_grant_refs: ["grant:notify"],
    rejected_permission_grant_refs: [],
    relationship_policy_refs: [],
    quieting_policy_refs: [],
    privacy_policy_refs: [],
    runtime_control_refs: ["runtime-control:surface"],
    notification_policy_refs: ["notification-policy:ops"],
    auth_state_ref: "auth:slack",
    readiness_ref: "readiness:notify:slack:send",
    result: "allowed",
    rationale: ["All supplied admission policy inputs allow this exact operation scope."],
    expires_at: "2026-05-09T00:05:00.000Z",
    invalidation_bindings: [],
    metadata: {
      operation_kind: "send",
      side_effect_profile: "send",
      required_permission_capabilities: [],
      considered_permission_grant_refs: ["grant:notify"],
    },
    ...overrides,
  };
}

function autonomy(level: AutonomyDecisionLevel, overrides: Partial<AutonomyDecision> = {}): AutonomyDecision {
  return {
    schema_version: "autonomy-decision/v1",
    decision_id: `autonomy:notify:${level}`,
    operation_id: "notify.send",
    capability_id: "capability:notify",
    evaluated_at: NOW,
    level,
    rationale: ["RAW_POLICY_STATE readiness=executable_verified admission=allowed"],
    allowed_steps: level === "prohibited" ? [] : ["execute"],
    blocked_steps: level === "prohibited" ? ["execute"] : [],
    required_user_approval: level === "approval_required",
    audit_refs: ["audit:notify"],
    expires_at: "2026-05-09T00:05:00.000Z",
    invalidation_bindings: [],
    cache_key: "cache:notify",
    metadata: {
      admission_evaluation_ref: "admission:notify:allowed",
      readiness_refs: ["readiness:notify:slack:send"],
      user_directed: level === "user_directed_execute",
      external_side_effect: level !== "autonomous_low_risk",
      blast_radius: level === "autonomous_low_risk" ? "workspace" : "external",
      privacy_sensitivity: "medium",
      context_authority_evidence_refs: [],
    },
    ...overrides,
  };
}

describe("capability status projection", () => {
  it("keeps executable readiness separate from user-directed and autonomous authority", () => {
    const projection = projectCapabilityOperatorStatus({
      readiness: readiness(),
      admission_evaluation: admission(),
      autonomy_decision: autonomy("user_directed_execute"),
      surface_kind: "operator",
      evaluated_at: NOW,
    });

    expect(projection.readiness).toMatchObject({
      label: "execution_substrate_verified",
      can_execute: true,
    });
    expect(projection.admission.label).toBe("admitted");
    expect(projection.autonomy.label).toBe("user_directed_execute");
    expect(projection.execution).toMatchObject({
      label: "admitted_user_directed_execution",
      can_execute: true,
      may_execute_now: true,
      may_initiate_autonomously: false,
    });
  });

  it("does not turn registry availability into executable or autonomous status", () => {
    const projection = projectCapabilityOperatorStatus({
      readiness: readiness({
        state: "authenticated",
        passed_gates: ["stored", "discoverable", "loadable", "compatible", "configured", "authenticated"],
        failed_gates: ["executable_verified"],
        verification_refs: [],
        evidence_refs: [],
        safe_user_visible_label: "Configured, verification required",
      }),
      registry_status: "available",
      evaluated_at: NOW,
    });

    expect(projection.readiness.label).toBe("verification_required");
    expect(projection.readiness.can_execute).toBe(false);
    expect(projection.admission.label).toBe("not_evaluated");
    expect(projection.autonomy.label).toBe("not_evaluated");
    expect(projection.execution).toMatchObject({
      label: "not_executable",
      may_execute_now: false,
      may_initiate_autonomously: false,
    });
    expect(projection.warnings).toContain(
      "Registry status available is evidence only and does not grant execution or autonomy."
    );
  });

  it("requires matching readiness, admission, and autonomy refs before projecting autonomous initiation", () => {
    const stale = projectCapabilityOperatorStatus({
      readiness: readiness(),
      admission_evaluation: admission({ readiness_ref: "readiness:other" }),
      autonomy_decision: autonomy("autonomous_low_risk", {
        metadata: {
          ...autonomy("autonomous_low_risk").metadata,
          external_side_effect: false,
        },
      }),
      evaluated_at: NOW,
    });

    expect(stale.admission.label).toBe("not_evaluated");
    expect(stale.autonomy.label).toBe("not_evaluated");
    expect(stale.execution).toMatchObject({
      can_execute: true,
      may_execute_now: false,
      may_initiate_autonomously: false,
      label: "execution_verified_admission_not_granted",
    });
    expect(stale.warnings).toEqual(expect.arrayContaining([
      "Admission evaluation did not match this readiness snapshot and was ignored.",
      "Autonomy decision did not match this readiness/admission scope and was ignored.",
    ]));

    const current = projectCapabilityOperatorStatus({
      readiness: readiness({
        operation_kind: "write",
        side_effect_profile: "write",
        risk_class: "low",
      }),
      admission_evaluation: admission({
        metadata: {
          operation_kind: "write",
          side_effect_profile: "write",
          required_permission_capabilities: [],
          considered_permission_grant_refs: ["grant:notify"],
        },
      }),
      autonomy_decision: autonomy("autonomous_low_risk", {
        metadata: {
          ...autonomy("autonomous_low_risk").metadata,
          external_side_effect: false,
          user_directed: false,
        },
      }),
      evaluated_at: NOW,
    });

    expect(current.autonomy.label).toBe("autonomous_low_risk");
    expect(current.execution).toMatchObject({
      label: "admitted_autonomous_low_risk_internal",
      may_execute_now: true,
      may_initiate_autonomously: true,
    });
  });

  it("does not reuse expired admission or autonomy decisions as current operator state", () => {
    const projection = projectCapabilityOperatorStatus({
      readiness: readiness(),
      admission_evaluation: admission({
        expires_at: "not-a-date",
      }),
      autonomy_decision: autonomy("autonomous_low_risk", {
        expires_at: "not-a-date",
        metadata: {
          ...autonomy("autonomous_low_risk").metadata,
          external_side_effect: false,
        },
      }),
      evaluated_at: NOW,
    });

    expect(projection.admission.label).toBe("not_evaluated");
    expect(projection.autonomy.label).toBe("not_evaluated");
    expect(projection.execution).toMatchObject({
      can_execute: true,
      may_execute_now: false,
      may_initiate_autonomously: false,
      label: "execution_verified_admission_not_granted",
    });
    expect(projection.warnings).toEqual(expect.arrayContaining([
      "Admission evaluation expired and was ignored.",
      "Autonomy decision expired and was ignored.",
    ]));
  });

  it("does not let stale autonomy project execute_now on normal companion surfaces", () => {
    const projection = projectCapabilityNormalCompanionStatusAction({
      decision: autonomy("autonomous_low_risk", {
        expires_at: "2026-05-08T23:59:59.000Z",
        metadata: {
          ...autonomy("autonomous_low_risk").metadata,
          external_side_effect: false,
          user_directed: false,
        },
      }),
      surface_ref: "surface:chat",
      prepared_artifact_refs: ["draft:notify"],
      evaluated_at: NOW,
    });

    expect(projection.user_visible_action_kind).toBe("prepare_draft");
    expect(projection.executes_operation).toBe(false);
    expect(projection.next_best_safe_action).toBe("Prepare an inspectable draft without executing the operation.");
    expect(projection.brief_reason).toBe("The previous autonomy decision is no longer current.");
    expect(projection.capability_catalog_visible).toBe(false);
    expect(projection.raw_policy_state_visible).toBe(false);
  });

  it("keeps degraded and blocked readiness visible to operator surfaces", () => {
    const degraded = projectCapabilityOperatorStatus({
      readiness: readiness({
        state: "degraded",
        safe_user_visible_label: "Degraded",
        degraded_gates: ["executable_verified"],
      }),
      admission_evaluation: admission(),
      autonomy_decision: autonomy("autonomous_low_risk", {
        metadata: {
          ...autonomy("autonomous_low_risk").metadata,
          external_side_effect: false,
        },
      }),
      surface_kind: "debug",
      evaluated_at: NOW,
    });

    expect(degraded.surface_expression).toMatchObject({
      capability_catalog_visible: true,
      raw_policy_state_visible: true,
    });
    expect(degraded.readiness.label).toBe("degraded");
    expect(degraded.execution).toMatchObject({
      label: "not_executable",
      can_execute: false,
      may_execute_now: false,
    });
  });

  it("projects normal companion UX as next-best safe action without raw capability state", () => {
    const projection = projectCapabilityNormalCompanionStatusAction({
      decision: autonomy("approval_required"),
      surface_ref: "surface:chat",
      prepared_artifact_refs: ["draft:notify"],
      approval_request_ref: "approval:notify",
      evaluated_at: NOW,
    });

    expect(projection.user_visible_action_kind).toBe("ask_for_approval");
    expect(projection.next_best_safe_action).toBe("Ask for explicit approval before executing the prepared operation.");
    expect(projection.capability_catalog_visible).toBe(false);
    expect(projection.raw_policy_state_visible).toBe(false);
    expect(JSON.stringify(projection)).not.toContain("RAW_POLICY_STATE");
    expect(JSON.stringify(projection)).not.toContain("readiness=executable_verified");
    expect(JSON.stringify(projection)).not.toContain("admission=allowed");
  });
});
