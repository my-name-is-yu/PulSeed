import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import {
  openControlDatabase,
  type ControlDatabase,
  type RuntimeControlDbStoreOptions,
} from "./control-db/index.js";
import { EthicsLogSchema } from "../../base/types/ethics.js";
import { EthicsLogStore } from "./ethics-log-store.js";

const MIGRATION_NAME = "trust-ethics-profile-runtime-state";
const MIGRATION_VERSION = 15;
const LEGACY_ETHICS_LOG_PATH = path.join("ethics", "ethics-log.json");

export interface EthicsLogLegacyImportReport {
  ethicsLogFiles: number;
  importedLogs: number;
  blockedSources: Array<{ sourceKind: string; sourcePath: string; reason: string }>;
}

export async function importLegacyEthicsLogState(
  baseDir: string,
  options: RuntimeControlDbStoreOptions = {},
): Promise<EthicsLogLegacyImportReport> {
  const controlDb = options.controlDb ?? await openControlDatabase({
    baseDir: options.controlBaseDir ?? baseDir,
    dbPath: options.controlDbPath,
  });
  const report: EthicsLogLegacyImportReport = {
    ethicsLogFiles: 0,
    importedLogs: 0,
    blockedSources: [],
  };

  try {
    const filePath = path.join(baseDir, LEGACY_ETHICS_LOG_PATH);
    let payload: { raw: string; checksum: string; mtimeMs: number };
    try {
      payload = await readLegacyTextFile(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return report;
      blockImport(baseDir, filePath, controlDb, report, error);
      return report;
    }

    try {
      const raw = JSON.parse(payload.raw) as unknown;
      if (!Array.isArray(raw)) {
        throw new Error("legacy ethics log must be a JSON array");
      }
      const parsed = raw.map((entry) => EthicsLogSchema.parse(entry));
      await new EthicsLogStore(baseDir, { ...options, controlDb }).replaceLogs(parsed);
      report.ethicsLogFiles += 1;
      report.importedLogs += parsed.length;
      controlDb.recordLegacyImport({
        sourceKind: "ethics_log",
        sourceId: "current",
        sourcePath: path.relative(baseDir, filePath),
        sourceChecksum: payload.checksum,
        sourceMtimeMs: payload.mtimeMs,
        migrationName: MIGRATION_NAME,
        migrationVersion: MIGRATION_VERSION,
        status: "imported",
        details: { log_count: parsed.length },
      });
    } catch (error) {
      blockImport(baseDir, filePath, controlDb, report, error, payload.checksum, payload.mtimeMs);
    }

    return report;
  } finally {
    if (!options.controlDb) {
      controlDb.close();
    }
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
  controlDb: ControlDatabase,
  report: EthicsLogLegacyImportReport,
  error: unknown,
  checksum?: string,
  mtimeMs?: number,
): void {
  const reason = error instanceof Error ? error.message : String(error);
  report.blockedSources.push({
    sourceKind: "ethics_log",
    sourcePath: path.relative(baseDir, filePath),
    reason,
  });
  controlDb.recordLegacyImport({
    sourceKind: "ethics_log",
    sourceId: "current",
    sourcePath: path.relative(baseDir, filePath),
    sourceChecksum: checksum ?? null,
    sourceMtimeMs: mtimeMs ?? null,
    migrationName: MIGRATION_NAME,
    migrationVersion: MIGRATION_VERSION,
    status: "blocked",
    details: { reason },
  });
}
