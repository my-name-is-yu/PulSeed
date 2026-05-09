import { createHash, randomUUID } from "node:crypto";
import {
  openControlDatabase,
  type ControlDatabase,
  type RuntimeControlDbStoreOptions,
  type SqliteDatabase,
} from "./control-db/index.js";
import { parseStrategy, PortfolioSchema, type Portfolio, type Strategy } from "../../base/types/strategy.js";
import type { RebalanceResult } from "../../base/types/portfolio.js";
import {
  DreamActivationArtifactSchema,
  EventLogSchema,
  ImportanceEntrySchema,
  IterationLogSchema,
  ScheduleSuggestionSchema,
  SessionLogSchema,
  WatermarkStateSchema,
  type DreamActivationArtifact,
  type EventLog,
  type ImportanceEntry,
  type IterationLog,
  type ScheduleSuggestion,
  type SessionLog,
  type WatermarkState,
} from "../../platform/dream/dream-types.js";

export interface RawStateStoreResult {
  handled: boolean;
  value: unknown | null;
}

export interface StrategyDreamStateStoreOptions extends RuntimeControlDbStoreOptions {}

function nowIso(): string {
  return new Date().toISOString();
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}

function normalizeRelativePath(relativePath: string): string[] {
  return relativePath.replace(/\\/g, "/").replace(/^\/+/, "").split("/").filter(Boolean);
}

function stableId(prefix: string, value: unknown): string {
  const digest = createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex").slice(0, 24);
  return `${prefix}:${digest}`;
}

type StrategyRawPath =
  | { kind: "portfolio"; goalId: string }
  | { kind: "strategy_history"; goalId: string }
  | { kind: "wait_metadata"; goalId: string; strategyId: string }
  | { kind: "rebalance_history"; goalId: string };

function parseStrategyRawPath(relativePath: string): StrategyRawPath | null {
  const parts = normalizeRelativePath(relativePath);
  if (parts[0] !== "strategies" || parts.length < 3) return null;
  const goalId = parts[1]!;
  if (parts.length === 3 && parts[2] === "portfolio.json") return { kind: "portfolio", goalId };
  if (parts.length === 3 && parts[2] === "strategy-history.json") return { kind: "strategy_history", goalId };
  if (parts.length === 3 && parts[2] === "rebalance-history.json") return { kind: "rebalance_history", goalId };
  if (parts.length === 4 && parts[2] === "wait-meta" && parts[3]!.endsWith(".json")) {
    return { kind: "wait_metadata", goalId, strategyId: parts[3]!.slice(0, -".json".length) };
  }
  return null;
}

export class StrategyDreamStateStore {
  private dbPromise: Promise<ControlDatabase> | null = null;

  constructor(
    private readonly baseDir: string,
    private readonly options: StrategyDreamStateStoreOptions = {},
  ) {}

  async ensureReady(): Promise<void> {
    await this.database();
  }

  async savePortfolio(goalId: string, portfolio: Portfolio): Promise<void> {
    const parsed = PortfolioSchema.parse(portfolio);
    const db = await this.database();
    db.transaction((sqlite) => {
      sqlite.prepare(`
        INSERT INTO strategy_portfolios (goal_id, updated_at, portfolio_json)
        VALUES (?, ?, ?)
        ON CONFLICT(goal_id) DO UPDATE SET
          updated_at = excluded.updated_at,
          portfolio_json = excluded.portfolio_json
      `).run(goalId, nowIso(), stringifyJson(parsed));
    });
  }

  async loadPortfolio(goalId: string): Promise<Portfolio | null> {
    const db = await this.database();
    return db.read((sqlite) => {
      const row = sqlite.prepare(`
        SELECT portfolio_json
        FROM strategy_portfolios
        WHERE goal_id = ?
      `).get(goalId) as { portfolio_json: string } | undefined;
      return row ? PortfolioSchema.parse(parseJson(row.portfolio_json)) : null;
    });
  }

