import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StateManager } from "../../../base/state/state-manager.js";
import type { Task } from "../../../base/types/task.js";
import { makeGoal } from "../../../../tests/helpers/fixtures.js";
import { cleanupTempDir, makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { openControlDatabase } from "../control-db/index.js";
import { importLegacyGoalTaskDurableLoopState } from "../goal-task-state-migration.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    goal_id: "goal-1",
    strategy_id: null,
    target_dimensions: ["quality"],
    primary_dimension: "quality",
    work_description: "Improve quality",
    rationale: "Need durable state coverage",
    approach: "Add tests",
    success_criteria: [],
    scope_boundary: {
      in_scope: ["src"],
      out_of_scope: ["release"],
      blast_radius: "low",
    },
    constraints: [],
    plateau_until: null,
    estimated_duration: null,
    consecutive_failure_count: 0,
    reversibility: "reversible",
    task_category: "verification",
    status: "pending",
    started_at: null,
    completed_at: null,
    timeout_at: null,
    heartbeat_at: null,
    created_at: "2026-05-09T00:00:00.000Z",
    ...overrides,
  };
}

describe("GoalTaskStateStore database ownership", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      cleanupTempDir(dir);
    }
  });

  function tempHome(prefix: string): string {
    const dir = makeTempDir(prefix);
    tempDirs.push(dir);
    return dir;
  }

  it("routes StateManager goal/task/checkpoint/pipeline state to Control DB without legacy JSON files", async () => {
    const baseDir = tempHome("pulseed-goal-task-store-");
    const stateManager = new StateManager(baseDir);
    await stateManager.init();

    await stateManager.saveGoal(makeGoal({ id: "goal-1" }));
    await stateManager.writeRaw("tasks/goal-1/task-1.json", makeTask());
    await stateManager.writeRaw("tasks/goal-1/task-history.json", [{ task_id: "task-1", status: "pending" }]);
    await stateManager.writeRaw("tasks/goal-1/ledger/task-1.json", {
      task_id: "task-1",
      goal_id: "goal-1",
      events: [{ type: "acked", ts: "2026-05-09T00:00:00.000Z" }],
      summary: {
        task_id: "task-1",
        goal_id: "goal-1",
        latest_event_type: "acked",
        latest_event_at: "2026-05-09T00:00:00.000Z",
        task_status: "pending",
        stopped_reason: null,
        tokens_used: 0,
        latencies: {},
      },
    });
    await stateManager.writeRaw("checkpoints/goal-1/checkpoint-1.json", {
      checkpoint_id: "checkpoint-1",
      goal_id: "goal-1",
      task_id: "task-1",
      agent_id: "agent-a",
      session_context_snapshot: "context",
      intermediate_results: [],
      created_at: "2026-05-09T00:00:00.000Z",
      metadata: {},
    });
    await stateManager.writeRaw("pipelines/task-1.json", {
      pipeline_id: "pipeline-1",
      task_id: "task-1",
      current_stage_index: 0,
      completed_stages: [],
      status: "running",
      started_at: "2026-05-09T00:00:00.000Z",
      updated_at: "2026-05-09T00:00:00.000Z",
    });

    expect(await stateManager.loadGoal("goal-1")).toMatchObject({ id: "goal-1" });
    expect(await stateManager.loadTask("goal-1", "task-1")).toMatchObject({ id: "task-1" });
    expect(await stateManager.readRaw("checkpoints/goal-1/index.json")).toMatchObject({
      goal_id: "goal-1",
      checkpoints: [{ checkpoint_id: "checkpoint-1", task_id: "task-1", agent_id: "agent-a", created_at: "2026-05-09T00:00:00.000Z" }],
    });
    expect((await stateManager.listPipelinesByStatus("running")).map((entry) => entry.pipeline_id)).toEqual(["pipeline-1"]);
    expect(fs.existsSync(path.join(baseDir, "goals", "goal-1", "goal.json"))).toBe(false);
    expect(fs.existsSync(path.join(baseDir, "tasks", "goal-1", "task-1.json"))).toBe(false);
    expect(fs.existsSync(path.join(baseDir, "tasks", "goal-1", "ledger", "task-1.json"))).toBe(false);
  });

  it("imports legacy goal/task/checkpoint files only through the explicit migration boundary", async () => {
    const baseDir = tempHome("pulseed-goal-task-import-");
    fs.mkdirSync(path.join(baseDir, "goals", "goal-1"), { recursive: true });
    fs.mkdirSync(path.join(baseDir, "tasks", "goal-1", "ledger"), { recursive: true });
    fs.mkdirSync(path.join(baseDir, "checkpoints", "goal-1"), { recursive: true });
    fs.writeFileSync(path.join(baseDir, "goals", "goal-1", "goal.json"), JSON.stringify(makeGoal({ id: "goal-1" })));
    fs.writeFileSync(path.join(baseDir, "tasks", "goal-1", "task-1.json"), JSON.stringify(makeTask()));
    fs.writeFileSync(path.join(baseDir, "tasks", "goal-1", "task-history.json"), JSON.stringify([{ task_id: "task-1", status: "pending" }]));
    fs.writeFileSync(path.join(baseDir, "tasks", "goal-1", "ledger", "task-1.json"), JSON.stringify({
      task_id: "task-1",
      goal_id: "goal-1",
      events: [],
      summary: { task_id: "task-1", goal_id: "goal-1", task_status: "pending", tokens_used: 0 },
    }));
    fs.writeFileSync(path.join(baseDir, "checkpoints", "goal-1", "checkpoint-1.json"), JSON.stringify({
      checkpoint_id: "checkpoint-1",
      goal_id: "goal-1",
      task_id: "task-1",
      agent_id: "agent-a",
      session_context_snapshot: "context",
      intermediate_results: [],
      created_at: "2026-05-09T00:00:00.000Z",
      metadata: {},
    }));

    const report = await importLegacyGoalTaskDurableLoopState(baseDir);
    expect(report).toMatchObject({
      goals: 1,
      tasks: 1,
      taskHistoryRecords: 1,
      taskOutcomeLedgers: 1,
      checkpoints: 1,
    });

    const stateManager = new StateManager(baseDir);
    await stateManager.init();
    expect(await stateManager.loadGoal("goal-1")).toMatchObject({ id: "goal-1" });
    expect(await stateManager.loadTask("goal-1", "task-1")).toMatchObject({ id: "task-1" });
    const db = await openControlDatabase({ baseDir });
    try {
      expect(db.listLegacyImports().filter((record) => record.migration_name === "goal-task-durable-loop-state")).toHaveLength(5);
    } finally {
      db.close();
    }
  });

  it("imports legacy archived goal/task files through the explicit migration boundary", async () => {
    const baseDir = tempHome("pulseed-goal-task-archived-import-");
    fs.mkdirSync(path.join(baseDir, "archive", "goal-archived", "goal"), { recursive: true });
    fs.mkdirSync(path.join(baseDir, "archive", "goal-archived", "tasks", "ledger"), { recursive: true });
    fs.writeFileSync(
      path.join(baseDir, "archive", "goal-archived", "goal", "goal.json"),
      JSON.stringify(makeGoal({ id: "goal-archived", status: "archived" })),
    );
    fs.writeFileSync(
      path.join(baseDir, "archive", "goal-archived", "tasks", "task-archived.json"),
      JSON.stringify(makeTask({ id: "task-archived", goal_id: "goal-archived", status: "completed" })),
    );
    fs.writeFileSync(
      path.join(baseDir, "archive", "goal-archived", "tasks", "ledger", "task-archived.json"),
      JSON.stringify({
        task_id: "task-archived",
        goal_id: "goal-archived",
        events: [],
        summary: { task_id: "task-archived", goal_id: "goal-archived", task_status: "completed", tokens_used: 0 },
      }),
    );

    const report = await importLegacyGoalTaskDurableLoopState(baseDir);
    expect(report).toMatchObject({
      goals: 1,
      tasks: 1,
      taskOutcomeLedgers: 1,
    });

    const stateManager = new StateManager(baseDir);
    await stateManager.init();
    expect(await stateManager.listArchivedGoals()).toEqual(["goal-archived"]);
    expect(await stateManager.loadGoal("goal-archived")).toMatchObject({
      id: "goal-archived",
      status: "archived",
    });
    expect(await stateManager.loadTask("goal-archived", "task-archived")).toMatchObject({ id: "task-archived" });
    const db = await openControlDatabase({ baseDir });
    try {
      expect(
        db.listLegacyImports().some((record) =>
          record.migration_name === "goal-task-durable-loop-state" &&
          record.source_kind === "archived_goal_state" &&
          record.source_path === "archive/goal-archived/goal/goal.json"
        ),
      ).toBe(true);
    } finally {
      db.close();
    }
  });
});
