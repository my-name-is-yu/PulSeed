/**
 * portfolio-rebalance.ts
 *
 * Pure/stateless helpers for PortfolioManager rebalancing logic.
 * Functions here take configuration and data as explicit parameters
 * and return results without side effects (except via the provided
 * callbacks).
 */

import type {
  PortfolioConfig,
  EffectivenessRecord,
  RebalanceResult,
  AllocationAdjustment,
  RebalanceTrigger,
  TaskSelectionResult,
} from "../../base/types/portfolio.js";
import {
  normalizeWaitMetadata,
  resolveWaitNextObserveAt,
  type Strategy,
  type WaitMetadata,
  type WaitExpiryOutcome,
  type WaitStrategy,
} from "../../base/types/strategy.js";
import {
  approvalOutcomeFromWaitMetadata,
  type CapabilityAvailabilityProvider,
  evaluateWaitConditions,
  missingRequiredCapabilities,
  nextReobserveAt,
  persistWaitObservation,
} from "./portfolio-wait-observation.js";

export { buildWaitApprovalId } from "./portfolio-wait-observation.js";

/**
 * Get the current gap value for a specific dimension of a goal.
 * Reads from the caller-provided typed current-gap boundary.
 */
export async function getCurrentGapForDimension(
  goalId: string,
  dimension: string,
  getCurrentGap: (goalId: string, dimension: string) => number | null | Promise<number | null>
): Promise<number | null> {
  return getCurrentGap(goalId, dimension);
}

/**
 * Calculate gap delta attributed to a strategy using dimension-target matching.
 * Sums gap improvements across the strategy's target_dimensions.
 */
export async function calculateGapDeltaForStrategy(
  strategy: Strategy,
  goalId: string,
  getCurrentGap: (goalId: string, dimension: string) => number | null | Promise<number | null>
): Promise<number> {
  let totalDelta = 0;

  for (const dimension of strategy.target_dimensions) {
    const currentGap = await getCurrentGapForDimension(goalId, dimension, getCurrentGap);
    if (currentGap === null) continue;

    const baseline = strategy.gap_snapshot_at_start ?? 1.0;
    const delta = baseline - currentGap;
    totalDelta += delta;
  }

  return totalDelta;
}

/**
 * Calculate initial equal-split allocations for N strategies.
 * Single strategy: [1.0].
 * Multiple: equal split clamped to [min_allocation, max_allocation], sum = 1.0.
 */
export function calculateInitialAllocations(
  count: number,
  config: Pick<PortfolioConfig, "min_allocation" | "max_allocation">
): number[] {
  if (count === 1) return [1.0];

  const { min_allocation, max_allocation } = config;
  let base = 1.0 / count;

  base = Math.max(min_allocation, Math.min(max_allocation, base));

  const allocations = new Array<number>(count).fill(base);

  const sum = allocations.reduce((a, b) => a + b, 0);
  if (sum > 0 && Math.abs(sum - 1.0) > 0.001) {
    const factor = 1.0 / sum;
    for (let i = 0; i < allocations.length; i++) {
      allocations[i] = Math.max(
        min_allocation,
        Math.min(max_allocation, allocations[i] * factor)
      );
    }
    const finalSum = allocations.slice(0, -1).reduce((a, b) => a + b, 0);
    allocations[allocations.length - 1] = Math.max(
      min_allocation,
      1.0 - finalSum
    );
  }

  return allocations;
}

/**
 * Count how many consecutive recent rebalances a strategy has been the lowest scorer
 * (i.e., was adjusted down to min_allocation).
 */
export function countConsecutiveLowestRebalances(
  strategyId: string,
  history: RebalanceResult[],
  minAllocation: number
): number {
  let count = 0;

  for (let i = history.length - 1; i >= 0; i--) {
    const rebalance = history[i];
    const adjustment = rebalance.adjustments.find(
      (a) => a.strategy_id === strategyId
    );
    if (adjustment && adjustment.new_allocation <= minAllocation) {
      count++;
    } else {
      break;
    }
  }

  return count;
}

/**
 * Redistribute freed allocation proportionally among remaining strategies
 * based on effectiveness scores.
 *
 * Calls updateAllocation(goalId, strategyId, newAllocation) for each change.
 */
