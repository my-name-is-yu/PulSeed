import type { StateManager } from "../../base/state/state-manager.js";
import {
  openControlDatabase,
  type ControlDatabase,
  type RuntimeControlDbStoreOptions,
} from "../store/control-db/index.js";
import { RunSpecIdSchema, RunSpecSchema, type RunSpec } from "./types.js";

export interface RunSpecStoreOptions extends RuntimeControlDbStoreOptions {}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}

export class RunSpecStore {
  private dbPromise: Promise<ControlDatabase> | null = null;

  constructor(
    private readonly stateManager: Pick<StateManager, "getBaseDir">,
    private readonly options: RunSpecStoreOptions = {},
  ) {}

  async save(spec: RunSpec): Promise<RunSpec> {
    const parsed = RunSpecSchema.parse(spec);
    const db = await this.database();
    db.transaction((sqlite) => {
      sqlite.prepare(`
        INSERT INTO run_spec_records (
          run_spec_id,
          status,
          profile,
          goal_id,
          runtime_session_id,
          conversation_id,
          created_at,
          updated_at,
          spec_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, json(?))
        ON CONFLICT(run_spec_id) DO UPDATE SET
          status = excluded.status,
          profile = excluded.profile,
          goal_id = excluded.goal_id,
          runtime_session_id = excluded.runtime_session_id,
          conversation_id = excluded.conversation_id,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          spec_json = excluded.spec_json
      `).run(
        parsed.id,
        parsed.status,
        parsed.profile,
        parsed.links.goal_id,
        parsed.links.runtime_session_id,
        parsed.origin.session_id,
        parsed.created_at,
        parsed.updated_at,
        stringifyJson(parsed),
      );
    });
    return parsed;
  }

  async load(id: string): Promise<RunSpec | null> {
    const parsedId = RunSpecIdSchema.parse(id);
    const db = await this.database();
    return db.read((sqlite) => {
      const row = sqlite.prepare(`
        SELECT spec_json
        FROM run_spec_records
        WHERE run_spec_id = ?
      `).get(parsedId) as { spec_json: string } | undefined;
      if (!row) return null;
      return RunSpecSchema.parse(parseJson(row.spec_json));
    });
  }

  async list(): Promise<RunSpec[]> {
    const db = await this.database();
    return db.read((sqlite) => {
      const rows = sqlite.prepare(`
        SELECT spec_json
        FROM run_spec_records
        ORDER BY updated_at ASC, run_spec_id ASC
      `).all() as Array<{ spec_json: string }>;
      return rows.map((row) => RunSpecSchema.parse(parseJson(row.spec_json)));
    });
  }

  private async database(): Promise<ControlDatabase> {
    if (this.options.controlDb) {
      return this.options.controlDb;
    }
    this.dbPromise ??= openControlDatabase({
      baseDir: this.options.controlBaseDir ?? this.stateManager.getBaseDir(),
      dbPath: this.options.controlDbPath,
    });
    return this.dbPromise;
  }
}

export function createRunSpecStore(
  stateManager: Pick<StateManager, "getBaseDir">,
  options: RunSpecStoreOptions = {},
): RunSpecStore {
  return new RunSpecStore(stateManager, options);
}
