import { describe, expect, it } from "vitest";
import {
  AuthorizationRequestSchema,
  CloudBoundaryEvaluationSchema,
  CloudComputeRequestSchema,
  CognitionMemoryResultSchema,
  CognitionMemorySourceSchema,
  CognitionEventRefSchema,
  CompanionCognitionOutputSchema,
  IntentionSelectionSchema,
  ToolCandidateSchema,
  classifyCognitionMemorySourceForCloud,
  createCloudComputeAuthorizationRequest,
  evaluateCloudBoundaryForCognition,
} from "../index.js";

const NOW = "2026-05-14T00:00:00.000Z";

function eventRef(ref = "event:1", sourceEpoch = "turn:1") {
  return CognitionEventRefSchema.parse({
    ref,
    source_store: "chat_history",
    source_event_type: "user_input",
    schema_version: 1,
    source_epoch: sourceEpoch,
    redaction_policy: "metadata_only",
  });
}

function memoryRef(ref = "memory:1", sourceEpoch = "memory:1") {
  return CognitionEventRefSchema.parse({
    ref,
    source_store: "profile",
    source_event_type: "preference",
    schema_version: 1,
    source_epoch: sourceEpoch,
    redaction_policy: "metadata_only",
  });
}

function cloudRequest(input: {
  requestId?: string;
  purpose?: "chat_reply" | "tool_reasoning" | "research" | "summarization" | "embedding" | "classification";
  contextRefs?: ReturnType<typeof eventRef>[];
  externalToolPayloadRefs?: Array<{ kind: string; ref: string }>;
  grants?: Array<Record<string, unknown>>;
  targetEpoch?: string;
  payloadEpoch?: string;
  payloadFingerprint?: string;
  providerPolicyRef?: { kind: string; ref: string };
  dispatchNonceRef?: { kind: string; ref: string };
  invalidationRefs?: Array<{ kind: string; ref: string }>;
  expiresAt?: string;
} = {}) {
  const purpose = input.purpose ?? "chat_reply";
  const contextRefs = input.contextRefs ?? [eventRef()];
  return CloudComputeRequestSchema.parse({
    request_id: input.requestId ?? "cloud:1",
    provider_ref: "openai:responses",
    provider_policy_ref: input.providerPolicyRef ?? { kind: "provider_policy", ref: "provider-policy:openai:2026-05-14" },
    purpose,
    surface_projection_ref: "surface:allowed",
    redaction_refs: [{ kind: "redaction", ref: "redaction:1" }],
    privacy_profile: "external_service",
    admission_evaluation_ref: { kind: "admission", ref: "admission:1" },
    autonomy_evaluation_ref: { kind: "autonomy", ref: "autonomy:1" },
    payload_fingerprint: input.payloadFingerprint ?? "payload:fingerprint:1",
    dispatch_nonce_ref: input.dispatchNonceRef ?? { kind: "dispatch_nonce", ref: "nonce:1" },
    target_epoch: input.targetEpoch ?? "target:v1",
    payload_epoch: input.payloadEpoch ?? "payload:v1",
    admitted_ref_versions: contextRefs.map((ref) => ({
      ref,
      lifecycle: "active",
      correction_state: "current",
      source_epoch: ref.source_epoch ?? ref.high_watermark ?? ref.replay_key ?? "source:unknown",
    })),
    model_visible_context_refs: contextRefs,
    external_tool_payload_refs: input.externalToolPayloadRefs ?? [],
    external_data_scope_grants: input.grants ?? [
      ...contextRefs.map((ref) => ({
        grant_ref: { kind: "data_scope_grant", ref: `grant:${ref.ref}` },
        use: "external_model_context",
        purpose,
        context_ref: ref,
      })),
      ...(input.externalToolPayloadRefs ?? []).map((payloadRef) => ({
        grant_ref: { kind: "data_scope_grant", ref: `grant:${payloadRef.ref}` },
        use: "external_tool_payload",
        purpose,
        payload_ref: payloadRef,
      })),
    ],
    invalidation_refs: input.invalidationRefs ?? [{ kind: "memory_invalidation", ref: "invalidation:1" }],
    retention_expectation: "zero_retention_contract",
    user_visible_summary: "Send the approved redacted summary to the configured model provider.",
    expires_at: input.expiresAt ?? "2099-01-01T00:00:00.000Z",
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
    const cloud = cloudRequest({ expiresAt: NOW });
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
    expect(request.fail_closed_validation_refs).toEqual(expect.arrayContaining([
      { kind: "cloud_provider_policy", ref: "provider-policy:openai:2026-05-14" },
      { kind: "cloud_dispatch_nonce", ref: "nonce:1" },
    ]));
  });

  it("matches cloud authorization expiration by instant instead of raw string", () => {
    const cloud = cloudRequest({ expiresAt: "2026-05-14T00:00:00.000Z" });

    expect(createCloudComputeAuthorizationRequest({
      requestId: "auth:cloud:instant-match",
      requestFingerprint: "fingerprint:cloud:instant-match",
      originRef: eventRef(),
      targetEpoch: "target:v1",
      payloadEpoch: "payload:v1",
      expiresAt: "2026-05-14T00:00:00Z",
      cloudComputeRequest: cloud,
    }).expires_at).toBe("2026-05-14T00:00:00Z");
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
    const approvedContext = eventRef("memory:private-context", "turn:approved");
    const sameRefUnapprovedEpochContext = eventRef("memory:private-context", "turn:unapproved");
    const unapprovedContext = eventRef("memory:unapproved-context");
    const cloud = cloudRequest({
      requestId: "cloud:admitted",
      contextRefs: [approvedContext],
    });

    const allowed = evaluateCloudBoundaryForCognition({
      evaluationId: "cloud-boundary:gated",
      mode: "gated_external_service",
      contextRefs: [sameRefUnapprovedEpochContext, approvedContext, unapprovedContext],
      cloudComputeRequest: cloud,
    });

    expect(allowed.external_service_context_allowed).toBe(true);
    expect(allowed.model_visible_context_refs).toEqual([approvedContext]);
    expect(() => CloudBoundaryEvaluationSchema.parse({
      ...allowed,
      redaction_refs: [],
    })).toThrow(/redaction refs/);
  });

  it("blocks private model context until an explicit purpose-bound external data scope grant exists", () => {
    const privateContext = memoryRef("memory:private-context", "memory:private");
    expect(() => cloudRequest({
      requestId: "cloud:no-grant",
      contextRefs: [privateContext],
      grants: [],
    })).toThrow(/external_model_context grant/);

    const cloud = cloudRequest({
      requestId: "cloud:with-grant",
      contextRefs: [privateContext],
    });
    const allowed = evaluateCloudBoundaryForCognition({
      evaluationId: "cloud-boundary:private-with-grant",
      mode: "gated_external_service",
      contextRefs: [privateContext],
      memorySources: [{
        memory_ref: privateContext,
        source_kind: "episodic",
        allowed_uses: ["user_facing_reference"],
        forbidden_uses: [],
        sensitivity: "private",
        lifecycle: "active",
        correction_state: "current",
        surface_projection_ref: "surface:private-summary",
        excerpt: "A redacted private summary.",
      }],
      cloudComputeRequest: cloud,
    });

    expect(allowed).toMatchObject({
      external_service_context_allowed: true,
      model_visible_context_refs: [privateContext],
      admitted_context_refs: [privateContext],
      retention_expectation: "zero_retention_contract",
    });
    const missingMetadata = evaluateCloudBoundaryForCognition({
      evaluationId: "cloud-boundary:private-missing-metadata",
      mode: "gated_external_service",
      contextRefs: [privateContext],
      cloudComputeRequest: cloud,
    });

    expect(missingMetadata).toMatchObject({
      external_service_context_allowed: false,
      blocked_context_refs: [{ ref: privateContext, reason: "missing_memory_source_metadata" }],
    });
    expect(CognitionMemoryResultSchema.parse({
      request_id: "memory-result:cloud-gate",
      included: [],
      withheld: [],
      audit_refs: [],
    }).model_visible_without_cloud_gate).toBe(false);
  });

  it("does not admit sensitive, redacted, deleted, tombstoned, superseded, or corrected memory refs", () => {
    const refs = {
      sensitive: eventRef("memory:sensitive", "turn:sensitive"),
      redacted: eventRef("memory:redacted", "turn:redacted"),
      deleted: eventRef("memory:deleted", "turn:deleted"),
      tombstoned: eventRef("memory:tombstoned", "turn:tombstoned"),
      superseded: eventRef("memory:superseded", "turn:superseded"),
      corrected: eventRef("memory:corrected", "turn:corrected"),
    };
    const memorySources = [
      { ref: refs.sensitive, sensitivity: "sensitive", lifecycle: "active", correction_state: "current" },
      { ref: refs.redacted, sensitivity: "redacted", lifecycle: "active", correction_state: "current" },
      { ref: refs.deleted, sensitivity: "private", lifecycle: "deleted", correction_state: "current" },
      { ref: refs.tombstoned, sensitivity: "private", lifecycle: "retracted", correction_state: "current" },
      { ref: refs.superseded, sensitivity: "private", lifecycle: "superseded", correction_state: "current" },
      { ref: refs.corrected, sensitivity: "private", lifecycle: "active", correction_state: "corrected" },
    ].map((source) => CognitionMemorySourceSchema.parse({
      memory_ref: source.ref,
      source_kind: "episodic",
      allowed_uses: ["user_facing_reference"],
      forbidden_uses: [],
      sensitivity: source.sensitivity,
      lifecycle: source.lifecycle,
      correction_state: source.correction_state,
      surface_projection_ref: `surface:${source.ref.ref}`,
      excerpt: "Redacted summary.",
    }));
    const contextRefs = Object.values(refs);
    const cloud = cloudRequest({
      requestId: "cloud:block-unsafe-memory",
      contextRefs,
    });
    const blocked = evaluateCloudBoundaryForCognition({
      evaluationId: "cloud-boundary:block-unsafe-memory",
      mode: "gated_external_service",
      contextRefs,
      memorySources,
      cloudComputeRequest: cloud,
    });

    expect(blocked.external_service_context_allowed).toBe(false);
    expect(blocked.model_visible_context_refs).toEqual([]);
    expect(blocked.blocked_context_refs.map((ref) => ref.reason)).toEqual([
      "sensitive_memory_blocked",
      "redacted_memory_blocked",
      "deleted_memory_blocked",
      "tombstoned_memory_blocked",
      "superseded_memory_blocked",
      "corrected_memory_blocked",
    ]);
    expect(classifyCognitionMemorySourceForCloud(memorySources[0]!)).toMatchObject({
      cloud_visible: false,
      blocked_reason: "sensitive_memory_blocked",
    });
  });

  it("rejects previously admitted cloud payloads after policy, target, payload, nonce, or invalidation drift", () => {
    const context = eventRef("memory:admitted", "turn:admitted");
    const cloud = cloudRequest({
      requestId: "cloud:stale-rejection",
      contextRefs: [context],
    });
    const cases = [
      {
        name: "provider_policy_changed",
        input: { currentProviderPolicyRef: { kind: "provider_policy", ref: "provider-policy:new" } },
      },
      {
        name: "target_epoch_changed",
        input: { currentTargetEpoch: "target:v2" },
      },
      {
        name: "payload_fingerprint_changed",
        input: { currentPayloadFingerprint: "payload:fingerprint:2" },
      },
      {
        name: "dispatch_nonce_reused",
        input: { usedDispatchNonceRefs: [{ kind: "dispatch_nonce", ref: "nonce:1" }] },
      },
      {
        name: "payload_invalidated",
        input: { currentInvalidationRefs: [{ kind: "memory_invalidation", ref: "invalidation:1" }] },
      },
      {
        name: "payload_invalidated",
        cloudRequest: cloudRequest({
          requestId: "cloud:stale-rejection:new-invalidation",
          contextRefs: [context],
          invalidationRefs: [],
        }),
        input: { currentInvalidationRefs: [{ kind: "memory_invalidation", ref: "invalidation:new-after-request" }] },
      },
      {
        name: "cloud_request_expired",
        input: { evaluatedAt: "2099-01-01T00:00:00.001Z" },
      },
    ];

    for (const testCase of cases) {
      const blocked = evaluateCloudBoundaryForCognition({
        evaluationId: `cloud-boundary:${testCase.name}`,
        mode: "gated_external_service",
        contextRefs: [context],
        cloudComputeRequest: testCase.cloudRequest ?? cloud,
        ...testCase.input,
      });
      expect(blocked.external_service_context_allowed).toBe(false);
      expect(blocked.blocked_reason).toContain(testCase.name);
    }
  });

  it("requires explicit purpose-bound data scope before external tool payload transfer", () => {
    const payloadRef = { kind: "external_tool_payload", ref: "payload:mcp-calendar-read" };
    expect(() => cloudRequest({
      requestId: "cloud:external-tool:no-grant",
      purpose: "tool_reasoning",
      externalToolPayloadRefs: [payloadRef],
      grants: [{
        grant_ref: { kind: "data_scope_grant", ref: "grant:wrong-use" },
        use: "external_model_context",
        purpose: "tool_reasoning",
        context_ref: eventRef(),
      }],
    })).toThrow(/external_tool_payload grant/);

    expect(cloudRequest({
      requestId: "cloud:external-tool:with-grant",
      purpose: "tool_reasoning",
      externalToolPayloadRefs: [payloadRef],
    }).external_tool_payload_refs).toEqual([payloadRef]);
  });
});
