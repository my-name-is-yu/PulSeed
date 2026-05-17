import { sleep } from "../../base/utils/sleep.js";
import type { StateDiffCalculator } from "./state-diff.js";
import { IterationBudget } from "./iteration-budget.js";
import { saveLoopCheckpoint, restoreLoopCheckpoint } from "./checkpoint-manager-loop.js";
import { runPostLoopHooks } from "./post-loop-hooks.js";
import { generateLoopReport } from "./loop-report-helper.js";

import type { LoopIterationResult, LoopResult } from "./loop-result-types.js";
import type {
  LoopConfig,
  ResolvedLoopConfig,
  CoreLoopDeps,
  LoopRunPolicyMode,
} from "./durable-loop/contracts.js";
import {
  runTreeIteration as runTreeIterationImpl,
  runMultiGoalIteration as runMultiGoalIterationImpl,
} from "./tree-loop-runner.js";
import { type StateDiffState } from "./durable-loop/control.js";
import type { ITimeHorizonEngine } from "../../platform/time/time-horizon-engine.js";
import type { PacingResult } from "../../base/types/time-horizon.js";
import { CoreLoopLearning } from "./durable-loop/learning.js";
import { StaticCorePhasePolicyRegistry } from "./durable-loop/phase-policy.js";
import { CoreDecisionEngine } from "./durable-loop/decision-engine.js";
import { ExperienceLearningBridge } from "./durable-loop/experience-learning-bridge.js";
import type { CorePhasePolicyRegistry } from "./durable-loop/phase-policy.js";
import { CoreIterationKernel } from "./durable-loop/iteration-kernel.js";
import { ExperienceLearningStateStore } from "../../runtime/store/experience-learning-state-store.js";
import type { GoalRunActivationContext } from "../../base/types/goal-activation.js";
import { resolveLoopConfig, resolveLoopRunPolicy } from "./run-policy.js";
import type {
  RuntimeBudgetLimitInput,
  RuntimeBudgetRecord,
  RuntimeBudgetStatus,
} from "../../runtime/store/budget-store.js";
import type {
  RuntimeOperatorHandoffInput,
  RuntimeOperatorHandoffTrigger,
} from "../../runtime/store/operator-handoff-store.js";

// Re-export types for compatibility while DurableLoop naming is introduced.
export type {
  GapCalculatorModule,
  DriveScorerModule,
  ExecutionSummaryParams,
  ReportingEngine,
  WaitApprovalBroker,
  LoopConfig,
  ResolvedLoopConfig,
  CoreLoopDeps,
  ProgressEvent,
  ProgressPhase,
  LoopRunPolicyMode,
} from "./durable-loop/contracts.js";
export type {
  CoreLoopDeps as DurableLoopDeps,
} from "./durable-loop/contracts.js";
export type {
  LoopIterationResult,
  LoopResult,
} from "./loop-result-types.js";
export { buildDriveContext } from "./durable-loop/contracts.js";
export { makeEmptyIterationResult } from "./loop-result-types.js";

const DEFAULT_CONFIG: Required<Omit<LoopConfig, "iterationBudget" | "runtimeBudget">> = {
  maxIterations: 100,
  runPolicy: { mode: "bounded", maxIterations: 100 },
  maxConsecutiveErrors: 3,
  delayBetweenLoopsMs: 1000,
  adapterType: "openai_codex_cli",
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
};

// ─── DurableLoop ───

/**
 * DurableLoop is the daemon-backed resilient long-running execution loop. The
 * legacy CoreLoop export remains available as a compatibility name during the
 * migration.
 *
 * CoreLoop orchestrates one full iteration of the
 * task discovery loop: observe → gap → score → completion check → stall check → task → report.
 *
 * It runs multiple iterations until the goal is complete (SatisficingJudge),
 * max iterations reached, stall escalation occurs, or an external stop signal.
 */
