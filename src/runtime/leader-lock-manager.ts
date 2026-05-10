import { randomUUID } from "node:crypto";
import { z } from "zod";
import { isProcessPidValue, signalProcessPid } from "../base/utils/process-pid.js";
import { createRuntimeStorePaths, type RuntimeStorePaths } from "./store/runtime-paths.js";
import {
  openRuntimeControlDatabase,
  type ControlDatabase,
  type RuntimeControlDbStoreOptions,
  type SqliteDatabase,
} from "./store/control-db/index.js";

export interface LeaderLockRecord {
  owner_token: string;
  pid: number;
  acquired_at: number;
  last_renewed_at: number;
  lease_until: number;
}

export interface LeaderLockAcquireOptions {
  ownerToken?: string;
  leaseMs?: number;
  now?: number;
}

export interface LeaderLockRenewOptions {
  leaseMs?: number;
  now?: number;
}

const DEFAULT_LEASE_MS = 30_000;
const LeaderLockPidSchema = z.number().int().positive().safe();
const LeaderLockSafeNonnegativeIntSchema = z.number().int().nonnegative().safe();
const LeaderLockSafePositiveIntSchema = z.number().int().positive().safe();
const LEADER_LOCK_ID = "runtime_leader";

export const LeaderLockRecordSchema = z.object({
  owner_token: z.string(),
  pid: LeaderLockPidSchema,
  acquired_at: LeaderLockSafeNonnegativeIntSchema,
  last_renewed_at: LeaderLockSafeNonnegativeIntSchema,
  lease_until: LeaderLockSafeNonnegativeIntSchema,
});

function isProcessAlive(pid: number): boolean {
  return signalProcessPid(pid, 0).status === "sent";
}

function parseLeaderLockRecord(value: unknown): LeaderLockRecord | null {
  const parsed = LeaderLockRecordSchema.safeParse(value);
  return parsed.success && isProcessPidValue(parsed.data.pid) ? parsed.data : null;
}

function parseLeaseNow(value: number): number {
  return LeaderLockSafeNonnegativeIntSchema.parse(value);
}

function parseLeaseMs(value: number): number {
  return LeaderLockSafePositiveIntSchema.parse(value);
}

function computeLeaseUntil(now: number, leaseMs: number): number {
  return LeaderLockSafeNonnegativeIntSchema.parse(now + leaseMs);
}

export class LeaderLockManager {
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
    this.defaultLeaseMs = parseLeaseMs(defaultLeaseMs);
  }

  private buildRecord(ownerToken: string, leaseMs: number, now: number): LeaderLockRecord {
    return {
      owner_token: ownerToken,
      pid: process.pid,
      acquired_at: now,
      last_renewed_at: now,
      lease_until: computeLeaseUntil(now, leaseMs),
    };
  }

  async acquire(opts: LeaderLockAcquireOptions = {}): Promise<LeaderLockRecord | null> {
    const now = parseLeaseNow(opts.now ?? Date.now());
    const leaseMs = parseLeaseMs(opts.leaseMs ?? this.defaultLeaseMs);
    const ownerToken = opts.ownerToken ?? randomUUID();
    const db = await this.database();
    return db.transaction((sqlite) => {
      const current = readLeaderLock(sqlite);
      const currentOwnerAlive = current ? isProcessAlive(current.pid) : false;
      if (current && current.lease_until > now && currentOwnerAlive) {
        return null;
      }

      const record = this.buildRecord(ownerToken, leaseMs, now);
      upsertLeaderLock(sqlite, record);
      return record;
    });
  }

  async renew(ownerToken: string, opts: LeaderLockRenewOptions = {}): Promise<LeaderLockRecord | null> {
    const now = parseLeaseNow(opts.now ?? Date.now());
    const leaseMs = parseLeaseMs(opts.leaseMs ?? this.defaultLeaseMs);
    const db = await this.database();
    return db.transaction((sqlite) => {
      const current = readLeaderLock(sqlite);
      if (!current || current.owner_token !== ownerToken || current.lease_until <= now) {
        return null;
      }

      const renewed: LeaderLockRecord = {
        ...current,
        last_renewed_at: now,
        lease_until: computeLeaseUntil(now, leaseMs),
      };
      upsertLeaderLock(sqlite, renewed);
      return renewed;
    });
  }

  async release(ownerToken: string): Promise<boolean> {
    const db = await this.database();
    return db.transaction((sqlite) => {
      const current = readLeaderLock(sqlite);
      if (!current || current.owner_token !== ownerToken) {
        return false;
      }

      sqlite.prepare("DELETE FROM leader_locks WHERE lock_id = ?").run(LEADER_LOCK_ID);
      return true;
    });
  }

  async read(): Promise<LeaderLockRecord | null> {
    const db = await this.database();
    return db.read((sqlite) => readLeaderLock(sqlite));
  }

  async reapStale(now = Date.now()): Promise<LeaderLockRecord | null> {
    const db = await this.database();
    return db.transaction((sqlite) => {
      const current = readLeaderLock(sqlite);
      if (!current || current.lease_until > now) {
        return null;
      }

      sqlite.prepare("DELETE FROM leader_locks WHERE lock_id = ?").run(LEADER_LOCK_ID);
      return current;
    });
  }

  async importLegacyRecord(record: LeaderLockRecord): Promise<LeaderLockRecord> {
    const parsed = LeaderLockRecordSchema.parse(record);
    const db = await this.database();
    db.transaction((sqlite) => {
      upsertLeaderLock(sqlite, parsed);
    });
    return parsed;
  }

  private async database(): Promise<ControlDatabase> {
    this.dbPromise ??= openRuntimeControlDatabase(this.paths, this.dbOptions);
    return this.dbPromise;
  }
}

interface LeaderLockRow {
  record_json: string;
}

function parseLeaderLockJson(recordJson: string): LeaderLockRecord | null {
  return parseLeaderLockRecord(JSON.parse(recordJson) as unknown);
}

function readLeaderLock(sqlite: SqliteDatabase): LeaderLockRecord | null {
  const row = sqlite.prepare(`
    SELECT record_json
    FROM leader_locks
    WHERE lock_id = ?
  `).get(LEADER_LOCK_ID) as LeaderLockRow | undefined;
  return row ? parseLeaderLockJson(row.record_json) : null;
}

function upsertLeaderLock(sqlite: SqliteDatabase, record: LeaderLockRecord): void {
  sqlite.prepare(`
    INSERT INTO leader_locks (
      lock_id,
      owner_token,
      pid,
      acquired_at,
      last_renewed_at,
      lease_until,
      record_json
    )
    VALUES (?, ?, ?, ?, ?, ?, json(?))
    ON CONFLICT(lock_id) DO UPDATE SET
      owner_token = excluded.owner_token,
      pid = excluded.pid,
      acquired_at = excluded.acquired_at,
      last_renewed_at = excluded.last_renewed_at,
      lease_until = excluded.lease_until,
      record_json = excluded.record_json
  `).run(
    LEADER_LOCK_ID,
    record.owner_token,
    record.pid,
    record.acquired_at,
    record.last_renewed_at,
    record.lease_until,
    JSON.stringify(record),
  );
}
