import { z } from "zod/v3";

export const CompanionCognitionCallerPathSchema = z.enum([
  "chat_user_turn",
  "resident_proactive_check",
  "long_running_task_turn",
  "schedule_wake",
  "runtime_control_response",
  "memory_truth_operation",
]);
export type CompanionCognitionCallerPath = z.infer<typeof CompanionCognitionCallerPathSchema>;

export const CompanionCognitionSurfaceTargetSchema = z.enum([
  "normal_user",
  "operator_debug",
  "internal_audit",
]);
export type CompanionCognitionSurfaceTarget = z.infer<typeof CompanionCognitionSurfaceTargetSchema>;

export const CognitionSourceStoreSchema = z.enum([
  "chat_events",
  "chat_history",
  "runtime_operation",
  "dream_event_log",
  "proactive_intervention",
  "attention_ledger",
  "schedule",
  "soil",
  "profile",
  "knowledge",
  "approval",
  "notification",
  "cognition_audit",
  "memory_truth",
  "runtime_event_log",
]);
export type CognitionSourceStore = z.infer<typeof CognitionSourceStoreSchema>;

export const CognitionRedactionPolicySchema = z.enum([
  "materialized",
  "redacted",
  "metadata_only",
]);
export type CognitionRedactionPolicy = z.infer<typeof CognitionRedactionPolicySchema>;

export const CognitionEventRefSchema = z.object({
  ref: z.string().min(1),
  source_store: CognitionSourceStoreSchema,
  source_event_type: z.string().min(1),
  schema_version: z.number().int().positive(),
  source_epoch: z.string().min(1).optional(),
  high_watermark: z.string().min(1).optional(),
  replay_key: z.string().min(1).optional(),
  redaction_policy: CognitionRedactionPolicySchema,
}).strict().superRefine((eventRef, ctx) => {
  if (!eventRef.source_epoch && !eventRef.high_watermark && !eventRef.replay_key) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["source_epoch"],
      message: "cognition event refs must include source_epoch, high_watermark, or replay_key",
    });
  }
});
export type CognitionEventRef = z.infer<typeof CognitionEventRefSchema>;

export const CognitionRefSchema = z.object({
  kind: z.string().min(1),
  ref: z.string().min(1),
}).strict();
export type CognitionRef = z.infer<typeof CognitionRefSchema>;

export const WorkingContextSnapshotSchema = z.object({
  input_ref: CognitionEventRefSchema,
  current_text_ref: z.string().min(1).optional(),
  route_ref: CognitionRefSchema.optional(),
  reply_target_ref: CognitionRefSchema.optional(),
  session_ref: CognitionRefSchema.optional(),
  situation_frame_ref: CognitionRefSchema.optional(),
  runtime_event_refs: z.array(CognitionRefSchema).default([]),
  runtime_graph_refs: z.array(CognitionRefSchema).default([]),
  authority_state_refs: z.array(CognitionRefSchema).default([]),
  memory_truth_refs: z.array(CognitionRefSchema).default([]),
  relationship_permission_refs: z.array(CognitionRefSchema).default([]),
  conflict_refs: z.array(CognitionRefSchema).default([]),
  uncertainty_refs: z.array(CognitionRefSchema).default([]),
  turn_started_at: z.string().datetime().optional(),
  current_language_hint: z.string().min(1).optional(),
  hidden_prompt_content_materialized: z.literal(false).default(false),
}).strict();
export type WorkingContextSnapshot = z.infer<typeof WorkingContextSnapshotSchema>;

export const ChatSessionCognitionContextSchema = z.object({
  session_ref: CognitionRefSchema,
  turn_ref: CognitionRefSchema,
  run_ref: CognitionRefSchema.optional(),
  route_kind: z.enum(["agent_loop", "gateway_model_loop"]),
  runtime_control_allowed: z.boolean(),
  approval_mode: z.enum(["interactive", "preapproved", "disallowed"]),
  quieting_active: z.boolean().default(false),
  stale_reply_target_refs: z.array(CognitionRefSchema).default([]),
}).strict();
export type ChatSessionCognitionContext = z.infer<typeof ChatSessionCognitionContextSchema>;

export const ProactiveDeliveryKindSchema = z.enum([
  "hold",
  "digest",
  "suggest",
  "notify",
  "speak",
  "prepare",
  "execute",
]);
export type ProactiveDeliveryKind = z.infer<typeof ProactiveDeliveryKindSchema>;

const DELIVERY_KIND_RANK: Record<ProactiveDeliveryKind, number> = {
  hold: 0,
  digest: 1,
  suggest: 2,
  notify: 3,
  speak: 4,
  prepare: 5,
  execute: 6,
};

export const AttentionCognitionContextSchema = z.object({
  attention_input_ref: CognitionRefSchema,
  commitment_ref: CognitionRefSchema.optional(),
  agenda_ref: CognitionRefSchema.optional(),
  admission_status: z.enum(["admitted", "held", "blocked", "not_selected", "duplicate"]),
  initiative_gate_decision_id: z.string().min(1),
  operation_boundary: z.enum(["allowed", "blocked", "held", "unavailable"]),
  operation_plan_ref: z.string().min(1).optional(),
  max_delivery_kind: ProactiveDeliveryKindSchema,
  feedback_policy_refs: z.array(CognitionRefSchema).default([]),
  store_ref: CognitionRefSchema.optional(),
  handoff_state: z.enum([
    "not_applicable",
    "shadow_recorded",
    "candidate_saved",
    "control_applied",
    "resident_operation_selected",
  ]).default("not_applicable"),
}).strict();
export type AttentionCognitionContext = z.infer<typeof AttentionCognitionContextSchema>;

