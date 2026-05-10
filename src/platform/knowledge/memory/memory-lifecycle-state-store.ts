import * as path from "node:path";
import {
  LessonEntrySchema,
  MemoryDataTypeSchema,
  MemoryIndexEntrySchema,
  MemoryIndexSchema,
  ShortTermEntrySchema,
  StatisticalSummarySchema,
  type LessonEntry,
  type MemoryDataType,
  type MemoryIndex,
  type MemoryIndexEntry,
  type ShortTermEntry,
  type StatisticalSummary,
} from "../../../base/types/memory-lifecycle.js";
import {
  openControlDatabase,
  type ControlDatabase,
  type RuntimeControlDbStoreOptions,
  type SqliteDatabase,
} from "../../../runtime/store/control-db/index.js";
import { generateId } from "./memory-persistence.js";

export type MemoryLifecycleIndexLayer = "short-term" | "long-term";

export interface MemoryLifecycleStateStoreOptions extends RuntimeControlDbStoreOptions {}

interface JsonRow {
  entry_json: string;
}

interface LessonRow {
  lesson_json: string;
}

interface ShortTermRow {
  entry_json: string;
}

interface StatisticRow {
  summary_json: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}

function baseDirFromMemoryDir(memoryDir: string): string {
  const resolved = path.resolve(memoryDir);
  return path.basename(resolved) === "memory" ? path.dirname(resolved) : resolved;
}

function shortTermDataRef(goalId: string, dataType: MemoryDataType): string {
  return `memory-lifecycle:short-term:${goalId}:${dataType}`;
}

