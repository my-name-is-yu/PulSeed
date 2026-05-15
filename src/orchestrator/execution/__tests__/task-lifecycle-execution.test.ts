import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { z } from "zod/v3";
import { StateManager } from "../../../base/state/state-manager.js";
import { SessionManager } from "../session-manager.js";
import { TrustManager } from "../../../platform/traits/trust-manager.js";
import { StrategyManager } from "../../strategy/strategy-manager.js";
import { StallDetector } from "../../../platform/drive/stall-detector.js";
import { TaskLifecycle } from "../task/task-lifecycle.js";
import { GoalSchema } from "../../goal/types/goal.js";
import type { Task } from "../../../base/types/task.js";
import type { AgentLoopStopReason } from "../agent-loop/agent-loop-budget.js";
import type { AgentLoopResult } from "../agent-loop/agent-loop-result.js";
import type { TaskAgentLoopOutput } from "../agent-loop/task-agent-loop-result.js";
import type { TaskAgentLoopRunner } from "../agent-loop/task-agent-loop-runner.js";
import type {
  ILLMClient,
  LLMMessage,
  LLMRequestOptions,
  LLMResponse,
} from "../../../base/llm/llm-client.js";
import { createDaemonShutdownAbortReason } from "../../../base/utils/abort-reason.js";
import { createMockLLMClient } from "../../../../tests/helpers/mock-llm.js";
import { makeTempDir } from "../../../../tests/helpers/temp-dir.js";

// ─── Spy LLM Client ───

function createSpyLLMClient(responses: string[]): ILLMClient & { calls: Array<{ messages: LLMMessage[]; options?: LLMRequestOptions }> } {
  let callIndex = 0;
  const calls: Array<{ messages: LLMMessage[]; options?: LLMRequestOptions }> = [];
  return {
    calls,
    async sendMessage(
      messages: LLMMessage[],
      options?: LLMRequestOptions
    ): Promise<LLMResponse> {
      calls.push({ messages, options });
      return {
        content: responses[callIndex++] ?? "",
        usage: { input_tokens: 0, output_tokens: 0 },
        stop_reason: "end_turn",
      };
    },
    parseJSON<T>(content: string, schema: z.ZodSchema<T>): T {
      const match = content.match(/```json\n?([\s\S]*?)\n?```/) || [
        null,
        content,
      ];
      return schema.parse(JSON.parse(match[1] ?? content));
    },
  };
}

// ─── Phase 2 helpers ───

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

function createMockAdapter(
  results: Array<Partial<import("../task/task-lifecycle.js").AgentResult>>
): import("../task/task-lifecycle.js").IAdapter {
  let callIndex = 0;
  return {
    adapterType: "mock",
    async execute(
      _task: import("../task/task-lifecycle.js").AgentTask
    ): Promise<import("../task/task-lifecycle.js").AgentResult> {
      const r = results[callIndex++] ?? {};
      return {
        success: true,
        output: "Task completed successfully",
        error: null,
        exit_code: 0,
        elapsed_ms: 100,
        stopped_reason: "completed",
        ...r,
      };
    },
  };
}

function makeAgentLoopResult(
  stopReason: AgentLoopStopReason,
  overrides: Partial<AgentLoopResult<TaskAgentLoopOutput>> = {}
): AgentLoopResult<TaskAgentLoopOutput> {
  return {
    success: stopReason === "completed",
    output: stopReason === "completed"
      ? {
          status: "done",
          finalAnswer: "done",
          summary: "done",
          filesChanged: [],
          testsRun: [],
          completionEvidence: [],
          verificationHints: [],
          blockers: [],
        }
      : null,
    finalText: stopReason,
    stopReason,
    elapsedMs: 100,
    modelTurns: 1,
    toolCalls: 0,
    compactions: 0,
    filesChanged: false,
    changedFiles: [],
    commandResults: [],
    traceId: "trace-1",
    sessionId: "session-1",
    turnId: "turn-1",
    ...overrides,
  };
}

function makeAgentLoopRunner(
  result: AgentLoopResult<TaskAgentLoopOutput>
): TaskAgentLoopRunner {
  return {
    runTask: vi.fn().mockResolvedValue(result),
  } as unknown as TaskAgentLoopRunner;
}

// ─── Test Suite ───

