import { z } from "zod";

export const RuntimeItemTypeSchema = z.enum([
  "run",
  "task",
  "session",
  "goal",
  "wait",
  "watch",
  "hold",
  "urge_candidate",
  "agent_agenda_item",
  "surface_projection",
  "permission_boundary",
  "audit_trace",
  "diff_proposal",
  "auth_handoff",
  "browser_session",
  "guardrail_state",
  "backpressure_state",
]);
export type RuntimeItemType = z.infer<typeof RuntimeItemTypeSchema>;

export const RuntimeItemStatusSchema = z.enum([
  "pending",
  "running",
  "active",
  "mature",
  "completed",
  "failed",
  "cancelled",
  "paused",
  "expired",
  "blocked",
  "superseded",
]);
export type RuntimeItemStatus = z.infer<typeof RuntimeItemStatusSchema>;

export const RuntimeItemPostureSchema = z.enum([
  "working",
  "watching",
  "waiting",
  "holding",
  "cooling_down",
  "blocked_by_boundary",
  "needs_user",
  "ready_to_digest",
  "safe_to_forget",
  "stale",
  "suspended",
  "suppressed",
  "proposed",
  "committed",
  "rejected",
]);
export type RuntimeItemPosture = z.infer<typeof RuntimeItemPostureSchema>;

export const AuthorityScopeSchema = z.enum([
  "none",
  "inspect_only",
  "user_origin_only",
  "confirmed_proactivity",
  "bounded_runtime_item",
]);
export type AuthorityScope = z.infer<typeof AuthorityScopeSchema>;

export const AuthoritySchema = z.object({
  inspectable: z.boolean(),
  resumable: z.boolean(),
  actionable: z.boolean(),
  speakable: z.boolean(),
  can_create_urge: z.boolean(),
  can_update_surface: z.boolean(),
  can_write_memory: z.boolean(),
  can_delegate_work: z.boolean(),
  requires_confirmation: z.boolean(),
  approval_scope: AuthorityScopeSchema,
  authority_reason: z.string().min(1),
}).strict().superRefine((authority, ctx) => {
  const grantsAction = authority.resumable
    || authority.actionable
    || authority.speakable
    || authority.can_create_urge
    || authority.can_update_surface
    || authority.can_write_memory
    || authority.can_delegate_work;

  if (authority.approval_scope === "none" && (authority.inspectable || grantsAction)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "authority with approval_scope=none cannot grant inspect or action permissions",
      path: ["approval_scope"],
    });
  }

  if (authority.approval_scope === "inspect_only" && grantsAction) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "inspect_only authority cannot grant resume, action, speech, memory, Surface, or delegation permissions",
      path: ["approval_scope"],
    });
  }

  if (authority.can_write_memory && !authority.can_update_surface) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "memory writes require authority to update Surface state",
      path: ["can_write_memory"],
    });
  }
});
export type Authority = z.infer<typeof AuthoritySchema>;

export const StalenessOutcomeSchema = z.enum([
  "current",
  "needs_review",
  "needs_regrounding",
  "inspect_only",
  "summary_only",
  "not_resumable",
  "not_actionable",
  "rejected",
]);
export type StalenessOutcome = z.infer<typeof StalenessOutcomeSchema>;

export const StalenessDimensionSchema = z.object({
  outcome: StalenessOutcomeSchema,
  reason: z.string().min(1),
  observed_at: z.string().datetime().optional(),
}).strict();
export type StalenessDimension = z.infer<typeof StalenessDimensionSchema>;

export const StalenessSchema = z.object({
  temporal: StalenessDimensionSchema,
  world: StalenessDimensionSchema,
  project: StalenessDimensionSchema,
  permission: StalenessDimensionSchema,
  relationship: StalenessDimensionSchema,
  surface: StalenessDimensionSchema,
  goal: StalenessDimensionSchema,
  assumption: StalenessDimensionSchema,
  session: StalenessDimensionSchema,
  browser_session: StalenessDimensionSchema,
  auth_handoff: StalenessDimensionSchema,
}).strict();
export type Staleness = z.infer<typeof StalenessSchema>;

export const CompanionWideControlSchema = z.enum([
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
]);
export type CompanionWideControl = z.infer<typeof CompanionWideControlSchema>;

export const RuntimeItemControlSchema = z.enum([
  "inspect_item",
  "pause_item",
  "resume_item",
  "cancel_item",
  "finalize_item",
  "forget_item",
  "reground_item",
  "revoke_permission",
  "narrow_permission",
  "require_confirmation",
]);
export type RuntimeItemControl = z.infer<typeof RuntimeItemControlSchema>;

