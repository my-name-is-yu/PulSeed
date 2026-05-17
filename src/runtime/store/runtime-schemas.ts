import { z } from "zod/v3";
import {
  RuntimeControlActorSchema,
  RuntimeControlReplyTargetSchema,
} from "./runtime-operation-schemas.js";

const RuntimeSafeNonnegativeIntSchema = z.number().int().nonnegative().safe();
const RuntimeSafePositiveIntSchema = z.number().int().positive().safe();
const RuntimeSafeFiniteNumberSchema = z.number()
  .finite()
  .min(Number.MIN_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER);

export const RuntimeEnvelopeKindSchema = z.enum(["event", "command", "approval", "system"]);
export type RuntimeEnvelopeKind = z.infer<typeof RuntimeEnvelopeKindSchema>;

export const RuntimeEnvelopePrioritySchema = z.enum(["critical", "high", "normal", "low"]);
export type RuntimeEnvelopePriority = z.infer<typeof RuntimeEnvelopePrioritySchema>;

export const RuntimeEnvelopeSchema = z.object({
  message_id: z.string(),
  kind: RuntimeEnvelopeKindSchema,
  name: z.string(),
  source: z.string(),
  goal_id: z.string().optional(),
  correlation_id: z.string().optional(),
  idempotency_key: z.string().optional(),
  dedupe_key: z.string().optional(),
  priority: RuntimeEnvelopePrioritySchema,
  payload: z.unknown(),
  created_at: RuntimeSafeNonnegativeIntSchema,
  ttl_ms: RuntimeSafePositiveIntSchema.optional(),
  attempt: RuntimeSafeNonnegativeIntSchema.default(0),
});
export type RuntimeEnvelope = z.infer<typeof RuntimeEnvelopeSchema>;

export const RuntimeQueueStateSchema = z.enum([
  "accepted",
  "queued",
  "claimed",
  "retry_wait",
  "completed",
  "deadletter",
  "cancelled",
]);
export type RuntimeQueueState = z.infer<typeof RuntimeQueueStateSchema>;

export const RuntimeQueueRecordSchema = z.object({
  message_id: z.string(),
  state: z.enum(["queued", "claimed", "retry_wait", "completed", "deadletter", "cancelled"]),
  available_at: RuntimeSafeNonnegativeIntSchema,
  claimed_by: z.string().optional(),
  lease_until: RuntimeSafeNonnegativeIntSchema.optional(),
  attempt: RuntimeSafeNonnegativeIntSchema.default(0),
  last_error: z.string().optional(),
  updated_at: RuntimeSafeNonnegativeIntSchema,
});
export type RuntimeQueueRecord = z.infer<typeof RuntimeQueueRecordSchema>;

export const RuntimeSafePauseStateSchema = z.enum([
  "running",
  "pause_requested",
  "paused",
  "resumed",
  "emergency_stopped",
  "completed",
]);
export type RuntimeSafePauseState = z.infer<typeof RuntimeSafePauseStateSchema>;

export const RuntimeSafePauseCheckpointSchema = z.object({
  checkpoint_id: z.string().min(1),
  checkpointed_at: z.string().datetime(),
  reason: z.string().optional(),
  active_goals: z.array(z.string()),
  queued_goal_ids: z.array(z.string()),
  current_mode: z.string().nullable(),
  candidate_evidence_refs: z.array(z.string()),
  artifact_refs: z.array(z.string()),
  next_action: z.string().nullable(),
  supervisor_state_ref: z.string().nullable(),
  background_run_ids: z.array(z.string()),
});
export type RuntimeSafePauseCheckpoint = z.infer<typeof RuntimeSafePauseCheckpointSchema>;

export const RuntimeSafePauseRecordSchema = z.object({
  schema_version: z.literal("runtime-safe-pause-v1"),
  goal_id: z.string().min(1),
  state: RuntimeSafePauseStateSchema,
  requested_at: z.string().datetime().optional(),
  paused_at: z.string().datetime().optional(),
  resumed_at: z.string().datetime().optional(),
  completed_at: z.string().datetime().optional(),
  updated_at: z.string().datetime(),
  requested_by: z.string().optional(),
  reason: z.string().optional(),
  checkpoint: RuntimeSafePauseCheckpointSchema.optional(),
});
export type RuntimeSafePauseRecord = z.infer<typeof RuntimeSafePauseRecordSchema>;

