import type { ObservationLogEntry } from "../../../base/types/state.js";
import type { ObservationMethod } from "../../../base/types/core.js";
import type { Goal } from "../../../base/types/goal.js";
import type { Dimension } from "../../../orchestrator/goal/types/goal.js";
import type { HookManager } from "../../../runtime/hook-manager.js";
import type { Logger } from "../../../runtime/logger.js";
import { createObservationEntry } from "../observation-helpers.js";
import { ObservationPersistenceError } from "../observation-llm.js";
import type { WorkspaceContextFetcher } from "./observe-context.js";

type ApplyObservation = (goalId: string, entry: ObservationLogEntry) => Promise<void>;
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

interface ObserveLlmStageParams {
  goalId: string;
  goal: Goal;
  dimension: Dimension;
  method: ObservationMethod;
  workspacePath?: string;
  dataSourceAvailable: boolean;
  fetchWorkspaceContext: WorkspaceContextFetcher;
  observeWithLLM: ObserveWithLLM;
  applyObservation: ApplyObservation;
  logger?: Logger;
  hookManager?: HookManager;
}

export async function runLlmObservationStage({
  goalId,
  goal,
  dimension,
  method,
  workspacePath,
  dataSourceAvailable,
  fetchWorkspaceContext,
  observeWithLLM,
  applyObservation,
  logger,
  hookManager,
}: ObserveLlmStageParams): Promise<boolean> {
  const workspaceContext = await fetchWorkspaceContext(goalId, dimension.name);

  try {
    await observeWithLLM(
      goalId,
      dimension.name,
      goal.description,
      dimension.label ?? dimension.name,
      JSON.stringify(dimension.threshold),
      workspaceContext,
      getPreviousScore(dimension),
      undefined,
      typeof dimension.current_value === "number" ? dimension.current_value : null,
      dataSourceAvailable,
      workspacePath,
    );
    void hookManager?.emit("PostObserve", {
      goal_id: goalId,
      dimension: dimension.name,
      data: { value: null, confidence: null },
    });
    return true;
  } catch (err) {
    logger?.warn(
      `[ObservationEngine] LLM observation failed for dimension "${dimension.name}": ${err instanceof Error ? err.message : String(err)}. Falling back to self_report.`
    );

    if (err instanceof ObservationPersistenceError) {
      const recoveredValue = err.entry.extracted_value;
      logger?.warn(
        `[ObservationEngine] Recovering LLM-observed value=${recoveredValue} for dimension "${dimension.name}" via self_report fallback.`
      );
      const recoveryEntry = createObservationEntry({
        goalId,
        dimensionName: dimension.name,
        layer: "self_report",
        method,
        trigger: "periodic",
        rawResult: recoveredValue,
        extractedValue:
          typeof recoveredValue === "number" ||
          typeof recoveredValue === "string" ||
          typeof recoveredValue === "boolean" ||
          recoveredValue === null
            ? (recoveredValue as number | string | boolean | null)
            : null,
        confidence: err.entry.confidence,
      });
      await applyObservation(goalId, recoveryEntry);
      void hookManager?.emit("PostObserve", {
        goal_id: goalId,
        dimension: dimension.name,
        data: { value: recoveryEntry.extracted_value, confidence: recoveryEntry.confidence },
      });
      return true;
    }
  }

  return false;
}

function getPreviousScore(dimension: Dimension): number | null {
  if (!Array.isArray(dimension.history) || dimension.history.length === 0) {
    return null;
  }

  const lastObsEntry = dimension.history[dimension.history.length - 1];
  if (!lastObsEntry || typeof lastObsEntry.value !== "number") {
    return null;
  }

  const rawVal = lastObsEntry.value;
  try {
    const threshold = JSON.parse(JSON.stringify(dimension.threshold));
    if (
      threshold.type === "min" &&
      typeof threshold.value === "number" &&
      threshold.value > 1
    ) {
      return Math.min(1, Math.max(0, rawVal / threshold.value));
    }
    if (
      threshold.type === "max" &&
      typeof threshold.value === "number" &&
      threshold.value > 1
    ) {
      return Math.min(1, Math.max(0, 2 - rawVal / threshold.value));
    }
    if (
      threshold.type === "range" &&
      typeof threshold.low === "number" &&
      typeof threshold.high === "number" &&
      threshold.high > threshold.low
    ) {
      const span = threshold.high - threshold.low;
      return Math.min(1, Math.max(0, (rawVal - threshold.low) / span));
    }
  } catch {
    return Math.min(1, Math.max(0, rawVal));
  }

  return Math.min(1, Math.max(0, rawVal));
}
