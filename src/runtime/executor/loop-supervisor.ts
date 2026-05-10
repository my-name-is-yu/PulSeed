import { dirname, join } from 'node:path';
import { z } from 'zod';
import { GoalWorker, type GoalWorkerConfig, type WorkerResult } from './goal-worker.js';
import { createEnvelope } from '../types/envelope.js';
import type { DurableLoop } from '../../orchestrator/loop/durable-loop.js';
import type { DriveSystem } from '../../platform/drive/drive-system.js';
import type { StateManager } from '../../base/state/state-manager.js';
import type { Logger } from '../logger.js';
import type { GoalLeaseManager } from '../goal-lease-manager.js';
import type { JournalBackedQueue, JournalBackedQueueClaim } from '../queue/journal-backed-queue.js';
import { StateFenceError } from '../../base/utils/errors.js';
import { getPulseedDirPath } from '../../base/utils/paths.js';
import type { BackgroundRunLedger } from '../store/background-run-store.js';
import type { BackgroundRun, RuntimeSessionRef } from '../session-registry/types.js';
import type { WaitResumeActivation } from '../../base/types/goal-activation.js';
import type { LoopRunPolicyMode } from '../../orchestrator/loop/durable-loop.js';
import { createDaemonShutdownAbortReason } from '../../base/utils/abort-reason.js';
import { SupervisorStateStore } from '../store/supervisor-state-store.js';

export interface SupervisorConfig {
  concurrency: number;
  iterationsPerCycle: number;
  maxIterations?: number | null;
  maxCrashCount: number;
  crashBackoffBaseMs: number;
  runtimeRoot: string;
  /** @deprecated Normal runtime supervisor state is control DB backed; this remains only to infer runtimeRoot for legacy tests. */
  stateFilePath: string;
  pollIntervalMs: number;
  claimLeaseMs: number;
  leaseRenewIntervalMs: number;
  runPolicy: LoopRunPolicyMode;
  activeStopGraceMs: number;
  controlBaseDir?: string;
}

export interface SupervisorDeps {
  durableLoopFactory?: () => DurableLoop;
  /** @deprecated Use durableLoopFactory. */
  coreLoopFactory?: () => DurableLoop;
  journalQueue: JournalBackedQueue;
  goalLeaseManager: GoalLeaseManager;
  driveSystem: DriveSystem;
  stateManager: StateManager;
  logger?: Logger;
  backgroundRunLedger?: Pick<BackgroundRunLedger, 'load' | 'link' | 'started' | 'terminal'>;
  onCycleComplete?: (goalId: string, result: WorkerResult) => Promise<void> | void;
  onGoalComplete?: (goalId: string, result: WorkerResult) => Promise<void> | void;
  onBackgroundRunTerminal?: (run: BackgroundRun, result: WorkerResult) => Promise<void> | void;
  onEscalation?: (goalId: string, crashCount: number, lastError: string) => void;
}

export interface SupervisorState {
  workers: Array<{
    workerId: string;
    goalId: string | null;
    startedAt: number;
    iterations: number;
    backgroundRunId?: string | null;
    sessionId?: string | null;
    parentSessionId?: string | null;
  }>;
  crashCounts: Record<string, number>;
  suspendedGoals: string[];
  updatedAt: number;
}

interface DurableGoalActivation {
  goalId: string;
  claim: JournalBackedQueueClaim;
  ownerToken: string;
  attemptId: string;
  backgroundRun?: GoalActivationBackgroundRun;
  waitResume?: WaitResumeActivation;
}

type GoalActivation = DurableGoalActivation;

export interface GoalActivationBackgroundRun {
  backgroundRunId: string;
  parentSessionId?: string | null;
}

export interface ActivateGoalOptions {
  backgroundRun?: GoalActivationBackgroundRun;
  waitResume?: WaitResumeActivation;
}

