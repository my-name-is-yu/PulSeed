import { VerificationResultSchema, type Task, type VerificationResult } from "../../../base/types/task.js";
import type { GapVector } from "../../../base/types/gap.js";
import type { DriveContext } from "../../../base/types/drive.js";
import type { Dimension } from "../../../base/types/goal.js";
import type { IAdapter, AgentResult } from "../adapter-layer.js";
import type { StateManager } from "../../../base/state/state-manager.js";
import type { Logger } from "../../../runtime/logger.js";
import type { HookManager } from "../../../runtime/hook-manager.js";
import type { ToolExecutor } from "../../../tools/executor.js";
import type { DimensionSelectionOptions } from "../context/dimension-selector.js";
import type { TaskCycleResult, TaskLearningPriorApplication } from "./task-execution-types.js";
import type { EthicsGate } from "../../../platform/traits/ethics-gate.js";
import type { CapabilityDetector } from "../../../platform/observation/capability-detector.js";
import type { KnowledgeTransfer } from "../../../platform/knowledge/transfer/knowledge-transfer.js";
import type { KnowledgeManager } from "../../../platform/knowledge/knowledge-manager.js";
import type { VerifierDeps, VerdictResult, VerdictHandlingContext } from "./task-verifier-types.js";
import type { TaskPreExecutionPolicyRecorder } from "./task-pre-execution-policy-trace.js";
import { _verifyTask as verifyTaskWithDeps } from "./task-verifier-internal.js";
import { buildEnrichedKnowledgeContext } from "./task-context-enricher.js";
import { runPreExecutionChecks } from "./task-approval.js";
import { finalizeSuccessfulExecution } from "./task-post-execution.js";
import { persistTaskCycleSideEffects } from "./task-side-effects.js";
import { reloadTaskFromDisk, verifyExecutionWithGitDiff } from "./task-execution-helpers-internal.js";
import { appendTaskOutcomeEvent, setTaskOutcomeTokens } from "./task-outcome-ledger.js";
import { createSkippedTaskResult } from "./task-execution-types.js";
import type { ExecutionModeState } from "../../../platform/time/execution-mode.js";
import type { LearningPriorPhaseProjection } from "../../../runtime/learning/index.js";
import { applyVerdictHandlingContextGuards } from "./task-verifier.js";

export interface TaskGenerationResult {
  task: Task | null;
  tokensUsed: number;
  playbookIdsUsed: string[];
  refusalReason?: string;
}

export interface TaskCycleRunOptionsShape {
  targetDimensionOverride?: string;
  knowledgeContextPrefix?: string;
  learningProjection?: Extract<LearningPriorPhaseProjection, { phase: "task_generation" }>;
  learningPriorConsumptionRef?: string;
  executionMode?: ExecutionModeState;
  runControlRecommendationContext?: string;
  abortSignal?: AbortSignal;
}

