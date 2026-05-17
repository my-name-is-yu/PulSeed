import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentResult, IAdapter } from "../adapter-layer.js";
import { executeTask, type TaskExecutorDeps } from "../task/task-executor.js";
import type { Task } from "../../../base/types/task.js";
import type { SessionManager } from "../session-manager.js";
import { makeTempDir } from "../../../../tests/helpers/temp-dir.js";

vi.mock("../../../base/llm/provider-config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../base/llm/provider-config.js")>();
  return {
    ...actual,
    loadProviderConfig: vi.fn().mockResolvedValue({
      provider: "openai",
      model: "gpt-5.4-mini",
      adapter: "openai_codex_cli",
      agent_loop: {
        security: {
          protected_paths: ["build"],
        },
      },
    }),
  };
});

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    goal_id: "goal-1",
    strategy_id: null,
    target_dimensions: ["quality"],
    primary_dimension: "quality",
    work_description: "work",
    rationale: "why",
    approach: "how",
    success_criteria: [{ description: "done", verification_method: "review", is_blocking: true }],
    scope_boundary: { in_scope: ["src"], out_of_scope: [], blast_radius: "low" },
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
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeChangedPathsExecFileSync(paths: string[]): TaskExecutorDeps["execFileSyncFn"] {
  let snapshotReadCount = 0;
  return vi.fn().mockImplementation((_cmd: string, args: string[]) => {
    if (
      args[0] === "diff" && args[1] === "--name-only"
      || args[0] === "diff" && args[1] === "--cached" && args[2] === "--name-only"
      || args[0] === "ls-files"
    ) {
      snapshotReadCount += 1;
      if (snapshotReadCount <= 3) return "";
    }
    if (args[0] === "diff" && args[1] === "--name-only") return paths.join("\n");
    if (args[0] === "diff" && args[1] === "--cached" && args[2] === "--name-only") return "";
    if (args[0] === "ls-files") return "";
    if (args[0] === "diff") {
      const requestedPaths = args.slice(args.indexOf("--") + 1);
      return requestedPaths.flatMap((filePath) => [
        `diff --git a/${filePath} b/${filePath}`,
        "@@ -1 +1 @@",
        "-old",
        "+new",
      ]).join("\n");
    }
    return "";
  }) as TaskExecutorDeps["execFileSyncFn"];
}

describe("executeTask protected paths", () => {
  let stateManager: TaskExecutorDeps["stateManager"];
  let sessionManager: SessionManager;
  let adapter: IAdapter;
  let execFileSyncFn: TaskExecutorDeps["execFileSyncFn"];
  let workspace: string;

  beforeEach(() => {
    workspace = makeTempDir();
    fs.mkdirSync(path.join(workspace, ".git"), { recursive: true });
    const taskOutcomeLedgers = new Map<string, unknown>();
    stateManager = {
      loadGoal: vi.fn().mockResolvedValue({ constraints: [`workspace_path:${workspace}`] }),
      saveTask: vi.fn().mockResolvedValue(undefined),
      loadTaskOutcomeLedger: vi.fn(async (goalId: string, taskId: string) => {
        return taskOutcomeLedgers.get(`${goalId}:${taskId}`) ?? null;
      }),
      saveTaskOutcomeLedger: vi.fn(async (record: { goal_id: string; task_id: string }) => {
        taskOutcomeLedgers.set(`${record.goal_id}:${record.task_id}`, record);
      }),
      readRaw: vi.fn().mockResolvedValue(null),
      writeRaw: vi.fn().mockResolvedValue(undefined),
    } as unknown as TaskExecutorDeps["stateManager"];
    sessionManager = {
      createSession: vi.fn().mockResolvedValue({ id: "session-1" }),
      buildTaskExecutionContext: vi.fn().mockReturnValue([]),
      endSession: vi.fn().mockResolvedValue(undefined),
    } as unknown as SessionManager;
    adapter = {
      adapterType: "mock",
      capabilityPlaneBoundary: "test",
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: "done",
        error: null,
        exit_code: 0,
        elapsed_ms: 1,
        stopped_reason: "completed",
      } as AgentResult),
    } as unknown as IAdapter;
    execFileSyncFn = makeChangedPathsExecFileSync(["build/output.txt"]);
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it("fails successful task results when configured protected paths are modified", async () => {
    const result = await executeTask(
      {
        stateManager,
        sessionManager,
        execFileSyncFn,
      },
      makeTask(),
      adapter,
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("build/output.txt");
  });

  it("uses task workspace_path before goal workspace_path for adapter cwd, diff capture, and protected-path checks", async () => {
    const goalWorkspace = path.join(workspace, "goal-workspace");
    const taskWorkspace = path.join(workspace, "task-workspace");
    fs.mkdirSync(path.join(goalWorkspace, ".git"), { recursive: true });
    fs.mkdirSync(path.join(taskWorkspace, ".git"), { recursive: true });
    vi.mocked(stateManager.loadGoal).mockResolvedValue({ constraints: [`workspace_path:${goalWorkspace}`] } as never);
    const execute = vi.fn().mockResolvedValue({
      success: true,
      output: "done",
      error: null,
      exit_code: 0,
      elapsed_ms: 1,
      stopped_reason: "completed",
    } as AgentResult);
    adapter = {
      adapterType: "mock",
      capabilityPlaneBoundary: "test",
      execute,
    } as unknown as IAdapter;
    execFileSyncFn = makeChangedPathsExecFileSync(["src/changed.ts", ".env"]);

    const result = await executeTask(
      {
        stateManager,
        sessionManager,
        execFileSyncFn,
      },
      makeTask({ constraints: [`workspace_path:${taskWorkspace}`] }),
      adapter,
    );

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ cwd: taskWorkspace }));
    expect(result.success).toBe(false);
    expect(result.error).toContain(".env");
    expect(result.filesChangedPaths).toEqual(["src/changed.ts", ".env"]);
    expect(result.fileDiffs).toEqual([
      expect.objectContaining({
        path: "src/changed.ts",
        patch: expect.stringContaining("+new"),
      }),
      expect.objectContaining({
        path: ".env",
        patch: expect.stringContaining("+new"),
      }),
    ]);
    expect(vi.mocked(execFileSyncFn).mock.calls.every((call) => call[2].cwd === taskWorkspace)).toBe(true);
  });
});
