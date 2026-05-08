import type { Goal } from "../../../base/types/goal.js";
import type { DriveScore } from "../../../base/types/drive.js";
import type { DeadlineFinalizationStatus } from "../../../platform/time/deadline-finalization.js";
import type { MetricTrendContext } from "../../../platform/drive/metric-history.js";
import type { RuntimeDreamCheckpointContext } from "../../../runtime/store/dream-checkpoints.js";
import type { RuntimeEvidenceEntry, RuntimeEvidenceSummary, RuntimeFailedLineageContext } from "../../../runtime/store/evidence-ledger.js";
import type {
  DreamReviewActiveHypothesis,
  DreamReviewCheckpointEvidence,
  DreamReviewFailedLineage,
  DreamReviewMemoryRef,
  DreamReviewCheckpointTrigger,
  DreamReviewRejectedApproach,
  DreamRunControlPolicyDecision,
  DreamRunControlRecommendation,
  DreamReviewStrategyCandidate,
} from "./phase-specs.js";
import type { LoopIterationResult } from "../loop-result-types.js";
import type { ExecutionModeState } from "../../../platform/time/execution-mode.js";

export interface DreamReviewCheckpointRequest {
  trigger: DreamReviewCheckpointTrigger;
  reason: string;
  activeDimensions: string[];
  bestEvidenceSummary?: string;
  recentStrategyFamilies: string[];
  metricTrendSummary?: string;
  finalizationReason?: string;
  currentExecutionMode?: ExecutionModeState["mode"];
  activeHypotheses: DreamReviewActiveHypothesis[];
  rejectedApproaches: DreamReviewRejectedApproach[];
  failedLineages: DreamReviewFailedLineage[];
  runControlPolicy: "auto_apply_low_risk_require_approval_for_high_cost_or_irreversible";
  memoryAuthorityPolicy: "soil_and_playbooks_are_advisory_only";
  maxGuidanceItems: number;
}

export interface DreamReviewCheckpointTriggerOptions {
  iterationInterval?: number;
  minIterationsBetween?: number;
}

export interface BuildDreamReviewCheckpointRequestInput {
  goal: Goal;
  loopIndex: number;
  result: LoopIterationResult;
  driveScores: DriveScore[];
  finalizationStatus?: DeadlineFinalizationStatus;
  executionMode?: ExecutionModeState;
  recentCheckpoints?: RuntimeDreamCheckpointContext[];
  evidenceSummary?: Pick<RuntimeEvidenceSummary, "best_evidence" | "recent_entries" | "failed_lineages"> | null;
  requestedTrigger?: DreamReviewCheckpointTrigger;
  options?: DreamReviewCheckpointTriggerOptions;
}

const DEFAULT_ITERATION_INTERVAL = 3;
const DEFAULT_MIN_ITERATIONS_BETWEEN = 2;

export function buildDreamReviewCheckpointRequest(
  input: BuildDreamReviewCheckpointRequestInput
): DreamReviewCheckpointRequest | null {
  const trigger = input.requestedTrigger ?? inferCheckpointTrigger(input);
  if (!trigger) return null;
  if (!rateLimitAllows(input, trigger)) return null;

  const activeDimensions = topDimensions(input.driveScores, input.goal);
  const metricTrendSummary = input.result.metricTrendContext?.summary;
  const activeHypotheses = recentActiveHypotheses(input.recentCheckpoints ?? []);
  const rejectedApproaches = recentRejectedApproaches(input.recentCheckpoints ?? []);
  const failedLineages = repeatedFailedLineages(input.evidenceSummary?.failed_lineages ?? []);
  return {
    trigger,
    reason: reasonForTrigger(trigger, input),
    activeDimensions,
    ...(input.evidenceSummary?.best_evidence ? { bestEvidenceSummary: entrySummary(input.evidenceSummary.best_evidence) } : {}),
    recentStrategyFamilies: recentStrategyFamilies(input.evidenceSummary?.recent_entries ?? []),
    activeHypotheses,
    rejectedApproaches,
    failedLineages,
    ...(metricTrendSummary ? { metricTrendSummary } : {}),
    ...(isPreFinalization(input.finalizationStatus) ? { finalizationReason: input.finalizationStatus?.reason } : {}),
    ...(input.executionMode?.mode ? { currentExecutionMode: input.executionMode.mode } : {}),
    runControlPolicy: "auto_apply_low_risk_require_approval_for_high_cost_or_irreversible",
    memoryAuthorityPolicy: "soil_and_playbooks_are_advisory_only",
    maxGuidanceItems: 3,
  };
}

