import { z } from "zod";
import {
  openControlDatabase,
  openControlDatabaseSync,
  type ControlDatabase,
  type RuntimeControlDbStoreOptions,
  type SqliteDatabase,
} from "./control-db/index.js";

export const PROCESS_SESSION_SNAPSHOT_REF_PREFIX = "control-db://process-sessions/";

const ProcessSessionSignalSchema = z.custom<NodeJS.Signals>((value) => typeof value === "string");

const ProcessSessionSnapshotSchema = z.object({
  session_id: z.string().min(1),
  label: z.string().optional(),
  command: z.string().min(1),
  args: z.array(z.string()),
  cwd: z.string().min(1),
  goal_id: z.string().optional(),
  task_id: z.string().optional(),
  strategy_id: z.string().optional(),
  pid: z.number().int().positive().safe().optional(),
  running: z.boolean(),
  exitCode: z.number().int().safe().nullable(),
  signal: ProcessSessionSignalSchema.nullable(),
  startedAt: z.string().min(1),
  exitedAt: z.string().optional(),
  bufferedChars: z.number().int().nonnegative(),
  metadataRef: z.string().optional(),
  artifactRefs: z.array(z.string()).optional(),
}).passthrough();

export type ProcessSessionStateSnapshot = z.infer<typeof ProcessSessionSnapshotSchema>;

export interface ProcessSessionStateStoreOptions extends RuntimeControlDbStoreOptions {}

export interface RawStateStoreResult {
  handled: boolean;
  value: unknown | null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function processSessionRef(sessionId: string): string {
  return `${PROCESS_SESSION_SNAPSHOT_REF_PREFIX}${encodeURIComponent(sessionId)}`;
}

function parseProcessSessionRawPath(relativePath: string): string | null {
  const parts = relativePath.replace(/\\/g, "/").replace(/^\/+/, "").split("/").filter(Boolean);
  if (parts.length !== 3 || parts[0] !== "runtime" || parts[1] !== "process-sessions" || !parts[2]!.endsWith(".json")) {
    return null;
  }
  const sessionId = parts[2]!.slice(0, -".json".length);
  return sessionId.length > 0 ? sessionId : null;
}

function normalizeSnapshot(input: unknown): ProcessSessionStateSnapshot {
  const parsed = ProcessSessionSnapshotSchema.parse(input);
  return {
    ...parsed,
    metadataRef: parsed.metadataRef ?? processSessionRef(parsed.session_id),
  };
}

function saveSnapshotRow(sqlite: SqliteDatabase, snapshot: ProcessSessionStateSnapshot, updatedAt: string): void {
  sqlite.prepare(`
    INSERT INTO process_session_snapshots (
      session_id, label, command, cwd, goal_id, task_id, strategy_id, pid, running,
      exit_code, signal, started_at, exited_at, updated_at, snapshot_json
    ) VALUES (
      @session_id, @label, @command, @cwd, @goal_id, @task_id, @strategy_id, @pid, @running,
      @exit_code, @signal, @started_at, @exited_at, @updated_at, @snapshot_json
    )
    ON CONFLICT(session_id) DO UPDATE SET
      label = excluded.label,
      command = excluded.command,
      cwd = excluded.cwd,
      goal_id = excluded.goal_id,
      task_id = excluded.task_id,
      strategy_id = excluded.strategy_id,
      pid = excluded.pid,
      running = excluded.running,
      exit_code = excluded.exit_code,
      signal = excluded.signal,
      started_at = excluded.started_at,
      exited_at = excluded.exited_at,
      updated_at = excluded.updated_at,
      snapshot_json = excluded.snapshot_json
  `).run({
    session_id: snapshot.session_id,
    label: snapshot.label ?? null,
    command: snapshot.command,
    cwd: snapshot.cwd,
    goal_id: snapshot.goal_id ?? null,
    task_id: snapshot.task_id ?? null,
    strategy_id: snapshot.strategy_id ?? null,
    pid: snapshot.pid ?? null,
    running: snapshot.running ? 1 : 0,
    exit_code: snapshot.exitCode,
    signal: snapshot.signal,
    started_at: snapshot.startedAt,
    exited_at: snapshot.exitedAt ?? null,
    updated_at: updatedAt,
    snapshot_json: stringifyJson(snapshot),
  });
}

function rowToSnapshot(row: { snapshot_json: string }): ProcessSessionStateSnapshot {
  return normalizeSnapshot(parseJson(row.snapshot_json));
}

export class ProcessSessionStateStore {
  private dbPromise: Promise<ControlDatabase> | null = null;

