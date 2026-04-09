import { z } from "zod";

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
  created_at: z.number().int().nonnegative(),
  ttl_ms: z.number().int().positive().optional(),
  attempt: z.number().int().nonnegative().default(0),
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
  available_at: z.number().int().nonnegative(),
  claimed_by: z.string().optional(),
  lease_until: z.number().int().nonnegative().optional(),
  attempt: z.number().int().nonnegative().default(0),
  last_error: z.string().optional(),
  updated_at: z.number().int().nonnegative(),
});
export type RuntimeQueueRecord = z.infer<typeof RuntimeQueueRecordSchema>;

export const GoalLeaseRecordSchema = z.object({
  goal_id: z.string(),
  owner_token: z.string(),
  attempt_id: z.string(),
  worker_id: z.string(),
  lease_until: z.number().int().nonnegative(),
  acquired_at: z.number().int().nonnegative(),
  last_renewed_at: z.number().int().nonnegative(),
});
export type GoalLeaseRecord = z.infer<typeof GoalLeaseRecordSchema>;

export const ApprovalStateSchema = z.enum(["pending", "approved", "denied", "expired", "cancelled"]);
export type ApprovalState = z.infer<typeof ApprovalStateSchema>;

export const ApprovalRecordSchema = z.object({
  approval_id: z.string(),
  goal_id: z.string().optional(),
  request_envelope_id: z.string(),
  correlation_id: z.string(),
  state: ApprovalStateSchema,
  created_at: z.number().int().nonnegative(),
  expires_at: z.number().int().nonnegative(),
  resolved_at: z.number().int().nonnegative().optional(),
  response_channel: z.string().optional(),
  payload: z.unknown(),
});
export type ApprovalRecord = z.infer<typeof ApprovalRecordSchema>;

export const OutboxRecordSchema = z.object({
  seq: z.number().int().positive(),
  event_type: z.string(),
  goal_id: z.string().optional(),
  correlation_id: z.string().optional(),
  created_at: z.number().int().nonnegative(),
  payload: z.unknown(),
});
export type OutboxRecord = z.infer<typeof OutboxRecordSchema>;

export const RuntimeHealthStatusSchema = z.enum(["ok", "degraded", "failed"]);
export type RuntimeHealthStatus = z.infer<typeof RuntimeHealthStatusSchema>;

export const RuntimeDaemonHealthSchema = z.object({
  status: RuntimeHealthStatusSchema,
  leader: z.boolean(),
  checked_at: z.number().int().nonnegative(),
  details: z.record(z.unknown()).optional(),
});
export type RuntimeDaemonHealth = z.infer<typeof RuntimeDaemonHealthSchema>;

export const RuntimeComponentsHealthSchema = z.object({
  checked_at: z.number().int().nonnegative(),
  components: z.record(RuntimeHealthStatusSchema),
});
export type RuntimeComponentsHealth = z.infer<typeof RuntimeComponentsHealthSchema>;

export const RuntimeHealthSnapshotSchema = z.object({
  status: RuntimeHealthStatusSchema,
  leader: z.boolean(),
  checked_at: z.number().int().nonnegative(),
  components: z.record(RuntimeHealthStatusSchema),
  details: z.record(z.unknown()).optional(),
});
export type RuntimeHealthSnapshot = z.infer<typeof RuntimeHealthSnapshotSchema>;

export function summarizeRuntimeHealthStatus(
  components: Record<string, RuntimeHealthStatus>
): RuntimeHealthStatus {
  const statuses = Object.values(components);
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("degraded")) return "degraded";
  return "ok";
}
