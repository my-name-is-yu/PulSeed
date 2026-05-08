import { describe, expect, it } from "vitest";
import {
  admitInitiativeGateDecision,
  advanceAttentionMaturation,
  applyAttentionFeedbackConservatively,
  applySurfaceInvalidationToAttention,
  assembleSignalContext,
  buildSchedulerWakeSignalContext,
  createExpressionDecisionForOutcome,
  createUrgeCandidate,
  decideInhibition,
  mergeUrgesIntoAgenda,
  ref,
  renderExpressionDecisionForSurface,
  runtimeItemsForAgenda,
  selectInitiativeGateDecision,
  sourceRef,
  type AttentionFeedbackEvent,
} from "../index.js";
import { renderTuiExpressionDecision } from "../../../interface/tui/fullscreen-chat-render.js";
import { renderGatewayExpressionDecision } from "../../gateway/index.js";
import type {
  AgentAgendaItem,
  AutonomyCheck,
  OutcomeClass,
  SignalContext,
  UrgeCandidate,
  VisibilityPolicy,
} from "../../types/companion-autonomy.js";
import type { SurfaceMemorySourceRef } from "../../../grounding/surface-contracts.js";

const NOW = "2026-05-08T00:00:00.000Z";

function check(
  kind: AutonomyCheck["kind"],
  status: AutonomyCheck["status"] = "passed",
  reason = `${kind} ${status}`
): AutonomyCheck {
  return {
    check_id: `${kind}:${status}`,
    kind,
    status,
    reason,
    evidence_refs: [],
  };
}

function signalContext() {
  return assembleSignalContext({
    signal_context_id: "signal:attention:1",
    assembled_at: NOW,
    signals: [
      { source: "runtime_event", ref: ref("runtime_event", "runtime:event:1") },
      { source: "goal", ref: ref("goal", "goal:1") },
      { source: "drive", ref: ref("drive", "drive:goal-care") },
      { source: "curiosity", ref: ref("curiosity", "curiosity:compare") },
    ],
    active_surface_ref: ref("surface", "surface:current"),
    current_session_refs: [ref("session", "session:current")],
    current_goal_refs: [ref("goal", "goal:1")],
    runtime_state_refs: [ref("runtime_event", "runtime:event:1")],
    relationship_permission_refs: [ref("permission_grant", "permission:active")],
    user_activity_refs: [ref("user_activity", "activity:focus")],
    timing_context: {
      observed_at: NOW,
      quiet_hours_active: false,
    },
    safety_context: {
      safety_refs: [ref("safety_check", "safety:clear")],
      hard_blocked: false,
    },
  });
}

type UrgeHelperInput = Partial<UrgeCandidate> & {
  signal_context?: SignalContext;
};

function curiosityUrge(input: UrgeHelperInput = {}): UrgeCandidate {
  return createUrgeCandidate({
    urge_id: input.urge_id ?? "urge:curiosity:1",
    signal_context: input.signal_context ?? signalContext(),
    origin: input.origin ?? "curiosity",
    target: input.target ?? ref("goal", "goal:1"),
    feeling: input.feeling ?? "curiosity",
    subject: input.subject ?? "Compare recent runtime evidence against the active goal.",
    strength: input.strength ?? 0.72,
    confidence: input.confidence ?? 0.74,
    expected_user_benefit: input.expected_user_benefit ?? "The goal can be watched without interrupting the user.",
    companion_state_ref: input.companion_state_ref,
    allowed_moves: input.allowed_moves,
    forbidden_moves: input.forbidden_moves,
    maturation_state: input.maturation?.state ?? "warming",
  });
}

function matureAgenda(input: Partial<AgentAgendaItem> = {}): AgentAgendaItem {
  return mergeUrgesIntoAgenda({
    now: NOW,
    urges: [
      curiosityUrge({
        urge_id: "urge:ready:1",
        maturation: {
          state: input.maturation?.state ?? "mature",
          first_seen_at: NOW,
          reinforcement_refs: [sourceRef("runtime_event", "runtime:event:1")],
          blocker_refs: [],
        },
        confidence: input.confidence ?? 0.9,
      }),
    ],
  })[0]!;
}

function surfaceMemorySource(): SurfaceMemorySourceRef {
  const owner = {
    schema_version: 1,
    kind: "relationship_profile" as const,
    store_ref: "relationship-profile.json",
    record_ref: "profile-item-1",
  };
  return {
    memory_id: "memory:surface-source",
    owning_store_ref: owner,
    role: "relationship" as const,
    record_kind: "preference" as const,
    domain_fields: {
      target: "status reports",
      preference: "concise",
    },
    allowed_uses: ["surface_projection", "attention_prioritization"],
    not_allowed_uses: [],
    lifecycle: "active" as const,
    correction_state: "current" as const,
    superseded_by_memory_id: null,
    sensitivity: "private" as const,
    content_state: "materialized" as const,
    dependency_ref: {
      kind: "memory_record" as const,
      ref: "memory:surface-source",
      owning_store_ref: owner,
      content_state: "materialized" as const,
      lifecycle: "active" as const,
      correction_state: "current" as const,
      superseded_by_memory_id: null,
    },
  };
}

