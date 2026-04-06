import { Envelope, EnvelopePriority } from '../types/envelope.js';
import { PriorityQueue } from './priority-queue.js';

export interface CommandBusOptions {
  highWaterMark?: number;
  onHighPriority?: () => void;
  onDropped?: (envelope: Envelope) => void;
}

const DEFAULT_TTL_MS = 300_000;

function isExpired(envelope: Envelope): boolean {
  const ttl = envelope.ttl_ms ?? DEFAULT_TTL_MS;
  return envelope.created_at + ttl <= Date.now();
}

export class CommandBus {
  private queue: PriorityQueue<Envelope>;
  private highWaterMark: number;
  private onHighPriority?: () => void;
  private onDropped?: (envelope: Envelope) => void;

  constructor(options?: CommandBusOptions) {
    this.queue = new PriorityQueue<Envelope>();
    this.highWaterMark = options?.highWaterMark ?? 1000;
    this.onHighPriority = options?.onHighPriority;
    this.onDropped = options?.onDropped;
  }

  push(envelope: Envelope): void {
    if (envelope.type !== 'command') {
      throw new Error(`CommandBus only accepts type="command", got "${envelope.type}"`);
    }

    if (isExpired(envelope)) {
      console.warn(`[CommandBus] Dropping expired envelope id=${envelope.id}`);
      return;
    }

    // Backpressure
    if (this.queue.size() >= this.highWaterMark) {
      if (envelope.priority === 'low') {
        console.warn(`[CommandBus] Backpressure: LOW command dropped, queue full`);
        this.onDropped?.(envelope);
        return;
      }
      if (envelope.priority === 'normal') {
        console.warn(`[CommandBus] Backpressure: NORMAL command held, queue full`);
        return;
      }
      // HIGH and CRITICAL always accepted
    }

    this.queue.enqueue(envelope, envelope.priority);

    if (envelope.priority === 'critical' || envelope.priority === 'high') {
      this.onHighPriority?.();
    }
  }

  pull(): Envelope | undefined {
    while (this.queue.size() > 0) {
      const envelope = this.queue.dequeue();
      if (!envelope) break;
      if (isExpired(envelope)) {
        console.warn(`[CommandBus] Dropping expired envelope id=${envelope.id} on pull`);
        continue;
      }
      return envelope;
    }
    return undefined;
  }

  size(): number {
    return this.queue.size();
  }

  pendingCount(): Record<EnvelopePriority, number> {
    return this.queue.sizeByPriority();
  }
}
