import { describe, expect, it } from "vitest";
import {
  AuthorizationRequestSchema,
  CloudBoundaryEvaluationSchema,
  CloudComputeRequestSchema,
  CognitionEventRefSchema,
  CompanionCognitionOutputSchema,
  IntentionSelectionSchema,
  ToolCandidateSchema,
  createCloudComputeAuthorizationRequest,
  evaluateCloudBoundaryForCognition,
} from "../index.js";

const NOW = "2026-05-14T00:00:00.000Z";

function eventRef(ref = "event:1") {
  return CognitionEventRefSchema.parse({
    ref,
    source_store: "chat_history",
    source_event_type: "user_input",
    schema_version: 1,
    source_epoch: "turn:1",
    redaction_policy: "metadata_only",
  });
}

describe("Companion cognition contracts", () => {
  it("requires store-qualified event refs with replay or epoch information", () => {
    expect(() => CognitionEventRefSchema.parse({
      ref: "chat:1",
      source_store: "chat_history",
      source_event_type: "user_input",
      schema_version: 1,
      redaction_policy: "metadata_only",
    })).toThrow(/source_epoch/);
  });

  it("separates executable substrate from initiation authority", () => {
    const candidate = ToolCandidateSchema.parse({
      candidate_id: "candidate:read-workspace",
      authority_stage: "prepare",
      expected_effect: "Prepare a workspace search plan.",
      risk_class: "low",
      can_execute: true,
      may_execute: false,
      memory_is_authority: false,
      model_text_is_authority: false,
    });

    expect(candidate.can_execute).toBe(true);
    expect(candidate.may_execute).toBe(false);
    expect(() => ToolCandidateSchema.parse({
      ...candidate,
      authority_stage: "execute",
      required_authorization_refs: [],
    })).toThrow(/authorization refs/);
  });

  it("keeps resident proactive cognition from creating execute-stage authority", () => {
    expect(() => CompanionCognitionOutputSchema.parse({
      cognition_id: "cognition:resident:1",
      caller_path: "resident_proactive_check",
      situation_model: {
        situation_id: "situation:1",
        summary_ref: eventRef(),
        caller_path: "resident_proactive_check",
        current_target_refs: [],
        stale_target_refs: [],
        protocol_bypass: false,
        confidence: 0.7,
      },
      relationship_state: {
        projection_id: "relationship:1",
        relationship_refs: [],
        withheld_memory_refs: [],
        conflict_refs: [],
        overreach_risk: "medium",
        ordinary_surface_debug_visible: false,
      },
      selected_intention: null,
      response_plan: {
        plan_id: "response:1",
        guidance_kind: "suggest",
        public_summary: "Suggest only.",
        surface_target: "internal_audit",
        delivery_kind: "suggest",
        quieting_applied: false,
        hidden_policy_state_visible_to_normal_user: false,
      },
      tool_candidates: [{
        candidate_id: "candidate:execute",
        authority_stage: "execute",
        expected_effect: "Execute something.",
        risk_class: "high",
        required_authorization_refs: [{ kind: "approval", ref: "approval:1" }],
        can_execute: true,
        may_execute: false,
        memory_is_authority: false,
        model_text_is_authority: false,
      }],
      authorization_requests: [],
      memory_writeback: [],
      reflection_hints: [],
      audit_refs: [],
      uncertainty: [],
    })).toThrow(/resident proactive cognition/);
  });

  it("forces stale intentions into regrounding lifecycle", () => {
    expect(() => IntentionSelectionSchema.parse({
      intention_id: "intention:stale",
      lifecycle: "selected",
      requires_regrounding: false,
      stale_target_refs: [{ kind: "run", ref: "run:previous" }],
      reason_refs: [eventRef()],
    })).toThrow(/stale target refs require/);

    expect(IntentionSelectionSchema.parse({
      intention_id: "intention:stale",
      lifecycle: "requires_regrounding",
      requires_regrounding: true,
      stale_target_refs: [{ kind: "run", ref: "run:previous" }],
      reason_refs: [eventRef()],
    }).lifecycle).toBe("requires_regrounding");
  });

  it("treats cloud compute as an authorization-bearing external service request", () => {
    const cloud = CloudComputeRequestSchema.parse({
      request_id: "cloud:1",
      provider_ref: "openai:responses",
      surface_projection_ref: "surface:allowed",
      redaction_refs: [{ kind: "redaction", ref: "redaction:1" }],
      privacy_profile: "external_service",
      admission_evaluation_ref: { kind: "admission", ref: "admission:1" },
      autonomy_evaluation_ref: { kind: "autonomy", ref: "autonomy:1" },
      model_visible_context_refs: [eventRef()],
    });
    const request = createCloudComputeAuthorizationRequest({
      requestId: "auth:cloud:1",
      requestFingerprint: "fingerprint:cloud:1",
      originRef: eventRef(),
      targetEpoch: "target:v1",
      payloadEpoch: "payload:v1",
      expiresAt: NOW,
      cloudComputeRequest: cloud,
    });

    expect(AuthorizationRequestSchema.parse(request)).toMatchObject({
      kind: "cloud_compute_request",
      side_effect_profile: "cloud_compute",
      privacy_profile: "external_service",
    });
  });

  it("blocks model-visible cognition context in local-only mode", () => {
    const blocked = evaluateCloudBoundaryForCognition({
      evaluationId: "cloud-boundary:local-only",
      mode: "local_only",
      contextRefs: [eventRef("memory:private-context")],
    });

    expect(blocked).toMatchObject({
      external_service_context_allowed: false,
      model_visible_context_refs: [],
      runtime_authority: false,
      memory_authority: false,
    });
    expect(() => CloudBoundaryEvaluationSchema.parse({
      ...blocked,
      external_service_context_allowed: true,
    })).toThrow(/local-only cognition/);
  });

  it("requires redaction, admission, and autonomy refs before cloud-visible context leaves local cognition", () => {
    const cloud = CloudComputeRequestSchema.parse({
      request_id: "cloud:admitted",
      provider_ref: "openai:responses",
      surface_projection_ref: "surface:redacted",
      redaction_refs: [{ kind: "redaction", ref: "redaction:private-context" }],
      privacy_profile: "external_service",
      admission_evaluation_ref: { kind: "admission", ref: "admission:cloud" },
      autonomy_evaluation_ref: { kind: "autonomy", ref: "autonomy:cloud" },
      model_visible_context_refs: [eventRef("memory:private-context")],
    });

    const allowed = evaluateCloudBoundaryForCognition({
      evaluationId: "cloud-boundary:gated",
      mode: "gated_external_service",
      contextRefs: [eventRef("memory:private-context")],
      cloudComputeRequest: cloud,
    });

    expect(allowed.external_service_context_allowed).toBe(true);
    expect(allowed.model_visible_context_refs).toHaveLength(1);
    expect(() => CloudBoundaryEvaluationSchema.parse({
      ...allowed,
      redaction_refs: [],
    })).toThrow(/redaction refs/);
  });
});
