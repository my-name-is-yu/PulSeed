import { randomUUID } from "node:crypto";
import { createRuntimeStorePaths, type RuntimeStorePaths } from "./store/runtime-paths.js";
import { GoalLeaseRecordSchema } from "./store/runtime-schemas.js";
import type { GoalLeaseRecord as RuntimeGoalLeaseRecord } from "./store/runtime-schemas.js";
import {
  openRuntimeControlDatabase,
  type ControlDatabase,
  type RuntimeControlDbStoreOptions,
  type SqliteDatabase,
} from "./store/control-db/index.js";

export type GoalLeaseRecord = RuntimeGoalLeaseRecord;

export interface GoalLeaseAcquireOptions {
  workerId: string;
  ownerToken?: string;
  attemptId?: string;
  leaseMs?: number;
  now?: number;
}

export interface GoalLeaseRenewOptions {
  leaseMs?: number;
  now?: number;
}

const DEFAULT_LEASE_MS = 30_000;

export class GoalLeaseManager {
  private readonly paths: RuntimeStorePaths;
  private readonly dbOptions: RuntimeControlDbStoreOptions;
  private dbPromise: Promise<ControlDatabase> | null = null;
  private readonly defaultLeaseMs: number;

  constructor(
    runtimeRoot: string,
    defaultLeaseMs = DEFAULT_LEASE_MS,
    options: RuntimeControlDbStoreOptions = {}
  ) {
    this.paths = createRuntimeStorePaths(runtimeRoot);
    this.dbOptions = options;
    this.defaultLeaseMs = defaultLeaseMs;
  }

	private buildRecord(goalId: string, opts: GoalLeaseAcquireOptions, now: number): GoalLeaseRecord {
		const leaseMs = opts.leaseMs ?? this.defaultLeaseMs;
		return GoalLeaseRecordSchema.parse({
			goal_id: goalId,
			owner_token: opts.ownerToken ?? randomUUID(),
			attempt_id: opts.attemptId ?? randomUUID(),
			worker_id: opts.workerId,
			lease_until: now + leaseMs,
			acquired_at: now,
			last_renewed_at: now,
		});
	}

  async acquire(goalId: string, opts: GoalLeaseAcquireOptions): Promise<GoalLeaseRecord | null> {
    const now = opts.now ?? Date.now();
    const db = await this.database();
    return db.transaction((sqlite) => {
      const current = readGoalLease(sqlite, goalId);
      if (current && current.lease_until > now) {
        return null;
      }

      const record = this.buildRecord(goalId, opts, now);
      upsertGoalLease(sqlite, record);
      return record;
    });
  }

  async renew(
    goalId: string,
    ownerToken: string,
    opts: GoalLeaseRenewOptions = {}
  ): Promise<GoalLeaseRecord | null> {
    const now = opts.now ?? Date.now();
    const leaseMs = opts.leaseMs ?? this.defaultLeaseMs;
    const db = await this.database();
    return db.transaction((sqlite) => {
      const current = readGoalLease(sqlite, goalId);
      if (!current || current.owner_token !== ownerToken || current.lease_until <= now) {
        return null;
      }

			const renewed = GoalLeaseRecordSchema.parse({
				...current,
				lease_until: now + leaseMs,
				last_renewed_at: now,
			});
			upsertGoalLease(sqlite, renewed);
			return renewed;
		});
  }

  async release(goalId: string, ownerToken: string): Promise<boolean> {
    const db = await this.database();
    return db.transaction((sqlite) => {
      const current = readGoalLease(sqlite, goalId);
      if (!current || current.owner_token !== ownerToken) {
        return false;
      }

      sqlite.prepare("DELETE FROM goal_leases WHERE goal_id = ?").run(goalId);
      return true;
    });
  }

  async read(goalId: string): Promise<GoalLeaseRecord | null> {
    const db = await this.database();
    return db.read((sqlite) => readGoalLease(sqlite, goalId));
  }

  async reapStale(now = Date.now()): Promise<GoalLeaseRecord[]> {
    const db = await this.database();
    return db.transaction((sqlite) => {
      const rows = sqlite.prepare(`
        SELECT record_json
        FROM goal_leases
        WHERE lease_until <= ?
        ORDER BY lease_until ASC, goal_id ASC
      `).all(now) as GoalLeaseRow[];
      const removed = rows.map((row) => parseGoalLeaseJson(row.record_json));
      sqlite.prepare("DELETE FROM goal_leases WHERE lease_until <= ?").run(now);
      return removed;
    });
  }

  async importLegacyRecord(record: GoalLeaseRecord): Promise<GoalLeaseRecord> {
    const parsed = GoalLeaseRecordSchema.parse(record);
    const db = await this.database();
    db.transaction((sqlite) => {
      upsertGoalLease(sqlite, parsed);
    });
    return parsed;
  }

  private async database(): Promise<ControlDatabase> {
    this.dbPromise ??= openRuntimeControlDatabase(this.paths, this.dbOptions);
    return this.dbPromise;
  }
}

interface GoalLeaseRow {
  record_json: string;
}

function parseGoalLeaseJson(recordJson: string): GoalLeaseRecord {
  return GoalLeaseRecordSchema.parse(JSON.parse(recordJson) as unknown);
}

function readGoalLease(sqlite: SqliteDatabase, goalId: string): GoalLeaseRecord | null {
  const row = sqlite.prepare(`
    SELECT record_json
    FROM goal_leases
    WHERE goal_id = ?
  `).get(goalId) as GoalLeaseRow | undefined;
  return row ? parseGoalLeaseJson(row.record_json) : null;
}

function upsertGoalLease(sqlite: SqliteDatabase, record: GoalLeaseRecord): void {
  sqlite.prepare(`
    INSERT INTO goal_leases (
      goal_id,
      owner_token,
      worker_id,
      attempt_id,
      acquired_at,
      last_renewed_at,
      lease_until,
      record_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, json(?))
    ON CONFLICT(goal_id) DO UPDATE SET
      owner_token = excluded.owner_token,
      worker_id = excluded.worker_id,
      attempt_id = excluded.attempt_id,
      acquired_at = excluded.acquired_at,
      last_renewed_at = excluded.last_renewed_at,
      lease_until = excluded.lease_until,
      record_json = excluded.record_json
  `).run(
    record.goal_id,
    record.owner_token,
    record.worker_id,
    record.attempt_id,
    record.acquired_at,
    record.last_renewed_at,
    record.lease_until,
    JSON.stringify(record),
  );
}
