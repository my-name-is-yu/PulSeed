import { JournalBackedQueue, type JournalBackedQueueClaim } from "./queue/journal-backed-queue.js";
import type { Envelope } from "./types/envelope.js";
import type { Logger } from "./logger.js";
import { PulSeedEventSchema } from "../base/types/drive.js";
import type { CronTask } from "./types/cron.js";

export interface EventDispatcherDeps {
  journalQueue: JournalBackedQueue;
  logger?: Logger;
  onGoalActivate?: (goalId: string, envelope: Envelope) => Promise<void> | void;
  onExternalEvent?: (event: unknown, envelope: Envelope) => Promise<void> | void;
  onCronTaskDue?: (task: CronTask, envelope: Envelope) => Promise<void> | void;
}

export interface EventDispatcherConfig {
  pollIntervalMs: number;
  claimLeaseMs: number;
}

const DEFAULT_CONFIG: EventDispatcherConfig = {
  pollIntervalMs: 100,
  claimLeaseMs: 30_000,
};

export class EventDispatcher {
  private readonly deps: EventDispatcherDeps;
  private readonly config: EventDispatcherConfig;
  private readonly workerId: string;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private polling = false;
  private inFlight = new Set<Promise<void>>();

  constructor(deps: EventDispatcherDeps, config?: Partial<EventDispatcherConfig>) {
    this.deps = deps;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.workerId = `event-dispatcher:${process.pid}`;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.pollOnce();
    this.pollTimer = setInterval(() => {
      void this.pollOnce();
    }, this.config.pollIntervalMs);
    this.pollTimer.unref?.();
  }

  async shutdown(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    await Promise.allSettled(this.inFlight);
  }

  private async pollOnce(): Promise<void> {
    if (!this.running || this.polling) return;
    this.polling = true;
    try {
      while (this.running) {
        const claim = this.deps.journalQueue.claim(
          this.workerId,
          this.config.claimLeaseMs,
          (envelope) =>
            envelope.type === "event" &&
            envelope.name !== "goal_activated"
        );
        if (!claim) break;
        const task = this.dispatch(claim);
        this.inFlight.add(task);
        await task.finally(() => {
          this.inFlight.delete(task);
        });
      }
    } finally {
      this.polling = false;
    }
  }

  private async dispatch(claim: JournalBackedQueueClaim): Promise<void> {
    try {
      await this.handleEnvelope(claim.envelope);
      this.ackClaim(claim);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.deps.logger?.warn("Event dispatch failed", {
        event: claim.envelope.name,
        goalId: claim.envelope.goal_id,
        error: reason,
      });
      this.nackClaim(claim, reason);
    }
  }

  private async handleEnvelope(envelope: Envelope): Promise<void> {
    switch (envelope.name) {
      case "schedule_activated": {
        const goalId = envelope.goal_id ?? this.readStringField(envelope.payload, "goal_id");
        if (!goalId) {
          throw new Error("schedule_activated event is missing goal_id");
        }
        await this.deps.onGoalActivate?.(goalId, envelope);
        return;
      }
      case "cron_task_due": {
        await this.deps.onCronTaskDue?.(envelope.payload as CronTask, envelope);
        return;
      }
      default: {
        const event = PulSeedEventSchema.parse(envelope.payload);
        await this.deps.onExternalEvent?.(event, envelope);
        const goalId =
          this.readStringField(event.data, "goal_id") ??
          this.readStringField(event.data, "target_goal_id");
        if (goalId) {
          await this.deps.onGoalActivate?.(goalId, envelope);
        }
      }
    }
  }

  private ackClaim(claim: JournalBackedQueueClaim): void {
    const acked = this.deps.journalQueue.ack(claim.claimToken);
    if (!acked) {
      this.deps.logger?.warn("Failed to ack durable event claim", {
        event: claim.envelope.name,
        claimToken: claim.claimToken,
      });
    }
  }

  private nackClaim(claim: JournalBackedQueueClaim, reason: string): void {
    const settled = this.deps.journalQueue.nack(claim.claimToken, reason, true);
    if (!settled) {
      this.deps.logger?.warn("Failed to nack durable event claim", {
        event: claim.envelope.name,
        claimToken: claim.claimToken,
        reason,
      });
    }
  }

  private readStringField(payload: unknown, key: string): string | undefined {
    if (!payload || typeof payload !== "object") return undefined;
    const value = (payload as Record<string, unknown>)[key];
    return typeof value === "string" ? value : undefined;
  }
}
