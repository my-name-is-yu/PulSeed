import { z } from "zod";
import {
  AdmissionPolicyResultSchema,
} from "../control/admission-policy.js";
import {
  AutonomyDecisionLevelSchema,
  AutonomyDecisionSchema,
  type AutonomyDecision,
} from "../control/autonomy-governor.js";
import {
  CompanionActionProjectionSchema,
  CompanionProjectionContextSchema,
  projectCompanionAction,
  type CompanionActionProjection,
  type CompanionProjectionContextInput,
} from "../control/companion-action-projection.js";
import {
  CompanionAutonomyRefSchema,
  CompanionAutonomySourceRefSchema,
} from "../types/companion-autonomy.js";

export const CompanionDecisionSourceKindSchema = z.enum([
  "chat_turn",
  "task_execution",
  "resident_attention_cycle",
]);
export type CompanionDecisionSourceKind = z.infer<typeof CompanionDecisionSourceKindSchema>;

export const CompanionDecisionCallerPathKindSchema = z.enum([
  "chat_gateway_model_loop",
  "chat_native_agent_loop",
  "chat_runtime_control",
  "chat_configure_route",
  "task_agent_loop",
  "bounded_agent_loop",
  "resident_attention_cycle",
  "projection_only",
]);
export type CompanionDecisionCallerPathKind = z.infer<typeof CompanionDecisionCallerPathKindSchema>;

export const CompanionDecisionInputRefKindSchema = z.enum([
  "chat_message",
  "task",
  "attention_cycle",
  "grounding_bundle",
  "grounding_section",
  "companion_state",
  "attention_signal",
  "attention_agenda_item",
  "initiative_gate_decision",
  "outcome_decision",
  "admission_policy_evaluation",
  "autonomy_decision",
  "runtime_item",
  "runtime_control_state",
  "approval_request",
  "surface",
  "goal",
  "session",
  "run",
  "capability_readiness",
  "memory_projection",
  "gadget_plan",
  "character_config_policy",
]);
export type CompanionDecisionInputRefKind = z.infer<typeof CompanionDecisionInputRefKindSchema>;

export const CompanionDecisionInputRoleSchema = z.enum([
  "trigger",
  "target",
  "context",
  "state",
  "policy",
  "constraint",
  "candidate",
  "bridge",
]);
export type CompanionDecisionInputRole = z.infer<typeof CompanionDecisionInputRoleSchema>;

export const CompanionDecisionInputFreshnessSchema = z.enum([
  "current",
  "aging",
  "stale",
  "needs_regrounding",
  "rejected_stale",
  "unknown",
]);
export type CompanionDecisionInputFreshness = z.infer<typeof CompanionDecisionInputFreshnessSchema>;

export const CompanionDecisionInputRefSchema = z.object({
  kind: CompanionDecisionInputRefKindSchema,
  ref: z.string().min(1),
  role: CompanionDecisionInputRoleSchema,
  freshness: CompanionDecisionInputFreshnessSchema.default("current"),
  epoch: z.string().min(1).optional(),
  reason: z.string().min(1).optional(),
}).strict();
export type CompanionDecisionInputRef = z.infer<typeof CompanionDecisionInputRefSchema>;

export const CompanionDecisionEvidenceSourceSchema = z.enum([
  "user_turn",
  "task",
  "resident_cycle",
  "grounding",
  "attention",
  "companion_state",
  "admission_policy",
  "autonomy_governor",
  "runtime_control",
  "runner",
  "projection",
  "feedback",
]);
export type CompanionDecisionEvidenceSource = z.infer<typeof CompanionDecisionEvidenceSourceSchema>;

export const CompanionDecisionEvidenceVisibilitySchema = z.enum([
  "normal_user_visible",
  "operator_only",
  "audit_only",
  "hidden_policy",
]);
export type CompanionDecisionEvidenceVisibility = z.infer<typeof CompanionDecisionEvidenceVisibilitySchema>;

export const CompanionDecisionEvidenceRefSchema = z.object({
  evidence_ref: z.string().min(1),
  source: CompanionDecisionEvidenceSourceSchema,
  visibility: CompanionDecisionEvidenceVisibilitySchema.default("audit_only"),
  source_ref: CompanionAutonomySourceRefSchema.optional(),
  summary: z.string().min(1).optional(),
}).strict();
export type CompanionDecisionEvidenceRef = z.infer<typeof CompanionDecisionEvidenceRefSchema>;

export const CompanionDecisionPolicyRefKindSchema = z.enum([
  "safety_boundary",
  "approval_gate",
  "runtime_control",
  "attention_gate",
  "admission_policy",
  "autonomy_governor",
  "companion_state",
  "visibility_policy",
  "surface_policy",
  "character_config_policy",
]);
export type CompanionDecisionPolicyRefKind = z.infer<typeof CompanionDecisionPolicyRefKindSchema>;