export function normalizeDreamReviewCheckpoint(
  output: DreamReviewCheckpointEvidence,
  request: DreamReviewCheckpointRequest,
  goal: Goal
): DreamReviewCheckpointEvidence {
  return {
    ...output,
    trigger: output.trigger ?? request.trigger,
    current_goal: output.current_goal || goal.title,
    active_dimensions: output.active_dimensions.length > 0 ? output.active_dimensions : request.activeDimensions,
    relevant_memories: rankDreamReviewMemories(output.relevant_memories, request.maxGuidanceItems),
    active_hypotheses: output.active_hypotheses,
    rejected_approaches: output.rejected_approaches,
    next_strategy_candidates: downrankRepeatedFailedLineageCandidates(
      filterRejectedStrategyCandidates(
        output.next_strategy_candidates,
        output.rejected_approaches.length > 0 ? output.rejected_approaches : request.rejectedApproaches
      ),
      request.failedLineages
    ),
    run_control_recommendations: normalizeRunControlRecommendations(output.run_control_recommendations, request),
    context_authority: "advisory_only",
  };
}

export function formatDreamRunControlRecommendationContext(
  recommendations: DreamRunControlRecommendation[] | undefined
): string | undefined {
  const actionable = (recommendations ?? []).filter((recommendation) =>
    recommendation.policy_decision?.disposition === "auto_apply"
  );
  if (actionable.length === 0) return undefined;

  return [
    "Dream run-control recommendations:",
    ...actionable.slice(0, 5).map((recommendation, index) => {
      const evidence = recommendation.evidence
        .map((item) => `${item.kind}: ${item.summary}`)
        .join("; ");
      const policy = recommendation.policy_decision
        ? `${recommendation.policy_decision.disposition}: ${recommendation.policy_decision.reason}`
        : "advisory_only";
      return [
        `${index + 1}. ${recommendation.action}`,
        `rationale=${recommendation.rationale}`,
        `evidence=${evidence}`,
        `policy=${policy}`,
      ].join(" | ");
    }),
  ].join("\n");
}

function normalizeRunControlRecommendations(
  recommendations: DreamRunControlRecommendation[],
  request: DreamReviewCheckpointRequest
): DreamRunControlRecommendation[] {
  return recommendations.map((recommendation, index) => ({
    ...recommendation,
    id: recommendation.id ?? `${request.trigger}-run-control-${index + 1}`,
    policy_decision: decideRunControlPolicy(recommendation, request),
  }));
}

function rankDreamReviewMemories(
  memories: DreamReviewMemoryRef[],
  admitLimit: number
): DreamReviewMemoryRef[] {
  return memories
    .map((memory) => ({
      ...memory,
      authority: "advisory_only" as const,
      ranking_trace: {
        score: memoryRankScore(memory),
        decision: "admitted" as const,
        reason: memoryRankReason(memory),
      },
    }))
    .sort((a, b) =>
      (b.ranking_trace?.score ?? 0) - (a.ranking_trace?.score ?? 0)
    )
    .map((memory, index) => ({
      ...memory,
      ranking_trace: {
        score: memory.ranking_trace?.score ?? 0,
        decision: index < admitLimit ? "admitted" : "rejected",
        reason: index < admitLimit
          ? memory.ranking_trace?.reason ?? "Ranked into Dream memory context."
          : `Rejected by memory admission cap ${admitLimit}.`,
      },
    }));
}

function memoryRankScore(memory: DreamReviewMemoryRef): number {
  const retrievalKind = memory.retrieval?.kind ?? (memory.source_type === "soil" ? "route_hit" : "checkpoint");
  const routeScore =
    retrievalKind === "route_hit" ? 0.2
      : retrievalKind === "fallback_hit" ? 0.08
        : retrievalKind === "checkpoint" ? 0.05
          : 0;
  const score =
    (memory.relevance_score ?? memory.retrieval?.score ?? 0.5) * 0.35
    + (memory.source_reliability ?? memory.retrieval?.confidence ?? 0.5) * 0.25
    + (memory.prior_success_contribution ?? 0) * 0.2
    + (memory.recency_score ?? 0.5) * 0.1
    + routeScore
    + memoryUsageRankAdjustment(memory.usage_stats);
  return Math.max(0, Math.min(1, Number(score.toFixed(4))));
}

