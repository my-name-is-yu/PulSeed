import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  openControlDatabase,
  type ControlDatabase,
  type ControlLegacyImportStatus,
  type RuntimeControlDbStoreOptions,
} from "./control-db/index.js";
import {
  TransferEffectivenessEnum,
  TransferTrustScoreSchema,
} from "../../base/types/cross-portfolio.js";
import {
  TRANSFER_TRUST_HISTORY_PREFIX,
  TRANSFER_TRUST_INDEX_PATH,
  TRANSFER_TRUST_SCORE_PREFIX,
  TransferTrustStateStore,
  transferTrustDomainPairKey,
} from "./transfer-trust-state-store.js";

const MIGRATION_NAME = "transfer-trust-runtime-state";
const MIGRATION_VERSION = 21;

const TransferTrustIndexSchema = z.array(z.string());
const TransferTrustHistorySchema = z.array(TransferEffectivenessEnum);

export interface TransferTrustLegacyImportReport {
  indexEntries: number;
  scores: number;
  historyEntries: number;
  skippedAlreadyImported: number;
  retiredExistingTypedState: number;
  blockedSources: Array<{ sourceKind: string; sourcePath: string; reason: string }>;
}

export async function importLegacyTransferTrustState(
  baseDir: string,
  options: RuntimeControlDbStoreOptions = {},
): Promise<TransferTrustLegacyImportReport> {
  const controlDb = options.controlDb ?? await openControlDatabase({
    baseDir: options.controlBaseDir ?? baseDir,
    dbPath: options.controlDbPath,
  });
  const store = new TransferTrustStateStore(baseDir, { ...options, controlDb });
  const report: TransferTrustLegacyImportReport = {
    indexEntries: 0,
    scores: 0,
    historyEntries: 0,
    skippedAlreadyImported: 0,
    retiredExistingTypedState: 0,
    blockedSources: [],
  };

  try {
    await importIndex(baseDir, store, controlDb, report);
    await importScoreFiles(baseDir, store, controlDb, report);
    await importHistoryFiles(baseDir, store, controlDb, report);
    return report;
  } finally {
    if (!options.controlDb) {
      controlDb.close();
    }
  }
}

async function importIndex(
  baseDir: string,
  store: TransferTrustStateStore,
  controlDb: ControlDatabase,
  report: TransferTrustLegacyImportReport,
): Promise<void> {
  const sourceKind = "transfer_trust_index";
  const sourceId = "current";
  const filePath = path.join(baseDir, TRANSFER_TRUST_INDEX_PATH);
  if (hasCompletedImportRecord(controlDb, sourceKind, sourceId)) {
    report.skippedAlreadyImported += 1;
    return;
  }

  let payload: { raw: string; checksum: string; mtimeMs: number };
  try {
    payload = await readLegacyTextFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    blockImport(baseDir, filePath, sourceKind, sourceId, controlDb, report, error);
    return;
  }

  try {
    if ((await store.listIndexDomainPairs()).length > 0) {
      report.retiredExistingTypedState += 1;
      recordImport(controlDb, {
        sourceKind,
        sourceId,
        sourcePath: path.relative(baseDir, filePath),
        sourceChecksum: payload.checksum,
        sourceMtimeMs: payload.mtimeMs,
        status: "retired",
        details: { reason: "typed transfer trust index already exists" },
      });
      return;
    }
  } catch (error) {
    blockImport(baseDir, filePath, sourceKind, sourceId, controlDb, report, error, payload);
    return;
  }

  try {
    const parsed = TransferTrustIndexSchema.parse(JSON.parse(payload.raw) as unknown);
    await store.saveIndexDomainPairs(parsed);
    report.indexEntries += parsed.length;
    recordImport(controlDb, {
      sourceKind,
      sourceId,
      sourcePath: path.relative(baseDir, filePath),
      sourceChecksum: payload.checksum,
      sourceMtimeMs: payload.mtimeMs,
      status: "imported",
      details: { entries: parsed.length },
    });
  } catch (error) {
    blockImport(baseDir, filePath, sourceKind, sourceId, controlDb, report, error, payload);
  }
}

async function importScoreFiles(
  baseDir: string,
  store: TransferTrustStateStore,
  controlDb: ControlDatabase,
  report: TransferTrustLegacyImportReport,
): Promise<void> {
  const dirPath = path.join(baseDir, TRANSFER_TRUST_SCORE_PREFIX);
  const entries = await listJsonFiles(dirPath);
  for (const entry of entries) {
    if (entry.name === "_index.json") continue;
    const sourceKind = "transfer_trust_score";
    const sourceId = entry.name.slice(0, -".json".length);
    const filePath = path.join(dirPath, entry.name);
    if (hasCompletedImportRecord(controlDb, sourceKind, sourceId)) {
      report.skippedAlreadyImported += 1;
      continue;
    }
    await importScoreFile(baseDir, filePath, sourceKind, sourceId, store, controlDb, report);
  }
}

