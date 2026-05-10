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
  KnowledgeTransferSnapshotSchema,
  KnowledgeTransferStateStore,
  META_PATTERN_LAST_AGGREGATED_AT_PATH,
  KNOWLEDGE_TRANSFER_SNAPSHOT_PATH,
} from "./knowledge-transfer-state-store.js";

const MIGRATION_NAME = "knowledge-transfer-runtime-state";
const MIGRATION_VERSION = 20;

export interface KnowledgeTransferLegacyImportReport {
  snapshots: number;
  metaPatternWatermarks: number;
  skippedAlreadyImported: number;
  retiredExistingTypedState: number;
  blockedSources: Array<{ sourceKind: string; sourcePath: string; reason: string }>;
}

export async function importLegacyKnowledgeTransferState(
  baseDir: string,
  options: RuntimeControlDbStoreOptions = {},
): Promise<KnowledgeTransferLegacyImportReport> {
  const controlDb = options.controlDb ?? await openControlDatabase({
    baseDir: options.controlBaseDir ?? baseDir,
    dbPath: options.controlDbPath,
  });
  const store = new KnowledgeTransferStateStore(baseDir, { ...options, controlDb });
  const report: KnowledgeTransferLegacyImportReport = {
    snapshots: 0,
    metaPatternWatermarks: 0,
    skippedAlreadyImported: 0,
    retiredExistingTypedState: 0,
    blockedSources: [],
  };

  try {
    await importSnapshot(baseDir, store, controlDb, report);
    await importLastAggregatedAt(baseDir, store, controlDb, report);
    return report;
  } finally {
    if (!options.controlDb) {
      controlDb.close();
    }
  }
}

async function importSnapshot(
  baseDir: string,
  store: KnowledgeTransferStateStore,
  controlDb: ControlDatabase,
  report: KnowledgeTransferLegacyImportReport,
): Promise<void> {
  const sourceKind = "knowledge_transfer_snapshot";
  const sourceId = "current";
  const filePath = path.join(baseDir, KNOWLEDGE_TRANSFER_SNAPSHOT_PATH);
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
    if (await store.hasSnapshot()) {
      report.retiredExistingTypedState += 1;
      recordImport(controlDb, {
        sourceKind,
        sourceId,
        sourcePath: path.relative(baseDir, filePath),
        sourceChecksum: payload.checksum,
        sourceMtimeMs: payload.mtimeMs,
        status: "retired",
        details: { reason: "typed knowledge transfer snapshot already exists" },
      });
      return;
    }
  } catch (error) {
    blockImport(baseDir, filePath, sourceKind, sourceId, controlDb, report, error, payload);
    return;
  }

  try {
    const parsed = KnowledgeTransferSnapshotSchema.parse(JSON.parse(payload.raw) as unknown);
    await store.saveSnapshot(parsed);
    report.snapshots += 1;
    recordImport(controlDb, {
      sourceKind,
      sourceId,
      sourcePath: path.relative(baseDir, filePath),
      sourceChecksum: payload.checksum,
      sourceMtimeMs: payload.mtimeMs,
      status: "imported",
      details: {
        transfers: parsed.transfers.length,
        results: parsed.results.length,
        effectiveness_records: parsed.effectiveness_records.length,
        cross_goal_patterns: parsed.cross_goal_patterns.length,
      },
    });
  } catch (error) {
    blockImport(baseDir, filePath, sourceKind, sourceId, controlDb, report, error, payload);
  }
}

async function importLastAggregatedAt(
  baseDir: string,
  store: KnowledgeTransferStateStore,
  controlDb: ControlDatabase,
  report: KnowledgeTransferLegacyImportReport,
): Promise<void> {
  const sourceKind = "knowledge_transfer_meta_pattern_last_aggregated_at";
  const sourceId = "current";
  const filePath = path.join(baseDir, META_PATTERN_LAST_AGGREGATED_AT_PATH);
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
    if (await store.hasLastAggregatedAt()) {
      report.retiredExistingTypedState += 1;
      recordImport(controlDb, {
        sourceKind,
        sourceId,
        sourcePath: path.relative(baseDir, filePath),
        sourceChecksum: payload.checksum,
        sourceMtimeMs: payload.mtimeMs,
        status: "retired",
        details: { reason: "typed knowledge transfer meta-pattern watermark already exists" },
      });
      return;
    }
  } catch (error) {
    blockImport(baseDir, filePath, sourceKind, sourceId, controlDb, report, error, payload);
    return;
  }

  try {
    const parsed = parseLastAggregatedAt(JSON.parse(payload.raw) as unknown);
    await store.saveLastAggregatedAt(parsed.ts);
    report.metaPatternWatermarks += 1;
    recordImport(controlDb, {
      sourceKind,
      sourceId,
      sourcePath: path.relative(baseDir, filePath),
      sourceChecksum: payload.checksum,
      sourceMtimeMs: payload.mtimeMs,
      status: "imported",
      details: { ts: parsed.ts },
    });
  } catch (error) {
    blockImport(baseDir, filePath, sourceKind, sourceId, controlDb, report, error, payload);
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

function parseLastAggregatedAt(raw: unknown): { ts: string } {
  const parsed = zMetaPatternLastAggregatedAt.parse(raw);
  return parsed;
}

const zMetaPatternLastAggregatedAt = {
  parse(raw: unknown): { ts: string } {
    if (!raw || typeof raw !== "object" || !("ts" in raw)) {
      throw new Error("Legacy meta-pattern watermark must be an object with ts.");
    }
    const ts = (raw as { ts?: unknown }).ts;
    if (typeof ts !== "string" || Number.isNaN(Date.parse(ts))) {
      throw new Error("Legacy meta-pattern watermark ts must be an ISO timestamp string.");
    }
    return { ts };
  },
};

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
  report: KnowledgeTransferLegacyImportReport,
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
