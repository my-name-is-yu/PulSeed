import { describe, expect, it } from "vitest";
import { buildCompanionCapabilityGraph } from "../capability-graph.js";
import { buildCapabilityReadinessSnapshots } from "../capability-readiness.js";
import type {
  Capability,
  CapabilityCandidate,
  CapabilityGraph,
  CapabilityOperationContract,
} from "../types/capability.js";
import type { CapabilityVerificationEvidenceSummary } from "../../../runtime/store/index.js";

function operation(
  id: string,
  overrides: Partial<CapabilityOperationContract> = {}
): CapabilityOperationContract {
  return {
    id,
    operation_kind: "send",
    side_effect_profile: "send",
    privacy_profile: "external_service",
    risk_profile: "medium",
    reversibility: "irreversible",
    verification: {
      required: true,
      profile: "operation_specific_smoke",
    },
    authority_scope: "requires_runtime_selection",
    external_action_authority: true,
    payload_class: "notification_payload",
    required: [],
    ...overrides,
  };
}

function graph(candidates: CapabilityCandidate[]): CapabilityGraph {
  return {
    schema_version: "companion-capability-graph/v1",
    generated_at: "2026-05-09T00:00:00.000Z",
    candidates,
    dependency_edges: [],
  };
}

function evidence(
  overrides: Partial<CapabilityVerificationEvidenceSummary> = {}
): CapabilityVerificationEvidenceSummary {
  return {
    verification_id: "verify:send-smoke",
    capability_id: "capability:notify",
    provider_ref: "asset:notifier/slack",
    asset_ref: "asset:notifier/slack",
    operation_kind: "send",
    tool_name: "notify.send",
    payload_class: "notification_payload",
    risk_class: "medium",
    side_effect_profile: "send",
    verification_class: "smoke_execution",
    evidence_stage: "smoke_verified",
    result: "passed",
    readiness_effect: "supports_readiness",
    ...overrides,
  };
}

