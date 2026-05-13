import { describe, expect, it } from "vitest";
import { CoreCompanionMemoryProjectionSchema } from "../../decision/core-companion-memory-projection.js";
import { CompanionCognitionService } from "../companion-cognition-service.js";
import { cognitionMemoryResultFromCoreProjection } from "../memory-context.js";
import type { CompanionCognitionInput } from "../contracts.js";

const NOW = "2026-05-14T00:00:00.000Z";

describe("cognition memory context", () => {
  it("converts governed core memory projections without turning withheld memory into model-visible content", async () => {
    const projection = CoreCompanionMemoryProjectionSchema.parse({
      schema_version: "core-companion-memory-projection/v1",
      projection_id: "core-memory:cognition-memory-test",
      created_at: NOW,
      caller_path: "chat_gateway_model_loop",
      source_refs: [{
        kind: "surface_projection",
        ref: "surface:cognition-memory-test",
      }],
      surface_ref: "surface:cognition-memory-test",
      requested_use: "runtime_grounding",
      included_entries: [{
        entry_id: "core-memory-entry:current",
        lane: "relationship",
        source_ref: memorySource("memory:current"),
        content: {
          state: "available",
          excerpt: "Use the current corrected preference.",
        },
        use_policy: {
          remembered: true,
          usable: true,
          speakable: false,
          actionable: false,
          inhibition_only: false,
          planning_only: true,
          forbidden: false,
          memory_is_runtime_authority: false,
          required_confirmation: "none",
          requested_use: "runtime_grounding",
          allowed_use_classes: ["runtime_grounding", "surface_projection"],
          blocked_use_classes: ["side_effect_authorization"],
        },
        source_projection_ref: "surface:cognition-memory-test",
        audit_refs: ["audit:memory:current"],
      }],
      restricted_entries: [{
        entry_id: "core-memory-restricted:sensitive",
        source_ref: memorySource("memory:sensitive", { sensitivity: "sensitive" }),
        requested_use: "runtime_grounding",
        restriction_reasons: ["sensitive"],
        content: {
          state: "withheld",
          redaction_ref: "redaction:memory:sensitive",
          reason_refs: ["policy:sensitive"],
        },
        use_policy: {
          remembered: true,
          usable: false,
          speakable: false,
          actionable: false,
          inhibition_only: false,
          planning_only: false,
          forbidden: true,
          memory_is_runtime_authority: false,
          required_confirmation: "none",
          requested_use: "runtime_grounding",
          allowed_use_classes: [],
          blocked_use_classes: ["runtime_grounding"],
        },
        source_projection_ref: "surface:cognition-memory-test",
        audit_refs: ["audit:memory:sensitive"],
      }],
      ordinary_surface_policy: {},
      summary: {
        included_count: 1,
        restricted_count: 1,
        remembered_count: 2,
        usable_count: 1,
        speakable_count: 0,
        actionable_count: 0,
        inhibition_only_count: 0,
        planning_only_count: 1,
        forbidden_count: 1,
      },
    });

    const result = cognitionMemoryResultFromCoreProjection({
      requestId: "memory-request:chat:1",
      projection,
      requestedUse: "runtime_grounding",
    });

    expect(result).toMatchObject({
      model_visible_without_cloud_gate: false,
      included: [{
        memory_ref: {
          ref: "memory:current",
          source_store: "profile",
        },
        lifecycle: "active",
        correction_state: "current",
        excerpt: "Use the current corrected preference.",
      }],
      withheld: [{
        memory_ref: {
          ref: "memory:sensitive",
        },
        withheld_reason: "sensitive",
        sensitivity: "sensitive",
      }],
    });
    expect(JSON.stringify(result.withheld)).not.toContain("sensitive-secret");

    const cognition = await new CompanionCognitionService({
      memoryPort: {
        retrieveMemory: async () => result,
      },
    }).evaluateTurn(chatInput({ memory_result: undefined }));
    expect(cognition.relationship_state.relationship_refs).toHaveLength(1);
    expect(cognition.relationship_state.withheld_memory_refs).toHaveLength(1);
    expect(cognition.uncertainty.map((item) => item.kind)).toContain("missing_surface");
  });
});

function chatInput(overrides: Partial<CompanionCognitionInput> = {}): CompanionCognitionInput {
  const ref = {
    ref: "chat:event:1",
    source_store: "chat_history" as const,
    source_event_type: "user_input",
    schema_version: 1,
    source_epoch: "turn:1",
    redaction_policy: "metadata_only" as const,
  };
  return {
    cognition_id: "cognition:chat:memory-test",
    caller_path: "chat_user_turn",
    event_refs: [ref],
    working_context: {
      input_ref: ref,
      route_ref: { kind: "chat_route", ref: "gateway_model_loop" },
      hidden_prompt_content_materialized: false,
    },
    session_context: {
      session_ref: { kind: "chat_session", ref: "session:1" },
      turn_ref: { kind: "chat_turn", ref: "turn:1" },
      route_kind: "gateway_model_loop",
      runtime_control_allowed: true,
      approval_mode: "interactive",
      quieting_active: false,
      stale_reply_target_refs: [],
    },
    memory_context_request: {
      request_id: "memory-request:chat:1",
      requested_uses: ["runtime_grounding"],
      caller_path: "chat_user_turn",
      query_ref: ref,
      surface_projection_required: true,
      side_effect_authorization_allowed: false,
      include_sensitive_content: false,
    },
    surface_target: "internal_audit",
    ...overrides,
  };
}

function memorySource(memoryId: string, overrides: Record<string, unknown> = {}) {
  const sensitivity = typeof overrides["sensitivity"] === "string" ? overrides["sensitivity"] : "private";
  return {
    memory_id: memoryId,
    owning_store_ref: {
      kind: "relationship_profile",
      store_ref: "relationship-profile:cognition-test",
      record_ref: memoryId,
    },
    role: "relationship",
    record_kind: "preference",
    domain_fields: {
      target: "cognition memory test",
      preference: memoryId === "memory:sensitive" ? "sensitive-secret" : "current preference",
      confidence: 0.9,
      scope: "PulSeed",
      allowed_uses: ["runtime_grounding"],
      review_condition: "current only",
    },
    allowed_uses: ["runtime_grounding", "surface_projection"],
    not_allowed_uses: ["side_effect_authorization"],
    lifecycle: "active",
    correction_state: "current",
    superseded_by_memory_id: null,
    sensitivity,
    content_state: "materialized",
    dependency_ref: {
      kind: "memory_record",
      ref: memoryId,
      owning_store_ref: {
        kind: "relationship_profile",
        store_ref: "relationship-profile:cognition-test",
        record_ref: memoryId,
      },
      content_state: "materialized",
      lifecycle: "active",
      correction_state: "current",
      superseded_by_memory_id: null,
    },
  };
}
