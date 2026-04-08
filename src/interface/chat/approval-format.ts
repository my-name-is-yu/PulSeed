import type { Task } from "../../base/types/task.js";
import type { ApprovalRequest as ToolApprovalRequest } from "../../tools/types.js";

export type ApprovalDecision = "approve" | "reject" | "clarify";
export type ApprovalDecisionMode = "binary" | "tri";

export interface ApprovalDetail {
  label: string;
  value: string;
}

export interface ApprovalView {
  kind: "task" | "tool";
  title: string;
  summary: string;
  details: ApprovalDetail[];
  decisionMode: ApprovalDecisionMode;
}

export function formatApprovalView(view: ApprovalView): string {
  const lines = [
    view.title,
    view.summary,
    ...view.details.map((detail) => `${detail.label}: ${detail.value}`),
  ];
  return lines.join("\n");
}

function stringifyValue(value: unknown, maxLength: number = 240): string {
  if (typeof value === "string") {
    return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
  }

  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return String(value);
  }

  try {
    const serialized = JSON.stringify(value, null, 2) ?? String(value);
    return serialized.length > maxLength ? `${serialized.slice(0, maxLength - 1)}…` : serialized;
  } catch {
    const fallback = String(value);
    return fallback.length > maxLength ? `${fallback.slice(0, maxLength - 1)}…` : fallback;
  }
}

export function buildTaskApprovalView(task: Task): ApprovalView {
  return {
    kind: "task",
    title: "TASK APPROVAL REQUIRED",
    summary: task.work_description,
    details: [
      { label: "Rationale", value: task.rationale },
      { label: "Approach", value: task.approach },
      { label: "Reversibility", value: task.reversibility },
      { label: "Blast radius", value: task.scope_boundary?.blast_radius ?? "unknown" },
    ],
    decisionMode: "binary",
  };
}

export function buildToolApprovalView(request: ToolApprovalRequest): ApprovalView {
  return {
    kind: "tool",
    title: "TOOL APPROVAL REQUIRED",
    summary: `${request.toolName} is requesting approval`,
    details: [
      { label: "Tool", value: request.toolName },
      { label: "Reason", value: request.reason },
      { label: "Permission", value: request.permissionLevel },
      { label: "Destructive", value: request.isDestructive ? "yes" : "no" },
      { label: "Reversibility", value: request.reversibility },
      { label: "Input", value: stringifyValue(request.input) },
    ],
    decisionMode: "tri",
  };
}
