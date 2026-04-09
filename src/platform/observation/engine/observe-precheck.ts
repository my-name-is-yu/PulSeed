import type { ObservationLogEntry } from "../../../base/types/state.js";
import type { ObservationLayer, ObservationMethod } from "../../../base/types/core.js";
import type { Dimension } from "../../../orchestrator/goal/types/goal.js";
import type { IDimensionPreChecker } from "../dimension-pre-checker.js";
import type { HookManager } from "../../../runtime/hook-manager.js";
import type { Logger } from "../../../runtime/logger.js";
import { createObservationEntry } from "../observation-helpers.js";

type ApplyObservation = (goalId: string, entry: ObservationLogEntry) => Promise<void>;

interface ObservePreCheckParams {
  goalId: string;
  dimension: Dimension;
  method: ObservationMethod;
  workspacePath?: string;
  enabled: boolean;
  preChecker?: IDimensionPreChecker;
  applyObservation: ApplyObservation;
  logger?: Logger;
  hookManager?: HookManager;
}

export async function runPreCheckStage({
  goalId,
  dimension,
  method,
  workspacePath,
  enabled,
  preChecker,
  applyObservation,
  logger,
  hookManager,
}: ObservePreCheckParams): Promise<boolean> {
  if (!preChecker || !enabled) return false;

  const lastObs = Array.isArray(dimension.history) && dimension.history.length > 0
    ? (() => {
        const historyEntry = dimension.history[dimension.history.length - 1]!;
        return {
          observation_id: historyEntry.source_observation_id,
          goal_id: goalId,
          dimension_name: dimension.name,
          layer: (dimension.last_observed_layer ?? "self_report") as ObservationLayer,
          method,
          trigger: "periodic" as const,
          raw_result: historyEntry.value,
          extracted_value: historyEntry.value as number | string | boolean | null,
          confidence: historyEntry.confidence,
          timestamp: historyEntry.timestamp,
          notes: null,
        } satisfies ObservationLogEntry;
      })()
    : null;

  try {
    const preCheck = await preChecker.check(dimension, lastObs, { workspace_path: workspacePath });
    if (!preCheck.changed && lastObs !== null) {
      const cachedEntry = createObservationEntry({
        goalId,
        dimensionName: dimension.name,
        layer: lastObs.layer ?? "self_report",
        method,
        trigger: "periodic",
        rawResult: `cached: ${String(lastObs.extracted_value)}`,
        extractedValue: lastObs.extracted_value,
        confidence: Math.max(0.10, lastObs.confidence * 0.95),
      });
      await applyObservation(goalId, cachedEntry);
      logger?.debug(
        `[ObservationEngine] Pre-check: skipping LLM for dimension "${dimension.name}" (no change detected, confidence decayed to ${cachedEntry.confidence.toFixed(3)})`
      );
      void hookManager?.emit("PostObserve", {
        goal_id: goalId,
        dimension: dimension.name,
        data: { value: cachedEntry.extracted_value, confidence: cachedEntry.confidence },
      });
      return true;
    }
  } catch (err) {
    logger?.warn(
      `[ObservationEngine] Pre-check failed for dimension "${dimension.name}": ${err instanceof Error ? err.message : String(err)}. Proceeding with normal observation.`
    );
  }

  return false;
}
