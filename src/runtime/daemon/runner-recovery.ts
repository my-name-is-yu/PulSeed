import { TaskSchema, VerificationResultSchema, type Task } from "../../base/types/task.js";
import { appendTaskOutcomeEvent } from "../../orchestrator/execution/task/task-outcome-ledger.js";
import { durationToMs } from "../../orchestrator/execution/task/task-executor.js";
import { verifyTaskArtifactContract } from "../../orchestrator/execution/task/task-artifact-contract.js";
import { resolveTaskWorkspacePath } from "../../orchestrator/execution/task/task-workspace.js";
import type { StateManager } from "../../base/state/state-manager.js";
import { GoalTaskStateStore } from "../store/goal-task-state-store.js";
import type { Logger } from "../logger.js";

type InterruptedTaskTerminalStatus = Extract<Task["status"], "cancelled" | "timed_out" | "error">;

export interface ReconcileInterruptedExecutionsParams {
  baseDir: string;
  stateManager: StateManager;
  logger: Pick<Logger, "warn">;
  liveOwnerGoalIds?: Iterable<string>;
  interruptedOutputMessage?: string;
  failedEventReason?: string;
  retryEventReason?: string;
  recoverySource?: string;
  terminalStatus?: InterruptedTaskTerminalStatus;
  stoppedReason?: string;
}

export async function reconcileInterruptedExecutions(params: ReconcileInterruptedExecutionsParams): Promise<string[]> {
  const recoveredGoalIds = new Set<string>();
  const skippedLiveOwnerGoalIds = new Set<string>();
  const liveOwnerGoalIds = new Set(params.liveOwnerGoalIds ?? []);
  const now = new Date().toISOString();
  const interruptedOutputMessage =
    params.interruptedOutputMessage ??
    "[RECOVERED] Task execution was interrupted by daemon recovery; no live worker remains attached.";
  const failedEventReason = params.failedEventReason ?? "task execution interrupted by daemon recovery; no live worker remains attached";
  const retryEventReason = params.retryEventReason ?? "task was marked terminal during daemon recovery";
  const recoverySource = params.recoverySource ?? "daemon_startup";

  for (const task of await findRunningTasks(params.baseDir, params.stateManager)) {
    if (liveOwnerGoalIds.has(task.goal_id)) {
      skippedLiveOwnerGoalIds.add(task.goal_id);
      continue;
    }

    const artifactRecoveredTask = await recoverInterruptedTaskFromArtifactContract(task, params, now);
    if (artifactRecoveredTask) {
      recoveredGoalIds.add(task.goal_id);
      continue;
    }

    const terminalStatus = params.terminalStatus ?? inferInterruptedTaskStatus(task, now);
    const stoppedReason = params.stoppedReason ?? stoppedReasonForStatus(terminalStatus);
    const recoveredTask: Task = TaskSchema.parse({
      ...task,
      status: terminalStatus,
      completed_at: task.completed_at ?? now,
      heartbeat_at: now,
      ...(terminalStatus === "timed_out" ? { timeout_at: task.timeout_at ?? now } : {}),
      execution_output: [
        task.execution_output,
        interruptedOutputMessage,
      ]
        .filter((value): value is string => typeof value === "string" && value.length > 0)
        .join("\n"),
    });

    await params.stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, recoveredTask);
    await appendRecoveredTaskHistory(params.stateManager, recoveredTask, {
      recoverySource,
      recovery_reason: failedEventReason,
      retry_intent: retryEventReason,
    });
    await appendTaskOutcomeEvent(params.stateManager, {
      task: recoveredTask,
      type: "failed",
      attempt: Math.max(task.consecutive_failure_count + 1, 1),
      reason: failedEventReason,
      stoppedReason,
    });
    recoveredGoalIds.add(task.goal_id);
  }

  await reconcileInterruptedPipelines(params.baseDir, params.stateManager, now);

  if (recoveredGoalIds.size > 0) {
    params.logger.warn("Recovered interrupted task executions on startup", {
      goals: [...recoveredGoalIds],
      count: recoveredGoalIds.size,
    });
  }
  if (skippedLiveOwnerGoalIds.size > 0) {
    params.logger.warn("Skipped interrupted task recovery for goals with live owners", {
      goals: [...skippedLiveOwnerGoalIds],
      count: skippedLiveOwnerGoalIds.size,
    });
  }

  return [...recoveredGoalIds];
}

