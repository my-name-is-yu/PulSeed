import * as path from "node:path";
import type { LoopResult } from "../../orchestrator/loop/durable-loop.js";
import type { ProgressEvent } from "../../orchestrator/loop/durable-loop.js";
import type { GoalSchedule } from "../../platform/drive/types/drive.js";
import type { GoalRunAdmissionTriggerKind, RuntimeGraphRef } from "../personal-agent/index.js";
import { recordGoalRunAdmissionDecision } from "../personal-agent/index.js";
import { RuntimeOperatorHandoffStore } from "../store/operator-handoff-store.js";
import { projectOperatorHandoffSurfaceEvent } from "../operator-handoff-surface.js";
import { errorMessage } from "./runner-errors.js";
import { getDueWaitGoalIds, type WaitDeadlineResolution } from "./wait-deadline-resolver.js";

const MAX_IDLE_SLEEP_MS = 5_000;

export type GoalCycleRunnerContext = any;

function buildLoopCompletePayload(goalId: string, result: LoopResult): Record<string, unknown> {
  const lastIteration = result.iterations.at(-1);
  return {
    goalId,
    iterations: result.totalIterations,
    gap: lastIteration?.gapAggregate,
    status: result.finalStatus,
    executionMode: lastIteration?.executionMode
      ? {
          mode: lastIteration.executionMode.mode,
          source: lastIteration.executionMode.source,
          reason: lastIteration.executionMode.reason,
          changedAt: lastIteration.executionMode.changed_at,
          approvalRequiredToExplore: lastIteration.executionMode.approval_required_to_explore ?? false,
        }
      : undefined,
    wait: lastIteration?.waitExpiryOutcome
      ? {
          strategyId: lastIteration.waitStrategyId,
          status: lastIteration.waitExpiryOutcome.status,
          details: lastIteration.waitExpiryOutcome.details,
          approvalId: lastIteration.waitApprovalId,
          observeOnly: lastIteration.waitObserveOnly ?? false,
        }
      : undefined,
    finalization: lastIteration?.finalizationStatus && lastIteration.finalizationStatus.mode !== "no_deadline"
      ? {
          mode: lastIteration.finalizationStatus.mode,
          deadline: lastIteration.finalizationStatus.deadline,
          remainingMs: lastIteration.finalizationStatus.remaining_ms,
          remainingExplorationMs: lastIteration.finalizationStatus.remaining_exploration_ms,
          reservedFinalizationMs: lastIteration.finalizationStatus.reserved_finalization_ms,
          bestArtifact: lastIteration.finalizationStatus.finalization_plan?.best_artifact?.label ?? null,
          approvalRequiredActions:
            lastIteration.finalizationStatus.finalization_plan?.approval_required_actions.map((action) => action.label) ?? [],
        }
      : undefined,
  };
}

function buildDaemonStatusPayload(context: GoalCycleRunnerContext): Record<string, unknown> {
  return {
    status: context.state.status,
    activeGoals: context.state.active_goals,
    loopCount: context.state.loop_count,
    lastLoopAt: context.state.last_loop_at,
    waitingGoals: context.state.waiting_goals ?? [],
    nextObserveAt: context.state.next_observe_at ?? null,
    lastObserveAt: context.state.last_observe_at ?? null,
    lastWaitReason: context.state.last_wait_reason ?? null,
    approvalPendingCount: context.state.approval_pending_count ?? 0,
  };
}

function applyWaitDeadlineStatus(context: GoalCycleRunnerContext, waitDeadlines: unknown): void {
  const resolution = waitDeadlines as {
    next_observe_at?: string | null;
    waiting_goals?: Array<{ wait_reason?: string; approval_pending?: boolean; activation_kind?: string; internal_schedule?: boolean }>;
  } | null | undefined;
  const waitingGoals = Array.isArray(resolution?.waiting_goals) ? resolution.waiting_goals : [];
  context.state.waiting_goals = waitingGoals;
  context.state.next_observe_at = resolution?.next_observe_at ?? null;
  context.state.last_wait_reason = waitingGoals[0]?.wait_reason ?? null;
  context.state.approval_pending_count = waitingGoals.filter((goal) => goal.approval_pending === true).length;
}