export interface TaskLifecycleTaskCycleContext {
  goalId: string;
  gapVector: GapVector;
  driveContext: DriveContext;
  adapter: IAdapter;
  knowledgeContext?: string;
  existingTasks?: string[];
  workspaceContext?: string;
  options?: TaskCycleRunOptionsShape;
  stateManager: StateManager;
  logger?: Logger;
  hookManager?: HookManager;
  toolExecutor?: ToolExecutor;
  healthCheckEnabled: boolean;
  healthCheckCwd?: string;
  runPostExecutionHealthCheck: () => Promise<{ healthy: boolean; output: string }>;
  verificationDeps: (preferredAdapterType?: string) => VerifierDeps;
  sideEffectDeps: () => {
    stateManager: StateManager;
    sessionManager: VerifierDeps["sessionManager"];
    llmClient: VerifierDeps["llmClient"];
    knowledgeManager?: KnowledgeManager;
    logger?: Logger;
  };
  buildDimensionSelectionBackoff: (goalId: string) => Promise<DimensionSelectionOptions>;
  selectTargetDimension: (
    gapVector: GapVector,
    driveContext: DriveContext,
    dimensions?: Dimension[],
    options?: DimensionSelectionOptions
  ) => string;
  generateTaskWithTokens: (
    goalId: string,
    targetDimension: string,
    strategyId?: string,
    knowledgeContext?: string,
    adapterType?: string,
    existingTasks?: string[],
    workspaceContext?: string,
    executionMode?: ExecutionModeState
  ) => Promise<TaskGenerationResult>;
  enrichmentDeps: () => {
    knowledgeTransfer?: KnowledgeTransfer;
    knowledgeManager?: KnowledgeManager;
    logger?: Logger;
  };
  checkIrreversibleApproval: (task: Task) => Promise<boolean>;
  preExecution: {
    ethicsGate?: EthicsGate;
    capabilityDetector?: CapabilityDetector;
    approvalFn: (task: Task) => Promise<boolean>;
    recordPolicyDecision: TaskPreExecutionPolicyRecorder;
  };
  hasNativeAgentLoop: boolean;
  executeTask: (task: Task, adapter: IAdapter, workspaceContext?: string) => Promise<AgentResult>;
  executeTaskWithAgentLoop: (
    task: Task,
    workspaceContext?: string,
    knowledgeContext?: string,
    abortSignal?: AbortSignal,
  ) => Promise<AgentResult>;
  handleVerdict: (task: Task, verificationResult: VerificationResult, context?: VerdictHandlingContext) => Promise<VerdictResult>;
}

function buildVerdictHandlingContext(executionResult: AgentResult): VerdictHandlingContext {
  const context: VerdictHandlingContext = {
    stoppedReason: executionResult.success ? null : executionResult.stopped_reason,
  };
  if (executionResult.agentLoop) {
    context.agentLoopWorkspace = {
      requestedCwd: executionResult.agentLoop.requestedCwd,
      executionCwd: executionResult.agentLoop.executionCwd,
      isolatedWorkspace: executionResult.agentLoop.isolatedWorkspace,
      workspaceCleanupStatus: executionResult.agentLoop.workspaceCleanupStatus,
      workspaceCleanupReason: executionResult.agentLoop.workspaceCleanupReason,
      workspaceDirty: executionResult.agentLoop.workspaceDirty,
      workspaceDisposition: executionResult.agentLoop.workspaceDisposition,
    };
  }
  return context;
}

function buildDaemonShutdownDeferredVerification(task: Task): VerificationResult {
  return VerificationResultSchema.parse({
    task_id: task.id,
    verdict: "partial",
    confidence: 1,
    evidence: [{
      layer: "mechanical",
      description: "Task execution was interrupted by daemon shutdown and deferred for recovery before terminal verification.",
      confidence: 1,
    }],
    dimension_updates: [],
    timestamp: new Date().toISOString(),
  });
}