async function recoverInterruptedTaskFromArtifactContract(
  task: Task,
  params: ReconcileInterruptedExecutionsParams,
  now: string,
): Promise<Task | null> {
  const goal = await params.stateManager.loadGoal(task.goal_id).catch(() => null);
  const cwd = await resolveTaskWorkspacePath({
    stateManager: params.stateManager,
    task,
    fallbackCwd: params.baseDir,
  });
  const artifactResult = await verifyTaskArtifactContract(task, cwd, { goal });
  if (!artifactResult.applicable || !artifactResult.passed) return null;

  const recoverySource = params.recoverySource ?? "daemon_startup";
  const successReason =
    "interrupted task recovered from fresh artifact_contract evidence after daemon recovery";
  const recoveredTask: Task = TaskSchema.parse({
    ...task,
    status: "completed",
    completed_at: task.completed_at ?? now,
    heartbeat_at: now,
    verification_verdict: "pass",
    verification_evidence: [
      ...(task.verification_evidence ?? []),
      artifactResult.description,
      successReason,
    ],
    execution_output: [
      task.execution_output,
      "[RECOVERED] Task execution was interrupted, but artifact_contract verification passed during daemon recovery.",
    ]
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .join("\n"),
  });
  const verificationResult = VerificationResultSchema.parse({
    task_id: task.id,
    verdict: "pass",
    confidence: 1,
    evidence: [{
      layer: "mechanical",
      description: `${artifactResult.description}; ${successReason}`,
      confidence: 1,
    }],
    dimension_updates: [],
    artifact_contract_status: artifactResult,
    timestamp: now,
  });

  await params.stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, recoveredTask);
  await params.stateManager.writeRaw(`verification/${task.id}/verification-result.json`, verificationResult);
  await appendRecoveredTaskHistory(params.stateManager, recoveredTask, {
    recoverySource,
    recovery_reason: successReason,
    retry_intent: "task completed from durable artifact evidence during daemon recovery",
  });
  await appendTaskOutcomeEvent(params.stateManager, {
    task: recoveredTask,
    type: "succeeded",
    attempt: Math.max(task.consecutive_failure_count + 1, 1),
    action: "completed",
    verificationResult,
  });

  return recoveredTask;
}

function stoppedReasonForStatus(status: InterruptedTaskTerminalStatus): string {
  if (status === "timed_out") return "timeout";
  if (status === "cancelled") return "cancelled";
  return "error";
}

function inferInterruptedTaskStatus(task: Task, now: string): InterruptedTaskTerminalStatus {
  if (task.timeout_at) {
    const timeoutMs = Date.parse(task.timeout_at);
    const nowMs = Date.parse(now);
    if (Number.isFinite(timeoutMs) && Number.isFinite(nowMs) && timeoutMs <= nowMs) {
      return "timed_out";
    }
  }
  return "cancelled";
}

export async function findRunningTasks(baseDir: string, stateManager: StateManager): Promise<Task[]> {
  const listTasksByStatus = (stateManager as {
    listTasksByStatus?: StateManager["listTasksByStatus"];
  }).listTasksByStatus;
  if (typeof listTasksByStatus === "function") {
    return listTasksByStatus.call(stateManager, "running");
  }
  return new GoalTaskStateStore(baseDir).listTasksByStatus("running");
}

export async function appendRecoveredTaskHistory(
  stateManager: StateManager,
  task: Task,
  recovery: {
    recoverySource: string;
    recovery_reason: string;
    retry_intent: string;
  }
): Promise<void> {
  const historyPath = `tasks/${task.goal_id}/task-history.json`;
  const existing = await stateManager.readRaw(historyPath);
  const history = Array.isArray(existing) ? existing : [];
  const actualElapsedMs =
    task.started_at && task.completed_at
      ? new Date(task.completed_at).getTime() - new Date(task.started_at).getTime()
      : null;

  history.push({
    task_id: task.id,
    status: task.status,
    primary_dimension: task.primary_dimension,
    consecutive_failure_count: task.consecutive_failure_count,
    completed_at: task.completed_at ?? new Date().toISOString(),
    actual_elapsed_ms: actualElapsedMs,
    estimated_duration_ms: task.estimated_duration ? durationToMs(task.estimated_duration) : null,
    recovery_source: recovery.recoverySource,
    recovery_reason: recovery.recovery_reason,
    retry_intent: recovery.retry_intent,
  });
  await stateManager.writeRaw(historyPath, history);
}

export async function reconcileInterruptedPipelines(
  baseDir: string,
  stateManager: StateManager,
  now: string
): Promise<void> {
  const listPipelinesByStatus = (stateManager as {
    listPipelinesByStatus?: StateManager["listPipelinesByStatus"];
  }).listPipelinesByStatus;
  const runningPipelines = typeof listPipelinesByStatus === "function"
    ? await listPipelinesByStatus.call(stateManager, "running")
    : await new GoalTaskStateStore(baseDir).listPipelinesByStatus("running");
  for (const pipelineState of runningPipelines) {
    await stateManager.writeRaw(`pipelines/${pipelineState.task_id}.json`, {
      ...pipelineState,
      status: "interrupted",
      updated_at: now,
    });
  }
}
