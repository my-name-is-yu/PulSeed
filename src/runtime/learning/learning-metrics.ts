import { z } from "zod/v3";

export const ExperienceLearningMetricNameSchema = z.enum([
  "experience_frames_created",
  "micro_probe_eligible_candidates",
  "micro_probe_attempted",
  "micro_probe_falsified",
  "micro_probe_deferred",
  "micro_probe_self_confirmation_rejections",
  "micro_probe_replay_drift_count",
  "hypotheses_created",
  "hypotheses_falsified",
  "generalization_candidates_created",
  "experiences_to_trial_reuse_ready",
  "experiences_to_promoted_generalization",
  "generalization_counterexample_capture_rate",
  "pre_registered_experiment_rate",
  "hypothesis_to_experiment_rate",
  "experiment_value_calibration",
  "trial_reuse_attempts",
  "trial_reuse_success_rate_by_scope",
  "negative_transfer_rate",
  "action_savings_after_reuse",
  "interaction_policy_bias_outcome_delta",
  "unsupported_compression_rejections",
  "artifacts_created",
  "artifacts_promoted",
  "artifacts_falsified",
  "learning_prior_injections",
  "stale_prior_suppression_count",
  "prior_suppressed_at_consumption",
  "prior_consumed_by_phase",
  "prior_outcome_delta",
  "repeated_failed_action_rate",
  "avoidable_loop_count",
  "falsification_latency",
  "contradiction_to_demotion_latency",
  "artifact_reuse_success_rate",
  "delayed_false_promotion_rate",
]);
export type ExperienceLearningMetricName = z.infer<typeof ExperienceLearningMetricNameSchema>;

export const ExperienceLearningMetricDefinitionSchema = z.object({
  name: ExperienceLearningMetricNameSchema,
  numerator: z.string().min(1),
  denominator: z.string().min(1),
  observation_timing: z.string().min(1),
  read_path: z.string().min(1),
}).strict();
export type ExperienceLearningMetricDefinition = z.infer<typeof ExperienceLearningMetricDefinitionSchema>;

export const ExperienceLearningMetricValueSchema = z.object({
  name: ExperienceLearningMetricNameSchema,
  numerator_value: z.number().finite().nonnegative(),
  denominator_value: z.number().finite().nonnegative(),
  value: z.number().finite().nonnegative(),
}).strict();
export type ExperienceLearningMetricValue = z.infer<typeof ExperienceLearningMetricValueSchema>;

export const ExperienceLearningMetricsSnapshotSchema = z.object({
  schema_version: z.literal("experience-learning-metrics/v1"),
  generated_at: z.string().datetime(),
  goal_id: z.string().min(1).optional(),
  definitions: z.array(ExperienceLearningMetricDefinitionSchema),
  values: z.array(ExperienceLearningMetricValueSchema),
}).strict();
export type ExperienceLearningMetricsSnapshot = z.infer<typeof ExperienceLearningMetricsSnapshotSchema>;

export const EXPERIENCE_LEARNING_METRIC_DEFINITIONS: ExperienceLearningMetricDefinition[] = ExperienceLearningMetricNameSchema.options.map((name) =>
  ExperienceLearningMetricDefinitionSchema.parse({
    name,
    numerator: `count of ${name} observations in experience-learning projection tables`,
    denominator: `eligible experience-learning observations for ${name}`,
    observation_timing: "computed from the current control-DB projection after RuntimeEventLog replay or lifecycle append",
    read_path: "ExperienceLearningStateStore.getMetricsSnapshot",
  })
);
