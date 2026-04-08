import type { VerificationResult } from "../../../base/types/task.js";
import type { GapVector } from "../../../base/types/gap.js";
import type { DriveContext } from "../../../base/types/drive.js";
import type { Dimension } from "../../../base/types/goal.js";
import type { TaskPipeline } from "../../../base/types/pipeline.js";
import type { AgentTask, IAdapter } from "../adapter-layer.js";
import { AdapterRegistry } from "../adapter-layer.js";
import type { TaskObservationContext } from "../../../platform/observation/observation-engine.js";
import type { TaskCycleResult } from "./task-execution-types.js";
import { createSkippedTaskResult } from "./task-execution-types.js";
import { PipelineExecutor } from "../pipeline-executor.js";
import { runPreExecutionChecks } from "./task-approval.js";
import { durationToMs } from "./task-executor.js";
import { generateReflection, saveReflectionAsKnowledge } from "../reflection-generator.js";
import type {
  PipelineCycleDeps,
  PipelineCycleOptions,
} from "./task-pipeline-types.js";

export type {
  PipelineCycleDeps,
  PipelineCycleOptions,
  SelectTargetDimensionFn,
  GenerateTaskFn,
} from "./task-pipeline-types.js";

// ─── runPipelineTaskCycle ───

/**
 * Run a pipeline-based task cycle: select → generate → observe → approve → pipeline execute → map verdict.
 *
 * Uses PipelineExecutor to orchestrate multi-role sequential execution.
 * Falls back to wrapping the provided adapter in a new AdapterRegistry if none is supplied.
 */
export async function runPipelineTaskCycle(
  deps: PipelineCycleDeps,
  goalId: string,
  gapVector: GapVector,
  driveContext: DriveContext,
  adapter: IAdapter,
  pipeline: TaskPipeline,
  options?: PipelineCycleOptions
): Promise<TaskCycleResult> {
  // 1. Select target dimension
  let goalDimensions: Dimension[] | undefined;
  try {
    const goal = await deps.stateManager.loadGoal(goalId);
    goalDimensions = goal?.dimensions ?? undefined;
  } catch {
    // Fall back to unweighted selection
  }
  const targetDimension = deps.selectTargetDimension(gapVector, driveContext, goalDimensions);

  // 2. Generate task
  const task = await deps.generateTask(
    goalId,
    targetDimension,
    pipeline.strategy_id,
    options?.knowledgeContext,
    adapter.adapterType,
    options?.existingTasks,
    options?.workspaceContext
  );
  if (task === null) {
    deps.logger?.warn("TaskLifecycle: task generation returned null (duplicate detected), skipping pipeline cycle");
    return createSkippedTaskResult(goalId, targetDimension);
  }

  // 3. Build AgentTask from Task (needed for observation and pipeline execution)
  const timeoutMs = task.estimated_duration ? durationToMs(task.estimated_duration) : 30 * 60 * 1000;
  const agentTask: AgentTask = {
    prompt: `${task.work_description}\n\nApproach: ${task.approach}\n\nSuccess Criteria:\n${task.success_criteria.map((c) => `- ${c.description}`).join("\n")}`,
    timeout_ms: timeoutMs,
    adapter_type: adapter.adapterType,
  };

  // 4. Optionally gather pre-execution observation context
  let observationContext: TaskObservationContext | undefined;
  if (options?.observationEngine && options?.domain) {
    try {
      observationContext = await options.observationEngine.observeForTask(agentTask, options.domain);
    } catch {
      // Non-fatal: proceed without observation context
    }
  }

  // 5. Pre-execution checks: ethics, capability, irreversible approval
  const preCheckResult = await runPreExecutionChecks(
    {
      ethicsGate: deps.ethicsGate,
      capabilityDetector: deps.capabilityDetector,
      approvalFn: deps.approvalFn,
      checkIrreversibleApproval: deps.checkIrreversibleApproval,
    },
    task
  );
  if (preCheckResult !== null) return preCheckResult;

  // 6. Build AdapterRegistry: prefer explicit registry, then deps-level, then wrap adapter
  const registry =
    options?.adapterRegistry ??
    deps.adapterRegistry ??
    (() => {
      const r = new AdapterRegistry();
      r.register(adapter);
      return r;
    })();

  // 7. Run pipeline via PipelineExecutor
  const pipelineExecutor = new PipelineExecutor({
    stateManager: deps.stateManager,
    adapterRegistry: registry,
    logger: deps.logger,
  });
  const pipelineResult = await pipelineExecutor.run(
    task.id,
    agentTask,
    pipeline,
    observationContext?.context
  );

  // 8. Map final_verdict to action
  const actionMap: Record<string, TaskCycleResult["action"]> = {
    pass: "completed",
    partial: "keep",
    fail: "discard",
  };
  const action: TaskCycleResult["action"] = actionMap[pipelineResult.final_verdict] ?? "discard";

  // 9. Build a synthetic VerificationResult from the pipeline outcome
  const avgConfidence =
    pipelineResult.stage_results.length > 0
      ? pipelineResult.stage_results.reduce((sum, s) => sum + s.confidence, 0) /
        pipelineResult.stage_results.length
      : 0;
  const verificationResult: VerificationResult = {
    task_id: task.id,
    verdict: pipelineResult.final_verdict,
    evidence: pipelineResult.stage_results.map((s) => ({
      layer: "self_report" as const,
      description: `Stage ${s.stage_index} (${s.role}): ${s.verdict}`,
      confidence: s.confidence,
    })),
    dimension_updates: [],
    confidence: avgConfidence,
    timestamp: new Date().toISOString(),
  };

  // 10. Save checkpoint on pipeline task completion
  const pipelineAdapterType = adapter?.adapterType ?? 'unknown';
  const pipelineContextSnapshot = [
    `goal: ${goalId}`,
    `dimension: ${targetDimension}`,
    `strategy: ${pipeline.strategy_id ?? 'none'}`,
    `action: ${action}`,
  ].join('\n');
  const pipelineIntermediateResults: string[] = pipelineResult.stage_results.map(
    s => `Stage ${s.stage_index} (${s.role}): ${s.verdict}`
  );
  await deps.sessionManager.saveCheckpoint({
    goalId,
    taskId: task.id,
    agentId: typeof pipelineAdapterType === 'string' ? pipelineAdapterType : 'unknown',
    sessionContextSnapshot: pipelineContextSnapshot,
    intermediateResults: pipelineIntermediateResults,
    metadata: { strategy_id: pipeline.strategy_id, final_verdict: pipelineResult.final_verdict },
  }).catch(e => deps.logger?.warn?.('checkpoint save failed', { error: String(e) }));

  // 11. Generate and save reflection (non-fatal)
  try {
    const reflection = await generateReflection({
      task,
      verificationResult,
      goalId,
      strategyId: pipeline.strategy_id ?? undefined,
      llmClient: deps.llmClient,
      logger: deps.logger,
    });
    if (deps.knowledgeManager) {
      await saveReflectionAsKnowledge(
        deps.knowledgeManager, goalId, reflection,
        task.work_description,
      );
    }
  } catch (e) {
    deps.logger?.warn?.("Reflection generation failed (non-fatal)", { error: String(e) });
  }

  return { task, verificationResult, action };
}
