import { describe, expect, it } from "vitest";
import type { Task } from "../../../base/types/task.js";
import { formatApprovalNotice, normalizeApprovalTask } from "../app-approval.js";

describe("TUI app approval helpers", () => {
  it("normalizes daemon handoff payloads into approval tasks", () => {
    const task = normalizeApprovalTask({
      handoff_id: "handoff-1",
      goal_id: "goal-1",
      title: "Approve deployment",
      summary: "Needs operator approval before continuing.",
      recommended_action: "Approve after checking CI.",
      triggers: ["external_action", "deploy"],
      created_at: "2026-05-10T00:00:00.000Z",
    });

    expect(task).toMatchObject({
      id: "handoff-1",
      goal_id: "goal-1",
      primary_dimension: "operator_handoff",
      work_description: "Approve deployment",
      rationale: "Approve after checking CI.",
      approach: "Approve after checking CI.",
      status: "pending",
      created_at: "2026-05-10T00:00:00.000Z",
      scope_boundary: {
        in_scope: ["external_action, deploy"],
      },
    });
  });

  it("preserves already structured task payloads", () => {
    const structuredTask = normalizeApprovalTask({
      task: {
        id: "task-1",
        goal_id: "goal-1",
        work_description: "Review handoff",
      },
    }) as Task;

    expect(structuredTask.id).toBe("task-1");
    expect(structuredTask.work_description).toBe("Review handoff");
  });

  it("formats approval notices for the chat surface", () => {
    const notice = formatApprovalNotice({
      work_description: "Approve deployment",
      rationale: "Needs operator approval before continuing.",
      approach: "Approve after checking CI.",
    } as Task);

    expect(notice).toContain("Approval required.");
    expect(notice).toContain("Work: Approve deployment");
    expect(notice).toContain("Rationale: Needs operator approval before continuing.");
    expect(notice).toContain("Approach: Approve after checking CI.");
  });
});
