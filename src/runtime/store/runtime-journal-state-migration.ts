import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { z } from "zod/v3";
import {
  BrowserAutomationSessionRecordSchema,
  RuntimeAuthHandoffRecordSchema,
  type BrowserAutomationSessionRecord,
  type RuntimeAuthHandoffRecord,
} from "./runtime-schemas.js";
import {
  createRuntimeStorePaths,
  type RuntimeStorePaths,
} from "./runtime-paths.js";
import {
  RuntimeOperatorHandoffRecordSchema,
  RuntimeOperatorHandoffStore,
  type RuntimeOperatorHandoffRecord,
} from "./operator-handoff-store.js";
import {
  RuntimeBudgetRecordSchema,
  RuntimeBudgetStore,
  type RuntimeBudgetRecord,
} from "./budget-store.js";
import {
  RuntimeExperimentQueueRecordSchema,
  RuntimeExperimentQueueStore,
  type RuntimeExperimentQueueRecord,
} from "./experiment-queue-store.js";
import {
  CapabilityAuditRecordSchema,
  CapabilityVerificationRefSchema,
  type CapabilityAuditRecord,
  type CapabilityVerificationRef,
} from "./capability-verification-schemas.js";
import { CapabilityVerificationStore } from "./capability-verification-store.js";
import {
  ProactiveInterventionEventSchema,
  ProactiveInterventionStore,
  type ProactiveInterventionEvent,
} from "./proactive-intervention-store.js";
import { BrowserSessionStore } from "../interactive-automation/browser-session-store.js";
import { RuntimeAuthHandoffStore } from "../interactive-automation/runtime-auth-handoff-store.js";
import {
  openRuntimeControlDatabase,
  type ControlDatabase,
  type ControlLegacyImportRecord,
  type ControlLegacyImportStatus,
  type RuntimeControlDbStoreOptions,
} from "./control-db/index.js";

const MIGRATION_NAME = "runtime-journal-state";
const MIGRATION_VERSION = 13;

const BrowserAutomationSessionMigrationSchema =
  BrowserAutomationSessionRecordSchema as z.ZodType<BrowserAutomationSessionRecord>;
const RuntimeAuthHandoffMigrationSchema =
  RuntimeAuthHandoffRecordSchema as z.ZodType<RuntimeAuthHandoffRecord>;
const RuntimeOperatorHandoffMigrationSchema =
  RuntimeOperatorHandoffRecordSchema as z.ZodType<RuntimeOperatorHandoffRecord>;
const RuntimeBudgetMigrationSchema =
  RuntimeBudgetRecordSchema as unknown as z.ZodType<RuntimeBudgetRecord>;
const RuntimeExperimentQueueMigrationSchema =
  RuntimeExperimentQueueRecordSchema as unknown as z.ZodType<RuntimeExperimentQueueRecord>;
const CapabilityVerificationMigrationSchema =
  CapabilityVerificationRefSchema as z.ZodType<CapabilityVerificationRef>;
const CapabilityAuditMigrationSchema =
  CapabilityAuditRecordSchema as z.ZodType<CapabilityAuditRecord>;

export interface ImportLegacyRuntimeFileStateInput extends RuntimeControlDbStoreOptions {
  runtimeRootOrPaths?: string | RuntimeStorePaths;
  importedAt?: string;
}

export interface ImportLegacyRuntimeFileStateResult {
  operatorHandoffs: number;
  budgets: number;
  experimentQueues: number;
  capabilityVerifications: number;
  capabilityAudits: number;
  browserSessions: number;
  authHandoffs: number;
  proactiveInterventionEvents: number;
  invalidLegacyRecords: number;
  legacyImports: ControlLegacyImportRecord[];
}

interface LegacyInvalidRecord {
  source: string;
  reason: string;
}

interface LegacyRuntimeJsonRecords<T> {
  records: T[];
  fileCount: number;
  invalidRecords: LegacyInvalidRecord[];
}

