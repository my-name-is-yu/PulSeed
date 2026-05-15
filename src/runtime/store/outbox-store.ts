import { OutboxRecordSchema, type OutboxRecord } from "./runtime-schemas.js";
import {
  createRuntimeStorePaths,
  type RuntimeStorePaths,
} from "./runtime-paths.js";
import {
  openRuntimeControlDatabase,
  resolveRuntimeControlDbBaseDir,
  type ControlDatabase,
  type RuntimeControlDbStoreOptions,
  type SqliteDatabase,
} from "./control-db/index.js";
import {
  PersonalAgentRuntimeStore,
  buildPersonalAgentDecisionTrace,
  stableId,
} from "../personal-agent/index.js";

export type OutboxSaveBoundary = "migration" | "import" | "debug" | "test_seed";

export class OutboxStore {
  private readonly paths: RuntimeStorePaths;
  private readonly dbOptions: RuntimeControlDbStoreOptions;
  private dbPromise: Promise<ControlDatabase> | null = null;

  constructor(
    runtimeRootOrPaths?: string | RuntimeStorePaths,
    options: RuntimeControlDbStoreOptions = {}
  ) {
    this.paths =
      typeof runtimeRootOrPaths === "string"
        ? createRuntimeStorePaths(runtimeRootOrPaths)
        : runtimeRootOrPaths ?? createRuntimeStorePaths();
    this.dbOptions = options;
  }

  async ensureReady(): Promise<void> {
    await this.database();
  }

  async load(seq: number): Promise<OutboxRecord | null> {
    const db = await this.database();
    return db.read((sqlite) => readOutbox(sqlite, seq));
  }

  async loadLatest(): Promise<OutboxRecord | null> {
    const db = await this.database();
    return db.read((sqlite) => {
      const row = sqlite.prepare(`
        SELECT record_json
        FROM outbox_records
        ORDER BY seq DESC
        LIMIT 1
      `).get() as OutboxRow | undefined;
      return row ? parseOutboxJson(row.record_json) : null;
    });
  }

  async list(afterSeq = 0): Promise<OutboxRecord[]> {
    const db = await this.database();
    return db.read((sqlite) => {
      const rows = sqlite.prepare(`
        SELECT record_json
        FROM outbox_records
        WHERE seq > ?
        ORDER BY seq ASC
      `).all(afterSeq) as OutboxRow[];
      return rows.map((row) => parseOutboxJson(row.record_json));
    });
  }

  async nextSeq(): Promise<number> {
    const db = await this.database();
    return db.read((sqlite) => nextOutboxSeq(sqlite));
  }

  async save(record: OutboxRecord, options?: { boundary: OutboxSaveBoundary }): Promise<OutboxRecord> {
    if (!options) {
      throw new Error("OutboxStore.save is restricted to explicit migration/import/debug/test seeding boundaries; use append() for production notification enqueue.");
    }
    const parsed = OutboxRecordSchema.parse(record);
    const db = await this.database();
    db.transaction((sqlite) => {
      upsertOutbox(sqlite, parsed);
    });
    return parsed;
  }

  async remove(seq: number): Promise<void> {
    const db = await this.database();
    db.transaction((sqlite) => {
      sqlite.prepare("DELETE FROM outbox_records WHERE seq = ?").run(seq);
    });
  }

  async append(record: Omit<OutboxRecord, "seq">): Promise<OutboxRecord> {
    const candidate = OutboxRecordSchema.parse({ ...record, seq: 1 });
    await this.recordOutboxAdmission(candidate);
    const db = await this.database();
    return db.transaction((sqlite) => {
      const dedupeKey = outboxDedupeKey(candidate);
      const existing = readOutboxByDedupeKey(sqlite, dedupeKey);
      if (existing) return existing;
      const parsed = OutboxRecordSchema.parse({ ...record, seq: nextOutboxSeq(sqlite) });
      upsertOutbox(sqlite, parsed);
      return parsed;
    });
  }