function buildLoopErrorPayload(goalId: string, error: unknown, context: GoalCycleRunnerContext): Record<string, unknown> {
  const message = errorMessage(error);
  return {
    goalId,
    error: message,
    message,
    status: "error",
    crashCount: context.state?.crash_count,
    maxRetries: context.config?.crash_recovery?.max_retries,
  };
}

function getBaseDirFromGoalCycleContext(context: GoalCycleRunnerContext): string | undefined {
  if (typeof context.baseDir === "string") return context.baseDir;
  if (typeof context.stateManager?.getBaseDir === "function") return context.stateManager.getBaseDir();
  return undefined;
}

function findCycleSnapshotEntry(
  cycleSnapshot: unknown,
  goalId: string,
): { goalId: string; shouldActivate?: boolean; schedule?: GoalSchedule | null } | null {
  if (!Array.isArray(cycleSnapshot)) return null;
  return cycleSnapshot.find((entry): entry is { goalId: string; shouldActivate?: boolean; schedule?: GoalSchedule | null } =>
    Boolean(entry)
    && typeof entry === "object"
    && (entry as { goalId?: unknown }).goalId === goalId
  ) ?? null;
}

function findDueWaitGoal(
  waitDeadlines: WaitDeadlineResolution | null | undefined,
  goalId: string,
): WaitDeadlineResolution["waiting_goals"][number] | null {
  return waitDeadlines?.waiting_goals.find((goal) => goal.goal_id === goalId) ?? null;
}

function isScheduleDue(schedule: GoalSchedule | null | undefined): boolean {
  if (!schedule) return false;
  const dueAt = Date.parse(schedule.next_check_at);
  return Number.isFinite(dueAt) && dueAt <= Date.now();
}

function inferGoalRunAdmissionTrigger(input: {
  dueWaitGoal: WaitDeadlineResolution["waiting_goals"][number] | null;
  snapshotEntry: { shouldActivate?: boolean; schedule?: GoalSchedule | null } | null;
}): GoalRunAdmissionTriggerKind {
  if (input.dueWaitGoal) return "wait_resume";
  const schedule = input.snapshotEntry?.schedule ?? null;
  if (isScheduleDue(schedule)) return "schedule_due";
  if (input.snapshotEntry?.shouldActivate === true && schedule) return "external_signal";
  return "resident_cycle";
}

function goalRunAdmissionSourceEpoch(input: {
  triggerKind: GoalRunAdmissionTriggerKind;
  dueWaitGoal: WaitDeadlineResolution["waiting_goals"][number] | null;
  schedule: GoalSchedule | null;
  loopCount: unknown;
}): string {
  if (input.triggerKind === "wait_resume" && input.dueWaitGoal) {
    return input.dueWaitGoal.next_observe_at;
  }
  if (input.triggerKind === "schedule_due" && input.schedule) {
    return input.schedule.next_check_at;
  }
  return `daemon-loop:${String(input.loopCount ?? "unknown")}`;
}

function goalRunAdmissionRefs(input: {
  goalId: string;
  triggerKind: GoalRunAdmissionTriggerKind;
  dueWaitGoal: WaitDeadlineResolution["waiting_goals"][number] | null;
  schedule: GoalSchedule | null;
  loopCount: unknown;
}): RuntimeGraphRef[] {
  const refs: RuntimeGraphRef[] = [
    { kind: "daemon_state", ref: `loop:${String(input.loopCount ?? "unknown")}` },
  ];
  if (input.schedule) {
    refs.push(
      { kind: "goal_schedule", ref: input.schedule.goal_id },
      { kind: "schedule_wake", ref: `${input.goalId}:${input.schedule.next_check_at}` },
    );
  }
  if (input.dueWaitGoal) {
    refs.push(
      { kind: "wait_strategy", ref: input.dueWaitGoal.strategy_id },
      { kind: "schedule_wake", ref: `${input.goalId}:${input.dueWaitGoal.next_observe_at}` },
    );
  }
  if (input.triggerKind === "external_signal") {
    refs.push({ kind: "drive_event_queue", ref: input.goalId });
  }
  return refs;
}