interface LegacyRuntimeJsonlRecords<T> {
  records: T[];
  lineCount: number;
  invalidRecords: LegacyInvalidRecord[];
}

export async function importLegacyRuntimeFileState(
  input: ImportLegacyRuntimeFileStateInput = {}
): Promise<ImportLegacyRuntimeFileStateResult> {
  const paths = typeof input.runtimeRootOrPaths === "string"
    ? createRuntimeStorePaths(input.runtimeRootOrPaths)
    : input.runtimeRootOrPaths ?? createRuntimeStorePaths();
  const providedDb = input.controlDb !== undefined;
  const controlDb = await openRuntimeControlDatabase(paths, input);
  const storeOptions = { controlDb };
  const operatorHandoffStore = new RuntimeOperatorHandoffStore(paths, storeOptions);
  const budgetStore = new RuntimeBudgetStore(paths, storeOptions);
  const experimentQueueStore = new RuntimeExperimentQueueStore(paths, storeOptions);
  const capabilityVerificationStore = new CapabilityVerificationStore(paths, storeOptions);
  const browserSessionStore = new BrowserSessionStore(paths, storeOptions);
  const authHandoffStore = new RuntimeAuthHandoffStore(paths, storeOptions);
  const proactiveInterventionStore = new ProactiveInterventionStore(paths, storeOptions);
  const legacyImports: ControlLegacyImportRecord[] = [];
  let invalidLegacyRecords = 0;

  try {
    const operatorHandoffDir = path.join(paths.rootDir, "operator-handoffs");
    const operatorHandoffRead = await readLegacyRuntimeJsonRecords(operatorHandoffDir, RuntimeOperatorHandoffMigrationSchema);
    const operatorHandoffs = operatorHandoffRead.records;
    invalidLegacyRecords += operatorHandoffRead.invalidRecords.length;
    for (const record of operatorHandoffs) {
      await operatorHandoffStore.importLegacyRecord(record);
    }
    legacyImports.push(await recordLegacyImport(controlDb, paths, operatorHandoffDir, "operator-handoff-json", "operator-handoffs", {
      rowCount: operatorHandoffs.length,
      fileCount: operatorHandoffRead.fileCount,
      invalidRecords: operatorHandoffRead.invalidRecords,
    }, input.importedAt));

    const budgetDir = path.join(paths.rootDir, "budgets");
    const budgetRead = await readLegacyRuntimeJsonRecords(budgetDir, RuntimeBudgetMigrationSchema);
    const budgets = budgetRead.records;
    invalidLegacyRecords += budgetRead.invalidRecords.length;
    for (const record of budgets) {
      await budgetStore.importLegacyRecord(record);
    }
    legacyImports.push(await recordLegacyImport(controlDb, paths, budgetDir, "runtime-budget-json", "runtime-budgets", {
      rowCount: budgets.length,
      fileCount: budgetRead.fileCount,
      invalidRecords: budgetRead.invalidRecords,
    }, input.importedAt));

    const experimentQueueDir = path.join(paths.rootDir, "experiment-queues");
    const experimentQueueRead = await readLegacyRuntimeJsonRecords(experimentQueueDir, RuntimeExperimentQueueMigrationSchema);
    const experimentQueues = experimentQueueRead.records;
    invalidLegacyRecords += experimentQueueRead.invalidRecords.length;
    for (const record of experimentQueues) {
      await experimentQueueStore.importLegacyRecord(record);
    }
    legacyImports.push(await recordLegacyImport(controlDb, paths, experimentQueueDir, "experiment-queue-json", "experiment-queues", {
      rowCount: experimentQueues.length,
      fileCount: experimentQueueRead.fileCount,
      invalidRecords: experimentQueueRead.invalidRecords,
    }, input.importedAt));

    const capabilityVerificationDir = path.join(paths.rootDir, "capability-verification", "verifications");
    const capabilityVerificationRead = await readLegacyRuntimeJsonRecords(capabilityVerificationDir, CapabilityVerificationMigrationSchema);
    const capabilityVerifications = capabilityVerificationRead.records;
    invalidLegacyRecords += capabilityVerificationRead.invalidRecords.length;
    for (const record of capabilityVerifications) {
      await capabilityVerificationStore.importLegacyVerification(record);
    }
    legacyImports.push(await recordLegacyImport(controlDb, paths, capabilityVerificationDir, "capability-verification-json", "capability-verifications", {
      rowCount: capabilityVerifications.length,
      fileCount: capabilityVerificationRead.fileCount,
      invalidRecords: capabilityVerificationRead.invalidRecords,
    }, input.importedAt));

    const capabilityAuditDir = path.join(paths.rootDir, "capability-verification", "audits");
    const capabilityAuditRead = await readLegacyRuntimeJsonRecords(capabilityAuditDir, CapabilityAuditMigrationSchema);
    const capabilityAudits = capabilityAuditRead.records;
    invalidLegacyRecords += capabilityAuditRead.invalidRecords.length;
    for (const record of capabilityAudits) {
      await capabilityVerificationStore.importLegacyAudit(record);
    }
    legacyImports.push(await recordLegacyImport(controlDb, paths, capabilityAuditDir, "capability-audit-json", "capability-audits", {
      rowCount: capabilityAudits.length,
      fileCount: capabilityAuditRead.fileCount,
      invalidRecords: capabilityAuditRead.invalidRecords,
    }, input.importedAt));

    const browserSessionDir = path.join(paths.rootDir, "browser-sessions");
    const browserSessionRead = await readLegacyRuntimeJsonRecords(browserSessionDir, BrowserAutomationSessionMigrationSchema);
    const browserSessions = browserSessionRead.records;
    invalidLegacyRecords += browserSessionRead.invalidRecords.length;
    for (const record of browserSessions) {
      await browserSessionStore.importLegacyRecord(record);
    }
    legacyImports.push(await recordLegacyImport(controlDb, paths, browserSessionDir, "browser-session-json", "browser-sessions", {
      rowCount: browserSessions.length,
      fileCount: browserSessionRead.fileCount,
      invalidRecords: browserSessionRead.invalidRecords,
    }, input.importedAt));

    const authHandoffDir = path.join(paths.rootDir, "auth-handoffs");
    const authHandoffRead = await readLegacyRuntimeJsonRecords(authHandoffDir, RuntimeAuthHandoffMigrationSchema);
    const authHandoffs = authHandoffRead.records;
    invalidLegacyRecords += authHandoffRead.invalidRecords.length;
    for (const record of authHandoffs) {
      await authHandoffStore.importLegacyRecord(record);
    }
    legacyImports.push(await recordLegacyImport(controlDb, paths, authHandoffDir, "runtime-auth-handoff-json", "runtime-auth-handoffs", {
      rowCount: authHandoffs.length,
      fileCount: authHandoffRead.fileCount,
      invalidRecords: authHandoffRead.invalidRecords,
    }, input.importedAt));

    const proactiveInterventionPath = path.join(paths.rootDir, "proactive-interventions", "events.jsonl");
    const proactiveInterventionRead = await readLegacyProactiveInterventionEvents(proactiveInterventionPath);
    const proactiveInterventionEvents = proactiveInterventionRead.records;
    invalidLegacyRecords += proactiveInterventionRead.invalidRecords.length;
    for (const event of proactiveInterventionEvents) {
      await proactiveInterventionStore.importLegacyEvent(event);
    }
    legacyImports.push(await recordLegacyImport(controlDb, paths, proactiveInterventionPath, "proactive-intervention-jsonl", "proactive-interventions", {
      rowCount: proactiveInterventionEvents.length,
      lineCount: proactiveInterventionRead.lineCount,
      invalidRecords: proactiveInterventionRead.invalidRecords,
    }, input.importedAt));

    return {
      operatorHandoffs: operatorHandoffs.length,
      budgets: budgets.length,
      experimentQueues: experimentQueues.length,
      capabilityVerifications: capabilityVerifications.length,
      capabilityAudits: capabilityAudits.length,
      browserSessions: browserSessions.length,
      authHandoffs: authHandoffs.length,
      proactiveInterventionEvents: proactiveInterventionEvents.length,
      invalidLegacyRecords,
      legacyImports,
    };
  } finally {
    if (!providedDb) {
      controlDb.close();
    }
  }
}

