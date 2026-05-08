import { ObservationLogSchema } from "../../base/types/state.js";
import type { ObservationLogEntry, ObservationLog } from "../../base/types/state.js";
import type { ObservationLayer, ObservationMethod } from "../../base/types/core.js";
import type { StateManager } from "../../base/state/state-manager.js";
import type { KnowledgeGapSignal } from "../../base/types/knowledge.js";
import type { IDataSourceAdapter } from "./data-source-adapter.js";
import type { ILLMClient } from "../../base/llm/llm-client.js";
import type { Logger } from "../../runtime/logger.js";
import type { IDimensionPreChecker } from "./dimension-pre-checker.js";
import type { HookManager } from "../../runtime/hook-manager.js";
import {
  observeForTask as _observeForTask,
} from "./observation-task.js";
import type { TaskDomain } from "../../base/types/pipeline.js";
import type { AgentTask } from "../../orchestrator/execution/adapter-layer.js";
import type { TaskObservationContext } from "./observation-task.js";
export type { TaskObservationContext } from "./observation-task.js";
import {
  applyProgressCeiling,
  getConfidenceTier,
  createObservationEntry,
  needsVerificationTask,
  resolveContradiction,
  normalizeDimensionName,
  detectKnowledgeGap,
  loadOrEmptyObservationLog,
} from "./observation-helpers.js";
import type { ObservationEngineOptions, CrossValidationResult } from "./observation-helpers.js";
import { observeWithLLM as llmObserve } from "./observation-llm.js";
import {
  applyObservation as applyObservationFn,
  observeFromDataSource as observeFromDataSourceFn,
} from "./observation-apply.js";
import { findDataSourceForDimension as findDataSourceForDimensionFn } from "./observation-datasource.js";
import { createWorkspaceContextFetcher } from "./engine/observe-context.js";
import { runPreCheckStage } from "./engine/observe-precheck.js";
import { runToolObservationStage } from "./engine/observe-tool-stage.js";
import { runDataSourceObservationStage } from "./engine/observe-datasource-stage.js";
import { runLlmObservationStage } from "./engine/observe-llm-stage.js";
import { runSelfReportStage } from "./engine/observe-self-report.js";
import { createGoalWorkspaceArtifactMetricDataSource } from "../../adapters/datasources/artifact-metric-datasource.js";
import type { ArtifactMetricFreshnessScope } from "../../adapters/datasources/artifact-metric-datasource.js";
import { isArtifactContractRequired } from "../../orchestrator/execution/task/task-artifact-contract.js";
import { extractWorkspacePathConstraint, resolveWorkspacePath } from "../../base/utils/workspace-path.js";

import type { ToolExecutor } from "../../tools/executor.js";
import type { ToolCallContext } from "../../tools/types.js";
import type { Dimension } from "../../orchestrator/goal/types/goal.js";
import type { Goal } from "../../base/types/goal.js";
import type { Task } from "../../base/types/task.js";
import { observeWithTools } from "./observation-tools.js";
import type { ToolObservationResult } from "./observation-tools.js";

// Re-export types and helpers for backward compatibility
export type { ObservationEngineOptions, CrossValidationResult } from "./observation-helpers.js";
export {
  applyProgressCeiling,
  getConfidenceTier,
  createObservationEntry,
  needsVerificationTask,
  resolveContradiction,
  detectKnowledgeGap,
} from "./observation-helpers.js";


export {
  observeWithTools,
  registerObservationAllowRules,
  type ToolObservationResult,
} from "./observation-tools.js";

/**
 * ObservationEngine handles the 3-layer observation architecture.
 *
 * Layers (in descending trust order):
 *   mechanical         — confidence [0.85, 1.0],  progress ceiling 1.00
 *   independent_review — confidence [0.50, 0.84], progress ceiling 0.90
 *   self_report        — confidence [0.10, 0.49], progress ceiling 0.70
 *
 * Observation logs are persisted via StateManager.appendObservation.
 * Goal state updates are persisted via StateManager.saveGoal.
 */
export class ObservationEngine {
  private readonly stateManager: StateManager;
  private dataSources: IDataSourceAdapter[];
  private readonly llmClient?: ILLMClient;
  private readonly contextProvider?: (goalId: string, dimensionName: string) => Promise<string>;
  private readonly options: ObservationEngineOptions;
  private readonly logger?: Logger;
  private readonly preChecker?: IDimensionPreChecker;
  private readonly hookManager?: HookManager;
  private toolExecutor?: ToolExecutor;

