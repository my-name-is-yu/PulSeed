import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cmdTaskList, cmdTaskShow } from "../commands/task-read.js";
import type { StateManager } from "../../../base/state/state-manager.js";
import type { Task } from "../../../base/types/task.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    goal_id: "goal-1",
    strategy_id: null,
    target_dimensions: ["quality"],
    primary_dimension: "quality",
    work_description: "Harden CLI task display",
    rationale: "regression",
    approach: "format safely",
    success_criteria: [],
    scope_boundary: { in_scope: [], out_of_scope: [], blast_radius: "low" },
    constraints: [],
    plateau_until: null,
    estimated_duration: null,
    consecutive_failure_count: 0,
    reversibility: "reversible",
    task_category: "normal",
    status: "completed",
    started_at: "not-a-date",
    completed_at: "2026-05-10T00:05:00.000Z",
    timeout_at: null,
    heartbeat_at: null,
    created_at: "2026-05-10T00:00:00.000Z",
    ...overrides,
  };
}

function makeStateManager(task: Task): StateManager {
  return {
    listTasks: vi.fn().mockResolvedValue([task]),
    loadTask: vi.fn().mockResolvedValue(task),
  } as unknown as StateManager;
}

function capturedOutput(logSpy: ReturnType<typeof vi.spyOn>): string {
  return logSpy.mock.calls.map((call: unknown[]) => call.join(" ")).join("\n");
}

describe("task read CLI commands", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it("renders unknown elapsed time for malformed task timestamps in list output", async () => {
    const exitCode = await cmdTaskList(makeStateManager(makeTask()), ["--goal", "goal-1"]);

    expect(exitCode).toBe(0);
    const output = capturedOutput(logSpy);
    expect(output).toContain("task-1");
    expect(output).not.toContain("NaN");
  });

  it("renders unknown elapsed time for malformed task timestamps in show output", async () => {
    const exitCode = await cmdTaskShow(makeStateManager(makeTask()), ["task-1", "--goal", "goal-1"]);

    expect(exitCode).toBe(0);
    const output = capturedOutput(logSpy);
    expect(output).toContain("Elapsed:       -");
    expect(output).not.toContain("NaN");
  });
});