async function recordDaemonGoalRunAdmission(input: {
  context: GoalCycleRunnerContext;
  goalId: string;
  cycleSnapshot: unknown;
  waitDeadlines: WaitDeadlineResolution | null | undefined;
  runPolicy: "bounded" | "resident";
  maxIterations: number | null;
}): Promise<void> {
  const snapshotEntry = findCycleSnapshotEntry(input.cycleSnapshot, input.goalId);
  const dueWaitGoal = findDueWaitGoal(input.waitDeadlines, input.goalId);
  const schedule = snapshotEntry?.schedule ?? null;
  const triggerKind = inferGoalRunAdmissionTrigger({ dueWaitGoal, snapshotEntry });
  const sourceEpoch = goalRunAdmissionSourceEpoch({
    triggerKind,
    dueWaitGoal,
    schedule,
    loopCount: input.context.state?.loop_count,
  });
  const sourceId = [
    "daemon-goal-cycle",
    input.goalId,
    triggerKind,
    sourceEpoch,
  ].join(":");
  const refs = goalRunAdmissionRefs({
    goalId: input.goalId,
    triggerKind,
    dueWaitGoal,
    schedule,
    loopCount: input.context.state?.loop_count,
  });

  await recordGoalRunAdmissionDecision({
    personalAgentRuntime: input.context.personalAgentRuntime,
    baseDir: getBaseDirFromGoalCycleContext(input.context),
    source: "daemon_goal_cycle",
    triggerKind,
    goalId: input.goalId,
    sourceId,
    sourceEpoch,
    highWatermark: sourceEpoch,
    runPolicy: input.runPolicy,
    maxIterations: input.maxIterations,
    decisionReason: `Daemon goal cycle admitted goal ${input.goalId} for DurableLoop execution from ${triggerKind}.`,
    currentRefs: refs,
    auditRefs: refs,
  });
}

