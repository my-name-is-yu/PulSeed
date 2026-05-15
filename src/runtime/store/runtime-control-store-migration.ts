import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { z } from "zod/v3";
import {
  RuntimeControlOperationSchema,
  type RuntimeControlOperation,
} from "./runtime-operation-schemas.js";
import {
  RuntimeEventSchema,
  type RuntimeEvent,
} from "../types/companion-state.js";
import {
  RuntimeComponentsHealthSchema,
  RuntimeDaemonHealthSchema,
} from "./runtime-schemas.js";
import {
  createRuntimeStorePaths,
  type RuntimeStorePaths,
} from "./runtime-paths.js";
import {
  listRuntimeJson,
  loadRuntimeJson,
} from "./runtime-journal.js";
import {
  BackgroundRunLedger,
  BackgroundRunLedgerRecordSchema,
} from "./background-run-store.js";
import { RuntimeHealthStore } from "./health-store.js";
import {
  deriveRuntimeOperationIdFromEvent,
  RuntimeOperationStore,
} from "./runtime-operation-store.js";
import {
  openRuntimeControlDatabase,
  type ControlDatabase,
  type ControlLegacyImportRecord,
  type RuntimeControlDbStoreOptions,
} from "./control-db/index.js";

const RuntimeEventJournalSchema = RuntimeEventSchema as z.ZodType<RuntimeEvent>;
const RUNTIME_CONTROL_LEGACY_IMPORT_MIGRATION_VERSION = 2;

export interface ImportLegacyRuntimeControlStoresInput extends RuntimeControlDbStoreOptions {
  runtimeRootOrPaths?: string | RuntimeStorePaths;
  importedAt?: string;
}

export interface ImportLegacyRuntimeControlStoresResult {
  operations: {
    pending: number;
    completed: number;
  };
  operationEvents: number;
  backgroundRuns: number;
  healthRecords: number;
  legacyImports: ControlLegacyImportRecord[];
}