  async saveStrategyHistory(goalId: string, history: Strategy[]): Promise<void> {
    const parsed = history.map((strategy) => parseStrategy(strategy));
    const db = await this.database();
    db.transaction((sqlite) => {
      sqlite.prepare("DELETE FROM strategy_history_records WHERE goal_id = ?").run(goalId);
      const insert = sqlite.prepare(`
        INSERT INTO strategy_history_records (goal_id, strategy_id, sort_order, updated_at, strategy_json)
        VALUES (?, ?, ?, ?, ?)
      `);
      parsed.forEach((strategy, index) => {
        insert.run(goalId, strategy.id, index, strategy.completed_at ?? strategy.started_at ?? strategy.created_at, stringifyJson(strategy));
      });
    });
  }

  async loadStrategyHistory(goalId: string): Promise<Strategy[]> {
    const db = await this.database();
    return db.read((sqlite) => {
      const rows = sqlite.prepare(`
        SELECT strategy_json
        FROM strategy_history_records
        WHERE goal_id = ?
        ORDER BY sort_order ASC, strategy_id ASC
      `).all(goalId) as Array<{ strategy_json: string }>;
      return rows.map((row) => parseStrategy(parseJson(row.strategy_json)));
    });
  }

  async countStrategyHistoryGoals(): Promise<number> {
    const db = await this.database();
    return db.read((sqlite) => {
      const row = sqlite.prepare(`
        SELECT COUNT(DISTINCT goal_id) AS count
        FROM strategy_history_records
      `).get() as { count: number };
      return row.count;
    });
  }

  async saveWaitMetadata(goalId: string, strategyId: string, metadata: unknown): Promise<void> {
    const db = await this.database();
    db.transaction((sqlite) => {
      sqlite.prepare(`
        INSERT INTO strategy_wait_metadata (goal_id, strategy_id, updated_at, metadata_json)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(goal_id, strategy_id) DO UPDATE SET
          updated_at = excluded.updated_at,
          metadata_json = excluded.metadata_json
      `).run(goalId, strategyId, nowIso(), stringifyJson(metadata ?? {}));
    });
  }

  async loadWaitMetadata(goalId: string, strategyId: string): Promise<unknown | null> {
    const db = await this.database();
    return db.read((sqlite) => {
      const row = sqlite.prepare(`
        SELECT metadata_json
        FROM strategy_wait_metadata
        WHERE goal_id = ? AND strategy_id = ?
      `).get(goalId, strategyId) as { metadata_json: string } | undefined;
      return row ? parseJson(row.metadata_json) : null;
    });
  }

  async saveRebalanceHistory(goalId: string, history: RebalanceResult[] | unknown[]): Promise<void> {
    const db = await this.database();
    db.transaction((sqlite) => {
      sqlite.prepare("DELETE FROM strategy_rebalance_history WHERE goal_id = ?").run(goalId);
      const insert = sqlite.prepare(`
        INSERT INTO strategy_rebalance_history (goal_id, sort_order, rebalance_at, record_json)
        VALUES (?, ?, ?, ?)
      `);
      history.forEach((record, index) => {
        const object = record && typeof record === "object" ? record as Record<string, unknown> : {};
        const timestamp = typeof object["timestamp"] === "string" ? object["timestamp"] : nowIso();
        insert.run(goalId, index, timestamp, stringifyJson(record));
      });
    });
  }

  async loadRebalanceHistory(goalId: string): Promise<unknown[]> {
    const db = await this.database();
    return db.read((sqlite) => {
      const rows = sqlite.prepare(`
        SELECT record_json
        FROM strategy_rebalance_history
        WHERE goal_id = ?
        ORDER BY sort_order ASC
      `).all(goalId) as Array<{ record_json: string }>;
      return rows.map((row) => parseJson(row.record_json));
    });
  }

