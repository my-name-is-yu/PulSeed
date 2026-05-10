import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StateManager } from "../../base/state/state-manager.js";
import type { Task } from "../../base/types/task.js";
import { cleanupTempDir, makeTempDir } from "../../../tests/helpers/temp-dir.js";
import { makeGoal } from "../../../tests/helpers/fixtures.js";
import type { GroundingProviderContext } from "../contracts.js";
import { taskStateProvider } from "../providers/task-state-provider.js";

function makeTask(id: string, goalId: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    goal_id: goalId,
    strategy_id: null,
    target_dimensions: ["coverage"],
    primary_dimension: "coverage",
    work_description: `Work on ${id}`,
    rationale: "Need grounded task state",
    approach: "Use typed task state",
    success_criteria: [],
    scope_boundary: {
      in_scope: ["src"],
      out_of_scope: [],
      blast_radius: "low",
    },
    constraints: [],
    plateau_until: null,
    estimated_duration: null,
    consecutive_failure_count: 0,
    reversibility: "reversible",
    task_category: "normal",
    status: "pending",
    started_at: null,
    completed_at: null,
    timeout_at: null,
    heartbeat_at: null,
    created_at: "2026-05-10T00:00:00.000Z",
    verification_evidence: [],
    ...overrides,
  };
}

function makeContext(
  stateManager: StateManager,
  request: Partial<GroundingProviderContext["request"]> = {},
): GroundingProviderContext {
  return {
    deps: { stateManager },
    profile: {
      id: "agent_loop/task_execution",
      surface: "agent_loop",
      purpose: "task_execution",
      include: {} as never,
      budgets: {
        maxTokens: 10_000,
        maxGoalCount: 5,
        maxTaskCount: 2,
        maxHistoryMessages: 5,
        maxProgressEntries: 5,
        maxKnowledgeHits: 5,
        maxRepoInstructionChars: 1_000,
      },
    },
    request: {
      surface: "agent_loop",
      purpose: "task_execution",
      goalId: "goal-task-provider",
      ...request,
    },
    warnings: [],
    runtime: new Map(),
  };
}

describe("taskStateProvider", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      cleanupTempDir(dir);
    }
  });

  function tempHome(): string {
    const dir = makeTempDir("pulseed-task-state-provider-");
    tempDirs.push(dir);
    return dir;
  }

  it("reads task grounding from the typed task store without legacy task files", async () => {
    const baseDir = tempHome();
    const stateManager = new StateManager(baseDir);
    await stateManager.init();
    await stateManager.saveGoal(makeGoal({ id: "goal-task-provider" }));
    await stateManager.saveTask(makeTask("task-db", "goal-task-provider", {
      work_description: "Typed task should ground the prompt",
      status: "running",
    }));

    expect(fs.existsSync(path.join(baseDir, "tasks", "goal-task-provider", "task-db.json"))).toBe(false);

    const section = await taskStateProvider.build(makeContext(stateManager));

    expect(section?.content).toContain("Typed task should ground the prompt (task-db) - running");
    expect(section?.sources[0]).toMatchObject({
      type: "state",
      label: "task state",
      retrievalId: "tasks:goal-task-provider",
      metadata: { goalId: "goal-task-provider" },
    });
  });

  it("prioritizes the requested typed task before applying the task budget", async () => {
    const baseDir = tempHome();
    const stateManager = new StateManager(baseDir);
    await stateManager.init();
    await stateManager.saveGoal(makeGoal({ id: "goal-task-provider" }));
    await stateManager.saveTask(makeTask("task-newer", "goal-task-provider", {
      work_description: "Newer task",
      created_at: "2026-05-10T00:02:00.000Z",
    }));
    await stateManager.saveTask(makeTask("task-focus", "goal-task-provider", {
      work_description: "Focused task",
      created_at: "2026-05-10T00:01:00.000Z",
    }));
    await stateManager.saveTask(makeTask("task-budgeted-out", "goal-task-provider", {
      work_description: "Budgeted out task",
      created_at: "2026-05-10T00:00:00.000Z",
    }));

    const section = await taskStateProvider.build(makeContext(stateManager, { taskId: "task-focus" }));

    const content = section?.content ?? "";
    expect(content.indexOf("Focused task")).toBeLessThan(content.indexOf("Newer task"));
    expect(content).not.toContain("Budgeted out task");
  });
});
