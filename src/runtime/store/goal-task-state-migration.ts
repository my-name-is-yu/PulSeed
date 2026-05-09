import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import {
  openControlDatabase,
  type ControlDatabase,
  type RuntimeControlDbStoreOptions,
} from "./control-db/index.js";
import { GoalTaskStateStore } from "./goal-task-state-store.js";
import { GoalSchema, GoalTreeSchema } from "../../base/types/goal.js";
import { ObservationLogSchema } from "../../base/types/state.js";
import { GapHistoryEntrySchema } from "../../base/types/gap.js";
import { TaskSchema } from "../../base/types/task.js";
import { CheckpointSchema, LoopCheckpointSchema } from "../../base/types/checkpoint.js";
import { PipelineStateSchema } from "../../base/types/pipeline.js";

const MIGRATION_NAME = "goal-task-durable-loop-state";
const MIGRATION_VERSION = 6;

export interface GoalTaskStateLegacyImportReport {
  goals: number;
  goalTrees: number;
  observationLogs: number;
  gapHistories: number;
  loopCheckpoints: number;
  tasks: number;
  taskHistoryRecords: number;
  taskOutcomeLedgers: number;
  taskFailureContexts: number;
  verificationResults: number;
  checkpoints: number;
  pipelines: number;
  stalls: number;
  blockedSources: Array<{ sourceKind: string; sourcePath: string; reason: string }>;
}

export async function importLegacyGoalTaskDurableLoopState(
  baseDir: string,
  options: RuntimeControlDbStoreOptions = {},
): Promise<GoalTaskStateLegacyImportReport> {
  const controlDb = options.controlDb ?? await openControlDatabase({
    baseDir: options.controlBaseDir ?? baseDir,
    dbPath: options.controlDbPath,
  });
  const store = new GoalTaskStateStore(baseDir, { ...options, controlDb });
  const report: GoalTaskStateLegacyImportReport = {
    goals: 0,
    goalTrees: 0,
    observationLogs: 0,
    gapHistories: 0,
    loopCheckpoints: 0,
    tasks: 0,
    taskHistoryRecords: 0,
    taskOutcomeLedgers: 0,
    taskFailureContexts: 0,
    verificationResults: 0,
    checkpoints: 0,
    pipelines: 0,
    stalls: 0,
    blockedSources: [],
  };

  try {
    await importGoals(baseDir, store, controlDb, report);
    await importArchivedGoals(baseDir, store, controlDb, report);
    await importGoalTrees(baseDir, store, controlDb, report);
    await importTasks(baseDir, store, controlDb, report);
    await importVerificationResults(baseDir, store, controlDb, report);
    await importCheckpoints(baseDir, store, controlDb, report);
    await importPipelines(baseDir, store, controlDb, report);
    await importStalls(baseDir, store, controlDb, report);
    return report;
  } finally {
    if (!options.controlDb) {
      controlDb.close();
    }
  }
}

async function importGoals(
  baseDir: string,
  store: GoalTaskStateStore,
  controlDb: ControlDatabase,
  report: GoalTaskStateLegacyImportReport,
): Promise<void> {
  const goalsDir = path.join(baseDir, "goals");
  for (const entry of await readDir(goalsDir)) {
    if (!entry.isDirectory()) continue;
    const goalId = entry.name;
    await importJson({
      baseDir,
      filePath: path.join(goalsDir, goalId, "goal.json"),
      sourceKind: "goal_state",
      sourceId: goalId,
      controlDb,
      report,
      onImport: async (raw) => {
        await store.saveGoal(GoalSchema.parse(raw));
        report.goals += 1;
      },
    });
    await importJson({
      baseDir,
      filePath: path.join(goalsDir, goalId, "observations.json"),
      sourceKind: "goal_observation_log",
      sourceId: goalId,
      controlDb,
      report,
      onImport: async (raw) => {
        await store.saveObservationLog(ObservationLogSchema.parse(raw));
        report.observationLogs += 1;
      },
    });
    await importJson({
      baseDir,
      filePath: path.join(goalsDir, goalId, "gap-history.json"),
      sourceKind: "goal_gap_history",
      sourceId: goalId,
      controlDb,
      report,
      onImport: async (raw) => {
        const history = Array.isArray(raw) ? raw.map((entry) => GapHistoryEntrySchema.parse(entry)) : [];
        await store.saveGapHistory(goalId, history);
        report.gapHistories += 1;
      },
    });
    await importJson({
      baseDir,
      filePath: path.join(goalsDir, goalId, "checkpoint.json"),
      sourceKind: "goal_loop_checkpoint",
      sourceId: goalId,
      controlDb,
      report,
      onImport: async (raw) => {
        await store.saveLoopCheckpoint(goalId, LoopCheckpointSchema.parse(raw));
        report.loopCheckpoints += 1;
      },
    });
  }
}

