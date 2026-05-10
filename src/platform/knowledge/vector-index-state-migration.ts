import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
  openControlDatabase,
  type ControlDatabase,
  type RuntimeControlDbStoreOptions,
} from "../../runtime/store/control-db/index.js";
import { EmbeddingEntrySchema } from "../../base/types/embedding.js";
import { VectorIndexStateStore } from "./vector-index-state-store.js";

const MIGRATION_NAME = "knowledge-vector-graph-runtime-state";
const MIGRATION_VERSION = 26;
const LEGACY_VECTOR_INDEX_FILE = path.join("memory", "vector-index.json");

export interface VectorIndexLegacyImportReport {
  vectorIndexFiles: number;
  importedEntries: number;
  skippedAlreadyImported: number;
  retiredExistingTypedState: number;
  blockedSources: Array<{ sourceKind: string; sourcePath: string; reason: string }>;
}

export async function importLegacyVectorIndexState(
  baseDir: string,
  options: RuntimeControlDbStoreOptions = {},
): Promise<VectorIndexLegacyImportReport> {
  const controlDb = options.controlDb ?? await openControlDatabase({
    baseDir: options.controlBaseDir ?? baseDir,
    dbPath: options.controlDbPath,
  });
  const report: VectorIndexLegacyImportReport = {
    vectorIndexFiles: 0,
    importedEntries: 0,
    skippedAlreadyImported: 0,
    retiredExistingTypedState: 0,
    blockedSources: [],
  };

  try {
    const filePath = path.join(baseDir, LEGACY_VECTOR_INDEX_FILE);
    let payload: { raw: string; checksum: string; mtimeMs: number };
    try {
      payload = await readLegacyTextFile(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return report;
      blockImport(baseDir, filePath, LEGACY_VECTOR_INDEX_FILE, controlDb, report, error);
      return report;
    }

    report.vectorIndexFiles = 1;
    let rawEntries: unknown;
    try {
      rawEntries = JSON.parse(payload.raw) as unknown;
    } catch (error) {
      blockImport(baseDir, filePath, LEGACY_VECTOR_INDEX_FILE, controlDb, report, error, payload.checksum, payload.mtimeMs);
      return report;
    }

    if (!Array.isArray(rawEntries)) {
      blockImport(
        baseDir,
        filePath,
        LEGACY_VECTOR_INDEX_FILE,
        controlDb,
        report,
        new Error("legacy vector index file must contain an array"),
        payload.checksum,
        payload.mtimeMs,
      );
      return report;
    }

    const store = new VectorIndexStateStore(baseDir, { ...options, controlDb });
    for (const [index, item] of rawEntries.entries()) {
      const parsed = EmbeddingEntrySchema.safeParse(item);
      const sourceId = parsed.success ? parsed.data.id : `${LEGACY_VECTOR_INDEX_FILE}#${index}`;
      if (!parsed.success) {
        blockImport(baseDir, filePath, sourceId, controlDb, report, parsed.error, payload.checksum, payload.mtimeMs);
        continue;
      }

      if (hasCompletedLegacyImport(controlDb, parsed.data.id)) {
        report.skippedAlreadyImported += 1;
        continue;
      }

      const existingEntry = await store.load(parsed.data.id);
      if (existingEntry !== null) {
        report.retiredExistingTypedState += 1;
        controlDb.recordLegacyImport({
          sourceKind: "vector_index_entry",
          sourceId: parsed.data.id,
          sourcePath: path.relative(baseDir, filePath),
          sourceChecksum: payload.checksum,
          sourceMtimeMs: payload.mtimeMs,
          migrationName: MIGRATION_NAME,
          migrationVersion: MIGRATION_VERSION,
          status: "retired",
          details: { reason: "typed vector index entry already exists" },
        });
        continue;
      }

      await store.save(parsed.data);
      report.importedEntries += 1;
      controlDb.recordLegacyImport({
        sourceKind: "vector_index_entry",
        sourceId: parsed.data.id,
        sourcePath: path.relative(baseDir, filePath),
        sourceChecksum: payload.checksum,
        sourceMtimeMs: payload.mtimeMs,
        migrationName: MIGRATION_NAME,
        migrationVersion: MIGRATION_VERSION,
        status: "imported",
        details: {
          model: parsed.data.model,
          created_at: parsed.data.created_at,
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
  report: VectorIndexLegacyImportReport,
  error: unknown,
  checksum?: string,
  mtimeMs?: number,
): void {
  const reason = error instanceof Error ? error.message : String(error);
  const sourcePath = path.relative(baseDir, filePath);
  report.blockedSources.push({ sourceKind: "vector_index_entry", sourcePath, reason });
  controlDb.recordLegacyImport({
    sourceKind: "vector_index_entry",
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
    record.source_kind === "vector_index_entry"
    && record.source_id === sourceId
    && record.migration_name === MIGRATION_NAME
    && record.status === "imported"
  );
}
