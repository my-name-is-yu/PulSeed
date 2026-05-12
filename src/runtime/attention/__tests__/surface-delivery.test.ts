import { describe, expect, it } from "vitest";
import {
  projectSurfaceDelivery,
  ref,
  renderSurfaceDeliveryProjection,
} from "../index.js";
import { renderTuiExpressionDecision } from "../../../interface/tui/fullscreen-chat-render.js";
import { renderGatewayExpressionDecision } from "../../gateway/index.js";
import {
  ExpressionDecisionSchema,
  OutcomeDecisionSchema,
  VisibilityPolicySchema,
  type ExpressionDecision,
  type ExpressionSurfaceClass,
  type OutcomeClass,
  type OutcomeDecision,
  type SurfaceFacingOutcomeClass,
  type VisibilityPolicy,
} from "../../types/companion-autonomy.js";
import type { CompanionActionProjection } from "../../control/index.js";

const NOW = "2026-05-12T00:00:00.000Z";

function outcome(finalOutcome: OutcomeClass): OutcomeDecision {
  return OutcomeDecisionSchema.parse({
    outcome_decision_id: `outcome:${finalOutcome}`,
    initiative_decision_ref: ref("initiative_gate_decision", `gate:${finalOutcome}`),
    decided_at: NOW,
    requested_outcome: finalOutcome,
    admission_status: "admitted",
    final_outcome: finalOutcome,
    visibility_policy_ref: ref("visibility_policy", `visibility:${finalOutcome}`),
    audit_ref: ref("audit_trace", `audit:${finalOutcome}`),
  });
}

function outcomeWithExpressionRef(
  finalOutcome: SurfaceFacingOutcomeClass,
  expressionId: string,
): OutcomeDecision {
  return OutcomeDecisionSchema.parse({
    ...outcome(finalOutcome),
    expression_decision_ref: ref("expression_decision", expressionId),
  });
}

function expression(
  outcomeClass: SurfaceFacingOutcomeClass,
  targetSurfaceClasses: readonly ExpressionSurfaceClass[] = ["gateway", "tui"],
  input: {
    expressionId?: string;
    outcomeId?: string;
  } = {},
): ExpressionDecision {
  return ExpressionDecisionSchema.parse({
    expression_decision_id: input.expressionId ?? `expression:${outcomeClass}`,
    outcome_decision_ref: ref("outcome_decision", input.outcomeId ?? `outcome:${outcomeClass}`),
    outcome_class: outcomeClass,
    created_at: NOW,
    expression_mode: outcomeClass === "request_approval"
      ? "approval_request"
      : outcomeClass === "add_to_digest"
        ? "digest_item"
        : outcomeClass === "escalate"
          ? "urgent_alert"
          : "direct_message",
    target_surface_classes: [...targetSurfaceClasses],
    visibility_policy_ref: ref("visibility_policy", `visibility:${outcomeClass}`),
    user_facing_rationale: `rendered ${outcomeClass}`,
    audit_ref: ref("audit_trace", `audit:expression:${outcomeClass}`),
  });
}

function visibilityPolicy(input: {
  id: string;
  outcomeId: string;
  expressionId: string;
  digestOnly?: boolean;
}): VisibilityPolicy {
  return VisibilityPolicySchema.parse({
    schema_version: "visibility-policy-v1",
    visibility_policy_id: input.id,
    applies_to: [
      ref("outcome_decision", input.outcomeId),
      ref("expression_decision", input.expressionId),
    ],
    hidden_by_default: false,
    visible_in_gui: true,
    visible_in_chat: input.digestOnly ? false : true,
    visible_in_tui: input.digestOnly ? false : true,
    visible_in_cli: false,
    visible_in_audit: true,
    visible_in_debug: true,
    digest_only: input.digestOnly ?? false,
    visible_in_digest: input.digestOnly ?? false,
    never_directly_show: false,
    content_lifecycle: "active",
    redaction_required: false,
    raw_content_allowed: false,
    rationale: "test visibility policy",
    audit_refs: [],
  });
}

function companionProjection(input: {
  kind: CompanionActionProjection["user_visible_action_kind"];
  decisionId?: string;
  operationId?: string;
  executesOperation?: boolean;
}): CompanionActionProjection {
  const decisionId = input.decisionId ?? `autonomy:${input.kind}`;
  const operationId = input.operationId ?? `operation:${input.kind}`;
  return {
    schema_version: "companion-action-projection/v1",
    projection_id: `companion-action:${input.kind}`,
    operation_id: operationId,
    decision_id: decisionId,
    evaluated_at: NOW,
    user_visible_action_kind: input.kind,
    next_best_safe_action: `next ${input.kind}`,
    surface_expression_policy: {
      surface_kind: "normal_companion",
      user_visible_reason: "brief",
      hidden_reasons_visible: false,
      capability_catalog_visible: false,
      raw_policy_state_visible: false,
    },
    hidden_reason_refs: [],
    prepared_artifact_refs: [],
    audit_refs: [],
    alternative_action_refs: [],
    executes_operation: input.executesOperation ?? input.kind === "execute_now",
    metadata: {
      autonomy_level: "advisory",
      normal_capability_catalog_suppressed: true,
      raw_policy_state_suppressed: true,
    },
  };
}

