import { z } from "zod/v3";
import { SurfaceInspectionAdapterPayloadSchema } from "../../grounding/surface-contracts.js";
import { RuntimeSafePauseRecordSchema } from "../store/runtime-schemas.js";

const PID_EPOCH_ISO = "1970-01-01T00:00:00.000Z";
const MAX_EVENT_SERVER_PORT = 65_535;
const MAX_DAEMON_TIMER_MS = 2_147_483_647;
const DaemonPositiveTimerMsSchema = z.number().finite().int().positive().max(MAX_DAEMON_TIMER_MS);
const DaemonNonnegativeTimerMsSchema = z.number().finite().int().nonnegative().max(MAX_DAEMON_TIMER_MS);
const DaemonPositiveSafeIntSchema = z.number().finite().int().positive().safe();
const DaemonNonnegativeSafeIntSchema = z.number().finite().int().nonnegative().safe();
const DaemonPositiveFiniteNumberSchema = z.number().finite().positive().max(Number.MAX_SAFE_INTEGER);
const DaemonHourSchema = z.number().finite().int().min(0).max(23);
const DaemonPositiveFiniteMultiplierSchema = z.number().finite().positive().max(Number.MAX_SAFE_INTEGER);

function applyLegacyDaemonRunPolicy(raw: unknown): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return raw;
  }
  const input = raw as Record<string, unknown>;
  if (
    Object.prototype.hasOwnProperty.call(input, "run_policy")
    || !Object.prototype.hasOwnProperty.call(input, "iterations_per_cycle")
  ) {
    return raw;
  }
  const iterationsPerCycle = input.iterations_per_cycle;
  if (typeof iterationsPerCycle !== "number" || !Number.isInteger(iterationsPerCycle) || iterationsPerCycle <= 0) {
    return raw;
  }
  return {
    ...input,
    run_policy: { mode: "bounded", max_iterations: iterationsPerCycle },
  };
}

// Daemon configuration
const DaemonConfigObjectSchema = z.object({
  // Deprecated compatibility flag. Durable runtime recovery is always enabled.
  runtime_journal_v2: z.boolean().default(true),
  check_interval_ms: DaemonPositiveTimerMsSchema.default(300_000), // 5 min default
  pid_file: z.string().default("pulseed.pid"),
  log_dir: z.string().default("logs"),
  runtime_root: z.string().optional(),
  workspace_path: z.string().optional(),
  log_rotation: z.object({
    max_size_mb: DaemonPositiveFiniteNumberSchema.default(10),
    max_files: DaemonPositiveSafeIntSchema.default(5),
  }).default({}),
  crash_recovery: z.object({
    enabled: z.boolean().default(true),
    max_retries: DaemonNonnegativeSafeIntSchema.default(3),
    retry_delay_ms: DaemonPositiveTimerMsSchema.default(10_000),
    graceful_shutdown_timeout_ms: DaemonPositiveTimerMsSchema.optional(),
  }).default({}),
  goal_intervals: z.record(z.string(), DaemonPositiveTimerMsSchema).optional(), // goal_id -> interval_ms override
  iterations_per_cycle: DaemonPositiveSafeIntSchema.default(10), // telemetry window in resident mode; bounded fallback cap
  max_concurrent_goals: DaemonPositiveSafeIntSchema.default(4), // max goals the supervisor may execute at once
  event_server_port: z.number().int().min(0).max(MAX_EVENT_SERVER_PORT).default(41700), // EventServer HTTP port (0 = OS-assigned, safe for tests)
  gateway: z.object({
    slack: z.object({
      enabled: z.boolean().default(false),
      signing_secret: z.string().optional(),
      bot_token: z.string().optional(),
      path: z.string().default("/slack/events"),
      channel_goal_map: z.record(z.string()).default({}),
    }).default({}),
  }).default({}),
  proactive_mode: z.boolean().default(false),
  run_policy: z.object({
    mode: z.enum(["bounded", "resident"]).default("resident"),
    max_iterations: DaemonPositiveSafeIntSchema.nullable().default(null),
  }).default({}),
  proactive_interval_ms: DaemonNonnegativeTimerMsSchema.default(3_600_000), // 1 hour default between proactive ticks
  goal_review_interval_ms: DaemonNonnegativeTimerMsSchema.default(7 * 24 * 60 * 60 * 1000), // weekly goal review cadence
  adaptive_sleep: z.object({
    enabled: z.boolean().default(false),
    min_interval_ms: DaemonPositiveTimerMsSchema.default(60_000), // 1 minute minimum
    max_interval_ms: DaemonPositiveTimerMsSchema.default(1_800_000), // 30 minutes maximum
    night_start_hour: DaemonHourSchema.default(22), // 22:00
    night_end_hour: DaemonHourSchema.default(7), // 07:00
    night_multiplier: DaemonPositiveFiniteMultiplierSchema.default(2.0), // 2x interval at night
  }).default({}),
});
export const DaemonConfigSchema = z.preprocess(applyLegacyDaemonRunPolicy, DaemonConfigObjectSchema);
export type DaemonConfig = z.infer<typeof DaemonConfigSchema>;

