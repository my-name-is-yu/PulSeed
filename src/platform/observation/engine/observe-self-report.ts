import type { ObservationLogEntry } from "../../../base/types/state.js";
import type { ObservationMethod } from "../../../base/types/core.js";
import type { Dimension } from "../../../orchestrator/goal/types/goal.js";
import type { HookManager } from "../../../runtime/hook-manager.js";
import type { Logger } from "../../../runtime/logger.js";
import { createObservationEntry } from "../observation-helpers.js";

type ApplyObservation = (goalId: string, entry: ObservationLogEntry) => Promise<void>;

interface ObserveSelfReportParams {
  goalId: string;
  dimension: Dimension;
  method: ObservationMethod;
  dataSourceAvailable: boolean;
  applyObservation: ApplyObservation;
  logger?: Logger;
  hookManager?: HookManager;
}

export async function runSelfReportStage({
  goalId,
  dimension,
  method,
  dataSourceAvailable,
  applyObservation,
  logger,
  hookManager,
}: ObserveSelfReportParams): Promise<void> {
  const entry = createObservationEntry({
    goalId,
    dimensionName: dimension.name,
    layer: "self_report",
    method,
    trigger: "periodic",
    rawResult: dimension.current_value,
    extractedValue:
      typeof dimension.current_value === "number" ||
      typeof dimension.current_value === "string" ||
      typeof dimension.current_value === "boolean" ||
      dimension.current_value === null
        ? (dimension.current_value as number | string | boolean | null)
        : null,
    confidence: dataSourceAvailable ? dimension.confidence : Math.min(dimension.confidence, 0.30),
  });

  await applyObservation(goalId, entry);
  logger?.info(`[observe] ${dimension.name}=${entry.extracted_value} (confidence=${entry.confidence})`);
  void hookManager?.emit("PostObserve", {
    goal_id: goalId,
    dimension: dimension.name,
    data: { value: entry.extracted_value, confidence: entry.confidence },
  });
}
