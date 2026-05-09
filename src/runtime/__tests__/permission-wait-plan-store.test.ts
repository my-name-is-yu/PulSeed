import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempDir, cleanupTempDir } from "../../../tests/helpers/temp-dir.js";
import {
  PermissionWaitPlanRecordSchema,
  PermissionWaitPlanStore,
  type PermissionWaitCanonicalPlan,
} from "../store/permission-wait-plan-store.js";

describe("PermissionWaitPlanStore", () => {
  let tmpDir: string;
  let now: number;
  let eventSeq: number;
  let store: PermissionWaitPlanStore;

  beforeEach(() => {
    tmpDir = makeTempDir();
    now = 1_000;
    eventSeq = 0;
    store = new PermissionWaitPlanStore(tmpDir, {
      now: () => now,
      createEventId: () => `event-${++eventSeq}`,
    });
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  function makePlan(overrides: Partial<PermissionWaitCanonicalPlan> = {}): PermissionWaitCanonicalPlan {
    return {
      schema_version: "permission-wait-canonical-plan-v1",
      tool_name: "shell",
      input: { command: "npm test", cwd: "." },
      cwd: "/repo",
      command: "npm test",
      target: {
        goal_id: "goal-1",
        run_id: "run-1",
        session_id: "session-1",
        turn_id: "turn-1",
        tool_call_id: "call-1",
      },
      permission: {
        permission_level: "execute",
        is_destructive: false,
        reversibility: "reversible",
      },
      state_epoch: "epoch-1",
      capability_facts: {
        tool_permission_level: "execute",
        tool_is_read_only: false,
        tool_is_destructive: false,
        tool_activity_category: "test",
        tool_tags: ["shell"],
        host_decision_status: "needs_permission",
        host_decision_reason: "Host policy requires permission.",
      },
      ...overrides,
    };
  }

  it("round-trips a waiting_for_permission plan through the control database", async () => {
    const record = await store.createWaiting({
      wait_plan_id: "wait-1",
      approval_id: "approval-1",
      goal_id: "goal-1",
      canonical_plan: makePlan(),
      audit_refs: ["audit:request"],
    });

    expect(record).toMatchObject({
      schema_version: "permission-wait-plan-v1",
      wait_plan_id: "wait-1",
      approval_id: "approval-1",
      state: "waiting_for_permission",
      audit_events: [
        {
          state: "waiting_for_permission",
          reason: "approval_required",
        },
      ],
    });
    expect(await store.load("wait-1")).toEqual(record);
    expect(fs.existsSync(path.join(tmpDir, "state", "pulseed-control.sqlite"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "permission-wait-plans", "wait-1.json"))).toBe(false);
  });

  it("rejects unsafe permission wait plan timestamps before writing", async () => {
    now = Number.MAX_SAFE_INTEGER + 1;

    await expect(store.createWaiting({
      wait_plan_id: "wait-unsafe-now",
      approval_id: "approval-unsafe-now",
      canonical_plan: makePlan(),
    })).rejects.toThrow();
    expect(await store.load("wait-unsafe-now")).toBeNull();

    now = 1_000;
    await expect(store.createWaiting({
      wait_plan_id: "wait-unsafe-expiry",
      approval_id: "approval-unsafe-expiry",
      expires_at: Number.POSITIVE_INFINITY,
      canonical_plan: makePlan(),
    })).rejects.toThrow();
    expect(await store.load("wait-unsafe-expiry")).toBeNull();
  });

  it("does not read legacy permission wait plan JSON on the normal store path", async () => {
    fs.mkdirSync(path.join(tmpDir, "permission-wait-plans"), { recursive: true });
    const recordPath = path.join(tmpDir, "permission-wait-plans", "wait-corrupt.json");
    fs.writeFileSync(recordPath, JSON.stringify(PermissionWaitPlanRecordSchema.parse({
      schema_version: "permission-wait-plan-v1",
      wait_plan_id: "wait-corrupt",
      approval_id: "approval-corrupt",
      state: "waiting_for_permission",
      created_at: 1_000,
      updated_at: 1_000,
      canonical_plan: makePlan(),
      audit_refs: [],
      audit_events: [],
    }), null, 2), "utf8");

    await expect(store.load("wait-corrupt")).resolves.toBeNull();
    await expect(store.list()).resolves.toEqual([]);
  });

  it("approves and resumes only the stored canonical plan", async () => {
    const plan = makePlan();
    await store.createWaiting({
      wait_plan_id: "wait-approve",
      approval_id: "approval-approve",
      canonical_plan: plan,
    });
    now = 1_100;
    await store.markApproved("wait-approve", {
      response_channel: "chat",
      audit_refs: ["approval:approval-approve"],
    });
    now = 1_200;

    const resumed = await store.resumeApproved("wait-approve", {
      canonical_plan: plan,
      audit_refs: ["tool:shell:call-1"],
    });

    expect(resumed.status).toBe("resumed");
    expect(await store.load("wait-approve")).toMatchObject({
      state: "resumed",
      resumed_at: 1_200,
      audit_refs: ["approval:approval-approve", "tool:shell:call-1"],
      audit_events: [
        expect.objectContaining({ state: "waiting_for_permission" }),
        expect.objectContaining({ state: "approved" }),
        expect.objectContaining({ state: "resumed" }),
      ],
    });
  });

  it("rejects changed command, cwd, target, state epoch, and capability facts before resume", async () => {
    const plan = makePlan();
    await store.createWaiting({
      wait_plan_id: "wait-mismatch",
      approval_id: "approval-mismatch",
      canonical_plan: plan,
    });
    await store.markApproved("wait-mismatch");

    const result = await store.resumeApproved("wait-mismatch", {
      canonical_plan: makePlan({
        input: { command: "npm run build", cwd: "subdir" },
        cwd: "/repo/subdir",
        command: "npm run build",
        target: { ...plan.target, run_id: "run-2" },
        state_epoch: "epoch-2",
        capability_facts: {
          ...plan.capability_facts,
          host_decision_reason: "Different policy evidence.",
        },
      }),
    });

    expect(result.status).toBe("mismatch_rejected");
    if (result.status === "mismatch_rejected") {
      expect(result.mismatch_reasons).toEqual(expect.arrayContaining([
        "cwd_changed",
        "command_changed",
        "state_epoch_changed",
        "target_changed",
        "capability_facts_changed",
        "input_changed",
      ]));
    }
    expect(await store.load("wait-mismatch")).toMatchObject({
      state: "mismatch_rejected",
      audit_events: expect.arrayContaining([
        expect.objectContaining({
          state: "mismatch_rejected",
          reason: "canonical_plan_mismatch",
        }),
      ]),
    });
  });

  it("keeps denied and expired approvals as non-resumable state", async () => {
    const plan = makePlan();
    await store.createWaiting({
      wait_plan_id: "wait-denied",
      approval_id: "approval-denied",
      canonical_plan: plan,
    });
    await store.markDenied("wait-denied", { reason: "operator_rejected" });
    await expect(store.resumeApproved("wait-denied", { canonical_plan: plan })).resolves.toMatchObject({
      status: "not_approved",
      record: { state: "denied" },
    });

    await store.createWaiting({
      wait_plan_id: "wait-expired",
      approval_id: "approval-expired",
      expires_at: 1_500,
      canonical_plan: plan,
    });
    await store.markApproved("wait-expired");
    now = 1_600;
    await expect(store.resumeApproved("wait-expired", { canonical_plan: plan })).resolves.toMatchObject({
      status: "expired",
      record: { state: "expired" },
    });
  });
});
