import { z } from "zod";
import {
  MemoryCorrectionEntrySchema,
  type MemoryCorrectionEntry,
  MemoryCorrectionTargetStateSchema,
} from "../../platform/corrections/memory-correction-ledger.js";
import {
  MemoryProvenanceSchema,
  MemoryQuarantineStateSchema,
  MemoryVerificationStatusSchema,
} from "../../platform/corrections/memory-quarantine.js";

export const RuntimeArtifactRetentionClassSchema = z.enum([
  "final_deliverable",
  "best_candidate",
  "robust_candidate",
  "near_miss",
  "reproducibility_critical",
  "evidence_report",
  "low_value_smoke",
  "cache_intermediate",
  "duplicate_superseded",
  "other",
]);
export type RuntimeArtifactRetentionClass = z.infer<typeof RuntimeArtifactRetentionClassSchema>;

export const RuntimeEvidenceOutcomeSchema = z.enum([
  "improved",
  "regressed",
  "inconclusive",
  "failed",
  "blocked",
  "continued",
]);
export type RuntimeEvidenceOutcome = z.infer<typeof RuntimeEvidenceOutcomeSchema>;

export const RuntimeEvidenceEntryKindSchema = z.enum([
  "observation",
  "strategy",
  "task_generation",
  "execution",
  "verification",
  "decision",
  "metric",
  "evaluator",
  "research",
  "dream_checkpoint",
  "artifact",
  "failure",
  "correction",
  "other",
]);
export type RuntimeEvidenceEntryKind = z.infer<typeof RuntimeEvidenceEntryKindSchema>;

export const RuntimeEvidenceScalarValueSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.null()]);
export type RuntimeEvidenceScalarValue = z.infer<typeof RuntimeEvidenceScalarValueSchema>;

export const RuntimeEvidenceArtifactRefSchema = z.object({
  label: z.string().min(1),
  path: z.string().min(1).optional(),
  state_relative_path: z.string().min(1).optional(),
  url: z.string().url().optional(),
  kind: z.enum(["log", "metrics", "report", "diff", "url", "other"]).default("other"),
  retention_class: RuntimeArtifactRetentionClassSchema.optional(),
  size_bytes: z.number().int().nonnegative().optional(),
  source: z.string().min(1).optional(),
  dependency_refs: z.array(z.string().min(1)).optional(),
}).strict();
export type RuntimeEvidenceArtifactRef = z.infer<typeof RuntimeEvidenceArtifactRefSchema>;

export const RuntimeEvidenceMetricSchema = z.object({
  label: z.string().min(1),
  value: RuntimeEvidenceScalarValueSchema.optional(),
  unit: z.string().min(1).optional(),
  direction: z.enum(["maximize", "minimize", "neutral"]).optional(),
  confidence: z.number().min(0).max(1).optional(),
  observed_at: z.string().datetime().optional(),
  source: z.string().min(1).optional(),
  summary: z.string().min(1).optional(),
}).strict();
export type RuntimeEvidenceMetric = z.infer<typeof RuntimeEvidenceMetricSchema>;

export const RuntimeEvidenceCandidateDispositionSchema = z.enum(["retained", "promoted", "retired"]);
export type RuntimeEvidenceCandidateDisposition = z.infer<typeof RuntimeEvidenceCandidateDispositionSchema>;

export const RuntimeEvidenceCandidateLineageSchema = z.object({
  parent_candidate_id: z.string().min(1).optional(),
  source_candidate_id: z.string().min(1).optional(),
  source_strategy_id: z.string().min(1).optional(),
  source_strategy: z.string().min(1).optional(),
  strategy_family: z.string().min(1),
  feature_lineage: z.array(z.string().min(1)).default([]),
  model_lineage: z.array(z.string().min(1)).default([]),
  config_lineage: z.array(z.string().min(1)).default([]),
  seed_lineage: z.array(z.string().min(1)).default([]),
  fold_lineage: z.array(z.string().min(1)).default([]),
  postprocess_lineage: z.array(z.string().min(1)).default([]),
  notes: z.string().min(1).optional(),
}).strict();
export type RuntimeEvidenceCandidateLineage = z.infer<typeof RuntimeEvidenceCandidateLineageSchema>;

