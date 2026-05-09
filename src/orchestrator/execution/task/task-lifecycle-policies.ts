import type { Logger } from "../../../runtime/logger.js";
import type { Task } from "../../../base/types/task.js";
import type { Goal } from "../../../base/types/goal.js";
import { isDaemonShutdownAbortSignal } from "../../../base/utils/abort-reason.js";
import type { AgentResult } from "../adapter-layer.js";
import { defaultAgentLoopBudget, type AgentLoopBudget } from "../agent-loop/agent-loop-budget.js";
import { durationToMs } from "./task-executor.js";
import { isMechanicalVerificationMethod } from "./task-verifier-rules.js";

export const NATIVE_CODE_TASK_NO_CHANGES_ERROR = "No files were modified";

const PROFILED_TASK_BUDGET_PADDING_MS = 5 * 60 * 1000;

export function nativeTaskRequiresCapturedFileChanges(task: Task): boolean {
  return task.task_category === "normal" || task.task_category === "capability_acquisition";
}

export function isProfiledLongRunningTask(task: Task, goal?: Pick<Goal, "constraints"> | null): boolean {
  return [...task.constraints, ...(goal?.constraints ?? [])].some((constraint) => {
    const trimmed = constraint.trim();
    return trimmed.startsWith("run_spec_profile:") || trimmed.startsWith("profile:");
  });
}

export function estimateTaskDurationMs(task: Task): number | null {
  if (!task.estimated_duration) return null;
  return durationToMs(task.estimated_duration);
}

export function deriveTaskAgentLoopBudget(
  task: Task,
  goal?: Pick<Goal, "constraints"> | null,
  baseBudget: AgentLoopBudget = defaultAgentLoopBudget
): {
  budget?: Partial<AgentLoopBudget>;
  activeBudgetMs: number;
  generatedEstimateMs: number | null;
  reason: "default" | "profiled_estimate";
} {
  const generatedEstimateMs = estimateTaskDurationMs(task);
  if (
    generatedEstimateMs !== null &&
    generatedEstimateMs > baseBudget.maxWallClockMs &&
    isProfiledLongRunningTask(task, goal)
  ) {
    const activeBudgetMs = generatedEstimateMs + PROFILED_TASK_BUDGET_PADDING_MS;
    return {
      budget: { maxWallClockMs: activeBudgetMs },
      activeBudgetMs,
      generatedEstimateMs,
      reason: "profiled_estimate",
    };
  }

  return {
    activeBudgetMs: baseBudget.maxWallClockMs,
    generatedEstimateMs,
    reason: "default",
  };
}

export function failNativeCodeTaskWithoutFileChanges(input: {
  task: Task;
  result: AgentResult;
  capturedChangedPaths: string[];
  logger?: Logger;
}): void {
  if (!input.result.success || !nativeTaskRequiresCapturedFileChanges(input.task)) return;
  if (input.capturedChangedPaths.length > 0) return;

  input.logger?.warn(
    "[TaskLifecycle] Native agent loop reported success but no files were modified",
    { taskId: input.task.id }
  );
  input.result.success = false;
  input.result.error = NATIVE_CODE_TASK_NO_CHANGES_ERROR;
  input.result.stopped_reason = "completed";
  if (input.result.agentLoop) {
    input.result.agentLoop.verificationHints = [
      ...(input.result.agentLoop.verificationHints ?? []),
      NATIVE_CODE_TASK_NO_CHANGES_ERROR,
    ];
  }
}

export function hasRequiredArtifactContract(task: Task): boolean {
  return task.artifact_contract?.required === true &&
    Array.isArray(task.artifact_contract.required_artifacts) &&
    task.artifact_contract.required_artifacts.length > 0;
}

export function hasCapturedExecutionEvidence(result: AgentResult): boolean {
  return (result.fileDiffs?.length ?? 0) > 0 ||
    (result.filesChanged === true && (result.filesChangedPaths?.length ?? 0) > 0);
}

export function shouldDeferAgentLoopTerminalUntilVerification(task: Task, result: AgentResult): boolean {
  if (result.success) return result.agentLoop?.requiresPostVerificationBeforeSuccessLedger === true;
  if (!result.agentLoop) return false;
  if (result.stopped_reason === "cancelled" || result.stopped_reason === "policy_blocked") return false;
  if (result.agentLoop.workspaceDisposition === "handoff_required") return false;
  return hasCapturedExecutionEvidence(result) &&
    (hasRequiredArtifactContract(task) || hasBlockingMechanicalVerification(task));
}

export function hasBlockingMechanicalVerification(task: Task): boolean {
  return task.success_criteria.some((criterion) =>
    criterion.is_blocking && isMechanicalVerificationMethod(criterion.verification_method)
  );
}

export function shouldKeepDaemonShutdownInterruptedTaskRunning(
  result: AgentResult,
  abortSignal?: AbortSignal
): boolean {
  return result.stopped_reason === "cancelled" && isDaemonShutdownAbortSignal(abortSignal);
}

export function isExternalActionTask(task: Task): boolean {
  const externalAction = task.risk_profile?.external_action;
  if (!externalAction) return true;
  if (externalAction.action_kind === "unknown") return true;
  return externalAction.action_kind !== "none"
    || externalAction.required === true
    || externalAction.approval_required === true;
}

export function taskApprovalHandoffId(task: Task): string {
  return `handoff:${task.goal_id}:task:${task.id}:approval-required`;
}