  async prune(options: {
    olderThanMs?: number;
    maxRecords?: number;
    now?: number;
  } = {}): Promise<{ pruned: number; retained: number }> {
    const now = options.now ?? Date.now();
    const olderThanMs = options.olderThanMs ?? 30 * 24 * 60 * 60 * 1000;
    const maxRecords = options.maxRecords ?? 5_000;
    const threshold = now - olderThanMs;
    const records = await this.list();
    const protectedSeq = records.length > maxRecords
      ? records[records.length - maxRecords]?.seq ?? null
      : null;

    let pruned = 0;
    for (const record of records) {
      const overAge = record.created_at < threshold;
      const overCount = protectedSeq !== null && record.seq < protectedSeq;
      if (!overAge && !overCount) {
        continue;
      }

      await this.remove(record.seq);
      pruned += 1;
    }

    return { pruned, retained: Math.max(records.length - pruned, 0) };
  }

  private async database(): Promise<ControlDatabase> {
    this.dbPromise ??= openRuntimeControlDatabase(this.paths, this.dbOptions).then((db) => {
      db.transaction((sqlite) => {
        backfillOutboxDedupeKeys(sqlite);
      });
      return db;
    });
    return this.dbPromise;
  }

  private async recordOutboxAdmission(record: OutboxRecord): Promise<void> {
    const baseDir = this.dbOptions.controlBaseDir ?? resolveRuntimeControlDbBaseDir(this.paths);
    const eventRef = outboxAdmissionRef(record);
    const emittedAt = new Date(record.created_at).toISOString();
    await new PersonalAgentRuntimeStore(baseDir, {
      ...this.dbOptions,
      controlBaseDir: baseDir,
    }).recordTrace(buildPersonalAgentDecisionTrace({
      callerPath: "notification_interruption",
      source: {
        sourceKind: "notification_report",
        sourceId: eventRef.ref,
        emittedAt,
        sourceEpoch: record.event_type,
        highWatermark: record.correlation_id ?? eventRef.ref,
        replayKey: [
          "outbox_enqueue",
          outboxDedupeKey(record),
        ].join(":"),
        summary: `Outbox event "${record.event_type}" requested delivery or replay enqueue.`,
        sourceRef: eventRef,
      },
      target: {
        kind: "notification",
        ref: eventRef,
        effect: "send_notification",
        summary: `Enqueue outbox event ${record.event_type}.`,
      },
      decision: "allow",
      decisionReason: "Outbox delivery was admitted through notification interruption policy before enqueue.",
      capabilityDecision: "available",
      capabilityRefs: [{ kind: "notification_channel", ref: "runtime_outbox" }],
      policyRef: { kind: "intervention_policy", ref: "policy:notification-interruption-v1" },
      currentRefs: [
        eventRef,
        ...(record.goal_id ? [{ kind: "goal", ref: record.goal_id }] : []),
        ...(record.correlation_id ? [{ kind: "correlation", ref: record.correlation_id }] : []),
      ],
      auditRefs: [eventRef],
    }));
  }
}

interface OutboxRow {
  seq?: number;
  record_json: string;
}

function parseOutboxJson(recordJson: string): OutboxRecord {
  return OutboxRecordSchema.parse(JSON.parse(recordJson) as unknown);
}

function readOutbox(sqlite: SqliteDatabase, seq: number): OutboxRecord | null {
  const row = sqlite.prepare(`
    SELECT record_json
    FROM outbox_records
    WHERE seq = ?
  `).get(seq) as OutboxRow | undefined;
  return row ? parseOutboxJson(row.record_json) : null;
}

function readOutboxByDedupeKey(sqlite: SqliteDatabase, dedupeKey: string): OutboxRecord | null {
  const row = sqlite.prepare(`
    SELECT record_json
    FROM outbox_records
    WHERE dedupe_key = ?
    LIMIT 1
  `).get(dedupeKey) as OutboxRow | undefined;
  if (row) return parseOutboxJson(row.record_json);
  return readAndBackfillLegacyOutboxByDedupeKey(sqlite, dedupeKey);
}

