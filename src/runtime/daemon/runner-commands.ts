import { resolveScheduleEntry } from "../schedule/entry-resolver.js";
import {
  RuntimeOperationStore,
  RuntimePostmortemReportStore,
  RuntimeSafePauseStore,
  type RuntimeControlOperationKind,
  type RuntimeSafePauseCheckpoint,
  type RuntimeSafePauseRecord,
} from "../store/index.js";
import type { Logger } from "../logger.js";
import type { EventServer } from "../event/server.js";
import type { ScheduleEngine } from "../schedule/engine.js";
import type { StateManager } from "../../base/state/state-manager.js";
import type { DaemonState } from "../../base/types/daemon.js";
import type { Envelope } from "../types/envelope.js";
import type { ApprovalBroker } from "../approval-broker.js";
import type { LoopSupervisor } from "../executor/index.js";
import type { JournalBackedQueue, JournalBackedQueueAcceptResult } from "../queue/journal-backed-queue.js";
import { writeChatMessageEvent } from "./maintenance.js";
import { runCommandWithHealth as runCommandWithHealthFn } from "./runner-errors.js";
import type { WaitResumeActivation } from "../../base/types/goal-activation.js";

export interface BackgroundRunStartMetadata {
  backgroundRunId: string;
  parentSessionId?: string | null;
  notifyPolicy?: "silent" | "done_only" | "state_changes";
  replyTargetSource?: "pinned_run" | "parent_session" | "none";
  pinnedReplyTarget?: Record<string, unknown> | null;
}

export interface GoalStartMetadata {
  backgroundRun?: BackgroundRunStartMetadata;
  waitResume?: WaitResumeActivation;
}

export interface DaemonRunnerCommandContext {
  runtimeRoot?: string;
  logger: Logger;
  scheduleEngine?: ScheduleEngine;
  stateManager: StateManager;
  state: DaemonState;
  currentGoalIds: string[];
  supervisor?: LoopSupervisor;
  approvalBroker?: ApprovalBroker;
  eventServer?: EventServer;
  journalQueue?: JournalBackedQueue;
  saveDaemonState(): Promise<void>;
  refreshOperationalState(): void;
  abortSleep(): void;
  beginGracefulShutdown(): void;
  broadcastGoalUpdated(goalId: string, fallbackStatus?: string): Promise<void>;
  broadcastChatResponse(goalId: string, message: string): Promise<void>;
  runtimeOwnership: {
    observeTaskExecution(
      status: "ok" | "degraded" | "failed",
      reason?: string,
    ): Promise<void>;
    observeCommandAcceptance(
      status: "accepted" | "rejected" | "failed",
      reason?: string,
    ): Promise<void>;
  };
  driveSystem: {
    writeEvent(event: unknown): Promise<void>;
  };
}

export function acceptRuntimeEnvelope(
  context: Pick<DaemonRunnerCommandContext, "journalQueue" | "logger" | "runtimeRoot">,
  envelope: Envelope,
): boolean {
  if (!context.journalQueue) return true;

  const result: JournalBackedQueueAcceptResult = context.journalQueue.accept(envelope);
  if (result.accepted) {
    return true;
  }

  context.logger.info("Runtime journal skipped envelope", {
    id: envelope.id,
    name: envelope.name,
    type: envelope.type,
    duplicate: result.duplicate,
    runtime_root: context.runtimeRoot,
  });
  return false;
}

export async function handleInboundEnvelope(
  context: Pick<DaemonRunnerCommandContext, "journalQueue" | "logger" | "runtimeRoot">,
  envelope: Envelope,
): Promise<void> {
  if (!acceptRuntimeEnvelope(context, envelope)) {
    return;
  }
}

export async function handleGoalStartCommand(
  context: Pick<
    DaemonRunnerCommandContext,
    "currentGoalIds" | "refreshOperationalState" | "saveDaemonState" | "supervisor" | "abortSleep" | "broadcastGoalUpdated" | "state"
  >,
  goalId: string,
  metadata?: GoalStartMetadata,
): Promise<void> {
  if (!context.currentGoalIds.includes(goalId)) {
    context.currentGoalIds.push(goalId);
  }
  context.refreshOperationalState();
  await context.saveDaemonState();
  context.supervisor?.activateGoal(goalId, metadata);
  context.abortSleep();
  await context.broadcastGoalUpdated(goalId, "active");
}

