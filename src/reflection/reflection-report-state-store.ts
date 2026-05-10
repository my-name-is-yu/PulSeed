import {
  openControlDatabase,
  type ControlDatabase,
  type RuntimeControlDbStoreOptions,
} from "../runtime/store/control-db/index.js";
import {
  CatchupReportSchema,
  ConsolidationReportSchema,
  PlanningReportSchema,
  WeeklyReviewReportSchema,
  type CatchupReport,
  type ConsolidationReport,
  type PlanningReport,
  type WeeklyReviewReport,
} from "./types.js";

export type ReflectionReportType = "morning" | "evening" | "weekly" | "dream";

export type ReflectionReportByType = {
  morning: PlanningReport;
  evening: CatchupReport;
  weekly: WeeklyReviewReport;
  dream: ConsolidationReport;
};

export interface ReflectionReportStateStoreOptions extends RuntimeControlDbStoreOptions {}

const REPORT_SCHEMAS = {
  morning: PlanningReportSchema,
  evening: CatchupReportSchema,
  weekly: WeeklyReviewReportSchema,
  dream: ConsolidationReportSchema,
} as const;

function reportId(reportType: ReflectionReportType, periodKey: string): string {
  return `${reportType}:${periodKey}`;
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}

export class ReflectionReportStateStore {
  private dbPromise: Promise<ControlDatabase> | null = null;

  constructor(
    private readonly baseDir: string,
    private readonly options: ReflectionReportStateStoreOptions = {},
  ) {}

  async save<TType extends ReflectionReportType>(
    reportType: TType,
    periodKey: string,
    report: ReflectionReportByType[TType],
  ): Promise<ReflectionReportByType[TType]> {
    const parsed = REPORT_SCHEMAS[reportType].parse(report) as ReflectionReportByType[TType];
    const createdAt = typeof parsed.created_at === "string" ? parsed.created_at : new Date().toISOString();
    const db = await this.database();
    db.transaction((sqlite) => {
      sqlite.prepare(`
        INSERT INTO reflection_reports (
          report_id,
          report_type,
          period_key,
          created_at,
          report_json
        ) VALUES (?, ?, ?, ?, json(?))
        ON CONFLICT(report_type, period_key) DO UPDATE SET
          report_id = excluded.report_id,
          created_at = excluded.created_at,
          report_json = excluded.report_json
      `).run(
        reportId(reportType, periodKey),
        reportType,
        periodKey,
        createdAt,
        stringifyJson(parsed),
      );
    });
    return parsed;
  }

  async load<TType extends ReflectionReportType>(
    reportType: TType,
    periodKey: string,
  ): Promise<ReflectionReportByType[TType] | null> {
    const db = await this.database();
    return db.read((sqlite) => {
      const row = sqlite.prepare(`
        SELECT report_json
        FROM reflection_reports
        WHERE report_type = ? AND period_key = ?
      `).get(reportType, periodKey) as { report_json: string } | undefined;
      if (!row) return null;
      return REPORT_SCHEMAS[reportType].parse(parseJson(row.report_json)) as ReflectionReportByType[TType];
    });
  }

  async list<TType extends ReflectionReportType>(
    reportType: TType,
  ): Promise<Array<ReflectionReportByType[TType]>> {
    const db = await this.database();
    return db.read((sqlite) => {
      const rows = sqlite.prepare(`
        SELECT report_json
        FROM reflection_reports
        WHERE report_type = ?
        ORDER BY created_at ASC, period_key ASC
      `).all(reportType) as Array<{ report_json: string }>;
      return rows.map((row) =>
        REPORT_SCHEMAS[reportType].parse(parseJson(row.report_json)) as ReflectionReportByType[TType]
      );
    });
  }

  async close(): Promise<void> {
    if (this.options.controlDb || !this.dbPromise) return;
    const db = await this.dbPromise;
    db.close();
    this.dbPromise = null;
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
