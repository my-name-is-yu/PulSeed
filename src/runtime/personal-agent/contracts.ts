import { z } from "zod";
import {
  SituationModelSchema,
  type CognitionRef,
  type SituationModel,
} from "../cognition/contracts.js";

export const PersonalAgentCallerPathSchema = z.enum([
  "chat_gateway_turn",
  "tui_turn",
  "scheduled_wake",
  "resident_proactive",
  "goal_gap_task_generation",
  "runtime_control",
  "notification_interruption",
  "memory_correction",
  "reflection",
  "task_execution",
  "crash_restart_resume",
  "explicit_user_command",
  "external_signal",
]);
export type PersonalAgentCallerPath = z.infer<typeof PersonalAgentCallerPathSchema>;

export const PersonalAgentSourceKindSchema = z.enum([
  "user_message",
  "tui_message",
  "schedule_wake",
  "resident_observation",
  "goal_gap",
  "runtime_control_request",
  "notification_report",
  "memory_operation",
  "reflection_cycle",
  "task_execution",
  "restart_recovery",
  "explicit_command",
  "external_signal",
]);
export type PersonalAgentSourceKind = z.infer<typeof PersonalAgentSourceKindSchema>;

export const InitiativeEventTypeSchema = z.enum([
  "signal_received",
  "scheduler_wake",
  "resident_observation",
  "user_follow_up",
  "task_candidate_proposed",
  "policy_decision_recorded",
  "action_requested",
  "action_outcome",
  "reflection_recorded",
  "memory_updated",
  "runtime_resumed",
]);
export type InitiativeEventType = z.infer<typeof InitiativeEventTypeSchema>;

export const AttentionTransitionStateSchema = z.enum([
  "observed",
  "warming",
  "held",
  "blocked",
  "suppressed",
  "admitted",
  "terminal",
]);
export type AttentionTransitionState = z.infer<typeof AttentionTransitionStateSchema>;

export const TaskCandidateTargetKindSchema = z.enum([
  "goal",
  "task",
  "run",
  "tool_call",
  "notification",
  "runtime_control",
  "memory_update",
  "reflection",
  "attention_only",
]);
export type TaskCandidateTargetKind = z.infer<typeof TaskCandidateTargetKindSchema>;

export const InterventionDecisionKindSchema = z.enum([
  "allow",
  "hold",
  "block",
  "suppress",
  "confirm_required",
]);
export type InterventionDecisionKind = z.infer<typeof InterventionDecisionKindSchema>;

export const InterventionTargetEffectSchema = z.enum([
  "continue_route",
  "create_goal",
  "create_task",
  "create_run",
  "execute_tool",
  "send_notification",
  "mutate_runtime_control",
  "write_memory",
  "record_reflection",
  "hold_concern",
  "none",
]);
export type InterventionTargetEffect = z.infer<typeof InterventionTargetEffectSchema>;

export const CapabilityRegistryDecisionKindSchema = z.enum([
  "available",
  "missing",
  "permission_required",
  "blocked",
  "not_applicable",
]);
export type CapabilityRegistryDecisionKind = z.infer<typeof CapabilityRegistryDecisionKindSchema>;

export const RuntimeGraphNodeKindSchema = z.enum([
  "goal",
  "session",
  "run",
  "task",
  "process_session",
  "commitment",
  "milestone",
  "artifact",
  "reply_target",
  "situation_frame",
  "initiative_event",
  "task_candidate",
  "intervention_decision",
  "capability_decision",
  "memory_record",
]);
export type RuntimeGraphNodeKind = z.infer<typeof RuntimeGraphNodeKindSchema>;

export const RuntimeGraphEdgeKindSchema = z.enum([
  "derived_from",
  "decided_by",
  "requires_capability",
  "targets",
  "parent_of",
  "replies_to",
  "produced",
  "invalidates",
  "supersedes",
  "resumes",
]);
export type RuntimeGraphEdgeKind = z.infer<typeof RuntimeGraphEdgeKindSchema>;

const RuntimeGraphRefSchema = z.object({
  kind: z.string().min(1),
  ref: z.string().min(1),
}).strict();
export type RuntimeGraphRef = z.infer<typeof RuntimeGraphRefSchema>;