export class CoreLoop {
  private readonly deps: CoreLoopDeps;
  /** Mutable config — may be updated mid-run (e.g. treeMode enabled after decomposition). */
  private config: ResolvedLoopConfig;
  private readonly logger?: import("../../runtime/logger.js").Logger;
  private stopped = false;
  private readonly learning: CoreLoopLearning = new CoreLoopLearning();
  private readonly corePhasePolicyRegistry: CorePhasePolicyRegistry;
  private readonly coreDecisionEngine: CoreDecisionEngine;
  /** Optional StateDiffCalculator for loop-skip optimization. */
  private readonly stateDiff?: StateDiffCalculator;
  private stateDiffState = new Map<string, StateDiffState>();
  private pendingIterationDirectives = new Map<string, import("./loop-result-types.js").NextIterationDirective>();
  /** Tracks goals that have already been through auto-decompose this run. */
  private decomposedGoals = new Set<string>();
  /** Optional TimeHorizonEngine for adaptive observation interval (Gap 4). */
  private timeHorizonEngine?: ITimeHorizonEngine;
  /** Last known pacing result — updated each iteration for adaptive delay. */
  private lastPacingResult?: PacingResult;
  private currentActivationContext?: GoalRunActivationContext;

  constructor(deps: CoreLoopDeps, config?: LoopConfig, stateDiff?: StateDiffCalculator) {
    this.deps = deps;
    const mergedConfig: LoopConfig = { ...DEFAULT_CONFIG, ...config };
    if (config?.maxIterations === undefined && typeof config?.runPolicy === "object") {
      mergedConfig.maxIterations = config.runPolicy.maxIterations;
    }
    if (config?.maxIterations === undefined && config?.runPolicy === "resident") {
      mergedConfig.maxIterations = null;
    }
    this.config = resolveLoopConfig(mergedConfig) as ResolvedLoopConfig;
    this.logger = deps.logger;
    this.stateDiff = stateDiff;
    this.corePhasePolicyRegistry = deps.corePhasePolicyRegistry ?? new StaticCorePhasePolicyRegistry();
    this.coreDecisionEngine = deps.coreDecisionEngine ?? new CoreDecisionEngine();

    // Wire optional StrategyTemplateRegistry into StrategyManager for auto-templating
    if (deps.strategyTemplateRegistry) {
      deps.strategyManager.setStrategyTemplateRegistry(deps.strategyTemplateRegistry);
    }
    const baseDir = typeof deps.stateManager.getBaseDir === "function"
      ? deps.stateManager.getBaseDir()
      : null;
    if (!deps.experienceLearningStore && baseDir) {
      deps.experienceLearningStore = new ExperienceLearningStateStore(baseDir, { controlBaseDir: baseDir });
    }
    if (!deps.experienceLearningBridge && deps.experienceLearningStore) {
      deps.experienceLearningBridge = new ExperienceLearningBridge(deps.experienceLearningStore);
    }
  }
  // ─── Public API ───

