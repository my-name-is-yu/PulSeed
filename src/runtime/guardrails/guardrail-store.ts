import type {
  BackpressureSnapshot,
  CircuitBreakerRecord,
} from "../store/index.js";
import {
  BackpressureSnapshotSchema,
  CircuitBreakerRecordSchema,
  createRuntimeStorePaths,
  openRuntimeControlDatabase,
  type ControlDatabase,
  type RuntimeControlDbStoreOptions,
  type RuntimeStorePaths,
  type SqliteDatabase,
} from "../store/index.js";

export class GuardrailStore {
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

  async loadBreaker(key: string): Promise<CircuitBreakerRecord | null> {
    const db = await this.database();
    return db.read((sqlite) => readBreaker(sqlite, key));
  }

  async saveBreaker(record: CircuitBreakerRecord): Promise<CircuitBreakerRecord> {
    const parsed = CircuitBreakerRecordSchema.parse(record);
    const db = await this.database();
    db.transaction((sqlite) => {
      upsertBreaker(sqlite, parsed);
    });
    return parsed;
  }

  async listBreakers(): Promise<CircuitBreakerRecord[]> {
    const db = await this.database();
    return db.read((sqlite) => {
      const rows = sqlite.prepare(`
        SELECT record_json
        FROM guardrail_breakers
        ORDER BY updated_at ASC, breaker_key ASC
      `).all() as GuardrailRow[];
      return rows.map((row) => parseBreakerJson(row.record_json));
    });
  }

  async loadBackpressureSnapshot(): Promise<BackpressureSnapshot | null> {
    const db = await this.database();
    const snapshot = db.read((sqlite) => readBackpressureSnapshot(sqlite));
    return snapshot
      ? {
        ...snapshot,
        throttled: snapshot.throttled ?? [],
      }
      : null;
  }

  async saveBackpressureSnapshot(snapshot: BackpressureSnapshot): Promise<BackpressureSnapshot> {
    const parsed = BackpressureSnapshotSchema.parse(snapshot);
    const db = await this.database();
    db.transaction((sqlite) => {
      upsertBackpressureSnapshot(sqlite, parsed);
    });
    return parsed;
  }

  async updateBackpressureSnapshot<T>(
    updater: (snapshot: BackpressureSnapshot) => { snapshot: BackpressureSnapshot; result: T },
  ): Promise<T> {
    const db = await this.database();
    return db.transaction((sqlite) => {
      const current = readBackpressureSnapshot(sqlite) ?? {
        updated_at: new Date().toISOString(),
        active: [],
        throttled: [],
      };
      const updated = updater(current);
      upsertBackpressureSnapshot(sqlite, BackpressureSnapshotSchema.parse(updated.snapshot));
      return updated.result;
    });
  }

  private async database(): Promise<ControlDatabase> {
    this.dbPromise ??= openRuntimeControlDatabase(this.paths, this.dbOptions);
    return this.dbPromise;
  }
}

interface GuardrailRow {
  record_json: string;
}

interface BackpressureRow {
  snapshot_json: string;
}

function parseBreakerJson(recordJson: string): CircuitBreakerRecord {
  return CircuitBreakerRecordSchema.parse(JSON.parse(recordJson) as unknown);
}

function parseBackpressureJson(snapshotJson: string): BackpressureSnapshot {
  return BackpressureSnapshotSchema.parse(JSON.parse(snapshotJson) as unknown);
}

function readBreaker(sqlite: SqliteDatabase, key: string): CircuitBreakerRecord | null {
  const row = sqlite.prepare(`
    SELECT record_json
    FROM guardrail_breakers
    WHERE breaker_key = ?
  `).get(key) as GuardrailRow | undefined;
  return row ? parseBreakerJson(row.record_json) : null;
}

function readBackpressureSnapshot(sqlite: SqliteDatabase): BackpressureSnapshot | null {
  const row = sqlite.prepare(`
    SELECT snapshot_json
    FROM guardrail_backpressure_snapshots
    WHERE snapshot_id = 'current'
  `).get() as BackpressureRow | undefined;
  return row ? parseBackpressureJson(row.snapshot_json) : null;
}

function upsertBreaker(sqlite: SqliteDatabase, record: CircuitBreakerRecord): void {
  sqlite.prepare(`
    INSERT INTO guardrail_breakers (breaker_key, state, updated_at, record_json)
    VALUES (?, ?, ?, json(?))
    ON CONFLICT(breaker_key) DO UPDATE SET
      state = excluded.state,
      updated_at = excluded.updated_at,
      record_json = excluded.record_json
  `).run(record.key, record.state, record.updated_at, JSON.stringify(record));
}

function upsertBackpressureSnapshot(sqlite: SqliteDatabase, snapshot: BackpressureSnapshot): void {
  sqlite.prepare(`
    INSERT INTO guardrail_backpressure_snapshots (snapshot_id, updated_at, snapshot_json)
    VALUES ('current', ?, json(?))
    ON CONFLICT(snapshot_id) DO UPDATE SET
      updated_at = excluded.updated_at,
      snapshot_json = excluded.snapshot_json
  `).run(snapshot.updated_at, JSON.stringify(snapshot));
}
