import type { GroundingProvider } from "../contracts.js";
import { makeSection, makeSource } from "./helpers.js";
import type { Task } from "../../base/types/task.js";

function formatTask(task: Task): string {
  const label = task.work_description?.trim() || "Untitled task";
  const status = task.status ? ` - ${task.status}` : "";
  return `- ${label} (${task.id})${status}`;
}

export const taskStateProvider: GroundingProvider = {
  key: "task_state",
  kind: "dynamic",
  async build(context) {
    const stateManager = context.deps.stateManager;
    const goalId = context.request.goalId;
    if (!stateManager || !goalId) {
      return null;
    }

    const allTasks = await stateManager.listTasks(goalId);
    const prioritizedTasks = context.request.taskId
      ? [
          ...allTasks.filter((task) => task.id === context.request.taskId),
          ...allTasks.filter((task) => task.id !== context.request.taskId),
        ]
      : allTasks;
    const tasks = prioritizedTasks.slice(0, context.profile.budgets.maxTaskCount);

    return makeSection(
      "task_state",
      tasks.length > 0 ? tasks.map(formatTask).join("\n") : "No active tasks found.",
      [
        makeSource("task_state", "task state", {
          type: tasks.length > 0 ? "state" : "none",
          trusted: true,
          accepted: true,
          retrievalId: tasks.length > 0 ? `tasks:${goalId}` : "none:task_state",
          metadata: { goalId },
        }),
      ],
      { title: "Current Tasks" },
    );
  },
};
