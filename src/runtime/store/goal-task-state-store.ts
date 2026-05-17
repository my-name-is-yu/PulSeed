import { randomUUID } from "node:crypto";
import {
  openControlDatabase,
  type ControlDatabase,
  type RuntimeControlDbStoreOptions,
  type SqliteDatabase,
} from "./control-db/index.js";
import { GoalSchema, GoalTreeSchema, type Goal, type GoalTree } from "../../base/types/goal.js";
import { ObservationLogEntrySchema, ObservationLogSchema, type ObservationLog, type ObservationLogEntry } from "../../base/types/state.js";
import { GapHistoryEntrySchema, type GapHistoryEntry } from "../../base/types/gap.js";
import { TaskSchema, type Task } from "../../base/types/task.js";
import { CheckpointSchema, LoopCheckpointSchema, type Checkpoint, type LoopCheckpoint } from "../../base/types/checkpoint.js";
import { PipelineStateSchema, type PipelineState } from "../../base/types/pipeline.js";
import {
  RuntimeGraphEdgeSchema,
  RuntimeGraphNodeSchema,
  type RuntimeGraphEdge,
  type RuntimeGraphNode,
} from "../personal-agent/contracts.js";
import { RuntimeEventLogStore } from "./runtime-event-log.js";

export interface RawStateStoreResult {
  handled: boolean;
  value: unknown | null;
}

export interface GoalTaskStateStoreOptions extends RuntimeControlDbStoreOptions {}

export interface CheckpointIndexEntry {
  checkpoint_id: string;
  task_id: string;
  agent_id: string;
  created_at: string;
}

export interface TaskOutcomeLedgerRecordLike {
  task_id: string;
  goal_id: string;
  events: unknown[];
  summary: Record<string, unknown>;
}

