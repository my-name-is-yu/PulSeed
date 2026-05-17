import { describe, expect, it } from "vitest";
import {
  CompanionCognitionKernel,
  CompanionCognitionService,
  InMemoryCognitionAuditSink,
  createEmptyCognitionMemoryResult,
  createReflectionInputFromCognitionReplay,
  type CompanionCognitionInput,
} from "../index.js";

const NOW = "2026-05-14T00:00:00.000Z";

function eventRef(ref = "chat:event:1") {
  return {
    ref,
    source_store: "chat_history" as const,
    source_event_type: "user_input",
    schema_version: 1,
    source_epoch: "turn:1",
    redaction_policy: "metadata_only" as const,
  };
}

function scheduleEventRef(ref = "schedule:entry:1") {
  return {
    ref,
    source_store: "schedule" as const,
    source_event_type: "schedule_wake",
    schema_version: 1,
    source_epoch: "2026-05-14T00:00:00.000Z",
    replay_key: "schedule:wake:entry:1",
    redaction_policy: "metadata_only" as const,
  };
}

function runtimeEventRef(ref = "runtime-control:reload_config") {
  return {
    ref,
    source_store: "runtime_operation" as const,
    source_event_type: "runtime_control_response",
    schema_version: 1,
    source_epoch: "reload_config",
    high_watermark: "runtime-control:reload_config",
    replay_key: "runtime-control:reload_config:confirm_required",
    redaction_policy: "metadata_only" as const,
  };
}

function memoryTruthEventRef(ref = "memory-correction:1") {
  return {
    ref,
    source_store: "memory_truth" as const,
    source_event_type: "memory_correction",
    schema_version: 1,
    source_epoch: "forget",
    high_watermark: "runtime_evidence:evidence-1",
    replay_key: "memory-truth:forget:evidence-1",
    redaction_policy: "metadata_only" as const,
  };
}

function chatInput(overrides: Partial<CompanionCognitionInput> = {}): CompanionCognitionInput {
  const input = eventRef();
  return {
    cognition_id: "cognition:chat:1",
    caller_path: "chat_user_turn",
    event_refs: [input],
    working_context: {
      input_ref: input,
      route_ref: { kind: "chat_route", ref: "agent_loop" },
      session_ref: { kind: "chat_session", ref: "session:1" },
      turn_started_at: NOW,
      hidden_prompt_content_materialized: false,
    },
    session_context: {
      session_ref: { kind: "chat_session", ref: "session:1" },
      turn_ref: { kind: "chat_turn", ref: "turn:1" },
      run_ref: { kind: "chat_run", ref: "run:1" },
      route_kind: "agent_loop",
      runtime_control_allowed: true,
      approval_mode: "interactive",
      quieting_active: false,
      stale_reply_target_refs: [],
    },
    memory_context_request: {
      request_id: "memory-request:chat:1",
      requested_uses: ["runtime_grounding"],
      caller_path: "chat_user_turn",
      query_ref: input,
      surface_projection_required: true,
      side_effect_authorization_allowed: false,
      include_sensitive_content: false,
    },
    surface_target: "internal_audit",
    ...overrides,
  };
}