  constructor(
    stateManager: StateManager,
    dataSources: IDataSourceAdapter[] = [],
    llmClient?: ILLMClient,
    contextProvider?: (goalId: string, dimensionName: string) => Promise<string>,
    options: ObservationEngineOptions = {},
    logger?: Logger,
    preChecker?: IDimensionPreChecker,
    hookManager?: HookManager,
    toolExecutor?: ToolExecutor
  ) {
    this.stateManager = stateManager;
    this.dataSources = dataSources;
    this.llmClient = llmClient;
    this.contextProvider = contextProvider;
    this.options = options;
    this.logger = logger;
    this.preChecker = preChecker;
    this.hookManager = hookManager;
    this.toolExecutor = toolExecutor;
  }

  // ─── Cross-Validation ───

  /**
   * Compare a mechanical observation value against an LLM-produced value.
   * Logs a warning when the two diverge beyond the configured threshold.
   * The mechanical value always wins — LLM is used for diagnostics only.
   */
  private crossValidate(
    goalId: string,
    dimensionName: string,
    mechanicalValue: number,
    llmValue: number
  ): CrossValidationResult {
    const threshold = this.options.divergenceThreshold ?? 0.20;
    const denominator = Math.max(Math.abs(mechanicalValue), Math.abs(llmValue), 1);
    const ratio = Math.abs(mechanicalValue - llmValue) / denominator;
    const diverged = ratio > threshold;

    // Apply confidence penalty proportional to divergence when LLM hallucinated.
    // Penalty = min(0.30, divergenceRatio * 0.5) — caps at 0.30.
    const confidencePenalty = diverged ? Math.min(0.30, ratio * 0.5) : 0;

    if (diverged) {
      this.logger?.warn(
        `[CrossValidation] DIVERGED goal="${goalId}" dim="${dimensionName}" ` +
        `mechanical=${mechanicalValue} llm=${llmValue} ` +
        `ratio=${ratio.toFixed(3)} threshold=${threshold} ` +
        `confidencePenalty=${confidencePenalty.toFixed(3)} resolution=mechanical_wins`
      );
    }

    return {
      dimensionName,
      mechanicalValue,
      llmValue,
      diverged,
      divergenceRatio: ratio,
      resolution: "mechanical_wins",
      confidencePenalty,
    };
  }

  // ─── Progress Ceiling ───

  /**
   * Apply progress ceiling based on observation layer.
   * Returns min(progress, ceiling).
   */
  applyProgressCeiling(progress: number, layer: ObservationLayer): number {
    return applyProgressCeiling(progress, layer);
  }

  // ─── Confidence Tier ───

  /**
   * Return the ConfidenceTier and valid confidence range for a given layer.
   */
  getConfidenceTier(layer: ObservationLayer): ReturnType<typeof getConfidenceTier> {
    return getConfidenceTier(layer);
  }

  // ─── Create Observation Entry ───

  /**
   * Construct a new ObservationLogEntry.
   * Confidence is clamped to the layer's valid range.
   */
  createObservationEntry(params: Parameters<typeof createObservationEntry>[0]): ObservationLogEntry {
    return createObservationEntry(params);
  }

  // ─── Evidence Gate ───

  /**
   * Returns true when effective progress meets the threshold but confidence
   * is below 0.85, meaning a mechanical verification task should be generated.
   */
  needsVerificationTask(effectiveProgress: number, confidence: number, threshold: number): boolean {
    return needsVerificationTask(effectiveProgress, confidence, threshold);
  }

  // ─── Contradiction Resolution ───

  /**
   * Resolve contradictions among multiple observation entries.
   */
  resolveContradiction(entries: ObservationLogEntry[]): ObservationLogEntry {
    return resolveContradiction(entries);
  }

  // ─── Dimension Name Normalization ───

  /**
   * Strip trailing _2, _3, ... _N suffixes that LLMs sometimes append to
   * deduplicate JSON keys.  Only applied to names from external (LLM) input.
   */
  normalizeDimensionName(name: string): string {
    return normalizeDimensionName(name, this.logger);
  }

  // ─── Apply Observation to Goal ───

  applyObservation(goalId: string, entry: ObservationLogEntry): Promise<void> {
    return applyObservationFn(goalId, entry, this.stateManager, this.options);
  }

  // ─── Observation Log Persistence ───

  /**
   * Load the observation log for a goal.
   * Returns an empty log if none exists.
   */
  async getObservationLog(goalId: string): Promise<ObservationLog> {
    return loadOrEmptyObservationLog(this.stateManager, goalId);
  }

  /**
   * Persist the observation log for a goal.
   */
  async saveObservationLog(goalId: string, log: ObservationLog): Promise<void> {
    if (goalId !== log.goal_id) throw new Error("goalId mismatch");
    const parsed = ObservationLogSchema.parse(log);
    await this.stateManager.saveObservationLog(parsed);
  }

