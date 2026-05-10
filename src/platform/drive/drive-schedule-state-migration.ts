import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
  openControlDatabase,
  type ControlDatabase,
  type RuntimeControlDbStoreOptions,
} from "../../runtime/store/control-db/index.js";
import { DriveGoalScheduleStateStore } from "./drive-schedule-state-store.js";
import { GoalScheduleSchema } from "./types/drive.js";

const MIGRATION_NAME = "drive-goal-activation-schedule-state";
const MIGRATION_VERSION = 24;
const LEGACY_SCHEDULE_DIR = "schedule";

export interface DriveGoalScheduleLegacyImportReport {
  scheduleFiles: number;
  importedSchedules: number;
  skippedAlreadyImported: number;
  blockedSources: Array<{ sourceKind: string; sourcePath: string; reason: string }>;
}

export async function importLegacyDriveGoalScheduleState(
  baseDir: string,
  options: RuntimeControlDbStoreOptions = {},
): Promise<DriveGoalScheduleLegacyImportReport> {
  const controlDb = options.controlDb ?? await openControlDatabase({
    baseDir: options.controlBaseDir ?? baseDir,
    dbPath: options.controlDbPath,
  });
  const report: DriveGoalScheduleLegacyImportReport = {
    scheduleFiles: 0,
    importedSchedules: 0,
    skippedAlreadyImported: 0,
    blockedSources: [],
  };

  try {
    const legacyDir = path.join(baseDir, LEGACY_SCHEDULE_DIR);
    let entries: string[];
    try {
      entries = await fsp.readdir(legacyDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return report;
      blockImport(baseDir, legacyDir, "directory", controlDb, report, error);
      return report;
    }

    const store = new DriveGoalScheduleStateStore(baseDir, { ...options, controlDb });
    for (const entry of entries.sort()) {
      if (!entry.endsWith(".json")) continue;
      const filePath = path.join(legacyDir, entry);
      report.scheduleFiles += 1;
      let payload: { raw: string; checksum: string; mtimeMs: number };
      try {
        payload = await readLegacyTextFile(filePath);
      } catch (error) {
        blockImport(baseDir, filePath, entry, controlDb, report, error);
        continue;
      }

      try {
        const parsed = GoalScheduleSchema.parse(JSON.parse(payload.raw) as unknown);
        if (hasCompletedLegacyImport(controlDb, parsed.goal_id)) {
          report.skippedAlreadyImported += 1;
          continue;
        }
        await store.save(parsed.goal_id, parsed);
        report.importedSchedules += 1;
        controlDb.recordLegacyImport({
          sourceKind: "drive_goal_schedule",
          sourceId: parsed.goal_id,
          sourcePath: path.relative(baseDir, filePath),
          sourceChecksum: payload.checksum,
          sourceMtimeMs: payload.mtimeMs,
          migrationName: MIGRATION_NAME,
          migrationVersion: MIGRATION_VERSION,
          status: "imported",
          details: {
            next_check_at: parsed.next_check_at,
            check_interval_hours: parsed.check_interval_hours,
            cooldown_until: parsed.cooldown_until,
          },
        });
      } catch (error) {
        blockImport(baseDir, filePath, entry, controlDb, report, error, payload.checksum, payload.mtimeMs);
      }
    }

    return report;
  } finally {
    if (!options.controlDb) controlDb.close();
  }
}

async function readLegacyTextFile(filePath: string): Promise<{ raw: string; checksum: string; mtimeMs: number }> {
  const [raw, stat] = await Promise.all([
    fsp.readFile(filePath, "utf8"),
    fsp.stat(filePath),
  ]);
  return {
    raw,
    checksum: createHash("sha256").update(raw, "utf8").digest("hex"),
    mtimeMs: stat.mtimeMs,
  };
}

function blockImport(
  baseDir: string,
  filePath: string,
  sourceId: string,
  controlDb: ControlDatabase,
  report: DriveGoalScheduleLegacyImportReport,
  error: unknown,
  checksum?: string,
  mtimeMs?: number,
): void {
  const reason = error instanceof Error ? error.message : String(error);
  const sourcePath = path.relative(baseDir, filePath);
  report.blockedSources.push({ sourceKind: "drive_goal_schedule", sourcePath, reason });
  controlDb.recordLegacyImport({
    sourceKind: "drive_goal_schedule",
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
    record.source_kind === "drive_goal_schedule"
    && record.source_id === sourceId
    && record.migration_name === MIGRATION_NAME
    && record.status === "imported"
  );
}