export const RuntimeCognitionContextSchema = z.object({
  runtime_item_refs: z.array(CognitionRefSchema).default([]),
  approval_refs: z.array(CognitionRefSchema).default([]),
  last_tool_trace_refs: z.array(CognitionRefSchema).default([]),
  operator_handoff_ref: CognitionRefSchema.optional(),
  phase_ref: CognitionRefSchema.optional(),
  active_control_state_refs: z.array(CognitionRefSchema).default([]),
}).strict();
export type RuntimeCognitionContext = z.infer<typeof RuntimeCognitionContextSchema>;

export const GoalRefSchema = z.object({
  goal_id: z.string().min(1),
  goal_ref: CognitionRefSchema,
  lifecycle: z.enum(["candidate", "active", "blocked", "completed", "stale", "unknown"]),
  priority: z.enum(["low", "normal", "high", "urgent", "unknown"]).default("unknown"),
}).strict();
export type GoalRef = z.infer<typeof GoalRefSchema>;

export const IntentionLifecycleSchema = z.enum([
  "candidate",
  "selected",
  "awaiting_approval",
  "active",
  "blocked",
  "completed",
  "obsolete",
  "revoked",
  "requires_regrounding",
]);
export type IntentionLifecycle = z.infer<typeof IntentionLifecycleSchema>;

export const GoalIntentionContextSchema = z.object({
  active_goals: z.array(GoalRefSchema).default([]),
  active_intention_refs: z.array(CognitionRefSchema).default([]),
  stale_target_refs: z.array(CognitionRefSchema).default([]),
}).strict();
export type GoalIntentionContext = z.infer<typeof GoalIntentionContextSchema>;

export const CognitionRequestedMemoryUseSchema = z.enum([
  "runtime_grounding",
  "user_facing_reference",
  "behavioral_inhibition",
  "goal_planning",
  "proactive_action_candidate",
  "attention_prioritization",
  "ask_for_confirmation",
  "reflection_input",
]);
export type CognitionRequestedMemoryUse = z.infer<typeof CognitionRequestedMemoryUseSchema>;

export const CognitionMemoryRequestSchema = z.object({
  request_id: z.string().min(1),
  requested_uses: z.array(CognitionRequestedMemoryUseSchema).min(1),
  caller_path: CompanionCognitionCallerPathSchema,
  query_ref: CognitionEventRefSchema,
  surface_projection_required: z.literal(true).default(true),
  side_effect_authorization_allowed: z.literal(false).default(false),
  include_sensitive_content: z.literal(false).default(false),
}).strict();
export type CognitionMemoryRequest = z.infer<typeof CognitionMemoryRequestSchema>;

export const RelationshipSurfaceFactRoleSchema = z.enum([
  "preference",
  "boundary",
  "promise",
  "intervention_policy",
  "notification_preference",
  "open_tension",
]);
export type RelationshipSurfaceFactRole = z.infer<typeof RelationshipSurfaceFactRoleSchema>;

export const RelationshipSurfaceAllowedUseSchema = z.enum([
  "tone_adaptation",
  "behavioral_inhibition",
  "ask_for_confirmation",
  "user_facing_reference",
]);
export type RelationshipSurfaceAllowedUse = z.infer<typeof RelationshipSurfaceAllowedUseSchema>;

export const RelationshipSurfaceRepairPathSchema = z.enum([
  "correct",
  "suppress",
  "revoke",
  "forget",
]);
export type RelationshipSurfaceRepairPath = z.infer<typeof RelationshipSurfaceRepairPathSchema>;

export const CognitionMemorySourceSchema = z.object({
  memory_ref: CognitionEventRefSchema,
  source_kind: z.enum(["working", "episodic", "semantic", "procedural"]),
  allowed_uses: z.array(CognitionRequestedMemoryUseSchema).default([]),
  forbidden_uses: z.array(CognitionRequestedMemoryUseSchema).default([]),
  sensitivity: z.enum(["public", "private", "sensitive", "redacted"]),
  lifecycle: z.enum(["active", "matured", "stale", "superseded", "retracted", "deleted", "quarantined"]),
  correction_state: z.enum(["current", "corrected", "superseded", "retracted", "unknown"]),
  confidence: z.number().min(0).max(1).optional(),
  surface_projection_ref: z.string().min(1).optional(),
  relationship_role: RelationshipSurfaceFactRoleSchema.optional(),
  excerpt: z.string().min(1).optional(),
}).strict();
export type CognitionMemorySource = z.infer<typeof CognitionMemorySourceSchema>;

export const CognitionWithheldMemorySourceSchema = CognitionMemorySourceSchema.extend({
  withheld_reason: z.enum([
    "stale",
    "superseded",
    "corrected",
    "sensitive",
    "deleted",
    "quarantined",
    "forbidden_use",
    "missing_surface_projection",
  ]),
}).strict();
export type CognitionWithheldMemorySource = z.infer<typeof CognitionWithheldMemorySourceSchema>;

