import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createEnvelope } from '../../types/envelope.js';
import { JournalBackedQueue } from '../journal-backed-queue.js';

describe('JournalBackedQueue', () => {
  let tmpDir: string;
  let journalPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulseed-journal-queue-'));
    journalPath = path.join(tmpDir, 'queue.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('accepts, claims, renews, and acks with durable state', () => {
    const queue = new JournalBackedQueue({ journalPath, now: () => 1_000 });
    const envelope = createEnvelope({ type: 'event', name: 'job', source: 'test', payload: {}, priority: 'high' });

    expect(queue.accept(envelope)).toEqual({
      accepted: true,
      duplicate: false,
      messageId: envelope.id,
    });

    const claim = queue.claim('worker-a', 5_000);
    expect(claim?.messageId).toBe(envelope.id);
    expect(claim?.attempt).toBe(1);

    const renewed = queue.renew(claim!.claimToken, 10_000);
    expect(renewed?.leaseUntil).toBe(11_000);

    expect(queue.ack(claim!.claimToken)).toBe(true);
    expect(queue.size()).toBe(0);
    expect(queue.inflightSize()).toBe(0);

    const reloaded = new JournalBackedQueue({ journalPath, now: () => 2_000 });
    expect(reloaded.get(envelope.id)?.status).toBe('completed');
    expect(reloaded.snapshot().completed).toContain(envelope.id);
  });

  it('persists finite fractional lease deadlines used by retry backoff', () => {
    const queue = new JournalBackedQueue({ journalPath, now: () => 1_000 });
    const envelope = createEnvelope({ type: 'event', name: 'job', source: 'test', payload: {}, priority: 'high' });
    queue.accept(envelope);

    const claim = queue.claim('worker-a', 250.5);
    expect(claim?.leaseUntil).toBe(1_250.5);

    const renewed = queue.renew(claim!.claimToken, 500.25);
    expect(renewed?.leaseUntil).toBe(1_500.25);

    const reloaded = new JournalBackedQueue({ journalPath, now: () => 1_000 });
    expect(reloaded.snapshot().inflight[claim!.claimToken]?.leaseUntil).toBe(1_500.25);
  });

  it('replaces older pending entries that share the same dedupe_key', () => {
    const queue = new JournalBackedQueue({ journalPath, now: () => 1_000 });
    const first = createEnvelope({
      type: 'event',
      name: 'job',
      source: 'test',
      payload: { version: 1 },
      priority: 'normal',
      dedupe_key: 'logical-job',
    });
    const second = createEnvelope({
      type: 'event',
      name: 'job',
      source: 'test',
      payload: { version: 2 },
      priority: 'high',
      dedupe_key: 'logical-job',
    });

    expect(queue.accept(first)).toEqual({
      accepted: true,
      duplicate: false,
      messageId: first.id,
    });

    expect(queue.accept(second)).toEqual({
      accepted: true,
      duplicate: false,
      messageId: second.id,
    });

    expect(queue.get(first.id)).toBeUndefined();
    expect(queue.size()).toBe(1);
    expect(queue.snapshot().pending.high).toEqual([second.id]);

    const claim = queue.claim('worker-a', 5_000);
    expect(claim?.messageId).toBe(second.id);
    expect(claim?.envelope.payload).toEqual({ version: 2 });
  });

  it('allows a dedupe_key to be accepted again after completion', () => {
    const queue = new JournalBackedQueue({ journalPath, now: () => 1_000 });
    const first = createEnvelope({
      type: 'event',
      name: 'job',
      source: 'test',
      payload: { version: 1 },
      priority: 'normal',
      dedupe_key: 'logical-job',
    });
    const second = createEnvelope({
      type: 'event',
      name: 'job',
      source: 'test',
      payload: { version: 2 },
      priority: 'normal',
      dedupe_key: 'logical-job',
    });

    queue.accept(first);
    const claim = queue.claim('worker-a', 5_000)!;
    expect(queue.ack(claim.claimToken)).toBe(true);

    expect(queue.accept(second)).toEqual({
      accepted: true,
      duplicate: false,
      messageId: second.id,
    });
    expect(queue.get(second.id)?.status).toBe('pending');
    expect(queue.size()).toBe(1);
  });

  it('nacks back to pending and deadletters after max attempts', () => {
    const queue = new JournalBackedQueue({ journalPath, maxAttempts: 2, now: () => 1_000 });
    const envelope = createEnvelope({ type: 'command', name: 'job', source: 'test', payload: {}, priority: 'normal' });
    queue.accept(envelope);

    const first = queue.claim('worker-a', 1_000)!;
    expect(queue.nack(first.claimToken, 'boom')).toBe(true);
    expect(queue.size()).toBe(1);

    const second = queue.claim('worker-a', 1_000)!;
    expect(second.attempt).toBe(2);
    expect(queue.nack(second.claimToken, 'boom', true)).toBe(true);
    expect(queue.get(envelope.id)?.status).toBe('deadletter');
    expect(queue.snapshot().deadletter).toContain(envelope.id);
  });

  it('requeues deadlettered items back to pending', () => {
    const queue = new JournalBackedQueue({ journalPath, now: () => 1_000 });
    const envelope = createEnvelope({ type: 'event', name: 'job', source: 'test', payload: {}, priority: 'low' });
    queue.accept(envelope);

    const claim = queue.claim('worker-a', 1_000)!;
    queue.deadletter(claim.messageId, 'manual stop');
    expect(queue.get(envelope.id)?.status).toBe('deadletter');

    expect(queue.requeue(envelope.id)).toBe(true);
    expect(queue.get(envelope.id)?.status).toBe('pending');
    expect(queue.size()).toBe(1);
  });

  it('reloads under lock so two instances sharing a journal path do not clobber each other', () => {
    const queueA = new JournalBackedQueue({ journalPath, now: () => 1_000 });
    const queueB = new JournalBackedQueue({ journalPath, now: () => 1_000 });
    const first = createEnvelope({ type: 'event', name: 'first', source: 'test', payload: {}, priority: 'high' });
    const second = createEnvelope({ type: 'event', name: 'second', source: 'test', payload: {}, priority: 'high' });

    expect(queueA.accept(first).accepted).toBe(true);
    expect(queueB.accept(second).accepted).toBe(true);
    expect(queueA.size()).toBe(2);
    expect(queueA.get(second.id)?.status).toBe('pending');

    const reloaded = new JournalBackedQueue({ journalPath, now: () => 1_000 });
    expect(reloaded.size()).toBe(2);

    const claimA = queueA.claim('worker-a', 5_000);
    const claimB = queueB.claim('worker-b', 5_000);

    expect([claimA?.messageId, claimB?.messageId].sort()).toEqual([first.id, second.id].sort());
    expect(queueA.ack(claimA!.claimToken)).toBe(true);
    expect(queueB.ack(claimB!.claimToken)).toBe(true);

    const final = new JournalBackedQueue({ journalPath, now: () => 1_000 });
    expect(final.snapshot().completed).toEqual(expect.arrayContaining([first.id, second.id]));
  });

  it('claims the first dispatcher-matching item without disturbing earlier unmatched entries', () => {
    const queue = new JournalBackedQueue({ journalPath, now: () => 1_000 });
    const first = createEnvelope({ type: 'event', name: 'schedule_activated', source: 'test', payload: {}, priority: 'normal' });
    const second = createEnvelope({ type: 'event', name: 'goal_activated', source: 'test', goal_id: 'g-1', payload: {}, priority: 'normal' });

    queue.accept(first);
    queue.accept(second);

    const claim = queue.claim(
      'worker-a',
      5_000,
      (envelope) => envelope.name === 'goal_activated'
    );

    expect(claim?.messageId).toBe(second.id);
    expect(queue.snapshot().pending.normal).toEqual([first.id]);
  });

});
