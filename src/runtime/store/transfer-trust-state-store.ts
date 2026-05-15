import { z } from "zod/v3";
import {
  openControlDatabase,
  type ControlDatabase,
  type RuntimeControlDbStoreOptions,
} from "./control-db/index.js";
import {
  TransferEffectivenessEnum,
  TransferTrustScoreSchema,
  type TransferEffectiveness,
  type TransferTrustScore,
} from "../../base/types/cross-portfolio.js";

export interface TransferTrustStateStoreOptions extends RuntimeControlDbStoreOptions {}

export const TRANSFER_TRUST_SCORE_PREFIX = "transfer-trust";
export const TRANSFER_TRUST_HISTORY_PREFIX = "transfer-trust-history";
export const TRANSFER_TRUST_INDEX_PATH = "transfer-trust/_index.json";

export type TransferTrustRawKind = "score" | "history" | "index";

export interface TransferTrustRawPathMatch {
  kind: TransferTrustRawKind;
  key?: string;
}

export interface TransferTrustRawStateStoreResult {
  handled: boolean;
  value: unknown | null;
}

const TransferTrustHistorySchema = z.array(TransferEffectivenessEnum);
type TransferTrustHistory = z.infer<typeof TransferTrustHistorySchema>;

export interface TransferTrustStateStorePort {
  ensureReady(): Promise<void>;
  loadScore(domainPair: string): Promise<TransferTrustScore | null>;
  saveScore(score: TransferTrustScore): Promise<void>;
  hasScore(domainPair: string): Promise<boolean>;
  hasScoreKey(domainPairKey: string): Promise<boolean>;
  loadHistory(domainPair: string): Promise<TransferEffectiveness[]>;
  saveHistory(domainPair: string, history: TransferEffectiveness[]): Promise<void>;
  hasHistory(domainPair: string): Promise<boolean>;
  hasHistoryKey(domainPairKey: string): Promise<boolean>;
  listScores(): Promise<TransferTrustScore[]>;
  listIndexDomainPairs(): Promise<string[]>;
  saveIndexDomainPairs(domainPairs: string[]): Promise<void>;
  domainPairForKey(domainPairKey: string): Promise<string | null>;
  readRawPath(relativePath: string): Promise<TransferTrustRawStateStoreResult>;
  writeRawPath(relativePath: string, data: unknown): Promise<boolean>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function stringifyJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("Transfer trust state must be JSON serializable.");
  }
  return serialized;
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/").split("/").filter(Boolean).join("/");
}

export function transferTrustDomainPairKey(domainPair: string): string {
  return domainPair.replace(/[^a-zA-Z0-9_:.-]/g, "_");
}

export function parseTransferTrustRawPath(relativePath: string): TransferTrustRawPathMatch | null {
  const normalized = normalizeRelativePath(relativePath);
  if (normalized === TRANSFER_TRUST_INDEX_PATH) {
    return { kind: "index" };
  }
  if (normalized.startsWith(`${TRANSFER_TRUST_SCORE_PREFIX}/`) && normalized.endsWith(".json")) {
    const key = normalized.slice(TRANSFER_TRUST_SCORE_PREFIX.length + 1, -".json".length);
    if (key.length > 0 && key !== "_index") {
      return { kind: "score", key };
    }
  }
  if (normalized.startsWith(`${TRANSFER_TRUST_HISTORY_PREFIX}/`) && normalized.endsWith(".json")) {
    const key = normalized.slice(TRANSFER_TRUST_HISTORY_PREFIX.length + 1, -".json".length);
    if (key.length > 0) {
      return { kind: "history", key };
    }
  }
  return null;
}

export class TransferTrustStateStore implements TransferTrustStateStorePort {
  private dbPromise: Promise<ControlDatabase> | null = null;

  constructor(
    private readonly baseDir: string,
    private readonly options: TransferTrustStateStoreOptions = {},
  ) {}

  async ensureReady(): Promise<void> {
    await this.database();
  }

  async loadScore(domainPair: string): Promise<TransferTrustScore | null> {
    return this.loadScoreByKey(transferTrustDomainPairKey(domainPair));
  }

  async saveScore(score: TransferTrustScore): Promise<void> {
    const parsed = TransferTrustScoreSchema.parse(score);
    const domainPairKey = transferTrustDomainPairKey(parsed.domain_pair);
    const updatedAt = nowIso();
    const serialized = stringifyJson(parsed);
    const db = await this.database();
    db.transaction((sqlite) => {
      sqlite.prepare(`
        INSERT INTO transfer_trust_scores (
          domain_pair_key,
          domain_pair,
          updated_at,
          score_json
        ) VALUES (?, ?, ?, json(?))
        ON CONFLICT(domain_pair_key) DO UPDATE SET
          domain_pair = excluded.domain_pair,
          updated_at = excluded.updated_at,
          score_json = excluded.score_json
      `).run(domainPairKey, parsed.domain_pair, updatedAt, serialized);
      upsertIndexEntry(sqlite, domainPairKey, parsed.domain_pair, updatedAt);
    });
  }

