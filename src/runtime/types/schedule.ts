import { z } from "zod/v3";
import {
  InhibitionDecisionKindSchema,
  OutcomeClassSchema,
} from "./companion-autonomy.js";
import {
  RuntimeItemPostureSchema,
  RuntimeItemStatusSchema,
  RuntimeItemTypeSchema,
  RuntimeItemVisibilityPolicySchema,
} from "./companion-state.js";
import { CapabilityOperationPlanAssemblySchema } from "./capability-operation-plan.js";

const SchedulePositiveSafeIntegerSchema = z.number().finite().int().min(1).max(Number.MAX_SAFE_INTEGER);
const ScheduleNonNegativeSafeIntegerSchema = z.number().finite().int().min(0).max(Number.MAX_SAFE_INTEGER);
const ScheduleNonNegativeSafeNumberSchema = z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER);
const ScheduleUnitIntervalSchema = z.number().finite().safe().min(0).max(1);
const ScheduleTcpPortSchema = z.number().finite().int().min(1).max(65535);

export const HeartbeatCheckTypeSchema = z.enum(["http", "tcp", "process", "disk", "custom"]);

const HeartbeatConfigBaseSchema = z.object({
  failure_threshold: SchedulePositiveSafeIntegerSchema.default(3),
  timeout_ms: SchedulePositiveSafeIntegerSchema.min(100).default(5000),
});

export const HeartbeatHttpCheckConfigSchema = z.object({
  url: z.string().url(),
});

export const HeartbeatTcpCheckConfigSchema = z.object({
  host: z.string().min(1),
  port: ScheduleTcpPortSchema,
});

export const HeartbeatProcessCheckConfigSchema = z.object({
  pid: SchedulePositiveSafeIntegerSchema,
});

export const HeartbeatDiskCheckConfigSchema = z.object({
  path: z.string().min(1),
});

export const HeartbeatCustomCheckConfigSchema = z.object({
  command: z.string().min(1),
});

export const HeartbeatConfigSchema = z.discriminatedUnion("check_type", [
  HeartbeatConfigBaseSchema.extend({
    check_type: z.literal("http"),
    check_config: HeartbeatHttpCheckConfigSchema,
  }),
  HeartbeatConfigBaseSchema.extend({
    check_type: z.literal("tcp"),
    check_config: HeartbeatTcpCheckConfigSchema,
  }),
  HeartbeatConfigBaseSchema.extend({
    check_type: z.literal("process"),
    check_config: HeartbeatProcessCheckConfigSchema,
  }),
  HeartbeatConfigBaseSchema.extend({
    check_type: z.literal("disk"),
    check_config: HeartbeatDiskCheckConfigSchema,
  }),
  HeartbeatConfigBaseSchema.extend({
    check_type: z.literal("custom"),
    check_config: HeartbeatCustomCheckConfigSchema,
  }),
]);

export type HeartbeatConfig = z.infer<typeof HeartbeatConfigSchema>;

export const ProbeConfigSchema = z.object({
  data_source_id: z.string(),
  probe_dimension: z.string().optional(),
  query_params: z.record(z.unknown()).default({}),
  change_detector: z.object({
    mode: z.enum(["threshold", "diff", "presence"]),
    threshold_value: z.number().finite().safe().optional(),
    baseline_window: SchedulePositiveSafeIntegerSchema.default(5),
  }),
  llm_on_change: z.boolean().default(true),
  llm_prompt_template: z.string().optional(),
});

export type ProbeConfig = z.infer<typeof ProbeConfigSchema>;

export const ReflectionJobKindSchema = z.enum([
  "morning_planning",
  "evening_catchup",
  "weekly_review",
  "dream_consolidation",
]);

export type ReflectionJobKind = z.infer<typeof ReflectionJobKindSchema>;

export const CronConfigSchema = z.object({
  job_kind: z.enum(["prompt", "reflection", "soil_publish"]).default("prompt"),
  reflection_kind: ReflectionJobKindSchema.optional(),
  prompt_template: z.string(),
  context_sources: z.array(z.string()).default([]),
  output_format: z.enum(['notification', 'report', 'both']).default('notification'),
  report_type: z.string().optional(),
  max_tokens: ScheduleNonNegativeSafeIntegerSchema.default(4000),
}).superRefine((value, ctx) => {
  if (value.job_kind === "reflection" && !value.reflection_kind) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["reflection_kind"],
      message: "reflection_kind is required when job_kind is reflection",
    });
  }
});

export type CronConfig = z.infer<typeof CronConfigSchema>;