function lessonDataRef(goalId: string): string {
  return `memory-lifecycle:long-term:${goalId}:lessons`;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

export class MemoryLifecycleStateStore {
  private dbPromise: Promise<ControlDatabase> | null = null;

  constructor(
    private readonly memoryDir: string,
    private readonly options: MemoryLifecycleStateStoreOptions = {},
  ) {}

  async initialize(): Promise<void> {
    const db = await this.database();
    db.read(() => undefined);
  }

  async appendShortTermEntry(entry: ShortTermEntry): Promise<ShortTermEntry> {
    const parsed = ShortTermEntrySchema.parse(entry);
    const entries = await this.loadShortTermEntries(parsed.goal_id, parsed.data_type);
    await this.replaceShortTermEntries(parsed.goal_id, parsed.data_type, [...entries, parsed]);
    return parsed;
  }

  async loadShortTermEntries(goalId: string, dataType: MemoryDataType): Promise<ShortTermEntry[]> {
    const parsedType = MemoryDataTypeSchema.parse(dataType);
    const db = await this.database();
    return db.read((sqlite) => readShortTermEntries(sqlite, goalId, parsedType));
  }

  async loadShortTermEntry(entryId: string): Promise<ShortTermEntry | null> {
    const db = await this.database();
    return db.read((sqlite) => {
      const row = sqlite.prepare(`
        SELECT entry_json
        FROM memory_lifecycle_short_term_entries
        WHERE entry_id = ?
      `).get(entryId) as ShortTermRow | undefined;
      return row ? ShortTermEntrySchema.parse(parseJson<unknown>(row.entry_json)) : null;
    });
  }

  async replaceShortTermEntries(
    goalId: string,
    dataType: MemoryDataType,
    entries: ShortTermEntry[],
  ): Promise<void> {
    const parsedType = MemoryDataTypeSchema.parse(dataType);
    const parsed = entries.map((entry) => ShortTermEntrySchema.parse(entry));
    const db = await this.database();
    db.transaction((sqlite) => {
      sqlite.prepare(`
        DELETE FROM memory_lifecycle_short_term_entries
        WHERE goal_id = ? AND data_type = ?
      `).run(goalId, parsedType);
      insertShortTermEntries(sqlite, parsed);
    });
  }

  async deleteShortTermGoal(goalId: string): Promise<void> {
    const db = await this.database();
    db.transaction((sqlite) => {
      sqlite.prepare("DELETE FROM memory_lifecycle_short_term_entries WHERE goal_id = ?").run(goalId);
      sqlite.prepare("DELETE FROM memory_lifecycle_index_entries WHERE layer = 'short-term' AND goal_id = ?").run(goalId);
    });
  }

  async listShortTermGoalIds(): Promise<string[]> {
    const db = await this.database();
    return db.read((sqlite) => {
      const rows = sqlite.prepare(`
        SELECT DISTINCT goal_id
        FROM memory_lifecycle_short_term_entries
        ORDER BY goal_id ASC
      `).all() as Array<{ goal_id: string }>;
      return rows.map((row) => row.goal_id);
    });
  }

  async listShortTermDataTypes(goalId: string): Promise<MemoryDataType[]> {
    const db = await this.database();
    return db.read((sqlite) => {
      const rows = sqlite.prepare(`
        SELECT DISTINCT data_type
        FROM memory_lifecycle_short_term_entries
        WHERE goal_id = ?
        ORDER BY data_type ASC
      `).all(goalId) as Array<{ data_type: string }>;
      return rows.map((row) => MemoryDataTypeSchema.parse(row.data_type));
    });
  }

  async estimateShortTermGoalSize(goalId: string): Promise<number> {
    const db = await this.database();
    return db.read((sqlite) => {
      const row = sqlite.prepare(`
        SELECT COALESCE(SUM(LENGTH(entry_json)), 0) AS byte_count
        FROM memory_lifecycle_short_term_entries
        WHERE goal_id = ?
      `).get(goalId) as { byte_count: number };
      return row.byte_count;
    });
  }

  async estimateLongTermSize(): Promise<number> {
    const db = await this.database();
    return db.read((sqlite) => {
      const lesson = sqlite.prepare(`
        SELECT COALESCE(SUM(LENGTH(lesson_json)), 0) AS byte_count
        FROM memory_lifecycle_lessons
      `).get() as { byte_count: number };
      const stats = sqlite.prepare(`
        SELECT COALESCE(SUM(LENGTH(summary_json)), 0) AS byte_count
        FROM memory_lifecycle_statistics
      `).get() as { byte_count: number };
      return lesson.byte_count + stats.byte_count;
    });
  }

  async loadIndex(layer: MemoryLifecycleIndexLayer): Promise<MemoryIndex> {
    const db = await this.database();
    const entries = db.read((sqlite) => {
      const rows = sqlite.prepare(`
        SELECT entry_json
        FROM memory_lifecycle_index_entries
        WHERE layer = ?
        ORDER BY sort_order ASC, event_timestamp ASC, index_id ASC
      `).all(layer) as JsonRow[];
      return rows.map((row) => MemoryIndexEntrySchema.parse(parseJson<unknown>(row.entry_json)));
    });
    return MemoryIndexSchema.parse({
      version: 1,
      last_updated: nowIso(),
      entries,
    });
  }

  async saveIndex(layer: MemoryLifecycleIndexLayer, index: MemoryIndex): Promise<void> {
    const parsed = MemoryIndexSchema.parse(index);
    const db = await this.database();
    db.transaction((sqlite) => replaceIndex(sqlite, layer, parsed.entries));
  }

  async updateIndex(layer: MemoryLifecycleIndexLayer, entry: MemoryIndexEntry): Promise<void> {
    const parsed = MemoryIndexEntrySchema.parse(entry);
    const index = await this.loadIndex(layer);
    await this.saveIndex(layer, { ...index, entries: [...index.entries, parsed] });
  }

  async removeFromIndex(layer: MemoryLifecycleIndexLayer, entryIds: Set<string>): Promise<void> {
    const index = await this.loadIndex(layer);
    await this.saveIndex(layer, {
      ...index,
      entries: index.entries.filter((entry) => !entryIds.has(entry.entry_id)),
    });
  }

  async removeGoalFromIndex(layer: MemoryLifecycleIndexLayer, goalId: string): Promise<void> {
    const index = await this.loadIndex(layer);
    await this.saveIndex(layer, {
      ...index,
      entries: index.entries.filter((entry) => entry.goal_id !== goalId),
    });
  }

  async touchIndexEntry(layer: MemoryLifecycleIndexLayer, indexId: string): Promise<void> {
    const index = await this.loadIndex(layer);
    const touchedAt = nowIso();
    await this.saveIndex(layer, {
      ...index,
      entries: index.entries.map((entry) =>
        entry.id === indexId
          ? MemoryIndexEntrySchema.parse({
            ...entry,
            last_accessed: touchedAt,
            access_count: entry.access_count + 1,
          })
          : entry
      ),
    });
  }

  async storeLessonsLongTerm(
    goalId: string,
    lessons: LessonEntry[],
    sourceEntries: ShortTermEntry[],
  ): Promise<void> {
    const parsed = lessons.map((lesson) => LessonEntrySchema.parse(lesson));
    const db = await this.database();
    db.transaction((sqlite) => {
      const upsert = sqlite.prepare(`
        INSERT INTO memory_lifecycle_lessons (
          lesson_id,
          goal_id,
          status,
          extracted_at,
          lesson_json
        ) VALUES (?, ?, ?, ?, json(?))
        ON CONFLICT(lesson_id) DO UPDATE SET
          goal_id = excluded.goal_id,
          status = excluded.status,
          extracted_at = excluded.extracted_at,
          lesson_json = excluded.lesson_json
      `);
      for (const lesson of parsed) {
        upsert.run(lesson.lesson_id, lesson.goal_id, lesson.status, lesson.extracted_at, stringifyJson(lesson));
      }
    });

    const now = nowIso();
    for (const lesson of parsed) {
      await this.updateIndex("long-term", MemoryIndexEntrySchema.parse({
        id: generateId("ltidx"),
        goal_id: goalId,
        dimensions: unique(sourceEntries
          .filter((entry) => lesson.source_loops.includes(`loop_${entry.loop_number}`))
          .flatMap((entry) => entry.dimensions)),
        tags: lesson.relevance_tags,
        timestamp: lesson.extracted_at,
        data_file: lessonDataRef(goalId),
        entry_id: lesson.lesson_id,
        last_accessed: now,
        access_count: 0,
        embedding_id: null,
        memory_tier: "recall",
      }));
    }
  }

  async saveLessons(lessons: LessonEntry[]): Promise<void> {
    const parsed = lessons.map((lesson) => LessonEntrySchema.parse(lesson));
    const db = await this.database();
    db.transaction((sqlite) => {
      const upsert = sqlite.prepare(`
        INSERT INTO memory_lifecycle_lessons (
          lesson_id,
          goal_id,
          status,
          extracted_at,
          lesson_json
        ) VALUES (?, ?, ?, ?, json(?))
        ON CONFLICT(lesson_id) DO UPDATE SET
          goal_id = excluded.goal_id,
          status = excluded.status,
          extracted_at = excluded.extracted_at,
          lesson_json = excluded.lesson_json
      `);
      for (const lesson of parsed) {
        upsert.run(lesson.lesson_id, lesson.goal_id, lesson.status, lesson.extracted_at, stringifyJson(lesson));
      }
    });
  }

  async loadLessons(input: {
    goalId?: string;
    status?: LessonEntry["status"];
  } = {}): Promise<LessonEntry[]> {
    const db = await this.database();
    return db.read((sqlite) => {
      const where: string[] = [];
      const params: unknown[] = [];
      if (input.goalId) {
        where.push("goal_id = ?");
        params.push(input.goalId);
      }
      if (input.status) {
        where.push("status = ?");
        params.push(input.status);
      }
      const rows = sqlite.prepare(`
        SELECT lesson_json
        FROM memory_lifecycle_lessons
        ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY extracted_at DESC, lesson_id ASC
      `).all(...params) as LessonRow[];
      return rows.map((row) => LessonEntrySchema.parse(parseJson<unknown>(row.lesson_json)));
    });
  }

  async queryLessons(tags: string[], dimensions: string[], maxCount: number): Promise<LessonEntry[]> {
    const active = await this.loadLessons({ status: "active" });
    const results: LessonEntry[] = [];
    const seen = new Set<string>();

    for (const dim of dimensions) {
      for (const lesson of active) {
        if (results.length >= maxCount) break;
        if (seen.has(lesson.lesson_id)) continue;
        if (lesson.relevance_tags.includes(dim)) {
          results.push(lesson);
          seen.add(lesson.lesson_id);
        }
      }
    }

    if (results.length < maxCount && tags.length > 0) {
      const matching = active.filter((lesson) =>
        !seen.has(lesson.lesson_id) && tags.some((tag) => lesson.relevance_tags.includes(tag))
      );
      for (const lesson of matching) {
        if (results.length >= maxCount) break;
        results.push(lesson);
        seen.add(lesson.lesson_id);
      }
    }

    return results;
  }

  async queryCrossGoalLessons(
    tags: string[],
    dimensions: string[],
    excludeGoalId: string,
    maxCount: number,
  ): Promise<LessonEntry[]> {
    const active = await this.loadLessons({ status: "active" });
    return active
      .filter((lesson) =>
        lesson.goal_id !== excludeGoalId &&
        (tags.some((tag) => lesson.relevance_tags.includes(tag)) ||
          dimensions.some((dimension) => lesson.relevance_tags.includes(dimension)))
      )
      .slice(0, maxCount);
  }

  async archiveOldestLongTermEntries(): Promise<void> {
    const index = await this.loadIndex("long-term");
    const sorted = [...index.entries].sort(
      (left, right) => new Date(left.last_accessed).getTime() - new Date(right.last_accessed).getTime()
    );
    const archiveCount = Math.max(1, Math.floor(sorted.length * 0.1));
    const archivedIds = new Set(sorted.slice(0, archiveCount).map((entry) => entry.entry_id));
    await this.removeFromIndex("long-term", archivedIds);
    await this.markLessonsArchived(archivedIds);
  }

  async loadStatistics(goalId: string): Promise<StatisticalSummary | null> {
    const db = await this.database();
    return db.read((sqlite) => {
      const row = sqlite.prepare(`
        SELECT summary_json
        FROM memory_lifecycle_statistics
        WHERE goal_id = ?
      `).get(goalId) as StatisticRow | undefined;
      return row ? StatisticalSummarySchema.parse(parseJson<unknown>(row.summary_json)) : null;
    });
  }

  async saveStatistics(summary: StatisticalSummary): Promise<void> {
    const parsed = StatisticalSummarySchema.parse(summary);
    const db = await this.database();
    db.transaction((sqlite) => {
      sqlite.prepare(`
        INSERT INTO memory_lifecycle_statistics (goal_id, updated_at, summary_json)
        VALUES (?, ?, json(?))
        ON CONFLICT(goal_id) DO UPDATE SET
          updated_at = excluded.updated_at,
          summary_json = excluded.summary_json
      `).run(parsed.goal_id, parsed.updated_at, stringifyJson(parsed));
    });
  }

  async archiveGoal(goalId: string, reason: "completed" | "cancelled"): Promise<void> {
    const db = await this.database();
    db.transaction((sqlite) => {
      const archiveId = generateId("memory-archive");
      const shortTermRows = sqlite.prepare(`
        SELECT entry_json
        FROM memory_lifecycle_short_term_entries
        WHERE goal_id = ?
        ORDER BY sort_order ASC, entry_id ASC
      `).all(goalId) as ShortTermRow[];
      sqlite.prepare(`
        INSERT INTO memory_lifecycle_archives (
          archive_id,
          goal_id,
          archive_kind,
          data_type,
          archived_at,
          archive_json
        ) VALUES (?, ?, ?, ?, ?, json(?))
      `).run(
        archiveId,
        goalId,
        "goal_close",
        null,
        nowIso(),
        stringifyJson({
          reason,
          short_term_entries: shortTermRows.map((row) => parseJson<unknown>(row.entry_json)),
        }),
      );
      sqlite.prepare("DELETE FROM memory_lifecycle_short_term_entries WHERE goal_id = ?").run(goalId);
      sqlite.prepare("DELETE FROM memory_lifecycle_index_entries WHERE layer = 'short-term' AND goal_id = ?").run(goalId);
      const lessonRows = sqlite.prepare(`
        SELECT lesson_json
        FROM memory_lifecycle_lessons
        WHERE goal_id = ?
      `).all(goalId) as LessonRow[];
      const updateLesson = sqlite.prepare(`
        UPDATE memory_lifecycle_lessons
        SET status = 'archived',
            lesson_json = json(?)
        WHERE lesson_id = ?
      `);
      for (const row of lessonRows) {
        const lesson = LessonEntrySchema.parse(parseJson<unknown>(row.lesson_json));
        const archived = LessonEntrySchema.parse({ ...lesson, status: "archived" });
        updateLesson.run(stringifyJson(archived), archived.lesson_id);
      }
    });
  }

  async loadArchives(goalId: string): Promise<unknown[]> {
    const db = await this.database();
    return db.read((sqlite) => {
      const rows = sqlite.prepare(`
        SELECT archive_json
        FROM memory_lifecycle_archives
        WHERE goal_id = ?
        ORDER BY archived_at ASC, archive_id ASC
      `).all(goalId) as Array<{ archive_json: string }>;
      return rows.map((row) => parseJson<unknown>(row.archive_json));
    });
  }

  async saveArchive(input: {
    goalId: string;
    archiveKind: string;
    dataType?: string | null;
    archivedAt?: string;
    archive: unknown;
  }): Promise<void> {
    const db = await this.database();
    db.transaction((sqlite) => {
      sqlite.prepare(`
        INSERT INTO memory_lifecycle_archives (
          archive_id,
          goal_id,
          archive_kind,
          data_type,
          archived_at,
          archive_json
        ) VALUES (?, ?, ?, ?, ?, json(?))
      `).run(
        generateId("memory-archive"),
        input.goalId,
        input.archiveKind,
        input.dataType ?? null,
        input.archivedAt ?? nowIso(),
        stringifyJson(input.archive),
      );
    });
  }

  private async markLessonsArchived(lessonIds: Set<string>): Promise<void> {
    if (lessonIds.size === 0) return;
    const db = await this.database();
    db.transaction((sqlite) => {
      const select = sqlite.prepare("SELECT lesson_json FROM memory_lifecycle_lessons WHERE lesson_id = ?");
      const update = sqlite.prepare(`
        UPDATE memory_lifecycle_lessons
        SET status = 'archived',
            lesson_json = json(?)
        WHERE lesson_id = ?
      `);
      for (const lessonId of lessonIds) {
        const row = select.get(lessonId) as LessonRow | undefined;
        if (!row) continue;
        const archived = LessonEntrySchema.parse({
          ...LessonEntrySchema.parse(parseJson<unknown>(row.lesson_json)),
          status: "archived",
        });
        update.run(stringifyJson(archived), lessonId);
      }
    });
  }

  private async database(): Promise<ControlDatabase> {
    if (this.options.controlDb) {
      return this.options.controlDb;
    }
    this.dbPromise ??= openControlDatabase({
      baseDir: this.options.controlBaseDir ?? baseDirFromMemoryDir(this.memoryDir),
      dbPath: this.options.controlDbPath,
    });
    return this.dbPromise;
  }
}

function readShortTermEntries(
  sqlite: SqliteDatabase,
  goalId: string,
  dataType: MemoryDataType,
): ShortTermEntry[] {
  const rows = sqlite.prepare(`
    SELECT entry_json
    FROM memory_lifecycle_short_term_entries
    WHERE goal_id = ? AND data_type = ?
    ORDER BY sort_order ASC, loop_number ASC, event_timestamp ASC, entry_id ASC
  `).all(goalId, dataType) as ShortTermRow[];
  return rows.map((row) => ShortTermEntrySchema.parse(parseJson<unknown>(row.entry_json)));
}

function insertShortTermEntries(sqlite: SqliteDatabase, entries: ShortTermEntry[]): void {
  const insert = sqlite.prepare(`
    INSERT INTO memory_lifecycle_short_term_entries (
      entry_id,
      goal_id,
      data_type,
      loop_number,
      event_timestamp,
      memory_tier,
      sort_order,
      entry_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, json(?))
    ON CONFLICT(entry_id) DO UPDATE SET
      goal_id = excluded.goal_id,
      data_type = excluded.data_type,
      loop_number = excluded.loop_number,
      event_timestamp = excluded.event_timestamp,
      memory_tier = excluded.memory_tier,
      sort_order = excluded.sort_order,
      entry_json = excluded.entry_json
  `);
  entries.forEach((entry, index) => {
    insert.run(
      entry.id,
      entry.goal_id,
      entry.data_type,
      entry.loop_number,
      entry.timestamp,
      entry.memory_tier,
      index,
      stringifyJson(entry),
    );
  });
}

function replaceIndex(
  sqlite: SqliteDatabase,
  layer: MemoryLifecycleIndexLayer,
  entries: MemoryIndexEntry[],
): void {
  sqlite.prepare("DELETE FROM memory_lifecycle_index_entries WHERE layer = ?").run(layer);
  const insert = sqlite.prepare(`
    INSERT INTO memory_lifecycle_index_entries (
      index_id,
      layer,
      entry_id,
      goal_id,
      event_timestamp,
      last_accessed,
      access_count,
      memory_tier,
      sort_order,
      entry_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, json(?))
  `);
  entries.forEach((entry, index) => {
    insert.run(
      entry.id,
      layer,
      entry.entry_id,
      entry.goal_id,
      entry.timestamp,
      entry.last_accessed,
      entry.access_count,
      entry.memory_tier,
      index,
      stringifyJson(entry),
    );
  });
}

export function memoryLifecycleShortTermDataRef(goalId: string, dataType: MemoryDataType): string {
  return shortTermDataRef(goalId, dataType);
}