export const RuntimeEvidenceCandidateSimilaritySchema = z.object({
  candidate_id: z.string().min(1),
  similarity: z.number().min(0).max(1),
  signal: z.enum(["declared", "lineage", "metric_correlation", "artifact_overlap", "other"]).default("declared"),
  summary: z.string().min(1).optional(),
}).strict();
export type RuntimeEvidenceCandidateSimilarity = z.infer<typeof RuntimeEvidenceCandidateSimilaritySchema>;

export const RuntimeEvidenceCandidateNearMissReasonSchema = z.enum([
  "close_to_best",
  "stability",
  "novelty",
  "weak_dimension_improvement",
  "complementarity",
  "ensemble_potential",
]);
export type RuntimeEvidenceCandidateNearMissReason = z.infer<typeof RuntimeEvidenceCandidateNearMissReasonSchema>;

export const RuntimeEvidenceCandidateNearMissSchema = z.object({
  status: z.enum(["retained", "promoted", "rejected"]).default("retained"),
  reason_to_keep: z.array(RuntimeEvidenceCandidateNearMissReasonSchema).min(1),
  margin_to_best: z.number().min(0).optional(),
  weak_dimensions: z.array(z.string().min(1)).default([]),
  complementary_candidate_ids: z.array(z.string().min(1)).default([]),
  follow_up: z.object({
    title: z.string().min(1),
    rationale: z.string().min(1),
    target_dimensions: z.array(z.string().min(1)).default([]),
    expected_evidence_gain: z.string().min(1).optional(),
  }).strict().optional(),
  evidence_refs: z.array(z.string().min(1)).default([]),
  summary: z.string().min(1).optional(),
}).strict();
export type RuntimeEvidenceCandidateNearMiss = z.infer<typeof RuntimeEvidenceCandidateNearMissSchema>;

export const RuntimeEvidenceCandidateRecordSchema = z.object({
  candidate_id: z.string().min(1),
  label: z.string().min(1).optional(),
  lineage: RuntimeEvidenceCandidateLineageSchema,
  metrics: z.array(RuntimeEvidenceMetricSchema).default([]),
  artifacts: z.array(RuntimeEvidenceArtifactRefSchema).default([]),
  similarity: z.array(RuntimeEvidenceCandidateSimilaritySchema).default([]),
  robustness: z.object({
    stability_score: z.number().min(0).max(1).optional(),
    diversity_score: z.number().min(0).max(1).optional(),
    risk_penalty: z.number().min(0).max(1).optional(),
    robust_score: z.number().min(0).max(1).optional(),
    evidence_confidence: z.number().min(0).max(1).optional(),
    repeated_evaluations: z.number().int().nonnegative().optional(),
    mean_score: z.number().optional(),
    max_score: z.number().optional(),
    score_stddev: z.number().min(0).optional(),
    fold_score_range: z.number().min(0).optional(),
    seed_score_range: z.number().min(0).optional(),
    weak_dimensions: z.array(z.string().min(1)).default([]),
    provenance_refs: z.array(z.string().min(1)).default([]),
    summary: z.string().min(1).optional(),
  }).strict().optional(),
  near_miss: RuntimeEvidenceCandidateNearMissSchema.optional(),
  disposition: RuntimeEvidenceCandidateDispositionSchema.default("retained"),
  disposition_reason: z.string().min(1).optional(),
  produced_at: z.string().datetime().optional(),
}).strict();
export type RuntimeEvidenceCandidateRecord = z.infer<typeof RuntimeEvidenceCandidateRecordSchema>;

export const RuntimeEvidenceEvaluatorSignalSchema = z.enum(["local", "external"]);
export type RuntimeEvidenceEvaluatorSignal = z.infer<typeof RuntimeEvidenceEvaluatorSignalSchema>;

