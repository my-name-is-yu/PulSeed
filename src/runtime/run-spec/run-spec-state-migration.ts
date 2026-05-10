import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import {
  openControlDatabase,
  type ControlDatabase,
  type RuntimeControlDbStoreOptions,
} from "../store/control-db/index.js";
import { createRunSpecStore } from "./store.js";
import { RunSpecSchema } from "./types.js";

const MIGRATION_NAME = "run-spec-runtime-state";
const MIGRATION_VERSION = 23;
const LEGACY_RUN_SPEC_DIR = "run-specs";

export interface RunSpecLegacyImportReport {
  runSpecFiles: number;
  importedRunSpecs: number;
  skippedAlreadyImported: number;
  blockedSources: Array<{ sourceKind: string; sourcePath: string; reason: string }>;
}

export async function importLegacyRunSpecState(
  baseDir: string,
  options: RuntimeControlDbStoreOptions = {},
): Promise<RunSpecLegacyImportReport> {
  const controlDb = options.controlDb ?? await openControlDatabase({
    baseDir: options.controlBaseDir ?? baseDir,
    dbPath: options.controlDbPath,
  });
  const report: RunSpecLegacyImportReport = {
    runSpecFiles: 0,
    importedRunSpecs: 0,
    skippedAlreadyImported: 0,
    blockedSources: [],
  };

  try {
    const legacyDir = path.join(baseDir, LEGACY_RUN_SPEC_DIR);
    let entries: string[];
    try {
      entries = await fsp.readdir(legacyDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return report;
      blockImport(baseDir, legacyDir, "directory", controlDb, report, error);
      return report;
    }

    const store = createRunSpecStore({ getBaseDir: () => baseDir }, { ...options, controlDb });
    for (const entry of entries.sort()) {
      if (!entry.endsWith(".json")) continue;
      const filePath = path.join(legacyDir, entry);
      report.runSpecFiles += 1;
      let payload: { raw: string; checksum: string; mtimeMs: number };
      try {
        payload = await readLegacyTextFile(filePath);
      } catch (error) {
        blockImport(baseDir, filePath, entry, controlDb, report, error);
        continue;
      }

      try {
        const parsed = RunSpecSchema.parse(JSON.parse(payload.raw) as unknown);
        if (hasCompletedLegacyImport(controlDb, parsed.id)) {
          report.skippedAlreadyImported += 1;
          continue;
        }
        await store.save(parsed);
        report.importedRunSpecs += 1;
        controlDb.recordLegacyImport({
          sourceKind: "run_spec",
          sourceId: parsed.id,
          sourcePath: path.relative(baseDir, filePath),
          sourceChecksum: payload.checksum,
          sourceMtimeMs: payload.mtimeMs,
          migrationName: MIGRATION_NAME,
          migrationVersion: MIGRATION_VERSION,
          status: "imported",
          details: {
            status: parsed.status,
            profile: parsed.profile,
            goal_id: parsed.links.goal_id,
            runtime_session_id: parsed.links.runtime_session_id,
            conversation_id: parsed.links.conversation_id,
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
  report: RunSpecLegacyImportReport,
  error: unknown,
  checksum?: string,
  mtimeMs?: number,
): void {
  const reason = error instanceof Error ? error.message : String(error);
  const sourcePath = path.relative(baseDir, filePath);
  report.blockedSources.push({ sourceKind: "run_spec", sourcePath, reason });
  controlDb.recordLegacyImport({
    sourceKind: "run_spec",
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
    record.source_kind === "run_spec"
    && record.source_id === sourceId
    && record.migration_name === MIGRATION_NAME
    && record.status === "imported"
  );
}
