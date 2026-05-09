import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { getPulseedDirPath } from "../utils/paths.js";
import { StateError } from "../utils/errors.js";
import type { Logger } from "../../runtime/logger.js";
import { GoalSchema, GoalTreeSchema } from "../types/goal.js";
import { ObservationLogSchema, ObservationLogEntrySchema } from "../types/state.js";
import { GapHistoryEntrySchema } from "../types/gap.js";
import type { Goal, GoalTree } from "../types/goal.js";
import type { ObservationLog, ObservationLogEntry } from "../types/state.js";
import type { GapHistoryEntry } from "../types/gap.js";
import type { PaceSnapshot } from "../types/goal.js";
import type { Task } from "../types/task.js";
import type { PipelineState } from "../types/pipeline.js";
import { LoopCheckpointSchema } from "../types/checkpoint.js";
import type { CheckpointTrustPort } from "./checkpoint-trust-port.js";
import { initDirs, atomicWrite, atomicRead } from "./state-persistence.js";
import { GoalWriteCoordinator } from "./state-manager-goal-write.js";
import type { StateWriteFence } from "./state-write-fence.js";
import {
  listRecoverableArchivedGoalIds as listRecoverableArchivedGoalIdsFromState,
} from "./state-manager-goal-state.js";

export { initDirs, atomicWrite, atomicRead };
export type { StateWriteFence, StateWriteFenceContext } from "./state-write-fence.js";

const MAX_HISTORY_ENTRIES = 500;
type GoalTaskStateStore = import("../../runtime/store/goal-task-state-store.js").GoalTaskStateStore;
type StrategyDreamStateStore = import("../../runtime/store/strategy-dream-state-store.js").StrategyDreamStateStore;
type ProcessSessionStateStore = import("../../runtime/store/process-session-state-store.js").ProcessSessionStateStore;

function normalizeRawStatePath(relativePath: string): string[] {
  return relativePath.replace(/\\/g, "/").replace(/^\/+/, "").split("/").filter(Boolean);
}

function isGoalTaskDurableStatePath(relativePath: string): boolean {
  const parts = normalizeRawStatePath(relativePath);
  if (parts.length === 0) return false;
  if (parts[0] === "goals" && parts.length >= 3) return true;
  if (parts[0] === "tasks" && parts.length >= 3) return true;
  if (parts[0] === "goal-trees" && parts.length === 2) return true;
  if (parts[0] === "verification" && parts.length === 3) return true;
  if (parts[0] === "checkpoints" && parts.length >= 3) return true;
  if (parts[0] === "pipelines" && parts.length === 2) return true;
  if (parts[0] === "stalls" && parts.length === 2) return true;
  return false;
}

function isStrategyDreamDurableStatePath(relativePath: string): boolean {
  const parts = normalizeRawStatePath(relativePath);
  return parts[0] === "strategies" && parts.length >= 3;
}

function isProcessSessionDurableStatePath(relativePath: string): boolean {
  const parts = normalizeRawStatePath(relativePath);
  return parts[0] === "runtime" && parts[1] === "process-sessions" && parts.length === 3 && parts[2]!.endsWith(".json");
}

/**
 * StateManager handles persistence of goals, state vectors, observation logs,
 * and gap history under a base directory (default: ~/.pulseed/).
 *
 * File layout:
 *   <base>/goals/<goal_id>/goal.json
 *   <base>/goals/<goal_id>/observations.json
 *   <base>/goals/<goal_id>/gap-history.json
 *   <base>/goal-trees/<root_id>.json
 *   <base>/events/              (event queue directory)
 *   <base>/events/archive/      (processed events)
 *   <base>/reports/             (report output directory)
 *
 * All writes are atomic: write to .tmp file, then rename.
 */
export class StateManager {
  private readonly baseDir: string;
  private readonly logger?: Logger;
  private readonly walEnabled: boolean;
  private readonly goalWriteCoordinator: GoalWriteCoordinator;
  private goalTaskStateStorePromise: Promise<GoalTaskStateStore> | null = null;
  private strategyDreamStateStorePromise: Promise<StrategyDreamStateStore> | null = null;
  private processSessionStateStorePromise: Promise<ProcessSessionStateStore> | null = null;
  private readonly goalStateWriteQueues = new Map<string, Promise<void>>();

