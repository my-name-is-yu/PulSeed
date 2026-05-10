import {
  openControlDatabase,
  type ControlDatabase,
  type RuntimeControlDbStoreOptions,
  type SqliteDatabase,
} from "../../runtime/store/control-db/index.js";
import {
  ChatSessionSchema,
  type ChatSession,
} from "./chat-session-contracts.js";
import type { CrossPlatformChatSessionInfo } from "./cross-platform-session-types.js";

interface ChatSessionRow {
  session_json: string;
}

interface CrossPlatformSessionRow {
  info_json: string;
}

export class ChatSessionDataStore {
  private readonly dbOptions: RuntimeControlDbStoreOptions;
  private dbPromise: Promise<ControlDatabase> | null = null;

  constructor(
    private readonly baseDir: string,
    options: RuntimeControlDbStoreOptions = {},
  ) {
    this.dbOptions = options;
  }

  async save(session: ChatSession): Promise<ChatSession> {
    const parsed = ChatSessionSchema.parse(session);
    const db = await this.database();
    db.transaction((sqlite) => upsertChatSession(sqlite, parsed));
    return parsed;
  }

  async load(sessionId: string): Promise<ChatSession | null> {
    const db = await this.database();
    return db.read((sqlite) => {
      const row = sqlite.prepare(`
        SELECT session_json
        FROM chat_sessions
        WHERE session_id = ?
      `).get(sessionId) as ChatSessionRow | undefined;
      return row ? ChatSessionSchema.parse(JSON.parse(row.session_json) as unknown) : null;
    });
  }

  async list(options: { cwd?: string } = {}): Promise<ChatSession[]> {
    const db = await this.database();
    return db.read((sqlite) => {
      const rows = options.cwd?.trim()
        ? sqlite.prepare(`
            SELECT session_json
            FROM chat_sessions
            WHERE cwd = ?
            ORDER BY activity_at_ms DESC, updated_at DESC, session_id ASC
          `).all(options.cwd.trim()) as ChatSessionRow[]
        : sqlite.prepare(`
            SELECT session_json
            FROM chat_sessions
            ORDER BY activity_at_ms DESC, updated_at DESC, session_id ASC
          `).all() as ChatSessionRow[];
      return rows.map((row) => ChatSessionSchema.parse(JSON.parse(row.session_json) as unknown));
    });
  }

