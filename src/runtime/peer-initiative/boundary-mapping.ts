import { createHash } from "node:crypto";
import {
  createProactivePolicyState,
  decideProactiveThreshold,
  type ProactiveThresholdDecision,
} from "../attention/proactive-policy.js";
import { projectCompanionAction } from "../control/companion-action-projection.js";
import type { ResidentOperationBoundaryResult } from "../capability-operation-planner.js";
import type { ResidentAttentionAdmission } from "../daemon/resident-attention-orchestrator.js";
import type { CognitionRef, PrivacyProfile, SideEffectProfile } from "../cognition/index.js";
import {
  PeerInitiativeBoundaryMappingSchema,
  type PeerInitiativeBoundaryMapping,
  type PeerInitiativeCandidate,
} from "./contracts.js";

export interface PeerInitiativeBoundaryMappingInput {
  candidate: PeerInitiativeCandidate;
  attentionAdmission: ResidentAttentionAdmission;
  operationBoundary?: ResidentOperationBoundaryResult;
  now: string;
  quietingActive?: boolean;
}

export interface PeerInitiativeBoundaryMappingResult {
  mapping: PeerInitiativeBoundaryMapping;
  thresholdDecision: ProactiveThresholdDecision;
  companionActionProjectionId?: string;
  shouldRender: boolean;
}

export function mapPeerInitiativeBoundary(
  input: PeerInitiativeBoundaryMappingInput
): PeerInitiativeBoundaryMappingResult {
  const operationCandidate = input.operationBoundary?.assembly.candidate_plans[0];
  const candidateRef = cognitionRef("peer_initiative", input.candidate.candidate_id);
  const artifactRef = preparedArtifactRef(input.candidate);
  const thresholdDecision = decideProactiveThreshold({
    state: createProactivePolicyState({
      policyId: `peer-initiative:${input.candidate.candidate_id}`,
      now: input.now,
      maxDeliveryKind: input.candidate.max_delivery_kind,
    }),
    candidateCreatedAt: input.candidate.created_at,
    thresholdInput: {
      candidate_ref: candidateRef,
      expected_user_value: expectedUserValue(input.candidate),
      interruption_cost: interruptionCost(input.candidate),
      urgency: input.candidate.max_delivery_kind === "notify" ? "high" : "low",
      confidence: input.candidate.confidence,
      reversibility: input.candidate.action_plan.mode === "permissioned_external_action" ? "moderate" : "easy",
      operation_boundary: operationBoundaryStatus(input.operationBoundary),
      side_effect_profile: thresholdSideEffectProfile(input.candidate),
      privacy_profile: thresholdPrivacyProfile(input.candidate),
      recent_feedback_refs: [],
      channel_budget_ref: cognitionRef("proactive_budget", "peer-initiative-default"),
      quieting_active: input.quietingActive ?? false,
      stale_target_refs: [],
      downstream_authorization_refs: [],
      ...(requiresDecision(input.candidate) ? { requires_user_decision_ref: candidateRef } : {}),
      ...(input.candidate.action_plan.mode === "permissioned_external_action"
        ? { requires_approval_ref: candidateRef }
        : {}),
      ...(artifactRef ? { prepared_artifact_ref: cognitionRef("prepared_artifact", artifactRef) } : {}),
      requested_delivery_kind: requestedDeliveryKind(input.candidate),
    },
  });

  const companionActionProjection = input.operationBoundary?.autonomy_decision
    ? projectCompanionAction({
        decision: input.operationBoundary.autonomy_decision,
        context: {
          surface_ref: "surface:resident-peer-initiative",
          surface_kind: "normal_companion",
          quieted: thresholdDecision.allowed_delivery_kind === "hold",
        },
        prepared_artifact_refs: artifactRef ? [artifactRef] : [],
        ...(input.candidate.action_plan.mode === "permissioned_external_action"
          ? { approval_request_ref: `approval:peer-initiative:${input.candidate.candidate_id}` }
          : {}),
        evaluated_at: input.now,
      })
    : undefined;

  const projectedKind = companionActionProjection?.user_visible_action_kind;
  const companionActionProjectionId = companionActionProjection?.projection_id;
  if (companionActionProjection?.executes_operation) {
    return {
      mapping: PeerInitiativeBoundaryMappingSchema.parse({
        mapping_id: mappingId(input.candidate.candidate_id, thresholdDecision.allowed_delivery_kind),
        action_plan_ref: `${input.candidate.candidate_id}:action_plan`,
        ...(operationCandidate ? { autonomy_operation_plan_ref: operationCandidate.operation_plan.operation_id } : {}),
        ...(input.operationBoundary?.admission_evaluation
          ? { admission_evaluation_ref: input.operationBoundary.admission_evaluation.evaluation_id }
          : {}),
        ...(input.operationBoundary?.autonomy_decision
          ? { autonomy_decision_ref: input.operationBoundary.autonomy_decision.decision_id }
          : {}),
        proactive_threshold_decision_ref: thresholdDecisionId(input.candidate.candidate_id, thresholdDecision),
        outcome_decision_ref: input.attentionAdmission.outcome_decision_id,
        companion_action_projection_ref: companionActionProjectionId,
        mapped_boundary: "held_by_threshold",
      }),
      thresholdDecision,
      companionActionProjectionId,
      shouldRender: false,
    };
  }

  const mappedBoundary = mappedBoundaryFor(input.candidate, thresholdDecision, projectedKind);
  return {
    mapping: PeerInitiativeBoundaryMappingSchema.parse({
      mapping_id: mappingId(input.candidate.candidate_id, thresholdDecision.allowed_delivery_kind),
      action_plan_ref: `${input.candidate.candidate_id}:action_plan`,
      ...(operationCandidate ? { autonomy_operation_plan_ref: operationCandidate.operation_plan.operation_id } : {}),
      ...(input.operationBoundary?.admission_evaluation
        ? { admission_evaluation_ref: input.operationBoundary.admission_evaluation.evaluation_id }
        : {}),
      ...(input.operationBoundary?.autonomy_decision
        ? { autonomy_decision_ref: input.operationBoundary.autonomy_decision.decision_id }
        : {}),
      proactive_threshold_decision_ref: thresholdDecisionId(input.candidate.candidate_id, thresholdDecision),
      outcome_decision_ref: input.attentionAdmission.outcome_decision_id,
      ...(companionActionProjectionId ? { companion_action_projection_ref: companionActionProjectionId } : {}),
      mapped_boundary: mappedBoundary,
    }),
    thresholdDecision,
    companionActionProjectionId,
    shouldRender: thresholdDecision.allowed_delivery_kind !== "hold"
      && mappedBoundary !== "held_by_threshold",
  };
}

