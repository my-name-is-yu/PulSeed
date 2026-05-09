import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { StrategyDreamStateStore } from "../../../runtime/store/strategy-dream-state-store.js";
import { consolidateDreamEventWorkflows, loadDreamWorkflowRecords } from "../dream-event-workflows.js";
import type { EventLog } from "../dream-types.js";

async function seedEvents(baseDir: string, events: EventLog[]): Promise<void> {
  const store = new StrategyDreamStateStore(baseDir);
  for (const event of events) {
    await store.appendEventLog(event);
  }
}

describe("dream event workflow consolidation", () => {
  let tmpDir = "";

  afterEach(() => {
    if (tmpDir) cleanupTempDir(tmpDir);
    tmpDir = "";
  });

  it("turns stall and execution events into Dream-owned workflow rows", async () => {
    tmpDir = makeTempDir("dream-event-workflows-");
    await seedEvents(tmpDir, [
      {
        timestamp: "2026-04-12T01:00:00.000Z",
        eventType: "StallDetected",
        goalId: "goal-a",
        taskId: "task-a",
        data: {
          task_id: "task-a",
          stall_type: "confidence_stall",
          suggested_cause: "verification signal is weak",
        },
      },
      {
        timestamp: "2026-04-12T01:05:00.000Z",
        eventType: "PostExecute",
        goalId: "goal-a",
        taskId: "task-a",
        data: {
          task_id: "task-a",
          success: false,
        },
      },
      {
        timestamp: "2026-04-12T01:10:00.000Z",
        eventType: "PostExecute",
        goalId: "goal-a",
        taskId: "task-a",
        data: {
          task_id: "task-a",
          success: true,
        },
      },
    ]);

    const report = await consolidateDreamEventWorkflows(tmpDir);
    const workflows = await loadDreamWorkflowRecords(tmpDir);

    expect(report).toMatchObject({
      eventsScanned: 3,
      malformedEvents: 0,
      workflowCandidates: 2,
      workflowsWritten: 2,
      eventWatermarksAdvanced: 1,
    });
    expect(workflows.map((workflow) => workflow.type).sort()).toEqual([
      "stall_recovery",
      "verification_recovery",
    ]);
    expect(workflows.find((workflow) => workflow.type === "stall_recovery")).toMatchObject({
      applicability: expect.objectContaining({
        goal_ids: ["goal-a"],
        task_ids: ["task-a"],
        event_types: ["StallDetected"],
      }),
      failure_count: 1,
    });
    expect(workflows.find((workflow) => workflow.type === "verification_recovery")).toMatchObject({
      success_count: 1,
      failure_count: 1,
    });
  });

  it("uses event watermarks to keep repeated runs idempotent", async () => {
    tmpDir = makeTempDir("dream-event-workflows-idempotent-");
    await seedEvents(tmpDir, [{
      timestamp: "2026-04-12T01:00:00.000Z",
      eventType: "StallDetected",
      goalId: "goal-a",
      data: {
        stall_type: "confidence_stall",
        suggested_cause: "verification signal is weak",
      },
    }]);

    const first = await consolidateDreamEventWorkflows(tmpDir);
    const second = await consolidateDreamEventWorkflows(tmpDir);

    expect(first.eventsScanned).toBe(1);
    expect(second.eventsScanned).toBe(0);
    expect((await loadDreamWorkflowRecords(tmpDir))).toHaveLength(1);
  });

  it("merges new matching events into existing workflow evidence", async () => {
    tmpDir = makeTempDir("dream-event-workflows-merge-");
    await seedEvents(tmpDir, [{
      timestamp: "2026-04-12T01:00:00.000Z",
      eventType: "StallDetected",
      goalId: "goal-a",
      data: {
        stall_type: "confidence_stall",
        suggested_cause: "verification signal is weak",
      },
    }]);

    await consolidateDreamEventWorkflows(tmpDir);
    await seedEvents(tmpDir, [{
      timestamp: "2026-04-12T02:00:00.000Z",
      eventType: "StallDetected",
      goalId: "goal-a",
      taskId: "task-b",
      data: {
        task_id: "task-b",
        stall_type: "confidence_stall",
        suggested_cause: "verification signal is weak",
      },
    }]);

    const second = await consolidateDreamEventWorkflows(tmpDir);
    const [workflow] = await loadDreamWorkflowRecords(tmpDir);

    expect(second.eventsScanned).toBe(1);
    expect(workflow).toMatchObject({
      failure_count: 2,
      evidence_count: 2,
      created_at: "2026-04-12T01:00:00.000Z",
      updated_at: "2026-04-12T02:00:00.000Z",
    });
    expect(workflow?.applicability.task_ids).toEqual(["task-b"]);
    expect(workflow?.evidence_refs).toEqual([
      "dream/events/goal-a.jsonl#L1",
      "dream/events/goal-a.jsonl#L2",
    ]);
  });
});