describe("CompanionCognitionService", () => {
  it("evaluates chat turns as advisory cognition and persists refs-only audit records", async () => {
    const sink = new InMemoryCognitionAuditSink();
    const service = new CompanionCognitionService({
      auditSink: sink,
      now: () => new Date(NOW),
    });
    const output = await service.evaluateTurn(chatInput());

    expect(output).toMatchObject({
      cognition_id: "cognition:chat:1",
      caller_path: "chat_user_turn",
      response_plan: {
        guidance_kind: "continue_route",
      },
    });
    expect(output.memory_writeback[0]).toMatchObject({
      admission_state: "pending_review",
      auto_apply: false,
      source_content_materialized: false,
    });
    expect(sink.list()).toHaveLength(1);
    expect(sink.list()[0]).toMatchObject({
      stable_output: {
        relationship_state: {
          relationship_refs: [],
          withheld_memory_refs: [],
        },
        selected_intention: null,
      },
      retention_policy: {
        materialized_content: false,
        refs_only: true,
        invalidates_on_source_tombstone: true,
      },
    });
  });

  it("keeps resident proactive cognition downgrade-only from upstream gates", async () => {
    const input = eventRef("attention:gate:1");
    const output = await new CompanionCognitionService().evaluateIntervention({
      cognition_id: "cognition:resident:1",
      caller_path: "resident_proactive_check",
      event_refs: [input],
      working_context: {
        input_ref: input,
        route_ref: { kind: "resident_action", ref: "preemptive_check" },
        hidden_prompt_content_materialized: false,
      },
      attention_context: {
        attention_input_ref: { kind: "attention_input", ref: "attention:input:1" },
        agenda_ref: { kind: "agenda", ref: "agenda:1" },
        admission_status: "held",
        initiative_gate_decision_id: "gate:1",
        operation_boundary: "blocked",
        max_delivery_kind: "hold",
        feedback_policy_refs: [],
      },
      memory_context_request: {
        request_id: "memory-request:resident:1",
        requested_uses: ["proactive_action_candidate"],
        caller_path: "resident_proactive_check",
        query_ref: input,
        surface_projection_required: true,
        side_effect_authorization_allowed: false,
        include_sensitive_content: false,
      },
      surface_target: "internal_audit",
    });

    expect(output.response_plan).toMatchObject({
      guidance_kind: "hold",
      delivery_kind: "hold",
      quieting_applied: true,
    });
    expect(output.tool_candidates).toEqual([]);
  });

  it("keeps high-risk relationship tension as confirmation context without increasing proactivity", async () => {
    const input = eventRef("attention:dependency-risk:1");
    const output = await new CompanionCognitionService().evaluateIntervention({
      cognition_id: "cognition:resident:dependency-risk",
      caller_path: "resident_proactive_check",
      event_refs: [input],
      working_context: {
        input_ref: input,
        route_ref: { kind: "resident_action", ref: "supportive_check" },
        hidden_prompt_content_materialized: false,
      },
      attention_context: {
        attention_input_ref: { kind: "attention_input", ref: "attention:dependency-risk" },
        admission_status: "admitted",
        initiative_gate_decision_id: "gate:dependency-risk",
        operation_boundary: "allowed",
        max_delivery_kind: "speak",
        feedback_policy_refs: [],
      },
      memory_context_request: {
        request_id: "memory-request:resident:dependency-risk",
        requested_uses: ["proactive_action_candidate"],
        caller_path: "resident_proactive_check",
        query_ref: input,
        surface_projection_required: true,
        side_effect_authorization_allowed: false,
        include_sensitive_content: false,
      },
      memory_result: {
        request_id: "memory-request:resident:dependency-risk",
        surface_projection_ref: {
          kind: "surface_projection",
          ref: "surface:dependency-risk",
        },
        core_memory_projection_ref: {
          kind: "memory_projection",
          ref: "core-memory:dependency-risk",
        },
        included: [{
          memory_ref: {
            ...input,
            ref: "profile:relationship:dependency-risk",
            source_store: "profile",
            source_event_type: "open_tension",
          },
          source_kind: "semantic",
          allowed_uses: ["proactive_action_candidate"],
          forbidden_uses: [],
          sensitivity: "private",
          lifecycle: "active",
          correction_state: "current",
          confidence: 0.35,
          surface_projection_ref: "surface:dependency-risk",
          relationship_role: "open_tension",
          excerpt: "Potential dependency risk must stay under review.",
        }],
        withheld: [],
        audit_refs: [],
        model_visible_without_cloud_gate: false,
      },
      surface_target: "internal_audit",
    });

    expect(output.response_plan).toMatchObject({
      guidance_kind: "suggest",
      delivery_kind: "suggest",
      quieting_applied: false,
    });
    expect(output.relationship_state).toMatchObject({
      posture: "careful",
      overreach_risk: "medium",
      included: [expect.objectContaining({
        role: "open_tension",
        allowed_surface_use: "ask_for_confirmation",
      })],
    });
    expect(output.authorization_requests).toEqual([]);
    expect(output.tool_candidates).toEqual([]);
  });

  it("represents stale targets as uncertainty and regrounding-only intention", async () => {
    const output = await new CompanionCognitionService().evaluateTurn(chatInput({
      goal_context: {
        active_goals: [],
        active_intention_refs: [],
        stale_target_refs: [{ kind: "run", ref: "run:previous" }],
      },
    }));

    expect(output.selected_intention).toMatchObject({
      lifecycle: "requires_regrounding",
      requires_regrounding: true,
    });
    expect(output.uncertainty.map((entry) => entry.kind)).toContain("stale_target");
  });

  it("assembles situation refs, missing memory, and unavailable policy without changing the route owner", async () => {
    const withheldMemory = {
      memory_ref: eventRef("profile:memory:withheld"),
      source_kind: "semantic" as const,
      allowed_uses: [],
      forbidden_uses: ["runtime_grounding" as const],
      sensitivity: "private" as const,
      lifecycle: "active" as const,
      correction_state: "current" as const,
      withheld_reason: "missing_surface_projection" as const,
    };
    const output = await new CompanionCognitionService().evaluateTurn(chatInput({
      session_context: {
        session_ref: { kind: "chat_session", ref: "session:1" },
        turn_ref: { kind: "chat_turn", ref: "turn:1" },
        run_ref: { kind: "chat_run", ref: "run:1" },
        route_kind: "agent_loop",
        runtime_control_allowed: false,
        approval_mode: "interactive",
        quieting_active: false,
        stale_reply_target_refs: [],
      },
      memory_result: {
        request_id: "memory-request:chat:1",
        included: [],
        withheld: [withheldMemory],
        audit_refs: [],
        model_visible_without_cloud_gate: false,
      },
    }));

    expect(output.situation_model).toMatchObject({
      route_ref: { kind: "chat_route", ref: "agent_loop" },
      session_ref: { kind: "chat_session", ref: "session:1" },
      policy_available: false,
      missing_memory_refs: [{ kind: "memory", ref: "profile:memory:withheld" }],
      missing_policy_refs: [{ kind: "runtime_control_policy", ref: "runtime_control:unavailable" }],
    });
    expect(output.response_plan.guidance_kind).toBe("continue_route");
  });

  it("turns cognition replay records into reflection input without runtime authority", async () => {
    const sink = new InMemoryCognitionAuditSink();
    await new CompanionCognitionService({
      auditSink: sink,
      now: () => new Date(NOW),
    }).evaluateTurn(chatInput({
      memory_result: createEmptyCognitionMemoryResult({ requestId: "memory-request:chat:1" }),
    }));
    const record = sink.list()[0]!;
    const reflectionInput = createReflectionInputFromCognitionReplay({
      inputId: "reflection:cognition:1",
      record,
    });

    expect(reflectionInput.writeback_proposals).toHaveLength(1);
    expect(reflectionInput.runtime_authority).toBe(false);
  });

  it("centralizes schedule wakes as hold-only candidate actions with replay refs", async () => {
    const input = scheduleEventRef();
    const output = await new CompanionCognitionKernel().evaluateScheduleWake({
      cognition_id: "cognition:schedule:1",
      caller_path: "schedule_wake",
      event_refs: [input],
      working_context: {
        input_ref: input,
        route_ref: { kind: "schedule_action", ref: "wait_resume" },
        runtime_graph_refs: [
          { kind: "schedule_entry", ref: "schedule:entry:1" },
          { kind: "goal", ref: "goal:1" },
        ],
        uncertainty_refs: [{ kind: "run", ref: "run:stale" }],
        hidden_prompt_content_materialized: false,
      },
      runtime_context: {
        runtime_item_refs: [{ kind: "schedule_entry", ref: "schedule:entry:1" }],
        phase_ref: { kind: "schedule_wake", ref: "schedule:entry:1:due" },
      },
      goal_context: {
        active_goals: [{
          goal_id: "goal:1",
          goal_ref: { kind: "goal", ref: "goal:1" },
          lifecycle: "active",
          priority: "unknown",
        }],
        active_intention_refs: [],
        stale_target_refs: [{ kind: "run", ref: "run:stale" }],
      },
      memory_context_request: {
        request_id: "memory-request:schedule:1",
        requested_uses: ["attention_prioritization", "runtime_grounding"],
        caller_path: "schedule_wake",
        query_ref: input,
        surface_projection_required: true,
        side_effect_authorization_allowed: false,
        include_sensitive_content: false,
      },
      surface_target: "internal_audit",
    });

    expect(output).toMatchObject({
      caller_path: "schedule_wake",
      response_plan: {
        guidance_kind: "hold",
        delivery_kind: "hold",
        quieting_applied: true,
      },
      candidate_action: {
        action_kind: "hold",
        side_effect_profile: "notification",
        executes_side_effect: false,
      },
      commitment_handoff: {
        state: "not_applicable",
        uses_attention_state_store: true,
        creates_parallel_commitment_store: false,
      },
      memory_use_audit: {
        owner_boundary: "memory_truth_maintenance",
        raw_memory_read: false,
        resurrects_invalidated_memory: false,
      },
      authority_handoff: {
        boundary: "none",
        kernel_executes_side_effects: false,
        bypasses_stale_target_rejection: false,
      },
      correlation_refs: {
        replay_key: "cognition:schedule:1:schedule:wake:entry:1",
        runtime_graph_refs: [
          { kind: "schedule_entry", ref: "schedule:entry:1" },
          { kind: "goal", ref: "goal:1" },
        ],
      },
    });
    expect(output.selected_intention).toMatchObject({
      lifecycle: "requires_regrounding",
      requires_regrounding: true,
    });
  });

  it("keeps runtime-control authority as a handoff instead of a kernel side effect", async () => {
    const input = runtimeEventRef();
    const output = await new CompanionCognitionKernel().evaluateRuntimeControlResponse({
      cognition_id: "cognition:runtime-control:1",
      caller_path: "runtime_control_response",
      event_refs: [input],
      working_context: {
        input_ref: input,
        route_ref: { kind: "runtime_control", ref: "reload_config" },
        runtime_graph_refs: [{ kind: "runtime_control_intent", ref: "reload_config" }],
        authority_state_refs: [{ kind: "approval", ref: "runtime-control:reload_config" }],
        hidden_prompt_content_materialized: false,
      },
      runtime_context: {
        runtime_item_refs: [{ kind: "runtime_control_intent", ref: "reload_config" }],
        approval_refs: [{ kind: "approval", ref: "runtime-control:reload_config" }],
        active_control_state_refs: [{ kind: "runtime_control_decision", ref: "confirm_required" }],
        operator_handoff_ref: { kind: "runtime_control_intent", ref: "reload_config" },
        phase_ref: { kind: "runtime_control_phase", ref: "confirm_required" },
      },
      memory_context_request: {
        request_id: "memory-request:runtime-control:1",
        requested_uses: ["runtime_grounding", "ask_for_confirmation"],
        caller_path: "runtime_control_response",
        query_ref: input,
        surface_projection_required: true,
        side_effect_authorization_allowed: false,
        include_sensitive_content: false,
      },
      surface_target: "internal_audit",
    });

    expect(output.response_plan.guidance_kind).toBe("request_approval");
    expect(output.candidate_action).toMatchObject({
      action_kind: "request_authority",
      side_effect_profile: "runtime_mutation",
      requires_authority: true,
      executes_side_effect: false,
    });
    expect(output.authority_handoff).toMatchObject({
      boundary: "runtime_control",
      authority_state_refs: expect.arrayContaining([{ kind: "approval", ref: "runtime-control:reload_config" }]),
      kernel_executes_side_effects: false,
      bypasses_stale_target_rejection: false,
    });
    expect(output.situation_model.approval_refs).toEqual([
      { kind: "approval", ref: "runtime-control:reload_config" },
    ]);
  });

  it("treats invalidated memory truth as withheld evidence for future behavior", async () => {
    const input = memoryTruthEventRef();
    const output = await new CompanionCognitionKernel().evaluateMemoryTruthOperation({
      cognition_id: "cognition:memory-truth:1",
      caller_path: "memory_truth_operation",
      event_refs: [input],
      working_context: {
        input_ref: input,
        route_ref: { kind: "memory_truth_operation", ref: "forget" },
        memory_truth_refs: [{ kind: "runtime_evidence", ref: "evidence-1" }],
        hidden_prompt_content_materialized: false,
      },
      runtime_context: {
        runtime_item_refs: [{ kind: "memory_correction", ref: "correction:1" }],
        phase_ref: { kind: "memory_truth_operation", ref: "forget" },
      },
      goal_context: {
        active_goals: [{
          goal_id: "goal:1",
          goal_ref: { kind: "goal", ref: "goal:1" },
          lifecycle: "active",
          priority: "unknown",
        }],
        active_intention_refs: [],
        stale_target_refs: [{ kind: "runtime_evidence", ref: "evidence-1" }],
      },
      memory_context_request: {
        request_id: "memory-request:memory-truth:1",
        requested_uses: ["behavioral_inhibition", "user_facing_reference"],
        caller_path: "memory_truth_operation",
        query_ref: input,
        surface_projection_required: true,
        side_effect_authorization_allowed: false,
        include_sensitive_content: false,
      },
      memory_result: {
        request_id: "memory-request:memory-truth:1",
        included: [],
        withheld: [{
          memory_ref: {
            ...input,
            ref: "evidence-1",
            source_store: "memory_truth",
            source_event_type: "memory_correction",
          },
          source_kind: "episodic",
          allowed_uses: [],
          forbidden_uses: ["user_facing_reference"],
          sensitivity: "private",
          lifecycle: "deleted",
          correction_state: "retracted",
          withheld_reason: "deleted",
        }],
        audit_refs: [],
        model_visible_without_cloud_gate: false,
      },
      surface_target: "internal_audit",
    });

    expect(output.response_plan).toMatchObject({
      guidance_kind: "hold",
      quieting_applied: true,
    });
    expect(output.memory_use_audit).toMatchObject({
      included_memory_refs: [],
      withheld_memory_refs: [{ kind: "memory", ref: "evidence-1" }],
      memory_truth_refs: [{ kind: "runtime_evidence", ref: "evidence-1" }],
      raw_memory_read: false,
      resurrects_invalidated_memory: false,
    });
    expect(output.uncertainty.map((entry) => entry.kind)).toEqual(expect.arrayContaining([
      "missing_surface",
      "stale_target",
    ]));
  });
});
