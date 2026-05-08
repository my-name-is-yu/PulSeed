import { randomUUID } from "node:crypto";
import type { Goal } from "../../../base/types/goal.js";
import type { GapHistoryEntry } from "../../../base/types/gap.js";
import type { StallReport } from "../../../base/types/stall.js";
import type { MetricTrendContext } from "../../../platform/drive/metric-history.js";
import type { RuntimeFailedLineageContext } from "../../../runtime/store/evidence-ledger.js";
import type { GapObservation } from "../../../base/types/time-horizon.js";
import {
  selectMetricTrendForDimension,
  summarizeEvidenceMetricTrends,
} from "../../../runtime/store/metric-history.js";
import { gatherStallEvidence } from "../stall-evidence.js";
import type { LoopIterationResult } from "./contracts.js";
import type { PhaseCtx } from "./preparation.js";
import {
  buildDecisionLineageForStrategy,
  type WaitStrategyActivationContext,
} from "../../strategy/strategy-manager-base.js";
import { collectDivergentHypotheses } from "../../strategy/divergent-exploration.js";

type DimensionGapSample = {
  normalized_gap: number;
  timestamp: string;
};

export interface StallActionHints {
  recommendedAction?: "continue" | "refine" | "pivot";
}

type StrategyStallArgs = [
  goalId: string,
  stallCount: number,
  goalType?: string,
  activationContext?: WaitStrategyActivationContext,
  metricTrendContext?: MetricTrendContext,
  failedLineages?: RuntimeFailedLineageContext[],
];

type DivergentExplorationPlanner = {
  prepareDivergentExplorationOnStall?: (
    goalId: string,
    input: {
      primaryDimension: string;
      targetDimensions: string[];
      currentGap: number;
      stallCount: number;
      trigger: "sustained_stall" | "predicted_plateau" | "predicted_regression";
      metricTrendContext?: MetricTrendContext;
      failedLineages?: RuntimeFailedLineageContext[];
    }
  ) => Promise<unknown>;
};

function resolveGoalWorkspacePath(goal: Goal): string | undefined {
  const constraint = goal.constraints.find((entry) => entry.startsWith("workspace_path:"));
  const workspacePath = constraint?.slice("workspace_path:".length).trim();
  return workspacePath || undefined;
}

function indexGapHistoryByDimension(
  goal: Goal,
  gapHistory: GapHistoryEntry[]
): Map<string, DimensionGapSample[]> {
  const indexedHistory = new Map<string, DimensionGapSample[]>();

  for (const dim of goal.dimensions) {
    indexedHistory.set(dim.name, []);
  }

  for (const entry of gapHistory) {
    const seenDimensions = new Set<string>();
    for (const gap of entry.gap_vector) {
      if (seenDimensions.has(gap.dimension_name)) continue;
      seenDimensions.add(gap.dimension_name);

      const dimHistory = indexedHistory.get(gap.dimension_name);
      if (!dimHistory) {
        continue;
      }

      dimHistory.push({
        normalized_gap: gap.normalized_weighted_gap ?? 1,
        timestamp: entry.timestamp,
      });
    }
  }

  return indexedHistory;
}

