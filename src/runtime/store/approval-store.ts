import {
  ApprovalRecordSchema,
  ApprovalStateSchema,
  type ApprovalRecord,
  type ApprovalState,
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

export interface ApprovalResolutionInput {
  state: Exclude<ApprovalState, "pending">;
  resolved_at?: number;
  response_channel?: string;
  payload?: unknown;
}

export class ApprovalStore {
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

  async load(approvalId: string): Promise<ApprovalRecord | null> {
    const db = await this.database();
    return db.read((sqlite) => readApproval(sqlite, approvalId));
  }

  async loadPending(approvalId: string): Promise<ApprovalRecord | null> {
    const record = await this.load(approvalId);
    return record?.state === "pending" ? record : null;
  }

  async loadResolved(approvalId: string): Promise<ApprovalRecord | null> {
    const record = await this.load(approvalId);
    return record && record.state !== "pending" ? record : null;
  }

  async listPending(): Promise<ApprovalRecord[]> {
    const db = await this.database();
    return db.read((sqlite) => listApprovals(sqlite, "state = 'pending'"));
  }

  async listResolved(): Promise<ApprovalRecord[]> {
    const db = await this.database();
    return db.read((sqlite) => listApprovals(sqlite, "state <> 'pending'"));
  }

  async removePending(approvalId: string): Promise<void> {
    const db = await this.database();
    db.transaction((sqlite) => {
      sqlite.prepare("DELETE FROM approval_records WHERE approval_id = ? AND state = 'pending'").run(approvalId);
    });
  }

  async removeResolved(approvalId: string): Promise<void> {
    const db = await this.database();
    db.transaction((sqlite) => {
      sqlite.prepare("DELETE FROM approval_records WHERE approval_id = ? AND state <> 'pending'").run(approvalId);
    });
  }

  async savePending(record: ApprovalRecord): Promise<ApprovalRecord> {
    const parsed = ApprovalRecordSchema.parse({ ...record, state: "pending" });
    const db = await this.database();
    return db.transaction((sqlite) => {
      const existing = readApproval(sqlite, parsed.approval_id);
      if (existing !== null && existing.state !== "pending") return existing;
      upsertApproval(sqlite, parsed);
      return parsed;
    });
  }

  async saveResolved(record: ApprovalRecord): Promise<ApprovalRecord> {
    const parsed = ApprovalRecordSchema.parse({
      ...record,
      state: ApprovalStateSchema.parse(record.state),
      resolved_at: record.resolved_at ?? Date.now(),
    });
    const db = await this.database();
    db.transaction((sqlite) => {
      upsertApproval(sqlite, parsed);
    });
    return parsed;
  }

  async resolvePending(approvalId: string, update: ApprovalResolutionInput): Promise<ApprovalRecord | null> {
    const db = await this.database();
    return db.transaction((sqlite) => {
      const current = readApproval(sqlite, approvalId);
      if (current === null) return null;
      if (current.state !== "pending") return current;

      const resolved = ApprovalRecordSchema.parse({
        ...current,
        ...update,
        approval_id: current.approval_id,
        state: ApprovalStateSchema.parse(update.state),
        resolved_at: update.resolved_at ?? Date.now(),
      });
      upsertApproval(sqlite, resolved);
      return resolved;
    });
  }

  async reconcile(now = Date.now()): Promise<{
    removedPending: number;
    expiredPending: number;
  }> {
    const pending = await this.listPending();
    const removedPending = 0;
    let expiredPending = 0;

    for (const record of pending) {
      if (record.expires_at > now) {
        continue;
      }

      await this.resolvePending(record.approval_id, {
        state: "expired",
        resolved_at: now,
        response_channel: record.response_channel,
        payload: record.payload,
      });
      expiredPending += 1;
    }

    return { removedPending, expiredPending };
  }

  async pruneResolved(olderThanMs: number, now = Date.now()): Promise<number> {
    const threshold = now - olderThanMs;
    const resolved = await this.listResolved();
    let pruned = 0;

    for (const record of resolved) {
      const resolvedAt = record.resolved_at ?? record.created_at;
      if (resolvedAt >= threshold) {
        continue;
      }

      await this.removeResolved(record.approval_id);
      pruned += 1;
    }

    return pruned;
  }

  private async database(): Promise<ControlDatabase> {
    this.dbPromise ??= openRuntimeControlDatabase(this.paths, this.dbOptions);
    return this.dbPromise;
  }
}

interface ApprovalRow {
  record_json: string;
}

function parseApprovalJson(recordJson: string): ApprovalRecord {
  return ApprovalRecordSchema.parse(JSON.parse(recordJson) as unknown);
}

function readApproval(sqlite: SqliteDatabase, approvalId: string): ApprovalRecord | null {
  const row = sqlite.prepare(`
    SELECT record_json
    FROM approval_records
    WHERE approval_id = ?
  `).get(approvalId) as ApprovalRow | undefined;
  return row ? parseApprovalJson(row.record_json) : null;
}

function listApprovals(sqlite: SqliteDatabase, whereSql: string): ApprovalRecord[] {
  const rows = sqlite.prepare(`
    SELECT record_json
    FROM approval_records
    WHERE ${whereSql}
    ORDER BY created_at ASC, approval_id ASC
  `).all() as ApprovalRow[];
  return rows.map((row) => parseApprovalJson(row.record_json));
}

function upsertApproval(sqlite: SqliteDatabase, record: ApprovalRecord): void {
  sqlite.prepare(`
    INSERT INTO approval_records (
      approval_id,
      state,
      created_at,
      resolved_at,
      expires_at,
      record_json
    )
    VALUES (?, ?, ?, ?, ?, json(?))
    ON CONFLICT(approval_id) DO UPDATE SET
      state = excluded.state,
      created_at = excluded.created_at,
      resolved_at = excluded.resolved_at,
      expires_at = excluded.expires_at,
      record_json = excluded.record_json
  `).run(
    record.approval_id,
    record.state,
    record.created_at,
    record.resolved_at ?? null,
    record.expires_at,
    JSON.stringify(record),
  );
}
