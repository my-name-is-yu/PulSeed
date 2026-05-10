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
import {
  LearningRuntimeStateStore,
  parseLearningRuntimeRawPath,
  type LearningRuntimeRawKind,
} from "./learning-runtime-state-store.js";
import {
  FeedbackEntrySchema,
  LearnedPatternSchema,
  StructuralFeedbackSchema,
} from "../../base/types/learning.js";

const MIGRATION_NAME = "learning-runtime-state";
const MIGRATION_VERSION = 19;

export interface LearningRuntimeLegacyImportReport {
  experienceLogs: number;
  patterns: number;
  feedbackEntries: number;
  structuralFeedback: number;
  skippedAlreadyImported: number;
  retiredExistingTypedState: number;
  blockedSources: Array<{ sourceKind: string; sourcePath: string; reason: string }>;
}

export async function importLegacyLearningRuntimeState(
  baseDir: string,
  options: RuntimeControlDbStoreOptions = {},
): Promise<LearningRuntimeLegacyImportReport> {
  const controlDb = options.controlDb ?? await openControlDatabase({
    baseDir: options.controlBaseDir ?? baseDir,
    dbPath: options.controlDbPath,
  });
  const store = new LearningRuntimeStateStore(baseDir, { ...options, controlDb });
  const report: LearningRuntimeLegacyImportReport = {
    experienceLogs: 0,
    patterns: 0,
    feedbackEntries: 0,
    structuralFeedback: 0,
    skippedAlreadyImported: 0,
    retiredExistingTypedState: 0,
    blockedSources: [],
  };

  try {
    await importLearningFiles(baseDir, store, controlDb, report);
    return report;
  } finally {
    if (!options.controlDb) {
      controlDb.close();
    }
  }
}

async function importLearningFiles(
  baseDir: string,
  store: LearningRuntimeStateStore,
  controlDb: ControlDatabase,
  report: LearningRuntimeLegacyImportReport,
): Promise<void> {
  const learningDir = path.join(baseDir, "learning");
  for (const entry of await readDir(learningDir)) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const match = parseLearningRuntimeRawPath(path.join("learning", entry.name));
    if (!match) continue;
    const sourceKind = sourceKindForRawKind(match.kind);
    const sourceId = `${match.kind}:${match.goalId}`;
    const filePath = path.join(learningDir, entry.name);
    if (hasCompletedImportRecord(controlDb, sourceKind, sourceId)) {
      report.skippedAlreadyImported += 1;
      continue;
    }

    let payload: { raw: string; checksum: string; mtimeMs: number };
    try {
      payload = await readLegacyTextFile(filePath);
    } catch (error) {
      blockImport(baseDir, filePath, sourceKind, sourceId, controlDb, report, error);
      continue;
    }

    try {
      if (await store.hasLearningState(match.goalId, match.kind)) {
        report.retiredExistingTypedState += 1;
        recordImport(controlDb, {
          sourceKind,
          sourceId,
          sourcePath: path.relative(baseDir, filePath),
          sourceChecksum: payload.checksum,
          sourceMtimeMs: payload.mtimeMs,
          status: "retired",
          details: { reason: "typed learning runtime state already exists" },
        });
        continue;
      }
    } catch (error) {
      blockImport(baseDir, filePath, sourceKind, sourceId, controlDb, report, error, payload);
      continue;
    }

    try {
      const parsedRaw = JSON.parse(payload.raw) as unknown;
      await saveImportedState(store, match.goalId, match.kind, parsedRaw);
      incrementReport(report, match.kind);
      recordImport(controlDb, {
        sourceKind,
        sourceId,
        sourcePath: path.relative(baseDir, filePath),
        sourceChecksum: payload.checksum,
        sourceMtimeMs: payload.mtimeMs,
        status: "imported",
        details: { goal_id: match.goalId, kind: match.kind },
      });
    } catch (error) {
      blockImport(baseDir, filePath, sourceKind, sourceId, controlDb, report, error, payload);
    }
  }
}

async function saveImportedState(
  store: LearningRuntimeStateStore,
  goalId: string,
  kind: LearningRuntimeRawKind,
  raw: unknown,
): Promise<void> {
  switch (kind) {
    case "logs":
      await store.saveExperienceLogs(goalId, raw);
      return;
    case "patterns":
      await store.savePatterns(goalId, parseArray(raw, (item) => LearnedPatternSchema.parse(item)));
      return;
    case "feedback":
      await store.saveFeedbackEntries(goalId, parseArray(raw, (item) => FeedbackEntrySchema.parse(item)));
      return;
    case "structural_feedback":
      await store.saveStructuralFeedback(goalId, parseArray(raw, (item) => StructuralFeedbackSchema.parse(item)));
      return;
  }
}

function parseArray<T>(value: unknown, itemParser: (item: unknown) => T): T[] {
  if (!Array.isArray(value)) {
    throw new Error("Legacy learning runtime state must be an array.");
  }
  return value.map((item) => itemParser(item));
}

async function readDir(dir: string): Promise<Dirent[]> {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
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

function sourceKindForRawKind(kind: LearningRuntimeRawKind): string {
  switch (kind) {
    case "logs":
      return "learning_experience_logs";
    case "patterns":
      return "learning_patterns";
    case "feedback":
      return "learning_feedback_entries";
    case "structural_feedback":
      return "learning_structural_feedback";
  }
}

function incrementReport(report: LearningRuntimeLegacyImportReport, kind: LearningRuntimeRawKind): void {
  switch (kind) {
    case "logs":
      report.experienceLogs += 1;
      return;
    case "patterns":
      report.patterns += 1;
      return;
    case "feedback":
      report.feedbackEntries += 1;
      return;
    case "structural_feedback":
      report.structuralFeedback += 1;
      return;
  }
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
  report: LearningRuntimeLegacyImportReport,
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
