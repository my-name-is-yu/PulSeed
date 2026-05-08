import { describe, expect, it } from "vitest";

import { makeGoal } from "../../../../tests/helpers/fixtures.js";
import type { DeadlineFinalizationStatus } from "../../../platform/time/deadline-finalization.js";
import type { MetricTrendContext } from "../../../platform/drive/metric-history.js";
import { makeEmptyIterationResult } from "../loop-result-types.js";
import {
  buildDreamReviewCheckpointRequest,
  dreamCheckpointRawRefs,
  formatDreamRunControlRecommendationContext,
  normalizeDreamReviewCheckpoint,
} from "../durable-loop/dream-review-checkpoint.js";
import { DreamReviewCheckpointEvidenceSchema } from "../durable-loop/phase-specs.js";

function makeMetricTrendContext(overrides: Partial<MetricTrendContext> = {}): MetricTrendContext {
  return {
    metric_key: "dim1",
    direction: "maximize",
    trend: "stalled",
    latest_value: 0.7,
    latest_observed_at: "2026-04-30T00:05:00.000Z",
    best_value: 0.7,
    best_observed_at: "2026-04-30T00:00:00.000Z",
    observation_count: 6,
    recent_slope_per_observation: 0,
    best_delta: 0,
    last_meaningful_improvement_delta: null,
    last_breakthrough_delta: null,
    time_since_last_meaningful_improvement_ms: null,
    improvement_threshold: 0.01,
    breakthrough_threshold: 0.05,
    noise_band: 0.005,
    confidence: 0.9,
    source_refs: [{ entry_id: "entry-1", kind: "metric" }],
    summary: "dim1 trend is stalled",
    ...overrides,
  };
}

function makeFinalizationStatus(overrides: Partial<DeadlineFinalizationStatus> = {}): DeadlineFinalizationStatus {
  return {
    mode: "finalization",
    deadline: "2026-04-30T01:00:00.000Z",
    evaluated_at: "2026-04-30T00:30:00.000Z",
    remaining_ms: 30 * 60 * 1000,
    reserved_finalization_ms: 30 * 60 * 1000,
    remaining_exploration_ms: 0,
    consolidation_buffer_ms: 0,
    finalization_plan: null,
    reason: "Reserved finalization buffer has started.",
    ...overrides,
  };
}

