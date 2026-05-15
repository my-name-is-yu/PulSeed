/**
 * Focused coverage for executeTask guardrail behavior.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { StateManager } from "../../../base/state/state-manager.js";
import { SessionManager } from "../session-manager.js";
import { TrustManager } from "../../../platform/traits/trust-manager.js";
import { StrategyManager } from "../../strategy/strategy-manager.js";
import { StallDetector } from "../../../platform/drive/stall-detector.js";
import { TaskLifecycle } from "../task/task-lifecycle.js";
import { GuardrailRunner } from "../../../platform/traits/guardrail-runner.js";
import type { Task } from "../../../base/types/task.js";
import type { IGuardrailHook } from "../../../base/types/guardrail.js";
import type { ToolExecutor } from "../../../tools/executor.js";
import type { PersonalAgentDecisionTrace, PersonalAgentRuntimeStore } from "../../../runtime/personal-agent/index.js";
import { createMockLLMClient } from "../../../../tests/helpers/mock-llm.js";
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
    success_criteria: [
      { description: "Tests pass", verification_method: "npx vitest run", is_blocking: true },
    ],
    scope_boundary: { in_scope: ["module A"], out_of_scope: ["module B"], blast_radius: "low" },
    constraints: [],
    plateau_until: null,
    estimated_duration: { value: 1, unit: "hours" },
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

function createMockAdapter(output = "done", elapsed_ms = 100): import("../task/task-lifecycle.js").IAdapter {
  return {
    adapterType: "mock",
    async execute(): Promise<import("../task/task-lifecycle.js").AgentResult> {
      return {
        success: true,
        output,
        error: null,
        exit_code: 0,
        elapsed_ms,
        stopped_reason: "completed",
      };
    },
  };
}

function makeChangedPathsExecFileSync(
  paths: string[],
): ReturnType<typeof vi.fn> & ((cmd: string, args: string[], opts: { cwd: string; encoding: "utf-8" }) => string) {
  let snapshotReadCount = 0;
  const fn = vi.fn().mockImplementation((_cmd: string, args: string[]) => {
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
    return "";
  });
  return fn as ReturnType<typeof vi.fn> & ((cmd: string, args: string[], opts: { cwd: string; encoding: "utf-8" }) => string);
}

const realExecFileSync = (
  cmd: string,
  args: string[],
  opts: { cwd: string; encoding: "utf-8" },
): string => execFileSync(cmd, args, {
  cwd: opts.cwd,
  encoding: opts.encoding,
  stdio: "pipe",
});

function runGit(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

describe("TaskLifecycle — executeTask guardrail behavior", () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let sessionManager: SessionManager;
  let trustManager: TrustManager;
  let strategyManager: StrategyManager;
  let stallDetector: StallDetector;

  beforeEach(() => {
    tmpDir = makeTempDir();
    stateManager = new StateManager(tmpDir);
    sessionManager = new SessionManager(stateManager);
    trustManager = new TrustManager(stateManager);
    stallDetector = new StallDetector(stateManager);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  function createLifecycle(
    llmClient: ReturnType<typeof createMockLLMClient>,
    options?: {
      approvalFn?: (task: Task) => Promise<boolean>;
      guardrailRunner?: GuardrailRunner;
      toolExecutor?: ToolExecutor;
      personalAgentRuntime?: Pick<PersonalAgentRuntimeStore, "recordTrace">;
      execFileSyncFn?: (cmd: string, args: string[], opts: { cwd: string; encoding: "utf-8" }) => string;
      revertCwd?: string;
    }
  ): TaskLifecycle {
    strategyManager = new StrategyManager(stateManager, llmClient);
    return new TaskLifecycle(
      stateManager,
      llmClient,
      sessionManager,
      trustManager,
      strategyManager,
      stallDetector,
      {
        healthCheckEnabled: false,
        execFileSyncFn: options?.execFileSyncFn ?? makeChangedPathsExecFileSync(["some-file.ts"]),
        revertCwd: options?.revertCwd,
        ...options,
      }
    );
  }

  it("blocks execution when the before_tool guardrail denies the call", async () => {
    const recordTrace = vi.fn(async (_trace: PersonalAgentDecisionTrace) => ({} as never));
    const guardrailRunner = new GuardrailRunner();
    const blockingHook: IGuardrailHook = {
      name: "block-all",
      checkpoint: "before_tool",
      priority: 1,
      async execute() {
        return {
          hook_name: "block-all",
          checkpoint: "before_tool",
          allowed: false,
          severity: "critical",
          reason: "Blocked by policy",
        };
      },
    };
    guardrailRunner.register(blockingHook);

    const lifecycle = createLifecycle(createMockLLMClient([]), { guardrailRunner, personalAgentRuntime: { recordTrace } });
    const adapter = createMockAdapter();
    const task = makeTask();

    const result = await lifecycle.executeTask(task, adapter);

    expect(result.success).toBe(false);
    expect(result.error).toBe("guardrail_rejected");
    expect(result.output).toContain("Blocked by policy");
    expect(result.elapsed_ms).toBe(0);
    const blockTrace = recordTrace.mock.calls
      .map((call) => call[0])
      .find((trace) => trace.replay_key.includes("guardrail_before"));
    expect(blockTrace).toMatchObject({
      situation_frame: {
        caller_path: "task_execution",
        source_kind: "task_execution",
      },
      initiative_events: expect.arrayContaining([
        expect.objectContaining({ event_type: "policy_decision_recorded" }),
        expect.objectContaining({ event_type: "action_outcome" }),
      ]),
      task_candidates: [
        expect.objectContaining({
          materialization_state: "blocked",
          task_created: false,
        }),
      ],
      intervention_decisions: [
        expect.objectContaining({
          decision: "block",
          target_effect: "execute_tool",
        }),
      ],
    });
  });

  it("lets execution pass through when the after_tool guardrail allows the result", async () => {
    const guardrailRunner = new GuardrailRunner();
    const allowingHook: IGuardrailHook = {
      name: "allow-after",
      checkpoint: "after_tool",
      priority: 1,
      async execute() {
        return { hook_name: "allow-after", checkpoint: "after_tool", allowed: true, severity: "info" };
      },
    };
    guardrailRunner.register(allowingHook);

    const lifecycle = createLifecycle(createMockLLMClient([]), { guardrailRunner });
    const adapter = createMockAdapter("all good");

    const result = await lifecycle.executeTask(makeTask(), adapter);

    expect(result.success).toBe(true);
    expect(result.output).toBe("all good");
  });

  it("passes task workspace_path through the run-adapter caller path and diff capture", async () => {
    const goalWorkspace = `${tmpDir}/goal-workspace`;
    const taskWorkspace = `${tmpDir}/task-workspace`;
    fs.mkdirSync(`${goalWorkspace}/.git`, { recursive: true });
    fs.mkdirSync(`${taskWorkspace}/.git`, { recursive: true });
    await stateManager.writeRaw("goals/goal-1/goal.json", {
      id: "goal-1",
      title: "Test goal",
      dimensions: [],
      constraints: [`workspace_path:${goalWorkspace}`],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    const execute = vi.fn().mockResolvedValue({
      success: true,
      data: {
        success: true,
        output: "tool path done",
        error: null,
        exit_code: 0,
        elapsed_ms: 7,
        stopped_reason: "completed",
      },
      summary: "ok",
      durationMs: 1,
    });
    const execFileSyncFn = makeChangedPathsExecFileSync(["src/changed.ts", ".env"]);
    const lifecycle = createLifecycle(createMockLLMClient([]), {
      toolExecutor: { execute } as unknown as ToolExecutor,
      execFileSyncFn,
    });

    const result = await lifecycle.executeTask(
      makeTask({ constraints: [`workspace_path:${taskWorkspace}`] }),
      createMockAdapter("direct adapter should not run"),
    );

    expect(execute).toHaveBeenCalledWith(
      "run-adapter",
      expect.objectContaining({ cwd: taskWorkspace }),
      expect.objectContaining({ cwd: taskWorkspace }),
    );
    expect(result.output).toContain("tool path done");
    expect(result.success).toBe(false);
    expect(result.error).toContain(".env");
    expect(result.filesChangedPaths).toEqual(["src/changed.ts", ".env"]);
    expect(execFileSyncFn.mock.calls.every((call) => call[2].cwd === taskWorkspace)).toBe(true);
  });

  it("resolves existing relative workspace_path against the configured execution workspace", async () => {
    const executionWorkspace = `${tmpDir}/execution-workspace`;
    const taskWorkspace = `${executionWorkspace}/relative-task-workspace`;
    fs.mkdirSync(`${taskWorkspace}/.git`, { recursive: true });
    await stateManager.writeRaw("goals/goal-1/goal.json", {
      id: "goal-1",
      title: "Test goal",
      dimensions: [],
      constraints: ["workspace_path:relative-task-workspace"],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    const execute = vi.fn().mockResolvedValue({
      success: true,
      data: {
        success: true,
        output: "tool path done",
        error: null,
        exit_code: 0,
        elapsed_ms: 7,
        stopped_reason: "completed",
      },
      summary: "ok",
      durationMs: 1,
    });
    const execFileSyncFn = vi.fn().mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === "diff" && args[1] === "--name-only") return "src/changed.ts";
      if (args[0] === "diff" && args[1] === "--cached" && args[2] === "--name-only") return "";
      if (args[0] === "ls-files") return "";
      if (args[0] === "diff") return "";
      return "";
    });
    const lifecycle = createLifecycle(createMockLLMClient([]), {
      toolExecutor: { execute } as unknown as ToolExecutor,
      execFileSyncFn,
      revertCwd: executionWorkspace,
    });

    const result = await lifecycle.executeTask(makeTask(), createMockAdapter("direct adapter should not run"));

    expect(execute).toHaveBeenCalledWith(
      "run-adapter",
      expect.objectContaining({ cwd: taskWorkspace }),
      expect.objectContaining({ cwd: taskWorkspace }),
    );
    expect(result.output).toContain("tool path done");
    expect(execFileSyncFn.mock.calls.every((call) => call[2].cwd === taskWorkspace)).toBe(true);
  });

  it("fails closed without re-running the adapter when run-adapter returns truncated non-result data", async () => {
    const execute = vi.fn().mockResolvedValue({
      success: true,
      data: "truncated adapter result",
      summary: "truncated",
      durationMs: 1,
    });
    const execFileSyncFn = makeChangedPathsExecFileSync([".env"]);
    const lifecycle = createLifecycle(createMockLLMClient([]), {
      toolExecutor: { execute } as unknown as ToolExecutor,
      execFileSyncFn,
    });
    const directExecute = vi.fn();
    const adapter = {
      adapterType: "mock",
      execute: directExecute,
    };

    const result = await lifecycle.executeTask(
      makeTask(),
      adapter,
    );

    expect(execute).toHaveBeenCalledOnce();
    expect(directExecute).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toContain("invalid or truncated");
    expect(result.error).toContain(".env");
    expect(result.filesChangedPaths).toEqual([".env"]);
    expect(execFileSyncFn).toHaveBeenCalled();
  });

  it("preserves run-adapter failure baseline without direct adapter rerun", async () => {
    const repo = path.join(tmpDir, "fallback-baseline-repo");
    fs.mkdirSync(repo, { recursive: true });
    runGit(repo, ["init"]);
    runGit(repo, ["config", "user.name", "PulSeed Test"]);
    runGit(repo, ["config", "user.email", "pulseed-test@example.com"]);
    fs.writeFileSync(path.join(repo, "preexisting.txt"), "clean\n", "utf-8");
    runGit(repo, ["add", "preexisting.txt"]);
    runGit(repo, ["commit", "-m", "initial"]);
    fs.writeFileSync(path.join(repo, "preexisting.txt"), "dirty before task\n", "utf-8");

    const execute = vi.fn().mockImplementation(async () => {
      fs.writeFileSync(path.join(repo, "first-attempt.txt"), "first attempt\n", "utf-8");
      return {
        success: false,
        data: null,
        error: "run-adapter failed after writing",
        summary: "failed",
        durationMs: 1,
      };
    });
    const directExecute = vi.fn(async (): Promise<import("../task/task-lifecycle.js").AgentResult> => {
      fs.writeFileSync(path.join(repo, "second-attempt.txt"), "second attempt\n", "utf-8");
      return {
        success: false,
        output: "direct fallback failed",
        error: "direct fallback failed",
        exit_code: 1,
        elapsed_ms: 10,
        stopped_reason: "error",
      };
    });
    const adapter = {
      adapterType: "mock",
      execute: directExecute,
    };
    const lifecycle = createLifecycle(createMockLLMClient([]), {
      toolExecutor: { execute } as unknown as ToolExecutor,
      execFileSyncFn: realExecFileSync,
    });

    const result = await lifecycle.executeTask(
      makeTask({
        id: "task-run-adapter-fallback-baseline",
        constraints: [`workspace_path:${repo}`],
      }),
      adapter,
    );

    expect(execute).toHaveBeenCalledOnce();
    expect(directExecute).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(new Set(result.filesChangedPaths)).toEqual(new Set(["first-attempt.txt"]));
    expect(new Set(result.fileDiffs?.map((diff) => diff.path))).toEqual(new Set(["first-attempt.txt"]));
    expect(result.filesChangedPaths).not.toContain("preexisting.txt");
  });

  it("preserves elapsed_ms when the after_tool guardrail rejects", async () => {
    const recordTrace = vi.fn(async (_trace: PersonalAgentDecisionTrace) => ({} as never));
    const guardrailRunner = new GuardrailRunner();
    const afterHook: IGuardrailHook = {
      name: "block-after",
      checkpoint: "after_tool",
      priority: 1,
      async execute() {
        return {
          hook_name: "block-after",
          checkpoint: "after_tool",
          allowed: false,
          severity: "critical",
          reason: "Rejected after execution",
        };
      },
    };
    guardrailRunner.register(afterHook);

    const lifecycle = createLifecycle(createMockLLMClient([]), { guardrailRunner, personalAgentRuntime: { recordTrace } });
    const adapter = createMockAdapter("done", 250);

    const result = await lifecycle.executeTask(makeTask(), adapter);

    expect(result.success).toBe(false);
    expect(result.error).toBe("guardrail_rejected");
    expect(result.output).toContain("Rejected after execution");
    expect(result.elapsed_ms).toBe(250);
    const blockTrace = recordTrace.mock.calls
      .map((call) => call[0])
      .find((trace) => trace.replay_key.includes("guardrail_after"));
    expect(blockTrace).toMatchObject({
      initiative_events: expect.arrayContaining([
        expect.objectContaining({ event_type: "policy_decision_recorded" }),
        expect.objectContaining({ event_type: "action_outcome" }),
      ]),
      task_candidates: [
        expect.objectContaining({
          materialization_state: "blocked",
          task_created: false,
        }),
      ],
      intervention_decisions: [
        expect.objectContaining({
          decision: "block",
          target_effect: "execute_tool",
        }),
      ],
    });
  });
});
