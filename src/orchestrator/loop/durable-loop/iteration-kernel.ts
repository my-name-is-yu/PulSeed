import type { Logger } from "../../../runtime/logger.js";
import * as path from "node:path";
import type { StateDiffCalculator } from "../state-diff.js";
import { generateLoopReport } from "../loop-report-helper.js";
import { makeEmptyIterationResult } from "../loop-result-types.js";
import type { LoopIterationResult, NextIterationDirective } from "../loop-result-types.js";
import type { CoreLoopDeps, ResolvedLoopConfig } from "./contracts.js";
import {
  loadGoalWithAggregation,
  observeAndReload,
  calculateGapOrComplete,
  scoreDrivesAndCheckKnowledge,
  phaseAutoDecompose,
  type PhaseCtx,
} from "./preparation.js";
import {
  checkCompletionAndMilestones,
  detectStallsAndRebalance,
  evaluateWaitStrategiesForObserveOnly,
  checkDependencyBlock,
  runTaskCycleWithContext,
  type LoopCallbacks,
} from "./task-cycle.js";
import {
  runStateDiffCheck,
  tryParallelExecution,
  type StateDiffState,
} from "./control.js";
import { handleCapabilityAcquisition } from "./capability.js";
import { CoreLoopEvidenceLedger } from "./evidence-ledger.js";
import { CorePhaseRuntime } from "./phase-runtime.js";
import {
  buildDreamReviewCheckpointSpec,
  buildKnowledgeRefreshSpec,
  buildObserveEvidenceSpec,
  buildPublicResearchSpec,
  buildReplanningOptionsSpec,
  buildStallInvestigationSpec,
  buildWaitObservationSpec,
  buildVerificationEvidenceSpec,
  type DreamReviewCheckpointEvidence,
} from "./phase-specs.js";
import type { CorePhasePolicyRegistry } from "./phase-policy.js";
import type { CoreDecisionEngine } from "./decision-engine.js";
import type { ITimeHorizonEngine } from "../../../platform/time/time-horizon-engine.js";
import {
  buildDeadlineFinalizationStatus,
  normalizeFinalizationPolicy,
  shouldStopExplorationForFinalization,
  type DeadlineFinalizationArtifact,
  type DeadlineFinalizationStatus,
} from "../../../platform/time/deadline-finalization.js";
import { deriveExecutionModeFromDeadlineStatus } from "../../../platform/time/execution-mode.js";
import type { DriveScore } from "../../../base/types/drive.js";
import type { Goal } from "../../../base/types/goal.js";
import type { CorePhaseKind } from "../../execution/agent-loop/core-phase-runner.js";
import { findActiveWaitObservationInput } from "./iteration-kernel-wait.js";
import {
  autoAcquireKnowledgeForDreamStall,
  autoAcquireKnowledgeForRefresh,
} from "./iteration-kernel-knowledge.js";
import {
  buildDreamReviewCheckpointRequest,
  dreamCheckpointRawRefs,
  formatDreamRunControlRecommendationContext,
  normalizeDreamReviewCheckpoint,
  type DreamReviewCheckpointRequest,
} from "./dream-review-checkpoint.js";
import {
  buildPublicResearchRequest,
  normalizePublicResearchMemo,
  publicResearchSummary,
  researchRawRefs,
  type PublicResearchRequest,
} from "./public-research.js";
import type { GoalRunActivationContext } from "../../../base/types/goal-activation.js";
import type {
  RuntimeEvidenceEntryInput,
  RuntimeEvidenceEntryKind,
  RuntimeEvidenceSummary,
} from "../../../runtime/store/evidence-ledger.js";
import { RuntimeReproducibilityManifestStore } from "../../../runtime/store/reproducibility-manifest.js";
import type { TaskCycleResult } from "../../execution/task/task-execution-types.js";
import {
  bestArtifactFromEvidence,
  phaseStatusToOutcome,
  selectLatestVerifiedArtifact,
  summarizeVerificationEvidence,
  taskActionToOutcome,
  truncateOneLine,
  verificationToOutcome,
} from "./iteration-kernel-evidence-helpers.js";

export interface CoreIterationKernelDeps {
  deps: CoreLoopDeps;
  getConfig: () => ResolvedLoopConfig;
  setConfig: (config: ResolvedLoopConfig) => void;
  logger?: Logger;
  stateDiff?: StateDiffCalculator;
  stateDiffState: Map<string, StateDiffState>;
  decomposedGoals: Set<string>;
  timeHorizonEngine?: ITimeHorizonEngine;
  corePhasePolicyRegistry: CorePhasePolicyRegistry;
  coreDecisionEngine: CoreDecisionEngine;
  capabilityFailures: Map<string, number>;
  incrementTransferCounter: () => number;
  getPendingDirective: (goalId: string) => NextIterationDirective | undefined;
  getActivationContext: () => GoalRunActivationContext | undefined;
  getRuntimeBudgetContext?: () => Promise<Record<string, unknown> | undefined>;
}

export interface RunCoreIterationInput {
  goalId: string;
  loopIndex: number;
  isFirstIteration?: boolean;
  abortSignal?: AbortSignal;
}

export class CoreIterationKernel {
  constructor(private readonly deps: CoreIterationKernelDeps) {}