export const ResidentActivitySchema = z.object({
  intervention_id: z.string().optional(),
  kind: z.enum(["sleep", "suggestion", "negotiation", "curiosity", "dream", "observation", "skipped", "error"]),
  trigger: z.enum(["proactive_tick", "schedule", "external"]).default("proactive_tick"),
  summary: z.string(),
  recorded_at: z.string().datetime(),
  suggestion_title: z.string().optional(),
  goal_id: z.string().optional(),
  surface_id: z.string().optional(),
  surface_included_count: DaemonNonnegativeSafeIntSchema.optional(),
  surface_excluded_count: DaemonNonnegativeSafeIntSchema.optional(),
  surface_inspection: SurfaceInspectionAdapterPayloadSchema.optional(),
  surface_inspections: z.array(SurfaceInspectionAdapterPayloadSchema).optional(),
  attention_input_id: z.string().optional(),
  attention_replay_disposition: z.enum(["accepted", "duplicate"]).optional(),
  agenda_item_id: z.string().optional(),
  outcome_decision_id: z.string().optional(),
  operation_plan_assembly_id: z.string().optional(),
  operation_plan_status: z.enum(["planned", "no_supported_plan", "clarification_required", "fail_closed"]).optional(),
  operation_plan_reason: z.string().optional(),
  operation_plan_id: z.string().optional(),
  operation_admission_evaluation_id: z.string().optional(),
  autonomy_decision_id: z.string().optional(),
  autonomy_decision_level: z.enum([
    "advisory",
    "prepare_only",
    "user_directed_execute",
    "autonomous_low_risk",
    "approval_required",
    "prohibited",
  ]).optional(),
  operation_preparation_allowed: z.boolean().optional(),
  operation_execution_allowed: z.boolean().optional(),
  cognition_id: z.string().optional(),
  cognition_response_plan_id: z.string().optional(),
  cognition_delivery_kind: z.enum(["hold", "digest", "suggest", "notify", "speak", "prepare", "execute"]).optional(),
  cognition_writeback_proposal_count: DaemonNonnegativeSafeIntSchema.optional(),
  cognition_tool_candidate_count: DaemonNonnegativeSafeIntSchema.optional(),
  cognition_replay_record_id: z.string().optional(),
  cognition_replay_index_entry_id: z.string().optional(),
  peer_initiative_candidate_id: z.string().optional(),
  peer_initiative_selection_reason: z.string().optional(),
  peer_initiative_boundary_mapping_id: z.string().optional(),
  peer_initiative_boundary: z.string().optional(),
  peer_initiative_threshold_delivery_kind: z.enum(["hold", "digest", "suggest", "notify", "ask", "prepare", "execute"]).optional(),
  peer_initiative_message_id: z.string().optional(),
  peer_initiative_delivery_id: z.string().optional(),
  peer_initiative_delivery_status: z.enum(["pending_send", "delivered", "held", "failed"]).optional(),
  peer_prepared_artifact_ref: z.string().optional(),
});
export type ResidentActivity = z.infer<typeof ResidentActivitySchema>;

const ProcessIdSchema = z.number().int().positive().safe();

// Daemon runtime state
export const DaemonStateSchema = z.object({
  pid: ProcessIdSchema,
  started_at: z.string().datetime(),
  last_loop_at: z.string().datetime().nullable(),
  loop_count: DaemonNonnegativeSafeIntSchema,
  active_goals: z.array(z.string()),
  status: z.enum(["idle", "running", "stopping", "stopped", "crashed"]),
  runtime_root: z.string().optional(),
  crash_count: DaemonNonnegativeSafeIntSchema.default(0),
  last_error: z.string().nullable().default(null),
  interrupted_goals: z.array(z.string()).optional(),
  last_resident_at: z.string().datetime().nullable().default(null),
  resident_activity: ResidentActivitySchema.nullable().default(null),
  waiting_goals: z.array(z.object({
    goal_id: z.string(),
    strategy_id: z.string(),
    next_observe_at: z.string(),
    wait_until: z.string(),
    wait_reason: z.string(),
    approval_pending: z.boolean().optional(),
    activation_kind: z.enum(["wait_resume"]).optional(),
    internal_schedule: z.boolean().optional(),
  })).optional(),
  next_observe_at: z.string().nullable().optional(),
  last_observe_at: z.string().datetime().nullable().optional(),
  last_wait_reason: z.string().nullable().optional(),
  approval_pending_count: DaemonNonnegativeSafeIntSchema.optional(),
  safe_pause_goals: z.record(RuntimeSafePauseRecordSchema).optional(),
});
export type DaemonState = z.infer<typeof DaemonStateSchema>;

// PID file info
export const PIDInfoSchema = z.object({
  // Authoritative runtime PID. When a watchdog is present, this is the child daemon PID.
  pid: ProcessIdSchema,
  started_at: z.string().datetime().default(PID_EPOCH_ISO),
  runtime_started_at: z.string().datetime().optional(),
  // Process that should receive lifecycle signals. When a watchdog is present, this is the parent PID.
  owner_pid: ProcessIdSchema.optional(),
  owner_started_at: z.string().datetime().optional(),
  // Explicit watchdog parent PID when running under the watchdog.
  watchdog_pid: ProcessIdSchema.optional(),
  watchdog_started_at: z.string().datetime().optional(),
  // Explicit daemon/runtime child PID when running under the watchdog.
  runtime_pid: ProcessIdSchema.optional(),
  version: z.string().optional(),
});
export type PIDInfo = z.infer<typeof PIDInfoSchema>;
