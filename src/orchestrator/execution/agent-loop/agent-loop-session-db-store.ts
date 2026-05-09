import {
  openControlDatabase,
  type ControlDatabase,
  type RuntimeControlDbStoreOptions,
  type SqliteDatabase,
} from "../../../runtime/store/control-db/index.js";
import type { AgentLoopEvent } from "./agent-loop-events.js";
import type { AgentLoopTraceStore } from "./agent-loop-trace-store.js";
import { redactSetupSecretsDeep } from "../../../interface/chat/setup-secret-intake.js";
import {
  normalizeAgentLoopSessionState,
  type AgentLoopSessionState,
  type AgentLoopSessionStateStore,
} from "./agent-loop-session-state.js";

export type AgentLoopSessionKind = "task" | "chat" | "review" | "unknown";

interface AgentLoopStateRow {
  state_json: string;
}

interface AgentLoopTraceEventRow {
  event_json: string;
}

export class SqliteAgentLoopSessionStateStore implements AgentLoopSessionStateStore {
  private readonly dbOptions: RuntimeControlDbStoreOptions;
  private dbPromise: Promise<ControlDatabase> | null = null;

  constructor(
    private readonly baseDir: string,
    private readonly sessionId: string,
    private readonly kind: AgentLoopSessionKind = "unknown",
    options: RuntimeControlDbStoreOptions = {},
  ) {
    this.dbOptions = options;
  }

  async load(): Promise<AgentLoopSessionState | null> {
    const db = await this.database();
    return db.read((sqlite) => {
      const row = sqlite.prepare(`
        SELECT state_json
        FROM agent_loop_session_states
        WHERE session_id = ?
      `).get(this.sessionId) as AgentLoopStateRow | undefined;
      return row ? parseAgentLoopSessionState(row.state_json) : null;
    });
  }

  async save(state: AgentLoopSessionState): Promise<void> {
    const parsed = requireAgentLoopSessionState(state);
    const db = await this.database();
    db.transaction((sqlite) => upsertAgentLoopSessionState(sqlite, parsed, this.kind));
  }

  private async database(): Promise<ControlDatabase> {
    if (this.dbOptions.controlDb) {
      return this.dbOptions.controlDb;
    }
    this.dbPromise ??= openControlDatabase({
      baseDir: this.dbOptions.controlBaseDir ?? this.baseDir,
      dbPath: this.dbOptions.controlDbPath,
    });
    return this.dbPromise;
  }
}

export class SqliteAgentLoopTraceStore implements AgentLoopTraceStore {
  private readonly dbOptions: RuntimeControlDbStoreOptions;
  private dbPromise: Promise<ControlDatabase> | null = null;

  constructor(
    private readonly baseDir: string,
    options: RuntimeControlDbStoreOptions = {},
  ) {
    this.dbOptions = options;
  }

  async append(event: AgentLoopEvent): Promise<void> {
    const safeEvent = redactSetupSecretsDeep(event) as AgentLoopEvent;
    const db = await this.database();
    db.transaction((sqlite) => {
      insertAgentLoopTraceEvent(sqlite, safeEvent);
    });
  }

  async list(traceId?: string): Promise<AgentLoopEvent[]> {
    const db = await this.database();
    return db.read((sqlite) => {
      const rows = traceId
        ? sqlite.prepare(`
            SELECT event_json
            FROM agent_loop_trace_events
            WHERE trace_id = ?
            ORDER BY sequence ASC, event_id ASC
          `).all(traceId) as AgentLoopTraceEventRow[]
        : sqlite.prepare(`
            SELECT event_json
            FROM agent_loop_trace_events
            ORDER BY created_at ASC, trace_id ASC, sequence ASC, event_id ASC
          `).all() as AgentLoopTraceEventRow[];
      return rows.map((row) => JSON.parse(row.event_json) as AgentLoopEvent);
    });
  }

  private async database(): Promise<ControlDatabase> {
    if (this.dbOptions.controlDb) {
      return this.dbOptions.controlDb;
    }
    this.dbPromise ??= openControlDatabase({
      baseDir: this.dbOptions.controlBaseDir ?? this.baseDir,
      dbPath: this.dbOptions.controlDbPath,
    });
    return this.dbPromise;
  }
}

export class AgentLoopSessionStateCatalog {
  private readonly dbOptions: RuntimeControlDbStoreOptions;
  private dbPromise: Promise<ControlDatabase> | null = null;

  constructor(
    private readonly baseDir: string,
    options: RuntimeControlDbStoreOptions = {},
  ) {
    this.dbOptions = options;
  }