function memoryRankReason(memory: DreamReviewMemoryRef): string {
  const retrievalKind = memory.retrieval?.kind ?? (memory.source_type === "soil" ? "route_hit" : "checkpoint");
  return [
    `kind=${retrievalKind}`,
    `relevance=${memory.relevance_score ?? memory.retrieval?.score ?? "default"}`,
    `reliability=${memory.source_reliability ?? memory.retrieval?.confidence ?? "default"}`,
    `success=${memory.prior_success_contribution ?? 0}`,
    `recency=${memory.recency_score ?? "default"}`,
    `usage_outcome=${memoryUsageRankAdjustment(memory.usage_stats).toFixed(4)}`,
  ].join("; ");
}

function memoryUsageRankAdjustment(usage: DreamReviewMemoryRef["usage_stats"]): number {
  if (!usage) return 0;
  const validatedBoost = Math.min(usage.validated_count, 10) * 0.01;
  const negativePenalty = Math.min(usage.negative_outcome_count, 10) * 0.02;
  return validatedBoost - negativePenalty;
}

function decideRunControlPolicy(
  recommendation: DreamRunControlRecommendation,
  request: DreamReviewCheckpointRequest
): DreamRunControlPolicyDecision {
  if (
    recommendation.approval_required
    || recommendation.risk === "high"
    || recommendation.action === "request_operator_approval"
  ) {
    return {
      disposition: "approval_required",
      reason: "High-cost, irreversible, or explicit operator-approval recommendations cannot be auto-applied.",
    };
  }

  if (recommendation.action === "enter_finalization") {
    if (recommendation.risk !== "low") {
      return {
        disposition: "advisory_only",
        reason: "Only low-risk finalization recommendations are auto-applied as task-generation guidance.",
      };
    }
    const hasDeadlineEvidence = recommendation.evidence.some((evidence) => evidence.kind === "deadline");
    if (request.finalizationReason || hasDeadlineEvidence) {
      return {
        disposition: "auto_apply",
        reason: "Finalization recommendation is backed by deadline-state evidence.",
      };
    }
    return {
      disposition: "approval_required",
      reason: "Entering finalization without deadline evidence requires operator approval.",
    };
  }

  if (recommendation.action === "freeze_experiment_queue") {
    if (recommendation.risk !== "low") {
      return {
        disposition: "advisory_only",
        reason: "Only low-risk queue-freeze recommendations are auto-applied as task-generation guidance.",
      };
    }
    if (request.finalizationReason) {
      return {
        disposition: "auto_apply",
        reason: "Freezing the queue is allowed inside the finalization window.",
      };
    }
    return {
      disposition: "approval_required",
      reason: "Freezing active work outside finalization requires operator approval.",
    };
  }

  if (
    recommendation.action === "widen_exploration"
    && request.trigger === "plateau"
    && recommendation.evidence.some((evidence) => evidence.kind === "lineage" || evidence.kind === "task_history")
  ) {
    return {
      disposition: recommendation.risk === "low" ? "auto_apply" : "advisory_only",
      reason: "Plateau evidence supports feeding divergent exploration guidance into task generation.",
    };
  }

  if (
    recommendation.action === "stay_current_mode"
    || recommendation.action === "consolidate_candidates"
    || recommendation.action === "preserve_near_miss_candidates"
    || recommendation.action === "retire_low_value_lineage"
  ) {
    if (recommendation.risk !== "low") {
      return {
        disposition: "advisory_only",
        reason: "Only low-risk run-control recommendations are auto-applied as task-generation guidance.",
      };
    }
    return {
      disposition: "auto_apply",
      reason: "Low-risk run-control recommendation can be applied as task-generation guidance.",
    };
  }

  return {
    disposition: "advisory_only",
    reason: "Recommendation is preserved for operator/runtime review but is not auto-applied.",
  };
}

