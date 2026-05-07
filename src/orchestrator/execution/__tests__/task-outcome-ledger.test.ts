import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { StateManager } from "../../../base/state/state-manager.js";
import type { Task } from "../../../base/types/task.js";
import {
  appendTaskOutcomeEvent,
  recordTaskOutcomeMutation,
  summarizeTaskOutcomeLedgers,
} from "../task/task-outcome-ledger.js";
import { makeTempDir } from "../../../../tests/helpers/temp-dir.js";

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
    success_criteria: [],
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

describe("task outcome ledger", () => {
  let tmpDir: string;
  let stateManager: StateManager;

  beforeEach(() => {
    tmpDir = makeTempDir();
    stateManager = new StateManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("preserves stopped reasons in summaries and aggregate failure counts", async () => {
    await appendTaskOutcomeEvent(stateManager, {
      task: makeTask({ id: "timeout-task", status: "timed_out" }),
      type: "failed",
      stoppedReason: "timeout",
    });
    await appendTaskOutcomeEvent(stateManager, {
      task: makeTask({ id: "cancelled-task", status: "cancelled" }),
      type: "failed",
      stoppedReason: "cancelled",
    });
    await appendTaskOutcomeEvent(stateManager, {
      task: makeTask({ id: "error-task", status: "error" }),
      type: "failed",
      stoppedReason: "error",
    });
    await appendTaskOutcomeEvent(stateManager, {
      task: makeTask({ id: "discarded-timeout-task", status: "timed_out" }),
      type: "abandoned",
      stoppedReason: "timeout",
    });

    const timeoutLedger = await stateManager.readRaw("tasks/goal-1/ledger/timeout-task.json") as {
      summary: { stopped_reason: string | null };
    };
    const aggregate = await summarizeTaskOutcomeLedgers(tmpDir);

    expect(timeoutLedger.summary.stopped_reason).toBe("timeout");
    expect(aggregate.failed).toBe(3);
    expect(aggregate.abandoned).toBe(1);
    expect(aggregate.failure_stopped_reasons).toEqual({
      timeout: 2,
      policy_blocked: 0,
      cancelled: 1,
      error: 1,
      unknown: 0,
      other: 0,
    });
  });

  it("does not reuse an older stopped reason for a later ordinary failure", async () => {
    const task = makeTask({ id: "task-stale", status: "timed_out" });
    await appendTaskOutcomeEvent(stateManager, {
      task,
      type: "failed",
      stoppedReason: "timeout",
    });
    const ordinaryFailure = { ...task, status: "error" as const };
    await appendTaskOutcomeEvent(stateManager, {
      task: ordinaryFailure,
      type: "failed",
    });

    const ledger = await stateManager.readRaw("tasks/goal-1/ledger/task-stale.json") as {
      events: Array<{ stopped_reason: string | null }>;
      summary: { stopped_reason: string | null };
    };
    const aggregate = await summarizeTaskOutcomeLedgers(tmpDir);

    expect(ledger.events.at(-1)?.stopped_reason).toBeNull();
    expect(ledger.summary.stopped_reason).toBeNull();
    expect(aggregate.failure_stopped_reasons).toEqual({
      timeout: 0,
      policy_blocked: 0,
      cancelled: 0,
      error: 0,
      unknown: 1,
      other: 0,
    });
  });

  it("does not infer abandoned outcomes from freeform execution output markers", async () => {
    const task = makeTask({
      id: "freeform-marker-task",
      status: "error",
      execution_output: "Provider printed [STOPPED], but no typed abandonment event was recorded.",
    });

    const ledger = await recordTaskOutcomeMutation(stateManager, task);

    expect(ledger.events.map((event) => event.type)).toEqual(["failed"]);
    expect(ledger.summary).toMatchObject({
      latest_event_type: "failed",
      task_status: "error",
      abandoned_at: null,
    });
  });

  it("preserves explicit abandoned outcomes from the typed ledger event path", async () => {
    const task = makeTask({
      id: "explicit-abandoned-task",
      status: "timed_out",
      execution_output: "No special freeform marker is required.",
    });

    await appendTaskOutcomeEvent(stateManager, {
      task,
      type: "abandoned",
      stoppedReason: "timeout",
      reason: "typed verifier outcome discarded dirty isolated workspace",
    });

    const ledger = await recordTaskOutcomeMutation(stateManager, task);

    expect(ledger.events.map((event) => event.type)).toEqual(["abandoned"]);
    expect(ledger.summary).toMatchObject({
      latest_event_type: "abandoned",
      task_status: "timed_out",
      stopped_reason: "timeout",
    });
  });

  it("clamps verification latency at zero when verifier timestamp slightly precedes completed_at", async () => {
    const task = makeTask({
      id: "timestamp-race-task",
      status: "completed",
      started_at: "2026-05-07T15:26:42.799Z",
      completed_at: "2026-05-07T15:27:52.796Z",
    });

    await appendTaskOutcomeEvent(stateManager, {
      task,
      type: "succeeded",
      verificationResult: {
        task_id: task.id,
        verdict: "pass",
        confidence: 0.9,
        evidence: [{ layer: "mechanical", description: "passed", confidence: 0.9 }],
        dimension_updates: [],
        timestamp: "2026-05-07T15:27:52.790Z",
      },
    });

    const ledger = await stateManager.readRaw("tasks/goal-1/ledger/timestamp-race-task.json") as {
      summary: { latencies: { completed_to_verification_ms: number | null } };
    };

    expect(ledger.summary.latencies.completed_to_verification_ms).toBe(0);
  });
});
