import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import {
  openControlDatabase,
  type ControlDatabase,
  type ControlLegacyImportStatus,
  type RuntimeControlDbStoreOptions,
} from "./control-db/index.js";
import { StallStateStore } from "./stall-state-store.js";
import { StallStateSchema } from "../../base/types/stall.js";

const MIGRATION_NAME = "stall-runtime-state";
const MIGRATION_VERSION = 18;

export interface StallStateLegacyImportReport {
  stallStates: number;
  skippedAlreadyImported: number;
  retiredExistingTypedState: number;
  blockedSources: Array<{ sourceKind: string; sourcePath: string; reason: string }>;
}

export async function importLegacyStallState(
  baseDir: string,
  options: RuntimeControlDbStoreOptions = {},
): Promise<StallStateLegacyImportReport> {
  const controlDb = options.controlDb ?? await openControlDatabase({
    baseDir: options.controlBaseDir ?? baseDir,
    dbPath: options.controlDbPath,
  });
  const store = new StallStateStore(baseDir, { ...options, controlDb });
  const report: StallStateLegacyImportReport = {
    stallStates: 0,
    skippedAlreadyImported: 0,
    retiredExistingTypedState: 0,
    blockedSources: [],
  };

  try {
    await importStallFiles(baseDir, store, controlDb, report);
    return report;
  } finally {
    if (!options.controlDb) {
      controlDb.close();
    }
  }
}

async function importStallFiles(
  baseDir: string,
  store: StallStateStore,
  controlDb: ControlDatabase,
  report: StallStateLegacyImportReport,
): Promise<void> {
  const stallsDir = path.join(baseDir, "stalls");
  for (const entry of await readDir(stallsDir)) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const goalId = entry.name.slice(0, -".json".length);
    const filePath = path.join(stallsDir, entry.name);
    if (hasCompletedImportRecord(controlDb, goalId)) {
      report.skippedAlreadyImported += 1;
      continue;
    }

    let payload: { raw: string; checksum: string; mtimeMs: number };
    try {
      payload = await readLegacyTextFile(filePath);
    } catch (error) {
      blockImport(baseDir, filePath, goalId, controlDb, report, error);
      continue;
    }

    try {
      if (await store.loadStallState(goalId) !== null) {
        report.retiredExistingTypedState += 1;
        recordImport(controlDb, {
          sourceId: goalId,
          sourcePath: path.relative(baseDir, filePath),
          sourceChecksum: payload.checksum,
          sourceMtimeMs: payload.mtimeMs,
          status: "retired",
          details: { reason: "typed stall state already exists" },
        });
        continue;
      }
    } catch (error) {
      blockImport(baseDir, filePath, goalId, controlDb, report, error, payload);
      continue;
    }

    try {
      const parsed = StallStateSchema.parse(JSON.parse(payload.raw) as unknown);
      await store.saveStallState(goalId, parsed);
      report.stallStates += 1;
      recordImport(controlDb, {
        sourceId: goalId,
        sourcePath: path.relative(baseDir, filePath),
        sourceChecksum: payload.checksum,
        sourceMtimeMs: payload.mtimeMs,
        status: "imported",
        details: { goal_id: parsed.goal_id },
      });
    } catch (error) {
      blockImport(baseDir, filePath, goalId, controlDb, report, error, payload);
    }
  }
}

async function readDir(dir: string): Promise<Dirent[]> {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
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

function recordImport(
  controlDb: ControlDatabase,
  input: {
    sourceId: string;
    sourcePath: string;
    sourceChecksum: string;
    sourceMtimeMs: number;
    status: ControlLegacyImportStatus;
    details: Record<string, unknown>;
  },
): void {
  controlDb.recordLegacyImport({
    sourceKind: "stall_state",
    sourceId: input.sourceId,
    sourcePath: input.sourcePath,
    sourceChecksum: input.sourceChecksum,
    sourceMtimeMs: input.sourceMtimeMs,
    migrationName: MIGRATION_NAME,
    migrationVersion: MIGRATION_VERSION,
    status: input.status,
    details: input.details,
    retiredAt: input.status === "retired" ? new Date().toISOString() : null,
  });
}

function hasCompletedImportRecord(controlDb: ControlDatabase, goalId: string): boolean {
  return controlDb.listLegacyImports().some((record) =>
    record.source_kind === "stall_state"
    && record.source_id === goalId
    && record.migration_name === MIGRATION_NAME
    && (record.status === "imported" || record.status === "retired")
  );
}

function blockImport(
  baseDir: string,
  filePath: string,
  goalId: string,
  controlDb: ControlDatabase,
  report: StallStateLegacyImportReport,
  error: unknown,
  payload?: { checksum: string; mtimeMs: number },
): void {
  const reason = error instanceof Error ? error.message : String(error);
  const sourcePath = path.relative(baseDir, filePath);
  report.blockedSources.push({ sourceKind: "stall_state", sourcePath, reason });
  controlDb.recordLegacyImport({
    sourceKind: "stall_state",
    sourceId: goalId,
    sourcePath,
    sourceChecksum: payload?.checksum ?? null,
    sourceMtimeMs: payload?.mtimeMs ?? null,
    migrationName: MIGRATION_NAME,
    migrationVersion: MIGRATION_VERSION,
    status: "blocked",
    details: { reason },
  });
}