  // ─── Observe ───

  /**
   * Perform an observation pass for all dimensions of a goal.
   *
   * For each dimension, the following priority order is used:
   *   1. DataSource — if a registered data source covers this dimension,
   *      call observeFromDataSource() (mechanical, confidence 0.90).
   *   2. LLM — if an LLM client is available, call observeWithLLM()
   *      (independent_review, confidence 0.70).
   *   3. self_report — fall back to re-recording the existing stored value.
   *
   * @param goalId   The goal to observe.
   * @param methods  Array of ObservationMethod descriptors (one per dimension,
   *                 in the same order as goal.dimensions).  Extra entries are
   *                 ignored; missing entries fall back to the dimension's own
   *                 observation_method.
   */
  async observe(goalId: string, methods: ObservationMethod[]): Promise<void> {
    const goal = await this.stateManager.loadGoal(goalId);
    if (goal === null) {
      throw new Error(`observe: goal "${goalId}" not found`);
    }

    // When methods array is non-empty, only observe the dimensions corresponding to
    // the provided methods (the caller is explicitly selecting which dimensions to observe).
    // When methods is empty (e.g. CoreLoop passes []), observe all dimensions.
    const observeCount = methods.length > 0 ? methods.length : goal.dimensions.length;
    const fetchWorkspaceContext = createWorkspaceContextFetcher(this.contextProvider, this.logger);

    // Workspace path for pre-checker (extracted from contextProvider key heuristic)
    const workspacePathConstraint = extractWorkspacePathConstraint(goal.constraints);
    const workspacePath = workspacePathConstraint
      ? resolveWorkspacePath(workspacePathConstraint, this.options.workspaceBasePath)
      : undefined;
    const goalArtifactDataSource = await createGoalScopedArtifactDataSource(goalId, goal, workspacePath, this.stateManager);
    const observationDataSources = goalArtifactDataSource
      ? [...this.dataSources, goalArtifactDataSource]
      : this.dataSources;

    for (const dataSource of observationDataSources) {
      dataSource.beginObservationPass?.();
    }
    try {
    for (let idx = 0; idx < observeCount; idx++) {
      const dim = goal.dimensions[idx]!;
      const method: ObservationMethod = methods[idx] ?? dim.observation_method;

      void this.hookManager?.emit("PreObserve", { goal_id: goalId, dimension: dim.name });

      if (await runPreCheckStage({
        goalId,
        dimension: dim,
        method,
        workspacePath,
        enabled: goal.observation_optimization?.skip_on_no_change !== false,
        preChecker: this.preChecker,
        applyObservation: (gId, entry) => this.applyObservation(gId, entry),
        logger: this.logger,
        hookManager: this.hookManager,
      })) {
        continue;
      }

      if (this.toolExecutor && await runToolObservationStage({
        goalId,
        dimension: dim,
        method,
        applyObservation: (gId, entry) => this.applyObservation(gId, entry),
        observeWithTools: (dimension, context) => this.observeWithTools(dimension, context),
        logger: this.logger,
        hookManager: this.hookManager,
      })) {
        continue;
      }

      const dataSourceDimensionName = dim.observation_mapping?.dimension ?? dim.name;
      const dataSource = findDataSourceForDimensionFn(observationDataSources, dataSourceDimensionName, goalId, dim.observation_mapping?.data_source);
      if (dataSource && await runDataSourceObservationStage({
        goalId,
        goal,
        dimension: dim,
        queryDimensionName: dataSourceDimensionName,
        method,
        dataSource,
        workspacePath,
        crossValidationEnabled: !!this.options.crossValidationEnabled,
        llmAvailable: !!this.llmClient,
        stateManager: this.stateManager,
        fetchWorkspaceContext,
        observeFromDataSource: (gId, dimensionName, sourceId, queryDimensionName) => observeFromDataSourceFn(
          gId,
          dimensionName,
          sourceId,
          observationDataSources,
          (targetGoalId, entry) => this.applyObservation(targetGoalId, entry),
          queryDimensionName,
        ),
        observeWithLLM: (...args) => this.observeWithLLM(...args),
        crossValidate: (gId, dimensionName, mechanicalValue, llmValue) =>
          this.crossValidate(gId, dimensionName, mechanicalValue, llmValue),
        logger: this.logger,
        hookManager: this.hookManager,
      })) {
        continue;
      }

      if (this.llmClient) {
        if (await runLlmObservationStage({
          goalId,
          goal,
          dimension: dim,
          method,
          workspacePath,
          dataSourceAvailable: !!dataSource,
          fetchWorkspaceContext,
          observeWithLLM: (...args) => this.observeWithLLM(...args),
          applyObservation: (gId, entry) => this.applyObservation(gId, entry),
          logger: this.logger,
          hookManager: this.hookManager,
        })) {
          continue;
        }
      } else if (observationDataSources.length > 0) {
        // DataSources exist but none match this dimension and no LLM client
        this.logger?.warn(
          `[ObservationEngine] Warning: dimension "${dim.name}" has no matching DataSource and no LLM client available for observation`
        );
      }

      await runSelfReportStage({
        goalId,
        dimension: dim,
        method,
        dataSourceAvailable: !!dataSource,
        applyObservation: (gId, entry) => this.applyObservation(gId, entry),
        logger: this.logger,
        hookManager: this.hookManager,
      });
    }
    } finally {
      for (const dataSource of observationDataSources) {
        dataSource.endObservationPass?.();
      }
    }
  }

