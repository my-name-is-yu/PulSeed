import { z } from "zod/v3";
import type { JsonObject, JsonValue } from "../harness/types.js";

export const EvalLabMetricNameSchema = z.enum([
  "overreach_rate",
  "missed_help_rate",
  "duplicate_side_effect_rate",
  "stale_action_rejection_rate",
  "memory_retrieval_hit_rate",
  "corrected_memory_reuse_rate",
  "sensitive_leak_rate",
  "approval_bypass_rate",
  "replay_equivalence_rate",
  "scenario_pass_rate",
]);
export type EvalLabMetricName = z.infer<typeof EvalLabMetricNameSchema>;

export const EvalLabMetricsSchema = z.object({
  overreach_rate: z.number().min(0).max(1),
  missed_help_rate: z.number().min(0).max(1),
  duplicate_side_effect_rate: z.number().min(0).max(1),
  stale_action_rejection_rate: z.number().min(0).max(1),
  memory_retrieval_hit_rate: z.number().min(0).max(1),
  corrected_memory_reuse_rate: z.number().min(0).max(1),
  sensitive_leak_rate: z.number().min(0).max(1),
  approval_bypass_rate: z.number().min(0).max(1),
  replay_equivalence_rate: z.number().min(0).max(1),
  scenario_pass_rate: z.number().min(0).max(1),
}).strict();
export type EvalLabMetrics = z.infer<typeof EvalLabMetricsSchema>;

const EvalMetricThresholdRecordSchema = z.object({
  overreach_rate: z.number().min(0).max(1).optional(),
  missed_help_rate: z.number().min(0).max(1).optional(),
  duplicate_side_effect_rate: z.number().min(0).max(1).optional(),
  stale_action_rejection_rate: z.number().min(0).max(1).optional(),
  memory_retrieval_hit_rate: z.number().min(0).max(1).optional(),
  corrected_memory_reuse_rate: z.number().min(0).max(1).optional(),
  sensitive_leak_rate: z.number().min(0).max(1).optional(),
  approval_bypass_rate: z.number().min(0).max(1).optional(),
  replay_equivalence_rate: z.number().min(0).max(1).optional(),
  scenario_pass_rate: z.number().min(0).max(1).optional(),
}).strict();

export const EvalMetricThresholdsSchema = z.object({
  minimums: EvalMetricThresholdRecordSchema.default({}),
  maximums: EvalMetricThresholdRecordSchema.default({}),
}).strict();
export type EvalMetricThresholds = z.infer<typeof EvalMetricThresholdsSchema>;

export const EvalLabStepKindSchema = z.enum([
  "fake_user_turn",
  "fake_provider_model",
  "fake_telegram_gateway",
  "fake_filesystem_workspace",
  "fake_clock_advance",
  "fake_network",
  "fake_plugin_capability",
  "daemon_restart",
  "event_log_replay",
  "schedule_wake",
  "approval_request",
  "approval_response",
  "memory_seed",
  "memory_recall",
  "memory_correction",
  "feedback",
  "quiet_proactivity_control",
  "proactivity_decision",
  "missed_help_observation",
  "stale_action_binding",
  "force_failure",
]);
export type EvalLabStepKind = z.infer<typeof EvalLabStepKindSchema>;

export const EvalLabStepSchema = z.object({
  kind: EvalLabStepKindSchema,
  id: z.string().min(1),
  at: z.string().datetime().optional(),
  input: z.record(z.unknown()).default({}),
}).strict();
export type EvalLabStep = z.infer<typeof EvalLabStepSchema>;

export const EvalLabScenarioSchema = z.object({
  schema_version: z.literal("pulseed.eval-lab.scenario/v1"),
  scenario_id: z.string().min(1),
  seed: z.string().min(1),
  title: z.string().min(1),
  covers: z.array(z.string().min(1)).min(1),
  started_at: z.string().datetime(),
  steps: z.array(EvalLabStepSchema).min(1),
  model_script: z.array(z.object({
    request_phase: z.string().min(1),
    response: z.record(z.unknown()),
  }).strict()).default([]),
  tool_script: z.array(z.object({
    name: z.string().min(1),
    args: z.record(z.unknown()).optional(),
    approval_required: z.boolean().optional(),
    approved: z.boolean().optional(),
    result: z.record(z.unknown()),
    side_effect_artifact: z.record(z.unknown()).optional(),
  }).strict()).default([]),
  expectations: z.object({
    metric_thresholds: EvalMetricThresholdsSchema.default({ minimums: {}, maximums: {} }),
    required_event_types: z.array(z.string().min(1)).default([]),
    required_runtime_graph_edge_kinds: z.array(z.string().min(1)).default([]),
    required_failure_codes: z.array(z.string().min(1)).default([]),
  }).strict().default({
    metric_thresholds: { minimums: {}, maximums: {} },
    required_event_types: [],
    required_runtime_graph_edge_kinds: [],
    required_failure_codes: [],
  }),
}).strict();
export type EvalLabScenario = z.infer<typeof EvalLabScenarioSchema>;

export const EvalLabTranscriptEntrySchema = z.object({
  at: z.string().datetime(),
  role: z.enum(["user", "assistant", "system", "tool", "runtime"]),
  source: z.string().min(1),
  text: z.string(),
  refs: z.array(z.string().min(1)).default([]),
}).strict();
export type EvalLabTranscriptEntry = z.infer<typeof EvalLabTranscriptEntrySchema>;

export const EvalLabFailureSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  refs: z.array(z.string().min(1)).default([]),
  expected: z.unknown().optional(),
  actual: z.unknown().optional(),
}).strict();
export type EvalLabFailure = z.infer<typeof EvalLabFailureSchema>;

export const EvalRunArtifactSchema = z.object({
  schema_version: z.literal("pulseed.eval-lab.run-artifact/v1"),
  scenario_id: z.string().min(1),
  seed: z.string().min(1),
  started_at: z.string().datetime(),
  fake_clock: z.object({
    started_at: z.string().datetime(),
    current_at: z.string().datetime(),
  }).strict(),
  runtime_event_refs: z.array(z.object({
    event_id: z.string().min(1),
    event_type: z.string().min(1),
    trace_id: z.string().min(1),
    idempotency_key: z.string().min(1),
  }).strict()),
  runtime_graph_refs: z.object({
    node_refs: z.array(z.string().min(1)),
    edge_refs: z.array(z.string().min(1)),
    edge_kinds: z.record(z.number().int().nonnegative()),
  }).strict(),
  surface_projections: z.record(z.unknown()),
  operator_projections: z.record(z.unknown()),
  transcript: z.array(EvalLabTranscriptEntrySchema),
  replay_summary: z.object({
    source: z.literal("RuntimeEventLogStore.rebuildProjections"),
    source_event_count: z.number().int().nonnegative(),
    projection_names: z.array(z.string().min(1)),
    replay_equivalent: z.boolean(),
  }).strict(),
  metrics: EvalLabMetricsSchema,
  failures: z.array(EvalLabFailureSchema),
  reproduction_command: z.string().min(1),
}).strict();
export type EvalRunArtifact = z.infer<typeof EvalRunArtifactSchema>;

export interface EvalLabSuiteResult {
  artifacts: EvalRunArtifact[];
  metrics: EvalLabMetrics;
  artifact_paths: string[];
}

export function jsonObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as JsonObject;
}

export function jsonValue(value: unknown): JsonValue {
  return value as JsonValue;
}
