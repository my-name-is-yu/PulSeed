import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TaskStopTool } from "../TaskStopTool.js";
import type { ToolCallContext } from "../../../types.js";
import type { StateManager } from "../../../../base/state/state-manager.js";

async function fakeReadRaw(baseDir: string, relativePath: string): Promise<unknown | null> {
  const resolved = path.resolve(baseDir, relativePath);
  if (!resolved.startsWith(path.resolve(baseDir) + path.sep)) {
    throw new Error(`Path traversal detected: ${relativePath}`);
  }
  if (!fs.existsSync(resolved)) return null;
  try {
    return JSON.parse(fs.readFileSync(resolved, "utf-8")) as unknown;
  } catch {
    return null;
  }
}

async function fakeWriteRaw(baseDir: string, relativePath: string, payload: unknown): Promise<void> {
  const resolved = path.resolve(baseDir, relativePath);
  if (!resolved.startsWith(path.resolve(baseDir) + path.sep)) {
    throw new Error(`Path traversal detected: ${relativePath}`);
  }
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, JSON.stringify(payload, null, 2), "utf-8");
}

function makeContext(): ToolCallContext {
  return {
    cwd: "/tmp",
    goalId: "goal-1",
    trustBalance: 50,
    preApproved: false,
    approvalFn: async () => false,
  };
}

function makeTaskJson(id: string, goalId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    goal_id: goalId,
    strategy_id: null,
    target_dimensions: ["coverage"],
    primary_dimension: "coverage",
    work_description: `Improve coverage for ${id}`,
    rationale: "Need better confidence",
    approach: "Run tests and add missing cases",
    success_criteria: [],
    scope_boundary: {
      in_scope: ["src"],
      out_of_scope: ["infra"],
      blast_radius: "low",
    },
    constraints: [],
    plateau_until: null,
    estimated_duration: null,
    consecutive_failure_count: 0,
    reversibility: "reversible",
    task_category: "normal",
    status: "running",
    started_at: "2026-01-01T00:00:00.000Z",
    completed_at: null,
    timeout_at: null,
    heartbeat_at: null,
    created_at: "2026-01-01T00:00:00.000Z",
    execution_output: "Initial output",
    ...overrides,
  };
}

describe("TaskStopTool", () => {
  let stateManager: StateManager;
  let tool: TaskStopTool;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-stop-tool-"));
    stateManager = {
      readRaw: vi.fn().mockImplementation((rel: string) => fakeReadRaw(tmpDir, rel)),
      writeRaw: vi.fn().mockImplementation((rel: string, data: unknown) => fakeWriteRaw(tmpDir, rel, data)),
      loadTask: vi.fn().mockImplementation((goalId: string, taskId: string) =>
        fakeReadRaw(tmpDir, `tasks/${goalId}/${taskId}.json`)
      ),
      saveTask: vi.fn().mockImplementation((task: { goal_id: string; id: string }) =>
        fakeWriteRaw(tmpDir, `tasks/${task.goal_id}/${task.id}.json`, task)
      ),
      loadTaskHistory: vi.fn().mockImplementation(async (goalId: string) => {
        const history = await fakeReadRaw(tmpDir, `tasks/${goalId}/task-history.json`);
        return Array.isArray(history) ? history : [];
      }),
      saveTaskHistory: vi.fn().mockImplementation((goalId: string, history: unknown) =>
        fakeWriteRaw(tmpDir, `tasks/${goalId}/task-history.json`, history)
      ),
      loadTaskOutcomeLedger: vi.fn().mockImplementation((goalId: string, taskId: string) =>
        fakeReadRaw(tmpDir, `tasks/${goalId}/ledger/${taskId}.json`)
      ),
      saveTaskOutcomeLedger: vi.fn().mockImplementation((record: { goal_id: string; task_id: string }) =>
        fakeWriteRaw(tmpDir, `tasks/${record.goal_id}/ledger/${record.task_id}.json`, record)
      ),
    } as unknown as StateManager;
    tool = new TaskStopTool(stateManager);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("marks a task as error and appends the stop reason", async () => {
    const tasksDir = path.join(tmpDir, "tasks", "goal-1");
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(path.join(tasksDir, "task-1.json"), JSON.stringify(makeTaskJson("task-1", "goal-1")));

    const result = await tool.call(
      { goalId: "goal-1", taskId: "task-1", reason: "Supervisor cancelled it" },
      makeContext()
    );

    expect(result.success).toBe(true);
    const persisted = await fakeReadRaw(tmpDir, "tasks/goal-1/task-1.json") as Record<string, unknown>;
    expect(persisted.status).toBe("error");
    expect((persisted.execution_output as string)).toContain("Supervisor cancelled it");
    expect(typeof persisted.completed_at).toBe("string");

    const ledger = await fakeReadRaw(tmpDir, "tasks/goal-1/ledger/task-1.json") as Record<string, unknown>;
    const events = ledger.events as Array<Record<string, unknown>>;
    expect(events.map((event) => event.type)).toEqual(["abandoned"]);
    expect(events[0]).toMatchObject({
      action: "stop",
      reason: "Supervisor cancelled it",
      stopped_reason: "cancelled",
    });
    expect(ledger.summary).toMatchObject({
      latest_event_type: "abandoned",
      task_status: "error",
      stopped_reason: "cancelled",
    });
  });

  it("updates task-history.json", async () => {
    const tasksDir = path.join(tmpDir, "tasks", "goal-1");
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(path.join(tasksDir, "task-1.json"), JSON.stringify(makeTaskJson("task-1", "goal-1")));

    const result = await tool.call(
      { goalId: "goal-1", taskId: "task-1", reason: "Stopped manually" },
      makeContext()
    );
    expect(result.success).toBe(true);

    const history = await fakeReadRaw(tmpDir, "tasks/goal-1/task-history.json") as Array<Record<string, unknown>>;
    expect(history).toHaveLength(1);
    expect(history[0]?.task_id).toBe("task-1");
    expect(history[0]?.status).toBe("error");
  });
});
