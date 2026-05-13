import { z } from "zod";
import {
  AutonomyDecisionSchema,
  type AutonomyDecision,
} from "./autonomy-governor.js";

export const CompanionUserVisibleActionKindSchema = z.enum([
  "stay_silent",
  "suggest",
  "prepare_draft",
  "ask_for_approval",
  "execute_now",
  "challenge",
  "refuse_with_alternative",
  "digest_later",
]);
export type CompanionUserVisibleActionKind = z.infer<typeof CompanionUserVisibleActionKindSchema>;

export const CompanionProjectionSurfaceKindSchema = z.enum([
  "normal_companion",
  "operator",
  "debug",
  "status",
]);
export type CompanionProjectionSurfaceKind = z.infer<typeof CompanionProjectionSurfaceKindSchema>;

export const CompanionSurfaceExpressionPolicySchema = z.object({
  surface_kind: CompanionProjectionSurfaceKindSchema,
  user_visible_reason: z.enum(["none", "brief", "operator_detail"]),
  hidden_reasons_visible: z.boolean(),
  capability_catalog_visible: z.boolean(),
  raw_policy_state_visible: z.boolean(),
}).strict();
export type CompanionSurfaceExpressionPolicy = z.infer<typeof CompanionSurfaceExpressionPolicySchema>;

export const CompanionProjectionContextSchema = z.object({
  surface_ref: z.string().min(1),
  surface_kind: CompanionProjectionSurfaceKindSchema.default("normal_companion"),
  quieted: z.boolean().default(false),
  digest_later_allowed: z.boolean().default(true),
  operator_inspectable: z.boolean().default(false),
}).strict();
export type CompanionProjectionContext = z.infer<typeof CompanionProjectionContextSchema>;
export type CompanionProjectionContextInput = z.input<typeof CompanionProjectionContextSchema>;

export const CompanionActionProjectionInputSchema = z.object({
  decision: AutonomyDecisionSchema,
  context: CompanionProjectionContextSchema,
  prepared_artifact_refs: z.array(z.string().min(1)).default([]),
  approval_request_ref: z.string().min(1).optional(),
  alternative_action_refs: z.array(z.string().min(1)).default([]),
  evaluated_at: z.string().min(1).optional(),
  projection_id: z.string().min(1).optional(),
}).strict();
export type CompanionActionProjectionInput = z.input<typeof CompanionActionProjectionInputSchema>;

export const CompanionActionProjectionSchema = z.object({
  schema_version: z.literal("companion-action-projection/v1"),
  projection_id: z.string().min(1),
  operation_id: z.string().min(1),
  decision_id: z.string().min(1),
  evaluated_at: z.string().min(1),
  user_visible_action_kind: CompanionUserVisibleActionKindSchema,
  next_best_safe_action: z.string().min(1),
  brief_reason: z.string().min(1).optional(),
  hidden_reason_refs: z.array(z.string().min(1)).default([]),
  surface_expression_policy: CompanionSurfaceExpressionPolicySchema,
  prepared_artifact_refs: z.array(z.string().min(1)).default([]),
  approval_request_ref: z.string().min(1).optional(),
  audit_refs: z.array(z.string().min(1)).default([]),
  alternative_action_refs: z.array(z.string().min(1)).default([]),
  executes_operation: z.boolean(),
  metadata: z.object({
    autonomy_level: z.string().min(1),
    normal_capability_catalog_suppressed: z.boolean(),
    raw_policy_state_suppressed: z.boolean(),
  }).strict(),
}).strict();
export type CompanionActionProjection = z.infer<typeof CompanionActionProjectionSchema>;

export const CompanionUserFacingPolicyProjectionSchema = z.object({
  schema_version: z.literal("companion-user-facing-policy-projection/v1"),
  evaluated_at: z.string().min(1),
  user_visible_action_kind: CompanionUserVisibleActionKindSchema,
  next_best_safe_action: z.string().min(1),
  brief_reason: z.string().min(1).optional(),
  executes_operation: z.boolean(),
}).strict();
export type CompanionUserFacingPolicyProjection = z.infer<typeof CompanionUserFacingPolicyProjectionSchema>;

type ParsedProjectionInput = z.infer<typeof CompanionActionProjectionInputSchema>;

export function projectCompanionAction(input: CompanionActionProjectionInput): CompanionActionProjection {
  const parsed = CompanionActionProjectionInputSchema.parse(input);
  const evaluatedAt = parsed.evaluated_at ?? new Date().toISOString();
  const actionKind = actionKindFor(parsed);
  const surfacePolicy = surfacePolicyFor(parsed.context);

  return CompanionActionProjectionSchema.parse({
    schema_version: "companion-action-projection/v1",
    projection_id: parsed.projection_id ?? projectionId(parsed.decision.decision_id, parsed.context.surface_ref, evaluatedAt),
    operation_id: parsed.decision.operation_id,
    decision_id: parsed.decision.decision_id,
    evaluated_at: evaluatedAt,
    user_visible_action_kind: actionKind,
    next_best_safe_action: nextBestSafeActionFor(actionKind, parsed),
    ...briefReasonPart(actionKind, parsed, surfacePolicy),
    hidden_reason_refs: hiddenReasonRefs(parsed.decision),
    surface_expression_policy: surfacePolicy,
    prepared_artifact_refs: parsed.prepared_artifact_refs,
    ...(parsed.approval_request_ref ? { approval_request_ref: parsed.approval_request_ref } : {}),
    audit_refs: auditRefsFor(parsed.decision),
    alternative_action_refs: parsed.alternative_action_refs,
    executes_operation: actionKind === "execute_now",
    metadata: {
      autonomy_level: parsed.decision.level,
      normal_capability_catalog_suppressed: parsed.context.surface_kind === "normal_companion",
      raw_policy_state_suppressed: parsed.context.surface_kind === "normal_companion",
    },
  });
}