  async run(input: RunCoreIterationInput): Promise<LoopIterationResult> {
    const { goalId, loopIndex, isFirstIteration, abortSignal } = input;
    const startTime = Date.now();
    let config = this.deps.getConfig();
    const pendingDirective = this.deps.getPendingDirective(goalId);
    const ctx: PhaseCtx = {
      deps: this.deps.deps,
      config,
      logger: this.deps.logger,
      toolExecutor: this.deps.deps.toolExecutor,
      timeHorizonEngine: this.deps.timeHorizonEngine,
    };
    const runPhase = async <T>(phase: string, work: () => Promise<T>): Promise<T> => {
      const phaseStartedAt = Date.now();
      this.deps.logger?.info(`[CoreLoop] phase ${phase} starting`, { goalId, loopIndex });
      try {
        const value = await work();
        this.deps.logger?.info(`[CoreLoop] phase ${phase} completed`, {
          goalId,
          loopIndex,
          duration_ms: Date.now() - phaseStartedAt,
        });
        return value;
      } catch (err) {
        this.deps.logger?.warn(`[CoreLoop] phase ${phase} failed`, {
          goalId,
          loopIndex,
          duration_ms: Date.now() - phaseStartedAt,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    };

    const result: LoopIterationResult = makeEmptyIterationResult(goalId, loopIndex);
    const activationContext = this.deps.getActivationContext();
    const evidenceLedger = new CoreLoopEvidenceLedger();
    const runtimeEvidenceScope = {
      goal_id: goalId,
      ...(activationContext?.backgroundRun?.backgroundRunId
        ? { run_id: activationContext.backgroundRun.backgroundRunId }
        : {}),
      loop_index: loopIndex,
    };
    const appendRuntimeEvidence = async (entry: Omit<RuntimeEvidenceEntryInput, "scope"> & { scope?: RuntimeEvidenceEntryInput["scope"] }) => {
      if (config.dryRun || !this.deps.deps.evidenceLedger) return;
      try {
        await this.deps.deps.evidenceLedger.append({
          ...entry,
          scope: {
            ...runtimeEvidenceScope,
            ...entry.scope,
          },
        });
      } catch (err) {
        this.deps.logger?.warn("CoreLoop: failed to append runtime evidence ledger entry", {
          goalId,
          loopIndex,
          kind: entry.kind,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    };
    const corePhaseRuntime = new CorePhaseRuntime({
      phaseRunner: this.deps.deps.corePhaseRunner,
      policyRegistry: this.deps.corePhasePolicyRegistry,
    });
    let dreamReviewCheckpointRan = false;
    const rememberPhase = (execution: {
      phase: CorePhaseKind;
      status: "skipped" | "completed" | "low_confidence" | "failed";
      summary?: string;
      traceId?: string;
      sessionId?: string;
      turnId?: string;
      stopReason?: string;
      lowConfidence?: boolean;
      error?: string;
    }) => {
      if (execution.status === "skipped") return;
      evidenceLedger.record(execution);
      result.corePhaseResults = evidenceLedger.toIterationPhaseResults();
    };
    const maybeRunDreamReviewCheckpoint = async (input: {
      goal: Goal;
      gapAggregate: number;
      driveScores: DriveScore[];
      finalizationStatus?: DeadlineFinalizationStatus;
      executionMode?: ReturnType<typeof deriveExecutionModeFromDeadlineStatus>;
      requestedTrigger?: "iteration" | "plateau" | "breakthrough" | "pre_finalization";
    }): Promise<DreamReviewCheckpointEvidence | null> => {
      if (dreamReviewCheckpointRan) return null;
      const evidenceSummary = await loadDreamReviewEvidenceSummary(this.deps.deps.evidenceLedger, goalId);
      const request = buildDreamReviewCheckpointRequest({
        goal: input.goal,
        loopIndex,
        result,
        driveScores: input.driveScores,
        finalizationStatus: input.finalizationStatus,
        executionMode: input.executionMode,
        evidenceSummary,
        recentCheckpoints: evidenceSummary?.dream_checkpoints,
        ...(input.requestedTrigger ? { requestedTrigger: input.requestedTrigger } : {}),
      });
      if (!request) return null;

      const dreamReview = await runPhase("dream-review-checkpoint", () =>
        corePhaseRuntime.run(
          {
            ...buildDreamReviewCheckpointSpec(),
            requiredTools: ["soil_query"],
            allowedTools: ["soil_query", "knowledge_query", "memory_recall"],
            budget: {
              maxModelTurns: 3,
              maxToolCalls: 5,
              maxWallClockMs: 45_000,
              maxRepeatedToolCalls: 1,
            },
          },
          {
            goalTitle: input.goal.title,
            trigger: request.trigger,
            reason: request.reason,
            activeDimensions: request.activeDimensions,
            ...(request.bestEvidenceSummary ? { bestEvidenceSummary: request.bestEvidenceSummary } : {}),
            recentStrategyFamilies: request.recentStrategyFamilies,
            activeHypotheses: request.activeHypotheses,
            rejectedApproaches: request.rejectedApproaches,
            failedLineages: request.failedLineages,
            ...(request.metricTrendSummary ? { metricTrendSummary: request.metricTrendSummary } : {}),
            ...(request.finalizationReason ? { finalizationReason: request.finalizationReason } : {}),
            ...(request.currentExecutionMode ? { currentExecutionMode: request.currentExecutionMode } : {}),
            runControlPolicy: request.runControlPolicy,
            memoryAuthorityPolicy: request.memoryAuthorityPolicy,
            maxGuidanceItems: request.maxGuidanceItems,
          },
          { goalId, stallDetected: result.stallDetected, gapAggregate: input.gapAggregate },
        )
      );
      rememberPhase(dreamReview);
      const checkpoint = await appendDreamReviewCheckpointEvidence(appendRuntimeEvidence, dreamReview, request, input.goal);
      if (checkpoint?.run_control_recommendations.length) {
        result.dreamRunControlRecommendations = checkpoint.run_control_recommendations;
      }
      dreamReviewCheckpointRan = dreamReview.status !== "skipped";
      return checkpoint;
    };

    this.deps.logger?.info(`[CoreLoop] iteration ${loopIndex + 1} starting`, { goalId, loopIndex });

    const loadedGoal = await runPhase("load-goal", () =>
      loadGoalWithAggregation(ctx, goalId, result, startTime)
    );
    if (!loadedGoal) return result;
    let goal = loadedGoal;

    await runPhase("auto-decompose", () =>
      phaseAutoDecompose(
        goalId,
        goal,
        this.deps.deps,
        config,
        this.deps.logger,
        this.deps.decomposedGoals,
        isFirstIteration
      )
    );

    if (!goal.children_ids.length) {
      const reloadedAfterDecompose = await this.deps.deps.stateManager.loadGoal(goalId);
      if (reloadedAfterDecompose && reloadedAfterDecompose.children_ids.length > 0) {
        goal = reloadedAfterDecompose;
        if (this.deps.deps.treeLoopOrchestrator) {
          config = { ...config, treeMode: true };
          this.deps.setConfig(config);
          ctx.config = config;
          this.deps.logger?.info("[CoreLoop] treeMode enabled after auto-decomposition", {
            goalId,
            childrenCount: goal.children_ids.length,
          });
        }
      }
    }

    const observeEvidence = await runPhase("observe-evidence", () =>
      corePhaseRuntime.run(
        {
          ...buildObserveEvidenceSpec(),
          requiredTools: [],
          allowedTools: [],
          budget: {},
        },
        {
          goalTitle: goal.title,
          goalDescription: goal.description,
          dimensions: goal.dimensions.map((dimension) => dimension.name),
        },
        { goalId, gapAggregate: result.gapAggregate },
      )
    );
    rememberPhase(observeEvidence);
    await appendPhaseEvidence(appendRuntimeEvidence, observeEvidence, "observation");

    goal = await runPhase("observe", () => observeAndReload(ctx, goalId, goal, loopIndex));

    if (this.deps.stateDiff) {
      const { shouldSkip } = await runStateDiffCheck(
        this.deps.stateDiff,
        this.deps.stateDiffState,
        goalId,
        goal,
        loopIndex,
        config,
        this.deps.deps,
        result,
        startTime,
        this.deps.logger
      );
      if (shouldSkip) return result;
    }

    const gapResult = await runPhase("gap-analysis", () =>
      calculateGapOrComplete(ctx, goalId, goal, loopIndex, result, startTime)
    );
    if (!gapResult) return result;
    const { gapVector, gapAggregate, skipTaskGeneration } = gapResult;

    this.deps.logger?.info(
      `[iter ${loopIndex}] gap: ${gapAggregate.toFixed(2)} | ${(gapVector.gaps ?? [])
        .map((g: any) => `${g.dimension_name}=${g.normalized_weighted_gap.toFixed(2)}`)
        .join(", ")}`
    );

    const finalizationStatus = await runPhase("deadline-finalization", async () => {
      const bestArtifact = await loadBestFinalizationArtifact(
        this.deps.deps.evidenceLedger,
        goalId,
        normalizeFinalizationPolicy(goal.finalization_policy).best_artifact_selection
      );
      const reproducibilityManifestId = await loadReadyFinalizationManifestId({
        stateManager: this.deps.deps.stateManager,
        goalId,
        runId: runtimeEvidenceScope.run_id,
        bestArtifact,
        requireReproducibilityManifest: normalizeFinalizationPolicy(goal.finalization_policy).require_reproducibility_manifest,
      });
      return buildDeadlineFinalizationStatus({
        goal,
        bestArtifact,
        reproducibilityManifestId,
      });
    });
    result.finalizationStatus = finalizationStatus;
    const executionMode = deriveExecutionModeFromDeadlineStatus(finalizationStatus);
    result.executionMode = executionMode;
    if (shouldStopExplorationForFinalization(finalizationStatus)) {
      await maybeRunDreamReviewCheckpoint({
        goal,
        gapAggregate,
        driveScores: [],
        finalizationStatus,
        executionMode,
        requestedTrigger: "pre_finalization",
      });
      result.skipped = true;
      result.skipReason =
        finalizationStatus.mode === "missed_deadline"
          ? "deadline_missed_finalization"
          : "deadline_finalization";
      await appendRuntimeEvidence({
        kind: "decision",
        summary: finalizationStatus.reason,
        outcome: "blocked",
        decision_reason: finalizationStatus.reason,
        scope: { phase: "deadline_finalization" },
        result: {
          status: finalizationStatus.mode,
          summary: finalizationStatus.finalization_plan?.deliverable_contract ?? finalizationStatus.reason,
        },
      });
      await generateLoopReport(goalId, loopIndex, result, goal, this.deps.deps.reportingEngine, this.deps.logger);
      result.elapsedMs = Date.now() - startTime;
      return result;
    }

    const activeWait = await findActiveWaitObservationInput(
      this.deps.deps,
      goalId,
      goal.title,
      activationContext?.waitResume?.strategyId
    );
    if (activeWait) {
      const waitObservationPhase = await runPhase("wait-observation-agentic", () =>
        corePhaseRuntime.run(
          {
            ...buildWaitObservationSpec(),
            requiredTools: [],
            allowedTools: [],
            budget: {},
          },
          activeWait,
          { goalId, gapAggregate },
        )
      );
      rememberPhase(waitObservationPhase);
      await appendPhaseEvidence(appendRuntimeEvidence, waitObservationPhase, "observation");
    }

    const waitObservationDecision = await runPhase("wait-observation", () =>
      evaluateWaitStrategiesForObserveOnly(
        ctx,
        goalId,
        goal,
        result,
        activationContext?.waitResume?.strategyId
      )
    );
    if (waitObservationDecision.observeOnly) {
      result.skipped = true;
      result.skipReason =
        waitObservationDecision.outcome?.status === "not_due"
          ? "wait_not_due"
          : "wait_observe_only";
      await generateLoopReport(goalId, loopIndex, result, goal, this.deps.deps.reportingEngine, this.deps.logger);
      result.elapsedMs = Date.now() - startTime;
      return result;
    }

    let driveScores: DriveScore[] = [];
    let highDissatisfactionDimensions: string[] = [];
    if (!skipTaskGeneration) {
      const driveResult = await runPhase("drive-scoring", () =>
        scoreDrivesAndCheckKnowledge(
          ctx,
          goalId,
          goal,
          gapVector,
          loopIndex,
          result,
          startTime,
          (id, idx, r, g) => generateLoopReport(id, idx, r, g, this.deps.deps.reportingEngine, this.deps.logger)
        )
      );
      if (!driveResult) return result;
      driveScores = driveResult.driveScores;
      highDissatisfactionDimensions = driveResult.highDissatisfactionDimensions;
    }

    const knowledgeRefresh = !skipTaskGeneration
      ? await runPhase("knowledge-refresh", () =>
          corePhaseRuntime.run(
            {
              ...buildKnowledgeRefreshSpec(),
              requiredTools: [],
              allowedTools: [],
              budget: {},
            },
            {
              goalTitle: goal.title,
              topDimensions: highDissatisfactionDimensions.length > 0
                ? [
                    ...(pendingDirective?.focusDimension ? [pendingDirective.focusDimension] : []),
                    ...highDissatisfactionDimensions,
                  ].filter((value, index, values) => values.indexOf(value) === index)
                : [
                    ...(pendingDirective?.focusDimension ? [pendingDirective.focusDimension] : []),
                    ...driveScores.map((score) => score.dimension_name),
                  ].filter((value, index, values) => values.indexOf(value) === index),
              gapAggregate,
            },
            { goalId, gapAggregate },
          )
        )
      : null;
    if (knowledgeRefresh) rememberPhase(knowledgeRefresh);
    if (knowledgeRefresh) await appendPhaseEvidence(appendRuntimeEvidence, knowledgeRefresh, "strategy");

    const replanningOptions = this.deps.coreDecisionEngine.shouldRunReplanningOptions({
      skipTaskGeneration: Boolean(skipTaskGeneration),
      taskCycleBlocked: false,
      gapAggregate,
    })
      ? await runPhase("replanning-options", () =>
          corePhaseRuntime.run(
            {
              ...buildReplanningOptionsSpec(),
              requiredTools: [],
              allowedTools: [],
              budget: {},
            },
            {
              goalTitle: goal.title,
              targetDimensions: driveScores.map((score) => score.dimension_name),
              gapAggregate,
            },
            { goalId, gapAggregate },
          )
        )
      : null;
    if (replanningOptions) rememberPhase(replanningOptions);
    if (replanningOptions) await appendPhaseEvidence(appendRuntimeEvidence, replanningOptions, "strategy");

    await runPhase("completion-check", () =>
      checkCompletionAndMilestones(ctx, goalId, goal, result, startTime)
    );
    if (result.error) return result;

    const stallActionHints = this.deps.coreDecisionEngine.buildStallActionHints({
      phase: replanningOptions,
    });
    await runPhase("stall-detection", () =>
      detectStallsAndRebalance(
        ctx,
        goalId,
        goal,
        result,
        stallActionHints.recommendedAction
          ? stallActionHints
          : pendingDirective?.preferredAction
            ? { recommendedAction: pendingDirective.preferredAction }
            : undefined,
      )
    );
    const stallInvestigation = this.deps.coreDecisionEngine.shouldRunStallInvestigation(result)
      ? await runPhase("stall-investigation", () =>
          corePhaseRuntime.run(
            {
              ...buildStallInvestigationSpec(),
              requiredTools: [],
              allowedTools: [],
              budget: {},
            },
            {
              goalId,
              goalTitle: goal.title,
              stallType: result.stallReport?.stall_type ?? "unknown",
              ...(result.stallReport?.dimension_name ? { dimensionName: result.stallReport.dimension_name } : {}),
              ...(result.stallReport?.suggested_cause ? { suggestedCause: result.stallReport.suggested_cause } : {}),
              ...(result.stallReport?.task_id ? { taskId: result.stallReport.task_id } : {}),
            },
            {
              goalId,
              ...(result.stallReport?.task_id ? { taskId: result.stallReport.task_id } : {}),
              stallDetected: result.stallDetected,
              gapAggregate,
            },
          )
        )
      : null;
    if (stallInvestigation) rememberPhase(stallInvestigation);
    if (stallInvestigation) await appendPhaseEvidence(appendRuntimeEvidence, stallInvestigation, "failure");

    if (result.stallDetected && result.stallReport) {
      this.deps.logger?.warn(`[iter ${loopIndex}] stall detected: ${result.stallReport.stall_type}`, {
        escalation: result.stallReport.escalation_level,
      });
      void this.deps.deps.hookManager?.emit("StallDetected", {
        goal_id: goalId,
        dimension: result.stallReport.dimension_name ?? undefined,
        data: {
          stall_type: result.stallReport.stall_type,
          escalation_level: result.stallReport.escalation_level,
          suggested_cause: result.stallReport.suggested_cause,
          task_id: result.stallReport.task_id ?? undefined,
        },
      });
    }

    const dreamCheckpoint = await maybeRunDreamReviewCheckpoint({
      goal,
      gapAggregate,
      driveScores,
      finalizationStatus,
      executionMode,
    });
    const dreamRunControlRecommendationContext = formatDreamRunControlRecommendationContext(
      dreamCheckpoint?.run_control_recommendations
    );

    const publicResearchRequest = buildPublicResearchRequest({
      goal,
      result,
      gapAggregate,
      driveScores,
      knowledgeRefresh,
    });
    const publicResearch = publicResearchRequest
      ? await runPhase("public-research", () =>
          corePhaseRuntime.run(
            {
              ...buildPublicResearchSpec(),
              requiredTools: ["research_answer_with_sources"],
              allowedTools: ["research_web", "research_answer_with_sources"],
              budget: {
                maxModelTurns: 4,
                maxToolCalls: 4,
                maxWallClockMs: 60_000,
                maxRepeatedToolCalls: 1,
              },
            },
            {
              goalTitle: goal.title,
              trigger: publicResearchRequest.trigger,
              question: publicResearchRequest.question,
              targetDimensions: publicResearchRequest.targetDimensions,
              sourcePreference: publicResearchRequest.sourcePreference,
              maxSources: publicResearchRequest.maxSources,
              sensitiveContextPolicy: publicResearchRequest.sensitiveContextPolicy,
              untrustedContentPolicy: publicResearchRequest.untrustedContentPolicy,
            },
            { goalId, stallDetected: result.stallDetected, gapAggregate },
          )
        )
      : null;
    if (publicResearch) rememberPhase(publicResearch);
    if (publicResearch && publicResearchRequest) {
      await appendPublicResearchEvidence(appendRuntimeEvidence, publicResearch, publicResearchRequest);
    }

    const knowledgeAcquisitionDecision = this.deps.coreDecisionEngine.evaluateKnowledgeAcquisition({
      phase: knowledgeRefresh,
      hasKnowledgeManager: !!this.deps.deps.knowledgeManager,
      hasToolExecutor: !!this.deps.deps.toolExecutor,
    });
    if (
      knowledgeAcquisitionDecision.shouldAcquire &&
      knowledgeAcquisitionDecision.question &&
      this.deps.deps.knowledgeManager &&
      this.deps.deps.toolExecutor
    ) {
      try {
        const acquiredCount = await autoAcquireKnowledgeForRefresh(
          this.deps.deps,
          this.deps.logger,
          goalId,
          knowledgeAcquisitionDecision.question
        );
        if (acquiredCount > 0) {
          result.nextIterationDirective = this.deps.coreDecisionEngine.buildNextIterationDirective({
            knowledgeRefreshPhase: knowledgeRefresh,
            replanningPhase: replanningOptions,
            goalDimensions: goal.dimensions.map((dimension) => dimension.name),
            fallbackFocusDimension: driveScores[0]?.dimension_name ?? pendingDirective?.focusDimension,
          });
          await appendDecisionEvidence(appendRuntimeEvidence, result.nextIterationDirective, "knowledge_refresh_auto_acquire");
          this.deps.logger?.info("CoreLoop: knowledge_refresh auto-acquired knowledge and skipped execution", {
            goalId,
            acquiredCount,
          });
          await generateLoopReport(goalId, loopIndex, result, goal, this.deps.deps.reportingEngine, this.deps.logger);
          result.skipped = true;
          result.skipReason = "knowledge_refresh_auto_acquire";
          result.elapsedMs = Date.now() - startTime;
          return result;
        }
      } catch (err) {
        this.deps.logger?.warn("CoreLoop: knowledge_refresh auto acquisition failed (non-fatal)", {
          goalId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (result.stallDetected && this.deps.deps.knowledgeManager && this.deps.deps.toolExecutor) {
      try {
        const acquiredCount = await autoAcquireKnowledgeForDreamStall(
          this.deps.deps,
          this.deps.logger,
          goalId,
          goal,
          gapVector
        );
        if (acquiredCount > 0) {
          this.deps.logger?.info(
            "CoreLoop: dream auto-acquired knowledge and skipped execution for context refresh",
            { goalId, acquiredCount }
          );
          await generateLoopReport(goalId, loopIndex, result, goal, this.deps.deps.reportingEngine, this.deps.logger);
          result.skipped = true;
          result.skipReason = "dream_auto_acquire_knowledge";
          result.elapsedMs = Date.now() - startTime;
          return result;
        }
      } catch (err) {
        this.deps.logger?.warn("CoreLoop: autoAcquireKnowledge failed (non-fatal)", {
          goalId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (skipTaskGeneration) {
      result.nextIterationDirective = this.deps.coreDecisionEngine.buildNextIterationDirective({
        knowledgeRefreshPhase: knowledgeRefresh,
        replanningPhase: replanningOptions,
        goalDimensions: goal.dimensions.map((dimension) => dimension.name),
        fallbackFocusDimension: driveScores[0]?.dimension_name ?? pendingDirective?.focusDimension,
      });
      await appendDecisionEvidence(appendRuntimeEvidence, result.nextIterationDirective, "skip_task_generation");
      await generateLoopReport(goalId, loopIndex, result, goal, this.deps.deps.reportingEngine, this.deps.logger);
      result.elapsedMs = Date.now() - startTime;
      return result;
    }

    if (checkDependencyBlock(ctx, goalId, result)) return result;

    const tookParallelPath = await tryParallelExecution(
      goalId,
      goal,
      gapAggregate,
      result,
      startTime,
      this.deps.deps,
      loopIndex,
      this.deps.logger
    );
    if (tookParallelPath) return result;

    const shouldPreferReplanningContext = this.deps.coreDecisionEngine.shouldPreferReplanningContext({
      phase: replanningOptions,
    });
    const taskGenerationHints = this.deps.coreDecisionEngine.buildTaskGenerationHints({
      phase: replanningOptions,
      goalDimensions: goal.dimensions.map((dimension) => dimension.name),
    });
    const runtimeBudgetContext = await this.deps.getRuntimeBudgetContext?.().catch((err) => {
      this.deps.logger?.warn("CoreLoop: failed to load runtime budget context", {
        goalId,
        loopIndex,
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    });
    const mergedTaskGenerationHints = {
      targetDimensionOverride: taskGenerationHints.targetDimensionOverride ?? pendingDirective?.focusDimension,
      knowledgeContextPrefix: taskGenerationHints.knowledgeContextPrefix,
      budgetContext: runtimeBudgetContext,
      executionMode,
      runControlRecommendationContext: dreamRunControlRecommendationContext,
    };
    if (!shouldPreferReplanningContext && replanningOptions?.status === "completed") {
      this.deps.logger?.debug("CoreLoop: replanning evidence collected but not adopted as preferred context", {
        goalId,
        loopIndex,
      });
    }

    const loopCallbacks: LoopCallbacks = {
      handleCapabilityAcquisition: (task, gId, adapter) => handleCapabilityAcquisition(
        task as Parameters<typeof handleCapabilityAcquisition>[0],
        gId,
        adapter as Parameters<typeof handleCapabilityAcquisition>[2],
        this.deps.deps.capabilityDetector,
        this.deps.capabilityFailures,
        this.deps.logger,
        {
          toolExecutor: this.deps.deps.toolExecutor,
          baseDir: this.deps.deps.stateManager.getBaseDir(),
        },
      ),
      incrementTransferCounter: () => this.deps.incrementTransferCounter(),
      tryGenerateReport: (id, idx, r, g) =>
        generateLoopReport(id, idx, r, g, this.deps.deps.reportingEngine, this.deps.logger),
    };
    const taskCycleOk = await runTaskCycleWithContext(
      ctx,
      goalId,
      goal,
      gapVector,
      driveScores,
      highDissatisfactionDimensions,
      loopIndex,
      result,
      startTime,
      loopCallbacks,
      evidenceLedger,
      mergedTaskGenerationHints,
      abortSignal,
    );
    if (!taskCycleOk) return result;

    const completedTaskResult = result.taskResult;
    if (completedTaskResult) {
      await appendTaskCycleEvidence(appendRuntimeEvidence, completedTaskResult);
    }
    if (this.deps.coreDecisionEngine.shouldRunVerificationEvidence(result) && completedTaskResult) {
      const verificationPhase = await runPhase("verification-evidence", () =>
        corePhaseRuntime.run(
          {
            ...buildVerificationEvidenceSpec(),
            budget: {},
          },
          {
            taskId: completedTaskResult.task.id,
            taskDescription: completedTaskResult.task.work_description,
            successCriteria: completedTaskResult.task.success_criteria.map((criterion) => criterion.description),
            executionAction: completedTaskResult.action,
          },
          {
            goalId,
            taskId: completedTaskResult.task.id,
            hasTaskResult: true,
          },
        )
      );
      rememberPhase(verificationPhase);
      await appendPhaseEvidence(appendRuntimeEvidence, verificationPhase, "verification", {
        task_id: completedTaskResult.task.id,
      });
    }

    result.nextIterationDirective = this.deps.coreDecisionEngine.buildNextIterationDirective({
      knowledgeRefreshPhase: knowledgeRefresh,
      replanningPhase: replanningOptions,
      goalDimensions: goal.dimensions.map((dimension) => dimension.name),
      fallbackFocusDimension: driveScores[0]?.dimension_name ?? pendingDirective?.focusDimension,
    });
    await appendDecisionEvidence(appendRuntimeEvidence, result.nextIterationDirective, "next_iteration_directive");

    await generateLoopReport(goalId, loopIndex, result, goal, this.deps.deps.reportingEngine, this.deps.logger);

    result.elapsedMs = Date.now() - startTime;
    return result;
  }
}

async function appendPublicResearchEvidence(
  appendRuntimeEvidence: (entry: Omit<RuntimeEvidenceEntryInput, "scope"> & { scope?: RuntimeEvidenceEntryInput["scope"] }) => Promise<void>,
  execution: {
    phase: CorePhaseKind;
    status: "skipped" | "completed" | "low_confidence" | "failed";
    output?: unknown;
    summary?: string;
    traceId?: string;
    sessionId?: string;
    turnId?: string;
    error?: string;
  },
  request: PublicResearchRequest,
): Promise<void> {
  if (execution.status === "skipped") return;
  const output = buildPublicResearchSpec().outputSchema.safeParse(execution.output);
  if (!output.success) {
    await appendRuntimeEvidence({
      kind: "research",
      scope: { phase: execution.phase },
      summary: execution.summary ?? request.reason,
      outcome: "inconclusive",
      result: {
        status: execution.status,
        summary: request.reason,
        error: output.error.issues.map((issue) => issue.message).join("; "),
      },
    });
    return;
  }

  const memo = normalizePublicResearchMemo(output.data, request);
  await appendRuntimeEvidence({
    kind: "research",
    scope: { phase: execution.phase },
    summary: publicResearchSummary(memo),
    outcome: phaseStatusToOutcome(execution.status),
    research: [memo],
    result: {
      status: execution.status,
      summary: memo.summary,
      ...(execution.error ? { error: execution.error } : {}),
    },
    raw_refs: [
      ...researchRawRefs(memo),
      ...(execution.traceId ? [{ kind: "agentloop_trace", id: execution.traceId }] : []),
      ...(execution.sessionId ? [{ kind: "agentloop_state", id: execution.sessionId }] : []),
      ...(execution.turnId ? [{ kind: "agentloop_turn", id: execution.turnId }] : []),
    ],
  });
}

async function appendDreamReviewCheckpointEvidence(
  appendRuntimeEvidence: (entry: Omit<RuntimeEvidenceEntryInput, "scope"> & { scope?: RuntimeEvidenceEntryInput["scope"] }) => Promise<void>,
  execution: {
    phase: CorePhaseKind;
    status: "skipped" | "completed" | "low_confidence" | "failed";
    output?: unknown;
    summary?: string;
    traceId?: string;
    sessionId?: string;
    turnId?: string;
    error?: string;
  },
  request: DreamReviewCheckpointRequest,
  goal: Goal,
): Promise<DreamReviewCheckpointEvidence | null> {
  if (execution.status === "skipped") return null;
  const output = buildDreamReviewCheckpointSpec().outputSchema.safeParse(execution.output);
  if (!output.success) {
    await appendRuntimeEvidence({
      kind: "dream_checkpoint",
      scope: { phase: execution.phase },
      summary: execution.summary ?? request.reason,
      outcome: "inconclusive",
      result: {
        status: execution.status,
        summary: request.reason,
        error: output.error.issues.map((issue) => issue.message).join("; "),
      },
    });
    return null;
  }

  const checkpoint = normalizeDreamReviewCheckpoint(output.data, request, goal);
  await appendRuntimeEvidence({
    kind: "dream_checkpoint",
    scope: { phase: execution.phase },
    summary: checkpoint.summary,
    outcome: phaseStatusToOutcome(execution.status),
    dream_checkpoints: [checkpoint],
    result: {
      status: execution.status,
      summary: checkpoint.guidance,
      ...(execution.error ? { error: execution.error } : {}),
    },
    raw_refs: [
      ...dreamCheckpointRawRefs(checkpoint),
      ...(execution.traceId ? [{ kind: "agentloop_trace", id: execution.traceId }] : []),
      ...(execution.sessionId ? [{ kind: "agentloop_state", id: execution.sessionId }] : []),
      ...(execution.turnId ? [{ kind: "agentloop_turn", id: execution.turnId }] : []),
    ],
  });
  return checkpoint;
}

async function loadDreamReviewEvidenceSummary(
  evidenceLedger: CoreLoopDeps["evidenceLedger"],
  goalId: string
): Promise<RuntimeEvidenceSummary | null> {
  if (!evidenceLedger?.summarizeGoal) return null;
  try {
    return await evidenceLedger.summarizeGoal(goalId);
  } catch {
    return null;
  }
}

async function loadBestFinalizationArtifact(
  evidenceLedger: CoreLoopDeps["evidenceLedger"],
  goalId: string,
  selection: "best_evidence" | "latest_artifact" | "latest_verified"
): Promise<DeadlineFinalizationArtifact | null> {
  if (!evidenceLedger) return null;
  try {
    if (selection === "best_evidence") {
      const summary = await evidenceLedger.summarizeGoal?.(goalId);
      return summary?.best_evidence ? bestArtifactFromEvidence(summary.best_evidence) : null;
    }

    const entries = evidenceLedger.readByGoal
      ? (await evidenceLedger.readByGoal(goalId)).entries
      : (await evidenceLedger.summarizeGoal?.(goalId))?.recent_entries ?? [];
    const newestFirst = [...entries].sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
    const selected =
      selection === "latest_artifact"
        ? newestFirst.find((entry) => entry.artifacts.length > 0 || entry.kind === "artifact")
        : selectLatestVerifiedArtifact(newestFirst);
    return selected ? bestArtifactFromEvidence(selected) : null;
  } catch {
    return null;
  }
}

async function loadReadyFinalizationManifestId(input: {
  stateManager: CoreLoopDeps["stateManager"];
  goalId: string;
  runId?: string;
  bestArtifact: DeadlineFinalizationArtifact | null;
  requireReproducibilityManifest: boolean;
}): Promise<string | null> {
  if (!input.requireReproducibilityManifest) return null;
  if (!input.bestArtifact) return null;
  try {
    const store = new RuntimeReproducibilityManifestStore(path.join(input.stateManager.getBaseDir(), "runtime"));
    const manifest = await store.findReadyForFinalization({
      goalId: input.goalId,
      runId: input.runId,
      deliverable: input.bestArtifact
        ? {
            ...(input.bestArtifact.id ? { id: input.bestArtifact.id } : {}),
            label: input.bestArtifact.label,
            ...(input.bestArtifact.path ? { path: input.bestArtifact.path } : {}),
            ...(input.bestArtifact.state_relative_path ? { state_relative_path: input.bestArtifact.state_relative_path } : {}),
            ...(input.bestArtifact.url ? { url: input.bestArtifact.url } : {}),
          }
        : null,
    });
    return manifest?.manifest_id ?? null;
  } catch {
    return null;
  }
}

async function appendPhaseEvidence(
  appendRuntimeEvidence: (entry: Omit<RuntimeEvidenceEntryInput, "scope"> & { scope?: RuntimeEvidenceEntryInput["scope"] }) => Promise<void>,
  execution: {
    phase: CorePhaseKind;
    status: "skipped" | "completed" | "low_confidence" | "failed";
    summary?: string;
    traceId?: string;
    sessionId?: string;
    turnId?: string;
    error?: string;
  },
  kind: RuntimeEvidenceEntryKind,
  scope?: RuntimeEvidenceEntryInput["scope"],
): Promise<void> {
  if (execution.status === "skipped") return;
  await appendRuntimeEvidence({
    kind,
    scope: { ...scope, phase: execution.phase },
    summary: execution.summary ?? `${execution.phase} ${execution.status}`,
    outcome: phaseStatusToOutcome(execution.status),
    result: {
      status: execution.status,
      ...(execution.error ? { error: execution.error } : {}),
      ...(execution.summary ? { summary: execution.summary } : {}),
    },
    raw_refs: [
      ...(execution.traceId ? [{ kind: "agentloop_trace", id: execution.traceId }] : []),
      ...(execution.sessionId ? [{ kind: "agentloop_state", id: execution.sessionId }] : []),
      ...(execution.turnId ? [{ kind: "agentloop_turn", id: execution.turnId }] : []),
    ],
  });
}

async function appendDecisionEvidence(
  appendRuntimeEvidence: (entry: Omit<RuntimeEvidenceEntryInput, "scope"> & { scope?: RuntimeEvidenceEntryInput["scope"] }) => Promise<void>,
  directive: LoopIterationResult["nextIterationDirective"],
  fallbackReason: string,
): Promise<void> {
  if (!directive) return;
  await appendRuntimeEvidence({
    kind: "decision",
    summary: directive.reason,
    strategy: directive.preferredAction,
    outcome: "continued",
    decision_reason: directive.reason,
    scope: { phase: directive.sourcePhase },
    result: {
      status: fallbackReason,
      summary: directive.reason,
    },
  });
}

async function appendTaskCycleEvidence(
  appendRuntimeEvidence: (entry: Omit<RuntimeEvidenceEntryInput, "scope"> & { scope?: RuntimeEvidenceEntryInput["scope"] }) => Promise<void>,
  taskResult: TaskCycleResult,
): Promise<void> {
  const task = taskResult.task;
  await appendRuntimeEvidence({
    kind: "task_generation",
    scope: { task_id: task.id },
    hypothesis: task.rationale,
    strategy: task.approach,
    task: {
      id: task.id,
      description: task.work_description,
      primary_dimension: task.primary_dimension,
    },
    summary: task.work_description,
    outcome: "continued",
    decision_reason: task.rationale,
  });

  await appendRuntimeEvidence({
    kind: taskResult.action === "completed" ? "execution" : "failure",
    scope: { task_id: task.id },
    task: {
      id: task.id,
      description: task.work_description,
      action: taskResult.action,
      primary_dimension: task.primary_dimension,
    },
    artifacts: taskResult.verificationResult.file_diffs?.map((diff) => ({
      label: diff.path,
      path: diff.path,
      kind: "diff" as const,
    })) ?? [],
    result: {
      status: taskResult.action,
      ...(task.execution_output ? { summary: truncateOneLine(task.execution_output, 500) } : {}),
    },
    outcome: taskActionToOutcome(taskResult.action),
    summary: `Task ${task.id} ${taskResult.action}`,
  });

  await appendRuntimeEvidence({
    kind: taskResult.verificationResult.verdict === "pass" ? "verification" : "failure",
    scope: { task_id: task.id },
    verification: {
      verdict: taskResult.verificationResult.verdict,
      confidence: taskResult.verificationResult.confidence,
      summary: summarizeVerificationEvidence(taskResult.verificationResult.evidence),
    },
    result: {
      status: taskResult.verificationResult.verdict,
      summary: summarizeVerificationEvidence(taskResult.verificationResult.evidence),
    },
    outcome: verificationToOutcome(taskResult.verificationResult.verdict),
    summary: `Verification ${taskResult.verificationResult.verdict} for ${task.id}`,
  });
}
