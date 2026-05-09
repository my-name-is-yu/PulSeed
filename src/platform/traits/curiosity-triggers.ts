import type { StallDetector } from "../drive/stall-detector.js";
import type { Goal } from "../../base/types/goal.js";
import { CuriosityTriggerSchema } from "../../base/types/curiosity.js";
import type {
  CuriosityConfig,
  CuriosityState,
  CuriosityTrigger,
} from "../../base/types/curiosity.js";

export interface CuriosityTriggerDeps {
  config: CuriosityConfig;
  stallDetector: Pick<StallDetector, "getStallState">;
  state: Pick<CuriosityState, "last_exploration_at">;
}

export async function evaluateCuriosityTriggers(
  goals: Goal[],
  deps: CuriosityTriggerDeps
): Promise<CuriosityTrigger[]> {
  const triggers: CuriosityTrigger[] = [];

  const taskQueueEmpty = checkTaskQueueEmpty(goals);
  if (taskQueueEmpty) triggers.push(taskQueueEmpty);

  const unexpectedObservation = checkUnexpectedObservation(goals, deps.config);
  if (unexpectedObservation) triggers.push(unexpectedObservation);

  const repeatedFailure = await checkRepeatedFailures(goals, deps.stallDetector);
  if (repeatedFailure) triggers.push(repeatedFailure);

  const undefinedProblem = checkUndefinedProblems(goals);
  if (undefinedProblem) triggers.push(undefinedProblem);

  const periodicExploration = checkPeriodicExploration(deps.state.last_exploration_at, deps.config);
  if (periodicExploration) triggers.push(periodicExploration);

  return triggers;
}

export async function shouldExploreForCuriosity(
  goals: Goal[],
  deps: CuriosityTriggerDeps
): Promise<boolean> {
  if (!deps.config.enabled) return false;

  if (isUserTaskQueueEmpty(goals)) return true;
  if (isPeriodicExplorationDue(deps.state.last_exploration_at, deps.config)) return true;

  for (const goal of activeUserGoals(goals)) {
    const stallState = await deps.stallDetector.getStallState(goal.id);
    const hasEscalated = Object.values(stallState.dimension_escalation).some((level) => level > 0);
    if (hasEscalated) return true;
  }

  return false;
}

export function checkTaskQueueEmpty(goals: Goal[]): CuriosityTrigger | null {
  const userGoals = goals.filter(isUserGoal);

  if (userGoals.length === 0) return null;

  const allInactive = userGoals.every(isCompletedOrWaiting);

  if (!allInactive) return null;

  return CuriosityTriggerSchema.parse({
    type: "task_queue_empty",
    detected_at: new Date().toISOString(),
    source_goal_id: null,
    details: `All ${userGoals.length} user goal(s) are completed or waiting. Entering curiosity mode.`,
    severity: 0.8,
  });
}

export function checkUnexpectedObservation(goals: Goal[], config: CuriosityConfig): CuriosityTrigger | null {
  const threshold = config.unexpected_observation_threshold;

  for (const goal of goals) {
    if (goal.status !== "active") continue;

    for (const dim of goal.dimensions) {
      const history = dim.history;
      if (history.length < 4) continue;

      const numericValues = history
        .map((h) => (typeof h.value === "number" ? h.value : null))
        .filter((v): v is number => v !== null);

      if (numericValues.length < 4) continue;

      const mean = numericValues.reduce((a, b) => a + b, 0) / numericValues.length;
      const variance = numericValues.reduce((a, b) => a + (b - mean) ** 2, 0) / numericValues.length;
      const stddev = Math.sqrt(variance);

      if (stddev === 0) continue;

      const currentValue = dim.current_value;
      if (typeof currentValue !== "number") continue;

      const deviation = Math.abs(currentValue - mean);
      if (deviation > threshold * stddev) {
        return CuriosityTriggerSchema.parse({
          type: "unexpected_observation",
          detected_at: new Date().toISOString(),
          source_goal_id: goal.id,
          details: `Dimension "${dim.name}" in goal "${goal.id}" deviated ${deviation.toFixed(2)} from mean ${mean.toFixed(2)} (stddev=${stddev.toFixed(2)}, threshold=${threshold}σ).`,
          severity: Math.min(1.0, deviation / (stddev * threshold * 2)),
        });
      }
    }
  }

  return null;
}

