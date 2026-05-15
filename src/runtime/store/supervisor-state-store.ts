import { z } from "zod/v3";
import { createRuntimeStorePaths } from "./runtime-paths.js";
import {
  openRuntimeControlDatabase,
  openRuntimeControlDatabaseSync,
  type ControlDatabase,
  type RuntimeControlDbStoreOptions,
  type SqliteDatabase,
} from "./control-db/index.js";

const SupervisorWorkerStateSchema = z.object({
  workerId: z.string(),
  goalId: z.string().nullable(),
  startedAt: z.number().finite().safe(),
  iterations: z.number().finite().int().nonnegative().safe(),
  backgroundRunId: z.string().nullable().optional(),
  sessionId: z.string().nullable().optional(),
  parentSessionId: z.string().nullable().optional(),
});

export const SupervisorStateSchema = z.object({
  workers: z.array(SupervisorWorkerStateSchema),
  crashCounts: z.record(z.number().finite().int().nonnegative().safe()),
  suspendedGoals: z.array(z.string()),
  updatedAt: z.number().finite().safe(),
});

const SupervisorCrashCountSchema = z.number().finite().int().nonnegative().safe();

export type SupervisorStateRecord = z.infer<typeof SupervisorStateSchema>;

export class SupervisorStateStore {
  private readonly dbOptions: RuntimeControlDbStoreOptions;
  private dbPromise: Promise<ControlDatabase> | null = null;

  constructor(
    private readonly runtimeRoot: string,
    options: RuntimeControlDbStoreOptions = {}
  ) {
    this.dbOptions = options;
  }

  async load(): Promise<SupervisorStateRecord | null> {
    const db = await this.database();
    return db.read((sqlite) => readSupervisorState(sqlite));
  }

  async save(state: SupervisorStateRecord): Promise<SupervisorStateRecord> {
    const parsed = SupervisorStateSchema.parse(state);
    const db = await this.database();
    db.transaction((sqlite) => upsertSupervisorState(sqlite, parsed));
    return parsed;
  }

  loadSync(): SupervisorStateRecord | null {
    const db = openRuntimeControlDatabaseSync(createRuntimeStorePaths(this.runtimeRoot), this.dbOptions);
    try {
      return db.read((sqlite) => readSupervisorState(sqlite));
    } finally {
      if (!this.dbOptions.controlDb) {
        db.close();
      }
    }
  }

  saveSync(state: SupervisorStateRecord): SupervisorStateRecord {
    const parsed = SupervisorStateSchema.parse(state);
    const db = openRuntimeControlDatabaseSync(createRuntimeStorePaths(this.runtimeRoot), this.dbOptions);
    try {
      db.transaction((sqlite) => upsertSupervisorState(sqlite, parsed));
      return parsed;
    } finally {
      if (!this.dbOptions.controlDb) {
        db.close();
      }
    }
  }

  private async database(): Promise<ControlDatabase> {
    if (this.dbOptions.controlDb) {
      return this.dbOptions.controlDb;
    }
    this.dbPromise ??= openRuntimeControlDatabase(
      createRuntimeStorePaths(this.runtimeRoot),
      this.dbOptions
    );
    return this.dbPromise;
  }
}

interface SupervisorStateRow {
  state_json: string;
}

function readSupervisorState(sqlite: SqliteDatabase): SupervisorStateRecord | null {
  const row = sqlite.prepare(`
    SELECT state_json
    FROM supervisor_state_snapshots
    WHERE state_id = 'current'
  `).get() as SupervisorStateRow | undefined;
  if (!row) return null;
  const raw = JSON.parse(row.state_json) as unknown;
  const parsed = SupervisorStateSchema.safeParse(raw);
  if (parsed.success) {
    return parsed.data;
  }
  return normalizePersistedSupervisorState(raw);
}

function normalizePersistedSupervisorState(raw: unknown): SupervisorStateRecord {
  const source = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const workers = Array.isArray(source["workers"])
    ? source["workers"].flatMap((worker) => {
      const parsed = SupervisorWorkerStateSchema.safeParse(worker);
      return parsed.success ? [parsed.data] : [];
    })
    : [];
  const crashCounts: Record<string, number> = {};
  const rawCrashCounts = source["crashCounts"];
  if (rawCrashCounts && typeof rawCrashCounts === "object" && !Array.isArray(rawCrashCounts)) {
    for (const [goalId, rawCount] of Object.entries(rawCrashCounts)) {
      if (goalId.length === 0) continue;
      const parsed = SupervisorCrashCountSchema.safeParse(rawCount);
      if (parsed.success) {
        crashCounts[goalId] = parsed.data;
      }
    }
  }
  const suspendedGoals = Array.isArray(source["suspendedGoals"])
    ? source["suspendedGoals"].filter((goalId): goalId is string => typeof goalId === "string")
    : [];
  const updatedAt = z.number().finite().safe().safeParse(source["updatedAt"]);
  return SupervisorStateSchema.parse({
    workers,
    crashCounts,
    suspendedGoals,
    updatedAt: updatedAt.success ? updatedAt.data : Date.now(),
  });
}

function upsertSupervisorState(sqlite: SqliteDatabase, state: SupervisorStateRecord): void {
  const activeGoalCount = state.workers.filter((worker) => worker.goalId !== null).length;
  sqlite.prepare(`
    INSERT INTO supervisor_state_snapshots (
      state_id,
      updated_at,
      active_goal_count,
      state_json
    )
    VALUES ('current', ?, ?, json(?))
    ON CONFLICT(state_id) DO UPDATE SET
      updated_at = excluded.updated_at,
      active_goal_count = excluded.active_goal_count,
      state_json = excluded.state_json
  `).run(state.updatedAt, activeGoalCount, JSON.stringify(state));
}
