import type { LoopIterationResult, LoopResult, NextIterationDirective } from "../loop-result-types.js";
import type { KnowledgeRefreshEvidence, ReplanningOptions } from "./phase-specs.js";
import type { LearningPriorPhaseProjection } from "../../../runtime/learning/index.js";

export interface CoreLoopRunCounters {
  consecutiveErrors: number;
  consecutiveDenied: number;
  consecutiveEscalations: number;
}

export interface CoreLoopRunDecision {
  counters: CoreLoopRunCounters;
  shouldStop: boolean;
  finalStatus?: LoopResult["finalStatus"];
}

export interface KnowledgeAcquisitionDecision {
  shouldAcquire: boolean;
  question?: string;
}

export interface TaskGenerationHintsDecision {
  targetDimensionOverride?: string;
  knowledgeContextPrefix?: string;
}

export interface StallActionHintsDecision {
  recommendedAction?: "continue" | "refine" | "pivot";
}

export class CoreDecisionEngine {
  shouldRunStallInvestigation(result: LoopIterationResult): boolean {
    return result.stallDetected && !!result.stallReport;
  }

  shouldRunReplanningOptions(input: {
    skipTaskGeneration: boolean;
    taskCycleBlocked: boolean;
    gapAggregate: number;
  }): boolean {
    return !input.skipTaskGeneration && !input.taskCycleBlocked && input.gapAggregate > 0;
  }

  shouldRunVerificationEvidence(result: LoopIterationResult): boolean {
    return !!result.taskResult;
  }

  evaluateKnowledgeAcquisition(input: {
    phase?: {
      status: "skipped" | "completed" | "low_confidence" | "failed";
      output?: KnowledgeRefreshEvidence;
    } | null;
    hasKnowledgeManager: boolean;
    hasToolExecutor: boolean;
  }): KnowledgeAcquisitionDecision {
    if (!input.hasKnowledgeManager || !input.hasToolExecutor || !input.phase?.output) {
      return { shouldAcquire: false };
    }
    const output = input.phase.output;
    if (input.phase.status === "failed" || input.phase.status === "skipped") {
      return { shouldAcquire: false };
    }
    if (!output.worthwhile || output.confidence < 0.7 || output.required_knowledge.length === 0) {
      return { shouldAcquire: false };
    }
    const question = [
      output.summary,
      ...output.required_knowledge,
      ...output.acquisition_candidates,
    ]
      .filter((value) => typeof value === "string" && value.trim().length > 0)
      .join("\n");
    if (question.length === 0) {
      return { shouldAcquire: false };
    }
    return { shouldAcquire: true, question };
  }

  shouldPreferReplanningContext(input: {
    phase?: {
      status: "skipped" | "completed" | "low_confidence" | "failed";
      output?: ReplanningOptions;
    } | null;
  }): boolean {
    const output = input.phase?.output;
    if (!output) return false;
    return input.phase?.status !== "failed" && output.confidence >= 0.6 && output.candidates.length > 0;
  }

  buildTaskGenerationHints(input: {
    phase?: {
      status: "skipped" | "completed" | "low_confidence" | "failed";
      output?: ReplanningOptions;
    } | null;
    goalDimensions: string[];
  }): TaskGenerationHintsDecision {
    if (!this.shouldPreferReplanningContext({ phase: input.phase })) {
      return {};
    }
    const output = input.phase?.output;
    if (!output) return {};
    const topCandidate = output.candidates[0];
    const matchedDimension = topCandidate?.target_dimensions.find((dimension) =>
      input.goalDimensions.includes(dimension)
    );
    const detailLines = output.candidates.slice(0, 3).map((candidate, index) => {
      const dimensions = candidate.target_dimensions.length > 0
        ? ` dimensions=${candidate.target_dimensions.join(", ")}`
        : "";
      return `${index + 1}. ${candidate.title}${dimensions} | rationale=${candidate.rationale} | evidence_gain=${candidate.expected_evidence_gain} | blast_radius=${candidate.blast_radius}`;
    });
    return {
      ...(matchedDimension ? { targetDimensionOverride: matchedDimension } : {}),
      knowledgeContextPrefix: [
        "Replanning directive:",
        output.summary,
        "Prefer task generation that follows these candidate directions in order:",
        ...detailLines,
        "If a candidate conflicts with current workspace evidence, prefer the smallest verifiable task that preserves the candidate intent.",
      ].join("\n"),
    };
  }

  buildStallActionHints(input: {
    phase?: {
      status: "skipped" | "completed" | "low_confidence" | "failed";
      output?: ReplanningOptions;
    } | null;
  }): StallActionHintsDecision {
    if (!this.shouldPreferReplanningContext({ phase: input.phase })) {
      return {};
    }
    const action = input.phase?.output?.recommended_action;
    return action ? { recommendedAction: action } : {};
  }

