import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { EnvelopeSchema, type Envelope, type EnvelopePriority } from '../types/envelope.js';
import { createRuntimeStorePaths } from '../store/runtime-paths.js';
import {
  openRuntimeControlDatabaseSync,
  type ControlDatabase,
  type RuntimeControlDbStoreOptions,
  type SqliteDatabase,
} from '../store/control-db/index.js';

export interface JournalBackedQueueOptions extends RuntimeControlDbStoreOptions {
  runtimeRoot?: string;
  journalPath?: string;
  defaultLeaseMs?: number;
  maxAttempts?: number;
  now?: () => number;
}

export type JournalBackedQueueClaimFilter = (envelope: Envelope) => boolean;

export interface JournalBackedQueueAcceptResult {
  accepted: boolean;
  duplicate: boolean;
  messageId: string;
}

export interface JournalBackedQueueClaim {
  claimToken: string;
  messageId: string;
  workerId: string;
  leaseUntil: number;
  attempt: number;
  envelope: Envelope;
}

export interface JournalBackedQueueSweepResult {
  reclaimed: number;
  deadlettered: number;
  expiredClaimTokens: string[];
}

export interface JournalBackedQueueSnapshot {
  pending: Record<EnvelopePriority, string[]>;
  inflight: Record<string, JournalBackedQueueClaimRecord>;
  completed: string[];
  deadletter: string[];
}

export interface JournalBackedQueueRecord {
  envelope: Envelope;
  status: 'pending' | 'inflight' | 'completed' | 'deadletter';
  attempt: number;
  createdAt: number;
  updatedAt: number;
  workerId?: string;
  claimToken?: string;
  leaseUntil?: number;
  deadletterReason?: string;
  completedAt?: number;
}

export interface JournalBackedQueueClaimRecord {
  messageId: string;
  workerId: string;
  leaseUntil: number;
  attempt: number;
  claimedAt: number;
}

interface JournalBackedQueueState {
  version: 1;
  records: Record<string, JournalBackedQueueRecord>;
  pending: Record<EnvelopePriority, string[]>;
  inflight: Record<string, JournalBackedQueueClaimRecord>;
}

const PRIORITY_ORDER: EnvelopePriority[] = ['critical', 'high', 'normal', 'low'];
const QueueSafeNonnegativeIntSchema = z.number().int().nonnegative().safe();
const QueueSafeNonnegativeNumberSchema = z.number()
  .finite()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);

const JournalBackedQueueRecordSchema = z.object({
  envelope: EnvelopeSchema,
  status: z.enum(['pending', 'inflight', 'completed', 'deadletter']),
  attempt: QueueSafeNonnegativeIntSchema,
  createdAt: QueueSafeNonnegativeNumberSchema,
  updatedAt: QueueSafeNonnegativeNumberSchema,
  workerId: z.string().optional(),
  claimToken: z.string().optional(),
  leaseUntil: QueueSafeNonnegativeNumberSchema.optional(),
  deadletterReason: z.string().optional(),
  completedAt: QueueSafeNonnegativeNumberSchema.optional(),
});

const JournalBackedQueueClaimRecordSchema = z.object({
  messageId: z.string(),
  workerId: z.string(),
  leaseUntil: QueueSafeNonnegativeNumberSchema,
  attempt: QueueSafeNonnegativeIntSchema,
  claimedAt: QueueSafeNonnegativeNumberSchema,
});

const JournalBackedQueuePendingSchema = z.object({
  critical: z.array(z.string()),
  high: z.array(z.string()),
  normal: z.array(z.string()),
  low: z.array(z.string()),
});

const JournalBackedQueueStateSchema = z.object({
  version: z.literal(1),
  records: z.record(JournalBackedQueueRecordSchema),
  pending: JournalBackedQueuePendingSchema,
  inflight: z.record(JournalBackedQueueClaimRecordSchema),
});

function emptyPending(): Record<EnvelopePriority, string[]> {
  return {
    critical: [],
    high: [],
    normal: [],
    low: [],
  };
}

function clonePending(pending: Record<EnvelopePriority, string[]>): Record<EnvelopePriority, string[]> {
  return {
    critical: [...pending.critical],
    high: [...pending.high],
    normal: [...pending.normal],
    low: [...pending.low],
  };
}

function isExpired(envelope: Envelope, now: number): boolean {
  const ttl = envelope.ttl_ms ?? 300_000;
  return envelope.created_at + ttl <= now;
}

