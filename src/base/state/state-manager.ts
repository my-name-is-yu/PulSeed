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
import { TaskSchema } from "../types/task.js";
import type { Task } from "../types/task.js";
import { PipelineStateSchema, type PipelineState } from "../types/pipeline.js";
import { CheckpointSchema, LoopCheckpointSchema } from "../types/checkpoint.js";
import type { Checkpoint, LoopCheckpoint } from "../types/checkpoint.js";
import { PortfolioSchema, parseStrategy, type Portfolio, type Strategy } from "../types/strategy.js";
import type { RebalanceResult } from "../types/portfolio.js";
import { CapabilityRegistrySchema, type CapabilityRegistry } from "../types/capability.js";
import type { CheckpointTrustPort } from "./checkpoint-trust-port.js";
import { initDirs, atomicWrite, atomicRead } from "./state-persistence.js";
import type { StateWriteFence } from "./state-write-fence.js";
import {
  listRecoverableArchivedGoalIds as listRecoverableArchivedGoalIdsFromState,
} from "./legacy-archived-goal-recovery.js";

export { initDirs, atomicWrite, atomicRead };
export type { StateWriteFence, StateWriteFenceContext } from "./state-write-fence.js";

const MAX_HISTORY_ENTRIES = 500;
type GoalTaskStateStore = import("../../runtime/store/goal-task-state-store.js").GoalTaskStateStore;
type CheckpointIndexEntry = import("../../runtime/store/goal-task-state-store.js").CheckpointIndexEntry;
type TaskOutcomeLedgerRecordLike = import("../../runtime/store/goal-task-state-store.js").TaskOutcomeLedgerRecordLike;
type StrategyDreamStateStore = import("../../runtime/store/strategy-dream-state-store.js").StrategyDreamStateStore;
type ProcessSessionStateStore = import("../../runtime/store/process-session-state-store.js").ProcessSessionStateStore;
type CapabilityRegistryStateStore = import("../../runtime/store/capability-registry-state-store.js").CapabilityRegistryStateStore;
type StallStateStore = import("../../runtime/store/stall-state-store.js").StallStateStore;
type LearningRuntimeStateStore = import("../../runtime/store/learning-runtime-state-store.js").LearningRuntimeStateStore;
type KnowledgeTransferStateStore = import("../../runtime/store/knowledge-transfer-state-store.js").KnowledgeTransferStateStore;
type TransferTrustStateStore = import("../../runtime/store/transfer-trust-state-store.js").TransferTrustStateStore;
type StallState = import("../types/stall.js").StallState;

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
  return false;
}

function parseStallStateRawPath(relativePath: string): string | null {
  const parts = normalizeRawStatePath(relativePath);
  if (parts[0] !== "stalls" || parts.length !== 2) return null;
  const fileName = parts[1]!;
  return fileName.endsWith(".json") ? fileName.slice(0, -".json".length) : null;
}

function isLearningRuntimeRawPath(relativePath: string): boolean {
  const parts = normalizeRawStatePath(relativePath);
  if (parts[0] !== "learning" || parts.length !== 2) return false;
  const fileName = parts[1]!;
  return fileName.endsWith("_logs.json")
    || fileName.endsWith("_patterns.json")
    || fileName.endsWith("_feedback.json")
    || fileName.endsWith("_structural_feedback.json");
}

function isKnowledgeTransferRawPath(relativePath: string): boolean {
  const parts = normalizeRawStatePath(relativePath);
  return (parts.length === 2 && parts[0] === "knowledge-transfer" && parts[1] === "snapshot.json")
    || (parts.length === 2 && parts[0] === "meta-patterns" && parts[1] === "last_aggregated_at.json");
}

function isCapabilityDependenciesRawPath(relativePath: string): boolean {
  const parts = normalizeRawStatePath(relativePath);
  return parts.length === 1 && parts[0] === "capability_dependencies.json";
}

