import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { DreamDecisionHeuristicFileSchema } from "../../platform/dream/dream-decision-heuristics.js";
import {
  openControlDatabase,
  type ControlDatabase,
} from "./control-db/index.js";
import {
  readDreamDecisionHeuristics,
  replaceDreamDecisionHeuristics,
} from "./dream-decision-heuristic-store.js";

const MIGRATION_NAME = "dream-decision-heuristics-control-db";
const MIGRATION_VERSION = 1;
const LEGACY_SOURCE_KIND = "dream_decision_heuristics";
const LEGACY_SOURCE_ID = "current";

export interface DreamDecisionHeuristicImportReport {
  imported: boolean;
  skipped: "missing" | "already-owned" | null;
  blocked: boolean;
  heuristicCount: number;
}

function checksum(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function legacyDecisionHeuristicsPath(baseDir: string): string {
  return path.join(baseDir, "dream", "decision-heuristics.json");
}

export async function importLegacyDreamDecisionHeuristics(
  baseDir: string
): Promise<DreamDecisionHeuristicImportReport> {
  const filePath = legacyDecisionHeuristicsPath(baseDir);
  let sourceText: string;
  let stat: Awaited<ReturnType<typeof fsp.stat>>;
  try {
    [sourceText, stat] = await Promise.all([
      fsp.readFile(filePath, "utf8"),
      fsp.stat(filePath),
    ]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { imported: false, skipped: "missing", blocked: false, heuristicCount: 0 };
    }
    throw error;
  }

  const database = await openControlDatabase({ baseDir });
  try {
    const existing = database.read((sqlite) => readDreamDecisionHeuristics(sqlite));
    const priorImported = database.listLegacyImports().find((record) =>
      record.source_kind === LEGACY_SOURCE_KIND &&
      record.source_id === LEGACY_SOURCE_ID &&
      record.migration_name === MIGRATION_NAME &&
      record.status === "imported"
    );
    if (existing.length > 0 || priorImported) {
      return { imported: false, skipped: "already-owned", blocked: false, heuristicCount: existing.length };
    }

    const sourcePath = path.relative(baseDir, filePath);
    const sourceChecksum = checksum(sourceText);
    const parsed = DreamDecisionHeuristicFileSchema.safeParse(JSON.parse(sourceText) as unknown);
    if (!parsed.success) {
      recordLegacyImport(database, sourcePath, sourceChecksum, stat.mtimeMs, "blocked", {
        error: parsed.error.message,
      });
      return { imported: false, skipped: null, blocked: true, heuristicCount: 0 };
    }

    database.transaction((sqlite) => replaceDreamDecisionHeuristics(sqlite, parsed.data.heuristics));
    recordLegacyImport(database, sourcePath, sourceChecksum, stat.mtimeMs, "imported", {
      heuristic_count: parsed.data.heuristics.length,
    });
    return {
      imported: true,
      skipped: null,
      blocked: false,
      heuristicCount: parsed.data.heuristics.length,
    };
  } catch (error) {
    if (error instanceof SyntaxError) {
      recordLegacyImport(database, path.relative(baseDir, filePath), checksum(sourceText), stat.mtimeMs, "blocked", {
        error: error.message,
      });
      return { imported: false, skipped: null, blocked: true, heuristicCount: 0 };
    }
    throw error;
  } finally {
    database.close();
  }
}

function recordLegacyImport(
  database: ControlDatabase,
  sourcePath: string,
  sourceChecksum: string,
  sourceMtimeMs: number,
  status: "imported" | "blocked",
  details: Record<string, unknown>,
): void {
  database.recordLegacyImport({
    sourceKind: LEGACY_SOURCE_KIND,
    sourceId: LEGACY_SOURCE_ID,
    sourcePath,
    sourceChecksum,
    sourceMtimeMs,
    migrationName: MIGRATION_NAME,
    migrationVersion: MIGRATION_VERSION,
    status,
    details,
  });
}
