import type { StateManager } from "../../base/state/state-manager.js";
import type { Task } from "../../base/types/task.js";
import { durationToMs } from "../../orchestrator/execution/task/task-executor.js";
import { recordTaskOutcomeMutation } from "../../orchestrator/execution/task/task-outcome-ledger.js";

export async function upsertTaskHistory(stateManager: StateManager, task: Task): Promise<void> {
  const history = [...await stateManager.loadTaskHistory(task.goal_id)];

  const actual_elapsed_ms =
    task.started_at && task.completed_at
      ? new Date(task.completed_at).getTime() - new Date(task.started_at).getTime()
      : null;

  const estimated_duration_ms = task.estimated_duration
    ? durationToMs(task.estimated_duration)
    : null;

  const entry = {
    task_id: task.id,
    status: task.status,
    primary_dimension: task.primary_dimension,
    consecutive_failure_count: task.consecutive_failure_count,
    completed_at: task.completed_at ?? null,
    actual_elapsed_ms,
    estimated_duration_ms,
  };

  const existingIndex = history.findIndex(
    (item) => item && typeof item === "object" && (item as Record<string, unknown>)["task_id"] === task.id
  );

  if (existingIndex >= 0) {
    history[existingIndex] = entry;
  } else {
    history.push(entry);
  }

  await stateManager.saveTaskHistory(task.goal_id, history);
  await recordTaskOutcomeMutation(stateManager, task);
}