  async hasScore(domainPair: string): Promise<boolean> {
    return this.hasScoreKey(transferTrustDomainPairKey(domainPair));
  }

  async hasScoreKey(domainPairKey: string): Promise<boolean> {
    const db = await this.database();
    return db.read((sqlite) => {
      const row = sqlite.prepare(`
        SELECT 1
        FROM transfer_trust_scores
        WHERE domain_pair_key = ?
      `).get(domainPairKey) as unknown | undefined;
      return row !== undefined;
    });
  }

  async loadHistory(domainPair: string): Promise<TransferEffectiveness[]> {
    return (await this.loadHistoryByKey(transferTrustDomainPairKey(domainPair))) ?? [];
  }

  async saveHistory(domainPair: string, history: TransferEffectiveness[]): Promise<void> {
    const parsed = TransferTrustHistorySchema.parse(history);
    const domainPairKey = transferTrustDomainPairKey(domainPair);
    const updatedAt = nowIso();
    const serialized = stringifyJson(parsed);
    const db = await this.database();
    db.transaction((sqlite) => {
      sqlite.prepare(`
        INSERT INTO transfer_trust_history (
          domain_pair_key,
          domain_pair,
          updated_at,
          history_json
        ) VALUES (?, ?, ?, json(?))
        ON CONFLICT(domain_pair_key) DO UPDATE SET
          domain_pair = excluded.domain_pair,
          updated_at = excluded.updated_at,
          history_json = excluded.history_json
      `).run(domainPairKey, domainPair, updatedAt, serialized);
      upsertIndexEntry(sqlite, domainPairKey, domainPair, updatedAt);
    });
  }

  async hasHistory(domainPair: string): Promise<boolean> {
    return this.hasHistoryKey(transferTrustDomainPairKey(domainPair));
  }

  async hasHistoryKey(domainPairKey: string): Promise<boolean> {
    const db = await this.database();
    return db.read((sqlite) => {
      const row = sqlite.prepare(`
        SELECT 1
        FROM transfer_trust_history
        WHERE domain_pair_key = ?
      `).get(domainPairKey) as unknown | undefined;
      return row !== undefined;
    });
  }

  async listScores(): Promise<TransferTrustScore[]> {
    const db = await this.database();
    return db.read((sqlite) => {
      const rows = sqlite.prepare(`
        SELECT score_json
        FROM transfer_trust_scores
        ORDER BY domain_pair ASC
      `).all() as Array<{ score_json: string }>;
      return rows.map((row) => TransferTrustScoreSchema.parse(parseJson<unknown>(row.score_json)));
    });
  }

  async listIndexDomainPairs(): Promise<string[]> {
    const db = await this.database();
    return db.read((sqlite) => {
      const rows = sqlite.prepare(`
        SELECT domain_pair
        FROM transfer_trust_index_entries
        ORDER BY sort_order ASC, domain_pair ASC
      `).all() as Array<{ domain_pair: string }>;
      return rows.map((row) => row.domain_pair);
    });
  }

  async saveIndexDomainPairs(domainPairs: string[]): Promise<void> {
    const parsed = z.array(z.string()).parse(domainPairs);
    const updatedAt = nowIso();
    const db = await this.database();
    db.transaction((sqlite) => {
      sqlite.prepare("DELETE FROM transfer_trust_index_entries").run();
      const insert = sqlite.prepare(`
        INSERT INTO transfer_trust_index_entries (
          domain_pair_key,
          domain_pair,
          sort_order,
          updated_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(domain_pair_key) DO UPDATE SET
          domain_pair = excluded.domain_pair,
          sort_order = excluded.sort_order,
          updated_at = excluded.updated_at
      `);
      parsed.forEach((domainPair, index) => {
        insert.run(transferTrustDomainPairKey(domainPair), domainPair, index, updatedAt);
      });
    });
  }