  async deleteGoalStrategyState(goalId: string): Promise<void> {
    const db = await this.database();
    db.transaction((sqlite) => {
      sqlite.prepare("DELETE FROM strategy_portfolios WHERE goal_id = ?").run(goalId);
      sqlite.prepare("DELETE FROM strategy_history_records WHERE goal_id = ?").run(goalId);
      sqlite.prepare("DELETE FROM strategy_wait_metadata WHERE goal_id = ?").run(goalId);
      sqlite.prepare("DELETE FROM strategy_rebalance_history WHERE goal_id = ?").run(goalId);
    });
  }

  async readRawPath(relativePath: string): Promise<RawStateStoreResult> {
    const match = parseStrategyRawPath(relativePath);
    if (!match) return { handled: false, value: null };
    switch (match.kind) {
      case "portfolio":
        return { handled: true, value: await this.loadPortfolio(match.goalId) };
      case "strategy_history":
        return { handled: true, value: await this.loadStrategyHistory(match.goalId) };
      case "wait_metadata":
        return { handled: true, value: await this.loadWaitMetadata(match.goalId, match.strategyId) };
      case "rebalance_history":
        return { handled: true, value: await this.loadRebalanceHistory(match.goalId) };
    }
  }

  async writeRawPath(relativePath: string, data: unknown): Promise<boolean> {
    const match = parseStrategyRawPath(relativePath);
    if (!match) return false;
    if (data === null) {
      await this.deleteRawPath(match);
      return true;
    }
    switch (match.kind) {
      case "portfolio":
        await this.savePortfolio(match.goalId, PortfolioSchema.parse(data));
        return true;
      case "strategy_history":
        await this.saveStrategyHistory(match.goalId, Array.isArray(data) ? data.map((item) => parseStrategy(item)) : []);
        return true;
      case "wait_metadata":
        await this.saveWaitMetadata(match.goalId, match.strategyId, data);
        return true;
      case "rebalance_history":
        await this.saveRebalanceHistory(match.goalId, Array.isArray(data) ? data : []);
        return true;
    }
  }

  async appendIterationLog(entry: IterationLog): Promise<void> {
    const parsed = IterationLogSchema.parse(entry);
    const entryId = parsed.entryId ?? stableId("dream-iteration", parsed);
    const db = await this.database();
    db.transaction((sqlite) => {
      const sequence = nextScopedSequence(sqlite, "dream_iteration_logs", "goal_id", parsed.goalId);
      sqlite.prepare(`
        INSERT INTO dream_iteration_logs (goal_id, entry_id, sequence, session_id, iteration, timestamp, entry_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(goal_id, entry_id) DO UPDATE SET
          session_id = excluded.session_id,
          iteration = excluded.iteration,
          timestamp = excluded.timestamp,
          entry_json = excluded.entry_json
      `).run(parsed.goalId, entryId, sequence, parsed.sessionId, parsed.iteration, parsed.timestamp, stringifyJson({ ...parsed, entryId }));
    });
  }

  async listIterationLogs(goalId: string): Promise<IterationLog[]> {
    const db = await this.database();
    return db.read((sqlite) => {
      const rows = sqlite.prepare(`
        SELECT entry_json
        FROM dream_iteration_logs
        WHERE goal_id = ?
        ORDER BY sequence ASC
      `).all(goalId) as Array<{ entry_json: string }>;
      return rows.map((row) => IterationLogSchema.parse(parseJson(row.entry_json)));
    });
  }

  async countIterationLogs(goalId: string): Promise<number> {
    const db = await this.database();
    return db.read((sqlite) =>
      (sqlite.prepare("SELECT COUNT(*) AS count FROM dream_iteration_logs WHERE goal_id = ?").get(goalId) as { count: number }).count
    );
  }

  async listDreamGoalIds(): Promise<string[]> {
    const db = await this.database();
    return db.read((sqlite) => {
      const rows = sqlite.prepare(`
        SELECT DISTINCT goal_id
        FROM dream_iteration_logs
        ORDER BY goal_id ASC
      `).all() as Array<{ goal_id: string }>;
      return rows.map((row) => row.goal_id);
    });
  }

