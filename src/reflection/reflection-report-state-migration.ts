import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { readTextFileWithinLimit } from "../base/utils/json-io.js";
import {
  openControlDatabase,
  type ControlDatabase,
  type RuntimeControlDbStoreOptions,
} from "../runtime/store/control-db/index.js";
import { ReflectionReportStateStore, type ReflectionReportType } from "./reflection-report-state-store.js";
import {
  CatchupReportSchema,
  ConsolidationReportSchema,
  PlanningReportSchema,
  WeeklyReviewReportSchema,
} from "./types.js";

const MIGRATION_NAME = "reflection-report-runtime-state";
const MIGRATION_VERSION = 27;
const LEGACY_REFLECTION_REPORT_DIR = "reflections";
const LEGACY_REPORT_MAX_BYTES = 1024 * 1024;

type ReflectionReportSchema = typeof PlanningReportSchema
  | typeof CatchupReportSchema
  | typeof ConsolidationReportSchema
  | typeof WeeklyReviewReportSchema;

interface LegacyReportDescriptor {
  reportType: ReflectionReportType;
  periodKey: string;
  schema: ReflectionReportSchema;
}

export interface ReflectionReportLegacyImportReport {
  reflectionReportFiles: number;
  importedReports: number;
  skippedAlreadyImported: number;
  retiredExistingTypedState: number;
  blockedSources: Array<{ sourceKind: string; sourcePath: string; reason: string }>;
}

export async function importLegacyReflectionReportState(
  baseDir: string,
  options: RuntimeControlDbStoreOptions = {},
): Promise<ReflectionReportLegacyImportReport> {
  const controlDb = options.controlDb ?? await openControlDatabase({
    baseDir: options.controlBaseDir ?? baseDir,
    dbPath: options.controlDbPath,
  });
  const report: ReflectionReportLegacyImportReport = {
    reflectionReportFiles: 0,
    importedReports: 0,
    skippedAlreadyImported: 0,
    retiredExistingTypedState: 0,
    blockedSources: [],
  };

  try {
    const dirPath = path.join(baseDir, LEGACY_REFLECTION_REPORT_DIR);
    let entries: string[];
    try {
      entries = await fsp.readdir(dirPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return report;
      blockImport(baseDir, dirPath, LEGACY_REFLECTION_REPORT_DIR, controlDb, report, error);
      return report;
    }

    const store = new ReflectionReportStateStore(baseDir, { ...options, controlDb });
    for (const entry of entries.sort()) {
      const descriptor = classifyLegacyReportFile(entry);
      if (!descriptor) continue;

      const filePath = path.join(dirPath, entry);
      const sourcePath = path.relative(baseDir, filePath);
      const sourceId = `${descriptor.reportType}:${descriptor.periodKey}`;
      report.reflectionReportFiles += 1;

      let payload: { raw: string; checksum: string; mtimeMs: number };
      try {
        payload = await readLegacyTextFile(filePath);
      } catch (error) {
        blockImport(baseDir, filePath, sourceId, controlDb, report, error);
        continue;
      }

      let rawReport: unknown;
      try {
        rawReport = JSON.parse(payload.raw) as unknown;
      } catch (error) {
        blockImport(baseDir, filePath, sourceId, controlDb, report, error, payload.checksum, payload.mtimeMs);
        continue;
      }

      const parsed = descriptor.schema.safeParse(rawReport);
      if (!parsed.success) {
        blockImport(baseDir, filePath, sourceId, controlDb, report, parsed.error, payload.checksum, payload.mtimeMs);
        continue;
      }

      if (hasCompletedLegacyImport(controlDb, sourceId)) {
        report.skippedAlreadyImported += 1;
        continue;
      }

      const existingReport = await store.load(descriptor.reportType, descriptor.periodKey);
      if (existingReport !== null) {
        report.retiredExistingTypedState += 1;
        controlDb.recordLegacyImport({
          sourceKind: "reflection_report",
          sourceId,
          sourcePath,
          sourceChecksum: payload.checksum,
          sourceMtimeMs: payload.mtimeMs,
          migrationName: MIGRATION_NAME,
          migrationVersion: MIGRATION_VERSION,
          status: "retired",
          details: {
            reason: "typed reflection report state already exists",
            report_type: descriptor.reportType,
            period_key: descriptor.periodKey,
          },
        });
        continue;
      }

      await store.save(
        descriptor.reportType,
        descriptor.periodKey,
        parsed.data as never,
      );
      report.importedReports += 1;
      controlDb.recordLegacyImport({
        sourceKind: "reflection_report",
        sourceId,
        sourcePath,
        sourceChecksum: payload.checksum,
        sourceMtimeMs: payload.mtimeMs,
        migrationName: MIGRATION_NAME,
        migrationVersion: MIGRATION_VERSION,
        status: "imported",
        details: {
          report_type: descriptor.reportType,
          period_key: descriptor.periodKey,
        },
      });
    }

    return report;
  } finally {
    if (!options.controlDb) controlDb.close();
  }
}

async function readLegacyTextFile(filePath: string): Promise<{ raw: string; checksum: string; mtimeMs: number }> {
  const [raw, stat] = await Promise.all([
    readTextFileWithinLimit(filePath, { maxBytes: LEGACY_REPORT_MAX_BYTES }),
    fsp.stat(filePath),
  ]);
  return {
    raw,
    checksum: createHash("sha256").update(raw, "utf8").digest("hex"),
    mtimeMs: stat.mtimeMs,
  };
}

function classifyLegacyReportFile(fileName: string): LegacyReportDescriptor | null {
  if (!fileName.endsWith(".json")) return null;
  const stem = fileName.slice(0, -".json".length);
  const separator = stem.indexOf("-");
  if (separator <= 0 || separator === stem.length - 1) return null;

  const prefix = stem.slice(0, separator);
  const periodKey = stem.slice(separator + 1);
  switch (prefix) {
    case "morning":
      return { reportType: "morning", periodKey, schema: PlanningReportSchema };
    case "evening":
      return { reportType: "evening", periodKey, schema: CatchupReportSchema };
    case "weekly":
      return { reportType: "weekly", periodKey, schema: WeeklyReviewReportSchema };
    case "dream":
      return { reportType: "dream", periodKey, schema: ConsolidationReportSchema };
    default:
      return null;
  }
}

function blockImport(
  baseDir: string,
  filePath: string,
  sourceId: string,
  controlDb: ControlDatabase,
  report: ReflectionReportLegacyImportReport,
  error: unknown,
  checksum?: string,
  mtimeMs?: number,
): void {
  const reason = error instanceof Error ? error.message : String(error);
  const sourcePath = path.relative(baseDir, filePath);
  report.blockedSources.push({ sourceKind: "reflection_report", sourcePath, reason });
  controlDb.recordLegacyImport({
    sourceKind: "reflection_report",
    sourceId,
    sourcePath,
    sourceChecksum: checksum ?? null,
    sourceMtimeMs: mtimeMs ?? null,
    migrationName: MIGRATION_NAME,
    migrationVersion: MIGRATION_VERSION,
    status: "blocked",
    details: { reason },
  });
}

function hasCompletedLegacyImport(controlDb: ControlDatabase, sourceId: string): boolean {
  return controlDb.listLegacyImports().some((record) =>
    record.source_kind === "reflection_report"
    && record.source_id === sourceId
    && record.migration_name === MIGRATION_NAME
    && record.status === "imported"
  );
}