export const CompanionDecisionPolicyRefSchema = z.object({
  kind: CompanionDecisionPolicyRefKindSchema,
  ref: z.string().min(1),
  result: z.string().min(1).optional(),
  epoch: z.string().min(1).optional(),
}).strict();
export type CompanionDecisionPolicyRef = z.infer<typeof CompanionDecisionPolicyRefSchema>;

export const CompanionDecisionSourceSchema = z.object({
  kind: CompanionDecisionSourceKindSchema,
  source_ref: z.string().min(1),
  received_at: z.string().datetime(),
  caller_path: CompanionDecisionCallerPathKindSchema.optional(),
  surface_ref: z.string().min(1).optional(),
  session_ref: z.string().min(1).optional(),
  goal_ref: z.string().min(1).optional(),
  task_ref: z.string().min(1).optional(),
  run_ref: z.string().min(1).optional(),
  attention_cycle_ref: z.string().min(1).optional(),
  channel: z.string().min(1).optional(),
}).strict().superRefine((source, ctx) => {
  if (source.kind === "task_execution" && !source.task_ref) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "task_execution decision sources must carry task_ref",
      path: ["task_ref"],
    });
  }
  if (source.kind === "resident_attention_cycle" && !source.attention_cycle_ref) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "resident_attention_cycle decision sources must carry attention_cycle_ref",
      path: ["attention_cycle_ref"],
    });
  }
});
export type CompanionDecisionSource = z.infer<typeof CompanionDecisionSourceSchema>;

export const CompanionDecisionFrameSchema = z.object({
  schema_version: z.literal("companion-decision-frame/v1"),
  frame_id: z.string().min(1),
  assembled_at: z.string().datetime(),
  source: CompanionDecisionSourceSchema,
  input_refs: z.array(CompanionDecisionInputRefSchema).min(1),
  evidence_refs: z.array(CompanionDecisionEvidenceRefSchema).default([]),
  policy_refs: z.array(CompanionDecisionPolicyRefSchema).default([]),
  active_target_ref: CompanionAutonomyRefSchema.nullable().default(null),
  active_surface_ref: z.string().min(1).nullable().default(null),
  companion_state_ref: z.string().min(1).nullable().default(null),
  grounding_bundle_ref: z.string().min(1).nullable().default(null),
  attention_cycle_ref: z.string().min(1).nullable().default(null),
  admission_evaluation_refs: z.array(z.string().min(1)).default([]),
  autonomy_decision_refs: z.array(z.string().min(1)).default([]),
  projection_refs: z.array(z.string().min(1)).default([]),
}).strict();
export type CompanionDecisionFrame = z.infer<typeof CompanionDecisionFrameSchema>;

export const CompanionDecisionDispositionSchema = z.enum([
  "answer_now",
  "ask_clarification",
  "hold",
  "prepare_draft",
  "digest_later",
  "request_approval",
  "execute_now",
  "continue_durable_work",
  "stay_silent",
  "refuse_with_alternative",
  "emit_surface_intent",
  "reground_before_action",
]);
export type CompanionDecisionDisposition = z.infer<typeof CompanionDecisionDispositionSchema>;

export const CompanionDecisionHoldReasonSchema = z.enum([
  "quieting_policy",
  "stale_target",
  "user_focus",
  "backpressure",
  "safety_boundary",
  "missing_evidence",
]);
export type CompanionDecisionHoldReason = z.infer<typeof CompanionDecisionHoldReasonSchema>;

export const CompanionDecisionIntegrationStateSchema = z.enum([
  "contract_only",
  "adapter_ready",
  "production_wired",
]);
export type CompanionDecisionIntegrationState = z.infer<typeof CompanionDecisionIntegrationStateSchema>;

export const CompanionDecisionRouteSchema = z.object({
  disposition: CompanionDecisionDispositionSchema,
  caller_path: CompanionDecisionCallerPathKindSchema,
  integration_state: CompanionDecisionIntegrationStateSchema.default("contract_only"),
  preserves_existing_runner: z.boolean().default(true),
  target_ref: CompanionAutonomyRefSchema.nullable().default(null),
  requires_approval: z.boolean().default(false),
  emits_user_visible_projection: z.boolean().default(false),
  hold_reason: CompanionDecisionHoldReasonSchema.optional(),
}).strict().superRefine((route, ctx) => {
  if (route.disposition === "request_approval" && !route.requires_approval) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "request_approval routes must mark requires_approval=true",
      path: ["requires_approval"],
    });
  }
  if (route.disposition === "hold" && !route.hold_reason) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "hold routes must name a hold_reason",
      path: ["hold_reason"],
    });
  }
});
export type CompanionDecisionRoute = z.infer<typeof CompanionDecisionRouteSchema>;