function requestedDeliveryKind(candidate: PeerInitiativeCandidate) {
  if (candidate.action_plan.mode === "internal_preparation") return "prepare" as const;
  if (candidate.action_plan.mode === "permissioned_external_action") return "speak" as const;
  return candidate.max_delivery_kind;
}

function requiresDecision(candidate: PeerInitiativeCandidate): boolean {
  return candidate.action_plan.mode === "permissioned_external_action"
    || (candidate.action_plan.mode === "contextual_capability_disclosure" && candidate.action_plan.permission_required);
}

function preparedArtifactRef(candidate: PeerInitiativeCandidate): string | undefined {
  const plan = candidate.action_plan;
  if (plan.mode === "internal_preparation") return plan.prepared_artifact_ref;
  if (plan.mode === "permissioned_external_action") return plan.prepared_artifact_ref;
  return undefined;
}

function operationBoundaryStatus(boundary: ResidentOperationBoundaryResult | undefined) {
  if (!boundary) return "allowed" as const;
  if (boundary.preparation_allowed) return "allowed" as const;
  if (boundary.assembly.status === "planned") return "held" as const;
  if (boundary.assembly.status === "fail_closed") return "blocked" as const;
  return "unavailable" as const;
}

function thresholdSideEffectProfile(candidate: PeerInitiativeCandidate): SideEffectProfile {
  switch (candidate.action_plan.mode) {
    case "care_only":
    case "contextual_capability_disclosure":
      return "read";
    case "internal_preparation":
      return "local_write";
    case "permissioned_external_action":
      return "external_write";
  }
}

function thresholdPrivacyProfile(candidate: PeerInitiativeCandidate): PrivacyProfile {
  return candidate.action_plan.mode === "permissioned_external_action"
    ? "external_service"
    : "local_only";
}

function expectedUserValue(candidate: PeerInitiativeCandidate): number {
  const care = score(candidate.worthiness.care_value, ["none", "low", "medium", "high"]);
  const attention = score(candidate.worthiness.attention_fit, ["none", "weak", "medium", "strong"]);
  const helpful = score(candidate.worthiness.concrete_helpfulness, ["none", "low", "medium", "high"]);
  return Math.min(1, (care + attention + helpful) / 9);
}

function interruptionCost(candidate: PeerInitiativeCandidate): number {
  const load = score(candidate.worthiness.user_cognitive_load, ["none", "low", "medium", "high"]);
  const reply = candidate.worthiness.reply_pressure === "strong" ? 3 : candidate.worthiness.reply_pressure === "soft" ? 1 : 0;
  return Math.min(1, (load + reply) / 6);
}

function score(value: string, order: readonly string[]): number {
  const index = order.indexOf(value);
  return index < 0 ? 0 : index;
}

function mappedBoundaryFor(
  candidate: PeerInitiativeCandidate,
  decision: ProactiveThresholdDecision,
  projectedKind?: string,
): PeerInitiativeBoundaryMapping["mapped_boundary"] {
  if (decision.allowed_delivery_kind === "hold") return "held_by_threshold";
  switch (candidate.action_plan.mode) {
    case "care_only":
      return "care_suggest";
    case "internal_preparation":
      return projectedKind === "prepare_draft" ? "attention_prepare_draft" : "held_by_threshold";
    case "permissioned_external_action":
      return projectedKind === "ask_for_approval" || projectedKind === "prepare_draft"
        ? "permission_request"
        : "held_by_threshold";
    case "contextual_capability_disclosure":
      if (candidate.action_plan.permission_required) return "capability_ask_for_approval";
      return projectedKind === "prepare_draft" ? "capability_prepare_draft" : "capability_suggest";
  }
}

function thresholdDecisionId(candidateId: string, decision: ProactiveThresholdDecision): string {
  return `peer-threshold:${stableToken(`${candidateId}:${decision.allowed_delivery_kind}:${decision.display_delivery_kind}`)}`;
}

function mappingId(candidateId: string, deliveryKind: string): string {
  return `peer-boundary:${stableToken(`${candidateId}:${deliveryKind}`)}`;
}

function cognitionRef(kind: string, ref: string): CognitionRef {
  return { kind, ref };
}

function stableToken(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