describe("Dream review checkpoint trigger planning", () => {
  it("requests a bounded iteration checkpoint on cadence", () => {
    const request = buildDreamReviewCheckpointRequest({
      goal: makeGoal(),
      loopIndex: 3,
      result: makeEmptyIterationResult("goal-1", 3),
      driveScores: [],
    });

    expect(request).toMatchObject({
      trigger: "iteration",
      memoryAuthorityPolicy: "soil_and_playbooks_are_advisory_only",
      activeDimensions: ["dim1"],
      maxGuidanceItems: 3,
    });
  });

  it("rate-limits repeated non-finalization checkpoints", () => {
    const request = buildDreamReviewCheckpointRequest({
      goal: makeGoal(),
      loopIndex: 3,
      result: makeEmptyIterationResult("goal-1", 3),
      driveScores: [],
      recentCheckpoints: [{
        trigger: "plateau",
        summary: "Recent checkpoint",
        current_goal: "Test Goal",
        active_dimensions: ["dim1"],
        recent_strategy_families: [],
        exhausted: [],
        promising: [],
        relevant_memories: [],
        active_hypotheses: [],
        rejected_approaches: [],
        next_strategy_candidates: [],
        guidance: "Try one bounded variant.",
        uncertainty: [],
        context_authority: "advisory_only",
        confidence: 0.8,
        entry_id: "entry-checkpoint",
        occurred_at: "2026-04-30T00:00:00.000Z",
        loop_index: 2,
      }],
    });

    expect(request).toBeNull();
  });

  it("uses plateau and breakthrough metric trends as checkpoint triggers", () => {
    const plateau = buildDreamReviewCheckpointRequest({
      goal: makeGoal(),
      loopIndex: 1,
      result: makeEmptyIterationResult("goal-1", 1, {
        metricTrendContext: makeMetricTrendContext({ trend: "regressing", summary: "metric regressed" }),
      }),
      driveScores: [],
    });
    const breakthrough = buildDreamReviewCheckpointRequest({
      goal: makeGoal(),
      loopIndex: 1,
      result: makeEmptyIterationResult("goal-1", 1, {
        metricTrendContext: makeMetricTrendContext({ trend: "breakthrough", summary: "metric broke through" }),
      }),
      driveScores: [],
    });

    expect(plateau).toMatchObject({ trigger: "plateau", metricTrendSummary: "metric regressed" });
    expect(breakthrough).toMatchObject({ trigger: "breakthrough", metricTrendSummary: "metric broke through" });
  });

  it("runs pre-finalization checkpoints even when a recent checkpoint exists", () => {
    const request = buildDreamReviewCheckpointRequest({
      goal: makeGoal(),
      loopIndex: 3,
      result: makeEmptyIterationResult("goal-1", 3),
      driveScores: [],
      finalizationStatus: makeFinalizationStatus(),
      recentCheckpoints: [{
        trigger: "iteration",
        summary: "Recent checkpoint",
        current_goal: "Test Goal",
        active_dimensions: ["dim1"],
        recent_strategy_families: [],
        exhausted: [],
        promising: [],
        relevant_memories: [],
        active_hypotheses: [],
        rejected_approaches: [],
        next_strategy_candidates: [],
        guidance: "Try one bounded variant.",
        uncertainty: [],
        context_authority: "advisory_only",
        confidence: 0.8,
        entry_id: "entry-checkpoint",
        occurred_at: "2026-04-30T00:00:00.000Z",
        loop_index: 2,
      }],
    });

    expect(request).toMatchObject({
      trigger: "pre_finalization",
      finalizationReason: "Reserved finalization buffer has started.",
    });
  });

  it("rate-limits repeated pre-finalization checkpoints", () => {
    const request = buildDreamReviewCheckpointRequest({
      goal: makeGoal(),
      loopIndex: 3,
      result: makeEmptyIterationResult("goal-1", 3),
      driveScores: [],
      finalizationStatus: makeFinalizationStatus(),
      recentCheckpoints: [{
        trigger: "pre_finalization",
        summary: "Recent checkpoint",
        current_goal: "Test Goal",
        active_dimensions: ["dim1"],
        recent_strategy_families: [],
        exhausted: [],
        promising: [],
        relevant_memories: [],
        active_hypotheses: [],
        rejected_approaches: [],
        next_strategy_candidates: [],
        guidance: "Try one bounded variant.",
        uncertainty: [],
        context_authority: "advisory_only",
        confidence: 0.8,
        entry_id: "entry-checkpoint",
        occurred_at: "2026-04-30T00:00:00.000Z",
        loop_index: 2,
      }],
    });

    expect(request).toBeNull();
  });

  it("requires retrieved Soil and playbook memories to remain advisory-only", () => {
    const parsed = DreamReviewCheckpointEvidenceSchema.safeParse({
      summary: "Checkpoint summary",
      trigger: "plateau",
      current_goal: "Test Goal",
      active_dimensions: ["dim1"],
      relevant_memories: [{
        source_type: "soil",
        ref: "soil://memory/a",
        summary: "Prior run note",
        authority: "executable",
      }],
      guidance: "Try a bounded variant.",
      context_authority: "advisory_only",
      confidence: 0.8,
    });

    expect(parsed.success).toBe(false);
  });

  it("ranks Dream memories by relevance, reliability, route priority, and prior success", () => {
    const goal = makeGoal({ title: "Improve benchmark score" });
    const request = buildDreamReviewCheckpointRequest({
      goal,
      loopIndex: 1,
      result: makeEmptyIterationResult("goal-1", 1, { stallDetected: true }),
      driveScores: [],
    });
    expect(request).not.toBeNull();

    const parsed = DreamReviewCheckpointEvidenceSchema.parse({
      summary: "Rank memories before guidance.",
      trigger: "plateau",
      current_goal: "Improve benchmark score",
      active_dimensions: ["balanced_accuracy"],
      relevant_memories: [
        {
          source_type: "runtime_evidence",
          ref: "checkpoint://recent-low",
          summary: "Recent but weak checkpoint memory.",
          relevance_score: 0.25,
          source_reliability: 0.4,
          recency_score: 1,
          retrieval: { kind: "checkpoint", confidence: 0.4 },
          authority: "advisory_only",
        },
        {
          source_type: "soil",
          ref: "soil://old-high",
          summary: "Older high-confidence route memory with prior success.",
          relevance_score: 0.92,
          source_reliability: 0.95,
          recency_score: 0.15,
          prior_success_contribution: 0.9,
          retrieval: { kind: "route_hit", score: 0.92, confidence: 0.95 },
          authority: "advisory_only",
        },
        {
          source_type: "soil",
          ref: "soil://fallback-mid",
          summary: "Fallback memory with moderate score.",
          relevance_score: 0.72,
          source_reliability: 0.7,
          recency_score: 0.7,
          retrieval: { kind: "fallback_hit", score: 0.72, confidence: 0.7 },
          authority: "advisory_only",
        },
      ],
      guidance: "Use high-confidence advisory memory.",
      uncertainty: [],
      context_authority: "advisory_only",
      confidence: 0.8,
    });

    const normalized = normalizeDreamReviewCheckpoint(parsed, request!, goal);

    expect(normalized.relevant_memories.map((memory) => memory.ref)).toEqual([
      "soil://old-high",
      "soil://fallback-mid",
      "checkpoint://recent-low",
    ]);
    expect(normalized.relevant_memories[0]).toMatchObject({
      authority: "advisory_only",
      ranking_trace: {
        decision: "admitted",
        reason: expect.stringContaining("kind=route_hit"),
      },
    });
    expect(normalized.context_authority).toBe("advisory_only");
  });

  it("uses soil usage outcomes as advisory ranking signal without changing authority", () => {
    const goal = makeGoal({ title: "Improve benchmark score" });
    const request = buildDreamReviewCheckpointRequest({
      goal,
      loopIndex: 1,
      result: makeEmptyIterationResult("goal-1", 1, { stallDetected: true }),
      driveScores: [],
    });
    expect(request).not.toBeNull();

    const parsed = DreamReviewCheckpointEvidenceSchema.parse({
      summary: "Rank usage-aware memories.",
      trigger: "plateau",
      current_goal: "Improve benchmark score",
      active_dimensions: ["balanced_accuracy"],
      relevant_memories: [
        {
          source_type: "soil",
          ref: "soil://validated",
          summary: "Validated memory with slightly lower base score.",
          relevance_score: 0.7,
          source_reliability: 0.75,
          recency_score: 0.5,
          retrieval: { kind: "route_hit", score: 0.7, confidence: 0.75 },
          usage_stats: {
            last_used_at: "2026-05-02T00:00:00.000Z",
            use_count: 5,
            validated_count: 5,
            negative_outcome_count: 0,
          },
          authority: "advisory_only",
        },
        {
          source_type: "soil",
          ref: "soil://negative",
          summary: "Negative memory with higher base score.",
          relevance_score: 0.75,
          source_reliability: 0.78,
          recency_score: 0.5,
          retrieval: { kind: "route_hit", score: 0.75, confidence: 0.78 },
          usage_stats: {
            last_used_at: "2026-05-02T00:00:00.000Z",
            use_count: 9,
            validated_count: 0,
            negative_outcome_count: 5,
          },
          authority: "advisory_only",
        },
      ],
      guidance: "Use validated advisory memory first.",
      uncertainty: [],
      context_authority: "advisory_only",
      confidence: 0.8,
    });

    const normalized = normalizeDreamReviewCheckpoint(parsed, request!, goal);

    expect(normalized.relevant_memories.map((memory) => memory.ref)).toEqual([
      "soil://validated",
      "soil://negative",
    ]);
    expect(normalized.relevant_memories[0]).toMatchObject({
      authority: "advisory_only",
      ranking_trace: {
        decision: "admitted",
        reason: expect.stringContaining("usage_outcome=0.0500"),
      },
    });
    expect(normalized.context_authority).toBe("advisory_only");
  });

  it("carries active hypotheses and rejected approaches into the next checkpoint request", () => {
    const request = buildDreamReviewCheckpointRequest({
      goal: makeGoal(),
      loopIndex: 5,
      result: makeEmptyIterationResult("goal-1", 5, { stallDetected: true }),
      driveScores: [],
      recentCheckpoints: [{
        trigger: "plateau",
        summary: "Previous checkpoint rejected repeat sweep.",
        current_goal: "Improve benchmark score",
        active_dimensions: ["dim1"],
        recent_strategy_families: ["threshold_sweep"],
        exhausted: ["repeat threshold sweep"],
        promising: ["feature ablation"],
        relevant_memories: [],
        active_hypotheses: [{
          hypothesis: "Feature ablation exposes leakage sensitivity.",
          supporting_evidence_ref: "metric:balanced_accuracy",
          target_metric_or_dimension: "balanced_accuracy",
          expected_next_observation: "Ablation changes balanced accuracy by more than noise.",
          status: "testing",
        }],
        rejected_approaches: [{
          approach: "Repeat threshold sweep",
          rejection_reason: "Three sweeps stayed within metric noise.",
          evidence_ref: "lineage:threshold-sweep",
          revisit_condition: "new calibration evidence appears",
          confidence: 0.88,
        }],
        next_strategy_candidates: [],
        guidance: "Avoid repeating threshold sweeps.",
        uncertainty: [],
        context_authority: "advisory_only",
        confidence: 0.8,
        entry_id: "entry-checkpoint",
        occurred_at: "2026-04-30T00:00:00.000Z",
        loop_index: 2,
      }],
    });

    expect(request).toMatchObject({
      activeHypotheses: [{
        hypothesis: "Feature ablation exposes leakage sensitivity.",
        target_metric_or_dimension: "balanced_accuracy",
      }],
      rejectedApproaches: [{
        approach: "Repeat threshold sweep",
        evidence_ref: "lineage:threshold-sweep",
      }],
    });
  });

  it("normalizes rejected approaches and suppresses matching next candidates", () => {
    const goal = makeGoal({ title: "Improve benchmark score" });
    const request = buildDreamReviewCheckpointRequest({
      goal,
      loopIndex: 1,
      result: makeEmptyIterationResult("goal-1", 1, { stallDetected: true }),
      driveScores: [],
      recentCheckpoints: [{
        trigger: "plateau",
        summary: "Previous checkpoint rejected repeat sweep.",
        current_goal: "Improve benchmark score",
        active_dimensions: ["dim1"],
        recent_strategy_families: [],
        exhausted: ["repeat threshold sweep"],
        promising: [],
        relevant_memories: [],
        active_hypotheses: [],
        rejected_approaches: [{
          approach: "repeat threshold sweep",
          rejection_reason: "Three attempts did not improve the metric.",
          evidence_ref: "lineage:threshold-sweep",
          revisit_condition: "new calibration evidence appears",
          confidence: 0.86,
        }],
        next_strategy_candidates: [],
        guidance: "Avoid repeating threshold sweeps.",
        uncertainty: [],
        context_authority: "advisory_only",
        confidence: 0.8,
        entry_id: "entry-checkpoint",
        occurred_at: "2026-04-30T00:00:00.000Z",
      }],
    });
    expect(request).not.toBeNull();

    const parsed = DreamReviewCheckpointEvidenceSchema.parse({
      summary: "Plateau review.",
      trigger: "plateau",
      current_goal: "Improve benchmark score",
      active_dimensions: ["dim1"],
      active_hypotheses: [{
        hypothesis: "Feature ablation is now the active path.",
        supporting_evidence_ref: "metric:balanced_accuracy",
        target_metric_or_dimension: "balanced_accuracy",
        expected_next_observation: "Ablation moves balanced accuracy.",
        status: "active",
      }],
      rejected_approaches: [{
        approach: "repeat threshold sweep",
        rejection_reason: "Three attempts did not improve the metric.",
        evidence_ref: "lineage:threshold-sweep",
        revisit_condition: "new calibration evidence appears",
        confidence: 0.86,
      }],
      next_strategy_candidates: [
        {
          title: "Repeat threshold sweep",
          rationale: "Try the same thresholds again.",
          target_dimensions: ["dim1"],
        },
        {
          title: "Feature ablation",
          rationale: "Test a different mechanism.",
          target_dimensions: ["dim1"],
        },
      ],
      guidance: "Try feature ablation.",
      uncertainty: [],
      context_authority: "advisory_only",
      confidence: 0.8,
    });

    const normalized = normalizeDreamReviewCheckpoint(parsed, request!, goal);

    expect(normalized.next_strategy_candidates.map((candidate) => candidate.title)).toEqual(["Feature ablation"]);
    expect(dreamCheckpointRawRefs(normalized)).toEqual(expect.arrayContaining([
      { kind: "dream_active_hypothesis_evidence", id: "metric:balanced_accuracy" },
      { kind: "dream_rejected_approach_evidence", id: "lineage:threshold-sweep" },
    ]));
  });

  it("suppresses non-ASCII rejected candidates during normalization", () => {
    const goal = makeGoal({ title: "Improve benchmark score" });
    const request = buildDreamReviewCheckpointRequest({
      goal,
      loopIndex: 1,
      result: makeEmptyIterationResult("goal-1", 1, { stallDetected: true }),
      driveScores: [],
    });
    expect(request).not.toBeNull();

    const parsed = DreamReviewCheckpointEvidenceSchema.parse({
      summary: "Plateau review.",
      trigger: "plateau",
      current_goal: "Improve benchmark score",
      active_dimensions: ["dim1"],
      rejected_approaches: [{
        approach: "閾値スイープの再実行",
        rejection_reason: "3回の試行で改善しなかった.",
        evidence_ref: "lineage:threshold-sweep",
        confidence: 0.9,
      }],
      next_strategy_candidates: [
        {
          title: "閾値スイープの再実行",
          rationale: "同じ探索をもう一度行う.",
          target_dimensions: ["dim1"],
        },
        {
          title: "特徴量アブレーション",
          rationale: "別の仮説を検証する.",
          target_dimensions: ["dim1"],
        },
      ],
      guidance: "Try feature ablation.",
      uncertainty: [],
      context_authority: "advisory_only",
      confidence: 0.8,
    });

    const normalized = normalizeDreamReviewCheckpoint(parsed, request!, goal);

    expect(normalized.next_strategy_candidates.map((candidate) => candidate.title)).toEqual(["特徴量アブレーション"]);
  });

  it("does not downrank repeated failed lineages from text overlap alone", () => {
    const failedFingerprint = "threshold_sweep|balanced_accuracy|balanced_accuracy stayed inside noise";
    const goal = makeGoal({ title: "Improve benchmark score" });
    const request = buildDreamReviewCheckpointRequest({
      goal,
      loopIndex: 1,
      result: makeEmptyIterationResult("goal-1", 1, { stallDetected: true }),
      driveScores: [],
      evidenceSummary: {
        best_evidence: null,
        recent_entries: [],
        failed_lineages: [{
          fingerprint: failedFingerprint,
          count: 3,
          first_seen_at: "2026-04-30T00:00:00.000Z",
          last_seen_at: "2026-04-30T00:10:00.000Z",
          strategy_family: "threshold_sweep",
          hypothesis: "Repeat threshold sweep improves balanced accuracy",
          primary_dimension: "balanced_accuracy",
          task_action: "threshold_sweep",
          failure_reason: "Balanced accuracy stayed inside noise.",
          representative_entry_id: "failed-threshold-3",
          representative_summary: "Threshold sweep failed.",
          evidence_entry_ids: ["failed-threshold-1", "failed-threshold-2", "failed-threshold-3"],
        }],
      },
    });
    expect(request).not.toBeNull();

    const parsed = DreamReviewCheckpointEvidenceSchema.parse({
      summary: "Plateau review.",
      trigger: "plateau",
      current_goal: "Improve benchmark score",
      active_dimensions: ["balanced_accuracy"],
      next_strategy_candidates: [
        {
          title: "threshold_sweep retry",
          rationale: "Try another threshold_sweep attempt.",
          target_dimensions: ["balanced_accuracy"],
        },
        {
          title: "Feature ablation",
          rationale: "Test a different mechanism for balanced_accuracy.",
          target_dimensions: ["balanced_accuracy"],
        },
      ],
      guidance: "Avoid repeating failed threshold sweeps without new evidence.",
      uncertainty: [],
      context_authority: "advisory_only",
      confidence: 0.8,
    });

    const normalized = normalizeDreamReviewCheckpoint(parsed, request!, goal);

    expect(normalized.next_strategy_candidates.map((candidate) => candidate.title)).toEqual([
      "threshold_sweep retry",
      "Feature ablation",
    ]);
    expect(normalized.next_strategy_candidates[0]?.failed_lineage_warning).toBeUndefined();
  });

  it("carries repeated failed lineages into checkpoint requests and downranks fingerprinted candidates", () => {
    const failedFingerprint = "threshold_sweep|balanced_accuracy|balanced_accuracy stayed inside noise";
    const goal = makeGoal({ title: "Improve benchmark score" });
    const request = buildDreamReviewCheckpointRequest({
      goal,
      loopIndex: 1,
      result: makeEmptyIterationResult("goal-1", 1, { stallDetected: true }),
      driveScores: [],
      evidenceSummary: {
        best_evidence: null,
        recent_entries: [],
        failed_lineages: [{
          fingerprint: failedFingerprint,
          count: 3,
          first_seen_at: "2026-04-30T00:00:00.000Z",
          last_seen_at: "2026-04-30T00:10:00.000Z",
          strategy_family: "threshold_sweep",
          hypothesis: "Repeat threshold sweep improves balanced accuracy",
          primary_dimension: "balanced_accuracy",
          task_action: "threshold_sweep",
          failure_reason: "Balanced accuracy stayed inside noise.",
          representative_entry_id: "failed-threshold-3",
          representative_summary: "Threshold sweep failed.",
          evidence_entry_ids: ["failed-threshold-1", "failed-threshold-2", "failed-threshold-3"],
        }],
      },
    });
    expect(request).toMatchObject({
      failedLineages: [{
        count: 3,
        strategy_family: "threshold_sweep",
        representative_entry_id: "failed-threshold-3",
      }],
    });

    const parsed = DreamReviewCheckpointEvidenceSchema.parse({
      summary: "Plateau review.",
      trigger: "plateau",
      current_goal: "Improve benchmark score",
      active_dimensions: ["balanced_accuracy"],
      next_strategy_candidates: [
        {
          title: "threshold_sweep retry",
          rationale: "Try another threshold_sweep attempt.",
          target_dimensions: ["balanced_accuracy"],
          failed_lineage_fingerprints: [failedFingerprint],
        },
        {
          title: "Feature ablation",
          rationale: "Test a different mechanism for balanced_accuracy.",
          target_dimensions: ["balanced_accuracy"],
        },
        {
          title: "threshold_sweep with new calibration evidence",
          rationale: "Retry threshold_sweep because calibration bins changed.",
          target_dimensions: ["balanced_accuracy"],
          failed_lineage_fingerprints: [failedFingerprint],
          retry_reason: "New calibration evidence changes the search space.",
        },
      ],
      guidance: "Avoid repeating failed threshold sweeps without new evidence.",
      uncertainty: [],
      context_authority: "advisory_only",
      confidence: 0.8,
    });

    const normalized = normalizeDreamReviewCheckpoint(parsed, request!, goal);

    expect(normalized.next_strategy_candidates.map((candidate) => candidate.title)).toEqual([
      "Feature ablation",
      "threshold_sweep with new calibration evidence",
      "threshold_sweep retry",
    ]);
    expect(normalized.next_strategy_candidates[1]?.failed_lineage_warning).toMatchObject({
      count: 3,
      reason: expect.stringContaining("Retry override"),
    });
    expect(normalized.next_strategy_candidates[2]?.failed_lineage_warning).toMatchObject({
      count: 3,
      reason: expect.stringContaining("Similar to failed lineage"),
    });
  });

  it("normalizes deadline-backed finalization recommendations as auto-applied run control", () => {
    const goal = makeGoal({ title: "Submit final benchmark artifact" });
    const request = buildDreamReviewCheckpointRequest({
      goal,
      loopIndex: 3,
      result: makeEmptyIterationResult("goal-1", 3),
      driveScores: [],
      finalizationStatus: makeFinalizationStatus(),
    });
    expect(request).not.toBeNull();

    const parsed = DreamReviewCheckpointEvidenceSchema.parse({
      summary: "Deadline is inside finalization buffer.",
      trigger: "pre_finalization",
      current_goal: "Submit final benchmark artifact",
      active_dimensions: ["dim1"],
      run_control_recommendations: [{
        action: "enter_finalization",
        target_mode: "finalization",
        rationale: "The deadline buffer has started, so remaining work should freeze candidates and package artifacts.",
        evidence: [{
          kind: "deadline",
          ref: "deadline:goal-1",
          summary: "Reserved finalization buffer has started.",
        }],
        risk: "low",
        confidence: 0.9,
      }],
      guidance: "Enter finalization and verify the best artifact.",
      uncertainty: [],
      context_authority: "advisory_only",
      confidence: 0.9,
    });

    const normalized = normalizeDreamReviewCheckpoint(parsed, request!, goal);

    expect(normalized.run_control_recommendations[0]).toMatchObject({
      action: "enter_finalization",
      policy_decision: {
        disposition: "auto_apply",
      },
    });
  });

  it("builds task-generation context for divergent exploration after repeated lineage evidence", () => {
    const goal = makeGoal({ title: "Improve benchmark score" });
    const request = buildDreamReviewCheckpointRequest({
      goal,
      loopIndex: 1,
      result: makeEmptyIterationResult("goal-1", 1, {
        stallDetected: true,
        metricTrendContext: makeMetricTrendContext({
          trend: "stalled",
          summary: "Same CatBoost lineage has not improved balanced accuracy across six observations.",
        }),
      }),
      driveScores: [],
    });
    expect(request).not.toBeNull();

    const parsed = DreamReviewCheckpointEvidenceSchema.parse({
      summary: "The current lineage is repeating low-value attempts.",
      trigger: "plateau",
      current_goal: "Improve benchmark score",
      active_dimensions: ["dim1"],
      recent_strategy_families: ["catboost_thresholding", "catboost_thresholding", "catboost_thresholding"],
      exhausted: ["catboost_thresholding"],
      promising: ["lightgbm_ranked_features"],
      run_control_recommendations: [{
        action: "widen_exploration",
        target_strategy_family: "lightgbm_ranked_features",
        rationale: "Repeated same-lineage attempts have stopped moving the metric.",
        evidence: [
          {
            kind: "lineage",
            ref: "lineage:catboost_thresholding",
            summary: "Three recent attempts stayed in the same CatBoost thresholding family.",
          },
          {
            kind: "metric",
            ref: "metric:balanced_accuracy",
            summary: "Balanced accuracy trend is stalled.",
          },
        ],
        risk: "low",
        confidence: 0.82,
      }],
      guidance: "Try a divergent low-cost branch before another same-lineage task.",
      uncertainty: ["Need one smoke validation."],
      context_authority: "advisory_only",
      confidence: 0.82,
    });

    const normalized = normalizeDreamReviewCheckpoint(parsed, request!, goal);
    const context = formatDreamRunControlRecommendationContext(normalized.run_control_recommendations);

    expect(normalized.run_control_recommendations[0]).toMatchObject({
      action: "widen_exploration",
      target_strategy_family: "lightgbm_ranked_features",
      policy_decision: {
        disposition: "auto_apply",
      },
    });
    expect(context).toContain("Dream run-control recommendations:");
    expect(context).toContain("widen_exploration");
    expect(context).toContain("lineage: Three recent attempts stayed in the same CatBoost thresholding family.");
    expect(dreamCheckpointRawRefs(normalized)).toEqual(expect.arrayContaining([
      { kind: "dream_run_control_lineage", id: "lineage:catboost_thresholding" },
      { kind: "dream_run_control_metric", id: "metric:balanced_accuracy" },
    ]));
  });

  it("does not feed advisory-only recommendations into task generation context", () => {
    const context = formatDreamRunControlRecommendationContext([{
      id: "medium-risk-widen",
      action: "widen_exploration",
      target_strategy_family: "expensive_gpu_sweep",
      rationale: "Could uncover a better family but needs budget review.",
      evidence: [{
        kind: "lineage",
        ref: "lineage:current",
        summary: "Current lineage is narrowing.",
      }],
      candidate_refs: [],
      lineage_refs: [],
      approval_required: false,
      risk: "medium",
      confidence: 0.7,
      policy_decision: {
        disposition: "advisory_only",
        reason: "Preserved for review but not auto-applied.",
      },
    }]);

    expect(context).toBeUndefined();
  });

  it("keeps default medium-risk recommendations advisory-only", () => {
    const goal = makeGoal({ title: "Improve benchmark score" });
    const request = buildDreamReviewCheckpointRequest({
      goal,
      loopIndex: 1,
      result: makeEmptyIterationResult("goal-1", 1, {
        stallDetected: true,
      }),
      driveScores: [],
    });
    expect(request).not.toBeNull();

    const parsed = DreamReviewCheckpointEvidenceSchema.parse({
      summary: "Consolidation could help but confidence is incomplete.",
      trigger: "plateau",
      current_goal: "Improve benchmark score",
      active_dimensions: ["dim1"],
      run_control_recommendations: [{
        action: "consolidate_candidates",
        target_mode: "consolidation",
        rationale: "Candidate evidence should be organized before more exploration.",
        evidence: [{
          kind: "artifact",
          ref: "artifact:candidate-report",
          summary: "A candidate report exists but has not been revalidated.",
        }],
        confidence: 0.7,
      }],
      guidance: "Consider consolidation.",
      uncertainty: [],
      context_authority: "advisory_only",
      confidence: 0.7,
    });

    const normalized = normalizeDreamReviewCheckpoint(parsed, request!, goal);

    expect(normalized.run_control_recommendations[0]).toMatchObject({
      risk: "medium",
      policy_decision: {
        disposition: "advisory_only",
      },
    });
    expect(formatDreamRunControlRecommendationContext(normalized.run_control_recommendations)).toBeUndefined();
  });

  it("keeps default medium-risk finalization recommendations advisory-only even with deadline evidence", () => {
    const goal = makeGoal({ title: "Submit final benchmark artifact" });
    const request = buildDreamReviewCheckpointRequest({
      goal,
      loopIndex: 3,
      result: makeEmptyIterationResult("goal-1", 3),
      driveScores: [],
      finalizationStatus: makeFinalizationStatus(),
    });
    expect(request).not.toBeNull();

    const parsed = DreamReviewCheckpointEvidenceSchema.parse({
      summary: "Deadline is inside finalization buffer.",
      trigger: "pre_finalization",
      current_goal: "Submit final benchmark artifact",
      active_dimensions: ["dim1"],
      run_control_recommendations: [{
        action: "enter_finalization",
        target_mode: "finalization",
        rationale: "The deadline buffer has started.",
        evidence: [{
          kind: "deadline",
          ref: "deadline:goal-1",
          summary: "Reserved finalization buffer has started.",
        }],
        confidence: 0.9,
      }],
      guidance: "Consider finalization.",
      uncertainty: [],
      context_authority: "advisory_only",
      confidence: 0.9,
    });

    const normalized = normalizeDreamReviewCheckpoint(parsed, request!, goal);

    expect(normalized.run_control_recommendations[0]).toMatchObject({
      risk: "medium",
      policy_decision: {
        disposition: "advisory_only",
      },
    });
    expect(formatDreamRunControlRecommendationContext(normalized.run_control_recommendations)).toBeUndefined();
  });

  it("does not treat ordinary deadline status reasons as finalization-window approval for queue freeze", () => {
    const goal = makeGoal({ title: "Improve benchmark score" });
    const request = buildDreamReviewCheckpointRequest({
      goal,
      loopIndex: 1,
      result: makeEmptyIterationResult("goal-1", 1, {
        stallDetected: true,
      }),
      driveScores: [],
      finalizationStatus: makeFinalizationStatus({
        mode: "no_deadline",
        deadline: null,
        remaining_ms: null,
        remaining_exploration_ms: null,
        reason: "Goal has no deadline.",
      }),
    });
    expect(request).not.toBeNull();
    expect(request?.finalizationReason).toBeUndefined();

    const parsed = DreamReviewCheckpointEvidenceSchema.parse({
      summary: "Queue freeze is not yet justified.",
      trigger: "plateau",
      current_goal: "Improve benchmark score",
      active_dimensions: ["dim1"],
      run_control_recommendations: [{
        action: "freeze_experiment_queue",
        rationale: "Freeze current queue.",
        evidence: [{
          kind: "runtime_state",
          ref: "queue:active",
          summary: "The queue has pending experiments.",
        }],
        risk: "low",
        confidence: 0.8,
      }],
      guidance: "Do not freeze without finalization.",
      uncertainty: [],
      context_authority: "advisory_only",
      confidence: 0.8,
    });

    const normalized = normalizeDreamReviewCheckpoint(parsed, request!, goal);

    expect(normalized.run_control_recommendations[0]).toMatchObject({
      policy_decision: {
        disposition: "approval_required",
      },
    });
    expect(formatDreamRunControlRecommendationContext(normalized.run_control_recommendations)).toBeUndefined();
  });
});