  constructor(baseDir?: string, logger?: Logger, options?: { walEnabled?: boolean }) {
    this.baseDir = baseDir ?? getPulseedDirPath();
    this.logger = logger;
    this.walEnabled = options?.walEnabled ?? true;
    this.goalWriteCoordinator = new GoalWriteCoordinator({
      baseDir: this.baseDir,
      walEnabled: this.walEnabled,
      loadGoal: (goalId) => this.loadGoal(goalId),
    });
  }

  /** Create required subdirectories. Must be called after construction before first use. */
  async init(): Promise<void> {
    await initDirs(this.baseDir);
    await (await this.goalTaskStateStore()).ensureReady();
    await (await this.strategyDreamStateStore()).ensureReady();
    await (await this.processSessionStateStore()).ensureReady();
  }

  /** Returns the base directory path */
  getBaseDir(): string {
    return this.baseDir;
  }

  setWriteFence(goalId: string, fence: StateWriteFence): void {
    this.goalWriteCoordinator.setWriteFence(goalId, fence);
  }

  clearWriteFence(goalId: string): void {
    this.goalWriteCoordinator.clearWriteFence(goalId);
  }

  private async assertWriteFence(goalId: string, op: string, data: unknown): Promise<void> {
    await this.goalWriteCoordinator.assertWriteFence(goalId, op, data);
  }

  private async runGoalStateMutation<T>(
    goalId: string,
    op: string,
    data: unknown,
    fn: () => Promise<T>
  ): Promise<T> {
    const previous = this.goalStateWriteQueues.get(goalId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => {
      await this.assertWriteFence(goalId, op, data);
      return fn();
    });
    const marker = run.then(() => undefined, () => undefined);
    this.goalStateWriteQueues.set(goalId, marker);
    try {
      return await run;
    } finally {
      if (this.goalStateWriteQueues.get(goalId) === marker) {
        this.goalStateWriteQueues.delete(goalId);
      }
    }
  }

  private async goalDir(goalId: string): Promise<string> {
    return this.goalWriteCoordinator.goalDir(goalId);
  }

  // ─── Atomic Write / Read (delegated to state-persistence) ───

  private async atomicWrite(filePath: string, data: unknown): Promise<void> {
    return atomicWrite(filePath, data);
  }

  private async atomicRead<T>(filePath: string): Promise<T | null> {
    return atomicRead<T>(filePath, this.logger);
  }

  /** Wrap a goal write with lock + WAL + snapshot cycle. */
  private async protectedWrite(goalId: string, op: string, data: unknown, writeFn: () => Promise<void>): Promise<void> {
    await this.goalWriteCoordinator.protectedWrite(goalId, op, data, writeFn);
  }

  private isEnoent(error: unknown): boolean {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }

  private async pathExists(filePath: string): Promise<boolean> {
    try {
      await fsp.access(filePath);
      return true;
    } catch (e: unknown) {
      if (!this.isEnoent(e)) throw e;
      return false;
    }
  }

  private async cleanupActiveGoalState(goalId: string): Promise<void> {
    await fsp.rm(path.join(this.baseDir, "goals", goalId), { recursive: true, force: true });
    await fsp.rm(path.join(this.baseDir, "tasks", goalId), { recursive: true, force: true });
    await fsp.rm(path.join(this.baseDir, "strategies", goalId), { recursive: true, force: true });
    await (await this.strategyDreamStateStore()).deleteGoalStrategyState(goalId);
    await fsp.rm(path.join(this.baseDir, "stalls", `${goalId}.json`), { force: true });
    await fsp.rm(path.join(this.baseDir, "reports", goalId), { recursive: true, force: true });
  }

  private markGoalVisited(goalId: string, visited: Set<string>): boolean {
    if (visited.has(goalId)) return false;
    visited.add(goalId);
    return true;
  }

  private capHistoryEntries<T>(entries: T[]): T[] {
    return entries.slice(-MAX_HISTORY_ENTRIES);
  }

  private syntheticGoal(goalId: string): Goal {
    const timestamp = new Date().toISOString();
    return GoalSchema.parse({
      id: goalId,
      title: goalId,
      description: "",
      dimensions: [],
      created_at: timestamp,
      updated_at: timestamp,
    });
  }

  private async ensureGoalRegistryEntryForSidecar(goalId: string): Promise<void> {
    const store = await this.goalTaskStateStore();
    const existing = await store.loadGoal(goalId, { includeArchived: true });
    if (existing === null) {
      await store.saveGoal(this.syntheticGoal(goalId));
    }
  }

