/**
 * core-loop-phases-b-verify.test.ts
 *
 * Tests for Phase 7 verifyWithTools() integration in runTaskCycleWithContext().
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PhaseCtx } from "../core-loop-phases.js";
import type { Goal } from "../../../base/types/goal.js";
import type { Criterion } from "../../execution/types/task.js";

// ─── Helpers ───

function makeGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "goal-verify-1",
    title: "Verify Test Goal",
    description: "Test goal for Phase 7 verification",
    dimensions: [
      {
        name: "coverage",
        label: "Coverage",
        threshold: { type: "min" as const, value: 80 },
        current_value: 50,
        confidence: 0.7,
        weight: 1.0,
        last_updated: new Date().toISOString(),
        observation_method: {
          type: "llm_review" as const,
          source: "test",
          schedule: null,
          endpoint: null,
          confidence_tier: "independent_review" as const,
        },
        history: [],
        uncertainty_weight: null,
        state_integrity: "ok" as const,
        dimension_mapping: null,
      },
    ],
    gap_aggregation: "max",
    uncertainty_weight: 1.0,
    status: "active",
    origin: "manual",
    children_ids: [],
    deadline: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
    parent_id: overrides.parent_id ?? null,
    node_type: overrides.node_type ?? "goal",
    dimension_mapping: overrides.dimension_mapping ?? null,
  } as Goal;
}

function makeCriteria(overrides: Partial<Criterion> = {}): Criterion[] {
  return [
    {
      description: "Build passes",
      verification_method: "run npm run build",
      is_blocking: true,
      ...overrides,
    },
  ];
}

function makeTask(criteria: Criterion[] = makeCriteria()) {
  return {
    id: "task-verify-1",
    goal_id: "goal-verify-1",
    strategy_id: null,
    target_dimensions: ["coverage"],
    primary_dimension: "coverage",
    work_description: "Improve test coverage",
    rationale: "Tests are needed",
    approach: "Add unit tests",
    success_criteria: criteria,
    scope_boundary: { in_scope: [], out_of_scope: [], blast_radius: "" },
    constraints: [],
    plateau_until: null,
    estimated_duration: null,
    consecutive_failure_count: 0,
    reversibility: "unknown" as const,
    status: "completed" as const,
    started_at: null,
    completed_at: null,
    timeout_at: null,
    heartbeat_at: null,
    created_at: new Date().toISOString(),
    task_category: "normal" as const,
  };
}

function makeVerificationResult(verdict: "pass" | "fail" = "pass") {
  return {
    task_id: "task-verify-1",
    verdict,
    confidence: 0.8,
    evidence: [],
    dimension_updates: [],
    timestamp: new Date().toISOString(),
  };
}

function makeTaskCycleResult(criteria: Criterion[] = makeCriteria()) {
  return {
    task: makeTask(criteria),
    verificationResult: makeVerificationResult(),
    action: "completed" as const,
  };
}

function makeToolResult(success: boolean, error?: string) {
  return { success, data: null, summary: success ? "ok" : "failed", error, durationMs: 5 };
}

function makeToolExecutor(resultOverride?: { success: boolean; error?: string }) {
  const result = resultOverride ?? { success: true };
  return {
    execute: vi.fn().mockResolvedValue(makeToolResult(result.success, result.error)),
  } as unknown as PhaseCtx["toolExecutor"];
}

function makeStateManager(goal: Goal | null = null) {
  return {
    loadGoal: vi.fn().mockResolvedValue(goal),
    saveGoal: vi.fn().mockResolvedValue(undefined),
    appendGapHistoryEntry: vi.fn().mockResolvedValue(undefined),
    loadGapHistory: vi.fn().mockResolvedValue([]),
    savePaceSnapshot: vi.fn().mockResolvedValue(undefined),
  };
}

function makeBasePhaseCtx(toolExecutor?: PhaseCtx["toolExecutor"]): PhaseCtx {
  const goal = makeGoal();
  const stateManager = makeStateManager(goal);

  return {
    deps: {
      stateManager,
      observationEngine: { observe: vi.fn().mockResolvedValue(undefined) },
      satisficingJudge: {
        isGoalComplete: vi.fn().mockReturnValue({
          is_complete: false,
          blocking_dimensions: [],
          low_confidence_dimensions: [],
          needs_verification_task: false,
          checked_at: new Date().toISOString(),
        }),
        judgeTreeCompletion: vi.fn(),
      },
      gapCalculator: {
        calculateGapVector: vi.fn().mockReturnValue([]),
        aggregateGaps: vi.fn().mockReturnValue(0.5),
      },
      driveScorer: {
        scoreAllDimensions: vi.fn().mockReturnValue([]),
        rankDimensions: vi.fn().mockReturnValue([]),
      },
      driveSystem: { computeReward: vi.fn().mockReturnValue({ score: 0, components: [] }) },
      reportingEngine: { generateExecutionSummary: vi.fn(), saveReport: vi.fn() },
      adapterRegistry: {
        getAdapter: vi.fn().mockReturnValue({
          adapterType: "test",
          execute: vi.fn().mockResolvedValue({ success: true, output: "done" }),
          listExistingTasks: vi.fn().mockResolvedValue([]),
        }),
      },
      taskLifecycle: {
        runTaskCycle: vi.fn(),
        setOnTaskComplete: vi.fn(),
      },
      stallDetector: {
        checkDimensionStall: vi.fn().mockReturnValue(null),
        checkGlobalStall: vi.fn().mockReturnValue(null),
        getEscalationLevel: vi.fn().mockResolvedValue(0),
        incrementEscalation: vi.fn().mockResolvedValue(undefined),
        analyzeStallCause: vi.fn().mockReturnValue(undefined),
      },
      strategyManager: {
        getActiveStrategy: vi.fn().mockResolvedValue(null),
        getPortfolio: vi.fn().mockResolvedValue(null),
        onStallDetected: vi.fn().mockResolvedValue(null),
        incrementPivotCount: vi.fn().mockResolvedValue(undefined),
      },
    } as unknown as PhaseCtx["deps"],
    config: {
      maxIterations: 5,
      adapterType: "test",
      maxConsecutiveErrors: 3,
      delayBetweenLoopsMs: 0,
      treeMode: false,
      multiGoalMode: false,
      goalIds: [],
      minIterations: 1,
      autoArchive: false,
      dryRun: false,
      maxConsecutiveSkips: 5,
      autoDecompose: false,
    } as unknown as PhaseCtx["config"],
    logger: undefined,
    toolExecutor,
  };
}

// ─── Mock verifyWithTools ───

vi.mock("../verification-layer1.js", () => ({
  verifyWithTools: vi.fn(),
}));

vi.mock("../core-loop-phases.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../core-loop-phases.js")>();
  return {
    ...actual,
    buildLoopToolContext: vi.fn().mockResolvedValue({
      cwd: "/tmp",
      goalId: "goal-verify-1",
      trustBalance: 0,
      preApproved: true,
      approvalFn: async () => false,
    }),
  };
});

import { runTaskCycleWithContext } from "../core-loop-phases-b.js";
import { verifyWithTools } from "../verification-layer1.js";
import { buildLoopToolContext } from "../core-loop-phases.js";
import { makeEmptyIterationResult } from "../core-loop-types.js";

// ─── Tests ───

describe("Phase 7: verifyWithTools integration in runTaskCycleWithContext", () => {
  const mockVerifyWithTools = vi.mocked(verifyWithTools);
  const mockBuildLoopToolContext = vi.mocked(buildLoopToolContext);

  const goalId = "goal-verify-1";
  const goal = makeGoal();

  const baseCallbacks = {
    handleCapabilityAcquisition: vi.fn().mockResolvedValue(undefined),
    incrementTransferCounter: vi.fn().mockReturnValue(1),
    tryGenerateReport: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("Test 1: calls verifyWithTools when toolExecutor is present and task has criteria", async () => {
    const criteria = makeCriteria();
    const taskCycleResult = makeTaskCycleResult(criteria);
    const toolExecutor = makeToolExecutor();
    const ctx = makeBasePhaseCtx(toolExecutor);

    (ctx.deps.taskLifecycle.runTaskCycle as ReturnType<typeof vi.fn>).mockResolvedValue(taskCycleResult);

    mockVerifyWithTools.mockResolvedValue({ mechanicalPassed: true, details: [] });

    const result = makeEmptyIterationResult(goalId, 0);
    const gapVector = [] as unknown as import("../../../base/types/gap.js").GapVector;
    const driveScores = [] as unknown as import("../../../base/types/drive.js").DriveScore[];

    await runTaskCycleWithContext(ctx, goalId, goal, gapVector, driveScores, [], 0, result, Date.now(), baseCallbacks);

    expect(mockVerifyWithTools).toHaveBeenCalledOnce();
    expect(mockVerifyWithTools).toHaveBeenCalledWith(
      criteria,
      toolExecutor,
      expect.objectContaining({ goalId })
    );
    expect(result.toolVerification).toEqual({ mechanicalPassed: true, details: [] });
  });

  it("Test 2: sets verificationResult verdict to fail when mechanicalPassed is false", async () => {
    const criteria = makeCriteria();
    const taskCycleResult = makeTaskCycleResult(criteria);
    const toolExecutor = makeToolExecutor();
    const ctx = makeBasePhaseCtx(toolExecutor);

    (ctx.deps.taskLifecycle.runTaskCycle as ReturnType<typeof vi.fn>).mockResolvedValue(taskCycleResult);

    const failDetail = {
      criterion: criteria[0],
      toolName: "shell",
      toolResult: makeToolResult(false, "exit code 1"),
      passed: false,
    };
    mockVerifyWithTools.mockResolvedValue({ mechanicalPassed: false, details: [failDetail] });

    const result = makeEmptyIterationResult(goalId, 0);
    const gapVector = [] as unknown as import("../../../base/types/gap.js").GapVector;
    const driveScores = [] as unknown as import("../../../base/types/drive.js").DriveScore[];

    await runTaskCycleWithContext(ctx, goalId, goal, gapVector, driveScores, [], 0, result, Date.now(), baseCallbacks);

    expect(result.toolVerification?.mechanicalPassed).toBe(false);
    expect(result.taskResult?.verificationResult.verdict).toBe("fail");
  });

  it("Test 3: skips verifyWithTools when toolExecutor is absent", async () => {
    const criteria = makeCriteria();
    const taskCycleResult = makeTaskCycleResult(criteria);
    const ctx = makeBasePhaseCtx(undefined); // no toolExecutor

    (ctx.deps.taskLifecycle.runTaskCycle as ReturnType<typeof vi.fn>).mockResolvedValue(taskCycleResult);

    const result = makeEmptyIterationResult(goalId, 0);
    const gapVector = [] as unknown as import("../../../base/types/gap.js").GapVector;
    const driveScores = [] as unknown as import("../../../base/types/drive.js").DriveScore[];

    await runTaskCycleWithContext(ctx, goalId, goal, gapVector, driveScores, [], 0, result, Date.now(), baseCallbacks);

    expect(mockVerifyWithTools).not.toHaveBeenCalled();
    expect(result.toolVerification).toBeUndefined();
  });

  it("Test 4: catches error from verifyWithTools without failing the loop (non-fatal)", async () => {
    const criteria = makeCriteria();
    const taskCycleResult = makeTaskCycleResult(criteria);
    const toolExecutor = makeToolExecutor();
    const ctx = makeBasePhaseCtx(toolExecutor);
    const warnSpy = vi.fn();
    ctx.logger = { warn: warnSpy, info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as typeof ctx.logger;

    (ctx.deps.taskLifecycle.runTaskCycle as ReturnType<typeof vi.fn>).mockResolvedValue(taskCycleResult);
    mockVerifyWithTools.mockRejectedValue(new Error("tool executor crashed"));

    const result = makeEmptyIterationResult(goalId, 0);
    const gapVector = [] as unknown as import("../../../base/types/gap.js").GapVector;
    const driveScores = [] as unknown as import("../../../base/types/drive.js").DriveScore[];

    // Should not throw
    const returned = await runTaskCycleWithContext(ctx, goalId, goal, gapVector, driveScores, [], 0, result, Date.now(), baseCallbacks);

    expect(returned).toBe(true); // loop continues
    expect(result.error).toBeNull(); // no fatal error
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Phase 7"),
      expect.objectContaining({ error: "tool executor crashed" })
    );
    expect(result.toolVerification).toBeUndefined();
  });
});
