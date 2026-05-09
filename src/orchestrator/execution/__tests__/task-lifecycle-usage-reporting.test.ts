import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { StateManager } from "../../../base/state/state-manager.js";
import { SessionManager } from "../session-manager.js";
import { TrustManager } from "../../../platform/traits/trust-manager.js";
import { StrategyManager } from "../../strategy/strategy-manager.js";
import { StallDetector } from "../../../platform/drive/stall-detector.js";
import { TaskLifecycle } from "../task/task-lifecycle.js";
import { cmdUsage } from "../../../interface/cli/commands/usage.js";
import type { IPromptGateway, PromptGatewayExecutionResult, PromptGatewayInput } from "../../../prompt/gateway.js";
import type { ILLMClient } from "../../../base/llm/llm-client.js";
import type { IAdapter } from "../adapter-layer.js";
import type { TaskAgentLoopRunner } from "../agent-loop/task-agent-loop-runner.js";
import type { AdapterRegistry } from "../task/task-lifecycle.js";
import { makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { makeGoal } from "../../../../tests/helpers/fixtures.js";

function makeGateway(): IPromptGateway {
  let callIndex = 0;
  return {
    async execute<T>(_input: PromptGatewayInput<T>): Promise<T> {
      throw new Error("execute() should not be used in this test");
    },
    async executeWithUsage<T>(_input: PromptGatewayInput<T>): Promise<PromptGatewayExecutionResult<T>> {
      callIndex += 1;
      if (callIndex === 1) {
        return {
          data: {
            work_description: "Write regression coverage for usage reporting",
            rationale: "Need a durable telemetry signal",
            approach: "Add a focused end-to-end test",
            success_criteria: [
              {
                description: "usage totals are reported",
                verification_method: "review",
                is_blocking: true,
              },
            ],
            scope_boundary: {
              in_scope: ["tests"],
              out_of_scope: ["runtime redesign"],
              blast_radius: "low",
            },
            constraints: [],
            reversibility: "reversible",
            estimated_duration: null,
          } as T,
          usage: { inputTokens: 30, outputTokens: 5, totalTokens: 35 },
          contextTokens: 0,
        };
      }

      return {
        data: {
          verdict: "pass",
          reasoning: "usage was persisted and reported",
          criteria_met: 1,
          criteria_total: 1,
        } as T,
        usage: { inputTokens: 40, outputTokens: 2, totalTokens: 42 },
        contextTokens: 0,
      };
    },
  };
}

function makeNoopLLMClient(): ILLMClient {
  return {
    async sendMessage() {
      throw new Error("llmClient should not be used when gateway is configured");
    },
    parseJSON() {
      throw new Error("llmClient should not be used when gateway is configured");
    },
  } as unknown as ILLMClient;
}

function makeLifecycle(
  tmpDir: string,
  options?: {
    gateway?: IPromptGateway;
    agentLoopRunner?: TaskAgentLoopRunner;
    adapterRegistry?: AdapterRegistry;
  },
): {
  stateManager: StateManager;
  lifecycle: TaskLifecycle;
} {
  const stateManager = new StateManager(tmpDir);
  const llmClient = makeNoopLLMClient();
  const sessionManager = new SessionManager(stateManager);
  const trustManager = new TrustManager(stateManager);
  const strategyManager = new StrategyManager(stateManager, llmClient);
  const stallDetector = new StallDetector(stateManager);
  const lifecycle = new TaskLifecycle(
    stateManager,
    llmClient,
    sessionManager,
    trustManager,
    strategyManager,
    stallDetector,
    {
      approvalFn: async () => true,
      gateway: options?.gateway,
      agentLoopRunner: options?.agentLoopRunner,
      adapterRegistry: options?.adapterRegistry,
      healthCheckEnabled: false,
    }
  );
  return { stateManager, lifecycle };
}

async function readSingleLedger(
  stateManager: StateManager,
  goalId: string,
): Promise<{ summary: { tokens_used: number; latest_event_type?: string | null } }> {
  const [task] = await stateManager.listTasks(goalId);
  expect(task).toBeDefined();
  const ledger = await stateManager.readRaw(`tasks/${goalId}/ledger/${task!.id}.json`);
  expect(ledger).toBeTruthy();
  return ledger as { summary: { tokens_used: number; latest_event_type?: string | null } };
}

describe("TaskLifecycle usage reporting", () => {
  it("threads gateway generation and verifier usage into ledger summaries and CLI reporting", async () => {
    const tmpDir = makeTempDir("pulseed-task-lifecycle-usage-");
    const { stateManager, lifecycle } = makeLifecycle(tmpDir, { gateway: makeGateway() });
    await stateManager.init();
    await stateManager.saveGoal(makeGoal({ id: "goal-usage", title: "Close usage telemetry gaps" }));
    const adapter: IAdapter = {
      adapterType: "mock",
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: "Implemented telemetry reporting",
        error: null,
        exit_code: 0,
        elapsed_ms: 25,
        stopped_reason: "completed",
      }),
    };
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const result = await lifecycle.runTaskCycle(
        "goal-usage",
        {
          goal_id: "goal-usage",
          gaps: [{
            dimension_name: "coverage",
            raw_gap: 0.6,
            normalized_gap: 0.6,
            normalized_weighted_gap: 0.6,
            confidence: 0.8,
            uncertainty_weight: 1,
          }],
          timestamp: new Date().toISOString(),
        },
        {
          time_since_last_attempt: { coverage: 24 },
          deadlines: { coverage: null },
          opportunities: {},
          pacing: {},
        },
        adapter,
      );

      expect(result.action).toBe("completed");
      expect(result.tokensUsed).toBe(77);
      expect(adapter.execute).toHaveBeenCalledTimes(1);

      const ledgerRecord = await readSingleLedger(stateManager, "goal-usage");
      expect(ledgerRecord.summary.tokens_used).toBe(77);

      await expect(cmdUsage(stateManager, ["goal", "goal-usage"])).resolves.toBe(0);
      const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(output).toContain("Usage summary (goal scope)");
      expect(output).toContain("Goal: goal-usage");
      expect(output).toContain("Total tokens: 77");
    } finally {
      logSpy.mockRestore();
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it("includes native agent loop execution usage in task cycle totals", async () => {
    const tmpDir = makeTempDir("pulseed-task-lifecycle-agentloop-usage-");
    const agentLoopRunner = {
      runTask: vi.fn(async () => ({
        success: true,
        output: {
          status: "done" as const,
          finalAnswer: "Implemented with native loop",
          summary: "done",
          filesChanged: ["src/example.ts"],
          testsRun: [],
          completionEvidence: ["implemented"],
          verificationHints: [],
          blockers: [],
        },
        finalText: "Implemented with native loop",
        stopReason: "completed" as const,
        elapsedMs: 123,
        modelTurns: 2,
        toolCalls: 3,
        usage: { inputTokens: 7, outputTokens: 4, totalTokens: 11 },
        compactions: 0,
        changedFiles: ["src/example.ts"],
        commandResults: [],
        traceId: "trace-usage",
        sessionId: "session-usage",
        turnId: "turn-usage",
      })),
    } as unknown as TaskAgentLoopRunner;
    const { stateManager, lifecycle } = makeLifecycle(tmpDir, {
      gateway: makeGateway(),
      agentLoopRunner,
    });
    await stateManager.init();
    await stateManager.saveGoal(makeGoal({ id: "goal-native-usage", title: "Track native usage" }));

    const adapter: IAdapter = {
      adapterType: "mock",
      execute: vi.fn(async () => {
        throw new Error("adapter execute should not be called when native loop is enabled");
      }),
    };

    try {
      const result = await lifecycle.runTaskCycle(
        "goal-native-usage",
        {
          goal_id: "goal-native-usage",
          gaps: [{
            dimension_name: "coverage",
            raw_gap: 0.6,
            normalized_gap: 0.6,
            normalized_weighted_gap: 0.6,
            confidence: 0.8,
            uncertainty_weight: 1,
          }],
          timestamp: new Date().toISOString(),
        },
        {
          time_since_last_attempt: { coverage: 24 },
          deadlines: { coverage: null },
          opportunities: {},
          pacing: {},
        },
        adapter,
      );

      expect(result.action).toBe("completed");
      expect(result.tokensUsed).toBe(88);

      const ledgerRecord = await readSingleLedger(stateManager, "goal-native-usage");
      expect(ledgerRecord.summary.tokens_used).toBe(88);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it("preserves generation tokens when duplicate-pruned task creation returns null", async () => {
    const tmpDir = makeTempDir("pulseed-task-lifecycle-duplicate-usage-");
    const { stateManager, lifecycle } = makeLifecycle(tmpDir, {
      adapterRegistry: {
        isAvailable: () => false,
      } as unknown as AdapterRegistry,
    });
    await stateManager.init();
    await stateManager.saveGoal(makeGoal({ id: "goal-duplicate-usage", title: "Keep generation usage" }));
    const adapter: IAdapter = {
      adapterType: "mock",
      execute: vi.fn(async () => ({
        success: true,
        output: "should not execute",
        error: null,
        exit_code: 0,
        elapsed_ms: 1,
        stopped_reason: "completed" as const,
      })),
    };
    vi.spyOn(
      lifecycle as unknown as {
        _generateTaskWithTokens: typeof lifecycle["_generateTaskWithTokens"];
      },
      "_generateTaskWithTokens"
    ).mockResolvedValue({ task: null, tokensUsed: 35, playbookIdsUsed: [] });

    try {
      const result = await lifecycle.runTaskCycle(
        "goal-duplicate-usage",
        {
          goal_id: "goal-duplicate-usage",
          gaps: [{
            dimension_name: "coverage",
            raw_gap: 0.6,
            normalized_gap: 0.6,
            normalized_weighted_gap: 0.6,
            confidence: 0.8,
            uncertainty_weight: 1,
          }],
          timestamp: new Date().toISOString(),
        },
        {
          time_since_last_attempt: { coverage: 24 },
          deadlines: { coverage: null },
          opportunities: {},
          pacing: {},
        },
        adapter,
      );

      expect(result.action).toBe("discard");
      expect(result.task.id).toBe("skipped");
      expect(result.tokensUsed).toBe(35);
      expect(adapter.execute).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it("persists generation tokens when pre-execution checks block the task", async () => {
    const tmpDir = makeTempDir("pulseed-task-lifecycle-precheck-usage-");
    const { stateManager, lifecycle } = makeLifecycle(tmpDir);
    await stateManager.init();
    await stateManager.saveGoal(makeGoal({ id: "goal-precheck-usage", title: "Keep precheck usage" }));
    const adapter: IAdapter = {
      adapterType: "mock",
      execute: vi.fn(async () => ({
        success: true,
        output: "should not execute",
        error: null,
        exit_code: 0,
        elapsed_ms: 1,
        stopped_reason: "completed" as const,
      })),
    };
    vi.spyOn(
      lifecycle as unknown as {
        _generateTaskWithTokens: typeof lifecycle["_generateTaskWithTokens"];
      },
      "_generateTaskWithTokens"
    ).mockResolvedValue({
      task: {
        id: "task-precheck-usage",
        goal_id: "goal-precheck-usage",
        strategy_id: null,
        target_dimensions: ["coverage"],
        primary_dimension: "coverage",
        work_description: "blocked before execution",
        rationale: "test",
        approach: "test",
        success_criteria: [{
          description: "n/a",
          verification_method: "review",
          is_blocking: true,
        }],
        scope_boundary: {
          in_scope: ["tests"],
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
        created_at: new Date().toISOString(),
      },
      tokensUsed: 35,
      playbookIdsUsed: [],
    });
    vi.spyOn(
      lifecycle as unknown as {
        checkIrreversibleApproval: typeof lifecycle["checkIrreversibleApproval"];
      },
      "checkIrreversibleApproval"
    ).mockResolvedValue(false);

    try {
      const result = await lifecycle.runTaskCycle(
        "goal-precheck-usage",
        {
          goal_id: "goal-precheck-usage",
          gaps: [{
            dimension_name: "coverage",
            raw_gap: 0.6,
            normalized_gap: 0.6,
            normalized_weighted_gap: 0.6,
            confidence: 0.8,
            uncertainty_weight: 1,
          }],
          timestamp: new Date().toISOString(),
        },
        {
          time_since_last_attempt: { coverage: 24 },
          deadlines: { coverage: null },
          opportunities: {},
          pacing: {},
        },
        adapter,
      );

      expect(result.action).toBe("approval_denied");
      expect(result.tokensUsed).toBe(35);
      expect(adapter.execute).not.toHaveBeenCalled();
      expect(result.verificationResult.evidence[0]?.description).toContain("Approval denied");

      const ledgerRecord = await stateManager.readRaw(
        "tasks/goal-precheck-usage/ledger/task-precheck-usage.json"
      ) as { summary: { tokens_used: number; latest_event_type: string | null } };
      expect(ledgerRecord.summary.latest_event_type).toBe("abandoned");
      expect(ledgerRecord.summary.tokens_used).toBe(35);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it("persists generation tokens when adapter circuit breaker blocks execution", async () => {
    const tmpDir = makeTempDir("pulseed-task-lifecycle-circuit-usage-");
    const { stateManager, lifecycle } = makeLifecycle(tmpDir);
    await stateManager.init();
    await stateManager.saveGoal(makeGoal({ id: "goal-circuit-usage", title: "Keep circuit-breaker usage" }));
    const adapter: IAdapter = {
      adapterType: "mock",
      execute: vi.fn(async () => ({
        success: true,
        output: "should not execute",
        error: null,
        exit_code: 0,
        elapsed_ms: 1,
        stopped_reason: "completed" as const,
      })),
    };
    vi.spyOn(
      lifecycle as unknown as {
        _generateTaskWithTokens: typeof lifecycle["_generateTaskWithTokens"];
      },
      "_generateTaskWithTokens"
    ).mockResolvedValue({
      task: {
        id: "task-circuit-usage",
        goal_id: "goal-circuit-usage",
        strategy_id: null,
        target_dimensions: ["coverage"],
        primary_dimension: "coverage",
        work_description: "blocked by circuit breaker",
        rationale: "test",
        approach: "test",
        success_criteria: [{
          description: "n/a",
          verification_method: "review",
          is_blocking: true,
        }],
        scope_boundary: {
          in_scope: ["tests"],
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
        created_at: new Date().toISOString(),
      },
      tokensUsed: 35,
      playbookIdsUsed: [],
    });
    const adapterRegistry = {
      isAvailable: vi.fn().mockReturnValue(false),
    };
    (lifecycle as unknown as { adapterRegistry: AdapterRegistry }).adapterRegistry = adapterRegistry as unknown as AdapterRegistry;
    try {
      const result = await lifecycle.runTaskCycle(
        "goal-circuit-usage",
        {
          goal_id: "goal-circuit-usage",
          gaps: [{
            dimension_name: "coverage",
            raw_gap: 0.6,
            normalized_gap: 0.6,
            normalized_weighted_gap: 0.6,
            confidence: 0.8,
            uncertainty_weight: 1,
          }],
          timestamp: new Date().toISOString(),
        },
        {
          time_since_last_attempt: { coverage: 24 },
          deadlines: { coverage: null },
          opportunities: {},
          pacing: {},
        },
        adapter,
      );

      expect(result.tokensUsed).toBe(35);
      expect(adapter.execute).not.toHaveBeenCalled();
      expect(adapterRegistry.isAvailable).toHaveBeenCalledWith("mock");
      expect(result.verificationResult.evidence[0]?.description).toContain("Adapter circuit breaker is open");

      const ledgerRecord = await stateManager.readRaw(
        "tasks/goal-circuit-usage/ledger/task-circuit-usage.json"
      ) as { summary: { tokens_used: number; latest_event_type: string | null } };
      expect(ledgerRecord.summary.latest_event_type).toBe("failed");
      expect(ledgerRecord.summary.tokens_used).toBe(35);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });
});