  private assertObservationGoalId(goalId: string, entry: ObservationLogEntry): void {
    if (entry.goal_id !== goalId) {
      throw new StateError(
        `appendObservation: entry.goal_id ("${entry.goal_id}") does not match goalId ("${goalId}")`
      );
    }
  }

  private async writeObservationLog(
    goalId: string,
    op: string,
    log: ObservationLog,
    resolveDirBeforeWrite: boolean
  ): Promise<void> {
    const resolvedDir = resolveDirBeforeWrite ? await this.goalDir(goalId) : null;
    await this.protectedWrite(goalId, op, log, async () => {
      const dir = resolvedDir ?? await this.goalDir(goalId);
      await this.atomicWrite(path.join(dir, "observations.json"), log);
    });
  }

  private async writeGapHistory(
    goalId: string,
    op: string,
    entries: GapHistoryEntry[],
    resolveDirBeforeWrite: boolean
  ): Promise<void> {
    const resolvedDir = resolveDirBeforeWrite ? await this.goalDir(goalId) : null;
    await this.protectedWrite(goalId, op, { goalId, entries }, async () => {
      const dir = resolvedDir ?? await this.goalDir(goalId);
      await this.atomicWrite(path.join(dir, "gap-history.json"), entries);
    });
  }

  private async goalTaskStateStore(): Promise<GoalTaskStateStore> {
    this.goalTaskStateStorePromise ??= import("../../runtime/store/goal-task-state-store.js")
      .then(({ GoalTaskStateStore }) => new GoalTaskStateStore(this.baseDir));
    return this.goalTaskStateStorePromise;
  }

  private async strategyDreamStateStore(): Promise<StrategyDreamStateStore> {
    this.strategyDreamStateStorePromise ??= import("../../runtime/store/strategy-dream-state-store.js")
      .then(({ StrategyDreamStateStore }) => new StrategyDreamStateStore(this.baseDir));
    return this.strategyDreamStateStorePromise;
  }

  private async processSessionStateStore(): Promise<ProcessSessionStateStore> {
    this.processSessionStateStorePromise ??= import("../../runtime/store/process-session-state-store.js")
      .then(({ ProcessSessionStateStore }) => new ProcessSessionStateStore(this.baseDir));
    return this.processSessionStateStorePromise;
  }

  // ─── Goal CRUD ───

  async saveGoal(goal: Goal): Promise<void> {
    const parsed = GoalSchema.parse(goal);
    await this.runGoalStateMutation(parsed.id, "save_goal", parsed, async () => {
      await (await this.goalTaskStateStore()).saveGoal(parsed);
    });
  }

  async loadGoal(goalId: string): Promise<Goal | null> {
    return (await this.goalTaskStateStore()).loadGoal(goalId, { includeArchived: true });
  }

  async deleteGoal(goalId: string, _visited = new Set<string>()): Promise<boolean> {
    if (!this.markGoalVisited(goalId, _visited)) return false;

    const goal = await this.loadGoal(goalId);
    if (goal === null) {
      return false;
    }

    // Recursively delete children first (depth-first)
    for (const childId of goal.children_ids) {
      await this.deleteGoal(childId, _visited);
    }
    await (await this.goalTaskStateStore()).deleteGoal(goalId);
    await this.cleanupActiveGoalState(goalId);
    return true;
  }

  /** Archive a DB-owned goal without falling back to legacy goal JSON. */
  async archiveGoal(goalId: string, _visited = new Set<string>()): Promise<boolean> {
    if (!this.markGoalVisited(goalId, _visited)) return false;
    const store = await this.goalTaskStateStore();
    const goal = await store.loadGoal(goalId, { includeArchived: false });
    if (goal !== null) {
      for (const childId of goal.children_ids) {
        await this.archiveGoal(childId, _visited);
      }
      return this.runGoalStateMutation(goalId, "archive_goal", { goalId }, async () => {
        const archived = await store.markGoalArchived(goalId);
        await fsp.rm(path.join(this.baseDir, "goals", goalId), { recursive: true, force: true });
        await fsp.rm(path.join(this.baseDir, "tasks", goalId), { recursive: true, force: true });
        await (await this.strategyDreamStateStore()).deleteGoalStrategyState(goalId);
        await fsp.rm(path.join(this.baseDir, "stalls", `${goalId}.json`), { force: true });
        return archived || (await store.loadGoal(goalId, { includeArchived: true })) !== null;
      });
    }
    return false;
  }