function buildWaitStrategyActivationContext(
  ctx: PhaseCtx,
  goalId: string,
  goal: Goal,
  gapHistoryByDimension: ReadonlyMap<string, DimensionGapSample[]>
): WaitStrategyActivationContext | undefined {
  if (!ctx.timeHorizonEngine) {
    return undefined;
  }

  const velocityByDimension = new Map<string, number>();
  for (const [dimensionName, dimHistory] of gapHistoryByDimension.entries()) {
    if (dimHistory.length < 2) continue;
    const currentGap = dimHistory[dimHistory.length - 1]?.normalized_gap;
    if (typeof currentGap !== "number" || !Number.isFinite(currentGap)) continue;
    const observations: GapObservation[] = dimHistory.map((entry) => ({
      timestamp: entry.timestamp,
      normalizedGap: entry.normalized_gap,
    }));
    const pacing = ctx.timeHorizonEngine.evaluatePacing(
      goalId,
      currentGap,
      goal.deadline ?? null,
      observations
    );
    if (Number.isFinite(pacing.velocityPerHour)) {
      velocityByDimension.set(dimensionName, pacing.velocityPerHour);
    }
  }

  return {
    getCurrentGap: (_goalId, dimension) => {
      const history = gapHistoryByDimension.get(dimension);
      return history && history.length > 0
        ? history[history.length - 1]?.normalized_gap ?? null
        : null;
    },
    canAffordWait: ({ strategy, waitHours, currentGap, initialGap, startedAt }) => {
      const velocityPerHour = velocityByDimension.get(strategy.primary_dimension);
      if (velocityPerHour === undefined) {
        return false;
      }
      const budget = ctx.timeHorizonEngine!.getTimeBudget(
        goal.deadline ?? null,
        goal.created_at ?? startedAt,
        currentGap,
        initialGap,
        velocityPerHour
      );
      return budget.canAffordWait(waitHours);
    },
  };
}