describe("TaskLifecycle", async () => {
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
    fs.rmSync(tmpDir, { recursive: true, force: true , maxRetries: 3, retryDelay: 100 });
  });

  // Default mock execFileSyncFn: baseline reads are clean, then post-execution
  // scope checks see a modification and do not force success=false.
  function makeDefaultMockExecFileSync(): (cmd: string, args: string[], opts: { cwd: string; encoding: "utf-8" }) => string {
    let snapshotReadCount = 0;
    return (_cmd: string, args: string[]): string => {
      const key = args.join(" ");
      if (
        key === "diff --name-only"
        || key === "diff --cached --name-only"
        || key === "ls-files --others --exclude-standard"
      ) {
        snapshotReadCount += 1;
        if (snapshotReadCount <= 3) return "";
      }
      if (key === "diff --name-only") return "some-file.ts\n";
      if (key === "diff --cached --name-only") return "";
      if (key === "ls-files --others --exclude-standard") return "";
      if (key === "diff -- some-file.ts") {
        return "diff --git a/some-file.ts b/some-file.ts\n@@ -1 +1 @@\n-old\n+new\n";
      }
      return "";
    };
  }

  const realExecFileSync = (
    cmd: string,
    args: string[],
    opts: { cwd: string; encoding: "utf-8"; stdio?: "pipe" },
  ): string => execFileSync(cmd, args, {
    cwd: opts.cwd,
    encoding: opts.encoding,
    stdio: opts.stdio ?? "pipe",
  });

  function runGit(cwd: string, args: string[]): void {
    execFileSync("git", args, { cwd, stdio: "pipe" });
  }

  function makeDirtyGitRepo(name: string): string {
    const repo = path.join(tmpDir, name);
    fs.mkdirSync(repo, { recursive: true });
    runGit(repo, ["init"]);
    runGit(repo, ["config", "user.name", "PulSeed Test"]);
    runGit(repo, ["config", "user.email", "pulseed-test@example.com"]);
    fs.writeFileSync(path.join(repo, "preexisting.txt"), "clean\n", "utf-8");
    runGit(repo, ["add", "preexisting.txt"]);
    runGit(repo, ["commit", "-m", "initial"]);
    fs.writeFileSync(path.join(repo, "preexisting.txt"), "dirty before task\n", "utf-8");
    return repo;
  }

  function createLifecycle(
    llmClient: ILLMClient,
    options?: {
      approvalFn?: (task: Task) => Promise<boolean>;
      logger?: import("../../../runtime/logger.js").Logger;
      adapterRegistry?: import("../task/task-lifecycle.js").AdapterRegistry;
      agentLoopRunner?: TaskAgentLoopRunner;
      execFileSyncFn?: (cmd: string, args: string[], opts: { cwd: string; encoding: "utf-8" }) => string;
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
      { execFileSyncFn: options?.execFileSyncFn ?? makeDefaultMockExecFileSync(), ...options }
    );
  }

  // ─────────────────────────────────────────────
  // executeTask
  // ─────────────────────────────────────────────

  describe("executeTask", async () => {
    it("creates a session with correct type and IDs", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      const adapter = createMockAdapter([{ success: true }]);
      const task = makeTask();

      await lifecycle.executeTask(task, adapter);

      // Verify session was created by checking state
      const sessions = await sessionManager.getActiveSessions("goal-1");
      // Session should be ended (not active anymore)
      expect(sessions.length).toBe(0);
    });

    it("calls adapter.execute()", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      let executeCalled = false;
      const adapter: import("../task/task-lifecycle.js").IAdapter = {
        adapterType: "mock",
        async execute() {
          executeCalled = true;
          return {
            success: true,
            output: "done",
            error: null,
            exit_code: 0,
            elapsed_ms: 50,
            stopped_reason: "completed" as const,
          };
        },
      };

      await lifecycle.executeTask(makeTask(), adapter);
      expect(executeCalled).toBe(true);
    });

    it("excludes pre-existing dirty workspace paths from adapter file diffs", async () => {
      const llm = createMockLLMClient([]);
      const repo = makeDirtyGitRepo("adapter-dirty-repo");
      const lifecycle = createLifecycle(llm, { execFileSyncFn: realExecFileSync });
      const adapter: import("../task/task-lifecycle.js").IAdapter = {
        adapterType: "mock",
        async execute() {
          fs.writeFileSync(path.join(repo, "task-output.txt"), "task output\n", "utf-8");
          return {
            success: true,
            output: "Task completed successfully",
            error: null,
            exit_code: 0,
            elapsed_ms: 100,
            stopped_reason: "completed",
          };
        },
      };
      const task = makeTask({
        id: "task-dirty-adapter",
        constraints: [`workspace_path:${repo}`],
      });

      const result = await lifecycle.executeTask(task, adapter);

      expect(result.success).toBe(true);
      expect(result.filesChangedPaths).toEqual(["task-output.txt"]);
      expect(result.fileDiffs?.map((diff) => diff.path)).toEqual(["task-output.txt"]);
      expect(result.fileDiffs?.[0]?.patch).toContain("+task output");
      expect(fs.readFileSync(path.join(repo, "preexisting.txt"), "utf-8")).toBe("dirty before task\n");
    });

    it("filters failed adapter file diffs to task-produced paths", async () => {
      const llm = createMockLLMClient([]);
      const repo = makeDirtyGitRepo("failed-adapter-dirty-repo");
      const lifecycle = createLifecycle(llm, { execFileSyncFn: realExecFileSync });
      const adapter: import("../task/task-lifecycle.js").IAdapter = {
        adapterType: "mock",
        async execute() {
          fs.writeFileSync(path.join(repo, "task-output.txt"), "task output\n", "utf-8");
          return {
            success: false,
            output: "Task failed after writing output",
            error: "adapter failed",
            exit_code: 1,
            elapsed_ms: 100,
            stopped_reason: "error",
            filesChangedPaths: ["preexisting.txt", "task-output.txt"],
            fileDiffs: [
              { path: "preexisting.txt", patch: "diff --git a/preexisting.txt b/preexisting.txt" },
              { path: "task-output.txt", patch: "diff --git a/task-output.txt b/task-output.txt" },
            ],
          };
        },
      };
      const task = makeTask({
        id: "task-failed-dirty-adapter",
        constraints: [`workspace_path:${repo}`],
      });

      const result = await lifecycle.executeTask(task, adapter);

      expect(result.success).toBe(false);
      expect(result.filesChangedPaths).toEqual(["task-output.txt"]);
      expect(result.fileDiffs?.map((diff) => diff.path)).toEqual(["task-output.txt"]);
      expect(result.fileDiffs?.[0]?.patch).toContain("+task output");
      expect(fs.readFileSync(path.join(repo, "preexisting.txt"), "utf-8")).toBe("dirty before task\n");
    });

    it("keeps same-file edits to a dirty baseline path but marks them unsafe for path restore", async () => {
      const llm = createMockLLMClient([]);
      const repo = makeDirtyGitRepo("same-file-dirty-adapter-repo");
      const lifecycle = createLifecycle(llm, { execFileSyncFn: realExecFileSync });
      const adapter: import("../task/task-lifecycle.js").IAdapter = {
        adapterType: "mock",
        async execute() {
          fs.writeFileSync(path.join(repo, "preexisting.txt"), "dirty before task\nand task edit\n", "utf-8");
          return {
            success: false,
            output: "Task failed after editing a dirty file",
            error: "adapter failed",
            exit_code: 1,
            elapsed_ms: 100,
            stopped_reason: "error",
          };
        },
      };
      const task = makeTask({
        id: "task-same-file-dirty-adapter",
        constraints: [`workspace_path:${repo}`],
      });

      const result = await lifecycle.executeTask(task, adapter);

      expect(result.success).toBe(false);
      expect(result.filesChangedPaths).toEqual(["preexisting.txt"]);
      expect(result.fileDiffs).toEqual([
        expect.objectContaining({
          path: "preexisting.txt",
          patch: expect.stringContaining("and task edit"),
          safe_to_revert: false,
        }),
      ]);
    });

    it("returns AgentResult from adapter", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      const adapter = createMockAdapter([{
        success: true,
        output: "test output",
        elapsed_ms: 200,
      }]);

      const result = await lifecycle.executeTask(makeTask(), adapter);
      expect(result.success).toBe(true);
      expect(result.output).toBe("test output");
      expect(result.elapsed_ms).toBe(200);
    });

    it("updates task status to completed on success", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      const adapter = createMockAdapter([{ success: true, stopped_reason: "completed" }]);
      const task = makeTask();

      // Persist task first
      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
      await lifecycle.executeTask(task, adapter);

      const persisted = await stateManager.readRaw(`tasks/goal-1/task-1.json`) as Record<string, unknown>;
      expect(persisted.status).toBe("completed");
    });

    it("updates task status to timed_out on timeout", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      const adapter = createMockAdapter([{
        success: false,
        stopped_reason: "timeout",
        error: "Timed out",
      }]);
      const task = makeTask();

      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
      await lifecycle.executeTask(task, adapter);

      const persisted = await stateManager.readRaw(`tasks/goal-1/task-1.json`) as Record<string, unknown>;
      expect(persisted.status).toBe("timed_out");
    });

    it("updates task status to error on error", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      const adapter = createMockAdapter([{
        success: false,
        stopped_reason: "error",
        error: "Something went wrong",
      }]);
      const task = makeTask();

      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
      await lifecycle.executeTask(task, adapter);

      const persisted = await stateManager.readRaw(`tasks/goal-1/task-1.json`) as Record<string, unknown>;
      expect(persisted.status).toBe("error");
    });

    it("persists updated task after execution", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      const adapter = createMockAdapter([{ success: true }]);
      const task = makeTask();

      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
      await lifecycle.executeTask(task, adapter);

      const persisted = await stateManager.readRaw(`tasks/goal-1/task-1.json`) as Record<string, unknown>;
      expect(persisted).not.toBeNull();
      expect(persisted.completed_at).toBeDefined();
    });

    it("ends session after execution", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      const adapter = createMockAdapter([{ success: true }]);
      const task = makeTask();

      await lifecycle.executeTask(task, adapter);

      // All sessions should be ended (no active ones)
      const activeSessions = await sessionManager.getActiveSessions("goal-1");
      expect(activeSessions.length).toBe(0);
    });

    it("handles adapter throwing an error", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      const adapter: import("../task/task-lifecycle.js").IAdapter = {
        adapterType: "mock",
        async execute() {
          throw new Error("Adapter crashed");
        },
      };
      const task = makeTask();

      const result = await lifecycle.executeTask(task, adapter);
      expect(result.success).toBe(false);
      expect(result.error).toContain("Adapter crashed");
      expect(result.stopped_reason).toBe("error");
    });

    it("builds prompt from context slots", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      let receivedPrompt = "";
      const adapter: import("../task/task-lifecycle.js").IAdapter = {
        adapterType: "mock",
        async execute(agentTask) {
          receivedPrompt = agentTask.prompt;
          return {
            success: true, output: "ok", error: null,
            exit_code: 0, elapsed_ms: 10, stopped_reason: "completed" as const,
          };
        },
      };
      const task = makeTask();

      await lifecycle.executeTask(task, adapter);
      expect(receivedPrompt).toContain("task_definition_and_success_criteria");
      expect(receivedPrompt).toContain("goal-1");
    });

    it("builds github-issue JSON block for github_issue adapter", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      let receivedPrompt = "";
      const adapter: import("../task/task-lifecycle.js").IAdapter = {
        adapterType: "github_issue",
        formatPrompt(t: Task) {
          const titleLine = t.work_description.split("\n")[0]?.trim() ?? t.work_description;
          const title = titleLine.length > 120 ? titleLine.slice(0, 117) + "..." : titleLine;
          return `\`\`\`github-issue\n${JSON.stringify({ title, body: t.work_description })}\n\`\`\``;
        },
        async execute(agentTask) {
          receivedPrompt = agentTask.prompt;
          return {
            success: true, output: "https://github.com/owner/repo/issues/1", error: null,
            exit_code: 0, elapsed_ms: 10, stopped_reason: "completed" as const,
          };
        },
      };
      const task = makeTask({ work_description: "Fix memory leak in cache module" });

      await lifecycle.executeTask(task, adapter);
      expect(receivedPrompt).toContain("```github-issue");
      const jsonMatch = receivedPrompt.match(/```github-issue\s*([\s\S]*?)```/);
      expect(jsonMatch).not.toBeNull();
      const parsed = JSON.parse(jsonMatch![1].trim());
      expect(parsed.title).toBe("Fix memory leak in cache module");
      expect(parsed.body).toBe("Fix memory leak in cache module");
      expect(receivedPrompt).not.toContain("task_definition_and_success_criteria");
    });

    it("truncates long work_description title to 120 chars for github_issue adapter", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      let receivedPrompt = "";
      const adapter: import("../task/task-lifecycle.js").IAdapter = {
        adapterType: "github_issue",
        formatPrompt(t: Task) {
          const titleLine = t.work_description.split("\n")[0]?.trim() ?? t.work_description;
          const title = titleLine.length > 120 ? titleLine.slice(0, 117) + "..." : titleLine;
          return `\`\`\`github-issue\n${JSON.stringify({ title, body: t.work_description })}\n\`\`\``;
        },
        async execute(agentTask) {
          receivedPrompt = agentTask.prompt;
          return {
            success: true, output: "https://github.com/owner/repo/issues/2", error: null,
            exit_code: 0, elapsed_ms: 10, stopped_reason: "completed" as const,
          };
        },
      };
      const longDesc = "A".repeat(200);
      const task = makeTask({ work_description: longDesc });

      await lifecycle.executeTask(task, adapter);
      const jsonMatch = receivedPrompt.match(/```github-issue\s*([\s\S]*?)```/);
      expect(jsonMatch).not.toBeNull();
      const parsed = JSON.parse(jsonMatch![1].trim());
      expect(parsed.title.length).toBeLessThanOrEqual(120);
      expect(parsed.body).toBe(longDesc);
    });

    it("sets timeout_ms from estimated_duration", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      let receivedTimeout = 0;
      const adapter: import("../task/task-lifecycle.js").IAdapter = {
        adapterType: "mock",
        async execute(agentTask) {
          receivedTimeout = agentTask.timeout_ms;
          return {
            success: true, output: "ok", error: null,
            exit_code: 0, elapsed_ms: 10, stopped_reason: "completed" as const,
          };
        },
      };
      const task = makeTask({ estimated_duration: { value: 2, unit: "hours" } });

      await lifecycle.executeTask(task, adapter);
      expect(receivedTimeout).toBe(2 * 60 * 60 * 1000);
    });

    it("uses default timeout when estimated_duration is null", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      let receivedTimeout = 0;
      const adapter: import("../task/task-lifecycle.js").IAdapter = {
        adapterType: "mock",
        async execute(agentTask) {
          receivedTimeout = agentTask.timeout_ms;
          return {
            success: true, output: "ok", error: null,
            exit_code: 0, elapsed_ms: 10, stopped_reason: "completed" as const,
          };
        },
      };
      const task = makeTask({ estimated_duration: null });

      await lifecycle.executeTask(task, adapter);
      expect(receivedTimeout).toBe(30 * 60 * 1000); // default 30 minutes
    });

    it("sets adapter_type in AgentTask", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      let receivedType = "";
      const adapter: import("../task/task-lifecycle.js").IAdapter = {
        adapterType: "claude_api",
        async execute(agentTask) {
          receivedType = agentTask.adapter_type;
          return {
            success: true, output: "ok", error: null,
            exit_code: 0, elapsed_ms: 10, stopped_reason: "completed" as const,
          };
        },
      };

      await lifecycle.executeTask(makeTask(), adapter);
      expect(receivedType).toBe("claude_api");
    });

    it("sets started_at on the running task", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm);
      const adapter = createMockAdapter([{ success: true }]);
      const task = makeTask();

      await lifecycle.executeTask(task, adapter);

      const persisted = await stateManager.readRaw(`tasks/goal-1/task-1.json`) as Record<string, unknown>;
      // started_at should be set when task moves to running
      expect(persisted.started_at).toBeDefined();
      expect(typeof persisted.started_at).toBe("string");
    });

    // ─── filesChanged annotation (git diff check) ───

    it("sets filesChanged=true when git diff --stat reports changed files", async () => {
      // Inject mock via execFileSyncFn option to avoid ES module spy issues
      let snapshotReadCount = 0;
      const mockExecFileSync = vi.fn((_cmd: string, args: string[]) => {
        const key = args.join(" ");
        if (
          key === "diff --name-only"
          || key === "diff --cached --name-only"
          || key === "ls-files --others --exclude-standard"
        ) {
          snapshotReadCount += 1;
          if (snapshotReadCount <= 3) return "";
        }
        if (key === "diff --name-only") return "src/foo.ts\n";
        if (key === "diff --cached --name-only") return "";
        if (key === "ls-files --others --exclude-standard") return "";
        if (key === "diff -- src/foo.ts") {
          return "diff --git a/src/foo.ts b/src/foo.ts\n@@ -1 +1 @@\n-old\n+new\n";
        }
        return "";
      });

      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm, { execFileSyncFn: mockExecFileSync });
      const adapter = createMockAdapter([{ success: true }]);
      const task = makeTask();

      const result = await lifecycle.executeTask(task, adapter);

      expect(result.filesChanged).toBe(true);
    });

    it("sets filesChanged=false and logs warning when git diff --stat is empty", async () => {
      // Inject mock that returns empty string (no files changed)
      const mockExecFileSync = vi.fn().mockReturnValue("");

      const warnCalls: Array<[string, Record<string, unknown>?]> = [];
      const mockLogger = {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn((...args: unknown[]) => {
          warnCalls.push(args as [string, Record<string, unknown>?]);
        }),
        error: vi.fn(),
      };

      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm, {
        logger: mockLogger as unknown as import("../../../runtime/logger.js").Logger,
        execFileSyncFn: mockExecFileSync,
      });
      const adapter = createMockAdapter([{ success: true }]);
      const task = makeTask();

      const result = await lifecycle.executeTask(task, adapter);

      expect(result.filesChanged).toBe(false);
      // Logger.warn should have been called with the no-files-modified message
      expect(warnCalls.some(([msg]) => msg.includes("no files were modified"))).toBe(true);
    });

    it("does not annotate filesChanged when git is unavailable", async () => {
      // Inject mock that throws (simulates git not available / not a git repo)
      const mockExecFileSync = vi.fn().mockImplementation(() => {
        throw new Error("git: command not found");
      });

      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm, { execFileSyncFn: mockExecFileSync });
      const adapter = createMockAdapter([{ success: true }]);
      const task = makeTask();

      // Should not throw, and filesChanged should be undefined (check skipped)
      const result = await lifecycle.executeTask(task, adapter);

      expect(result.success).toBe(true);
      expect(result.filesChanged).toBeUndefined();
    });

    it("filters diff evidence when adapter reports failure", async () => {
      const mockExecFileSync = vi.fn().mockReturnValue("some output");

      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm, { execFileSyncFn: mockExecFileSync });
      const adapter = createMockAdapter([{ success: false, stopped_reason: "error" }]);
      const task = makeTask();

      const result = await lifecycle.executeTask(task, adapter);

      expect(result.filesChanged).toBe(false);
      expect(result.filesChangedPaths).toEqual([]);
      expect(result.fileDiffs).toEqual([]);
      expect(mockExecFileSync).toHaveBeenCalledWith(
        "git",
        ["check-ignore", "--", "."],
        expect.objectContaining({ encoding: "utf-8" }),
      );
      expect(mockExecFileSync.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("executeTaskWithAgentLoop", () => {
    it("records dirty isolated worktree handoff as non-completed execution", async () => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm, {
        agentLoopRunner: makeAgentLoopRunner(makeAgentLoopResult("completed", {
          filesChanged: true,
          changedFiles: ["README.md"],
          workspace: {
            requestedCwd: "/repo",
            executionCwd: "/worktrees/task-1",
            isolated: true,
            cleanupStatus: "kept",
            cleanupReason: "worktree has changes",
            dirty: true,
            disposition: "handoff_required",
          },
        })),
        execFileSyncFn: () => "",
      });
      const task = makeTask();
      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);

      const result = await lifecycle.executeTaskWithAgentLoop(task, "workspace context", "knowledge context");

      const persisted = await stateManager.readRaw(`tasks/${task.goal_id}/${task.id}.json`) as Record<string, unknown>;
      const ledger = await stateManager.readRaw(`tasks/${task.goal_id}/ledger/${task.id}.json`) as {
        events: Array<Record<string, unknown>>;
        summary: Record<string, unknown>;
      };

      expect(result.success).toBe(false);
      expect(result.stopped_reason).toBe("error");
      expect(result.output).toContain("/worktrees/task-1");
      expect(result.agentLoop).toMatchObject({
        isolatedWorkspace: true,
        workspaceDirty: true,
        workspaceDisposition: "handoff_required",
      });
      expect(persisted.status).toBe("error");
      expect(persisted.completed_at).toBeNull();
      expect(ledger.events.map((event) => event.type)).toEqual(["started", "failed"]);
      expect(ledger.events.at(-1)!.reason).toContain("operator handoff");
      expect(ledger.summary.task_status).toBe("error");
    });

    it("excludes pre-existing dirty workspace paths from worktree-disabled native file diffs", async () => {
      const llm = createMockLLMClient([]);
      const repo = makeDirtyGitRepo("native-dirty-repo");
      const task = makeTask({
        id: "task-dirty-native",
        constraints: [`workspace_path:${repo}`],
      });
      const agentLoopRunner = {
        runTask: vi.fn().mockImplementation(async (input: { cwd?: string }) => {
          expect(input.cwd).toBe(repo);
          fs.writeFileSync(path.join(repo, "task-output.txt"), "task output\n", "utf-8");
          return makeAgentLoopResult("completed", {
            filesChanged: true,
            changedFiles: ["preexisting.txt", "task-output.txt"],
            workspace: {
              requestedCwd: repo,
              executionCwd: repo,
              isolated: false,
              cleanupStatus: "not_requested",
              dirty: false,
              disposition: "not_isolated",
            },
          });
        }),
      } as unknown as TaskAgentLoopRunner;
      const lifecycle = createLifecycle(llm, {
        agentLoopRunner,
        execFileSyncFn: realExecFileSync,
      });
      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);

      const result = await lifecycle.executeTaskWithAgentLoop(task, "workspace context", "knowledge context");

      expect(result.success).toBe(true);
      expect(result.filesChangedPaths).toEqual(["task-output.txt"]);
      expect(result.fileDiffs?.map((diff) => diff.path)).toEqual(["task-output.txt"]);
      expect(result.fileDiffs?.[0]?.patch).toContain("+task output");
      expect(fs.readFileSync(path.join(repo, "preexisting.txt"), "utf-8")).toBe("dirty before task\n");
    });

    it("fails native normal-task success when git diff capture finds no file changes", async () => {
      const llm = createMockLLMClient([]);
      const repo = makeDirtyGitRepo("native-no-change-repo");
      const task = makeTask({
        id: "task-native-no-change-git",
        constraints: [`workspace_path:${repo}`],
      });
      const agentLoopRunner = {
        runTask: vi.fn().mockImplementation(async (input: { cwd?: string }) => {
          expect(input.cwd).toBe(repo);
          return makeAgentLoopResult("completed", {
            output: {
              status: "done",
              finalAnswer: "claimed done",
              summary: "claimed done",
              filesChanged: [],
              testsRun: [],
              completionEvidence: ["claimed implementation"],
              verificationHints: [],
              blockers: [],
            },
            changedFiles: [],
            workspace: {
              requestedCwd: repo,
              executionCwd: repo,
              isolated: false,
              cleanupStatus: "not_requested",
              dirty: false,
              disposition: "not_isolated",
            },
          });
        }),
      } as unknown as TaskAgentLoopRunner;
      const lifecycle = createLifecycle(llm, {
        agentLoopRunner,
        execFileSyncFn: realExecFileSync,
      });
      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);

      const result = await lifecycle.executeTaskWithAgentLoop(task, "workspace context", "knowledge context");
      const persisted = await stateManager.readRaw(`tasks/${task.goal_id}/${task.id}.json`) as Record<string, unknown>;
      const ledger = await stateManager.readRaw(`tasks/${task.goal_id}/ledger/${task.id}.json`) as {
        events: Array<Record<string, unknown>>;
        summary: Record<string, unknown>;
      };

      expect(result.success).toBe(false);
      expect(result.error).toBe("No files were modified");
      expect(result.filesChanged).toBe(false);
      expect(result.filesChangedPaths).toEqual([]);
      expect(result.agentLoop?.verificationHints).toContain("No files were modified");
      expect(persisted.status).toBe("error");
      expect(ledger.events.map((event) => event.type)).toEqual(["started", "failed"]);
      expect(ledger.events.at(-1)!.reason).toBe("No files were modified");
    });

    it("fails native normal-task success in non-git workspaces when no changed files are captured", async () => {
      const llm = createMockLLMClient([]);
      const workspace = path.join(tmpDir, "native-no-change-non-git");
      fs.mkdirSync(workspace, { recursive: true });
      const task = makeTask({
        id: "task-native-no-change-non-git",
        constraints: [`workspace_path:${workspace}`],
      });
      const agentLoopRunner = {
        runTask: vi.fn().mockImplementation(async (input: { cwd?: string }) => {
          expect(input.cwd).toBe(workspace);
          return makeAgentLoopResult("completed", {
            output: {
              status: "done",
              finalAnswer: "claimed done",
              summary: "claimed done",
              filesChanged: [],
              testsRun: [],
              completionEvidence: ["claimed implementation"],
              verificationHints: [],
              blockers: [],
            },
            changedFiles: [],
            workspace: {
              requestedCwd: workspace,
              executionCwd: workspace,
              isolated: false,
              cleanupStatus: "not_requested",
              dirty: false,
              disposition: "not_isolated",
            },
          });
        }),
      } as unknown as TaskAgentLoopRunner;
      const lifecycle = createLifecycle(llm, {
        agentLoopRunner,
        execFileSyncFn: realExecFileSync,
      });
      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);

      const result = await lifecycle.executeTaskWithAgentLoop(task, "workspace context", "knowledge context");
      const persisted = await stateManager.readRaw(`tasks/${task.goal_id}/${task.id}.json`) as Record<string, unknown>;

      expect(result.success).toBe(false);
      expect(result.error).toBe("No files were modified");
      expect(result.diffEvidenceSource).toBe("filesystem_artifact");
      expect(result.filesChangedPaths).toEqual([]);
      expect(result.agentLoop?.verificationHints).toContain("No files were modified");
      expect(persisted.status).toBe("error");
    });

    it("reports filesystem artifact evidence for a policy-blocked non-git Kaggle workspace without artifacts", async () => {
      const llm = createMockLLMClient([]);
      const workspace = path.join(tmpDir, "playground-series-s6e5");
      fs.mkdirSync(workspace, { recursive: true });
      const task = makeTask({
        id: "task-kaggle-policy-blocked-non-git",
        constraints: [`workspace_path:${workspace}`, "run_spec_profile:kaggle"],
      });
      const agentLoopRunner = makeAgentLoopRunner(makeAgentLoopResult("completed", {
        success: true,
        output: {
          status: "blocked",
          finalAnswer: "policy blocked before training artifacts were created",
          summary: "policy blocked",
          filesChanged: [],
          testsRun: [],
          completionEvidence: [],
          verificationHints: [],
          blockers: ["shell execution was blocked by runtime policy"],
        },
        changedFiles: [],
        commandResults: [{
          toolName: "shell",
          command: "python train.py",
          cwd: workspace,
          success: false,
          execution: { status: "not_executed", reason: "policy_blocked", message: "shell execution blocked" },
          category: "other",
          evidenceEligible: false,
          relevantToTask: true,
          outputSummary: "shell execution blocked",
          durationMs: 1,
        }],
        workspace: {
          requestedCwd: workspace,
          executionCwd: workspace,
          isolated: false,
          cleanupStatus: "not_requested",
          dirty: false,
          disposition: "not_isolated",
        },
      }));
      const lifecycle = createLifecycle(llm, {
        agentLoopRunner,
        execFileSyncFn: realExecFileSync,
      });
      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);

      const result = await lifecycle.executeTaskWithAgentLoop(task, "workspace context", "knowledge context");
      const persisted = await stateManager.readRaw(`tasks/${task.goal_id}/${task.id}.json`) as Record<string, unknown>;

      expect(result.success).toBe(false);
      expect(result.stopped_reason).toBe("policy_blocked");
      expect(result.diffEvidenceSource).toBe("filesystem_artifact");
      expect(result.filesChanged).toBe(false);
      expect(result.filesChangedPaths).toEqual([]);
      expect(result.fileDiffs).toEqual([]);
      expect(result.error).toContain("shell execution was blocked by runtime policy");
      expect(fs.existsSync(path.join(workspace, "hgb-balanced-weight-smoke"))).toBe(false);
      expect(fs.existsSync(path.join(workspace, "metrics.json"))).toBe(false);
      expect(fs.existsSync(path.join(workspace, "submission.csv"))).toBe(false);
      expect(persisted.status).toBe("blocked");
    });

    it("fails non-git native success without treating model-claimed paths as changed evidence", async () => {
      const llm = createMockLLMClient([]);
      const workspace = path.join(tmpDir, "native-claimed-change-non-git");
      fs.mkdirSync(workspace, { recursive: true });
      fs.writeFileSync(path.join(workspace, "claimed.txt"), "unchanged\n", "utf-8");
      const task = makeTask({
        id: "task-native-claimed-change-non-git",
        constraints: [`workspace_path:${workspace}`],
      });
      const agentLoopRunner = {
        runTask: vi.fn().mockImplementation(async (input: { cwd?: string }) => {
          expect(input.cwd).toBe(workspace);
          return makeAgentLoopResult("completed", {
            output: {
              status: "done",
              finalAnswer: "claimed done",
              summary: "claimed done",
              filesChanged: ["claimed.txt"],
              testsRun: [],
              completionEvidence: ["claimed implementation"],
              verificationHints: [],
              blockers: [],
            },
            changedFiles: [],
            workspace: {
              requestedCwd: workspace,
              executionCwd: workspace,
              isolated: false,
              cleanupStatus: "not_requested",
              dirty: false,
              disposition: "not_isolated",
            },
          });
        }),
      } as unknown as TaskAgentLoopRunner;
      const lifecycle = createLifecycle(llm, {
        agentLoopRunner,
        execFileSyncFn: realExecFileSync,
      });
      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);

      const result = await lifecycle.executeTaskWithAgentLoop(task, "workspace context", "knowledge context");
      const persisted = await stateManager.readRaw(`tasks/${task.goal_id}/${task.id}.json`) as Record<string, unknown>;

      expect(result.success).toBe(false);
      expect(result.error).toBe("No files were modified");
      expect(result.diffEvidenceSource).toBe("filesystem_artifact");
      expect(result.filesChangedPaths).toEqual([]);
      expect(result.agentLoop?.verificationHints).toContain("No files were modified");
      expect(persisted.status).toBe("error");
    });

    it("defers external AgentLoop success ledger events until task verification observes the result", async () => {
      const llm = createMockLLMClient([]);
      const workspace = path.join(tmpDir, "external-success-deferred");
      fs.mkdirSync(workspace, { recursive: true });
      fs.writeFileSync(path.join(workspace, "README.md"), "base\n", "utf-8");
      const task = makeTask({
        id: "task-external-success-deferred",
        constraints: [`workspace_path:${workspace}`],
      });
      const agentLoopRunner = {
        runTask: vi.fn().mockImplementation(async (input: { cwd?: string }) => {
          expect(input.cwd).toBe(workspace);
          fs.writeFileSync(path.join(workspace, "result.txt"), "done\n", "utf-8");
          return makeAgentLoopResult("completed", {
            output: {
              status: "done",
              finalAnswer: "created result.txt",
              summary: "created result",
              filesChanged: [],
              testsRun: [],
              completionEvidence: ["external runtime reported result.txt"],
              verificationHints: [],
              blockers: [],
            },
            changedFiles: ["result.txt"],
            requiresPostVerificationBeforeSuccessLedger: true,
            workspace: {
              requestedCwd: workspace,
              executionCwd: workspace,
              isolated: false,
              cleanupStatus: "not_requested",
              dirty: false,
              disposition: "not_isolated",
            },
          });
        }),
      } as unknown as TaskAgentLoopRunner;
      const lifecycle = createLifecycle(llm, {
        agentLoopRunner,
        execFileSyncFn: realExecFileSync,
      });
      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);

      const result = await lifecycle.executeTaskWithAgentLoop(task, "workspace context", "knowledge context");

      const persisted = await stateManager.readRaw(`tasks/${task.goal_id}/${task.id}.json`) as Record<string, unknown>;
      const ledger = await stateManager.readRaw(`tasks/${task.goal_id}/ledger/${task.id}.json`) as {
        events: Array<Record<string, unknown>>;
        summary: Record<string, unknown>;
      };

      expect(result.success).toBe(true);
      expect(result.agentLoop?.requiresPostVerificationBeforeSuccessLedger).toBe(true);
      expect(result.filesChangedPaths).toEqual(["result.txt"]);
      expect(result.fileDiffs?.map((diff) => diff.path)).toEqual(["result.txt"]);
      expect(persisted.status).toBe("running");
      expect(persisted.completed_at).toBeNull();
      expect(ledger.events.map((event) => event.type)).toEqual(["started"]);
      expect(ledger.summary.latest_event_type).toBe("started");
      expect(ledger.summary.task_status).toBe("running");
    });

    it("defers external AgentLoop blocked ledger events when artifact evidence was created", async () => {
      const llm = createMockLLMClient([]);
      const workspace = path.join(tmpDir, "external-blocked-artifact-deferred");
      fs.mkdirSync(workspace, { recursive: true });
      const task = makeTask({
        id: "task-external-blocked-artifact-deferred",
        constraints: [`workspace_path:${workspace}`],
        artifact_contract: {
          required: true,
          required_artifacts: [{
            kind: "metrics_json" as const,
            path: "reports/judger.json",
            required_fields: ["scenario", "passed"],
            field_types: {
              scenario: "string" as const,
              passed: "boolean" as const,
            },
            fresh_after_task_start: true,
          }],
        },
      });
      const agentLoopRunner = {
        runTask: vi.fn().mockImplementation(async (input: { cwd?: string }) => {
          expect(input.cwd).toBe(workspace);
          fs.mkdirSync(path.join(workspace, "reports"), { recursive: true });
          fs.writeFileSync(
            path.join(workspace, "reports", "judger.json"),
            JSON.stringify({ scenario: "completion-judger-fallback", passed: true }),
            "utf-8"
          );
          return makeAgentLoopResult("completed", {
            output: {
              status: "blocked",
              finalAnswer: "claimed workspace was read-only",
              summary: "claimed blocked",
              filesChanged: [],
              testsRun: [],
              completionEvidence: [],
              verificationHints: [],
              blockers: [],
            },
            changedFiles: ["reports/judger.json"],
            workspace: {
              requestedCwd: workspace,
              executionCwd: workspace,
              isolated: false,
              cleanupStatus: "not_requested",
              dirty: false,
              disposition: "not_isolated",
            },
          });
        }),
      } as unknown as TaskAgentLoopRunner;
      const lifecycle = createLifecycle(llm, {
        agentLoopRunner,
        execFileSyncFn: realExecFileSync,
      });
      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);

      const result = await lifecycle.executeTaskWithAgentLoop(task, "workspace context", "knowledge context");

      const persisted = await stateManager.readRaw(`tasks/${task.goal_id}/${task.id}.json`) as Record<string, unknown>;
      const ledger = await stateManager.readRaw(`tasks/${task.goal_id}/ledger/${task.id}.json`) as {
        events: Array<Record<string, unknown>>;
        summary: Record<string, unknown>;
      };

      expect(result.success).toBe(false);
      expect(result.stopped_reason).toBe("blocked");
      expect(result.filesChangedPaths).toEqual(["reports/judger.json"]);
      expect(persisted.status).toBe("running");
      expect(persisted.stopped_at).toBeUndefined();
      expect(ledger.events.map((event) => event.type)).toEqual(["started"]);
      expect(ledger.summary.task_status).toBe("running");
    });

    it("defers completion-gate failure ledger events when changed files can be mechanically verified", async () => {
      const llm = createMockLLMClient([]);
      const workspace = path.join(tmpDir, "external-completion-gate-mechanical-deferred");
      fs.mkdirSync(workspace, { recursive: true });
      const task = makeTask({
        id: "task-completion-gate-mechanical-deferred",
        constraints: [`workspace_path:${workspace}`],
        success_criteria: [{
          description: "Canary contract validates",
          verification_method: "node scripts/judger-canary.mjs --check-contract",
          is_blocking: true,
        }],
      });
      const agentLoopRunner = {
        runTask: vi.fn().mockImplementation(async (input: { cwd?: string }) => {
          expect(input.cwd).toBe(workspace);
          fs.mkdirSync(path.join(workspace, "reports"), { recursive: true });
          fs.mkdirSync(path.join(workspace, "scripts"), { recursive: true });
          fs.writeFileSync(
            path.join(workspace, "reports", "judger.json"),
            JSON.stringify({ scenario: "completion-judger-fallback", passed: true }),
            "utf-8"
          );
          fs.writeFileSync(
            path.join(workspace, "scripts", "judger-canary.mjs"),
            "import fs from 'node:fs';\nconst report = JSON.parse(fs.readFileSync('reports/judger.json', 'utf8'));\nif (report.scenario !== 'completion-judger-fallback' || report.passed !== true) process.exit(1);\n",
            "utf-8"
          );
          return makeAgentLoopResult("completion_gate_failed", {
            finalText: "{\"status\":\"done\",\"finalAnswer\":\"claimed verification without observed tool call\"}",
            changedFiles: ["reports/judger.json", "scripts/judger-canary.mjs"],
            workspace: {
              requestedCwd: workspace,
              executionCwd: workspace,
              isolated: false,
              cleanupStatus: "not_requested",
              dirty: false,
              disposition: "not_isolated",
            },
          });
        }),
      } as unknown as TaskAgentLoopRunner;
      const lifecycle = createLifecycle(llm, {
        agentLoopRunner,
        execFileSyncFn: realExecFileSync,
      });
      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);

      const result = await lifecycle.executeTaskWithAgentLoop(task, "workspace context", "knowledge context");

      const persisted = await stateManager.readRaw(`tasks/${task.goal_id}/${task.id}.json`) as Record<string, unknown>;
      const ledger = await stateManager.readRaw(`tasks/${task.goal_id}/ledger/${task.id}.json`) as {
        events: Array<Record<string, unknown>>;
        summary: Record<string, unknown>;
      };

      expect(result.success).toBe(false);
      expect(result.stopped_reason).toBe("error");
      expect(result.agentLoop?.stopReason).toBe("completion_gate_failed");
      expect(result.filesChangedPaths).toEqual(["reports/judger.json", "scripts/judger-canary.mjs"]);
      expect(persisted.status).toBe("running");
      expect(persisted.stopped_at).toBeUndefined();
      expect(ledger.events.map((event) => event.type)).toEqual(["started"]);
      expect(ledger.summary.task_status).toBe("running");
    });

    it.each([
      {
        stopReason: "timeout" as const,
        expectedTaskStatus: "timed_out",
        expectedTimestampField: "timeout_at",
      },
      {
        stopReason: "cancelled" as const,
        expectedTaskStatus: "cancelled",
        expectedTimestampField: "stopped_at",
      },
    ])("records native $stopReason stop reason in task ledger", async ({
      stopReason,
      expectedTaskStatus,
      expectedTimestampField,
    }) => {
      const llm = createMockLLMClient([]);
      const lifecycle = createLifecycle(llm, {
        agentLoopRunner: makeAgentLoopRunner(makeAgentLoopResult(stopReason)),
        execFileSyncFn: () => "",
      });
      const task = makeTask();
      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);

      const result = await lifecycle.executeTaskWithAgentLoop(task, "workspace context", "knowledge context");

      const persisted = await stateManager.readRaw(`tasks/${task.goal_id}/${task.id}.json`) as Record<string, unknown>;
      const ledger = await stateManager.readRaw(`tasks/${task.goal_id}/ledger/${task.id}.json`) as {
        events: Array<Record<string, unknown>>;
        summary: Record<string, unknown>;
      };
      const failedEvent = ledger.events.at(-1)!;

      expect(result.success).toBe(false);
      expect(result.stopped_reason).toBe(stopReason);
      expect(persisted.status).toBe(expectedTaskStatus);
      expect(persisted[expectedTimestampField]).toEqual(expect.any(String));
      expect(ledger.events.map((event) => event.type)).toEqual(["started", "failed"]);
      expect(failedEvent.stopped_reason).toBe(stopReason);
      expect(ledger.summary.task_status).toBe(expectedTaskStatus);
      expect(ledger.summary.latest_event_type).toBe("failed");
      expect(ledger.summary.stopped_reason).toBe(stopReason);
    });

    it("keeps daemon-shutdown-interrupted native AgentLoop tasks running for recovery", async () => {
      const llm = createMockLLMClient([]);
      const abortController = new AbortController();
      abortController.abort(createDaemonShutdownAbortReason("test daemon shutdown"));
      const lifecycle = createLifecycle(llm, {
        agentLoopRunner: makeAgentLoopRunner(makeAgentLoopResult("cancelled")),
        execFileSyncFn: () => "",
      });
      const task = makeTask();
      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);

      const result = await lifecycle.executeTaskWithAgentLoop(
        task,
        "workspace context",
        "knowledge context",
        abortController.signal,
      );

      const persisted = await stateManager.readRaw(`tasks/${task.goal_id}/${task.id}.json`) as Record<string, unknown>;
      const ledger = await stateManager.readRaw(`tasks/${task.goal_id}/ledger/${task.id}.json`) as {
        events: Array<Record<string, unknown>>;
        summary: Record<string, unknown>;
      };

      expect(result.success).toBe(false);
      expect(result.stopped_reason).toBe("cancelled");
      expect(persisted.status).toBe("running");
      expect(persisted.stopped_at).toBeUndefined();
      expect(ledger.events.map((event) => event.type)).toEqual(["started"]);
      expect(ledger.summary.task_status).toBe("running");
      expect(ledger.summary.latest_event_type).toBe("started");
    });

    it("aligns profiled Kaggle native AgentLoop budget with generated task estimate and reports both on timeout", async () => {
      const llm = createMockLLMClient([]);
      const task = makeTask({
        id: "task-kaggle-budget",
        constraints: [],
        estimated_duration: { value: 45, unit: "minutes" },
      });
      await stateManager.saveGoal(GoalSchema.parse({
        id: task.goal_id,
        parent_id: null,
        node_type: "goal",
        title: "Kaggle benchmark",
        description: "Run profiled Kaggle work",
        status: "active",
        dimensions: [],
        gap_aggregation: "max",
        dimension_mapping: null,
        constraints: ["run_spec_profile:kaggle"],
        children_ids: [],
        target_date: null,
        origin: "manual",
        pace_snapshot: null,
        deadline: null,
        finalization_policy: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }));
      const agentLoopRunner = {
        runTask: vi.fn().mockImplementation(async (input: { budget?: { maxWallClockMs?: number } }) => {
          expect(input.budget?.maxWallClockMs).toBe(50 * 60_000);
          return makeAgentLoopResult("timeout", {
            activeBudgetMs: input.budget?.maxWallClockMs,
            generatedEstimateMs: 45 * 60_000,
            finalText: "timeout",
          });
        }),
      } as unknown as TaskAgentLoopRunner;
      const lifecycle = createLifecycle(llm, {
        agentLoopRunner,
        execFileSyncFn: () => "",
      });
      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);

      const result = await lifecycle.executeTaskWithAgentLoop(task, "workspace context", "knowledge context");

      expect(result.stopped_reason).toBe("timeout");
      expect(result.agentLoop?.generatedEstimateMs).toBe(45 * 60_000);
      expect(result.agentLoop?.activeBudgetMs).toBe(50 * 60_000);
      expect(result.error).toContain("generated estimate 2700000ms");
      expect(result.error).toContain("active AgentLoop budget 3000000ms");
    });

    it("records policy-blocked native tool non-execution as blocked instead of timed out", async () => {
      const llm = createMockLLMClient([]);
      const policyBlockedResult = makeAgentLoopResult("completed", {
        success: false,
        output: null,
        finalText: "policy-blocked tool call",
        toolCalls: 1,
        commandResults: [{
          toolName: "shell_command",
          command: "python - <<'PY'\nprint('rewrite')\nPY",
          cwd: tmpDir,
          success: false,
          execution: {
            status: "not_executed",
            reason: "policy_blocked",
            message: "Shell command contains unsupported multiline syntax",
          },
          category: "other",
          evidenceEligible: false,
          outputSummary: "blocked by shell policy",
          durationMs: 1,
        }],
      });
      const lifecycle = createLifecycle(llm, {
        agentLoopRunner: makeAgentLoopRunner(policyBlockedResult),
        execFileSyncFn: () => "",
      });
      const task = makeTask();
      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);

      const result = await lifecycle.executeTaskWithAgentLoop(task, "workspace context", "knowledge context");

      const persisted = await stateManager.readRaw(`tasks/${task.goal_id}/${task.id}.json`) as Record<string, unknown>;
      const ledger = await stateManager.readRaw(`tasks/${task.goal_id}/ledger/${task.id}.json`) as {
        events: Array<Record<string, unknown>>;
        summary: Record<string, unknown>;
      };
      const failedEvent = ledger.events.at(-1)!;

      expect(result.success).toBe(false);
      expect(result.stopped_reason).toBe("policy_blocked");
      expect(persisted.status).toBe("blocked");
      expect(persisted.timeout_at).toBeNull();
      expect(persisted.stopped_at).toEqual(expect.any(String));
      expect(ledger.events.map((event) => event.type)).toEqual(["started", "failed"]);
      expect(failedEvent.stopped_reason).toBe("policy_blocked");
      expect(ledger.summary.task_status).toBe("blocked");
      expect(ledger.summary.latest_event_type).toBe("failed");
      expect(ledger.summary.stopped_reason).toBe("policy_blocked");
    });
  });
});