async function importArchivedGoals(
  baseDir: string,
  store: GoalTaskStateStore,
  controlDb: ControlDatabase,
  report: GoalTaskStateLegacyImportReport,
): Promise<void> {
  const archiveRoot = path.join(baseDir, "archive");
  for (const entry of await readDir(archiveRoot)) {
    if (!entry.isDirectory() || entry.name === ".staging") continue;
    const goalId = entry.name;
    const archiveBase = path.join(archiveRoot, goalId);
    const goalDir = path.join(archiveBase, "goal");
    await importJson({
      baseDir,
      filePath: path.join(goalDir, "goal.json"),
      sourceKind: "archived_goal_state",
      sourceId: goalId,
      controlDb,
      report,
      onImport: async (raw) => {
        const goal = GoalSchema.parse(raw);
        await store.saveArchivedGoal({ ...goal, status: "archived" });
        report.goals += 1;
      },
    });
    await importJson({
      baseDir,
      filePath: path.join(goalDir, "observations.json"),
      sourceKind: "archived_goal_observation_log",
      sourceId: goalId,
      controlDb,
      report,
      onImport: async (raw) => {
        await store.saveObservationLog(ObservationLogSchema.parse(raw));
        report.observationLogs += 1;
      },
    });
    await importJson({
      baseDir,
      filePath: path.join(goalDir, "gap-history.json"),
      sourceKind: "archived_goal_gap_history",
      sourceId: goalId,
      controlDb,
      report,
      onImport: async (raw) => {
        const history = Array.isArray(raw) ? raw.map((entry) => GapHistoryEntrySchema.parse(entry)) : [];
        await store.saveGapHistory(goalId, history);
        report.gapHistories += 1;
      },
    });
    await importJson({
      baseDir,
      filePath: path.join(goalDir, "checkpoint.json"),
      sourceKind: "archived_goal_loop_checkpoint",
      sourceId: goalId,
      controlDb,
      report,
      onImport: async (raw) => {
        await store.saveLoopCheckpoint(goalId, LoopCheckpointSchema.parse(raw));
        report.loopCheckpoints += 1;
      },
    });
    await importArchivedTasks(baseDir, archiveBase, goalId, store, controlDb, report);
  }
}

async function importGoalTrees(
  baseDir: string,
  store: GoalTaskStateStore,
  controlDb: ControlDatabase,
  report: GoalTaskStateLegacyImportReport,
): Promise<void> {
  const dir = path.join(baseDir, "goal-trees");
  for (const entry of await readDir(dir)) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const rootId = entry.name.slice(0, -".json".length);
    await importJson({
      baseDir,
      filePath: path.join(dir, entry.name),
      sourceKind: "goal_tree",
      sourceId: rootId,
      controlDb,
      report,
      onImport: async (raw) => {
        await store.saveGoalTree(GoalTreeSchema.parse(raw));
        report.goalTrees += 1;
      },
    });
  }
}

async function importTasks(
  baseDir: string,
  store: GoalTaskStateStore,
  controlDb: ControlDatabase,
  report: GoalTaskStateLegacyImportReport,
): Promise<void> {
  const tasksRoot = path.join(baseDir, "tasks");
  for (const goalDir of await readDir(tasksRoot)) {
    if (!goalDir.isDirectory()) continue;
    const goalId = goalDir.name;
    const dir = path.join(tasksRoot, goalId);
    for (const entry of await readDir(dir)) {
      if (entry.isFile() && entry.name.endsWith(".json")) {
        if (entry.name === "task-history.json") {
          await importJson({
            baseDir,
            filePath: path.join(dir, entry.name),
            sourceKind: "task_history",
            sourceId: goalId,
            controlDb,
            report,
            onImport: async (raw) => {
              const records = Array.isArray(raw) ? raw : [];
              await store.saveTaskHistory(goalId, records);
              report.taskHistoryRecords += records.length;
            },
          });
          continue;
        }
        if (entry.name === "last-failure-context.json") {
          await importJson({
            baseDir,
            filePath: path.join(dir, entry.name),
            sourceKind: "task_failure_context",
            sourceId: goalId,
            controlDb,
            report,
            onImport: async (raw) => {
              await store.saveTaskFailureContext(goalId, raw);
              report.taskFailureContexts += 1;
            },
          });
          continue;
        }
        const taskId = entry.name.slice(0, -".json".length);
        await importJson({
          baseDir,
          filePath: path.join(dir, entry.name),
          sourceKind: "task_state",
          sourceId: `${goalId}/${taskId}`,
          controlDb,
          report,
          onImport: async (raw) => {
            await store.saveTask(TaskSchema.parse(raw));
            report.tasks += 1;
          },
        });
      }
    }
    const ledgerDir = path.join(dir, "ledger");
    for (const entry of await readDir(ledgerDir)) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const taskId = entry.name.slice(0, -".json".length);
      await importJson({
        baseDir,
        filePath: path.join(ledgerDir, entry.name),
        sourceKind: "task_outcome_ledger",
        sourceId: `${goalId}/${taskId}`,
        controlDb,
        report,
        onImport: async (raw) => {
          const record = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
          await store.saveTaskOutcomeLedger({
            goal_id: typeof record["goal_id"] === "string" ? record["goal_id"] : goalId,
            task_id: typeof record["task_id"] === "string" ? record["task_id"] : taskId,
            events: Array.isArray(record["events"]) ? record["events"] : [],
            summary: record["summary"] && typeof record["summary"] === "object"
              ? record["summary"] as Record<string, unknown>
              : {},
          });
          report.taskOutcomeLedgers += 1;
        },
      });
    }
  }
}

