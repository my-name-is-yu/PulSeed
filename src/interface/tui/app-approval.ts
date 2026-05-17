import type { Task } from "../../base/types/task.js";

export function normalizeApprovalTask(data: Record<string, unknown>): Task {
  const rawTask = data.task;
  if (rawTask && typeof rawTask === "object") {
    return rawTask as Task;
  }
  const goalId = String(data.goalId ?? data.goal_id ?? "");
  const title = String(data.title ?? "Operator handoff required");
  const summary = String(data.recommended_action ?? "Review this operator handoff before continuing.");
  const triggers = Array.isArray(data.triggers) ? data.triggers.map(String).join(", ") : "operator_handoff";
  return {
    id: String(data.handoff_id ?? data.requestId ?? "operator_handoff"),
    goal_id: goalId,
    strategy_id: null,
    target_dimensions: [],
    primary_dimension: "operator_handoff",
    work_description: title,
    rationale: summary,
    approach: String(data.recommended_action ?? "Operator decision required."),
    success_criteria: [{
      description: "Operator has approved or rejected the handoff.",
      verification_method: "daemon approval response",
      is_blocking: true,
    }],
    scope_boundary: {
      in_scope: [triggers],
      out_of_scope: [],
      blast_radius: "operator handoff",
    },
    constraints: ["Requires explicit operator approval."],
    plateau_until: null,
    estimated_duration: null,
    consecutive_failure_count: 0,
    reversibility: "unknown",
    task_category: "normal",
    status: "pending",
    started_at: null,
    completed_at: null,
    timeout_at: null,
    heartbeat_at: null,
    created_at: String(data.created_at ?? new Date().toISOString()),
  };
}

export function formatApprovalNotice(task: Task): string {
  return [
    "Approval required.",
    `Work: ${task.work_description}`,
    `Rationale: ${task.rationale}`,
    `Approach: ${task.approach}`,
    "Approval decisions are handled in the originating conversation channel.",
  ].join("\n");
}
