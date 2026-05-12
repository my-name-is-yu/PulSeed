import { describe, expect, it } from "vitest";
import {
  RuntimeCapabilityDiscoverySchema,
  buildResidentRuntimeInterfaceSnapshot,
  deriveRuntimeConnectionStatus,
} from "../resident-runtime-interface.js";
import type { ApprovalRequiredEvent } from "../approval-broker.js";
import type { RuntimeControlOperation } from "../store/runtime-operation-schemas.js";

function makeOperation(overrides: Partial<RuntimeControlOperation> = {}): RuntimeControlOperation {
  return {
    operation_id: "runtime-op-1",
    kind: "inspect_run",
    state: "pending",
    requested_at: "2026-05-12T00:00:00.000Z",
    updated_at: "2026-05-12T00:00:30.000Z",
    requested_by: { surface: "gateway", platform: "telegram" },
    reply_target: { surface: "gateway", channel: "plugin_gateway", platform: "telegram" },
    reason: "inspect the active run",
    expected_health: { daemon_ping: false, gateway_acceptance: false },
    ...overrides,
  };
}

describe("resident runtime interface contract", () => {
  it("derives online, stale, and offline connection states from daemon evidence", () => {
    const observedAt = "2026-05-12T00:05:00.000Z";

    expect(deriveRuntimeConnectionStatus({
      observedAt,
      daemonState: { status: "running", last_loop_at: "2026-05-12T00:04:00.000Z" },
      staleAfterMs: 120_000,
      offlineAfterMs: 900_000,
    })).toMatchObject({ status: "online", reason: "daemon_evidence_fresh" });

    expect(deriveRuntimeConnectionStatus({
      observedAt,
      daemonState: { status: "running", last_loop_at: "2026-05-12T00:02:00.000Z" },
      staleAfterMs: 120_000,
      offlineAfterMs: 900_000,
    })).toMatchObject({ status: "stale", reason: "daemon_evidence_stale" });

    expect(deriveRuntimeConnectionStatus({
      observedAt,
      daemonState: { status: "running", last_loop_at: "2026-05-11T23:45:00.000Z" },
      staleAfterMs: 120_000,
      offlineAfterMs: 900_000,
    })).toMatchObject({ status: "offline", reason: "daemon_evidence_offline" });
  });

  it("rejects capability discovery payloads that grant execution authority", () => {
    expect(() => RuntimeCapabilityDiscoverySchema.parse({
      generated_at: "2026-05-12T00:00:00.000Z",
      discovery_ref: "runtime-capability-discovery:test",
      authority_granted: false,
      capabilities: [{
        capability_id: "runtime.command_channel",
        kind: "command_channel",
        channel: "command",
        available: true,
        requires_approval: true,
        authority_scope: "none",
        authority_granted: true,
        can_execute: false,
        evidence_refs: ["runtime-command-channel:runtime-control"],
      }],
    })).toThrow();
  });

  it("builds a backend-only runtime snapshot without turning capability discovery into authority", () => {
    const approval: ApprovalRequiredEvent = {
      requestId: "approval-runtime-1",
      expiresAt: Date.parse("2026-05-12T00:10:00.000Z"),
      task: {
        id: "task-runtime-1",
        description: "Approve the runtime control operation",
        action: "approve",
      },
      origin: {
        channel: "telegram",
        conversation_id: "thread-1",
      },
    };

    const snapshot = buildResidentRuntimeInterfaceSnapshot({
      runtimeRoot: "/tmp/pulseed/runtime",
      controlBaseDir: "/tmp/pulseed",
      generatedAt: "2026-05-12T00:05:00.000Z",
      daemonState: {
        status: "running",
        started_at: "2026-05-12T00:00:00.000Z",
        last_loop_at: "2026-05-12T00:04:00.000Z",
      },
      pendingOperations: [makeOperation()],
      pendingApprovals: [approval],
      lastOutboxSeq: 4,
      activeWorkers: [{ worker_id: "worker-1" }],
      operatorHandoffRefs: ["handoff-runtime-1"],
    });

    expect(snapshot.schema_version).toBe("resident-runtime-interface-v1");
    expect(snapshot.connection.status).toBe("online");
    expect(snapshot.command_channel).toMatchObject({
      requires_admission: true,
      capability_discovery_grants_authority: false,
      dispatch_state: "accepting_admitted_commands",
      pending_operation_refs: ["runtime-op-1"],
    });
    expect(snapshot.approval_channel).toMatchObject({
      pending_count: 1,
      pending_approval_refs: ["approval-runtime-1"],
      response_requires_active_approval: true,
      reply_surfaces: ["telegram"],
    });
    expect(snapshot.dev_connector_projection).toMatchObject({
      backend_contract_only: true,
      gui_surface_included: false,
      capability_authority_granted: false,
    });
    expect(snapshot.capability_discovery.authority_granted).toBe(false);
    expect(snapshot.capability_discovery.capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capability_id: "runtime.command_channel",
          requires_approval: true,
          authority_granted: false,
          can_execute: false,
        }),
      ])
    );
  });
});
