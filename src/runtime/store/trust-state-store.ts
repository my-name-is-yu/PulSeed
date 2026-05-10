import * as fs from "node:fs";
import {
  TrustBalanceSchema,
  TrustOverrideLogEntrySchema,
  TrustStoreSchema,
  type TrustBalance,
  type TrustOverrideLogEntry,
  type TrustStore,
} from "../../base/types/trust.js";
import {
  openControlDatabase,
  resolveControlDbPath,
  type ControlDatabase,
  type RuntimeControlDbStoreOptions,
  type SqliteDatabase,
} from "./control-db/index.js";

export interface TrustStateStoreOptions extends RuntimeControlDbStoreOptions {}

export interface TrustStateStorePort {
  loadStore(): Promise<TrustStore>;
  saveStore(store: TrustStore): Promise<void>;
}

interface TrustBalanceRow {
  balance_json: string;
}

interface TrustGateRow {
  domain: string;
  category: string;
}

interface TrustOverrideLogRow {
  entry_json: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function emptyTrustStore(): TrustStore {
  return TrustStoreSchema.parse({
    balances: {},
    permanent_gates: {},
    override_log: [],
  });
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}

export class TrustStateStore implements TrustStateStorePort {
  private dbPromise: Promise<ControlDatabase> | null = null;

  constructor(
    private readonly baseDir: string,
    private readonly options: TrustStateStoreOptions = {},
  ) {}

  async loadStore(): Promise<TrustStore> {
    if (!this.options.controlDb && !fs.existsSync(resolveControlDbPath({
      baseDir: this.options.controlBaseDir ?? this.baseDir,
      dbPath: this.options.controlDbPath,
    }))) {
      return emptyTrustStore();
    }
    const db = await this.database();
    return db.read((sqlite) => readTrustStore(sqlite));
  }

  async saveStore(store: TrustStore): Promise<void> {
    const parsed = TrustStoreSchema.parse(store);
    const db = await this.database();
    db.transaction((sqlite) => replaceTrustStore(sqlite, parsed));
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

function readTrustStore(sqlite: SqliteDatabase): TrustStore {
  const balanceRows = sqlite.prepare(`
    SELECT balance_json
    FROM trust_balances
    ORDER BY domain ASC
  `).all() as TrustBalanceRow[];
  const gateRows = sqlite.prepare(`
    SELECT domain, category
    FROM trust_permanent_gates
    ORDER BY domain ASC, sort_order ASC, category ASC
  `).all() as TrustGateRow[];
  const logRows = sqlite.prepare(`
    SELECT entry_json
    FROM trust_override_log
    ORDER BY sort_order ASC, event_timestamp ASC, log_sequence ASC
  `).all() as TrustOverrideLogRow[];

  const balances: Record<string, TrustBalance> = {};
  for (const row of balanceRows) {
    const balance = TrustBalanceSchema.parse(parseJson<unknown>(row.balance_json));
    balances[balance.domain] = balance;
  }

  const permanentGates: Record<string, string[]> = {};
  for (const row of gateRows) {
    permanentGates[row.domain] ??= [];
    permanentGates[row.domain]!.push(row.category);
  }

  const overrideLog = logRows.map((row) =>
    TrustOverrideLogEntrySchema.parse(parseJson<TrustOverrideLogEntry>(row.entry_json))
  );

  return TrustStoreSchema.parse({
    balances,
    permanent_gates: permanentGates,
    override_log: overrideLog,
  });
}

function replaceTrustStore(sqlite: SqliteDatabase, store: TrustStore): void {
  const updatedAt = nowIso();
  sqlite.prepare("DELETE FROM trust_balances").run();
  sqlite.prepare("DELETE FROM trust_permanent_gates").run();
  sqlite.prepare("DELETE FROM trust_override_log").run();

  sqlite.prepare(`
    INSERT INTO trust_state_metadata (state_id, updated_at, state_json)
    VALUES ('current', ?, json(?))
    ON CONFLICT(state_id) DO UPDATE SET
      updated_at = excluded.updated_at,
      state_json = excluded.state_json
  `).run(updatedAt, stringifyJson(store));

  const insertBalance = sqlite.prepare(`
    INSERT INTO trust_balances (
      domain, balance, success_delta, failure_delta, updated_at, balance_json
    ) VALUES (?, ?, ?, ?, ?, json(?))
  `);
  for (const balance of Object.values(store.balances)) {
    insertBalance.run(
      balance.domain,
      balance.balance,
      balance.success_delta,
      balance.failure_delta,
      updatedAt,
      stringifyJson(balance),
    );
  }

  const insertGate = sqlite.prepare(`
    INSERT INTO trust_permanent_gates (domain, category, sort_order, updated_at)
    VALUES (?, ?, ?, ?)
  `);
  for (const [domain, categories] of Object.entries(store.permanent_gates)) {
    categories.forEach((category, index) => {
      insertGate.run(domain, category, index, updatedAt);
    });
  }

  const insertLog = sqlite.prepare(`
    INSERT INTO trust_override_log (
      event_timestamp,
      override_type,
      domain,
      target_category,
      balance_before,
      balance_after,
      sort_order,
      entry_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, json(?))
  `);
  store.override_log.forEach((entry, index) => {
    insertLog.run(
      entry.timestamp,
      entry.override_type,
      entry.domain,
      entry.target_category,
      entry.balance_before,
      entry.balance_after,
      index,
      stringifyJson(entry),
    );
  });
}