function isTransferTrustRawPath(relativePath: string): boolean {
  const parts = normalizeRawStatePath(relativePath);
  return (parts.length === 2 && parts[0] === "transfer-trust" && parts[1] === "_index.json")
    || (parts.length === 2 && parts[0] === "transfer-trust" && parts[1]!.endsWith(".json"))
    || (parts.length === 2 && parts[0] === "transfer-trust-history" && parts[1]!.endsWith(".json"));
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
 * and gap history under a typed database owned by the configured base directory
 * (default: ~/.pulseed/).
 *
 * Legacy JSON paths are still accepted by readRaw/writeRaw compatibility
 * callers, but goal/task state is routed through GoalTaskStateStore instead of
 * whole-file JSON mutation.
 *
 * Durable state layout:
 *   <base>/runtime/control.db
 *   <base>/events/              (event queue directory)
 *   <base>/events/archive/      (processed events)
 *   <base>/reports/             (report output directory)
 */
export class StateManager {
  private readonly baseDir: string;
  private readonly logger?: Logger;
  private goalTaskStateStorePromise: Promise<GoalTaskStateStore> | null = null;
  private strategyDreamStateStorePromise: Promise<StrategyDreamStateStore> | null = null;
  private processSessionStateStorePromise: Promise<ProcessSessionStateStore> | null = null;
  private capabilityRegistryStateStorePromise: Promise<CapabilityRegistryStateStore> | null = null;
  private stallStateStorePromise: Promise<StallStateStore> | null = null;
  private learningRuntimeStateStorePromise: Promise<LearningRuntimeStateStore> | null = null;
  private knowledgeTransferStateStorePromise: Promise<KnowledgeTransferStateStore> | null = null;
  private transferTrustStateStorePromise: Promise<TransferTrustStateStore> | null = null;
  private readonly goalStateWriteQueues = new Map<string, Promise<void>>();
  private readonly writeFences = new Map<string, StateWriteFence>();

  constructor(baseDir?: string, logger?: Logger, options?: { walEnabled?: boolean }) {
    this.baseDir = baseDir ?? getPulseedDirPath();
    this.logger = logger;
    void options;
  }

  /** Create required subdirectories. Must be called after construction before first use. */
  async init(): Promise<void> {
    await initDirs(this.baseDir);
    await (await this.goalTaskStateStore()).ensureReady();
    await (await this.strategyDreamStateStore()).ensureReady();
    await (await this.capabilityRegistryStateStore()).ensureReady();
    await (await this.processSessionStateStore()).ensureReady();
    await (await this.stallStateStore()).ensureReady();
    await (await this.learningRuntimeStateStore()).ensureReady();
    await (await this.knowledgeTransferStateStore()).ensureReady();
    await (await this.transferTrustStateStore()).ensureReady();
  }

  /** Returns the base directory path */
  getBaseDir(): string {
    return this.baseDir;
  }

  setWriteFence(goalId: string, fence: StateWriteFence): void {
    this.writeFences.set(goalId, fence);
  }

  clearWriteFence(goalId: string): void {
    this.writeFences.delete(goalId);
  }

  private async assertWriteFence(goalId: string, op: string, data: unknown): Promise<void> {
    const fence = this.writeFences.get(goalId);
    if (!fence) return;
    await fence({ goalId, op, data });
  }

  private async runGoalStateMutation<T>(
    goalId: string,
    op: string,
    data: unknown,
    fn: () => Promise<T>
  ): Promise<T> {
    const previous = this.goalStateWriteQueues.get(goalId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => {
      const store = await this.goalTaskStateStore();
      return store.withGoalStateWriteLock(goalId, async () => {
        await this.assertWriteFence(goalId, op, data);
        return fn();
      });
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

  // ─── Atomic Write / Read (delegated to state-persistence) ───

  private async atomicWrite(filePath: string, data: unknown): Promise<void> {
    return atomicWrite(filePath, data);
  }

  private async atomicRead<T>(filePath: string): Promise<T | null> {
    return atomicRead<T>(filePath, this.logger);
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
    await (await this.stallStateStore()).deleteStallState(goalId);
    await fsp.rm(path.join(this.baseDir, "stalls", `${goalId}.json`), { force: true });
    await this.cleanupLearningRuntimeState(goalId);
    await fsp.rm(path.join(this.baseDir, "reports", goalId), { recursive: true, force: true });
  }

  private async cleanupLearningRuntimeState(goalId: string): Promise<void> {
    await (await this.learningRuntimeStateStore()).deleteGoalLearningState(goalId);
    await fsp.rm(path.join(this.baseDir, "learning", `${goalId}_logs.json`), { force: true });
    await fsp.rm(path.join(this.baseDir, "learning", `${goalId}_patterns.json`), { force: true });
    await fsp.rm(path.join(this.baseDir, "learning", `${goalId}_feedback.json`), { force: true });
    await fsp.rm(path.join(this.baseDir, "learning", `${goalId}_structural_feedback.json`), { force: true });
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

  private async capabilityRegistryStateStore(): Promise<CapabilityRegistryStateStore> {
    this.capabilityRegistryStateStorePromise ??= import("../../runtime/store/capability-registry-state-store.js")
      .then(({ CapabilityRegistryStateStore }) => new CapabilityRegistryStateStore(this.baseDir));
    return this.capabilityRegistryStateStorePromise;
  }

  private async stallStateStore(): Promise<StallStateStore> {
    this.stallStateStorePromise ??= import("../../runtime/store/stall-state-store.js")
      .then(({ StallStateStore }) => new StallStateStore(this.baseDir));
    return this.stallStateStorePromise;
  }

  private async learningRuntimeStateStore(): Promise<LearningRuntimeStateStore> {
    this.learningRuntimeStateStorePromise ??= import("../../runtime/store/learning-runtime-state-store.js")
      .then(({ LearningRuntimeStateStore }) => new LearningRuntimeStateStore(this.baseDir));
    return this.learningRuntimeStateStorePromise;
  }

  private async knowledgeTransferStateStore(): Promise<KnowledgeTransferStateStore> {
    this.knowledgeTransferStateStorePromise ??= import("../../runtime/store/knowledge-transfer-state-store.js")
      .then(({ KnowledgeTransferStateStore }) => new KnowledgeTransferStateStore(this.baseDir));
    return this.knowledgeTransferStateStorePromise;
  }

  private async transferTrustStateStore(): Promise<TransferTrustStateStore> {
    this.transferTrustStateStorePromise ??= import("../../runtime/store/transfer-trust-state-store.js")
      .then(({ TransferTrustStateStore }) => new TransferTrustStateStore(this.baseDir));
    return this.transferTrustStateStorePromise;
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

    return this.runGoalStateMutation(goalId, "delete_goal", { goalId }, async () => {
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
    });
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
        await (await this.stallStateStore()).deleteStallState(goalId);
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

  async saveTask(task: Task): Promise<void> {
    const parsed = TaskSchema.parse(task);
    await (await this.goalTaskStateStore()).saveTask(parsed);
  }

  async loadTaskHistory(goalId: string): Promise<unknown[]> {
    return (await this.goalTaskStateStore()).loadTaskHistory(goalId);
  }

  async saveTaskHistory(goalId: string, history: unknown[]): Promise<void> {
    await (await this.goalTaskStateStore()).saveTaskHistory(goalId, history);
  }

  async loadTaskFailureContext(goalId: string): Promise<unknown | null> {
    return (await this.goalTaskStateStore()).loadTaskFailureContext(goalId);
  }

  async saveTaskFailureContext(goalId: string, context: unknown): Promise<void> {
    await (await this.goalTaskStateStore()).saveTaskFailureContext(goalId, context);
  }

  async loadTaskVerificationResult(taskId: string): Promise<unknown | null> {
    return (await this.goalTaskStateStore()).loadTaskVerificationResult(taskId);
  }

  async saveTaskVerificationResult(taskId: string, result: unknown): Promise<void> {
    await (await this.goalTaskStateStore()).saveTaskVerificationResult(taskId, result);
  }

  async loadTaskOutcomeLedger(goalId: string, taskId: string): Promise<TaskOutcomeLedgerRecordLike | null> {
    return (await this.goalTaskStateStore()).loadTaskOutcomeLedger(goalId, taskId);
  }

  async saveTaskOutcomeLedger(record: TaskOutcomeLedgerRecordLike): Promise<void> {
    await (await this.goalTaskStateStore()).saveTaskOutcomeLedger(record);
  }

  async listPipelinesByStatus(status: PipelineState["status"]): Promise<PipelineState[]> {
    return (await this.goalTaskStateStore()).listPipelinesByStatus(status);
  }

  async savePipeline(taskId: string, state: PipelineState): Promise<void> {
    await (await this.goalTaskStateStore()).savePipeline(taskId, PipelineStateSchema.parse(state));
  }

  async loadPipeline(taskId: string): Promise<PipelineState | null> {
    return (await this.goalTaskStateStore()).loadPipeline(taskId);
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

  async loadCurrentGapForDimension(goalId: string, dimensionName: string): Promise<number | null> {
    const history = await this.loadGapHistory(goalId);
    for (let index = history.length - 1; index >= 0; index--) {
      const match = history[index]?.gap_vector.find((gap) => gap.dimension_name === dimensionName);
      if (match && typeof match.normalized_weighted_gap === "number") {
        return match.normalized_weighted_gap;
      }
    }
    return null;
  }

  async saveLoopCheckpoint(goalId: string, checkpoint: LoopCheckpoint, adapterType?: string | null): Promise<void> {
    const parsed = LoopCheckpointSchema.parse(checkpoint);
    await (await this.goalTaskStateStore()).saveLoopCheckpoint(goalId, parsed, adapterType);
  }

  async loadLoopCheckpoint(goalId: string): Promise<LoopCheckpoint | null> {
    return (await this.goalTaskStateStore()).loadLoopCheckpoint(goalId);
  }

  async saveCheckpoint(checkpoint: Checkpoint): Promise<Checkpoint> {
    return (await this.goalTaskStateStore()).saveCheckpoint(CheckpointSchema.parse(checkpoint));
  }

  async loadCheckpoint(checkpointId: string): Promise<Checkpoint | null> {
    return (await this.goalTaskStateStore()).loadCheckpoint(checkpointId);
  }

  async loadLatestCheckpoint(goalId: string, taskId?: string): Promise<Checkpoint | null> {
    return (await this.goalTaskStateStore()).loadLatestCheckpoint(goalId, taskId);
  }

  async listCheckpointEntries(goalId: string): Promise<CheckpointIndexEntry[]> {
    return (await this.goalTaskStateStore()).listCheckpointEntries(goalId);
  }

  async deleteCheckpoint(goalId: string, checkpointId: string): Promise<boolean> {
    return (await this.goalTaskStateStore()).deleteCheckpoint(goalId, checkpointId);
  }

  async garbageCollectCheckpoints(goalId: string, cutoffMs: number): Promise<number> {
    return (await this.goalTaskStateStore()).garbageCollectCheckpoints(goalId, cutoffMs);
  }

  async loadStrategyPortfolio(goalId: string): Promise<Portfolio | null> {
    return (await this.strategyDreamStateStore()).loadPortfolio(goalId);
  }

  async saveStrategyPortfolio(goalId: string, portfolio: Portfolio): Promise<void> {
    await (await this.strategyDreamStateStore()).savePortfolio(goalId, PortfolioSchema.parse(portfolio));
  }

  async loadStrategyHistory(goalId: string): Promise<Strategy[]> {
    return (await this.strategyDreamStateStore()).loadStrategyHistory(goalId);
  }

  async saveStrategyHistory(goalId: string, history: Strategy[]): Promise<void> {
    await (await this.strategyDreamStateStore()).saveStrategyHistory(goalId, history.map((strategy) => parseStrategy(strategy)));
  }

  async loadWaitMetadata(goalId: string, strategyId: string): Promise<unknown | null> {
    return (await this.strategyDreamStateStore()).loadWaitMetadata(goalId, strategyId);
  }

  async saveWaitMetadata(goalId: string, strategyId: string, metadata: unknown): Promise<void> {
    await (await this.strategyDreamStateStore()).saveWaitMetadata(goalId, strategyId, metadata);
  }

  async loadRebalanceHistory(goalId: string): Promise<unknown[]> {
    return (await this.strategyDreamStateStore()).loadRebalanceHistory(goalId);
  }

  async saveRebalanceHistory(goalId: string, history: RebalanceResult[] | unknown[]): Promise<void> {
    await (await this.strategyDreamStateStore()).saveRebalanceHistory(goalId, history);
  }

  async loadCapabilityRegistry(): Promise<CapabilityRegistry> {
    return (await this.capabilityRegistryStateStore()).loadRegistry();
  }

  async saveCapabilityRegistry(registry: CapabilityRegistry): Promise<void> {
    await (await this.capabilityRegistryStateStore()).saveRegistry(CapabilityRegistrySchema.parse(registry));
  }

  async isCapabilityAvailable(capabilityName: string): Promise<boolean> {
    return (await this.capabilityRegistryStateStore()).isCapabilityAvailable(capabilityName);
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
    const stallGoalId = parseStallStateRawPath(relativePath);
    if (stallGoalId) {
      return (await this.stallStateStore()).loadStallState(stallGoalId);
    }
    if (isLearningRuntimeRawPath(relativePath)) {
      const routed = await (await this.learningRuntimeStateStore()).readRawPath(relativePath);
      if (routed.handled) {
        return routed.value;
      }
    }
    if (isKnowledgeTransferRawPath(relativePath)) {
      const routed = await (await this.knowledgeTransferStateStore()).readRawPath(relativePath);
      if (routed.handled) {
        return routed.value;
      }
    }
    if (isCapabilityDependenciesRawPath(relativePath)) {
      const routed = await (await this.capabilityRegistryStateStore()).readRawPath(relativePath);
      if (routed.handled) {
        return routed.value;
      }
    }
    if (isTransferTrustRawPath(relativePath)) {
      const routed = await (await this.transferTrustStateStore()).readRawPath(relativePath);
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
    const stallGoalId = parseStallStateRawPath(relativePath);
    if (stallGoalId) {
      const routedStore = await this.stallStateStore();
      if (data === null) {
        await routedStore.deleteStallState(stallGoalId);
      } else {
        await routedStore.saveStallState(stallGoalId, data as StallState);
      }
      return;
    }
    if (isLearningRuntimeRawPath(relativePath)) {
      const routedStore = await this.learningRuntimeStateStore();
      if (await routedStore.writeRawPath(relativePath, data)) {
        return;
      }
    }
    if (isKnowledgeTransferRawPath(relativePath)) {
      const routedStore = await this.knowledgeTransferStateStore();
      if (await routedStore.writeRawPath(relativePath, data)) {
        return;
      }
    }
    if (isCapabilityDependenciesRawPath(relativePath)) {
      const routedStore = await this.capabilityRegistryStateStore();
      if (await routedStore.writeRawPath(relativePath, data)) {
        return;
      }
    }
    if (isTransferTrustRawPath(relativePath)) {
      const routedStore = await this.transferTrustStateStore();
      if (await routedStore.writeRawPath(relativePath, data)) {
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
