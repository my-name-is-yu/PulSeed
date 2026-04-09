import type { ObservationMethod } from "../../../base/types/core.js";
import type { Goal } from "../../../base/types/goal.js";
import type { StateManager } from "../../../base/state/state-manager.js";
import type { Dimension } from "../../../orchestrator/goal/types/goal.js";
import type { HookManager } from "../../../runtime/hook-manager.js";
import type { Logger } from "../../../runtime/logger.js";
import type { IDataSourceAdapter } from "../data-source-adapter.js";
import type { ObservationLogEntry } from "../../../base/types/state.js";
import type { WorkspaceContextFetcher } from "./observe-context.js";
import type { CrossValidationResult } from "../observation-helpers.js";

type ObserveFromDataSource = (goalId: string, dimensionName: string, sourceId: string) => Promise<ObservationLogEntry>;
type ObserveWithLLM = (
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
  workspacePath?: string,
) => Promise<ObservationLogEntry>;
type CrossValidate = (
  goalId: string,
  dimensionName: string,
  mechanicalValue: number,
  llmValue: number,
) => CrossValidationResult;

interface ObserveDataSourceStageParams {
  goalId: string;
  goal: Goal;
  dimension: Dimension;
  method: ObservationMethod;
  dataSource: IDataSourceAdapter;
  workspacePath?: string;
  crossValidationEnabled: boolean;
  llmAvailable: boolean;
  stateManager: StateManager;
  fetchWorkspaceContext: WorkspaceContextFetcher;
  observeFromDataSource: ObserveFromDataSource;
  observeWithLLM: ObserveWithLLM;
  crossValidate: CrossValidate;
  logger?: Logger;
  hookManager?: HookManager;
}

export async function runDataSourceObservationStage({
  goalId,
  goal,
  dimension,
  dataSource,
  workspacePath,
  crossValidationEnabled,
  llmAvailable,
  stateManager,
  fetchWorkspaceContext,
  observeFromDataSource,
  observeWithLLM,
  crossValidate,
  logger,
  hookManager,
}: ObserveDataSourceStageParams): Promise<boolean> {
  try {
    await observeFromDataSource(goalId, dimension.name, dataSource.sourceId);

    if (crossValidationEnabled && llmAvailable) {
      await runCrossValidation({
        goalId,
        goal,
        dimension,
        workspacePath,
        stateManager,
        fetchWorkspaceContext,
        observeWithLLM,
        crossValidate,
        logger,
      });
    }

    void hookManager?.emit("PostObserve", {
      goal_id: goalId,
      dimension: dimension.name,
      data: { value: null, confidence: null },
    });
    return true;
  } catch (err) {
    logger?.warn(
      `[ObservationEngine] DataSource observation failed for dimension "${dimension.name}" (source: ${dataSource.sourceId}): ${err instanceof Error ? err.message : String(err)}. Falling through to LLM fallback.`
    );
    return false;
  }
}

interface CrossValidationParams {
  goalId: string;
  goal: Goal;
  dimension: Dimension;
  workspacePath?: string;
  stateManager: StateManager;
  fetchWorkspaceContext: WorkspaceContextFetcher;
  observeWithLLM: ObserveWithLLM;
  crossValidate: CrossValidate;
  logger?: Logger;
}

async function runCrossValidation({
  goalId,
  goal,
  dimension,
  workspacePath,
  stateManager,
  fetchWorkspaceContext,
  observeWithLLM,
  crossValidate,
  logger,
}: CrossValidationParams): Promise<void> {
  try {
    const updatedGoal = await stateManager.loadGoal(goalId);
    const dimState = updatedGoal?.dimensions.find((candidate) => candidate.name === dimension.name);
    const mechanicalValue = typeof dimState?.current_value === "number" ? dimState.current_value : 0;

    const workspaceContext = await fetchWorkspaceContext(goalId, dimension.name);
    const llmEntry = await observeWithLLM(
      goalId,
      dimension.name,
      goal.description,
      dimension.label ?? dimension.name,
      JSON.stringify(dimension.threshold),
      workspaceContext,
      null,
      true,
      undefined,
      undefined,
      workspacePath,
    );
    const llmValue = typeof llmEntry.extracted_value === "number" ? llmEntry.extracted_value : 0;
    const result = crossValidate(goalId, dimension.name, mechanicalValue, llmValue);

    if (result.diverged && result.confidencePenalty > 0) {
      await applyConfidencePenalty(stateManager, goalId, dimension.name, result, logger);
    }
  } catch (err) {
    logger?.warn(`[CrossValidation] LLM comparison failed for "${dimension.name}": ${err}`);
  }
}

async function applyConfidencePenalty(
  stateManager: StateManager,
  goalId: string,
  dimensionName: string,
  result: CrossValidationResult,
  logger?: Logger,
): Promise<void> {
  const currentGoal = await stateManager.loadGoal(goalId);
  if (!currentGoal) return;

  const dimIdx = currentGoal.dimensions.findIndex((dimension) => dimension.name === dimensionName);
  if (dimIdx === -1) return;

  const currentDim = currentGoal.dimensions[dimIdx]!;
  const penalizedConfidence = Math.max(0.10, (currentDim.confidence ?? 0.5) - result.confidencePenalty);
  const updatedDims = [...currentGoal.dimensions];
  updatedDims[dimIdx] = { ...currentDim, confidence: penalizedConfidence };
  await stateManager.saveGoal({
    ...currentGoal,
    dimensions: updatedDims,
    updated_at: new Date().toISOString(),
  });
  logger?.warn(
    `[CrossValidation] Confidence penalized for "${dimensionName}": ` +
    `${(currentDim.confidence ?? 0.5).toFixed(3)} → ${penalizedConfidence.toFixed(3)} ` +
    `(penalty=${result.confidencePenalty.toFixed(3)}, LLM hallucination detected)`
  );
}