async function importArchivedTasks(
  baseDir: string,
  archiveBase: string,
  goalId: string,
  store: GoalTaskStateStore,
  controlDb: ControlDatabase,
  report: GoalTaskStateLegacyImportReport,
): Promise<void> {
  const dir = path.join(archiveBase, "tasks");
  for (const entry of await readDir(dir)) {
    if (entry.isFile() && entry.name.endsWith(".json")) {
      if (entry.name === "task-history.json") {
        await importJson({
          baseDir,
          filePath: path.join(dir, entry.name),
          sourceKind: "archived_task_history",
          sourceId: goalId,
          controlDb,
          report,
          onImport: async (raw) => {
            const records = Array.isArray(raw) ? raw : [];
            await store.saveTaskHistory(goalId, records);
            report.taskHistoryRecords += records.length;
          },
        });
        continue;
      }
      if (entry.name === "last-failure-context.json") {
        await importJson({
          baseDir,
          filePath: path.join(dir, entry.name),
          sourceKind: "archived_task_failure_context",
          sourceId: goalId,
          controlDb,
          report,
          onImport: async (raw) => {
            await store.saveTaskFailureContext(goalId, raw);
            report.taskFailureContexts += 1;
          },
        });
        continue;
      }
      const taskId = entry.name.slice(0, -".json".length);
      await importJson({
        baseDir,
        filePath: path.join(dir, entry.name),
        sourceKind: "archived_task_state",
        sourceId: `${goalId}/${taskId}`,
        controlDb,
        report,
        onImport: async (raw) => {
          await store.saveTask(TaskSchema.parse(raw));
          report.tasks += 1;
        },
      });
    }
  }
  const ledgerDir = path.join(dir, "ledger");
  for (const entry of await readDir(ledgerDir)) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const taskId = entry.name.slice(0, -".json".length);
    await importJson({
      baseDir,
      filePath: path.join(ledgerDir, entry.name),
      sourceKind: "archived_task_outcome_ledger",
      sourceId: `${goalId}/${taskId}`,
      controlDb,
      report,
      onImport: async (raw) => {
        const record = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
        await store.saveTaskOutcomeLedger({
          goal_id: typeof record["goal_id"] === "string" ? record["goal_id"] : goalId,
          task_id: typeof record["task_id"] === "string" ? record["task_id"] : taskId,
          events: Array.isArray(record["events"]) ? record["events"] : [],
          summary: record["summary"] && typeof record["summary"] === "object"
            ? record["summary"] as Record<string, unknown>
            : {},
        });
        report.taskOutcomeLedgers += 1;
      },
    });
  }
}

async function importVerificationResults(
  baseDir: string,
  store: GoalTaskStateStore,
  controlDb: ControlDatabase,
  report: GoalTaskStateLegacyImportReport,
): Promise<void> {
  const dir = path.join(baseDir, "verification");
  for (const taskDir of await readDir(dir)) {
    if (!taskDir.isDirectory()) continue;
    const taskId = taskDir.name;
    await importJson({
      baseDir,
      filePath: path.join(dir, taskId, "verification-result.json"),
      sourceKind: "task_verification_result",
      sourceId: taskId,
      controlDb,
      report,
      onImport: async (raw) => {
        await store.saveTaskVerificationResult(taskId, raw);
        report.verificationResults += 1;
      },
    });
  }
}