export const CognitionMemoryResultSchema = z.object({
  request_id: z.string().min(1),
  surface_projection_ref: CognitionRefSchema.optional(),
  core_memory_projection_ref: CognitionRefSchema.optional(),
  included: z.array(CognitionMemorySourceSchema).default([]),
  withheld: z.array(CognitionWithheldMemorySourceSchema).default([]),
  audit_refs: z.array(CognitionEventRefSchema).default([]),
  model_visible_without_cloud_gate: z.literal(false).default(false),
}).strict().superRefine((result, ctx) => {
  for (const source of result.included) {
    if (source.sensitivity === "sensitive" || source.sensitivity === "redacted") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["included"],
        message: "sensitive or redacted memory cannot be included as cognition content",
      });
    }
    if (source.lifecycle !== "active" && source.lifecycle !== "matured") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["included"],
        message: "inactive memory lifecycle cannot be included as cognition content",
      });
    }
    if (source.correction_state !== "current") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["included"],
        message: "corrected, superseded, or retracted memory cannot be included as cognition content",
      });
    }
  }
});
export type CognitionMemoryResult = z.infer<typeof CognitionMemoryResultSchema>;

export const ToolAuthorityStageSchema = z.enum(["read", "suggest", "prepare", "execute"]);
export type ToolAuthorityStage = z.infer<typeof ToolAuthorityStageSchema>;

export const ToolRiskClassSchema = z.enum(["none", "low", "medium", "high", "external_side_effect"]);
export type ToolRiskClass = z.infer<typeof ToolRiskClassSchema>;

export const ToolCandidateSchema = z.object({
  candidate_id: z.string().min(1),
  capability_ref: CognitionRefSchema.optional(),
  tool_ref: CognitionRefSchema.optional(),
  authority_stage: ToolAuthorityStageSchema,
  expected_effect: z.string().min(1),
  risk_class: ToolRiskClassSchema,
  required_context_refs: z.array(CognitionEventRefSchema).default([]),
  required_authorization_refs: z.array(CognitionRefSchema).default([]),
  can_execute: z.boolean(),
  may_execute: z.literal(false).default(false),
  observability_refs: z.array(CognitionRefSchema).default([]),
  failure_recovery_refs: z.array(CognitionRefSchema).default([]),
  failed_trace_requires_repair: z.boolean().default(false),
  memory_is_authority: z.literal(false).default(false),
  model_text_is_authority: z.literal(false).default(false),
}).strict().superRefine((candidate, ctx) => {
  if (candidate.authority_stage === "execute" && candidate.required_authorization_refs.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["required_authorization_refs"],
      message: "execute-stage tool candidates must carry downstream authorization refs",
    });
  }
  if (candidate.failed_trace_requires_repair && candidate.failure_recovery_refs.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["failure_recovery_refs"],
      message: "failed tool traces require an explicit repair condition before reuse",
    });
  }
});
export type ToolCandidate = z.infer<typeof ToolCandidateSchema>;

export const SideEffectProfileSchema = z.enum([
  "read",
  "local_write",
  "external_write",
  "notification",
  "runtime_mutation",
  "cloud_compute",
]);
export type SideEffectProfile = z.infer<typeof SideEffectProfileSchema>;

export const PrivacyProfileSchema = z.enum([
  "local_only",
  "workspace_private",
  "user_private",
  "sensitive",
  "external_service",
]);
export type PrivacyProfile = z.infer<typeof PrivacyProfileSchema>;

export const CloudComputePurposeSchema = z.enum([
  "chat_reply",
  "tool_reasoning",
  "research",
  "summarization",
  "embedding",
  "classification",
]);
export type CloudComputePurpose = z.infer<typeof CloudComputePurposeSchema>;

export const CloudRetentionExpectationSchema = z.enum([
  "provider_default",
  "zero_retention_contract",
  "unknown",
]);
export type CloudRetentionExpectation = z.infer<typeof CloudRetentionExpectationSchema>;

export const ExternalDataScopeUseSchema = z.enum([
  "external_model_context",
  "external_tool_payload",
]);
export type ExternalDataScopeUse = z.infer<typeof ExternalDataScopeUseSchema>;

export const ExternalDataScopeGrantSchema = z.object({
  grant_ref: CognitionRefSchema,
  use: ExternalDataScopeUseSchema,
  purpose: CloudComputePurposeSchema,
  context_ref: CognitionEventRefSchema.optional(),
  payload_ref: CognitionRefSchema.optional(),
}).strict().superRefine((grant, ctx) => {
  if (grant.use === "external_model_context" && !grant.context_ref) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["context_ref"],
      message: "external model context grants must name the exact context ref",
    });
  }
  if (grant.use === "external_tool_payload" && !grant.payload_ref) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["payload_ref"],
      message: "external tool payload grants must name the exact payload ref",
    });
  }
});
export type ExternalDataScopeGrant = z.infer<typeof ExternalDataScopeGrantSchema>;

export const CloudAdmittedRefVersionSchema = z.object({
  ref: CognitionEventRefSchema,
  lifecycle: z.enum(["active", "matured"]),
  correction_state: z.literal("current"),
  source_epoch: z.string().min(1),
}).strict();
export type CloudAdmittedRefVersion = z.infer<typeof CloudAdmittedRefVersionSchema>;

