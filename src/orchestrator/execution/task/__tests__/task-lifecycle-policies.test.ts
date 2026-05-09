import { describe, expect, it, vi } from "vitest";
import { createDaemonShutdownAbortReason } from "../../../../base/utils/abort-reason.js";
import { TaskSchema, type Task } from "../../../../base/types/task.js";
import type { AgentResult } from "../../adapter-layer.js";
import { defaultAgentLoopBudget } from "../../agent-loop/agent-loop-budget.js";
import {
  NATIVE_CODE_TASK_NO_CHANGES_ERROR,
  deriveTaskAgentLoopBudget,
  failNativeCodeTaskWithoutFileChanges,
  hasCapturedExecutionEvidence,
  isExternalActionTask,
  shouldDeferAgentLoopTerminalUntilVerification,
  shouldKeepDaemonShutdownInterruptedTaskRunning,
  taskApprovalHandoffId,
} from "../task-lifecycle-policies.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return TaskSchema.parse({
    id: "task-1",
    goal_id: "goal-1",
    strategy_id: null,
    target_dimensions: ["quality"],
    primary_dimension: "quality",
    work_description: "Update implementation",
    rationale: "Improve correctness",
    approach: "Make a bounded code edit",
    success_criteria: [{
      description: "Tests pass",
      verification_method: "npm test",
      is_blocking: true,
    }],
    scope_boundary: {
      in_scope: ["src"],
      out_of_scope: [],
      blast_radius: "single module",
    },
    constraints: [],
    artifact_contract: {
      required: false,
      required_artifacts: [],
    },
    plateau_until: null,
    estimated_duration: null,
    consecutive_failure_count: 0,
    reversibility: "reversible",
    task_category: "normal",
    status: "pending",
    started_at: null,
    completed_at: null,
    timeout_at: null,
    heartbeat_at: null,
    created_at: "2026-05-10T00:00:00.000Z",
    ...overrides,
  });
}

function makeAgentResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    success: false,
    output: "",
    error: "failed",
    exit_code: 1,
    elapsed_ms: 100,
    stopped_reason: "error",
    ...overrides,
  };
}

function makeAgentLoopInfo(overrides: NonNullable<AgentResult["agentLoop"]> = {
  traceId: "trace-1",
  sessionId: "session-1",
  turnId: "turn-1",
  stopReason: "completed",
  modelTurns: 1,
  toolCalls: 0,
  compactions: 0,
}): NonNullable<AgentResult["agentLoop"]> {
  return overrides;
}

describe("task lifecycle policies", () => {
  it("extends AgentLoop budget only for profiled long-running task estimates", () => {
    const baseBudget = { ...defaultAgentLoopBudget, maxWallClockMs: 30 * 60 * 1000 };
    const longRunning = makeTask({
      constraints: ["profile:kaggle-long-run"],
      estimated_duration: { value: 2, unit: "hours" },
    });

    expect(deriveTaskAgentLoopBudget(longRunning, null, baseBudget)).toEqual({
      budget: { maxWallClockMs: 125 * 60 * 1000 },
      activeBudgetMs: 125 * 60 * 1000,
      generatedEstimateMs: 120 * 60 * 1000,
      reason: "profiled_estimate",
    });

    expect(deriveTaskAgentLoopBudget(makeTask({
      estimated_duration: { value: 2, unit: "hours" },
    }), null, baseBudget)).toMatchObject({
      activeBudgetMs: 30 * 60 * 1000,
      generatedEstimateMs: 120 * 60 * 1000,
      reason: "default",
    });
  });

  it("marks native code task success as failed when no file changes were captured", () => {
    const warn = vi.fn();
    const result = makeAgentResult({
      success: true,
      error: null,
      exit_code: 0,
      stopped_reason: "completed",
      agentLoop: makeAgentLoopInfo(),
    });

    failNativeCodeTaskWithoutFileChanges({
      task: makeTask({ task_category: "normal" }),
      result,
      capturedChangedPaths: [],
      logger: { warn } as never,
    });

    expect(result).toMatchObject({
      success: false,
      error: NATIVE_CODE_TASK_NO_CHANGES_ERROR,
      stopped_reason: "completed",
    });
    expect(result.agentLoop?.verificationHints).toContain(NATIVE_CODE_TASK_NO_CHANGES_ERROR);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("does not require file-change capture for knowledge acquisition tasks", () => {
    const result = makeAgentResult({
      success: true,
      error: null,
      exit_code: 0,
      stopped_reason: "completed",
    });

    failNativeCodeTaskWithoutFileChanges({
      task: makeTask({ task_category: "knowledge_acquisition" }),
      result,
      capturedChangedPaths: [],
    });

    expect(result.success).toBe(true);
    expect(result.error).toBeNull();
  });

  it("defers terminal ledgers for failed AgentLoop results that still have verifiable evidence", () => {
    const taskWithArtifact = makeTask({
      artifact_contract: {
        required: true,
        required_artifacts: [{
          kind: "metrics_json",
          path: "reports/metrics.json",
          required_fields: ["score"],
          fresh_after_task_start: true,
        }],
      },
    });
    const failedWithDiff = makeAgentResult({
      agentLoop: makeAgentLoopInfo(),
      filesChanged: true,
      filesChangedPaths: ["src/app.ts"],
    });

    expect(hasCapturedExecutionEvidence(failedWithDiff)).toBe(true);
    expect(shouldDeferAgentLoopTerminalUntilVerification(taskWithArtifact, failedWithDiff)).toBe(true);
    expect(shouldDeferAgentLoopTerminalUntilVerification(taskWithArtifact, {
      ...failedWithDiff,
      stopped_reason: "policy_blocked",
    })).toBe(false);
    expect(shouldDeferAgentLoopTerminalUntilVerification(taskWithArtifact, {
      ...failedWithDiff,
      agentLoop: makeAgentLoopInfo({ ...makeAgentLoopInfo(), workspaceDisposition: "handoff_required" }),
    })).toBe(false);
  });

  it("keeps daemon-shutdown interrupted task running only for typed daemon abort signals", () => {
    const result = makeAgentResult({ stopped_reason: "cancelled" });
    const daemonAbort = new AbortController();
    daemonAbort.abort(createDaemonShutdownAbortReason("test shutdown"));

    const genericAbort = new AbortController();
    genericAbort.abort(new Error("generic"));

    expect(shouldKeepDaemonShutdownInterruptedTaskRunning(result, daemonAbort.signal)).toBe(true);
    expect(shouldKeepDaemonShutdownInterruptedTaskRunning(result, genericAbort.signal)).toBe(false);
    expect(shouldKeepDaemonShutdownInterruptedTaskRunning(
      makeAgentResult({ stopped_reason: "timeout" }),
      daemonAbort.signal,
    )).toBe(false);
  });

  it("fails closed for missing or unknown external-action risk metadata", () => {
    expect(isExternalActionTask(makeTask({ risk_profile: undefined }))).toBe(true);
    expect(isExternalActionTask(makeTask({
      risk_profile: { external_action: { action_kind: "none", required: false, approval_required: false, rationale: null } },
    }))).toBe(false);
    expect(isExternalActionTask(makeTask({
      risk_profile: { external_action: { action_kind: "unknown", required: false, approval_required: false, rationale: null } },
    }))).toBe(true);
    expect(taskApprovalHandoffId(makeTask({ goal_id: "goal-x", id: "task-y" }))).toBe(
      "handoff:goal-x:task:task-y:approval-required"
    );
  });
});
