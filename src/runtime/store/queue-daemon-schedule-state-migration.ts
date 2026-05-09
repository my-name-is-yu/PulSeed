import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { readJsonFileOrNull } from "../../base/utils/json-io.js";
import { DaemonStateSchema } from "../../base/types/daemon.js";
import { JournalBackedQueue } from "../queue/journal-backed-queue.js";
import { ShutdownMarkerSchema } from "../daemon/types.js";
import { ScheduleRunHistoryRecordSchema } from "../schedule/history.js";
import { parsePersistedScheduleEntries } from "../schedule/entry-normalization.js";
import { ScheduleEntryStore } from "../schedule/entry-store.js";
import { ScheduleHistoryStore } from "../schedule/history.js";
import {
  SupervisorStateSchema,
  SupervisorStateStore,
} from "./supervisor-state-store.js";
import {
  DaemonShutdownStore,
  DaemonStateStore,
} from "./daemon-state-store.js";
import {
  openControlDatabase,
  type ControlDatabase,
  type ControlLegacyImportRecord,
  type ControlLegacyImportStatus,
  type RuntimeControlDbStoreOptions,
} from "./control-db/index.js";

const QUEUE_DAEMON_SCHEDULE_IMPORT_MIGRATION_VERSION = 4;

export interface ImportLegacyQueueDaemonScheduleStateInput extends RuntimeControlDbStoreOptions {
  baseDir: string;
  runtimeRoot?: string;
  importedAt?: string;
}

export interface ImportLegacyQueueDaemonScheduleStateResult {
  queueRecords: number;
  daemonState: boolean;
  shutdownMarker: boolean;
  supervisorState: boolean;
  scheduleEntries: number;
  scheduleHistoryRecords: number;
  legacyImports: ControlLegacyImportRecord[];
}