export function dreamCheckpointRawRefs(
  output: DreamReviewCheckpointEvidence
): Array<{ kind: string; id?: string }> {
  const memoryRefs = output.relevant_memories
    .map((memory) => memory.ref ? { kind: `dream_${memory.source_type}_memory`, id: memory.ref } : null)
    .filter((ref): ref is { kind: string; id: string } => ref !== null);
  const recommendationEvidenceRefs = output.run_control_recommendations
    .flatMap((recommendation) => recommendation.evidence)
    .map((evidence) => evidence.ref
      ? { kind: `dream_run_control_${evidence.kind}`, id: evidence.ref }
      : null)
    .filter((ref): ref is { kind: string; id: string } => ref !== null);
  const hypothesisRefs = output.active_hypotheses
    .map((hypothesis) => hypothesis.supporting_evidence_ref
      ? { kind: "dream_active_hypothesis_evidence", id: hypothesis.supporting_evidence_ref }
      : null)
    .filter((ref): ref is { kind: string; id: string } => ref !== null);
  const rejectedRefs = output.rejected_approaches
    .map((approach) => approach.evidence_ref
      ? { kind: "dream_rejected_approach_evidence", id: approach.evidence_ref }
      : null)
    .filter((ref): ref is { kind: string; id: string } => ref !== null);
  return [...memoryRefs, ...recommendationEvidenceRefs, ...hypothesisRefs, ...rejectedRefs];
}

function recentActiveHypotheses(checkpoints: RuntimeDreamCheckpointContext[]): DreamReviewActiveHypothesis[] {
  return dedupeByText(
    checkpoints.flatMap((checkpoint) => checkpoint.active_hypotheses ?? []),
    (hypothesis) => hypothesis.hypothesis,
  ).slice(0, 5);
}

function recentRejectedApproaches(checkpoints: RuntimeDreamCheckpointContext[]): DreamReviewRejectedApproach[] {
  return dedupeByText(
    checkpoints.flatMap((checkpoint) => checkpoint.rejected_approaches ?? []),
    (approach) => approach.approach,
  ).slice(0, 8);
}

function repeatedFailedLineages(lineages: RuntimeFailedLineageContext[]): DreamReviewFailedLineage[] {
  return lineages
    .filter((lineage) => lineage.count >= 2)
    .slice(0, 8)
    .map((lineage) => ({
      fingerprint: lineage.fingerprint,
      count: lineage.count,
      last_seen_at: lineage.last_seen_at,
      ...(lineage.strategy_family ? { strategy_family: lineage.strategy_family } : {}),
      ...(lineage.hypothesis ? { hypothesis: lineage.hypothesis } : {}),
      ...(lineage.primary_dimension ? { primary_dimension: lineage.primary_dimension } : {}),
      ...(lineage.task_action ? { task_action: lineage.task_action } : {}),
      ...(lineage.failure_reason ? { failure_reason: lineage.failure_reason } : {}),
      representative_entry_id: lineage.representative_entry_id,
      representative_summary: lineage.representative_summary,
    }));
}

function dedupeByText<T>(items: T[], keyFor: (item: T) => string): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];
  for (const item of items) {
    const key = normalizeApproachText(keyFor(item));
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

function filterRejectedStrategyCandidates(
  candidates: DreamReviewStrategyCandidate[],
  rejectedApproaches: DreamReviewRejectedApproach[]
): DreamReviewStrategyCandidate[] {
  if (rejectedApproaches.length === 0) return candidates;
  return candidates.filter((candidate) =>
    !rejectedApproaches.some((rejected) => rejectedCandidateMatches(candidate, rejected))
  );
}

function downrankRepeatedFailedLineageCandidates(
  candidates: DreamReviewStrategyCandidate[],
  failedLineages: DreamReviewFailedLineage[]
): DreamReviewStrategyCandidate[] {
  if (failedLineages.length === 0) return candidates;
  const allowed: DreamReviewStrategyCandidate[] = [];
  const downranked: DreamReviewStrategyCandidate[] = [];
  for (const candidate of candidates) {
    const lineage = failedLineages.find((item) => failedLineageMatchesCandidate(item, candidate));
    if (!lineage) {
      allowed.push(candidate);
      continue;
    }
    const annotated = {
      ...candidate,
      failed_lineage_warning: {
        fingerprint: lineage.fingerprint,
        count: lineage.count,
        reason: candidate.retry_reason
          ? `Retry override: ${candidate.retry_reason}`
          : `Similar to failed lineage seen ${lineage.count} times: ${lineage.representative_summary}`,
      },
    };
    if (candidate.retry_reason) {
      allowed.push(annotated);
    } else {
      downranked.push(annotated);
    }
  }
  return [...allowed, ...downranked];
}

function failedLineageMatchesCandidate(
  lineage: DreamReviewFailedLineage,
  candidate: DreamReviewStrategyCandidate
): boolean {
  return (candidate.failed_lineage_fingerprints ?? []).includes(lineage.fingerprint);
}

function rejectedCandidateMatches(
  candidate: DreamReviewStrategyCandidate,
  rejected: DreamReviewRejectedApproach
): boolean {
  const candidateText = normalizeApproachText(`${candidate.title} ${candidate.rationale}`);
  const approachText = normalizeApproachText(rejected.approach);
  if (!candidateText || !approachText) return false;
  const matchesApproach = candidateText.includes(approachText) || approachText.includes(candidateText);
  if (!matchesApproach) return false;
  const revisitText = normalizeApproachText(rejected.revisit_condition ?? "");
  return !revisitText || !candidateText.includes(revisitText);
}

function normalizeApproachText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{Letter}\p{Number}]+/gu, " ").trim();
}

