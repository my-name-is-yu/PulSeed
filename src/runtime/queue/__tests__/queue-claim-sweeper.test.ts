import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createEnvelope } from '../../types/envelope.js';
import { JournalBackedQueue } from '../journal-backed-queue.js';
import { QueueClaimSweeper } from '../queue-claim-sweeper.js';

describe('QueueClaimSweeper', () => {
  let tmpDir: string;
  let journalPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulseed-claim-sweeper-'));
    journalPath = path.join(tmpDir, 'queue.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reclaims expired claims back to pending', () => {
    let now = 1_000;
    const queue = new JournalBackedQueue({ journalPath, maxAttempts: 3, now: () => now });
    const sweeper = new QueueClaimSweeper({ queue, intervalMs: 50 });
    const envelope = createEnvelope({ type: 'event', name: 'job', source: 'test', payload: {}, priority: 'normal' });

    queue.accept(envelope);
    const claim = queue.claim('worker-a', 100)!;
    now = 1_200;

    const result = sweeper.sweep(now);
    expect(result.reclaimed).toBe(1);
    expect(result.deadlettered).toBe(0);
    expect(queue.get(envelope.id)?.status).toBe('pending');
    expect(queue.size()).toBe(1);
    expect(queue.inflightSize()).toBe(0);
  });

  it('deadletters expired claims at max attempts', () => {
    let now = 1_000;
    const queue = new JournalBackedQueue({ journalPath, maxAttempts: 1, now: () => now });
    const sweeper = new QueueClaimSweeper({ queue });
    const envelope = createEnvelope({ type: 'command', name: 'job', source: 'test', payload: {}, priority: 'critical' });

    queue.accept(envelope);
    queue.claim('worker-a', 100);
    now = 1_200;

    const result = sweeper.sweep(now);
    expect(result.reclaimed).toBe(0);
    expect(result.deadlettered).toBe(1);
    expect(queue.get(envelope.id)?.status).toBe('deadletter');
    expect(queue.snapshot().deadletter).toContain(envelope.id);
  });
});