  /**
   * Returns DB-owned archived goal IDs. Legacy archive directories are exposed
   * only through listRecoverableArchivedGoalIds() for explicit migration/recovery.
   */
  async listArchivedGoals(): Promise<string[]> {
    return (await this.goalTaskStateStore()).listGoalIds({ archived: true });
  }

  async listGoalIds(): Promise<string[]> {
    return (await this.goalTaskStateStore()).listGoalIds({ archived: false });
  }

  async listRecoverableArchivedGoalIds(): Promise<string[]> {
    return listRecoverableArchivedGoalIdsFromState(this.baseDir, (filePath) => this.pathExists(filePath));
  }

  async listTasks(goalId: string, options: { includeArchive?: boolean } = {}): Promise<Task[]> {
    void options;
    return (await this.goalTaskStateStore()).listTasks(goalId);
  }

  async listTasksByStatus(status: Task["status"]): Promise<Task[]> {
    return (await this.goalTaskStateStore()).listTasksByStatus(status);
  }

  async loadTask(goalId: string, taskId: string, options: { includeArchive?: boolean } = {}): Promise<Task | null> {
    void options;
    return (await this.goalTaskStateStore()).loadTask(goalId, taskId);
  }

  async listPipelinesByStatus(status: PipelineState["status"]): Promise<PipelineState[]> {
    return (await this.goalTaskStateStore()).listPipelinesByStatus(status);
  }

  // ─── Goal Tree ───

  async saveGoalTree(tree: GoalTree): Promise<void> {
    const parsed = GoalTreeSchema.parse(tree);
    await (await this.goalTaskStateStore()).saveGoalTree(parsed);
  }

  async loadGoalTree(rootId: string): Promise<GoalTree | null> {
    return (await this.goalTaskStateStore()).loadGoalTree(rootId);
  }

  async deleteGoalTree(rootId: string): Promise<boolean> {
    return (await this.goalTaskStateStore()).deleteGoalTree(rootId);
  }

  // ─── Observation Log ───

  async saveObservationLog(log: ObservationLog): Promise<void> {
    const parsed = ObservationLogSchema.parse(log);
    await this.runGoalStateMutation(parsed.goal_id, "save_observation", parsed, async () => {
      await (await this.goalTaskStateStore()).saveObservationLog(parsed);
    });
  }

  async loadObservationLog(goalId: string): Promise<ObservationLog | null> {
    return (await this.goalTaskStateStore()).loadObservationLog(goalId);
  }

  async appendObservation(goalId: string, entry: ObservationLogEntry): Promise<void> {
    const parsed = ObservationLogEntrySchema.parse(entry);
    this.assertObservationGoalId(goalId, parsed);
    await this.runGoalStateMutation(goalId, "append_observation", parsed, async () => {
      await (await this.goalTaskStateStore()).appendObservation(goalId, parsed, MAX_HISTORY_ENTRIES);
    });
  }

  // ─── Gap History ───

  async saveGapHistory(goalId: string, history: GapHistoryEntry[]): Promise<void> {
    const parsed = history.map((e) => GapHistoryEntrySchema.parse(e));
    await this.runGoalStateMutation(goalId, "save_gap_history", { goalId, entries: parsed }, async () => {
      await (await this.goalTaskStateStore()).saveGapHistory(goalId, parsed);
    });
  }

  async loadGapHistory(goalId: string): Promise<GapHistoryEntry[]> {
    return (await this.goalTaskStateStore()).loadGapHistory(goalId);
  }

  async appendGapHistoryEntry(goalId: string, entry: GapHistoryEntry): Promise<void> {
    const parsed = GapHistoryEntrySchema.parse(entry);
    await this.runGoalStateMutation(goalId, "append_gap_entry", parsed, async () => {
      await (await this.goalTaskStateStore()).appendGapHistoryEntry(goalId, parsed, MAX_HISTORY_ENTRIES);
    });
  }