export const GoalTriggerConfigSchema = z.object({
  goal_id: z.string(),
  run_policy: z.enum(["bounded", "resident"]).default("bounded"),
  max_iterations: SchedulePositiveSafeIntegerSchema.nullable().default(10),
  skip_if_active: z.boolean().default(true),
}).superRefine((value, ctx) => {
  if (value.run_policy === "bounded" && value.max_iterations === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["max_iterations"],
      message: "bounded goal triggers require max_iterations",
    });
  }
});

export type GoalTriggerConfig = z.infer<typeof GoalTriggerConfigSchema>;

export const ScheduleEntryMetadataSchema = z.object({
  source: z.enum(["manual", "preset", "dream", "external"]).default("manual"),
  preset_key: z.string().optional(),
  dream_suggestion_id: z.string().optional(),
  external_source_id: z.string().optional(),
  external_id: z.string().optional(),
  dependency_hints: z.array(z.string()).default([]),
  note: z.string().optional(),
  internal: z.boolean().optional(),
  activation_kind: z.enum(["wait_resume"]).optional(),
  goal_id: z.string().optional(),
  strategy_id: z.string().optional(),
  wait_strategy_id: z.string().optional(),
  personal_agent_replay_key: z.string().optional(),
});

export type ScheduleEntryMetadata = z.infer<typeof ScheduleEntryMetadataSchema>;

export const ScheduleFailureKindSchema = z.enum(["transient", "permanent"]);
export type ScheduleFailureKind = z.infer<typeof ScheduleFailureKindSchema>;

export const ScheduleInternalAttentionProjectionSchema = z.object({
  kind: z.literal("wait_resume_attention_projection"),
  projected_at: z.string().datetime(),
  signal_context_id: z.string().min(1),
  signal_sources: z.array(z.string().min(1)).default([]),
  urge_candidate_refs: z.array(z.string().min(1)).default([]),
  agenda_item_refs: z.array(z.string().min(1)).default([]),
  inhibition_decisions: z.array(z.object({
    ref: z.string().min(1),
    decision: InhibitionDecisionKindSchema,
  }).strict()).default([]),
  initiative_gate_decisions: z.array(z.object({
    ref: z.string().min(1),
    status: z.enum(["selected", "blocked", "delayed", "narrowed"]),
    selected_outcome: OutcomeClassSchema.optional(),
  }).strict()).default([]),
  runtime_items: z.array(z.object({
    ref: z.string().min(1),
    type: RuntimeItemTypeSchema,
    status: RuntimeItemStatusSchema,
    posture: RuntimeItemPostureSchema,
    visibility_display: RuntimeItemVisibilityPolicySchema.shape.display,
    inspectable: z.boolean(),
    auditable: z.boolean(),
  }).strict()).default([]),
  non_execution_states: z.array(z.enum([
    "blocked",
    "delayed",
    "held",
    "suppressed",
    "decayed",
    "expired",
    "rejected_stale",
    "inspectable_hidden",
    "silent_runtime_item",
  ])).default([]),
  summary: z.string().min(1),
}).strict();
export type ScheduleInternalAttentionProjection = z.infer<typeof ScheduleInternalAttentionProjectionSchema>;

export const MAX_SCHEDULE_RETRY_DELAY_MS = 24 * 60 * 60 * 1000;
export const MAX_SCHEDULE_RETRY_WINDOW_MS = 30 * MAX_SCHEDULE_RETRY_DELAY_MS;
export const MAX_SCHEDULE_RETRY_ATTEMPTS = 100;
export const MAX_SCHEDULE_RETRY_MULTIPLIER = 100;

export const ScheduleRetryPolicySchema = z.object({
  enabled: z.boolean().default(true),
  initial_delay_ms: z.number().finite().int().min(0).max(MAX_SCHEDULE_RETRY_DELAY_MS).default(30_000),
  max_delay_ms: z.number().finite().int().positive().max(MAX_SCHEDULE_RETRY_DELAY_MS).default(15 * 60 * 1000),
  multiplier: z.number().finite().min(1).max(MAX_SCHEDULE_RETRY_MULTIPLIER).default(2),
  jitter_factor: z.number().finite().min(0).max(1).default(0.2),
  max_attempts: z.number().finite().int().min(1).max(MAX_SCHEDULE_RETRY_ATTEMPTS).default(3),
  max_retry_window_ms: z.number().finite().int().positive().max(MAX_SCHEDULE_RETRY_WINDOW_MS).default(24 * 60 * 60 * 1000),
  retryable_failure_kinds: z.array(ScheduleFailureKindSchema).default(["transient"]),
});

