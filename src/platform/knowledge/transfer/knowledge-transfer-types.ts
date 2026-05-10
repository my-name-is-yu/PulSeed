import type { TransferCandidate } from "../../../base/types/cross-portfolio.js";
import type { LearnedPattern } from "../../../base/types/learning.js";
import type { StateManager } from "../../../base/state/state-manager.js";

// ─── Internal Storage Types ───

export interface TransferContext {
  candidate: TransferCandidate;
  /** gap score at apply time (lower is better) */
  gap_at_apply: number;
  source_pattern: LearnedPattern | null;
}

/** Track consecutive neutral/negative outcomes per source pattern */
export interface PatternEffectivenessTracker {
  consecutive_non_positive: number;
  invalidated: boolean;
}

// ─── Shared Helper ───

/**
 * Estimate the current gap for a goal.
 * Returns 0.5 as a neutral default if goal state is unavailable.
 */
export async function estimateCurrentGap(
  goalId: string,
  stateManager: StateManager
): Promise<number> {
  try {
    const latest = (await stateManager.loadGapHistory(goalId)).at(-1);
    const scores = latest?.gap_vector
      .map((gap) => gap.normalized_weighted_gap)
      .filter((value) => Number.isFinite(value)) ?? [];
    if (scores.length > 0) {
      return Math.max(...scores);
    }
  } catch {
    // non-fatal
  }
  return 0.5;
}