  async appendObservationAndSaveGoal(
    goalId: string,
    entry: ObservationLogEntry,
    updateGoal: (goal: Goal) => Goal
  ): Promise<void> {
    const parsed = ObservationLogEntrySchema.parse(entry);
    this.assertObservationGoalId(goalId, parsed);

    const store = await this.goalTaskStateStore();
    await this.runGoalStateMutation(goalId, "append_observation_and_save_goal", { observation: parsed }, async () => {
      const goal = await store.loadGoal(goalId, { includeArchived: true });
      if (goal === null) {
        throw new StateError(`appendObservationAndSaveGoal: goal "${goalId}" not found`);
      }
      const updatedGoal = GoalSchema.parse(updateGoal(goal));
      if (updatedGoal.id !== goalId) {
        throw new StateError(`appendObservationAndSaveGoal: update changed goal id from "${goalId}" to "${updatedGoal.id}"`);
      }
      await store.appendObservation(goalId, parsed, MAX_HISTORY_ENTRIES);
      await store.saveGoal(updatedGoal);
    });
  }

  /**
   * Save a pace snapshot to a milestone goal (persists to disk).
   */
  async savePaceSnapshot(goalId: string, snapshot: PaceSnapshot): Promise<void> {
    const goal = await this.loadGoal(goalId);
    if (!goal) {
      throw new StateError(`savePaceSnapshot: goal "${goalId}" not found`);
    }
    const updated: Goal = { ...goal, pace_snapshot: snapshot };
    await this.runGoalStateMutation(goalId, "save_pace_snapshot", updated, async () => {
      await (await this.goalTaskStateStore()).saveGoal(GoalSchema.parse(updated));
    });
  }

  // ─── Goal Tree Traversal ───

  /**
   * BFS traversal starting at rootId.
   * Returns null if rootId doesn't exist, otherwise returns goals in BFS order.
   */
  private async bfsCollect(rootId: string): Promise<Goal[] | null> {
    const root = await this.loadGoal(rootId);
    if (root === null) return null;

    const result: Goal[] = [];
    const queue: string[] = [rootId];
    const visited = new Set<string>();

    for (let index = 0; index < queue.length; index++) {
      const currentId = queue[index];
      if (visited.has(currentId)) continue;
      visited.add(currentId);

      const goal = await this.loadGoal(currentId);
      if (goal === null) continue;

      result.push(goal);

      for (const childId of goal.children_ids) {
        if (!visited.has(childId)) {
          queue.push(childId);
        }
      }
    }

    return result;
  }

  /**
   * Get the full goal tree rooted at rootId.
   * Returns null if the root goal doesn't exist.
   * Returns goals in BFS order: root first, then children level by level.
   */
  async getGoalTree(rootId: string): Promise<Goal[] | null> {
    return this.bfsCollect(rootId);
  }

  /**
   * Get all goals in the subtree of goalId (including goalId itself).
   * Returns [] if goal not found.
   */
  async getSubtree(goalId: string): Promise<Goal[]> {
    return (await this.bfsCollect(goalId)) ?? [];
  }

  /**
   * Update a goal that belongs to a tree, handling both goal and tree consistency.
   * Merges updates into the existing goal, preserving its id.
   * If the goal has a parent_id, ensures the parent's children_ids still includes this goal.
   */
  async updateGoalInTree(goalId: string, updates: Partial<Goal>): Promise<void> {
    const existingGoal = await this.loadGoal(goalId);
    if (existingGoal === null) {
      throw new StateError(`updateGoalInTree: goal "${goalId}" not found`);
    }

    const updatedGoal: Goal = {
      ...existingGoal,
      ...updates,
      id: existingGoal.id,  // id is immutable
    };

    await this.saveGoal(updatedGoal);

    // Ensure parent's children_ids still includes this goal
    if (existingGoal.parent_id !== null) {
      const parent = await this.loadGoal(existingGoal.parent_id);
      if (parent !== null && !parent.children_ids.includes(goalId)) {
        await this.saveGoal({
          ...parent,
          children_ids: [...parent.children_ids, goalId],
          updated_at: new Date().toISOString(),
        });
      }
    }
  }

  // ─── Utility ───

  /** Check whether a goal directory exists */
  async goalExists(goalId: string): Promise<boolean> {
    return (await this.goalTaskStateStore()).goalExists(goalId);
  }