export const SituationFrameSchema = z.object({
  schema_version: z.literal("situation-frame/v1"),
  frame_id: z.string().min(1),
  assembled_at: z.string().datetime(),
  caller_path: PersonalAgentCallerPathSchema,
  source_kind: PersonalAgentSourceKindSchema,
  source_ref: RuntimeGraphRefSchema,
  replay_key: z.string().min(1),
  summary: z.string().min(1),
  cognition_situation: SituationModelSchema.optional(),
  current_refs: z.array(RuntimeGraphRefSchema).default([]),
  memory_refs: z.array(RuntimeGraphRefSchema).default([]),
  withheld_memory_refs: z.array(RuntimeGraphRefSchema).default([]),
  stale_refs: z.array(RuntimeGraphRefSchema).default([]),
  uncertainty_refs: z.array(RuntimeGraphRefSchema).default([]),
  conflict_refs: z.array(RuntimeGraphRefSchema).default([]),
  policy_refs: z.array(RuntimeGraphRefSchema).default([]),
  normal_surface_trace_visible: z.literal(false).default(false),
}).strict();
export type SituationFrame = z.infer<typeof SituationFrameSchema>;

export const InitiativeEventSchema = z.object({
  schema_version: z.literal("initiative-event/v1"),
  event_id: z.string().min(1),
  trace_id: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  event_type: InitiativeEventTypeSchema,
  occurred_at: z.string().datetime(),
  situation_frame_id: z.string().min(1),
  source_ref: RuntimeGraphRefSchema,
  target_ref: RuntimeGraphRefSchema.optional(),
  summary: z.string().min(1),
  idempotency_key: z.string().min(1),
  refs: z.array(RuntimeGraphRefSchema).default([]),
  audit_refs: z.array(RuntimeGraphRefSchema).default([]),
}).strict();
export type InitiativeEvent = z.infer<typeof InitiativeEventSchema>;

export const AttentionTransitionSchema = z.object({
  schema_version: z.literal("attention-transition/v1"),
  transition_id: z.string().min(1),
  trace_id: z.string().min(1),
  occurred_at: z.string().datetime(),
  from_state: AttentionTransitionStateSchema.nullable(),
  to_state: AttentionTransitionStateSchema,
  reason: z.string().min(1),
  situation_frame_id: z.string().min(1),
  initiative_event_id: z.string().min(1),
  refs: z.array(RuntimeGraphRefSchema).default([]),
}).strict();
export type AttentionTransition = z.infer<typeof AttentionTransitionSchema>;

export const TaskCandidateSchema = z.object({
  schema_version: z.literal("task-candidate/v1"),
  candidate_id: z.string().min(1),
  trace_id: z.string().min(1),
  proposed_at: z.string().datetime(),
  source_event_id: z.string().min(1),
  situation_frame_id: z.string().min(1),
  target_kind: TaskCandidateTargetKindSchema,
  target_ref: RuntimeGraphRefSchema,
  summary: z.string().min(1),
  desired_effect: InterventionTargetEffectSchema,
  materialization_state: z.enum(["candidate", "held", "blocked", "materialized", "suppressed"]),
  capability_refs: z.array(RuntimeGraphRefSchema).default([]),
  policy_refs: z.array(RuntimeGraphRefSchema).default([]),
  reason_refs: z.array(RuntimeGraphRefSchema).default([]),
  task_created: z.literal(false).default(false),
}).strict();
export type TaskCandidate = z.infer<typeof TaskCandidateSchema>;

export const CapabilityRegistryDecisionSchema = z.object({
  schema_version: z.literal("capability-registry-decision/v1"),
  decision_id: z.string().min(1),
  trace_id: z.string().min(1),
  candidate_id: z.string().min(1),
  decided_at: z.string().datetime(),
  decision: CapabilityRegistryDecisionKindSchema,
  capability_refs: z.array(RuntimeGraphRefSchema).default([]),
  reason: z.string().min(1),
  registry_epoch: z.string().min(1),
  audit_refs: z.array(RuntimeGraphRefSchema).default([]),
}).strict();
export type CapabilityRegistryDecision = z.infer<typeof CapabilityRegistryDecisionSchema>;

export const InterventionDecisionSchema = z.object({
  schema_version: z.literal("intervention-decision/v1"),
  decision_id: z.string().min(1),
  trace_id: z.string().min(1),
  candidate_id: z.string().min(1),
  capability_decision_id: z.string().min(1),
  decided_at: z.string().datetime(),
  decision: InterventionDecisionKindSchema,
  target_effect: InterventionTargetEffectSchema,
  permission_required: z.boolean().default(false),
  policy_ref: RuntimeGraphRefSchema,
  reason: z.string().min(1),
  audit_refs: z.array(RuntimeGraphRefSchema).default([]),
  normal_surface_trace_visible: z.literal(false).default(false),
}).strict();
export type InterventionDecision = z.infer<typeof InterventionDecisionSchema>;

