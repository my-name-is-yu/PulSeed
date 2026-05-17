import { afterEach, describe, expect, it, vi } from "vitest";
import * as path from "node:path";
import { cleanupTempDir, makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { AttentionStateStore } from "../../store/attention-state-store.js";
import { RuntimeOperationStore } from "../../store/runtime-operation-store.js";
import type { RuntimeControlOperation } from "../../store/runtime-operation-schemas.js";
import { evaluateResidentAttentionAdmission } from "../resident-attention-orchestrator.js";
import type { DaemonRunnerResidentContext } from "../runner-resident-shared.js";

const tempDirs = new Set<string>();

function makeTrackedTempDir(prefix: string): string {
  const dir = makeTempDir(prefix);
  tempDirs.add(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    cleanupTempDir(dir);
  }
  tempDirs.clear();
});

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

function peerInitiativeDetails(): Record<string, unknown> {
  return {
    peer_initiative: {
      kind: "care_presence",
      message: "今日も頑張ってね。",
      action_plan: { mode: "care_only", permission_required: false },
      worthiness: {
        can_be_valuable_without_reply: true,
        user_cognitive_load: "low",
        reply_pressure: "none",
        care_value: "high",
        attention_fit: "medium",
        concrete_helpfulness: "medium",
        self_serving_risk: "none",
        tutorial_risk: "none",
      },
    },
  };
}

function permissionedPeerInitiativeDetails(): Record<string, unknown> {
  return {
    peer_initiative: {
      kind: "permissioned_attention_action",
      message: "この下書きでリマインド候補を作れるけど、作っていい？",
      action_plan: {
        mode: "permissioned_external_action",
        proposed_action_kind: "schedule_reminder",
        prepared_artifact_ref: "peer-artifact:reminder-candidate",
        permission_required: true,
        confirmation_phrase: "この内容でリマインドを作って",
      },
      worthiness: {
        can_be_valuable_without_reply: true,
        user_cognitive_load: "low",
        reply_pressure: "soft",
        care_value: "medium",
        attention_fit: "strong",
        concrete_helpfulness: "high",
        self_serving_risk: "none",
        tutorial_risk: "none",
      },
    },
  };
}

