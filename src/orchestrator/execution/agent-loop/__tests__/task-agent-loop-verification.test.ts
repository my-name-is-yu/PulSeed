import { describe, expect, it } from "vitest";
import type { Task } from "../../../../base/types/task.js";
import { isTaskRelevantVerificationCommand } from "../task-agent-loop-verification.js";

function makeTask(verificationMethod: string): Task {
  return {
    id: "task-1",
    goal_id: "goal-1",
    strategy_id: null,
    target_dimensions: ["dim"],
    primary_dimension: "dim",
    work_description: "test task",
    rationale: "why",
    approach: "how",
    success_criteria: [{ description: "done", verification_method: verificationMethod, is_blocking: true }],
    scope_boundary: { in_scope: ["."], out_of_scope: [], blast_radius: "low" },
    constraints: [],
    plateau_until: null,
    estimated_duration: { value: 1, unit: "hours" },
    consecutive_failure_count: 0,
    reversibility: "reversible",
    task_category: "normal",
    status: "pending",
    started_at: null,
    completed_at: null,
    timeout_at: null,
    heartbeat_at: null,
    created_at: new Date().toISOString(),
  };
}

describe("isTaskRelevantVerificationCommand", () => {
  it("matches verification commands to exact blocking criteria from the typed plan", () => {
    const task = makeTask("printf proof > evidence.txt");
    expect(isTaskRelevantVerificationCommand(task, {
      toolName: "shell_command",
      command: "printf proof > evidence.txt",
      cwd: process.cwd(),
      success: true,
      category: "verification",
      evidenceEligible: true,
      evidenceSource: "verification_plan",
      relevantToTask: true,
      outputSummary: "ok",
      durationMs: 1,
    })).toBe(true);

    expect(isTaskRelevantVerificationCommand(task, {
      toolName: "shell_command",
      command: "test -f old-target.ts",
      cwd: process.cwd(),
      success: true,
      category: "verification",
      evidenceEligible: true,
      evidenceSource: "verification_plan",
      relevantToTask: true,
      outputSummary: "ok",
      durationMs: 1,
    })).toBe(false);
  });

  it("accepts typed test-category tool evidence when no exact command parsing is needed", () => {
    const task = makeTask("");
    expect(isTaskRelevantVerificationCommand(task, {
      toolName: "verify",
      command: "arbitrary verification",
      cwd: process.cwd(),
      success: true,
      category: "verification",
      evidenceEligible: true,
      evidenceSource: "tool_activity_category",
      relevantToTask: true,
      outputSummary: "ok",
      durationMs: 1,
    })).toBe(true);
  });

  it("rejects stale typed test-category commands when a current verification plan exists", () => {
    const task = makeTask("npx vitest run src/current.test.ts");
    expect(isTaskRelevantVerificationCommand(task, {
      toolName: "test_runner",
      command: "npx vitest run src/old.test.ts",
      cwd: process.cwd(),
      success: true,
      category: "verification",
      evidenceEligible: true,
      evidenceSource: "tool_activity_category",
      relevantToTask: true,
      outputSummary: "ok",
      durationMs: 1,
    })).toBe(false);
  });
});
