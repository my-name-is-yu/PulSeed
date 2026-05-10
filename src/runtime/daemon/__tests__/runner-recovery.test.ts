import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { StateManager } from "../../../base/state/state-manager.js";
import type { Task } from "../../../base/types/task.js";
import type { PipelineState } from "../../../base/types/pipeline.js";
import { makeTempDir, cleanupTempDir } from "../../../../tests/helpers/temp-dir.js";
import {
  findRunningTasks,
  reconcileInterruptedExecutions,
} from "../runner-recovery.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    goal_id: "goal-1",
    strategy_id: null,
    target_dimensions: ["dim"],
    primary_dimension: "dim",
    work_description: "test task",
    rationale: "test rationale",
    approach: "test approach",
    success_criteria: [
      {
        description: "Tests pass",
        verification_method: "npx vitest run",
        is_blocking: true,
      },
    ],
    scope_boundary: {
      in_scope: ["module A"],
      out_of_scope: ["module B"],
      blast_radius: "low",
    },
    constraints: [],
    plateau_until: null,
    estimated_duration: { value: 2, unit: "hours" },
    consecutive_failure_count: 0,
    reversibility: "reversible",
    task_category: "normal",
    status: "pending",
    started_at: null,
    completed_at: null,
    timeout_at: null,
    heartbeat_at: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("runner-recovery", () => {
  let tmpDir: string | null = null;

  afterEach(() => {
    if (tmpDir) {
      cleanupTempDir(tmpDir);
      tmpDir = null;
    }
  });

  it("finds only valid running task rows and ignores malformed legacy files", async () => {
    tmpDir = makeTempDir();
    const stateManager = new StateManager(tmpDir);
    await stateManager.init();
    await stateManager.saveTask(makeTask({ id: "running", status: "running" }));
    await stateManager.saveTask(makeTask({ id: "done", status: "completed" }));
    await stateManager.writeRaw("tasks/goal-1/task-history.json", [{ task_id: "old" }]);
    fs.mkdirSync(`${tmpDir}/tasks/goal-1`, { recursive: true });
    fs.writeFileSync(`${tmpDir}/tasks/goal-1/malformed.json`, "{not-json");

    const tasks = await findRunningTasks(tmpDir, stateManager);

    expect(tasks.map((task) => task.id)).toEqual(["running"]);
  });

  it("reconciles running tasks and stale pipelines on startup", async () => {
    tmpDir = makeTempDir();
    const stateManager = new StateManager(tmpDir);
    await stateManager.init();
    const runningTask = makeTask({
      id: "task-recover",
      goal_id: "goal-recover",
      status: "running",
      started_at: new Date(Date.now() - 5_000).toISOString(),
      consecutive_failure_count: 1,
    });
    await stateManager.saveTask(runningTask);
    const runningPipeline: PipelineState = {
      pipeline_id: "pipe-1",
      task_id: "task-pipeline",
      current_stage_index: 1,
      completed_stages: [],
      status: "running",
      started_at: new Date(Date.now() - 10_000).toISOString(),
      updated_at: new Date(Date.now() - 5_000).toISOString(),
    };
    await stateManager.savePipeline("task-pipeline", runningPipeline);

    const recoveredGoalIds = await reconcileInterruptedExecutions({
      baseDir: tmpDir,
      stateManager,
      logger: { warn: vi.fn() },
    });

    expect(recoveredGoalIds).toEqual(["goal-recover"]);
    const task = await stateManager.loadTask(runningTask.goal_id, runningTask.id) as Record<string, unknown>;
    expect(task.status).toBe("cancelled");
    expect(String(task.execution_output)).toContain("[RECOVERED]");

    const history = await stateManager.loadTaskHistory(runningTask.goal_id) as Array<Record<string, unknown>>;
    expect(history.at(-1)).toMatchObject({
      task_id: "task-recover",
      status: "cancelled",
      primary_dimension: "dim",
      consecutive_failure_count: 1,
      recovery_source: "daemon_startup",
      recovery_reason: "task execution interrupted by daemon recovery; no live worker remains attached",
      retry_intent: "task was marked terminal during daemon recovery",
    });

    const ledger = await stateManager.loadTaskOutcomeLedger(runningTask.goal_id, runningTask.id) as { events: Array<{ type: string; reason?: string; stopped_reason?: string }> };
    expect(ledger.events.map((event) => event.type)).toEqual(["failed"]);
    expect(ledger.events[0]).toMatchObject({
      reason: "task execution interrupted by daemon recovery; no live worker remains attached",
      stopped_reason: "cancelled",
    });

    const pipeline = await stateManager.loadPipeline("task-pipeline") as Record<string, unknown>;
    expect(pipeline.status).toBe("interrupted");
  });

  it("marks expired running tasks as timed out during startup recovery", async () => {
    tmpDir = makeTempDir();
    const stateManager = new StateManager(tmpDir);
    await stateManager.init();
    const runningTask = makeTask({
      id: "task-timeout",
      goal_id: "goal-timeout",
      status: "running",
      started_at: new Date(Date.now() - 10_000).toISOString(),
      timeout_at: new Date(Date.now() - 1_000).toISOString(),
    });
    await stateManager.saveTask(runningTask);

    await reconcileInterruptedExecutions({
      baseDir: tmpDir,
      stateManager,
      logger: { warn: vi.fn() },
    });

    const task = await stateManager.loadTask(runningTask.goal_id, runningTask.id) as Record<string, unknown>;
    expect(task.status).toBe("timed_out");
    const ledger = await stateManager.loadTaskOutcomeLedger(runningTask.goal_id, runningTask.id) as unknown as {
      events: Array<{ type: string; stopped_reason?: string }>;
    };
    expect(ledger.events[0]).toMatchObject({
      type: "failed",
      stopped_reason: "timeout",
    });
  });

  it("completes interrupted running tasks when fresh artifact contract evidence passes", async () => {
    tmpDir = makeTempDir();
    const workspace = path.join(tmpDir, "workspace");
    fs.mkdirSync(path.join(workspace, "reports"), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, "reports", "restart.json"),
      JSON.stringify({ scenario: "daemon-stop-restart", restart_safe: true })
    );

    const stateManager = new StateManager(tmpDir);
    await stateManager.init();
    const runningTask = makeTask({
      id: "task-artifact-recover",
      goal_id: "goal-artifact-recover",
      status: "running",
      started_at: new Date(Date.now() - 5_000).toISOString(),
      constraints: [`workspace_path:${workspace}`],
      artifact_contract: {
        required: true,
        required_artifacts: [{
          kind: "metrics_json",
          path: "reports/restart.json",
          required_fields: ["scenario", "restart_safe"],
          field_types: {
            scenario: "string",
            restart_safe: "boolean",
          },
          fresh_after_task_start: true,
        }],
      },
    });
    await stateManager.saveTask(runningTask);

    const recoveredGoalIds = await reconcileInterruptedExecutions({
      baseDir: tmpDir,
      stateManager,
      logger: { warn: vi.fn() },
      recoverySource: "daemon_shutdown",
      terminalStatus: "cancelled",
      stoppedReason: "cancelled",
    });

    expect(recoveredGoalIds).toEqual(["goal-artifact-recover"]);
    const task = await stateManager.loadTask(runningTask.goal_id, runningTask.id) as Record<string, unknown>;
    expect(task.status).toBe("completed");
    expect(task.verification_verdict).toBe("pass");
    expect(String(task.execution_output)).toContain("artifact_contract verification passed");

    const verification = await stateManager.loadTaskVerificationResult(runningTask.id) as Record<string, unknown>;
    expect(verification).toMatchObject({
      verdict: "pass",
      artifact_contract_status: {
        applicable: true,
        passed: true,
      },
    });

    const history = await stateManager.loadTaskHistory(runningTask.goal_id) as Array<Record<string, unknown>>;
    expect(history.at(-1)).toMatchObject({
      task_id: "task-artifact-recover",
      status: "completed",
      recovery_source: "daemon_shutdown",
      retry_intent: "task completed from durable artifact evidence during daemon recovery",
    });

    const ledger = await stateManager.loadTaskOutcomeLedger(runningTask.goal_id, runningTask.id) as unknown as {
      events: Array<{ type: string; verification_verdict?: string }>;
      summary: { latest_event_type: string; task_status: string; verification_verdict?: string };
    };
    expect(ledger.events.map((event) => event.type)).toEqual(["succeeded"]);
    expect(ledger.events[0]).toMatchObject({
      verification_verdict: "pass",
    });
    expect(ledger.summary).toMatchObject({
      latest_event_type: "succeeded",
      task_status: "completed",
      verification_verdict: "pass",
    });
  });

  it("keeps live-owned running tasks while recovering unrelated stale running tasks", async () => {
    tmpDir = makeTempDir();
    const stateManager = new StateManager(tmpDir);
    await stateManager.init();
    const liveOwnedTask = makeTask({
      id: "task-live",
      goal_id: "goal-live",
      status: "running",
      started_at: new Date(Date.now() - 10_000).toISOString(),
    });
    const staleTask = makeTask({
      id: "task-stale",
      goal_id: "goal-stale",
      status: "running",
      started_at: new Date(Date.now() - 10_000).toISOString(),
    });
    await stateManager.saveTask(liveOwnedTask);
    await stateManager.saveTask(staleTask);

    const recoveredGoalIds = await reconcileInterruptedExecutions({
      baseDir: tmpDir,
      stateManager,
      logger: { warn: vi.fn() },
      liveOwnerGoalIds: ["goal-live"],
      recoverySource: "daemon_shutdown",
      terminalStatus: "cancelled",
      stoppedReason: "cancelled",
    });

    expect(recoveredGoalIds).toEqual(["goal-stale"]);
    const liveTask = await stateManager.loadTask(liveOwnedTask.goal_id, liveOwnedTask.id) as Record<string, unknown>;
    expect(liveTask.status).toBe("running");
    const recoveredTask = await stateManager.loadTask(staleTask.goal_id, staleTask.id) as Record<string, unknown>;
    expect(recoveredTask.status).toBe("cancelled");
    const liveLedger = await stateManager.loadTaskOutcomeLedger(liveOwnedTask.goal_id, liveOwnedTask.id);
    expect(liveLedger).toBeNull();
    const staleLedger = await stateManager.loadTaskOutcomeLedger(staleTask.goal_id, staleTask.id) as {
      events: Array<{ type: string; stopped_reason?: string }>;
    };
    expect(staleLedger.events.map((event) => event.type)).toEqual(["failed"]);
    expect(staleLedger.events[0]).toMatchObject({
      stopped_reason: "cancelled",
    });
  });
});
