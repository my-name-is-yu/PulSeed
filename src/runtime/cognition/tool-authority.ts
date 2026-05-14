import type { CompanionGadgetPlan } from "../decision/companion-gadget-planning.js";
import {
  AuthorizationRequestSchema,
  CloudComputeRequestSchema,
  ToolCandidateSchema,
  type AuthorizationRequest,
  type CloudComputeRequest,
  type CognitionEventRef,
  type ToolCandidate,
} from "./contracts.js";

export function toolCandidateFromGadgetPlan(input: {
  candidateId: string;
  plan: CompanionGadgetPlan;
  originRef: CognitionEventRef;
  authorizationRefs?: Array<{ kind: string; ref: string }>;
}): ToolCandidate {
  const action = input.plan.action_candidates[0];
  return ToolCandidateSchema.parse({
    candidate_id: input.candidateId,
    capability_ref: input.plan.candidate.capability_id
      ? { kind: "capability", ref: input.plan.candidate.capability_id }
      : undefined,
    tool_ref: input.plan.candidate.tool_name
      ? { kind: "tool", ref: input.plan.candidate.tool_name }
      : undefined,
    authority_stage: action?.requires_approval ? "suggest" : input.plan.candidate.can_execute ? "prepare" : "suggest",
    expected_effect: input.plan.operation_plan_candidate.user_visible_summary,
    risk_class: riskClassForGadgetPlan(input.plan),
    required_context_refs: [input.originRef],
    required_authorization_refs: input.authorizationRefs ?? [],
    can_execute: input.plan.candidate.can_execute,
    may_execute: false,
    observability_refs: input.plan.audit_refs.map((ref) => ({ kind: "audit", ref })),
    failure_recovery_refs: [],
    failed_trace_requires_repair: false,
    memory_is_authority: false,
    model_text_is_authority: false,
  });
}

export function createCloudComputeAuthorizationRequest(input: {
  requestId: string;
  requestFingerprint: string;
  originRef: CognitionEventRef;
  targetEpoch: string;
  payloadEpoch: string;
  expiresAt: string;
  cloudComputeRequest: CloudComputeRequest;
}): AuthorizationRequest {
  const cloudComputeRequest = CloudComputeRequestSchema.parse(input.cloudComputeRequest);
  if (cloudComputeRequest.target_epoch !== input.targetEpoch) {
    throw new Error("cloud compute authorization target epoch does not match cloud boundary request");
  }
  if (cloudComputeRequest.payload_epoch !== input.payloadEpoch) {
    throw new Error("cloud compute authorization payload epoch does not match cloud boundary request");
  }
  if (cloudComputeRequest.expires_at !== input.expiresAt) {
    throw new Error("cloud compute authorization expiration does not match cloud boundary request");
  }
  return AuthorizationRequestSchema.parse({
    kind: "cloud_compute_request",
    request_id: input.requestId,
    cloud_compute_request: cloudComputeRequest,
    request_fingerprint: input.requestFingerprint,
    origin_ref: input.originRef,
    target_epoch: input.targetEpoch,
    payload_epoch: input.payloadEpoch,
    expires_at: input.expiresAt,
    side_effect_profile: "cloud_compute",
    privacy_profile: "external_service",
    fail_closed_validation_refs: [
      { kind: "admission_evaluation", ref: input.cloudComputeRequest.admission_evaluation_ref.ref },
      { kind: "autonomy_evaluation", ref: input.cloudComputeRequest.autonomy_evaluation_ref.ref },
      { kind: "cloud_provider_policy", ref: input.cloudComputeRequest.provider_policy_ref.ref },
      { kind: "cloud_dispatch_nonce", ref: input.cloudComputeRequest.dispatch_nonce_ref.ref },
    ],
  });
}

function riskClassForGadgetPlan(plan: CompanionGadgetPlan): ToolCandidate["risk_class"] {
  const sideEffect = plan.candidate.side_effect_profile;
  if (sideEffect === "none") return "none";
  if (sideEffect === "read") return "low";
  if (sideEffect === "send" || sideEffect === "publish") return "external_side_effect";
  if (sideEffect === "write" || sideEffect === "delete" || sideEffect === "mutate") return "high";
  return "medium";
}
