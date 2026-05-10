import {
  openControlDatabase,
  type ControlDatabase,
  type RuntimeControlDbStoreOptions,
} from "./control-db/index.js";
import { StallStateSchema, type StallState } from "../../base/types/stall.js";

export interface StallStateStoreOptions extends RuntimeControlDbStoreOptions {}

export interface StallStateStorePort {
  ensureReady(): Promise<void>;
  loadStallState(goalId: string): Promise<StallState | null>;
  saveStallState(goalId: string, state: StallState): Promise<void>;
  deleteStallState(goalId: string): Promise<void>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}

export class StallStateStore implements StallStateStorePort {
  private dbPromise: Promise<ControlDatabase> | null = null;

  constructor(
    private readonly baseDir: string,
    private readonly options: StallStateStoreOptions = {},
  ) {}

  async ensureReady(): Promise<void> {
    await this.database();
  }

  async loadStallState(goalId: string): Promise<StallState | null> {
    const db = await this.database();
    return db.read((sqlite) => {
      const row = sqlite.prepare(`
        SELECT state_json
        FROM stall_states
        WHERE goal_id = ?
      `).get(goalId) as { state_json: string } | undefined;
      if (!row) return null;
      return StallStateSchema.parse(parseJson(row.state_json));
    });
  }

  async saveStallState(goalId: string, state: StallState): Promise<void> {
    const parsed = StallStateSchema.parse(state);
    if (parsed.goal_id !== goalId) {
      throw new Error(`Stall state goal_id ${parsed.goal_id} does not match storage key ${goalId}`);
    }
    const updatedAt = nowIso();
    const db = await this.database();
    db.transaction((sqlite) => {
      sqlite.prepare(`
        INSERT INTO stall_states (
          goal_id,
          updated_at,
          state_json
        ) VALUES (?, ?, ?)
        ON CONFLICT(goal_id) DO UPDATE SET
          updated_at = excluded.updated_at,
          state_json = excluded.state_json
      `).run(parsed.goal_id, updatedAt, stringifyJson(parsed));
    });
  }

  async deleteStallState(goalId: string): Promise<void> {
    const db = await this.database();
    db.transaction((sqlite) => {
      sqlite.prepare(`
        DELETE FROM stall_states
        WHERE goal_id = ?
      `).run(goalId);
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
