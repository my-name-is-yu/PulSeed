import { describe, expect, it } from "vitest";

import type { StateManager } from "../../../base/state/state-manager.js";
import type { DaemonSnapshot } from "../../../runtime/daemon/client.js";
import { formatGuardrailStatus } from "../chat-runner-guardrail-status.js";

function stateManagerStub(): StateManager {
  return { getBaseDir: () => "/unused" } as unknown as StateManager;
}

function snapshot(overrides: Partial<DaemonSnapshot> = {}): DaemonSnapshot {
  return {
    daemon: null,
    goals: [],
    approvals: [],
    active_workers: [],
    last_outbox_seq: 0,
    auth_sessions: [],
    operator_handoffs: [],
    guardrails: {},
    ...overrides,
  };
}

describe("chat runner guardrail status", () => {
  it("formats typed daemon automation status before runtime fallback stores", async () => {
    const output = await formatGuardrailStatus({
      stateManager: stateManagerStub(),
      snapshot: snapshot({
        operator_handoffs: [{
          title: "Review Browser Login",
          triggers: ["auth_required"],
          recommended_action: "Complete sign-in",
        }],
        runtime_automation: {
          auth_handoffs: {
            pending: [{
              service_key: "github",
              provider_id: "oauth",
              state: "waiting",
              handoff_id: "handoff-1",
            }],
          },
          guardrails: {
            open_breakers: [{
              provider_id: "browser",
              service_key: "web",
              state: "open",
              failure_count: 2,
            }],
          },
          backpressure: { active: [{ id: "work-1" }, { id: "work-2" }] },
          blocked_work: [{
            provider_id: "browser",
            service_key: "web",
            reason: "rate_limit",
          }],
        },
      }),
    });

    expect(output).toContain("Operator handoffs pending:");
    expect(output).toContain("Review Browser Login - Complete sign-in");
    expect(output).toContain("Auth handoffs pending:");
    expect(output).toContain("github via oauth is waiting for operator sign-in.");
    expect(output).toContain("Guardrails:");
    expect(output).toContain("browser/web is temporarily paused after 2 failure(s).");
    expect(output).toContain("Backpressure active: 2 browser workflow(s) in flight");
    expect(output).toContain("Blocked automation work:");
  });

  it("keeps diagnostic guardrail output stable", async () => {
    const output = await formatGuardrailStatus({
      stateManager: stateManagerStub(),
      diagnostic: true,
      snapshot: snapshot({
        operator_handoffs: [{
          handoff_id: "handoff-1",
          triggers: ["auth_required", "operator_review"],
          recommended_action: "Complete sign-in",
        }],
        runtime_automation: {
          guardrails: {
            paused_breakers: [{
              provider_id: "browser",
              service_key: "web",
              state: "paused",
              failure_count: 3,
            }],
          },
          blocked_work: [{
            provider_id: "browser",
            service_key: "web",
            reason: "quota",
          }],
        },
      }),
    });

    expect(output).toContain("handoff-1 [auth_required,operator_review] Complete sign-in");
    expect(output).toContain("breaker browser/web: paused (failures 3)");
    expect(output).toContain("browser/web: quota");
  });

  it("returns null when the snapshot has no status to surface", async () => {
    await expect(formatGuardrailStatus({
      stateManager: stateManagerStub(),
      snapshot: snapshot(),
    })).resolves.toBeNull();
  });
});
