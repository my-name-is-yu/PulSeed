import type { ObservationLogEntry } from "../../../base/types/state.js";
import type { ObservationMethod } from "../../../base/types/core.js";
import type { Dimension } from "../../../orchestrator/goal/types/goal.js";
import type { HookManager } from "../../../runtime/hook-manager.js";
import type { Logger } from "../../../runtime/logger.js";
import type { ToolObservationResult } from "../observation-tools.js";
import { createObservationEntry } from "../observation-helpers.js";
import type { ToolCallContext } from "../../../tools/types.js";

type ApplyObservation = (goalId: string, entry: ObservationLogEntry) => Promise<void>;
type ObserveWithTools = (dimension: Dimension, context: ToolCallContext) => Promise<ToolObservationResult | null>;

interface ObserveToolStageParams {
  goalId: string;
  dimension: Dimension;
  method: ObservationMethod;
  applyObservation: ApplyObservation;
  observeWithTools: ObserveWithTools;
  logger?: Logger;
  hookManager?: HookManager;
}

const TOOL_OBSERVATION_TYPES = new Set([
  "file_check",
  "mechanical",
  "api_query",
  "git_diff",
  "grep_check",
  "test_run",
]);

export async function runToolObservationStage({
  goalId,
  dimension,
  method,
  applyObservation,
  observeWithTools,
  logger,
  hookManager,
}: ObserveToolStageParams): Promise<boolean> {
  const methodType = dimension.observation_method?.type;
  if (!methodType || !TOOL_OBSERVATION_TYPES.has(methodType)) return false;

  try {
    const toolContext: ToolCallContext = {
      cwd: process.cwd(),
      goalId,
      trustBalance: 0,
      preApproved: false,
      approvalFn: async () => false,
    };
    const toolResult = await observeWithTools(dimension, toolContext);
    if (toolResult !== null && toolResult.parsedValue !== null && toolResult.parsedValue !== undefined) {
      const toolEntry = createObservationEntry({
        goalId,
        dimensionName: dimension.name,
        layer: "mechanical",
        method: { ...method, source: toolResult.toolName },
        trigger: "periodic",
        rawResult: toolResult.rawData,
        extractedValue: toolResult.parsedValue,
        confidence: toolResult.confidence,
      });
      await applyObservation(goalId, toolEntry);
      logger?.debug(`[ObservationEngine] Tool observation succeeded for ${dimension.name}: confidence=${toolResult.confidence}`);
      void hookManager?.emit("PostObserve", {
        goal_id: goalId,
        dimension: dimension.name,
        data: { value: toolEntry.extracted_value, confidence: toolEntry.confidence },
      });
      return true;
    }
  } catch (err) {
    logger?.warn(
      `[ObservationEngine] Tool observation failed for ${dimension.name}, falling through: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  return false;
}