async function broadcastOpenOperatorHandoffs(context: GoalCycleRunnerContext, goalId: string): Promise<void> {
  if (!context.eventServer) return;
  const runtimeRoot = context.runtimeRoot
    ?? (typeof context.stateManager?.getBaseDir === "function"
      ? path.join(context.stateManager.getBaseDir(), "runtime")
      : null);
  if (!runtimeRoot) return;
  const controlOptions = typeof context.stateManager?.getBaseDir === "function"
    ? { controlBaseDir: context.stateManager.getBaseDir() }
    : undefined;

  const broadcasted = context.operatorHandoffBroadcastedIds instanceof Set
    ? context.operatorHandoffBroadcastedIds
    : new Set<string>();
  context.operatorHandoffBroadcastedIds = broadcasted;

  try {
    const handoffs = await new RuntimeOperatorHandoffStore(runtimeRoot, controlOptions).listOpen();
    for (const handoff of handoffs) {
      if (handoff.goal_id && handoff.goal_id !== goalId) continue;
      if (broadcasted.has(handoff.handoff_id)) continue;
      broadcasted.add(handoff.handoff_id);
      await context.eventServer.broadcast("operator_handoff_required", projectOperatorHandoffSurfaceEvent(handoff));
    }
  } catch (err) {
    context.logger?.warn?.("Failed to broadcast operator handoffs", {
      goalId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function runDaemonGoalCycleLoop(context: GoalCycleRunnerContext): Promise<void> {
  while (context.running && !context.shuttingDown) {
    try {
      const goalIds = [...context.currentGoalIds];
      context.refreshOperationalState();
      const cycleSnapshot = await context.collectGoalCycleSnapshot(goalIds);
      const waitDeadlines = await context.resolveWaitDeadlines?.(goalIds) as WaitDeadlineResolution | undefined;
      if (waitDeadlines) {
        applyWaitDeadlineStatus(context, waitDeadlines);
      }
      const scheduledActiveGoals = await context.determineActiveGoals(goalIds, cycleSnapshot);
      const dueWaitGoalIds =
        waitDeadlines && !context.scheduleEngine
          ? getDueWaitGoalIds(waitDeadlines)
          : [];
      const activeGoals = [...new Set([...scheduledActiveGoals, ...dueWaitGoalIds])];
      await context.maybeRefreshProviderRuntime(activeGoals.length);

      if (activeGoals.length === 0) {
        context.logger.info("No goals need activation this cycle", { checked: goalIds.length });
      }

      for (const goalId of activeGoals) {
        if (!context.running) break;

        context.logger.info(`Running loop for goal: ${goalId}`);

        try {
          const iterationsPerCycle = context.config.iterations_per_cycle ?? 1;
          const runPolicy = context.config.run_policy?.mode ?? "resident";
          const boundedMaxIterations = context.config.run_policy?.max_iterations ?? iterationsPerCycle;
          const maxIterations = runPolicy === "resident" ? null : boundedMaxIterations;
          await recordDaemonGoalRunAdmission({
            context,
            goalId,
            cycleSnapshot,
            waitDeadlines,
            runPolicy,
            maxIterations,
          });
          const result: LoopResult = await context.coreLoop.run(goalId, {
            maxIterations,
            runPolicy,
            onProgress: (event: ProgressEvent) => {
              if (!context.eventServer) return;
              void context.eventServer.broadcast?.("progress", {
                goalId,
                ...event,
              });
            },
          });
          context.state.loop_count++;
          context.currentLoopIndex = context.state.loop_count;
          context.state.last_loop_at = new Date().toISOString();
          context.logger.info(`Loop completed for goal: ${goalId}`, {
            status: result.finalStatus,
            iterations: result.totalIterations,
          });
          if (context.eventServer) {
            const goal = await context.stateManager.loadGoal(goalId).catch(() => null);
            const lastIteration = result.iterations.at(-1);
            if (lastIteration?.waitObserveOnly) {
              context.state.last_observe_at = new Date().toISOString();
              void context.eventServer.broadcast?.("wait_status", {
                goalId,
                strategyId: lastIteration.waitStrategyId,
                outcome: lastIteration.waitExpiryOutcome,
                approvalId: lastIteration.waitApprovalId,
                skipReason: lastIteration.skipReason,
              });
            }
            void context.eventServer.broadcast?.("iteration_complete", {
              goalId,
              loopCount: context.state.loop_count,
              status: goal?.status ?? "unknown",
            });
            await broadcastOpenOperatorHandoffs(context, goalId);
            void context.eventServer.broadcast?.("loop_complete", buildLoopCompletePayload(goalId, result));
          }
          await context.broadcastGoalUpdated(goalId, result.finalStatus);
          await context.checkpointPauseIfRequested?.(goalId);
        } catch (err) {
          if (context.eventServer) {
            void context.eventServer.broadcast?.("loop_error", buildLoopErrorPayload(goalId, err, context));
          }
          context.handleLoopError(goalId, err);
        }

        if (!context.running) break;
      }

      context.refreshOperationalState();
      await context.saveDaemonState();
      if (context.eventServer) {
        void context.eventServer.broadcast?.("daemon_status", buildDaemonStatusPayload(context));
      }

      await context.processScheduleEntries();

      if (context.running) {
        await context.proactiveTick();
      }

      if (context.running) {
        await context.runRuntimeStoreMaintenance();
      }

      if (activeGoals.length > 0) {
        context.consecutiveIdleCycles = 0;
      } else {
        context.consecutiveIdleCycles++;
      }

      if (context.running) {
        const baseIntervalMs = context.getNextInterval(goalIds);
        const maxGapScore = await context.getMaxGapScore(goalIds, cycleSnapshot);
        const intervalMs = context.calculateAdaptiveInterval(
          baseIntervalMs,
          activeGoals.length,
          maxGapScore,
          context.consecutiveIdleCycles,
        );
        const idleAwareIntervalMs =
          activeGoals.length === 0 ? Math.min(intervalMs, MAX_IDLE_SLEEP_MS) : intervalMs;
        const sleepIntervalMs = waitDeadlines
          ? context.clampIntervalToWaitDeadline(idleAwareIntervalMs, waitDeadlines)
          : idleAwareIntervalMs;
        context.logger.info(`Sleeping for ${sleepIntervalMs}ms until next check`);
        await context.sleep(sleepIntervalMs);
      }
    } catch (err) {
      await context.handleCriticalError(err);
    }
  }

  await context.cleanup();
}