  async domainPairForKey(domainPairKey: string): Promise<string | null> {
    const db = await this.database();
    return db.read((sqlite) => {
      const scoreRow = sqlite.prepare(`
        SELECT domain_pair
        FROM transfer_trust_scores
        WHERE domain_pair_key = ?
      `).get(domainPairKey) as { domain_pair: string } | undefined;
      if (scoreRow) return scoreRow.domain_pair;
      const historyRow = sqlite.prepare(`
        SELECT domain_pair
        FROM transfer_trust_history
        WHERE domain_pair_key = ?
      `).get(domainPairKey) as { domain_pair: string } | undefined;
      if (historyRow) return historyRow.domain_pair;
      const indexRow = sqlite.prepare(`
        SELECT domain_pair
        FROM transfer_trust_index_entries
        WHERE domain_pair_key = ?
      `).get(domainPairKey) as { domain_pair: string } | undefined;
      return indexRow?.domain_pair ?? null;
    });
  }

  async readRawPath(relativePath: string): Promise<TransferTrustRawStateStoreResult> {
    const match = parseTransferTrustRawPath(relativePath);
    if (!match) return { handled: false, value: null };
    if (match.kind === "index") {
      return { handled: true, value: await this.listIndexDomainPairs() };
    }
    if (match.kind === "score") {
      return { handled: true, value: await this.loadScoreByKey(match.key!) };
    }
    return { handled: true, value: await this.loadHistoryByKey(match.key!) };
  }

  async writeRawPath(relativePath: string, data: unknown): Promise<boolean> {
    const match = parseTransferTrustRawPath(relativePath);
    if (!match) return false;
    if (match.kind === "index") {
      if (data === null) {
        await this.saveIndexDomainPairs([]);
      } else {
        await this.saveIndexDomainPairs(z.array(z.string()).parse(data));
      }
      return true;
    }
    if (match.kind === "score") {
      if (data === null) {
        await this.deleteScoreByKey(match.key!);
      } else {
        await this.saveScore(TransferTrustScoreSchema.parse(data));
      }
      return true;
    }
    if (data === null) {
      await this.deleteHistoryByKey(match.key!);
      return true;
    }
    const domainPair = await this.domainPairForKey(match.key!) ?? match.key!;
    await this.saveHistory(domainPair, TransferTrustHistorySchema.parse(data));
    return true;
  }

  private async loadScoreByKey(domainPairKey: string): Promise<TransferTrustScore | null> {
    const db = await this.database();
    return db.read((sqlite) => {
      const row = sqlite.prepare(`
        SELECT score_json
        FROM transfer_trust_scores
        WHERE domain_pair_key = ?
      `).get(domainPairKey) as { score_json: string } | undefined;
      if (!row) return null;
      return TransferTrustScoreSchema.parse(parseJson<unknown>(row.score_json));
    });
  }

  private async loadHistoryByKey(domainPairKey: string): Promise<TransferTrustHistory | null> {
    const db = await this.database();
    return db.read((sqlite) => {
      const row = sqlite.prepare(`
        SELECT history_json
        FROM transfer_trust_history
        WHERE domain_pair_key = ?
      `).get(domainPairKey) as { history_json: string } | undefined;
      if (!row) return null;
      return TransferTrustHistorySchema.parse(parseJson<unknown>(row.history_json));
    });
  }

  private async deleteScoreByKey(domainPairKey: string): Promise<void> {
    const db = await this.database();
    db.transaction((sqlite) => {
      sqlite.prepare("DELETE FROM transfer_trust_scores WHERE domain_pair_key = ?").run(domainPairKey);
    });
  }

  private async deleteHistoryByKey(domainPairKey: string): Promise<void> {
    const db = await this.database();
    db.transaction((sqlite) => {
      sqlite.prepare("DELETE FROM transfer_trust_history WHERE domain_pair_key = ?").run(domainPairKey);
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

function upsertIndexEntry(
  sqlite: { prepare(sql: string): { get(...params: unknown[]): unknown; run(...params: unknown[]): unknown } },
  domainPairKey: string,
  domainPair: string,
  updatedAt: string,
): void {
  const row = sqlite.prepare(`
    SELECT sort_order
    FROM transfer_trust_index_entries
    WHERE domain_pair_key = ?
  `).get(domainPairKey) as { sort_order: number } | undefined;
  const sortOrder = row?.sort_order ?? nextIndexSortOrder(sqlite);
  sqlite.prepare(`
    INSERT INTO transfer_trust_index_entries (
      domain_pair_key,
      domain_pair,
      sort_order,
      updated_at
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(domain_pair_key) DO UPDATE SET
      domain_pair = excluded.domain_pair,
      updated_at = excluded.updated_at
  `).run(domainPairKey, domainPair, sortOrder, updatedAt);
}

function nextIndexSortOrder(
  sqlite: { prepare(sql: string): { get(...params: unknown[]): unknown } },
): number {
  const row = sqlite.prepare(`
    SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_sort_order
    FROM transfer_trust_index_entries
  `).get() as { next_sort_order: number } | undefined;
  return row?.next_sort_order ?? 0;
}
