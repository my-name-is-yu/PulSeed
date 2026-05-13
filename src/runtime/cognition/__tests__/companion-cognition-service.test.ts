import { describe, expect, it } from "vitest";
import {
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
});
