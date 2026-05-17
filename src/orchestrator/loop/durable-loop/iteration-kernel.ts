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
  RuntimeEvidenceEntry,
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
import { recordExperienceLearningCheckpoint } from "./experience-learning-bridge.js";
import { enqueueExperienceLearningProjectionForOwnerReview } from "../../../reflection/experience-learning-writeback.js";
import type {
  ExperimentRecord,
  ExperimentValueOutcome,
  ExperienceLearningRuntimeEventPayload,
  GeneralizationCandidate,
  LearningArtifact,
  LearningConsumerPhase,
  LearningExperimentPlan,
  LearningPriorPhaseProjection,
  LearningPriorSnapshot,
  LearningScope,
} from "../../../runtime/learning/index.js";
import {
  ExperimentRecordSchema,
  ExperimentValueOutcomeSchema,
  GeneralizationCandidateSchema,
  LearningArtifactSchema,
  LearningPriorSnapshotSchema,
  defaultRuntimeEvidenceTrust,
  learningPriorSuggestion,
  redactedLearningLabel,
  stableLearningId,
} from "../../../runtime/learning/index.js";
import type { ExperienceLearningStateStore } from "../../../runtime/store/experience-learning-state-store.js";

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

type PhaseLearningProjection<TPhase extends LearningPriorPhaseProjection["phase"]> =
  LearningPriorPhaseProjection & { phase: TPhase };

