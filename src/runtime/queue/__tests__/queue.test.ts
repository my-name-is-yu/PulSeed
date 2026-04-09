import { describe, it, expect, beforeEach } from 'vitest';
import { PriorityQueue } from '../priority-queue.js';

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
