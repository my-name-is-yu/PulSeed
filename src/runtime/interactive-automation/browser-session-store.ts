import type {
  BrowserAutomationSessionRecord,
  BrowserAutomationSessionState,
} from "../store/index.js";
import {
  BrowserAutomationSessionRecordSchema,
} from "../store/runtime-schemas.js";
import {
  createRuntimeStorePaths,
  type RuntimeStorePaths,
} from "../store/runtime-paths.js";
import {
  openRuntimeControlDatabase,
  type ControlDatabase,
  type RuntimeControlDbStoreOptions,
  type SqliteDatabase,
} from "../store/control-db/index.js";

export interface BrowserSessionScope {
  providerId: string;
  serviceKey: string;
  workspace: string;
  actorKey: string;
}

export class BrowserSessionStore {
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

  async load(sessionId: string): Promise<BrowserAutomationSessionRecord | null> {
    const db = await this.database();
    return db.read((sqlite) => readBrowserSession(sqlite, sessionId));
  }

  async list(): Promise<BrowserAutomationSessionRecord[]> {
    const db = await this.database();
    return db.read((sqlite) => listBrowserSessions(sqlite));
  }

  async listPendingAuth(): Promise<BrowserAutomationSessionRecord[]> {
    return (await this.list())
      .filter((record) => record.state === "auth_required" || record.state === "expired")
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  }

  async findLatest(
    scope: BrowserSessionScope,
    states: BrowserAutomationSessionState[] = ["authenticated"],
  ): Promise<BrowserAutomationSessionRecord | null> {
    const matches = (await this.list())
      .filter((record) =>
        record.provider_id === scope.providerId
        && record.service_key === scope.serviceKey
        && record.workspace === scope.workspace
        && record.actor_key === scope.actorKey
        && states.includes(record.state)
        && !isExpired(record.expires_at)
      )
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return matches[0] ?? null;
  }

  async upsert(record: BrowserAutomationSessionRecord): Promise<BrowserAutomationSessionRecord> {
    const parsed = BrowserAutomationSessionRecordSchema.parse(record);
    const db = await this.database();
    db.transaction((sqlite) => upsertBrowserSession(sqlite, parsed));
    return parsed;
  }

  async recordAuthRequired(input: {
    sessionId: string;
    providerId: string;
    serviceKey: string;
    workspace: string;
    actorKey: string;
    failureMessage?: string | null;
    failureCode?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<BrowserAutomationSessionRecord> {
    const now = new Date().toISOString();
    const existing = await this.load(input.sessionId);
    return this.upsert({
      session_id: input.sessionId,
      provider_id: input.providerId,
      service_key: input.serviceKey,
      workspace: input.workspace,
      actor_key: input.actorKey,
      state: "auth_required",
      created_at: existing?.created_at ?? now,
      updated_at: now,
      last_auth_at: existing?.last_auth_at ?? null,
      expires_at: existing?.expires_at ?? null,
      last_failure_code: input.failureCode ?? existing?.last_failure_code ?? null,
      last_failure_message: input.failureMessage ?? existing?.last_failure_message ?? null,
      metadata: input.metadata ?? existing?.metadata,
    });
  }

  async recordAuthenticated(input: {
    sessionId: string;
    providerId: string;
    serviceKey: string;
    workspace: string;
    actorKey: string;
    expiresAt?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<BrowserAutomationSessionRecord> {
    const existing = await this.load(input.sessionId);
    const now = new Date().toISOString();
    return this.upsert({
      session_id: input.sessionId,
      provider_id: input.providerId,
      service_key: input.serviceKey,
      workspace: input.workspace,
      actor_key: input.actorKey,
      state: "authenticated",
      created_at: existing?.created_at ?? now,
      updated_at: now,
      last_auth_at: now,
      expires_at: input.expiresAt ?? existing?.expires_at ?? null,
      last_failure_code: null,
      last_failure_message: null,
      metadata: input.metadata ?? existing?.metadata,
    });
  }

  async markAuthenticated(sessionId: string, updates: {
    expiresAt?: string | null;
    metadata?: Record<string, unknown>;
  } = {}): Promise<BrowserAutomationSessionRecord | null> {
    const existing = await this.load(sessionId);
    if (!existing) return null;
    const now = new Date().toISOString();
    return this.upsert({
      ...existing,
      state: "authenticated",
      updated_at: now,
      last_auth_at: now,
      expires_at: updates.expiresAt ?? existing.expires_at ?? null,
      last_failure_code: null,
      last_failure_message: null,
      metadata: updates.metadata ?? existing.metadata,
    });
  }

  async importLegacyRecord(record: BrowserAutomationSessionRecord): Promise<BrowserAutomationSessionRecord> {
    return this.upsert(BrowserAutomationSessionRecordSchema.parse(record));
  }

  private async database(): Promise<ControlDatabase> {
    this.dbPromise ??= openRuntimeControlDatabase(this.paths, this.dbOptions);
    return this.dbPromise;
  }
}

interface BrowserSessionRow {
  record_json: string;
}

function parseBrowserSessionJson(recordJson: string): BrowserAutomationSessionRecord | null {
  try {
    const parsed = BrowserAutomationSessionRecordSchema.safeParse(JSON.parse(recordJson) as unknown);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function readBrowserSession(sqlite: SqliteDatabase, sessionId: string): BrowserAutomationSessionRecord | null {
  const row = sqlite.prepare(`
    SELECT record_json
    FROM browser_automation_sessions
    WHERE session_id = ?
  `).get(sessionId) as BrowserSessionRow | undefined;
  return row ? parseBrowserSessionJson(row.record_json) : null;
}

function listBrowserSessions(sqlite: SqliteDatabase): BrowserAutomationSessionRecord[] {
  const rows = sqlite.prepare(`
    SELECT record_json
    FROM browser_automation_sessions
    ORDER BY session_id ASC
  `).all() as BrowserSessionRow[];
  return rows.flatMap((row) => {
    const record = parseBrowserSessionJson(row.record_json);
    return record ? [record] : [];
  });
}

function upsertBrowserSession(sqlite: SqliteDatabase, record: BrowserAutomationSessionRecord): void {
  sqlite.prepare(`
    INSERT INTO browser_automation_sessions (
      session_id,
      provider_id,
      service_key,
      workspace,
      actor_key,
      state,
      created_at,
      updated_at,
      last_auth_at,
      expires_at,
      record_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, json(?))
    ON CONFLICT(session_id) DO UPDATE SET
      provider_id = excluded.provider_id,
      service_key = excluded.service_key,
      workspace = excluded.workspace,
      actor_key = excluded.actor_key,
      state = excluded.state,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      last_auth_at = excluded.last_auth_at,
      expires_at = excluded.expires_at,
      record_json = excluded.record_json
  `).run(
    record.session_id,
    record.provider_id,
    record.service_key,
    record.workspace,
    record.actor_key,
    record.state,
    record.created_at,
    record.updated_at,
    record.last_auth_at ?? null,
    record.expires_at ?? null,
    JSON.stringify(record),
  );
}

function isExpired(expiresAt?: string | null): boolean {
  if (!expiresAt) return false;
  const expiresAtMs = Date.parse(expiresAt);
  return Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now();
}
