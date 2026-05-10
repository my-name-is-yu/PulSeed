import type {
  MemoryCorrectionEntry,
  MemoryCorrectionTargetState,
} from "../../platform/corrections/memory-correction-ledger.js";
import type {
  RuntimeArtifactRetentionSummary,
} from "./artifact-retention.js";
import type {
  RuntimeDreamCheckpointContext,
} from "./dream-checkpoints.js";
import type {
  RuntimeEvaluatorSummary,
} from "./evaluator-results.js";
import type {
  RuntimeEvidenceCandidateDisposition,
  RuntimeEvidenceCandidateNearMissReason,
  RuntimeEvidenceCandidateSimilarity,
  RuntimeEvidenceDivergentHypothesis,
  RuntimeEvidenceEntry,
  RuntimeEvidenceMetric,
  RuntimeEvidenceReadWarning,
} from "./evidence-types.js";
import type {
  MetricObservation,
  MetricTrendContext,
} from "./metric-history.js";
import type {
  RuntimeResearchMemoContext,
} from "./research-evidence.js";

export interface RuntimeFailedLineageContext {
  fingerprint: string;
  count: number;
  first_seen_at: string;
  last_seen_at: string;
  strategy_family?: string;
  hypothesis?: string;
  primary_dimension?: string;
  task_action?: string;
  failure_reason?: string;
  representative_entry_id: string;
  representative_summary: string;
  evidence_entry_ids: string[];
}

export interface RuntimeCandidateLineageContext {
  strategy_family: string;
  candidate_ids: string[];
  retained_representative_ids: string[];
  promoted_ids: string[];
  retired_ids: string[];
  best_candidate_id?: string;
  best_metric?: {
    label: string;
    value: number;
    direction: "maximize" | "minimize";
  };
  diversity_notes: string[];
}

export interface RuntimeCandidatePortfolioSlot {
  candidate_id: string;
  label?: string;
  strategy_family: string;
  role: "top_metric" | "diverse_representative" | "lineage_representative";
  evidence_entry_id: string;
  occurred_at: string;
  metric?: {
    label: string;
    value: number;
    direction: "maximize" | "minimize";
    confidence: number;
  };
  parent_candidate_id?: string;
  source_candidate_id?: string;
  source_strategy_id?: string;
  disposition: RuntimeEvidenceCandidateDisposition;
  retained_reason?: string;
  similarity_to_selected?: RuntimeEvidenceCandidateSimilarity;
}

export interface RuntimeDiversifiedCandidatePortfolioOptions {
  limit?: number;
  nearDuplicateSimilarity?: number;
}

export interface CandidateComparableMetric {
  label: string;
  value: number;
  direction: "maximize" | "minimize";
  confidence: number;
}

export interface ComparableMetricKey {
  label: string;
  direction: "maximize" | "minimize";
}

export interface RuntimeCandidateSelectionCandidate {
  candidate_id: string;
  label?: string;
  strategy_family: string;
  evidence_entry_id: string;
  raw_rank: number;
  raw_metric?: {
    label: string;
    value: number;
    direction: "maximize" | "minimize";
    confidence: number;
  };
  robust_score: number;
  calibration_adjustment: number;
  metric_score: number;
  stability_score: number;
  diversity_score: number;
  risk_penalty: number;
  evidence_confidence: number;
  reasons: string[];
}

export interface RuntimeCandidateSelectionSummary {
  primary_metric: ComparableMetricKey | null;
  raw_best: RuntimeCandidateSelectionCandidate | null;
  robust_best: RuntimeCandidateSelectionCandidate | null;
  ranked: RuntimeCandidateSelectionCandidate[];
  final_portfolio: {
    safe: RuntimeCandidateSelectionCandidate | null;
    aggressive: RuntimeCandidateSelectionCandidate | null;
    diverse: RuntimeCandidateSelectionCandidate | null;
  };
}

