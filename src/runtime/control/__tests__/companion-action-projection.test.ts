import { describe, expect, it } from "vitest";
import type {
  AutonomyDecision,
  AutonomyDecisionLevel,
} from "../autonomy-governor.js";
import {
  projectCompanionAction,
  toCompanionUserFacingPolicyProjection,
} from "../companion-action-projection.js";

const NOW = "2026-05-09T00:00:00.000Z";

function decision(level: AutonomyDecisionLevel, overrides: Partial<AutonomyDecision> = {}): AutonomyDecision {
  return {
    schema_version: "autonomy-decision/v1",
    decision_id: `autonomy:operation:${level}`,
    operation_id: "notify.send",
    capability_id: "capability:notify",
    evaluated_at: NOW,
    level,
    rationale: [
      "RAW_POLICY_STATE admission=approval_required readiness=executable_verified capability:notify",
    ],
    allowed_steps: level === "approval_required"
      ? ["prepare", "request_user_approval"]
      : level === "prohibited"
        ? []
        : ["autonomous_low_risk_execute"],
    blocked_steps: level === "approval_required"
      ? ["autonomous_initiate", "execute_without_approval"]
      : level === "prohibited"
        ? ["execute", "initiate"]
        : [],
    required_user_approval: level === "approval_required",
    audit_refs: ["audit:capability-runtime", "readiness:notify"],
    expires_at: "2026-05-09T00:05:00.000Z",
    invalidation_bindings: [{
      kind: "policy",
      ref: "policy:notification",
    }],
    cache_key: "cache:decision",
    metadata: {
      admission_evaluation_ref: "admission:notify",
      readiness_refs: ["readiness:notify"],
      user_directed: false,
      external_side_effect: true,
      blast_radius: "external",
      privacy_sensitivity: "medium",
      context_authority_evidence_refs: [],
    },
    ...overrides,
  };
}

function normalContext(overrides: Record<string, unknown> = {}) {
  return {
    surface_ref: "surface:chat",
    surface_kind: "normal_companion" as const,
    ...overrides,
  };
}

const FORBIDDEN_NORMAL_PAYLOAD_PATHS = [
  "surface_expression_policy",
  "hidden_reason_refs",
  "audit_refs",
  "metadata",
  "autonomy_level",
  "readiness_label",
  "admission_label",
  "execution.label",
  "capability_catalog_visible",
  "raw_policy_state_visible",
  "ordinary_action_policy_projection",
  "source_refs",
  "rationale",
];

function expectNoRawControlPlaneFields(payload: unknown) {
  const paths = collectKeyPaths(payload);
  expect(FORBIDDEN_NORMAL_PAYLOAD_PATHS.filter((path) => paths.includes(path))).toEqual([]);
  expect(collectStringValues(payload).filter((value) => [
    "RAW_POLICY_STATE",
    "readiness=degraded",
    "readiness=executable_verified",
    "admission=approval_required",
    "admission=allowed",
    "autonomy=approval_required",
    "capability:notify",
  ].some((rawValue) => value.includes(rawValue)))).toEqual([]);
}

function collectKeyPaths(value: unknown, prefix = ""): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectKeyPaths(item, prefix));
  }
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return [path, ...collectKeyPaths(child, path)];
  });
}

function collectStringValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectStringValues);
  if (typeof value !== "object" || value === null) return [];
  return Object.values(value).flatMap(collectStringValues);
}