interface RawPathMatch {
  kind:
    | "goal"
    | "goal_tree"
    | "observation_log"
    | "gap_history"
    | "loop_checkpoint"
    | "task"
    | "task_history"
    | "task_outcome_ledger"
    | "task_failure_context"
    | "task_verification_result"
    | "checkpoint_index"
    | "checkpoint"
    | "pipeline";
  goalId?: string;
  taskId?: string;
  rootId?: string;
  checkpointId?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function validDateTimeOrNow(value: string | null | undefined): string {
  if (typeof value === "string") {
    const parsed = new Date(value);
    if (Number.isFinite(parsed.getTime())) return parsed.toISOString();
  }
  return nowIso();
}

const GOAL_STATE_WRITE_LOCK_TIMEOUT_MS = 5_000;
const GOAL_STATE_WRITE_LOCK_LEASE_MS = 30_000;
const GOAL_STATE_WRITE_LOCK_RETRY_MS = 25;

function parseJson<T = unknown>(value: string): T {
  return JSON.parse(value) as T;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeRawGoal(goalId: string, data: unknown): Goal {
  const object = asObject(data);
  if (!object) {
    throw new Error("Goal raw state must be an object.");
  }
  const timestamp = typeof object["updated_at"] === "string"
    ? object["updated_at"]
    : typeof object["created_at"] === "string"
      ? object["created_at"]
      : nowIso();
  const dimensions = Array.isArray(object["dimensions"])
    ? object["dimensions"].map((dimension, index) => {
        const dimensionObject = asObject(dimension) ?? {};
        const name = typeof dimensionObject["name"] === "string" && dimensionObject["name"].length > 0
          ? dimensionObject["name"]
          : `dimension-${index + 1}`;
        const observationMethod = asObject(dimensionObject["observation_method"]);
        return {
          ...dimensionObject,
          name,
          label: typeof dimensionObject["label"] === "string" ? dimensionObject["label"] : name,
          current_value: Object.hasOwn(dimensionObject, "current_value") ? dimensionObject["current_value"] : null,
          threshold: asObject(dimensionObject["threshold"]) ?? { type: "present" },
          confidence: typeof dimensionObject["confidence"] === "number" ? dimensionObject["confidence"] : 0.5,
          observation_method: observationMethod ?? {
            type: "manual",
            source: "legacy-raw-goal-write",
            schedule: null,
            endpoint: null,
            confidence_tier: "self_report",
          },
          last_updated: typeof dimensionObject["last_updated"] === "string" ? dimensionObject["last_updated"] : null,
          history: Array.isArray(dimensionObject["history"]) ? dimensionObject["history"] : [],
        };
      })
    : [];

  return GoalSchema.parse({
    ...object,
    id: typeof object["id"] === "string" && object["id"].length > 0 ? object["id"] : goalId,
    title: typeof object["title"] === "string" && object["title"].length > 0 ? object["title"] : goalId,
    dimensions,
    created_at: typeof object["created_at"] === "string" ? object["created_at"] : timestamp,
    updated_at: timestamp,
  });
}

function stripJsonExtension(name: string): string | null {
  return name.endsWith(".json") ? name.slice(0, -".json".length) : null;
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
}

function parseRawPath(relativePath: string): RawPathMatch | null {
  const parts = normalizeRelativePath(relativePath).split("/").filter(Boolean);
  if (parts.length === 0) return null;

  if (parts[0] === "goals" && parts.length === 3) {
    const goalId = parts[1]!;
    if (parts[2] === "goal.json") return { kind: "goal", goalId };
    if (parts[2] === "observations.json") return { kind: "observation_log", goalId };
    if (parts[2] === "gap-history.json") return { kind: "gap_history", goalId };
    if (parts[2] === "checkpoint.json") return { kind: "loop_checkpoint", goalId };
  }

  if (parts[0] === "goal-trees" && parts.length === 2) {
    const rootId = stripJsonExtension(parts[1]!);
    return rootId ? { kind: "goal_tree", rootId } : null;
  }

  if (parts[0] === "tasks" && parts.length >= 3) {
    const goalId = parts[1]!;
    if (parts.length === 3 && parts[2] === "task-history.json") {
      return { kind: "task_history", goalId };
    }
    if (parts.length === 3 && parts[2] === "last-failure-context.json") {
      return { kind: "task_failure_context", goalId };
    }
    if (parts.length === 4 && parts[2] === "ledger") {
      const taskId = stripJsonExtension(parts[3]!);
      return taskId ? { kind: "task_outcome_ledger", goalId, taskId } : null;
    }
    if (parts.length === 3) {
      const taskId = stripJsonExtension(parts[2]!);
      return taskId ? { kind: "task", goalId, taskId } : null;
    }
  }

  if (parts[0] === "verification" && parts.length === 3 && parts[2] === "verification-result.json") {
    return { kind: "task_verification_result", taskId: parts[1]! };
  }

  if (parts[0] === "checkpoints" && parts.length === 3) {
    const goalId = parts[1]!;
    if (parts[2] === "index.json") return { kind: "checkpoint_index", goalId };
    const checkpointId = stripJsonExtension(parts[2]!);
    return checkpointId ? { kind: "checkpoint", goalId, checkpointId } : null;
  }

  if (parts[0] === "pipelines" && parts.length === 2) {
    const taskId = stripJsonExtension(parts[1]!);
    return taskId ? { kind: "pipeline", taskId } : null;
  }

  return null;
}

export class GoalTaskStateStore {
  private dbPromise: Promise<ControlDatabase> | null = null;

  constructor(
    private readonly baseDir: string,
    private readonly options: GoalTaskStateStoreOptions = {},
  ) {}

  async ensureReady(): Promise<void> {
    await this.database();
  }

  async withGoalStateWriteLock<T>(goalId: string, work: () => Promise<T>): Promise<T> {
    const release = await this.acquireGoalStateWriteLock(goalId);
    try {
      return await work();
    } finally {
      release();
    }
  }

  async saveGoal(goal: Goal): Promise<Goal> {
    const parsed = GoalSchema.parse(goal);
    await this.recordGoalTaskMutation({ entityKind: "goal", action: "save", goal: parsed });
    const db = await this.database();
    db.transaction((sqlite) => upsertGoal(sqlite, parsed, 0));
    return parsed;
  }

  async saveArchivedGoal(goal: Goal): Promise<Goal> {
    const parsed = GoalSchema.parse({ ...goal, status: "archived" });
    await this.recordGoalTaskMutation({ entityKind: "goal", action: "archive", goal: parsed });
    const db = await this.database();
    db.transaction((sqlite) => upsertGoal(sqlite, parsed, 1));
    return parsed;
  }

  async loadGoal(goalId: string, options: { includeArchived?: boolean } = {}): Promise<Goal | null> {
    const db = await this.database();
    return db.transaction((sqlite) => {
      const graphGoal = readGoalFromRuntimeGraph(sqlite, goalId, options);
      if (graphGoal) return graphGoal;
      const row = sqlite.prepare(`
        SELECT goal_json, archived
        FROM goal_records
        WHERE goal_id = ?
          AND (? = 1 OR archived = 0)
      `).get(goalId, options.includeArchived === false ? 0 : 1) as { goal_json: string; archived: 0 | 1 } | undefined;
      if (!row) return null;
      const goal = GoalSchema.parse(parseJson(row.goal_json));
      upsertGoal(sqlite, goal, row.archived);
      return readGoalFromRuntimeGraph(sqlite, goalId, options) ?? goal;
    });
  }

  async goalExists(goalId: string): Promise<boolean> {
    const db = await this.database();
    return db.transaction((sqlite) => {
      const graphGoal = readGoalFromRuntimeGraph(sqlite, goalId, { includeArchived: false });
      if (graphGoal) return true;
      const row = sqlite.prepare(`
        SELECT goal_json
        FROM goal_records
        WHERE goal_id = ? AND archived = 0
      `).get(goalId) as { goal_json: string } | undefined;
      if (!row) return false;
      upsertGoal(sqlite, GoalSchema.parse(parseJson(row.goal_json)), 0);
      return true;
    });
  }

  async listGoalIds(options: { archived?: boolean } = {}): Promise<string[]> {
    const archived = options.archived === true ? 1 : 0;
    const db = await this.database();
    return db.transaction((sqlite) => {
      const rows = sqlite.prepare(`
        SELECT goal_json
        FROM goal_records
        WHERE archived = ?
        ORDER BY updated_at ASC, goal_id ASC
      `).all(archived) as Array<{ goal_json: string }>;
      for (const row of rows) {
        upsertGoal(sqlite, GoalSchema.parse(parseJson(row.goal_json)), archived);
      }
      return listGoalIdsFromRuntimeGraph(sqlite, archived);
    });
  }

  async markGoalArchived(goalId: string): Promise<boolean> {
    const goal = await this.readGoalForArchive(goalId);
    if (!goal) return false;
    const timestamp = nowIso();
    const archivedGoal = GoalSchema.parse({ ...goal, status: "archived", updated_at: timestamp });
    await this.recordGoalTaskMutation({ entityKind: "goal", action: "archive", goal: archivedGoal });
    const db = await this.database();
    return db.transaction((sqlite) => {
      upsertGoal(sqlite, archivedGoal, 1);
      return true;
    });
  }

  async deleteGoal(goalId: string): Promise<boolean> {
    const snapshot = await this.readGoalDeletionSnapshot(goalId);
    if (!snapshot.goal && snapshot.taskIds.length === 0) return false;
    if (snapshot.goal) {
      await this.recordGoalTaskMutation({ entityKind: "goal", action: "delete", goal: snapshot.goal });
    }
    for (const taskId of snapshot.taskIds) {
      await this.recordGoalTaskMutation({
        entityKind: "task",
        action: "delete",
        goalId,
        taskId,
        task: snapshot.tasks.get(taskId) ?? null,
      });
    }
    const db = await this.database();
    return db.transaction((sqlite) => {
      const graphGoal = readRuntimeGraphNodeByKindRef(sqlite, "goal", goalId);
      const graphTaskIds = listTaskIdsFromRuntimeGraph(sqlite, goalId);
      const taskRows = sqlite.prepare("SELECT task_id FROM task_records WHERE goal_id = ?").all(goalId) as Array<{ task_id: string }>;
      const taskIds = new Set([...graphTaskIds, ...taskRows.map((row) => row.task_id)]);
      for (const taskId of taskIds) {
        sqlite.prepare("DELETE FROM personal_agent_runtime_graph_nodes WHERE node_id = ?").run(taskRuntimeGraphNodeId(taskId));
      }
      sqlite.prepare("DELETE FROM personal_agent_runtime_graph_nodes WHERE node_id = ?").run(milestoneRuntimeGraphNodeId(goalId));
      const graphResult = sqlite.prepare("DELETE FROM personal_agent_runtime_graph_nodes WHERE node_id = ?").run(goalRuntimeGraphNodeId(goalId));
      const result = sqlite.prepare("DELETE FROM goal_records WHERE goal_id = ?").run(goalId);
      sqlite.prepare("DELETE FROM goal_observation_logs WHERE goal_id = ?").run(goalId);
      sqlite.prepare("DELETE FROM goal_gap_histories WHERE goal_id = ?").run(goalId);
      sqlite.prepare("DELETE FROM goal_loop_checkpoints WHERE goal_id = ?").run(goalId);
      sqlite.prepare("DELETE FROM goal_stall_records WHERE goal_id = ?").run(goalId);
      sqlite.prepare("DELETE FROM task_records WHERE goal_id = ?").run(goalId);
      sqlite.prepare("DELETE FROM task_history_records WHERE goal_id = ?").run(goalId);
      sqlite.prepare("DELETE FROM task_outcome_events WHERE goal_id = ?").run(goalId);
      sqlite.prepare("DELETE FROM task_outcome_summaries WHERE goal_id = ?").run(goalId);
      sqlite.prepare("DELETE FROM task_failure_contexts WHERE goal_id = ?").run(goalId);
      sqlite.prepare("DELETE FROM task_checkpoints WHERE goal_id = ?").run(goalId);
      return result.changes > 0 || graphResult.changes > 0 || graphGoal !== null || taskIds.size > 0;
    });
  }

  async saveGoalTree(tree: GoalTree): Promise<GoalTree> {
    const parsed = GoalTreeSchema.parse(tree);
    const db = await this.database();
    db.transaction((sqlite) => {
      sqlite.prepare(`
        INSERT INTO goal_tree_records (root_id, updated_at, tree_json)
        VALUES (?, ?, json(?))
        ON CONFLICT(root_id) DO UPDATE SET
          updated_at = excluded.updated_at,
          tree_json = excluded.tree_json
      `).run(parsed.root_id, nowIso(), JSON.stringify(parsed));
    });
    return parsed;
  }

  async loadGoalTree(rootId: string): Promise<GoalTree | null> {
    const db = await this.database();
    return db.read((sqlite) => {
      const row = sqlite.prepare(`
        SELECT tree_json
        FROM goal_tree_records
        WHERE root_id = ?
      `).get(rootId) as { tree_json: string } | undefined;
      return row ? GoalTreeSchema.parse(parseJson(row.tree_json)) : null;
    });
  }

  async deleteGoalTree(rootId: string): Promise<boolean> {
    const db = await this.database();
    return db.transaction((sqlite) =>
      sqlite.prepare("DELETE FROM goal_tree_records WHERE root_id = ?").run(rootId).changes > 0
    );
  }

  async saveObservationLog(log: ObservationLog): Promise<ObservationLog> {
    const parsed = ObservationLogSchema.parse(log);
    const db = await this.database();
    db.transaction((sqlite) => upsertObservationLog(sqlite, parsed));
    return parsed;
  }

  async loadObservationLog(goalId: string): Promise<ObservationLog | null> {
    const db = await this.database();
    return db.read((sqlite) => {
      const row = sqlite.prepare(`
        SELECT log_json
        FROM goal_observation_logs
        WHERE goal_id = ?
      `).get(goalId) as { log_json: string } | undefined;
      return row ? ObservationLogSchema.parse(parseJson(row.log_json)) : null;
    });
  }

  async appendObservation(goalId: string, entry: ObservationLogEntry, maxEntries: number): Promise<ObservationLog> {
    const parsed = ObservationLogEntrySchema.parse(entry);
    const db = await this.database();
    return db.transaction((sqlite) => {
      const current = readObservationLog(sqlite, goalId) ?? { goal_id: goalId, entries: [] };
      const next = ObservationLogSchema.parse({
        ...current,
        entries: [...current.entries, parsed].slice(-maxEntries),
      });
      upsertObservationLog(sqlite, next);
      return next;
    });
  }

  async saveGapHistory(goalId: string, history: GapHistoryEntry[]): Promise<GapHistoryEntry[]> {
    const parsed = history.map((entry) => GapHistoryEntrySchema.parse(entry));
    const db = await this.database();
    db.transaction((sqlite) => upsertGapHistory(sqlite, goalId, parsed));
    return parsed;
  }

  async loadGapHistory(goalId: string): Promise<GapHistoryEntry[]> {
    const db = await this.database();
    return db.read((sqlite) => readGapHistory(sqlite, goalId));
  }

  async appendGapHistoryEntry(goalId: string, entry: GapHistoryEntry, maxEntries: number): Promise<GapHistoryEntry[]> {
    const parsed = GapHistoryEntrySchema.parse(entry);
    const db = await this.database();
    return db.transaction((sqlite) => {
      const next = [...readGapHistory(sqlite, goalId), parsed].slice(-maxEntries);
      upsertGapHistory(sqlite, goalId, next);
      return next;
    });
  }

  async saveTask(task: Task): Promise<Task> {
    const parsed = TaskSchema.parse(task);
    await this.recordGoalTaskMutation({
      entityKind: "task",
      action: "save",
      goalId: parsed.goal_id,
      taskId: parsed.id,
      task: parsed,
    });
    const db = await this.database();
    db.transaction((sqlite) => upsertTask(sqlite, parsed));
    return parsed;
  }

  async loadTask(goalId: string, taskId: string): Promise<Task | null> {
    const db = await this.database();
    return db.transaction((sqlite) => readTask(sqlite, goalId, taskId));
  }

  async listTasks(goalId: string): Promise<Task[]> {
    const db = await this.database();
    return db.transaction((sqlite) => {
      const rows = sqlite.prepare(`
        SELECT task_json
        FROM task_records
        WHERE goal_id = ?
        ORDER BY created_at DESC, task_id ASC
      `).all(goalId) as Array<{ task_json: string }>;
      for (const row of rows) {
        upsertTask(sqlite, TaskSchema.parse(parseJson(row.task_json)));
      }
      return listTasksFromRuntimeGraph(sqlite, { goalId });
    });
  }

  async listTasksByStatus(status: Task["status"]): Promise<Task[]> {
    const db = await this.database();
    return db.transaction((sqlite) => {
      const rows = sqlite.prepare(`
        SELECT task_json
        FROM task_records
        WHERE status = ?
        ORDER BY updated_at ASC, goal_id ASC, task_id ASC
      `).all(status) as Array<{ task_json: string }>;
      for (const row of rows) {
        upsertTask(sqlite, TaskSchema.parse(parseJson(row.task_json)));
      }
      return listTasksFromRuntimeGraph(sqlite, { status });
    });
  }

  async deleteTask(goalId: string, taskId: string): Promise<boolean> {
    const snapshot = await this.readTaskDeletionSnapshot(goalId, taskId);
    if (!snapshot.exists) return false;
    await this.recordGoalTaskMutation({
      entityKind: "task",
      action: "delete",
      goalId,
      taskId,
      task: snapshot.task,
    });
    const db = await this.database();
    return db.transaction((sqlite) => {
      const graphTask = readTaskFromRuntimeGraph(sqlite, goalId, taskId);
      const graphResult = sqlite.prepare("DELETE FROM personal_agent_runtime_graph_nodes WHERE node_id = ?").run(taskRuntimeGraphNodeId(taskId));
      const result = sqlite.prepare("DELETE FROM task_records WHERE goal_id = ? AND task_id = ?").run(goalId, taskId);
      sqlite.prepare("DELETE FROM task_outcome_events WHERE goal_id = ? AND task_id = ?").run(goalId, taskId);
      sqlite.prepare("DELETE FROM task_outcome_summaries WHERE goal_id = ? AND task_id = ?").run(goalId, taskId);
      sqlite.prepare("DELETE FROM task_checkpoints WHERE goal_id = ? AND task_id = ?").run(goalId, taskId);
      return result.changes > 0 || graphResult.changes > 0 || graphTask !== null;
    });
  }

  async saveTaskHistory(goalId: string, history: unknown[]): Promise<unknown[]> {
    const db = await this.database();
    db.transaction((sqlite) => {
      sqlite.prepare("DELETE FROM task_history_records WHERE goal_id = ?").run(goalId);
      const insert = sqlite.prepare(`
        INSERT INTO task_history_records (goal_id, task_id, sort_order, updated_at, record_json)
        VALUES (@goal_id, @task_id, @sort_order, @updated_at, json(@record_json))
      `);
      history.forEach((record, index) => {
        const object = asObject(record);
        insert.run({
          goal_id: goalId,
          task_id: typeof object?.["task_id"] === "string"
            ? object["task_id"]
            : typeof object?.["id"] === "string"
              ? object["id"]
              : null,
          sort_order: index,
          updated_at: nowIso(),
          record_json: JSON.stringify(record),
        });
      });
    });
    return history;
  }

  async loadTaskHistory(goalId: string): Promise<unknown[]> {
    const db = await this.database();
    return db.read((sqlite) => {
      const rows = sqlite.prepare(`
        SELECT record_json
        FROM task_history_records
        WHERE goal_id = ?
        ORDER BY sort_order ASC, history_id ASC
      `).all(goalId) as Array<{ record_json: string }>;
      return rows.map((row) => parseJson(row.record_json));
    });
  }

  async saveTaskOutcomeLedger(record: TaskOutcomeLedgerRecordLike): Promise<TaskOutcomeLedgerRecordLike> {
    const events = Array.isArray(record.events) ? record.events : [];
    const summary = asObject(record.summary) ?? {};
    const db = await this.database();
    db.transaction((sqlite) => {
      sqlite.prepare("DELETE FROM task_outcome_events WHERE goal_id = ? AND task_id = ?").run(record.goal_id, record.task_id);
      const insertEvent = sqlite.prepare(`
        INSERT INTO task_outcome_events (goal_id, task_id, event_index, event_type, occurred_at, event_json)
        VALUES (@goal_id, @task_id, @event_index, @event_type, @occurred_at, json(@event_json))
      `);
      events.forEach((event, index) => {
        const eventObject = asObject(event) ?? {};
        insertEvent.run({
          goal_id: record.goal_id,
          task_id: record.task_id,
          event_index: index,
          event_type: typeof eventObject["type"] === "string" ? eventObject["type"] : "unknown",
          occurred_at: typeof eventObject["ts"] === "string" ? eventObject["ts"] : nowIso(),
          event_json: JSON.stringify(event),
        });
      });
      sqlite.prepare(`
        INSERT INTO task_outcome_summaries (
          goal_id, task_id, latest_event_type, latest_event_at,
          task_status, tokens_used, updated_at, summary_json
        )
        VALUES (
          @goal_id, @task_id, @latest_event_type, @latest_event_at,
          @task_status, @tokens_used, @updated_at, json(@summary_json)
        )
        ON CONFLICT(goal_id, task_id) DO UPDATE SET
          latest_event_type = excluded.latest_event_type,
          latest_event_at = excluded.latest_event_at,
          task_status = excluded.task_status,
          tokens_used = excluded.tokens_used,
          updated_at = excluded.updated_at,
          summary_json = excluded.summary_json
      `).run({
        goal_id: record.goal_id,
        task_id: record.task_id,
        latest_event_type: typeof summary["latest_event_type"] === "string" ? summary["latest_event_type"] : null,
        latest_event_at: typeof summary["latest_event_at"] === "string" ? summary["latest_event_at"] : null,
        task_status: typeof summary["task_status"] === "string" ? summary["task_status"] : "unknown",
        tokens_used: typeof summary["tokens_used"] === "number" ? Math.max(0, Math.trunc(summary["tokens_used"])) : 0,
        updated_at: nowIso(),
        summary_json: JSON.stringify(summary),
      });
    });
    return { ...record, events, summary };
  }

  async loadTaskOutcomeLedger(goalId: string, taskId: string): Promise<TaskOutcomeLedgerRecordLike | null> {
    const db = await this.database();
    return db.read((sqlite) => readTaskOutcomeLedger(sqlite, goalId, taskId));
  }

  async deleteTaskOutcomeLedger(goalId: string, taskId: string): Promise<boolean> {
    const db = await this.database();
    return db.transaction((sqlite) => {
      sqlite.prepare("DELETE FROM task_outcome_events WHERE goal_id = ? AND task_id = ?").run(goalId, taskId);
      return sqlite.prepare("DELETE FROM task_outcome_summaries WHERE goal_id = ? AND task_id = ?").run(goalId, taskId).changes > 0;
    });
  }

  async listTaskOutcomeLedgers(): Promise<TaskOutcomeLedgerRecordLike[]> {
    const db = await this.database();
    return db.read((sqlite) => {
      const rows = sqlite.prepare(`
        SELECT goal_id, task_id
        FROM task_outcome_summaries
        ORDER BY goal_id ASC, task_id ASC
      `).all() as Array<{ goal_id: string; task_id: string }>;
      return rows
        .map((row) => readTaskOutcomeLedger(sqlite, row.goal_id, row.task_id))
        .filter((record): record is TaskOutcomeLedgerRecordLike => record !== null);
    });
  }

  async saveTaskFailureContext(goalId: string, context: unknown): Promise<void> {
    const db = await this.database();
    db.transaction((sqlite) => {
      if (context === null) {
        sqlite.prepare("DELETE FROM task_failure_contexts WHERE goal_id = ?").run(goalId);
        return;
      }
      sqlite.prepare(`
        INSERT INTO task_failure_contexts (goal_id, updated_at, context_json)
        VALUES (?, ?, json(?))
        ON CONFLICT(goal_id) DO UPDATE SET
          updated_at = excluded.updated_at,
          context_json = excluded.context_json
      `).run(goalId, nowIso(), JSON.stringify(context));
    });
  }

  async loadTaskFailureContext(goalId: string): Promise<unknown | null> {
    const db = await this.database();
    return db.read((sqlite) => {
      const row = sqlite.prepare(`
        SELECT context_json
        FROM task_failure_contexts
        WHERE goal_id = ?
      `).get(goalId) as { context_json: string } | undefined;
      return row ? parseJson(row.context_json) : null;
    });
  }

  async saveTaskVerificationResult(taskId: string, result: unknown): Promise<void> {
    if (result === null) {
      const db = await this.database();
      db.transaction((sqlite) => sqlite.prepare("DELETE FROM task_verification_results WHERE task_id = ?").run(taskId));
      return;
    }
    const object = asObject(result);
    const db = await this.database();
    db.transaction((sqlite) => {
      sqlite.prepare(`
        INSERT INTO task_verification_results (
          task_id, goal_id, verdict, result_timestamp, updated_at, result_json
        )
        VALUES (
          @task_id, @goal_id, @verdict, @result_timestamp, @updated_at, json(@result_json)
        )
        ON CONFLICT(task_id) DO UPDATE SET
          goal_id = excluded.goal_id,
          verdict = excluded.verdict,
          result_timestamp = excluded.result_timestamp,
          updated_at = excluded.updated_at,
          result_json = excluded.result_json
      `).run({
        task_id: typeof object?.["task_id"] === "string" ? object["task_id"] : taskId,
        goal_id: typeof object?.["goal_id"] === "string" ? object["goal_id"] : null,
        verdict: typeof object?.["verdict"] === "string" ? object["verdict"] : null,
        result_timestamp: typeof object?.["timestamp"] === "string" ? object["timestamp"] : null,
        updated_at: nowIso(),
        result_json: JSON.stringify(result),
      });
    });
  }

  async loadTaskVerificationResult(taskId: string): Promise<unknown | null> {
    const db = await this.database();
    return db.read((sqlite) => {
      const row = sqlite.prepare(`
        SELECT result_json
        FROM task_verification_results
        WHERE task_id = ?
      `).get(taskId) as { result_json: string } | undefined;
      return row ? parseJson(row.result_json) : null;
    });
  }

  async saveCheckpoint(checkpoint: Checkpoint): Promise<Checkpoint> {
    const parsed = CheckpointSchema.parse(checkpoint);
    const db = await this.database();
    db.transaction((sqlite) => {
      sqlite.prepare(`
        INSERT INTO task_checkpoints (
          checkpoint_id, goal_id, task_id, agent_id, created_at, checkpoint_json
        )
        VALUES (?, ?, ?, ?, ?, json(?))
        ON CONFLICT(checkpoint_id) DO UPDATE SET
          goal_id = excluded.goal_id,
          task_id = excluded.task_id,
          agent_id = excluded.agent_id,
          created_at = excluded.created_at,
          checkpoint_json = excluded.checkpoint_json
      `).run(
        parsed.checkpoint_id,
        parsed.goal_id,
        parsed.task_id,
        parsed.agent_id,
        parsed.created_at,
        JSON.stringify(parsed),
      );
    });
    return parsed;
  }

  async loadCheckpoint(checkpointId: string): Promise<Checkpoint | null> {
    const db = await this.database();
    return db.read((sqlite) => {
      const row = sqlite.prepare(`
        SELECT checkpoint_json
        FROM task_checkpoints
        WHERE checkpoint_id = ?
      `).get(checkpointId) as { checkpoint_json: string } | undefined;
      return row ? CheckpointSchema.parse(parseJson(row.checkpoint_json)) : null;
    });
  }

  async listCheckpointEntries(goalId: string): Promise<CheckpointIndexEntry[]> {
    const db = await this.database();
    return db.read((sqlite) => {
      const rows = sqlite.prepare(`
        SELECT checkpoint_id, task_id, agent_id, created_at
        FROM task_checkpoints
        WHERE goal_id = ?
        ORDER BY created_at ASC, checkpoint_id ASC
      `).all(goalId) as CheckpointIndexEntry[];
      return rows;
    });
  }

  async loadLatestCheckpoint(goalId: string, taskId?: string): Promise<Checkpoint | null> {
    const db = await this.database();
    return db.read((sqlite) => {
      const row = taskId
        ? sqlite.prepare(`
            SELECT checkpoint_json
            FROM task_checkpoints
            WHERE goal_id = ? AND task_id = ?
            ORDER BY created_at DESC, checkpoint_id DESC
            LIMIT 1
          `).get(goalId, taskId)
        : sqlite.prepare(`
            SELECT checkpoint_json
            FROM task_checkpoints
            WHERE goal_id = ?
            ORDER BY created_at DESC, checkpoint_id DESC
            LIMIT 1
          `).get(goalId);
      const typed = row as { checkpoint_json: string } | undefined;
      return typed ? CheckpointSchema.parse(parseJson(typed.checkpoint_json)) : null;
    });
  }

  async deleteCheckpoint(goalId: string, checkpointId: string): Promise<boolean> {
    const db = await this.database();
    return db.transaction((sqlite) =>
      sqlite.prepare("DELETE FROM task_checkpoints WHERE goal_id = ? AND checkpoint_id = ?").run(goalId, checkpointId).changes > 0
    );
  }

  async garbageCollectCheckpoints(goalId: string, cutoffMs: number): Promise<number> {
    const db = await this.database();
    return db.transaction((sqlite) => {
      const rows = sqlite.prepare(`
        SELECT checkpoint_id, created_at
        FROM task_checkpoints
        WHERE goal_id = ?
      `).all(goalId) as Array<{ checkpoint_id: string; created_at: string }>;
      const toDelete = rows.filter((row) => {
        const createdMs = Date.parse(row.created_at);
        return Number.isFinite(createdMs) && createdMs < cutoffMs;
      });
      const deleteStmt = sqlite.prepare("DELETE FROM task_checkpoints WHERE goal_id = ? AND checkpoint_id = ?");
      for (const row of toDelete) {
        deleteStmt.run(goalId, row.checkpoint_id);
      }
      return toDelete.length;
    });
  }

  async saveLoopCheckpoint(goalId: string, checkpoint: LoopCheckpoint, adapterType?: string | null): Promise<LoopCheckpoint> {
    const parsed = LoopCheckpointSchema.parse(checkpoint);
    await this.saveLoopCheckpointRaw(goalId, parsed, adapterType);
    return parsed;
  }

  async saveLoopCheckpointRaw(goalId: string, checkpoint: unknown, adapterType?: string | null): Promise<void> {
    const object = asObject(checkpoint);
    const cycleNumber = typeof object?.["cycle_number"] === "number" && object["cycle_number"] >= 0
      ? Math.trunc(object["cycle_number"])
      : 0;
    const timestamp = typeof object?.["timestamp"] === "string" ? object["timestamp"] : nowIso();
    const db = await this.database();
    db.transaction((sqlite) => {
      sqlite.prepare(`
        INSERT INTO goal_loop_checkpoints (
          goal_id, adapter_type, cycle_number, updated_at, checkpoint_json
        )
        VALUES (?, ?, ?, ?, json(?))
        ON CONFLICT(goal_id) DO UPDATE SET
          adapter_type = excluded.adapter_type,
          cycle_number = excluded.cycle_number,
          updated_at = excluded.updated_at,
          checkpoint_json = excluded.checkpoint_json
      `).run(goalId, adapterType ?? null, cycleNumber, timestamp, JSON.stringify(checkpoint));
    });
  }

  async loadLoopCheckpoint(goalId: string): Promise<LoopCheckpoint | null> {
    const db = await this.database();
    return db.read((sqlite) => {
      const row = sqlite.prepare(`
        SELECT checkpoint_json
        FROM goal_loop_checkpoints
        WHERE goal_id = ?
      `).get(goalId) as { checkpoint_json: string } | undefined;
      return row ? LoopCheckpointSchema.parse(parseJson(row.checkpoint_json)) : null;
    });
  }

  async savePipeline(taskId: string, state: PipelineState): Promise<PipelineState> {
    const parsed = PipelineStateSchema.parse(state);
    const db = await this.database();
    db.transaction((sqlite) => {
      sqlite.prepare(`
        INSERT INTO pipeline_state_records (
          task_id, pipeline_id, status, current_stage_index, started_at, updated_at, pipeline_json
        )
        VALUES (?, ?, ?, ?, ?, ?, json(?))
        ON CONFLICT(task_id) DO UPDATE SET
          pipeline_id = excluded.pipeline_id,
          status = excluded.status,
          current_stage_index = excluded.current_stage_index,
          started_at = excluded.started_at,
          updated_at = excluded.updated_at,
          pipeline_json = excluded.pipeline_json
      `).run(
        taskId,
        parsed.pipeline_id,
        parsed.status,
        parsed.current_stage_index,
        parsed.started_at,
        parsed.updated_at,
        JSON.stringify(parsed),
      );
    });
    return parsed;
  }

  async loadPipeline(taskId: string): Promise<PipelineState | null> {
    const db = await this.database();
    return db.read((sqlite) => {
      const row = sqlite.prepare(`
        SELECT pipeline_json
        FROM pipeline_state_records
        WHERE task_id = ?
      `).get(taskId) as { pipeline_json: string } | undefined;
      return row ? PipelineStateSchema.parse(parseJson(row.pipeline_json)) : null;
    });
  }

  async listPipelinesByStatus(status: PipelineState["status"]): Promise<PipelineState[]> {
    const db = await this.database();
    return db.read((sqlite) => {
      const rows = sqlite.prepare(`
        SELECT pipeline_json
        FROM pipeline_state_records
        WHERE status = ?
        ORDER BY updated_at ASC, task_id ASC
      `).all(status) as Array<{ pipeline_json: string }>;
      return rows.map((row) => PipelineStateSchema.parse(parseJson(row.pipeline_json)));
    });
  }

  async readRawPath(relativePath: string): Promise<RawStateStoreResult> {
    const match = parseRawPath(relativePath);
    if (!match) return { handled: false, value: null };
    switch (match.kind) {
      case "goal":
        return { handled: true, value: await this.loadGoal(match.goalId!, { includeArchived: true }) };
      case "goal_tree":
        return { handled: true, value: await this.loadGoalTree(match.rootId!) };
      case "observation_log":
        return { handled: true, value: await this.loadObservationLog(match.goalId!) };
      case "gap_history":
        return { handled: true, value: await this.loadGapHistory(match.goalId!) };
      case "loop_checkpoint":
        return { handled: true, value: await this.loadLoopCheckpoint(match.goalId!) };
      case "task":
        return { handled: true, value: await this.loadTask(match.goalId!, match.taskId!) };
      case "task_history":
        return { handled: true, value: await this.loadTaskHistory(match.goalId!) };
      case "task_outcome_ledger":
        return { handled: true, value: await this.loadTaskOutcomeLedger(match.goalId!, match.taskId!) };
      case "task_failure_context":
        return { handled: true, value: await this.loadTaskFailureContext(match.goalId!) };
      case "task_verification_result":
        return { handled: true, value: await this.loadTaskVerificationResult(match.taskId!) };
      case "checkpoint_index":
        return {
          handled: true,
          value: { goal_id: match.goalId!, checkpoints: await this.listCheckpointEntries(match.goalId!) },
        };
      case "checkpoint":
        return { handled: true, value: await this.loadCheckpoint(match.checkpointId!) };
      case "pipeline":
        return { handled: true, value: await this.loadPipeline(match.taskId!) };
    }
  }

  async writeRawPath(relativePath: string, data: unknown): Promise<boolean> {
    const match = parseRawPath(relativePath);
    if (!match) return false;
    switch (match.kind) {
      case "goal":
        if (data === null) {
          await this.deleteGoal(match.goalId!);
        } else {
          await this.saveGoal(normalizeRawGoal(match.goalId!, data));
        }
        return true;
      case "goal_tree":
        if (data === null) {
          await this.deleteGoalTree(match.rootId!);
        } else {
          await this.saveGoalTree(GoalTreeSchema.parse(data));
        }
        return true;
      case "observation_log":
        if (data === null) {
          await this.saveObservationLog({ goal_id: match.goalId!, entries: [] });
        } else {
          await this.saveObservationLog(ObservationLogSchema.parse(data));
        }
        return true;
      case "gap_history":
        await this.saveGapHistory(match.goalId!, Array.isArray(data) ? data : []);
        return true;
      case "loop_checkpoint":
        if (data !== null) {
          await this.saveLoopCheckpointRaw(match.goalId!, data);
        }
        return true;
      case "task":
        if (data === null) {
          await this.deleteTask(match.goalId!, match.taskId!);
        } else {
          await this.saveTask(TaskSchema.parse(data));
        }
        return true;
      case "task_history":
        await this.saveTaskHistory(match.goalId!, Array.isArray(data) ? data : []);
        return true;
      case "task_outcome_ledger": {
        if (data === null) {
          await this.deleteTaskOutcomeLedger(match.goalId!, match.taskId!);
        } else {
          const record = asObject(data);
          if (!record) throw new Error("Task outcome ledger must be an object.");
          await this.saveTaskOutcomeLedger({
            task_id: typeof record["task_id"] === "string" ? record["task_id"] : match.taskId!,
            goal_id: typeof record["goal_id"] === "string" ? record["goal_id"] : match.goalId!,
            events: Array.isArray(record["events"]) ? record["events"] : [],
            summary: asObject(record["summary"]) ?? {},
          });
        }
        return true;
      }
      case "task_failure_context":
        await this.saveTaskFailureContext(match.goalId!, data);
        return true;
      case "task_verification_result":
        await this.saveTaskVerificationResult(match.taskId!, data);
        return true;
      case "checkpoint_index":
        return true;
      case "checkpoint":
        if (data === null) {
          await this.deleteCheckpoint(match.goalId!, match.checkpointId!);
        } else {
          await this.saveCheckpoint(CheckpointSchema.parse(data));
        }
        return true;
      case "pipeline":
        if (data !== null) {
          await this.savePipeline(match.taskId!, PipelineStateSchema.parse(data));
        }
        return true;
    }
  }

  private async database(): Promise<ControlDatabase> {
    if (this.options.controlDb) {
      return this.options.controlDb;
    }
    this.dbPromise ??= openControlDatabase({
      baseDir: this.options.controlBaseDir ?? this.baseDir,
      dbPath: this.options.controlDbPath,
    });
    return this.dbPromise;
  }

  private async recordGoalTaskMutation(input: Parameters<RuntimeEventLogStore["appendGoalTaskMutation"]>[0]): Promise<void> {
    const eventLog = new RuntimeEventLogStore(this.options.controlBaseDir ?? this.baseDir, this.options);
    await eventLog.appendGoalTaskMutation(input);
  }

  private async readGoalForArchive(goalId: string): Promise<Goal | null> {
    const db = await this.database();
    return db.read((sqlite) => {
      const graphGoal = readGoalFromRuntimeGraph(sqlite, goalId, { includeArchived: false });
      if (graphGoal) return graphGoal;
      const row = sqlite.prepare(`
        SELECT goal_json
        FROM goal_records
        WHERE goal_id = ? AND archived = 0
      `).get(goalId) as { goal_json: string } | undefined;
      return row ? GoalSchema.parse(parseJson(row.goal_json)) : null;
    });
  }

  private async readGoalDeletionSnapshot(goalId: string): Promise<{
    goal: Goal | null;
    taskIds: string[];
    tasks: Map<string, Task>;
  }> {
    const db = await this.database();
    return db.read((sqlite) => {
      const graphGoal = readGoalFromRuntimeGraph(sqlite, goalId, { includeArchived: true });
      const row = sqlite.prepare(`
        SELECT goal_json
        FROM goal_records
        WHERE goal_id = ?
      `).get(goalId) as { goal_json: string } | undefined;
      const goal = graphGoal ?? (row ? GoalSchema.parse(parseJson(row.goal_json)) : null);
      const graphTaskIds = listTaskIdsFromRuntimeGraph(sqlite, goalId);
      const taskRows = sqlite.prepare("SELECT task_id FROM task_records WHERE goal_id = ?").all(goalId) as Array<{ task_id: string }>;
      const taskIds = [...new Set([...graphTaskIds, ...taskRows.map((taskRow) => taskRow.task_id)])].sort();
      const tasks = new Map<string, Task>();
      for (const taskId of taskIds) {
        const task = readTask(sqlite, goalId, taskId);
        if (task) tasks.set(taskId, task);
      }
      return { goal, taskIds, tasks };
    });
  }

  private async readTaskDeletionSnapshot(goalId: string, taskId: string): Promise<{
    exists: boolean;
    task: Task | null;
  }> {
    const db = await this.database();
    return db.read((sqlite) => {
      const graphTask = readTaskFromRuntimeGraph(sqlite, goalId, taskId);
      const row = sqlite.prepare(`
        SELECT task_json
        FROM task_records
        WHERE goal_id = ? AND task_id = ?
      `).get(goalId, taskId) as { task_json: string } | undefined;
      const task = graphTask ?? (row ? TaskSchema.parse(parseJson(row.task_json)) : null);
      return {
        exists: graphTask !== null || row !== undefined,
        task,
      };
    });
  }

  private async acquireGoalStateWriteLock(goalId: string): Promise<() => void> {
    const db = await this.database();
    const ownerToken = randomUUID();
    const startedAt = Date.now();

    while (true) {
      const acquired = db.transaction((sqlite) => {
        const now = Date.now();
        sqlite.prepare(`
          DELETE FROM goal_state_write_locks
          WHERE goal_id = ? AND lease_until <= ?
        `).run(goalId, now);
        const result = sqlite.prepare(`
          INSERT OR IGNORE INTO goal_state_write_locks (
            goal_id,
            owner_token,
            owner_pid,
            acquired_at,
            lease_until
          )
          VALUES (?, ?, ?, ?, ?)
        `).run(goalId, ownerToken, process.pid, now, now + GOAL_STATE_WRITE_LOCK_LEASE_MS);
        return result.changes === 1;
      });
      if (acquired) {
        return () => {
          db.transaction((sqlite) => {
            sqlite.prepare(`
              DELETE FROM goal_state_write_locks
              WHERE goal_id = ? AND owner_token = ?
            `).run(goalId, ownerToken);
          });
        };
      }
      if (Date.now() - startedAt >= GOAL_STATE_WRITE_LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for goal state write lock in control DB for "${goalId}"`);
      }
      await new Promise((resolve) => setTimeout(resolve, GOAL_STATE_WRITE_LOCK_RETRY_MS));
    }
  }
}

function upsertGoal(sqlite: SqliteDatabase, goal: Goal, archived: 0 | 1): void {
  upsertRuntimeGraphNode(sqlite, buildGoalRuntimeGraphNode(goal, archived));
  if (goal.node_type === "milestone") {
    upsertRuntimeGraphNode(sqlite, buildMilestoneRuntimeGraphNode(goal, archived));
    insertRuntimeGraphEdgeIfNodesExist(sqlite, {
      schema_version: "runtime-graph-edge/v1",
      edge_id: `runtime-graph:edge:goal-milestone:${goal.id}`,
      edge_kind: "produced",
      from_node_id: goalRuntimeGraphNodeId(goal.id),
      to_node_id: milestoneRuntimeGraphNodeId(goal.id),
      created_at: validDateTimeOrNow(goal.updated_at),
      provenance_refs: [{ kind: "goal", ref: goal.id }],
    });
  }
  deleteGoalParentRuntimeGraphEdges(sqlite, goal.id);
  if (goal.parent_id) {
    insertRuntimeGraphEdgeIfNodesExist(sqlite, {
      schema_version: "runtime-graph-edge/v1",
      edge_id: `runtime-graph:edge:goal-parent:${goal.parent_id}:${goal.id}`,
      edge_kind: "parent_of",
      from_node_id: goalRuntimeGraphNodeId(goal.parent_id),
      to_node_id: goalRuntimeGraphNodeId(goal.id),
      created_at: validDateTimeOrNow(goal.updated_at),
      provenance_refs: [{ kind: "goal", ref: goal.id }],
    });
  }
  sqlite.prepare(`
    INSERT INTO goal_records (goal_id, parent_goal_id, status, updated_at, archived, goal_json)
    VALUES (?, ?, ?, ?, ?, json(?))
    ON CONFLICT(goal_id) DO UPDATE SET
      parent_goal_id = excluded.parent_goal_id,
      status = excluded.status,
      updated_at = excluded.updated_at,
      archived = excluded.archived,
      goal_json = excluded.goal_json
  `).run(goal.id, goal.parent_id ?? null, goal.status, goal.updated_at, archived, JSON.stringify(goal));
}

function deleteGoalParentRuntimeGraphEdges(sqlite: SqliteDatabase, goalId: string): void {
  sqlite.prepare(`
    DELETE FROM personal_agent_runtime_graph_edges
    WHERE edge_kind = 'parent_of'
      AND to_node_id = ?
  `).run(goalRuntimeGraphNodeId(goalId));
}

function goalRuntimeGraphNodeId(goalId: string): string {
  return `runtime-graph:goal:${goalId}`;
}

function milestoneRuntimeGraphNodeId(goalId: string): string {
  return `runtime-graph:milestone:${goalId}`;
}

function taskRuntimeGraphNodeId(taskId: string): string {
  return `runtime-graph:task:${taskId}`;
}

function buildGoalRuntimeGraphNode(goal: Goal, archived: 0 | 1): RuntimeGraphNode {
  return RuntimeGraphNodeSchema.parse({
    schema_version: "runtime-graph-node/v1",
    node_id: goalRuntimeGraphNodeId(goal.id),
    node_kind: "goal",
    ref: { kind: "goal", ref: goal.id },
    label: goal.title || goal.id,
    created_at: validDateTimeOrNow(goal.created_at),
    updated_at: validDateTimeOrNow(goal.updated_at),
    provenance_refs: [{ kind: "goal_state_store", ref: "goal_records" }],
    payload: {
      runtime_graph_role: "source_of_truth",
      entity_kind: "goal",
      storage_projection: "goal_records",
      archived: archived === 1,
      goal,
      parent_ref: goal.parent_id ? { kind: "goal", ref: goal.parent_id } : null,
      child_refs: goal.children_ids.map((childId) => ({ kind: "goal", ref: childId })),
    },
  });
}

function buildMilestoneRuntimeGraphNode(goal: Goal, archived: 0 | 1): RuntimeGraphNode {
  return RuntimeGraphNodeSchema.parse({
    schema_version: "runtime-graph-node/v1",
    node_id: milestoneRuntimeGraphNodeId(goal.id),
    node_kind: "milestone",
    ref: { kind: "milestone", ref: goal.id },
    label: goal.title || goal.id,
    created_at: validDateTimeOrNow(goal.created_at),
    updated_at: validDateTimeOrNow(goal.updated_at),
    provenance_refs: [{ kind: "goal_state_store", ref: "goal_records" }],
    payload: {
      runtime_graph_role: "source_of_truth",
      entity_kind: "milestone",
      storage_projection: "goal_records",
      goal_ref: { kind: "goal", ref: goal.id },
      archived: archived === 1,
      milestone: goal,
      parent_ref: goal.parent_id ? { kind: "goal", ref: goal.parent_id } : null,
    },
  });
}

function buildTaskRuntimeGraphNode(task: Task, updatedAt: string): RuntimeGraphNode {
  return RuntimeGraphNodeSchema.parse({
    schema_version: "runtime-graph-node/v1",
    node_id: taskRuntimeGraphNodeId(task.id),
    node_kind: "task",
    ref: { kind: "task", ref: task.id },
    label: task.work_description || task.id,
    created_at: validDateTimeOrNow(task.created_at),
    updated_at: validDateTimeOrNow(updatedAt),
    provenance_refs: [{ kind: "goal_state_store", ref: "task_records" }],
    payload: {
      runtime_graph_role: "source_of_truth",
      entity_kind: "task",
      storage_projection: "task_records",
      task,
      parent_ref: { kind: "goal", ref: task.goal_id },
      strategy_ref: task.strategy_id ? { kind: "strategy", ref: task.strategy_id } : null,
    },
  });
}

function upsertRuntimeGraphNode(sqlite: SqliteDatabase, node: RuntimeGraphNode): void {
  const parsed = RuntimeGraphNodeSchema.parse(node);
  sqlite.prepare(`
    INSERT INTO personal_agent_runtime_graph_nodes (
      node_id, node_kind, ref, created_at, updated_at, node_json
    )
    VALUES (?, ?, ?, ?, ?, json(?))
    ON CONFLICT(node_id) DO UPDATE SET
      node_kind = excluded.node_kind,
      ref = excluded.ref,
      updated_at = excluded.updated_at,
      node_json = excluded.node_json
  `).run(
    parsed.node_id,
    parsed.node_kind,
    parsed.ref.ref,
    parsed.created_at,
    parsed.updated_at,
    JSON.stringify(parsed),
  );
}

function insertRuntimeGraphEdgeIfNodesExist(sqlite: SqliteDatabase, edge: RuntimeGraphEdge): void {
  const parsed = RuntimeGraphEdgeSchema.parse(edge);
  const nodesExist = sqlite.prepare(`
    SELECT 1 AS ok
    WHERE EXISTS (SELECT 1 FROM personal_agent_runtime_graph_nodes WHERE node_id = ?)
      AND EXISTS (SELECT 1 FROM personal_agent_runtime_graph_nodes WHERE node_id = ?)
  `).get(parsed.from_node_id, parsed.to_node_id) as { ok: number } | undefined;
  if (!nodesExist) return;
  sqlite.prepare(`
    INSERT INTO personal_agent_runtime_graph_edges (
      edge_id, edge_kind, from_node_id, to_node_id, created_at, edge_json
    )
    VALUES (?, ?, ?, ?, ?, json(?))
    ON CONFLICT(edge_id) DO NOTHING
  `).run(
    parsed.edge_id,
    parsed.edge_kind,
    parsed.from_node_id,
    parsed.to_node_id,
    parsed.created_at,
    JSON.stringify(parsed),
  );
}

function readRuntimeGraphNodeByKindRef(
  sqlite: SqliteDatabase,
  nodeKind: "goal" | "task",
  ref: string,
): RuntimeGraphNode | null {
  const row = sqlite.prepare(`
    SELECT node_json
    FROM personal_agent_runtime_graph_nodes
    WHERE node_kind = ? AND ref = ?
    ORDER BY
      CASE
        WHEN json_extract(node_json, '$.payload.runtime_graph_role') = 'source_of_truth' THEN 0
        ELSE 1
      END,
      updated_at DESC,
      node_id DESC
    LIMIT 1
  `).get(nodeKind, ref) as { node_json: string } | undefined;
  return row ? RuntimeGraphNodeSchema.parse(parseJson(row.node_json)) : null;
}

function readGoalFromRuntimeGraph(
  sqlite: SqliteDatabase,
  goalId: string,
  options: { includeArchived?: boolean } = {},
): Goal | null {
  const node = readRuntimeGraphNodeByKindRef(sqlite, "goal", goalId);
  if (!node) return null;
  if (node.payload["runtime_graph_role"] !== "source_of_truth") return null;
  if (options.includeArchived === false && node.payload["archived"] === true) return null;
  const goal = node.payload["goal"];
  return GoalSchema.parse(goal);
}

function listGoalIdsFromRuntimeGraph(sqlite: SqliteDatabase, archived: 0 | 1): string[] {
  const rows = sqlite.prepare(`
    SELECT ref
    FROM personal_agent_runtime_graph_nodes
    WHERE node_kind = 'goal'
      AND json_extract(node_json, '$.payload.runtime_graph_role') = 'source_of_truth'
      AND json_extract(node_json, '$.payload.entity_kind') = 'goal'
      AND json_extract(node_json, '$.payload.archived') = ?
    ORDER BY updated_at ASC, ref ASC
  `).all(archived) as Array<{ ref: string }>;
  return rows.map((row) => row.ref);
}

function readTaskFromRuntimeGraph(sqlite: SqliteDatabase, goalId: string, taskId: string): Task | null {
  const node = readRuntimeGraphNodeByKindRef(sqlite, "task", taskId);
  if (!node) return null;
  if (node.payload["runtime_graph_role"] !== "source_of_truth") return null;
  const task = TaskSchema.parse(node.payload["task"]);
  return task.goal_id === goalId ? task : null;
}

function listTasksFromRuntimeGraph(
  sqlite: SqliteDatabase,
  filter: { goalId: string; status?: never } | { goalId?: never; status: Task["status"] },
): Task[] {
  const predicate = filter.goalId
    ? "AND json_extract(node_json, '$.payload.task.goal_id') = ?"
    : "AND json_extract(node_json, '$.payload.task.status') = ?";
  const value = filter.goalId ?? filter.status;
  const rows = sqlite.prepare(`
    SELECT node_json
    FROM personal_agent_runtime_graph_nodes
    WHERE node_kind = 'task'
      AND json_extract(node_json, '$.payload.runtime_graph_role') = 'source_of_truth'
      AND json_extract(node_json, '$.payload.entity_kind') = 'task'
      ${predicate}
    ORDER BY
      CASE
        WHEN ? = 'goal' THEN json_extract(node_json, '$.payload.task.created_at')
        ELSE updated_at
      END DESC,
      ref ASC
  `).all(value, filter.goalId ? "goal" : "status") as Array<{ node_json: string }>;
  const tasks = rows.map((row) => TaskSchema.parse(RuntimeGraphNodeSchema.parse(parseJson(row.node_json)).payload["task"]));
  if (filter.goalId) return tasks;
  return tasks.sort((left, right) => {
    const leftUpdated = validDateTimeOrNow(left.completed_at ?? left.started_at ?? left.created_at);
    const rightUpdated = validDateTimeOrNow(right.completed_at ?? right.started_at ?? right.created_at);
    return leftUpdated.localeCompare(rightUpdated)
      || left.goal_id.localeCompare(right.goal_id)
      || left.id.localeCompare(right.id);
  });
}

function listTaskIdsFromRuntimeGraph(sqlite: SqliteDatabase, goalId: string): string[] {
  return listTasksFromRuntimeGraph(sqlite, { goalId }).map((task) => task.id);
}

function readObservationLog(sqlite: SqliteDatabase, goalId: string): ObservationLog | null {
  const row = sqlite.prepare(`
    SELECT log_json
    FROM goal_observation_logs
    WHERE goal_id = ?
  `).get(goalId) as { log_json: string } | undefined;
  return row ? ObservationLogSchema.parse(parseJson(row.log_json)) : null;
}

function upsertObservationLog(sqlite: SqliteDatabase, log: ObservationLog): void {
  sqlite.prepare(`
    INSERT INTO goal_observation_logs (goal_id, updated_at, log_json)
    VALUES (?, ?, json(?))
    ON CONFLICT(goal_id) DO UPDATE SET
      updated_at = excluded.updated_at,
      log_json = excluded.log_json
  `).run(log.goal_id, nowIso(), JSON.stringify(log));
}

function readGapHistory(sqlite: SqliteDatabase, goalId: string): GapHistoryEntry[] {
  const row = sqlite.prepare(`
    SELECT history_json
    FROM goal_gap_histories
    WHERE goal_id = ?
  `).get(goalId) as { history_json: string } | undefined;
  if (!row) return [];
  const parsed = parseJson(row.history_json);
  return Array.isArray(parsed)
    ? parsed.map((entry) => GapHistoryEntrySchema.parse(entry))
    : [];
}

function upsertGapHistory(sqlite: SqliteDatabase, goalId: string, history: GapHistoryEntry[]): void {
  sqlite.prepare(`
    INSERT INTO goal_gap_histories (goal_id, updated_at, history_json)
    VALUES (?, ?, json(?))
    ON CONFLICT(goal_id) DO UPDATE SET
      updated_at = excluded.updated_at,
      history_json = excluded.history_json
  `).run(goalId, nowIso(), JSON.stringify(history));
}

function upsertTask(sqlite: SqliteDatabase, task: Task): void {
  const updatedAt = validDateTimeOrNow(task.completed_at ?? task.started_at ?? task.created_at);
  upsertRuntimeGraphNode(sqlite, buildTaskRuntimeGraphNode(task, updatedAt));
  insertRuntimeGraphEdgeIfNodesExist(sqlite, {
    schema_version: "runtime-graph-edge/v1",
    edge_id: `runtime-graph:edge:goal-task:${task.goal_id}:${task.id}`,
    edge_kind: "parent_of",
    from_node_id: goalRuntimeGraphNodeId(task.goal_id),
    to_node_id: taskRuntimeGraphNodeId(task.id),
    created_at: updatedAt,
    provenance_refs: [
      { kind: "goal", ref: task.goal_id },
      { kind: "task", ref: task.id },
    ],
  });
  sqlite.prepare(`
    INSERT INTO task_records (
      goal_id, task_id, status, primary_dimension, strategy_id,
      created_at, started_at, completed_at, updated_at, task_json
    )
    VALUES (
      @goal_id, @task_id, @status, @primary_dimension, @strategy_id,
      @created_at, @started_at, @completed_at, @updated_at, json(@task_json)
    )
    ON CONFLICT(goal_id, task_id) DO UPDATE SET
      status = excluded.status,
      primary_dimension = excluded.primary_dimension,
      strategy_id = excluded.strategy_id,
      created_at = excluded.created_at,
      started_at = excluded.started_at,
      completed_at = excluded.completed_at,
      updated_at = excluded.updated_at,
      task_json = excluded.task_json
  `).run({
    goal_id: task.goal_id,
    task_id: task.id,
    status: task.status,
    primary_dimension: task.primary_dimension,
    strategy_id: task.strategy_id ?? null,
    created_at: task.created_at,
    started_at: task.started_at ?? null,
    completed_at: task.completed_at ?? null,
    updated_at: updatedAt,
    task_json: JSON.stringify(task),
  });
}

function readTask(sqlite: SqliteDatabase, goalId: string, taskId: string): Task | null {
  const graphTask = readTaskFromRuntimeGraph(sqlite, goalId, taskId);
  if (graphTask) return graphTask;
  const row = sqlite.prepare(`
    SELECT task_json
    FROM task_records
    WHERE goal_id = ? AND task_id = ?
  `).get(goalId, taskId) as { task_json: string } | undefined;
  if (!row) return null;
  const task = TaskSchema.parse(parseJson(row.task_json));
  upsertTask(sqlite, task);
  return readTaskFromRuntimeGraph(sqlite, goalId, taskId) ?? task;
}

function readTaskOutcomeLedger(
  sqlite: SqliteDatabase,
  goalId: string,
  taskId: string,
): TaskOutcomeLedgerRecordLike | null {
  const summaryRow = sqlite.prepare(`
    SELECT summary_json
    FROM task_outcome_summaries
    WHERE goal_id = ? AND task_id = ?
  `).get(goalId, taskId) as { summary_json: string } | undefined;
  if (!summaryRow) return null;
  const eventRows = sqlite.prepare(`
    SELECT event_json
    FROM task_outcome_events
    WHERE goal_id = ? AND task_id = ?
    ORDER BY event_index ASC
  `).all(goalId, taskId) as Array<{ event_json: string }>;
  return {
    goal_id: goalId,
    task_id: taskId,
    events: eventRows.map((row) => parseJson(row.event_json)),
    summary: parseJson<Record<string, unknown>>(summaryRow.summary_json),
  };
}