  /**
   * Run the full loop until completion or stop condition.
   * @param options.maxIterations - Override config.maxIterations for this run only. Use null for resident/unbounded policy.
   */
  async run(
    goalId: string,
    options?: {
      maxIterations?: number | null;
      runPolicy?: LoopConfig["runPolicy"];
      onProgress?: CoreLoopDeps["onProgress"];
      activation?: GoalRunActivationContext;
      abortSignal?: AbortSignal;
    }
  ): Promise<LoopResult> {
    const depsWithMutableProgress = this.deps as CoreLoopDeps;
    const previousOnProgress = depsWithMutableProgress.onProgress;
    const previousMaxIterations = this.config.maxIterations;
    const previousRunPolicy = this.config.runPolicy;
    if (options?.onProgress) {
      depsWithMutableProgress.onProgress = options.onProgress;
    }
    if (options?.maxIterations !== undefined || options?.runPolicy !== undefined) {
      const runPolicy = resolveLoopRunPolicy({
        runPolicy: options?.runPolicy ?? this.config.runPolicy,
        maxIterations: options?.maxIterations !== undefined ? options.maxIterations : this.config.maxIterations,
      });
      this.config.maxIterations = runPolicy.maxIterations;
      this.config.runPolicy = runPolicy;
    }
    this.currentActivationContext = options?.activation;
    const abortSignal = options?.abortSignal;
    const abortFromParent = (): void => {
      this.logger?.warn("CoreLoop: abort requested by operator stop", { goalId });
      this.stop();
    };
    if (abortSignal?.aborted) {
      abortFromParent();
    } else {
      abortSignal?.addEventListener("abort", abortFromParent, { once: true });
    }

    try {
    const startedAt = new Date().toISOString();
    const dreamCollector = this.deps.hookManager?.getDreamCollector();
    const sessionId = dreamCollector?.buildSessionId(goalId, startedAt) ?? `${goalId}:${startedAt}`;
    this.stopped = false;
    // Reset state diff tracking for each run (snapshots are in-memory only)
    this.stateDiffState.clear();
    // Reset auto-decompose tracking for each run
    this.decomposedGoals.clear();
    this.pendingIterationDirectives.clear();

    // Load and validate goal
    const goal = await this.deps.stateManager.loadGoal(goalId);
    if (!goal) {
      return {
        goalId,
        totalIterations: 0,
        finalStatus: "error",
        iterations: [],
        startedAt,
        completedAt: new Date().toISOString(),
      };
    }

    if (goal.status !== "active" && goal.status !== "waiting") {
      const msg = `Goal "${goalId}" cannot be run: status is "${goal.status}" (expected "active" or "waiting")`;
      this.logger?.error(msg);
      return {
        goalId,
        totalIterations: 0,
        finalStatus: "error",
        errorMessage: msg,
        iterations: [],
        startedAt,
        completedAt: new Date().toISOString(),
      };
    }

    // Reset stall escalation state at the beginning of each run so prior
    // run's escalation does not immediately poison a fresh start.
    for (const dim of goal.dimensions) {
      await this.deps.stallDetector.resetEscalation(goalId, dim.name);
    }

    // Restore dimension/trust state from checkpoint if present (§4.8).
    const startLoopIndex = await restoreLoopCheckpoint(
      this.deps.stateManager,
      goalId,
      this.config.adapterType,
      this.deps.trustManager
    );

    const iterations: LoopIterationResult[] = [];
    let totalTokens = 0;
    let decisionCounters = {
      consecutiveErrors: 0,
      consecutiveDenied: 0,
      consecutiveEscalations: 0,
    };
    let finalStatus: LoopResult["finalStatus"] = this.config.runPolicy?.mode === "bounded" ? "max_iterations" : "stopped";

    const effectiveRunPolicy = this.config.runPolicy ?? resolveLoopRunPolicy({ maxIterations: this.config.maxIterations });
    const effectiveMaxIterations = effectiveRunPolicy.maxIterations;
    const hasIterationCap = effectiveRunPolicy.mode === "bounded" && effectiveMaxIterations !== null;
    const runtimeBudgetId = await this.ensureRuntimeBudgetForRun({
      goalId,
      startedAt,
      runId: this.currentActivationContext?.backgroundRun?.backgroundRunId,
      hasIterationCap,
      effectiveMaxIterations,
    });

    // Use the provided iterationBudget if set; otherwise create a local one.
    const budget: IterationBudget | null = this.config.iterationBudget
      ?? (hasIterationCap ? new IterationBudget(effectiveMaxIterations) : null);

    // Per-node iteration tracking for tree mode.
    const nodeConsumedMap = new Map<string, number>();

    for (
      let loopIndex = startLoopIndex;
      hasIterationCap ? loopIndex < startLoopIndex + effectiveMaxIterations : true;
      loopIndex++
    ) {
      if (abortSignal?.aborted) {
        finalStatus = "stopped";
        break;
      }
      if (this.stopped) {
        finalStatus = "stopped";
        break;
      }

      if (budget?.exhausted) {
        this.logger?.info("Iteration budget exhausted, stopping loop");
        if (effectiveRunPolicy.mode === "bounded") {
          finalStatus = "max_iterations";
        }
        break;
      }
      const budgetGate = await this.evaluateRuntimeBudgetGate(goalId, runtimeBudgetId);
      if (budgetGate.stop) {
        finalStatus = budgetGate.finalStatus;
        break;
      }

      void this.deps.hookManager?.emit("LoopCycleStart", { goal_id: goalId, data: { loopIndex } });

      let iterationResult: LoopIterationResult;
      try {
        iterationResult = this.config.treeMode && this.deps.treeLoopOrchestrator
          ? await this.runTreeIteration(goalId, loopIndex, nodeConsumedMap, runtimeBudgetId, abortSignal)
          : await this.runOneIteration(goalId, loopIndex, loopIndex === startLoopIndex, runtimeBudgetId, abortSignal);
      } catch (err) {
        if (abortSignal?.aborted) {
          finalStatus = "stopped";
          break;
        }
        const msg = err instanceof Error ? err.message : String(err);
        this.logger?.error(`[CoreLoop] unexpected error in iteration ${loopIndex}: ${msg}`);
        decisionCounters = {
          ...decisionCounters,
          consecutiveErrors: decisionCounters.consecutiveErrors + 1,
        };
        if (decisionCounters.consecutiveErrors >= this.config.maxConsecutiveErrors) {
          finalStatus = "error";
          break;
        }
        continue;
      }

      // Carry forward gapAggregate from the previous iteration when this one was skipped.
      if (iterationResult.skipped && iterations.length >= 1) {
        iterationResult.gapAggregate = iterations[iterations.length - 1]!.gapAggregate;
      }

      // Only consume budget for non-skipped iterations.
      if (!iterationResult.skipped) {
        const { allowed, warnings } = budget ? budget.consume() : { allowed: true, warnings: [] };
        for (const w of warnings) { this.logger?.warn(w); }
        if (!allowed) {
          this.logger?.info("Iteration budget exhausted, stopping loop");
          break;
        }
      }
      await this.recordRuntimeBudgetUsage(runtimeBudgetId, iterationResult);
      await this.recordOperatorHandoffForIteration(goalId, runtimeBudgetId, iterationResult);
      void this.deps.hookManager?.emit("LoopCycleEnd", { goal_id: goalId, data: { loopIndex, status: iterationResult.error ? "error" : "ok" } });

      iterations.push(iterationResult);
      // Accumulate token usage from iteration.
      totalTokens += iterationResult.tokensUsed ?? 0;

      if (!this.config.dryRun && dreamCollector) {
        try {
          await dreamCollector.appendIterationResult({
            goalId,
            sessionId,
            iterationResult,
          });
        } catch (err) {
          this.logger?.warn("CoreLoop: failed to persist dream iteration log", {
            goalId,
            loopIndex,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Save checkpoint after each successful verify step (§4.8)
      if (!this.config.dryRun && iterationResult.error === null && iterationResult.taskResult !== null) {
        await saveLoopCheckpoint(
          this.deps.stateManager,
          goalId,
          loopIndex,
          iterationResult,
          this.config.adapterType,
          this.deps.trustManager,
          this.logger
        );
      }

      const runDecision = this.coreDecisionEngine.evaluateRunDecision({
        iterationResult,
        loopIndex,
        minIterations: this.config.minIterations ?? 1,
        maxConsecutiveErrors: this.config.maxConsecutiveErrors,
        counters: decisionCounters,
      });
      decisionCounters = runDecision.counters;
      if (runDecision.shouldStop && runDecision.finalStatus) {
        finalStatus = runDecision.finalStatus;
        if (finalStatus === "completed" || finalStatus === "stalled") {
          void this.deps.hookManager?.emit("GoalStateChange", { goal_id: goalId, data: { newStatus: finalStatus } });
        }
        break;
      }

      if (this.stopped) {
        finalStatus = "stopped";
        break;
      }

      // Periodic learning review
      await this.learning.checkPeriodicReview(goalId, this.deps, this.logger);

      // Gap 4: derive a PacingResult from this iteration to feed adaptive delay.
      if (this.timeHorizonEngine) {
        // Build velocity history from accumulated iterations
        let elapsedMs = 0;
        const startMs = new Date(startedAt).getTime();
        const gapHistory = iterations.map((it) => {
          elapsedMs += it.elapsedMs;
          return {
            timestamp: new Date(startMs + elapsedMs).toISOString(),
            normalizedGap: it.gapAggregate,
          };
        });
        this.lastPacingResult = this.timeHorizonEngine.evaluatePacing(
          goalId,
          iterationResult.gapAggregate,
          goal.deadline ?? null,
          gapHistory
        );
      }

      // Delay between loops (skip on last iteration)
      const shouldDelay =
        this.config.delayBetweenLoopsMs > 0 &&
        (!hasIterationCap || loopIndex < startLoopIndex + effectiveMaxIterations - 1);
      if (shouldDelay) {
        // Gap 4: adaptive observation frequency — scale delay by pacing status when
        // a TimeHorizonEngine is available. Falls back to fixed delayBetweenLoopsMs.
        let delay = this.config.delayBetweenLoopsMs;
        if (this.timeHorizonEngine && this.lastPacingResult) {
          delay = this.timeHorizonEngine.suggestObservationInterval(this.lastPacingResult, delay);
        }
        await sleep(delay);
      }
    }

    // Run post-loop hooks (curiosity, memory lifecycle, archive, final report)
    const completedAt = new Date().toISOString();
    await runPostLoopHooks({
      goalId,
      sessionId,
      runId: this.currentActivationContext?.backgroundRun?.backgroundRunId,
      completedAt,
      totalTokensUsed: totalTokens,
      finalStatus,
      iterations,
      deps: this.deps,
      config: this.config,
      logger: this.logger,
      tryGenerateReport: (id, idx, r, g) => generateLoopReport(id, idx, r, g, this.deps.reportingEngine, this.logger),
    });

    if (finalStatus === "completed") {
      await this.learning.onGoalCompleted(goalId, this.deps, this.logger);
    }

    return {
      goalId,
      totalIterations: iterations.length,
      finalStatus,
      iterations,
      startedAt,
      completedAt,
      tokensUsed: totalTokens,
    };
    } finally {
      abortSignal?.removeEventListener("abort", abortFromParent);
      this.currentActivationContext = undefined;
      depsWithMutableProgress.onProgress = previousOnProgress;
      this.config.maxIterations = previousMaxIterations;
      this.config.runPolicy = previousRunPolicy;
    }
  }

  /**
   * Run a single iteration of the loop.
   */
  async runOneIteration(
    goalId: string,
    loopIndex: number,
    isFirstIteration?: boolean,
    runtimeBudgetId?: string | null,
    abortSignal?: AbortSignal
  ): Promise<LoopIterationResult> {
    const result = await new CoreIterationKernel({
      deps: this.deps,
      getConfig: () => this.config,
      setConfig: (nextConfig) => {
        this.config = nextConfig;
      },
      logger: this.logger,
      stateDiff: this.stateDiff,
      stateDiffState: this.stateDiffState,
      decomposedGoals: this.decomposedGoals,
      timeHorizonEngine: this.timeHorizonEngine,
      corePhasePolicyRegistry: this.corePhasePolicyRegistry,
      coreDecisionEngine: this.coreDecisionEngine,
      capabilityFailures: this.learning.getCapabilityFailures(),
      incrementTransferCounter: () => this.learning.incrementTransferCounter(),
      getPendingDirective: (id) => this.pendingIterationDirectives.get(id),
      getActivationContext: () => this.currentActivationContext,
      getRuntimeBudgetContext: () => this.loadRuntimeBudgetTaskContext(runtimeBudgetId),
    }).run({ goalId, loopIndex, isFirstIteration, abortSignal });
    if (result.nextIterationDirective) {
      this.pendingIterationDirectives.set(goalId, result.nextIterationDirective);
    } else {
      this.pendingIterationDirectives.delete(goalId);
    }
    return result;
  }

  /**
   * Tree-mode iteration: select one node via TreeLoopOrchestrator, run a
   * normal observe→gap→score→task cycle on that node, then aggregate upward.
   */
  async runTreeIteration(
    rootId: string,
    loopIndex: number,
    nodeConsumedMap: Map<string, number>,
    runtimeBudgetId?: string | null,
    abortSignal?: AbortSignal
  ): Promise<LoopIterationResult> {
    return runTreeIterationImpl(rootId, loopIndex, this.deps, this.config, this.logger,
      (id, idx) => this.runOneIteration(id, idx, undefined, runtimeBudgetId, abortSignal), nodeConsumedMap, {
        getPendingDirective: (id) => this.pendingIterationDirectives.get(id),
      });
  }

  /**
   * Run one iteration of the multi-goal loop.
   */
  async runMultiGoalIteration(loopIndex: number): Promise<LoopIterationResult> {
    return runMultiGoalIterationImpl(loopIndex, this.deps, this.config,
      (id, idx) => this.runOneIteration(id, idx), {
        getPendingDirective: (id) => this.pendingIterationDirectives.get(id),
      });
  }

  /**
   * Stop the loop externally (e.g., on SIGTERM).
   */
  stop(): void {
    this.stopped = true;
  }

  /**
   * Attach a TimeHorizonEngine for adaptive observation frequency (Gap 4).
   * When set, the delay between iterations is scaled by pacing status instead
   * of using the fixed delayBetweenLoopsMs value.
   */
  setTimeHorizonEngine(engine: ITimeHorizonEngine): void {
    this.timeHorizonEngine = engine;
  }

  setWaitApprovalBroker(broker: CoreLoopDeps["waitApprovalBroker"]): void {
    (this.deps as CoreLoopDeps).waitApprovalBroker = broker;
  }

  /**
   * Check if the loop has been stopped.
   */
  isStopped(): boolean {
    return this.stopped;
  }

  private async ensureRuntimeBudgetForRun(input: {
    goalId: string;
    startedAt: string;
    runId?: string;
    hasIterationCap: boolean;
    effectiveMaxIterations: number | null;
  }): Promise<string | null> {
    if (this.config.dryRun || !this.deps.runtimeBudgetStore) return null;
    const configuredLimits = this.config.runtimeBudget?.limits;
    const defaultLimits: RuntimeBudgetLimitInput[] =
      configuredLimits ?? (
        input.hasIterationCap && input.effectiveMaxIterations !== null
          ? [{
              dimension: "iterations",
              limit: input.effectiveMaxIterations,
              approval_at_remaining: 0,
              finalization_at_remaining: 0,
              exhaustion_policy: "approval_required",
            }]
          : []
      );
    if (defaultLimits.length === 0) return null;
    const budgetId = this.config.runtimeBudget?.budgetId
      ?? `runtime-budget:${input.runId ?? `goal:${input.goalId}`}`;
    const existing = await this.deps.runtimeBudgetStore.load(budgetId);
    if (existing) return budgetId;
    try {
      await this.deps.runtimeBudgetStore.create({
        budget_id: budgetId,
        scope: {
          goal_id: input.goalId,
          ...(input.runId ? { run_id: input.runId } : {}),
        },
        title: this.config.runtimeBudget?.title ?? `Runtime budget for ${input.goalId}`,
        created_at: input.startedAt,
        limits: defaultLimits,
      });
    } catch (err) {
      const loaded = await this.deps.runtimeBudgetStore.load(budgetId);
      if (!loaded) throw err;
    }
    return budgetId;
  }

  private async evaluateRuntimeBudgetGate(goalId: string, budgetId: string | null): Promise<{
    stop: boolean;
    finalStatus: LoopResult["finalStatus"];
  }> {
    const status = await this.loadRuntimeBudgetStatus(budgetId);
    if (!status) return { stop: false, finalStatus: "stopped" };
    if (status.finalization_required || status.handoff_required) {
      await this.recordBudgetOperatorHandoff(goalId, status);
    }
    if (status.finalization_required) return { stop: true, finalStatus: "finalization" };
    if (status.dimensions.some((dimension) => dimension.exhausted && dimension.exhaustion_policy === "stop")) {
      return { stop: true, finalStatus: "stopped" };
    }
    if (!status.exhausted && !status.approval_required && !status.handoff_required) {
      return { stop: false, finalStatus: "stopped" };
    }
    if (status.approval_required && this.deps.waitApprovalBroker) {
      const approved = await this.deps.waitApprovalBroker.requestApproval(
        goalId,
        {
          id: `budget:${status.budget_id}`,
          description: `Runtime budget threshold reached for ${status.budget_id}.`,
          action: "continue_after_budget_threshold",
        },
        undefined,
        `budget:${status.budget_id}`,
      );
      if (approved) return { stop: false, finalStatus: "stopped" };
    }
    await this.recordBudgetOperatorHandoff(goalId, status);
    return { stop: true, finalStatus: "stopped" };
  }

  private async loadRuntimeBudgetTaskContext(budgetId: string | null | undefined): Promise<Record<string, unknown> | undefined> {
    if (!budgetId || !this.deps.runtimeBudgetStore) return undefined;
    const budget = await this.deps.runtimeBudgetStore.load(budgetId);
    return budget ? this.deps.runtimeBudgetStore.taskGenerationContext(budget) : undefined;
  }

  private async loadRuntimeBudgetStatus(budgetId: string | null | undefined): Promise<RuntimeBudgetStatus | null> {
    const budget = await this.loadRuntimeBudgetRecord(budgetId);
    return budget && this.deps.runtimeBudgetStore ? this.deps.runtimeBudgetStore.status(budget) : null;
  }

  private async loadRuntimeBudgetRecord(budgetId: string | null | undefined): Promise<RuntimeBudgetRecord | null> {
    if (!budgetId || !this.deps.runtimeBudgetStore) return null;
    return this.deps.runtimeBudgetStore.load(budgetId);
  }

  private async recordRuntimeBudgetUsage(budgetId: string | null, iterationResult: LoopIterationResult): Promise<void> {
    if (!budgetId || !this.deps.runtimeBudgetStore || this.config.dryRun) return;
    try {
      await this.deps.runtimeBudgetStore.recordTaskExecution(budgetId, {
        iterations: 1,
        tasks: iterationResult.taskResult ? 1 : 0,
        process_ms: Math.max(0, iterationResult.elapsedMs),
        wall_clock_ms: Math.max(0, iterationResult.elapsedMs),
        reason: `coreloop iteration ${iterationResult.loopIndex}`,
      });
      if (iterationResult.tokensUsed && iterationResult.tokensUsed > 0) {
        await this.deps.runtimeBudgetStore.recordToolUsage(budgetId, {
          llm_tokens: iterationResult.tokensUsed,
          reason: `coreloop iteration ${iterationResult.loopIndex}`,
        });
      }
      const artifactCount = iterationResult.taskResult?.verificationResult.file_diffs?.length
        ?? 0;
      if (artifactCount > 0) {
        await this.deps.runtimeBudgetStore.recordArtifactGeneration(budgetId, {
          artifacts: artifactCount,
          reason: `coreloop iteration ${iterationResult.loopIndex}`,
        });
      }
    } catch (err) {
      this.logger?.warn("CoreLoop: failed to record runtime budget usage", {
        budgetId,
        goalId: iterationResult.goalId,
        loopIndex: iterationResult.loopIndex,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async recordOperatorHandoffForIteration(
    goalId: string,
    budgetId: string | null,
    iterationResult: LoopIterationResult
  ): Promise<void> {
    if (this.config.dryRun || !this.deps.operatorHandoffStore) return;
    const finalization = iterationResult.finalizationStatus;
    if (!finalization) return;
    const plan = finalization.finalization_plan;
    const isDeadlineWindow = finalization.mode === "finalization" || finalization.mode === "missed_deadline";
    if (!isDeadlineWindow && !plan?.handoff_required) return;

    const approvalActions = plan?.approval_required_actions ?? [];
    const triggers: RuntimeOperatorHandoffTrigger[] = ["deadline", "finalization"];
    if (approvalActions.length > 0) triggers.push("external_action");
    if (plan?.reproducibility_manifest.status === "required_missing") triggers.push("policy");

    const firstAction = approvalActions[0];
    const bestArtifact = plan?.best_artifact ?? null;
    await this.createOperatorHandoff({
      handoff_id: `handoff:${this.currentActivationContext?.backgroundRun?.backgroundRunId ?? goalId}:deadline-finalization`,
      goal_id: goalId,
      ...(this.currentActivationContext?.backgroundRun?.backgroundRunId
        ? { run_id: this.currentActivationContext.backgroundRun.backgroundRunId }
        : {}),
      triggers: uniqueTriggers(triggers),
      title: `Operator handoff: ${goalId}`,
      summary: finalization.reason,
      current_status: [
        `mode=${finalization.mode}`,
        finalization.deadline ? `deadline=${finalization.deadline}` : null,
        finalization.remaining_ms !== null ? `remaining_ms=${finalization.remaining_ms}` : null,
        budgetId ? `budget=${budgetId}` : null,
      ].filter(Boolean).join(", "),
      recommended_action: approvalActions.length > 0
        ? `Review and approve required finalization action: ${approvalActions.map((action) => action.label).join(", ")}.`
        : "Review the deadline finalization state before continuing autonomous work.",
      candidate_options: bestArtifact
        ? [{
            id: bestArtifact.id ?? bestArtifact.path ?? bestArtifact.state_relative_path ?? "best_artifact",
            label: bestArtifact.label,
            tradeoff: bestArtifact.summary ?? "Use the current best observable artifact for handoff/finalization.",
          }]
        : [],
      risks: [
        "Continuing autonomous exploration may miss or has already missed the deadline window.",
        ...(approvalActions.length > 0 ? ["External or irreversible finalization actions remain blocked until approval."] : []),
      ],
      required_approvals: approvalActions.map((action) => action.label),
      next_action: {
        label: firstAction?.label ?? "Review deadline finalization",
        ...(firstAction?.tool_name ? { tool_name: firstAction.tool_name } : {}),
        ...(firstAction?.payload_ref ? { payload_ref: firstAction.payload_ref } : {}),
        approval_required: true,
      },
      gate: {
        autonomous_task_generation: isDeadlineWindow ? "pause" : "constrain",
        external_action_requires_approval: true,
      },
      evidence_refs: [
        { kind: "deadline_finalization_status", ref: `goal:${goalId}:iteration:${iterationResult.loopIndex}`, observed_at: finalization.evaluated_at },
        ...(bestArtifact?.path ? [{ kind: bestArtifact.kind ?? "artifact", ref: bestArtifact.path, observed_at: bestArtifact.occurred_at }] : []),
        ...(bestArtifact?.state_relative_path ? [{ kind: "state_artifact", ref: bestArtifact.state_relative_path, observed_at: bestArtifact.occurred_at }] : []),
      ],
      created_at: finalization.evaluated_at,
    });
  }

  private async recordBudgetOperatorHandoff(goalId: string, status: RuntimeBudgetStatus): Promise<void> {
    if (this.config.dryRun || !this.deps.operatorHandoffStore) return;
    if (!status.handoff_required && !status.approval_required && !status.finalization_required) return;
    const approvalRequestId = `budget:${status.budget_id}`;
    await this.createOperatorHandoff({
      handoff_id: approvalRequestId,
      goal_id: goalId,
      ...(status.scope.run_id ? { run_id: status.scope.run_id } : {}),
      triggers: ["budget"],
      title: `Budget handoff: ${status.budget_id}`,
      summary: "Runtime budget threshold reached before autonomous work can continue.",
      current_status: status.dimensions
        .map((dimension) => `${dimension.dimension}: used=${dimension.used}/${dimension.limit}, remaining=${dimension.remaining}`)
        .join("; "),
      recommended_action: "Review budget usage and approve, finalize, or pause the run.",
      risks: ["Continuing without an operator decision can exceed the configured runtime budget."],
      required_approvals: status.approval_required ? ["continue_after_budget_threshold"] : [],
      ...(status.approval_required ? { approval_request_id: approvalRequestId } : {}),
      next_action: {
        label: status.finalization_required ? "Finalize run" : "Review budget threshold",
        approval_required: true,
      },
      gate: {
        autonomous_task_generation: status.finalization_required || status.handoff_required ? "pause" : "constrain",
        external_action_requires_approval: true,
      },
      evidence_refs: [{ kind: "runtime_budget", ref: status.budget_id }],
    });
  }

  private async createOperatorHandoff(input: RuntimeOperatorHandoffInput): Promise<void> {
    try {
      await this.deps.operatorHandoffStore?.create(input);
    } catch (err) {
      this.logger?.warn("CoreLoop: failed to record operator handoff", {
        goalId: input.goal_id,
        handoffId: input.handoff_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

}

function uniqueTriggers(triggers: RuntimeOperatorHandoffTrigger[]): RuntimeOperatorHandoffTrigger[] {
  return [...new Set(triggers)];
}

export { CoreLoop as DurableLoop };