export const CloudComputeRequestSchema = z.object({
  request_id: z.string().min(1),
  provider_ref: z.string().min(1),
  provider_policy_ref: CognitionRefSchema,
  purpose: CloudComputePurposeSchema,
  surface_projection_ref: z.string().min(1),
  redaction_refs: z.array(CognitionRefSchema).default([]),
  privacy_profile: z.literal("external_service"),
  admission_evaluation_ref: CognitionRefSchema,
  autonomy_evaluation_ref: CognitionRefSchema,
  payload_fingerprint: z.string().min(1),
  dispatch_nonce_ref: CognitionRefSchema,
  target_epoch: z.string().min(1),
  payload_epoch: z.string().min(1),
  admitted_ref_versions: z.array(CloudAdmittedRefVersionSchema).default([]),
  model_visible_context_refs: z.array(CognitionEventRefSchema).default([]),
  external_tool_payload_refs: z.array(CognitionRefSchema).default([]),
  external_data_scope_grants: z.array(ExternalDataScopeGrantSchema).default([]),
  invalidation_refs: z.array(CognitionRefSchema).default([]),
  retention_expectation: CloudRetentionExpectationSchema,
  user_visible_summary: z.string().min(1),
  expires_at: z.string().datetime(),
}).strict().superRefine((request, ctx) => {
  if (request.model_visible_context_refs.length > 0 && request.redaction_refs.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["redaction_refs"],
      message: "cloud compute requests with model-visible context require redaction refs",
    });
  }
  for (const [index, contextRef] of request.model_visible_context_refs.entries()) {
    if (!hasAdmittedRefVersion(request.admitted_ref_versions, contextRef)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["admitted_ref_versions", index],
        message: "cloud compute requests require current admitted ref versions for each model-visible context ref",
      });
    }
    if (!hasExternalDataScopeGrant(request.external_data_scope_grants, "external_model_context", request.purpose, contextRef)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["external_data_scope_grants", index],
        message: "model-visible context requires an explicit purpose-bound external_model_context grant",
      });
    }
  }
  for (const [index, payloadRef] of request.external_tool_payload_refs.entries()) {
    if (!hasExternalToolPayloadGrant(request.external_data_scope_grants, request.purpose, payloadRef)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["external_data_scope_grants", index],
        message: "external tool payload requires an explicit purpose-bound external_tool_payload grant",
      });
    }
  }
});
export type CloudComputeRequest = z.infer<typeof CloudComputeRequestSchema>;

export const AuthorizationRequestSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("runtime_control_intent"),
    request_id: z.string().min(1),
    runtime_control_intent_ref: CognitionRefSchema,
    request_fingerprint: z.string().min(1),
    origin_ref: CognitionEventRefSchema,
    target_epoch: z.string().min(1),
    payload_epoch: z.string().min(1),
    expires_at: z.string().datetime(),
    side_effect_profile: SideEffectProfileSchema,
    privacy_profile: PrivacyProfileSchema,
    fail_closed_validation_refs: z.array(CognitionRefSchema).default([]),
  }).strict(),
  z.object({
    kind: z.literal("approval_task_request"),
    request_id: z.string().min(1),
    approval_task_ref: CognitionRefSchema,
    request_fingerprint: z.string().min(1),
    origin_ref: CognitionEventRefSchema,
    target_epoch: z.string().min(1),
    payload_epoch: z.string().min(1),
    expires_at: z.string().datetime(),
    side_effect_profile: SideEffectProfileSchema,
    privacy_profile: PrivacyProfileSchema,
    fail_closed_validation_refs: z.array(CognitionRefSchema).default([]),
  }).strict(),
  z.object({
    kind: z.literal("permission_wait_plan"),
    request_id: z.string().min(1),
    permission_wait_plan_ref: CognitionRefSchema,
    request_fingerprint: z.string().min(1),
    origin_ref: CognitionEventRefSchema,
    target_epoch: z.string().min(1),
    payload_epoch: z.string().min(1),
    expires_at: z.string().datetime(),
    side_effect_profile: SideEffectProfileSchema,
    privacy_profile: PrivacyProfileSchema,
    fail_closed_validation_refs: z.array(CognitionRefSchema).default([]),
  }).strict(),
  z.object({
    kind: z.literal("gateway_approval_binding"),
    request_id: z.string().min(1),
    gateway_approval_binding_ref: CognitionRefSchema,
    request_fingerprint: z.string().min(1),
    origin_ref: CognitionEventRefSchema,
    target_epoch: z.string().min(1),
    payload_epoch: z.string().min(1),
    expires_at: z.string().datetime(),
    side_effect_profile: SideEffectProfileSchema,
    privacy_profile: PrivacyProfileSchema,
    fail_closed_validation_refs: z.array(CognitionRefSchema).default([]),
  }).strict(),
  z.object({
    kind: z.literal("cloud_compute_request"),
    request_id: z.string().min(1),
    cloud_compute_request: CloudComputeRequestSchema,
    request_fingerprint: z.string().min(1),
    origin_ref: CognitionEventRefSchema,
    target_epoch: z.string().min(1),
    payload_epoch: z.string().min(1),
    expires_at: z.string().datetime(),
    side_effect_profile: z.literal("cloud_compute"),
    privacy_profile: z.literal("external_service"),
    fail_closed_validation_refs: z.array(CognitionRefSchema).default([]),
  }).strict(),
]);
export type AuthorizationRequest = z.infer<typeof AuthorizationRequestSchema>;

