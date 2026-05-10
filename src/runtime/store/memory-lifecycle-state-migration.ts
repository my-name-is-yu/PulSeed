import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { Dirent } from "node:fs";
import { z } from "zod";
import {
  LessonEntrySchema,
  MemoryDataTypeSchema,
  MemoryIndexEntrySchema,
  MemoryIndexSchema,
  ShortTermEntrySchema,
  StatisticalSummarySchema,
  type LessonEntry,
  type MemoryDataType,
} from "../../base/types/memory-lifecycle.js";
import {
  MemoryLifecycleStateStore,
  memoryLifecycleShortTermDataRef,
} from "../../platform/knowledge/memory/memory-lifecycle-state-store.js";
import {
  openControlDatabase,
  type ControlDatabase,
  type RuntimeControlDbStoreOptions,
} from "./control-db/index.js";

const MIGRATION_NAME = "memory-lifecycle-control-db-state";
const MIGRATION_VERSION = 16;

const SHORT_TERM_FILES: Record<MemoryDataType, string> = {
  experience_log: "experience-log.json",
  observation: "observations.json",
  strategy: "strategies.json",
  task: "tasks.json",
  knowledge: "knowledge.json",
};

export interface MemoryLifecycleLegacyImportReport {
  shortTermFiles: number;
  shortTermEntries: number;
  indexFiles: number;
  indexEntries: number;
  lessonFiles: number;
  lessons: number;
  statisticsFiles: number;
  archives: number;
  blockedSources: Array<{ sourceKind: string; sourcePath: string; reason: string }>;
}

interface ImportPayload {
  raw: string;
  checksum: string;
  mtimeMs: number;
}

export async function importLegacyMemoryLifecycleState(
  baseDir: string,
  options: RuntimeControlDbStoreOptions = {},
): Promise<MemoryLifecycleLegacyImportReport> {
  const controlDb = options.controlDb ?? await openControlDatabase({
    baseDir: options.controlBaseDir ?? baseDir,
    dbPath: options.controlDbPath,
  });
  const memoryDir = path.join(baseDir, "memory");
  const store = new MemoryLifecycleStateStore(memoryDir, { ...options, controlDb });
  const report: MemoryLifecycleLegacyImportReport = {
    shortTermFiles: 0,
    shortTermEntries: 0,
    indexFiles: 0,
    indexEntries: 0,
    lessonFiles: 0,
    lessons: 0,
    statisticsFiles: 0,
    archives: 0,
    blockedSources: [],
  };

  try {
    await importShortTermState(baseDir, memoryDir, store, controlDb, report);
    await importIndex(baseDir, memoryDir, "short-term", store, controlDb, report);
    await importLessons(baseDir, memoryDir, store, controlDb, report);
    await importIndex(baseDir, memoryDir, "long-term", store, controlDb, report);
    await importStatistics(baseDir, memoryDir, store, controlDb, report);
    await importArchives(baseDir, memoryDir, store, controlDb, report);
    return report;
  } finally {
    if (!options.controlDb) {
      controlDb.close();
    }
  }
}

async function importShortTermState(
  baseDir: string,
  memoryDir: string,
  store: MemoryLifecycleStateStore,
  controlDb: ControlDatabase,
  report: MemoryLifecycleLegacyImportReport,
): Promise<void> {
  const goalsDir = path.join(memoryDir, "short-term", "goals");
  for (const goalEntry of await readDir(goalsDir)) {
    if (!goalEntry.isDirectory()) continue;
    const goalId = goalEntry.name;
    for (const [dataType, fileName] of Object.entries(SHORT_TERM_FILES) as Array<[MemoryDataType, string]>) {
      const filePath = path.join(goalsDir, goalId, fileName);
      await importJson({
        baseDir,
        filePath,
        sourceKind: "memory_lifecycle_short_term",
        sourceId: `${goalId}:${dataType}`,
        controlDb,
        report,
        onImport: async (raw) => {
          const entries = z.array(ShortTermEntrySchema).parse(raw);
          const mismatched = entries.find((entry) => entry.goal_id !== goalId || entry.data_type !== dataType);
          if (mismatched) {
            throw new Error(`short-term entry "${mismatched.id}" does not match legacy path goal/data type`);
          }
          await store.replaceShortTermEntries(goalId, dataType, entries);
          for (const [index, entry] of entries.entries()) {
            await store.updateIndex("short-term", MemoryIndexEntrySchema.parse({
              id: `legacy-stidx-${entry.id}`,
              goal_id: goalId,
              dimensions: entry.dimensions,
              tags: entry.tags,
              timestamp: entry.timestamp,
              data_file: memoryLifecycleShortTermDataRef(goalId, dataType),
              entry_id: entry.id,
              last_accessed: entry.timestamp,
              access_count: 0,
              embedding_id: entry.embedding_id,
              memory_tier: entry.memory_tier,
              sort_order: index,
            }));
          }
          report.shortTermFiles += 1;
          report.shortTermEntries += entries.length;
          return { entry_count: entries.length };
        },
      });
    }
  }
}

