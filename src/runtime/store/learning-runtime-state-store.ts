import {
  openControlDatabase,
  type ControlDatabase,
  type RuntimeControlDbStoreOptions,
} from "./control-db/index.js";
import {
  FeedbackEntrySchema,
  LearnedPatternSchema,
  StructuralFeedbackSchema,
  type FeedbackEntry,
  type LearnedPattern,
  type StructuralFeedback,
} from "../../base/types/learning.js";

export interface LearningRuntimeStateStoreOptions extends RuntimeControlDbStoreOptions {}

export type LearningRuntimeRawKind =
  | "logs"
  | "patterns"
  | "feedback"
  | "structural_feedback";

export interface LearningRuntimeRawPathMatch {
  goalId: string;
  kind: LearningRuntimeRawKind;
}

export interface LearningRuntimeRawStateStoreResult {
  handled: boolean;
  value: unknown | null;
}

export interface LearningRuntimeStateStorePort {
  ensureReady(): Promise<void>;
  loadExperienceLogs(goalId: string): Promise<unknown | null>;
  saveExperienceLogs(goalId: string, logs: unknown): Promise<void>;
  loadPatterns(goalId: string): Promise<LearnedPattern[]>;
  loadAllPatterns(): Promise<LearnedPattern[]>;
  savePatterns(goalId: string, patterns: LearnedPattern[]): Promise<void>;
  loadFeedbackEntries(goalId: string): Promise<FeedbackEntry[]>;
  saveFeedbackEntries(goalId: string, entries: FeedbackEntry[]): Promise<void>;
  loadStructuralFeedback(goalId: string): Promise<StructuralFeedback[]>;
  saveStructuralFeedback(goalId: string, entries: StructuralFeedback[]): Promise<void>;
  deleteGoalLearningState(goalId: string): Promise<void>;
}

const LEARNING_RAW_SUFFIXES: Array<{ kind: LearningRuntimeRawKind; suffix: string }> = [
  { kind: "structural_feedback", suffix: "_structural_feedback.json" },
  { kind: "feedback", suffix: "_feedback.json" },
  { kind: "patterns", suffix: "_patterns.json" },
  { kind: "logs", suffix: "_logs.json" },
];

function nowIso(): string {
  return new Date().toISOString();
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function stringifyJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("Learning runtime state must be JSON serializable.");
  }
  return serialized;
}

function parseArray<T>(value: unknown, itemParser: (item: unknown) => T): T[] {
  if (!Array.isArray(value)) {
    throw new Error("Learning runtime state must be an array.");
  }
  return value.map((item) => itemParser(item));
}

function normalizeRelativePath(relativePath: string): string[] {
  return relativePath.replace(/\\/g, "/").replace(/^\/+/, "").split("/").filter(Boolean);
}

export function parseLearningRuntimeRawPath(relativePath: string): LearningRuntimeRawPathMatch | null {
  const parts = normalizeRelativePath(relativePath);
  if (parts.length !== 2 || parts[0] !== "learning") return null;
  const fileName = parts[1]!;
  for (const { kind, suffix } of LEARNING_RAW_SUFFIXES) {
    if (!fileName.endsWith(suffix)) continue;
    const goalId = fileName.slice(0, -suffix.length);
    return goalId.length > 0 ? { goalId, kind } : null;
  }
  return null;
}

export class LearningRuntimeStateStore implements LearningRuntimeStateStorePort {
  private dbPromise: Promise<ControlDatabase> | null = null;

  constructor(
    private readonly baseDir: string,
    private readonly options: LearningRuntimeStateStoreOptions = {},
  ) {}

  async ensureReady(): Promise<void> {
    await this.database();
  }

  async loadExperienceLogs(goalId: string): Promise<unknown | null> {
    const db = await this.database();
    return db.read((sqlite) => {
      const row = sqlite.prepare(`
        SELECT logs_json
        FROM learning_experience_logs
        WHERE goal_id = ?
      `).get(goalId) as { logs_json: string } | undefined;
      return row ? parseJson<unknown>(row.logs_json) : null;
    });
  }

  async saveExperienceLogs(goalId: string, logs: unknown): Promise<void> {
    await this.saveJsonRow("learning_experience_logs", "logs_json", goalId, logs);
  }

  async loadPatterns(goalId: string): Promise<LearnedPattern[]> {
    const raw = await this.loadJsonRow("learning_patterns", "patterns_json", goalId);
    if (raw === null) return [];
    return parseArray(raw, (item) => LearnedPatternSchema.parse(item));
  }

  async loadAllPatterns(): Promise<LearnedPattern[]> {
    const db = await this.database();
    return db.read((sqlite) => {
      const rows = sqlite.prepare(`
        SELECT patterns_json
        FROM learning_patterns
        ORDER BY updated_at DESC, goal_id ASC
      `).all() as Array<{ patterns_json: string }>;
      return rows.flatMap((row) =>
        parseArray(parseJson<unknown>(row.patterns_json), (item) => LearnedPatternSchema.parse(item))
      );
    });
  }

  async savePatterns(goalId: string, patterns: LearnedPattern[]): Promise<void> {
    const parsed = parseArray(patterns, (item) => LearnedPatternSchema.parse(item));
    await this.saveJsonRow("learning_patterns", "patterns_json", goalId, parsed);
  }