  async appendSessionLog(entry: SessionLog): Promise<void> {
    const parsed = SessionLogSchema.parse(entry);
    const db = await this.database();
    db.transaction((sqlite) => {
      sqlite.prepare(`
        INSERT INTO dream_session_logs (session_id, goal_id, timestamp, entry_json)
        VALUES (?, ?, ?, ?)
      `).run(parsed.sessionId, parsed.goalId, parsed.timestamp, stringifyJson(parsed));
    });
  }

  async listSessionLogs(): Promise<SessionLog[]> {
    const db = await this.database();
    return db.read((sqlite) => {
      const rows = sqlite.prepare(`
        SELECT entry_json
        FROM dream_session_logs
        ORDER BY sequence ASC
      `).all() as Array<{ entry_json: string }>;
      return rows.map((row) => SessionLogSchema.parse(parseJson(row.entry_json)));
    });
  }

  async appendEventLog(entry: EventLog): Promise<void> {
    const parsed = EventLogSchema.parse(entry);
    const entryId = stableId("dream-event", { ...parsed, nonce: randomUUID() });
    const db = await this.database();
    db.transaction((sqlite) => {
      const sequence = nextScopedSequence(sqlite, "dream_event_logs", "goal_id", parsed.goalId);
      sqlite.prepare(`
        INSERT INTO dream_event_logs (goal_id, entry_id, sequence, event_type, task_id, timestamp, entry_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(parsed.goalId, entryId, sequence, parsed.eventType, parsed.taskId ?? null, parsed.timestamp, stringifyJson(parsed));
    });
  }

  async listEventLogs(): Promise<Array<{ event: EventLog; line: number; fileName: string }>> {
    const db = await this.database();
    return db.read((sqlite) => {
      const rows = sqlite.prepare(`
        SELECT goal_id, sequence, entry_json
        FROM dream_event_logs
        ORDER BY goal_id ASC, sequence ASC
      `).all() as Array<{ goal_id: string; sequence: number; entry_json: string }>;
      return rows.map((row) => ({
        event: EventLogSchema.parse(parseJson(row.entry_json)),
        line: row.sequence,
        fileName: `${row.goal_id}.jsonl`,
      }));
    });
  }

  async appendImportanceEntry(entry: ImportanceEntry): Promise<void> {
    const parsed = ImportanceEntrySchema.parse(entry);
    const db = await this.database();
    db.transaction((sqlite) => {
      const sequence = nextGlobalSequence(sqlite, "dream_importance_entries", "sequence");
      sqlite.prepare(`
        INSERT INTO dream_importance_entries (entry_id, goal_id, sequence, timestamp, importance, processed, entry_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(entry_id) DO UPDATE SET
          goal_id = excluded.goal_id,
          timestamp = excluded.timestamp,
          importance = excluded.importance,
          processed = excluded.processed,
          entry_json = excluded.entry_json
      `).run(parsed.id, parsed.goalId, sequence, parsed.timestamp, parsed.importance, parsed.processed ? 1 : 0, stringifyJson(parsed));
    });
  }

  async listImportanceEntries(): Promise<ImportanceEntry[]> {
    const db = await this.database();
    return db.read((sqlite) => {
      const rows = sqlite.prepare(`
        SELECT entry_json
        FROM dream_importance_entries
        ORDER BY sequence ASC
      `).all() as Array<{ entry_json: string }>;
      return rows.map((row) => ImportanceEntrySchema.parse(parseJson(row.entry_json)));
    });
  }

  async markImportanceEntriesProcessed(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const db = await this.database();
    db.transaction((sqlite) => {
      const select = sqlite.prepare("SELECT entry_json FROM dream_importance_entries WHERE entry_id = ?");
      const update = sqlite.prepare("UPDATE dream_importance_entries SET processed = 1, entry_json = ? WHERE entry_id = ?");
      for (const id of ids) {
        const row = select.get(id) as { entry_json: string } | undefined;
        if (!row) continue;
        const current = ImportanceEntrySchema.parse(parseJson(row.entry_json));
        const parsed = ImportanceEntrySchema.parse({ ...current, processed: true });
        update.run(stringifyJson(parsed), id);
      }
    });
  }

  async loadWatermarks(): Promise<WatermarkState> {
    const db = await this.database();
    return db.read((sqlite) => {
      const row = sqlite.prepare(`
        SELECT state_json
        FROM dream_watermark_state
        WHERE state_id = 'current'
      `).get() as { state_json: string } | undefined;
      return row ? WatermarkStateSchema.parse(parseJson(row.state_json)) : WatermarkStateSchema.parse({});
    });
  }

  async saveWatermarks(state: WatermarkState): Promise<void> {
    const parsed = WatermarkStateSchema.parse(state);
    const db = await this.database();
    db.transaction((sqlite) => {
      sqlite.prepare(`
        INSERT INTO dream_watermark_state (state_id, updated_at, state_json)
        VALUES ('current', ?, ?)
        ON CONFLICT(state_id) DO UPDATE SET
          updated_at = excluded.updated_at,
          state_json = excluded.state_json
      `).run(nowIso(), stringifyJson(parsed));
    });
  }

  async saveScheduleSuggestions(suggestions: ScheduleSuggestion[], generatedAt = nowIso()): Promise<void> {
    const parsed = suggestions.map((suggestion) => ScheduleSuggestionSchema.parse(suggestion));
    const db = await this.database();
    db.transaction((sqlite) => {
      sqlite.prepare("DELETE FROM dream_schedule_suggestions").run();
      const insert = sqlite.prepare(`
        INSERT INTO dream_schedule_suggestions (suggestion_id, status, generated_at, updated_at, goal_id, suggestion_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const suggestion of parsed) {
        const id = suggestion.id ?? randomUUID();
        const resolved = ScheduleSuggestionSchema.parse({ ...suggestion, id });
        insert.run(id, resolved.status, generatedAt, resolved.decided_at ?? generatedAt, resolved.goalId ?? null, stringifyJson(resolved));
      }
    });
  }

  async loadScheduleSuggestions(): Promise<{ generated_at: string; suggestions: ScheduleSuggestion[] }> {
    const db = await this.database();
    return db.read((sqlite) => {
      const rows = sqlite.prepare(`
        SELECT generated_at, suggestion_json
        FROM dream_schedule_suggestions
        ORDER BY updated_at ASC, suggestion_id ASC
      `).all() as Array<{ generated_at: string; suggestion_json: string }>;
      return {
        generated_at: rows[0]?.generated_at ?? new Date(0).toISOString(),
        suggestions: rows.map((row) => ScheduleSuggestionSchema.parse(parseJson(row.suggestion_json))),
      };
    });
  }

  async upsertDreamPlaybook(record: { playbook_id: string; status: string; updated_at: string } & Record<string, unknown>): Promise<void> {
    const db = await this.database();
    db.transaction((sqlite) => {
      sqlite.prepare(`
        INSERT INTO dream_playbooks (playbook_id, status, updated_at, record_json)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(playbook_id) DO UPDATE SET
          status = excluded.status,
          updated_at = excluded.updated_at,
          record_json = excluded.record_json
      `).run(record.playbook_id, record.status, record.updated_at, stringifyJson(record));
    });
  }

  async loadDreamPlaybooks(): Promise<unknown[]> {
    const db = await this.database();
    return db.read((sqlite) => {
      const rows = sqlite.prepare(`
        SELECT record_json
        FROM dream_playbooks
        ORDER BY playbook_id ASC
      `).all() as Array<{ record_json: string }>;
      return rows.map((row) => parseJson(row.record_json));
    });
  }

  async deleteDreamPlaybook(playbookId: string): Promise<boolean> {
    const db = await this.database();
    return db.transaction((sqlite) => {
      const result = sqlite.prepare("DELETE FROM dream_playbooks WHERE playbook_id = ?").run(playbookId);
      return result.changes > 0;
    });
  }

  async replaceActivationArtifacts(artifacts: DreamActivationArtifact[], updatedAt = nowIso()): Promise<void> {
    const parsed = artifacts.map((artifact) => DreamActivationArtifactSchema.parse(artifact));
    const db = await this.database();
    db.transaction((sqlite) => {
      sqlite.prepare("DELETE FROM dream_activation_artifacts").run();
      const insert = sqlite.prepare(`
        INSERT INTO dream_activation_artifacts (
          artifact_id, artifact_type, source, confidence, valid_from, valid_to, updated_at, artifact_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const artifact of parsed) {
        insert.run(
          artifact.artifact_id,
          artifact.type,
          artifact.source,
          artifact.confidence,
          artifact.valid_from,
          artifact.valid_to,
          updatedAt,
          stringifyJson(artifact),
        );
      }
    });
  }

  async loadActivationArtifacts(): Promise<DreamActivationArtifact[]> {
    const db = await this.database();
    return db.read((sqlite) => {
      const rows = sqlite.prepare(`
        SELECT artifact_json
        FROM dream_activation_artifacts
        ORDER BY artifact_id ASC
      `).all() as Array<{ artifact_json: string }>;
      return rows.map((row) => DreamActivationArtifactSchema.parse(parseJson(row.artifact_json)));
    });
  }

  async saveDreamWorkflows(records: Array<Record<string, unknown>>): Promise<void> {
    const db = await this.database();
    db.transaction((sqlite) => {
      sqlite.prepare("DELETE FROM dream_workflows").run();
      const insert = sqlite.prepare(`
        INSERT INTO dream_workflows (workflow_id, workflow_type, updated_at, record_json)
        VALUES (?, ?, ?, ?)
      `);
      for (const record of records) {
        insert.run(
          String(record["workflow_id"]),
          String(record["type"]),
          typeof record["updated_at"] === "string" ? record["updated_at"] : nowIso(),
          stringifyJson(record),
        );
      }
    });
  }

  async loadDreamWorkflows(): Promise<unknown[]> {
    const db = await this.database();
    return db.read((sqlite) => {
      const rows = sqlite.prepare(`
        SELECT record_json
        FROM dream_workflows
        ORDER BY workflow_id ASC
      `).all() as Array<{ record_json: string }>;
      return rows.map((row) => parseJson(row.record_json));
    });
  }

  private async deleteRawPath(match: StrategyRawPath): Promise<void> {
    const db = await this.database();
    db.transaction((sqlite) => {
      switch (match.kind) {
        case "portfolio":
          sqlite.prepare("DELETE FROM strategy_portfolios WHERE goal_id = ?").run(match.goalId);
          break;
        case "strategy_history":
          sqlite.prepare("DELETE FROM strategy_history_records WHERE goal_id = ?").run(match.goalId);
          break;
        case "wait_metadata":
          sqlite.prepare("DELETE FROM strategy_wait_metadata WHERE goal_id = ? AND strategy_id = ?").run(match.goalId, match.strategyId);
          break;
        case "rebalance_history":
          sqlite.prepare("DELETE FROM strategy_rebalance_history WHERE goal_id = ?").run(match.goalId);
          break;
      }
    });
  }

  private async database(): Promise<ControlDatabase> {
    if (this.options.controlDb) {
      return this.options.controlDb;
    }
    if (!this.dbPromise) {
      this.dbPromise = openControlDatabase({
        baseDir: this.options.controlBaseDir ?? this.baseDir,
        dbPath: this.options.controlDbPath,
      });
    }
    return this.dbPromise;
  }
}

function nextScopedSequence(sqlite: SqliteDatabase, table: string, scopeColumn: string, scopeId: string): number {
  const row = sqlite.prepare(`
    SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
    FROM ${table}
    WHERE ${scopeColumn} = ?
  `).get(scopeId) as { next_sequence: number };
  return row.next_sequence;
}

function nextGlobalSequence(sqlite: SqliteDatabase, table: string, column: string): number {
  const row = sqlite.prepare(`
    SELECT COALESCE(MAX(${column}), 0) + 1 AS next_sequence
    FROM ${table}
  `).get() as { next_sequence: number };
  return row.next_sequence;
}
