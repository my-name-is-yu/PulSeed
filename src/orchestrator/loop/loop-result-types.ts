import type { DriveScore } from "../../base/types/drive.js";
import type { CompletionJudgment } from "../../base/types/satisficing.js";
import type { StallAnalysis, StallReport } from "../../base/types/stall.js";
import type { MetricTrendContext } from "../../platform/drive/metric-history.js";
import type { DeadlineFinalizationStatus } from "../../platform/time/deadline-finalization.js";
import type { ExecutionModeState } from "../../platform/time/execution-mode.js";
import type { DreamRunControlRecommendation } from "./durable-loop/phase-specs.js";
import type { TransferCandidate } from "../../base/types/cross-portfolio.js";
import type { WaitExpiryOutcome } from "../../base/types/strategy.js";
import type { RuntimeEvidenceDivergentHypothesis } from "../../runtime/store/evidence-ledger.js";
import type { TaskCycleResult } from "../execution/task/task-execution-types.js";
import type { VerificationLayer1Result } from "./verification-layer1.js";
import type { CorePhaseKind } from "../execution/agent-loop/core-phase-runner.js";
import type { ExperienceLearningBridgeResult } from "./durable-loop/experience-learning-bridge.js";
import type { InteractionPolicyBiasProjection } from "../../runtime/learning/learning-prior.js";

export interface CorePhaseIterationResult {
  phase: CorePhaseKind;
  status: "skipped" | "completed" | "low_confidence" | "failed";
  summary?: string;
  traceId?: string;
  sessionId?: string;
  turnId?: string;
  stopReason?: string;
  lowConfidence?: boolean;
  error?: string;
}

export interface NextIterationDirective {
  sourcePhase: "knowledge_refresh" | "replanning_options" | "stall_investigation" | "learning_prior";
  reason: string;
  focusDimension?: string;
  preferredAction?: "continue" | "refine" | "pivot";
  requestedPhase?: "knowledge_refresh" | "normal";
  learning_prior_consumption_ref?: string;
  phase_projection_ref?: string;
  reason_code?: string;
  focus_refs?: string[];
  inhibition_refs?: string[];
  interaction_policy_biases?: InteractionPolicyBiasProjection[];
}

export interface LoopIterationResult {
  loopIndex: number;
  goalId: string;
  gapAggregate: number;
  driveScores: DriveScore[];
  taskResult: TaskCycleResult | null;
  stallDetected: boolean;
  stallReport: StallReport | null;
  /** M14-S2: cause analysis result when a stall is detected */
  stallAnalysis?: StallAnalysis;
  /** Outcome metric trend that informed stall/recovery decisions. */
  metricTrendContext?: MetricTrendContext;
  /** Curiosity-driven divergent exploration portfolio requested by existing stall recovery. */
  divergentExploration?: {
    trigger: "dimension_stall" | "global_stall" | "predicted_plateau" | "predicted_regression";
    candidates: RuntimeEvidenceDivergentHypothesis[];
    evidenceEntryId?: string;
  };
  /** Deadline-aware finalization planning state for this iteration. */
  finalizationStatus?: DeadlineFinalizationStatus;
  /** Current runtime execution mode and transition evidence for this iteration. */
  executionMode?: ExecutionModeState;
  /** Structured Dream checkpoint run-control recommendations accepted by runtime policy. */
  dreamRunControlRecommendations?: DreamRunControlRecommendation[];
  pivotOccurred: boolean;
  completionJudgment: CompletionJudgment;
  elapsedMs: number;
  error: string | null;
  /** Alerts for milestones that are at_risk or behind (optional) */
  milestoneAlerts?: Array<{ goalId: string; status: string; pace_ratio: number }>;
  /** Transfer candidates detected from cross-goal knowledge (suggestion-only, Phase 1) */
  transfer_candidates?: TransferCandidate[];
  /** Total tokens consumed by LLM calls during this iteration (task generation + verification). */
  tokensUsed?: number;
  /**
   * When true, this iteration was skipped because no meaningful state change was
   * detected (Pillar 2: State Diff + Loop Skip). Only observation ran; gap
   * calculation, task generation, execution, and verification were bypassed.
   */
  skipped?: boolean;
  /** Reason for the skip, when skipped=true. */
  skipReason?: string;
  /** Result from Phase 7 tool-based verification (Layer 1). Present when toolExecutor is set and task has success_criteria. */
  toolVerification?: VerificationLayer1Result;
  /** Tool-based workspace evidence gathered during stall detection (Phase 6). */
  toolStallEvidence?: import("./stall-evidence.js").StallEvidence;
  /** True when stall detection was suppressed by an active WaitStrategy plateau_until. */
  waitSuppressed?: boolean;
  /** True when a WaitStrategy reached its wait_until expiry this iteration. */
  waitExpired?: boolean;
  /** Strategy ID of the active WaitStrategy, if any. */
  waitStrategyId?: string;
  /** True when the iteration observed wait state and intentionally skipped task generation. */
  waitObserveOnly?: boolean;
  /** Full wait expiry decision used by CoreLoop and portfolio rebalance. */
  waitExpiryOutcome?: WaitExpiryOutcome;
  /** Durable approval request id created when wait resume requires approval. */
  waitApprovalId?: string;
  /** Agentic core phase results collected during the iteration. */
  corePhaseResults?: CorePhaseIterationResult[];
  /** Deterministic scheduler directive for the next iteration of the same goal. */
  nextIterationDirective?: NextIterationDirective;
  /** Experience-to-Structure bridge result for exact iteration evidence learning. */
  experienceLearning?: ExperienceLearningBridgeResult;
  /** Exact runtime evidence refs appended during this iteration. */
  iterationEvidenceRefs?: string[];
}

/**
 * Factory that returns a zeroed-out LoopIterationResult for the given goalId
 * and loopIndex. Accepts optional overrides for fields that vary per call-site.
 */
export function makeEmptyIterationResult(
  goalId: string,
  loopIndex: number,
  overrides?: Partial<LoopIterationResult>
): LoopIterationResult {
  return {
    loopIndex,
    goalId,
    gapAggregate: 0,
    driveScores: [],
    taskResult: null,
    stallDetected: false,
    stallReport: null,
    pivotOccurred: false,
    completionJudgment: {
      is_complete: false,
      blocking_dimensions: [],
      low_confidence_dimensions: [],
      needs_verification_task: false,
      checked_at: new Date().toISOString(),
    },
    elapsedMs: 0,
    error: null,
    ...overrides,
  };
}

export interface LoopResult {
  goalId: string;
  totalIterations: number;
  finalStatus: "completed" | "stalled" | "max_iterations" | "error" | "stopped" | "finalization";
  iterations: LoopIterationResult[];
  startedAt: string;
  completedAt: string;
  /** Human-readable explanation when finalStatus is "error" */
  errorMessage?: string;
  /** Total tokens consumed across all iterations */
  tokensUsed?: number;
}