describe("surface delivery projection", () => {
  it("renders TUI, gateway, and Telegram-shaped gateway text from the same admitted projection", () => {
    const admitted = outcome("express_to_user");
    const activeExpression = expression("express_to_user", ["gateway", "tui"]);
    const policy = visibilityPolicy({
      id: "visibility:express_to_user",
      outcomeId: "outcome:express_to_user",
      expressionId: "expression:express_to_user",
    });

    const gatewayDelivery = projectSurfaceDelivery({
      renderId: "render:gateway:express",
      renderedAt: NOW,
      surfaceClass: "gateway",
      outcomeDecision: admitted,
      expressionDecision: activeExpression,
      visibilityPolicy: policy,
      companionActionProjection: companionProjection({ kind: "suggest", executesOperation: false }),
    });

    expect(gatewayDelivery).toMatchObject({
      delivery_kind: "express_to_user",
      delivery_mode: "body_message",
      outcome_decision_ref: ref("outcome_decision", "outcome:express_to_user"),
      expression_decision_ref: ref("expression_decision", "expression:express_to_user"),
      should_render: true,
      user_facing_text: "rendered express_to_user",
    });
    expect(renderSurfaceDeliveryProjection(gatewayDelivery)).toBe("rendered express_to_user");
    expect(renderGatewayExpressionDecision({
      renderId: "render:telegram-shaped:express",
      renderedAt: NOW,
      surfaceClass: "gateway",
      outcomeDecision: admitted,
      expressionDecision: activeExpression,
      visibilityPolicy: policy,
    })).toBe("rendered express_to_user");
    expect(renderTuiExpressionDecision({
      renderId: "render:tui:express",
      renderedAt: NOW,
      surfaceClass: "tui",
      outcomeDecision: admitted,
      expressionDecision: activeExpression,
      visibilityPolicy: policy,
    })).toMatchObject({
      key: "surface-delivery:render:tui:express",
      text: "rendered express_to_user",
      protected: true,
    });
  });

  it("supports approval and digest delivery without creating a second surface policy path", () => {
    const approval = projectSurfaceDelivery({
      renderId: "render:approval",
      renderedAt: NOW,
      surfaceClass: "gateway",
      outcomeDecision: outcome("request_approval"),
      expressionDecision: expression("request_approval", ["gateway"]),
      visibilityPolicy: visibilityPolicy({
        id: "visibility:request_approval",
        outcomeId: "outcome:request_approval",
        expressionId: "expression:request_approval",
      }),
      companionActionProjection: companionProjection({ kind: "ask_for_approval" }),
    });

    expect(approval).toMatchObject({
      delivery_kind: "request_approval",
      delivery_mode: "approval_request",
      companion_action_projection_id: "companion-action:ask_for_approval",
      should_render: true,
      user_facing_text: "rendered request_approval",
    });

    const digestExpression = expression("add_to_digest", ["digest"]);
    const digestPolicy = visibilityPolicy({
      id: "visibility:add_to_digest",
      outcomeId: "outcome:add_to_digest",
      expressionId: "expression:add_to_digest",
      digestOnly: true,
    });
    const hiddenOnGateway = projectSurfaceDelivery({
      renderId: "render:gateway:digest",
      renderedAt: NOW,
      surfaceClass: "gateway",
      outcomeDecision: outcome("add_to_digest"),
      expressionDecision: digestExpression,
      visibilityPolicy: digestPolicy,
      companionActionProjection: companionProjection({ kind: "digest_later", executesOperation: false }),
    });
    const visibleInDigest = projectSurfaceDelivery({
      renderId: "render:digest",
      renderedAt: NOW,
      surfaceClass: "digest",
      outcomeDecision: outcome("add_to_digest"),
      expressionDecision: digestExpression,
      visibilityPolicy: digestPolicy,
      companionActionProjection: companionProjection({ kind: "digest_later", executesOperation: false }),
    });

    expect(hiddenOnGateway).toMatchObject({
      delivery_kind: "add_to_digest",
      delivery_mode: "digest_item",
      should_render: false,
      quiet_audit_reason: "surface delivery is hidden by the admitted visibility policy",
    });
    expect(visibleInDigest).toMatchObject({
      delivery_kind: "add_to_digest",
      delivery_mode: "digest_item",
      should_render: true,
      user_facing_text: "rendered add_to_digest",
    });
  });

  it("allows request approval delivery while the approval artifact is still a prepared draft", () => {
    const delivery = projectSurfaceDelivery({
      renderId: "render:approval-draft",
      renderedAt: NOW,
      surfaceClass: "gateway",
      outcomeDecision: outcome("request_approval"),
      expressionDecision: expression("request_approval", ["gateway"]),
      visibilityPolicy: visibilityPolicy({
        id: "visibility:request_approval",
        outcomeId: "outcome:request_approval",
        expressionId: "expression:request_approval",
      }),
      companionActionProjection: companionProjection({ kind: "prepare_draft", executesOperation: false }),
    });

    expect(delivery).toMatchObject({
      delivery_kind: "request_approval",
      delivery_mode: "approval_request",
      companion_action_projection_id: "companion-action:prepare_draft",
      should_render: true,
      user_facing_text: "rendered request_approval",
    });
  });

  it("rejects stale ExpressionDecision records that are not selected by the OutcomeDecision", () => {
    const selectedOutcome = outcomeWithExpressionRef("express_to_user", "expression:new");
    const staleExpression = expression("express_to_user", ["gateway"], {
      expressionId: "expression:old",
    });
    const policy = visibilityPolicy({
      id: "visibility:express_to_user",
      outcomeId: "outcome:express_to_user",
      expressionId: "expression:old",
    });

    const delivery = projectSurfaceDelivery({
      renderId: "render:stale-expression",
      renderedAt: NOW,
      surfaceClass: "gateway",
      outcomeDecision: selectedOutcome,
      expressionDecision: staleExpression,
      visibilityPolicy: policy,
    });

    expect(delivery).toMatchObject({
      should_render: false,
      expression_decision_ref: ref("expression_decision", "expression:old"),
      quiet_audit_reason: "surface delivery rejected a stale ExpressionDecision not selected by OutcomeDecision",
    });
    expect(renderGatewayExpressionDecision({
      renderId: "render:stale-expression:gateway",
      renderedAt: NOW,
      surfaceClass: "gateway",
      outcomeDecision: selectedOutcome,
      expressionDecision: staleExpression,
      visibilityPolicy: policy,
    })).toBeNull();
  });

  it("keeps quiet outcomes auditable without speaking, notifying, or preparing a parallel expression", () => {
    for (const finalOutcome of ["prepare_silently", "keep_watching", "silence"] as const) {
      const delivery = projectSurfaceDelivery({
        renderId: `render:${finalOutcome}`,
        renderedAt: NOW,
        surfaceClass: "gateway",
        outcomeDecision: outcome(finalOutcome),
        companionActionProjection: companionProjection({ kind: "stay_silent", executesOperation: false }),
      });
      expect(delivery).toMatchObject({
        delivery_kind: finalOutcome,
        outcome_decision_ref: ref("outcome_decision", `outcome:${finalOutcome}`),
        should_render: false,
      });
      expect(renderSurfaceDeliveryProjection(delivery)).toBeNull();
      expect(delivery?.quiet_audit_reason).toBeTruthy();
    }
  });

  it("fails closed when quiet outcomes carry a contradictory CompanionActionProjection", () => {
    for (const finalOutcome of ["prepare_silently", "keep_watching", "silence"] as const) {
      expect(() => projectSurfaceDelivery({
        renderId: `render:${finalOutcome}:contradiction`,
        renderedAt: NOW,
        surfaceClass: "gateway",
        outcomeDecision: outcome(finalOutcome),
        companionActionProjection: companionProjection({ kind: "execute_now", executesOperation: true }),
      })).toThrow(/incompatible/);
    }
  });

  it("fails closed when express or escalation delivery carries approval-style action semantics", () => {
    for (const finalOutcome of ["express_to_user", "escalate"] as const) {
      for (const projectionKind of ["ask_for_approval", "prepare_draft"] as const) {
        expect(() => projectSurfaceDelivery({
          renderId: `render:${finalOutcome}:${projectionKind}`,
          renderedAt: NOW,
          surfaceClass: "gateway",
          outcomeDecision: outcome(finalOutcome),
          expressionDecision: expression(finalOutcome, ["gateway"]),
          visibilityPolicy: visibilityPolicy({
            id: `visibility:${finalOutcome}`,
            outcomeId: `outcome:${finalOutcome}`,
            expressionId: `expression:${finalOutcome}`,
          }),
          companionActionProjection: companionProjection({
            kind: projectionKind,
            executesOperation: false,
          }),
        })).toThrow(/incompatible/);
      }
    }
  });

  it("fails closed when CompanionActionProjection would contradict the admitted outcome delivery", () => {
    expect(() => projectSurfaceDelivery({
      renderId: "render:contradiction",
      renderedAt: NOW,
      surfaceClass: "gateway",
      outcomeDecision: outcome("express_to_user"),
      expressionDecision: expression("express_to_user", ["gateway"]),
      visibilityPolicy: visibilityPolicy({
        id: "visibility:express_to_user",
        outcomeId: "outcome:express_to_user",
        expressionId: "expression:express_to_user",
      }),
      companionActionProjection: companionProjection({ kind: "stay_silent", executesOperation: false }),
    })).toThrow(/incompatible/);
  });
});
