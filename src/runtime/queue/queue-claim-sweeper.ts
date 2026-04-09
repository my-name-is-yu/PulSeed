import { JournalBackedQueue, JournalBackedQueueSweepResult } from './journal-backed-queue.js';

export interface QueueClaimSweeperOptions {
  queue: JournalBackedQueue;
  intervalMs?: number;
}

export class QueueClaimSweeper {
  private readonly queue: JournalBackedQueue;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null;

  constructor(options: QueueClaimSweeperOptions) {
    this.queue = options.queue;
    this.intervalMs = options.intervalMs ?? 5_000;
    this.timer = null;
  }

  sweep(now?: number): JournalBackedQueueSweepResult {
    return this.queue.sweepExpiredClaims(now);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.queue.sweepExpiredClaims();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