export type ScheduleRetryPolicy = z.infer<typeof ScheduleRetryPolicySchema>;

export const ScheduleRetryStateSchema = z.object({
  attempts: z.number().finite().int().nonnegative().max(MAX_SCHEDULE_RETRY_ATTEMPTS).default(0),
  next_retry_at: z.string().datetime().nullable().default(null),
  scheduled_for: z.string().datetime().nullable().default(null),
  last_attempt_at: z.string().datetime().nullable().default(null),
  first_failure_at: z.string().datetime().nullable().default(null),
  last_failure_kind: ScheduleFailureKindSchema.nullable().default(null),
  last_error_message: z.string().nullable().default(null),
});

export type ScheduleRetryState = z.infer<typeof ScheduleRetryStateSchema>;

export const EscalationConfigSchema = z.object({
  enabled: z.boolean().default(false),
  target_layer: z.enum(["probe", "cron", "goal_trigger"]).optional(),
  target_entry_id: z.string().optional(),
  target_goal_id: z.string().optional(),
  cooldown_minutes: ScheduleNonNegativeSafeNumberSchema.default(15),
  max_per_hour: ScheduleNonNegativeSafeIntegerSchema.default(4),
  circuit_breaker_threshold: SchedulePositiveSafeIntegerSchema.default(10),
});

export type EscalationConfig = z.infer<typeof EscalationConfigSchema>;

export const ScheduleLayerSchema = z.enum(["heartbeat", "probe", "cron", "goal_trigger"]);

export const ScheduleTriggerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("cron"), expression: z.string(), timezone: z.string().default("UTC") }),
  z.object({
    type: z.literal("interval"),
    seconds: SchedulePositiveSafeIntegerSchema,
    jitter_factor: ScheduleUnitIntervalSchema.default(0),
  }),
]);
export type ScheduleTriggerInput = z.input<typeof ScheduleTriggerSchema>;

export const ScheduleEntrySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  layer: ScheduleLayerSchema,
  trigger: ScheduleTriggerSchema,
  enabled: z.boolean().default(true),
  metadata: ScheduleEntryMetadataSchema.optional(),
  heartbeat: HeartbeatConfigSchema.optional(),
  probe: ProbeConfigSchema.optional(),
  escalation: EscalationConfigSchema.optional(),
  retry_policy: ScheduleRetryPolicySchema.optional(),
  retry_state: ScheduleRetryStateSchema.nullable().optional(),
  baseline_results: z.array(z.unknown()).default([]),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  last_fired_at: z.string().datetime().nullable().default(null),
  next_fire_at: z.string().datetime(),
  consecutive_failures: ScheduleNonNegativeSafeIntegerSchema.default(0),
  last_escalation_at: z.string().datetime().nullable().default(null),
  escalation_timestamps: z.array(z.string().datetime()).default([]),
  total_executions: ScheduleNonNegativeSafeIntegerSchema.default(0),
  total_tokens_used: ScheduleNonNegativeSafeIntegerSchema.default(0),
  max_tokens_per_day: ScheduleNonNegativeSafeIntegerSchema.default(100000),
  tokens_used_today: ScheduleNonNegativeSafeIntegerSchema.default(0),
  budget_reset_at: z.string().datetime().nullable().default(null),
  cron: CronConfigSchema.optional(),
  goal_trigger: GoalTriggerConfigSchema.optional(),
});

export type ScheduleEntry = z.infer<typeof ScheduleEntrySchema>;
export type ScheduleEntryInput = z.input<typeof ScheduleEntrySchema>;

export const ScheduleEntryListSchema = z.array(ScheduleEntrySchema);

export const ScheduleResultSchema = z.object({
  entry_id: z.string().uuid(),
  status: z.enum(["ok", "degraded", "down", "skipped", "error", "escalated"]),
  duration_ms: ScheduleNonNegativeSafeIntegerSchema,
  error_message: z.string().optional(),
  fired_at: z.string().datetime(),
  layer: z.enum(["heartbeat", "probe", "cron", "goal_trigger"]).optional(),
  goal_id: z.string().optional(),
  failure_kind: ScheduleFailureKindSchema.optional(),
  tokens_used: ScheduleNonNegativeSafeIntegerSchema.default(0),
  escalated_to: z.string().nullable().default(null),
  output_summary: z.string().optional(),
  change_detected: z.boolean().optional(),
  internal_attention_projection: ScheduleInternalAttentionProjectionSchema.optional(),
  capability_operation_plan_assembly: CapabilityOperationPlanAssemblySchema.optional(),
});

export type ScheduleResult = z.infer<typeof ScheduleResultSchema>;
