import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import {
  openControlDatabase,
  type ControlDatabase,
  type ControlLegacyImportStatus,
  type RuntimeControlDbStoreOptions,
} from "./control-db/index.js";
import {
  CAPABILITY_DEPENDENCIES_PATH,
  CapabilityRegistryStateStore,
} from "./capability-registry-state-store.js";
import {
  CapabilityDependencySchema,
  CapabilityRegistrySchema,
} from "../../base/types/capability.js";

const MIGRATION_NAME = "capability-registry-state";
const MIGRATION_VERSION = 12;
const LEGACY_REGISTRY_PATH = "capability_registry.json";
const DEPENDENCY_MIGRATION_NAME = "capability-dependency-state";
const DEPENDENCY_MIGRATION_VERSION = 22;

export interface CapabilityRegistryLegacyImportReport {
  registryFiles: number;
  importedCapabilities: number;
  blockedSources: Array<{ sourceKind: string; sourcePath: string; reason: string }>;
}

export interface CapabilityDependencyLegacyImportReport {
  dependencyFiles: number;
  dependencies: number;
  skippedAlreadyImported: number;
  retiredExistingTypedState: number;
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

export async function importLegacyCapabilityDependencyState(
  baseDir: string,
  options: RuntimeControlDbStoreOptions = {},
): Promise<CapabilityDependencyLegacyImportReport> {
  const controlDb = options.controlDb ?? await openControlDatabase({
    baseDir: options.controlBaseDir ?? baseDir,
    dbPath: options.controlDbPath,
  });
  const store = new CapabilityRegistryStateStore(baseDir, { ...options, controlDb });
  const report: CapabilityDependencyLegacyImportReport = {
    dependencyFiles: 0,
    dependencies: 0,
    skippedAlreadyImported: 0,
    retiredExistingTypedState: 0,
    blockedSources: [],
  };

  const sourceKind = "capability_dependency_state";
  const sourceId = "current";
  const filePath = path.join(baseDir, CAPABILITY_DEPENDENCIES_PATH);
  try {
    if (hasCompletedDependencyImportRecord(controlDb, sourceKind, sourceId)) {
      report.skippedAlreadyImported += 1;
      return report;
    }

    let payload: { raw: string; checksum: string; mtimeMs: number };
    try {
      payload = await readLegacyTextFile(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return report;
      blockDependencyImport(baseDir, filePath, sourceKind, sourceId, controlDb, report, error);
      return report;
    }

    try {
      if (await store.hasDependencies()) {
        report.retiredExistingTypedState += 1;
        recordDependencyImport(controlDb, {
          sourceKind,
          sourceId,
          sourcePath: path.relative(baseDir, filePath),
          sourceChecksum: payload.checksum,
          sourceMtimeMs: payload.mtimeMs,
          status: "retired",
          details: { reason: "typed capability dependency state already exists" },
        });
        return report;
      }
    } catch (error) {
      blockDependencyImport(baseDir, filePath, sourceKind, sourceId, controlDb, report, error, payload);
      return report;
    }

    try {
      const parsed = CapabilityDependencySchema.array().parse(JSON.parse(payload.raw) as unknown);
      await store.saveDependencies(parsed);
      report.dependencyFiles += 1;
      report.dependencies += parsed.length;
      recordDependencyImport(controlDb, {
        sourceKind,
        sourceId,
        sourcePath: path.relative(baseDir, filePath),
        sourceChecksum: payload.checksum,
        sourceMtimeMs: payload.mtimeMs,
        status: "imported",
        details: { dependency_count: parsed.length },
      });
      return report;
    } catch (error) {
      blockDependencyImport(baseDir, filePath, sourceKind, sourceId, controlDb, report, error, payload);
      return report;
    }
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

function recordDependencyImport(
  controlDb: ControlDatabase,
  input: {
    sourceKind: string;
    sourceId: string;
    sourcePath: string;
    sourceChecksum: string;
    sourceMtimeMs: number;
    status: ControlLegacyImportStatus;
    details: Record<string, unknown>;
  },
): void {
  controlDb.recordLegacyImport({
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    sourcePath: input.sourcePath,
    sourceChecksum: input.sourceChecksum,
    sourceMtimeMs: input.sourceMtimeMs,
    migrationName: DEPENDENCY_MIGRATION_NAME,
    migrationVersion: DEPENDENCY_MIGRATION_VERSION,
    status: input.status,
    details: input.details,
    retiredAt: input.status === "retired" ? new Date().toISOString() : null,
  });
}

function hasCompletedDependencyImportRecord(controlDb: ControlDatabase, sourceKind: string, sourceId: string): boolean {
  return controlDb.listLegacyImports().some((record) =>
    record.source_kind === sourceKind
    && record.source_id === sourceId
    && record.migration_name === DEPENDENCY_MIGRATION_NAME
    && (record.status === "imported" || record.status === "retired")
  );
}

function blockDependencyImport(
  baseDir: string,
  filePath: string,
  sourceKind: string,
  sourceId: string,
  controlDb: ControlDatabase,
  report: CapabilityDependencyLegacyImportReport,
  error: unknown,
  payload?: { checksum: string; mtimeMs: number },
): void {
  const reason = error instanceof Error ? error.message : String(error);
  report.blockedSources.push({
    sourceKind,
    sourcePath: path.relative(baseDir, filePath),
    reason,
  });
  controlDb.recordLegacyImport({
    sourceKind,
    sourceId,
    sourcePath: path.relative(baseDir, filePath),
    sourceChecksum: payload?.checksum ?? null,
    sourceMtimeMs: payload?.mtimeMs ?? null,
    migrationName: DEPENDENCY_MIGRATION_NAME,
    migrationVersion: DEPENDENCY_MIGRATION_VERSION,
    status: "blocked",
    details: { reason },
  });
}