export const GoalLeaseRecordSchema = z.object({
  goal_id: z.string(),
  owner_token: z.string(),
  attempt_id: z.string(),
  worker_id: z.string(),
  lease_until: RuntimeSafeNonnegativeIntSchema,
  acquired_at: RuntimeSafeNonnegativeIntSchema,
  last_renewed_at: RuntimeSafeNonnegativeIntSchema,
});
export type GoalLeaseRecord = z.infer<typeof GoalLeaseRecordSchema>;

export const ApprovalStateSchema = z.enum(["pending", "approved", "denied", "expired", "cancelled"]);
export type ApprovalState = z.infer<typeof ApprovalStateSchema>;

export const ApprovalOriginSchema = z.object({
  channel: z.string().min(1),
  conversation_id: z.string().min(1),
  user_id: z.string().min(1).optional(),
  session_id: z.string().min(1).optional(),
  turn_id: z.string().min(1).optional(),
  reply_target: z.unknown().optional(),
});
export type ApprovalOrigin = z.infer<typeof ApprovalOriginSchema>;

export const ApprovalRecordSchema = z.object({
  approval_id: z.string(),
  surface_issuance_id: z.string().min(1).optional(),
  goal_id: z.string().optional(),
  request_envelope_id: z.string(),
  correlation_id: z.string(),
  state: ApprovalStateSchema,
  created_at: RuntimeSafeNonnegativeIntSchema,
  expires_at: RuntimeSafeNonnegativeIntSchema,
  resolved_at: RuntimeSafeNonnegativeIntSchema.optional(),
  response_channel: z.string().optional(),
  origin: ApprovalOriginSchema.optional(),
  payload: z.unknown(),
});
export type ApprovalRecord = z.infer<typeof ApprovalRecordSchema>;

export const OutboxRecordSchema = z.object({
  seq: RuntimeSafePositiveIntSchema,
  event_type: z.string(),
  goal_id: z.string().optional(),
  correlation_id: z.string().optional(),
  created_at: RuntimeSafeNonnegativeIntSchema,
  payload: z.unknown(),
});
export type OutboxRecord = z.infer<typeof OutboxRecordSchema>;

export const RuntimeHealthStatusSchema = z.enum(["ok", "degraded", "failed"]);
export type RuntimeHealthStatus = z.infer<typeof RuntimeHealthStatusSchema>;

export const RuntimeLongRunProcessStatusSchema = z.enum(["alive", "dead", "unknown"]);
export type RuntimeLongRunProcessStatus = z.infer<typeof RuntimeLongRunProcessStatusSchema>;

export const RuntimeLongRunChildActivityStatusSchema = z.enum(["active", "idle", "unknown"]);
export type RuntimeLongRunChildActivityStatus = z.infer<typeof RuntimeLongRunChildActivityStatusSchema>;

export const RuntimeLongRunFreshnessStatusSchema = z.enum(["fresh", "stale", "missing", "unknown"]);
export type RuntimeLongRunFreshnessStatus = z.infer<typeof RuntimeLongRunFreshnessStatusSchema>;

export const RuntimeLongRunMetricProgressStatusSchema = z.enum([
  "improved",
  "plateau",
  "regressed",
  "missing",
  "unknown",
]);
export type RuntimeLongRunMetricProgressStatus = z.infer<typeof RuntimeLongRunMetricProgressStatusSchema>;

export const RuntimeLongRunBlockerStatusSchema = z.enum([
  "none",
  "approval_wait",
  "auth_wait",
  "operator_wait",
  "resource_pressure",
  "blocked",
  "unknown",
]);
export type RuntimeLongRunBlockerStatus = z.infer<typeof RuntimeLongRunBlockerStatusSchema>;

export const RuntimeArtifactExpectationSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("none"),
    reason: z.enum(["no_active_goal", "idle_no_worker"]),
  }),
  z.object({
    state: z.literal("expected"),
    reason: z.enum(["active_goal", "active_worker", "recent_artifact_contract"]),
  }),
  z.object({
    state: z.literal("recently_expected"),
    reason: z.literal("recent_goal_or_worker"),
    stale_after_ms: RuntimeSafeNonnegativeIntSchema,
  }),
  z.object({
    state: z.literal("unknown"),
    reason: z.string(),
  }),
]);
export type RuntimeArtifactExpectation = z.infer<typeof RuntimeArtifactExpectationSchema>;