export const RuntimeEvidenceEvaluatorStatusSchema = z.enum([
  "pending",
  "ready",
  "approval_required",
  "submitted",
  "passed",
  "succeeded",
  "completed",
  "failed",
  "regressed",
  "blocked",
  "unknown",
]);
export type RuntimeEvidenceEvaluatorStatus = z.infer<typeof RuntimeEvidenceEvaluatorStatusSchema>;

export const RuntimeEvidenceEvaluatorPublishActionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  tool_name: z.string().min(1).optional(),
  payload_ref: z.string().min(1).optional(),
  approval_required: z.literal(true).default(true),
  status: z.enum(["approval_required", "approved", "submitted", "completed", "blocked"]).optional(),
}).strict();
export type RuntimeEvidenceEvaluatorPublishAction = z.infer<typeof RuntimeEvidenceEvaluatorPublishActionSchema>;

export const RuntimeEvidenceEvaluatorValidationSchema = z.object({
  status: z.enum(["pending", "passed", "failed", "blocked", "unknown"]).default("unknown"),
  command: z.string().min(1).optional(),
  summary: z.string().min(1).optional(),
}).strict();
export type RuntimeEvidenceEvaluatorValidation = z.infer<typeof RuntimeEvidenceEvaluatorValidationSchema>;

export const RuntimeEvidenceEvaluatorProvenanceSchema = z.object({
  kind: z.enum(["local_command", "external_url", "ci", "benchmark", "human_review", "other"]).default("other"),
  command: z.string().min(1).optional(),
  url: z.string().url().optional(),
  run_id: z.string().min(1).optional(),
  external_id: z.string().min(1).optional(),
  raw_ref: z.string().min(1).optional(),
  retrieved_at: z.string().datetime().optional(),
}).strict();
export type RuntimeEvidenceEvaluatorProvenance = z.infer<typeof RuntimeEvidenceEvaluatorProvenanceSchema>;

export const RuntimeEvidenceEvaluatorBudgetSchema = z.object({
  policy_id: z.string().min(1).optional(),
  max_attempts: z.number().int().positive().optional(),
  used_attempts: z.number().int().nonnegative().optional(),
  remaining_attempts: z.number().int().nonnegative(),
  approval_required: z.boolean().default(true),
  deadline_at: z.string().datetime().optional(),
  phase: z.enum(["exploration", "consolidation", "finalization", "other"]).optional(),
  portfolio_policy: z.object({
    diversified_portfolio_required: z.boolean().default(false),
    reserve_for_finalization: z.boolean().default(false),
    min_strategy_families: z.number().int().positive().optional(),
  }).strict().optional(),
}).strict();
export type RuntimeEvidenceEvaluatorBudget = z.infer<typeof RuntimeEvidenceEvaluatorBudgetSchema>;

export const RuntimeEvidenceEvaluatorCandidateSnapshotSchema = z.object({
  evidence_entry_id: z.string().min(1).optional(),
  primary_metric_label: z.string().min(1).optional(),
  local_metrics: z.array(RuntimeEvidenceMetricSchema).default([]),
  robust_selection: z.object({
    raw_rank: z.number().int().positive().optional(),
    robust_score: z.number().min(0).max(1).optional(),
    stability_score: z.number().min(0).max(1).optional(),
    diversity_score: z.number().min(0).max(1).optional(),
    risk_penalty: z.number().min(0).max(1).optional(),
    portfolio_role: z.enum(["raw_best", "robust_best", "safe", "aggressive", "diverse", "near_miss", "other"]).optional(),
  }).strict().optional(),
  summary: z.string().min(1).optional(),
}).strict();
export type RuntimeEvidenceEvaluatorCandidateSnapshot = z.infer<typeof RuntimeEvidenceEvaluatorCandidateSnapshotSchema>;

export const RuntimeEvidenceEvaluatorCalibrationSchema = z.object({
  mode: z.literal("calibration_only").default("calibration_only"),
  use_for_selection: z.boolean().default(false),
  direct_optimization_allowed: z.literal(false).default(false),
  minimum_observations: z.number().int().positive().default(1),
  conclusion: z.string().min(1).optional(),
}).strict();
export type RuntimeEvidenceEvaluatorCalibration = z.infer<typeof RuntimeEvidenceEvaluatorCalibrationSchema>;