async function importIndex(
  baseDir: string,
  memoryDir: string,
  layer: "short-term" | "long-term",
  store: MemoryLifecycleStateStore,
  controlDb: ControlDatabase,
  report: MemoryLifecycleLegacyImportReport,
): Promise<void> {
  const filePath = path.join(memoryDir, layer, "index.json");
  await importJson({
    baseDir,
    filePath,
    sourceKind: `memory_lifecycle_${layer}_index`,
    sourceId: layer,
    controlDb,
    report,
    onImport: async (raw) => {
      const parsed = MemoryIndexSchema.parse(raw);
      await store.saveIndex(layer, {
        ...parsed,
        entries: parsed.entries.map((entry) => normalizeLegacyIndexEntry(layer, entry)),
      });
      report.indexFiles += 1;
      report.indexEntries += parsed.entries.length;
      return { entry_count: parsed.entries.length };
    },
  });
}

async function importLessons(
  baseDir: string,
  memoryDir: string,
  store: MemoryLifecycleStateStore,
  controlDb: ControlDatabase,
  report: MemoryLifecycleLegacyImportReport,
): Promise<void> {
  const lessonsDir = path.join(memoryDir, "long-term", "lessons");
  const byGoalDir = path.join(lessonsDir, "by-goal");
  for (const entry of await readDir(byGoalDir)) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const goalId = path.basename(entry.name, ".json");
    await importLessonFile({
      baseDir,
      filePath: path.join(byGoalDir, entry.name),
      sourceId: `by-goal:${goalId}`,
      store,
      controlDb,
      report,
      validate: (lesson) => {
        if (lesson.goal_id !== goalId) {
          throw new Error(`lesson "${lesson.lesson_id}" does not match legacy by-goal path "${goalId}"`);
        }
      },
    });
  }

  const byDimensionDir = path.join(lessonsDir, "by-dimension");
  for (const entry of await readDir(byDimensionDir)) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    await importLessonFile({
      baseDir,
      filePath: path.join(byDimensionDir, entry.name),
      sourceId: `by-dimension:${path.basename(entry.name, ".json")}`,
      store,
      controlDb,
      report,
    });
  }

  await importLessonFile({
    baseDir,
    filePath: path.join(lessonsDir, "global.json"),
    sourceId: "global",
    store,
    controlDb,
    report,
  });
}

async function importLessonFile(input: {
  baseDir: string;
  filePath: string;
  sourceId: string;
  store: MemoryLifecycleStateStore;
  controlDb: ControlDatabase;
  report: MemoryLifecycleLegacyImportReport;
  validate?: (lesson: LessonEntry) => void;
}): Promise<void> {
  await importJson({
    baseDir: input.baseDir,
    filePath: input.filePath,
    sourceKind: "memory_lifecycle_lessons",
    sourceId: input.sourceId,
    controlDb: input.controlDb,
    report: input.report,
    onImport: async (raw) => {
      const lessons = z.array(LessonEntrySchema).parse(raw);
      for (const lesson of lessons) {
        input.validate?.(lesson);
      }
      await input.store.saveLessons(lessons);
      input.report.lessonFiles += 1;
      input.report.lessons += lessons.length;
      return { lesson_count: lessons.length };
    },
  });
}

async function importStatistics(
  baseDir: string,
  memoryDir: string,
  store: MemoryLifecycleStateStore,
  controlDb: ControlDatabase,
  report: MemoryLifecycleLegacyImportReport,
): Promise<void> {
  const statisticsDir = path.join(memoryDir, "long-term", "statistics");
  for (const entry of await readDir(statisticsDir)) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const goalId = path.basename(entry.name, ".json");
    await importJson({
      baseDir,
      filePath: path.join(statisticsDir, entry.name),
      sourceKind: "memory_lifecycle_statistics",
      sourceId: goalId,
      controlDb,
      report,
      onImport: async (raw) => {
        const summary = StatisticalSummarySchema.parse(raw);
        if (summary.goal_id !== goalId) {
          throw new Error(`statistics goal_id "${summary.goal_id}" does not match legacy path goal "${goalId}"`);
        }
        await store.saveStatistics(summary);
        report.statisticsFiles += 1;
        return { goal_id: summary.goal_id };
      },
    });
  }
}