export function extractGoalStartMetadata(envelope: Envelope): GoalStartMetadata | undefined {
  const payload = envelope.payload;
  if (!payload || typeof payload !== "object") return undefined;
  const value = payload as Record<string, unknown>;
  const backgroundRun = extractBackgroundRun(value["backgroundRun"]);
  const waitResume = extractWaitResume(value["wait_resume"]);
  if (!backgroundRun && !waitResume) return undefined;

  return {
    ...(backgroundRun ? { backgroundRun } : {}),
    ...(waitResume ? { waitResume } : {}),
  };
}

function extractBackgroundRun(payload: unknown): BackgroundRunStartMetadata | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const input = payload as Record<string, unknown>;
  const backgroundRunId = input["backgroundRunId"];
  if (typeof backgroundRunId !== "string" || backgroundRunId.trim() === "") return undefined;

  const parentSessionId = input["parentSessionId"];
  const notifyPolicy = input["notifyPolicy"];
  const replyTargetSource = input["replyTargetSource"];
  const pinnedReplyTarget = input["pinnedReplyTarget"];

  return {
    backgroundRunId,
    ...(typeof parentSessionId === "string" || parentSessionId === null ? { parentSessionId } : {}),
    ...(notifyPolicy === "silent" || notifyPolicy === "done_only" || notifyPolicy === "state_changes"
      ? { notifyPolicy }
      : {}),
    ...(replyTargetSource === "pinned_run" || replyTargetSource === "parent_session" || replyTargetSource === "none"
      ? { replyTargetSource }
      : {}),
    ...(pinnedReplyTarget && typeof pinnedReplyTarget === "object"
      ? { pinnedReplyTarget: pinnedReplyTarget as Record<string, unknown> }
      : pinnedReplyTarget === null
        ? { pinnedReplyTarget: null }
        : {}),
  };
}

function extractWaitResume(payload: unknown): WaitResumeActivation | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const input = payload as Record<string, unknown>;
  if (input["type"] !== "wait_resume") return undefined;
  const strategyId = input["strategyId"];
  if (typeof strategyId !== "string" || strategyId.trim() === "") return undefined;
  const scheduleEntryId = input["scheduleEntryId"];
  const nextObserveAt = input["nextObserveAt"];
  const waitReason = input["waitReason"];
  return {
    type: "wait_resume",
    strategyId,
    ...(typeof scheduleEntryId === "string" ? { scheduleEntryId } : {}),
    ...(typeof nextObserveAt === "string" || nextObserveAt === null ? { nextObserveAt } : {}),
    ...(typeof waitReason === "string" || waitReason === null ? { waitReason } : {}),
  };
}

export async function handleGoalStopCommand(
	context: Pick<
		DaemonRunnerCommandContext,
		"currentGoalIds" | "refreshOperationalState" | "saveDaemonState" | "supervisor" | "abortSleep" | "broadcastGoalUpdated" | "state" | "runtimeRoot" | "stateManager"
	>,
  goalId: string,
): Promise<void> {
  context.currentGoalIds.splice(0, context.currentGoalIds.length, ...context.currentGoalIds.filter((id) => id !== goalId));
  context.refreshOperationalState();
  if (context.state.interrupted_goals) {
    context.state.interrupted_goals = context.state.interrupted_goals.filter((id) => id !== goalId);
  }
  const store = safePauseStore(context);
  if (store) {
    const stopped = await store.markEmergencyStopped(goalId, "goal_stop command requested emergency stop");
    context.state.safe_pause_goals = {
      ...(context.state.safe_pause_goals ?? {}),
      [goalId]: stopped,
    };
  }
  await context.saveDaemonState();
  context.supervisor?.deactivateGoal(goalId);
  context.abortSleep();
  await context.broadcastGoalUpdated(goalId, "stopped");
}

