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

export const ExperienceLearningMetricScenarioClassSchema = z.enum([
  "task_work",
  "stall_recovery",
  "companion_interaction",
]);
export type ExperienceLearningMetricScenarioClass = z.infer<typeof ExperienceLearningMetricScenarioClassSchema>;

export const ExperienceLearningMetricBaselineRunKindSchema = z.enum([
  "no_prior",
  "prior_enabled",
]);
export type ExperienceLearningMetricBaselineRunKind = z.infer<typeof ExperienceLearningMetricBaselineRunKindSchema>;

export const EXPERIENCE_LEARNING_BASELINE_SCENARIO_CLASSES = ExperienceLearningMetricScenarioClassSchema.options;
export const EXPERIENCE_LEARNING_BASELINE_RUN_KINDS = ExperienceLearningMetricBaselineRunKindSchema.options;

export const EXPERIENCE_LEARNING_PAIRED_BASELINE_REQUIRED_METRICS = [
  "experiences_to_trial_reuse_ready",
  "experiences_to_promoted_generalization",
  "action_savings_after_reuse",
  "interaction_policy_bias_outcome_delta",
  "prior_outcome_delta",
  "repeated_failed_action_rate",
  "avoidable_loop_count",
  "artifact_reuse_success_rate",
] as const satisfies readonly ExperienceLearningMetricName[];

export function experienceLearningMetricRequiresPairedBaseline(name: ExperienceLearningMetricName): boolean {
  return (EXPERIENCE_LEARNING_PAIRED_BASELINE_REQUIRED_METRICS as readonly ExperienceLearningMetricName[]).includes(name);
}

export const ExperienceLearningMetricBaselineRequirementSchema = z.object({
  required: z.boolean(),
  scenario_classes: z.array(ExperienceLearningMetricScenarioClassSchema),
  run_kinds: z.array(ExperienceLearningMetricBaselineRunKindSchema),
}).strict();
export type ExperienceLearningMetricBaselineRequirement = z.infer<typeof ExperienceLearningMetricBaselineRequirementSchema>;

export const ExperienceLearningMetricDefinitionSchema = z.object({
  name: ExperienceLearningMetricNameSchema,
  numerator: z.string().min(1),
  denominator: z.string().min(1),
  observation_timing: z.string().min(1),
  read_path: z.string().min(1),
  baseline_requirement: ExperienceLearningMetricBaselineRequirementSchema,
}).strict();
export type ExperienceLearningMetricDefinition = z.infer<typeof ExperienceLearningMetricDefinitionSchema>;

export const ExperienceLearningMetricBaselineObservationSchema = z.object({
  id: z.string().min(1),
  baselineId: z.string().min(1),
  goalId: z.string().min(1).optional(),
  scenarioClass: ExperienceLearningMetricScenarioClassSchema,
  runKind: ExperienceLearningMetricBaselineRunKindSchema,
  runRef: z.string().min(1),
  observedAt: z.string().datetime(),
  metricNames: z.array(ExperienceLearningMetricNameSchema).min(1),
  numeratorValue: z.number().finite().nonnegative(),
  denominatorValue: z.number().finite().nonnegative(),
  value: z.number().finite().nonnegative(),
}).strict();
export type ExperienceLearningMetricBaselineObservation = z.infer<typeof ExperienceLearningMetricBaselineObservationSchema>;

export const ExperienceLearningMetricValiditySchema = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("valid"),
    baseline_ids: z.array(z.string().min(1)),
    baseline_observation_ids: z.array(z.string().min(1)),
  }).strict(),
  z.object({
    decision: z.literal("invalid"),
    reason_codes: z.array(z.enum([
      "paired_baseline_required",
      "missing_task_work_pair",
      "missing_stall_recovery_pair",
      "missing_companion_interaction_pair",
    ])).min(1),
    missing_scenario_classes: z.array(ExperienceLearningMetricScenarioClassSchema),
    baseline_ids: z.array(z.string().min(1)),
    baseline_observation_ids: z.array(z.string().min(1)),
  }).strict(),
]);
export type ExperienceLearningMetricValidity = z.infer<typeof ExperienceLearningMetricValiditySchema>;

export const ExperienceLearningMetricValueSchema = z.object({
  name: ExperienceLearningMetricNameSchema,
  numerator_value: z.number().finite().nonnegative(),
  denominator_value: z.number().finite().nonnegative(),
  value: z.number().finite().nonnegative(),
  validity: ExperienceLearningMetricValiditySchema,
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
    baseline_requirement: experienceLearningMetricRequiresPairedBaseline(name)
      ? {
          required: true,
          scenario_classes: [...EXPERIENCE_LEARNING_BASELINE_SCENARIO_CLASSES],
          run_kinds: [...EXPERIENCE_LEARNING_BASELINE_RUN_KINDS],
        }
      : {
          required: false,
          scenario_classes: [],
          run_kinds: [],
        },
  })
);