export interface RuntimeNearMissCandidateContext {
  candidate_id: string;
  label?: string;
  strategy_family: string;
  evidence_entry_id: string;
  occurred_at: string;
  raw_rank: number;
  raw_metric?: CandidateComparableMetric;
  raw_best_candidate_id?: string;
  margin_to_raw_best?: number;
  reason_to_keep: RuntimeEvidenceCandidateNearMissReason[];
  weak_dimensions: string[];
  complementary_candidate_ids: string[];
  follow_up?: {
    title: string;
    rationale: string;
    target_dimensions: string[];
    expected_evidence_gain?: string;
  };
  retained_reason?: string;
  evidence_refs: string[];
  summary?: string;
}

export interface RuntimeEvidenceSummary {
  schema_version: "runtime-evidence-summary-v1";
  context_policy_version: "quarantine-filtered-planning-context-v2";
  generated_at: string;
  scope: {
    goal_id?: string;
    run_id?: string;
  };
  total_entries: number;
  latest_strategy: RuntimeEvidenceEntry | null;
  best_evidence: RuntimeEvidenceEntry | null;
  metric_trends: MetricTrendContext[];
  evaluator_summary: RuntimeEvaluatorSummary;
  research_memos: RuntimeResearchMemoContext[];
  dream_checkpoints: RuntimeDreamCheckpointContext[];
  divergent_exploration: RuntimeEvidenceDivergentHypothesis[];
  corrections: MemoryCorrectionEntry[];
  correction_state: Record<string, MemoryCorrectionTargetState>;
  candidate_lineages: RuntimeCandidateLineageContext[];
  recommended_candidate_portfolio: RuntimeCandidatePortfolioSlot[];
  candidate_selection_summary: RuntimeCandidateSelectionSummary;
  near_miss_candidates: RuntimeNearMissCandidateContext[];
  artifact_retention: RuntimeArtifactRetentionSummary;
  recent_failed_attempts: RuntimeEvidenceEntry[];
  failed_lineages: RuntimeFailedLineageContext[];
  recent_entries: RuntimeEvidenceEntry[];
  warnings: RuntimeEvidenceReadWarning[];
}

export interface RuntimeEvidenceSummaryIndex {
  schema_version: "runtime-evidence-summary-index-v1";
  generated_at: string;
  canonical_log_path: string;
  canonical_log_size: number;
  canonical_log_mtime_ms: number;
  summary: RuntimeEvidenceSummary;
  append_state?: RuntimeEvidenceSummaryAppendState;
  checkpoint?: RuntimeEvidenceSummaryCheckpoint;
}

export interface RuntimeEvidenceSummaryAppendState {
  schema_version: "runtime-evidence-summary-append-state-v1";
  warnings: RuntimeEvidenceReadWarning[];
  primary_metric?: ComparableMetricKey;
  metric_observations?: RuntimeEvidenceSummaryMetricObservationState[];
}

export interface RuntimeEvidenceSummaryMetricObservationState {
  metric_key: string;
  direction: "maximize" | "minimize";
  count: number;
  confidence_sum: number;
  first_value: number;
  first_normalized: number;
  first_observed_at: string;
  latest_value: number;
  latest_normalized: number;
  latest_observed_at: string;
  best_value: number;
  best_normalized: number;
  best_observed_at: string;
  previous_best_normalized: number;
  last_meaningful_improvement_delta: number | null;
  last_meaningful_improvement_observed_at: string | null;
  last_meaningful_improvement_index: number | null;
  last_breakthrough_delta: number | null;
  post_improvement_min_normalized: number;
  post_improvement_max_normalized: number;
  recent: Array<{
    value: number;
    normalized: number;
    observed_at: string;
    source: MetricObservation["source"];
  }>;
}

export interface RuntimeEvidenceSummaryCheckpoint {
  schema_version: "runtime-evidence-summary-checkpoint-v1";
  entries: RuntimeEvidenceEntry[];
  warnings: RuntimeEvidenceReadWarning[];
}

export interface ComparableEvidenceMetric {
  entry: RuntimeEvidenceEntry;
  metric: RuntimeEvidenceMetric;
  value: number;
  direction: "maximize" | "minimize";
  primary_metric: ComparableMetricKey;
  improvement_strength: number;
  confidence: number;
  has_pass_verification: boolean;
  has_artifact: boolean;
}