function nextOutboxSeq(sqlite: SqliteDatabase): number {
  const row = sqlite.prepare("SELECT MAX(seq) AS max_seq FROM outbox_records").get() as { max_seq: number | null };
  return (row.max_seq ?? 0) + 1;
}

function outboxKind(record: OutboxRecord): string {
  return record.event_type;
}

function outboxAdmissionRef(record: OutboxRecord): { kind: string; ref: string } {
  return {
    kind: "outbox_record",
    ref: `outbox:${stableId(outboxDedupeKey(record))}`,
  };
}

function outboxDedupeKey(record: Pick<OutboxRecord, "event_type" | "goal_id" | "correlation_id" | "payload">): string {
  return [
    record.event_type,
    record.goal_id ?? "",
    record.correlation_id ?? "",
    stableId(stableJson(record.payload)),
  ].join(":");
}

function backfillOutboxDedupeKeys(sqlite: SqliteDatabase): void {
  const rows = sqlite.prepare(`
    SELECT seq, record_json
    FROM outbox_records
    WHERE dedupe_key IS NULL
    ORDER BY seq ASC
  `).all() as Array<Required<Pick<OutboxRow, "seq" | "record_json">>>;
  const seen = new Set<string>();
  for (const row of rows) {
    const record = parseOutboxJson(row.record_json);
    const dedupeKey = outboxDedupeKey(record);
    if (seen.has(dedupeKey) || readOutboxByNonNullDedupeKey(sqlite, dedupeKey)) {
      continue;
    }
    sqlite.prepare(`
      UPDATE outbox_records
      SET dedupe_key = ?
      WHERE seq = ? AND dedupe_key IS NULL
    `).run(dedupeKey, row.seq);
    seen.add(dedupeKey);
  }
}

function readAndBackfillLegacyOutboxByDedupeKey(sqlite: SqliteDatabase, dedupeKey: string): OutboxRecord | null {
  const rows = sqlite.prepare(`
    SELECT seq, record_json
    FROM outbox_records
    WHERE dedupe_key IS NULL
    ORDER BY seq ASC
  `).all() as Array<Required<Pick<OutboxRow, "seq" | "record_json">>>;
  for (const row of rows) {
    const record = parseOutboxJson(row.record_json);
    if (outboxDedupeKey(record) !== dedupeKey) continue;
    sqlite.prepare(`
      UPDATE outbox_records
      SET dedupe_key = ?
      WHERE seq = ? AND dedupe_key IS NULL
    `).run(dedupeKey, row.seq);
    return record;
  }
  return null;
}

function readOutboxByNonNullDedupeKey(sqlite: SqliteDatabase, dedupeKey: string): OutboxRecord | null {
  const row = sqlite.prepare(`
    SELECT record_json
    FROM outbox_records
    WHERE dedupe_key = ?
    LIMIT 1
  `).get(dedupeKey) as OutboxRow | undefined;
  return row ? parseOutboxJson(row.record_json) : null;
}

function stableJson(value: unknown): string {
  return JSON.stringify(normalizeForStableJson(value));
}

function normalizeForStableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeForStableJson(item));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, normalizeForStableJson(record[key])]),
    );
  }
  return value;
}

function upsertOutbox(sqlite: SqliteDatabase, record: OutboxRecord): void {
  sqlite.prepare(`
    INSERT INTO outbox_records (seq, dedupe_key, created_at, kind, record_json)
    VALUES (?, ?, ?, ?, json(?))
    ON CONFLICT(seq) DO UPDATE SET
      dedupe_key = excluded.dedupe_key,
      created_at = excluded.created_at,
      kind = excluded.kind,
      record_json = excluded.record_json
  `).run(record.seq, outboxDedupeKey(record), record.created_at, outboxKind(record), JSON.stringify(record));
}