describe("CompanionActionProjection", () => {
  it("projects approval_required into approval or draft preparation without executing", () => {
    const projection = projectCompanionAction({
      decision: decision("approval_required"),
      context: normalContext(),
      prepared_artifact_refs: ["draft:notify"],
      approval_request_ref: "approval:notify",
      evaluated_at: NOW,
    });

    expect(projection.user_visible_action_kind).toBe("ask_for_approval");
    expect(projection.ordinary_action_policy_projection.ordinary_action_policy).toBe("ask");
    expect(projection.executes_operation).toBe(false);
    expect(projection.prepared_artifact_refs).toEqual(["draft:notify"]);
    expect(projection.approval_request_ref).toBe("approval:notify");
    expect(projection.next_best_safe_action).toBe("Ask for explicit approval before executing the prepared operation.");
  });

  it("projects prohibited into a safe alternative rather than a raw policy dump", () => {
    const projection = projectCompanionAction({
      decision: decision("prohibited"),
      context: normalContext(),
      alternative_action_refs: ["alternative:local-summary"],
      evaluated_at: NOW,
    });

    expect(projection.user_visible_action_kind).toBe("refuse_with_alternative");
    expect(projection.ordinary_action_policy_projection.ordinary_action_policy).toBe("deny");
    expect(projection.executes_operation).toBe(false);
    expect(projection.next_best_safe_action).toContain("safe alternative");
    expect(projection.brief_reason).toBe("That route is blocked, so I will offer a safer alternative.");
    expect(JSON.stringify({
      next_best_safe_action: projection.next_best_safe_action,
      brief_reason: projection.brief_reason,
    })).not.toContain("RAW_POLICY_STATE");
    expect(JSON.stringify({
      next_best_safe_action: projection.next_best_safe_action,
      brief_reason: projection.brief_reason,
    })).not.toContain("capability:notify");
  });

  it("keeps suppressed or quieted work silent or deferred", () => {
    const quieted = projectCompanionAction({
      decision: decision("prohibited", {
        suppression_reason: "Quieting policy is active.",
      }),
      context: normalContext({ quieted: true }),
      evaluated_at: NOW,
    });
    expect(quieted.user_visible_action_kind).toBe("digest_later");
    expect(quieted.ordinary_action_policy_projection.ordinary_action_policy).toBe("suggest");
    expect(quieted.surface_expression_policy.user_visible_reason).toBe("none");

    const silent = projectCompanionAction({
      decision: decision("prohibited", {
        suppression_reason: "Companion is suspended.",
      }),
      context: normalContext({ quieted: true, digest_later_allowed: false }),
      evaluated_at: NOW,
    });
    expect(silent.user_visible_action_kind).toBe("stay_silent");
    expect(silent.ordinary_action_policy_projection.ordinary_action_policy).toBe("suggest");
    expect(silent.brief_reason).toBeUndefined();
  });

  it("keeps degraded advisory evidence on the internal projection while surfacing suggest", () => {
    const projection = projectCompanionAction({
      decision: decision("advisory", {
        decision_id: "autonomy:operation:degraded-advisory",
        rationale: ["RAW_POLICY_STATE readiness=degraded admission=not_evaluated capability:notify"],
        audit_refs: ["audit:capability-runtime", "readiness:degraded"],
        metadata: {
          ...decision("advisory").metadata,
          admission_evaluation_ref: "admission:degraded",
          readiness_refs: ["readiness:degraded"],
        },
      }),
      context: normalContext(),
      evaluated_at: NOW,
    });
    const userFacing = toCompanionUserFacingPolicyProjection(projection);

    expect(projection.user_visible_action_kind).toBe("suggest");
    expect(projection.ordinary_action_policy_projection.ordinary_action_policy).toBe("suggest");
    expect(projection.ordinary_action_policy_projection.source_refs).toMatchObject({
      autonomy_decision_ref: "autonomy:operation:degraded-advisory",
      admission_evaluation_ref: "admission:degraded",
      readiness_refs: ["readiness:degraded"],
    });
    expect(userFacing.ordinary_action_policy).toBe("suggest");
    expectNoRawControlPlaneFields(userFacing);
  });

  it("keeps hidden reasons inspectable for operator and debug surfaces", () => {
    const projection = projectCompanionAction({
      decision: decision("approval_required"),
      context: {
        surface_ref: "surface:debug",
        surface_kind: "debug",
      },
      evaluated_at: NOW,
    });

    expect(projection.surface_expression_policy.hidden_reasons_visible).toBe(true);
    expect(projection.surface_expression_policy.raw_policy_state_visible).toBe(true);
    expect(projection.hidden_reason_refs).toEqual([
      "admission:notify",
      "audit:capability-runtime",
      "autonomy:operation:approval_required",
      "policy:notification",
      "readiness:notify",
    ]);
    expect(projection.ordinary_action_policy_projection.source_refs).toEqual({
      projection_ref: projection.projection_id,
      operation_ref: "notify.send",
      autonomy_decision_ref: "autonomy:operation:approval_required",
      admission_evaluation_ref: "admission:notify",
      readiness_refs: ["readiness:notify"],
      audit_refs: [
        "audit:capability-runtime",
        "autonomy:operation:approval_required",
        "readiness:notify",
      ],
    });
    expect(projection.brief_reason).toBe("Projected from autonomy decision autonomy:operation:approval_required.");
  });

  it("derives a normal user-facing policy view without policy refs or raw metadata", () => {
    const projection = projectCompanionAction({
      decision: decision("approval_required"),
      context: normalContext(),
      prepared_artifact_refs: ["draft:notify"],
      approval_request_ref: "approval:notify",
      evaluated_at: NOW,
    });
    const userFacing = toCompanionUserFacingPolicyProjection(projection);

    expect(userFacing).toEqual({
      schema_version: "companion-user-facing-policy-projection/v1",
      evaluated_at: NOW,
      user_visible_action_kind: "ask_for_approval",
      ordinary_action_policy: "ask",
      next_best_safe_action: "Ask for explicit approval before executing the prepared operation.",
      brief_reason: "Approval is needed before this can run.",
      executes_operation: false,
    });
    expectNoRawControlPlaneFields(userFacing);
  });

  it("rejects operator-detail reasons before deriving a user-facing policy view", () => {
    const projection = projectCompanionAction({
      decision: decision("approval_required"),
      context: normalContext(),
      evaluated_at: NOW,
    });

    expect(() => toCompanionUserFacingPolicyProjection({
      ...projection,
      brief_reason: "Projected from autonomy decision autonomy:operation:approval_required.",
      surface_expression_policy: {
        ...projection.surface_expression_policy,
        user_visible_reason: "operator_detail",
      },
    })).toThrow(/not safe for a normal companion surface/);
  });

  it("drops brief_reason when the normal surface policy says no reason is visible", () => {
    const projection = projectCompanionAction({
      decision: decision("prohibited", {
        suppression_reason: "Quieting policy is active.",
      }),
      context: normalContext({ quieted: true }),
      evaluated_at: NOW,
    });

    const userFacing = toCompanionUserFacingPolicyProjection({
      ...projection,
      brief_reason: "Operator-only quieting policy detail.",
    });

    expect(userFacing).toEqual({
      schema_version: "companion-user-facing-policy-projection/v1",
      evaluated_at: NOW,
      user_visible_action_kind: "digest_later",
      ordinary_action_policy: "suggest",
      next_best_safe_action: "Hold this for a later digest.",
      executes_operation: false,
    });
  });

  it("does not turn normal companion UX into a capability catalog", () => {
    const projection = projectCompanionAction({
      decision: decision("prepare_only"),
      context: normalContext(),
      prepared_artifact_refs: ["draft:local-prep"],
      evaluated_at: NOW,
    });

    expect(projection.user_visible_action_kind).toBe("prepare_draft");
    expect(projection.ordinary_action_policy_projection.ordinary_action_policy).toBe("suggest");
    expect(projection.surface_expression_policy.capability_catalog_visible).toBe(false);
    expect(projection.surface_expression_policy.raw_policy_state_visible).toBe(false);
    expect(projection.metadata.normal_capability_catalog_suppressed).toBe(true);
    expect(JSON.stringify({
      next_best_safe_action: projection.next_best_safe_action,
      brief_reason: projection.brief_reason,
    })).not.toContain("readiness");
    expect(JSON.stringify({
      next_best_safe_action: projection.next_best_safe_action,
      brief_reason: projection.brief_reason,
    })).not.toContain("admission");
    expect(JSON.stringify({
      next_best_safe_action: projection.next_best_safe_action,
      brief_reason: projection.brief_reason,
    })).not.toContain("autonomy");
  });

  it("distinguishes user-directed execution from autonomous low-risk internal work", () => {
    const userDirected = projectCompanionAction({
      decision: decision("user_directed_execute"),
      context: normalContext(),
      evaluated_at: NOW,
    });
    const autonomousLowRisk = projectCompanionAction({
      decision: decision("autonomous_low_risk"),
      context: normalContext(),
      evaluated_at: NOW,
    });

    expect(userDirected.user_visible_action_kind).toBe("execute_now");
    expect(userDirected.ordinary_action_policy_projection.ordinary_action_policy).toBe("allow");
    expect(userDirected.next_best_safe_action).toBe("Run the requested operation now.");
    expect(userDirected.brief_reason).toBe("This requested action is safe to run now.");
    expect(userDirected.brief_reason).not.toContain("admission");
    expect(userDirected.brief_reason).not.toContain("low-risk internal");

    expect(autonomousLowRisk.user_visible_action_kind).toBe("execute_now");
    expect(autonomousLowRisk.ordinary_action_policy_projection.ordinary_action_policy).toBe("allow");
    expect(autonomousLowRisk.next_best_safe_action).toBe("Run the safe background operation now.");
    expect(autonomousLowRisk.brief_reason).toBe("This background action is safe to run now.");
    expect(autonomousLowRisk.brief_reason).not.toContain("autonomous");
    expect(autonomousLowRisk.brief_reason).not.toContain("admitted");
  });
});