export const RuntimeEvidenceEvaluatorObservationSchema = z.object({
  evaluator_id: z.string().min(1),
  signal: RuntimeEvidenceEvaluatorSignalSchema,
  source: z.string().min(1),
  candidate_id: z.string().min(1),
  candidate_label: z.string().min(1).optional(),
  artifact_labels: z.array(z.string().min(1)).optional(),
  status: RuntimeEvidenceEvaluatorStatusSchema.default("unknown"),
  score: RuntimeEvidenceScalarValueSchema.optional(),
  score_label: z.string().min(1).optional(),
  direction: z.enum(["maximize", "minimize", "neutral"]).optional(),
  observed_at: z.string().datetime().optional(),
  expected_score: RuntimeEvidenceScalarValueSchema.optional(),
  expected_status: RuntimeEvidenceEvaluatorStatusSchema.optional(),
  expectation_source: z.string().min(1).optional(),
  validation: RuntimeEvidenceEvaluatorValidationSchema.optional(),
  publish_action: RuntimeEvidenceEvaluatorPublishActionSchema.optional(),
  provenance: RuntimeEvidenceEvaluatorProvenanceSchema.optional(),
  budget: RuntimeEvidenceEvaluatorBudgetSchema.optional(),
  candidate_snapshot: RuntimeEvidenceEvaluatorCandidateSnapshotSchema.optional(),
  calibration: RuntimeEvidenceEvaluatorCalibrationSchema.optional(),
  summary: z.string().min(1).optional(),
}).strict();
export type RuntimeEvidenceEvaluatorObservation = z.infer<typeof RuntimeEvidenceEvaluatorObservationSchema>;

export const RuntimeEvidenceResearchSourceSchema = z.object({
  url: z.string().url(),
  title: z.string().min(1).optional(),
  source_type: z.enum(["official_docs", "maintainer", "paper", "issue_thread", "example", "writeup", "other"]).default("other"),
  provenance: z.enum(["quoted", "paraphrased", "summarized"]).default("summarized"),
  relevance: z.string().min(1).optional(),
}).strict();
export type RuntimeEvidenceResearchSource = z.infer<typeof RuntimeEvidenceResearchSourceSchema>;

export const RuntimeEvidenceResearchFindingSchema = z.object({
  finding: z.string().min(1),
  source_urls: z.array(z.string().url()).min(1),
  applicability: z.string().min(1),
  risks_constraints: z.array(z.string().min(1)).default([]),
  proposed_experiment: z.string().min(1),
  expected_metric_impact: z.string().min(1),
  fact_vs_adaptation: z.object({
    facts: z.array(z.string().min(1)).default([]),
    adaptation: z.string().min(1),
  }).strict(),
}).strict();
export type RuntimeEvidenceResearchFinding = z.infer<typeof RuntimeEvidenceResearchFindingSchema>;

export const RuntimeEvidenceResearchExternalActionSchema = z.object({
  label: z.string().min(1),
  reason: z.string().min(1),
  approval_required: z.literal(true).default(true),
}).strict();
export type RuntimeEvidenceResearchExternalAction = z.infer<typeof RuntimeEvidenceResearchExternalActionSchema>;

export const RuntimeEvidenceResearchMemoSchema = z.object({
  trigger: z.enum(["plateau", "uncertainty", "knowledge_gap"]),
  query: z.string().min(1),
  summary: z.string().min(1),
  sources: z.array(RuntimeEvidenceResearchSourceSchema).min(1),
  findings: z.array(RuntimeEvidenceResearchFindingSchema).min(1),
  candidate_playbook: z.object({
    title: z.string().min(1),
    steps: z.array(z.string().min(1)).default([]),
    source_urls: z.array(z.string().url()).default([]),
  }).strict().optional(),
  untrusted_content_policy: z.literal("webpage_instructions_are_untrusted").default("webpage_instructions_are_untrusted"),
  external_actions: z.array(RuntimeEvidenceResearchExternalActionSchema).default([]),
  confidence: z.number().min(0).max(1).default(0.5),
}).strict();
export type RuntimeEvidenceResearchMemo = z.infer<typeof RuntimeEvidenceResearchMemoSchema>;