  /**
   * Restore dimension values and trust balance from a loop crash-recovery checkpoint.
   * Uses Zod validation on both the checkpoint and the goal.
   * Returns the saved cycle_number so the caller can resume iteration counting,
   * or 0 if no checkpoint exists or restoration fails (non-fatal).
   */
  async restoreFromCheckpoint(
    goalId: string,
    adapterType: string,
    trustManager?: CheckpointTrustPort
  ): Promise<number> {
    try {
      const raw = await (await this.goalTaskStateStore()).loadLoopCheckpoint(goalId);
      if (raw === null) return 0;

      const parseResult = LoopCheckpointSchema.safeParse(raw);
      if (!parseResult.success) {
        this.logger?.warn(`[StateManager] Invalid checkpoint for "${goalId}": ${parseResult.error.message}`);
        return 0;
      }
      const cp = parseResult.data;

      // Restore dimension values from snapshot
      if (cp.dimension_snapshot) {
        const goal = await this.loadGoal(goalId);
        if (goal !== null) {
          const updatedDimensions = goal.dimensions.map((dim) => {
            const snapshotVal = cp.dimension_snapshot![dim.name];
            return typeof snapshotVal === "number"
              ? { ...dim, current_value: snapshotVal }
              : dim;
          });
          await this.saveGoal({ ...goal, dimensions: updatedDimensions });
        }
      }

      // Restore trust balance for the adapter domain
      if (typeof cp.trust_snapshot === "number" && trustManager) {
    try {
      await trustManager.setOverride(adapterType, cp.trust_snapshot, "checkpoint_restore");
    } catch {
      // Non-fatal — trust restore failure should not abort the run
    }
      }

      return cp.cycle_number;
    } catch {
      // Checkpoint restore failure is non-fatal — caller starts from beginning
      return 0;
    }
  }

  /** Read raw JSON from any path relative to base dir */
  async readRaw(relativePath: string): Promise<unknown | null> {
    const resolved = path.resolve(this.baseDir, relativePath);
    if (!resolved.startsWith(path.resolve(this.baseDir) + path.sep)) {
      throw new Error(`Path traversal detected: ${relativePath}`);
    }
    if (isGoalTaskDurableStatePath(relativePath)) {
      const routed = await (await this.goalTaskStateStore()).readRawPath(relativePath);
      if (routed.handled) {
        return routed.value;
      }
    }
    if (isStrategyDreamDurableStatePath(relativePath)) {
      const routed = await (await this.strategyDreamStateStore()).readRawPath(relativePath);
      if (routed.handled) {
        return routed.value;
      }
    }
    if (isProcessSessionDurableStatePath(relativePath)) {
      const routed = await (await this.processSessionStateStore()).readRawPath(relativePath);
      if (routed.handled) {
        return routed.value;
      }
    }
    return this.atomicRead<unknown>(resolved);
  }

  /** Write raw JSON to any path relative to base dir (atomic) */
  async writeRaw(relativePath: string, data: unknown): Promise<void> {
    const resolved = path.resolve(this.baseDir, relativePath);
    if (!resolved.startsWith(path.resolve(this.baseDir) + path.sep)) {
      throw new Error(`Path traversal detected: ${relativePath}`);
    }
    const parts = relativePath.split("/");
    if (isGoalTaskDurableStatePath(relativePath)) {
      const routedStore = await this.goalTaskStateStore();
      if (relativePath.startsWith("goals/") && parts.length >= 3) {
        const goalId = parts[1]!;
        const routed = await this.runGoalStateMutation(goalId, "write_raw", { path: relativePath, payload: data }, async () =>
          routedStore.writeRawPath(relativePath, data)
        );
        if (routed) {
          return;
        }
      } else if (await routedStore.writeRawPath(relativePath, data)) {
        return;
      }
    }
    if (isStrategyDreamDurableStatePath(relativePath)) {
      const routedStore = await this.strategyDreamStateStore();
      if (await routedStore.writeRawPath(relativePath, data)) {
        return;
      }
    }
    if (isProcessSessionDurableStatePath(relativePath)) {
      const routedStore = await this.processSessionStateStore();
      if (await routedStore.writeRawPath(relativePath, data)) {
        return;
      }
    }
    const filePath = resolved;
    const dir = path.dirname(filePath);
    try {
      await fsp.mkdir(dir, { recursive: true });
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    if (relativePath.startsWith("goals/") && parts.length >= 3) {
      const goalId = parts[1]!;
      if (data !== null) {
        await this.ensureGoalRegistryEntryForSidecar(goalId);
      }
      await this.atomicWrite(filePath, data);
    } else {
      await this.atomicWrite(filePath, data);
    }
  }
}