const DEFAULT_CONFIG: SupervisorConfig = {
  concurrency: 4,
  iterationsPerCycle: 5,
  maxCrashCount: 3,
  crashBackoffBaseMs: 1000,
  runtimeRoot: getPulseedDirPath(),
  stateFilePath: join(getPulseedDirPath(), 'supervisor-state.json'),
  pollIntervalMs: 100,
  claimLeaseMs: 30_000,
  leaseRenewIntervalMs: 10_000,
  runPolicy: 'resident',
  activeStopGraceMs: 5_000,
};

const SupervisorCrashCountSchema = z.number().finite().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

function workerStatusToBackgroundRunStatus(
  status: WorkerResult['status'],
): 'succeeded' | 'failed' | 'cancelled' {
  if (status === 'completed' || status === 'finalization') return 'succeeded';
  if (status === 'stopped') return 'cancelled';
  return 'failed';
}

export class LoopSupervisor {
  private workers: GoalWorker[] = [];
  private activeGoals: Map<string, GoalWorker> = new Map();
  private activeBackgroundRuns: Map<string, {
    backgroundRunId: string;
    sessionId: string;
    parentSessionId: string | null;
  }> = new Map();
  private crashCounts: Map<string, number> = new Map();
  private suspendedGoals: Set<string> = new Set();
  private stoppedGoals: Set<string> = new Set();
  private running: boolean = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly config: SupervisorConfig;
  private readonly deps: SupervisorDeps;
  private readonly supervisorStateStore: SupervisorStateStore;
  private polling: boolean = false;
  private currentPoll: Promise<void> | null = null;
  private runningExecutions: Array<{
    promise: Promise<void>;
    controller: AbortController;
    goalId: string;
    workerId: string;
    activation: GoalActivation;
  }> = [];
  private shutdownRelinquishedClaimTokens: Set<string> = new Set();
  private shutdownRelinquishedWorkerIds: Set<string> = new Set();
  private pendingTimers: Set<ReturnType<typeof setTimeout>> = new Set();

  constructor(deps: SupervisorDeps, config?: Partial<SupervisorConfig>) {
    this.deps = deps;
    this.config = { ...DEFAULT_CONFIG, ...config };
    const runtimeRoot = config?.runtimeRoot ?? dirname(this.config.stateFilePath);
    this.supervisorStateStore = new SupervisorStateStore(runtimeRoot, {
      controlBaseDir: this.config.controlBaseDir,
    });
  }

  async start(initialGoalIds: string[]): Promise<void> {
    const workerCfg: GoalWorkerConfig = {
      iterationsPerCycle: this.config.iterationsPerCycle,
      maxIterations: this.config.maxIterations,
      runPolicy: this.config.runPolicy,
    };
    const durableLoopFactory = resolveDurableLoopFactory(this.deps);
    for (let i = 0; i < this.config.concurrency; i++) {
      this.workers.push(new GoalWorker(durableLoopFactory(), workerCfg, {
        onRunStart: () => {
          this.persistState();
        },
        onRunComplete: async (loopResult, cumulativeIterations) => {
          await this.deps.onCycleComplete?.(loopResult.goalId, {
            goalId: loopResult.goalId,
            status: loopResult.finalStatus,
            totalIterations: cumulativeIterations,
            durationMs: 0,
            error: loopResult.errorMessage,
          });
          this.persistState();
        },
      }));
    }

    this.running = true;
    this.shutdownRelinquishedClaimTokens.clear();
    this.shutdownRelinquishedWorkerIds.clear();
    this.loadState();
    this.persistState();

    for (const goalId of initialGoalIds) {
      this.enqueueGoalActivation(goalId);
    }

    this.schedulePoll();
    this.pollTimer = setInterval(() => {
      this.schedulePoll();
    }, this.config.pollIntervalMs);
  }