export const RuntimeLongRunHealthSummarySchema = z.enum([
  "alive_and_progressing",
  "alive_idle_no_artifact_stream",
  "alive_but_metric_stalled",
  "alive_but_artifact_stalled",
  "alive_but_waiting",
  "alive_but_stalled",
  "dead_but_resumable",
  "dead_needs_intervention",
  "unknown",
]);
export type RuntimeLongRunHealthSummary = z.infer<typeof RuntimeLongRunHealthSummarySchema>;

const RuntimeLongRunSignalBaseSchema = z.object({
  checked_at: RuntimeSafeNonnegativeIntSchema,
  observed_at: RuntimeSafeNonnegativeIntSchema.optional(),
  reason: z.string().optional(),
});

export const RuntimeLongRunHealthSignalsSchema = z.object({
  process: RuntimeLongRunSignalBaseSchema.extend({
    status: RuntimeLongRunProcessStatusSchema,
    pid: RuntimeSafePositiveIntSchema.optional(),
  }),
  child_activity: RuntimeLongRunSignalBaseSchema.extend({
    status: RuntimeLongRunChildActivityStatusSchema,
    active_count: RuntimeSafeNonnegativeIntSchema.optional(),
  }),
  log_freshness: RuntimeLongRunSignalBaseSchema.extend({
    status: RuntimeLongRunFreshnessStatusSchema,
    path: z.string().optional(),
  }),
  artifact_freshness: RuntimeLongRunSignalBaseSchema.extend({
    status: RuntimeLongRunFreshnessStatusSchema,
    path: z.string().optional(),
  }),
  metric_freshness: RuntimeLongRunSignalBaseSchema.extend({
    status: RuntimeLongRunFreshnessStatusSchema,
    metric_name: z.string().optional(),
  }),
  metric_progress: RuntimeLongRunSignalBaseSchema.extend({
    status: RuntimeLongRunMetricProgressStatusSchema,
    metric_name: z.string().optional(),
    direction: z.enum(["maximize", "minimize"]).optional(),
    previous_value: RuntimeSafeFiniteNumberSchema.optional(),
    current_value: RuntimeSafeFiniteNumberSchema.optional(),
  }),
  blocker: RuntimeLongRunSignalBaseSchema.extend({
    status: RuntimeLongRunBlockerStatusSchema,
    active_goal_ids: z.array(z.string()).optional(),
    pending_approval_count: RuntimeSafeNonnegativeIntSchema.optional(),
    goal_scoped_pending_approval_count: RuntimeSafeNonnegativeIntSchema.optional(),
    unrelated_pending_approval_count: RuntimeSafeNonnegativeIntSchema.optional(),
  }),
  expected_next_checkpoint_at: RuntimeSafeNonnegativeIntSchema.optional(),
  artifact_expectation: RuntimeArtifactExpectationSchema.optional(),
  resumable: z.boolean().optional(),
});
export type RuntimeLongRunHealthSignals = z.infer<typeof RuntimeLongRunHealthSignalsSchema>;

export const RuntimeLongRunHealthSchema = z.object({
  summary: RuntimeLongRunHealthSummarySchema,
  checked_at: RuntimeSafeNonnegativeIntSchema,
  signals: RuntimeLongRunHealthSignalsSchema,
});
export type RuntimeLongRunHealth = z.infer<typeof RuntimeLongRunHealthSchema>;

export const RuntimeHealthCapabilitySchema = z.object({
  status: RuntimeHealthStatusSchema,
  checked_at: RuntimeSafeNonnegativeIntSchema,
  last_ok_at: RuntimeSafeNonnegativeIntSchema.optional(),
  last_degraded_at: RuntimeSafeNonnegativeIntSchema.optional(),
  last_failed_at: RuntimeSafeNonnegativeIntSchema.optional(),
  reason: z.string().optional(),
});
export type RuntimeHealthCapability = z.infer<typeof RuntimeHealthCapabilitySchema>;

export const RuntimeHealthKpiSchema = z.object({
  process_alive: RuntimeHealthCapabilitySchema,
  command_acceptance: RuntimeHealthCapabilitySchema,
  task_execution: RuntimeHealthCapabilitySchema,
  degraded_at: RuntimeSafeNonnegativeIntSchema.optional(),
  recovered_at: RuntimeSafeNonnegativeIntSchema.optional(),
});
export type RuntimeHealthKpi = z.infer<typeof RuntimeHealthKpiSchema>;

