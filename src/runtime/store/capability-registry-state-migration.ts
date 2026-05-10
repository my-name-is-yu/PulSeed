import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import {
  openControlDatabase,
  type ControlDatabase,
  type RuntimeControlDbStoreOptions,
} from "./control-db/index.js";
import { CapabilityRegistryStateStore } from "./capability-registry-state-store.js";
import { CapabilityRegistrySchema } from "../../base/types/capability.js";

const MIGRATION_NAME = "capability-registry-state";
const MIGRATION_VERSION = 12;
const LEGACY_REGISTRY_PATH = "capability_registry.json";

export interface CapabilityRegistryLegacyImportReport {
  registryFiles: number;
  importedCapabilities: number;
  blockedSources: Array<{ sourceKind: string; sourcePath: string; reason: string }>;
}

export async function importLegacyCapabilityRegistryState(
  baseDir: string,
  options: RuntimeControlDbStoreOptions = {},
): Promise<CapabilityRegistryLegacyImportReport> {
  const controlDb = options.controlDb ?? await openControlDatabase({
    baseDir: options.controlBaseDir ?? baseDir,
    dbPath: options.controlDbPath,
  });
  const report: CapabilityRegistryLegacyImportReport = {
    registryFiles: 0,
    importedCapabilities: 0,
    blockedSources: [],
  };

  try {
    const filePath = path.join(baseDir, LEGACY_REGISTRY_PATH);
    let payload: { raw: string; checksum: string; mtimeMs: number };
    try {
      payload = await readLegacyTextFile(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return report;
      blockImport(baseDir, filePath, controlDb, report, error);
      return report;
    }

    try {
      const parsed = CapabilityRegistrySchema.parse(JSON.parse(payload.raw) as unknown);
      await new CapabilityRegistryStateStore(baseDir, { ...options, controlDb }).saveRegistry(parsed);
      report.registryFiles += 1;
      report.importedCapabilities += parsed.capabilities.length;
      controlDb.recordLegacyImport({
        sourceKind: "capability_registry",
        sourceId: "current",
        sourcePath: path.relative(baseDir, filePath),
        sourceChecksum: payload.checksum,
        sourceMtimeMs: payload.mtimeMs,
        migrationName: MIGRATION_NAME,
        migrationVersion: MIGRATION_VERSION,
        status: "imported",
        details: { capability_count: parsed.capabilities.length },
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
  report: CapabilityRegistryLegacyImportReport,
  error: unknown,
  checksum?: string,
  mtimeMs?: number,
): void {
  const reason = error instanceof Error ? error.message : String(error);
  report.blockedSources.push({
    sourceKind: "capability_registry",
    sourcePath: path.relative(baseDir, filePath),
    reason,
  });
  controlDb.recordLegacyImport({
    sourceKind: "capability_registry",
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