export const RuntimeEvidenceDreamCheckpointTriggerSchema = z.enum([
  "iteration",
  "plateau",
  "breakthrough",
  "pre_finalization",
]);
export type RuntimeEvidenceDreamCheckpointTrigger = z.infer<typeof RuntimeEvidenceDreamCheckpointTriggerSchema>;

export const RuntimeEvidenceMemoryUsageStatsSchema = z.object({
  last_used_at: z.string().datetime().nullable().default(null),
  use_count: z.number().int().nonnegative().default(0),
  validated_count: z.number().int().nonnegative().default(0),
  negative_outcome_count: z.number().int().nonnegative().default(0),
}).strict();
export type RuntimeEvidenceMemoryUsageStats = z.infer<typeof RuntimeEvidenceMemoryUsageStatsSchema>;

export const RuntimeEvidenceDreamCheckpointMemoryRefSchema = z.object({
  source_type: z.enum(["soil", "playbook", "runtime_evidence", "other"]),
  ref: z.string().min(1).optional(),
  summary: z.string().min(1),
  authority: z.literal("advisory_only").default("advisory_only"),
  relevance_score: z.number().min(0).max(1).optional(),
  source_reliability: z.number().min(0).max(1).optional(),
  verification_status: MemoryVerificationStatusSchema.optional(),
  provenance: MemoryProvenanceSchema.optional(),
  quarantine_state: MemoryQuarantineStateSchema.optional(),
  recency_score: z.number().min(0).max(1).optional(),
  prior_success_contribution: z.number().min(0).max(1).optional(),
  retrieval: z.object({
    kind: z.enum(["route_hit", "fallback_hit", "checkpoint", "manual", "unknown"]).default("unknown"),
    score: z.number().min(0).max(1).optional(),
    confidence: z.number().min(0).max(1).optional(),
  }).strict().optional(),
  usage_stats: RuntimeEvidenceMemoryUsageStatsSchema.optional(),
  ranking_trace: z.object({
    score: z.number().min(0).max(1),
    decision: z.enum(["admitted", "rejected"]),
    reason: z.string().min(1),
  }).strict().optional(),
}).strict();
export type RuntimeEvidenceDreamCheckpointMemoryRef = z.infer<typeof RuntimeEvidenceDreamCheckpointMemoryRefSchema>;

export const RuntimeEvidenceDreamCheckpointStrategyCandidateSchema = z.object({
  candidate_ref: z.string().min(1).optional(),
  title: z.string().min(1),
  rationale: z.string().min(1),
  target_dimensions: z.array(z.string().min(1)).default([]),
  expected_evidence_gain: z.string().min(1).optional(),
  retry_reason: z.string().min(1).optional(),
  failed_lineage_fingerprints: z.array(z.string().min(1)).optional(),
  failed_lineage_warning: z.object({
    fingerprint: z.string().min(1),
    count: z.number().int().positive(),
    reason: z.string().min(1),
  }).strict().optional(),
}).strict();
export type RuntimeEvidenceDreamCheckpointStrategyCandidate = z.infer<typeof RuntimeEvidenceDreamCheckpointStrategyCandidateSchema>;

export const RuntimeEvidenceDreamCheckpointActiveHypothesisSchema = z.object({
  hypothesis: z.string().min(1),
  supporting_evidence_ref: z.string().min(1).optional(),
  target_metric_or_dimension: z.string().min(1),
  expected_next_observation: z.string().min(1),
  status: z.enum(["active", "testing", "supported", "weakened"]).default("active"),
}).strict();
export type RuntimeEvidenceDreamCheckpointActiveHypothesis = z.infer<typeof RuntimeEvidenceDreamCheckpointActiveHypothesisSchema>;