export function projectCompanionUserFacingPolicy(
  input: CompanionActionProjectionInput
): CompanionUserFacingPolicyProjection {
  return toCompanionUserFacingPolicyProjection(projectCompanionAction(input));
}

export function toCompanionUserFacingPolicyProjection(
  input: CompanionActionProjection
): CompanionUserFacingPolicyProjection {
  const projection = CompanionActionProjectionSchema.parse(input);
  const policy = projection.surface_expression_policy;
  if (
    policy.surface_kind !== "normal_companion"
    || policy.user_visible_reason === "operator_detail"
    || policy.hidden_reasons_visible
    || policy.capability_catalog_visible
    || policy.raw_policy_state_visible
  ) {
    throw new Error("CompanionActionProjection is not safe for a normal companion surface.");
  }

  return CompanionUserFacingPolicyProjectionSchema.parse({
    schema_version: "companion-user-facing-policy-projection/v1",
    evaluated_at: projection.evaluated_at,
    user_visible_action_kind: projection.user_visible_action_kind,
    next_best_safe_action: projection.next_best_safe_action,
    ...(policy.user_visible_reason === "brief" && projection.brief_reason
      ? { brief_reason: projection.brief_reason }
      : {}),
    executes_operation: projection.executes_operation,
  });
}

function actionKindFor(input: ParsedProjectionInput): CompanionUserVisibleActionKind {
  if (input.context.quieted || input.decision.suppression_reason) {
    return input.context.digest_later_allowed ? "digest_later" : "stay_silent";
  }
  switch (input.decision.level) {
    case "advisory":
      return "suggest";
    case "prepare_only":
      return input.prepared_artifact_refs.length > 0 ? "prepare_draft" : "suggest";
    case "user_directed_execute":
    case "autonomous_low_risk":
      return "execute_now";
    case "approval_required":
      return input.approval_request_ref ? "ask_for_approval" : "prepare_draft";
    case "prohibited":
      return "refuse_with_alternative";
  }
}

function nextBestSafeActionFor(
  actionKind: CompanionUserVisibleActionKind,
  input: ParsedProjectionInput
): string {
  switch (actionKind) {
    case "stay_silent":
      return "Stay silent on the normal surface.";
    case "digest_later":
      return "Hold this for a later digest.";
    case "suggest":
      return "Suggest a safe next step without executing.";
    case "prepare_draft":
      return "Prepare an inspectable draft without executing the operation.";
    case "ask_for_approval":
      return "Ask for explicit approval before executing the prepared operation.";
    case "execute_now":
      return input.decision.level === "user_directed_execute"
        ? "Run the requested operation now."
        : "Run the safe background operation now.";
    case "challenge":
      return "Challenge the request and ask for clarification.";
    case "refuse_with_alternative":
      return input.alternative_action_refs.length > 0
        ? "Refuse the blocked operation and offer the prepared safe alternative."
        : "Refuse the blocked operation and offer a safe alternative.";
  }
}

function briefReasonPart(
  actionKind: CompanionUserVisibleActionKind,
  input: ParsedProjectionInput,
  policy: CompanionSurfaceExpressionPolicy
): { brief_reason?: string } {
  if (policy.user_visible_reason === "none") return {};
  if (policy.user_visible_reason === "operator_detail") {
    return { brief_reason: `Projected from autonomy decision ${input.decision.decision_id}.` };
  }
  switch (actionKind) {
    case "ask_for_approval":
    case "prepare_draft":
      return { brief_reason: "Approval is needed before this can run." };
    case "refuse_with_alternative":
      return { brief_reason: "That route is blocked, so I will offer a safer alternative." };
    case "digest_later":
      return { brief_reason: "This should wait for a less disruptive surface." };
    case "stay_silent":
      return {};
    case "execute_now":
      return {
        brief_reason: input.decision.level === "user_directed_execute"
          ? "This requested action is safe to run now."
          : "This background action is safe to run now.",
      };
    case "suggest":
      return { brief_reason: "A safe suggestion is available." };
    case "challenge":
      return { brief_reason: "More clarity is needed before acting." };
  }
}

function surfacePolicyFor(context: CompanionProjectionContext): CompanionSurfaceExpressionPolicy {
  const hiddenVisible = context.surface_kind !== "normal_companion";
  return CompanionSurfaceExpressionPolicySchema.parse({
    surface_kind: context.surface_kind,
    user_visible_reason: context.quieted
      ? "none"
      : context.surface_kind === "normal_companion"
        ? "brief"
        : "operator_detail",
    hidden_reasons_visible: hiddenVisible,
    capability_catalog_visible: context.surface_kind !== "normal_companion",
    raw_policy_state_visible: context.surface_kind !== "normal_companion",
  });
}

function hiddenReasonRefs(decision: AutonomyDecision): string[] {
  return unique([
    decision.decision_id,
    decision.metadata.admission_evaluation_ref,
    ...decision.metadata.readiness_refs,
    ...decision.audit_refs,
    ...decision.invalidation_bindings.map((binding) => binding.ref),
  ]);
}

function auditRefsFor(decision: AutonomyDecision): string[] {
  return unique([
    decision.decision_id,
    ...decision.audit_refs,
  ]);
}

function projectionId(decisionId: string, surfaceRef: string, evaluatedAt: string): string {
  return `companion-action:${decisionId}:${surfaceRef}:${evaluatedAt}`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}
