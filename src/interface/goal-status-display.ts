import type { Goal } from "../base/types/goal.js";
import type { Dimension } from "../base/types/goal.js";
import { dimensionProgress } from "../platform/drive/gap-calculator.js";
import { formatPlainGoalState } from "./current-goal-summary.js";

export interface GoalStatusDisplayOptions {
  diagnostic?: boolean;
}

export function formatGoalListLine(goal: Goal, options: GoalStatusDisplayOptions = {}): string {
  if (options.diagnostic) {
    return `- ${goal.id} [${goal.status}/${goal.loop_status}] ${goal.title}`;
  }
  return `- ${goal.title} — ${formatPlainGoalState(goal)}`;
}

export function formatGoalStatusDetails(goal: Goal, options: GoalStatusDisplayOptions = {}): string {
  if (options.diagnostic) return formatDiagnosticGoalStatusDetails(goal);
  const lines = [
    `Goal details: ${goal.title}`,
    `State: ${formatPlainGoalState(goal)}`,
    `Updated: ${goal.updated_at}`,
  ];
  if (goal.deadline) lines.push(`Deadline: ${goal.deadline}`);
  if (goal.children_ids.length > 0) lines.push(`Child goals: ${goal.children_ids.length}`);
  if (goal.dimensions.length > 0) {
    lines.push("Progress signals:");
    lines.push(...goal.dimensions.map(formatPlainDimensionLine));
  } else {
    lines.push("Progress signals: none configured yet.");
  }
  return lines.join("\n");
}

function formatDiagnosticGoalStatusDetails(goal: Goal): string {
  return [
    `Goal details: ${goal.title}`,
    `ID: ${goal.id}`,
    `Status: ${goal.status}`,
    `Loop: ${goal.loop_status}`,
    `Updated: ${goal.updated_at}`,
    `Children: ${goal.children_ids.length}`,
    "Dimensions:",
    ...goal.dimensions.map((dimension) =>
      `- ${dimension.name}: current=${String(dimension.current_value)}, threshold=${JSON.stringify(dimension.threshold)}, confidence=${dimension.confidence}`
    ),
  ].join("\n");
}

function formatPlainDimensionLine(dimension: Dimension): string {
  const progress = dimensionProgress(dimension.current_value, dimension.threshold);
  if (progress === null) return `- ${dimension.label}: not yet measured`;
  return `- ${dimension.label}: ${Math.round(progress * 100)}% toward the target`;
}
