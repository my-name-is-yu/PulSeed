import { randomUUID } from "node:crypto";
import { parsePersistedScheduleEntries } from "./entry-normalization.js";
import type { ScheduleEntry } from "../types/schedule.js";
import {
  openControlDatabase,
  type ControlDatabase,
  type RuntimeControlDbStoreOptions,
  type SqliteDatabase,
} from "../store/control-db/index.js";

const SCHEDULE_LOCK_ID = "schedule_entries";
const SCHEDULE_LOCK_TIMEOUT_MS = 5000;
const SCHEDULE_LOCK_LEASE_MS = 30_000;
const SCHEDULE_LOCK_RETRY_MS = 25;

export interface ScheduleEntryStoreLogger {
  warn: (message: string, context?: Record<string, unknown>) => void;
}

export class ScheduleEntryStore {
  private readonly dbOptions: RuntimeControlDbStoreOptions;
  private dbPromise: Promise<ControlDatabase> | null = null;
  private lockDepth = 0;

  constructor(
    private readonly baseDir: string,
    private readonly logger: ScheduleEntryStoreLogger,
    private readonly onPersist?: (entries: ScheduleEntry[]) => Promise<void>,
    options: RuntimeControlDbStoreOptions = {}
  ) {
    this.dbOptions = options;
  }

  async readEntries(): Promise<ScheduleEntry[]> {
    const db = await this.database();
    const raw = db.read((sqlite) => readScheduleEntryJson(sqlite));
    const { entries, invalidCount, validList } = parsePersistedScheduleEntries(raw);
    if (!validList) return [];

    if (invalidCount > 0) {
      this.logger.warn("Skipped invalid schedule entries while loading schedule_entries", {
        invalid_count: invalidCount,
      });
    }
    return entries;
  }

  async saveEntries(entries: ScheduleEntry[]): Promise<void> {
    await this.withLock(async () => {
      const db = await this.database();
      db.transaction((sqlite) => writeScheduleEntries(sqlite, entries));
      await this.onPersist?.(entries);
    });
  }

  async withLock<T>(work: () => Promise<T>): Promise<T> {
    if (this.lockDepth > 0) {
      return work();
    }

    const release = await this.acquireScheduleStoreLock();
    this.lockDepth++;
    try {
      return await work();
    } finally {
      this.lockDepth--;
      release();
    }
  }

  private async acquireScheduleStoreLock(): Promise<() => void> {
    const db = await this.database();
    const ownerToken = randomUUID();
    const startedAt = Date.now();

    while (true) {
      const acquired = db.transaction((sqlite) => {
        const now = Date.now();
        sqlite.prepare(`
          DELETE FROM schedule_store_locks
          WHERE lock_id = ? AND lease_until <= ?
        `).run(SCHEDULE_LOCK_ID, now);
        const result = sqlite.prepare(`
          INSERT OR IGNORE INTO schedule_store_locks (
            lock_id,
            owner_token,
            owner_pid,
            acquired_at,
            lease_until
          )
          VALUES (?, ?, ?, ?, ?)
        `).run(SCHEDULE_LOCK_ID, ownerToken, process.pid, now, now + SCHEDULE_LOCK_LEASE_MS);
        return result.changes === 1;
      });
      if (acquired) {
        return () => {
          db.transaction((sqlite) => {
            sqlite.prepare(`
              DELETE FROM schedule_store_locks
              WHERE lock_id = ? AND owner_token = ?
            `).run(SCHEDULE_LOCK_ID, ownerToken);
          });
        };
      }
      if (Date.now() - startedAt >= SCHEDULE_LOCK_TIMEOUT_MS) {
        throw new Error("Timed out waiting for schedule store lock in control DB");
      }
      await new Promise((resolve) => setTimeout(resolve, SCHEDULE_LOCK_RETRY_MS));
    }
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

interface ScheduleEntryRow {
  entry_json: string;
}

function readScheduleEntryJson(sqlite: SqliteDatabase): unknown[] {
  const rows = sqlite.prepare(`
    SELECT entry_json
    FROM schedule_entries
    ORDER BY sort_order ASC, entry_id ASC
  `).all() as ScheduleEntryRow[];
  return rows.map((row) => JSON.parse(row.entry_json) as unknown);
}

function writeScheduleEntries(sqlite: SqliteDatabase, entries: readonly ScheduleEntry[]): void {
  sqlite.prepare("DELETE FROM schedule_entries").run();
  const insert = sqlite.prepare(`
    INSERT INTO schedule_entries (
      entry_id,
      name,
      layer,
      enabled,
      next_fire_at,
      updated_at,
      internal,
      activation_kind,
      goal_id,
      wait_strategy_id,
      sort_order,
      entry_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, json(?))
  `);
  entries.forEach((entry, index) => {
    insert.run(
      entry.id,
      entry.name,
      entry.layer,
      entry.enabled ? 1 : 0,
      entry.next_fire_at,
      entry.updated_at,
      entry.metadata?.internal === true ? 1 : 0,
      entry.metadata?.activation_kind ?? null,
      entry.metadata?.goal_id ?? entry.goal_trigger?.goal_id ?? null,
      entry.metadata?.wait_strategy_id ?? null,
      index,
      JSON.stringify(entry),
    );
  });
}