  // ─── Data Source Observation ───

  /**
   * Observe a goal dimension by querying a registered data source.
   */
  async observeFromDataSource(
    goalId: string,
    dimensionName: string,
    sourceId: string,
    queryDimensionName?: string
  ): Promise<ObservationLogEntry> {
    return observeFromDataSourceFn(
      goalId,
      dimensionName,
      sourceId,
      this.dataSources,
      (gId, entry) => this.applyObservation(gId, entry),
      queryDimensionName
    );
  }

  // ─── DataSource Dimension Lookup ───

  /**
   * Find the first DataSource adapter that can serve the given dimension name.
   */
  private findDataSourceForDimension(dimensionName: string, goalId?: string, preferredSourceName?: string): IDataSourceAdapter | null {
    return findDataSourceForDimensionFn(this.dataSources, dimensionName, goalId, preferredSourceName);
  }

  // ─── LLM Observation ───

  /**
   * Observe a goal dimension using the LLM client.
   *
   * @param goalId             The goal being observed.
   * @param dimensionName      The dimension name (snake_case).
   * @param goalDescription    Human-readable goal description.
   * @param dimensionLabel     Human-readable dimension label.
   * @param thresholdDescription  JSON-stringified threshold for context.
   * @param workspaceContext   Optional pre-fetched workspace context.
   * @param previousScore      Previous observed score for trend context.
   * @param dryRun             If true, do not write to state.
   */
  async observeWithLLM(
    goalId: string,
    dimensionName: string,
    goalDescription: string,
    dimensionLabel: string,
    thresholdDescription: string,
    workspaceContext?: string,
    previousScore?: number | null,
    dryRun?: boolean,
    currentValue?: number | null,
    sourceAvailable?: boolean,
    workspacePath?: string
  ): Promise<ObservationLogEntry> {
    if (!this.llmClient) {
      throw new Error("observeWithLLM: llmClient is not configured");
    }
    return llmObserve(
      goalId,
      dimensionName,
      goalDescription,
      dimensionLabel,
      thresholdDescription,
      this.llmClient,
      this.options,
      (gId, entry) => this.applyObservation(gId, entry),
      workspaceContext,
      previousScore,
      dryRun,
      this.logger,
      undefined, // dimensionHistory
      undefined, // gateway
      currentValue,
      sourceAvailable,
      workspacePath,
      this.toolExecutor
    );
  }

  /**
   * Return the registered data source adapters.
   */
  getDataSources(): IDataSourceAdapter[] {
    return this.dataSources;
  }

  /**
   * Dynamically add a data source adapter at runtime.
   */
  addDataSource(adapter: IDataSourceAdapter): void {
    this.dataSources.push(adapter);
  }

  /**
   * Dynamically remove a data source adapter at runtime.
   * Returns true if the adapter was found and removed, false otherwise.
   */
  removeDataSource(sourceId: string): boolean {
    const index = this.dataSources.findIndex((ds) => ds.sourceId === sourceId);
    if (index === -1) {
      return false;
    }
    this.dataSources.splice(index, 1);
    return true;
  }

  /**
   * Return dimension info for all registered data sources that expose
   * getSupportedDimensions().
   */
  getAvailableDimensionInfo(): Array<{ name: string; dimensions: string[] }> {
    const result: Array<{ name: string; dimensions: string[] }> = [];
    for (const ds of this.dataSources) {
      if (typeof ds.getSupportedDimensions === "function") {
        result.push({ name: ds.config.name, dimensions: ds.getSupportedDimensions() });
      }
    }
    return result;
  }

  // ─── Knowledge Gap Detection ───