async function applyStallAction(
  ctx: PhaseCtx,
  goalId: string,
  goal: Goal,
  dimHistory: DimensionGapSample[],
  stallReport: StallReport,
  escalationLevel: number,
  incrementDimName: string,
  result: LoopIterationResult,
  logPrefix: string,
  stallActionHints?: StallActionHints,
  waitActivationContext?: WaitStrategyActivationContext
): Promise<void> {
  if (ctx.deps.learningPipeline) {
    try {
      await ctx.deps.learningPipeline.onStallDetected(goalId, stallReport);
    } catch {
      // non-fatal
    }
  }

  const activeStrategyForRecord = await Promise.resolve(ctx.deps.strategyManager.getActiveStrategy(goalId)).catch(() => null);
  const strategyIdForRecord = activeStrategyForRecord?.id ?? "unknown";
  const metricTrendContext = stallReport.metric_trend_context;
  const failedLineages = await loadFailedLineageContexts(ctx, goalId);
  if (metricTrendContext) {
    result.metricTrendContext = metricTrendContext;
    ctx.logger?.info(`CoreLoop: ${logPrefix}metric trend evidence — ${metricTrendContext.summary}`, {
      goalId,
      metricTrend: metricTrendContext.trend,
      metricKey: metricTrendContext.metric_key,
      latestValue: metricTrendContext.latest_value,
      bestValue: metricTrendContext.best_value,
    });
  }
  const analysis = ctx.deps.stallDetector.analyzeStallCause?.(dimHistory);
  result.stallAnalysis = analysis;
  const selectedAction = analysis?.recommended_action === "escalate"
    ? "escalate"
    : stallActionHints?.recommendedAction ?? analysis?.recommended_action ?? "pivot";

  if (selectedAction === "continue") {
    ctx.logger?.info(`CoreLoop: ${logPrefix}stall CONTINUE — replanning evidence prefers continuing current strategy`, {
      goalId,
      evidence: analysis?.evidence,
    });
  } else if (stallReport.suggested_cause === "information_deficit" && ctx.deps.goalRefiner) {
    ctx.logger?.info(`CoreLoop: ${logPrefix}observation-failure stall — calling reRefineLeaf`, { goalId });
    try {
      await ctx.deps.goalRefiner.reRefineLeaf(goalId, stallReport.suggested_cause!);
    } catch (reRefineErr) {
      ctx.logger?.warn(`CoreLoop: ${logPrefix}reRefineLeaf failed (non-fatal)`, {
        goalId,
        err: reRefineErr instanceof Error ? reRefineErr.message : String(reRefineErr),
      });
    }
  } else if (selectedAction === "refine") {
    ctx.logger?.info(`CoreLoop: ${logPrefix}stall REFINE — parameter_issue detected, keeping strategy`, {
      goalId,
      evidence: analysis?.evidence,
    });
  } else if (selectedAction === "escalate") {
    ctx.logger?.warn(`CoreLoop: ${logPrefix}stall ESCALATE — goal_unreachable detected`, {
      goalId,
      evidence: analysis?.evidence,
    });
    await callStrategyOnStall(ctx, [
      goalId,
      3,
      goal.origin ?? "general",
      waitActivationContext,
      metricTrendContext,
      failedLineages,
    ]);
    await appendDivergentRecoveryEvidence(ctx, goalId, result, stallReport);
    result.pivotOccurred = true;
  } else {
    const portfolio = await ctx.deps.strategyManager.getPortfolio(goalId);
    const activeStrategy = portfolio?.strategies.find((s) => s.state === "active");
    const pivotCount = activeStrategy?.pivot_count ?? 0;
    const maxPivotCount = activeStrategy?.max_pivot_count ?? 2;

    if (pivotCount >= maxPivotCount) {
      ctx.logger?.warn(`CoreLoop: ${logPrefix}stall auto-ESCALATE — pivot_count limit reached`, {
        goalId,
        pivotCount,
        maxPivotCount,
      });
      await callStrategyOnStall(ctx, [
        goalId,
        3,
        goal.origin ?? "general",
        waitActivationContext,
        metricTrendContext,
        failedLineages,
      ]);
      await appendDivergentRecoveryEvidence(ctx, goalId, result, stallReport);
      result.pivotOccurred = true;
    } else {
      const newStrategy = await callStrategyOnStall(ctx, [
        goalId,
        escalationLevel + 1,
        goal.origin ?? "general",
        waitActivationContext,
        metricTrendContext,
        failedLineages,
      ]);
      if (newStrategy) {
        await appendDivergentRecoveryEvidence(ctx, goalId, result, stallReport);
        result.pivotOccurred = true;
        if (activeStrategy?.id) {
          try {
            await ctx.deps.strategyManager.incrementPivotCount(goalId, activeStrategy.id);
          } catch {
            // non-fatal
          }
        }
      }
    }
  }

  if (ctx.deps.knowledgeManager) {
    try {
      const latestGap = dimHistory[dimHistory.length - 1]?.normalized_gap ?? 1;
      const recordedDecision = selectedAction === "continue" ? "proceed" : selectedAction;
      const decisionLineage = buildDecisionLineageForStrategy(activeStrategyForRecord);
      await ctx.deps.knowledgeManager.recordDecision({
        id: randomUUID(),
        goal_id: goalId,
        goal_type: goal.origin ?? "general",
        strategy_id: strategyIdForRecord,
        hypothesis: activeStrategyForRecord?.hypothesis,
        ...(decisionLineage ? { lineage: decisionLineage } : {}),
        decision: recordedDecision,
        context: {
          gap_value: latestGap,
          stall_count: stallReport.escalation_level,
          cycle_count: dimHistory.length,
          trust_score: 0,
        },
        outcome: "pending",
        timestamp: new Date().toISOString(),
        what_worked: [],
        what_failed: [],
        suggested_next: [],
      });
    } catch {
      // non-fatal
    }
  }

  if (incrementDimName) {
    await ctx.deps.stallDetector.incrementEscalation(goalId, incrementDimName);
  }
}

async function callStrategyOnStall(
  ctx: PhaseCtx,
  args: StrategyStallArgs
) {
  const [goalId, stallCount, goalType, activationContext, metricTrendContext] = args;
  const failedLineages = args[5];
  const hasFailedLineages = failedLineages !== undefined && failedLineages.length > 0;
  if (metricTrendContext) {
    return hasFailedLineages
      ? ctx.deps.strategyManager.onStallDetected(
        goalId,
        stallCount,
        goalType,
        activationContext,
        metricTrendContext,
        failedLineages
      )
      : ctx.deps.strategyManager.onStallDetected(
        goalId,
        stallCount,
        goalType,
        activationContext,
        metricTrendContext
      );
  }
  return hasFailedLineages
    ? ctx.deps.strategyManager.onStallDetected(
      goalId,
      stallCount,
      goalType,
      activationContext,
      undefined,
      failedLineages
    )
    : ctx.deps.strategyManager.onStallDetected(goalId, stallCount, goalType, activationContext);
}