export async function runTaskLifecycleCycle(context: TaskLifecycleTaskCycleContext): Promise<TaskCycleResult> {
  const {
    goalId,
    gapVector,
    driveContext,
    adapter,
    knowledgeContext,
    existingTasks,
    workspaceContext,
    options,
    stateManager,
    logger,
    hookManager,
  } = context;

  const runPhase = async <T>(phase: string, fn: () => Promise<T>): Promise<T> => {
    const phaseStart = Date.now();
    logger?.info("TaskLifecycle: phase started", { goalId, phase });
    try {
      const value = await fn();
      logger?.info("TaskLifecycle: phase completed", {
        goalId,
        phase,
        duration_ms: Date.now() - phaseStart,
      });
      return value;
    } catch (err) {
      logger?.warn("TaskLifecycle: phase failed", {
        goalId,
        phase,
        duration_ms: Date.now() - phaseStart,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  };

  let goalDimensions: Dimension[] | undefined;
  try {
    const goal = await stateManager.loadGoal(goalId);
    goalDimensions = goal?.dimensions ?? undefined;
  } catch (err) {
    logger?.warn(`[TaskLifecycle] Failed to load goal "${goalId}" for dimension selection, using unweighted fallback: ${err instanceof Error ? err.message : String(err)}`);
  }

  const dimensionSelectionOptions = await context.buildDimensionSelectionBackoff(goalId);
  const learningProjection = options?.learningProjection;
  const projectedTargetDimension = learningProjection?.preferredTargetDimension;
  const projectedTargetDimensionIsCurrent = !!projectedTargetDimension
    && !!goalDimensions?.some((dimension) => dimension.name === projectedTargetDimension);
  const targetDimension = projectedTargetDimensionIsCurrent
    ? projectedTargetDimension
    : options?.targetDimensionOverride
      ?? await runPhase("select-target-dimension", async () =>
        context.selectTargetDimension(gapVector, driveContext, goalDimensions, dimensionSelectionOptions)
      );

  if (projectedTargetDimension && !projectedTargetDimensionIsCurrent) {
    logger?.warn("TaskLifecycle: ignored stale learning-prior target dimension projection", {
      goalId,
      projectedTargetDimension,
      consumptionRecordId: learningProjection?.consumptionRecordId,
    });
  }

  if (projectedTargetDimensionIsCurrent) {
    logger?.info("TaskLifecycle: using learning-prior target dimension projection", {
      goalId,
      targetDimension,
      consumptionRecordId: learningProjection?.consumptionRecordId,
    });
  } else if (options?.targetDimensionOverride) {
    logger?.info("TaskLifecycle: using target dimension override", { goalId, targetDimension });
  }

  const buildLearningPriorApplication = (generatedTask: Task): TaskLearningPriorApplication | undefined => {
    if (!learningProjection) return undefined;
    if (projectedTargetDimension) {
      if (!projectedTargetDimensionIsCurrent) {
        return {
          consumptionRecordId: learningProjection.consumptionRecordId,
          status: "suppressed",
          reason: "preferred_target_dimension_stale",
        };
      }
      const taskTargetsProjectedDimension = generatedTask.primary_dimension === projectedTargetDimension
        || generatedTask.target_dimensions.includes(projectedTargetDimension);
      if (taskTargetsProjectedDimension) {
        return {
          consumptionRecordId: learningProjection.consumptionRecordId,
          status: "applied",
          reason: "preferred_target_dimension_applied",
          generatedDecisionRefs: [`task:${generatedTask.id}`],
        };
      }
      return {
        consumptionRecordId: learningProjection.consumptionRecordId,
        status: "suppressed",
        reason: "generated_task_projection_mismatch",
      };
    }
    if (learningProjection.requiredExperimentPlanIds.length > 0) return undefined;
    return {
      consumptionRecordId: learningProjection.consumptionRecordId,
      status: "suppressed",
      reason: "unsupported_projection",
    };
  };

  const buildSkippedLearningPriorApplication = (): TaskLearningPriorApplication | undefined => {
    if (!learningProjection) return undefined;
    if (projectedTargetDimension && !projectedTargetDimensionIsCurrent) {
      return {
        consumptionRecordId: learningProjection.consumptionRecordId,
        status: "suppressed",
        reason: "preferred_target_dimension_stale",
      };
    }
    if (learningProjection.requiredExperimentPlanIds.length > 0) return undefined;
    return {
      consumptionRecordId: learningProjection.consumptionRecordId,
      status: "suppressed",
      reason: "task_generation_skipped",
    };
  };

  const baseKnowledgeContext = [
    options?.knowledgeContextPrefix,
    options?.runControlRecommendationContext,
    knowledgeContext,
  ].filter(Boolean).join("\n\n") || undefined;

  const enrichedKnowledgeContext = await runPhase("enrich-knowledge-context", () =>
    buildEnrichedKnowledgeContext({
      goalId,
      knowledgeContext: baseKnowledgeContext,
      stateManager: context.stateManager,
      ...context.enrichmentDeps(),
    })
  );

  void hookManager?.emit("PreTaskCreate", { goal_id: goalId, data: { task_type: targetDimension } });
  const genResult = await runPhase("generate-task", () =>
    context.generateTaskWithTokens(
      goalId,
      targetDimension,
      undefined,
      enrichedKnowledgeContext,
      adapter.adapterType,
      existingTasks,
      workspaceContext,
      options?.executionMode
    )
  );

  let taskCycleTokens = genResult.tokensUsed;
  const playbookIdsUsed = genResult.playbookIdsUsed;
  const task = genResult.task;
  if (task === null) {
    logger?.warn(
      genResult.refusalReason
        ? `TaskLifecycle: task generation refused (${genResult.refusalReason}), skipping cycle`
        : "TaskLifecycle: task generation returned null (duplicate detected), skipping cycle"
    );
    return createSkippedTaskResult(
      goalId,
      targetDimension,
      taskCycleTokens,
      buildSkippedLearningPriorApplication()
    );
  }
  const learningPriorApplication = buildLearningPriorApplication(task);

  void hookManager?.emit("PostTaskCreate", { goal_id: goalId, data: { task_id: task.id } });
  logger?.info(`[task] created: ${task.work_description?.substring(0, 120)}`, { taskId: task.id });

  const preCheckResult = await runPhase("pre-execution-checks", () =>
    runPreExecutionChecks(
      {
        ethicsGate: context.preExecution.ethicsGate,
        capabilityDetector: context.preExecution.capabilityDetector,
        approvalFn: context.preExecution.approvalFn,
        checkIrreversibleApproval: (t) => context.checkIrreversibleApproval(t),
        recordPolicyDecision: context.preExecution.recordPolicyDecision,
      },
      task
    )
  );
  if (preCheckResult !== null) {
    await appendTaskOutcomeEvent(stateManager, {
      task,
      type: "abandoned",
      attempt: task.consecutive_failure_count + 1,
      action: preCheckResult.action,
      verificationResult: preCheckResult.verificationResult,
      reason: preCheckResult.verificationResult.evidence[0]?.description,
    });
    await setTaskOutcomeTokens(stateManager, task, taskCycleTokens);
    return {
      ...preCheckResult,
      tokensUsed: taskCycleTokens,
      ...(learningPriorApplication ? { learningPriorApplication } : {}),
    };
  }

  await appendTaskOutcomeEvent(stateManager, {
    task,
    type: "acked",
    attempt: task.consecutive_failure_count + 1,
  });

  const verifierDeps = context.verificationDeps(adapter.adapterType);
  if (!context.hasNativeAgentLoop && verifierDeps.adapterRegistry && !verifierDeps.adapterRegistry.isAvailable(adapter.adapterType)) {
    const reason = `Adapter circuit breaker is open for "${adapter.adapterType}"`;
    const now = new Date().toISOString();
    const blockedTask = {
      ...task,
      status: "error" as const,
      completed_at: now,
      execution_output: reason,
    };
    await stateManager.saveTask(blockedTask);
    await appendTaskOutcomeEvent(stateManager, {
      task: blockedTask,
      type: "failed",
      attempt: task.consecutive_failure_count + 1,
      reason,
    });
    await setTaskOutcomeTokens(stateManager, blockedTask, taskCycleTokens);
    logger?.warn(`[task] skipped: ${reason}`, { taskId: task.id });

    return {
      task: blockedTask,
      verificationResult: VerificationResultSchema.parse({
        task_id: task.id,
        verdict: "fail",
        confidence: 1,
        evidence: [{ layer: "mechanical", description: reason, confidence: 1 }],
        dimension_updates: [],
        timestamp: now,
      }),
      action: "discard",
      tokensUsed: taskCycleTokens,
      ...(learningPriorApplication ? { learningPriorApplication } : {}),
    };
  }

  logger?.debug(`[DEBUG-TL] Executing task ${task.id} via adapter ${adapter.adapterType}`);
  void hookManager?.emit("PreExecute", { goal_id: goalId, data: { task_id: task.id } });
  const executionResult = await runPhase("execute-task", () =>
    context.hasNativeAgentLoop
      ? context.executeTaskWithAgentLoop(task, workspaceContext, enrichedKnowledgeContext, options?.abortSignal)
      : context.executeTask(task, adapter, workspaceContext)
  );
  const nativeExecutionTokens = executionResult.agentLoop?.usage?.totalTokens;
  if (typeof nativeExecutionTokens === "number" && Number.isFinite(nativeExecutionTokens)) {
    taskCycleTokens += nativeExecutionTokens;
  }
  void hookManager?.emit("PostExecute", { goal_id: goalId, data: { task_id: task.id, success: executionResult.success } });
  logger?.info(`[task] executed: ${executionResult.success ? "success" : "failed"}`, { taskId: task.id });
  logger?.debug(`[DEBUG-TL] Execution result: success=${executionResult.success}, stopped=${executionResult.stopped_reason}, error=${executionResult.error}, output=${executionResult.output?.substring(0, 200)}`);

  if (executionResult.interruptedByDaemonShutdown === true) {
    const interruptedTask = await reloadTaskFromDisk(stateManager, task);
    const deferredVerification = buildDaemonShutdownDeferredVerification(interruptedTask);
    await setTaskOutcomeTokens(stateManager, interruptedTask, taskCycleTokens);
    logger?.info("TaskLifecycle: deferred post-execution verification for daemon shutdown recovery", {
      goalId,
      taskId: interruptedTask.id,
      stoppedReason: executionResult.stopped_reason,
    });
    return {
      task: interruptedTask,
      verificationResult: deferredVerification,
      action: "keep",
      diffEvidenceSource: executionResult.diffEvidenceSource,
      tokensUsed: taskCycleTokens,
      ...(learningPriorApplication ? { learningPriorApplication } : {}),
    };
  }

  await finalizeSuccessfulExecution({
    executionResult,
    goalId,
    logger,
    healthCheck: {
      enabled: context.healthCheckEnabled,
      run: context.runPostExecutionHealthCheck,
    },
    successVerification: {
      toolExecutor: context.toolExecutor,
      verifyWithGitDiff: verifyExecutionWithGitDiff,
    },
  });

  const taskForVerification = await reloadTaskFromDisk(stateManager, task);
  const verifierTokenAccumulator = { tokensUsed: 0 };
  const verificationResult = await runPhase("verify-task", () =>
    verifyTaskWithDeps(
      {
        ...verifierDeps,
        _tokenAccumulator: verifierTokenAccumulator,
      },
      taskForVerification,
      executionResult
    )
  );
  taskCycleTokens += verifierTokenAccumulator.tokensUsed;
  const verdictContext = buildVerdictHandlingContext(executionResult);
  const effectiveVerificationResult = applyVerdictHandlingContextGuards(verificationResult, verdictContext);
  const effectiveVerdictContext = { ...verdictContext, verificationGuardsApplied: true };
  if (effectiveVerificationResult !== verificationResult) {
    const rawVerification = await stateManager.loadTaskVerificationResult(taskForVerification.id);
    await stateManager.saveTaskVerificationResult(
      taskForVerification.id,
      rawVerification && typeof rawVerification === "object"
        ? { ...rawVerification, ...effectiveVerificationResult }
        : effectiveVerificationResult
    );
  }
  logger?.debug(`[DEBUG-TL] Verification: verdict=${effectiveVerificationResult.verdict}, evidence=${effectiveVerificationResult.evidence.map((e) => e.description).join("; ").substring(0, 300)}`);

  const verdictResult = await runPhase("handle-verdict", () =>
    context.handleVerdict(
      taskForVerification,
      effectiveVerificationResult,
      effectiveVerdictContext
    )
  );
  logger?.info(`[task] verdict: ${verdictResult.action}`, { taskId: task.id });

  await runPhase("persist-task-side-effects", () =>
    persistTaskCycleSideEffects({
      goalId,
      targetDimension,
      task: verdictResult.task,
      action: verdictResult.action,
      verificationResult: effectiveVerificationResult,
      executionResult,
      adapter,
      ...context.sideEffectDeps(),
      gapValue: gapVector?.gaps?.[0]?.normalized_gap,
      reusedPlaybookIds: playbookIdsUsed,
    })
  );
  await runPhase("persist-usage-telemetry", async () => {
    await setTaskOutcomeTokens(stateManager, verdictResult.task, taskCycleTokens);
  });

  return {
    task: verdictResult.task,
    verificationResult: effectiveVerificationResult,
    action: verdictResult.action,
    diffEvidenceSource: executionResult.diffEvidenceSource,
    tokensUsed: taskCycleTokens,
    ...(learningPriorApplication ? { learningPriorApplication } : {}),
  };
}
