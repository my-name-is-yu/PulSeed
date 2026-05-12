import { z } from "zod";
import {
  CompanionActionProjectionSchema,
  type CompanionActionProjection,
} from "../control/companion-action-projection.js";
import {
  CompanionAutonomyRefSchema,
  ExpressionDecisionSchema,
  ExpressionSurfaceClassSchema,
  OutcomeAdmissionStatusSchema,
  OutcomeDecisionSchema,
  VisibilityPolicySchema,
  type CompanionAutonomyRef,
  type ExpressionDecision,
  type ExpressionSurfaceClass,
  type OutcomeDecision,
  type VisibilityPolicy,
} from "../types/companion-autonomy.js";
import {
  ref,
  renderExpressionDecisionForSurface,
} from "./attention-metabolism.js";

export const SurfaceDeliveryKindSchema = z.enum([
  "express_to_user",
  "request_approval",
  "add_to_digest",
  "prepare_silently",
  "keep_watching",
  "silence",
  "escalate",
]);
export type SurfaceDeliveryKind = z.infer<typeof SurfaceDeliveryKindSchema>;

export const SurfaceDeliveryModeSchema = z.enum([
  "body_message",
  "approval_request",
  "digest_item",
  "silent_preparation",
  "watch_status",
  "quiet_audit",
  "urgent_alert",
]);
export type SurfaceDeliveryMode = z.infer<typeof SurfaceDeliveryModeSchema>;

export const SurfaceDeliveryProjectionSchema = z.object({
  schema_version: z.literal("surface-delivery-projection-v1"),
  delivery_id: z.string().min(1),
  rendered_at: z.string().datetime(),
  surface_class: ExpressionSurfaceClassSchema,
  delivery_kind: SurfaceDeliveryKindSchema,
  delivery_mode: SurfaceDeliveryModeSchema,
  outcome_decision_ref: CompanionAutonomyRefSchema,
  expression_decision_ref: CompanionAutonomyRefSchema.optional(),
  companion_action_projection_id: z.string().min(1).optional(),
  visibility_policy_ref: CompanionAutonomyRefSchema.optional(),
  admission_status: OutcomeAdmissionStatusSchema,
  should_render: z.boolean(),
  user_facing_text: z.string().min(1).optional(),
  quiet_audit_reason: z.string().min(1).optional(),
  audit_refs: z.array(CompanionAutonomyRefSchema).default([]),
}).strict().superRefine((projection, ctx) => {
  if (projection.should_render && !projection.user_facing_text) {
    ctx.addIssue({
      code: "custom",
      path: ["user_facing_text"],
      message: "rendered surface delivery requires user_facing_text",
    });
  }
  if (!projection.should_render && !projection.quiet_audit_reason) {
    ctx.addIssue({
      code: "custom",
      path: ["quiet_audit_reason"],
      message: "quiet surface delivery requires a quiet_audit_reason",
    });
  }
});
export type SurfaceDeliveryProjection = z.infer<typeof SurfaceDeliveryProjectionSchema>;

export interface SurfaceDeliveryProjectionInput {
  readonly deliveryId?: string;
  readonly renderId: string;
  readonly renderedAt: string;
  readonly surfaceClass: ExpressionSurfaceClass;
  readonly outcomeDecision: OutcomeDecision;
  readonly expressionDecision?: ExpressionDecision | null;
  readonly visibilityPolicy?: VisibilityPolicy | null;
  readonly companionActionProjection?: CompanionActionProjection | null;
  readonly auditRef?: CompanionAutonomyRef;
}

export function projectSurfaceDelivery(input: SurfaceDeliveryProjectionInput): SurfaceDeliveryProjection | null {
  const outcome = OutcomeDecisionSchema.parse(input.outcomeDecision);
  if (!isAdmittedOutcome(outcome)) return null;
  if (!outcome.final_outcome) return null;

  const deliveryKind = deliveryKindForOutcome(outcome.final_outcome);
  if (!deliveryKind) return null;
  const actionProjection = input.companionActionProjection
    ? CompanionActionProjectionSchema.parse(input.companionActionProjection)
    : null;
  assertCompanionProjectionCompatible(deliveryKind, actionProjection);

  const base = {
    schema_version: "surface-delivery-projection-v1" as const,
    delivery_id: input.deliveryId ?? `surface-delivery:${input.renderId}`,
    rendered_at: input.renderedAt,
    surface_class: input.surfaceClass,
    delivery_kind: deliveryKind,
    delivery_mode: deliveryModeForKind(deliveryKind),
    outcome_decision_ref: ref("outcome_decision", outcome.outcome_decision_id),
    ...(actionProjection
      ? { companion_action_projection_id: actionProjection.projection_id }
      : {}),
    ...(outcome.visibility_policy_ref ? { visibility_policy_ref: outcome.visibility_policy_ref } : {}),
    admission_status: outcome.admission_status,
    audit_refs: auditRefsFor(input, outcome),
  };

  if (isQuietDeliveryKind(deliveryKind)) {
    return SurfaceDeliveryProjectionSchema.parse({
      ...base,
      should_render: false,
      quiet_audit_reason: quietReasonForKind(deliveryKind),
    });
  }

  const expression = input.expressionDecision
    ? ExpressionDecisionSchema.parse(input.expressionDecision)
    : null;
  const policy = input.visibilityPolicy ? VisibilityPolicySchema.parse(input.visibilityPolicy) : null;
  if (!expression || !policy) {
    return SurfaceDeliveryProjectionSchema.parse({
      ...base,
      should_render: false,
      quiet_audit_reason: "surface delivery is waiting for an active ExpressionDecision and VisibilityPolicy",
    });
  }

  if (
    outcome.expression_decision_ref &&
    expression.expression_decision_id !== outcome.expression_decision_ref.id
  ) {
    return SurfaceDeliveryProjectionSchema.parse({
      ...base,
      expression_decision_ref: ref("expression_decision", expression.expression_decision_id),
      should_render: false,
      quiet_audit_reason: "surface delivery rejected a stale ExpressionDecision not selected by OutcomeDecision",
    });
  }
  const rendered = renderExpressionDecisionForSurface({
    render_id: input.renderId,
    rendered_at: input.renderedAt,
    surface_class: input.surfaceClass,
    outcome_decision: outcome,
    expression_decision: expression,
    visibility_policy: policy,
    audit_ref: input.auditRef,
  });
  if (!rendered) {
    return SurfaceDeliveryProjectionSchema.parse({
      ...base,
      expression_decision_ref: ref("expression_decision", expression.expression_decision_id),
      should_render: false,
      quiet_audit_reason: "surface delivery is hidden by the admitted visibility policy",
    });
  }

  return SurfaceDeliveryProjectionSchema.parse({
    ...base,
    expression_decision_ref: rendered.expression_decision_ref,
    visibility_policy_ref: rendered.visibility_policy_ref,
    should_render: true,
    user_facing_text: rendered.user_facing_rationale,
  });
}