export const RuntimeItemCompanionControlStateSchema = z.object({
  active_controls: z.array(CompanionWideControlSchema),
  global_control_refs: z.array(z.string().min(1)),
  held_by_controls: z.array(CompanionWideControlSchema),
  rejected_by_controls: z.array(CompanionWideControlSchema),
  reason: z.string().min(1),
}).strict();
export type RuntimeItemCompanionControlState = z.infer<typeof RuntimeItemCompanionControlStateSchema>;

export const RuntimeItemVisibilityPolicySchema = z.object({
  display: z.enum(["normal", "hidden", "redacted"]),
  inspectable: z.boolean(),
  auditable: z.boolean(),
  policy_ref: z.string().min(1).nullable(),
  reason: z.string().min(1),
}).strict();
export type RuntimeItemVisibilityPolicy = z.infer<typeof RuntimeItemVisibilityPolicySchema>;

export const ControlPolicySchema = z.object({
  allowed_controls: z.array(RuntimeItemControlSchema),
  forbidden_controls: z.array(RuntimeItemControlSchema),
  required_confirmation: z.array(RuntimeItemControlSchema),
  repair_options: z.array(RuntimeItemControlSchema),
  reason: z.string().min(1),
}).strict().superRefine((policy, ctx) => {
  for (const control of policy.allowed_controls) {
    if (policy.forbidden_controls.includes(control)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `control ${control} cannot be both allowed and forbidden`,
        path: ["allowed_controls"],
      });
    }
  }
});
export type ControlPolicy = z.infer<typeof ControlPolicySchema>;

export const RuntimeItemSchema = z.object({
  schema_version: z.literal("runtime-item-v1").default("runtime-item-v1"),
  item_id: z.string().min(1),
  id: z.string().min(1).optional(),
  type: RuntimeItemTypeSchema,
  status: RuntimeItemStatusSchema,
  posture: RuntimeItemPostureSchema,
  source: z.string().min(1),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  related_goal_refs: z.array(z.string().min(1)).default([]),
  related_task_refs: z.array(z.string().min(1)).default([]),
  related_session_refs: z.array(z.string().min(1)).default([]),
  related_memory_refs: z.array(z.string().min(1)).default([]),
  related_surface_refs: z.array(z.string().min(1)).default([]),
  related_agenda_refs: z.array(z.string().min(1)).default([]),
  companion_state_refs: z.array(z.string().min(1)).default([]),
  companion_control_state: RuntimeItemCompanionControlStateSchema,
  authority: AuthoritySchema,
  staleness: StalenessSchema,
  visibility_policy: RuntimeItemVisibilityPolicySchema,
  visibility_policy_ref: z.string().min(1).nullable().default(null),
  control_policy: ControlPolicySchema,
  audit_trace_refs: z.array(z.string().min(1)).default([]),
}).strict().superRefine((item, ctx) => {
  if (item.id !== undefined && item.id !== item.item_id) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "legacy id must match item_id when both are present",
      path: ["id"],
    });
  }
});
export type RuntimeItem = z.infer<typeof RuntimeItemSchema>;

export const CompanionGlobalControlEntrySchema = z.object({
  control: CompanionWideControlSchema,
  state: z.enum(["active", "inactive", "ambiguous"]),
  source_ref: z.string().min(1),
  updated_at: z.string().datetime(),
  reason: z.string().min(1),
}).strict();
export type CompanionGlobalControlEntry = z.infer<typeof CompanionGlobalControlEntrySchema>;

export const CompanionStateModeSchema = z.enum([
  "sleeping",
  "resting",
  "quieted",
  "proactivity_paused",
  "suspended",
  "watching",
  "curious",
  "concerned",
  "working",
  "waiting",
  "holding_back",
  "cooling_down",
  "overloaded",
  "needs_user",
  "reaching_out",
  "escalating",
]);
export type CompanionStateMode = z.infer<typeof CompanionStateModeSchema>;

export const CompanionCapacitySchema = z.enum(["available", "constrained", "exhausted"]);
export type CompanionCapacity = z.infer<typeof CompanionCapacitySchema>;

export const CompanionStateReducerInputSchema = z.object({
  schema_version: z.literal("companion-state-reducer-input-v1").default("companion-state-reducer-input-v1"),
  runtime_items: z.array(RuntimeItemSchema),
  recent_runtime_events: z.array(z.string().min(1)),
  active_surface_ref: z.string().min(1).nullable(),
  surface_invalidation_events: z.array(z.string().min(1)),
  global_control_state_ref: z.string().min(1).nullable(),
  global_controls: z.array(CompanionGlobalControlEntrySchema),
  active_goal_refs: z.array(z.string().min(1)),
  active_watch_refs: z.array(z.string().min(1)),
  active_wait_refs: z.array(z.string().min(1)),
  active_quiet_work_refs: z.array(z.string().min(1)),
  attention_history_refs: z.array(z.string().min(1)),
  control_overlays: z.array(CompanionWideControlSchema),
  pre_suspend_mode: CompanionStateModeSchema.nullable(),
  authority_blockers: z.array(z.string().min(1)),
  staleness_blockers: z.array(z.string().min(1)),
  safety_blockers: z.array(z.string().min(1)),
  user_activity_refs: z.array(z.string().min(1)),
  feedback_refs: z.array(z.string().min(1)),
  safety_context_refs: z.array(z.string().min(1)),
  event_high_watermark: z.string().min(1),
  current_time: z.string().datetime(),
}).strict();
export type CompanionStateReducerInput = z.infer<typeof CompanionStateReducerInputSchema>;