async function importCheckpoints(
  baseDir: string,
  store: GoalTaskStateStore,
  controlDb: ControlDatabase,
  report: GoalTaskStateLegacyImportReport,
): Promise<void> {
  const root = path.join(baseDir, "checkpoints");
  for (const goalDir of await readDir(root)) {
    if (!goalDir.isDirectory()) continue;
    const goalId = goalDir.name;
    const dir = path.join(root, goalId);
    for (const entry of await readDir(dir)) {
      if (!entry.isFile() || !entry.name.endsWith(".json") || entry.name === "index.json") continue;
      const checkpointId = entry.name.slice(0, -".json".length);
      await importJson({
        baseDir,
        filePath: path.join(dir, entry.name),
        sourceKind: "task_checkpoint",
        sourceId: `${goalId}/${checkpointId}`,
        controlDb,
        report,
        onImport: async (raw) => {
          await store.saveCheckpoint(CheckpointSchema.parse(raw));
          report.checkpoints += 1;
        },
      });
    }
  }
}

async function importPipelines(
  baseDir: string,
  store: GoalTaskStateStore,
  controlDb: ControlDatabase,
  report: GoalTaskStateLegacyImportReport,
): Promise<void> {
  const dir = path.join(baseDir, "pipelines");
  for (const entry of await readDir(dir)) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const taskId = entry.name.slice(0, -".json".length);
    await importJson({
      baseDir,
      filePath: path.join(dir, entry.name),
      sourceKind: "pipeline_state",
      sourceId: taskId,
      controlDb,
      report,
      onImport: async (raw) => {
        await store.savePipeline(taskId, PipelineStateSchema.parse(raw));
        report.pipelines += 1;
      },
    });
  }
}

async function importStalls(
  baseDir: string,
  store: GoalTaskStateStore,
  controlDb: ControlDatabase,
  report: GoalTaskStateLegacyImportReport,
): Promise<void> {
  const dir = path.join(baseDir, "stalls");
  for (const entry of await readDir(dir)) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const goalId = entry.name.slice(0, -".json".length);
    await importJson({
      baseDir,
      filePath: path.join(dir, entry.name),
      sourceKind: "goal_stall_state",
      sourceId: goalId,
      controlDb,
      report,
      onImport: async (raw) => {
        await store.saveStallRecord(goalId, raw);
        report.stalls += 1;
      },
    });
  }
}

async function importJson(input: {
  baseDir: string;
  filePath: string;
  sourceKind: string;
  sourceId: string;
  controlDb: ControlDatabase;
  report: GoalTaskStateLegacyImportReport;
  onImport: (raw: unknown) => Promise<void>;
}): Promise<void> {
  let payload: { raw: unknown; checksum: string; mtimeMs: number };
  try {
    payload = await readLegacyJsonFile(input.filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    blockImport(input, error);
    return;
  }

  try {
    await input.onImport(payload.raw);
    recordImport(input.controlDb, {
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      sourcePath: path.relative(input.baseDir, input.filePath),
      sourceChecksum: payload.checksum,
      sourceMtimeMs: payload.mtimeMs,
      status: "imported",
    });
  } catch (error) {
    blockImport(input, error);
  }
}

async function readDir(dir: string): Promise<Array<import("node:fs").Dirent>> {
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function readLegacyJsonFile(filePath: string): Promise<{ raw: unknown; checksum: string; mtimeMs: number }> {
  const stat = await fsp.stat(filePath);
  const text = await fsp.readFile(filePath, "utf-8");
  return {
    raw: JSON.parse(text) as unknown,
    checksum: createHash("sha256").update(text).digest("hex"),
    mtimeMs: stat.mtimeMs,
  };
}

function recordImport(
  db: ControlDatabase,
  input: {
    sourceKind: string;
    sourceId: string;
    sourcePath: string;
    sourceChecksum?: string;
    sourceMtimeMs?: number;
    status: "imported" | "blocked";
    details?: Record<string, unknown>;
  },
): void {
  db.recordLegacyImport({
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    sourcePath: input.sourcePath,
    sourceChecksum: input.sourceChecksum,
    sourceMtimeMs: input.sourceMtimeMs,
    migrationName: MIGRATION_NAME,
    migrationVersion: MIGRATION_VERSION,
    status: input.status,
    details: input.details,
  });
}

function blockImport(
  input: {
    baseDir: string;
    filePath: string;
    sourceKind: string;
    sourceId: string;
    controlDb: ControlDatabase;
    report: GoalTaskStateLegacyImportReport;
  },
  error: unknown,
): void {
  const reason = error instanceof Error ? error.message : String(error);
  const sourcePath = path.relative(input.baseDir, input.filePath);
  input.report.blockedSources.push({ sourceKind: input.sourceKind, sourcePath, reason });
  recordImport(input.controlDb, {
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    sourcePath,
    status: "blocked",
    details: { reason },
  });
}
