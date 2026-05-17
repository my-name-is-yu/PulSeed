/**
 * core-loop-stall-refine.test.ts
 *
 * Tests for stall-handler integration with GoalRefiner. See
 * docs/design/execution/goal-orchestration.md for the current design map.
 *
 * Verifies:
 *   - Observation-failure stall (suggested_cause === "information_deficit")
 *     triggers reRefineLeaf() when goalRefiner is available.
 *   - Progress stall (other suggested_cause) does NOT trigger reRefineLeaf().
 *   - reRefineLeaf() failures are non-fatal (loop continues).
 *   - goalRefiner absent → no reRefineLeaf() call (backward compat).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  type CoreLoopDeps,
  type GapCalculatorModule,
  type DriveScorerModule,
  type ReportingEngine,
} from "../durable-loop.js";
import { detectStallsAndRebalance } from "../durable-loop/task-cycle.js";
import { StateManager } from "../../../base/state/state-manager.js";
import type { ObservationEngine } from "../../../platform/observation/observation-engine.js";
import type { TaskLifecycle } from "../../execution/task/task-lifecycle.js";
import type { SatisficingJudge } from "../../../platform/drive/satisficing-judge.js";
import type { StallDetector } from "../../../platform/drive/stall-detector.js";
import type { StrategyManager } from "../../strategy/strategy-manager.js";
import type { DriveSystem } from "../../../platform/drive/drive-system.js";
import type { AdapterRegistry } from "../../execution/adapter-layer.js";
import type { GoalRefiner } from "../../goal/goal-refiner.js";
import type { Goal } from "../../../base/types/goal.js";
import type { StallReport } from "../../../base/types/stall.js";
import type { ITimeHorizonEngine } from "../../../platform/time/time-horizon-engine.js";
import type { RuntimeEvidenceEntry } from "../../../runtime/store/evidence-ledger.js";
import type { LoopIterationResult } from "../durable-loop/contracts.js";
import type { PhaseCtx } from "../durable-loop/preparation.js";
import { makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { makeDimension, makeGoal } from "../../../../tests/helpers/fixtures.js";

// ─── Helpers ───

function makeStallReport(
  overrides: Partial<StallReport> = {}
): StallReport {
  return {
    stall_type: "dimension_stall",
    goal_id: "goal-1",
    dimension_name: "dim1",
    task_id: null,
    detected_at: new Date().toISOString(),
    escalation_level: 1,
    suggested_cause: "approach_failure", // default = progress stall
    decay_factor: 0.8,
    ...overrides,
  };
}

function makeIterationResult(): LoopIterationResult {
  return {
    loopIndex: 0,
    goalId: "goal-1",
    gapAggregate: 0.5,
    driveScores: [],
    taskResult: null,
    stallDetected: false,
    stallReport: null,
    pivotOccurred: false,
    completionJudgment: {
      is_complete: false,
      blocking_dimensions: ["dim1"],
      low_confidence_dimensions: [],
      needs_verification_task: false,
      checked_at: new Date().toISOString(),
    },
    elapsedMs: 0,
    error: null,
  };
}

function makeGapHistoryWithStall(dimensionName: string, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    iteration: i,
    timestamp: new Date().toISOString(),
    gap_vector: [
      {
        dimension_name: dimensionName,
        normalized_weighted_gap: 0.8,
      },
    ],
    confidence_vector: [
      {
        dimension_name: dimensionName,
        confidence: 0.5,
      },
    ],
  }));
}

function makeGapHistoryWithDimensions(dimensionNames: string[], count: number) {
  return Array.from({ length: count }, (_, i) => ({
    iteration: i,
    timestamp: new Date().toISOString(),
    gap_vector: dimensionNames.map((dimensionName) => ({
      dimension_name: dimensionName,
      normalized_weighted_gap: 0.8,
    })),
    confidence_vector: dimensionNames.map((dimensionName) => ({
      dimension_name: dimensionName,
      confidence: 0.5,
    })),
  }));
}

function makeMetricTrendEvidenceEntries(metricLabel: string): RuntimeEvidenceEntry[] {
  return [
    {
      schema_version: "runtime-evidence-entry-v1",
      id: `${metricLabel}-entry-a`,
      occurred_at: "2026-04-30T00:00:00.000Z",
      kind: "metric",
      scope: { goal_id: "goal-1" },
      metrics: [{ label: metricLabel, value: 0.5, direction: "maximize", confidence: 0.9 }],
      artifacts: [],
      raw_refs: [],
      outcome: "continued",
    },
    {
      schema_version: "runtime-evidence-entry-v1",
      id: `${metricLabel}-entry-b`,
      occurred_at: "2026-04-30T00:05:00.000Z",
      kind: "metric",
      scope: { goal_id: "goal-1" },
      metrics: [{ label: metricLabel, value: 0.7, direction: "maximize", confidence: 0.95 }],
      artifacts: [],
      raw_refs: [],
      outcome: "improved",
    },
  ];
}

function buildPhaseCtx(
  deps: CoreLoopDeps,
  config: { maxIterations: number; adapterType: string }
): PhaseCtx {
  return {
    deps,
    config: {
      maxIterations: config.maxIterations,
      maxConsecutiveErrors: 3,
      delayBetweenLoopsMs: 0,
      adapterType: config.adapterType,
      treeMode: false,
      multiGoalMode: false,
      goalIds: [],
      minIterations: 1,
      autoArchive: false,
      dryRun: false,
      maxConsecutiveSkips: 5,
      autoDecompose: true,
      autoConsolidateOnComplete: true,
      consolidationRawThreshold: 20,
    },
    logger: undefined,
  };
}

function createBaseDeps(tmpDir: string): CoreLoopDeps {
  const stateManager = new StateManager(tmpDir);

  const observationEngine = {
    observe: vi.fn(),
    applyObservation: vi.fn(),
    createObservationEntry: vi.fn(),
    getObservationLog: vi.fn(),
    saveObservationLog: vi.fn(),
    applyProgressCeiling: vi.fn(),
    getConfidenceTier: vi.fn(),
    resolveContradiction: vi.fn(),
    needsVerificationTask: vi.fn(),
  };

  const gapCalculator = {
    calculateGapVector: vi.fn(),
    aggregateGaps: vi.fn().mockReturnValue(0.5),
  };

  const driveScorer = {
    scoreAllDimensions: vi.fn().mockReturnValue([]),
    rankDimensions: vi.fn().mockReturnValue([]),
  };

  const taskLifecycle = {
    runTaskCycle: vi.fn(),
    selectTargetDimension: vi.fn(),
    generateTask: vi.fn(),
    checkIrreversibleApproval: vi.fn(),
    executeTask: vi.fn(),
    verifyTask: vi.fn(),
    handleVerdict: vi.fn(),
    handleFailure: vi.fn(),
  };

  const satisficingJudge = {
    isGoalComplete: vi.fn().mockReturnValue({
      is_complete: false,
      blocking_dimensions: ["dim1"],
      low_confidence_dimensions: [],
      needs_verification_task: false,
      checked_at: new Date().toISOString(),
    }),
    isDimensionSatisfied: vi.fn(),
    applyProgressCeiling: vi.fn(),
    selectDimensionsForIteration: vi.fn(),
    detectThresholdAdjustmentNeeded: vi.fn(),
    propagateSubgoalCompletion: vi.fn(),
  };

  const stallDetector = {
    checkDimensionStall: vi.fn().mockReturnValue(null),
    checkGlobalStall: vi.fn().mockReturnValue(null),
    checkTimeExceeded: vi.fn().mockReturnValue(null),
    checkConsecutiveFailures: vi.fn().mockReturnValue(null),
    getEscalationLevel: vi.fn().mockReturnValue(0),
    incrementEscalation: vi.fn().mockReturnValue(1),
    resetEscalation: vi.fn(),
    getStallState: vi.fn(),
    saveStallState: vi.fn(),
    classifyStallCause: vi.fn(),
    computeDecayFactor: vi.fn(),
    isSuppressed: vi.fn(),
  };

  const strategyManager = {
    onStallDetected: vi.fn().mockResolvedValue(null),
    getActiveStrategy: vi.fn().mockReturnValue(null),
    getPortfolio: vi.fn().mockResolvedValue(null),
    generateCandidates: vi.fn(),
    activateBestCandidate: vi.fn(),
    updateState: vi.fn(),
    getStrategyHistory: vi.fn(),
    incrementPivotCount: vi.fn().mockResolvedValue(undefined),
  };

  const reportingEngine = {
    generateExecutionSummary: vi.fn().mockReturnValue({ type: "execution_summary" }),
    saveReport: vi.fn(),
  };

  const driveSystem = {
    shouldActivate: vi.fn().mockReturnValue(true),
    processEvents: vi.fn().mockReturnValue([]),
    readEventQueue: vi.fn().mockReturnValue([]),
    archiveEvent: vi.fn(),
    getSchedule: vi.fn(),
    updateSchedule: vi.fn(),
    isScheduleDue: vi.fn(),
    createDefaultSchedule: vi.fn(),
    prioritizeGoals: vi.fn(),
  };

  const adapterRegistry = {
    getAdapter: vi.fn(),
    register: vi.fn(),
    listAdapters: vi.fn().mockReturnValue(["openai_codex_cli"]),
  };

  return {
    stateManager,
    observationEngine: observationEngine as unknown as ObservationEngine,
    gapCalculator: gapCalculator as unknown as GapCalculatorModule,
    driveScorer: driveScorer as unknown as DriveScorerModule,
    taskLifecycle: taskLifecycle as unknown as TaskLifecycle,
    satisficingJudge: satisficingJudge as unknown as SatisficingJudge,
    stallDetector: stallDetector as unknown as StallDetector,
    strategyManager: strategyManager as unknown as StrategyManager,
    reportingEngine: reportingEngine as unknown as ReportingEngine,
    driveSystem: driveSystem as unknown as DriveSystem,
    adapterRegistry: adapterRegistry as unknown as AdapterRegistry,
  };
}

// ─── Setup ───

let tmpDir: string;

beforeEach(() => {
  tmpDir = makeTempDir();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true , maxRetries: 3, retryDelay: 100 });
});

// ─── Tests ───

describe("detectStallsAndRebalance — reRefineLeaf on observation-failure stall", () => {
  it("uses the goal workspace_path for tool-based stall evidence", async () => {
    const deps = createBaseDeps(tmpDir);
    const workspacePath = path.join(tmpDir, "workspace");
    fs.mkdirSync(workspacePath, { recursive: true });
    const goal = makeGoal({
      id: "goal-1",
      constraints: [`workspace_path:${workspacePath}`],
    });
    await deps.stateManager.saveGoal(goal);
    await deps.stateManager.saveGapHistory("goal-1", []);

    const execute = vi.fn().mockResolvedValue({
      success: true,
      data: "",
      summary: "no changes",
      durationMs: 0,
    });
    const ctx = buildPhaseCtx(deps, { maxIterations: 10, adapterType: "openai_codex_cli" });
    ctx.toolExecutor = { execute } as never;
    const result = makeIterationResult();

    await detectStallsAndRebalance(ctx, "goal-1", goal, result);

    expect(execute).toHaveBeenCalledWith(
      "git-diff",
      { target: "unstaged", path: workspacePath },
      expect.objectContaining({ cwd: workspacePath, goalId: "goal-1" }),
    );
  });

  it("calls reRefineLeaf() when stall suggested_cause is information_deficit and goalRefiner is present", async () => {
    const deps = createBaseDeps(tmpDir);

    const mockRefiner = {
      refine: vi.fn(),
      reRefineLeaf: vi.fn().mockResolvedValue({ leaf: true }),
    } as unknown as GoalRefiner;

    deps.goalRefiner = mockRefiner;

    // Set up goal with a stalling dimension
    const goal = makeGoal({
      id: "goal-1",
      dimensions: [
        {
          name: "dim1",
          label: "Dim 1",
          current_value: 0.2,
          threshold: { type: "min", value: 1.0 },
          confidence: 0.5,
          observation_method: {
            type: "manual",
            source: "manual",
            schedule: null,
            endpoint: null,
            confidence_tier: "self_report",
          },
          last_updated: new Date().toISOString(),
          history: [],
          weight: 1.0,
          uncertainty_weight: null,
          state_integrity: "ok",
          dimension_mapping: null,
        },
      ],
    });
    await deps.stateManager.saveGoal(goal);

    // Seed enough gap history to trigger stall
    const gapHistory = makeGapHistoryWithStall("dim1", 5);
    await deps.stateManager.saveGapHistory("goal-1", gapHistory);

    // Make stallDetector fire an information_deficit stall
    const stallReport = makeStallReport({
      suggested_cause: "information_deficit",
      goal_id: "goal-1",
      dimension_name: "dim1",
    });
    (deps.stallDetector.checkDimensionStall as ReturnType<typeof vi.fn>).mockReturnValue(stallReport);

    const ctx = buildPhaseCtx(deps, { maxIterations: 10, adapterType: "openai_codex_cli" });
    const result = makeIterationResult();

    await detectStallsAndRebalance(ctx, "goal-1", goal, result);

    expect(result.stallDetected).toBe(true);
    expect(mockRefiner.reRefineLeaf).toHaveBeenCalledOnce();
    expect(mockRefiner.reRefineLeaf).toHaveBeenCalledWith("goal-1", "information_deficit");
  });

  it("does NOT call reRefineLeaf() for a progress stall (approach_failure)", async () => {
    const deps = createBaseDeps(tmpDir);

    const mockRefiner = {
      refine: vi.fn(),
      reRefineLeaf: vi.fn(),
    } as unknown as GoalRefiner;

    deps.goalRefiner = mockRefiner;

    const goal = makeGoal({ id: "goal-1" });
    await deps.stateManager.saveGoal(goal);

    const gapHistory = makeGapHistoryWithStall("dim1", 5);
    await deps.stateManager.saveGapHistory("goal-1", gapHistory);

    const stallReport = makeStallReport({
      suggested_cause: "approach_failure", // progress stall
      goal_id: "goal-1",
      dimension_name: "dim1",
    });
    (deps.stallDetector.checkDimensionStall as ReturnType<typeof vi.fn>).mockReturnValue(stallReport);

    const ctx = buildPhaseCtx(deps, { maxIterations: 10, adapterType: "openai_codex_cli" });
    const result = makeIterationResult();

    await detectStallsAndRebalance(ctx, "goal-1", goal, result);

    expect(result.stallDetected).toBe(true);
    expect(mockRefiner.reRefineLeaf).not.toHaveBeenCalled();
  });

  it("feeds runtime metric trend context into stall recovery", async () => {
    const deps = createBaseDeps(tmpDir);
    const goal = makeGoal({ id: "goal-1" });
    await deps.stateManager.saveGoal(goal);
    await deps.stateManager.saveGapHistory("goal-1", makeGapHistoryWithStall("dim1", 5));

    const metricEntries: RuntimeEvidenceEntry[] = [
      {
        schema_version: "runtime-evidence-entry-v1",
        id: "entry-a",
        occurred_at: "2026-04-30T00:00:00.000Z",
        kind: "metric",
        scope: { goal_id: "goal-1" },
        metrics: [{ label: "dim1", value: 0.5, direction: "maximize", confidence: 0.9 }],
        artifacts: [{ label: "metrics-a", state_relative_path: "runs/a/metrics.json", kind: "metrics" }],
        raw_refs: [],
        outcome: "continued",
        summary: "Initial metric.",
      },
      {
        schema_version: "runtime-evidence-entry-v1",
        id: "entry-b",
        occurred_at: "2026-04-30T00:05:00.000Z",
        kind: "metric",
        scope: { goal_id: "goal-1" },
        metrics: [{ label: "dim1", value: 0.7, direction: "maximize", confidence: 0.95 }],
        artifacts: [{ label: "metrics-b", state_relative_path: "runs/b/metrics.json", kind: "metrics" }],
        raw_refs: [],
        outcome: "improved",
        summary: "Breakthrough metric.",
      },
    ];
    deps.evidenceLedger = {
      append: vi.fn().mockResolvedValue([]),
      readByGoal: vi.fn().mockResolvedValue({ entries: metricEntries, warnings: [] }),
    };

    (deps.stallDetector.checkDimensionStall as ReturnType<typeof vi.fn>).mockImplementation(
      (_goalId, _dimensionName, _history, _feedbackCategory, metricTrendContext) =>
        makeStallReport({ metric_trend_context: metricTrendContext })
    );
    (deps.strategyManager.onStallDetected as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "strategy-next", state: "active" });

    const ctx = buildPhaseCtx(deps, { maxIterations: 10, adapterType: "openai_codex_cli" });
    const result = makeIterationResult();

    await detectStallsAndRebalance(ctx, "goal-1", goal, result);

    expect(deps.stallDetector.checkDimensionStall).toHaveBeenCalledWith(
      "goal-1",
      "dim1",
      expect.any(Array),
      undefined,
      expect.objectContaining({ metric_key: "dim1", trend: "breakthrough", latest_value: 0.7 })
    );
    expect(deps.strategyManager.onStallDetected).toHaveBeenCalledWith(
      "goal-1",
      1,
      goal.origin ?? "general",
      undefined,
      expect.objectContaining({ metric_key: "dim1", trend: "breakthrough" })
    );
    expect(result.metricTrendContext).toMatchObject({ metric_key: "dim1", trend: "breakthrough" });
  });

  it("feeds runtime metric trend context through typed observation mapping", async () => {
    const deps = createBaseDeps(tmpDir);
    const goal = makeGoal({
      id: "goal-1",
      dimensions: [
        makeDimension({
          name: "model_quality",
          label: "Model Quality",
          observation_mapping: {
            kind: "data_source",
            data_source: "evals",
            dimension: "balanced_accuracy",
            confidence: "high",
          },
        }),
      ],
    });
    await deps.stateManager.saveGoal(goal);
    await deps.stateManager.saveGapHistory("goal-1", makeGapHistoryWithStall("model_quality", 5));

    deps.evidenceLedger = {
      append: vi.fn().mockResolvedValue([]),
      readByGoal: vi.fn().mockResolvedValue({
        entries: makeMetricTrendEvidenceEntries("balanced_accuracy"),
        warnings: [],
      }),
    };

    (deps.stallDetector.checkDimensionStall as ReturnType<typeof vi.fn>).mockImplementation(
      (_goalId, dimensionName, _history, _feedbackCategory, metricTrendContext) =>
        makeStallReport({ dimension_name: dimensionName, metric_trend_context: metricTrendContext })
    );

    const ctx = buildPhaseCtx(deps, { maxIterations: 10, adapterType: "openai_codex_cli" });
    const result = makeIterationResult();

    await detectStallsAndRebalance(ctx, "goal-1", goal, result);

    expect(deps.stallDetector.checkDimensionStall).toHaveBeenCalledWith(
      "goal-1",
      "model_quality",
      expect.any(Array),
      undefined,
      expect.objectContaining({ metric_key: "balanced_accuracy", trend: "breakthrough", latest_value: 0.7 })
    );
    expect(result.metricTrendContext).toMatchObject({ metric_key: "balanced_accuracy", trend: "breakthrough" });
  });

  it("does not reuse metric trend context from a non-stalled dimension", async () => {
    const deps = createBaseDeps(tmpDir);
    const goal = makeGoal({
      id: "goal-1",
      dimensions: [
        makeDimension({
          name: "model_quality",
          label: "Model Quality",
          observation_mapping: {
            kind: "data_source",
            data_source: "evals",
            dimension: "balanced_accuracy",
            confidence: "high",
          },
        }),
        makeDimension({
          name: "delivery_blocker",
          label: "Delivery Blocker",
        }),
      ],
    });
    await deps.stateManager.saveGoal(goal);
    await deps.stateManager.saveGapHistory(
      "goal-1",
      makeGapHistoryWithDimensions(["model_quality", "delivery_blocker"], 5)
    );
    deps.evidenceLedger = {
      append: vi.fn().mockResolvedValue([]),
      readByGoal: vi.fn().mockResolvedValue({
        entries: makeMetricTrendEvidenceEntries("balanced_accuracy"),
        warnings: [],
      }),
    };
    (deps.stallDetector.checkDimensionStall as ReturnType<typeof vi.fn>).mockImplementation(
      (_goalId, dimensionName, _history, _feedbackCategory, metricTrendContext) => {
        if (dimensionName === "model_quality") {
          expect(metricTrendContext).toMatchObject({ metric_key: "balanced_accuracy" });
          return null;
        }
        return makeStallReport({ dimension_name: dimensionName });
      }
    );

    const ctx = buildPhaseCtx(deps, { maxIterations: 10, adapterType: "openai_codex_cli" });
    const result = makeIterationResult();

    await detectStallsAndRebalance(ctx, "goal-1", goal, result);

    expect(result.stallReport).toMatchObject({ dimension_name: "delivery_blocker" });
    expect(result.metricTrendContext).toBeUndefined();
  });

  it("does not infer metric trend context by substring without typed mapping", async () => {
    const deps = createBaseDeps(tmpDir);
    const goal = makeGoal({
      id: "goal-1",
      dimensions: [
        makeDimension({
          name: "balanced_accuracy_target",
          label: "Balanced Accuracy Target",
        }),
      ],
    });
    await deps.stateManager.saveGoal(goal);
    await deps.stateManager.saveGapHistory("goal-1", makeGapHistoryWithStall("balanced_accuracy_target", 5));

    deps.evidenceLedger = {
      append: vi.fn().mockResolvedValue([]),
      readByGoal: vi.fn().mockResolvedValue({
        entries: makeMetricTrendEvidenceEntries("balanced_accuracy"),
        warnings: [],
      }),
    };

    const ctx = buildPhaseCtx(deps, { maxIterations: 10, adapterType: "openai_codex_cli" });
    const result = makeIterationResult();

    await detectStallsAndRebalance(ctx, "goal-1", goal, result);

    expect(deps.stallDetector.checkDimensionStall).toHaveBeenCalledWith(
      "goal-1",
      "balanced_accuracy_target",
      expect.any(Array),
      undefined,
      undefined
    );
    expect(result.metricTrendContext).toBeUndefined();
  });

  it("records typed strategy lineage keys with stall decisions", async () => {
    const deps = createBaseDeps(tmpDir);
    const goal = makeGoal({ id: "goal-1", origin: "manual" });
    await deps.stateManager.saveGoal(goal);
    await deps.stateManager.saveGapHistory("goal-1", makeGapHistoryWithStall("dim1", 5));

    (deps.strategyManager.getActiveStrategy as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "strategy-active",
      hypothesis: "Repeat threshold tuning around the same plateau",
      primary_dimension: "dim1",
      target_dimensions: ["dim1"],
      exploration: {
        schema_version: "strategy-exploration-v1",
        phase: "divergent_stall_recovery",
        role: "adjacent_exploration",
        strategy_family: "threshold_sweep",
        novelty_score: 0.5,
        similarity_to_recent_failures: 0.9,
        expected_cost: "medium",
        relationship_to_lineage: "failed_lineage",
        smoke: { status: "not_run", reason: "Smoke first." },
        speculative: true,
        evidence_authority: "speculative_hypothesis",
        lineage_assessment: {
          schema_version: "strategy-lineage-assessment-v1",
          confidence: 0.9,
          relationship_to_lineage: "failed_lineage",
          novelty_basis: "typed_lineage_evidence",
          matched_failed_lineage_fingerprints: ["threshold_sweep|dim1|threshold_sweep"],
          matched_strategy_ids: ["strategy-active"],
          evidence_refs: ["evidence-failed-1"],
          summary: "Matched failed lineage.",
        },
      },
    });
    const knowledgeManager = {
      recordDecision: vi.fn().mockResolvedValue(undefined),
    };
    deps.knowledgeManager = knowledgeManager as never;
    (deps.stallDetector.checkDimensionStall as ReturnType<typeof vi.fn>).mockReturnValue(makeStallReport({
      goal_id: "goal-1",
      dimension_name: "dim1",
      escalation_level: 2,
    }));
    (deps.strategyManager.onStallDetected as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "strategy-next", state: "active" });

    const ctx = buildPhaseCtx(deps, { maxIterations: 10, adapterType: "openai_codex_cli" });
    const result = makeIterationResult();

    await detectStallsAndRebalance(ctx, "goal-1", goal, result);

    expect(knowledgeManager.recordDecision).toHaveBeenCalledWith(expect.objectContaining({
      strategy_id: "strategy-active",
      hypothesis: "Repeat threshold tuning around the same plateau",
      lineage: expect.objectContaining({
        strategy_family: "threshold_sweep",
        relationship_to_lineage: "failed_lineage",
        failed_lineage_fingerprints: ["threshold_sweep|dim1|threshold_sweep"],
        lineage_evidence_refs: ["evidence-failed-1"],
      }),
    }));
  });

  it("requests divergent exploration on predicted plateau without pivoting and writes speculative evidence", async () => {
    const deps = createBaseDeps(tmpDir);
    const goal = makeGoal({ id: "goal-1" });
    await deps.stateManager.saveGoal(goal);
    await deps.stateManager.saveGapHistory("goal-1", makeGapHistoryWithStall("dim1", 5));

    const prepareDivergentExplorationOnStall = vi.fn().mockResolvedValue([]);
    (deps.strategyManager as unknown as {
      prepareDivergentExplorationOnStall: typeof prepareDivergentExplorationOnStall;
    }).prepareDivergentExplorationOnStall = prepareDivergentExplorationOnStall;
    (deps.strategyManager.getPortfolio as ReturnType<typeof vi.fn>).mockResolvedValue({
      goal_id: "goal-1",
      strategies: [{
        id: "strategy-divergent",
        hypothesis: "Run a smoke-scale data distribution audit",
        state: "candidate",
        exploration: {
          phase: "divergent_stall_recovery",
          role: "divergent_exploration",
          strategy_family: "data-audit",
          novelty_score: 0.86,
          similarity_to_recent_failures: 0.1,
          expected_cost: "low",
          relationship_to_lineage: "different_assumption",
          smoke: { status: "not_run", reason: "Smoke first." },
          evidence_authority: "speculative_hypothesis",
        },
      }],
      rebalance_interval: { value: 7, unit: "days" },
      last_rebalanced_at: new Date().toISOString(),
    });
    deps.evidenceLedger = {
      append: vi.fn().mockResolvedValue([{ id: "evidence-divergent" }]),
      readByGoal: vi.fn().mockResolvedValue({ entries: [], warnings: [] }),
      summarizeGoal: vi.fn().mockResolvedValue({
        failed_lineages: [{
          fingerprint: "threshold_sweep|dim1|threshold_sweep",
          count: 2,
          first_seen_at: "2026-04-30T00:00:00.000Z",
          last_seen_at: "2026-04-30T00:05:00.000Z",
          strategy_family: "threshold_sweep",
          primary_dimension: "dim1",
          task_action: "threshold_sweep",
          representative_entry_id: "evidence-failed-latest",
          representative_summary: "Threshold sweeps repeatedly failed.",
          evidence_entry_ids: ["evidence-failed-1", "evidence-failed-2"],
        }],
      }),
    };
    const stallReport = makeStallReport({
      stall_type: "predicted_plateau",
      escalation_level: 1,
      metric_trend_context: {
        metric_key: "dim1",
        direction: "maximize",
        trend: "stalled",
        latest_value: 0.97,
        latest_observed_at: "2026-04-30T00:00:00.000Z",
        best_value: 0.9708,
        best_observed_at: "2026-04-30T00:00:00.000Z",
        observation_count: 6,
        recent_slope_per_observation: 0,
        best_delta: 0.0001,
        last_meaningful_improvement_delta: null,
        last_breakthrough_delta: null,
        time_since_last_meaningful_improvement_ms: 86_400_000,
        improvement_threshold: 0.01,
        breakthrough_threshold: 0.05,
        noise_band: 0.005,
        confidence: 0.9,
        source_refs: [],
        summary: "dim1 stalled near the best value.",
      },
    });
    (deps.stallDetector.checkDimensionStall as ReturnType<typeof vi.fn>).mockReturnValue(stallReport);

    const ctx = buildPhaseCtx(deps, { maxIterations: 10, adapterType: "openai_codex_cli" });
    const result = makeIterationResult();

    await detectStallsAndRebalance(ctx, "goal-1", goal, result);

    expect(prepareDivergentExplorationOnStall).toHaveBeenCalledWith("goal-1", expect.objectContaining({
      trigger: "predicted_plateau",
      stallCount: 2,
      primaryDimension: "dim1",
      failedLineages: [expect.objectContaining({
        fingerprint: "threshold_sweep|dim1|threshold_sweep",
        strategy_family: "threshold_sweep",
      })],
    }));
    expect(deps.strategyManager.onStallDetected).not.toHaveBeenCalled();
    expect(deps.evidenceLedger.append).toHaveBeenCalledWith(expect.objectContaining({
      kind: "strategy",
      scope: expect.objectContaining({ goal_id: "goal-1", phase: "divergent_stall_recovery" }),
      divergent_exploration: [expect.objectContaining({
        strategy_family: "data-audit",
        role: "divergent_exploration",
        evidence_authority: "speculative_hypothesis",
      })],
    }));
    expect(result.pivotOccurred).toBe(false);
    expect(result.divergentExploration).toMatchObject({
      trigger: "predicted_plateau",
      evidenceEntryId: "evidence-divergent",
      candidates: [expect.objectContaining({ strategy_family: "data-audit" })],
    });
  });

  it("does NOT call reRefineLeaf() when goalRefiner is absent (backward compat)", async () => {
    const deps = createBaseDeps(tmpDir);
    // No goalRefiner set

    const goal = makeGoal({ id: "goal-1" });
    await deps.stateManager.saveGoal(goal);

    const gapHistory = makeGapHistoryWithStall("dim1", 5);
    await deps.stateManager.saveGapHistory("goal-1", gapHistory);

    const stallReport = makeStallReport({
      suggested_cause: "information_deficit",
      goal_id: "goal-1",
      dimension_name: "dim1",
    });
    (deps.stallDetector.checkDimensionStall as ReturnType<typeof vi.fn>).mockReturnValue(stallReport);

    const ctx = buildPhaseCtx(deps, { maxIterations: 10, adapterType: "openai_codex_cli" });
    const result = makeIterationResult();

    // Should not throw
    await expect(detectStallsAndRebalance(ctx, "goal-1", goal, result)).resolves.toEqual({ status: "completed" });
    expect(result.stallDetected).toBe(true);
  });

  it("honors replanning continue hint and avoids pivoting", async () => {
    const deps = createBaseDeps(tmpDir);
    const goal = makeGoal({ id: "goal-1" });
    await deps.stateManager.saveGoal(goal);

    const gapHistory = makeGapHistoryWithStall("dim1", 5);
    await deps.stateManager.saveGapHistory("goal-1", gapHistory);

    const stallReport = makeStallReport({
      goal_id: "goal-1",
      dimension_name: "dim1",
    });
    (deps.stallDetector.checkDimensionStall as ReturnType<typeof vi.fn>).mockReturnValue(stallReport);
    (deps.stallDetector.analyzeStallCause as ReturnType<typeof vi.fn> | undefined)?.mockReturnValue?.({
      recommended_action: "pivot",
      evidence: ["plateau"],
    });

    const ctx = buildPhaseCtx(deps, { maxIterations: 10, adapterType: "openai_codex_cli" });
    const result = makeIterationResult();

    await detectStallsAndRebalance(ctx, "goal-1", goal, result, { recommendedAction: "continue" });

    expect(result.stallDetected).toBe(true);
    expect(result.pivotOccurred).toBe(false);
    expect(deps.strategyManager.onStallDetected).not.toHaveBeenCalled();
  });

  it("reRefineLeaf() failure is non-fatal — loop continues", async () => {
    const deps = createBaseDeps(tmpDir);

    const mockRefiner = {
      refine: vi.fn(),
      reRefineLeaf: vi.fn().mockRejectedValue(new Error("reRefineLeaf failed")),
    } as unknown as GoalRefiner;

    deps.goalRefiner = mockRefiner;

    const goal = makeGoal({ id: "goal-1" });
    await deps.stateManager.saveGoal(goal);

    const gapHistory = makeGapHistoryWithStall("dim1", 5);
    await deps.stateManager.saveGapHistory("goal-1", gapHistory);

    const stallReport = makeStallReport({
      suggested_cause: "information_deficit",
      goal_id: "goal-1",
      dimension_name: "dim1",
    });
    (deps.stallDetector.checkDimensionStall as ReturnType<typeof vi.fn>).mockReturnValue(stallReport);

    const ctx = buildPhaseCtx(deps, { maxIterations: 10, adapterType: "openai_codex_cli" });
    const result = makeIterationResult();

    // Should not throw even when reRefineLeaf errors
    await expect(detectStallsAndRebalance(ctx, "goal-1", goal, result)).resolves.toEqual({ status: "completed" });
    expect(result.stallDetected).toBe(true);
    expect(mockRefiner.reRefineLeaf).toHaveBeenCalledOnce();
  });
});

describe("detectStallsAndRebalance — global stall reRefineLeaf", () => {
  it("calls reRefineLeaf() for global information_deficit stall when goalRefiner is present", async () => {
    const deps = createBaseDeps(tmpDir);

    const mockRefiner = {
      refine: vi.fn(),
      reRefineLeaf: vi.fn().mockResolvedValue({ leaf: true }),
    } as unknown as GoalRefiner;

    deps.goalRefiner = mockRefiner;

    const goal = makeGoal({
      id: "goal-1",
      dimensions: [
        {
          name: "dim1",
          label: "Dim 1",
          current_value: 0.2,
          threshold: { type: "min", value: 1.0 },
          confidence: 0.5,
          observation_method: {
            type: "manual",
            source: "manual",
            schedule: null,
            endpoint: null,
            confidence_tier: "self_report",
          },
          last_updated: new Date().toISOString(),
          history: [],
          weight: 1.0,
          uncertainty_weight: null,
          state_integrity: "ok",
          dimension_mapping: null,
        },
      ],
    });
    await deps.stateManager.saveGoal(goal);

    const gapHistory = makeGapHistoryWithStall("dim1", 5);
    await deps.stateManager.saveGapHistory("goal-1", gapHistory);

    // Per-dimension stall returns null so global stall is checked
    (deps.stallDetector.checkDimensionStall as ReturnType<typeof vi.fn>).mockReturnValue(null);

    const globalStallReport = makeStallReport({
      stall_type: "global_stall",
      suggested_cause: "information_deficit",
      goal_id: "goal-1",
      dimension_name: null,
    });
    (deps.stallDetector.checkGlobalStall as ReturnType<typeof vi.fn>).mockReturnValue(globalStallReport);

    const ctx = buildPhaseCtx(deps, { maxIterations: 10, adapterType: "openai_codex_cli" });
    const result = makeIterationResult();

    await detectStallsAndRebalance(ctx, "goal-1", goal, result);

    expect(result.stallDetected).toBe(true);
    expect(mockRefiner.reRefineLeaf).toHaveBeenCalledOnce();
    expect(mockRefiner.reRefineLeaf).toHaveBeenCalledWith("goal-1", "information_deficit");
  });

  it("does NOT call reRefineLeaf() for global progress stall (capability_limit)", async () => {
    const deps = createBaseDeps(tmpDir);

    const mockRefiner = {
      refine: vi.fn(),
      reRefineLeaf: vi.fn(),
    } as unknown as GoalRefiner;

    deps.goalRefiner = mockRefiner;

    const goal = makeGoal({ id: "goal-1" });
    await deps.stateManager.saveGoal(goal);

    const gapHistory = makeGapHistoryWithStall("dim1", 5);
    await deps.stateManager.saveGapHistory("goal-1", gapHistory);

    (deps.stallDetector.checkDimensionStall as ReturnType<typeof vi.fn>).mockReturnValue(null);

    const globalStallReport = makeStallReport({
      stall_type: "global_stall",
      suggested_cause: "capability_limit",
      goal_id: "goal-1",
      dimension_name: null,
    });
    (deps.stallDetector.checkGlobalStall as ReturnType<typeof vi.fn>).mockReturnValue(globalStallReport);

    const ctx = buildPhaseCtx(deps, { maxIterations: 10, adapterType: "openai_codex_cli" });
    const result = makeIterationResult();

    await detectStallsAndRebalance(ctx, "goal-1", goal, result);

    expect(result.stallDetected).toBe(true);
    expect(mockRefiner.reRefineLeaf).not.toHaveBeenCalled();
  });
});

describe("detectStallsAndRebalance — gap history indexing reuse", () => {
  it("reuses the same per-dimension history for dimension and global stall checks", async () => {
    const deps = createBaseDeps(tmpDir);
    const goal = makeGoal({
      id: "goal-1",
      dimensions: [
        {
          name: "dim1",
          label: "Dim 1",
          current_value: 0.2,
          threshold: { type: "min", value: 1.0 },
          confidence: 0.5,
          observation_method: {
            type: "manual",
            source: "manual",
            schedule: null,
            endpoint: null,
            confidence_tier: "self_report",
          },
          last_updated: new Date().toISOString(),
          history: [],
          weight: 1.0,
          uncertainty_weight: null,
          state_integrity: "ok",
          dimension_mapping: null,
        },
        {
          name: "dim2",
          label: "Dim 2",
          current_value: 0.4,
          threshold: { type: "min", value: 1.0 },
          confidence: 0.5,
          observation_method: {
            type: "manual",
            source: "manual",
            schedule: null,
            endpoint: null,
            confidence_tier: "self_report",
          },
          last_updated: new Date().toISOString(),
          history: [],
          weight: 1.0,
          uncertainty_weight: null,
          state_integrity: "ok",
          dimension_mapping: null,
        },
      ],
    });
    await deps.stateManager.saveGoal(goal);

    await deps.stateManager.saveGapHistory("goal-1", [
      {
        iteration: 0,
        timestamp: new Date().toISOString(),
        gap_vector: [
          { dimension_name: "dim1", normalized_weighted_gap: 0.8 },
          { dimension_name: "dim2", normalized_weighted_gap: 0.4 },
        ],
        confidence_vector: [],
      },
      {
        iteration: 1,
        timestamp: new Date().toISOString(),
        gap_vector: [
          { dimension_name: "dim2", normalized_weighted_gap: 0.3 },
        ],
        confidence_vector: [],
      },
      {
        iteration: 2,
        timestamp: new Date().toISOString(),
        gap_vector: [
          { dimension_name: "dim1", normalized_weighted_gap: 0.6 },
        ],
        confidence_vector: [],
      },
    ]);

    const dimensionHistories = new Map<string, Array<{ normalized_gap: number; timestamp?: string }>>();
    (deps.stallDetector.checkDimensionStall as ReturnType<typeof vi.fn>).mockImplementation(
      (_goalId: string, dimName: string, dimGapHistory: Array<{ normalized_gap: number; timestamp?: string }>) => {
        dimensionHistories.set(dimName, dimGapHistory);
        return null;
      }
    );

    const globalHistories: Array<Map<string, Array<{ normalized_gap: number; timestamp?: string }>>> = [];
    (deps.stallDetector.checkGlobalStall as ReturnType<typeof vi.fn>).mockImplementation(
      (_goalId: string, allDimGaps: Map<string, Array<{ normalized_gap: number; timestamp?: string }>>) => {
        globalHistories.push(allDimGaps);
        return null;
      }
    );

    const ctx = buildPhaseCtx(deps, { maxIterations: 10, adapterType: "openai_codex_cli" });
    const result = makeIterationResult();

    await detectStallsAndRebalance(ctx, "goal-1", goal, result);

    expect(dimensionHistories.get("dim1")).toEqual([
      expect.objectContaining({ normalized_gap: 0.8 }),
      expect.objectContaining({ normalized_gap: 0.6 }),
    ]);
    expect(dimensionHistories.get("dim2")).toEqual([
      expect.objectContaining({ normalized_gap: 0.4 }),
      expect.objectContaining({ normalized_gap: 0.3 }),
    ]);

    const globalHistory = globalHistories[0];
    expect(globalHistory).toBeDefined();
    expect(globalHistory?.get("dim1")).toBe(dimensionHistories.get("dim1"));
    expect(globalHistory?.get("dim2")).toBe(dimensionHistories.get("dim2"));
  });

  it("ignores stale dimensions that are no longer present on the goal", async () => {
    const deps = createBaseDeps(tmpDir);
    const goal = makeGoal({
      id: "goal-1",
      dimensions: [
        {
          name: "dim1",
          label: "Dim 1",
          current_value: 0.2,
          threshold: { type: "min", value: 1.0 },
          confidence: 0.5,
          observation_method: {
            type: "manual",
            source: "manual",
            schedule: null,
            endpoint: null,
            confidence_tier: "self_report",
          },
          last_updated: new Date().toISOString(),
          history: [],
          weight: 1.0,
          uncertainty_weight: null,
          state_integrity: "ok",
          dimension_mapping: null,
        },
      ],
    });
    await deps.stateManager.saveGoal(goal);

    await deps.stateManager.saveGapHistory("goal-1", [
      {
        iteration: 0,
        timestamp: new Date().toISOString(),
        gap_vector: [
          { dimension_name: "dim1", normalized_weighted_gap: 0.8 },
          { dimension_name: "stale-dim", normalized_weighted_gap: 0.1 },
        ],
        confidence_vector: [],
      },
    ]);

    (deps.stallDetector.checkDimensionStall as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const globalCheck = deps.stallDetector.checkGlobalStall as ReturnType<typeof vi.fn>;
    globalCheck.mockReturnValue(null);

    const ctx = buildPhaseCtx(deps, { maxIterations: 10, adapterType: "openai_codex_cli" });
    const result = makeIterationResult();

    await detectStallsAndRebalance(ctx, "goal-1", goal, result);

    const globalHistory = globalCheck.mock.calls[0]?.[1] as Map<string, Array<{ normalized_gap: number }>>;
    expect(globalHistory.has("dim1")).toBe(true);
    expect(globalHistory.has("stale-dim")).toBe(false);
  });

  it("excludes wait-suppressed dimensions from global stall checks", async () => {
    const deps = createBaseDeps(tmpDir);
    const goal = makeGoal({
      id: "goal-1",
      dimensions: [
        {
          name: "dim1",
          label: "Dim 1",
          current_value: 0.2,
          threshold: { type: "min", value: 1.0 },
          confidence: 0.5,
          observation_method: {
            type: "manual",
            source: "manual",
            schedule: null,
            endpoint: null,
            confidence_tier: "self_report",
          },
          last_updated: new Date().toISOString(),
          history: [],
          weight: 1.0,
          uncertainty_weight: null,
          state_integrity: "ok",
          dimension_mapping: null,
        },
        {
          name: "dim2",
          label: "Dim 2",
          current_value: 0.4,
          threshold: { type: "min", value: 1.0 },
          confidence: 0.5,
          observation_method: {
            type: "manual",
            source: "manual",
            schedule: null,
            endpoint: null,
            confidence_tier: "self_report",
          },
          last_updated: new Date().toISOString(),
          history: [],
          weight: 1.0,
          uncertainty_weight: null,
          state_integrity: "ok",
          dimension_mapping: null,
        },
      ],
    });
    await deps.stateManager.saveGoal(goal);
    await deps.stateManager.saveGapHistory("goal-1", [
      {
        iteration: 0,
        timestamp: new Date().toISOString(),
        gap_vector: [
          { dimension_name: "dim1", normalized_weighted_gap: 0.8 },
          { dimension_name: "dim2", normalized_weighted_gap: 0.4 },
        ],
        confidence_vector: [],
      },
    ]);

    const portfolioManager = {
      isWaitStrategy: vi.fn().mockImplementation(
        (strategy: Record<string, unknown>) => typeof strategy["wait_until"] === "string"
      ),
      shouldRebalance: vi.fn(),
      rebalance: vi.fn(),
    };
    const depsWithPortfolio = {
      ...deps,
      portfolioManager,
      strategyManager: {
        ...deps.strategyManager,
        getPortfolio: vi.fn().mockResolvedValue({
          goal_id: "goal-1",
          strategies: [
            {
              id: "wait-1",
              state: "active",
              primary_dimension: "dim1",
              wait_until: new Date(Date.now() + 60_000).toISOString(),
            },
          ],
        }),
      } as unknown as StrategyManager,
    };
    (depsWithPortfolio.stallDetector.isSuppressed as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (depsWithPortfolio.stallDetector.checkDimensionStall as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const globalCheck = depsWithPortfolio.stallDetector.checkGlobalStall as ReturnType<typeof vi.fn>;
    globalCheck.mockReturnValue(null);

    const ctx = buildPhaseCtx(depsWithPortfolio as unknown as CoreLoopDeps, { maxIterations: 10, adapterType: "openai_codex_cli" });
    const result = makeIterationResult();

    await detectStallsAndRebalance(ctx, "goal-1", goal, result);

    expect(result.waitSuppressed).toBe(true);
    expect(depsWithPortfolio.stallDetector.checkDimensionStall).toHaveBeenCalledTimes(1);
    expect(depsWithPortfolio.stallDetector.checkDimensionStall).toHaveBeenCalledWith(
      "goal-1",
      "dim2",
      [expect.objectContaining({ normalized_gap: 0.4 })],
      undefined,
      undefined
    );
    const globalHistory = globalCheck.mock.calls[0]?.[1] as Map<string, Array<{ normalized_gap: number; timestamp?: string }>>;
    expect(globalHistory.has("dim1")).toBe(false);
    expect(globalHistory.get("dim2")).toEqual([expect.objectContaining({ normalized_gap: 0.4 })]);
  });

  it("suppresses only the WaitStrategy primary_dimension, not every target_dimension", async () => {
    const deps = createBaseDeps(tmpDir);
    const goal = makeGoal({
      id: "goal-1",
      dimensions: [
        {
          name: "dim1",
          label: "Dim 1",
          current_value: 0.2,
          threshold: { type: "min", value: 1.0 },
          confidence: 0.5,
          observation_method: {
            type: "manual",
            source: "manual",
            schedule: null,
            endpoint: null,
            confidence_tier: "self_report",
          },
          last_updated: new Date().toISOString(),
          history: [],
          weight: 1.0,
          uncertainty_weight: null,
          state_integrity: "ok",
          dimension_mapping: null,
        },
        {
          name: "dim2",
          label: "Dim 2",
          current_value: 0.4,
          threshold: { type: "min", value: 1.0 },
          confidence: 0.5,
          observation_method: {
            type: "manual",
            source: "manual",
            schedule: null,
            endpoint: null,
            confidence_tier: "self_report",
          },
          last_updated: new Date().toISOString(),
          history: [],
          weight: 1.0,
          uncertainty_weight: null,
          state_integrity: "ok",
          dimension_mapping: null,
        },
      ],
    });
    await deps.stateManager.saveGoal(goal);
    await deps.stateManager.saveGapHistory("goal-1", [
      {
        iteration: 0,
        timestamp: new Date().toISOString(),
        gap_vector: [
          { dimension_name: "dim1", normalized_weighted_gap: 0.8 },
          { dimension_name: "dim2", normalized_weighted_gap: 0.4 },
        ],
        confidence_vector: [],
      },
    ]);

    const portfolioManager = {
      isWaitStrategy: vi.fn().mockReturnValue(true),
      shouldRebalance: vi.fn(),
      rebalance: vi.fn(),
    };
    const depsWithPortfolio = {
      ...deps,
      portfolioManager,
      strategyManager: {
        ...deps.strategyManager,
        getPortfolio: vi.fn().mockResolvedValue({
          goal_id: "goal-1",
          strategies: [
            {
              id: "wait-1",
              state: "active",
              primary_dimension: "dim1",
              target_dimensions: ["dim1", "dim2"],
              wait_until: new Date(Date.now() + 60_000).toISOString(),
            },
          ],
        }),
      } as unknown as StrategyManager,
    };
    (depsWithPortfolio.stallDetector.isSuppressed as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (depsWithPortfolio.stallDetector.checkDimensionStall as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const globalCheck = depsWithPortfolio.stallDetector.checkGlobalStall as ReturnType<typeof vi.fn>;
    globalCheck.mockReturnValue(null);

    const ctx = buildPhaseCtx(depsWithPortfolio as unknown as CoreLoopDeps, { maxIterations: 10, adapterType: "openai_codex_cli" });
    const result = makeIterationResult();

    await detectStallsAndRebalance(ctx, "goal-1", goal, result);

    expect(depsWithPortfolio.stallDetector.checkDimensionStall).toHaveBeenCalledTimes(1);
    expect(depsWithPortfolio.stallDetector.checkDimensionStall).toHaveBeenCalledWith(
      "goal-1",
      "dim2",
      [expect.objectContaining({ normalized_gap: 0.4 })],
      undefined,
      undefined
    );
    const globalHistory = globalCheck.mock.calls[0]?.[1] as Map<string, Array<{ normalized_gap: number; timestamp?: string }>>;
    expect(globalHistory.has("dim1")).toBe(false);
    expect(globalHistory.has("dim2")).toBe(true);
  });

  it("skips global stall checks when every dimension is wait-suppressed", async () => {
    const deps = createBaseDeps(tmpDir);
    const goal = makeGoal({
      id: "goal-1",
      dimensions: [
        {
          name: "dim1",
          label: "Dim 1",
          current_value: 0.2,
          threshold: { type: "min", value: 1.0 },
          confidence: 0.5,
          observation_method: {
            type: "manual",
            source: "manual",
            schedule: null,
            endpoint: null,
            confidence_tier: "self_report",
          },
          last_updated: new Date().toISOString(),
          history: [],
          weight: 1.0,
          uncertainty_weight: null,
          state_integrity: "ok",
          dimension_mapping: null,
        },
      ],
    });
    await deps.stateManager.saveGoal(goal);
    await deps.stateManager.saveGapHistory("goal-1", [
      {
        iteration: 0,
        timestamp: new Date().toISOString(),
        gap_vector: [{ dimension_name: "dim1", normalized_weighted_gap: 0.8 }],
        confidence_vector: [],
      },
    ]);

    const depsWithPortfolio = {
      ...deps,
      portfolioManager: {
        isWaitStrategy: vi.fn().mockReturnValue(true),
        shouldRebalance: vi.fn(),
        rebalance: vi.fn(),
      },
      strategyManager: {
        ...deps.strategyManager,
        getPortfolio: vi.fn().mockResolvedValue({
          goal_id: "goal-1",
          strategies: [
            {
              id: "wait-1",
              state: "active",
              primary_dimension: "dim1",
              wait_until: new Date(Date.now() + 60_000).toISOString(),
            },
          ],
        }),
      } as unknown as StrategyManager,
    };
    (depsWithPortfolio.stallDetector.isSuppressed as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (depsWithPortfolio.stallDetector.checkDimensionStall as ReturnType<typeof vi.fn>).mockReturnValue(null);

    const ctx = buildPhaseCtx(depsWithPortfolio as unknown as CoreLoopDeps, { maxIterations: 10, adapterType: "openai_codex_cli" });
    const result = makeIterationResult();

    await detectStallsAndRebalance(ctx, "goal-1", goal, result);

    expect(depsWithPortfolio.stallDetector.checkDimensionStall).not.toHaveBeenCalled();
    expect(depsWithPortfolio.stallDetector.checkGlobalStall).not.toHaveBeenCalled();
    expect(result.stallDetected).toBe(false);
    expect(result.waitSuppressed).toBe(true);
  });

  it("passes a TimeHorizon-derived canAffordWait hook into stall-driven regeneration", async () => {
    const deps = createBaseDeps(tmpDir);
    const goal = makeGoal({
      id: "goal-1",
      deadline: "2026-05-01T00:00:00.000Z",
      dimensions: [
        {
          name: "dim1",
          label: "Dim 1",
          current_value: 0.2,
          threshold: { type: "min", value: 1.0 },
          confidence: 0.5,
          observation_method: {
            type: "manual",
            source: "manual",
            schedule: null,
            endpoint: null,
            confidence_tier: "self_report",
          },
          last_updated: new Date().toISOString(),
          history: [],
          weight: 1.0,
          uncertainty_weight: null,
          state_integrity: "ok",
          dimension_mapping: null,
        },
      ],
    });
    await deps.stateManager.saveGoal(goal);
    await deps.stateManager.saveGapHistory("goal-1", [
      {
        iteration: 0,
        timestamp: "2026-04-27T00:00:00.000Z",
        gap_vector: [{ dimension_name: "dim1", normalized_weighted_gap: 0.8 }],
        confidence_vector: [],
      },
      {
        iteration: 1,
        timestamp: "2026-04-27T01:00:00.000Z",
        gap_vector: [{ dimension_name: "dim1", normalized_weighted_gap: 0.6 }],
        confidence_vector: [],
      },
    ]);

    const timeHorizonEngine: ITimeHorizonEngine = {
      evaluatePacing: vi.fn().mockReturnValue({
        status: "on_track",
        velocityPerHour: 0.2,
        velocityStddev: 0,
        projectedCompletionDate: null,
        timeRemainingHours: 48,
        pacingRatio: 1,
        confidence: 1,
        recommendation: "maintain_course",
      }),
      projectCompletion: vi.fn(),
      suggestObservationInterval: vi.fn(),
      getTimeBudget: vi.fn().mockReturnValue({
        totalHours: 48,
        elapsedHours: 1,
        remainingHours: 47,
        percentElapsed: 0.02,
        percentGapRemaining: 0.6,
        canAffordWait: (waitHours: number) => waitHours <= 4,
      }),
    };

    const ctx = {
      ...buildPhaseCtx(deps, { maxIterations: 10, adapterType: "openai_codex_cli" }),
      timeHorizonEngine,
    };
    const result = makeIterationResult();
    (deps.stallDetector.checkDimensionStall as ReturnType<typeof vi.fn>).mockReturnValue(
      makeStallReport({ escalation_level: 1 })
    );
    (deps.strategyManager.onStallDetected as ReturnType<typeof vi.fn>).mockImplementation(
      async (_goalId: string, _stallCount: number, _goalType: string | undefined, activationContext?: {
        canAffordWait?: (input: {
          strategy: { primary_dimension: string };
          waitHours: number;
          currentGap: number;
          initialGap: number;
          startedAt: string;
        }) => boolean | Promise<boolean>;
      }) => {
        const canAfford = await activationContext?.canAffordWait?.({
          strategy: { primary_dimension: "dim1" },
          waitHours: 3,
          currentGap: 0.6,
          initialGap: 0.8,
          startedAt: "2026-04-27T01:00:00.000Z",
        });
        return canAfford ? { id: "wait-1", state: "active" } : null;
      }
    );

    await detectStallsAndRebalance(ctx, "goal-1", goal, result);

    expect(deps.strategyManager.onStallDetected).toHaveBeenCalledWith(
      "goal-1",
      1,
      goal.origin ?? "general",
      expect.objectContaining({
        canAffordWait: expect.any(Function),
      })
    );
    expect(timeHorizonEngine.evaluatePacing).toHaveBeenCalled();
    expect(timeHorizonEngine.getTimeBudget).toHaveBeenCalledWith(
      goal.deadline,
      goal.created_at,
      0.6,
      0.8,
      0.2
    );
    expect(result.pivotOccurred).toBe(true);
  });
});
