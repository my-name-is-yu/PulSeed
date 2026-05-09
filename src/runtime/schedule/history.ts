import { randomUUID } from "node:crypto";
import {
  ScheduleResultSchema,
  type ScheduleLayerSchema,
  type ScheduleFailureKind,
  type ScheduleResult,
} from "../types/schedule.js";
import { z } from "zod";
import {
  openControlDatabase,
  type ControlDatabase,
  type RuntimeControlDbStoreOptions,
  type SqliteDatabase,
} from "../store/control-db/index.js";

const DEFAULT_MAX_RECENT = 500;
const ScheduleHistorySafeNonnegativeIntSchema = z.number().int().nonnegative().safe();

export const ScheduleRunReasonSchema = z.enum(["cadence", "retry", "escalation_target", "manual_run"]);
export type ScheduleRunReason = z.infer<typeof ScheduleRunReasonSchema>;

export const ScheduleRunHistoryRecordSchema = ScheduleResultSchema.extend({
  id: z.string().uuid(),
  entry_name: z.string(),
  reason: ScheduleRunReasonSchema,
  attempt: ScheduleHistorySafeNonnegativeIntSchema.default(0),
  scheduled_for: z.string().datetime().nullable().default(null),
  started_at: z.string().datetime(),
  finished_at: z.string().datetime(),
  retry_at: z.string().datetime().nullable().default(null),
  activation_kind: z.enum(["wait_resume"]).nullable().default(null),
  strategy_id: z.string().nullable().default(null),
  wait_strategy_id: z.string().nullable().default(null),
  internal: z.boolean().default(false),
});

export type ScheduleRunHistoryRecord = z.infer<typeof ScheduleRunHistoryRecordSchema>;

export interface ScheduleRunHistoryInput {
  entry_id: string;
  entry_name: string;
  layer: z.infer<typeof ScheduleLayerSchema>;
  result: ScheduleResult;
  reason: ScheduleRunReason;
  attempt?: number;
  scheduled_for?: string | null;
  started_at: string;
  finished_at: string;
  retry_at?: string | null;
  failure_kind?: ScheduleFailureKind | null;
  activation_kind?: "wait_resume" | null;
  strategy_id?: string | null;
  wait_strategy_id?: string | null;
  internal?: boolean;
}

export class ScheduleHistoryStore {
  private readonly dbOptions: RuntimeControlDbStoreOptions;
  private dbPromise: Promise<ControlDatabase> | null = null;

  constructor(
    private readonly baseDir: string,
    private readonly maxRecent = DEFAULT_MAX_RECENT,
    options: RuntimeControlDbStoreOptions = {}
  ) {
    this.dbOptions = options;
  }

  async load(): Promise<ScheduleRunHistoryRecord[]> {
    const db = await this.database();
    return db.read((sqlite) => readScheduleHistory(sqlite));
  }

  async save(records: ScheduleRunHistoryRecord[]): Promise<void> {
    const trimmed = records.slice(-this.maxRecent);
    const db = await this.database();
    db.transaction((sqlite) => writeScheduleHistory(sqlite, trimmed));
  }

  async append(input: ScheduleRunHistoryInput): Promise<ScheduleRunHistoryRecord> {
    const parsed = ScheduleRunHistoryRecordSchema.parse({
      ...input.result,
      id: randomUUID(),
      entry_id: input.entry_id,
      entry_name: input.entry_name,
      layer: input.layer,
      reason: input.reason,
      attempt: input.attempt ?? 0,
      scheduled_for: input.scheduled_for ?? null,
      started_at: input.started_at,
      finished_at: input.finished_at,
      retry_at: input.retry_at ?? null,
      failure_kind: input.failure_kind ?? input.result.failure_kind,
      activation_kind: input.activation_kind ?? null,
      strategy_id: input.strategy_id ?? null,
      wait_strategy_id: input.wait_strategy_id ?? null,
      internal: input.internal ?? false,
    });

    const db = await this.database();
    db.transaction((sqlite) => {
      const existing = readScheduleHistory(sqlite);
      existing.push(parsed);
      writeScheduleHistory(sqlite, existing.slice(-this.maxRecent));
    });
    return parsed;
  }

  async recent(limit = 20): Promise<ScheduleRunHistoryRecord[]> {
    const records = await this.load();
    return records.slice(-limit);
  }

  private async database(): Promise<ControlDatabase> {
    if (this.dbOptions.controlDb) {
      return this.dbOptions.controlDb;
    }
    this.dbPromise ??= openControlDatabase({
      baseDir: this.dbOptions.controlBaseDir ?? this.baseDir,
      dbPath: this.dbOptions.controlDbPath,
    });
    return this.dbPromise;
  }
}

interface ScheduleHistoryRow {
  record_json: string;
}

function readScheduleHistory(sqlite: SqliteDatabase): ScheduleRunHistoryRecord[] {
  const rows = sqlite.prepare(`
    SELECT record_json
    FROM schedule_run_history
    ORDER BY sort_order ASC, history_id ASC
  `).all() as ScheduleHistoryRow[];
  const records: ScheduleRunHistoryRecord[] = [];
  for (const row of rows) {
    const parsed = ScheduleRunHistoryRecordSchema.safeParse(JSON.parse(row.record_json) as unknown);
    if (parsed.success) {
      records.push(parsed.data);
    }
  }
  return records;
}

function writeScheduleHistory(sqlite: SqliteDatabase, records: readonly ScheduleRunHistoryRecord[]): void {
  sqlite.prepare("DELETE FROM schedule_run_history").run();
  const insert = sqlite.prepare(`
    INSERT INTO schedule_run_history (
      history_id,
      entry_id,
      entry_name,
      layer,
      reason,
      started_at,
      finished_at,
      internal,
      tokens_used,
      sort_order,
      record_json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, json(?))
  `);
  records.forEach((record, index) => {
    insert.run(
      record.id,
      record.entry_id,
      record.entry_name,
      record.layer,
      record.reason,
      record.started_at,
      record.finished_at,
      record.internal ? 1 : 0,
      record.tokens_used,
      index,
      JSON.stringify(record),
    );
  });
}