describe("capability readiness evaluator", () => {
  it("projects legacy available as evidence only, not execution truth", () => {
    const legacyCapability: Capability & { operation_contracts: CapabilityOperationContract[] } = {
      id: "legacy-notifier",
      name: "Legacy notifier",
      description: "Legacy available notifier.",
      type: "service",
      status: "available",
      operation_contracts: [operation("legacy-notifier.send")],
    };
    const snapshots = buildCapabilityReadinessSnapshots({
      evaluatedAt: "2026-05-09T00:00:00.000Z",
      graph: buildCompanionCapabilityGraph({
        legacyCapabilities: [legacyCapability],
      }),
      verificationEvidence: [],
    });

    expect(snapshots[0]).toMatchObject({
      capability_id: "capability:legacy-notifier.send",
      state: "authenticated",
      safe_user_visible_label: "Configured, verification required",
      metadata: {
        legacy_status_projection: "available",
      },
    });
    expect(snapshots[0]?.failed_gates).toContain("executable_verified");
  });

  it("does not turn builtin available status into executable readiness", () => {
    const snapshots = buildCapabilityReadinessSnapshots({
      evaluatedAt: "2026-05-09T00:00:00.000Z",
      graph: buildCompanionCapabilityGraph({
        generatedAt: "2026-05-09T00:00:00.000Z",
        builtinIntegrations: [{
          id: "interactive-automation",
          kind: "automation",
          title: "Interactive Automation",
          description: "Routes desktop and browser workflows.",
          source: "builtin",
          status: "available",
          capabilities: ["browser_workflow_execution"],
        }],
      }),
      verificationEvidence: [],
    });

    const browser = snapshots.find((snapshot) =>
      snapshot.capability_id === "capability:run_browser_workflow"
    );
    expect(browser).toBeDefined();
    expect(browser?.state).not.toBe("executable_verified");
    expect(browser?.failed_gates).toContain("executable_verified");
    expect(browser?.safe_user_visible_label).not.toBe("Execution substrate verified");
  });

  it("keeps loaded native plugins without config below executable readiness", () => {
    const snapshots = buildCapabilityReadinessSnapshots({
      evaluatedAt: "2026-05-09T00:00:00.000Z",
      graph: buildCompanionCapabilityGraph({
        pluginStates: [{
          name: "slack-notifier",
          manifest: {
            name: "slack-notifier",
            version: "1.0.0",
            type: "notifier",
            capabilities: ["send_slack_notification"],
            description: "Slack notifier",
            config_schema: {},
            dependencies: [],
            entry_point: "dist/index.js",
            permissions: {
              network: true,
              file_read: false,
              file_write: false,
              shell: false,
            },
          },
          status: "loaded",
          loaded_at: "2026-05-09T00:00:00.000Z",
          trust_score: 0,
          usage_count: 0,
          success_count: 0,
          failure_count: 0,
        }],
      }),
      verificationEvidence: [],
    });

    const slack = snapshots.find((snapshot) =>
      snapshot.capability_id === "capability:send_slack_notification"
    );
    expect(slack).toMatchObject({
      state: "compatible",
      missing_config_refs: ["plugin:slack-notifier:config"],
      safe_user_visible_label: "Setup required",
    });
    expect(slack?.failed_gates).toEqual(expect.arrayContaining(["configured", "executable_verified"]));
    expect(slack?.missing_auth_refs).toEqual([]);
    expect(slack).not.toHaveProperty("admission");
    expect(slack).not.toHaveProperty("permission");
    expect(slack).not.toHaveProperty("autonomy");
  });

  it("keeps a configured notifier route below executable readiness until send evidence succeeds", () => {
    const candidate: CapabilityCandidate = {
      id: "capability:notify",
      name: "Notify",
      description: "Notification capability.",
      providers: [{
        provider_id: "asset:notifier/slack",
        provider_kind: "notifier",
        asset_id: "asset:notifier/slack",
      }],
      operations: [operation("notify.send", {
        required: [{
          kind: "config",
          ref: "notification_route:slack",
          reason: "Route must be configured.",
        }],
      })],
      source_refs: ["asset:notifier/slack"],
      metadata: {},
    };

    const snapshots = buildCapabilityReadinessSnapshots({
      evaluatedAt: "2026-05-09T00:00:00.000Z",
      graph: graph([candidate]),
      verificationEvidence: [evidence({
        verification_id: "verify:notification-config",
        verification_class: "configuration_validation",
        evidence_stage: "configured",
      })],
    });

    expect(snapshots[0]).toMatchObject({
      state: "authenticated",
      passed_gates: expect.arrayContaining(["configured", "authenticated"]),
      failed_gates: ["executable_verified"],
      safe_user_visible_label: "Configured, verification required",
    });
  });

  it("does not let read-only evidence prove side-effecting readiness", () => {
    const candidate: CapabilityCandidate = {
      id: "capability:notify",
      name: "Notify",
      description: "Notification capability.",
      providers: [{
        provider_id: "asset:notifier/slack",
        provider_kind: "notifier",
        asset_id: "asset:notifier/slack",
      }],
      operations: [
        operation("notify.read", {
          operation_kind: "read",
          side_effect_profile: "read",
          privacy_profile: "workspace_private",
          risk_profile: "low",
          reversibility: "reversible",
          external_action_authority: false,
          payload_class: "route_status",
        }),
        operation("notify.send"),
      ],
      source_refs: ["asset:notifier/slack"],
      metadata: {},
    };

    const snapshots = buildCapabilityReadinessSnapshots({
      evaluatedAt: "2026-05-09T00:00:00.000Z",
      graph: graph([candidate]),
      verificationEvidence: [evidence({
        verification_id: "verify:read-smoke",
        operation_kind: "read",
        tool_name: "notify.read",
        payload_class: "route_status",
        risk_class: "low",
        side_effect_profile: "read",
      })],
    });

    const read = snapshots.find((snapshot) => snapshot.operation_id === "notify.read");
    const send = snapshots.find((snapshot) => snapshot.operation_id === "notify.send");
    expect(read?.state).toBe("executable_verified");
    expect(read?.safe_user_visible_label).toBe("Execution substrate verified");
    expect(send?.state).not.toBe("executable_verified");
    expect(send?.failed_gates).toContain("executable_verified");
  });

  it("derives operator labels from readiness snapshots rather than raw asset presence", () => {
    const candidate: CapabilityCandidate = {
      id: "capability:notify",
      name: "Notify",
      description: "Notification capability.",
      providers: [{
        provider_id: "asset:notifier/slack",
        provider_kind: "notifier",
        asset_id: "asset:notifier/slack",
      }],
      operations: [operation("notify.send")],
      source_refs: ["asset:notifier/slack"],
      metadata: {},
    };

    const withoutVerification = buildCapabilityReadinessSnapshots({
      evaluatedAt: "2026-05-09T00:00:00.000Z",
      graph: graph([candidate]),
      verificationEvidence: [],
    })[0];
    const withVerification = buildCapabilityReadinessSnapshots({
      evaluatedAt: "2026-05-09T00:00:00.000Z",
      graph: graph([candidate]),
      verificationEvidence: [evidence()],
    })[0];

    expect(withoutVerification?.safe_user_visible_label).toBe("Configured, verification required");
    expect(withoutVerification?.state).not.toBe("executable_verified");
    expect(withVerification?.safe_user_visible_label).toBe("Execution substrate verified");
    expect(withVerification?.verification_refs).toEqual(["verify:send-smoke"]);
  });

  it("does not let expired verification evidence prove executable readiness", () => {
    const candidate: CapabilityCandidate = {
      id: "capability:notify",
      name: "Notify",
      description: "Notification capability.",
      providers: [{
        provider_id: "asset:notifier/slack",
        provider_kind: "notifier",
        asset_id: "asset:notifier/slack",
      }],
      operations: [operation("notify.send")],
      source_refs: ["asset:notifier/slack"],
      metadata: {},
    };

    const [snapshot] = buildCapabilityReadinessSnapshots({
      evaluatedAt: "2026-05-09T00:00:00.000Z",
      graph: graph([candidate]),
      verificationEvidence: [evidence({
        expires_at: "2026-05-08T23:59:59.000Z",
      })],
    });

    expect(snapshot).toMatchObject({
      state: "authenticated",
      failed_gates: ["executable_verified"],
      stale_refs: ["verify:send-smoke"],
      verification_refs: [],
      safe_user_visible_label: "Configured, verification required",
    });
  });
});