export function redistributeAllocation(
  goalId: string,
  remaining: Strategy[],
  records: EffectivenessRecord[],
  freedAllocation: number,
  config: Pick<PortfolioConfig, "max_allocation">,
  result: RebalanceResult,
  updateAllocation: (
    goalId: string,
    strategyId: string,
    allocation: number
  ) => void
): void {
  if (remaining.length === 0 || freedAllocation <= 0) return;

  const scoredRemaining = remaining.map((s) => {
    const record = records.find((r) => r.strategy_id === s.id);
    return {
      strategy: s,
      score: record?.effectiveness_score ?? 0,
    };
  });

  const totalScore = scoredRemaining.reduce(
    (sum, r) => sum + Math.max(r.score, 0),
    0
  );

  for (const { strategy, score } of scoredRemaining) {
    const proportion =
      totalScore > 0
        ? Math.max(score, 0) / totalScore
        : 1.0 / remaining.length;
    const additionalAllocation = freedAllocation * proportion;
    const oldAllocation = strategy.allocation;
    const newAllocation = Math.min(
      config.max_allocation,
      oldAllocation + additionalAllocation
    );

    if (Math.abs(newAllocation - oldAllocation) > 0.001) {
      updateAllocation(goalId, strategy.id, newAllocation);
      result.adjustments.push({
        strategy_id: strategy.id,
        old_allocation: oldAllocation,
        new_allocation: newAllocation,
        reason: "Redistribution from terminated strategy",
      });
    }
  }
}

/**
 * Adjust allocations based on effectiveness scores.
 * Increases high-performers, decreases low-performers.
 *
 * Calls updateAllocation(goalId, strategyId, newAllocation) for each change.
 */
export function adjustAllocations(
  goalId: string,
  strategies: Strategy[],
  scoredRecords: EffectivenessRecord[],
  config: Pick<PortfolioConfig, "min_allocation" | "max_allocation">,
  result: RebalanceResult,
  updateAllocation: (
    goalId: string,
    strategyId: string,
    allocation: number
  ) => void
): void {
  const sorted = [...scoredRecords].sort(
    (a, b) => (b.effectiveness_score ?? 0) - (a.effectiveness_score ?? 0)
  );

  const totalScore = sorted.reduce(
    (sum, r) => sum + Math.max(r.effectiveness_score ?? 0, 0),
    0
  );
  if (totalScore <= 0) return;

  const adjustments: AllocationAdjustment[] = [];
  const newAllocations: Map<string, number> = new Map();

  for (const record of sorted) {
    const strategy = strategies.find((s) => s.id === record.strategy_id);
    if (!strategy) continue;

    const proportion =
      Math.max(record.effectiveness_score ?? 0, 0) / totalScore;
    let targetAllocation = proportion;

    targetAllocation = Math.max(
      config.min_allocation,
      Math.min(config.max_allocation, targetAllocation)
    );

    newAllocations.set(strategy.id, targetAllocation);
  }

  const rawSum = Array.from(newAllocations.values()).reduce((a, b) => a + b, 0);
  if (rawSum > 0 && Math.abs(rawSum - 1.0) > 0.001) {
    const factor = 1.0 / rawSum;
    for (const [id, alloc] of newAllocations) {
      newAllocations.set(
        id,
        Math.max(config.min_allocation, alloc * factor)
      );
    }
  }

  for (const [strategyId, newAllocation] of newAllocations) {
    const strategy = strategies.find((s) => s.id === strategyId);
    if (!strategy) continue;

    const oldAllocation = strategy.allocation;
    if (Math.abs(newAllocation - oldAllocation) > 0.001) {
      updateAllocation(goalId, strategyId, newAllocation);
      adjustments.push({
        strategy_id: strategyId,
        old_allocation: oldAllocation,
        new_allocation: newAllocation,
        reason: `Score-based rebalancing (effectiveness: ${
          scoredRecords
            .find((r) => r.strategy_id === strategyId)
            ?.effectiveness_score?.toFixed(3) ?? "N/A"
        })`,
      });
    }
  }

  result.adjustments.push(...adjustments);
}

/**
 * Handle expiry of a WaitStrategy.
 *
 * When wait_until has passed:
 * - Gap improved: complete the WaitStrategy
 * - Gap unchanged: activate fallback strategy if one exists, otherwise trigger rebalance
 * - Gap worsened: terminate the WaitStrategy and trigger rebalance
 *
 * @param isWaitStrategy - predicate to detect WaitStrategy instances
 * @param getGap - get current gap for a dimension of a goal
 * @param updateState - transition a strategy to a new state
 * @param getPortfolioStrategies - get all strategies for a goal
 */