export const RuntimeEvidenceDreamCheckpointRejectedApproachSchema = z.object({
  approach: z.string().min(1),
  rejection_reason: z.string().min(1),
  candidate_ref: z.string().min(1).optional(),
  evidence_ref: z.string().min(1).optional(),
  revisit_condition: z.string().min(1).optional(),
  confidence: z.number().min(0).max(1).default(0.5),
}).strict();
export type RuntimeEvidenceDreamCheckpointRejectedApproach = z.infer<typeof RuntimeEvidenceDreamCheckpointRejectedApproachSchema>;

export const RuntimeEvidenceDreamRunControlRecommendationSchema = z.object({
  id: z.string().min(1).optional(),
  action: z.enum([
    "stay_current_mode",
    "widen_exploration",
    "consolidate_candidates",
    "freeze_experiment_queue",
    "enter_finalization",
    "preserve_near_miss_candidates",
    "retire_low_value_lineage",
    "request_operator_approval",
  ]),
  rationale: z.string().min(1),
  evidence: z.array(z.object({
    kind: z.enum(["metric", "artifact", "lineage", "task_history", "deadline", "external_feedback", "memory", "runtime_state"]),
    ref: z.string().min(1).optional(),
    summary: z.string().min(1),
  }).strict()).min(1),
  target_mode: z.enum(["exploration", "consolidation", "finalization"]).optional(),
  target_strategy_family: z.string().min(1).optional(),
  candidate_refs: z.array(z.string().min(1)).default([]),
  lineage_refs: z.array(z.string().min(1)).default([]),
  approval_required: z.boolean().default(false),
  risk: z.enum(["low", "medium", "high"]).default("medium"),
  confidence: z.number().min(0).max(1).default(0.5),
  policy_decision: z.object({
    disposition: z.enum(["auto_apply", "approval_required", "advisory_only"]),
    reason: z.string().min(1),
  }).strict().optional(),
}).strict();
export type RuntimeEvidenceDreamRunControlRecommendation = z.infer<typeof RuntimeEvidenceDreamRunControlRecommendationSchema>;

export const RuntimeEvidenceDreamCheckpointSchema = z.object({
  trigger: RuntimeEvidenceDreamCheckpointTriggerSchema,
  summary: z.string().min(1),
  current_goal: z.string().min(1),
  active_dimensions: z.array(z.string().min(1)).default([]),
  best_evidence_so_far: z.string().min(1).optional(),
  recent_strategy_families: z.array(z.string().min(1)).default([]),
  exhausted: z.array(z.string().min(1)).default([]),
  promising: z.array(z.string().min(1)).default([]),
  relevant_memories: z.array(RuntimeEvidenceDreamCheckpointMemoryRefSchema).default([]),
  active_hypotheses: z.array(RuntimeEvidenceDreamCheckpointActiveHypothesisSchema).default([]),
  rejected_approaches: z.array(RuntimeEvidenceDreamCheckpointRejectedApproachSchema).default([]),
  next_strategy_candidates: z.array(RuntimeEvidenceDreamCheckpointStrategyCandidateSchema).default([]),
  run_control_recommendations: z.array(RuntimeEvidenceDreamRunControlRecommendationSchema).optional(),
  guidance: z.string().min(1),
  uncertainty: z.array(z.string().min(1)).default([]),
  context_authority: z.literal("advisory_only").default("advisory_only"),
  confidence: z.number().min(0).max(1).default(0.5),
}).strict();
export type RuntimeEvidenceDreamCheckpoint = z.infer<typeof RuntimeEvidenceDreamCheckpointSchema>;

export const RuntimeEvidenceDivergentHypothesisSchema = z.object({
  strategy_id: z.string().min(1).optional(),
  hypothesis: z.string().min(1),
  strategy_family: z.string().min(1),
  role: z.enum(["exploitation", "adjacent_exploration", "divergent_exploration"]),
  novelty_score: z.number().min(0).max(1),
  similarity_to_recent_failures: z.number().min(0).max(1).default(0),
  expected_cost: z.enum(["low", "medium", "high"]),
  relationship_to_lineage: z.enum([
    "current_best",
    "neighbor",
    "failed_lineage",
    "different_mechanism",
    "different_assumption",
    "unknown",
  ]),
  prior_evidence: z.string().min(1).optional(),
  downrank_reason: z.string().min(1).optional(),
  smoke_status: z.enum(["not_run", "promote", "defer", "retire"]).default("not_run"),
  smoke_reason: z.string().min(1).optional(),
  smoke_evidence_ref: z.string().min(1).optional(),
  evidence_authority: z.literal("speculative_hypothesis").default("speculative_hypothesis"),
}).strict();
export type RuntimeEvidenceDivergentHypothesis = z.infer<typeof RuntimeEvidenceDivergentHypothesisSchema>;