export type CompanionStateAssemblyInput =
  Omit<
    CompanionStateReducerInput,
    | "schema_version"
    | "global_controls"
    | "active_goal_refs"
    | "active_watch_refs"
    | "active_wait_refs"
    | "active_quiet_work_refs"
    | "attention_history_refs"
    | "control_overlays"
    | "pre_suspend_mode"
    | "authority_blockers"
    | "staleness_blockers"
    | "safety_blockers"
    | "user_activity_refs"
    | "feedback_refs"
    | "safety_context_refs"
  >
  & Partial<Pick<
    CompanionStateReducerInput,
    | "schema_version"
    | "global_controls"
    | "active_goal_refs"
    | "active_watch_refs"
    | "active_wait_refs"
    | "active_quiet_work_refs"
    | "attention_history_refs"
    | "control_overlays"
    | "pre_suspend_mode"
    | "authority_blockers"
    | "staleness_blockers"
    | "safety_blockers"
    | "user_activity_refs"
    | "feedback_refs"
    | "safety_context_refs"
  >>;

export const CompanionStateDerivationTraceSchema = z.object({
  input_refs: z.array(z.string().min(1)),
  matched_control_refs: z.array(z.string().min(1)),
  matched_blocker_refs: z.array(z.string().min(1)),
  matched_feedback_refs: z.array(z.string().min(1)),
  matched_activity_refs: z.array(z.string().min(1)),
  selected_mode: CompanionStateModeSchema,
  budget_changes: z.array(z.string().min(1)),
  threshold_changes: z.array(z.string().min(1)),
  rejected_modes: z.array(CompanionStateModeSchema),
  reason: z.string().min(1),
}).strict();
export type CompanionStateDerivationTrace = z.infer<typeof CompanionStateDerivationTraceSchema>;

export const CompanionStateSnapshotSchema = z.object({
  schema_version: z.literal("companion-state-snapshot-v1").default("companion-state-snapshot-v1"),
  snapshot_id: z.string().min(1),
  computed_at: z.string().datetime(),
  source_event_high_watermark: z.string().min(1),
  active_surface_ref: z.string().min(1).nullable(),
  global_control_state_ref: z.string().min(1).nullable(),
  mode: CompanionStateModeSchema,
  control_overlays: z.array(CompanionWideControlSchema),
  current_capacity: CompanionCapacitySchema,
  interruption_budget: z.number().finite().min(0).max(1),
  quiet_work_budget: z.number().finite().min(0).max(1),
  budgets: z.record(z.number().finite()),
  attention_thresholds: z.record(z.number().finite()),
  expression_thresholds: z.record(z.number().finite()),
  threshold_overrides: z.record(z.number().finite()),
  cooldowns: z.array(z.string().min(1)),
  waiting_conditions: z.array(z.string().min(1)),
  blocked_refs: z.array(z.string().min(1)),
  blocked_by_boundary_refs: z.array(z.string().min(1)),
  needs_user_refs: z.array(z.string().min(1)),
  stale_refs: z.array(z.string().min(1)),
  stale_surface_refs: z.array(z.string().min(1)),
  invalidated_refs: z.array(z.string().min(1)),
  invalidated_surface_refs: z.array(z.string().min(1)),
  active_refs: z.array(z.string().min(1)),
  active_watch_refs: z.array(z.string().min(1)),
  active_wait_refs: z.array(z.string().min(1)),
  active_quiet_work_refs: z.array(z.string().min(1)),
  pre_suspend_mode: CompanionStateModeSchema.nullable(),
  held_runtime_refs: z.array(z.string().min(1)),
  derivation_trace: CompanionStateDerivationTraceSchema,
}).strict();
export type CompanionStateSnapshot = z.infer<typeof CompanionStateSnapshotSchema>;

export type CompanionStateSnapshotFreshness = {
  current: boolean;
  reason:
    | "current"
    | "event_high_watermark_changed"
    | "surface_invalidated"
    | "active_surface_changed"
    | "global_control_state_changed";
  stale_refs: string[];
};
