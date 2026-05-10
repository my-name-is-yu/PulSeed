import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import {
  openControlDatabase,
  type ControlDatabase,
  type RuntimeControlDbStoreOptions,
} from "./control-db/index.js";
import { TrustStoreSchema } from "../../base/types/trust.js";
import { TrustStateStore } from "./trust-state-store.js";

const MIGRATION_NAME = "trust-ethics-profile-runtime-state";
const MIGRATION_VERSION = 15;
const LEGACY_TRUST_STORE_PATH = path.join("trust", "trust-store.json");

export interface TrustStateLegacyImportReport {
  trustStoreFiles: number;
  importedBalances: number;
  importedPermanentGates: number;
  importedOverrideEvents: number;
  blockedSources: Array<{ sourceKind: string; sourcePath: string; reason: string }>;
}

export async function importLegacyTrustState(
  baseDir: string,
  options: RuntimeControlDbStoreOptions = {},
): Promise<TrustStateLegacyImportReport> {
  const controlDb = options.controlDb ?? await openControlDatabase({
    baseDir: options.controlBaseDir ?? baseDir,
    dbPath: options.controlDbPath,
  });
  const report: TrustStateLegacyImportReport = {
    trustStoreFiles: 0,
    importedBalances: 0,
    importedPermanentGates: 0,
    importedOverrideEvents: 0,
    blockedSources: [],
  };

  try {
    const filePath = path.join(baseDir, LEGACY_TRUST_STORE_PATH);
    let payload: { raw: string; checksum: string; mtimeMs: number };
    try {
      payload = await readLegacyTextFile(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return report;
      blockImport(baseDir, filePath, controlDb, report, error);
      return report;
    }

    try {
      const parsed = TrustStoreSchema.parse(JSON.parse(payload.raw) as unknown);
      await new TrustStateStore(baseDir, { ...options, controlDb }).saveStore(parsed);
      report.trustStoreFiles += 1;
      report.importedBalances += Object.keys(parsed.balances).length;
      report.importedPermanentGates += Object.values(parsed.permanent_gates)
        .reduce((count, gates) => count + gates.length, 0);
      report.importedOverrideEvents += parsed.override_log.length;
      controlDb.recordLegacyImport({
        sourceKind: "trust_state",
        sourceId: "current",
        sourcePath: path.relative(baseDir, filePath),
        sourceChecksum: payload.checksum,
        sourceMtimeMs: payload.mtimeMs,
        migrationName: MIGRATION_NAME,
        migrationVersion: MIGRATION_VERSION,
        status: "imported",
        details: {
          balance_count: Object.keys(parsed.balances).length,
          permanent_gate_count: report.importedPermanentGates,
          override_event_count: parsed.override_log.length,
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
  report: TrustStateLegacyImportReport,
  error: unknown,
  checksum?: string,
  mtimeMs?: number,
): void {
  const reason = error instanceof Error ? error.message : String(error);
  report.blockedSources.push({
    sourceKind: "trust_state",
    sourcePath: path.relative(baseDir, filePath),
    reason,
  });
  controlDb.recordLegacyImport({
    sourceKind: "trust_state",
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
