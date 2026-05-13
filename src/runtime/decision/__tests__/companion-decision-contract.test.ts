import { describe, expect, it } from "vitest";
import type {
  AutonomyDecision,
  AutonomyDecisionLevel,
} from "../../control/autonomy-governor.js";
import {
  CompanionDecisionFrameSchema,
  CompanionDecisionOutputSchema,
  CompanionDecisionRouteSchema,
  createCompanionDecisionProjectionBridge,
} from "../index.js";

const NOW = "2026-05-13T00:00:00.000Z";

function decision(level: AutonomyDecisionLevel, overrides: Partial<AutonomyDecision> = {}): AutonomyDecision {
  return {
    schema_version: "autonomy-decision/v1",
    decision_id: `autonomy:decision:${level}`,
    operation_id: "notify.send",
    capability_id: "capability:notify",
    evaluated_at: NOW,
    level,
    rationale: [
      "RAW_POLICY_STATE admission=approval_required provider=notify capability=external_send",
    ],
    allowed_steps: level === "approval_required"
      ? ["prepare", "request_user_approval"]
      : level === "prohibited"
        ? []
        : ["execute"],
    blocked_steps: level === "approval_required"
      ? ["execute_without_approval"]
      : level === "prohibited"
        ? ["execute"]
        : [],
    required_user_approval: level === "approval_required",
    audit_refs: ["audit:policy:notify"],
    expires_at: "2026-05-13T00:05:00.000Z",
    invalidation_bindings: [{
      kind: "policy",
      ref: "policy:notification",
    }],
    cache_key: `cache:${level}`,
    metadata: {
      admission_evaluation_ref: "admission:notify",
      readiness_refs: ["readiness:notify"],
      user_directed: false,
      external_side_effect: true,
      blast_radius: "external",
      privacy_sensitivity: "medium",
      context_authority_evidence_refs: [],
    },
    ...overrides,
  };
}

function baseFrame(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: "companion-decision-frame/v1",
    frame_id: "frame:1",
    assembled_at: NOW,
    source: {
      kind: "chat_turn",
      source_ref: "chat:turn:1",
      received_at: NOW,
      caller_path: "chat_native_agent_loop",
      surface_ref: "surface:chat",
      session_ref: "session:chat",
      channel: "tui",
    },
    input_refs: [{
      kind: "chat_message",
      ref: "chat:message:1",
      role: "trigger",
    }],
    evidence_refs: [{
      evidence_ref: "grounding:bundle:1",
      source: "grounding",
      visibility: "audit_only",
    }],
    policy_refs: [{
      kind: "runtime_control",
      ref: "runtime-control:session",
      result: "allowed",
    }],
    active_target_ref: {
      kind: "session",
      id: "session:chat",
    },
    active_surface_ref: "surface:chat",
    companion_state_ref: "companion-state:active",
    ...overrides,
  };
}

function baseOutput(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: "companion-decision-output/v1",
    decision_id: "decision:1",
    frame_id: "frame:1",
    decided_at: NOW,
    route: {
      disposition: "answer_now",
      caller_path: "chat_native_agent_loop",
      integration_state: "contract_only",
      preserves_existing_runner: true,
    },
    trace: {
      why_this: "The current turn is the trigger.",
      why_now: "The turn is active on the current surface.",
      why_this_route: "Native chat AgentLoop remains the existing caller path.",
      evidence_refs: ["grounding:bundle:1"],
      policy_refs: ["runtime-control:session"],
      alternatives_considered: ["gateway_model_loop"],
      suppressed_alternatives: ["resident_attention_cycle"],
    },
    ...overrides,
  };
}