export interface RuntimeHealthCapabilityStatuses {
  process_alive: RuntimeHealthStatus;
  command_acceptance: RuntimeHealthStatus;
  task_execution: RuntimeHealthStatus;
}

export interface RuntimeHealthKpiSnapshot {
  status: RuntimeHealthStatus;
  process_alive: boolean;
  can_accept_command: boolean;
  can_execute_task: boolean;
  degraded_at?: number;
  recovered_at?: number;
}

export const RuntimeDaemonHealthSchema = z.object({
  status: RuntimeHealthStatusSchema,
  leader: z.boolean(),
  checked_at: RuntimeSafeNonnegativeIntSchema,
  kpi: RuntimeHealthKpiSchema.optional(),
  long_running: RuntimeLongRunHealthSchema.optional(),
  details: z.record(z.unknown()).optional(),
});
export type RuntimeDaemonHealth = z.infer<typeof RuntimeDaemonHealthSchema>;

export const RuntimeComponentsHealthSchema = z.object({
  checked_at: RuntimeSafeNonnegativeIntSchema,
  components: z.record(RuntimeHealthStatusSchema),
});
export type RuntimeComponentsHealth = z.infer<typeof RuntimeComponentsHealthSchema>;

export const RuntimeHealthSnapshotSchema = z.object({
  status: RuntimeHealthStatusSchema,
  leader: z.boolean(),
  checked_at: RuntimeSafeNonnegativeIntSchema,
  components: z.record(RuntimeHealthStatusSchema),
  kpi: RuntimeHealthKpiSchema.optional(),
  long_running: RuntimeLongRunHealthSchema.optional(),
  details: z.record(z.unknown()).optional(),
});
export type RuntimeHealthSnapshot = z.infer<typeof RuntimeHealthSnapshotSchema>;

export const BrowserAutomationSessionStateSchema = z.enum([
  "fresh",
  "authenticated",
  "auth_required",
  "expired",
  "blocked",
  "unavailable",
]);
export type BrowserAutomationSessionState = z.infer<typeof BrowserAutomationSessionStateSchema>;