function inferCheckpointTrigger(
  input: BuildDreamReviewCheckpointRequestInput
): DreamReviewCheckpointTrigger | null {
  if (isPreFinalization(input.finalizationStatus)) return "pre_finalization";
  if (input.result.metricTrendContext?.trend === "breakthrough") return "breakthrough";
  if (
    input.result.stallDetected
    || input.result.metricTrendContext?.trend === "stalled"
    || input.result.metricTrendContext?.trend === "regressing"
  ) {
    return "plateau";
  }

  const interval = input.options?.iterationInterval ?? DEFAULT_ITERATION_INTERVAL;
  if (interval > 0 && input.loopIndex > 0 && input.loopIndex % interval === 0) return "iteration";
  return null;
}

function isPreFinalization(status: DeadlineFinalizationStatus | undefined): boolean {
  return status?.mode === "finalization" || status?.mode === "missed_deadline";
}

function rateLimitAllows(
  input: BuildDreamReviewCheckpointRequestInput,
  trigger: DreamReviewCheckpointTrigger
): boolean {
  const latest = trigger === "pre_finalization"
    ? input.recentCheckpoints?.find((checkpoint) =>
        checkpoint.trigger === "pre_finalization" && checkpoint.loop_index !== undefined
      )
    : input.recentCheckpoints?.find((checkpoint) => checkpoint.loop_index !== undefined);
  if (!latest || latest.loop_index === undefined) return true;
  const minIterations = input.options?.minIterationsBetween ?? DEFAULT_MIN_ITERATIONS_BETWEEN;
  return input.loopIndex - latest.loop_index >= minIterations;
}

function reasonForTrigger(
  trigger: DreamReviewCheckpointTrigger,
  input: BuildDreamReviewCheckpointRequestInput
): string {
  if (trigger === "pre_finalization") {
    return `Review accumulated evidence before finalization: ${input.finalizationStatus?.reason ?? "deadline finalization is active"}`;
  }
  if (trigger === "breakthrough") {
    return `Metric breakthrough detected: ${input.result.metricTrendContext?.summary ?? "trend improved sharply"}`;
  }
  if (trigger === "plateau") {
    return input.result.metricTrendContext?.summary
      ? `Plateau/regression detected from metric trend: ${input.result.metricTrendContext.summary}`
      : "Progress plateau or stall detected.";
  }
  return `Scheduled iteration checkpoint at loop ${input.loopIndex}.`;
}

function topDimensions(driveScores: DriveScore[], goal: Goal): string[] {
  const scored = driveScores.slice(0, 3).map((score) => score.dimension_name);
  if (scored.length > 0) return scored;
  return goal.dimensions.slice(0, 3).map((dimension) => dimension.name);
}

function recentStrategyFamilies(entries: RuntimeEvidenceEntry[]): string[] {
  const seen = new Set<string>();
  for (const entry of entries) {
    const candidate = entry.strategy ?? entry.task?.action ?? entry.task?.primary_dimension;
    if (!candidate) continue;
    seen.add(candidate);
    if (seen.size >= 5) break;
  }
  return [...seen];
}

function entrySummary(entry: RuntimeEvidenceEntry): string {
  return entry.summary
    ?? entry.result?.summary
    ?? entry.verification?.summary
    ?? entry.decision_reason
    ?? entry.kind;
}