async function importArchives(
  baseDir: string,
  memoryDir: string,
  store: MemoryLifecycleStateStore,
  controlDb: ControlDatabase,
  report: MemoryLifecycleLegacyImportReport,
): Promise<void> {
  const archiveDir = path.join(memoryDir, "archive");
  for (const goalEntry of await readDir(archiveDir)) {
    if (!goalEntry.isDirectory()) continue;
    const goalId = goalEntry.name;
    const goalArchiveDir = path.join(archiveDir, goalId);
    for (const fileEntry of await readDir(goalArchiveDir)) {
      if (!fileEntry.isFile() || !fileEntry.name.endsWith(".json")) continue;
      const filePath = path.join(goalArchiveDir, fileEntry.name);
      await importJson({
        baseDir,
        filePath,
        sourceKind: "memory_lifecycle_archive",
        sourceId: `${goalId}:${fileEntry.name}`,
        controlDb,
        report,
        onImport: async (raw) => {
          await store.saveArchive({
            goalId,
            archiveKind: "legacy_goal_archive",
            dataType: legacyArchiveDataType(fileEntry.name),
            archive: raw,
          });
          report.archives += 1;
          return { goal_id: goalId, file: fileEntry.name };
        },
      });
    }
  }
}

async function importJson(input: {
  baseDir: string;
  filePath: string;
  sourceKind: string;
  sourceId: string;
  controlDb: ControlDatabase;
  report: MemoryLifecycleLegacyImportReport;
  onImport: (raw: unknown) => Promise<Record<string, unknown>>;
}): Promise<void> {
  if (hasCompletedLegacyImport(input.controlDb, input.sourceKind, input.sourceId)) return;

  let payload: ImportPayload;
  try {
    payload = await readLegacyTextFile(input.filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    recordBlockedImport(input, error);
    return;
  }

  try {
    const details = await input.onImport(JSON.parse(payload.raw) as unknown);
    input.controlDb.recordLegacyImport({
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      sourcePath: relativeSourcePath(input.baseDir, input.filePath),
      sourceChecksum: payload.checksum,
      sourceMtimeMs: payload.mtimeMs,
      migrationName: MIGRATION_NAME,
      migrationVersion: MIGRATION_VERSION,
      status: "imported",
      details,
    });
  } catch (error) {
    recordBlockedImport(input, error, payload);
  }
}

async function readLegacyTextFile(filePath: string): Promise<ImportPayload> {
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

function normalizeLegacyIndexEntry(
  layer: "short-term" | "long-term",
  entry: z.infer<typeof MemoryIndexEntrySchema>,
): z.infer<typeof MemoryIndexEntrySchema> {
  if (layer === "long-term") {
    return MemoryIndexEntrySchema.parse({
      ...entry,
      data_file: `memory-lifecycle:long-term:${entry.goal_id}:lessons`,
    });
  }

  const dataType = inferShortTermDataType(entry.data_file);
  return MemoryIndexEntrySchema.parse({
    ...entry,
    data_file: dataType ? memoryLifecycleShortTermDataRef(entry.goal_id, dataType) : entry.data_file,
  });
}

function inferShortTermDataType(dataFile: string): MemoryDataType | null {
  const fileName = path.basename(dataFile);
  for (const [dataType, legacyFileName] of Object.entries(SHORT_TERM_FILES) as Array<[MemoryDataType, string]>) {
    if (fileName === legacyFileName) return MemoryDataTypeSchema.parse(dataType);
  }
  return null;
}

function legacyArchiveDataType(fileName: string): string | null {
  const fileBase = path.basename(fileName, ".json");
  for (const [dataType, legacyFileName] of Object.entries(SHORT_TERM_FILES) as Array<[MemoryDataType, string]>) {
    if (fileName === legacyFileName) return dataType;
  }
  return fileBase === "lessons" || fileBase === "statistics" ? fileBase : null;
}

function recordBlockedImport(
  input: {
    baseDir: string;
    filePath: string;
    sourceKind: string;
    sourceId: string;
    controlDb: ControlDatabase;
    report: MemoryLifecycleLegacyImportReport;
  },
  error: unknown,
  payload?: ImportPayload,
): void {
  const reason = error instanceof Error ? error.message : String(error);
  const sourcePath = relativeSourcePath(input.baseDir, input.filePath);
  input.report.blockedSources.push({ sourceKind: input.sourceKind, sourcePath, reason });
  input.controlDb.recordLegacyImport({
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    sourcePath,
    sourceChecksum: payload?.checksum ?? null,
    sourceMtimeMs: payload?.mtimeMs ?? null,
    migrationName: MIGRATION_NAME,
    migrationVersion: MIGRATION_VERSION,
    status: "blocked",
    details: { reason },
  });
}

function hasCompletedLegacyImport(
  controlDb: ControlDatabase,
  sourceKind: string,
  sourceId: string,
): boolean {
  return controlDb.listLegacyImports().some((record) =>
    record.migration_name === MIGRATION_NAME
    && record.source_kind === sourceKind
    && record.source_id === sourceId
    && (record.status === "imported" || record.status === "retired")
  );
}

async function readDir(dir: string): Promise<Dirent[]> {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function relativeSourcePath(baseDir: string, filePath: string): string {
  const relative = path.relative(baseDir, filePath);
  return relative.startsWith("..") ? filePath : relative;
}