export const BrowserAutomationSessionRecordSchema = z.object({
  session_id: z.string(),
  provider_id: z.string(),
  service_key: z.string(),
  workspace: z.string(),
  actor_key: z.string(),
  state: BrowserAutomationSessionStateSchema,
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  last_auth_at: z.string().datetime().nullable().optional(),
  expires_at: z.string().datetime().nullable().optional(),
  last_failure_code: z.string().nullable().optional(),
  last_failure_message: z.string().nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type BrowserAutomationSessionRecord = z.infer<typeof BrowserAutomationSessionRecordSchema>;

export const RuntimeAuthHandoffStateSchema = z.enum([
  "requested",
  "pending_operator",
  "in_progress",
  "completed",
  "cancelled",
  "expired",
  "superseded",
  "blocked",
]);
export type RuntimeAuthHandoffState = z.infer<typeof RuntimeAuthHandoffStateSchema>;

export const RuntimeAuthHandoffRecordSchema = z.object({
  schema_version: z.literal("runtime-auth-handoff-v1"),
  handoff_id: z.string().min(1),
  provider_id: z.string().min(1),
  service_key: z.string().min(1),
  workspace: z.string().min(1),
  actor_key: z.string().min(1),
  state: RuntimeAuthHandoffStateSchema,
  requested_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  expires_at: z.string().datetime().nullable().optional(),
  completed_at: z.string().datetime().nullable().optional(),
  browser_session_id: z.string().nullable().optional(),
  resumable_session_id: z.string().nullable().optional(),
  supersedes_handoff_id: z.string().nullable().optional(),
  superseded_by_handoff_id: z.string().nullable().optional(),
  reply_target: RuntimeControlReplyTargetSchema.nullable().optional(),
  requested_by: RuntimeControlActorSchema.nullable().optional(),
  failure_code: z.string().nullable().optional(),
  failure_message: z.string().nullable().optional(),
  resume_hint: z.object({
    tool_name: z.literal("browser_run_workflow"),
    input_ref: z.string().optional(),
    task_summary: z.string().min(1),
  }).nullable().optional(),
  evidence_refs: z.array(z.object({
    kind: z.string().min(1),
    ref: z.string().min(1),
    observed_at: z.string().datetime().optional(),
  })).default([]),
});
export type RuntimeAuthHandoffRecord = z.infer<typeof RuntimeAuthHandoffRecordSchema>;

export const CircuitBreakerStateSchema = z.enum(["closed", "open", "half_open", "paused"]);
export type CircuitBreakerState = z.infer<typeof CircuitBreakerStateSchema>;

export const CircuitBreakerRecordSchema = z.object({
  key: z.string(),
  provider_id: z.string(),
  service_key: z.string(),
  state: CircuitBreakerStateSchema,
  failure_count: RuntimeSafeNonnegativeIntSchema,
  last_failure_code: z.string().nullable().optional(),
  last_failure_message: z.string().nullable().optional(),
  last_failure_at: z.string().datetime().nullable().optional(),
  opened_at: z.string().datetime().nullable().optional(),
  cooldown_until: z.string().datetime().nullable().optional(),
  updated_at: z.string().datetime(),
});
export type CircuitBreakerRecord = z.infer<typeof CircuitBreakerRecordSchema>;

export const BackpressureLeaseSchema = z.object({
  provider_id: z.string(),
  service_key: z.string(),
  run_key: z.string(),
  acquired_at: z.string().datetime(),
});
export type BackpressureLease = z.infer<typeof BackpressureLeaseSchema>;

export const BackpressureSnapshotSchema = z.object({
  updated_at: z.string().datetime(),
  active: z.array(BackpressureLeaseSchema),
  throttled: z.array(z.object({
    provider_id: z.string(),
    service_key: z.string(),
    reason: z.string(),
    at: z.string().datetime(),
  })).default([]),
});
export type BackpressureSnapshot = z.infer<typeof BackpressureSnapshotSchema>;

export const RuntimeAutomationSnapshotSchema = z.object({
  schema_version: z.literal("runtime-automation-snapshot-v1"),
  generated_at: z.string().datetime(),
  auth_handoffs: z.object({
    pending: z.array(RuntimeAuthHandoffRecordSchema),
    stale: z.array(RuntimeAuthHandoffRecordSchema),
    recent_terminal: z.array(RuntimeAuthHandoffRecordSchema),
  }),
  browser_sessions: z.object({
    authenticated: z.array(BrowserAutomationSessionRecordSchema),
    stale: z.array(BrowserAutomationSessionRecordSchema),
  }),
  guardrails: z.object({
    open_breakers: z.array(CircuitBreakerRecordSchema),
    paused_breakers: z.array(CircuitBreakerRecordSchema),
    half_open_breakers: z.array(CircuitBreakerRecordSchema),
  }),
  backpressure: z.object({
    active: z.array(BackpressureLeaseSchema),
    throttled: z.array(z.object({
      provider_id: z.string(),
      service_key: z.string(),
      reason: z.string(),
      at: z.string().datetime(),
    })),
  }),
  blocked_work: z.array(z.object({
    kind: z.enum(["auth_wait", "guardrail_open", "backpressure", "provider_unavailable"]),
    provider_id: z.string(),
    service_key: z.string(),
    run_id: z.string().nullable().optional(),
    goal_id: z.string().nullable().optional(),
    handoff_id: z.string().nullable().optional(),
    reason: z.string(),
    since: z.string().datetime(),
    retry_after: z.string().datetime().nullable().optional(),
  })),
});
export type RuntimeAutomationSnapshot = z.infer<typeof RuntimeAutomationSnapshotSchema>;

export function summarizeRuntimeHealthStatus(
  components: Record<string, RuntimeHealthStatus>
): RuntimeHealthStatus {
  const statuses = Object.values(components);
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("degraded")) return "degraded";
  return "ok";
}

export function classifyLongRunHealth(
  signals: RuntimeLongRunHealthSignals
): RuntimeLongRunHealthSummary {
  if (signals.process.status === "dead") {
    return signals.resumable === true ? "dead_but_resumable" : "dead_needs_intervention";
  }

  if (signals.process.status !== "alive") {
    return "unknown";
  }

  if (signals.blocker.status !== "none" && signals.blocker.status !== "unknown") {
    return "alive_but_waiting";
  }

  if (signals.metric_progress.status === "improved") {
    return "alive_and_progressing";
  }

  if (signals.artifact_freshness.status === "fresh" && signals.metric_progress.status === "unknown") {
    return "alive_and_progressing";
  }

  if (signals.metric_progress.status === "plateau" || signals.metric_progress.status === "regressed") {
    return "alive_but_metric_stalled";
  }

  const artifactNotFresh =
    signals.artifact_freshness.status === "stale" ||
    signals.artifact_freshness.status === "missing";
  if (artifactNotFresh && signals.artifact_expectation?.state === "none") {
    return "alive_idle_no_artifact_stream";
  }

  if (artifactNotFresh && signals.artifact_expectation?.state === "unknown") {
    return "unknown";
  }

  if (
    artifactNotFresh
  ) {
    return "alive_but_artifact_stalled";
  }

  if (signals.metric_freshness.status === "stale") {
    return "alive_but_metric_stalled";
  }

  if (
    signals.child_activity.status === "idle" &&
    signals.log_freshness.status !== "fresh" &&
    signals.artifact_freshness.status !== "fresh"
  ) {
    return "alive_but_stalled";
  }

  return "unknown";
}

export function buildLongRunHealth(
  signals: RuntimeLongRunHealthSignals,
  checkedAt = Math.max(
    signals.process.checked_at,
    signals.child_activity.checked_at,
    signals.log_freshness.checked_at,
    signals.artifact_freshness.checked_at,
    signals.metric_freshness.checked_at,
    signals.metric_progress.checked_at,
    signals.blocker.checked_at
  )
): RuntimeLongRunHealth {
  return RuntimeLongRunHealthSchema.parse({
    summary: classifyLongRunHealth(signals),
    checked_at: checkedAt,
    signals,
  });
}

export function evolveRuntimeHealthKpi(
  previous: RuntimeHealthKpi | null | undefined,
  nextStatuses: RuntimeHealthCapabilityStatuses,
  checkedAt: number,
  reasons: Partial<Record<keyof RuntimeHealthCapabilityStatuses, string>> = {}
): RuntimeHealthKpi {
  const updateCapability = (
    prior: RuntimeHealthCapability | undefined,
    nextStatus: RuntimeHealthStatus,
    reason?: string
  ): RuntimeHealthCapability => {
    const changed = prior?.status !== nextStatus;
    return {
      status: nextStatus,
      checked_at: checkedAt,
      last_ok_at: nextStatus === "ok" ? checkedAt : prior?.last_ok_at,
      last_degraded_at:
        nextStatus === "degraded"
          ? changed
            ? checkedAt
            : prior?.last_degraded_at ?? checkedAt
          : prior?.last_degraded_at,
      last_failed_at:
        nextStatus === "failed"
          ? changed
            ? checkedAt
            : prior?.last_failed_at ?? checkedAt
          : prior?.last_failed_at,
      reason: nextStatus === "ok" ? undefined : reason ?? prior?.reason,
    };
  };

  const next = RuntimeHealthKpiSchema.parse({
    process_alive: updateCapability(
      previous?.process_alive,
      nextStatuses.process_alive,
      reasons.process_alive
    ),
    command_acceptance: updateCapability(
      previous?.command_acceptance,
      nextStatuses.command_acceptance,
      reasons.command_acceptance
    ),
    task_execution: updateCapability(
      previous?.task_execution,
      nextStatuses.task_execution,
      reasons.task_execution
    ),
    degraded_at: previous?.degraded_at,
    recovered_at: previous?.recovered_at,
  });

  const previousStatus = previous ? summarizeRuntimeHealthKpi(previous) : "ok";
  const currentStatus = summarizeRuntimeHealthKpi(next);
  if (currentStatus === "ok") {
    next.recovered_at = previousStatus === "ok" ? previous?.recovered_at : checkedAt;
    next.degraded_at = previous?.degraded_at;
  } else {
    next.degraded_at = previousStatus === "ok" ? checkedAt : previous?.degraded_at ?? checkedAt;
    next.recovered_at = previous?.recovered_at;
  }

  return next;
}

export function summarizeRuntimeHealthKpi(kpi: RuntimeHealthKpi): RuntimeHealthStatus {
  return summarizeRuntimeHealthStatus({
    process_alive: kpi.process_alive.status,
    command_acceptance: kpi.command_acceptance.status,
    task_execution: kpi.task_execution.status,
  });
}

export function compactRuntimeHealthKpi(
  kpi: RuntimeHealthKpi | null | undefined
): RuntimeHealthKpiSnapshot | null {
  if (!kpi) {
    return null;
  }

  return {
    status: summarizeRuntimeHealthKpi(kpi),
    process_alive: kpi.process_alive.status === "ok",
    can_accept_command: kpi.command_acceptance.status === "ok",
    can_execute_task: kpi.task_execution.status === "ok",
    degraded_at: kpi.degraded_at,
    recovered_at: kpi.recovered_at,
  };
}
