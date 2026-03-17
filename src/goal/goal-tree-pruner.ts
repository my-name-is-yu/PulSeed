import type { StateManager } from "../state-manager.js";
import type { Goal } from "../types/goal.js";
import type { PruneDecision, PruneReason, PruneRecord } from "../types/goal-tree.js";

// ─── Deps Interface ───

export interface GoalTreePrunerDeps {
  stateManager: StateManager;
}

// ─── Internal Helper ───

export function cancelGoalAndDescendants(
  goal: Goal,
  now: string,
  stateManager: StateManager
): void {
  // Recursively cancel all children first
  for (const childId of goal.children_ids) {
    const child = stateManager.loadGoal(childId);
    if (child) {
      cancelGoalAndDescendants(child, now, stateManager);
    }
  }

  // Cancel this goal
  const cancelled: Goal = {
    ...goal,
    status: "cancelled",
    updated_at: now,
  };
  stateManager.saveGoal(cancelled);
}

// ─── Pruning Functions ───

/**
 * Prunes a goal and all its descendants by setting status = "cancelled".
 * Removes the goal from its parent's children_ids.
 * Returns a PruneDecision.
 */
export function pruneGoal(
  goalId: string,
  reason: PruneReason,
  deps: GoalTreePrunerDeps
): PruneDecision {
  const goal = deps.stateManager.loadGoal(goalId);
  if (!goal) {
    throw new Error(`GoalTreeManager.pruneGoal: goal "${goalId}" not found`);
  }

  const now = new Date().toISOString();

  // Cancel the goal and all descendants
  cancelGoalAndDescendants(goal, now, deps.stateManager);

  // Remove from parent's children_ids
  if (goal.parent_id) {
    const parent = deps.stateManager.loadGoal(goal.parent_id);
    if (parent) {
      const updatedParent: Goal = {
        ...parent,
        children_ids: parent.children_ids.filter((id) => id !== goalId),
        updated_at: now,
      };
      deps.stateManager.saveGoal(updatedParent);
    }
  }

  return {
    goal_id: goalId,
    reason,
    replacement_id: null,
  };
}

/**
 * Prunes a subgoal with a free-form reason string for tracking.
 * Records a PruneRecord in the history for the parent goal tree.
 * The parentGoalId is the root goal whose history you want to track.
 */
export function pruneSubgoal(
  subgoalId: string,
  reason: string,
  pruneHistory: Map<string, PruneRecord[]>,
  deps: GoalTreePrunerDeps,
  parentGoalId?: string
): PruneDecision {
  const goal = deps.stateManager.loadGoal(subgoalId);
  if (!goal) {
    throw new Error(`GoalTreeManager.pruneSubgoal: goal "${subgoalId}" not found`);
  }

  const now = new Date().toISOString();

  // Cancel the goal and all descendants
  cancelGoalAndDescendants(goal, now, deps.stateManager);

  // Remove from parent's children_ids
  if (goal.parent_id) {
    const parent = deps.stateManager.loadGoal(goal.parent_id);
    if (parent) {
      const updatedParent: Goal = {
        ...parent,
        children_ids: parent.children_ids.filter((id) => id !== subgoalId),
        updated_at: now,
      };
      deps.stateManager.saveGoal(updatedParent);
    }
  }

  // Record prune history keyed by parentGoalId or the goal's own parent_id
  const trackingKey = parentGoalId ?? goal.parent_id ?? subgoalId;
  const record: PruneRecord = { subgoalId, reason, timestamp: now };
  const existing = pruneHistory.get(trackingKey) ?? [];
  pruneHistory.set(trackingKey, [...existing, record]);

  return {
    goal_id: subgoalId,
    reason: "user_requested",
    replacement_id: null,
  };
}

/**
 * Returns the prune history for a given goal tree root ID.
 * Returns an empty array if no prunes have been recorded.
 */
export function getPruneHistory(
  goalId: string,
  pruneHistory: Map<string, PruneRecord[]>
): PruneRecord[] {
  return pruneHistory.get(goalId) ?? [];
}