async function importScoreFile(
  baseDir: string,
  filePath: string,
  sourceKind: string,
  sourceId: string,
  store: TransferTrustStateStore,
  controlDb: ControlDatabase,
  report: TransferTrustLegacyImportReport,
): Promise<void> {
  let payload: { raw: string; checksum: string; mtimeMs: number };
  try {
    payload = await readLegacyTextFile(filePath);
  } catch (error) {
    blockImport(baseDir, filePath, sourceKind, sourceId, controlDb, report, error);
    return;
  }

  try {
    if (await store.hasScoreKey(sourceId)) {
      report.retiredExistingTypedState += 1;
      recordImport(controlDb, {
        sourceKind,
        sourceId,
        sourcePath: path.relative(baseDir, filePath),
        sourceChecksum: payload.checksum,
        sourceMtimeMs: payload.mtimeMs,
        status: "retired",
        details: { reason: "typed transfer trust score already exists" },
      });
      return;
    }
  } catch (error) {
    blockImport(baseDir, filePath, sourceKind, sourceId, controlDb, report, error, payload);
    return;
  }

  try {
    const parsed = TransferTrustScoreSchema.parse(JSON.parse(payload.raw) as unknown);
    await store.saveScore(parsed);
    report.scores += 1;
    recordImport(controlDb, {
      sourceKind,
      sourceId,
      sourcePath: path.relative(baseDir, filePath),
      sourceChecksum: payload.checksum,
      sourceMtimeMs: payload.mtimeMs,
      status: "imported",
      details: {
        domain_pair: parsed.domain_pair,
        domain_pair_key: transferTrustDomainPairKey(parsed.domain_pair),
      },
    });
  } catch (error) {
    blockImport(baseDir, filePath, sourceKind, sourceId, controlDb, report, error, payload);
  }
}

async function importHistoryFiles(
  baseDir: string,
  store: TransferTrustStateStore,
  controlDb: ControlDatabase,
  report: TransferTrustLegacyImportReport,
): Promise<void> {
  const dirPath = path.join(baseDir, TRANSFER_TRUST_HISTORY_PREFIX);
  const entries = await listJsonFiles(dirPath);
  for (const entry of entries) {
    const sourceKind = "transfer_trust_history";
    const sourceId = entry.name.slice(0, -".json".length);
    const filePath = path.join(dirPath, entry.name);
    if (hasCompletedImportRecord(controlDb, sourceKind, sourceId)) {
      report.skippedAlreadyImported += 1;
      continue;
    }
    await importHistoryFile(baseDir, filePath, sourceKind, sourceId, store, controlDb, report);
  }
}

async function importHistoryFile(
  baseDir: string,
  filePath: string,
  sourceKind: string,
  sourceId: string,
  store: TransferTrustStateStore,
  controlDb: ControlDatabase,
  report: TransferTrustLegacyImportReport,
): Promise<void> {
  let payload: { raw: string; checksum: string; mtimeMs: number };
  try {
    payload = await readLegacyTextFile(filePath);
  } catch (error) {
    blockImport(baseDir, filePath, sourceKind, sourceId, controlDb, report, error);
    return;
  }

  try {
    if (await store.hasHistoryKey(sourceId)) {
      report.retiredExistingTypedState += 1;
      recordImport(controlDb, {
        sourceKind,
        sourceId,
        sourcePath: path.relative(baseDir, filePath),
        sourceChecksum: payload.checksum,
        sourceMtimeMs: payload.mtimeMs,
        status: "retired",
        details: { reason: "typed transfer trust history already exists" },
      });
      return;
    }
  } catch (error) {
    blockImport(baseDir, filePath, sourceKind, sourceId, controlDb, report, error, payload);
    return;
  }

  try {
    const parsed = TransferTrustHistorySchema.parse(JSON.parse(payload.raw) as unknown);
    const domainPair = await store.domainPairForKey(sourceId) ?? sourceId;
    await store.saveHistory(domainPair, parsed);
    report.historyEntries += 1;
    recordImport(controlDb, {
      sourceKind,
      sourceId,
      sourcePath: path.relative(baseDir, filePath),
      sourceChecksum: payload.checksum,
      sourceMtimeMs: payload.mtimeMs,
      status: "imported",
      details: { domain_pair: domainPair, entries: parsed.length },
    });
  } catch (error) {
    blockImport(baseDir, filePath, sourceKind, sourceId, controlDb, report, error, payload);
  }
}

async function listJsonFiles(dirPath: string): Promise<Array<{ name: string }>> {
  let entries: Array<{ name: string; isFile(): boolean }>;
  try {
    entries = await fsp.readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => ({ name: entry.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
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

function recordImport(
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
    migrationName: MIGRATION_NAME,
    migrationVersion: MIGRATION_VERSION,
    status: input.status,
    details: input.details,
    retiredAt: input.status === "retired" ? new Date().toISOString() : null,
  });
}

function hasCompletedImportRecord(controlDb: ControlDatabase, sourceKind: string, sourceId: string): boolean {
  return controlDb.listLegacyImports().some((record) =>
    record.source_kind === sourceKind
    && record.source_id === sourceId
    && record.migration_name === MIGRATION_NAME
    && (record.status === "imported" || record.status === "retired")
  );
}

function blockImport(
  baseDir: string,
  filePath: string,
  sourceKind: string,
  sourceId: string,
  controlDb: ControlDatabase,
  report: TransferTrustLegacyImportReport,
  error: unknown,
  payload?: { checksum: string; mtimeMs: number },
): void {
  const reason = error instanceof Error ? error.message : String(error);
  const sourcePath = path.relative(baseDir, filePath);
  report.blockedSources.push({ sourceKind, sourcePath, reason });
  controlDb.recordLegacyImport({
    sourceKind,
    sourceId,
    sourcePath,
    sourceChecksum: payload?.checksum ?? null,
    sourceMtimeMs: payload?.mtimeMs ?? null,
    migrationName: MIGRATION_NAME,
    migrationVersion: MIGRATION_VERSION,
    status: "blocked",
    details: { reason },
  });
}