async function readLegacyRuntimeJsonRecords<T>(
  dirPath: string,
  schema: z.ZodType<T>
): Promise<LegacyRuntimeJsonRecords<T>> {
  let entries: string[];
  try {
    entries = await fsp.readdir(dirPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { records: [], fileCount: 0, invalidRecords: [] };
    }
    throw err;
  }

  const files = entries.filter((entry) => entry.endsWith(".json")).sort();
  const records: T[] = [];
  const invalidRecords: LegacyInvalidRecord[] = [];
  for (const fileName of files) {
    const filePath = path.join(dirPath, fileName);
    try {
      const parsedJson = JSON.parse(await fsp.readFile(filePath, "utf8")) as unknown;
      const parsed = schema.safeParse(parsedJson);
      if (parsed.success) {
        records.push(parsed.data);
      } else {
        invalidRecords.push({ source: fileName, reason: summarizeZodError(parsed.error) });
      }
    } catch (error) {
      invalidRecords.push({ source: fileName, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { records, fileCount: files.length, invalidRecords };
}

async function readLegacyProactiveInterventionEvents(filePath: string): Promise<LegacyRuntimeJsonlRecords<ProactiveInterventionEvent>> {
  let raw = "";
  try {
    raw = await fsp.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  const records: ProactiveInterventionEvent[] = [];
  const invalidRecords: LegacyInvalidRecord[] = [];
  const lines = raw.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const parsed = ProactiveInterventionEventSchema.safeParse(JSON.parse(line) as unknown);
      if (parsed.success) {
        records.push(parsed.data);
      } else {
        invalidRecords.push({ source: `line:${index + 1}`, reason: summarizeZodError(parsed.error) });
      }
    } catch (error) {
      invalidRecords.push({ source: `line:${index + 1}`, reason: error instanceof Error ? error.message : String(error) });
    }
  });
  return { records, lineCount: lines.filter((line) => line.trim()).length, invalidRecords };
}

function summarizeZodError(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
}

interface LegacyImportDetails {
  rowCount: number;
  fileCount?: number;
  lineCount?: number;
  invalidRecords: LegacyInvalidRecord[];
}

async function recordLegacyImport(
  controlDb: ControlDatabase,
  paths: RuntimeStorePaths,
  sourcePath: string,
  sourceKind: string,
  sourceId: string,
  details: LegacyImportDetails,
  importedAt?: string,
): Promise<ControlLegacyImportRecord> {
  const metadata = await readSourceMetadata(sourcePath);
  const invalidCount = details.invalidRecords.length;
  const recordDetails: Record<string, unknown> = {
    row_count: details.rowCount,
  };
  if (details.fileCount !== undefined) recordDetails["file_count"] = details.fileCount;
  if (details.lineCount !== undefined) recordDetails["line_count"] = details.lineCount;
  if (invalidCount > 0) {
    recordDetails["invalid_count"] = invalidCount;
    recordDetails["invalid_records"] = details.invalidRecords.slice(0, 20);
    recordDetails["skipped_reason"] = details.rowCount === 0
      ? "invalid_legacy_source"
      : "partial_invalid_legacy_source";
  }
  const status: ControlLegacyImportStatus = invalidCount > 0 ? "blocked" : "imported";
  return controlDb.recordLegacyImport({
    sourceKind,
    sourceId,
    sourcePath: displayLegacySourcePath(paths, sourcePath),
    sourceChecksum: metadata.checksum,
    sourceMtimeMs: metadata.mtimeMs,
    migrationName: MIGRATION_NAME,
    migrationVersion: MIGRATION_VERSION,
    status,
    details: recordDetails,
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