export async function importLegacyQueueDaemonScheduleState(
  input: ImportLegacyQueueDaemonScheduleStateInput
): Promise<ImportLegacyQueueDaemonScheduleStateResult> {
  const runtimeRoot = input.runtimeRoot ?? path.join(input.baseDir, "runtime");
  const providedDb = input.controlDb !== undefined;
  const controlDb = input.controlDb ?? await openControlDatabase({
    baseDir: input.controlBaseDir ?? input.baseDir,
    dbPath: input.controlDbPath,
  });
  const storeOptions = { controlDb };
  const legacyImports: ControlLegacyImportRecord[] = [];

  try {
    const queuePath = path.join(runtimeRoot, "queue.json");
    const queueRaw = await readJsonFileOrNull(queuePath);
    let queueRecords = 0;
    const queueImport = terminalLegacyImport(controlDb, "runtime-queue-json", "queue", "runtime-queue-json-import");
    const queueDbPresent = hasRows(controlDb, "runtime_queue_records");
    const queueValid = isLegacyQueueState(queueRaw);
    if (queueImport) {
      legacyImports.push(queueImport);
    } else if (queueValid && !queueDbPresent) {
      const queue = new JournalBackedQueue({
        journalPath: queuePath,
        controlDb,
      });
      const snapshot = queue.importLegacyState(queueRaw);
      queueRecords =
        Object.values(snapshot.pending).reduce((total, ids) => total + ids.length, 0)
        + Object.keys(snapshot.inflight).length
        + snapshot.completed.length
        + snapshot.deadletter.length;
      legacyImports.push(await recordImport(
        controlDb,
        queuePath,
        "runtime-queue-json",
        "queue",
        "runtime-queue-json-import",
        { imported_records: queueRecords },
        input.importedAt,
      ));
    } else {
      legacyImports.push(await recordImport(
        controlDb,
        queuePath,
        "runtime-queue-json",
        "queue",
        "runtime-queue-json-import",
        {
          imported_records: 0,
          skipped_reason: queueRaw === null
            ? "missing_legacy_source"
            : queueDbPresent
              ? "authoritative_db_state_present"
              : "invalid_legacy_source",
        },
        input.importedAt,
        queueDbPresent && queueRaw !== null ? "blocked" : "validated",
      ));
    }

    const daemonStatePath = path.join(input.baseDir, "daemon-state.json");
    const daemonStateRaw = await readJsonFileOrNull(daemonStatePath);
    const daemonStateParsed = DaemonStateSchema.safeParse(daemonStateRaw);
    let daemonStateImported = false;
    const daemonStateImport = terminalLegacyImport(controlDb, "daemon-state-json", "daemon-state", "runtime-daemon-state-json-import");
    const daemonStateDbPresent = hasRows(controlDb, "daemon_state_snapshots");
    if (daemonStateImport) {
      legacyImports.push(daemonStateImport);
    } else if (daemonStateParsed.success && !daemonStateDbPresent) {
      await new DaemonStateStore(input.baseDir, storeOptions).save(daemonStateParsed.data);
      daemonStateImported = true;
      legacyImports.push(await recordImport(
        controlDb,
        daemonStatePath,
        "daemon-state-json",
        "daemon-state",
        "runtime-daemon-state-json-import",
        { imported: true },
        input.importedAt,
      ));
    } else {
      legacyImports.push(await recordImport(
        controlDb,
        daemonStatePath,
        "daemon-state-json",
        "daemon-state",
        "runtime-daemon-state-json-import",
        {
          imported: false,
          skipped_reason: daemonStateRaw === null
            ? "missing_legacy_source"
            : daemonStateDbPresent
              ? "authoritative_db_state_present"
              : "invalid_legacy_source",
        },
        input.importedAt,
        daemonStateDbPresent && daemonStateRaw !== null ? "blocked" : "validated",
      ));
    }

    const shutdownPath = path.join(input.baseDir, "shutdown-state.json");
    const shutdownRaw = await readJsonFileOrNull(shutdownPath);
    const shutdownParsed = ShutdownMarkerSchema.safeParse(shutdownRaw);
    let shutdownMarkerImported = false;
    const shutdownImport = terminalLegacyImport(controlDb, "daemon-shutdown-json", "shutdown-marker", "runtime-shutdown-marker-json-import");
    const shutdownDbPresent = hasRows(controlDb, "daemon_shutdown_markers");
    if (shutdownImport) {
      legacyImports.push(shutdownImport);
    } else if (shutdownParsed.success && !shutdownDbPresent) {
      await new DaemonShutdownStore(input.baseDir, storeOptions).save(shutdownParsed.data);
      shutdownMarkerImported = true;
      legacyImports.push(await recordImport(
        controlDb,
        shutdownPath,
        "daemon-shutdown-json",
        "shutdown-marker",
        "runtime-shutdown-marker-json-import",
        { imported: true },
        input.importedAt,
      ));
    } else {
      legacyImports.push(await recordImport(
        controlDb,
        shutdownPath,
        "daemon-shutdown-json",
        "shutdown-marker",
        "runtime-shutdown-marker-json-import",
        {
          imported: false,
          skipped_reason: shutdownRaw === null
            ? "missing_legacy_source"
            : shutdownDbPresent
              ? "authoritative_db_state_present"
              : "invalid_legacy_source",
        },
        input.importedAt,
        shutdownDbPresent && shutdownRaw !== null ? "blocked" : "validated",
      ));
    }

    const supervisorPath = path.join(runtimeRoot, "supervisor-state.json");
    const supervisorRaw = await readJsonFileOrNull(supervisorPath);
    const supervisorParsed = SupervisorStateSchema.safeParse(supervisorRaw);
    let supervisorStateImported = false;
    const supervisorImport = terminalLegacyImport(controlDb, "supervisor-state-json", "supervisor-state", "runtime-supervisor-state-json-import");
    const supervisorDbPresent = hasRows(controlDb, "supervisor_state_snapshots");
    if (supervisorImport) {
      legacyImports.push(supervisorImport);
    } else if (supervisorParsed.success && !supervisorDbPresent) {
      await new SupervisorStateStore(runtimeRoot, storeOptions).save(supervisorParsed.data);
      supervisorStateImported = true;
      legacyImports.push(await recordImport(
        controlDb,
        supervisorPath,
        "supervisor-state-json",
        "supervisor-state",
        "runtime-supervisor-state-json-import",
        { imported: true },
        input.importedAt,
      ));
    } else {
      legacyImports.push(await recordImport(
        controlDb,
        supervisorPath,
        "supervisor-state-json",
        "supervisor-state",
        "runtime-supervisor-state-json-import",
        {
          imported: false,
          skipped_reason: supervisorRaw === null
            ? "missing_legacy_source"
            : supervisorDbPresent
              ? "authoritative_db_state_present"
              : "invalid_legacy_source",
        },
        input.importedAt,
        supervisorDbPresent && supervisorRaw !== null ? "blocked" : "validated",
      ));
    }

    const schedulesPath = path.join(input.baseDir, "schedules.json");
    const schedulesRaw = await readJsonFileOrNull(schedulesPath);
    const parsedSchedules = parsePersistedScheduleEntries(schedulesRaw);
    let scheduleEntries = 0;
    const scheduleImport = terminalLegacyImport(controlDb, "schedule-entries-json", "schedule-entries", "runtime-schedules-json-import");
    const scheduleDbPresent = hasRows(controlDb, "schedule_entries");
    const schedulesValid = parsedSchedules.validList
      && (parsedSchedules.entries.length > 0 || parsedSchedules.invalidCount === 0);
    if (scheduleImport) {
      legacyImports.push(scheduleImport);
    } else if (schedulesValid && !scheduleDbPresent) {
      await new ScheduleEntryStore(input.baseDir, { warn: () => {} }, undefined, storeOptions)
        .saveEntries(parsedSchedules.entries);
      scheduleEntries = parsedSchedules.entries.length;
      legacyImports.push(await recordImport(
        controlDb,
        schedulesPath,
        "schedule-entries-json",
        "schedule-entries",
        "runtime-schedules-json-import",
        {
          imported_records: scheduleEntries,
          invalid_records: parsedSchedules.invalidCount,
        },
        input.importedAt,
      ));
    } else {
      legacyImports.push(await recordImport(
        controlDb,
        schedulesPath,
        "schedule-entries-json",
        "schedule-entries",
        "runtime-schedules-json-import",
        {
          imported_records: 0,
          invalid_records: parsedSchedules.invalidCount,
          skipped_reason: schedulesRaw === null
            ? "missing_legacy_source"
            : scheduleDbPresent
              ? "authoritative_db_state_present"
              : "invalid_legacy_source",
        },
        input.importedAt,
        scheduleDbPresent && schedulesRaw !== null ? "blocked" : "validated",
      ));
    }

    const historyPath = path.join(input.baseDir, "schedule-history.json");
    const historyRaw = await readJsonFileOrNull(historyPath);
    const historyRecords = Array.isArray(historyRaw)
      ? historyRaw.flatMap((candidate) => {
          const parsed = ScheduleRunHistoryRecordSchema.safeParse(candidate);
          return parsed.success ? [parsed.data] : [];
        })
      : [];
    let scheduleHistoryRecords = 0;
    const historyImport = terminalLegacyImport(controlDb, "schedule-history-json", "schedule-history", "runtime-schedule-history-json-import");
    const historyDbPresent = hasRows(controlDb, "schedule_run_history");
    const historyValid = Array.isArray(historyRaw)
      && (historyRecords.length > 0 || historyRaw.length === 0);
    if (historyImport) {
      legacyImports.push(historyImport);
    } else if (historyValid && !historyDbPresent) {
      await new ScheduleHistoryStore(input.baseDir, undefined, storeOptions).save(historyRecords);
      scheduleHistoryRecords = historyRecords.length;
      legacyImports.push(await recordImport(
        controlDb,
        historyPath,
        "schedule-history-json",
        "schedule-history",
        "runtime-schedule-history-json-import",
        { imported_records: scheduleHistoryRecords },
        input.importedAt,
      ));
    } else {
      legacyImports.push(await recordImport(
        controlDb,
        historyPath,
        "schedule-history-json",
        "schedule-history",
        "runtime-schedule-history-json-import",
        {
          imported_records: 0,
          skipped_reason: historyRaw === null
            ? "missing_legacy_source"
            : historyDbPresent
              ? "authoritative_db_state_present"
              : "invalid_legacy_source",
        },
        input.importedAt,
        historyDbPresent && historyRaw !== null ? "blocked" : "validated",
      ));
    }

    return {
      queueRecords,
      daemonState: daemonStateImported,
      shutdownMarker: shutdownMarkerImported,
      supervisorState: supervisorStateImported,
      scheduleEntries,
      scheduleHistoryRecords,
      legacyImports,
    };
  } finally {
    if (!providedDb) {
      controlDb.close();
    }
  }
}

