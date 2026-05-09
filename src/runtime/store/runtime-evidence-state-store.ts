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
import {
  RuntimeEvidenceEntrySchema,
  type RuntimeEvidenceEntry,
  type RuntimeEvidenceReadResult,
  type RuntimeEvidenceReadWarning,
} from "./evidence-types.js";
import type {
  RuntimeEvidenceSummary,
  RuntimeEvidenceSummaryIndex,
} from "./evidence-ledger.js";

export type RuntimeEvidenceScopeKind = "goal" | "run";

export interface RuntimeEvidenceScopeKey {
  kind: RuntimeEvidenceScopeKind;
  id: string;
}

export interface RuntimeEvidenceExtractionRef {
  entry: RuntimeEvidenceEntry;
  source_ref: string;
}

export interface RuntimeEvidenceStateStoreOptions extends RuntimeControlDbStoreOptions {}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}

function scopeKeysForEntry(entry: RuntimeEvidenceEntry): RuntimeEvidenceScopeKey[] {
  const scopes: RuntimeEvidenceScopeKey[] = [];
  if (entry.scope.goal_id) scopes.push({ kind: "goal", id: entry.scope.goal_id });
  if (entry.scope.run_id) scopes.push({ kind: "run", id: entry.scope.run_id });
  return scopes;
}

function defaultSourceRef(scope: RuntimeEvidenceScopeKey, entry: RuntimeEvidenceEntry): string {
  return `runtime-evidence://${scope.kind}/${encodeURIComponent(scope.id)}/${encodeURIComponent(entry.id)}`;
}

export class RuntimeEvidenceStateStore {
  private readonly paths: RuntimeStorePaths;
  private dbPromise: Promise<ControlDatabase> | null = null;

  constructor(
    runtimeRootOrPaths?: string | RuntimeStorePaths,
    private readonly options: RuntimeEvidenceStateStoreOptions = {},
  ) {
    this.paths =
      typeof runtimeRootOrPaths === "string"
        ? createRuntimeStorePaths(runtimeRootOrPaths)
        : runtimeRootOrPaths ?? createRuntimeStorePaths();
  }

  async ensureReady(): Promise<void> {
    await this.database();
  }

  async append(entry: RuntimeEvidenceEntry, options: { sourceRef?: string } = {}): Promise<void> {
    const parsed = RuntimeEvidenceEntrySchema.parse(entry);
    const scopes = scopeKeysForEntry(parsed);
    if (scopes.length === 0) return;
    const db = await this.database();
    db.transaction((sqlite) => {
      for (const scope of scopes) {
        upsertEvidenceEntry(sqlite, scope, parsed, options.sourceRef ?? defaultSourceRef(scope, parsed));
        deleteSummaryIndex(sqlite, scope);
      }
    });
  }

  async readByGoal(goalId: string): Promise<RuntimeEvidenceReadResult> {
    return this.readByScope({ kind: "goal", id: goalId });
  }

  async readByRun(runId: string): Promise<RuntimeEvidenceReadResult> {
    return this.readByScope({ kind: "run", id: runId });
  }

  async readByScope(scope: RuntimeEvidenceScopeKey): Promise<RuntimeEvidenceReadResult> {
    const db = await this.database();
    return db.read((sqlite) => readEvidenceByScope(sqlite, scope));
  }

  async listExtractionRefs(limit = 1_000): Promise<RuntimeEvidenceExtractionRef[]> {
    const db = await this.database();
    return db.read((sqlite) => {
      const rows = sqlite.prepare(`
        SELECT entry_json, source_ref
        FROM runtime_evidence_entries
        WHERE source_ref IS NOT NULL
        ORDER BY occurred_at ASC, scope_kind ASC, scope_id ASC, entry_id ASC
        LIMIT ?
      `).all(limit) as Array<{ entry_json: string; source_ref: string | null }>;
      const refs: RuntimeEvidenceExtractionRef[] = [];
      const seen = new Set<string>();
      for (const row of rows) {
        const parsed = RuntimeEvidenceEntrySchema.safeParse(parseJson(row.entry_json));
        if (!parsed.success) continue;
        const sourceRef = row.source_ref ?? defaultSourceRef(
          parsed.data.scope.goal_id
            ? { kind: "goal", id: parsed.data.scope.goal_id }
            : { kind: "run", id: parsed.data.scope.run_id! },
          parsed.data,
        );
        const key = `${parsed.data.id}\0${sourceRef}`;
        if (seen.has(key)) continue;
        seen.add(key);
        refs.push({ entry: parsed.data, source_ref: sourceRef });
      }
      return refs;
    });
  }