  constructor(
    private readonly baseDir: string,
    private readonly options: ProcessSessionStateStoreOptions = {},
  ) {}

  async ensureReady(): Promise<void> {
    await this.database();
  }

  metadataRef(sessionId: string): string {
    return processSessionRef(sessionId);
  }

  async saveSnapshot(input: unknown, updatedAt = nowIso()): Promise<void> {
    const snapshot = normalizeSnapshot(input);
    const db = await this.database();
    db.transaction((sqlite) => saveSnapshotRow(sqlite, snapshot, updatedAt));
  }

  saveSnapshotSync(input: unknown, updatedAt = nowIso()): void {
    const snapshot = normalizeSnapshot(input);
    if (this.options.controlDb) {
      this.options.controlDb.transaction((sqlite) => saveSnapshotRow(sqlite, snapshot, updatedAt));
      return;
    }
    const db = openControlDatabaseSync({
      baseDir: this.options.controlBaseDir ?? this.baseDir,
      dbPath: this.options.controlDbPath,
    });
    try {
      db.transaction((sqlite) => saveSnapshotRow(sqlite, snapshot, updatedAt));
    } finally {
      db.close();
    }
  }

  async loadSnapshot(sessionId: string): Promise<ProcessSessionStateSnapshot | null> {
    const db = await this.database();
    return db.read((sqlite) => {
      const row = sqlite.prepare(`
        SELECT snapshot_json
        FROM process_session_snapshots
        WHERE session_id = ?
      `).get(sessionId) as { snapshot_json: string } | undefined;
      return row ? rowToSnapshot(row) : null;
    });
  }

  async listSnapshots(): Promise<ProcessSessionStateSnapshot[]> {
    const db = await this.database();
    return db.read((sqlite) => {
      const rows = sqlite.prepare(`
        SELECT snapshot_json
        FROM process_session_snapshots
        ORDER BY updated_at DESC, session_id ASC
      `).all() as Array<{ snapshot_json: string }>;
      return rows.map(rowToSnapshot);
    });
  }

  async deleteSnapshot(sessionId: string): Promise<boolean> {
    const db = await this.database();
    return db.transaction((sqlite) => {
      const result = sqlite.prepare("DELETE FROM process_session_snapshots WHERE session_id = ?").run(sessionId);
      return result.changes > 0;
    });
  }

  async readRawPath(relativePath: string): Promise<RawStateStoreResult> {
    const sessionId = parseProcessSessionRawPath(relativePath);
    if (!sessionId) return { handled: false, value: null };
    return { handled: true, value: await this.loadSnapshot(sessionId) };
  }

  async writeRawPath(relativePath: string, data: unknown): Promise<boolean> {
    const sessionId = parseProcessSessionRawPath(relativePath);
    if (!sessionId) return false;
    if (data === null) {
      await this.deleteSnapshot(sessionId);
      return true;
    }
    await this.saveSnapshot({
      ...(typeof data === "object" && data !== null ? data : {}),
      session_id: sessionId,
    });
    return true;
  }

  private async database(): Promise<ControlDatabase> {
    if (this.options.controlDb) {
      return this.options.controlDb;
    }
    if (!this.dbPromise) {
      this.dbPromise = openControlDatabase({
        baseDir: this.options.controlBaseDir ?? this.baseDir,
        dbPath: this.options.controlDbPath,
      });
    }
    return this.dbPromise;
  }
}