export async function importLegacyRuntimeControlStores(
  input: ImportLegacyRuntimeControlStoresInput = {}
): Promise<ImportLegacyRuntimeControlStoresResult> {
  const paths = typeof input.runtimeRootOrPaths === "string"
    ? createRuntimeStorePaths(input.runtimeRootOrPaths)
    : input.runtimeRootOrPaths ?? createRuntimeStorePaths();
  const providedDb = input.controlDb !== undefined;
  const controlDb = await openRuntimeControlDatabase(paths, input);
  const operationStore = new RuntimeOperationStore(paths, { controlDb });
  const backgroundRunLedger = new BackgroundRunLedger(paths, { controlDb });
  const healthStore = new RuntimeHealthStore(paths, { controlDb });
  const legacyImports: ControlLegacyImportRecord[] = [];

  try {
    const operationsRoot = path.join(paths.rootDir, "operations");
    const pendingOperations = await listRuntimeJson(
      path.join(operationsRoot, "pending"),
      RuntimeControlOperationSchema,
    );
    const completedOperations = await listRuntimeJson(
      path.join(operationsRoot, "completed"),
      RuntimeControlOperationSchema,
    );

    await importOperations(operationStore, pendingOperations);
    await importOperations(operationStore, completedOperations);
    legacyImports.push(await recordLegacyImport(
      controlDb,
      paths,
      path.join(operationsRoot, "pending"),
      "runtime-operation-json",
      "runtime-operations:pending",
      "runtime-control-operation-json-import",
      pendingOperations.length,
      input.importedAt,
    ));
    legacyImports.push(await recordLegacyImport(
      controlDb,
      paths,
      path.join(operationsRoot, "completed"),
      "runtime-operation-json",
      "runtime-operations:completed",
      "runtime-control-operation-json-import",
      completedOperations.length,
      input.importedAt,
    ));

    const operationEvents = await listRuntimeJson(
      path.join(operationsRoot, "events"),
      RuntimeEventJournalSchema,
    );
    for (const event of operationEvents) {
      await operationStore.importLegacyRuntimeEvent(
        event,
        deriveRuntimeOperationIdFromEvent(event),
      );
    }
    legacyImports.push(await recordLegacyImport(
      controlDb,
      paths,
      path.join(operationsRoot, "events"),
      "runtime-operation-event-json",
      "runtime-operation-events",
      "runtime-control-operation-event-json-import",
      operationEvents.length,
      input.importedAt,
    ));

    const backgroundRuns = await listRuntimeJson(
      paths.backgroundRunsDir,
      BackgroundRunLedgerRecordSchema,
    );
    for (const run of backgroundRuns) {
      await backgroundRunLedger.save(run);
    }
    legacyImports.push(await recordLegacyImport(
      controlDb,
      paths,
      paths.backgroundRunsDir,
      "background-run-json",
      "background-runs",
      "runtime-background-run-json-import",
      backgroundRuns.length,
      input.importedAt,
    ));

    let healthRecords = 0;
    const daemonHealth = await loadRuntimeJson(paths.daemonHealthPath, RuntimeDaemonHealthSchema);
    if (daemonHealth) {
      await healthStore.saveDaemonHealth(daemonHealth);
      healthRecords += 1;
    }
    legacyImports.push(await recordLegacyImport(
      controlDb,
      paths,
      paths.daemonHealthPath,
      "runtime-health-json",
      "runtime-health:daemon",
      "runtime-health-json-import",
      daemonHealth ? 1 : 0,
      input.importedAt,
    ));

    const componentsHealth = await loadRuntimeJson(paths.componentsHealthPath, RuntimeComponentsHealthSchema);
    if (componentsHealth) {
      await healthStore.saveComponentsHealth(componentsHealth);
      healthRecords += 1;
    }
    legacyImports.push(await recordLegacyImport(
      controlDb,
      paths,
      paths.componentsHealthPath,
      "runtime-health-json",
      "runtime-health:components",
      "runtime-health-json-import",
      componentsHealth ? 1 : 0,
      input.importedAt,
    ));

    return {
      operations: {
        pending: pendingOperations.length,
        completed: completedOperations.length,
      },
      operationEvents: operationEvents.length,
      backgroundRuns: backgroundRuns.length,
      healthRecords,
      legacyImports,
    };
  } finally {
    if (!providedDb) {
      controlDb.close();
    }
  }
}

async function importOperations(
  operationStore: RuntimeOperationStore,
  operations: RuntimeControlOperation[],
): Promise<void> {
  for (const operation of operations) {
    await operationStore.save(operation, { emitEvent: false });
  }
}

async function recordLegacyImport(
  controlDb: ControlDatabase,
  paths: RuntimeStorePaths,
  sourcePath: string,
  sourceKind: string,
  sourceId: string,
  migrationName: string,
  rowCount: number,
  importedAt?: string,
): Promise<ControlLegacyImportRecord> {
  const metadata = await readSourceMetadata(sourcePath);
  return controlDb.recordLegacyImport({
    sourceKind,
    sourceId,
    sourcePath: displayLegacySourcePath(paths, sourcePath),
    sourceChecksum: metadata.checksum,
    sourceMtimeMs: metadata.mtimeMs,
    migrationName,
    migrationVersion: RUNTIME_CONTROL_LEGACY_IMPORT_MIGRATION_VERSION,
    status: "imported",
    details: {
      row_count: rowCount,
    },
    importedAt,
  });
}

async function readSourceMetadata(sourcePath: string): Promise<{
  checksum: string | null;
  mtimeMs: number | null;
}> {
  try {
    const stat = await fsp.stat(sourcePath);
    if (!stat.isFile()) {
      return { checksum: null, mtimeMs: stat.mtimeMs };
    }
    const contents = await fsp.readFile(sourcePath);
    return {
      checksum: `sha256:${createHash("sha256").update(contents).digest("hex")}`,
      mtimeMs: stat.mtimeMs,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { checksum: null, mtimeMs: null };
    }
    throw error;
  }
}

function displayLegacySourcePath(paths: RuntimeStorePaths, sourcePath: string): string {
  const root = path.resolve(paths.rootDir);
  const baseDir = path.basename(root) === "runtime" ? path.dirname(root) : root;
  return path.relative(baseDir, sourcePath);
}