export async function handleWaitStrategyExpiry(
  goalId: string,
  strategyId: string,
  strategy: Strategy,
  isWaitStrategy: (s: Strategy) => boolean,
  getGap: (goalId: string, dimension: string) => number | null | Promise<number | null>,
  updateState: (strategyId: string, state: string) => void | Promise<void>,
  activateStrategy: ((goalId: string, strategyId: string) => void | Promise<void>) | undefined,
  getPortfolioStrategies: (goalId: string) => Strategy[] | Promise<Strategy[]>,
  getWaitMetadata?: (goalId: string, strategyId: string) => unknown | null | Promise<unknown | null>,
  isCapabilityAvailable?: CapabilityAvailabilityProvider,
  getWaitApprovalRecord?: (approvalId: string) => unknown | null | Promise<unknown | null>,
  writeWaitMetadata?: (goalId: string, strategyId: string, metadata: WaitMetadata) => void | Promise<void>,
  getStateBaseDir?: () => string | null | undefined
): Promise<WaitExpiryOutcome> {
  if (!isWaitStrategy(strategy)) {
    return {
      status: "unknown",
      goal_id: goalId,
      strategy_id: strategyId,
      details: "Strategy is not a WaitStrategy",
    };
  }

  const waitStrategy = strategy as unknown as WaitStrategy;
  const metadata = normalizeWaitMetadata(
    waitStrategy,
    await getWaitMetadata?.(goalId, strategyId)
  );
  const nextObserveAt = resolveWaitNextObserveAt(waitStrategy, metadata);
  const waitUntil = nextObserveAt ? new Date(nextObserveAt).getTime() : new Date(waitStrategy.wait_until).getTime();
  const now = Date.now();

  if (now < waitUntil) {
    return {
      status: "not_due",
      goal_id: goalId,
      strategy_id: strategyId,
      details: `WaitStrategy is not due until ${nextObserveAt ?? waitStrategy.wait_until}`,
    };
  }

  const approvalOutcome = await approvalOutcomeFromWaitMetadata(goalId, strategyId, metadata, isCapabilityAvailable, getWaitApprovalRecord);
  if (approvalOutcome) return approvalOutcome;

  const missingCapabilities = await missingRequiredCapabilities(metadata, isCapabilityAvailable);
  if (missingCapabilities.length > 0) {
    const details = `WaitStrategy observation capability missing: ${missingCapabilities.join(", ")}`;
    await persistWaitObservation(goalId, strategyId, metadata, {
      status: "failed",
      evidence: { missing_capabilities: missingCapabilities },
      next_observe_at: nextReobserveAt(now),
      confidence: 0.1,
      resume_hint: "capability_missing",
    }, writeWaitMetadata);
    return {
      status: "unknown",
      goal_id: goalId,
      strategy_id: strategyId,
      details,
      rebalance_trigger: {
        type: "stall_detected",
        strategy_id: strategyId,
        details,
      },
    };
  }

  const observation = await evaluateWaitConditions(metadata.conditions, metadata, {
    nowMs: now,
    stateBaseDir: getStateBaseDir?.() ?? null,
  });
  await persistWaitObservation(goalId, strategyId, metadata, observation, writeWaitMetadata);
  if (observation.status === "pending" || observation.status === "stale") {
    return {
      status: "not_due",
      goal_id: goalId,
      strategy_id: strategyId,
      details: observation.resume_hint ?? `WaitStrategy observation ${observation.status}`,
    };
  }
  if (observation.status === "failed" || observation.status === "expired") {
    return {
      status: "unknown",
      goal_id: goalId,
      strategy_id: strategyId,
      details: observation.resume_hint ?? `WaitStrategy observation ${observation.status}`,
      rebalance_trigger: {
        type: "stall_detected",
        strategy_id: strategyId,
        details: observation.resume_hint ?? `WaitStrategy observation ${observation.status}`,
      },
    };
  }

  const currentGap = await getGap(goalId, strategy.primary_dimension);
  if (currentGap === null) {
    await persistWaitObservation(goalId, strategyId, metadata, {
      status: "failed",
      evidence: { dimension: strategy.primary_dimension, reason: "gap_unavailable" },
      next_observe_at: nextReobserveAt(now),
      confidence: 0.1,
      resume_hint: `current gap is unavailable for ${strategy.primary_dimension}`,
    }, writeWaitMetadata);
    return {
      status: "unknown",
      goal_id: goalId,
      strategy_id: strategyId,
      details: `WaitStrategy expired but current gap is unavailable for ${strategy.primary_dimension}`,
    };
  }

  const startGap = strategy.gap_snapshot_at_start ?? currentGap;
  const gapDelta = currentGap - startGap;

  if (gapDelta < 0) {
    await updateState(strategyId, "completed");
    return {
      status: "improved",
      goal_id: goalId,
      strategy_id: strategyId,
      details: `WaitStrategy expired with gap improvement: ${startGap.toFixed(3)} → ${currentGap.toFixed(3)}`,
    };
  }

  if (gapDelta === 0) {
    if (waitStrategy.fallback_strategy_id) {
      const strategies = await getPortfolioStrategies(goalId);
      const fallback = strategies.find(
        (s) => s.id === waitStrategy.fallback_strategy_id
      );
      if (fallback && fallback.state === "candidate") {
        try {
          if (activateStrategy) {
            await activateStrategy(goalId, fallback.id);
          } else {
            await updateState(fallback.id, "active");
          }
          await updateState(strategyId, "terminated");
          return {
            status: "fallback_activated",
            goal_id: goalId,
            strategy_id: strategyId,
            details: `WaitStrategy expired unchanged; activated fallback strategy ${fallback.id}`,
          };
        } catch (err) {
          await updateState(strategyId, "terminated");
          const details = `WaitStrategy expired unchanged; fallback strategy ${fallback.id} could not be activated: ${err instanceof Error ? err.message : String(err)}`;
          return {
            status: "unchanged",
            goal_id: goalId,
            strategy_id: strategyId,
            details,
            rebalance_trigger: {
              type: "stall_detected",
              strategy_id: strategyId,
              details,
            },
          };
        }
      }
    }
    await updateState(strategyId, "terminated");
    const rebalanceTrigger: RebalanceTrigger = {
      type: "stall_detected",
      strategy_id: strategyId,
      details: `WaitStrategy expired with no gap improvement: ${startGap.toFixed(3)} → ${currentGap.toFixed(3)}`,
    };
    return {
      status: "unchanged",
      goal_id: goalId,
      strategy_id: strategyId,
      details: rebalanceTrigger.details,
      rebalance_trigger: rebalanceTrigger,
    };
  }

  await updateState(strategyId, "terminated");
  const rebalanceTrigger: RebalanceTrigger = {
    type: "stall_detected",
    strategy_id: strategyId,
    details: `WaitStrategy expired with gap worsening: ${startGap.toFixed(3)} → ${currentGap.toFixed(3)}`,
  };
  return {
    status: "worsened",
    goal_id: goalId,
    strategy_id: strategyId,
    details: rebalanceTrigger.details,
    rebalance_trigger: rebalanceTrigger,
  };
}

