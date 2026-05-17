import { describe, expect, it } from "vitest";
import {
  CompanionCognitionInputSchema,
  CompanionCognitionOutputSchema,
  type CognitionEventRef,
} from "../../src/runtime/cognition/index.js";

function runtimeControlRef(): CognitionEventRef {
  return {
    ref: "runtime-control:reload_config:confirm_required",
    source_store: "runtime_operation",
    source_event_type: "runtime_control_response",
    schema_version: 1,
    source_epoch: "reload_config",
    replay_key: "runtime-control:reload_config:confirm_required",
    redaction_policy: "metadata_only",
  };
}

describe("CompanionCognitionKernel contract", () => {
  it("requires runtime-control callers to carry runtime context and matching memory-request caller path", () => {
    const eventRef = runtimeControlRef();
    const validInput = {
      cognition_id: "cognition:runtime-control:contract",
      caller_path: "runtime_control_response" as const,
      event_refs: [eventRef],
      working_context: {
        input_ref: eventRef,
        route_ref: { kind: "runtime_control", ref: "reload_config" },
        hidden_prompt_content_materialized: false,
      },
      runtime_context: {
        runtime_item_refs: [{ kind: "runtime_control_intent", ref: "reload_config" }],
        approval_refs: [{ kind: "approval", ref: "runtime-control:reload_config" }],
        active_control_state_refs: [{ kind: "runtime_control_decision", ref: "confirm_required" }],
        phase_ref: { kind: "runtime_control_phase", ref: "confirm_required" },
      },
      memory_context_request: {
        request_id: "memory-request:runtime-control:contract",
        requested_uses: ["runtime_grounding" as const],
        caller_path: "runtime_control_response" as const,
        query_ref: eventRef,
        surface_projection_required: true,
        side_effect_authorization_allowed: false,
        include_sensitive_content: false,
      },
      surface_target: "internal_audit" as const,
    };

    expect(() => CompanionCognitionInputSchema.parse(validInput)).not.toThrow();
    expect(() => CompanionCognitionInputSchema.parse({
      ...validInput,
      runtime_context: undefined,
    })).toThrow(/runtime-control cognition input requires runtime_context/);
    expect(() => CompanionCognitionInputSchema.parse({
      ...validInput,
      memory_context_request: {
        ...validInput.memory_context_request,
        caller_path: "chat_user_turn",
      },
    })).toThrow(/memory request caller path must match cognition caller path/);
  });

  it("rejects normal-surface outputs that expose operator debug refs", () => {
    const eventRef = runtimeControlRef();

    expect(() => CompanionCognitionOutputSchema.parse({
      cognition_id: "cognition:normal-surface:contract",
      caller_path: "runtime_control_response",
      situation_model: {
        situation_id: "cognition:normal-surface:contract:situation",
        summary_ref: eventRef,
        caller_path: "runtime_control_response",
        current_target_refs: [],
        stale_target_refs: [],
        protocol_bypass: false,
        confidence: 0.82,
      },
      relationship_state: {
        projection_id: "cognition:normal-surface:contract:relationship",
        included: [],
        withheld: [],
        posture: "neutral",
        relationship_refs: [],
        withheld_memory_refs: [],
        conflict_refs: [],
        overreach_risk: "unknown",
        normal_surface_debug_visible: false,
        ordinary_surface_debug_visible: false,
      },
      selected_intention: null,
      candidate_action: {
        action_id: "cognition:normal-surface:contract:candidate-action",
        action_kind: "request_authority",
        side_effect_profile: "runtime_mutation",
        requires_authority: true,
        executes_side_effect: false,
      },
      response_plan: {
        plan_id: "cognition:normal-surface:contract:response",
        guidance_kind: "request_approval",
        public_summary: "Ask the authority owner before any mutation.",
        surface_target: "normal_user",
        quieting_applied: false,
        operator_debug_refs: [{ kind: "approval", ref: "runtime-control:reload_config" }],
        hidden_policy_state_visible_to_normal_user: false,
      },
      tool_candidates: [],
      authorization_requests: [],
      memory_writeback: [],
      reflection_hints: [],
      audit_refs: [],
      uncertainty: [],
    })).toThrow(/normal user surface cannot receive operator debug refs/);
  });
});
