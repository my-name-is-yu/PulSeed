import { z } from "zod/v3";

const ScheduleToolPositiveSafeIntegerSchema = z.number().finite().int().min(1).max(Number.MAX_SAFE_INTEGER);
const ScheduleToolNonNegativeSafeIntegerSchema = z.number().finite().int().min(0).max(Number.MAX_SAFE_INTEGER);
const ScheduleToolNonNegativeSafeNumberSchema = z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER);
const ScheduleToolFiniteSafeNumberSchema = z.number().finite().safe();
const ScheduleToolUnitIntervalSchema = z.number().finite().safe().min(0).max(1);
const ScheduleToolTcpPortSchema = z.number().finite().int().min(1).max(65535);

export const ScheduleToolTriggerInputSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("cron"),
    expression: z.string(),
    timezone: z.string().default("UTC"),
  }).strict(),
  z.object({
    type: z.literal("interval"),
    seconds: ScheduleToolPositiveSafeIntegerSchema,
    jitter_factor: ScheduleToolUnitIntervalSchema.default(0),
  }).strict(),
]);

const HeartbeatConfigBaseInputSchema = z.object({
  failure_threshold: ScheduleToolPositiveSafeIntegerSchema.default(3),
  timeout_ms: ScheduleToolPositiveSafeIntegerSchema.min(100).default(5000),
});

const HeartbeatHttpCheckConfigInputSchema = z.object({
  url: z.string().url(),
}).strict();

const HeartbeatTcpCheckConfigInputSchema = z.object({
  host: z.string().min(1),
  port: ScheduleToolTcpPortSchema,
}).strict();

const HeartbeatProcessCheckConfigInputSchema = z.object({
  pid: ScheduleToolPositiveSafeIntegerSchema,
}).strict();

const HeartbeatDiskCheckConfigInputSchema = z.object({
  path: z.string().min(1),
}).strict();

const HeartbeatCustomCheckConfigInputSchema = z.object({
  command: z.string().min(1),
}).strict();

export const ScheduleToolHeartbeatConfigInputSchema = z.discriminatedUnion("check_type", [
  HeartbeatConfigBaseInputSchema.extend({
    check_type: z.literal("http"),
    check_config: HeartbeatHttpCheckConfigInputSchema,
  }).strict(),
  HeartbeatConfigBaseInputSchema.extend({
    check_type: z.literal("tcp"),
    check_config: HeartbeatTcpCheckConfigInputSchema,
  }).strict(),
  HeartbeatConfigBaseInputSchema.extend({
    check_type: z.literal("process"),
    check_config: HeartbeatProcessCheckConfigInputSchema,
  }).strict(),
  HeartbeatConfigBaseInputSchema.extend({
    check_type: z.literal("disk"),
    check_config: HeartbeatDiskCheckConfigInputSchema,
  }).strict(),
  HeartbeatConfigBaseInputSchema.extend({
    check_type: z.literal("custom"),
    check_config: HeartbeatCustomCheckConfigInputSchema,
  }).strict(),
]);

export const ScheduleToolProbeConfigInputSchema = z.object({
  data_source_id: z.string(),
  probe_dimension: z.string().optional(),
  query_params: z.record(z.unknown()).default({}),
  change_detector: z.object({
    mode: z.enum(["threshold", "diff", "presence"]),
    threshold_value: z.number().finite().safe().optional(),
    baseline_window: ScheduleToolPositiveSafeIntegerSchema.default(5),
  }).strict(),
  llm_on_change: z.boolean().default(true),
  llm_prompt_template: z.string().optional(),
}).strict();

export const ScheduleToolCronConfigInputSchema = z.object({
  job_kind: z.enum(["prompt", "reflection", "soil_publish"]).default("prompt"),
  reflection_kind: z.enum([
    "morning_planning",
    "evening_catchup",
    "weekly_review",
    "dream_consolidation",
  ]).optional(),
  prompt_template: z.string(),
  context_sources: z.array(z.string()).default([]),
  output_format: z.enum(["notification", "report", "both"]).default("notification"),
  report_type: z.string().optional(),
  max_tokens: ScheduleToolNonNegativeSafeIntegerSchema.default(4000),
}).strict().superRefine((value, ctx) => {
  if (value.job_kind === "reflection" && !value.reflection_kind) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["reflection_kind"],
      message: "reflection_kind is required when job_kind is reflection",
    });
  }
});

export const ScheduleToolGoalTriggerConfigInputSchema = z.object({
  goal_id: z.string(),
  run_policy: z.enum(["bounded", "resident"]).default("bounded"),
  max_iterations: ScheduleToolPositiveSafeIntegerSchema.nullable().default(10),
  skip_if_active: z.boolean().default(true),
}).strict().superRefine((value, ctx) => {
  if (value.run_policy === "bounded" && value.max_iterations === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["max_iterations"],
      message: "bounded goal triggers require max_iterations",
    });
  }
});

export const ScheduleToolEscalationConfigInputSchema = z.object({
  enabled: z.boolean().default(false),
  target_layer: z.enum(["probe", "cron", "goal_trigger"]).optional(),
  target_entry_id: z.string().optional(),
  target_goal_id: z.string().optional(),
  cooldown_minutes: ScheduleToolNonNegativeSafeNumberSchema.default(15),
  max_per_hour: ScheduleToolNonNegativeSafeIntegerSchema.default(4),
  circuit_breaker_threshold: ScheduleToolPositiveSafeIntegerSchema.default(10),
}).strict();

const ScheduleToolPresetBaseInputSchema = z.object({
  name: z.string().min(1).optional(),
  enabled: z.boolean().default(true),
  trigger: ScheduleToolTriggerInputSchema.optional(),
}).strict();

export const ScheduleToolPresetInputSchema = z.discriminatedUnion("preset", [
  ScheduleToolPresetBaseInputSchema.extend({
    preset: z.literal("daily_brief"),
    context_sources: z.array(z.string()).default([]),
  }).strict(),
  ScheduleToolPresetBaseInputSchema.extend({
    preset: z.literal("weekly_review"),
    context_sources: z.array(z.string()).default([]),
  }).strict(),
  ScheduleToolPresetBaseInputSchema.extend({
    preset: z.literal("dream_consolidation"),
    context_sources: z.array(z.string()).default([]),
  }).strict(),
  ScheduleToolPresetBaseInputSchema.extend({
    preset: z.literal("soil_publish"),
  }).strict(),
  ScheduleToolPresetBaseInputSchema.extend({
    preset: z.literal("goal_probe"),
    data_source_id: z.string().min(1),
    probe_dimension: z.string().optional(),
    query_params: z.record(z.string(), z.unknown()).default({}),
    detector_mode: z.enum(["threshold", "diff", "presence"]).default("diff"),
    threshold_value: ScheduleToolFiniteSafeNumberSchema.optional(),
    baseline_window: ScheduleToolPositiveSafeIntegerSchema.default(5),
    llm_on_change: z.boolean().default(true),
    llm_prompt_template: z.string().optional(),
  }).strict(),
]);
