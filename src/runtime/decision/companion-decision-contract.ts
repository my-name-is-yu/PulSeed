import { z } from "zod";
import {
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
  "agent_agenda_item",
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