export const RuntimeEvidenceEntrySchema = z.object({
  schema_version: z.literal("runtime-evidence-entry-v1"),
  id: z.string().min(1),
  occurred_at: z.string().datetime(),
  kind: RuntimeEvidenceEntryKindSchema,
  scope: z.object({
    goal_id: z.string().min(1).optional(),
    run_id: z.string().min(1).optional(),
    task_id: z.string().min(1).optional(),
    loop_index: z.number().int().nonnegative().optional(),
    phase: z.string().min(1).optional(),
  }).strict(),
  hypothesis: z.string().min(1).optional(),
  strategy: z.string().min(1).optional(),
  task: z.object({
    id: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    action: z.string().min(1).optional(),
    primary_dimension: z.string().min(1).optional(),
  }).strict().optional(),
  verification: z.object({
    command: z.string().min(1).optional(),
    verdict: z.string().min(1).optional(),
    confidence: z.number().min(0).max(1).optional(),
    summary: z.string().min(1).optional(),
  }).strict().optional(),
  metrics: z.array(RuntimeEvidenceMetricSchema).default([]),
  evaluators: z.array(RuntimeEvidenceEvaluatorObservationSchema).optional(),
  research: z.array(RuntimeEvidenceResearchMemoSchema).optional(),
  dream_checkpoints: z.array(RuntimeEvidenceDreamCheckpointSchema).optional(),
  divergent_exploration: z.array(RuntimeEvidenceDivergentHypothesisSchema).optional(),
  correction: MemoryCorrectionEntrySchema.optional(),
  correction_state: MemoryCorrectionTargetStateSchema.optional(),
  verification_status: MemoryVerificationStatusSchema.optional(),
  provenance: MemoryProvenanceSchema.optional(),
  quarantine_state: MemoryQuarantineStateSchema.optional(),
  candidates: z.array(RuntimeEvidenceCandidateRecordSchema).optional(),
  artifacts: z.array(RuntimeEvidenceArtifactRefSchema).default([]),
  result: z.object({
    status: z.string().min(1).optional(),
    summary: z.string().min(1).optional(),
    error: z.string().min(1).optional(),
  }).strict().optional(),
  outcome: RuntimeEvidenceOutcomeSchema.optional(),
  decision_reason: z.string().min(1).optional(),
  raw_refs: z.array(z.object({
    kind: z.string().min(1),
    id: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
    state_relative_path: z.string().min(1).optional(),
    url: z.string().url().optional(),
  }).strict()).default([]),
  summary: z.string().min(1).optional(),
}).strict().refine((entry) => entry.scope.goal_id || entry.scope.run_id, {
  message: "goal_id or run_id is required",
  path: ["scope"],
});
export type RuntimeEvidenceEntry = z.infer<typeof RuntimeEvidenceEntrySchema>;
export type RuntimeEvidenceEntryInput = Omit<
  RuntimeEvidenceEntry,
  "schema_version" | "id" | "occurred_at" | "metrics" | "evaluators" | "research" | "dream_checkpoints" | "divergent_exploration" | "artifacts" | "raw_refs"
> & Partial<Pick<RuntimeEvidenceEntry, "id" | "occurred_at" | "metrics" | "evaluators" | "research" | "dream_checkpoints" | "divergent_exploration" | "artifacts" | "raw_refs">>;

export interface RuntimeEvidenceReadWarning {
  file: string;
  line: number;
  message: string;
}

export interface RuntimeEvidenceReadResult {
  entries: RuntimeEvidenceEntry[];
  warnings: RuntimeEvidenceReadWarning[];
}