export const SituationModelSchema = z.object({
  situation_id: z.string().min(1),
  summary_ref: CognitionEventRefSchema,
  caller_path: CompanionCognitionCallerPathSchema,
  route_ref: CognitionRefSchema.optional(),
  reply_target_ref: CognitionRefSchema.optional(),
  session_ref: CognitionRefSchema.optional(),
  runtime_phase_ref: CognitionRefSchema.optional(),
  operation_boundary_ref: CognitionRefSchema.optional(),
  operation_boundary_status: z.enum(["allowed", "blocked", "held", "unavailable"]).optional(),
  policy_available: z.boolean().optional(),
  tool_trace_refs: z.array(CognitionRefSchema).default([]),
  approval_refs: z.array(CognitionRefSchema).default([]),
  current_target_refs: z.array(CognitionRefSchema).default([]),
  stale_target_refs: z.array(CognitionRefSchema).default([]),
  missing_memory_refs: z.array(CognitionRefSchema).optional(),
  missing_policy_refs: z.array(CognitionRefSchema).optional(),
  protocol_bypass: z.boolean().default(false),
  confidence: z.number().min(0).max(1),
}).strict();
export type SituationModel = z.infer<typeof SituationModelSchema>;

export const RelationshipProjectionTurnRefSchema = z.object({
  kind: z.enum(["chat_turn", "gateway_turn", "resident_turn", "task_turn"]),
  ref: z.string().min(1),
}).strict();
export type RelationshipProjectionTurnRef = z.infer<typeof RelationshipProjectionTurnRefSchema>;

export const RelationshipProjectionSourceRefSchema = z.object({
  kind: z.enum(["surface_projection", "memory_projection", "character_policy_projection"]),
  ref: z.string().min(1),
}).strict();
export type RelationshipProjectionSourceRef = z.infer<typeof RelationshipProjectionSourceRefSchema>;

export const RelationshipSurfaceFactSchema = z.object({
  memory_ref: z.string().min(1),
  role: RelationshipSurfaceFactRoleSchema,
  user_readable_reason: z.string().min(1),
  allowed_surface_use: RelationshipSurfaceAllowedUseSchema,
  confidence: z.number().min(0).max(1),
  sensitivity: z.enum(["public", "private"]),
  repair_paths: z.array(RelationshipSurfaceRepairPathSchema).min(1),
}).strict().superRefine((fact, ctx) => {
  if (
    fact.role === "boundary"
    && fact.allowed_surface_use !== "behavioral_inhibition"
    && fact.allowed_surface_use !== "ask_for_confirmation"
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["allowed_surface_use"],
      message: "boundary relationship facts must inhibit behavior or ask for confirmation",
    });
  }
  if (fact.role === "open_tension" && fact.allowed_surface_use !== "ask_for_confirmation") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["allowed_surface_use"],
      message: "open tension facts can only ask for confirmation on the normal surface",
    });
  }
  if (fact.confidence < 0.5 && fact.allowed_surface_use === "user_facing_reference") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["allowed_surface_use"],
      message: "low-confidence relationship facts cannot be projected as stable user-facing references",
    });
  }
});
export type RelationshipSurfaceFact = z.infer<typeof RelationshipSurfaceFactSchema>;

export const RelationshipWithheldFactSchema = z.object({
  memory_ref: z.string().min(1),
  role: RelationshipSurfaceFactRoleSchema.default("preference"),
  withheld_reason: CognitionWithheldMemorySourceSchema.shape.withheld_reason,
  user_readable_reason: z.string().min(1),
  sensitivity: z.enum(["public", "private", "sensitive", "redacted"]),
  repair_paths: z.array(RelationshipSurfaceRepairPathSchema).min(1),
}).strict();
export type RelationshipWithheldFact = z.infer<typeof RelationshipWithheldFactSchema>;

export const RelationshipStateProjectionV2Schema = z.object({
  projection_id: z.string().min(1),
  turn_ref: RelationshipProjectionTurnRefSchema.optional(),
  surface_projection_ref: RelationshipProjectionSourceRefSchema.optional(),
  core_memory_projection_ref: RelationshipProjectionSourceRefSchema.optional(),
  included: z.array(RelationshipSurfaceFactSchema).default([]),
  withheld: z.array(RelationshipWithheldFactSchema).default([]),
  character_policy_ref: RelationshipProjectionSourceRefSchema.optional(),
  posture: z.enum(["neutral", "concise", "careful", "encouraging", "boundary_first"]).default("neutral"),
  relationship_refs: z.array(CognitionMemorySourceSchema).default([]),
  withheld_memory_refs: z.array(CognitionWithheldMemorySourceSchema).default([]),
  conflict_refs: z.array(CognitionRefSchema).default([]),
  overreach_risk: z.enum(["none", "low", "medium", "high", "unknown"]).default("unknown"),
  normal_surface_debug_visible: z.literal(false).default(false),
  ordinary_surface_debug_visible: z.literal(false).default(false),
}).strict().superRefine((projection, ctx) => {
  const hasBoundary = projection.included.some((fact) => fact.role === "boundary");
  const hasPreference = projection.included.some((fact) => fact.role === "preference");
  if (hasBoundary && hasPreference && projection.posture !== "boundary_first") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["posture"],
      message: "boundary/preference conflicts must resolve boundary-first on the normal surface",
    });
  }
  if (projection.normal_surface_debug_visible !== false || projection.ordinary_surface_debug_visible !== false) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["normal_surface_debug_visible"],
      message: "relationship projection debug state must stay hidden from normal surfaces",
    });
  }
});
export type RelationshipStateProjectionV2 = z.infer<typeof RelationshipStateProjectionV2Schema>;

export const RelationshipStateProjectionSchema = RelationshipStateProjectionV2Schema;
export type RelationshipStateProjection = z.infer<typeof RelationshipStateProjectionSchema>;

