import {
  openControlDatabase,
  type ControlDatabase,
  type RuntimeControlDbStoreOptions,
} from "./control-db/index.js";
import { DependencyGraphSchema, type DependencyGraph } from "../../base/types/dependency.js";
import { NegotiationLogSchema, type NegotiationLog } from "../../base/types/negotiation.js";

export interface GoalOrchestrationStateStoreOptions extends RuntimeControlDbStoreOptions {}

export interface GoalOrchestrationStateStorePort {
  ensureReady(): Promise<void>;
  loadNegotiationLog(goalId: string): Promise<NegotiationLog | null>;
  saveNegotiationLog(goalId: string, log: NegotiationLog): Promise<void>;
  loadDependencyGraph(): Promise<DependencyGraph | null>;
  saveDependencyGraph(graph: DependencyGraph): Promise<void>;
}

const DEPENDENCY_GRAPH_ID = "current";

function nowIso(): string {
  return new Date().toISOString();
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}

export class GoalOrchestrationStateStore implements GoalOrchestrationStateStorePort {
  private dbPromise: Promise<ControlDatabase> | null = null;

  constructor(
    private readonly baseDir: string,
    private readonly options: GoalOrchestrationStateStoreOptions = {},
  ) {}

  async ensureReady(): Promise<void> {
    await this.database();
  }

  async loadNegotiationLog(goalId: string): Promise<NegotiationLog | null> {
    const db = await this.database();
    return db.read((sqlite) => {
      const row = sqlite.prepare(`
        SELECT log_json
        FROM goal_negotiation_logs
        WHERE goal_id = ?
      `).get(goalId) as { log_json: string } | undefined;
      if (!row) return null;
      return NegotiationLogSchema.parse(parseJson(row.log_json));
    });
  }

  async saveNegotiationLog(goalId: string, log: NegotiationLog): Promise<void> {
    const parsed = NegotiationLogSchema.parse(log);
    if (parsed.goal_id !== goalId) {
      throw new Error(`Negotiation log goal_id ${parsed.goal_id} does not match storage key ${goalId}`);
    }
    const updatedAt = nowIso();
    const db = await this.database();
    db.transaction((sqlite) => {
      sqlite.prepare(`
        INSERT INTO goal_negotiation_logs (
          goal_id,
          log_timestamp,
          updated_at,
          log_json
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(goal_id) DO UPDATE SET
          log_timestamp = excluded.log_timestamp,
          updated_at = excluded.updated_at,
          log_json = excluded.log_json
      `).run(parsed.goal_id, parsed.timestamp, updatedAt, stringifyJson(parsed));
    });
  }

  async loadDependencyGraph(): Promise<DependencyGraph | null> {
    const db = await this.database();
    return db.read((sqlite) => {
      const row = sqlite.prepare(`
        SELECT graph_json
        FROM goal_dependency_graph_state
        WHERE graph_id = ?
      `).get(DEPENDENCY_GRAPH_ID) as { graph_json: string } | undefined;
      if (!row) return null;
      return DependencyGraphSchema.parse(parseJson(row.graph_json));
    });
  }

  async saveDependencyGraph(graph: DependencyGraph): Promise<void> {
    const parsed = DependencyGraphSchema.parse(graph);
    const updatedAt = nowIso();
    const db = await this.database();
    db.transaction((sqlite) => {
      sqlite.prepare(`
        INSERT INTO goal_dependency_graph_state (
          graph_id,
          updated_at,
          graph_json
        ) VALUES (?, ?, ?)
        ON CONFLICT(graph_id) DO UPDATE SET
          updated_at = excluded.updated_at,
          graph_json = excluded.graph_json
      `).run(DEPENDENCY_GRAPH_ID, updatedAt, stringifyJson(parsed));
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
