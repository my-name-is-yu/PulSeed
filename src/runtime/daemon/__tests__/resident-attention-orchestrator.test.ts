import { describe, expect, it, vi } from "vitest";
import * as path from "node:path";
import { makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { AttentionStateStore } from "../../store/attention-state-store.js";
import { RuntimeOperationStore } from "../../store/runtime-operation-store.js";
import type { RuntimeControlOperation } from "../../store/runtime-operation-schemas.js";
import { evaluateResidentAttentionAdmission } from "../resident-attention-orchestrator.js";
import type { DaemonRunnerResidentContext } from "../runner-resident-shared.js";

function makeContext(
  baseDir: string,
  startedAt: string,
  loopCount: number,
): Pick<DaemonRunnerResidentContext, "baseDir" | "config" | "state" | "logger"> {
  return {
    baseDir,
    config: {
      runtime_root: "runtime",
    } as DaemonRunnerResidentContext["config"],
    state: {
      started_at: startedAt,
      loop_count: loopCount,
    } as DaemonRunnerResidentContext["state"],
    logger: {
      warn: () => {},
    } as unknown as DaemonRunnerResidentContext["logger"],
  };
}

async function saveVerifiedControl(
  baseDir: string,
  kind: RuntimeControlOperation["kind"],
): Promise<void> {
  const now = new Date().toISOString();
  await new RuntimeOperationStore(path.join(baseDir, "runtime"), { controlBaseDir: baseDir }).save({
    operation_id: `test-control-${kind}`,
    kind,
    state: "verified",
    requested_at: now,
    updated_at: now,
    requested_by: { surface: "cli" },
    reply_target: { surface: "cli" },
    reason: `test ${kind}`,
    expected_health: { daemon_ping: false, gateway_acceptance: false },
    result: { ok: true, message: `${kind} verified` },
  }, { emitEvent: false });
}

describe("resident attention orchestrator", () => {
  it("dedupes the same resident candidate across daemon and store restart", async () => {
    const baseDir = makeTempDir("resident-attention-replay-");
    const input = {
      action: "suggest_goal" as const,
      trigger: "proactive_tick" as const,
      details: { why: "same quiet suggestion" },
      summary: "Resident proactive maintenance selected suggest_goal.",
      now: "2026-05-12T00:00:00.000Z",
    };

    const first = await evaluateResidentAttentionAdmission(
      makeContext(baseDir, "2026-05-12T00:00:00.000Z", 1),
      input,
    );
    const second = await evaluateResidentAttentionAdmission(
      makeContext(baseDir, "2026-05-12T00:05:00.000Z", 20),
      {
        ...input,
        now: "2026-05-12T00:05:00.000Z",
      },
    );

    expect(second.attention_input_id).toBe(first.attention_input_id);
    expect(second.outcome_decision_id).toBe(first.outcome_decision_id);
    expect(first.replay_disposition).toBe("accepted");
    expect(second.replay_disposition).toBe("duplicate");
    expect(second.branch_admitted).toBe(false);

    const snapshot = await new AttentionStateStore(path.join(baseDir, "runtime"), { controlBaseDir: baseDir })
      .loadDecisionChainSnapshot({ includeTerminal: true });
    expect(snapshot.attention_inputs).toHaveLength(1);
    expect(snapshot.agenda_items).toHaveLength(1);
    expect(snapshot.outcome_decisions).toHaveLength(1);
    expect(snapshot.attention_inputs[0]?.source).toEqual(expect.objectContaining({
      source_kind: "resident_proactive_maintenance",
      source_epoch: "resident:resident_proactive_maintenance:proactive_tick:suggest_goal:controls:none",
    }));
  });

  it("records a new current resident decision when companion controls change after replay", async () => {
    const baseDir = makeTempDir("resident-attention-control-replay-");
    const input = {
      action: "suggest_goal" as const,
      trigger: "proactive_tick" as const,
      details: { why: "same quiet suggestion" },
      summary: "Resident proactive maintenance selected suggest_goal.",
      now: "2026-05-12T00:00:00.000Z",
    };

    const first = await evaluateResidentAttentionAdmission(
      makeContext(baseDir, "2026-05-12T00:00:00.000Z", 1),
      input,
    );
    await saveVerifiedControl(baseDir, "stop_all_quiet_work");
    const second = await evaluateResidentAttentionAdmission(
      makeContext(baseDir, "2026-05-12T00:05:00.000Z", 20),
      {
        ...input,
        now: "2026-05-12T00:05:00.000Z",
      },
    );

    expect(second.attention_input_id).not.toBe(first.attention_input_id);
    expect(second.outcome_decision_id).not.toBe(first.outcome_decision_id);

    const snapshot = await new AttentionStateStore(path.join(baseDir, "runtime"), { controlBaseDir: baseDir })
      .loadDecisionChainSnapshot({ includeTerminal: true });
    expect(snapshot.attention_inputs).toHaveLength(2);
    expect(snapshot.outcome_decisions).toHaveLength(2);
    expect(snapshot.outcome_decisions.at(-1)).toEqual(expect.objectContaining({
      admission_status: "rejected",
      downgrade_or_rejection_reason: expect.objectContaining({
        code: "control_suppressed",
      }),
    }));
  });

  it("fails closed without fabricating active suspend control when companion controls are unavailable", async () => {
    const baseDir = makeTempDir("resident-attention-control-unavailable-");
    const savedCycles: unknown[] = [];
    const result = await evaluateResidentAttentionAdmission(
      {
        ...makeContext(baseDir, "2026-05-12T00:00:00.000Z", 1),
        attentionStateStore: {
          saveCycle: vi.fn(async (cycle: unknown) => {
            savedCycles.push(cycle);
            return null;
          }),
        },
        runtimeOperationStore: {
          listCompleted: vi.fn(async () => {
            throw new Error("control db unreadable");
          }),
          listPending: vi.fn(async () => []),
        },
      },
      {
        action: "suggest_goal",
        trigger: "proactive_tick",
        details: { why: "same quiet suggestion" },
        summary: "Resident proactive maintenance selected suggest_goal.",
        now: "2026-05-12T00:00:00.000Z",
      },
    );

    expect(result.branch_admitted).toBe(false);
    expect(result.summary).toContain("runtime companion controls unavailable");
    const persisted = JSON.stringify(savedCycles);
    expect(persisted).toContain("runtime companion controls unavailable; holding resident attention closed");
    expect(persisted).toContain("resident-control-store-unavailable");
    expect(persisted).not.toContain("suspend_companion");
  });
});