function safePauseStore(context: Pick<DaemonRunnerCommandContext, "runtimeRoot" | "stateManager">): RuntimeSafePauseStore | null {
  return context.runtimeRoot
    ? new RuntimeSafePauseStore(context.runtimeRoot, { controlBaseDir: context.stateManager.getBaseDir() })
    : null;
}

function activeWorkerCount(context: Pick<DaemonRunnerCommandContext, "supervisor">, goalId: string): number {
  return context.supervisor?.getState().workers.filter((worker) => worker.goalId === goalId).length ?? 0;
}

function buildSafePauseCheckpoint(
  context: Pick<DaemonRunnerCommandContext, "currentGoalIds" | "journalQueue" | "supervisor" | "runtimeRoot" | "state">,
  goalId: string,
  reason?: string,
) {
  const queueSnapshot = context.journalQueue?.snapshot();
  const queuedGoalIds = queueSnapshot
    ? Object.values(queueSnapshot.pending)
        .flat()
        .map((messageId) => context.journalQueue?.get(messageId)?.envelope.goal_id)
        .filter((id): id is string => typeof id === "string")
    : [];
  const supervisorState = context.supervisor?.getState();
  const backgroundRunIds = supervisorState?.workers
    .filter((worker) => worker.goalId === goalId && worker.backgroundRunId)
    .map((worker) => worker.backgroundRunId!)
    ?? [];
  return {
    checkpoint_id: `safe-pause:${goalId}:${Date.now()}`,
    checkpointed_at: new Date().toISOString(),
    reason,
    active_goals: [...context.currentGoalIds],
    queued_goal_ids: [...new Set(queuedGoalIds)],
    current_mode: context.state.status,
    candidate_evidence_refs: [
      ...(context.runtimeRoot ? [`${context.runtimeRoot}/evidence-ledger/goals/${encodeURIComponent(goalId)}.jsonl`] : []),
      ...(queueSnapshot ? [`queue:pending:${Object.values(queueSnapshot.pending).flat().length}`] : []),
    ],
    artifact_refs: [
      ...(context.runtimeRoot ? [`${context.runtimeRoot}/artifacts`] : []),
      ...(backgroundRunIds.map((runId) => `background-run:${runId}`)),
    ],
    next_action: "resume goal to continue from the saved queue/evidence/artifact context",
    supervisor_state_ref: context.runtimeRoot ? "control-db:supervisor_state_snapshots/current" : null,
    background_run_ids: [...new Set(backgroundRunIds)],
  };
}

function uniqueGoalIds(goalIds: string[]): string[] {
  return [...new Set(goalIds.filter((goalId) => goalId.trim() !== ""))];
}

function buildResumeGoalIds(currentGoalIds: string[], goalId: string): string[] {
  return uniqueGoalIds([...currentGoalIds, goalId]);
}

function isResumableSafePauseState(record: RuntimeSafePauseRecord | null): boolean {
  return record?.state === "pause_requested" || record?.state === "paused";
}

function buildSafePauseResumeReason(checkpoint: RuntimeSafePauseCheckpoint | undefined): string | null {
  if (!checkpoint) {
    return null;
  }
  const parts = [
    checkpoint.next_action,
    checkpoint.current_mode ? `mode=${checkpoint.current_mode}` : null,
    checkpoint.candidate_evidence_refs.length > 0
      ? `evidence=${checkpoint.candidate_evidence_refs.join(",")}`
      : null,
    checkpoint.artifact_refs.length > 0 ? `artifacts=${checkpoint.artifact_refs.join(",")}` : null,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" | ") : null;
}