  async shutdown(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const timer of this.pendingTimers) clearTimeout(timer);
    this.pendingTimers.clear();
    const pollCompleted = await waitForExecutions(
      this.currentPoll ? [this.currentPoll] : [],
      this.config.activeStopGraceMs
    );
    if (!pollCompleted) {
      this.deps.logger?.warn('Supervisor shutdown returned before active poll settled', {
        timeoutMs: this.config.activeStopGraceMs,
      });
    }
    const activeExecutions = [...this.runningExecutions];
    if (activeExecutions.length > 0) {
      this.deps.logger?.warn('Aborting active goal executions during supervisor shutdown', {
        activeCount: activeExecutions.length,
        goalIds: activeExecutions.map((execution) => execution.goalId),
      });
      for (const execution of activeExecutions) {
        execution.controller.abort(createDaemonShutdownAbortReason('supervisor shutdown requested'));
      }
    }
    const completed = await waitForExecutions(
      activeExecutions.map((execution) => execution.promise),
      this.config.activeStopGraceMs
    );
    if (!completed) {
      await Promise.all([...this.runningExecutions].map((execution) =>
        this.relinquishActiveExecutionAfterShutdownGrace(execution)
      ));
      this.deps.logger?.warn('Supervisor shutdown returned before active executions settled', {
        activeCount: this.runningExecutions.length,
        timeoutMs: this.config.activeStopGraceMs,
      });
    }
    this.persistState();
  }

  getState(): SupervisorState {
    return {
      workers: this.workers.map(w => {
        const backgroundRun = this.activeBackgroundRuns.get(w.id);
        const goalId = this.shutdownRelinquishedWorkerIds.has(w.id) ? null : w.getCurrentGoalId();
        return {
          workerId: w.id,
          goalId,
          startedAt: w.getStartedAt(),
          iterations: w.getIterations(),
          ...(backgroundRun
            ? {
                backgroundRunId: backgroundRun.backgroundRunId,
                sessionId: backgroundRun.sessionId,
                parentSessionId: backgroundRun.parentSessionId,
              }
            : {}),
        };
      }),
      crashCounts: Object.fromEntries(this.crashCounts),
      suspendedGoals: [...this.suspendedGoals],
      updatedAt: Date.now(),
    };
  }

  replaceIdleWorkers(durableLoopFactory: () => DurableLoop): void {
    if (this.activeGoals.size > 0 || this.workers.some((worker) => !worker.isIdle())) {
      return;
    }

    const workerCfg: GoalWorkerConfig = {
      iterationsPerCycle: this.config.iterationsPerCycle,
      maxIterations: this.config.maxIterations,
      runPolicy: this.config.runPolicy,
    };
    this.workers = [];
    for (let i = 0; i < this.config.concurrency; i++) {
      this.workers.push(new GoalWorker(durableLoopFactory(), workerCfg, {
        onRunComplete: async (loopResult, cumulativeIterations) => {
          await this.deps.onCycleComplete?.(loopResult.goalId, {
            goalId: loopResult.goalId,
            status: loopResult.finalStatus,
            totalIterations: cumulativeIterations,
            durationMs: 0,
            error: loopResult.errorMessage,
          });
          this.persistState();
        },
      }));
    }
  }

  activateGoal(goalId: string, options: ActivateGoalOptions = {}): void {
    this.stoppedGoals.delete(goalId);
    this.suspendedGoals.delete(goalId);
    this.enqueueGoalActivation(goalId, options);
  }

  deactivateGoal(goalId: string): void {
    this.stoppedGoals.add(goalId);
  }

  private schedulePoll(): void {
    if (this.currentPoll !== null) {
      return;
    }
    const poll = this.pollAndAssign();
    this.currentPoll = poll;
    void poll.finally(() => {
      if (this.currentPoll === poll) {
        this.currentPoll = null;
      }
    });
  }

  private enqueueGoalActivation(goalId: string, options: ActivateGoalOptions = {}): void {
    if (this.stoppedGoals.has(goalId)) {
      return;
    }

    const backgroundRunId = options.backgroundRun?.backgroundRunId;
    const envelope = createEnvelope({
      type: 'event',
      name: 'goal_activated',
      source: 'supervisor',
      goal_id: goalId,
      payload: {
        ...(backgroundRunId
          ? {
              backgroundRun: {
                backgroundRunId,
                ...(options.backgroundRun?.parentSessionId !== undefined
                  ? { parentSessionId: options.backgroundRun.parentSessionId }
                  : {}),
              },
            }
          : {}),
        ...(options.waitResume ? { wait_resume: options.waitResume } : {}),
      },
      priority: 'normal',
      dedupe_key: backgroundRunId ? `goal_activated:${goalId}:${backgroundRunId}` : `goal_activated:${goalId}`,
    });

    const accepted = this.deps.journalQueue.accept(envelope);
    if (!accepted.accepted && !accepted.duplicate) {
      this.deps.logger?.warn('Failed to enqueue durable goal activation', {
        goalId,
        envelopeId: envelope.id,
      });
    }
  }

  private async pollAndAssign(): Promise<void> {
    if (!this.running || this.polling) return;
    this.polling = true;

    const idleWorkers = this.workers.filter(w => w.isIdle());

    try {
      for (const worker of idleWorkers) {
        const dispatch = await this.claimNextDispatch(worker.id);
        if (!dispatch) break;

        const goalId = dispatch.goalId;
        if (this.activeGoals.has(goalId)) {
          const activeWorker = this.activeGoals.get(goalId)!;
          activeWorker.requestExtend();
          await this.markCoalescedBackgroundRun(dispatch, activeWorker);
          await this.completeClaim(dispatch);
          continue;
        }

        if (this.stoppedGoals.has(goalId)) {
          await this.completeClaim(dispatch);
          continue;
        }

        if (this.suspendedGoals.has(goalId)) {
          await this.failClaim(dispatch, 'goal suspended', false);
          continue;
        }

        if (!(await this.acquireExecutionLease(worker, dispatch))) {
          await this.failClaim(dispatch, 'goal lease unavailable', true);
          continue;
        }

        if (!this.running) {
          await this.failClaim(dispatch, 'supervisor stopping', true);
          await this.releaseExecutionLease(dispatch);
          break;
        }

        this.activeGoals.set(goalId, worker);
        const controller = new AbortController();
        const execution = this.executeWorker(worker, dispatch, controller.signal);
        this.persistState();
        const trackedExecution = {
          promise: execution,
          controller,
          goalId,
          workerId: worker.id,
          activation: dispatch,
        };
        this.runningExecutions.push(trackedExecution);
        execution.finally(() => {
          const idx = this.runningExecutions.indexOf(trackedExecution);
          if (idx !== -1) this.runningExecutions.splice(idx, 1);
        });
      }
    } finally {
      this.polling = false;
    }
  }

  private async claimNextDispatch(workerId: string): Promise<GoalActivation | null> {
    const claim = this.deps.journalQueue.claim(
      workerId,
      this.config.claimLeaseMs,
      (envelope) => envelope.type === 'event' && envelope.name === 'goal_activated' && Boolean(envelope.goal_id)
    );
    if (!claim || !claim.envelope.goal_id) {
      return null;
    }
    return {
      goalId: claim.envelope.goal_id,
      claim,
      ownerToken: claim.claimToken,
      attemptId: claim.claimToken,
      backgroundRun: this.extractActivationBackgroundRun(claim.envelope.payload),
      waitResume: this.extractActivationWaitResume(claim.envelope.payload),
    };
  }

  private extractActivationBackgroundRun(payload: unknown): GoalActivationBackgroundRun | undefined {
    if (!payload || typeof payload !== 'object') return undefined;
    const backgroundRun = (payload as Record<string, unknown>)['backgroundRun'];
    if (!backgroundRun || typeof backgroundRun !== 'object') return undefined;
    const input = backgroundRun as Record<string, unknown>;
    const backgroundRunId = input['backgroundRunId'];
    if (typeof backgroundRunId !== 'string' || backgroundRunId.trim() === '') return undefined;
    const parentSessionId = input['parentSessionId'];
    return {
      backgroundRunId,
      ...(typeof parentSessionId === 'string' || parentSessionId === null ? { parentSessionId } : {}),
    };
  }

  private extractActivationWaitResume(payload: unknown): WaitResumeActivation | undefined {
    if (!payload || typeof payload !== 'object') return undefined;
    const waitResume = (payload as Record<string, unknown>)['wait_resume'];
    if (!waitResume || typeof waitResume !== 'object') return undefined;
    const input = waitResume as Record<string, unknown>;
    if (input['type'] !== 'wait_resume') return undefined;
    const strategyId = input['strategyId'];
    if (typeof strategyId !== 'string' || strategyId.trim() === '') return undefined;
    return {
      type: 'wait_resume',
      strategyId,
      ...(typeof input['scheduleEntryId'] === 'string' ? { scheduleEntryId: input['scheduleEntryId'] as string } : {}),
      ...(typeof input['nextObserveAt'] === 'string' || input['nextObserveAt'] === null ? { nextObserveAt: input['nextObserveAt'] as string | null } : {}),
      ...(typeof input['waitReason'] === 'string' || input['waitReason'] === null ? { waitReason: input['waitReason'] as string | null } : {}),
    };
  }

  private async acquireExecutionLease(worker: GoalWorker, activation: GoalActivation): Promise<boolean> {
    const lease = await this.deps.goalLeaseManager.acquire(activation.goalId, {
      workerId: worker.id,
      ownerToken: activation.ownerToken,
      attemptId: activation.attemptId,
      leaseMs: this.config.claimLeaseMs,
    });
    return lease !== null;
  }

  private startLeaseRenewLoop(activation: GoalActivation, onLeaseLost: () => void): () => void {
    let stopped = false;
    let renewing = false;
    const timer = setInterval(() => {
      if (stopped || renewing) return;

      renewing = true;
      void (async () => {
        try {
          const renewedClaim = this.deps.journalQueue.renew(
            activation.claim.claimToken,
            this.config.claimLeaseMs
          );
          const renewedLease = await this.deps.goalLeaseManager.renew(
            activation.goalId,
            activation.ownerToken,
            { leaseMs: this.config.claimLeaseMs }
          );

          if (!renewedClaim || !renewedLease) {
            stopped = true;
            clearInterval(timer);
            this.deps.logger?.warn('Lost durable execution ownership during renewal', {
              goalId: activation.goalId,
              claimToken: activation.claim.claimToken,
            });
            onLeaseLost();
          }
        } catch (err) {
          this.deps.logger?.warn('Failed to renew durable execution ownership', {
            goalId: activation.goalId,
            error: err instanceof Error ? err.message : String(err),
          });
        } finally {
          renewing = false;
        }
      })();
    }, this.config.leaseRenewIntervalMs);

    timer.unref?.();

    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }

  private async executeWorker(worker: GoalWorker, activation: GoalActivation, abortSignal?: AbortSignal): Promise<void> {
    const { goalId } = activation;
    let ownershipLost = false;
    this.installWriteFence(activation);
    const stopRenewal = this.startLeaseRenewLoop(activation, () => {
      ownershipLost = true;
    });
    this.setActiveBackgroundRun(worker, activation);
    await this.markBackgroundRunStarted(activation, worker);

    try {
      const result: WorkerResult = await worker.execute(goalId, {
        ...(activation.backgroundRun ? { backgroundRun: activation.backgroundRun } : {}),
        ...(activation.waitResume ? { waitResume: activation.waitResume } : {}),
        ...(abortSignal ? { abortSignal } : {}),
      });

      if (this.shutdownRelinquishedClaimTokens.has(activation.claim.claimToken)) {
        this.deps.logger?.warn('Skipping completion for shutdown-relinquished goal execution', {
          goalId,
          claimToken: activation.claim.claimToken,
          workerId: worker.id,
          status: result.status,
        });
        return;
      }

      if (result.status === 'error') {
        const count = (this.crashCounts.get(goalId) ?? 0) + 1;
        this.crashCounts.set(goalId, count);

        if (count >= this.config.maxCrashCount) {
          this.suspendedGoals.add(goalId);
          this.deps.logger?.warn('Goal suspended after max crashes', {
            goalId,
            crashCount: count,
          });
          this.deps.onEscalation?.(goalId, count, result.error ?? 'unknown error');
          await this.markBackgroundRunTerminal(activation, result);
          await this.failClaim(
            activation,
            result.error ?? 'goal suspended after max crashes',
            false,
            ownershipLost
          );
        } else {
          const backoffMs = this.calculateCrashBackoff(count);
          await this.deferDurableRetry(
            activation,
            result.error ?? 'goal execution failed',
            backoffMs,
            ownershipLost
          );
        }

        return;
      }

      this.crashCounts.delete(goalId);
      this.suspendedGoals.delete(goalId);

      try {
        await this.deps.onGoalComplete?.(goalId, result);
      } catch (err) {
        this.deps.logger?.warn('Goal completion callback failed', {
          goalId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      await this.markBackgroundRunTerminal(activation, result);
      await this.completeClaim(activation, ownershipLost);
    } finally {
      stopRenewal();
      this.clearWriteFence(goalId);
      await this.releaseExecutionLease(activation);
      this.activeGoals.delete(goalId);
      this.activeBackgroundRuns.delete(worker.id);
      this.persistState();
    }
  }

  private async relinquishActiveExecutionAfterShutdownGrace(execution: {
    goalId: string;
    workerId: string;
    activation: GoalActivation;
  }): Promise<void> {
    const { activation } = execution;
    if (this.shutdownRelinquishedClaimTokens.has(activation.claim.claimToken)) {
      return;
    }

    this.shutdownRelinquishedClaimTokens.add(activation.claim.claimToken);
    this.shutdownRelinquishedWorkerIds.add(execution.workerId);
    this.activeGoals.delete(execution.goalId);
    this.activeBackgroundRuns.delete(execution.workerId);

    const nacked = this.deps.journalQueue.nack(
      activation.claim.claimToken,
      'daemon shutdown interrupted active execution',
      true,
    );
    let leaseReleased = false;
    try {
      leaseReleased = await this.deps.goalLeaseManager.release(activation.goalId, activation.ownerToken);
    } catch (err) {
      this.deps.logger?.warn('Failed to release shutdown-relinquished goal lease', {
        goalId: activation.goalId,
        workerId: execution.workerId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    this.deps.logger?.warn('Relinquished active goal execution after supervisor shutdown grace', {
      goalId: activation.goalId,
      workerId: execution.workerId,
      claimToken: activation.claim.claimToken,
      claimRequeued: nacked,
      leaseReleased,
    });
    this.persistState();
  }

  private coreLoopSessionId(worker: GoalWorker): string {
    return `session:coreloop:${worker.id}`;
  }

  private setActiveBackgroundRun(worker: GoalWorker, activation: GoalActivation): void {
    const runId = activation.backgroundRun?.backgroundRunId;
    if (!runId) return;
    this.activeBackgroundRuns.set(worker.id, {
      backgroundRunId: runId,
      sessionId: this.coreLoopSessionId(worker),
      parentSessionId: activation.backgroundRun?.parentSessionId ?? null,
    });
  }

  private supervisorStateRef(): RuntimeSessionRef {
    return {
      kind: 'supervisor_state',
      id: 'current',
      path: null,
      relative_path: 'control-db:supervisor_state_snapshots/current',
      updated_at: null,
    };
  }

  private evidenceLedgerRef(activation: GoalActivation): RuntimeSessionRef {
    const runId = activation.backgroundRun?.backgroundRunId ?? null;
    return {
      kind: 'evidence_ledger',
      id: runId,
      path: null,
      relative_path: runId ? `control-db://runtime-evidence/run/${encodeURIComponent(runId)}` : null,
      updated_at: null,
    };
  }

  private async mergeBackgroundRunSourceRefs(
    runId: string,
    refs: RuntimeSessionRef[],
  ): Promise<RuntimeSessionRef[]> {
    const existing = await this.deps.backgroundRunLedger?.load(runId).catch(() => null);
    const currentRefs = existing?.source_refs ?? [];
    const merged = [...currentRefs];
    for (const ref of refs) {
      const duplicate = merged.some((existingRef) =>
        existingRef.kind === ref.kind
        && existingRef.id === ref.id
        && existingRef.path === ref.path
        && existingRef.relative_path === ref.relative_path
      );
      if (!duplicate) merged.push(ref);
    }
    return merged;
  }

  private async markBackgroundRunStarted(activation: GoalActivation, worker: GoalWorker): Promise<void> {
    const runId = activation.backgroundRun?.backgroundRunId;
    if (!runId || !this.deps.backgroundRunLedger) return;
    const sourceRefs = await this.mergeBackgroundRunSourceRefs(runId, [
      this.supervisorStateRef(),
      this.evidenceLedgerRef(activation),
    ]);
    try {
      if (activation.backgroundRun?.parentSessionId !== undefined) {
        await this.deps.backgroundRunLedger.link(runId, {
          parent_session_id: activation.backgroundRun.parentSessionId,
          child_session_id: this.coreLoopSessionId(worker),
          source_refs: sourceRefs,
        });
      }
      await this.deps.backgroundRunLedger.started(runId, {
        child_session_id: this.coreLoopSessionId(worker),
        source_refs: sourceRefs,
      });
    } catch (err) {
      this.deps.logger?.warn('Failed to mark background run started', {
        goalId: activation.goalId,
        backgroundRunId: runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async markBackgroundRunTerminal(activation: GoalActivation, result: WorkerResult): Promise<void> {
    const runId = activation.backgroundRun?.backgroundRunId;
    if (!runId || !this.deps.backgroundRunLedger) return;
    const sourceRefs = await this.mergeBackgroundRunSourceRefs(runId, [
      this.supervisorStateRef(),
      this.evidenceLedgerRef(activation),
    ]);
    try {
      const run = await this.deps.backgroundRunLedger.terminal(runId, {
        status: workerStatusToBackgroundRunStatus(result.status),
        summary: `DurableLoop ${result.status} after ${result.totalIterations} iteration(s).`,
        error: result.error ?? null,
        source_refs: sourceRefs,
      });
      if (run.notify_policy !== 'silent' && run.pinned_reply_target) {
        await this.deps.onBackgroundRunTerminal?.(run, result);
      }
    } catch (err) {
      this.deps.logger?.warn('Failed to mark background run terminal', {
        goalId: activation.goalId,
        backgroundRunId: runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async markCoalescedBackgroundRun(activation: GoalActivation, activeWorker: GoalWorker): Promise<void> {
    const runId = activation.backgroundRun?.backgroundRunId;
    if (!runId || !this.deps.backgroundRunLedger) return;
    const sourceRefs = await this.mergeBackgroundRunSourceRefs(runId, [
      this.supervisorStateRef(),
      this.evidenceLedgerRef(activation),
    ]);
    const childSessionId = this.coreLoopSessionId(activeWorker);
    try {
      await this.deps.backgroundRunLedger.link(runId, {
        parent_session_id: activation.backgroundRun?.parentSessionId ?? null,
        child_session_id: childSessionId,
        source_refs: sourceRefs,
      });
      await this.deps.backgroundRunLedger.started(runId, {
        child_session_id: childSessionId,
        source_refs: sourceRefs,
      });
      const run = await this.deps.backgroundRunLedger.terminal(runId, {
        status: "cancelled",
        summary: `DurableLoop activation coalesced into active worker ${activeWorker.id}.`,
        source_refs: sourceRefs,
      });
      if (run.notify_policy !== 'silent' && run.pinned_reply_target) {
        await this.deps.onBackgroundRunTerminal?.(run, {
          goalId: activation.goalId,
          status: 'stopped',
          totalIterations: 0,
          durationMs: 0,
        });
      }
    } catch (err) {
      this.deps.logger?.warn('Failed to settle coalesced background run', {
        goalId: activation.goalId,
        backgroundRunId: runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async completeClaim(activation: GoalActivation, ownershipLost = false): Promise<void> {
    if (ownershipLost) {
      this.deps.logger?.warn('Skipping ack because durable execution ownership was lost', {
        goalId: activation.goalId,
        claimToken: activation.claim.claimToken,
      });
      return;
    }

    const acked = this.deps.journalQueue.ack(activation.claim.claimToken);
    if (!acked) {
      this.deps.logger?.warn('Failed to ack durable goal activation claim', {
        goalId: activation.goalId,
        claimToken: activation.claim.claimToken,
      });
    }
  }

  private async failClaim(
    activation: GoalActivation,
    reason: string,
    requeue: boolean,
    ownershipLost = false
  ): Promise<void> {
    if (ownershipLost) {
      return;
    }

    const settled = this.deps.journalQueue.nack(activation.claim.claimToken, reason, requeue);
    if (!settled) {
      this.deps.logger?.warn('Failed to nack durable goal activation claim', {
        goalId: activation.goalId,
        claimToken: activation.claim.claimToken,
        reason,
        requeue,
      });
    }
  }

  private async releaseExecutionLease(activation: GoalActivation): Promise<void> {
    try {
      await this.deps.goalLeaseManager.release(activation.goalId, activation.ownerToken);
    } catch (err) {
      this.deps.logger?.warn('Failed to release goal execution lease', {
        goalId: activation.goalId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private calculateCrashBackoff(crashCount: number): number {
    const jitter = Math.random() * 0.3;
    return Math.min(
      this.config.crashBackoffBaseMs * Math.pow(2, crashCount - 1) * (1 + jitter),
      30_000
    );
  }

  private async deferDurableRetry(
    activation: GoalActivation,
    reason: string,
    backoffMs: number,
    ownershipLost: boolean
  ): Promise<void> {
    if (ownershipLost) {
      return;
    }

    const leaseMs = backoffMs + Math.max(this.config.pollIntervalMs, 100);
    const renewedClaim = this.deps.journalQueue.renew(activation.claim.claimToken, leaseMs);
    if (!renewedClaim) {
      return;
    }

    const timer = setTimeout(() => {
      this.pendingTimers.delete(timer);
      if (!this.running) return;
      void this.failClaim(activation, reason, true, false);
    }, backoffMs);
    this.pendingTimers.add(timer);
  }

  private installWriteFence(activation: GoalActivation): void {
    this.deps.stateManager.setWriteFence?.(activation.goalId, async () => {
      const current = await this.deps.goalLeaseManager.read(activation.goalId);
      if (
        !current ||
        current.owner_token !== activation.ownerToken ||
        current.attempt_id !== activation.attemptId ||
        current.lease_until <= Date.now()
      ) {
        throw new StateFenceError(
          `Write fence rejected commit for goal "${activation.goalId}" because execution ownership is stale`
        );
      }
    });
  }

  private clearWriteFence(goalId: string): void {
    this.deps.stateManager.clearWriteFence?.(goalId);
  }

  private persistState(): void {
    const state = this.getState();
    try {
      this.supervisorStateStore.saveSync(state);
    } catch (err) {
      this.deps.logger?.error('Failed to persist supervisor state', { err: String(err) });
    }
  }

  private loadState(): void {
    try {
      const state = this.supervisorStateStore.loadSync();
      if (!state) return;
      for (const [goalId, count] of validCrashCountEntries(state)) {
        this.crashCounts.set(goalId, count);
      }
    } catch {
      // Corrupt or missing state — start fresh
    }
  }
}

function validCrashCountEntries(state: unknown): Array<[string, number]> {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return [];
  const crashCounts = (state as Record<string, unknown>)['crashCounts'];
  if (!crashCounts || typeof crashCounts !== 'object' || Array.isArray(crashCounts)) return [];

  return Object.entries(crashCounts).flatMap(([goalId, rawCount]) => {
    if (goalId.length === 0) return [];
    const parsed = SupervisorCrashCountSchema.safeParse(rawCount);
    return parsed.success ? [[goalId, parsed.data]] : [];
  });
}

function resolveDurableLoopFactory(deps: SupervisorDeps): () => DurableLoop {
  const factory = deps.durableLoopFactory ?? deps.coreLoopFactory;
  if (!factory) {
    throw new Error("LoopSupervisor requires a DurableLoop factory.");
  }
  return factory;
}

async function waitForExecutions(promises: Promise<void>[], timeoutMs: number): Promise<boolean> {
  if (promises.length === 0) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
    });
    const settled = Promise.allSettled(promises).then(() => true);
    return await Promise.race([settled, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