  /**
   * Detect whether a set of observation entries indicates a knowledge gap.
   */
  detectKnowledgeGap(
    entries: ObservationLogEntry[],
    dimensionName?: string
  ): KnowledgeGapSignal | null {
    return detectKnowledgeGap(entries, dimensionName);
  }

  // ─── Task-Scoped Observation ───

  /**
   * Collect domain-specific pre-execution context for a task.
   *
   * Delegates to the standalone `_observeForTask` function from
   * `observation-task.ts`. The `contextProvider` on this class returns
   * `Promise<string>` while `ObserveForTaskDeps` expects
   * `Promise<string | null>`, so we adapt inline (both are compatible at
   * runtime since `string` satisfies `string | null`).
   *
   * @param task    The agent task requiring pre-execution context.
   * @param domain  The task domain that governs the collection strategy.
   */
  async observeForTask(task: AgentTask, domain: TaskDomain): Promise<TaskObservationContext> {
    return _observeForTask(
      { contextProvider: this.contextProvider, logger: this.logger },
      task,
      domain
    );
  }

  // ─── Tool-Based Observation ───

  /**
   * Observe a dimension using the tool executor.
   * Thin wrapper around the standalone observeWithTools function.
   */
  async observeWithTools(
    dimension: Dimension,
    context: ToolCallContext,
  ): Promise<ToolObservationResult | null> {
    if (!this.toolExecutor) return null;
    return observeWithTools(this.toolExecutor, dimension, context);
  }

}

async function createGoalScopedArtifactDataSource(
  goalId: string,
  goal: Pick<Goal, "constraints" | "created_at" | "dimensions">,
  workspacePath?: string,
  stateManager?: StateManager,
): Promise<IDataSourceAdapter | null> {
  if (!workspacePath) return null;

  const dimensionMetrics: Record<string, string[]> = {};
  const dimensionAggregations: Record<string, "max" | "min"> = {};
  let supportedDimensionCount = 0;
  for (const dimension of goal.dimensions) {
    if (!isArtifactMetricDimension(dimension)) continue;
    const queryDimensionName = dimension.observation_mapping?.dimension ?? dimension.name;
    supportedDimensionCount += 1;
    if (needsPlainMetricMapping(queryDimensionName)) {
      dimensionMetrics[queryDimensionName] = [queryDimensionName];
      dimensionAggregations[queryDimensionName] = dimension.threshold.type === "max" ? "min" : "max";
    }
  }

  if (supportedDimensionCount === 0) return null;
  const freshnessScope = stateManager
    ? await resolveGoalArtifactFreshnessScope(goalId, goal, stateManager)
    : undefined;
  return createGoalWorkspaceArtifactMetricDataSource(
    goalId,
    workspacePath,
    dimensionMetrics,
    dimensionAggregations,
    freshnessScope,
  );
}

function isArtifactMetricDimension(dimension: Dimension): boolean {
  return dimension.threshold.type === "min" || dimension.threshold.type === "max" || dimension.threshold.type === "range";
}

function needsPlainMetricMapping(dimensionName: string): boolean {
  if (dimensionName === "validated_experiment_count" || dimensionName === "durable_artifact_count") return false;
  if (dimensionName.startsWith("best_")) return false;
  if (dimensionName.endsWith("_count")) return false;
  return true;
}

async function resolveGoalArtifactFreshnessScope(
  goalId: string,
  goal: Pick<Goal, "constraints" | "created_at">,
  stateManager: StateManager,
): Promise<ArtifactMetricFreshnessScope | undefined> {
  if (!isArtifactContractRequired({ goal })) return undefined;
  const latestTask = selectLatestTaskReference(await stateManager.listTasks(goalId).catch(() => []));
  if (latestTask) {
    return {
      freshAfterTime: latestTask.referenceTime,
      freshnessScope: "task",
      freshnessScopeId: latestTask.task.id,
    };
  }
  return {
    freshAfterTime: goal.created_at,
    freshnessScope: "goal",
    freshnessScopeId: goalId,
  };
}

function selectLatestTaskReference(tasks: readonly Task[]): { task: Task; referenceTime: string } | null {
  let latest: { task: Task; referenceTime: string; referenceMs: number } | null = null;
  for (const task of tasks) {
    const referenceTime = task.started_at ?? task.created_at;
    const referenceMs = Date.parse(referenceTime);
    if (!Number.isFinite(referenceMs)) continue;
    if (latest === null || referenceMs > latest.referenceMs) {
      latest = { task, referenceTime, referenceMs };
    }
  }
  return latest ? { task: latest.task, referenceTime: latest.referenceTime } : null;
}
