import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { StateManager } from "../../../base/state/state-manager.js";
import { SessionManager } from "../session-manager.js";
import { TrustManager } from "../../../platform/traits/trust-manager.js";
import { StrategyManager } from "../../strategy/strategy-manager.js";
import { StallDetector } from "../../../platform/drive/stall-detector.js";
import { TaskLifecycle } from "../task/task-lifecycle.js";
import type { Task } from "../../../base/types/task.js";
import type { AgentLoopResult } from "../agent-loop/agent-loop-result.js";
import type { TaskAgentLoopOutput } from "../agent-loop/task-agent-loop-result.js";
import type { TaskAgentLoopRunner } from "../agent-loop/task-agent-loop-runner.js";
import type { GapVector } from "../../../base/types/gap.js";
import type { DriveContext } from "../../../base/types/drive.js";
import type {
  ILLMClient,
  LLMMessage,
  LLMRequestOptions,
  LLMResponse,
} from "../../../base/llm/llm-client.js";
import { createMockLLMClient } from "../../../../tests/helpers/mock-llm.js";
import { makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { summarizeTaskOutcomeLedgers } from "../task/task-outcome-ledger.js";
import { z } from "zod/v3";

function createSpyLLMClient(responses: string[]): ILLMClient {
  let callIndex = 0;
  return {
    async sendMessage(
      _messages: LLMMessage[],
      _options?: LLMRequestOptions
    ): Promise<LLMResponse> {
      return {
        content: responses[callIndex++] ?? "",
        usage: { input_tokens: 0, output_tokens: 0 },
        stop_reason: "end_turn",
      };
    },
    parseJSON<T>(content: string, schema: z.ZodSchema<T>): T {
      const match = content.match(/```json\n?([\s\S]*?)\n?```/) || [null, content];
      return schema.parse(JSON.parse(match[1] ?? content));
    },
  };
}

const VALID_TASK_RESPONSE = `\`\`\`json
{
  "work_description": "Write unit tests for the authentication module",
  "rationale": "Improve test coverage to catch regressions early",
  "approach": "Use vitest to write tests for login, logout, and token refresh flows",
  "success_criteria": [
    {
      "description": "All auth flows have at least one test",
      "verification_method": "Run vitest and check test count",
      "is_blocking": true
    }
  ],
  "scope_boundary": {
    "in_scope": ["auth module tests"],
    "out_of_scope": ["auth module implementation changes"],
    "blast_radius": "tests/ directory only"
  },
  "constraints": ["Must not modify production code"],
  "artifact_contract": {
    "required": false,
    "required_artifacts": []
  },
  "reversibility": "reversible",
  "estimated_duration": { "value": 2, "unit": "hours" }
}
\`\`\``;

const LLM_REVIEW_PASS = '{"verdict": "pass", "reasoning": "All criteria satisfied", "criteria_met": 1, "criteria_total": 1}';
const LLM_REVIEW_FAIL = '{"verdict": "fail", "reasoning": "Criteria not met", "criteria_met": 0, "criteria_total": 1}';

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

function makeVerificationResult(
  overrides: Partial<import("../../../base/types/task.js").VerificationResult> = {}
): import("../../../base/types/task.js").VerificationResult {
  return {
    task_id: "task-1",
    verdict: "fail",
    confidence: 0.9,
    evidence: [
      { layer: "independent_review", description: "Verification failed", confidence: 0.8 },
      { layer: "self_report", description: "Task reported success", confidence: 0.3 },
    ],
    dimension_updates: [],
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeNativeTimeoutRunner(): TaskAgentLoopRunner {
  const result: AgentLoopResult<TaskAgentLoopOutput> = {
    success: false,
    output: null,
    finalText: "timeout",
    stopReason: "timeout",
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
  };
  return {
    runTask: async () => result,
  } as unknown as TaskAgentLoopRunner;
}

function makeNativeDirtyHandoffRunner(): TaskAgentLoopRunner {
  const result: AgentLoopResult<TaskAgentLoopOutput> = {
    success: true,
    output: {
      status: "done",
      finalAnswer: "done in isolated worktree",
      summary: "done",
      filesChanged: ["tracked.txt"],
      testsRun: [],
      completionEvidence: ["model reported success"],
      verificationHints: [],
      blockers: [],
    },
    finalText: "done in isolated worktree",
    stopReason: "completed",
    elapsedMs: 100,
    modelTurns: 1,
    toolCalls: 1,
    compactions: 0,
    filesChanged: true,
    changedFiles: ["tracked.txt"],
    commandResults: [],
    workspace: {
      requestedCwd: "/repo",
      executionCwd: "/worktrees/task-1",
      isolated: true,
      cleanupStatus: "kept",
      cleanupReason: "worktree has changes",
      dirty: true,
      disposition: "handoff_required",
    },
    traceId: "trace-1",
    sessionId: "session-1",
    turnId: "turn-1",
  };
  return {
    runTask: async () => result,
  } as unknown as TaskAgentLoopRunner;
}

function makeNativeBlockedRunner(): TaskAgentLoopRunner {
  const result: AgentLoopResult<TaskAgentLoopOutput> = {
    success: true,
    output: {
      status: "blocked",
      finalAnswer: "Experiment execution could not run.",
      summary: "blocked",
      filesChanged: [],
      testsRun: [],
      completionEvidence: [],
      verificationHints: [],
      blockers: ["Kaggle API token is unavailable."],
    },
    finalText: "Experiment execution could not run.",
    stopReason: "completed",
    elapsedMs: 100,
    modelTurns: 1,
    toolCalls: 0,
    compactions: 0,
    filesChanged: false,
    changedFiles: [],
    commandResults: [],
    traceId: "trace-blocked",
    sessionId: "session-blocked",
    turnId: "turn-blocked",
  };
  return {
    runTask: async () => result,
  } as unknown as TaskAgentLoopRunner;
}

function makeGapVector(goalId: string, dimensionName: string): GapVector {
  return {
    goal_id: goalId,
    gaps: [
      {
        dimension_name: dimensionName,
        raw_gap: 0.5,
        normalized_gap: 0.5,
        normalized_weighted_gap: 0.5,
        confidence: 0.8,
        uncertainty_weight: 1.0,
      },
    ],
    timestamp: new Date().toISOString(),
  };
}

function makeDriveContext(dimensionName: string): DriveContext {
  return {
    time_since_last_attempt: { [dimensionName]: 24 },
    deadlines: { [dimensionName]: null },
    opportunities: {},
    pacing: {},
  };
}

describe("TaskLifecycle — persistence", () => {
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
    llmClient: ILLMClient,
    options?: Partial<import("../task/task-lifecycle.js").TaskLifecycleOptions>
  ): TaskLifecycle {
    strategyManager = new StrategyManager(stateManager, llmClient);
    return new TaskLifecycle(
      stateManager,
      llmClient,
      sessionManager,
      trustManager,
      strategyManager,
      stallDetector,
      { healthCheckEnabled: false, execFileSyncFn: () => "some-file.ts", ...options }
    );
  }

  function initRevertRepo(name: string): string {
    const repoDir = path.join(tmpDir, name);
    fs.mkdirSync(repoDir, { recursive: true });
    execFileSync("git", ["init"], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["config", "user.name", "Codex Test"], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["config", "user.email", "codex@example.com"], { cwd: repoDir, stdio: "pipe" });
    fs.writeFileSync(path.join(repoDir, "tracked.txt"), "original\n", "utf-8");
    execFileSync("git", ["add", "tracked.txt"], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir, stdio: "pipe" });
    fs.writeFileSync(path.join(repoDir, "tracked.txt"), "changed\n", "utf-8");
    return repoDir;
  }

  it("verification result saved to correct path", async () => {
    const llm = createMockLLMClient([LLM_REVIEW_PASS]);
    const lifecycle = createLifecycle(llm);
    const task = makeTask({ id: "task-persist-test" });
    const result: import("../task/task-lifecycle.js").AgentResult = {
      success: true,
      output: "done",
      error: null,
      exit_code: 0,
      elapsed_ms: 100,
      stopped_reason: "completed",
    };

    await lifecycle.verifyTask(task, result);

    const saved = await stateManager.readRaw("verification/task-persist-test/verification-result.json");
    expect(saved).not.toBeNull();
    expect((saved as Record<string, unknown>).task_id).toBe("task-persist-test");
  });

  it("task history accumulates entries", async () => {
    const llm = createMockLLMClient([]);
    const lifecycle = createLifecycle(llm);

    for (let i = 1; i <= 2; i++) {
      const task = makeTask({ id: `task-${i}` });
      const vr: import("../../../base/types/task.js").VerificationResult = {
        task_id: `task-${i}`,
        verdict: "pass",
        confidence: 0.9,
        evidence: [
          { layer: "independent_review", description: "OK", confidence: 0.8 },
        ],
        dimension_updates: [],
        timestamp: new Date().toISOString(),
      };

      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
      await lifecycle.handleVerdict(task, vr);
    }

    const history = await stateManager.readRaw("tasks/goal-1/task-history.json") as Array<Record<string, unknown>>;
    expect(history.length).toBe(2);
    expect(history[0]!.task_id).toBe("task-1");
    expect(history[1]!.task_id).toBe("task-2");
  });

  it("task history records primary_dimension", async () => {
    const llm = createMockLLMClient([]);
    const lifecycle = createLifecycle(llm);
    const task = makeTask({ primary_dimension: "coverage" });
    const vr: import("../../../base/types/task.js").VerificationResult = {
      task_id: "task-1",
      verdict: "pass",
      confidence: 0.9,
      evidence: [
        { layer: "independent_review", description: "OK", confidence: 0.8 },
      ],
      dimension_updates: [],
      timestamp: new Date().toISOString(),
    };

    await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
    await lifecycle.handleVerdict(task, vr);

    const history = await stateManager.readRaw("tasks/goal-1/task-history.json") as Array<Record<string, unknown>>;
    expect(history[0]!.primary_dimension).toBe("coverage");
  });

  it("task history records work_description and verification verdict for duplicate avoidance", async () => {
    const llm = createMockLLMClient([]);
    const lifecycle = createLifecycle(llm);
    const task = makeTask({ work_description: "Add focused daemon recovery regression test" });
    const vr: import("../../../base/types/task.js").VerificationResult = {
      task_id: "task-1",
      verdict: "fail",
      confidence: 0.9,
      evidence: [
        { layer: "independent_review", description: "No durable recovery improvement", confidence: 0.8 },
      ],
      dimension_updates: [],
      timestamp: new Date().toISOString(),
    };

    await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
    await lifecycle.handleFailure(task, vr);

    const history = await stateManager.readRaw("tasks/goal-1/task-history.json") as Array<Record<string, unknown>>;
    expect(history[0]!.id).toBe("task-1");
    expect(history[0]!.work_description).toBe("Add focused daemon recovery regression test");
    expect(history[0]!.verification_verdict).toBe("fail");
    expect(history[0]!.verification_evidence).toEqual(["No durable recovery improvement"]);
  });

  it("task history records consecutive_failure_count on failure", async () => {
    const llm = createMockLLMClient([]);
    const lifecycle = createLifecycle(llm);
    const task = makeTask({ consecutive_failure_count: 1 });
    const vr: import("../../../base/types/task.js").VerificationResult = {
      task_id: "task-1",
      verdict: "fail",
      confidence: 0.9,
      evidence: [
        { layer: "independent_review", description: "Direction OK", confidence: 0.8 },
        { layer: "self_report", description: "Tried", confidence: 0.3 },
      ],
      dimension_updates: [],
      timestamp: new Date().toISOString(),
    };

    await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
    await lifecycle.handleFailure(task, vr);

    const history = await stateManager.readRaw("tasks/goal-1/task-history.json") as Array<Record<string, unknown>>;
    expect(history[0]!.consecutive_failure_count).toBe(2);
  });

  it("executeTask persists running state before execution", async () => {
    const llm = createSpyLLMClient([]);
    const lifecycle = createLifecycle(llm);
    let statusDuringExecution = "";
    const adapter: import("../task/task-lifecycle.js").IAdapter = {
      adapterType: "mock",
      async execute() {
        const raw = await stateManager.readRaw("tasks/goal-1/task-1.json") as Record<string, unknown>;
        statusDuringExecution = raw?.status as string;
        return {
          success: true,
          output: "ok",
          error: null,
          exit_code: 0,
          elapsed_ms: 10,
          stopped_reason: "completed" as const,
        };
      },
    };
    const task = makeTask();

    await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
    await lifecycle.executeTask(task, adapter);

    expect(statusDuringExecution).toBe("running");
  });

  it("runTaskCycle writes acked, started, and succeeded events to the ledger", async () => {
    const llm = createMockLLMClient([VALID_TASK_RESPONSE, LLM_REVIEW_PASS]);
    const lifecycle = createLifecycle(llm, { approvalFn: async () => true });
    const adapter: import("../task/task-lifecycle.js").IAdapter = {
      adapterType: "mock",
      async execute() {
        return {
          success: true,
          output: "implemented",
          error: null,
          exit_code: 0,
          elapsed_ms: 25,
          stopped_reason: "completed" as const,
        };
      },
    };

    const result = await lifecycle.runTaskCycle(
      "goal-1",
      makeGapVector("goal-1", "dim"),
      makeDriveContext("dim"),
      adapter
    );

    const ledger = await stateManager.readRaw(`tasks/goal-1/ledger/${result.task.id}.json`) as Record<string, unknown>;
    const events = ledger.events as Array<Record<string, unknown>>;
    const summary = ledger.summary as Record<string, unknown>;

    expect(events.map((event) => event.type)).toEqual(["acked", "started", "succeeded"]);
    expect(summary.latest_event_type).toBe("succeeded");
    expect(summary.tokens_used).toBeGreaterThan(0);
    expect((summary.latencies as Record<string, unknown>).created_to_acked_ms).not.toBeNull();
  });

  it("runTaskCycle does not leave execution-success verification failures as completed", async () => {
    const llm = createMockLLMClient([VALID_TASK_RESPONSE, LLM_REVIEW_FAIL]);
    const lifecycle = createLifecycle(llm, { approvalFn: async () => true });
    const adapter: import("../task/task-lifecycle.js").IAdapter = {
      adapterType: "mock",
      async execute() {
        return {
          success: true,
          output: "implemented",
          error: null,
          exit_code: 0,
          elapsed_ms: 25,
          stopped_reason: "completed" as const,
        };
      },
    };

    const result = await lifecycle.runTaskCycle(
      "goal-1",
      makeGapVector("goal-1", "dim"),
      makeDriveContext("dim"),
      adapter
    );

    const storedTask = await stateManager.readRaw(`tasks/goal-1/${result.task.id}.json`) as Record<string, unknown>;
    const history = await stateManager.readRaw("tasks/goal-1/task-history.json") as Array<Record<string, unknown>>;
    const ledger = await stateManager.readRaw(`tasks/goal-1/ledger/${result.task.id}.json`) as Record<string, unknown>;
    const summary = ledger.summary as Record<string, unknown>;

    expect(result.action).toBe("escalate");
    expect(result.verificationResult.verdict).toBe("fail");
    expect(storedTask.status).toBe("error");
    expect(storedTask.verification_verdict).toBe("fail");
    expect(history[0]!.status).toBe("error");
    expect(history[0]!.verification_verdict).toBe("fail");
    expect(summary.task_status).toBe("error");
    expect(summary.verification_verdict).toBe("fail");
    expect(summary.latest_event_type).toBe("abandoned");
    expect(summary.action).toBe("escalate");
  });

  it("runTaskCycle preserves native timeout stop reason through final ledger outcome", async () => {
    const llm = createMockLLMClient([VALID_TASK_RESPONSE, LLM_REVIEW_FAIL]);
    const lifecycle = createLifecycle(llm, {
      approvalFn: async () => true,
      agentLoopRunner: makeNativeTimeoutRunner(),
    });
    const adapter: import("../task/task-lifecycle.js").IAdapter = {
      adapterType: "mock",
      async execute() {
        throw new Error("native path should not call adapter.execute");
      },
    };

    const result = await lifecycle.runTaskCycle(
      "goal-1",
      makeGapVector("goal-1", "dim"),
      makeDriveContext("dim"),
      adapter
    );

    const ledger = await stateManager.readRaw(`tasks/goal-1/ledger/${result.task.id}.json`) as {
      events: Array<{ type: string; stopped_reason: string | null }>;
      summary: { latest_event_type: string | null; task_status: string; stopped_reason: string | null; action?: string };
    };

    expect(result.action).toBe("escalate");
    expect(result.task.status).toBe("timed_out");
    expect(ledger.events.map((event) => [event.type, event.stopped_reason])).toEqual([
      ["acked", null],
      ["started", null],
      ["failed", "timeout"],
      ["failed", "timeout"],
      ["abandoned", "timeout"],
    ]);
    expect(ledger.summary).toMatchObject({
      latest_event_type: "abandoned",
      task_status: "timed_out",
      stopped_reason: "timeout",
      action: "escalate",
    });

    const aggregate = await summarizeTaskOutcomeLedgers(tmpDir);
    expect(aggregate.failure_stopped_reasons).toEqual({
      timeout: 1,
      policy_blocked: 0,
      cancelled: 0,
      error: 0,
      unknown: 0,
      other: 0,
    });
  });

  it("runTaskCycle returns and persists guarded fail verdict for dirty isolated worktree handoff", async () => {
    const llm = createMockLLMClient([VALID_TASK_RESPONSE, LLM_REVIEW_PASS]);
    const lifecycle = createLifecycle(llm, {
      approvalFn: async () => true,
      agentLoopRunner: makeNativeDirtyHandoffRunner(),
      execFileSyncFn: () => "",
    });
    const adapter: import("../task/task-lifecycle.js").IAdapter = {
      adapterType: "mock",
      async execute() {
        throw new Error("native path should not call adapter.execute");
      },
    };

    const result = await lifecycle.runTaskCycle(
      "goal-1",
      makeGapVector("goal-1", "dim"),
      makeDriveContext("dim"),
      adapter
    );

    const ledger = await stateManager.readRaw(`tasks/goal-1/ledger/${result.task.id}.json`) as {
      summary: Record<string, unknown>;
      events: Array<Record<string, unknown>>;
    };
    const verification = await stateManager.readRaw(`verification/${result.task.id}/verification-result.json`) as Record<string, unknown>;

    expect(result.action).toBe("escalate");
    expect(result.verificationResult.verdict).toBe("fail");
    expect(result.verificationResult.evidence[0]!.description).toContain("dirty isolated worktree retained");
    expect(ledger.summary).toMatchObject({
      latest_event_type: "abandoned",
      task_status: "error",
      verification_verdict: "fail",
      action: "escalate",
    });
    expect(ledger.events.at(-1)!.reason).toContain("/worktrees/task-1");
    expect(verification.verdict).toBe("fail");
    expect(verification.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({
        layer: "mechanical",
        description: expect.stringContaining("dirty isolated worktree retained"),
      }),
    ]));
    expect(verification.agent_loop).toMatchObject({
      isolatedWorkspace: true,
      workspaceDisposition: "handoff_required",
    });
  });

  it("preserves native blocked task results through task status and ledger stop reason", async () => {
    const llm = createMockLLMClient([VALID_TASK_RESPONSE, LLM_REVIEW_FAIL]);
    const lifecycle = createLifecycle(llm, {
      approvalFn: async () => true,
      agentLoopRunner: makeNativeBlockedRunner(),
    });
    const adapter: import("../task/task-lifecycle.js").IAdapter = {
      adapterType: "mock",
      async execute() {
        throw new Error("native path should not call adapter.execute");
      },
    };

    const result = await lifecycle.runTaskCycle(
      "goal-1",
      makeGapVector("goal-1", "dim"),
      makeDriveContext("dim"),
      adapter
    );

    const ledger = await stateManager.readRaw(`tasks/goal-1/ledger/${result.task.id}.json`) as {
      events: Array<{ type: string; stopped_reason: string | null }>;
      summary: { task_status: string; stopped_reason: string | null };
    };

    expect(result.task.status).toBe("blocked");
    expect(result.task.execution_output).toContain("Kaggle API token is unavailable");
    expect(ledger.events.map((event) => [event.type, event.stopped_reason])).toContainEqual(["failed", "blocked"]);
    expect(ledger.summary).toMatchObject({
      task_status: "blocked",
      stopped_reason: "blocked",
    });
  });

  it("handleFailure records failed and retried events for retryable failures", async () => {
    const llm = createMockLLMClient([]);
    const lifecycle = createLifecycle(llm);
    const task = makeTask({
      started_at: new Date(Date.now() - 1000).toISOString(),
      completed_at: new Date().toISOString(),
    });
    const vr: import("../../../base/types/task.js").VerificationResult = {
      task_id: task.id,
      verdict: "partial",
      confidence: 0.7,
      evidence: [
        { layer: "independent_review", description: "Direction correct", confidence: 0.7 },
        { layer: "self_report", description: "Partial progress", confidence: 0.3 },
      ],
      dimension_updates: [],
      timestamp: new Date().toISOString(),
    };

    await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
    await lifecycle.handleFailure(task, vr);

    const ledger = await stateManager.readRaw(`tasks/${task.goal_id}/ledger/${task.id}.json`) as Record<string, unknown>;
    const events = ledger.events as Array<Record<string, unknown>>;

    expect(events.map((event) => event.type)).toEqual(["failed", "retried"]);
    expect(events[1]!.action).toBe("keep");
  });

  it("handleVerdict records partial keep outcomes as retried and persists the verdict", async () => {
    const llm = createMockLLMClient([]);
    const lifecycle = createLifecycle(llm);
    const task = makeTask({
      started_at: new Date(Date.now() - 1000).toISOString(),
      completed_at: new Date().toISOString(),
      status: "completed",
    });
    const vr: import("../../../base/types/task.js").VerificationResult = {
      task_id: task.id,
      verdict: "partial",
      confidence: 0.7,
      evidence: [
        { layer: "independent_review", description: "Direction correct", confidence: 0.7 },
        { layer: "self_report", description: "Partial progress", confidence: 0.3 },
      ],
      dimension_updates: [],
      timestamp: new Date().toISOString(),
    };

    await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
    const result = await lifecycle.handleVerdict(task, vr);

    const storedTask = await stateManager.readRaw(`tasks/${task.goal_id}/${task.id}.json`) as Record<string, unknown>;
    const ledger = await stateManager.readRaw(`tasks/${task.goal_id}/ledger/${task.id}.json`) as Record<string, unknown>;
    const events = ledger.events as Array<Record<string, unknown>>;
    const summary = ledger.summary as Record<string, unknown>;
    const history = await stateManager.readRaw(`tasks/${task.goal_id}/task-history.json`) as Array<Record<string, unknown>>;

    expect(result.action).toBe("keep");
    expect(storedTask.status).toBe("error");
    expect(storedTask.verification_verdict).toBe("partial");
    expect(history[0]!.status).toBe("error");
    expect(events.map((event) => event.type)).toEqual(["retried"]);
    expect(events[0]!.action).toBe("keep");
    expect(summary.latest_event_type).toBe("retried");
    expect(summary.action).toBe("keep");
    expect(summary.task_status).toBe("error");
    expect(summary.verification_verdict).toBe("partial");
  });

  it("handleFailure records discard outcomes without preserving completed status", async () => {
    const repoDir = initRevertRepo("persistence-revert-success");
    const llm = createMockLLMClient([]);
    const lifecycle = createLifecycle(llm, { revertCwd: repoDir });
    const task = makeTask({
      status: "completed",
      started_at: new Date(Date.now() - 1000).toISOString(),
      completed_at: new Date().toISOString(),
      reversibility: "reversible",
    });
    const vr = makeVerificationResult({
      task_id: task.id,
      file_diffs: [{ path: "tracked.txt", patch: "diff --git a/tracked.txt b/tracked.txt" }],
    });

    await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
    const result = await lifecycle.handleFailure(task, vr);

    const storedTask = await stateManager.readRaw(`tasks/${task.goal_id}/${task.id}.json`) as Record<string, unknown>;
    const history = await stateManager.readRaw(`tasks/${task.goal_id}/task-history.json`) as Array<Record<string, unknown>>;
    const ledger = await stateManager.readRaw(`tasks/${task.goal_id}/ledger/${task.id}.json`) as Record<string, unknown>;
    const summary = ledger.summary as Record<string, unknown>;

    expect(result.action).toBe("discard");
    expect(fs.readFileSync(path.join(repoDir, "tracked.txt"), "utf-8")).toBe("original\n");
    expect(storedTask.status).toBe("error");
    expect(history[0]!.status).toBe("error");
    expect(summary.task_status).toBe("error");
    expect(summary.latest_event_type).toBe("abandoned");
    expect(summary.action).toBe("discard");
  });

  it("handleFailure records escalate outcomes without preserving completed status", async () => {
    const llm = createMockLLMClient([]);
    const lifecycle = createLifecycle(llm);
    const task = makeTask({
      status: "completed",
      started_at: new Date(Date.now() - 1000).toISOString(),
      completed_at: new Date().toISOString(),
      reversibility: "irreversible",
    });
    const vr = makeVerificationResult({ task_id: task.id });

    await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);
    const result = await lifecycle.handleFailure(task, vr);

    const storedTask = await stateManager.readRaw(`tasks/${task.goal_id}/${task.id}.json`) as Record<string, unknown>;
    const history = await stateManager.readRaw(`tasks/${task.goal_id}/task-history.json`) as Array<Record<string, unknown>>;
    const ledger = await stateManager.readRaw(`tasks/${task.goal_id}/ledger/${task.id}.json`) as Record<string, unknown>;
    const summary = ledger.summary as Record<string, unknown>;

    expect(result.action).toBe("escalate");
    expect(storedTask.status).toBe("error");
    expect(history[0]!.status).toBe("error");
    expect(summary.task_status).toBe("error");
    expect(summary.latest_event_type).toBe("abandoned");
    expect(summary.action).toBe("escalate");
  });

  it("runTaskCycle records abandoned events when pre-execution checks reject the task", async () => {
    const llm = createMockLLMClient([VALID_TASK_RESPONSE]);
    const lifecycle = createLifecycle(llm, {
      ethicsGate: {
        checkMeans: async () => ({ verdict: "reject", reasoning: "unsafe path" }),
      } as unknown as import("../../../platform/traits/ethics-gate.js").EthicsGate,
      approvalFn: async () => true,
    });

    const result = await lifecycle.runTaskCycle(
      "goal-1",
      makeGapVector("goal-1", "dim"),
      makeDriveContext("dim"),
      {
        adapterType: "mock",
        async execute() {
          throw new Error("should not run");
        },
      }
    );

    const ledger = await stateManager.readRaw(`tasks/goal-1/ledger/${result.task.id}.json`) as Record<string, unknown>;
    const events = ledger.events as Array<Record<string, unknown>>;

    expect(result.action).toBe("discard");
    expect(events.map((event) => event.type)).toEqual(["abandoned"]);
    expect(events[0]!.action).toBe("discard");
  });
});