export function renderSurfaceDeliveryProjection(
  projection: SurfaceDeliveryProjection | null | undefined,
): string | null {
  if (!projection?.should_render) return null;
  return projection.user_facing_text ?? null;
}

function isAdmittedOutcome(outcome: OutcomeDecision): boolean {
  return outcome.admission_status === "admitted" || outcome.admission_status === "downgraded";
}

function deliveryKindForOutcome(outcome: OutcomeDecision["final_outcome"]): SurfaceDeliveryKind | null {
  switch (outcome) {
    case "express_to_user":
    case "request_approval":
    case "add_to_digest":
    case "prepare_silently":
    case "keep_watching":
    case "silence":
    case "escalate":
      return outcome;
    case "hold_in_agenda":
      return "keep_watching";
    case "prepare_action_candidate":
      return "prepare_silently";
    case "run_authorized_work":
    case "delegate_bounded_work":
    case "write_governed_memory_candidate":
    case "update_surface_candidate":
      return null;
    case undefined:
      return null;
  }
}

function deliveryModeForKind(kind: SurfaceDeliveryKind): SurfaceDeliveryMode {
  switch (kind) {
    case "express_to_user":
      return "body_message";
    case "request_approval":
      return "approval_request";
    case "add_to_digest":
      return "digest_item";
    case "prepare_silently":
      return "silent_preparation";
    case "keep_watching":
      return "watch_status";
    case "silence":
      return "quiet_audit";
    case "escalate":
      return "urgent_alert";
  }
}

function isQuietDeliveryKind(kind: SurfaceDeliveryKind): kind is Extract<SurfaceDeliveryKind, "prepare_silently" | "keep_watching" | "silence"> {
  return kind === "prepare_silently" || kind === "keep_watching" || kind === "silence";
}

function quietReasonForKind(kind: Extract<SurfaceDeliveryKind, "prepare_silently" | "keep_watching" | "silence">): string {
  switch (kind) {
    case "prepare_silently":
      return "admitted outcome prepares quietly without notifying or speaking";
    case "keep_watching":
      return "admitted outcome keeps watching without starting user-visible work";
    case "silence":
      return "admitted outcome intentionally stays silent";
  }
}

function auditRefsFor(
  input: SurfaceDeliveryProjectionInput,
  outcome: OutcomeDecision,
): CompanionAutonomyRef[] {
  const refs = [
    outcome.audit_ref,
    input.auditRef,
    ...(input.expressionDecision?.audit_ref ? [input.expressionDecision.audit_ref] : []),
  ].filter((item): item is CompanionAutonomyRef => item !== undefined);
  return [...new Map(refs.map((item) => [`${item.kind}:${item.id}:${item.version ?? ""}`, item])).values()];
}

function assertCompanionProjectionCompatible(
  deliveryKind: SurfaceDeliveryKind,
  projection: CompanionActionProjection | null,
): void {
  if (!projection) return;
  if (projection.executes_operation) {
    throw new Error(
      `CompanionActionProjection ${projection.projection_id} is side-effecting and cannot be used for ${deliveryKind} surface delivery`,
    );
  }
  const kind = projection.user_visible_action_kind;
  const compatible = (() => {
    switch (deliveryKind) {
      case "request_approval":
        return kind === "ask_for_approval" || kind === "prepare_draft";
      case "add_to_digest":
        return kind === "digest_later";
      case "prepare_silently":
        return kind === "prepare_draft" || kind === "stay_silent" || kind === "digest_later";
      case "keep_watching":
      case "silence":
        return kind === "stay_silent" || kind === "digest_later";
      case "express_to_user":
      case "escalate":
        return kind === "suggest" || kind === "challenge" || kind === "refuse_with_alternative";
    }
  })();
  if (!compatible) {
    throw new Error(
      `CompanionActionProjection ${projection.projection_id} is incompatible with ${deliveryKind} surface delivery`,
    );
  }
}
