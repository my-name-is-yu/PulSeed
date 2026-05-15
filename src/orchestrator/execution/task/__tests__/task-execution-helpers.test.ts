import { describe, expect, it, vi } from "vitest";
import { TaskSchema } from "../../../../base/types/task.js";
import type { StateManager } from "../../../../base/state/state-manager.js";
import type { SessionManager } from "../../session-manager.js";
import type { AdapterRegistry, IAdapter } from "../../adapter-layer.js";
import { executeTaskWithGuards } from "../task-execution-helpers.js";
import type { ToolExecutor } from "../../../../tools/executor.js";

const task = TaskSchema.parse({
  id: "task-policy-blocked",
  goal_id: "goal-1",
  strategy_id: null,
  target_dimensions: ["quality"],
  primary_dimension: "quality",
  work_description: "Run a blocked adapter task",
  rationale: "Verify execution admission failure does not fall back.",
  approach: "Use run-adapter ToolExecutor result only.",
  success_criteria: [{
    description: "No adapter side effect",
    verification_method: "mock",
    is_blocking: true,
  }],
  scope_boundary: {
    in_scope: ["src"],
    out_of_scope: [],
    blast_radius: "local",
  },
  constraints: [],
  status: "pending",
  created_at: "2026-05-15T00:00:00.000Z",
});

describe("executeTaskWithGuards", () => {
  it("does not execute adapter directly when run-adapter admission is blocked", async () => {
    const adapter: IAdapter = {
      adapterType: "blocked-adapter",
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: "should not run",
        error: null,
        exit_code: 0,
        elapsed_ms: 1,
        stopped_reason: "completed",
      }),
    };
    const toolExecutor = {
      execute: vi.fn().mockResolvedValue({
        success: false,
        data: null,
        summary: "blocked by policy",
        error: "blocked by policy",
        execution: {
          status: "not_executed",
          reason: "policy_blocked",
          message: "blocked by policy",
        },
        durationMs: 1,
      }),
    } as unknown as ToolExecutor;
    const adapterRegistry = {
      recordFailure: vi.fn(),
      recordSuccess: vi.fn(),
    } as unknown as AdapterRegistry;

    const result = await executeTaskWithGuards({
      task,
      adapter,
      toolExecutor,
      adapterRegistry,
      stateManager: {
        getBaseDir: () => "/tmp/pulseed-task-execution-test",
        loadGoal: vi.fn().mockResolvedValue(null),
        saveTask: vi.fn().mockResolvedValue(undefined),
        loadTaskOutcomeLedger: vi.fn().mockResolvedValue(null),
        saveTaskOutcomeLedger: vi.fn().mockResolvedValue(undefined),
      } as unknown as StateManager,
      sessionManager: {
        createSession: vi.fn().mockResolvedValue({ id: "session-1" }),
        buildTaskExecutionContext: vi.fn().mockReturnValue([]),
        endSession: vi.fn().mockResolvedValue(undefined),
      } as unknown as SessionManager,
      execFileSyncFn: vi.fn().mockReturnValue(""),
    });

    expect(result).toMatchObject({
      success: false,
      error: "policy_blocked",
      stopped_reason: "error",
    });
    expect(adapter.execute).not.toHaveBeenCalled();
    expect(adapterRegistry.recordFailure).toHaveBeenCalledWith("blocked-adapter");
    expect(adapterRegistry.recordSuccess).not.toHaveBeenCalled();
  });
});