describe("CompanionDecisionFrame", () => {
  it("represents chat, task, and resident cycle inputs with the same frame contract", () => {
    const chat = CompanionDecisionFrameSchema.parse(baseFrame());
    const task = CompanionDecisionFrameSchema.parse(baseFrame({
      frame_id: "frame:task",
      source: {
        kind: "task_execution",
        source_ref: "task:run:1",
        received_at: NOW,
        caller_path: "task_agent_loop",
        task_ref: "task:1",
        goal_ref: "goal:1",
      },
      input_refs: [{
        kind: "task",
        ref: "task:1",
        role: "trigger",
      }],
      active_target_ref: {
        kind: "task",
        id: "task:1",
      },
    }));
    const resident = CompanionDecisionFrameSchema.parse(baseFrame({
      frame_id: "frame:resident",
      source: {
        kind: "resident_attention_cycle",
        source_ref: "attention-cycle:1",
        received_at: NOW,
        caller_path: "resident_attention_cycle",
        attention_cycle_ref: "attention-cycle:1",
      },
      input_refs: [{
        kind: "attention_cycle",
        ref: "attention-cycle:1",
        role: "trigger",
      }],
      attention_cycle_ref: "attention-cycle:1",
      active_target_ref: {
        kind: "attention_cycle",
        id: "attention-cycle:1",
      },
    }));

    expect([chat.source.kind, task.source.kind, resident.source.kind]).toEqual([
      "chat_turn",
      "task_execution",
      "resident_attention_cycle",
    ]);
  });

  it("carries stale targets as input evidence without selecting a stale route directly", () => {
    const frame = CompanionDecisionFrameSchema.parse(baseFrame({
      frame_id: "frame:stale-target",
      input_refs: [
        {
          kind: "chat_message",
          ref: "chat:message:1",
          role: "trigger",
        },
        {
          kind: "surface",
          ref: "surface:previous",
          role: "target",
          freshness: "rejected_stale",
          reason: "The reply target belongs to a previous turn.",
        },
      ],
      policy_refs: [{
        kind: "safety_boundary",
        ref: "stale-target-rejection",
        result: "rejected_stale",
      }],
    }));
    const output = CompanionDecisionOutputSchema.parse(baseOutput({
      decision_id: "decision:stale-target",
      frame_id: frame.frame_id,
      route: {
        disposition: "reground_before_action",
        caller_path: "chat_native_agent_loop",
        integration_state: "contract_only",
        preserves_existing_runner: true,
        target_ref: {
          kind: "surface",
          id: "surface:previous",
        },
      },
      trace: {
        why_this: "The current turn references a prior surface target.",
        why_now: "The stale target was detected before action admission.",
        why_this_route: "Regrounding keeps the existing chat caller path and rejects stale target reuse.",
        evidence_refs: ["surface:previous"],
        policy_refs: ["stale-target-rejection"],
        alternatives_considered: ["execute_now", "request_approval"],
        suppressed_alternatives: ["execute_now"],
      },
    }));

    expect(frame.input_refs[1]).toMatchObject({ freshness: "rejected_stale" });
    expect(output.route.disposition).toBe("reground_before_action");
    expect(output.route.integration_state).toBe("contract_only");
  });

  it("allows run refs to remain selected targets when decisions point at active runs", () => {
    const frame = CompanionDecisionFrameSchema.parse(baseFrame({
      frame_id: "frame:run-target",
      source: {
        kind: "chat_turn",
        source_ref: "chat:turn:run",
        received_at: NOW,
        caller_path: "chat_native_agent_loop",
        run_ref: "run:active",
      },
      input_refs: [
        {
          kind: "chat_message",
          ref: "chat:message:run",
          role: "trigger",
        },
        {
          kind: "run",
          ref: "run:active",
          role: "target",
          freshness: "current",
        },
      ],
      active_target_ref: {
        kind: "run",
        id: "run:active",
      },
    }));
    const output = CompanionDecisionOutputSchema.parse(baseOutput({
      decision_id: "decision:run-target",
      frame_id: frame.frame_id,
      route: {
        disposition: "continue_durable_work",
        caller_path: "chat_native_agent_loop",
        integration_state: "contract_only",
        preserves_existing_runner: true,
        target_ref: {
          kind: "run",
          id: "run:active",
        },
      },
    }));

    expect(frame.active_target_ref).toMatchObject({ kind: "run", id: "run:active" });
    expect(output.route.target_ref).toMatchObject({ kind: "run", id: "run:active" });
  });
});

