import { OutboxRecordSchema, type OutboxRecord } from "./runtime-schemas.js";
import {
  createRuntimeStorePaths,
  type RuntimeStorePaths,
} from "./runtime-paths.js";
import {
  openRuntimeControlDatabase,
  type ControlDatabase,
  type RuntimeControlDbStoreOptions,
  type SqliteDatabase,
} from "./control-db/index.js";

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

  async save(record: OutboxRecord): Promise<OutboxRecord> {
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
    const db = await this.database();
    return db.transaction((sqlite) => {
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
    this.dbPromise ??= openRuntimeControlDatabase(this.paths, this.dbOptions);
    return this.dbPromise;
  }
}

interface OutboxRow {
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

function nextOutboxSeq(sqlite: SqliteDatabase): number {
  const row = sqlite.prepare("SELECT MAX(seq) AS max_seq FROM outbox_records").get() as { max_seq: number | null };
  return (row.max_seq ?? 0) + 1;
}

function outboxKind(record: OutboxRecord): string {
  return record.event_type;
}

function upsertOutbox(sqlite: SqliteDatabase, record: OutboxRecord): void {
  sqlite.prepare(`
    INSERT INTO outbox_records (seq, created_at, kind, record_json)
    VALUES (?, ?, ?, json(?))
    ON CONFLICT(seq) DO UPDATE SET
      created_at = excluded.created_at,
      kind = excluded.kind,
      record_json = excluded.record_json
  `).run(record.seq, record.created_at, outboxKind(record), JSON.stringify(record));
}