  buildNextIterationDirective(input: {
    learningProjection?: Extract<LearningPriorPhaseProjection, { phase: "next_iteration_directive" }>;
    knowledgeRefreshPhase?: {
      status: "skipped" | "completed" | "low_confidence" | "failed";
      output?: KnowledgeRefreshEvidence;
    } | null;
    replanningPhase?: {
      status: "skipped" | "completed" | "low_confidence" | "failed";
      output?: ReplanningOptions;
    } | null;
    goalDimensions: string[];
    fallbackFocusDimension?: string;
  }): NextIterationDirective | undefined {
    const mergeLearningProjection = (directive: NextIterationDirective): NextIterationDirective => {
      if (!input.learningProjection) return directive;
      const projectedFocusDimension = input.learningProjection.preferredFocusDimension
        && input.goalDimensions.includes(input.learningProjection.preferredFocusDimension)
        ? input.learningProjection.preferredFocusDimension
        : undefined;
      return {
        ...directive,
        focusDimension: projectedFocusDimension ?? directive.focusDimension,
        learning_prior_consumption_ref: input.learningProjection.consumptionRecordId,
        phase_projection_ref: `learning-prior-projection:${input.learningProjection.consumptionRecordId}`,
        reason_code: input.learningProjection.projectionKind,
        focus_refs: input.learningProjection.focusRefs,
        inhibition_refs: input.learningProjection.inhibitionRefs,
        interaction_policy_biases: input.learningProjection.interactionPolicyBiases,
      };
    };

    const knowledgeOutput = input.knowledgeRefreshPhase?.output;
    if (
      knowledgeOutput &&
      input.knowledgeRefreshPhase?.status !== "failed" &&
      knowledgeOutput.worthwhile &&
      knowledgeOutput.confidence >= 0.7
    ) {
      return mergeLearningProjection({
        sourcePhase: "knowledge_refresh",
        reason: knowledgeOutput.summary,
        focusDimension: input.fallbackFocusDimension,
        requestedPhase: "knowledge_refresh",
      });
    }

    if (this.shouldPreferReplanningContext({ phase: input.replanningPhase })) {
      const replanningOutput = input.replanningPhase?.output;
      const topCandidate = replanningOutput?.candidates[0];
      const focusDimension = topCandidate?.target_dimensions.find((dimension) =>
        input.goalDimensions.includes(dimension)
      ) ?? input.fallbackFocusDimension;
      return mergeLearningProjection({
        sourcePhase: "replanning_options",
        reason: replanningOutput?.summary ?? "replanning directive",
        focusDimension,
        preferredAction: replanningOutput?.recommended_action,
        requestedPhase: "normal",
      });
    }

    if (input.learningProjection) {
      return mergeLearningProjection({
        sourcePhase: "learning_prior",
        reason: "learning_prior_phase_projection",
        focusDimension: input.fallbackFocusDimension,
        requestedPhase: "normal",
      });
    }

    return undefined;
  }

  evaluateRunDecision(input: {
    iterationResult: LoopIterationResult;
    loopIndex: number;
    minIterations: number;
    maxConsecutiveErrors: number;
    counters: CoreLoopRunCounters;
  }): CoreLoopRunDecision {
    const next: CoreLoopRunCounters = { ...input.counters };
    const taskAction = input.iterationResult.taskResult?.action ?? null;

    if (
      input.iterationResult.finalizationStatus?.mode === "finalization" ||
      input.iterationResult.finalizationStatus?.mode === "missed_deadline"
    ) {
      return { counters: next, shouldStop: true, finalStatus: "finalization" };
    }

    if (input.iterationResult.completionJudgment.is_complete && input.loopIndex >= input.minIterations - 1) {
      return { counters: next, shouldStop: true, finalStatus: "completed" };
    }

    if (input.iterationResult.error !== null) {
      next.consecutiveErrors++;
      if (next.consecutiveErrors >= input.maxConsecutiveErrors) {
        return { counters: next, shouldStop: true, finalStatus: "error" };
      }
    } else {
      next.consecutiveErrors = 0;
    }

    if (taskAction === "approval_denied") {
      next.consecutiveDenied++;
      if (next.consecutiveDenied >= 3) {
        return { counters: next, shouldStop: true, finalStatus: "stopped" };
      }
    } else {
      next.consecutiveDenied = 0;
    }

    if (taskAction === "escalate") {
      next.consecutiveEscalations++;
      if (next.consecutiveEscalations >= 3) {
        return { counters: next, shouldStop: true, finalStatus: "stalled" };
      }
    } else {
      next.consecutiveEscalations = 0;
    }

    if (
      input.iterationResult.stallDetected &&
      input.iterationResult.stallReport &&
      input.iterationResult.stallReport.escalation_level >= 3
    ) {
      return { counters: next, shouldStop: true, finalStatus: "stalled" };
    }

    return { counters: next, shouldStop: false };
  }
}