export async function checkpointPauseIfRequested(
	context: Pick<
		DaemonRunnerCommandContext,
		"currentGoalIds" | "refreshOperationalState" | "saveDaemonState" | "supervisor" | "abortSleep" | "broadcastGoalUpdated" | "state" | "runtimeRoot" | "journalQueue" | "logger" | "stateManager"
	>,
  goalId: string,
): Promise<boolean> {
  const current = context.state.safe_pause_goals?.[goalId];
  if (current?.state !== "pause_requested") {
    return false;
  }

  const store = safePauseStore(context);
  const checkpoint = buildSafePauseCheckpoint(context, goalId, current.reason);
  const paused = store
    ? await store.markPaused({ goalId, checkpoint })
    : {
        schema_version: "runtime-safe-pause-v1" as const,
        goal_id: goalId,
        state: "paused" as const,
        requested_at: current.requested_at,
        paused_at: checkpoint.checkpointed_at,
        updated_at: checkpoint.checkpointed_at,
        reason: current.reason,
        checkpoint,
      };
  context.state.safe_pause_goals = {
    ...(context.state.safe_pause_goals ?? {}),
    [goalId]: paused,
  };
  context.currentGoalIds.splice(0, context.currentGoalIds.length, ...context.currentGoalIds.filter((id) => id !== goalId));
  context.refreshOperationalState();
  context.supervisor?.deactivateGoal(goalId);
  await context.saveDaemonState();
  if (context.runtimeRoot) {
    try {
      const postmortemStore = new RuntimePostmortemReportStore(context.runtimeRoot);
      await postmortemStore.generate({
        goalId,
        finalStatus: "paused",
        trigger: "pause",
      });
      for (const runId of checkpoint.background_run_ids) {
        await postmortemStore.generate({
          goalId,
          runId,
          finalStatus: "paused",
          trigger: "pause",
        });
      }
    } catch (err) {
      context.logger?.warn("Failed to generate safe-pause postmortem", {
        goalId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  context.abortSleep();
  await context.broadcastGoalUpdated(goalId, "paused");
  return true;
}

export async function handleGoalPauseCommand(
	context: Pick<
		DaemonRunnerCommandContext,
		"currentGoalIds" | "refreshOperationalState" | "saveDaemonState" | "supervisor" | "abortSleep" | "broadcastGoalUpdated" | "state" | "runtimeRoot" | "journalQueue" | "logger" | "stateManager"
	>,
  goalId: string,
  reason = "safe pause requested",
): Promise<void> {
  const store = safePauseStore(context);
  const requested = store
    ? await store.requestPause({ goalId, reason, requestedBy: "daemon-command" })
    : {
        schema_version: "runtime-safe-pause-v1" as const,
        goal_id: goalId,
        state: "pause_requested" as const,
        requested_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        requested_by: "daemon-command",
        reason,
      };
  context.state.safe_pause_goals = {
    ...(context.state.safe_pause_goals ?? {}),
    [goalId]: requested,
  };
  context.refreshOperationalState();
  await context.saveDaemonState();
  context.supervisor?.deactivateGoal(goalId);
  context.abortSleep();

  if (!context.currentGoalIds.includes(goalId) || activeWorkerCount(context, goalId) === 0) {
    await checkpointPauseIfRequested(context, goalId);
    return;
  }

  await context.broadcastGoalUpdated(goalId, "pause_requested");
}

export async function handleGoalResumeCommand(
	context: Pick<
		DaemonRunnerCommandContext,
		"currentGoalIds" | "refreshOperationalState" | "saveDaemonState" | "supervisor" | "abortSleep" | "broadcastGoalUpdated" | "state" | "runtimeRoot" | "stateManager"
	>,
  goalId: string,
): Promise<void> {
  const store = safePauseStore(context);
  const existing = store ? await store.load(goalId) : context.state.safe_pause_goals?.[goalId] ?? null;
  if (!isResumableSafePauseState(existing)) {
    if (existing) {
      context.state.safe_pause_goals = {
        ...(context.state.safe_pause_goals ?? {}),
        [goalId]: existing,
      };
      context.refreshOperationalState();
      await context.saveDaemonState();
      await context.broadcastGoalUpdated(goalId, existing.state);
    }
    return;
  }
  const resumed = store
    ? await store.markResumed(goalId)
    : {
        schema_version: "runtime-safe-pause-v1" as const,
        goal_id: goalId,
        state: "resumed" as const,
        resumed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
  const resumeMetadata = existing?.checkpoint
    ? {
        waitResume: {
          type: "wait_resume" as const,
          strategyId: "safe-pause-resume",
          waitReason: buildSafePauseResumeReason(existing.checkpoint),
        },
      }
    : undefined;
  context.state.safe_pause_goals = {
    ...(context.state.safe_pause_goals ?? {}),
    [goalId]: resumed,
  };
  context.currentGoalIds.splice(
    0,
    context.currentGoalIds.length,
    ...buildResumeGoalIds(context.currentGoalIds, goalId),
  );
  context.refreshOperationalState();
  await context.saveDaemonState();
  context.supervisor?.activateGoal(goalId, resumeMetadata);
  context.abortSleep();
  await context.broadcastGoalUpdated(goalId, "active");
}

export async function restoreSafePauseStateFromStore(
  context: Pick<
    DaemonRunnerCommandContext,
    "currentGoalIds" | "refreshOperationalState" | "saveDaemonState" | "state" | "runtimeRoot" | "journalQueue" | "stateManager"
  >,
): Promise<RuntimeSafePauseRecord[]> {
  if (!context.runtimeRoot) {
    return [];
  }
  const records = await new RuntimeSafePauseStore(
    context.runtimeRoot,
    { controlBaseDir: context.stateManager.getBaseDir() },
  ).list();
  if (records.length === 0) {
    return [];
  }
  context.state.safe_pause_goals = Object.fromEntries(records.map((record) => [record.goal_id, record]));
  const pausedGoalIds = new Set(records
    .filter((record) => record.state === "pause_requested" || record.state === "paused")
    .map((record) => record.goal_id));
  if (pausedGoalIds.size > 0) {
    context.currentGoalIds.splice(
      0,
      context.currentGoalIds.length,
      ...context.currentGoalIds.filter((goalId) => !pausedGoalIds.has(goalId)),
    );
    deadletterPausedGoalActivations(context, pausedGoalIds);
    context.refreshOperationalState();
  }
  await context.saveDaemonState();
  return records;
}

function deadletterPausedGoalActivations(
  context: Pick<DaemonRunnerCommandContext, "journalQueue">,
  pausedGoalIds: ReadonlySet<string>,
): void {
  if (!context.journalQueue) {
    return;
  }
  const snapshot = context.journalQueue.snapshot();
  const messageIds = [
    ...Object.values(snapshot.pending).flat(),
    ...Object.values(snapshot.inflight).map((claim) => claim.messageId),
  ];
  for (const messageId of messageIds) {
    const record = context.journalQueue.get(messageId);
    const envelope = record?.envelope;
    if (
      envelope?.type === "event" &&
      envelope.name === "goal_activated" &&
      envelope.goal_id &&
      pausedGoalIds.has(envelope.goal_id)
    ) {
      context.journalQueue.deadletter(messageId, "goal is paused by safe-pause checkpoint");
    }
  }
}

export async function handleRuntimeControlCommand(
  context: Pick<DaemonRunnerCommandContext, "runtimeRoot" | "logger" | "beginGracefulShutdown" | "stateManager">,
  operationId: string,
  kind: RuntimeControlOperationKind,
): Promise<void> {
  const operationStore = new RuntimeOperationStore(
    context.runtimeRoot ?? undefined,
    { controlBaseDir: context.stateManager.getBaseDir() },
  );
  const operation = await operationStore.load(operationId);
  if (!operation) {
    context.logger.warn("Runtime control operation not found", { operation_id: operationId, kind });
    return;
  }

  if (kind !== "restart_daemon" && kind !== "restart_gateway") {
    const now = new Date().toISOString();
    await operationStore.save({
      ...operation,
      state: "failed",
      updated_at: now,
      completed_at: now,
      result: {
        ok: false,
        message: `Runtime control operation ${kind} is not implemented yet.`,
      },
    });
    return;
  }

  const now = new Date().toISOString();
  await operationStore.save({
    ...operation,
    state: "restarting",
    started_at: operation.started_at ?? now,
    updated_at: now,
    result: {
      ok: true,
      message:
        kind === "restart_gateway"
          ? "gateway restart is being handled by a daemon restart because the gateway runs in-process."
          : "daemon restart was accepted by the runtime command dispatcher.",
    },
  });

  context.logger.info("Runtime control requested daemon restart", { operation_id: operationId, kind });
  setTimeout(() => {
    context.beginGracefulShutdown();
  }, 25).unref?.();
}

export async function handleScheduleRunNowCommand(
  context: Pick<DaemonRunnerCommandContext, "scheduleEngine" | "logger">,
  scheduleId: string,
  allowEscalation: boolean,
): Promise<void> {
  if (!context.scheduleEngine) {
    throw new Error("ScheduleEngine is not configured");
  }

  await context.scheduleEngine.loadEntries();
  const entry = resolveScheduleEntry(context.scheduleEngine.getEntries(), scheduleId);
  if (!entry) {
    throw new Error(`Schedule not found: ${scheduleId}`);
  }

  const run = await context.scheduleEngine.runEntryNow(entry.id, {
    allowEscalation,
    preserveEnabled: true,
  });
  if (!run) {
    throw new Error(`Schedule not found: ${scheduleId}`);
  }

  context.logger.info("Schedule run-now completed", {
    schedule_id: entry.id,
    schedule_name: entry.name,
    status: run.result.status,
    reason: run.reason,
    allow_escalation: allowEscalation,
  });
}

export async function handleGoalCompletion(
  context: Pick<
    DaemonRunnerCommandContext,
    "state" | "saveDaemonState" | "runtimeOwnership" | "eventServer" | "stateManager" | "broadcastGoalUpdated"
  > & { currentLoopIndex: number; setCurrentLoopIndex(index: number): void },
  goalId: string,
  result: { status: string; totalIterations: number },
): Promise<void> {
  context.state.loop_count++;
  context.setCurrentLoopIndex(context.state.loop_count);
  context.state.last_loop_at = new Date().toISOString();
  await context.saveDaemonState();
  await context.runtimeOwnership.observeTaskExecution(
    result.status === "error"
      ? "failed"
      : result.status === "stalled"
        ? "degraded"
        : "ok",
    result.status === "error"
      ? `goal ${goalId} execution failed`
      : result.status === "stalled"
        ? `goal ${goalId} stalled`
        : undefined,
  );

  if (context.eventServer) {
    const goal = await context.stateManager.loadGoal(goalId).catch(() => null);
    void context.eventServer.broadcast?.("iteration_complete", {
      goalId,
      loopCount: context.state.loop_count,
      status: goal?.status ?? result.status,
      iterations: result.totalIterations,
    });
    void context.eventServer.broadcast?.("daemon_status", {
      status: context.state.status,
      activeGoals: context.state.active_goals,
      loopCount: context.state.loop_count,
      lastLoopAt: context.state.last_loop_at,
    });
  }
  await context.broadcastGoalUpdated(goalId, result.status);
}

export async function handleChatMessageCommand(
  context: Pick<DaemonRunnerCommandContext, "driveSystem" | "broadcastChatResponse" | "abortSleep">,
  goalId: string,
  message: string,
): Promise<void> {
  await writeChatMessageEvent(context.driveSystem as never, goalId, message);
  await context.broadcastChatResponse(goalId, message);
  context.abortSleep();
}

export async function runCommandWithHealth<T>(
  context: Pick<DaemonRunnerCommandContext, "runtimeOwnership">,
  commandName: string,
  fn: () => Promise<T>,
): Promise<T> {
  return runCommandWithHealthFn(
    commandName,
    fn,
    (status, reason) => context.runtimeOwnership.observeCommandAcceptance(status as "accepted" | "rejected" | "failed", reason),
  );
}

export async function handleApprovalResponseCommand(
  context: Pick<DaemonRunnerCommandContext, "approvalBroker" | "eventServer">,
  goalId: string | undefined,
  requestId: string,
  approved: boolean,
): Promise<void> {
  if (context.approvalBroker) {
    await context.approvalBroker.resolveApproval(requestId, approved, "dispatcher");
    return;
  }
  if (goalId && context.eventServer) {
    await context.eventServer.resolveApproval(requestId, approved);
  }
}
