import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { Envelope, EnvelopePriority } from '../types/envelope.js';
import { PriorityQueue } from './priority-queue.js';

export interface EventBusOptions {
  highWaterMark?: number;
  dlqPath?: string;
  onHighPriority?: () => void;
}

const DEFAULT_TTL_MS = 300_000;

function isExpired(envelope: Envelope): boolean {
  const ttl = envelope.ttl_ms ?? DEFAULT_TTL_MS;
  return envelope.created_at + ttl <= Date.now();
}

export class EventBus {
  private queue: PriorityQueue<Envelope>;
  private highWaterMark: number;
  private dlqPath: string;
  private onHighPriority?: () => void;
  // Maps dedupe_key → index tracking is complex with multiple buckets,
  // so we track dedupe via a Map<dedupe_key, envelope id> and replace on enqueue
  private dedupeIndex: Map<string, string>; // dedupe_key → envelope.id

  constructor(options?: EventBusOptions) {
    this.queue = new PriorityQueue<Envelope>();
    this.highWaterMark = options?.highWaterMark ?? 1000;
    this.dlqPath = options?.dlqPath ?? join(homedir(), '.pulseed', 'dlq.jsonl');
    this.onHighPriority = options?.onHighPriority;
    this.dedupeIndex = new Map();
  }

  push(envelope: Envelope): void {
    if (envelope.type !== 'event') {
      throw new Error(`EventBus only accepts type="event", got "${envelope.type}"`);
    }

    if (isExpired(envelope)) {
      console.warn(`[EventBus] Dropping expired envelope id=${envelope.id}`);
      return;
    }

    // Backpressure (checked BEFORE dedupe to avoid priority inversion)
    if (this.queue.size() >= this.highWaterMark) {
      if (envelope.priority === 'low') {
        this.writeToDlq(envelope, 'backpressure: queue full, LOW dropped');
        return;
      }
      if (envelope.priority === 'normal') {
        // Hold — do not enqueue (caller must retry)
        console.warn(`[EventBus] Backpressure: NORMAL held, queue full`);
        return;
      }
      // HIGH and CRITICAL always accepted (may exceed high-water mark briefly)
    }

    // Dedupe: if dedupe_key matches, remove old entry and replace
    if (envelope.dedupe_key) {
      const existingId = this.dedupeIndex.get(envelope.dedupe_key);
      if (existingId) {
        // Mark old entry for removal by draining and re-enqueuing without it
        this.removeById(existingId);
      }
      this.dedupeIndex.set(envelope.dedupe_key, envelope.id);
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
      if (envelope.dedupe_key) {
        this.dedupeIndex.delete(envelope.dedupe_key);
      }
      if (isExpired(envelope)) {
        console.warn(`[EventBus] Dropping expired envelope id=${envelope.id} on pull`);
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

  private removeById(id: string): void {
    // Drain all priorities, filter out the id, re-enqueue the rest
    const priorities: EnvelopePriority[] = ['critical', 'high', 'normal', 'low'];
    for (const p of priorities) {
      const items = this.queue.drain(p);
      for (const item of items) {
        if (item.id !== id) {
          this.queue.enqueue(item, p);
        }
      }
    }
  }

  private writeToDlq(envelope: Envelope, reason: string): void {
    try {
      mkdirSync(dirname(this.dlqPath), { recursive: true });
      appendFileSync(this.dlqPath, JSON.stringify({ ...envelope, _dlq_reason: reason }) + '\n');
    } catch (err) {
      console.error(`[EventBus] DLQ write failed:`, err);
    }
  }
}
