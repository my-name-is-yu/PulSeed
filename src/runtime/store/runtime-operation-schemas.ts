import { z } from "zod";
import {
  AuthorityScopeSchema,
  CompanionResumeOutcomeSchema,
  CompanionStateModeSchema,
  CompanionWideControlSchema,
  RuntimeItemControlSchema,
  RuntimeItemPostureSchema,
  RuntimeItemStatusSchema,
  RuntimeItemTypeSchema,
  RuntimeItemVisibilityPolicySchema,
  StalenessOutcomeSchema,
} from "../types/companion-state.js";

const RuntimeControlSafePositiveIntSchema = z.number().finite().int().positive().safe();

export const RuntimeControlOperationKindSchema = z.enum([
  "restart_daemon",
  "restart_gateway",
  "reload_config",
  "self_update",
  "inspect_run",
  "pause_run",
  "resume_run",
  "cancel_run",
  "finalize_run",
  "inspect_permission_boundary",
  "revoke_permission",
  "narrow_permission",
  "extend_permission",
  "audit_permission_check",
  "inspect_companion_state",
  "enter_quiet_mode",
  "leave_quiet_mode",
  "pause_proactivity",
  "resume_proactivity",
  "suspend_companion",
  "resume_companion",
  "stop_all_quiet_work",
  "stop_all_watches",
  "suppress_nonessential_agenda",
  "require_confirmation_for_proactivity",
  "inspect_session",
  "summarize_session_without_resuming",
  "automation_control",
]);
export type RuntimeControlOperationKind = z.infer<typeof RuntimeControlOperationKindSchema>;

export const RuntimeControlOperationStateSchema = z.enum([
  "pending",
  "acknowledged",
  "approved",
  "running",
  "restarting",
  "verified",
  "blocked",
  "failed",
  "cancelled",
]);
export type RuntimeControlOperationState = z.infer<typeof RuntimeControlOperationStateSchema>;

export const RuntimeControlActorSchema = z.object({
  surface: z.enum(["chat", "gateway", "cli", "tui"]),
  platform: z.string().optional(),
  conversation_id: z.string().optional(),
  identity_key: z.string().optional(),
  user_id: z.string().optional(),
});
export type RuntimeControlActor = z.infer<typeof RuntimeControlActorSchema>;

export const RuntimeControlReplyTargetSchema = z.object({
  surface: z.enum(["chat", "gateway", "cli", "tui"]).optional(),
  channel: z.enum(["tui", "plugin_gateway", "cli", "web"]).optional(),
  platform: z.string().optional(),
  conversation_id: z.string().optional(),
  message_id: z.string().optional(),
  response_channel: z.string().optional(),
  outbox_topic: z.string().optional(),
  identity_key: z.string().optional(),
  user_id: z.string().optional(),
  deliveryMode: z.enum(["reply", "notify", "thread_reply"]).optional(),
  delivery_mode: z.enum(["reply", "notify", "thread_reply"]).optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type RuntimeControlReplyTarget = z.infer<typeof RuntimeControlReplyTargetSchema>;

export const RuntimeControlCompanionStateInspectionItemSchema = z.object({
  ref: z.string().min(1),
  type: RuntimeItemTypeSchema,
  status: RuntimeItemStatusSchema,
  posture: RuntimeItemPostureSchema,
  visibility_display: RuntimeItemVisibilityPolicySchema.shape.display,
  inspectable: z.boolean(),
  auditable: z.boolean(),
  authority_scope: AuthorityScopeSchema,
  authority: z.object({
    resumable: z.boolean(),
    actionable: z.boolean(),
    speakable: z.boolean(),
    can_create_urge: z.boolean(),
    can_update_surface: z.boolean(),
    can_write_memory: z.boolean(),
    can_delegate_work: z.boolean(),
    requires_confirmation: z.boolean(),
  }).strict(),
  staleness_outcomes: z.record(StalenessOutcomeSchema),
  allowed_controls: z.array(RuntimeItemControlSchema),
  repair_options: z.array(RuntimeItemControlSchema),
  audit_trace_refs: z.array(z.string().min(1)),
}).strict();
export type RuntimeControlCompanionStateInspectionItem = z.infer<typeof RuntimeControlCompanionStateInspectionItemSchema>;

export const RuntimeControlCompanionStateInspectionSchema = z.object({
  snapshot_id: z.string().min(1),
  mode: CompanionStateModeSchema,
  inspected_at: z.string().datetime(),
  active_controls: z.array(CompanionWideControlSchema),
  active_refs: z.array(z.string().min(1)),
  held_runtime_refs: z.array(z.string().min(1)),
  blocked_refs: z.array(z.string().min(1)),
  hidden_refs: z.array(z.string().min(1)),
  non_executable_refs: z.array(z.string().min(1)),
  repairable_refs: z.array(z.string().min(1)),
  runtime_items: z.array(RuntimeControlCompanionStateInspectionItemSchema),
}).strict();
export type RuntimeControlCompanionStateInspection = z.infer<typeof RuntimeControlCompanionStateInspectionSchema>;

export const RuntimeControlOperationSchema = z.object({
  operation_id: z.string().min(1),
  kind: RuntimeControlOperationKindSchema,
  state: RuntimeControlOperationStateSchema,
  requested_at: z.string(),
  updated_at: z.string(),
  requested_by: RuntimeControlActorSchema,
  reply_target: RuntimeControlReplyTargetSchema,
  reason: z.string(),
  target: z.object({
    run_id: z.string().min(1).optional(),
    session_id: z.string().min(1).optional(),
    goal_id: z.string().min(1).optional(),
    grant_id: z.string().min(1).optional(),
    handoff_id: z.string().min(1).optional(),
    provider_id: z.string().min(1).optional(),
    service_key: z.string().min(1).optional(),
  }).strict().optional(),
  automation_control: z.object({
    domain: z.enum(["auth_handoff", "browser_session", "guardrail", "backpressure"]),
    action: z.string().min(1),
  }).strict().optional(),
  risk: z.object({
    requires_approval: z.boolean(),
    irreversible: z.boolean(),
    external_actions: z.array(z.string().min(1)),
  }).strict().optional(),
  started_at: z.string().optional(),
  completed_at: z.string().optional(),
  approval_id: z.string().optional(),
  ack_outbox_seq: RuntimeControlSafePositiveIntSchema.optional(),
  restart_marker_path: z.string().optional(),
  expected_health: z.object({
    daemon_ping: z.boolean(),
    gateway_acceptance: z.boolean(),
  }),
  result: z.object({
    ok: z.boolean(),
    message: z.string(),
    daemon_status: z.string().optional(),
    health_error: z.string().optional(),
    resume_outcome: CompanionResumeOutcomeSchema.optional(),
    companion_state_inspection: RuntimeControlCompanionStateInspectionSchema.optional(),
    affected_runtime_refs: z.array(z.string().min(1)).optional(),
  }).optional(),
});
export type RuntimeControlOperation = z.infer<typeof RuntimeControlOperationSchema>;

export function isTerminalRuntimeControlState(state: RuntimeControlOperationState): boolean {
  return state === "verified" || state === "failed" || state === "cancelled" || state === "blocked";
}