export const IntentionSelectionSchema = z.object({
  intention_id: z.string().min(1),
  goal_ref: GoalRefSchema.optional(),
  lifecycle: IntentionLifecycleSchema,
  selected_path_ref: CognitionRefSchema.optional(),
  requires_regrounding: z.boolean().default(false),
  stale_target_refs: z.array(CognitionRefSchema).default([]),
  reason_refs: z.array(CognitionEventRefSchema).default([]),
}).strict().superRefine((selection, ctx) => {
  if (selection.stale_target_refs.length > 0 && !selection.requires_regrounding) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["requires_regrounding"],
      message: "stale target refs require regrounding before intention use",
    });
  }
  if (selection.requires_regrounding && selection.lifecycle !== "requires_regrounding" && selection.lifecycle !== "obsolete") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["lifecycle"],
      message: "regrounding intentions must be requires_regrounding or obsolete",
    });
  }
});
export type IntentionSelection = z.infer<typeof IntentionSelectionSchema>;

export const ResponsePlanSchema = z.object({
  plan_id: z.string().min(1),
  guidance_kind: z.enum(["answer", "clarify", "hold", "digest", "suggest", "request_approval", "refuse", "continue_route"]),
  public_summary: z.string().min(1),
  surface_target: CompanionCognitionSurfaceTargetSchema,
  delivery_kind: ProactiveDeliveryKindSchema.optional(),
  quieting_applied: z.boolean().default(false),
  operator_debug_refs: z.array(CognitionRefSchema).default([]),
  hidden_policy_state_visible_to_normal_user: z.literal(false).default(false),
}).strict();
export type ResponsePlan = z.infer<typeof ResponsePlanSchema>;

export const ModelContextPolicySchema = z.object({
  policy_id: z.string().min(1),
  surface: z.enum(["gateway_chat"]),
  reply_shape: z.enum(["codex_chat_shape"]),
  local_fact_policy: z.enum(["tool_required_for_current_state"]),
  tool_use_policy: z.enum(["use_available_tools_for_inspection_or_state"]),
  runtime_control_policy: z.enum(["provided_authorization_tools_only"]),
  internal_label_visibility: z.enum(["suppress_route_and_lifecycle_labels"]),
  language_policy: z.object({
    mode: z.literal("same_as_current_input"),
    hint: z.enum(["ja", "latin", "other", "unknown"]).default("unknown"),
  }).strict(),
  hidden_policy_state_visible_to_normal_user: z.literal(false).default(false),
}).strict();
export type ModelContextPolicy = z.infer<typeof ModelContextPolicySchema>;

export const MemoryWritebackProposalSchema = z.object({
  proposal_id: z.string().min(1),
  proposal_kind: z.enum([
    "episode",
    "relationship_profile_candidate",
    "soil_record_candidate",
    "procedural_skill_candidate",
    "feedback_policy_candidate",
  ]),
  source_event_refs: z.array(CognitionEventRefSchema).min(1),
  proposed_target: z.enum(["dream", "profile", "soil", "knowledge", "attention_feedback", "reflection"]),
  admission_state: z.literal("pending_review").default("pending_review"),
  user_visible_review_text: z.string().min(1).optional(),
  evidence_summary_ref: CognitionEventRefSchema.optional(),
  auto_apply: z.literal(false).default(false),
  source_content_materialized: z.literal(false).default(false),
}).strict();
export type MemoryWritebackProposal = z.infer<typeof MemoryWritebackProposalSchema>;

export const ReflectionHintSchema = z.object({
  hint_id: z.string().min(1),
  hint_kind: z.enum(["episode", "tool_failure", "overreach_feedback", "memory_conflict", "procedural_candidate"]),
  source_refs: z.array(CognitionEventRefSchema).min(1),
  consumer: z.enum(["dream_consolidation", "soil_projection", "profile_proposal", "procedural_promotion"]),
  runtime_authority: z.literal(false).default(false),
}).strict();
export type ReflectionHint = z.infer<typeof ReflectionHintSchema>;

export const CognitionUncertaintySchema = z.object({
  uncertainty_id: z.string().min(1),
  kind: z.enum(["unknown_intent", "memory_conflict", "stale_target", "missing_surface", "tool_repair_required", "policy_unavailable"]),
  severity: z.enum(["low", "medium", "high"]),
  reason: z.string().min(1),
  refs: z.array(CognitionRefSchema).default([]),
}).strict();
export type CognitionUncertainty = z.infer<typeof CognitionUncertaintySchema>;

export const CandidateActionSchema = z.object({
  action_id: z.string().min(1),
  action_kind: z.enum([
    "no_op",
    "hold",
    "suppress",
    "continue_route",
    "digest",
    "suggest",
    "prepare",
    "request_authority",
    "handoff",
  ]),
  target_ref: CognitionRefSchema.optional(),
  reason_refs: z.array(CognitionRefSchema).default([]),
  side_effect_profile: SideEffectProfileSchema,
  requires_authority: z.boolean().default(false),
  executes_side_effect: z.literal(false).default(false),
}).strict();
export type CandidateAction = z.infer<typeof CandidateActionSchema>;

export const CommitmentAttentionHandoffSchema = z.object({
  handoff_id: z.string().min(1),
  state: z.enum([
    "not_applicable",
    "shadow_recorded",
    "candidate_saved",
    "control_applied",
    "resident_operation_selected",
  ]),
  attention_input_ref: CognitionRefSchema.optional(),
  commitment_ref: CognitionRefSchema.optional(),
  operation_plan_ref: CognitionRefSchema.optional(),
  store_ref: CognitionRefSchema.optional(),
  uses_attention_state_store: z.literal(true).default(true),
  creates_parallel_commitment_store: z.literal(false).default(false),
}).strict();
export type CommitmentAttentionHandoff = z.infer<typeof CommitmentAttentionHandoffSchema>;