export const RuntimeGraphNodeSchema = z.object({
  schema_version: z.literal("runtime-graph-node/v1"),
  node_id: z.string().min(1),
  node_kind: RuntimeGraphNodeKindSchema,
  ref: RuntimeGraphRefSchema,
  label: z.string().min(1),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  provenance_refs: z.array(RuntimeGraphRefSchema).default([]),
  payload: z.record(z.unknown()).default({}),
}).strict();
export type RuntimeGraphNode = z.infer<typeof RuntimeGraphNodeSchema>;

export const RuntimeGraphEdgeSchema = z.object({
  schema_version: z.literal("runtime-graph-edge/v1"),
  edge_id: z.string().min(1),
  edge_kind: RuntimeGraphEdgeKindSchema,
  from_node_id: z.string().min(1),
  to_node_id: z.string().min(1),
  created_at: z.string().datetime(),
  provenance_refs: z.array(RuntimeGraphRefSchema).default([]),
}).strict();
export type RuntimeGraphEdge = z.infer<typeof RuntimeGraphEdgeSchema>;

export const RelationshipMemoryAuditSchema = z.object({
  schema_version: z.literal("relationship-memory-audit/v1"),
  audit_id: z.string().min(1),
  trace_id: z.string().min(1),
  recorded_at: z.string().datetime(),
  memory_ref: RuntimeGraphRefSchema,
  action: z.enum(["read", "write", "correct", "invalidate", "withhold"]),
  allowed_uses: z.array(z.string().min(1)).default([]),
  forbidden_uses: z.array(z.string().min(1)).default([]),
  uncertainty: z.enum(["none", "low", "medium", "high", "unknown"]).default("unknown"),
  correction_state: z.enum(["current", "corrected", "superseded", "retracted", "deleted", "unknown"]),
  invalidated: z.boolean().default(false),
  lifecycle: z.string().min(1).default("unknown"),
  sensitivity: z.string().min(1).optional(),
  source_kind: z.string().min(1).optional(),
  relationship_role: z.string().min(1).optional(),
  confidence: z.number().min(0).max(1).nullable().default(null),
  surface_projection_ref: z.string().min(1).optional(),
  withheld_reason: z.string().min(1).optional(),
  conflict_refs: z.array(RuntimeGraphRefSchema).default([]),
  provenance_refs: z.array(RuntimeGraphRefSchema).default([]),
  reason: z.string().min(1),
}).strict();
export type RelationshipMemoryAudit = z.infer<typeof RelationshipMemoryAuditSchema>;

export const PersonalAgentDecisionTraceSchema = z.object({
  schema_version: z.literal("personal-agent-decision-trace/v1"),
  trace_id: z.string().min(1),
  replay_key: z.string().min(1),
  situation_frame: SituationFrameSchema,
  initiative_events: z.array(InitiativeEventSchema).min(1),
  attention_transitions: z.array(AttentionTransitionSchema).default([]),
  task_candidates: z.array(TaskCandidateSchema).default([]),
  capability_decisions: z.array(CapabilityRegistryDecisionSchema).default([]),
  intervention_decisions: z.array(InterventionDecisionSchema).default([]),
  runtime_graph_nodes: z.array(RuntimeGraphNodeSchema).default([]),
  runtime_graph_edges: z.array(RuntimeGraphEdgeSchema).default([]),
  memory_audits: z.array(RelationshipMemoryAuditSchema).default([]),
}).strict();
export type PersonalAgentDecisionTrace = z.infer<typeof PersonalAgentDecisionTraceSchema>;

export function cognitionRefsToRuntimeRefs(refs: readonly CognitionRef[]): RuntimeGraphRef[] {
  return refs.map((item) => ({ kind: item.kind, ref: item.ref }));
}

export function situationModelRefs(model: SituationModel): RuntimeGraphRef[] {
  return cognitionRefsToRuntimeRefs([
    ...(model.route_ref ? [model.route_ref] : []),
    ...(model.reply_target_ref ? [model.reply_target_ref] : []),
    ...(model.session_ref ? [model.session_ref] : []),
    ...(model.runtime_phase_ref ? [model.runtime_phase_ref] : []),
    ...(model.operation_boundary_ref ? [model.operation_boundary_ref] : []),
    ...model.current_target_refs,
    ...model.tool_trace_refs,
    ...model.approval_refs,
  ]);
}
