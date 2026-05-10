import {
  DreamDecisionHeuristicSchema,
  type DreamDecisionHeuristic,
} from "../../platform/dream/dream-decision-heuristics.js";
import {
  openControlDatabase,
  type ControlDatabase,
  type RuntimeControlDbStoreOptions,
  type SqliteDatabase,
} from "./control-db/index.js";

interface DreamDecisionHeuristicRow {
  heuristic_json: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

export function readDreamDecisionHeuristics(sqlite: SqliteDatabase): DreamDecisionHeuristic[] {
  const rows = sqlite.prepare(`
    SELECT heuristic_json
    FROM dream_decision_heuristics
    ORDER BY sort_order ASC, heuristic_id ASC
  `).all() as DreamDecisionHeuristicRow[];
  return rows.map((row) => DreamDecisionHeuristicSchema.parse(parseJson<unknown>(row.heuristic_json)));
}

export function replaceDreamDecisionHeuristics(
  sqlite: SqliteDatabase,
  heuristics: DreamDecisionHeuristic[],
): void {
  const parsed = heuristics.map((heuristic) => DreamDecisionHeuristicSchema.parse(heuristic));
  const updatedAt = nowIso();
  sqlite.prepare("DELETE FROM dream_decision_heuristics").run();
  const insert = sqlite.prepare(`
    INSERT INTO dream_decision_heuristics (
      heuristic_id, sort_order, updated_at, heuristic_json
    ) VALUES (
      @heuristic_id, @sort_order, @updated_at, @heuristic_json
    )
  `);
  parsed.forEach((heuristic, index) => {
    insert.run({
      heuristic_id: heuristic.id,
      sort_order: index,
      updated_at: updatedAt,
      heuristic_json: JSON.stringify(heuristic),
    });
  });
}

export class DreamDecisionHeuristicStore {
  private dbPromise: Promise<ControlDatabase> | null = null;

  constructor(private readonly options: RuntimeControlDbStoreOptions = {}) {}

  async loadDecisionHeuristics(): Promise<DreamDecisionHeuristic[]> {
    const db = await this.database();
    return db.read((sqlite) => readDreamDecisionHeuristics(sqlite));
  }

  async saveDecisionHeuristics(heuristics: DreamDecisionHeuristic[]): Promise<void> {
    const db = await this.database();
    db.transaction((sqlite) => replaceDreamDecisionHeuristics(sqlite, heuristics));
  }

  private async database(): Promise<ControlDatabase> {
    if (this.options.controlDb) {
      return this.options.controlDb;
    }
    this.dbPromise ??= openControlDatabase({
      baseDir: this.options.controlBaseDir,
      dbPath: this.options.controlDbPath,
    });
    return this.dbPromise;
  }
}