function visibilityPolicy(input: Partial<VisibilityPolicy> = {}): VisibilityPolicy {
  return {
    schema_version: "visibility-policy-v1",
    visibility_policy_id: input.visibility_policy_id ?? "visibility:surface-facing",
    applies_to: input.applies_to ?? [ref("outcome_decision", "outcome:surface")],
    hidden_by_default: input.hidden_by_default ?? false,
    visible_in_gui: input.visible_in_gui ?? true,
    visible_in_chat: input.visible_in_chat ?? true,
    visible_in_tui: input.visible_in_tui ?? true,
    visible_in_cli: input.visible_in_cli ?? false,
    visible_in_audit: input.visible_in_audit ?? true,
    visible_in_debug: input.visible_in_debug ?? true,
    digest_only: input.digest_only ?? false,
    visible_in_digest: input.visible_in_digest ?? false,
    never_directly_show: input.never_directly_show ?? false,
    content_lifecycle: input.content_lifecycle ?? "active",
    redaction_required: input.redaction_required ?? false,
    raw_content_allowed: input.raw_content_allowed ?? false,
    inspectable_summary: input.inspectable_summary,
    rationale: input.rationale ?? "surface-facing outcome can render through shared decision policy",
    audit_refs: input.audit_refs ?? [],
  };
}

function selectedGateForOutcome(outcome: OutcomeClass, input: {
  decision_id?: string;
  required_runtime_control_refs?: ReturnType<typeof ref>[];
  required_approval?: boolean;
} = {}) {
  const agenda = matureAgenda();
  const inhibition = decideInhibition({
    decision_id: `${input.decision_id ?? outcome}:inhibition`,
    decided_at: NOW,
    candidate: agenda,
    permission_checks: [check("permission")],
    staleness_checks: [check("staleness")],
    safety_checks: [check("safety")],
  });

  return selectInitiativeGateDecision({
    decision_id: input.decision_id ?? `gate:${outcome}`,
    decided_at: NOW,
    candidate: agenda,
    inhibition_decision: inhibition,
    requested_outcome: outcome,
    permission_checks: [check("permission")],
    staleness_checks: [check("staleness")],
    side_effect_checks: [check("authority")],
    required_runtime_control_refs: input.required_runtime_control_refs ?? [ref("runtime_control", `runtime-control:${outcome}`)],
    required_approval: input.required_approval,
  });
}

