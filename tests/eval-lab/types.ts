import { z } from "zod/v3";

export const EvalMetricKeySchema = z.enum([
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
export type EvalMetricKey = z.infer<typeof EvalMetricKeySchema>;

export const EvalMetricsSchema = z.object({
  overreach_rate: z.number().finite().nonnegative(),
  missed_help_rate: z.number().finite().nonnegative(),
  duplicate_side_effect_rate: z.number().finite().nonnegative(),
  stale_action_rejection_rate: z.number().finite().min(0).max(1),
  memory_retrieval_hit_rate: z.number().finite().min(0).max(1),
  corrected_memory_reuse_rate: z.number().finite().min(0).max(1),
  sensitive_leak_rate: z.number().finite().nonnegative(),
  approval_bypass_rate: z.number().finite().nonnegative(),
  replay_equivalence_rate: z.number().finite().min(0).max(1),
  scenario_pass_rate: z.number().finite().min(0).max(1),
}).strict();
export type EvalMetrics = z.infer<typeof EvalMetricsSchema>;

export const EvalMetricThresholdSchema = z.object({
  metric: EvalMetricKeySchema,
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
}).strict();
export type EvalMetricThreshold = z.infer<typeof EvalMetricThresholdSchema>;

export const EvalCoverageSchema = z.enum([
  "multi_turn_chat_with_memory_use",
  "corrected_memory_reuse",
  "stale_memory_rejected",
  "schedule_wake_after_fake_time",
  "daemon_restart_pending_approval",
  "duplicate_delivery_prevention_after_replay",
  "tool_capability_failure_recovery",
  "quiet_mode_proactivity_hold",
  "overreach_feedback_lowers_intervention",
  "missed_help_detection",
  "stale_action_binding_rejection",
  "gateway_telegram_projection_consistency",
]);
export type EvalCoverage = z.infer<typeof EvalCoverageSchema>;

export const EvalStepSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("user_turn"),
    input: z.string(),
    expected_assistant: z.string(),
    gateway: z.boolean().default(true),
    memory_refs: z.array(z.string()).default([]),
  }).strict(),
  z.object({
    kind: z.literal("memory_seed"),
    key: z.string(),
    value: z.string(),
    memory_type: z.enum(["fact", "preference", "procedure", "observation"]).default("fact"),
    sensitivity: z.enum(["public", "local", "private", "secret"]).default("local"),
  }).strict(),
  z.object({
    kind: z.literal("memory_correction"),
    target_key: z.string(),
    replacement_key: z.string(),
    replacement_value: z.string(),
  }).strict(),
  z.object({
    kind: z.literal("schedule_wake"),
    advance_ms: z.number().finite().int().nonnegative(),
  }).strict(),
  z.object({
    kind: z.literal("approval_response"),
    approved: z.boolean(),
    restart_daemon_before_response: z.boolean().default(false),
  }).strict(),
  z.object({
    kind: z.literal("delivery_replay"),
    delivery_id: z.string(),
    duplicate_attempts: z.number().finite().int().nonnegative().default(1),
  }).strict(),
  z.object({
    kind: z.literal("tool_capability"),
    tool_name: z.string(),
    fail_first: z.boolean().default(false),
  }).strict(),
  z.object({
    kind: z.literal("quiet_mode"),
    quieting_ref: z.string(),
    requested_delivery_kind: z.enum(["suggest", "notify"]),
  }).strict(),
  z.object({
    kind: z.literal("feedback"),
    feedback_kind: z.enum(["overreach", "missed_help"]),
    lowers_future_intervention: z.boolean().default(false),
  }).strict(),
  z.object({
    kind: z.literal("stale_action_binding"),
    callback_id: z.string(),
    current_delivery_id: z.string(),
    stale_delivery_id: z.string(),
  }).strict(),
  z.object({
    kind: z.literal("telegram_projection"),
    delivery_id: z.string(),
    conversation_id: z.string(),
    transport_message_ref: z.string(),
  }).strict(),
  z.object({
    kind: z.literal("event_log_replay"),
  }).strict(),
]);
export type EvalStep = z.infer<typeof EvalStepSchema>;

export const EvalScenarioSchema = z.object({
  schema_version: z.literal("pulseed.eval-lab.scenario/v1"),
  scenario_id: z.string().min(1),
  seed: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  coverage: z.array(EvalCoverageSchema).min(1),
  fake_controls: z.object({
    clock_start: z.string().datetime(),
    provider_model: z.string().min(1),
    telegram_gateway: z.object({
      platform: z.literal("telegram"),
      conversation_id: z.string().min(1),
      user_id: z.string().min(1),
    }).strict(),
    filesystem_workspace: z.string().min(1),
    network: z.object({
      blocked: z.literal(true),
    }).strict(),
    plugin_capability: z.object({
      capability_id: z.string().min(1),
      available: z.boolean(),
    }).strict(),
  }).strict(),
  provider_script: z.array(z.object({
    request_phase: z.string().min(1),
    response_text: z.string(),
  }).strict()).default([]),
  steps: z.array(EvalStepSchema).min(1),
  metric_thresholds: z.array(EvalMetricThresholdSchema).default([]),
}).strict();
export type EvalScenario = z.infer<typeof EvalScenarioSchema>;

export const EvalRunArtifactSchema = z.object({
  schema_version: z.literal("pulseed.eval-lab.run-artifact/v1"),
  scenario_id: z.string().min(1),
  seed: z.string().min(1),
  started_at: z.string().datetime(),
  fake_clock: z.object({
    started_at: z.string().datetime(),
    ended_at: z.string().datetime(),
  }).strict(),
  runtime_event_refs: z.array(z.string()),
  runtime_graph_refs: z.array(z.string()),
  surface_projections: z.array(z.record(z.unknown())),
  operator_projections: z.array(z.record(z.unknown())),
  transcript: z.array(z.record(z.unknown())),
  replay_summary: z.record(z.unknown()),
  metrics: EvalMetricsSchema,
  failures: z.array(z.record(z.unknown())),
  reproduction_command: z.string().min(1),
  production_caller_paths: z.array(z.string().min(1)),
}).strict();
export type EvalRunArtifact = z.infer<typeof EvalRunArtifactSchema>;