describe("resident attention orchestrator", () => {
  it("dedupes the same resident candidate across daemon and store restart", async () => {
    const baseDir = makeTrackedTempDir("resident-attention-replay-");
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
    expect(first.branch_admitted).toBe(true);
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
    const concernState = await new AttentionStateStore(path.join(baseDir, "runtime"), { controlBaseDir: baseDir })
      .loadConcernState();
    expect(concernState.clusters).toHaveLength(1);
    expect(concernState.agenda_items[0]).toMatchObject({
      clusterRef: expect.objectContaining({ kind: "attention_cluster" }),
      needsRegrounding: false,
    });
    expect(concernState.decompositions[0]?.children.length).toBeGreaterThan(0);
  });

  it("records a new current resident decision when companion controls change after replay", async () => {
    const baseDir = makeTrackedTempDir("resident-attention-control-replay-");
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
    expect(second.outcome_decision_id).toBeUndefined();
    expect(second.admission_status).toBe("not_selected");
    expect(second.branch_admitted).toBe(false);

    const snapshot = await new AttentionStateStore(path.join(baseDir, "runtime"), { controlBaseDir: baseDir })
      .loadDecisionChainSnapshot({ includeTerminal: true });
    expect(snapshot.attention_inputs).toHaveLength(2);
    expect(snapshot.initiative_gate_decisions).toHaveLength(2);
    expect(snapshot.initiative_gate_decisions.at(-1)?.input_refs).toContainEqual({
      kind: "agent_agenda_item",
      id: second.agenda_item_id,
    });
    expect(snapshot.outcome_decisions).toHaveLength(1);
  });

  it("returns the agenda item produced for the current resident urge when prior concerns exist", async () => {
    const baseDir = makeTrackedTempDir("resident-attention-current-agenda-");
    const first = await evaluateResidentAttentionAdmission(
      makeContext(baseDir, "2026-05-12T00:00:00.000Z", 1),
      {
        action: "suggest_goal",
        trigger: "proactive_tick",
        details: { topic: "alpha" },
        summary: "Resident proactive maintenance selected the alpha concern.",
        now: "2026-05-12T00:00:00.000Z",
      },
    );
    const second = await evaluateResidentAttentionAdmission(
      makeContext(baseDir, "2026-05-12T00:05:00.000Z", 2),
      {
        action: "suggest_goal",
        trigger: "proactive_tick",
        details: { topic: "beta" },
        summary: "Resident proactive maintenance selected the beta concern.",
        now: "2026-05-12T00:05:00.000Z",
      },
    );
    const concernState = await new AttentionStateStore(path.join(baseDir, "runtime"), { controlBaseDir: baseDir })
      .loadConcernState();
    const currentAgenda = concernState.agenda_items.find((item) =>
      item.source_urge_refs.some((urgeRef) => urgeRef.id === second.urge_id)
    );
    const snapshot = await new AttentionStateStore(path.join(baseDir, "runtime"), { controlBaseDir: baseDir })
      .loadDecisionChainSnapshot({ includeTerminal: true });
    const secondGate = snapshot.initiative_gate_decisions.find((decision) =>
      decision.decision_id === second.initiative_gate_decision_id
    );
    const secondOutcome = snapshot.outcome_decisions.find((decision) =>
      decision.outcome_decision_id === second.outcome_decision_id
    );

    expect(second.replay_disposition).toBe("accepted");
    expect(second.agenda_item_id).not.toBe(first.agenda_item_id);
    expect(second.agenda_item_id).toBe(currentAgenda?.agenda_item_id);
    expect(secondGate?.input_refs).toContainEqual({
      kind: "agent_agenda_item",
      id: second.agenda_item_id,
    });
    expect(secondOutcome?.runtime_item_refs).toEqual([{
      kind: "runtime_item",
      id: second.agenda_item_id,
    }]);
  });

  it("requires surface-derived runtime-control admission before peer initiatives can express to the user", async () => {
    const heldBaseDir = makeTrackedTempDir("resident-attention-peer-no-surface-");
    const admittedBaseDir = makeTrackedTempDir("resident-attention-peer-surface-");
    const held = await evaluateResidentAttentionAdmission(
      makeContext(heldBaseDir, "2026-05-12T00:00:00.000Z", 1),
      {
        action: "peer_initiative",
        trigger: "proactive_tick",
        details: peerInitiativeDetails(),
        summary: "Resident proactive maintenance selected peer_initiative.",
        now: "2026-05-12T00:00:00.000Z",
      },
    );
    const admitted = await evaluateResidentAttentionAdmission(
      makeContext(admittedBaseDir, "2026-05-12T00:00:00.000Z", 1),
      {
        action: "peer_initiative",
        trigger: "proactive_tick",
        details: peerInitiativeDetails(),
        summary: "Resident proactive maintenance selected peer_initiative.",
        now: "2026-05-12T00:00:00.000Z",
        surfaceActivityMetadata: {
          surface_id: "relationship-profile-surface:peer:1",
          surface_included_count: 1,
          surface_excluded_count: 0,
        },
      },
    );

    expect(held.branch_admitted).toBe(false);
    expect(held.admission_status).toBe("held");
    expect(held.summary).toContain("resident-peer-initiative-surface:missing");
    expect(admitted.branch_admitted).toBe(true);
    expect(admitted.final_outcome).toBe("express_to_user");

    const snapshot = await new AttentionStateStore(path.join(admittedBaseDir, "runtime"), { controlBaseDir: admittedBaseDir })
      .loadDecisionChainSnapshot({ includeTerminal: true });
    const gate = snapshot.initiative_gate_decisions.find((decision) =>
      decision.decision_id === admitted.initiative_gate_decision_id
    );
    expect(gate?.required_runtime_control_refs).toHaveLength(1);
    expect(gate?.required_runtime_control_refs[0]).toMatchObject({
      kind: "runtime_control",
    });
    expect(gate?.required_runtime_control_refs[0]?.id).toMatch(/^resident-peer-initiative-surface:/);
    expect(gate?.required_runtime_control_refs[0]?.id).not.toBe("resident-peer-initiative-surface:daemon");
  });

  it("requires surface-derived runtime-control admission before peer initiatives can ask approval", async () => {
    const heldBaseDir = makeTrackedTempDir("resident-attention-peer-approval-no-surface-");
    const admittedBaseDir = makeTrackedTempDir("resident-attention-peer-approval-surface-");
    const held = await evaluateResidentAttentionAdmission(
      makeContext(heldBaseDir, "2026-05-12T00:00:00.000Z", 1),
      {
        action: "peer_initiative",
        trigger: "proactive_tick",
        details: permissionedPeerInitiativeDetails(),
        summary: "Resident proactive maintenance selected permissioned peer_initiative.",
        now: "2026-05-12T00:00:00.000Z",
      },
    );
    const admitted = await evaluateResidentAttentionAdmission(
      makeContext(admittedBaseDir, "2026-05-12T00:00:00.000Z", 1),
      {
        action: "peer_initiative",
        trigger: "proactive_tick",
        details: permissionedPeerInitiativeDetails(),
        summary: "Resident proactive maintenance selected permissioned peer_initiative.",
        now: "2026-05-12T00:00:00.000Z",
        surfaceActivityMetadata: {
          surface_id: "relationship-profile-surface:peer:approval",
          surface_included_count: 1,
          surface_excluded_count: 0,
        },
      },
    );

    expect(held.branch_admitted).toBe(false);
    expect(held.admission_status).toBe("held");
    expect(held.summary).toContain("resident-peer-initiative-surface:missing");
    expect(admitted.branch_admitted).toBe(true);
    expect(admitted.final_outcome).toBe("request_approval");
  });

  it("fails closed without fabricating active suspend control when companion controls are unavailable", async () => {
    const baseDir = makeTrackedTempDir("resident-attention-control-unavailable-");
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
