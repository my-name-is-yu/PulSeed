import type { Logger } from "../../../runtime/logger.js";
import type { Task } from "../../../base/types/task.js";
import type { Goal } from "../../../base/types/goal.js";
import { isDaemonShutdownAbortSignal } from "../../../base/utils/abort-reason.js";
import type { AgentResult } from "../adapter-layer.js";
import { defaultAgentLoopBudget, type AgentLoopBudget } from "../agent-loop/agent-loop-budget.js";
import type { AgentLoopToolPolicy } from "../agent-loop/agent-loop-turn-context.js";
import { durationToMs } from "./task-executor.js";
import { isMechanicalVerificationMethod } from "./task-verifier-rules.js";

export const NATIVE_CODE_TASK_NO_CHANGES_ERROR = "No files were modified";

const PROFILED_TASK_BUDGET_PADDING_MS = 5 * 60 * 1000;

export const ARC_AGI3_RUN_SPEC_PROFILE_CONSTRAINT = "run_spec_profile:arc_agi_3";

export const ARC_AGI3_ALLOWED_AGENT_LOOP_TOOLS = [
  "arc_agi3_list_games",
  "arc_agi3_start",
  "arc_agi3_observe",
  "arc_agi3_act",
  "arc_agi3_finish",
  "arc_agi3_scorecard",
  "arc_agi3_policy",
  "runtime_report_write",
  "runtime_result_normalize",
  "read-pulseed-file",
  "json_query",
] as const;

export const ARC_AGI3_DENIED_AGENT_LOOP_TOOLS = [
  "research_web",
  "research_answer_with_sources",
  "web_search",
  "http_fetch",
  "browser_get_state",
  "browser_run_workflow",
  "desktop_click",
  "desktop_get_app_state",
  "desktop_list_apps",
  "desktop_type_text",
  "shell",
  "shell_command",
  "apply_patch",
  "file_write",
  "file_edit",
  "write-pulseed-file",
  "kaggle_compare_experiments",
  "kaggle_experiment_list",
  "kaggle_experiment_read",
  "kaggle_experiment_start",
  "kaggle_experiment_stop",
  "kaggle_leaderboard_snapshot",
  "kaggle_list_submissions",
  "kaggle_metric_report",
  "kaggle_submission_prepare",
  "kaggle_submit",
  "kaggle_workspace_prepare",
] as const;

export function nativeTaskRequiresCapturedFileChanges(task: Task): boolean {
  return task.task_category === "normal" || task.task_category === "capability_acquisition";
}

export function isProfiledLongRunningTask(task: Task, goal?: Pick<Goal, "constraints"> | null): boolean {
  return [...task.constraints, ...(goal?.constraints ?? [])].some((constraint) => {
    const trimmed = constraint.trim();
    return trimmed.startsWith("run_spec_profile:") || trimmed.startsWith("profile:");
  });
}

export function hasArcAgi3ProfileConstraint(constraints: readonly string[] | undefined): boolean {
  return constraints?.some((constraint) => {
    const token = constraint.trim();
    return token === ARC_AGI3_RUN_SPEC_PROFILE_CONSTRAINT || token === "profile:arc_agi_3";
  }) ?? false;
}

export function isArcAgi3GoalOrTask(task: Task, goal?: Pick<Goal, "constraints"> | null): boolean {
  return hasArcAgi3ProfileConstraint(task.constraints) || hasArcAgi3ProfileConstraint(goal?.constraints);
}

export function resolveArcAgi3AgentLoopToolPolicy(
  task: Task,
  goal?: Pick<Goal, "constraints"> | null,
): AgentLoopToolPolicy | undefined {
  if (!isArcAgi3GoalOrTask(task, goal)) return undefined;
  return {
    allowedTools: [...ARC_AGI3_ALLOWED_AGENT_LOOP_TOOLS],
    deniedTools: [...ARC_AGI3_DENIED_AGENT_LOOP_TOOLS],
  };
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
