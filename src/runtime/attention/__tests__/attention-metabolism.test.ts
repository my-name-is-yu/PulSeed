import { describe, expect, it } from "vitest";
import {
  admitInitiativeGateDecision,
  advanceAttentionMaturation,
  applyAttentionFeedbackConservatively,
  assembleSignalContext,
  buildSchedulerWakeSignalContext,
  createUrgeCandidate,
  decideInhibition,
  mergeUrgesIntoAgenda,
  ref,
  runtimeItemsForAgenda,
  selectInitiativeGateDecision,
  sourceRef,
  type AttentionFeedbackEvent,
} from "../index.js";
import type {
  AgentAgendaItem,
  AutonomyCheck,
  SignalContext,
  UrgeCandidate,
} from "../../types/companion-autonomy.js";

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
