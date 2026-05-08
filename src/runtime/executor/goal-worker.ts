import { randomUUID } from 'node:crypto';
import type { DurableLoop } from '../../orchestrator/loop/durable-loop.js';
import type { LoopResult } from '../../orchestrator/loop/durable-loop.js';
import type { LoopRunPolicyMode } from '../../orchestrator/loop/durable-loop.js';
import type { GoalRunActivationContext } from '../../base/types/goal-activation.js';

export interface GoalWorkerConfig {
  iterationsPerCycle: number; // default 5
  maxIterations?: number | null;
  runPolicy?: LoopRunPolicyMode;
}

export type WorkerStatus = 'idle' | 'running' | 'crashed';

export interface WorkerResult {
  goalId: string;
  status: 'completed' | 'stalled' | 'max_iterations' | 'error' | 'stopped' | 'finalization';
  totalIterations: number;
  durationMs: number;
  error?: string;
}

export interface GoalWorkerExecuteOptions {
  backgroundRun?: GoalRunActivationContext["backgroundRun"];
  waitResume?: GoalRunActivationContext["waitResume"];
  abortSignal?: AbortSignal;
}

function toWorkerStatus(finalStatus: LoopResult['finalStatus']): WorkerResult['status'] {
  return finalStatus;
}

export class GoalWorker {
  readonly id: string;
  private status: WorkerStatus = 'idle';
  private currentGoalId: string | null = null;
  private startedAt: number = 0;
  private currentIterations: number = 0;
  private extendRequested: boolean = false;

  constructor(
    private readonly durableLoop: DurableLoop,
    private readonly config: GoalWorkerConfig = { iterationsPerCycle: 5 },
    private readonly hooks?: {
      onRunStart?: (goalId: string) => Promise<void> | void;
      onRunComplete?: (result: LoopResult, cumulativeIterations: number) => Promise<void> | void;
    }
  ) {
    this.id = randomUUID();
  }

  async execute(goalId: string, activation?: GoalWorkerExecuteOptions): Promise<WorkerResult> {
    this.status = 'running';
    this.currentGoalId = goalId;
    this.startedAt = Date.now();
    this.currentIterations = 0;
    this.extendRequested = false;
    await this.hooks?.onRunStart?.(goalId);

    try {
      let lastResult: LoopResult | undefined;
      let cumulativeIterations = 0;
      do {
        this.extendRequested = false;
        const maxIterations =
          this.config.runPolicy === 'resident'
            ? null
            : this.config.maxIterations ?? this.config.iterationsPerCycle;
        lastResult = await this.durableLoop.run(goalId, {
          maxIterations,
          ...(this.config.runPolicy ? { runPolicy: this.config.runPolicy } : {}),
          ...(activation ? { activation: toGoalRunActivationContext(activation) } : {}),
          ...(activation?.abortSignal ? { abortSignal: activation.abortSignal } : {}),
        });
        cumulativeIterations += lastResult.totalIterations;
        this.currentIterations = cumulativeIterations;
        try {
          await this.hooks?.onRunComplete?.(lastResult, cumulativeIterations);
        } catch {
          // Bookkeeping callbacks must not turn a successful loop into a worker crash.
        }

        if (!this.extendRequested) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      } while (this.extendRequested);

      this.status = 'idle';
      return {
        goalId,
        status: toWorkerStatus(lastResult.finalStatus),
        totalIterations: cumulativeIterations,
        durationMs: Date.now() - this.startedAt,
        error: lastResult.errorMessage,
      };
    } catch (err) {
      if (activation?.abortSignal?.aborted) {
        this.status = 'idle';
        return {
          goalId,
          status: 'stopped',
          totalIterations: this.currentIterations,
          durationMs: Date.now() - this.startedAt,
          error: 'operator stop aborted active execution',
        };
      }
      this.status = 'crashed';
      return {
        goalId,
        status: 'error',
        totalIterations: 0,
        durationMs: Date.now() - this.startedAt,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      this.currentGoalId = null;
      this.currentIterations = 0;
      if (this.status === 'running') {
        this.status = 'idle';
      }
    }
  }

  requestExtend(): void {
    this.extendRequested = true;
  }

  getStatus(): WorkerStatus {
    return this.status;
  }

  getCurrentGoalId(): string | null {
    return this.currentGoalId;
  }

  getStartedAt(): number {
    return this.startedAt;
  }

  getIterations(): number {
    return this.currentIterations;
  }

  isIdle(): boolean {
    return this.status === 'idle';
  }
}

function toGoalRunActivationContext(options: GoalWorkerExecuteOptions): GoalRunActivationContext {
  return {
    ...(options.backgroundRun ? { backgroundRun: options.backgroundRun } : {}),
    ...(options.waitResume ? { waitResume: options.waitResume } : {}),
  };
}
