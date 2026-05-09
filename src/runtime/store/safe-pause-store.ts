import {
  RuntimeSafePauseRecordSchema,
  type RuntimeSafePauseCheckpoint,
  type RuntimeSafePauseRecord,
} from "./runtime-schemas.js";
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

export interface RuntimeSafePauseRequestInput {
  goalId: string;
  reason?: string;
  requestedBy?: string;
  now?: string;
}

export interface RuntimeSafePauseCheckpointInput {
  goalId: string;
  checkpoint: RuntimeSafePauseCheckpoint;
  now?: string;
}

export class RuntimeSafePauseStore {
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

  async load(goalId: string): Promise<RuntimeSafePauseRecord | null> {
    const db = await this.database();
    return db.read((sqlite) => readSafePause(sqlite, goalId));
  }

  async list(): Promise<RuntimeSafePauseRecord[]> {
    const db = await this.database();
    return db.read((sqlite) => {
      const rows = sqlite.prepare(`
        SELECT record_json
        FROM runtime_safe_pauses
        ORDER BY updated_at ASC, goal_id ASC
      `).all() as SafePauseRow[];
      return rows.map((row) => parseSafePauseJson(row.record_json));
    });
  }

  async requestPause(input: RuntimeSafePauseRequestInput): Promise<RuntimeSafePauseRecord> {
    const now = input.now ?? new Date().toISOString();
    const existing = await this.load(input.goalId);
    return this.save({
      schema_version: "runtime-safe-pause-v1",
      goal_id: input.goalId,
      state: "pause_requested",
      requested_at: existing?.requested_at ?? now,
      updated_at: now,
      requested_by: input.requestedBy,
      reason: input.reason,
      checkpoint: existing?.checkpoint,
    });
  }

  async markPaused(input: RuntimeSafePauseCheckpointInput): Promise<RuntimeSafePauseRecord> {
    const now = input.now ?? new Date().toISOString();
    const existing = await this.load(input.goalId);
    return this.save({
      schema_version: "runtime-safe-pause-v1",
      goal_id: input.goalId,
      state: "paused",
      requested_at: existing?.requested_at ?? now,
      paused_at: existing?.paused_at ?? now,
      updated_at: now,
      requested_by: existing?.requested_by,
      reason: existing?.reason,
      checkpoint: input.checkpoint,
    });
  }

  async markResumed(goalId: string, now = new Date().toISOString()): Promise<RuntimeSafePauseRecord> {
    const existing = await this.load(goalId);
    return this.save({
      schema_version: "runtime-safe-pause-v1",
      goal_id: goalId,
      state: "resumed",
      requested_at: existing?.requested_at,
      paused_at: existing?.paused_at,
      resumed_at: now,
      updated_at: now,
      requested_by: existing?.requested_by,
      reason: existing?.reason,
      checkpoint: existing?.checkpoint,
    });
  }

  async markEmergencyStopped(goalId: string, reason: string, now = new Date().toISOString()): Promise<RuntimeSafePauseRecord> {
    const existing = await this.load(goalId);
    return this.save({
      schema_version: "runtime-safe-pause-v1",
      goal_id: goalId,
      state: "emergency_stopped",
      requested_at: existing?.requested_at,
      paused_at: existing?.paused_at,
      completed_at: now,
      updated_at: now,
      requested_by: existing?.requested_by,
      reason,
      checkpoint: existing?.checkpoint,
    });
  }

  async markCompleted(goalId: string, now = new Date().toISOString()): Promise<RuntimeSafePauseRecord> {
    const existing = await this.load(goalId);
    return this.save({
      schema_version: "runtime-safe-pause-v1",
      goal_id: goalId,
      state: "completed",
      requested_at: existing?.requested_at,
      paused_at: existing?.paused_at,
      completed_at: now,
      updated_at: now,
      requested_by: existing?.requested_by,
      reason: existing?.reason,
      checkpoint: existing?.checkpoint,
    });
  }

  async save(record: RuntimeSafePauseRecord): Promise<RuntimeSafePauseRecord> {
    const parsed = RuntimeSafePauseRecordSchema.parse(record);
    const db = await this.database();
    db.transaction((sqlite) => {
      upsertSafePause(sqlite, parsed);
    });
    return parsed;
  }

  private async database(): Promise<ControlDatabase> {
    this.dbPromise ??= openRuntimeControlDatabase(this.paths, this.dbOptions);
    return this.dbPromise;
  }
}

interface SafePauseRow {
  record_json: string;
}

function parseSafePauseJson(recordJson: string): RuntimeSafePauseRecord {
  return RuntimeSafePauseRecordSchema.parse(JSON.parse(recordJson) as unknown);
}

function readSafePause(sqlite: SqliteDatabase, goalId: string): RuntimeSafePauseRecord | null {
  const row = sqlite.prepare(`
    SELECT record_json
    FROM runtime_safe_pauses
    WHERE goal_id = ?
  `).get(goalId) as SafePauseRow | undefined;
  return row ? parseSafePauseJson(row.record_json) : null;
}

function upsertSafePause(sqlite: SqliteDatabase, record: RuntimeSafePauseRecord): void {
  sqlite.prepare(`
    INSERT INTO runtime_safe_pauses (goal_id, state, updated_at, record_json)
    VALUES (?, ?, ?, json(?))
    ON CONFLICT(goal_id) DO UPDATE SET
      state = excluded.state,
      updated_at = excluded.updated_at,
      record_json = excluded.record_json
  `).run(record.goal_id, record.state, record.updated_at, JSON.stringify(record));
}
