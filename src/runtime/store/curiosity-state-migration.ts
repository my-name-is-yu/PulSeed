import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import {
  openControlDatabase,
  type ControlDatabase,
  type RuntimeControlDbStoreOptions,
} from "./control-db/index.js";
import { CuriosityStateSchema } from "../../base/types/curiosity.js";
import { CuriosityStateStore } from "./curiosity-state-store.js";

const MIGRATION_NAME = "curiosity-runtime-state";
const MIGRATION_VERSION = 14;
const LEGACY_CURIOSITY_STATE_PATH = path.join("curiosity", "state.json");

export interface CuriosityStateLegacyImportReport {
  stateFiles: number;
  importedProposals: number;
  importedLearningRecords: number;
  importedRejectedHashes: number;
  blockedSources: Array<{ sourceKind: string; sourcePath: string; reason: string }>;
}

export async function importLegacyCuriosityState(
  baseDir: string,
  options: RuntimeControlDbStoreOptions = {},
): Promise<CuriosityStateLegacyImportReport> {
  const controlDb = options.controlDb ?? await openControlDatabase({
    baseDir: options.controlBaseDir ?? baseDir,
    dbPath: options.controlDbPath,
  });
  const report: CuriosityStateLegacyImportReport = {
    stateFiles: 0,
    importedProposals: 0,
    importedLearningRecords: 0,
    importedRejectedHashes: 0,
    blockedSources: [],
  };

  try {
    const filePath = path.join(baseDir, LEGACY_CURIOSITY_STATE_PATH);
    let payload: { raw: string; checksum: string; mtimeMs: number };
    try {
      payload = await readLegacyTextFile(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return report;
      blockImport(baseDir, filePath, controlDb, report, error);
      return report;
    }

    try {
      const parsed = CuriosityStateSchema.parse(JSON.parse(payload.raw) as unknown);
      await new CuriosityStateStore(baseDir, { ...options, controlDb }).save(parsed);
      report.stateFiles += 1;
      report.importedProposals += parsed.proposals.length;
      report.importedLearningRecords += parsed.learning_records.length;
      report.importedRejectedHashes += parsed.rejected_proposal_hashes.length;
      controlDb.recordLegacyImport({
        sourceKind: "curiosity_state",
        sourceId: "current",
        sourcePath: path.relative(baseDir, filePath),
        sourceChecksum: payload.checksum,
        sourceMtimeMs: payload.mtimeMs,
        migrationName: MIGRATION_NAME,
        migrationVersion: MIGRATION_VERSION,
        status: "imported",
        details: {
          proposal_count: parsed.proposals.length,
          learning_record_count: parsed.learning_records.length,
          rejected_hash_count: parsed.rejected_proposal_hashes.length,
        },
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
  report: CuriosityStateLegacyImportReport,
  error: unknown,
  checksum?: string,
  mtimeMs?: number,
): void {
  const reason = error instanceof Error ? error.message : String(error);
  report.blockedSources.push({
    sourceKind: "curiosity_state",
    sourcePath: path.relative(baseDir, filePath),
    reason,
  });
  controlDb.recordLegacyImport({
    sourceKind: "curiosity_state",
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
