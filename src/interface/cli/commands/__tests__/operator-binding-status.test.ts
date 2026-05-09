import { afterEach, describe, expect, it, vi } from "vitest";
import { projectCapabilityOperatorStatus } from "../../../../runtime/control/capability-status-projection.js";
import { printOperatorBindingStatus, type OperatorBindingStatus } from "../operator-binding-status.js";

const NOW = "2026-05-09T00:00:00.000Z";

describe("operator binding status capability runtime projection", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("prints explicit readiness, admission, autonomy, and execution labels without implying autonomy from readiness alone", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const capability = projectCapabilityOperatorStatus({
      readiness: {
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
        passed_gates: ["stored", "discoverable", "loadable", "compatible", "configured", "authenticated", "executable_verified"],
        failed_gates: [],
        degraded_gates: [],
        missing_config_refs: [],
        missing_auth_refs: [],
        verification_refs: ["verify:notify"],
        evidence_refs: ["evidence:notify"],
        stale_refs: [],
        safe_user_visible_label: "Execution substrate verified",
        metadata: {},
      },
      registry_status: "available",
      evaluated_at: NOW,
    });
    const status: OperatorBindingStatus = {
      schema_version: "operator-binding-status-v1",
      generated_at: NOW,
      daemon: {
        running: true,
        port: 41701,
        health: "ok",
        runtime_root: "/tmp/pulseed-runtime",
      },
      channels: [],
      capability_runtime: [capability],
      sessions: [],
      background_runs: [],
      warnings: [],
    };

    printOperatorBindingStatus(status);

    const output = log.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(output).toContain("Capability runtime:");
    expect(output).toContain("readiness=execution_substrate_verified");
    expect(output).toContain("admission=not_evaluated");
    expect(output).toContain("autonomy=not_evaluated");
    expect(output).toContain("execution=execution_verified_admission_not_granted");
    expect(output).toContain("can_execute=yes may_execute=no may_initiate=no");
    expect(output).toContain("Registry status available is evidence only");
  });
});