  async deleteSessions(sessionIds: readonly string[]): Promise<void> {
    if (sessionIds.length === 0) return;
    const db = await this.database();
    db.transaction((sqlite) => {
      const deleteSession = sqlite.prepare("DELETE FROM chat_sessions WHERE session_id = ?");
      for (const sessionId of sessionIds) {
        deleteSession.run(sessionId);
      }
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

export class CrossPlatformChatSessionInfoStore {
  private readonly dbOptions: RuntimeControlDbStoreOptions;
  private dbPromise: Promise<ControlDatabase> | null = null;

  constructor(
    private readonly baseDir: string,
    options: RuntimeControlDbStoreOptions = {},
  ) {
    this.dbOptions = options;
  }

  async load(sessionKey: string): Promise<CrossPlatformChatSessionInfo | null> {
    const db = await this.database();
    return db.read((sqlite) => {
      const row = sqlite.prepare(`
        SELECT info_json
        FROM chat_cross_platform_sessions
        WHERE session_key = ?
      `).get(sessionKey) as CrossPlatformSessionRow | undefined;
      return row ? parseCrossPlatformSessionInfo(row.info_json, sessionKey) : null;
    });
  }

  async save(info: CrossPlatformChatSessionInfo): Promise<CrossPlatformChatSessionInfo> {
    const parsed = normalizeCrossPlatformSessionInfo(info);
    const db = await this.database();
    db.transaction((sqlite) => upsertCrossPlatformSessionInfo(sqlite, parsed));
    return parsed;
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

function upsertChatSession(sqlite: SqliteDatabase, session: ChatSession): void {
  const updatedAt = session.updatedAt ?? session.createdAt;
  sqlite.prepare(`
    INSERT INTO chat_sessions (
      session_id, cwd, title, parent_session_id, session_status, agent_loop_session_id,
      agent_loop_trace_id, message_count, created_at, updated_at, activity_at_ms, session_json
    ) VALUES (
      @session_id, @cwd, @title, @parent_session_id, @session_status, @agent_loop_session_id,
      @agent_loop_trace_id, @message_count, @created_at, @updated_at, @activity_at_ms, json(@session_json)
    )
    ON CONFLICT(session_id) DO UPDATE SET
      cwd = excluded.cwd,
      title = excluded.title,
      parent_session_id = excluded.parent_session_id,
      session_status = excluded.session_status,
      agent_loop_session_id = excluded.agent_loop_session_id,
      agent_loop_trace_id = excluded.agent_loop_trace_id,
      message_count = excluded.message_count,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      activity_at_ms = excluded.activity_at_ms,
      session_json = excluded.session_json
  `).run({
    session_id: session.id,
    cwd: session.cwd,
    title: normalizeString(session.title),
    parent_session_id: normalizeString(session.parentSessionId),
    session_status: session.sessionStatus ?? null,
    agent_loop_session_id: normalizeString(session.agentLoopSessionId),
    agent_loop_trace_id: normalizeString(session.agentLoopTraceId),
    message_count: session.messages.length,
    created_at: session.createdAt,
    updated_at: updatedAt,
    activity_at_ms: activityAtMs(session),
    session_json: JSON.stringify({ ...session, updatedAt }),
  });
}

function activityAtMs(session: ChatSession): number {
  const candidates = [
    session.agentLoopUpdatedAt,
    session.completedAt,
    session.updatedAt,
    session.createdAt,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const parsed = Date.parse(candidate);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function parseCrossPlatformSessionInfo(infoJson: string, sessionKey: string): CrossPlatformChatSessionInfo | null {
  try {
    const parsed = normalizeCrossPlatformSessionInfo(JSON.parse(infoJson) as CrossPlatformChatSessionInfo);
    return parsed.session_key === sessionKey ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeCrossPlatformSessionInfo(info: CrossPlatformChatSessionInfo): CrossPlatformChatSessionInfo {
  const sessionKey = normalizeString(info.session_key);
  const cwd = normalizeString(info.cwd);
  const createdAt = normalizeString(info.created_at);
  const lastUsedAt = normalizeString(info.last_used_at);
  if (!sessionKey || !cwd || !createdAt || !lastUsedAt) {
    throw new Error("Invalid cross-platform chat session info record.");
  }
  return {
    session_key: sessionKey,
    ...(normalizeString(info.identity_key) ? { identity_key: normalizeString(info.identity_key)! } : {}),
    ...(normalizeString(info.platform) ? { platform: normalizeString(info.platform)! } : {}),
    ...(normalizeString(info.conversation_id) ? { conversation_id: normalizeString(info.conversation_id)! } : {}),
    ...(normalizeString(info.conversation_name) ? { conversation_name: normalizeString(info.conversation_name)! } : {}),
    ...(normalizeString(info.user_id) ? { user_id: normalizeString(info.user_id)! } : {}),
    ...(normalizeString(info.user_name) ? { user_name: normalizeString(info.user_name)! } : {}),
    cwd,
    created_at: createdAt,
    last_used_at: lastUsedAt,
    ...(normalizeString(info.last_message_id) ? { last_message_id: normalizeString(info.last_message_id)! } : {}),
    ...(normalizeString(info.chat_session_id) ? { chat_session_id: normalizeString(info.chat_session_id)! } : {}),
    ...(info.active_reply_target ? { active_reply_target: info.active_reply_target } : {}),
    ...(info.active_companion_contract ? { active_companion_contract: info.active_companion_contract } : {}),
    metadata: { ...(info.metadata ?? {}) },
  };
}

function upsertCrossPlatformSessionInfo(sqlite: SqliteDatabase, info: CrossPlatformChatSessionInfo): void {
  sqlite.prepare(`
    INSERT INTO chat_cross_platform_sessions (
      session_key, chat_session_id, identity_key, platform, conversation_id, user_id,
      cwd, created_at, last_used_at, info_json
    ) VALUES (
      @session_key, @chat_session_id, @identity_key, @platform, @conversation_id, @user_id,
      @cwd, @created_at, @last_used_at, json(@info_json)
    )
    ON CONFLICT(session_key) DO UPDATE SET
      chat_session_id = excluded.chat_session_id,
      identity_key = excluded.identity_key,
      platform = excluded.platform,
      conversation_id = excluded.conversation_id,
      user_id = excluded.user_id,
      cwd = excluded.cwd,
      created_at = excluded.created_at,
      last_used_at = excluded.last_used_at,
      info_json = excluded.info_json
  `).run({
    session_key: info.session_key,
    chat_session_id: info.chat_session_id ?? null,
    identity_key: info.identity_key ?? null,
    platform: info.platform ?? null,
    conversation_id: info.conversation_id ?? null,
    user_id: info.user_id ?? null,
    cwd: info.cwd,
    created_at: info.created_at,
    last_used_at: info.last_used_at,
    info_json: JSON.stringify(info),
  });
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