  async load(sessionId: string): Promise<AgentLoopSessionState | null> {
    return new SqliteAgentLoopSessionStateStore(this.baseDir, sessionId, "unknown", this.dbOptions).load();
  }

  async list(options: { kind?: AgentLoopSessionKind } = {}): Promise<AgentLoopSessionState[]> {
    const db = await this.database();
    return db.read((sqlite) => {
      const rows = options.kind
        ? sqlite.prepare(`
            SELECT state_json
            FROM agent_loop_session_states
            WHERE kind = ?
            ORDER BY updated_at DESC, session_id ASC
          `).all(options.kind) as AgentLoopStateRow[]
        : sqlite.prepare(`
            SELECT state_json
            FROM agent_loop_session_states
            ORDER BY updated_at DESC, session_id ASC
          `).all() as AgentLoopStateRow[];
      return rows.map((row) => parseAgentLoopSessionState(row.state_json));
    });
  }

  private async database(): Promise<ControlDatabase> {
    if (this.dbOptions.controlDb) {
      return this.dbOptions.controlDb;
    }
    this.dbPromise ??= openControlDatabase({
      baseDir: this.dbOptions.controlBaseDir ?? this.baseDir,
      dbPath: this.dbOptions.controlDbPath,
    });
    return this.dbPromise;
  }
}

function parseAgentLoopSessionState(stateJson: string): AgentLoopSessionState {
  return requireAgentLoopSessionState(JSON.parse(stateJson) as unknown);
}

function requireAgentLoopSessionState(value: unknown): AgentLoopSessionState {
  const parsed = normalizeAgentLoopSessionState(value);
  if (!parsed) {
    throw new Error("Invalid AgentLoop session state record.");
  }
  return parsed;
}

function upsertAgentLoopSessionState(
  sqlite: SqliteDatabase,
  state: AgentLoopSessionState,
  kind: AgentLoopSessionKind,
): void {
  sqlite.prepare(`
    INSERT INTO agent_loop_session_states (
      session_id, trace_id, parent_session_id, kind, status, goal_id, task_id, cwd,
      turn_id, model_ref, updated_at, state_json
    ) VALUES (
      @session_id, @trace_id, @parent_session_id, @kind, @status, @goal_id, @task_id, @cwd,
      @turn_id, @model_ref, @updated_at, json(@state_json)
    )
    ON CONFLICT(session_id) DO UPDATE SET
      trace_id = excluded.trace_id,
      parent_session_id = excluded.parent_session_id,
      kind = excluded.kind,
      status = excluded.status,
      goal_id = excluded.goal_id,
      task_id = excluded.task_id,
      cwd = excluded.cwd,
      turn_id = excluded.turn_id,
      model_ref = excluded.model_ref,
      updated_at = excluded.updated_at,
      state_json = excluded.state_json
  `).run({
    session_id: state.sessionId,
    trace_id: state.traceId,
    parent_session_id: null,
    kind,
    status: state.status,
    goal_id: state.goalId,
    task_id: state.taskId ?? null,
    cwd: state.cwd,
    turn_id: state.turnId,
    model_ref: state.modelRef,
    updated_at: state.updatedAt,
    state_json: JSON.stringify(state),
  });
}

function insertAgentLoopTraceEvent(sqlite: SqliteDatabase, event: AgentLoopEvent): void {
  const sequenceRow = sqlite.prepare(`
    SELECT COALESCE(MAX(sequence), -1) + 1 AS next_sequence
    FROM agent_loop_trace_events
    WHERE trace_id = ?
  `).get(event.traceId) as { next_sequence: number } | undefined;
  const sequence = sequenceRow?.next_sequence ?? 0;
  sqlite.prepare(`
    INSERT INTO agent_loop_trace_events (
      event_id, trace_id, session_id, turn_id, goal_id, event_type, created_at, sequence, event_json
    ) VALUES (
      @event_id, @trace_id, @session_id, @turn_id, @goal_id, @event_type, @created_at, @sequence, json(@event_json)
    )
    ON CONFLICT(event_id) DO UPDATE SET
      trace_id = excluded.trace_id,
      session_id = excluded.session_id,
      turn_id = excluded.turn_id,
      goal_id = excluded.goal_id,
      event_type = excluded.event_type,
      created_at = excluded.created_at,
      event_json = excluded.event_json
  `).run({
    event_id: event.eventId,
    trace_id: event.traceId,
    session_id: event.sessionId,
    turn_id: event.turnId,
    goal_id: event.goalId,
    event_type: event.type,
    created_at: event.createdAt,
    sequence,
    event_json: JSON.stringify(event),
  });
}