describe("attention metabolism pipeline", () => {
  it("assembles SignalContext into internal UrgeCandidate pressure without output moves", () => {
    const signal = signalContext();
    const urge = createUrgeCandidate({
      urge_id: "urge:signal-clamp",
      signal_context: signal,
      origin: "drive",
      target: ref("goal", "goal:1"),
      feeling: "care",
      subject: "Care about the active goal without exposing it.",
      strength: 1,
      confidence: 0.92,
      expected_user_benefit: "PulSeed can keep tracking the goal.",
      allowed_moves: ["notice", "watch", "speak", "external_side_effect"],
    });

    expect(signal.signal_sources).toEqual(["runtime_event", "goal", "drive", "curiosity"]);
    expect(urge.allowed_moves).toEqual(["notice", "watch"]);
    expect(urge.forbidden_moves).toEqual(expect.arrayContaining([
      "speak",
      "run_authorized_work",
      "write_memory_candidate",
      "update_surface_candidate",
      "external_side_effect",
    ]));
  });

  it("merges duplicate evidence into one agenda item while preserving provenance", () => {
    const repeatedSignal = assembleSignalContext({
      signal_context_id: "signal:repeat",
      assembled_at: NOW,
      signals: [
        { source: "runtime_event", ref: ref("runtime_event", "runtime:event:repeat") },
      ],
      active_surface_ref: ref("surface", "surface:current"),
      current_goal_refs: [ref("goal", "goal:1")],
      runtime_state_refs: [ref("runtime_event", "runtime:event:repeat")],
      relationship_permission_refs: [ref("permission_grant", "permission:active")],
    });
    const first = curiosityUrge({
      urge_id: "urge:repeat:1",
      signal_context: repeatedSignal,
      maturation: {
        state: "warming",
        first_seen_at: NOW,
        reinforcement_refs: [sourceRef("runtime_event", "runtime:event:repeat")],
        blocker_refs: [],
      },
    });
    const second = curiosityUrge({
      urge_id: "urge:repeat:2",
      signal_context: repeatedSignal,
      maturation: {
        state: "warming",
        first_seen_at: NOW,
        reinforcement_refs: [sourceRef("runtime_event", "runtime:event:repeat")],
        blocker_refs: [],
      },
    });

    const agenda = mergeUrgesIntoAgenda({ urges: [first, second], now: NOW });

    expect(agenda).toHaveLength(1);
    expect(agenda[0]!.source_urge_refs.map((item) => item.id)).toEqual([
      "urge:repeat:1",
      "urge:repeat:2",
    ]);
    expect(agenda[0]!.merge_trace?.reinforced_by_refs.map((item) => item.ref.id)).toContain("runtime:event:repeat");
    expect(agenda[0]!.maturation.state).toBe("held");
    expect(agenda[0]!.current_posture).toBe("held");
  });

  it("advances maturation through preparation, decay, and stale rejection", () => {
    const evidence = [sourceRef("runtime_event", "runtime:event:1")];
    const prepared = advanceAttentionMaturation({
      transition_id: "transition:prepare",
      candidate_ref: ref("agent_agenda_item", "agenda:1"),
      current_state: "warming",
      now: NOW,
      first_seen_at: NOW,
      evidence_refs: evidence,
      confidence: 0.9,
      reinforcement_causes: ["time_sensitivity"],
      prepare_allowed: true,
    });
    expect(prepared.transition.to_state).toBe("prepared");

    const decayed = advanceAttentionMaturation({
      transition_id: "transition:decay",
      candidate_ref: ref("urge_candidate", "urge:low-confidence"),
      current_state: "warming",
      now: NOW,
      first_seen_at: NOW,
      evidence_refs: evidence,
      confidence: 0.2,
    });
    expect(decayed.transition.to_state).toBe("decayed");

    const stale = advanceAttentionMaturation({
      transition_id: "transition:stale",
      candidate_ref: ref("agent_agenda_item", "agenda:stale"),
      current_state: "mature",
      now: NOW,
      first_seen_at: NOW,
      evidence_refs: evidence,
      blocker_causes: ["stale_target"],
    });
    expect(stale.transition.to_state).toBe("rejected_stale");
  });

  it("keeps inhibition separate from gate outcome selection and runtime admission", () => {
    const agenda = matureAgenda();
    const inhibition = decideInhibition({
      decision_id: "inhibition:allow",
      decided_at: NOW,
      candidate: agenda,
      permission_checks: [check("permission")],
      staleness_checks: [check("staleness")],
      safety_checks: [check("safety")],
    });
    expect(inhibition.decision).toBe("allow_to_gate");
    expect(inhibition).not.toHaveProperty("selected_outcome");

    const gate = selectInitiativeGateDecision({
      decision_id: "gate:expression",
      decided_at: NOW,
      candidate: agenda,
      inhibition_decision: inhibition,
      requested_outcome: "express_to_user",
      permission_checks: [check("permission")],
      staleness_checks: [check("staleness")],
      sensitivity_checks: [check("safety")],
      side_effect_checks: [check("authority")],
    });
    expect(gate.selected_outcome).toBe("express_to_user");

    const downgraded = admitInitiativeGateDecision({
      outcome_decision_id: "outcome:digest",
      decided_at: NOW,
      gate_decision: gate,
      companion_control_checks: [check("companion_control", "failed", "quiet mode blocks immediate expression")],
      visibility_policy_ref: ref("visibility_policy", "visibility:digest"),
    });
    expect(downgraded?.admission_status).toBe("downgraded");
    expect(downgraded?.final_outcome).toBe("add_to_digest");

    const rejected = admitInitiativeGateDecision({
      outcome_decision_id: "outcome:stale",
      decided_at: NOW,
      gate_decision: gate,
      staleness_checks: [check("staleness", "failed", "Surface invalidated before admission")],
    });
    expect(rejected?.admission_status).toBe("rejected");
    expect(rejected?.final_outcome).toBeUndefined();
  });

  it("holds gate-selected outcomes until required runtime control and approval are satisfied", () => {
    const agenda = matureAgenda();
    const inhibition = decideInhibition({
      decision_id: "inhibition:approval",
      decided_at: NOW,
      candidate: agenda,
      permission_checks: [check("permission")],
      staleness_checks: [check("staleness")],
      safety_checks: [check("safety")],
    });
    const requiredRuntimeControl = ref("runtime_control", "runtime-control:approval-route");
    const gate = selectInitiativeGateDecision({
      decision_id: "gate:approval",
      decided_at: NOW,
      candidate: agenda,
      inhibition_decision: inhibition,
      requested_outcome: "run_authorized_work",
      permission_checks: [check("permission")],
      staleness_checks: [check("staleness")],
      side_effect_checks: [check("authority")],
      required_runtime_control_refs: [requiredRuntimeControl],
    });

    const missingRuntimeControl = admitInitiativeGateDecision({
      outcome_decision_id: "outcome:missing-runtime-control",
      decided_at: NOW,
      gate_decision: gate,
    });
    expect(missingRuntimeControl?.admission_status).toBe("held");
    expect(missingRuntimeControl?.downgrade_or_rejection_reason?.code).toBe("authority_unknown");

    const admittedRuntimeControl = admitInitiativeGateDecision({
      outcome_decision_id: "outcome:runtime-control-admitted",
      decided_at: NOW,
      gate_decision: gate,
      admitted_runtime_control_refs: [requiredRuntimeControl],
    });
    expect(admittedRuntimeControl?.admission_status).toBe("admitted");
    expect(admittedRuntimeControl?.final_outcome).toBe("run_authorized_work");

    const approvalGate = {
      ...gate,
      decision_id: "gate:approval-required",
      selected_outcome: "express_to_user" as const,
      required_runtime_control_refs: [],
      required_approval: true,
    };
    const missingApproval = admitInitiativeGateDecision({
      outcome_decision_id: "outcome:missing-approval",
      decided_at: NOW,
      gate_decision: approvalGate,
      admitted_runtime_control_refs: [requiredRuntimeControl],
    });
    expect(missingApproval?.admission_status).toBe("held");
    expect(missingApproval?.downgrade_or_rejection_reason?.code).toBe("approval_required");

    const admitted = admitInitiativeGateDecision({
      outcome_decision_id: "outcome:approved",
      decided_at: NOW,
      gate_decision: approvalGate,
      admitted_runtime_control_refs: [requiredRuntimeControl],
      approval_ref: ref("approval", "approval:yes"),
    });
    expect(admitted?.admission_status).toBe("admitted");
    expect(admitted?.final_outcome).toBe("express_to_user");

    const missingImplicitRuntimeControl = admitInitiativeGateDecision({
      outcome_decision_id: "outcome:missing-implicit-runtime-control",
      decided_at: NOW,
      gate_decision: {
        ...gate,
        decision_id: "gate:missing-implicit-runtime-control",
        required_runtime_control_refs: [],
      },
    });
    expect(missingImplicitRuntimeControl?.admission_status).toBe("held");
    expect(missingImplicitRuntimeControl?.downgrade_or_rejection_reason?.code).toBe("authority_unknown");

    const spoofedRuntimeControl = admitInitiativeGateDecision({
      outcome_decision_id: "outcome:spoofed-runtime-control",
      decided_at: NOW,
      gate_decision: {
        ...gate,
        decision_id: "gate:spoofed-runtime-control",
        required_runtime_control_refs: [],
      },
      admitted_runtime_control_refs: [ref("goal", "goal:spoofed-runtime-control")],
    });
    expect(spoofedRuntimeControl?.admission_status).toBe("held");
    expect(spoofedRuntimeControl?.downgrade_or_rejection_reason?.code).toBe("authority_unknown");

    const invalidRequiredRuntimeControl = admitInitiativeGateDecision({
      outcome_decision_id: "outcome:invalid-required-runtime-control",
      decided_at: NOW,
      gate_decision: {
        ...gate,
        decision_id: "gate:invalid-required-runtime-control",
        required_runtime_control_refs: [ref("goal", "goal:not-runtime-control")],
      },
      admitted_runtime_control_refs: [requiredRuntimeControl],
    });
    expect(invalidRequiredRuntimeControl?.admission_status).toBe("held");
    expect(invalidRequiredRuntimeControl?.downgrade_or_rejection_reason?.code).toBe("authority_unknown");
  });

  it("records typed runtime admission failures and downgrades without fake final outcomes", () => {
    const stale = admitInitiativeGateDecision({
      outcome_decision_id: "outcome:stale-target",
      decided_at: NOW,
      gate_decision: selectedGateForOutcome("express_to_user"),
      admitted_runtime_control_refs: [ref("runtime_control", "runtime-control:express_to_user")],
      staleness_checks: [check("staleness", "failed", "target evidence is stale")],
    });
    expect(stale?.admission_status).toBe("rejected");
    expect(stale?.final_outcome).toBeUndefined();
    expect(stale?.downgrade_or_rejection_reason?.code).toBe("stale_target");

    const missingPermission = admitInitiativeGateDecision({
      outcome_decision_id: "outcome:missing-permission",
      decided_at: NOW,
      gate_decision: selectedGateForOutcome("run_authorized_work"),
      admitted_runtime_control_refs: [ref("runtime_control", "runtime-control:run_authorized_work")],
      authority_checks: [check("permission", "failed", "permission grant is absent")],
    });
    expect(missingPermission?.admission_status).toBe("rejected");
    expect(missingPermission?.final_outcome).toBeUndefined();
    expect(missingPermission?.downgrade_or_rejection_reason?.code).toBe("missing_permission");

    const invalidSurface = admitInitiativeGateDecision({
      outcome_decision_id: "outcome:invalid-surface",
      decided_at: NOW,
      gate_decision: selectedGateForOutcome("add_to_digest"),
      admitted_runtime_control_refs: [ref("runtime_control", "runtime-control:add_to_digest")],
      staleness_checks: [check("surface", "failed", "digest Surface invalidated before admission")],
    });
    expect(invalidSurface?.admission_status).toBe("held");
    expect(invalidSurface?.final_outcome).toBeUndefined();
    expect(invalidSurface?.downgrade_or_rejection_reason?.code).toBe("invalid_surface");

    const guardrail = admitInitiativeGateDecision({
      outcome_decision_id: "outcome:guardrail",
      decided_at: NOW,
      gate_decision: selectedGateForOutcome("escalate"),
      admitted_runtime_control_refs: [ref("runtime_control", "runtime-control:escalate")],
      safety_checks: [check("guardrail", "failed", "guardrail blocked escalation")],
    });
    expect(guardrail?.admission_status).toBe("rejected");
    expect(guardrail?.final_outcome).toBeUndefined();
    expect(guardrail?.downgrade_or_rejection_reason?.code).toBe("guardrail_blocked");

    const backpressure = admitInitiativeGateDecision({
      outcome_decision_id: "outcome:backpressure",
      decided_at: NOW,
      gate_decision: selectedGateForOutcome("express_to_user"),
      admitted_runtime_control_refs: [ref("runtime_control", "runtime-control:express_to_user")],
      companion_control_checks: [check("backpressure", "failed", "surface queue is backed up")],
      visibility_policy_ref: ref("visibility_policy", "visibility:digest"),
    });
    expect(backpressure?.admission_status).toBe("downgraded");
    expect(backpressure?.final_outcome).toBe("add_to_digest");
    expect(backpressure?.downgrade_or_rejection_reason?.code).toBe("backpressure");

    const approvalGate = {
      ...selectedGateForOutcome("prepare_action_candidate"),
      required_approval: true,
    };
    const approvalRequired = admitInitiativeGateDecision({
      outcome_decision_id: "outcome:approval-required",
      decided_at: NOW,
      gate_decision: approvalGate,
      admitted_runtime_control_refs: [ref("runtime_control", "runtime-control:prepare_action_candidate")],
      visibility_policy_ref: ref("visibility_policy", "visibility:approval"),
    });
    expect(approvalRequired?.admission_status).toBe("downgraded");
    expect(approvalRequired?.final_outcome).toBe("request_approval");
    expect(approvalRequired?.downgrade_or_rejection_reason?.code).toBe("approval_required");

    const overloaded = admitInitiativeGateDecision({
      outcome_decision_id: "outcome:overloaded",
      decided_at: NOW,
      gate_decision: selectedGateForOutcome("run_authorized_work"),
      admitted_runtime_control_refs: [ref("runtime_control", "runtime-control:run_authorized_work")],
      companion_control_checks: [check("capacity", "failed", "runtime is overloaded")],
    });
    expect(overloaded?.admission_status).toBe("downgraded");
    expect(overloaded?.final_outcome).toBe("hold_in_agenda");
    expect(overloaded?.downgrade_or_rejection_reason?.code).toBe("overloaded");

    const coolingDown = admitInitiativeGateDecision({
      outcome_decision_id: "outcome:cooling-down",
      decided_at: NOW,
      gate_decision: selectedGateForOutcome("delegate_bounded_work"),
      admitted_runtime_control_refs: [ref("runtime_control", "runtime-control:delegate_bounded_work")],
      companion_control_checks: [check("cooldown", "failed", "similar intervention is cooling down")],
    });
    expect(coolingDown?.admission_status).toBe("downgraded");
    expect(coolingDown?.final_outcome).toBe("prepare_silently");
    expect(coolingDown?.downgrade_or_rejection_reason?.code).toBe("cooling_down");
  });

  it("creates and renders shared ExpressionDecision records only for admitted surface-facing outcomes", () => {
    const work = admitInitiativeGateDecision({
      outcome_decision_id: "outcome:quiet-work",
      decided_at: NOW,
      gate_decision: selectedGateForOutcome("run_authorized_work"),
      admitted_runtime_control_refs: [ref("runtime_control", "runtime-control:run_authorized_work")],
      visibility_policy_ref: ref("visibility_policy", "visibility:work"),
    });
    expect(work?.final_outcome).toBe("run_authorized_work");
    expect(createExpressionDecisionForOutcome({
      expression_decision_id: "expression:quiet-work",
      created_at: NOW,
      outcome_decision: work!,
      target_surface_classes: ["chat"],
    })).toBeNull();

    const noVisibilityApproval = admitInitiativeGateDecision({
      outcome_decision_id: "outcome:approval-no-visibility",
      decided_at: NOW,
      gate_decision: selectedGateForOutcome("request_approval"),
      admitted_runtime_control_refs: [ref("runtime_control", "runtime-control:request_approval")],
    });
    expect(createExpressionDecisionForOutcome({
      expression_decision_id: "expression:no-visibility",
      created_at: NOW,
      outcome_decision: noVisibilityApproval!,
      target_surface_classes: ["gateway", "tui"],
    })).toBeNull();

    const approval = admitInitiativeGateDecision({
      outcome_decision_id: "outcome:approval-expression",
      decided_at: NOW,
      gate_decision: selectedGateForOutcome("request_approval"),
      admitted_runtime_control_refs: [ref("runtime_control", "runtime-control:request_approval")],
      visibility_policy_ref: ref("visibility_policy", "visibility:approval"),
    });
    const expression = createExpressionDecisionForOutcome({
      expression_decision_id: "expression:approval",
      created_at: NOW,
      outcome_decision: approval!,
      target_surface_classes: ["gateway", "tui"],
    });
    expect(expression?.expression_mode).toBe("approval_request");
    expect(() => createExpressionDecisionForOutcome({
      expression_decision_id: "expression:approval-wrong-visibility",
      created_at: NOW,
      outcome_decision: approval!,
      target_surface_classes: ["gateway", "tui"],
      visibility_policy_ref: ref("visibility_policy", "visibility:too-broad"),
    })).toThrow(/OutcomeDecision visibility policy/);

    const policy = visibilityPolicy({
      visibility_policy_id: "visibility:approval",
      applies_to: [
        ref("outcome_decision", "outcome:approval-expression"),
        ref("expression_decision", "expression:approval"),
      ],
    });
    const gatewayRender = renderGatewayExpressionDecision({
      renderId: "render:gateway:approval",
      renderedAt: NOW,
      outcomeDecision: approval!,
      expressionDecision: expression,
      visibilityPolicy: policy,
    });
    const tuiRender = renderTuiExpressionDecision({
      renderId: "render:tui:approval",
      renderedAt: NOW,
      outcomeDecision: approval!,
      expressionDecision: expression,
      visibilityPolicy: policy,
    });
    expect(gatewayRender).toBe("Ask the user before continuing the blocked action.");
    expect(tuiRender).toMatchObject({
      key: "render:tui:approval",
      text: "Ask the user before continuing the blocked action.",
      bold: true,
      protected: true,
    });
    expect(renderTuiExpressionDecision({
      renderId: "render:missing-expression",
      renderedAt: NOW,
      outcomeDecision: approval!,
      expressionDecision: null,
      visibilityPolicy: policy,
    })).toBeNull();
  });

  it("holds digest outcomes after Surface invalidation and renders only after re-admission", () => {
    const gate = selectedGateForOutcome("add_to_digest");
    const invalidated = admitInitiativeGateDecision({
      outcome_decision_id: "outcome:digest-invalidated",
      decided_at: NOW,
      gate_decision: gate,
      admitted_runtime_control_refs: [ref("runtime_control", "runtime-control:add_to_digest")],
      staleness_checks: [check("surface", "failed", "digest Surface was invalidated")],
      visibility_policy_ref: ref("visibility_policy", "visibility:digest"),
    });
    expect(invalidated?.admission_status).toBe("held");
    expect(createExpressionDecisionForOutcome({
      expression_decision_id: "expression:digest-invalidated",
      created_at: NOW,
      outcome_decision: invalidated!,
      target_surface_classes: ["digest"],
    })).toBeNull();

    const readmitted = admitInitiativeGateDecision({
      outcome_decision_id: "outcome:digest-readmitted",
      decided_at: NOW,
      gate_decision: gate,
      admitted_runtime_control_refs: [ref("runtime_control", "runtime-control:add_to_digest")],
      visibility_policy_ref: ref("visibility_policy", "visibility:digest"),
    });
    const expression = createExpressionDecisionForOutcome({
      expression_decision_id: "expression:digest-readmitted",
      created_at: NOW,
      outcome_decision: readmitted!,
      target_surface_classes: ["digest"],
    });
    expect(expression?.expression_mode).toBe("digest_item");

    const policy = visibilityPolicy({
      visibility_policy_id: "visibility:digest",
      applies_to: [
        ref("outcome_decision", "outcome:digest-readmitted"),
        ref("expression_decision", "expression:digest-readmitted"),
      ],
      visible_in_chat: false,
      visible_in_tui: false,
      visible_in_cli: false,
      visible_in_gui: false,
      digest_only: true,
      visible_in_digest: true,
      rationale: "digest item remains visible only through the digest surface",
    });
    expect(renderExpressionDecisionForSurface({
      render_id: "render:chat:digest",
      rendered_at: NOW,
      surface_class: "chat",
      outcome_decision: readmitted!,
      expression_decision: expression,
      visibility_policy: policy,
    })).toBeNull();
    expect(renderExpressionDecisionForSurface({
      render_id: "render:digest:readmitted",
      rendered_at: NOW,
      surface_class: "digest",
      outcome_decision: readmitted!,
      expression_decision: expression,
      visibility_policy: policy,
    })?.expression_mode).toBe("digest_item");
  });

  it("does not let high Drive or curiosity bypass permission, Surface, cooldown, or runtime control", () => {
    const highPressure = mergeUrgesIntoAgenda({
      now: NOW,
      urges: [
        curiosityUrge({
          urge_id: "urge:high-curiosity",
          strength: 1,
          confidence: 1,
          maturation: {
            state: "mature",
            first_seen_at: NOW,
            reinforcement_refs: [sourceRef("drive", "drive:high")],
            blocker_refs: [],
          },
        }),
      ],
    })[0]!;

    const inhibited = decideInhibition({
      decision_id: "inhibition:missing-permission",
      decided_at: NOW,
      candidate: highPressure,
      permission_checks: [check("permission", "failed", "permission grant is missing")],
      staleness_checks: [check("staleness")],
      safety_checks: [check("safety")],
    });
    expect(inhibited.decision).toBe("hold");

    const gate = selectInitiativeGateDecision({
      decision_id: "gate:no-bypass",
      decided_at: NOW,
      candidate: highPressure,
      inhibition_decision: inhibited,
      requested_outcome: "express_to_user",
      permission_checks: [check("permission", "failed", "permission grant is missing")],
      staleness_checks: [check("staleness")],
    });
    expect(gate.status).toBe("delayed");
    expect(gate.selected_outcome).toBeUndefined();
    expect(admitInitiativeGateDecision({
      outcome_decision_id: "outcome:none",
      decided_at: NOW,
      gate_decision: gate,
    })).toBeNull();
  });

  it("invalidates mature Surface-derived urges and expires non-regroundable agenda before the gate", () => {
    const surfaceBoundSignal = assembleSignalContext({
      signal_context_id: "signal:surface-old",
      assembled_at: NOW,
      signals: [
        { source: "runtime_event", ref: ref("runtime_event", "runtime:event:surface-old") },
        { source: "correction", ref: ref("memory", "memory:surface-source") },
      ],
      active_surface_ref: ref("surface", "surface:old"),
      current_goal_refs: [ref("goal", "goal:1")],
      relationship_permission_refs: [ref("permission_grant", "permission:active")],
    });
    const matureUrge = curiosityUrge({
      urge_id: "urge:surface-old",
      signal_context: surfaceBoundSignal,
      maturation: {
        state: "mature",
        first_seen_at: NOW,
        reinforcement_refs: [sourceRef("surface", "surface:old")],
        blocker_refs: [sourceRef("memory", "memory:surface-source")],
      },
      confidence: 0.92,
      companion_state_ref: ref("companion_state", "state:surface-old"),
    });
    const agenda = mergeUrgesIntoAgenda({ urges: [matureUrge], now: NOW })[0]!;
    expect(agenda.current_posture).toBe("ready_for_gate");

    const invalidation = applySurfaceInvalidationToAttention({
      surface_invalidation_event: {
        id: "surface-invalidation:old:correction",
        policy_ref: "surface:surface-old:policy:memory_correction",
        surface_ref: "surface:old",
        trigger: "memory_correction",
        source_ref: surfaceMemorySource(),
        affected_dependencies: [{
          kind: "agenda_item",
          ref: agenda.agenda_item_id,
          related_surface_refs: ["surface:old"],
          related_memory_refs: ["memory:surface-source"],
          permission_check_refs: ["permission:active"],
          staleness_check_refs: ["staleness:surface-old"],
          use_class: "surface_projection",
          audit_refs: ["audit:surface-old"],
        }],
        required_rechecks: [
          "scope",
          "lifecycle",
          "staleness",
          "sensitivity",
          "permission",
          "allowed_use",
          "forbidden_use",
          "projection",
          "audit",
        ],
        action: "regate",
        audit_ref: "audit:surface-invalidation",
        occurred_at: NOW,
      },
      urge_candidates: [matureUrge],
      agenda_items: [agenda],
      now: NOW,
    });

    const invalidatedUrge = invalidation.invalidated_urge_candidates[0]!;
    const invalidatedAgenda = invalidation.invalidated_agenda_items[0]!;
    expect(invalidatedUrge.maturation.state).toBe("held");
    expect(invalidatedUrge.surface_ref).toBeNull();
    expect(invalidatedUrge.companion_state_ref).toBeNull();
    expect(invalidatedUrge.evidence_refs).toEqual([
      {
        ref: ref("surface", "surface:old"),
        lifecycle: "redacted",
        redaction_reason: "surface invalidated by memory_correction",
      },
    ]);
    expect(invalidatedUrge.maturation.reinforcement_refs).toEqual([]);
    expect(invalidatedUrge.maturation.blocker_refs).toEqual([
      {
        ref: ref("surface", "surface:old"),
        lifecycle: "redacted",
        redaction_reason: "surface invalidated by memory_correction",
      },
    ]);
    expect(invalidatedAgenda.agenda_item_id).not.toBe(agenda.agenda_item_id);
    expect(invalidatedAgenda.current_posture).toBe("expired");
    expect(invalidatedAgenda.source_urge_refs).toEqual([]);
    expect(invalidatedAgenda.related_surface_refs).toEqual([]);
    expect(invalidatedAgenda.maturation.blocker_refs).toEqual([
      {
        ref: ref("surface", "surface:old"),
        lifecycle: "redacted",
        redaction_reason: "surface invalidated by memory_correction",
      },
    ]);
    expect(invalidation.invalidation_check).toMatchObject({
      kind: "staleness",
      status: "failed",
    });

    const inhibition = decideInhibition({
      decision_id: "inhibition:invalid-surface",
      decided_at: NOW,
      candidate: invalidatedUrge,
      permission_checks: [check("permission")],
      staleness_checks: [invalidation.invalidation_check],
      safety_checks: [check("safety")],
    });
    const gate = selectInitiativeGateDecision({
      decision_id: "gate:invalid-surface",
      decided_at: NOW,
      candidate: invalidatedUrge,
      inhibition_decision: inhibition,
      requested_outcome: "express_to_user",
    });
    expect(inhibition.decision).toBe("reject_stale");
    expect(gate.status).toBe("blocked");
    expect(gate.selected_outcome).toBeUndefined();

    const regroundableAgenda = applySurfaceInvalidationToAttention({
      surface_invalidation_event: {
        id: "surface-invalidation:old:correction",
        policy_ref: "surface:surface-old:policy:memory_correction",
        surface_ref: "surface:old",
        trigger: "memory_correction",
        source_ref: surfaceMemorySource(),
        affected_dependencies: [{
          kind: "agenda_item",
          ref: agenda.agenda_item_id,
          related_surface_refs: ["surface:old"],
          related_memory_refs: ["memory:surface-source"],
          permission_check_refs: ["permission:active"],
          staleness_check_refs: ["staleness:surface-old"],
          use_class: "surface_projection",
          audit_refs: ["audit:surface-old"],
        }],
        required_rechecks: [
          "scope",
          "lifecycle",
          "staleness",
          "sensitivity",
          "permission",
          "allowed_use",
          "forbidden_use",
          "projection",
          "audit",
        ],
        action: "regate",
        audit_ref: "audit:surface-invalidation",
        occurred_at: NOW,
      },
      agenda_items: [{
        ...agenda,
        related_surface_refs: [ref("surface", "surface:old"), ref("surface", "surface:current")],
      }],
      current_surface_ref: ref("surface", "surface:current"),
      now: NOW,
    }).invalidated_agenda_items[0]!;
    expect(regroundableAgenda.agenda_item_id).toBe(agenda.agenda_item_id);
    expect(regroundableAgenda.current_posture).toBe("held");
    expect(regroundableAgenda.staleness_state).toBe("needs_regrounding");
    expect(regroundableAgenda.related_surface_refs).toEqual([ref("surface", "surface:current")]);
  });

  it("routes scheduler and wait wakeups into re-evaluation instead of notification", () => {
    const wake = buildSchedulerWakeSignalContext({
      signal_context_id: "signal:wake:1",
      assembled_at: NOW,
      schedule_tick_ref: ref("schedule_tick", "schedule:reflection"),
      wait_ref: ref("wait", "wait:cooldown"),
      active_surface_ref: ref("surface", "surface:current"),
      current_session_refs: [ref("session", "session:current")],
      current_goal_refs: [ref("goal", "goal:1")],
      runtime_state_refs: [ref("runtime_event", "runtime:event:wake")],
      relationship_permission_refs: [ref("permission_grant", "permission:active")],
    });
    const scheduleUrge = createUrgeCandidate({
      urge_id: "urge:schedule-wake",
      signal_context: wake,
      origin: "schedule",
      target: ref("wait", "wait:cooldown"),
      feeling: "staleness_pressure",
      subject: "Re-evaluate the cooled down agenda item.",
      strength: 0.55,
      confidence: 0.7,
      expected_user_benefit: "PulSeed can revisit state without notifying.",
    });
    const agenda = mergeUrgesIntoAgenda({ urges: [scheduleUrge], now: NOW });
    const inhibition = decideInhibition({
      decision_id: "inhibition:wake-watch",
      decided_at: NOW,
      candidate: agenda[0]!,
      permission_checks: [check("permission")],
      staleness_checks: [check("staleness")],
      safety_checks: [check("safety")],
    });
    const gate = selectInitiativeGateDecision({
      decision_id: "gate:wake-delayed",
      decided_at: NOW,
      candidate: agenda[0]!,
      inhibition_decision: inhibition,
    });
    const runtimeItems = runtimeItemsForAgenda(agenda, NOW);

    expect(wake.signal_sources).toEqual(["schedule_tick", "wait_expiry"]);
    expect(inhibition.decision).toBe("watch");
    expect(gate.selected_outcome).toBeUndefined();
    expect(runtimeItems[0]!.visibility_policy.display).toBe("hidden");
    expect(runtimeItems[0]!.authority.speakable).toBe(false);
  });

  it("applies feedback conservatively to future initiative", () => {
    const feedback: AttentionFeedbackEvent[] = [
      {
        feedback_ref: ref("feedback", "feedback:accepted"),
        kind: "accepted",
        agenda_kind: "goal_stewardship",
        route: "express_to_user",
      },
      {
        feedback_ref: ref("feedback", "feedback:dismissed:1"),
        kind: "dismissed",
        agenda_kind: "goal_stewardship",
        urge_origin: "curiosity",
        route: "express_to_user",
      },
      {
        feedback_ref: ref("feedback", "feedback:dismissed:2"),
        kind: "dismissed",
        agenda_kind: "goal_stewardship",
        urge_origin: "curiosity",
        route: "express_to_user",
      },
      {
        feedback_ref: ref("feedback", "feedback:surface-narrowed"),
        kind: "surface_narrowed",
        surface_ref: ref("surface", "surface:narrowed"),
      },
    ];

    const adjustment = applyAttentionFeedbackConservatively(feedback);

    expect(adjustment.threshold_effects).toContain("preserve_thresholds");
    expect(adjustment.threshold_effects).toContain("raise_expression_threshold");
    expect(adjustment.suppressed_agenda_kinds).toEqual(["goal_stewardship"]);
    expect(adjustment.approval_required_outcomes).toEqual(["express_to_user"]);
    expect(adjustment.sensitive_urge_origins).toEqual(["curiosity"]);
    expect(adjustment.narrowed_surface_refs.map((item) => item.id)).toEqual(["surface:narrowed"]);
  });
});