export const MemoryUseAuditSchema = z.object({
  audit_id: z.string().min(1),
  request_id: z.string().min(1),
  requested_uses: z.array(CognitionRequestedMemoryUseSchema).default([]),
  included_memory_refs: z.array(CognitionRefSchema).default([]),
  withheld_memory_refs: z.array(CognitionRefSchema).default([]),
  memory_truth_refs: z.array(CognitionRefSchema).default([]),
  owner_boundary: z.literal("memory_truth_maintenance"),
  raw_memory_read: z.literal(false).default(false),
  resurrects_invalidated_memory: z.literal(false).default(false),
}).strict();
export type MemoryUseAudit = z.infer<typeof MemoryUseAuditSchema>;

export const AuthorityHandoffSchema = z.object({
  handoff_id: z.string().min(1),
  boundary: z.enum([
    "interaction_authority",
    "runtime_control",
    "tool_policy",
    "none",
  ]),
  proposed_decision_ref: CognitionRefSchema.optional(),
  request_refs: z.array(CognitionRefSchema).default([]),
  authority_state_refs: z.array(CognitionRefSchema).default([]),
  kernel_executes_side_effects: z.literal(false).default(false),
  bypasses_stale_target_rejection: z.literal(false).default(false),
}).strict();
export type AuthorityHandoff = z.infer<typeof AuthorityHandoffSchema>;

export const CognitionCorrelationRefsSchema = z.object({
  replay_key: z.string().min(1),
  idempotency_key: z.string().min(1),
  event_refs: z.array(CognitionEventRefSchema).default([]),
  runtime_graph_refs: z.array(CognitionRefSchema).default([]),
  runtime_event_refs: z.array(CognitionRefSchema).default([]),
}).strict();
export type CognitionCorrelationRefs = z.infer<typeof CognitionCorrelationRefsSchema>;

export const CompanionCognitionInputSchema = z.object({
  cognition_id: z.string().min(1),
  caller_path: CompanionCognitionCallerPathSchema,
  event_refs: z.array(CognitionEventRefSchema).min(1),
  working_context: WorkingContextSnapshotSchema,
  session_context: ChatSessionCognitionContextSchema.optional(),
  attention_context: AttentionCognitionContextSchema.optional(),
  runtime_context: RuntimeCognitionContextSchema.optional(),
  goal_context: GoalIntentionContextSchema.optional(),
  memory_context_request: CognitionMemoryRequestSchema,
  memory_result: CognitionMemoryResultSchema.optional(),
  proposed_tool_candidates: z.array(ToolCandidateSchema).default([]),
  authorization_requests: z.array(AuthorizationRequestSchema).default([]),
  surface_target: CompanionCognitionSurfaceTargetSchema,
}).strict().superRefine((input, ctx) => {
  if (input.caller_path === "chat_user_turn" && !input.session_context) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["session_context"],
      message: "chat cognition input requires session_context",
    });
  }
  if (input.caller_path === "resident_proactive_check" && !input.attention_context) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["attention_context"],
      message: "resident proactive cognition input requires attention_context",
    });
  }
  if (input.caller_path === "long_running_task_turn" && !input.runtime_context) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["runtime_context"],
      message: "task cognition input requires runtime_context",
    });
  }
  if (input.caller_path === "runtime_control_response" && !input.runtime_context) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["runtime_context"],
      message: "runtime-control cognition input requires runtime_context",
    });
  }
  if (input.memory_context_request.caller_path !== input.caller_path) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["memory_context_request", "caller_path"],
      message: "memory request caller path must match cognition caller path",
    });
  }
});
export type CompanionCognitionInput = z.input<typeof CompanionCognitionInputSchema>;
export type ParsedCompanionCognitionInput = z.infer<typeof CompanionCognitionInputSchema>;

export const CompanionCognitionOutputSchema = z.object({
  cognition_id: z.string().min(1),
  caller_path: CompanionCognitionCallerPathSchema,
  situation_model: SituationModelSchema,
  relationship_state: RelationshipStateProjectionSchema,
  selected_intention: IntentionSelectionSchema.nullable(),
  candidate_action: CandidateActionSchema.optional(),
  commitment_handoff: CommitmentAttentionHandoffSchema.optional(),
  response_plan: ResponsePlanSchema,
  model_context_policy: ModelContextPolicySchema.optional(),
  memory_use_audit: MemoryUseAuditSchema.optional(),
  authority_handoff: AuthorityHandoffSchema.optional(),
  tool_candidates: z.array(ToolCandidateSchema).default([]),
  authorization_requests: z.array(AuthorizationRequestSchema).default([]),
  memory_writeback: z.array(MemoryWritebackProposalSchema).default([]),
  reflection_hints: z.array(ReflectionHintSchema).default([]),
  correlation_refs: CognitionCorrelationRefsSchema.optional(),
  audit_refs: z.array(z.string().min(1)).default([]),
  uncertainty: z.array(CognitionUncertaintySchema).default([]),
  debug_trace: z.object({
    surface_target: CompanionCognitionSurfaceTargetSchema,
    event_ref_count: z.number().int().nonnegative(),
    memory_included_count: z.number().int().nonnegative(),
    memory_withheld_count: z.number().int().nonnegative(),
  }).optional(),
}).strict().superRefine((output, ctx) => {
  if (output.caller_path === "resident_proactive_check") {
    for (const [index, candidate] of output.tool_candidates.entries()) {
      if (candidate.authority_stage === "execute") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tool_candidates", index, "authority_stage"],
          message: "resident proactive cognition cannot create execute-stage tool authority",
        });
      }
    }
  }
  if (
    output.response_plan.surface_target === "normal_user"
    && output.response_plan.operator_debug_refs.length > 0
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["response_plan", "operator_debug_refs"],
      message: "normal user surface cannot receive operator debug refs",
    });
  }
});
export type CompanionCognitionOutput = z.infer<typeof CompanionCognitionOutputSchema>;

