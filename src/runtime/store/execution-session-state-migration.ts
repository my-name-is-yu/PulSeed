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
import { ExecutionSessionStateStore } from "./execution-session-state-store.js";
import { SessionSchema } from "../../base/types/session.js";

const MIGRATION_NAME = "execution-session-state";
const MIGRATION_VERSION = 11;

export interface ExecutionSessionLegacyImportReport {
  legacySessionFiles: number;
  importedSessions: number;
  legacyIndexFiles: number;
  staleIndexEntries: number;
  blockedSources: Array<{ sourceKind: string; sourcePath: string; reason: string }>;
}

interface LegacyFilePayload {
  raw: string;
  checksum: string;
  mtimeMs: number;
}

export async function importLegacyExecutionSessionState(
  baseDir: string,
  options: RuntimeControlDbStoreOptions = {},
): Promise<ExecutionSessionLegacyImportReport> {
  const controlDb = options.controlDb ?? await openControlDatabase({
    baseDir: options.controlBaseDir ?? baseDir,
    dbPath: options.controlDbPath,
  });
  const store = new ExecutionSessionStateStore(baseDir, { ...options, controlDb });
  const report: ExecutionSessionLegacyImportReport = {
    legacySessionFiles: 0,
    importedSessions: 0,
    legacyIndexFiles: 0,
    staleIndexEntries: 0,
    blockedSources: [],
  };

  try {
    await importLegacySessionFiles(baseDir, store, controlDb, report);
    await validateLegacySessionIndex(baseDir, controlDb, report);
    return report;
  } finally {
    if (!options.controlDb) {
      controlDb.close();
    }
  }
}

async function importLegacySessionFiles(
  baseDir: string,
  store: ExecutionSessionStateStore,
  controlDb: ControlDatabase,
  report: ExecutionSessionLegacyImportReport,
): Promise<void> {
  const sessionsDir = path.join(baseDir, "sessions");
  for (const entry of await readDir(sessionsDir)) {
    if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name === "index.json") continue;
    const filePath = path.join(sessionsDir, entry.name);
    let payload: LegacyFilePayload;
    try {
      payload = await readLegacyTextFile(filePath);
      const parsed = SessionSchema.parse(JSON.parse(payload.raw) as unknown);
      await store.save(parsed);
      report.legacySessionFiles += 1;
      report.importedSessions += 1;
      recordImport(controlDb, {
        sourceKind: "execution_session",
        sourceId: parsed.id,
        sourcePath: path.relative(baseDir, filePath),
        sourceChecksum: payload.checksum,
        sourceMtimeMs: payload.mtimeMs,
        status: "imported",
        details: { session_type: parsed.session_type, goal_id: parsed.goal_id },
      });
    } catch (error) {
      blockImport({
        baseDir,
        filePath,
        sourceKind: "execution_session",
        sourceId: path.basename(entry.name, ".json"),
        controlDb,
        report,
      }, error);
    }
  }
}

async function validateLegacySessionIndex(
  baseDir: string,
  controlDb: ControlDatabase,
  report: ExecutionSessionLegacyImportReport,
): Promise<void> {
  const indexPath = path.join(baseDir, "sessions", "index.json");
  let payload: LegacyFilePayload;
  try {
    payload = await readLegacyTextFile(indexPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    blockImport({
      baseDir,
      filePath: indexPath,
      sourceKind: "execution_session_index",
      sourceId: "index",
      controlDb,
      report,
    }, error);
    return;
  }

  try {
    report.legacyIndexFiles += 1;
    const parsed = JSON.parse(payload.raw) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error("legacy sessions/index.json is not an array");
    }
    let staleEntries = 0;
    for (const item of parsed) {
      if (typeof item !== "string") continue;
      try {
        await fsp.access(path.join(baseDir, "sessions", `${item}.json`));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          staleEntries += 1;
          continue;
        }
        throw error;
      }
    }
    report.staleIndexEntries += staleEntries;
    recordImport(controlDb, {
      sourceKind: "execution_session_index",
      sourceId: "index",
      sourcePath: path.relative(baseDir, indexPath),
      sourceChecksum: payload.checksum,
      sourceMtimeMs: payload.mtimeMs,
      status: "validated",
      details: { stale_entries: staleEntries },
    });
  } catch (error) {
    blockImport({
      baseDir,
      filePath: indexPath,
      sourceKind: "execution_session_index",
      sourceId: "index",
      controlDb,
      report,
      checksum: payload.checksum,
      mtimeMs: payload.mtimeMs,
    }, error);
  }
}

async function readDir(dirPath: string): Promise<Dirent[]> {
  try {
    return await fsp.readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function readLegacyTextFile(filePath: string): Promise<LegacyFilePayload> {
  const [raw, stat] = await Promise.all([
    fsp.readFile(filePath, "utf8"),
    fsp.stat(filePath),
  ]);
  return {
    raw,
    checksum: createHash("sha256").update(raw).digest("hex"),
    mtimeMs: stat.mtimeMs,
  };
}

function recordImport(
  controlDb: ControlDatabase,
  input: {
    sourceKind: string;
    sourceId: string;
    sourcePath: string;
    sourceChecksum?: string;
    sourceMtimeMs?: number;
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
    migrationName: MIGRATION_NAME,
    migrationVersion: MIGRATION_VERSION,
    status: input.status,
    details: input.details,
  });
}

function blockImport(
  context: {
    baseDir: string;
    filePath: string;
    sourceKind: string;
    sourceId: string;
    controlDb: ControlDatabase;
    report: ExecutionSessionLegacyImportReport;
    checksum?: string;
    mtimeMs?: number;
  },
  error: unknown,
): void {
  const reason = error instanceof Error ? error.message : String(error);
  const sourcePath = path.relative(context.baseDir, context.filePath);
  context.report.blockedSources.push({
    sourceKind: context.sourceKind,
    sourcePath,
    reason,
  });
  recordImport(context.controlDb, {
    sourceKind: context.sourceKind,
    sourceId: context.sourceId,
    sourcePath,
    sourceChecksum: context.checksum,
    sourceMtimeMs: context.mtimeMs,
    status: "blocked",
    details: { reason },
  });
}
