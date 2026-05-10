import type { Goal } from "../../base/types/goal.js";
import type { PaceSnapshot } from "../../base/types/goal.js";
import type { RescheduleOptions } from "../../base/types/state.js";

const ONE_SECOND_MS = 1000;
const MIN_RESCHEDULE_EXTENSION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_VALID_DATE_MS = 8_640_000_000_000_000;

/**
 * Returns all goals with node_type === "milestone".
 */
export function getMilestones(goals: Goal[]): Goal[] {
  return goals.filter((g) => g.node_type === "milestone");
}

/**
 * Returns milestones whose target_date is in the past (overdue).
 * Goals without a target_date are excluded.
 */
export function getOverdueMilestones(goals: Goal[]): Goal[] {
  const nowMs = Date.now();
  return getMilestones(goals).filter((g) => {
    const targetMs = parseEpochMs(g.target_date);
    return targetMs !== null && targetMs < nowMs;
  });
}

/**
 * Evaluate pace for a milestone goal.
 * currentAchievement (0-1) is computed by the caller (e.g. from SatisficingJudge).
 *
 * Pace evaluation logic (state-vector.md §8):
 *   elapsed_ratio = time_elapsed / total_duration   (creation → target_date)
 *   achievement_ratio = currentAchievement          (0-1)
 *   pace_ratio = achievement_ratio / elapsed_ratio  (guard divide-by-zero)
 *   on_track: pace_ratio >= 0.8
 *   at_risk:  pace_ratio >= 0.5
 *   behind:   pace_ratio < 0.5
 *
 * If no target_date is set, returns on_track with pace_ratio = 1.
 */
export function evaluatePace(milestone: Goal, currentAchievement: number): PaceSnapshot {
  const nowMs = Date.now();
  const evaluatedAt = new Date(nowMs).toISOString();
  const achievementRatio = normalizeAchievement(currentAchievement);

  const targetDate = parseEpochMs(milestone.target_date);
  const createdAt = parseEpochMs(milestone.created_at);

  if (targetDate === null || createdAt === null) {
    return noTimingPaceSnapshot(achievementRatio, evaluatedAt);
  }

  const totalDuration = targetDate - createdAt;

  // If total_duration is 0 or negative (target_date <= created_at), treat as elapsed
  if (totalDuration <= 0) {
    const paceRatio = achievementRatio;
    const status = paceRatio >= 0.8 ? "on_track" : paceRatio >= 0.5 ? "at_risk" : "behind";
    return {
      elapsed_ratio: 1,
      achievement_ratio: achievementRatio,
      pace_ratio: paceRatio,
      status,
      evaluated_at: evaluatedAt,
    };
  }

  const elapsed = nowMs - createdAt;
  const elapsedRatio = Math.min(Math.max(elapsed / totalDuration, 0), 1);

  let paceRatio: number;
  if (elapsed < ONE_SECOND_MS) {
    // Sub-second elapsed — treat as on_track to avoid flaky timing issues
    paceRatio = 1;
  } else {
    paceRatio = elapsedRatio > 0 ? achievementRatio / elapsedRatio : 1;
  }

  const status =
    paceRatio >= 0.8 ? "on_track" : paceRatio >= 0.5 ? "at_risk" : "behind";

  return {
    elapsed_ratio: elapsedRatio,
    achievement_ratio: achievementRatio,
    pace_ratio: paceRatio,
    status,
    evaluated_at: evaluatedAt,
  };
}

/**
 * Generate reschedule options when a milestone is behind.
 * Always returns 3 options: extend_deadline, reduce_target, renegotiate.
 */
export function generateRescheduleOptions(milestone: Goal, currentAchievement: number): RescheduleOptions {
  const achievementRatio = normalizeAchievement(currentAchievement);
  const snapshot = evaluatePace(milestone, achievementRatio);
  const now = new Date();

  // Extend deadline: add half the remaining duration
  let extendedDate: string | null = null;
  const targetMs = parseEpochMs(milestone.target_date);
  if (targetMs !== null) {
    const createdMs = parseEpochMs(milestone.created_at);
    const totalDuration = createdMs !== null ? targetMs - createdMs : 0;
    const halfDuration = Math.max(totalDuration * 0.5, MIN_RESCHEDULE_EXTENSION_MS);
    extendedDate = formatEpochMs(targetMs + halfDuration);
  }

  // Reduce target: scale current threshold by currentAchievement + buffer
  let reducedTargetValue: number | null = null;
  const firstNumericDim = milestone.dimensions.find(
    (d) => typeof d.current_value === "number" && d.threshold.type === "min"
  );
  if (firstNumericDim && firstNumericDim.threshold.type === "min") {
    const originalTarget = firstNumericDim.threshold.value;
    reducedTargetValue = reduceTargetValue(originalTarget, achievementRatio);
  }

  return {
    milestone_id: milestone.id,
    goal_id: milestone.parent_id ?? milestone.id,
    current_pace: snapshot.status,
    options: [
      {
        option_type: "extend_deadline",
        description: `Extend the deadline to give more time to reach the original target`,
        new_target_date: extendedDate,
        new_target_value: null,
      },
      {
        option_type: "reduce_target",
        description: `Lower the target value to match current pace`,
        new_target_date: null,
        new_target_value: reducedTargetValue,
      },
      {
        option_type: "renegotiate",
        description: `Trigger full goal renegotiation to reassess feasibility`,
        new_target_date: null,
        new_target_value: null,
      },
    ],
    generated_at: now.toISOString(),
  };
}

function normalizeAchievement(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function noTimingPaceSnapshot(achievementRatio: number, evaluatedAt: string): PaceSnapshot {
  return {
    elapsed_ratio: 0,
    achievement_ratio: achievementRatio,
    pace_ratio: 1,
    status: "on_track",
    evaluated_at: evaluatedAt,
  };
}

function reduceTargetValue(originalTarget: number, achievementRatio: number): number | null {
  if (!Number.isFinite(originalTarget)) return null;
  const scale = Math.max(achievementRatio + 0.1, 0.5);
  const reduced = Math.round(originalTarget * scale);
  return Number.isSafeInteger(reduced) ? reduced : null;
}

function parseEpochMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || Math.abs(parsed) > MAX_VALID_DATE_MS) return null;
  try {
    return new Date(parsed).toISOString() === value ? parsed : null;
  } catch {
    return null;
  }
}

function formatEpochMs(value: number): string | null {
  if (!Number.isFinite(value) || Math.abs(value) > MAX_VALID_DATE_MS) return null;
  return new Date(value).toISOString();
}