export async function checkRepeatedFailures(
  goals: Goal[],
  stallDetector: Pick<StallDetector, "getStallState">
): Promise<CuriosityTrigger | null> {
  for (const goal of activeUserGoals(goals)) {
    const stallState = await stallDetector.getStallState(goal.id);

    const hasConsecutiveFailure = Object.entries(stallState.dimension_escalation).some(([, level]) => level > 0);

    if (hasConsecutiveFailure) {
      const stalledDims = Object.entries(stallState.dimension_escalation)
        .filter(([, level]) => level > 0)
        .map(([dim]) => dim);

      return CuriosityTriggerSchema.parse({
        type: "repeated_failure",
        detected_at: new Date().toISOString(),
        source_goal_id: goal.id,
        details: `Goal "${goal.id}" has escalated stall on dimension(s): ${stalledDims.join(", ")}. Task-level approaches are failing; goal structure may need revision.`,
        severity: 0.7,
      });
    }
  }

  return null;
}

export function checkUndefinedProblems(goals: Goal[]): CuriosityTrigger | null {
  const activeGoals = goals.filter((g) => g.status === "active");

  for (const goal of activeGoals) {
    const lowConfidenceDims = goal.dimensions.filter((d) => d.confidence < 0.3);

    if (lowConfidenceDims.length > 0 && goal.dimensions.length > 0) {
      const ratio = lowConfidenceDims.length / goal.dimensions.length;
      if (ratio >= 0.5) {
        const dimNames = lowConfidenceDims.map((d) => d.name).join(", ");
        return CuriosityTriggerSchema.parse({
          type: "undefined_problem",
          detected_at: new Date().toISOString(),
          source_goal_id: goal.id,
          details: `Goal "${goal.id}" has ${lowConfidenceDims.length} dimension(s) with very low confidence (< 0.3): ${dimNames}. Current goal structure may not cover the real problem space.`,
          severity: 0.5 + ratio * 0.3,
        });
      }
    }
  }

  return null;
}

export function checkPeriodicExploration(
  lastExploration: CuriosityState["last_exploration_at"],
  config: CuriosityConfig
): CuriosityTrigger | null {
  if (lastExploration === null) {
    return CuriosityTriggerSchema.parse({
      type: "periodic_exploration",
      detected_at: new Date().toISOString(),
      source_goal_id: null,
      details: "First periodic exploration check. No previous exploration recorded.",
      severity: 0.3,
    });
  }

  const elapsed = Date.now() - new Date(lastExploration).getTime();
  if (elapsed >= periodicExplorationIntervalMs(config)) {
    const hoursElapsed = (elapsed / (1000 * 60 * 60)).toFixed(1);
    return CuriosityTriggerSchema.parse({
      type: "periodic_exploration",
      detected_at: new Date().toISOString(),
      source_goal_id: null,
      details: `${hoursElapsed} hours since last exploration (threshold: ${config.periodic_exploration_hours}h). Periodic curiosity check.`,
      severity: 0.3,
    });
  }

  return null;
}

function isUserTaskQueueEmpty(goals: Goal[]): boolean {
  const userGoals = goals.filter(isUserGoal);
  return userGoals.length > 0 && userGoals.every(isCompletedOrWaiting);
}

function isPeriodicExplorationDue(
  lastExploration: CuriosityState["last_exploration_at"],
  config: CuriosityConfig
): boolean {
  if (lastExploration === null) return true;
  return Date.now() - new Date(lastExploration).getTime() >= periodicExplorationIntervalMs(config);
}

function activeUserGoals(goals: Goal[]): Goal[] {
  return goals.filter((g) => g.status === "active" && isUserGoal(g));
}

function isUserGoal(goal: Goal): boolean {
  return goal.origin !== "curiosity";
}

function isCompletedOrWaiting(goal: Goal): boolean {
  return goal.status === "completed" || goal.status === "waiting";
}

function periodicExplorationIntervalMs(config: CuriosityConfig): number {
  return config.periodic_exploration_hours * 60 * 60 * 1000;
}
