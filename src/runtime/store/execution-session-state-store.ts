import {
  openControlDatabase,
  type ControlDatabase,
  type RuntimeControlDbStoreOptions,
  type SqliteDatabase,
} from "./control-db/index.js";
import { SessionSchema, type Session } from "../../base/types/session.js";

interface ExecutionSessionRow {
  session_json: string;
}

export interface ExecutionSessionListOptions {
  goalId?: string;
  activeOnly?: boolean;
  limit?: number;
}

export interface ExecutionSessionStateStoreOptions extends RuntimeControlDbStoreOptions {}

function nowIso(): string {
  return new Date().toISOString();
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function normalizeLimit(limit: number | undefined): number | null {
  if (limit === undefined) return null;
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw new Error(`Invalid execution session list limit: ${limit}`);
  }
  return limit;
}

function rowToSession(row: ExecutionSessionRow): Session {
  return SessionSchema.parse(parseJson(row.session_json));
}

function upsertSession(sqlite: SqliteDatabase, session: Session, updatedAt: string): void {
  sqlite.prepare(`
    INSERT INTO execution_sessions (
      session_id, session_type, goal_id, task_id, started_at, ended_at,
      updated_at, active, session_json
    ) VALUES (
      @session_id, @session_type, @goal_id, @task_id, @started_at, @ended_at,
      @updated_at, @active, json(@session_json)
    )
    ON CONFLICT(session_id) DO UPDATE SET
      session_type = excluded.session_type,
      goal_id = excluded.goal_id,
      task_id = excluded.task_id,
      started_at = excluded.started_at,
      ended_at = excluded.ended_at,
      updated_at = excluded.updated_at,
      active = excluded.active,
      session_json = excluded.session_json
  `).run({
    session_id: session.id,
    session_type: session.session_type,
    goal_id: session.goal_id,
    task_id: session.task_id,
    started_at: session.started_at,
    ended_at: session.ended_at,
    updated_at: updatedAt,
    active: session.ended_at === null ? 1 : 0,
    session_json: JSON.stringify(session),
  });
}

export class ExecutionSessionStateStore {
  private dbPromise: Promise<ControlDatabase> | null = null;

  constructor(
    private readonly baseDir: string,
    private readonly options: ExecutionSessionStateStoreOptions = {},
  ) {}

  async ensureReady(): Promise<void> {
    await this.database();
  }

  async save(session: Session, updatedAt = nowIso()): Promise<Session> {
    const parsed = SessionSchema.parse(session);
    const db = await this.database();
    db.transaction((sqlite) => upsertSession(sqlite, parsed, updatedAt));
    return parsed;
  }

  async load(sessionId: string): Promise<Session | null> {
    const db = await this.database();
    return db.read((sqlite) => {
      const row = sqlite.prepare(`
        SELECT session_json
        FROM execution_sessions
        WHERE session_id = ?
      `).get(sessionId) as ExecutionSessionRow | undefined;
      return row ? rowToSession(row) : null;
    });
  }

  async list(options: ExecutionSessionListOptions = {}): Promise<Session[]> {
    const limit = normalizeLimit(options.limit);
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (options.goalId !== undefined) {
      clauses.push("goal_id = ?");
      params.push(options.goalId);
    }
    if (options.activeOnly) {
      clauses.push("active = 1");
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const limitSql = limit === null ? "" : " LIMIT ?";
    if (limit !== null) {
      params.push(limit);
    }

    const db = await this.database();
    return db.read((sqlite) => {
      const rows = sqlite.prepare(`
        SELECT session_json
        FROM execution_sessions
        ${where}
        ORDER BY started_at DESC, session_id ASC
        ${limitSql}
      `).all(...params) as ExecutionSessionRow[];
      return rows.map(rowToSession);
    });
  }

  private async database(): Promise<ControlDatabase> {
    if (this.options.controlDb) {
      return this.options.controlDb;
    }
    this.dbPromise ??= openControlDatabase({
      baseDir: this.options.controlBaseDir ?? this.baseDir,
      dbPath: this.options.controlDbPath,
    });
    return this.dbPromise;
  }
}