  async loadSummaryIndex(scope: RuntimeEvidenceScopeKey): Promise<RuntimeEvidenceSummaryIndex | null> {
    const db = await this.database();
    return db.read((sqlite) => {
      const row = sqlite.prepare(`
        SELECT generated_at, summary_json, append_state_json, checkpoint_json
        FROM runtime_evidence_summary_indexes
        WHERE scope_kind = ? AND scope_id = ?
      `).get(scope.kind, scope.id) as {
        generated_at: string;
        summary_json: string;
        append_state_json: string | null;
        checkpoint_json: string | null;
      } | undefined;
      if (!row) return null;
      const summary = parseJson<RuntimeEvidenceSummary>(row.summary_json);
      return {
        schema_version: "runtime-evidence-summary-index-v1",
        generated_at: row.generated_at,
        canonical_log_path: `control-db://runtime-evidence/${scope.kind}/${encodeURIComponent(scope.id)}`,
        canonical_log_size: 0,
        canonical_log_mtime_ms: 0,
        summary,
        ...(row.append_state_json ? { append_state: parseJson(row.append_state_json) } : {}),
        ...(row.checkpoint_json ? { checkpoint: parseJson(row.checkpoint_json) } : {}),
      } as RuntimeEvidenceSummaryIndex;
    });
  }

  async saveSummaryIndex(scope: RuntimeEvidenceScopeKey, index: RuntimeEvidenceSummaryIndex): Promise<void> {
    const db = await this.database();
    db.transaction((sqlite) => {
      sqlite.prepare(`
        INSERT INTO runtime_evidence_summary_indexes (
          scope_kind, scope_id, generated_at, summary_json, append_state_json, checkpoint_json
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_kind, scope_id) DO UPDATE SET
          generated_at = excluded.generated_at,
          summary_json = excluded.summary_json,
          append_state_json = excluded.append_state_json,
          checkpoint_json = excluded.checkpoint_json
      `).run(
        scope.kind,
        scope.id,
        index.generated_at,
        stringifyJson(index.summary),
        index.append_state ? stringifyJson(index.append_state) : null,
        index.checkpoint ? stringifyJson(index.checkpoint) : null,
      );
    });
  }

  async clearSummaryIndex(scope: RuntimeEvidenceScopeKey): Promise<void> {
    const db = await this.database();
    db.transaction((sqlite) => deleteSummaryIndex(sqlite, scope));
  }

  private async database(): Promise<ControlDatabase> {
    if (!this.dbPromise) {
      this.dbPromise = openRuntimeControlDatabase(this.paths, this.options);
    }
    return this.dbPromise;
  }
}

function upsertEvidenceEntry(
  sqlite: SqliteDatabase,
  scope: RuntimeEvidenceScopeKey,
  entry: RuntimeEvidenceEntry,
  sourceRef: string,
): void {
  sqlite.prepare(`
    INSERT INTO runtime_evidence_entries (
      scope_kind, scope_id, entry_id, occurred_at, kind, outcome, goal_id, run_id, task_id, source_ref, entry_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(scope_kind, scope_id, entry_id) DO UPDATE SET
      occurred_at = excluded.occurred_at,
      kind = excluded.kind,
      outcome = excluded.outcome,
      goal_id = excluded.goal_id,
      run_id = excluded.run_id,
      task_id = excluded.task_id,
      source_ref = excluded.source_ref,
      entry_json = excluded.entry_json
  `).run(
    scope.kind,
    scope.id,
    entry.id,
    entry.occurred_at,
    entry.kind,
    entry.outcome ?? null,
    entry.scope.goal_id ?? null,
    entry.scope.run_id ?? null,
    entry.scope.task_id ?? null,
    sourceRef,
    stringifyJson(entry),
  );
}

function readEvidenceByScope(sqlite: SqliteDatabase, scope: RuntimeEvidenceScopeKey): RuntimeEvidenceReadResult {
  const rows = sqlite.prepare(`
    SELECT entry_json
    FROM runtime_evidence_entries
    WHERE scope_kind = ? AND scope_id = ?
    ORDER BY occurred_at ASC, entry_id ASC
  `).all(scope.kind, scope.id) as Array<{ entry_json: string }>;
  const entries: RuntimeEvidenceEntry[] = [];
  const warnings: RuntimeEvidenceReadWarning[] = [];
  rows.forEach((row, index) => {
    const parsed = RuntimeEvidenceEntrySchema.safeParse(parseJson(row.entry_json));
    if (parsed.success) {
      entries.push(parsed.data);
    } else {
      warnings.push({
        file: `control-db://runtime-evidence/${scope.kind}/${encodeURIComponent(scope.id)}`,
        line: index + 1,
        message: parsed.error.issues.map((issue) => issue.message).join("; "),
      });
    }
  });
  return { entries, warnings };
}

function deleteSummaryIndex(sqlite: SqliteDatabase, scope: RuntimeEvidenceScopeKey): void {
  sqlite.prepare(`
    DELETE FROM runtime_evidence_summary_indexes
    WHERE scope_kind = ? AND scope_id = ?
  `).run(scope.kind, scope.id);
}