export const CompanionDecisionTraceSchema = z.object({
  why_this: z.string().min(1),
  why_now: z.string().min(1),
  why_this_route: z.string().min(1),
  evidence_refs: z.array(z.string().min(1)).default([]),
  policy_refs: z.array(z.string().min(1)).default([]),
  alternatives_considered: z.array(z.string().min(1)).default([]),
  suppressed_alternatives: z.array(z.string().min(1)).default([]),
}).strict();
export type CompanionDecisionTrace = z.infer<typeof CompanionDecisionTraceSchema>;

export const CompanionDecisionInternalPolicyStateSchema = z.object({
  visibility: z.literal("operator_only"),
  policy_refs: z.array(CompanionDecisionPolicyRefSchema).min(1),
  raw_policy_detail_refs: z.array(z.string().min(1)).default([]),
  debug_snapshot_ref: z.string().min(1).optional(),
}).strict();
export type CompanionDecisionInternalPolicyState = z.infer<typeof CompanionDecisionInternalPolicyStateSchema>;

export const CompanionDecisionProjectionBridgeSchema = z.object({
  bridge_kind: z.literal("companion_action_projection"),
  autonomy_decision_ref: z.string().min(1),
  surface_ref: z.string().min(1),
  projection: CompanionActionProjectionSchema,
  raw_policy_state_visible: z.boolean(),
}).strict().superRefine((bridge, ctx) => {
  if (bridge.projection.decision_id !== bridge.autonomy_decision_ref) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "projection decision_id must match autonomy_decision_ref",
      path: ["projection", "decision_id"],
    });
  }
  if (bridge.projection.surface_expression_policy.raw_policy_state_visible !== bridge.raw_policy_state_visible) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "bridge raw policy visibility must match the projection surface policy",
      path: ["raw_policy_state_visible"],
    });
  }
});
export type CompanionDecisionProjectionBridge = z.infer<typeof CompanionDecisionProjectionBridgeSchema>;

export const CompanionDecisionOutputSchema = z.object({
  schema_version: z.literal("companion-decision-output/v1"),
  decision_id: z.string().min(1),
  frame_id: z.string().min(1),
  decided_at: z.string().datetime(),
  route: CompanionDecisionRouteSchema,
  trace: CompanionDecisionTraceSchema,
  admission_result: AdmissionPolicyResultSchema.optional(),
  autonomy_level: AutonomyDecisionLevelSchema.optional(),
  output_refs: z.array(CompanionDecisionInputRefSchema).default([]),
  internal_policy_state: CompanionDecisionInternalPolicyStateSchema.optional(),
  projection_bridge: CompanionDecisionProjectionBridgeSchema.optional(),
}).strict().superRefine((output, ctx) => {
  if (output.route.requires_approval && output.admission_result !== "approval_required") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "approval routes must carry admission_result=approval_required",
      path: ["admission_result"],
    });
  }
  if (output.projection_bridge && !output.route.emits_user_visible_projection) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "outputs with projection_bridge must mark emits_user_visible_projection=true",
      path: ["route", "emits_user_visible_projection"],
    });
  }
});
export type CompanionDecisionOutput = z.infer<typeof CompanionDecisionOutputSchema>;

export interface CreateCompanionDecisionProjectionBridgeInput {
  decision: AutonomyDecision;
  context: CompanionProjectionContextInput;
  preparedArtifactRefs?: string[];
  approvalRequestRef?: string;
  alternativeActionRefs?: string[];
  evaluatedAt?: string;
  projectionId?: string;
}

export function createCompanionDecisionProjectionBridge(
  input: CreateCompanionDecisionProjectionBridgeInput
): CompanionDecisionProjectionBridge {
  const decision = AutonomyDecisionSchema.parse(input.decision);
  const context = CompanionProjectionContextSchema.parse(input.context);
  const projection: CompanionActionProjection = projectCompanionAction({
    decision,
    context,
    prepared_artifact_refs: input.preparedArtifactRefs ?? [],
    ...(input.approvalRequestRef ? { approval_request_ref: input.approvalRequestRef } : {}),
    alternative_action_refs: input.alternativeActionRefs ?? [],
    ...(input.evaluatedAt ? { evaluated_at: input.evaluatedAt } : {}),
    ...(input.projectionId ? { projection_id: input.projectionId } : {}),
  });

  return CompanionDecisionProjectionBridgeSchema.parse({
    bridge_kind: "companion_action_projection",
    autonomy_decision_ref: decision.decision_id,
    surface_ref: context.surface_ref,
    projection,
    raw_policy_state_visible: projection.surface_expression_policy.raw_policy_state_visible,
  });
}