function buildEmptyState(): JournalBackedQueueState {
  return {
    version: 1,
    records: {},
    pending: emptyPending(),
    inflight: {},
  };
}

function isRecordMap(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseQueueRecord(value: unknown): JournalBackedQueueRecord | null {
  const parsed = JournalBackedQueueRecordSchema.safeParse(value);
  return parsed.success ? parsed.data as JournalBackedQueueRecord : null;
}

function parseQueueClaimRecord(value: unknown): JournalBackedQueueClaimRecord | null {
  const parsed = JournalBackedQueueClaimRecordSchema.safeParse(value);
  return parsed.success ? parsed.data as JournalBackedQueueClaimRecord : null;
}

function normalizeState(state: Partial<JournalBackedQueueState>): JournalBackedQueueState {
  const normalized = buildEmptyState();
  normalized.version = 1;
  normalized.records = {};

  const records = isRecordMap(state.records) ? state.records : {};
  for (const [messageId, record] of Object.entries(records)) {
    const parsed = parseQueueRecord(record);
    if (!parsed || parsed.envelope.id !== messageId) continue;
    normalized.records[messageId] = parsed;
  }

  normalized.pending = emptyPending();
  for (const priority of PRIORITY_ORDER) {
    const rawIds = state.pending?.[priority] ?? [];
    const ids = Array.isArray(rawIds) ? rawIds.filter((id): id is string => typeof id === 'string') : [];
    for (const messageId of ids) {
      const record = normalized.records[messageId];
      if (!record || record.status !== 'pending') continue;
      normalized.pending[priority].push(messageId);
    }
  }

  normalized.inflight = {};
  const claims = isRecordMap(state.inflight) ? state.inflight : {};
  for (const [claimToken, claim] of Object.entries(claims)) {
    const parsed = parseQueueClaimRecord(claim);
    if (!parsed) continue;
    const record = normalized.records[parsed.messageId];
    if (!record || record.status !== 'inflight' || record.claimToken !== claimToken) continue;
    normalized.inflight[claimToken] = parsed;
  }

  for (const [messageId, record] of Object.entries(normalized.records)) {
    if (record.status === 'pending') {
      const priority = record.envelope.priority;
      if (!normalized.pending[priority].includes(messageId)) {
        normalized.pending[priority].push(messageId);
      }
    }
    if (record.status === 'inflight' && record.claimToken) {
      normalized.inflight[record.claimToken] = {
        messageId,
        workerId: record.workerId ?? '',
        leaseUntil: record.leaseUntil ?? 0,
        attempt: record.attempt,
        claimedAt: record.updatedAt,
      };
    }
  }

  return normalized;
}

export class JournalBackedQueue {
  private readonly defaultLeaseMs: number;
  private readonly maxAttempts: number;
  private readonly now: () => number;
  private readonly controlDb: ControlDatabase;
  private state: JournalBackedQueueState;

  constructor(options: JournalBackedQueueOptions) {
    this.defaultLeaseMs = options.defaultLeaseMs ?? 60_000;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.now = options.now ?? Date.now;
    const runtimeRoot = options.runtimeRoot ?? (options.journalPath ? path.dirname(options.journalPath) : null);
    if (!runtimeRoot) {
      throw new Error('JournalBackedQueue requires runtimeRoot for normal operation or journalPath for explicit legacy import tests.');
    }
    this.controlDb = openRuntimeControlDatabaseSync(
      createRuntimeStorePaths(runtimeRoot),
      options
    );
    this.state = this.loadFromDb();
  }

  accept(envelope: Envelope): JournalBackedQueueAcceptResult {
    const parsedEnvelope = EnvelopeSchema.parse(envelope);
    return this.withLockedState<JournalBackedQueueAcceptResult>((state) => {
      const existing = state.records[parsedEnvelope.id];
      if (existing) {
        return {
          result: { accepted: false, duplicate: true, messageId: parsedEnvelope.id },
          dirty: false,
        };
      }

      if (isExpired(parsedEnvelope, this.now())) {
        return {
          result: { accepted: false, duplicate: false, messageId: parsedEnvelope.id },
          dirty: false,
        };
      }

      if (parsedEnvelope.dedupe_key) {
        const activeDedupeRecords = Object.entries(state.records).filter(([, record]) => {
          return (
            record.envelope.dedupe_key === parsedEnvelope.dedupe_key &&
            record.status !== 'completed' &&
            record.status !== 'deadletter'
          );
        });

        const inflightMatch = activeDedupeRecords.find(([, record]) => record.status === 'inflight');
        if (inflightMatch) {
          return {
            result: {
              accepted: false,
              duplicate: true,
              messageId: inflightMatch[0],
            },
            dirty: false,
          };
        }

        for (const [messageId] of activeDedupeRecords) {
          delete state.records[messageId];
          this.removePending(state, messageId);
        }
      }

      state.records[parsedEnvelope.id] = {
        envelope: parsedEnvelope,
        status: 'pending',
        attempt: 0,
        createdAt: this.now(),
        updatedAt: this.now(),
      };
      state.pending[parsedEnvelope.priority].push(parsedEnvelope.id);
      return {
        result: { accepted: true, duplicate: false, messageId: parsedEnvelope.id },
        dirty: true,
      };
    });
  }

  claim(
    workerId: string,
    leaseMs = this.defaultLeaseMs,
    filter?: JournalBackedQueueClaimFilter
  ): JournalBackedQueueClaim | null {
    return this.withLockedState((state) => {
      let dirty = false;
      for (const priority of PRIORITY_ORDER) {
        const bucket = state.pending[priority];
        let index = 0;
        while (index < bucket.length) {
          const messageId = bucket[index];
          const record = state.records[messageId];
          if (!record || record.status !== 'pending') {
            bucket.splice(index, 1);
            dirty = true;
            continue;
          }
          if (isExpired(record.envelope, this.now())) {
            bucket.splice(index, 1);
            record.status = 'deadletter';
            record.deadletterReason = 'expired before claim';
            record.updatedAt = this.now();
            dirty = true;
            continue;
          }
          if (filter && !filter(record.envelope)) {
            index += 1;
            continue;
          }

          const claimToken = randomUUID();
          const attempt = record.attempt + 1;
          const leaseUntil = this.now() + leaseMs;
          bucket.splice(index, 1);
          record.status = 'inflight';
          record.attempt = attempt;
          record.workerId = workerId;
          record.claimToken = claimToken;
          record.leaseUntil = leaseUntil;
          record.updatedAt = this.now();

          state.inflight[claimToken] = {
            messageId,
            workerId,
            leaseUntil,
            attempt,
            claimedAt: this.now(),
          };
          return {
            result: {
              claimToken,
              messageId,
              workerId,
              leaseUntil,
              attempt,
              envelope: record.envelope,
            },
            dirty: true,
          };
        }
      }

      return { result: null, dirty };
    });
  }

  renew(claimToken: string, leaseMs = this.defaultLeaseMs): JournalBackedQueueClaim | null {
    return this.withLockedState((state) => {
      const claim = state.inflight[claimToken];
      if (!claim) return { result: null, dirty: false };

      const record = state.records[claim.messageId];
      if (!record || record.status !== 'inflight' || record.claimToken !== claimToken) {
        delete state.inflight[claimToken];
        return { result: null, dirty: true };
      }

      if (this.isLeaseExpired(record, claimToken)) {
        return { result: null, dirty: false };
      }

      const leaseUntil = this.now() + leaseMs;
      claim.leaseUntil = leaseUntil;
      claim.claimedAt = this.now();
      record.leaseUntil = leaseUntil;
      record.updatedAt = this.now();
      return {
        result: {
          claimToken,
          messageId: claim.messageId,
          workerId: claim.workerId,
          leaseUntil,
          attempt: claim.attempt,
          envelope: record.envelope,
        },
        dirty: true,
      };
    });
  }

  ack(claimToken: string): boolean {
    return this.withLockedState((state) => {
      const claim = state.inflight[claimToken];
      if (!claim) return { result: false, dirty: false };

      const record = state.records[claim.messageId];
      if (!record || record.status !== 'inflight' || record.claimToken !== claimToken) {
        return { result: false, dirty: false };
      }

      if (this.isLeaseExpired(record, claimToken)) {
        return { result: false, dirty: false };
      }

      record.status = 'completed';
      record.completedAt = this.now();
      record.updatedAt = this.now();
      delete record.workerId;
      delete record.claimToken;
      delete record.leaseUntil;
      delete state.inflight[claimToken];
      return { result: true, dirty: true };
    });
  }

  nack(claimToken: string, reason: string, requeue = true): boolean {
    return this.withLockedState((state) => {
      const claim = state.inflight[claimToken];
      if (!claim) return { result: false, dirty: false };

      const record = state.records[claim.messageId];
      if (!record || record.status !== 'inflight' || record.claimToken !== claimToken) {
        return { result: false, dirty: false };
      }

      if (this.isLeaseExpired(record, claimToken)) {
        return { result: false, dirty: false };
      }

      delete state.inflight[claimToken];
      delete record.workerId;
      delete record.claimToken;
      delete record.leaseUntil;
      record.updatedAt = this.now();
      if (!requeue || record.attempt >= this.maxAttempts) {
        record.status = 'deadletter';
        record.deadletterReason = reason;
        return { result: true, dirty: true };
      }

      record.status = 'pending';
      state.pending[record.envelope.priority].push(record.envelope.id);
      return { result: true, dirty: true };
    });
  }

  requeue(messageId: string): boolean {
    return this.withLockedState((state) => {
      const record = state.records[messageId];
      if (!record) return { result: false, dirty: false };
      if (record.status === 'completed') return { result: false, dirty: false };
      if (record.status === 'pending') return { result: true, dirty: false };

      if (record.status === 'inflight' && record.claimToken) {
        delete state.inflight[record.claimToken];
      }

      delete record.workerId;
      delete record.claimToken;
      delete record.leaseUntil;
      delete record.deadletterReason;
      record.status = 'pending';
      record.updatedAt = this.now();
      state.pending[record.envelope.priority].push(messageId);
      return { result: true, dirty: true };
    });
  }

  deadletter(messageId: string, reason: string): boolean {
    return this.withLockedState((state) => {
      const record = state.records[messageId];
      if (!record) return { result: false, dirty: false };

      if (record.status === 'inflight' && record.claimToken) {
        delete state.inflight[record.claimToken];
      }

      this.removePending(state, messageId);
      delete record.workerId;
      delete record.claimToken;
      delete record.leaseUntil;
      record.status = 'deadletter';
      record.deadletterReason = reason;
      record.updatedAt = this.now();
      return { result: true, dirty: true };
    });
  }

  sweepExpiredClaims(now = this.now()): JournalBackedQueueSweepResult {
    return this.withLockedState((state) => {
      const expiredClaimTokens: string[] = [];
      let reclaimed = 0;
      let deadlettered = 0;

      for (const [claimToken, claim] of Object.entries({ ...state.inflight })) {
        if (claim.leaseUntil > now) continue;
        const record = state.records[claim.messageId];
        expiredClaimTokens.push(claimToken);
        delete state.inflight[claimToken];

        if (!record || record.status !== 'inflight' || record.claimToken !== claimToken) {
          continue;
        }

        delete record.workerId;
        delete record.claimToken;
        delete record.leaseUntil;
        record.updatedAt = now;

        if (record.attempt >= this.maxAttempts) {
          record.status = 'deadletter';
          record.deadletterReason = 'lease expired';
          deadlettered += 1;
          continue;
        }

        record.status = 'pending';
        state.pending[record.envelope.priority].push(record.envelope.id);
        reclaimed += 1;
      }

      return {
        result: { reclaimed, deadlettered, expiredClaimTokens },
        dirty: expiredClaimTokens.length > 0,
      };
    });
  }

  snapshot(): JournalBackedQueueSnapshot {
    this.refresh();
    const completed: string[] = [];
    const deadletter: string[] = [];
    for (const record of Object.values(this.state.records)) {
      if (record.status === 'completed') completed.push(record.envelope.id);
      if (record.status === 'deadletter') deadletter.push(record.envelope.id);
    }

    return {
      pending: clonePending(this.state.pending),
      inflight: { ...this.state.inflight },
      completed,
      deadletter,
    };
  }

  get(messageId: string): JournalBackedQueueRecord | undefined {
    this.refresh();
    return this.state.records[messageId] ? { ...this.state.records[messageId] } : undefined;
  }

  size(): number {
    this.refresh();
    return PRIORITY_ORDER.reduce((total, priority) => total + this.state.pending[priority].length, 0);
  }

  inflightSize(): number {
    this.refresh();
    return Object.keys(this.state.inflight).length;
  }

  importLegacyState(raw: unknown): JournalBackedQueueSnapshot {
    const state = isRecordMap(raw) && raw.version === 1
      ? normalizeState(raw as Partial<JournalBackedQueueState>)
      : buildEmptyState();
    this.controlDb.transaction((sqlite) => {
      writeQueueState(sqlite, state);
    });
    this.state = state;
    return this.snapshot();
  }

  private loadFromDb(sqlite?: SqliteDatabase): JournalBackedQueueState {
    const read = (db: SqliteDatabase): JournalBackedQueueState => readQueueState(db);
    return sqlite ? read(sqlite) : this.controlDb.read(read);
  }

  private refresh(): void {
    this.state = this.loadFromDb();
  }

  private persist(sqlite: SqliteDatabase, state: JournalBackedQueueState): void {
    writeQueueState(sqlite, JournalBackedQueueStateSchema.parse(state));
  }

  private withLockedState<T>(mutator: (state: JournalBackedQueueState) => { result: T; dirty: boolean }): T {
    return this.controlDb.transaction((sqlite) => {
      const state = this.loadFromDb(sqlite);
      const { result, dirty } = mutator(state);
      if (dirty) {
        this.persist(sqlite, state);
      }
      this.state = state;
      return result;
    });
  }

  private isLeaseExpired(record: JournalBackedQueueRecord, claimToken: string): boolean {
    return record.claimToken === claimToken && (record.leaseUntil ?? 0) <= this.now();
  }

  private removePending(state: JournalBackedQueueState, messageId: string): void {
    for (const priority of PRIORITY_ORDER) {
      const bucket = state.pending[priority];
      const index = bucket.indexOf(messageId);
      if (index >= 0) {
        bucket.splice(index, 1);
        return;
      }
    }
  }
}

interface QueueRow {
  message_id: string;
  record_json: string;
}

function readQueueState(sqlite: SqliteDatabase): JournalBackedQueueState {
  const rows = sqlite.prepare(`
    SELECT message_id, record_json
    FROM runtime_queue_records
    ORDER BY
      CASE priority
        WHEN 'critical' THEN 0
        WHEN 'high' THEN 1
        WHEN 'normal' THEN 2
        ELSE 3
      END ASC,
      queue_order ASC,
      created_at ASC,
      message_id ASC
  `).all() as QueueRow[];

  const state = buildEmptyState();
  for (const row of rows) {
    const record = parseQueueRecord(JSON.parse(row.record_json) as unknown);
    if (!record || record.envelope.id !== row.message_id) continue;
    state.records[row.message_id] = record;
    if (record.status === 'pending') {
      state.pending[record.envelope.priority].push(row.message_id);
    }
    if (record.status === 'inflight' && record.claimToken) {
      state.inflight[record.claimToken] = {
        messageId: row.message_id,
        workerId: record.workerId ?? '',
        leaseUntil: record.leaseUntil ?? 0,
        attempt: record.attempt,
        claimedAt: record.updatedAt,
      };
    }
  }
  return normalizeState(state);
}

function writeQueueState(sqlite: SqliteDatabase, state: JournalBackedQueueState): void {
  sqlite.prepare("DELETE FROM runtime_queue_records").run();
  const pendingOrder = new Map<string, number>();
  for (const priority of PRIORITY_ORDER) {
    state.pending[priority].forEach((messageId, index) => {
      pendingOrder.set(messageId, index);
    });
  }

  const insert = sqlite.prepare(`
    INSERT INTO runtime_queue_records (
      message_id,
      status,
      priority,
      attempt,
      created_at,
      updated_at,
      queue_order,
      worker_id,
      claim_token,
      lease_until,
      claimed_at,
      completed_at,
      deadletter_reason,
      dedupe_key,
      envelope_json,
      record_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, json(?), json(?))
  `);

  for (const [messageId, record] of Object.entries(state.records)) {
    const claim = record.claimToken ? state.inflight[record.claimToken] : undefined;
    insert.run(
      messageId,
      record.status,
      record.envelope.priority,
      record.attempt,
      record.createdAt,
      record.updatedAt,
      record.status === 'pending' ? pendingOrder.get(messageId) ?? null : null,
      record.workerId ?? null,
      record.claimToken ?? null,
      record.leaseUntil ?? null,
      claim?.claimedAt ?? (record.status === 'inflight' ? record.updatedAt : null),
      record.completedAt ?? null,
      record.deadletterReason ?? null,
      record.envelope.dedupe_key ?? null,
      JSON.stringify(record.envelope),
      JSON.stringify(record),
    );
  }
}
