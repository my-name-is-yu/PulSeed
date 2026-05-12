import { describe, expect, it } from "vitest";
import {
  assembleResidentOperationPlans,
  assembleScheduleOperationPlans,
  evaluateResidentOperationBoundary,
} from "../capability-operation-planner.js";
import { CapabilityReadinessSnapshotSchema } from "../../platform/observation/types/capability.js";
import {
  ScheduleEntrySchema,
  ScheduleInternalAttentionProjectionSchema,
  type ScheduleEntry,
  type ScheduleInternalAttentionProjection,
} from "../types/schedule.js";

const NOW = "2026-05-09T00:00:00.000Z";

function entry(overrides: Partial<ScheduleEntry> = {}): ScheduleEntry {
  return ScheduleEntrySchema.parse({
    id: "11111111-1111-4111-8111-111111111111",
    name: "wait resume",
    layer: "goal_trigger",
    trigger: { type: "interval", seconds: 60, jitter_factor: 0 },
    enabled: true,
    metadata: {
      internal: true,
      activation_kind: "wait_resume",
      goal_id: "goal-1",
      strategy_id: "strategy:wait",
      wait_strategy_id: "strategy:wait",
    },
    goal_trigger: {
      goal_id: "goal-1",
      max_iterations: 5,
      skip_if_active: false,
    },
    created_at: NOW,
    updated_at: NOW,
    last_fired_at: null,
    next_fire_at: NOW,
    ...overrides,
  });
}

function projection(): ScheduleInternalAttentionProjection {
  return ScheduleInternalAttentionProjectionSchema.parse({
    kind: "wait_resume_attention_projection",
    projected_at: NOW,
    signal_context_id: `signal:schedule-wake:11111111-1111-4111-8111-111111111111:${NOW}`,
    signal_sources: ["schedule_tick", "wait_expiry"],
    urge_candidate_refs: ["urge:1"],
    agenda_item_refs: ["agenda:1"],
    inhibition_decisions: [],
    initiative_gate_decisions: [{ ref: "gate:1", status: "delayed" }],
    runtime_items: [{
      ref: "runtime:item:1",
      type: "agent_agenda_item",
      status: "pending",
      posture: "holding",
      visibility_display: "hidden",
      inspectable: true,
      auditable: true,
    }],
    non_execution_states: ["delayed", "held", "silent_runtime_item"],
    summary: "wait resume projection",
  });
}

function residentAdmission(overrides: Record<string, unknown> = {}) {
  return {
    action: "suggest_goal" as const,
    source_kind: "resident_proactive_maintenance" as const,
    attention_input_id: "attention-input:resident:suggest",
    signal_context_id: "signal:resident:suggest",
    urge_id: "urge:resident:suggest",
    agenda_item_id: "agenda:resident:suggest",
    inhibition_decision_id: "inhibition:resident:suggest",
    initiative_gate_decision_id: "gate:resident:suggest",
    outcome_decision_id: "outcome:resident:suggest",
    requested_outcome: "prepare_silently",
    admission_status: "admitted",
    final_outcome: "prepare_silently",
    branch_admitted: true,
    ...overrides,
  };
}

describe("assembleScheduleOperationPlans", () => {
  it("assembles wait-resume attention output into an advisory candidate plan", () => {
    const assembly = assembleScheduleOperationPlans({
      entry: entry(),
      firedAt: NOW,
      projection: projection(),
    });

    expect(assembly.status).toBe("planned");
    expect(assembly.candidate_plans).toHaveLength(1);
    expect(assembly.candidate_plans[0]?.operation_plan).toMatchObject({
      operation_kind: "hint",
      side_effect_profile: "none",
      external_action_authority: false,
      advisory_only: true,
      local_only: true,
      expected_user_visible_effect: false,
    });
    expect(assembly.candidate_plans[0]?.admission_scope).toMatchObject({
      requires_runtime_control: false,
      external_action_authority: false,
      required_permission_capabilities: [],
    });
  });

  it("fails closed when the attention projection belongs to a different schedule tick", () => {
    const assembly = assembleScheduleOperationPlans({
      entry: entry(),
      firedAt: NOW,
      projection: {
        ...projection(),
        signal_context_id: "signal:schedule-wake:11111111-1111-4111-8111-111111111111:2026-05-08T00:00:00.000Z",
      },
    });

    expect(assembly).toMatchObject({
      status: "fail_closed",
      reason: "Wait-resume attention projection does not match the schedule tick context.",
      candidate_plans: [],
    });
  });

  it("fails closed when wait-resume source context is incomplete", () => {
    const assembly = assembleScheduleOperationPlans({
      entry: entry(),
      firedAt: NOW,
    });

    expect(assembly).toMatchObject({
      status: "fail_closed",
      candidate_plans: [],
    });
  });

  it("fails closed when wait-resume metadata does not match the trigger goal", () => {
    const assembly = assembleScheduleOperationPlans({
      entry: entry({
        metadata: {
          internal: true,
          source: "manual",
          dependency_hints: [],
          activation_kind: "wait_resume",
          goal_id: "stale-goal",
          strategy_id: "strategy:wait",
          wait_strategy_id: "strategy:wait",
        },
      }),
      firedAt: NOW,
      projection: projection(),
    });

    expect(assembly).toMatchObject({
      status: "fail_closed",
      candidate_plans: [],
    });
  });
});