function isLearningProjectionPhase<TPhase extends LearningPriorPhaseProjection["phase"]>(
  projection: LearningPriorPhaseProjection | null | undefined,
  phase: TPhase,
): projection is PhaseLearningProjection<TPhase> {
  return projection?.phase === phase;
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
    const iterationEvidence: RuntimeEvidenceEntry[] = [];
    let goalForExperienceLearning: Goal | null = null;
    const appendRuntimeEvidence = async (entry: Omit<RuntimeEvidenceEntryInput, "scope"> & { scope?: RuntimeEvidenceEntryInput["scope"] }): Promise<RuntimeEvidenceEntry[]> => {
      if (config.dryRun || !this.deps.deps.evidenceLedger) return [];
      try {
        const appended = await this.deps.deps.evidenceLedger.append({
          ...entry,
          scope: {
            ...runtimeEvidenceScope,
            ...entry.scope,
          },
        });
        iterationEvidence.push(...appended);
        result.iterationEvidenceRefs = iterationEvidence.map((evidence) => evidence.id);
        return appended;
      } catch (err) {
        this.deps.logger?.warn("CoreLoop: failed to append runtime evidence ledger entry", {
          goalId,
          loopIndex,
          kind: entry.kind,
          error: err instanceof Error ? err.message : String(err),
        });
        return [];
      }
    };
    const finalizeExperienceLearning = async (): Promise<LoopIterationResult> => {
      await recordExperienceLearningCheckpoint({
        bridge: this.deps.deps.experienceLearningBridge,
        goal: goalForExperienceLearning,
        goalId,
        ...(runtimeEvidenceScope.run_id ? { runId: runtimeEvidenceScope.run_id } : {}),
        loopIndex,
        result,
        iterationEvidence,
        dryRun: config.dryRun,
        hasEvidenceLedger: Boolean(this.deps.deps.evidenceLedger),
        logger: this.deps.logger,
      });
      return result;
    };
    const consumerScope = (phase: string): LearningScope => ({
      refs: {
        goalId,
        ...(runtimeEvidenceScope.run_id ? { runId: runtimeEvidenceScope.run_id } : {}),
      },
      semantic: {
        taskKind: phase,
        environmentKind: "pulseed_runtime",
        classifierVersion: "deterministic/learning-prior-consumer/v1",
        confidence: 1,
      },
    });
    const resolveLearningProjection = async (
      consumerPhase: LearningConsumerPhase,
      consumerDecisionRef: string,
    ) => {
      if (config.dryRun || !this.deps.deps.experienceLearningStore) return null;
      try {
        return await this.deps.deps.experienceLearningStore.resolvePriorForPhase({
          goalId,
          ...(runtimeEvidenceScope.run_id ? { runId: runtimeEvidenceScope.run_id } : {}),
          consumerPhase,
          consumerScope: consumerScope(consumerPhase),
          loopIndex,
          consumerAttemptId: `${consumerPhase}:${goalId}:${loopIndex}`,
          consumerDecisionRef,
        });
      } catch (err) {
        this.deps.logger?.warn("CoreLoop: failed to resolve experience-learning prior", {
          goalId,
          loopIndex,
          consumerPhase,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    };
    const markLearningProjectionApplied = async (
      projection: LearningPriorPhaseProjection | null | undefined,
      generatedDecisionRefs: readonly string[],
    ): Promise<void> => {
      if (!projection || !this.deps.deps.experienceLearningStore) return;
      try {
        await this.deps.deps.experienceLearningStore.markPriorConsumptionApplied({
          consumptionId: projection.consumptionRecordId,
          generatedDecisionRefs,
        });
      } catch (err) {
        this.deps.logger?.warn("CoreLoop: failed to mark experience-learning prior applied", {
          goalId,
          loopIndex,
          consumptionRecordId: projection.consumptionRecordId,
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
    if (!loadedGoal) return await finalizeExperienceLearning();
    let goal = loadedGoal;
    goalForExperienceLearning = goal;

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
        goalForExperienceLearning = goal;
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
      if (shouldSkip) return await finalizeExperienceLearning();
    }

    const gapResult = await runPhase("gap-analysis", () =>
      calculateGapOrComplete(ctx, goalId, goal, loopIndex, result, startTime)
    );
    if (!gapResult) return await finalizeExperienceLearning();
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
      return await finalizeExperienceLearning();
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
      return await finalizeExperienceLearning();
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
      if (!driveResult) return await finalizeExperienceLearning();
      driveScores = driveResult.driveScores;
      highDissatisfactionDimensions = driveResult.highDissatisfactionDimensions;
    }

    const knowledgeRefreshResolution = !skipTaskGeneration
      ? await resolveLearningProjection(
          "knowledge_refresh",
          `knowledge-refresh:${goalId}:${loopIndex}`,
        )
      : null;
    const knowledgeRefreshProjection = isLearningProjectionPhase(knowledgeRefreshResolution?.projection, "knowledge_refresh")
      ? knowledgeRefreshResolution.projection
      : undefined;
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
              ...(knowledgeRefreshProjection ? { learningProjection: knowledgeRefreshProjection } : {}),
            },
            { goalId, gapAggregate },
          )
        )
      : null;
    if (knowledgeRefresh) rememberPhase(knowledgeRefresh);
    if (knowledgeRefresh && knowledgeRefresh.status !== "skipped") {
      await markLearningProjectionApplied(knowledgeRefreshProjection, [
        knowledgeRefresh.traceId ?? `knowledge-refresh:${goalId}:${loopIndex}`,
      ]);
    }
    if (knowledgeRefresh) await appendPhaseEvidence(appendRuntimeEvidence, knowledgeRefresh, "strategy");

    const shouldRunReplanningOptions = this.deps.coreDecisionEngine.shouldRunReplanningOptions({
      skipTaskGeneration: Boolean(skipTaskGeneration),
      taskCycleBlocked: false,
      gapAggregate,
    });
    const replanningOptionsResolution = shouldRunReplanningOptions
      ? await resolveLearningProjection(
          "replanning_options",
          `replanning-options:${goalId}:${loopIndex}`,
        )
      : null;
    const replanningOptionsProjection = isLearningProjectionPhase(replanningOptionsResolution?.projection, "replanning_options")
      ? replanningOptionsResolution.projection
      : undefined;
    const replanningOptions = shouldRunReplanningOptions
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
              ...(replanningOptionsProjection ? { learningProjection: replanningOptionsProjection } : {}),
            },
            { goalId, gapAggregate },
          )
        )
      : null;
    if (replanningOptions) rememberPhase(replanningOptions);
    if (replanningOptions && replanningOptions.status !== "skipped") {
      await markLearningProjectionApplied(replanningOptionsProjection, [
        replanningOptions.traceId ?? `replanning-options:${goalId}:${loopIndex}`,
      ]);
    }
    if (replanningOptions) await appendPhaseEvidence(appendRuntimeEvidence, replanningOptions, "strategy");

    await runPhase("completion-check", () =>
      checkCompletionAndMilestones(ctx, goalId, goal, result, startTime)
    );
    if (result.error) return await finalizeExperienceLearning();

    const stallActionHints = this.deps.coreDecisionEngine.buildStallActionHints({
      phase: replanningOptions,
    });
    const stallDetectionResolution = await resolveLearningProjection(
      "stall_detection",
      `stall-detection:${goalId}:${loopIndex}`,
    );
    const stallDetectionProjection = isLearningProjectionPhase(stallDetectionResolution?.projection, "stall_detection")
      ? stallDetectionResolution.projection
      : undefined;
    const baseStallActionHints = stallActionHints.recommendedAction
      ? stallActionHints
      : pendingDirective?.preferredAction
        ? { recommendedAction: pendingDirective.preferredAction }
        : undefined;
    const mergedStallActionHints = stallDetectionProjection
      ? {
          ...baseStallActionHints,
          learningProjection: stallDetectionProjection,
          learningPriorConsumptionRef: stallDetectionProjection.consumptionRecordId,
        }
      : baseStallActionHints;
    await runPhase("stall-detection", () =>
      detectStallsAndRebalance(
        ctx,
        goalId,
        goal,
        result,
        mergedStallActionHints,
      )
    );
    await markLearningProjectionApplied(stallDetectionProjection, [
      `stall-detection:${goalId}:${loopIndex}`,
    ]);
    const shouldRunStallInvestigation = this.deps.coreDecisionEngine.shouldRunStallInvestigation(result);
    const stallInvestigationResolution = shouldRunStallInvestigation
      ? await resolveLearningProjection(
          "stall_investigation",
          `stall-investigation:${goalId}:${loopIndex}`,
        )
      : null;
    const stallInvestigationProjection = isLearningProjectionPhase(stallInvestigationResolution?.projection, "stall_investigation")
      ? stallInvestigationResolution.projection
      : undefined;
    const stallInvestigation = shouldRunStallInvestigation
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
              ...(stallInvestigationProjection ? { learningProjection: stallInvestigationProjection } : {}),
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
    if (stallInvestigation && stallInvestigation.status !== "skipped") {
      await markLearningProjectionApplied(stallInvestigationProjection, [
        stallInvestigation.traceId ?? `stall-investigation:${goalId}:${loopIndex}`,
      ]);
    }
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
          return await finalizeExperienceLearning();
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
          return await finalizeExperienceLearning();
        }
      } catch (err) {
        this.deps.logger?.warn("CoreLoop: autoAcquireKnowledge failed (non-fatal)", {
          goalId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (skipTaskGeneration) {
      const learningDirectiveResolution = await resolveLearningProjection(
        "next_iteration_directive",
        `next-directive:${goalId}:${loopIndex}:skip`,
      );
      const learningDirectiveProjection = learningDirectiveResolution?.projection?.phase === "next_iteration_directive"
        ? learningDirectiveResolution.projection
        : undefined;
      result.nextIterationDirective = this.deps.coreDecisionEngine.buildNextIterationDirective({
        learningProjection: learningDirectiveProjection,
        knowledgeRefreshPhase: knowledgeRefresh,
        replanningPhase: replanningOptions,
        goalDimensions: goal.dimensions.map((dimension) => dimension.name),
        fallbackFocusDimension: driveScores[0]?.dimension_name ?? pendingDirective?.focusDimension,
      });
      if (learningDirectiveProjection && result.nextIterationDirective) {
        await markLearningProjectionApplied(learningDirectiveProjection, [
          result.nextIterationDirective.phase_projection_ref ?? `next-directive:${goalId}:${loopIndex}:skip`,
        ]);
      }
      await appendDecisionEvidence(appendRuntimeEvidence, result.nextIterationDirective, "skip_task_generation");
      await generateLoopReport(goalId, loopIndex, result, goal, this.deps.deps.reportingEngine, this.deps.logger);
      result.elapsedMs = Date.now() - startTime;
      return await finalizeExperienceLearning();
    }

    if (checkDependencyBlock(ctx, goalId, result)) return await finalizeExperienceLearning();

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
    if (tookParallelPath) return await finalizeExperienceLearning();

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
    const taskLearningResolution = await resolveLearningProjection(
      "task_generation",
      `task-generation:${goalId}:${loopIndex}`,
    );
    const taskLearningProjection = taskLearningResolution?.projection?.phase === "task_generation"
      ? taskLearningResolution.projection
      : undefined;
    const mergedTaskGenerationHints = {
      targetDimensionOverride: taskLearningProjection?.preferredTargetDimension
        ?? taskGenerationHints.targetDimensionOverride
        ?? pendingDirective?.focusDimension,
      knowledgeContextPrefix: taskGenerationHints.knowledgeContextPrefix,
      ...(taskLearningProjection
        ? {
            learningProjection: taskLearningProjection,
            learningPriorConsumptionRef: taskLearningProjection.consumptionRecordId,
          }
        : {}),
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
    if (!taskCycleOk) return await finalizeExperienceLearning();

    const completedTaskResult = result.taskResult;
    if (completedTaskResult && taskLearningProjection) {
      await markLearningProjectionApplied(taskLearningProjection, [
        `task:${completedTaskResult.task.id}`,
      ]);
    }
    if (completedTaskResult) {
      await appendTaskCycleEvidence(appendRuntimeEvidence, completedTaskResult);
    }
    if (
      completedTaskResult
      && taskLearningProjection?.requiredExperimentPlanIds.length
      && this.deps.deps.experienceLearningStore
      && iterationEvidence.length > 0
    ) {
      try {
        const experimentPlanId = taskLearningProjection.requiredExperimentPlanIds[0]!;
        const experimentPlan = (await this.deps.deps.experienceLearningStore.listExperimentPlans(goalId))
          .find((plan) => plan.id === experimentPlanId) ?? null;
        const experimentClosedPayload = buildExperimentRecordClosedPayload({
          goalId,
          runId: runtimeEvidenceScope.run_id,
          loopIndex,
          taskResult: completedTaskResult,
          planId: experimentPlanId,
          plan: experimentPlan,
          evidenceRefs: iterationEvidence.map((entry) => entry.id),
          eventRefs: iterationEvidence.flatMap((entry) =>
            entry.raw_refs
              .filter((ref) => ref.kind === "runtime_event")
              .map((ref) => ref.id)
              .filter((ref): ref is string => typeof ref === "string" && ref.length > 0)
          ),
        });
        await this.deps.deps.experienceLearningStore.appendLifecycleEvent(experimentClosedPayload);
        const postOutcomePayloads = await buildPostExperimentOutcomePayloads({
          store: this.deps.deps.experienceLearningStore,
          experimentClosedPayload,
        });
        for (const payload of postOutcomePayloads) {
          await this.deps.deps.experienceLearningStore.appendLifecycleEvent(payload);
          if (
            payload.event_kind === "artifact_transitioned"
            && payload.artifact?.status === "promoted"
            && this.deps.deps.cognitionWritebackQueue
          ) {
            await enqueueExperienceLearningProjectionForOwnerReview({
              artifact: payload.artifact,
              learningStore: this.deps.deps.experienceLearningStore,
              queueStore: this.deps.deps.cognitionWritebackQueue,
              createdAt: payload.artifact.updatedAt,
            });
          }
        }
      } catch (err) {
        this.deps.logger?.warn("CoreLoop: failed to close experience-learning experiment record", {
          goalId,
          loopIndex,
          planId: taskLearningProjection.requiredExperimentPlanIds[0],
          error: err instanceof Error ? err.message : String(err),
        });
      }
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

    const learningDirectiveResolution = await resolveLearningProjection(
      "next_iteration_directive",
      `next-directive:${goalId}:${loopIndex}`,
    );
    const learningDirectiveProjection = learningDirectiveResolution?.projection?.phase === "next_iteration_directive"
      ? learningDirectiveResolution.projection
      : undefined;
    result.nextIterationDirective = this.deps.coreDecisionEngine.buildNextIterationDirective({
      learningProjection: learningDirectiveProjection,
      knowledgeRefreshPhase: knowledgeRefresh,
      replanningPhase: replanningOptions,
      goalDimensions: goal.dimensions.map((dimension) => dimension.name),
      fallbackFocusDimension: driveScores[0]?.dimension_name ?? pendingDirective?.focusDimension,
    });
    if (learningDirectiveProjection && result.nextIterationDirective) {
      await markLearningProjectionApplied(learningDirectiveProjection, [
        result.nextIterationDirective.phase_projection_ref ?? `next-directive:${goalId}:${loopIndex}`,
      ]);
    }
    await appendDecisionEvidence(appendRuntimeEvidence, result.nextIterationDirective, "next_iteration_directive");

    await generateLoopReport(goalId, loopIndex, result, goal, this.deps.deps.reportingEngine, this.deps.logger);

    result.elapsedMs = Date.now() - startTime;
    return await finalizeExperienceLearning();
  }
}

function buildExperimentRecordClosedPayload(input: {
  goalId: string;
  runId?: string;
  loopIndex: number;
  taskResult: TaskCycleResult;
  planId: string;
  plan?: LearningExperimentPlan | null;
  evidenceRefs: readonly string[];
  eventRefs: readonly string[];
}): Extract<ExperienceLearningRuntimeEventPayload, { event_kind: "experiment_record_closed" }> {
  const now = new Date().toISOString();
  const recordId = stableLearningId("learning-experiment-record", [
    input.planId,
    input.taskResult.task.id,
    input.loopIndex,
  ]);
  const valueOutcomeId = stableLearningId("learning-experiment-value-outcome", [recordId]);
  const outcome = input.taskResult.action === "completed" && input.taskResult.verificationResult.verdict === "pass"
    ? "supported"
    : input.taskResult.verificationResult.verdict === "fail"
      ? "falsified"
      : "inconclusive";
  const testedGeneralizationCandidateIds = input.plan?.generalizationCandidateIds ?? [];
  const eliminatedHypothesisIds = outcome === "falsified" ? input.plan?.hypothesisIds ?? [] : [];
  const trust = defaultRuntimeEvidenceTrust({
    targetRef: {
      kind: "experiment_record",
      id: recordId,
      scope: {
        goal_id: input.goalId,
        ...(input.runId ? { run_id: input.runId } : {}),
      },
    },
    provenanceRefs: input.evidenceRefs,
    sourceAuthority: "verified_execution",
  });
  const record = ExperimentRecordSchema.parse({
    id: recordId,
    planId: input.planId,
    goalId: input.goalId,
    ...(input.runId ? { runId: input.runId } : {}),
    loopIndex: input.loopIndex,
    taskId: input.taskResult.task.id,
    actionRefs: [`task:${input.taskResult.task.id}`],
    executedAt: now,
    outcome,
    outcomeEvidenceRefs: [...input.evidenceRefs],
    outcomeEventRefs: [...input.eventRefs],
    outcomeRuntimeGraphRefs: [],
    eliminatedHypothesisIds,
    testedGeneralizationCandidateIds,
    narrowedGeneralizationCandidateIds: outcome === "falsified" ? testedGeneralizationCandidateIds : [],
    negativeTransferRefs: outcome === "falsified" ? [...input.evidenceRefs] : [],
    followUpFrameIds: [],
    trust,
  });
  const valueOutcome = ExperimentValueOutcomeSchema.parse({
    id: valueOutcomeId,
    planId: input.planId,
    recordId,
    realizedInformationGain: outcome === "inconclusive" ? 0.2 : 0.7,
    eliminatedHypothesisIds,
    eliminatedHypothesisCount: eliminatedHypothesisIds.length,
    actualCost: "low",
    actualRisk: "low",
    actualTimeToSignal: "same_iteration",
    transferOutcome: outcome === "supported" ? "exact_success" : outcome === "falsified" ? "negative_transfer" : "inconclusive",
    calibrationError: outcome === "inconclusive" ? 0.3 : 0.1,
    outcomeEvidenceRefs: [...input.evidenceRefs],
  });
  return {
    schema_version: "runtime-event-payload/experience-learning/v1",
    event_kind: "experiment_record_closed",
    idempotency_key: `experience-learning:experiment-record:${recordId}`,
    goal_id: input.goalId,
    ...(input.runId ? { run_id: input.runId } : {}),
    loop_index: input.loopIndex,
    source_refs: {
      evidence_refs: [...input.evidenceRefs],
      event_refs: [...input.eventRefs],
      runtime_graph_refs: [],
    },
    trust,
    correction_state: trust.correctionState,
    redaction_class: "refs_only",
    graph: {
      node_refs: [
        { kind: "learning_experiment_record", ref: recordId },
        { kind: "learning_experiment_plan", ref: input.planId },
      ],
      edge_refs: [],
    },
    record_id: recordId,
    plan_id: input.planId,
    outcome,
    value_outcome_id: valueOutcomeId,
    record,
    value_outcome: valueOutcome,
  };
}

async function buildPostExperimentOutcomePayloads(input: {
  store: ExperienceLearningStateStore;
  experimentClosedPayload: Extract<ExperienceLearningRuntimeEventPayload, { event_kind: "experiment_record_closed" }>;
}): Promise<ExperienceLearningRuntimeEventPayload[]> {
  const record = input.experimentClosedPayload.record;
  const valueOutcome = input.experimentClosedPayload.value_outcome;
  if (!record || !valueOutcome) return [];

  const plans = await input.store.listExperimentPlans(record.goalId);
  const plan = plans.find((candidate) => candidate.id === record.planId);
  const candidateId = plan?.generalizationCandidateIds[0];
  if (!plan || !candidateId) return [];

  const candidates = await input.store.listGeneralizationCandidates(record.goalId);
  const candidate = candidates.find((item) => item.id === candidateId);
  if (!candidate || (candidate.status !== "trial_reuse_ready" && candidate.status !== "strengthened")) return [];

  const artifacts = await input.store.listArtifacts(record.goalId);
  const previousArtifact = artifacts.find((artifact) =>
    artifact.evidence.generalizationCandidateIds.includes(candidate.id)
    && (artifact.status === "trial_reuse_ready" || artifact.status === "strengthened" || artifact.status === "tentative")
  ) ?? null;

  const outcomeEventRefs = input.experimentClosedPayload.source_refs.event_refs;
  if (record.outcome === "supported" && valueOutcome.transferOutcome === "exact_success") {
    const promotedCandidate = promoteCandidateFromExperiment(candidate, record);
    const promotedArtifact = buildPostExperimentArtifact({
      candidate: promotedCandidate,
      previousArtifact,
      record,
      valueOutcome,
      status: "promoted",
    });
    const promotedPrior = buildPostExperimentPrior({
      artifact: promotedArtifact,
      candidate: promotedCandidate,
      plan,
      record,
    });
    return [
      generalizationPostOutcomePayload({ candidate: promotedCandidate, fromStatus: candidate.status, eventRefs: outcomeEventRefs, record, reasonCode: "experiment_supported_promotion" }),
      artifactPostOutcomePayload({ artifact: promotedArtifact, fromStatus: previousArtifact?.status ?? null, eventRefs: outcomeEventRefs, record, reasonCode: "pre_registered_experiment_supported" }),
      priorPostOutcomePayload({ prior: promotedPrior, eventRefs: outcomeEventRefs, record }),
    ];
  }

  if (record.outcome === "falsified" || valueOutcome.transferOutcome === "negative_transfer") {
    const narrowedCandidate = narrowCandidateFromExperiment(candidate, record);
    const narrowedArtifact = buildPostExperimentArtifact({
      candidate: narrowedCandidate,
      previousArtifact,
      record,
      valueOutcome,
      status: "narrowed",
    });
    return [
      generalizationPostOutcomePayload({ candidate: narrowedCandidate, fromStatus: candidate.status, eventRefs: outcomeEventRefs, record, reasonCode: "negative_transfer_narrowed_scope" }),
      artifactPostOutcomePayload({ artifact: narrowedArtifact, fromStatus: previousArtifact?.status ?? null, eventRefs: outcomeEventRefs, record, reasonCode: "negative_transfer_narrowed_scope" }),
    ];
  }

  return [];
}

function promoteCandidateFromExperiment(
  candidate: GeneralizationCandidate,
  record: ExperimentRecord,
): GeneralizationCandidate {
  const exactScopeRef = `goal:${candidate.goalId}`;
  return GeneralizationCandidateSchema.parse({
    ...candidate,
    status: "promoted",
    supportRefs: uniqueStrings([...candidate.supportRefs, record.id, ...record.outcomeEvidenceRefs]),
    transferScopes: candidate.transferScopes.map((scope) => ({
      ...scope,
      status: scope.scopeRef === exactScopeRef && scope.status !== "blocked" ? "exact" : scope.status,
      attempts: scope.scopeRef === exactScopeRef ? Math.min(scope.maxTrials, scope.attempts + 1) : scope.attempts,
      successRefs: scope.scopeRef === exactScopeRef ? uniqueStrings([...scope.successRefs, record.id]) : scope.successRefs,
    })),
    updatedAt: record.executedAt,
  });
}

function narrowCandidateFromExperiment(
  candidate: GeneralizationCandidate,
  record: ExperimentRecord,
): GeneralizationCandidate {
  return GeneralizationCandidateSchema.parse({
    ...candidate,
    status: "narrowed",
    counterexampleRefs: uniqueStrings([...candidate.counterexampleRefs, record.id, ...record.outcomeEvidenceRefs]),
    transferScopes: candidate.transferScopes.map((scope) => ({
      ...scope,
      status: "narrowed",
      attempts: Math.min(scope.maxTrials, scope.attempts + 1),
      negativeTransferRefs: uniqueStrings([...scope.negativeTransferRefs, record.id, ...record.negativeTransferRefs]),
      narrowedAt: record.executedAt,
    })),
    updatedAt: record.executedAt,
  });
}

function buildPostExperimentArtifact(input: {
  candidate: GeneralizationCandidate;
  previousArtifact: LearningArtifact | null;
  record: ExperimentRecord;
  valueOutcome: ExperimentValueOutcome;
  status: "promoted" | "narrowed";
}): LearningArtifact {
  const sourceEvidenceRefs = uniqueStrings([
    ...(input.previousArtifact?.evidence.runtimeEvidenceRefs ?? []),
    ...input.candidate.supportRefs,
    ...input.record.outcomeEvidenceRefs,
  ]);
  const artifactId = input.previousArtifact?.id ?? stableLearningId("learning-artifact", [input.candidate.id, input.status]);
  const targetDimension = targetDimensionFromCandidate(input.candidate);
  return LearningArtifactSchema.parse({
    id: artifactId,
    sourceGoalId: input.candidate.goalId,
    ...(input.candidate.runId ? { sourceRunId: input.candidate.runId } : {}),
    kind: "generalization_candidate",
    summary: redactedLearningLabel({
      label: `${input.status} reusable structure after ${input.valueOutcome.transferOutcome}`,
      sourceRefs: sourceEvidenceRefs,
      maxLength: 160,
    }),
    scope: input.candidate.scope,
    evidence: {
      frameIds: input.previousArtifact?.evidence.frameIds ?? input.candidate.invariantRefs,
      hypothesisIds: input.previousArtifact?.evidence.hypothesisIds ?? input.candidate.sourceHypothesisIds,
      generalizationCandidateIds: [input.candidate.id],
      experimentPlanIds: uniqueStrings([...(input.previousArtifact?.evidence.experimentPlanIds ?? []), input.record.planId]),
      experimentRecordIds: uniqueStrings([...(input.previousArtifact?.evidence.experimentRecordIds ?? []), input.record.id]),
      runtimeEvidenceRefs: sourceEvidenceRefs,
    },
    confidence: input.status === "promoted" ? 0.74 : 0.42,
    status: input.status,
    trust: input.candidate.trust,
    correctionState: input.candidate.correctionState,
    policyEffect: input.status === "promoted"
      ? promotedArtifactSuggestions({
          artifactId,
          candidate: input.candidate,
          targetDimension,
          sourceEvidenceRefs,
          expiresAt: new Date(Date.parse(input.record.executedAt) + 7 * 24 * 60 * 60 * 1000).toISOString(),
        })
      : [],
    guardrails: {
      authorityClass: "planning_hint_only",
      cannotGrantAuthority: true,
      requiresFreshEvidenceBeforePromotion: input.status !== "promoted",
      contradictionRefs: input.status === "narrowed" ? input.record.outcomeEvidenceRefs : [],
      falsificationPlanRefs: uniqueStrings([...(input.previousArtifact?.guardrails.falsificationPlanRefs ?? []), input.record.planId]),
    },
    createdAt: input.previousArtifact?.createdAt ?? input.record.executedAt,
    updatedAt: input.record.executedAt,
  });
}

function promotedArtifactSuggestions(input: {
  artifactId: string;
  candidate: GeneralizationCandidate;
  targetDimension: string;
  sourceEvidenceRefs: string[];
  expiresAt: string;
}): LearningArtifact["policyEffect"] {
  return [
    learningPriorSuggestion({
      id: stableLearningId("learning-prior-suggestion", [input.artifactId, "post-experiment-task-generation"]),
      kind: "strategy_preference",
      consumerPhase: "task_generation",
      targetRef: { kind: "dimension", id: input.targetDimension },
      rationale: redactedLearningLabel({
        label: "Apply the promoted experiment-backed learning structure as a bounded task-generation bias",
        sourceRefs: input.sourceEvidenceRefs,
        maxLength: 180,
      }),
      sourceArtifactIds: [input.artifactId],
      experimentPlanIds: input.candidate.transferScopes.flatMap((scope) => scope.successRefs),
      evidenceRefs: input.sourceEvidenceRefs,
      strength: 0.6,
      risk: "low",
      expiresAt: input.expiresAt,
      maxUses: 1,
      sourceContext: { kind: "non_user_context", requestedUseClass: "goal_planning" },
    }),
    learningPriorSuggestion({
      id: stableLearningId("learning-prior-suggestion", [input.artifactId, "post-experiment-next-directive"]),
      kind: "phase_focus",
      consumerPhase: "next_iteration_directive",
      targetRef: { kind: "dimension", id: input.targetDimension },
      rationale: redactedLearningLabel({
        label: "Focus the next directive on the promoted experiment-backed learning structure",
        sourceRefs: input.sourceEvidenceRefs,
        maxLength: 180,
      }),
      sourceArtifactIds: [input.artifactId],
      experimentPlanIds: input.candidate.transferScopes.flatMap((scope) => scope.successRefs),
      evidenceRefs: input.sourceEvidenceRefs,
      strength: 0.5,
      risk: "low",
      expiresAt: input.expiresAt,
      maxUses: 1,
      sourceContext: { kind: "non_user_context", requestedUseClass: "goal_planning" },
    }),
  ];
}

function buildPostExperimentPrior(input: {
  artifact: LearningArtifact;
  candidate: GeneralizationCandidate;
  plan: LearningExperimentPlan;
  record: ExperimentRecord;
}): LearningPriorSnapshot {
  const id = stableLearningId("learning-prior", [input.artifact.id, "post-experiment", input.record.id]);
  return LearningPriorSnapshotSchema.parse({
    id,
    goalId: input.artifact.sourceGoalId,
    ...(input.artifact.sourceRunId ? { runId: input.artifact.sourceRunId } : {}),
    generatedAt: input.record.executedAt,
    sourceLoopIndex: input.record.loopIndex ?? 0,
    eligibleFromIteration: (input.record.loopIndex ?? 0) + 1,
    generationEventRef: `runtime-event-projection:experience-learning:${id}`,
    sourceCandidateTransitionIds: [stableLearningId("candidate-transition", [input.candidate.id, "promoted", input.record.id])],
    scope: input.candidate.scope,
    compatibility: {
      decision: "compatible",
      reasonCode: "matched_exact_refs",
      matchedRefs: [`goalId:${input.artifact.sourceGoalId}`],
      missingRefs: [],
    },
    sourceArtifactIds: [input.artifact.id],
    suggestions: input.artifact.policyEffect.map((suggestion) => ({
      ...suggestion,
      experimentPlanIds: uniqueStrings([...suggestion.experimentPlanIds, input.plan.id]),
    })),
    staleOrFalsifiedArtifactIds: [],
    suppressedByCorrectionIds: [],
    suppressedByQuarantineIds: [],
    trust: input.artifact.trust,
    sourceTrustStates: [{ sourceRef: input.artifact.id, trust: input.artifact.trust }],
    filterDecision: {
      decision: "activated",
      reasonCodes: ["eligible"],
      evaluatedAt: input.record.executedAt,
    },
    confidence: 0.68,
    traceRef: `experience-learning-prior:${id}`,
  });
}

function generalizationPostOutcomePayload(input: {
  candidate: GeneralizationCandidate;
  fromStatus: GeneralizationCandidate["status"];
  eventRefs: readonly string[];
  record: ExperimentRecord;
  reasonCode: string;
}): Extract<ExperienceLearningRuntimeEventPayload, { event_kind: "generalization_transitioned" }> {
  return {
    ...postExperimentPayloadBase({
      idempotencyKey: `experience-learning:generalization:${input.candidate.id}:${input.candidate.status}:${input.record.id}`,
      goalId: input.candidate.goalId,
      runId: input.candidate.runId,
      loopIndex: input.record.loopIndex,
      evidenceRefs: input.record.outcomeEvidenceRefs,
      eventRefs: input.eventRefs,
      trust: input.candidate.trust,
      graphNodeRefs: [{ kind: "generalization_candidate", ref: input.candidate.id }],
    }),
    event_kind: "generalization_transitioned",
    generalization_id: input.candidate.id,
    body_kind: input.candidate.body.kind,
    transfer_scope_refs: input.candidate.transferScopes.map((scope) => scope.scopeRef),
    from_status: input.fromStatus,
    to_status: input.candidate.status,
    reason_code: input.reasonCode,
    generalization: input.candidate,
  };
}

function artifactPostOutcomePayload(input: {
  artifact: LearningArtifact;
  fromStatus: LearningArtifact["status"] | null;
  eventRefs: readonly string[];
  record: ExperimentRecord;
  reasonCode: string;
}): Extract<ExperienceLearningRuntimeEventPayload, { event_kind: "artifact_transitioned" }> {
  return {
    ...postExperimentPayloadBase({
      idempotencyKey: `experience-learning:artifact:${input.artifact.id}:${input.artifact.status}:${input.record.id}`,
      goalId: input.artifact.sourceGoalId,
      runId: input.artifact.sourceRunId,
      loopIndex: input.record.loopIndex,
      evidenceRefs: input.artifact.evidence.runtimeEvidenceRefs,
      eventRefs: input.eventRefs,
      trust: input.artifact.trust,
      graphNodeRefs: [{ kind: "learning_artifact", ref: input.artifact.id }],
    }),
    event_kind: "artifact_transitioned",
    artifact_id: input.artifact.id,
    source_candidate_ids: input.artifact.evidence.generalizationCandidateIds,
    from_status: input.fromStatus,
    to_status: input.artifact.status,
    reason_code: input.reasonCode,
    artifact: input.artifact,
  };
}

function priorPostOutcomePayload(input: {
  prior: LearningPriorSnapshot;
  eventRefs: readonly string[];
  record: ExperimentRecord;
}): Extract<ExperienceLearningRuntimeEventPayload, { event_kind: "prior_generated" }> {
  return {
    ...postExperimentPayloadBase({
      idempotencyKey: `experience-learning:prior-generated:${input.prior.id}`,
      goalId: input.prior.goalId,
      runId: input.prior.runId,
      loopIndex: input.record.loopIndex,
      evidenceRefs: input.prior.suggestions.flatMap((suggestion) => suggestion.evidenceRefs),
      eventRefs: input.eventRefs,
      trust: input.prior.trust,
      graphNodeRefs: [{ kind: "learning_prior", ref: input.prior.id }],
    }),
    event_kind: "prior_generated",
    prior_id: input.prior.id,
    artifact_ids: input.prior.sourceArtifactIds,
    eligible_from_iteration: input.prior.eligibleFromIteration,
    prior: input.prior,
  };
}

function postExperimentPayloadBase(input: {
  idempotencyKey: string;
  goalId: string;
  runId?: string;
  loopIndex?: number;
  evidenceRefs: readonly string[];
  eventRefs: readonly string[];
  trust: LearningArtifact["trust"];
  graphNodeRefs: Array<{ kind: string; ref: string }>;
}): Omit<ExperienceLearningRuntimeEventPayload, "event_kind"> {
  return {
    schema_version: "runtime-event-payload/experience-learning/v1",
    idempotency_key: input.idempotencyKey,
    goal_id: input.goalId,
    ...(input.runId ? { run_id: input.runId } : {}),
    ...(typeof input.loopIndex === "number" ? { loop_index: input.loopIndex } : {}),
    source_refs: {
      evidence_refs: uniqueStrings([...input.evidenceRefs]),
      event_refs: uniqueStrings([...input.eventRefs]),
      runtime_graph_refs: [],
    },
    trust: input.trust,
    correction_state: input.trust.correctionState,
    redaction_class: "refs_only",
    graph: {
      node_refs: input.graphNodeRefs,
      edge_refs: [],
    },
  } as Omit<ExperienceLearningRuntimeEventPayload, "event_kind">;
}

function targetDimensionFromCandidate(candidate: GeneralizationCandidate): string {
  const proposal = candidate.body.reuseProposal;
  const ref = proposal.strategyBiasRefs[0] ?? proposal.actionBiasRefs[0] ?? candidate.id;
  return ref.startsWith("dimension:") ? ref.slice("dimension:".length) : ref;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

async function appendPublicResearchEvidence(
  appendRuntimeEvidence: (entry: Omit<RuntimeEvidenceEntryInput, "scope"> & { scope?: RuntimeEvidenceEntryInput["scope"] }) => Promise<RuntimeEvidenceEntry[]>,
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
  appendRuntimeEvidence: (entry: Omit<RuntimeEvidenceEntryInput, "scope"> & { scope?: RuntimeEvidenceEntryInput["scope"] }) => Promise<RuntimeEvidenceEntry[]>,
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
  appendRuntimeEvidence: (entry: Omit<RuntimeEvidenceEntryInput, "scope"> & { scope?: RuntimeEvidenceEntryInput["scope"] }) => Promise<RuntimeEvidenceEntry[]>,
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
  appendRuntimeEvidence: (entry: Omit<RuntimeEvidenceEntryInput, "scope"> & { scope?: RuntimeEvidenceEntryInput["scope"] }) => Promise<RuntimeEvidenceEntry[]>,
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
  appendRuntimeEvidence: (entry: Omit<RuntimeEvidenceEntryInput, "scope"> & { scope?: RuntimeEvidenceEntryInput["scope"] }) => Promise<RuntimeEvidenceEntry[]>,
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