export function rebalanceTriggerFromWaitExpiryOutcome(
  outcome: WaitExpiryOutcome | null | undefined
): RebalanceTrigger | null {
  return outcome?.rebalance_trigger ?? null;
}

function normalizeGoalAllocation(value: number | undefined, fallback: number): number | null {
  const allocation = value ?? fallback;
  if (!Number.isFinite(allocation) || allocation <= 0 || allocation > Number.MAX_SAFE_INTEGER) {
    return null;
  }
  return allocation;
}

function normalizeGoalTaskCount(value: number | undefined): number {
  const count = value ?? 0;
  if (!Number.isSafeInteger(count) || count < 0) return 0;
  return count;
}

/**
 * Select the next strategy across multiple goals.
 *
 * Sorts goals by "saturation ratio" (tasks dispatched / allocation) — the most
 * underserved goal (lowest saturation) gets the next task. Within that goal,
 * selectStrategyForTask() picks the best strategy.
 *
 * @param goalTaskCounts - map of goalId → total tasks dispatched
 * @param selectStrategyForTask - select best strategy within one goal
 */
export async function selectNextStrategyAcrossGoals(
  goalIds: string[],
  goalAllocations: Map<string, number>,
  goalTaskCounts: Map<string, number>,
  selectStrategyForTask: (goalId: string) => TaskSelectionResult | null | Promise<TaskSelectionResult | null>
): Promise<{
  goal_id: string;
  strategy_id: string | null;
  selection_reason: string;
} | null> {
  if (goalIds.length === 0) return null;

  const fallbackAllocation = 1 / goalIds.length;
  const scored = goalIds.flatMap((goalId) => {
    const allocation = normalizeGoalAllocation(goalAllocations.get(goalId), fallbackAllocation);
    if (allocation === null) return [];
    const taskCount = normalizeGoalTaskCount(goalTaskCounts.get(goalId));
    const saturation = taskCount / allocation;
    return { goalId, saturation, allocation };
  });

  scored.sort((a, b) => a.saturation - b.saturation);

  for (const { goalId, saturation } of scored) {
    const allocation = goalAllocations.get(goalId) ?? 0;
    if (allocation <= 0) continue;

    const selectionResult = await selectStrategyForTask(goalId);
    if (selectionResult !== null) {
      return {
        goal_id: goalId,
        strategy_id: selectionResult.strategy_id,
        selection_reason: `Goal selected (saturation=${saturation.toFixed(2)}, allocation=${allocation.toFixed(2)}): ${selectionResult.reason}`,
      };
    }
  }

  return null;
}