describe("resident operation plan boundary", () => {
  it("converts admitted resident goal suggestions into prepare-only operation decisions", () => {
    const boundary = evaluateResidentOperationBoundary({
      admission: residentAdmission(),
      assembledAt: NOW,
      details: {
        title: "Prepare a resident suggestion",
      },
    });

    expect(boundary.assembly.status).toBe("planned");
    expect(boundary.assembly.candidate_plans[0]?.operation_plan).toMatchObject({
      operation_kind: "prepare",
      side_effect_profile: "write",
      external_action_authority: false,
      expected_user_visible_effect: false,
      preparable_when_blocked: true,
    });
    expect(boundary.admission_evaluation).toMatchObject({
      result: "allowed",
    });
    expect(boundary.autonomy_decision).toMatchObject({
      level: "prepare_only",
      required_user_approval: false,
      allowed_steps: ["prepare"],
      blocked_steps: expect.arrayContaining(["autonomous_initiate", "execute_without_approval"]),
    });
    expect(boundary.assembly.assembly_id).not.toContain(NOW);
    expect(boundary.assembly.candidate_plans[0]?.plan_id).not.toContain(NOW);
    expect(boundary.admission_evaluation?.evaluation_id).not.toContain(NOW);
    expect(boundary.autonomy_decision?.decision_id).not.toContain(NOW);
    expect(boundary.preparation_allowed).toBe(true);
    expect(boundary.execution_allowed).toBe(false);
  });

  it("fails closed when a non-preemptive resident proposal lacks admitted attention context", () => {
    const assembly = assembleResidentOperationPlans({
      admission: residentAdmission({
        branch_admitted: false,
        admission_status: "held",
        final_outcome: undefined,
      }),
      assembledAt: NOW,
    });

    expect(assembly).toMatchObject({
      status: "fail_closed",
      candidate_plans: [],
      reason: "Resident operation plan requires an admitted attention outcome before preparing a proposal.",
    });
  });

  it("keeps readiness, Dream hints, notification routes, auth sessions, MCP, and past success separate from initiation authority", () => {
    const input = {
      admission: residentAdmission({
        action: "preemptive_check",
        outcome_decision_id: "outcome:resident:preemptive",
        requested_outcome: "prepare_action_candidate",
        admission_status: "held",
        final_outcome: undefined,
        branch_admitted: false,
      }),
      assembledAt: NOW,
      goalId: "goal-1",
    };
    const assembly = assembleResidentOperationPlans(input);
    const candidate = assembly.candidate_plans[0]!;
    const readiness = CapabilityReadinessSnapshotSchema.parse({
      schema_version: "capability-readiness-snapshot/v1",
      snapshot_id: "readiness:resident-preemptive",
      capability_id: candidate.operation_plan.capability_id,
      provider_ref: candidate.operation_plan.provider_ref,
      asset_ref: candidate.operation_plan.provider_ref,
      operation_id: candidate.operation_plan.operation_id,
      operation_kind: candidate.operation_plan.operation_kind,
      tool_name: "resident-preemptive-check",
      payload_class: candidate.operation_plan.payload_class,
      risk_class: candidate.operation_plan.risk_class,
      side_effect_profile: candidate.operation_plan.side_effect_profile,
      evaluated_at: NOW,
      state: "executable_verified",
      passed_gates: ["stored", "configured", "authenticated", "executable_verified"],
      safe_user_visible_label: "Execution substrate verified",
    });

    const boundary = evaluateResidentOperationBoundary({
      ...input,
      readinessSnapshots: [readiness],
      authState: {
        ref: "auth:resident-valid",
        status: "valid",
        epoch: "auth-epoch-1",
      },
      contextAuthorityEvidence: [
        { ref: "dream:hint:1", kind: "dream_hint" },
        { ref: "route:telegram-home", kind: "route_config" },
        { ref: "notification:telegram", kind: "notification_subscription" },
        { ref: "auth:resident-valid", kind: "auth_session" },
        { ref: "mcp:filesystem", kind: "mcp_enabled" },
        { ref: "execution:previous-success", kind: "past_execution" },
      ],
    });

    expect(boundary.assembly.status).toBe("planned");
    expect(boundary.admission_evaluation).toMatchObject({
      result: "approval_required",
      runtime_control_refs: [],
      rejected_permission_grant_refs: [],
    });
    expect(boundary.autonomy_decision).toMatchObject({
      level: "approval_required",
      required_user_approval: true,
      allowed_steps: ["prepare", "request_user_approval"],
      metadata: {
        context_authority_evidence_refs: [
          "auth:resident-valid",
          "dream:hint:1",
          "execution:previous-success",
          "mcp:filesystem",
          "notification:telegram",
          "route:telegram-home",
        ],
      },
    });
    expect(boundary.autonomy_decision?.blocked_steps).toEqual(expect.arrayContaining([
      "autonomous_initiate",
      "execute_without_approval",
      "infer_permission_from_auth_session",
      "infer_permission_from_dream_hint",
      "infer_permission_from_mcp_enabled",
      "infer_permission_from_notification_subscription",
      "infer_permission_from_past_execution",
      "infer_permission_from_route_config",
    ]));
    expect(boundary.preparation_allowed).toBe(true);
    expect(boundary.execution_allowed).toBe(false);
  });
});