async function loadMetricTrendContexts(ctx: PhaseCtx, goalId: string): Promise<MetricTrendContext[]> {
  const readByGoal = ctx.deps.evidenceLedger?.readByGoal;
  if (!readByGoal) return [];
  try {
    const read = await readByGoal.call(ctx.deps.evidenceLedger, goalId);
    return summarizeEvidenceMetricTrends(read.entries);
  } catch (err) {
    ctx.logger?.warn("CoreLoop: metric trend history unavailable (non-fatal)", {
      goalId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

async function loadFailedLineageContexts(ctx: PhaseCtx, goalId: string): Promise<RuntimeFailedLineageContext[]> {
  const summarizeGoal = ctx.deps.evidenceLedger?.summarizeGoal;
  if (!summarizeGoal) return [];
  try {
    const summary = await summarizeGoal.call(ctx.deps.evidenceLedger, goalId);
    return summary.failed_lineages;
  } catch (err) {
    ctx.logger?.warn("CoreLoop: failed lineage summary unavailable (non-fatal)", {
      goalId,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

async function appendDivergentRecoveryEvidence(
  ctx: PhaseCtx,
  goalId: string,
  result: LoopIterationResult,
  stallReport: StallReport
): Promise<void> {
  let hypotheses: ReturnType<typeof collectDivergentHypotheses> = [];
  try {
    const portfolio = await ctx.deps.strategyManager.getPortfolio(goalId);
    hypotheses = collectDivergentHypotheses(portfolio?.strategies ?? []);
  } catch {
    return;
  }
  if (hypotheses.length === 0) return;

  result.divergentExploration = {
    trigger: stallReport.stall_type === "predicted_plateau" || stallReport.stall_type === "predicted_regression"
      ? stallReport.stall_type
      : stallReport.stall_type === "global_stall"
        ? "global_stall"
        : "dimension_stall",
    candidates: hypotheses,
  };

  const append = ctx.deps.evidenceLedger?.append;
  if (!append) return;
  try {
    const entries = await append.call(ctx.deps.evidenceLedger, {
      kind: "strategy",
      scope: { goal_id: goalId, loop_index: result.loopIndex, phase: "divergent_stall_recovery" },
      divergent_exploration: hypotheses,
      outcome: "continued",
      summary: `Divergent stall recovery proposed ${hypotheses.length} speculative hypothesis candidate(s).`,
      raw_refs: stallReport.metric_trend_context?.source_refs.flatMap((source) =>
        source.raw_refs?.map((ref) => ({
          kind: ref.kind,
          id: ref.id,
          path: ref.path,
          state_relative_path: ref.state_relative_path,
          url: ref.url,
        })) ?? []
      ) ?? [],
    });
    result.divergentExploration.evidenceEntryId = entries[0]?.id;
  } catch (err) {
    ctx.logger?.warn("CoreLoop: divergent stall recovery evidence write failed (non-fatal)", {
      goalId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function requestPredictedDivergentExploration(
  ctx: PhaseCtx,
  goalId: string,
  goal: Goal,
  dimHistory: DimensionGapSample[],
  stallReport: StallReport,
  result: LoopIterationResult,
  trigger: "predicted_plateau" | "predicted_regression"
): Promise<void> {
  const planner = ctx.deps.strategyManager as unknown as DivergentExplorationPlanner;
  if (!planner.prepareDivergentExplorationOnStall) return;
  const dimension = stallReport.dimension_name ?? goal.dimensions[0]?.name ?? "";
  const failedLineages = await loadFailedLineageContexts(ctx, goalId);
  try {
    await planner.prepareDivergentExplorationOnStall(goalId, {
      primaryDimension: dimension,
      targetDimensions: goal.dimensions.map((entry) => entry.name),
      currentGap: dimHistory[dimHistory.length - 1]?.normalized_gap ?? 1,
      stallCount: Math.max(2, stallReport.escalation_level),
      trigger,
      ...(stallReport.metric_trend_context ? { metricTrendContext: stallReport.metric_trend_context } : {}),
      ...(failedLineages.length > 0 ? { failedLineages } : {}),
    });
    await appendDivergentRecoveryEvidence(ctx, goalId, result, stallReport);
  } catch (err) {
    ctx.logger?.warn("CoreLoop: predicted plateau divergent exploration failed (non-fatal)", {
      goalId,
      trigger,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function checkGlobalStall(
  ctx: PhaseCtx,
  goalId: string,
  goal: Goal,
  result: LoopIterationResult,
  gapHistoryByDimension: Map<string, DimensionGapSample[]>,
  suppressedDimensions: ReadonlySet<string>,
  stallActionHints?: StallActionHints,
  waitActivationContext?: WaitStrategyActivationContext
): Promise<void> {
  const activeGapHistoryByDimension =
    suppressedDimensions.size === 0
      ? gapHistoryByDimension
      : new Map(
          Array.from(gapHistoryByDimension.entries()).filter(
            ([dimensionName]) => !suppressedDimensions.has(dimensionName)
          )
        );
  if (activeGapHistoryByDimension.size === 0) {
    return;
  }

  const globalStall = ctx.deps.stallDetector.checkGlobalStall(goalId, activeGapHistoryByDimension);
  if (!globalStall) return;

  result.stallDetected = true;
  result.stallReport = globalStall;

  const firstActiveDimension =
    goal.dimensions.find((dimension) => !suppressedDimensions.has(dimension.name))?.name
    ?? activeGapHistoryByDimension.keys().next().value
    ?? "";
  const firstDimHistory = activeGapHistoryByDimension.get(firstActiveDimension) ?? [];

  await applyStallAction(
    ctx,
    goalId,
    goal,
    firstDimHistory,
    globalStall,
    1,
    firstActiveDimension,
    result,
    "global ",
    stallActionHints,
    waitActivationContext
  );
}

async function rebalancePortfolio(
  ctx: PhaseCtx,
  goalId: string,
  goal: Goal,
  waitActivationContext?: WaitStrategyActivationContext
): Promise<void> {
  if (!ctx.deps.portfolioManager) return;
  try {
    const rebalanceTrigger = await ctx.deps.portfolioManager.shouldRebalance(goalId);
    if (rebalanceTrigger) {
      const rebalanceResult = await ctx.deps.portfolioManager.rebalance(goalId, rebalanceTrigger);
      if (rebalanceResult.new_generation_needed) {
        await ctx.deps.strategyManager.onStallDetected(
          goalId,
          3,
          goal.origin ?? "general",
          waitActivationContext
        );
      }
    }
  } catch {
    // non-fatal
  }
}

export async function detectStallsAndRebalance(
  ctx: PhaseCtx,
  goalId: string,
  goal: Goal,
  result: LoopIterationResult,
  stallActionHints?: StallActionHints
): Promise<void> {
  try {
    const gapHistory = await ctx.deps.stateManager.loadGapHistory(goalId);
    const gapHistoryByDimension = indexGapHistoryByDimension(goal, gapHistory);
    const metricTrends = await loadMetricTrendContexts(ctx, goalId);
    const waitActivationContext = buildWaitStrategyActivationContext(
      ctx,
      goalId,
      goal,
      gapHistoryByDimension
    );

    if (ctx.toolExecutor) {
      try {
        const workspacePath = resolveGoalWorkspacePath(goal);
        const toolContext = {
          cwd: workspacePath ?? process.cwd(),
          goalId,
          trustBalance: 0,
          preApproved: true,
          approvalFn: async () => false,
        };
        const evidence = await gatherStallEvidence(ctx.toolExecutor, toolContext, workspacePath);
        result.toolStallEvidence = evidence;
        if (!evidence.hasWorkspaceChanges) {
          ctx.logger?.info("CoreLoop: stall evidence — no workspace changes detected", { goalId, toolErrors: evidence.toolErrors });
        }
      } catch {
        // Non-fatal
      }
    }

    const suppressedDimensions = new Set<string>();
    if (ctx.deps.portfolioManager) {
      try {
        const portfolio = await ctx.deps.strategyManager.getPortfolio(goalId);
        if (portfolio) {
          for (const s of portfolio.strategies) {
            if (s.state !== "active" || !ctx.deps.portfolioManager.isWaitStrategy(s)) continue;
            const ws = s as Record<string, unknown>;
            const waitUntil = typeof ws["wait_until"] === "string" ? ws["wait_until"] as string : null;
            if (!ctx.deps.stallDetector.isSuppressed(waitUntil)) continue;
            const primaryDim = typeof ws["primary_dimension"] === "string" ? ws["primary_dimension"] as string : null;
            if (primaryDim) {
              suppressedDimensions.add(primaryDim);
              ctx.logger?.info("CoreLoop: stall detection suppressed for dimension by active WaitStrategy", {
                goalId,
                dimension: primaryDim,
                waitUntil,
              });
              result.waitSuppressed = true;
            }
          }
        }
      } catch {
        // Non-fatal
      }
    }

    for (const dim of goal.dimensions) {
      if (suppressedDimensions.has(dim.name)) continue;
      const dimGapHistory = gapHistoryByDimension.get(dim.name) ?? [];
      const metricTrendContext = selectMetricTrendForDimension(metricTrends, dim.name);
      if (metricTrendContext) {
        result.metricTrendContext = metricTrendContext;
      }
      const stallReport = ctx.deps.stallDetector.checkDimensionStall(
        goalId,
        dim.name,
        dimGapHistory,
        undefined,
        metricTrendContext
      );

      if (stallReport) {
        result.stallDetected = true;
        result.stallReport = stallReport;

        if (
          stallReport.stall_type === "predicted_plateau" ||
          stallReport.stall_type === "predicted_regression"
        ) {
          ctx.logger?.info(
            `CoreLoop: early warning ${stallReport.stall_type} — requesting divergent exploration portfolio without pivot`,
            {
              goalId,
              metricTrend: stallReport.metric_trend_context?.summary,
            },
          );
          await requestPredictedDivergentExploration(
            ctx,
            goalId,
            goal,
            dimGapHistory,
            stallReport,
            result,
            stallReport.stall_type
          );
          continue;
        }

        const escalationLevel = await ctx.deps.stallDetector.getEscalationLevel(goalId, dim.name);
        await applyStallAction(
          ctx,
          goalId,
          goal,
          dimGapHistory,
          stallReport,
          escalationLevel,
          dim.name,
          result,
          "",
          stallActionHints,
          waitActivationContext
        );
        break;
      }
    }

    if (!result.stallDetected) {
      await checkGlobalStall(
        ctx,
        goalId,
        goal,
        result,
        gapHistoryByDimension,
        suppressedDimensions,
        stallActionHints,
        waitActivationContext
      );
    }

    if (ctx.deps.portfolioManager) {
      await rebalancePortfolio(ctx, goalId, goal, waitActivationContext);
    }
  } catch (err) {
    ctx.logger?.warn("CoreLoop: stall detection failed (non-fatal)", { error: err instanceof Error ? err.message : String(err) });
  }
}

export function buildWaitObservationActivationContext(
  ctx: PhaseCtx,
  goalId: string,
  goal: Goal,
  gapHistory: GapHistoryEntry[]
): WaitStrategyActivationContext | undefined {
  return buildWaitStrategyActivationContext(
    ctx,
    goalId,
    goal,
    indexGapHistoryByDimension(goal, gapHistory)
  );
}
