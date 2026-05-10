import {
  openControlDatabase,
  type ControlDatabase,
  type RuntimeControlDbStoreOptions,
} from "../../runtime/store/control-db/index.js";
import { GoalScheduleSchema, type GoalSchedule } from "./types/drive.js";

export interface DriveGoalScheduleStateStoreOptions extends RuntimeControlDbStoreOptions {}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}

function nowIso(): string {
  return new Date().toISOString();
}

export class DriveGoalScheduleStateStore {
  private dbPromise: Promise<ControlDatabase> | null = null;

  constructor(
    private readonly baseDir: string,
    private readonly options: DriveGoalScheduleStateStoreOptions = {},
  ) {}

  async save(goalId: string, schedule: GoalSchedule, updatedAt = nowIso()): Promise<GoalSchedule> {
    const parsed = GoalScheduleSchema.parse({ ...schedule, goal_id: goalId });
    const db = await this.database();
    db.transaction((sqlite) => {
      sqlite.prepare(`
        INSERT INTO goal_drive_schedules (
          goal_id,
          next_check_at,
          check_interval_hours,
          last_triggered_at,
          consecutive_actions,
          cooldown_until,
          current_interval_hours,
          updated_at,
          schedule_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, json(?))
        ON CONFLICT(goal_id) DO UPDATE SET
          next_check_at = excluded.next_check_at,
          check_interval_hours = excluded.check_interval_hours,
          last_triggered_at = excluded.last_triggered_at,
          consecutive_actions = excluded.consecutive_actions,
          cooldown_until = excluded.cooldown_until,
          current_interval_hours = excluded.current_interval_hours,
          updated_at = excluded.updated_at,
          schedule_json = excluded.schedule_json
      `).run(
        parsed.goal_id,
        parsed.next_check_at,
        parsed.check_interval_hours,
        parsed.last_triggered_at,
        parsed.consecutive_actions,
        parsed.cooldown_until,
        parsed.current_interval_hours,
        updatedAt,
        stringifyJson(parsed),
      );
    });
    return parsed;
  }

  async load(goalId: string): Promise<GoalSchedule | null> {
    const db = await this.database();
    return db.read((sqlite) => {
      const row = sqlite.prepare(`
        SELECT schedule_json
        FROM goal_drive_schedules
        WHERE goal_id = ?
      `).get(goalId) as { schedule_json: string } | undefined;
      if (!row) return null;
      return GoalScheduleSchema.parse(parseJson(row.schedule_json));
    });
  }

  async list(): Promise<GoalSchedule[]> {
    const db = await this.database();
    return db.read((sqlite) => {
      const rows = sqlite.prepare(`
        SELECT schedule_json
        FROM goal_drive_schedules
        ORDER BY next_check_at ASC, goal_id ASC
      `).all() as Array<{ schedule_json: string }>;
      return rows.map((row) => GoalScheduleSchema.parse(parseJson(row.schedule_json)));
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
