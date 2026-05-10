import * as fs from "node:fs";
import {
  EthicsLogSchema,
  type EthicsLog,
} from "../../base/types/ethics.js";
import {
  openControlDatabase,
  resolveControlDbPath,
  type ControlDatabase,
  type RuntimeControlDbStoreOptions,
  type SqliteDatabase,
} from "./control-db/index.js";

export interface EthicsLogStoreOptions extends RuntimeControlDbStoreOptions {}

export interface EthicsLogStorePort {
  appendLog(entry: EthicsLog): Promise<void>;
  loadLogs(): Promise<EthicsLog[]>;
  replaceLogs(logs: EthicsLog[]): Promise<void>;
}

interface EthicsLogRow {
  entry_json: string;
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}

export class EthicsLogStore implements EthicsLogStorePort {
  private dbPromise: Promise<ControlDatabase> | null = null;

  constructor(
    private readonly baseDir: string,
    private readonly options: EthicsLogStoreOptions = {},
  ) {}

  async appendLog(entry: EthicsLog): Promise<void> {
    const parsed = EthicsLogSchema.parse(entry);
    const db = await this.database();
    db.transaction((sqlite) => {
      const nextOrder = ((sqlite.prepare(`
        SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order
        FROM ethics_log_entries
      `).get() as { next_order: number }).next_order);
      insertEthicsLog(sqlite, parsed, nextOrder);
    });
  }

  async loadLogs(): Promise<EthicsLog[]> {
    if (!this.options.controlDb && !fs.existsSync(resolveControlDbPath({
      baseDir: this.options.controlBaseDir ?? this.baseDir,
      dbPath: this.options.controlDbPath,
    }))) {
      return [];
    }
    const db = await this.database();
    return db.read((sqlite) => readEthicsLogs(sqlite));
  }

  async replaceLogs(logs: EthicsLog[]): Promise<void> {
    const parsed = logs.map((entry) => EthicsLogSchema.parse(entry));
    const db = await this.database();
    db.transaction((sqlite) => {
      sqlite.prepare("DELETE FROM ethics_log_entries").run();
      parsed.forEach((entry, index) => insertEthicsLog(sqlite, entry, index));
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

function readEthicsLogs(sqlite: SqliteDatabase): EthicsLog[] {
  const rows = sqlite.prepare(`
    SELECT entry_json
    FROM ethics_log_entries
    ORDER BY sort_order ASC, event_timestamp ASC, log_id ASC
  `).all() as EthicsLogRow[];
  return rows.map((row) => EthicsLogSchema.parse(parseJson<unknown>(row.entry_json)));
}

function insertEthicsLog(sqlite: SqliteDatabase, entry: EthicsLog, sortOrder: number): void {
  sqlite.prepare(`
    INSERT INTO ethics_log_entries (
      log_id,
      event_timestamp,
      subject_type,
      subject_id,
      verdict,
      category,
      layer1_triggered,
      sort_order,
      entry_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, json(?))
    ON CONFLICT(log_id) DO UPDATE SET
      event_timestamp = excluded.event_timestamp,
      subject_type = excluded.subject_type,
      subject_id = excluded.subject_id,
      verdict = excluded.verdict,
      category = excluded.category,
      layer1_triggered = excluded.layer1_triggered,
      sort_order = excluded.sort_order,
      entry_json = excluded.entry_json
  `).run(
    entry.log_id,
    entry.timestamp,
    entry.subject_type,
    entry.subject_id,
    entry.verdict.verdict,
    entry.verdict.category,
    entry.layer1_triggered ? 1 : 0,
    sortOrder,
    stringifyJson(entry),
  );
}