export const CognitionReplayStableOutputSchema = z.object({
  cognition_id: z.string().min(1),
  caller_path: CompanionCognitionCallerPathSchema,
  situation_model: SituationModelSchema,
  relationship_state: RelationshipStateProjectionSchema,
  selected_intention: IntentionSelectionSchema.nullable(),
  candidate_action: CandidateActionSchema.optional(),
  commitment_handoff: CommitmentAttentionHandoffSchema.optional(),
  response_plan: ResponsePlanSchema,
  model_context_policy: ModelContextPolicySchema.optional(),
  memory_use_audit: MemoryUseAuditSchema.optional(),
  authority_handoff: AuthorityHandoffSchema.optional(),
  tool_candidates: z.array(ToolCandidateSchema).default([]),
  authorization_requests: z.array(AuthorizationRequestSchema).default([]),
  memory_writeback: z.array(MemoryWritebackProposalSchema).default([]),
  reflection_hints: z.array(ReflectionHintSchema).default([]),
  correlation_refs: CognitionCorrelationRefsSchema.optional(),
  audit_refs: z.array(z.string().min(1)).default([]),
  uncertainty: z.array(CognitionUncertaintySchema).default([]),
}).strict();
export type CognitionReplayStableOutput = z.infer<typeof CognitionReplayStableOutputSchema>;

export const CognitionReplayRecordSchema = z.object({
  schema_version: z.literal("cognition-replay-record/v1"),
  record_id: z.string().min(1),
  cognition_id: z.string().min(1),
  caller_path: CompanionCognitionCallerPathSchema,
  created_at: z.string().datetime(),
  event_refs: z.array(CognitionEventRefSchema).default([]),
  stable_output: CognitionReplayStableOutputSchema.optional(),
  failure: z.object({
    message: z.string().min(1),
    retryable: z.boolean().default(false),
  }).strict().optional(),
  retention_policy: z.object({
    materialized_content: z.literal(false).default(false),
    refs_only: z.literal(true).default(true),
    invalidates_on_source_tombstone: z.literal(true).default(true),
  }).strict().default({}),
}).strict().superRefine((record, ctx) => {
  if (!record.stable_output && !record.failure) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["stable_output"],
      message: "cognition replay records must contain stable_output or failure",
    });
  }
});
export type CognitionReplayRecord = z.infer<typeof CognitionReplayRecordSchema>;

export const CognitionWritebackReflectionInputSchema = z.object({
  schema_version: z.literal("cognition-writeback-reflection-input/v1"),
  input_id: z.string().min(1),
  episode_refs: z.array(CognitionEventRefSchema).min(1),
  writeback_proposals: z.array(MemoryWritebackProposalSchema).default([]),
  tool_trace_refs: z.array(CognitionEventRefSchema).default([]),
  feedback_refs: z.array(CognitionEventRefSchema).default([]),
  runtime_authority: z.literal(false).default(false),
}).strict();
export type CognitionWritebackReflectionInput = z.infer<typeof CognitionWritebackReflectionInputSchema>;

export function deliveryKindRank(kind: ProactiveDeliveryKind): number {
  return DELIVERY_KIND_RANK[kind];
}

function hasAdmittedRefVersion(versions: CloudAdmittedRefVersion[], ref: CognitionEventRef): boolean {
  return versions.some((version) => cognitionEventRefKey(version.ref) === cognitionEventRefKey(ref));
}

function hasExternalDataScopeGrant(
  grants: ExternalDataScopeGrant[],
  use: ExternalDataScopeUse,
  purpose: CloudComputePurpose,
  contextRef: CognitionEventRef
): boolean {
  return grants.some((grant) =>
    grant.use === use
    && grant.purpose === purpose
    && grant.context_ref
    && cognitionEventRefKey(grant.context_ref) === cognitionEventRefKey(contextRef)
  );
}

function hasExternalToolPayloadGrant(
  grants: ExternalDataScopeGrant[],
  purpose: CloudComputePurpose,
  payloadRef: CognitionRef
): boolean {
  return grants.some((grant) =>
    grant.use === "external_tool_payload"
    && grant.purpose === purpose
    && grant.payload_ref
    && grant.payload_ref.kind === payloadRef.kind
    && grant.payload_ref.ref === payloadRef.ref
  );
}

function cognitionEventRefKey(ref: CognitionEventRef): string {
  return JSON.stringify({
    ref: ref.ref,
    source_store: ref.source_store,
    source_event_type: ref.source_event_type,
    schema_version: ref.schema_version,
    source_epoch: ref.source_epoch ?? null,
    high_watermark: ref.high_watermark ?? null,
    replay_key: ref.replay_key ?? null,
    redaction_policy: ref.redaction_policy,
  });
}