describe("CompanionDecisionOutput", () => {
  it("represents approval-required and quiet-hold outcomes before any runner rewiring", () => {
    const approval = CompanionDecisionOutputSchema.parse(baseOutput({
      decision_id: "decision:approval",
      route: {
        disposition: "request_approval",
        caller_path: "chat_runtime_control",
        integration_state: "contract_only",
        preserves_existing_runner: true,
        requires_approval: true,
        emits_user_visible_projection: true,
      },
      admission_result: "approval_required",
      autonomy_level: "approval_required",
      internal_policy_state: {
        visibility: "operator_only",
        policy_refs: [{
          kind: "approval_gate",
          ref: "admission:notify",
          result: "approval_required",
        }],
        raw_policy_detail_refs: ["debug:admission:notify"],
      },
    }));
    const quietHold = CompanionDecisionOutputSchema.parse(baseOutput({
      decision_id: "decision:quiet-hold",
      route: {
        disposition: "hold",
        caller_path: "resident_attention_cycle",
        integration_state: "contract_only",
        preserves_existing_runner: true,
        hold_reason: "quieting_policy",
      },
      admission_result: "suppressed",
      autonomy_level: "prepare_only",
    }));

    expect(approval.route.requires_approval).toBe(true);
    expect(approval.internal_policy_state?.visibility).toBe("operator_only");
    expect(quietHold.route.hold_reason).toBe("quieting_policy");
    expect(quietHold.route.preserves_existing_runner).toBe(true);
  });

  it("bridges to CompanionActionProjection without leaking raw policy details to normal surfaces", () => {
    const projectionBridge = createCompanionDecisionProjectionBridge({
      decision: decision("approval_required"),
      context: {
        surface_ref: "surface:chat",
        surface_kind: "normal_companion",
      },
      preparedArtifactRefs: ["draft:notify"],
      approvalRequestRef: "approval:notify",
      evaluatedAt: NOW,
    });
    const output = CompanionDecisionOutputSchema.parse(baseOutput({
      decision_id: "decision:projection",
      route: {
        disposition: "request_approval",
        caller_path: "chat_runtime_control",
        integration_state: "contract_only",
        preserves_existing_runner: true,
        requires_approval: true,
        emits_user_visible_projection: true,
      },
      admission_result: "approval_required",
      autonomy_level: "approval_required",
      internal_policy_state: {
        visibility: "operator_only",
        policy_refs: [{
          kind: "admission_policy",
          ref: "admission:notify",
          result: "approval_required",
        }],
        raw_policy_detail_refs: ["debug:raw-policy:notify"],
      },
      projection_bridge: projectionBridge,
    }));

    expect(output.projection_bridge?.projection.user_visible_action_kind).toBe("ask_for_approval");
    expect(output.projection_bridge?.projection.surface_expression_policy.raw_policy_state_visible).toBe(false);
    expect(output.projection_bridge?.raw_policy_state_visible).toBe(false);
    expect(JSON.stringify(output.projection_bridge?.projection)).not.toContain("RAW_POLICY_STATE");
    expect(output.internal_policy_state?.raw_policy_detail_refs).toEqual(["debug:raw-policy:notify"]);
  });

  it("names future caller-path adoption without integrating lower-level runners", () => {
    const routes = [
      "chat_gateway_model_loop",
      "chat_native_agent_loop",
      "chat_configure_route",
      "task_agent_loop",
      "bounded_agent_loop",
      "resident_attention_cycle",
      "projection_only",
    ].map((callerPath) => CompanionDecisionRouteSchema.parse({
      disposition: callerPath === "projection_only" ? "emit_surface_intent" : "continue_durable_work",
      caller_path: callerPath,
      integration_state: "contract_only",
      preserves_existing_runner: true,
    }));

    expect(routes.map((route) => route.caller_path)).toContain("chat_gateway_model_loop");
    expect(routes.map((route) => route.caller_path)).toContain("task_agent_loop");
    expect(routes.every((route) => route.integration_state === "contract_only")).toBe(true);
    expect(routes.every((route) => route.preserves_existing_runner)).toBe(true);
  });
});
