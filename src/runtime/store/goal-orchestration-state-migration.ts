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
import { GoalOrchestrationStateStore } from "./goal-orchestration-state-store.js";
import { DependencyGraphSchema } from "../../base/types/dependency.js";
import { NegotiationLogSchema } from "../../base/types/negotiation.js";

const MIGRATION_NAME = "goal-orchestration-runtime-state";
const MIGRATION_VERSION = 17;

export interface GoalOrchestrationLegacyImportReport {
  negotiationLogs: number;
  dependencyGraphs: number;
  skippedAlreadyImported: number;
  retiredExistingTypedState: number;
  blockedSources: Array<{ sourceKind: string; sourcePath: string; reason: string }>;
}

export async function importLegacyGoalOrchestrationState(
  baseDir: string,
  options: RuntimeControlDbStoreOptions = {},
): Promise<GoalOrchestrationLegacyImportReport> {
  const controlDb = options.controlDb ?? await openControlDatabase({
    baseDir: options.controlBaseDir ?? baseDir,
    dbPath: options.controlDbPath,
  });
  const store = new GoalOrchestrationStateStore(baseDir, { ...options, controlDb });
  const report: GoalOrchestrationLegacyImportReport = {
    negotiationLogs: 0,
    dependencyGraphs: 0,
    skippedAlreadyImported: 0,
    retiredExistingTypedState: 0,
    blockedSources: [],
  };

  try {
    await importDependencyGraph(baseDir, store, controlDb, report);
    await importNegotiationLogs(baseDir, store, controlDb, report);
    return report;
  } finally {
    if (!options.controlDb) {
      controlDb.close();
    }
  }
}

async function importDependencyGraph(
  baseDir: string,
  store: GoalOrchestrationStateStore,
  controlDb: ControlDatabase,
  report: GoalOrchestrationLegacyImportReport,
): Promise<void> {
  const filePath = path.join(baseDir, "dependency-graph.json");
  if (hasCompletedImportRecord(controlDb, "goal_dependency_graph", "current")) {
    report.skippedAlreadyImported += 1;
    return;
  }
  let payload: { raw: string; checksum: string; mtimeMs: number };
  try {
    payload = await readLegacyTextFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    blockImport(baseDir, filePath, "goal_dependency_graph", "current", controlDb, report, error);
    return;
  }

  try {
    if (await store.loadDependencyGraph() !== null) {
      report.retiredExistingTypedState += 1;
      recordImport(controlDb, {
        sourceKind: "goal_dependency_graph",
        sourceId: "current",
        sourcePath: path.relative(baseDir, filePath),
        sourceChecksum: payload.checksum,
        sourceMtimeMs: payload.mtimeMs,
        status: "retired",
        details: { reason: "typed dependency graph state already exists" },
      });
      return;
    }
  } catch (error) {
    blockImport(baseDir, filePath, "goal_dependency_graph", "current", controlDb, report, error, payload);
    return;
  }

  try {
    const parsed = DependencyGraphSchema.parse(JSON.parse(payload.raw) as unknown);
    await store.saveDependencyGraph(parsed);
    report.dependencyGraphs += 1;
    recordImport(controlDb, {
      sourceKind: "goal_dependency_graph",
      sourceId: "current",
      sourcePath: path.relative(baseDir, filePath),
      sourceChecksum: payload.checksum,
      sourceMtimeMs: payload.mtimeMs,
      status: "imported",
      details: {
        nodes: parsed.nodes.length,
        edges: parsed.edges.length,
      },
    });
  } catch (error) {
    blockImport(baseDir, filePath, "goal_dependency_graph", "current", controlDb, report, error, payload);
  }
}

async function importNegotiationLogs(
  baseDir: string,
  store: GoalOrchestrationStateStore,
  controlDb: ControlDatabase,
  report: GoalOrchestrationLegacyImportReport,
): Promise<void> {
  const goalsDir = path.join(baseDir, "goals");
  for (const entry of await readDir(goalsDir)) {
    if (!entry.isDirectory()) continue;
    const goalId = entry.name;
    const filePath = path.join(goalsDir, goalId, "negotiation-log.json");
    if (hasCompletedImportRecord(controlDb, "goal_negotiation_log", goalId)) {
      report.skippedAlreadyImported += 1;
      continue;
    }
    let payload: { raw: string; checksum: string; mtimeMs: number };
    try {
      payload = await readLegacyTextFile(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      blockImport(baseDir, filePath, "goal_negotiation_log", goalId, controlDb, report, error);
      continue;
    }

    try {
      if (await store.loadNegotiationLog(goalId) !== null) {
        report.retiredExistingTypedState += 1;
        recordImport(controlDb, {
          sourceKind: "goal_negotiation_log",
          sourceId: goalId,
          sourcePath: path.relative(baseDir, filePath),
          sourceChecksum: payload.checksum,
          sourceMtimeMs: payload.mtimeMs,
          status: "retired",
          details: { reason: "typed negotiation log state already exists" },
        });
        continue;
      }
    } catch (error) {
      blockImport(baseDir, filePath, "goal_negotiation_log", goalId, controlDb, report, error, payload);
      continue;
    }

    try {
      const parsed = NegotiationLogSchema.parse(JSON.parse(payload.raw) as unknown);
      await store.saveNegotiationLog(goalId, parsed);
      report.negotiationLogs += 1;
      recordImport(controlDb, {
        sourceKind: "goal_negotiation_log",
        sourceId: goalId,
        sourcePath: path.relative(baseDir, filePath),
        sourceChecksum: payload.checksum,
        sourceMtimeMs: payload.mtimeMs,
        status: "imported",
        details: { goal_id: parsed.goal_id },
      });
    } catch (error) {
      blockImport(baseDir, filePath, "goal_negotiation_log", goalId, controlDb, report, error, payload);
    }
  }
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
  report: GoalOrchestrationLegacyImportReport,
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
