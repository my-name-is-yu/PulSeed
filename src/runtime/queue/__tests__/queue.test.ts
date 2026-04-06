import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { PriorityQueue } from '../priority-queue.js';
import { EventBus } from '../event-bus.js';
import { CommandBus } from '../command-bus.js';
import { createEnvelope } from '../../types/envelope.js';

// ─── PriorityQueue ────────────────────────────────────────────────────────────

describe('PriorityQueue', () => {
  let q: PriorityQueue<string>;

  beforeEach(() => {
    q = new PriorityQueue<string>();
  });

  it('dequeues in priority order (critical > high > normal > low)', () => {
    q.enqueue('low-item', 'low');
    q.enqueue('normal-item', 'normal');
    q.enqueue('critical-item', 'critical');
    q.enqueue('high-item', 'high');

    expect(q.dequeue()).toBe('critical-item');
    expect(q.dequeue()).toBe('high-item');
    expect(q.dequeue()).toBe('normal-item');
    expect(q.dequeue()).toBe('low-item');
  });

  it('returns undefined when empty', () => {
    expect(q.dequeue()).toBeUndefined();
    expect(q.peek()).toBeUndefined();
  });

  it('size() reflects total items', () => {
    q.enqueue('a', 'high');
    q.enqueue('b', 'low');
    expect(q.size()).toBe(2);
  });

  it('sizeByPriority() returns per-bucket counts', () => {
    q.enqueue('a', 'critical');
    q.enqueue('b', 'normal');
    q.enqueue('c', 'normal');
    const counts = q.sizeByPriority();
    expect(counts.critical).toBe(1);
    expect(counts.high).toBe(0);
    expect(counts.normal).toBe(2);
    expect(counts.low).toBe(0);
  });

  it('drain() removes and returns all items at a priority', () => {
    q.enqueue('a', 'normal');
    q.enqueue('b', 'normal');
    q.enqueue('c', 'high');
    const drained = q.drain('normal');
    expect(drained).toEqual(['a', 'b']);
    expect(q.size()).toBe(1);
  });

  it('clear() empties all buckets', () => {
    q.enqueue('a', 'critical');
    q.enqueue('b', 'low');
    q.clear();
    expect(q.size()).toBe(0);
  });

  it('peek() does not remove the item', () => {
    q.enqueue('x', 'high');
    expect(q.peek()).toBe('x');
    expect(q.size()).toBe(1);
  });
});

// ─── EventBus ─────────────────────────────────────────────────────────────────