async function recordImport(
  controlDb: ControlDatabase,
  sourcePath: string,
  sourceKind: string,
  sourceId: string,
  migrationName: string,
  details: Record<string, unknown>,
  importedAt?: string,
  status?: ControlLegacyImportStatus,
): Promise<ControlLegacyImportRecord> {
  const fingerprint = await fingerprintFile(sourcePath);
  return controlDb.recordLegacyImport({
    sourceKind,
    sourceId,
    sourcePath,
    sourceChecksum: fingerprint?.checksum ?? null,
    sourceMtimeMs: fingerprint?.mtimeMs ?? null,
    migrationName,
    migrationVersion: QUEUE_DAEMON_SCHEDULE_IMPORT_MIGRATION_VERSION,
    status: status ?? (fingerprint ? "imported" : "validated"),
    details,
    importedAt,
  });
}

function terminalLegacyImport(
  controlDb: ControlDatabase,
  sourceKind: string,
  sourceId: string,
  migrationName: string,
): ControlLegacyImportRecord | null {
  const existing = controlDb.listLegacyImports().find((record) => (
    record.source_kind === sourceKind
    && record.source_id === sourceId
    && record.migration_name === migrationName
  ));
  if (!existing) return null;
  return existing.status === "validated" ? null : existing;
}

function hasRows(controlDb: ControlDatabase, tableName: string): boolean {
  return controlDb.read((sqlite) => {
    const row = sqlite.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as { count: number };
    return row.count > 0;
  });
}

function isLegacyQueueState(raw: unknown): raw is Record<string, unknown> {
  return raw !== null
    && typeof raw === "object"
    && !Array.isArray(raw)
    && (raw as Record<string, unknown>)["version"] === 1;
}

async function fingerprintFile(filePath: string): Promise<{ checksum: string; mtimeMs: number } | null> {
  try {
    const [raw, stat] = await Promise.all([
      fsp.readFile(filePath),
      fsp.stat(filePath),
    ]);
    return {
      checksum: createHash("sha256").update(raw).digest("hex"),
      mtimeMs: Math.floor(stat.mtimeMs),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}