  async loadFeedbackEntries(goalId: string): Promise<FeedbackEntry[]> {
    const raw = await this.loadJsonRow("learning_feedback_entries", "feedback_json", goalId);
    if (raw === null) return [];
    return parseArray(raw, (item) => FeedbackEntrySchema.parse(item));
  }

  async saveFeedbackEntries(goalId: string, entries: FeedbackEntry[]): Promise<void> {
    const parsed = parseArray(entries, (item) => FeedbackEntrySchema.parse(item));
    await this.saveJsonRow("learning_feedback_entries", "feedback_json", goalId, parsed);
  }

  async loadStructuralFeedback(goalId: string): Promise<StructuralFeedback[]> {
    const raw = await this.loadJsonRow("learning_structural_feedback", "feedback_json", goalId);
    if (raw === null) return [];
    return parseArray(raw, (item) => StructuralFeedbackSchema.parse(item));
  }

  async saveStructuralFeedback(goalId: string, entries: StructuralFeedback[]): Promise<void> {
    const parsed = parseArray(entries, (item) => StructuralFeedbackSchema.parse(item));
    for (const entry of parsed) {
      if (entry.goalId !== goalId) {
        throw new Error(`Structural feedback goalId ${entry.goalId} does not match storage key ${goalId}`);
      }
    }
    await this.saveJsonRow("learning_structural_feedback", "feedback_json", goalId, parsed);
  }

  async hasLearningState(goalId: string, kind: LearningRuntimeRawKind): Promise<boolean> {
    const table = this.tableForKind(kind);
    const db = await this.database();
    return db.read((sqlite) => {
      const row = sqlite.prepare(`
        SELECT 1
        FROM ${table}
        WHERE goal_id = ?
      `).get(goalId) as unknown | undefined;
      return row !== undefined;
    });
  }

  async deleteGoalLearningState(goalId: string): Promise<void> {
    const db = await this.database();
    db.transaction((sqlite) => {
      sqlite.prepare("DELETE FROM learning_experience_logs WHERE goal_id = ?").run(goalId);
      sqlite.prepare("DELETE FROM learning_patterns WHERE goal_id = ?").run(goalId);
      sqlite.prepare("DELETE FROM learning_feedback_entries WHERE goal_id = ?").run(goalId);
      sqlite.prepare("DELETE FROM learning_structural_feedback WHERE goal_id = ?").run(goalId);
    });
  }

  async readRawPath(relativePath: string): Promise<LearningRuntimeRawStateStoreResult> {
    const match = parseLearningRuntimeRawPath(relativePath);
    if (!match) return { handled: false, value: null };
    switch (match.kind) {
      case "logs":
        return { handled: true, value: await this.loadExperienceLogs(match.goalId) };
      case "patterns":
        return { handled: true, value: await this.loadPatterns(match.goalId) };
      case "feedback":
        return { handled: true, value: await this.loadFeedbackEntries(match.goalId) };
      case "structural_feedback":
        return { handled: true, value: await this.loadStructuralFeedback(match.goalId) };
    }
  }

  async writeRawPath(relativePath: string, data: unknown): Promise<boolean> {
    const match = parseLearningRuntimeRawPath(relativePath);
    if (!match) return false;
    if (data === null) {
      await this.deleteLearningStateKind(match.goalId, match.kind);
      return true;
    }
    switch (match.kind) {
      case "logs":
        await this.saveExperienceLogs(match.goalId, data);
        return true;
      case "patterns":
        await this.savePatterns(match.goalId, data as LearnedPattern[]);
        return true;
      case "feedback":
        await this.saveFeedbackEntries(match.goalId, data as FeedbackEntry[]);
        return true;
      case "structural_feedback":
        await this.saveStructuralFeedback(match.goalId, data as StructuralFeedback[]);
        return true;
    }
  }

  private async deleteLearningStateKind(goalId: string, kind: LearningRuntimeRawKind): Promise<void> {
    const table = this.tableForKind(kind);
    const db = await this.database();
    db.transaction((sqlite) => {
      sqlite.prepare(`DELETE FROM ${table} WHERE goal_id = ?`).run(goalId);
    });
  }

  private async loadJsonRow(table: string, column: string, goalId: string): Promise<unknown | null> {
    const db = await this.database();
    return db.read((sqlite) => {
      const row = sqlite.prepare(`
        SELECT ${column} AS payload_json
        FROM ${table}
        WHERE goal_id = ?
      `).get(goalId) as { payload_json: string } | undefined;
      return row ? parseJson<unknown>(row.payload_json) : null;
    });
  }

  private async saveJsonRow(table: string, column: string, goalId: string, value: unknown): Promise<void> {
    const updatedAt = nowIso();
    const serialized = stringifyJson(value);
    const db = await this.database();
    db.transaction((sqlite) => {
      sqlite.prepare(`
        INSERT INTO ${table} (
          goal_id,
          updated_at,
          ${column}
        ) VALUES (?, ?, json(?))
        ON CONFLICT(goal_id) DO UPDATE SET
          updated_at = excluded.updated_at,
          ${column} = excluded.${column}
      `).run(goalId, updatedAt, serialized);
    });
  }

  private tableForKind(kind: LearningRuntimeRawKind): string {
    switch (kind) {
      case "logs":
        return "learning_experience_logs";
      case "patterns":
        return "learning_patterns";
      case "feedback":
        return "learning_feedback_entries";
      case "structural_feedback":
        return "learning_structural_feedback";
    }
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