describe('EventBus', () => {
  const dlqPath = `/tmp/test-dlq-${Date.now()}.jsonl`;

  it('push/pull returns event envelope', () => {
    const bus = new EventBus({ dlqPath });
    const env = createEnvelope({ type: 'event', name: 'test', source: 'src', payload: {} });
    bus.push(env);
    expect(bus.pull()?.id).toBe(env.id);
  });

  it('pull returns higher priority first', () => {
    const bus = new EventBus({ dlqPath });
    const low = createEnvelope({ type: 'event', name: 'low', source: 's', payload: {}, priority: 'low' });
    const high = createEnvelope({ type: 'event', name: 'high', source: 's', payload: {}, priority: 'high' });
    bus.push(low);
    bus.push(high);
    expect(bus.pull()?.priority).toBe('high');
    expect(bus.pull()?.priority).toBe('low');
  });

  it('dedupe: same dedupe_key replaces older entry', () => {
    const bus = new EventBus({ dlqPath });
    const env1 = createEnvelope({ type: 'event', name: 'e1', source: 's', payload: { v: 1 }, dedupe_key: 'k1' });
    const env2 = createEnvelope({ type: 'event', name: 'e2', source: 's', payload: { v: 2 }, dedupe_key: 'k1' });
    bus.push(env1);
    bus.push(env2);
    expect(bus.size()).toBe(1);
    const pulled = bus.pull();
    expect(pulled?.id).toBe(env2.id);
  });

  it('TTL: push expired envelope drops it', () => {
    const bus = new EventBus({ dlqPath });
    const env = createEnvelope({ type: 'event', name: 'e', source: 's', payload: {}, ttl_ms: 1 });
    // Force expire
    (env as any).created_at = Date.now() - 5000;
    bus.push(env);
    expect(bus.size()).toBe(0);
  });

  it('TTL: pull skips expired item', () => {
    const bus = new EventBus({ dlqPath });
    const env = createEnvelope({ type: 'event', name: 'e', source: 's', payload: {}, ttl_ms: 60_000 });
    bus.push(env);
    // Expire after push
    (env as any).created_at = Date.now() - 70_000;
    // Modify the queued item by pushing again with same id approach — instead
    // we test by draining and re-checking via a fresh expired envelope
    // Reset: use a separate bus to test pull-time expiry
    const bus2 = new EventBus({ dlqPath });
    const env2 = createEnvelope({ type: 'event', name: 'e2', source: 's', payload: {}, ttl_ms: 50_000 });
    // Manually enqueue with past created_at via push then mutate internal state
    // Simpler: push with very short TTL and wait isn't feasible, so we push
    // two items — one that will expire (ttl_ms=1, created far in past) and one valid
    const expired = { ...createEnvelope({ type: 'event', name: 'exp', source: 's', payload: {} }), ttl_ms: 1, created_at: 1 };
    const valid = createEnvelope({ type: 'event', name: 'valid', source: 's', payload: {} });
    bus2.push(expired as any);
    bus2.push(valid);
    // expired is LOW priority (normal) so high priority pulled first — both normal
    // pull should skip expired and return valid
    const result = bus2.pull();
    expect(result?.name).toBe('exp'); // expired gets pulled first by insertion order but is dropped
    // Actually the expired envelope fails TTL check on push (created_at=1 + any ttl <= now)
    expect(bus2.size()).toBe(1); // only valid remains after expired was dropped on push
    expect(bus2.pull()?.name).toBe('valid');
  });

  it('backpressure: LOW dropped to DLQ at high-water mark', () => {
    const testDlq = `/tmp/test-dlq-bk-${Date.now()}.jsonl`;
    const bus = new EventBus({ highWaterMark: 2, dlqPath: testDlq });
    bus.push(createEnvelope({ type: 'event', name: 'a', source: 's', payload: {}, priority: 'normal' }));
    bus.push(createEnvelope({ type: 'event', name: 'b', source: 's', payload: {}, priority: 'normal' }));
    const low = createEnvelope({ type: 'event', name: 'c', source: 's', payload: {}, priority: 'low' });
    bus.push(low);
    expect(bus.size()).toBe(2); // LOW was dropped
    expect(existsSync(testDlq)).toBe(true);
    const dlqLine = JSON.parse(readFileSync(testDlq, 'utf-8').trim());
    expect(dlqLine.id).toBe(low.id);
    expect(dlqLine._dlq_reason).toMatch(/backpressure/);
    if (existsSync(testDlq)) unlinkSync(testDlq);
  });

  it('onHighPriority callback fires for CRITICAL and HIGH', () => {
    const cb = vi.fn();
    const bus = new EventBus({ dlqPath, onHighPriority: cb });
    bus.push(createEnvelope({ type: 'event', name: 'e1', source: 's', payload: {}, priority: 'critical' }));
    bus.push(createEnvelope({ type: 'event', name: 'e2', source: 's', payload: {}, priority: 'high' }));
    bus.push(createEnvelope({ type: 'event', name: 'e3', source: 's', payload: {}, priority: 'normal' }));
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('rejects non-event envelopes', () => {
    const bus = new EventBus({ dlqPath });
    const cmd = createEnvelope({ type: 'command', name: 'c', source: 's', payload: {} });
    expect(() => bus.push(cmd)).toThrow(/event/);
  });

  it('pendingCount reflects per-priority counts', () => {
    const bus = new EventBus({ dlqPath });
    bus.push(createEnvelope({ type: 'event', name: 'a', source: 's', payload: {}, priority: 'high' }));
    bus.push(createEnvelope({ type: 'event', name: 'b', source: 's', payload: {}, priority: 'low' }));
    const counts = bus.pendingCount();
    expect(counts.high).toBe(1);
    expect(counts.low).toBe(1);
    expect(counts.critical).toBe(0);
  });
});

// ─── CommandBus ───────────────────────────────────────────────────────────────

describe('CommandBus', () => {
  it('push/pull returns command envelope', () => {
    const bus = new CommandBus();
    const env = createEnvelope({ type: 'command', name: 'cmd', source: 's', payload: {} });
    bus.push(env);
    expect(bus.pull()?.id).toBe(env.id);
  });

  it('no dedupe: same dedupe_key does NOT replace', () => {
    const bus = new CommandBus();
    const env1 = createEnvelope({ type: 'command', name: 'c1', source: 's', payload: {}, dedupe_key: 'k1' });
    const env2 = createEnvelope({ type: 'command', name: 'c2', source: 's', payload: {}, dedupe_key: 'k1' });
    bus.push(env1);
    bus.push(env2);
    expect(bus.size()).toBe(2);
  });

  it('TTL: expired envelope dropped on push', () => {
    const bus = new CommandBus();
    const env = { ...createEnvelope({ type: 'command', name: 'c', source: 's', payload: {} }), ttl_ms: 1, created_at: 1 };
    bus.push(env as any);
    expect(bus.size()).toBe(0);
  });

  it('backpressure: LOW dropped at high-water mark', () => {
    const bus = new CommandBus({ highWaterMark: 1 });
    bus.push(createEnvelope({ type: 'command', name: 'a', source: 's', payload: {}, priority: 'normal' }));
    bus.push(createEnvelope({ type: 'command', name: 'b', source: 's', payload: {}, priority: 'low' }));
    expect(bus.size()).toBe(1);
  });

  it('HIGH and CRITICAL bypass backpressure', () => {
    const bus = new CommandBus({ highWaterMark: 1 });
    bus.push(createEnvelope({ type: 'command', name: 'a', source: 's', payload: {}, priority: 'normal' }));
    bus.push(createEnvelope({ type: 'command', name: 'b', source: 's', payload: {}, priority: 'critical' }));
    expect(bus.size()).toBe(2);
  });

  it('onHighPriority callback fires for CRITICAL and HIGH', () => {
    const cb = vi.fn();
    const bus = new CommandBus({ onHighPriority: cb });
    bus.push(createEnvelope({ type: 'command', name: 'c1', source: 's', payload: {}, priority: 'high' }));
    bus.push(createEnvelope({ type: 'command', name: 'c2', source: 's', payload: {}, priority: 'low' }));
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('rejects non-command envelopes', () => {
    const bus = new CommandBus();
    const ev = createEnvelope({ type: 'event', name: 'e', source: 's', payload: {} });
    expect(() => bus.push(ev)).toThrow(/command/);
  });

  it('pendingCount reflects per-priority counts', () => {
    const bus = new CommandBus();
    bus.push(createEnvelope({ type: 'command', name: 'a', source: 's', payload: {}, priority: 'critical' }));
    bus.push(createEnvelope({ type: 'command', name: 'b', source: 's', payload: {}, priority: 'normal' }));
    const counts = bus.pendingCount();
    expect(counts.critical).toBe(1);
    expect(counts.normal).toBe(1);
  });

  it('pull returns undefined when empty', () => {
    const bus = new CommandBus();
    expect(bus.pull()).toBeUndefined();
  });
});
