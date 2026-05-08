import { describe, expect, it } from "vitest";
import {
  AgentAgendaItemSchema,
  AttentionMaturationTransitionSchema,
  AuditTraceSchema,
  canVisibilityPolicyExposeRawContent,
  ExpressionDecisionSchema,
  InhibitionDecisionSchema,
  InitiativeGateDecisionSchema,
  OutcomeClassSchema,
  OutcomeDecisionSchema,
  PermissionGrantBoundarySchema,
  SignalContextSchema,
  UrgeCandidateSchema,
  VisibilityPolicySchema,
} from "../../src/runtime/types/companion-autonomy.js";

const NOW = "2026-05-08T00:00:00.000Z";

function ref(kind: string, id: string) {
  return { kind, id };
}

function sourceRef(kind: string, id: string, lifecycle = "active") {
  return {
    ref: ref(kind, id),
    lifecycle,
  };
}

function risk(level = "low", reason = "test risk") {
  return {
    level,
    reason,
  };
}

function check(kind: "permission" | "staleness" | "authority" | "safety" | "companion_control" | "visibility") {
  return {
    check_id: `${kind}:1`,
    kind,
    status: "passed",
    reason: `${kind} passed in contract test`,
  };
}

function signalContext(input: Record<string, unknown> = {}) {
  return {
    signal_context_id: "signal:1",
    assembled_at: NOW,
    signal_sources: ["runtime_event", "drive", "curiosity"],
    signal_refs: [sourceRef("runtime_event", "runtime:event:1")],
    active_surface_ref: ref("surface", "surface:current"),
    current_session_refs: [ref("session", "session:current")],
    current_goal_refs: [ref("goal", "goal:current")],
    runtime_state_refs: [ref("runtime_item", "runtime:item:1")],
    relationship_permission_refs: [ref("relationship_permission", "relationship:permission:1")],
    user_activity_refs: [ref("user_activity", "activity:1")],
    timing_context: {
      observed_at: NOW,
      quiet_hours_active: false,
    },
    safety_context: {
      safety_refs: [ref("safety_check", "safety:1")],
      hard_blocked: false,
    },
    stale_target_context: {
      stale_refs: [],
      rejected_refs: [],
      needs_regrounding_refs: [],
    },
    ...input,
  };
}

function urgeCandidate(input: Record<string, unknown> = {}) {
  return {
    urge_id: "urge:curiosity:1",
    origin: "curiosity",
    target: ref("goal", "goal:current"),
    feeling: "curiosity",
    subject: "Investigate a possible stalled goal.",
    strength: 0.55,
    confidence: 0.7,
    urgency: "normal",
    expected_user_benefit: "PulSeed may notice a stalled commitment without interrupting immediately.",
    user_cost: risk("low", "no user-facing interruption yet"),
    relationship_risk: risk("low", "uses scoped relationship permission only"),
    side_effect_risk: risk("none", "candidate has no side effects"),
    sensitivity: "internal",
    evidence_refs: [sourceRef("signal_context", "signal:1")],
    surface_ref: ref("surface", "surface:current"),
    companion_state_ref: ref("companion_state", "companion-state:1"),
    allowed_moves: ["watch", "hold", "prepare"],
    forbidden_moves: ["speak", "external_side_effect"],
    maturation: {
      state: "warming",
      first_seen_at: NOW,
      reinforcement_refs: [sourceRef("runtime_event", "runtime:event:1")],
    },
    ...input,
  };
}

function agendaItem(input: Record<string, unknown> = {}) {
  return {
    agenda_item_id: "agenda:goal:1",
    origin: "goal",
    kind: "goal_stewardship",
    subject: "Watch the active goal for drift.",
    why_pulseed_cares: "The current goal has an active promise and may need later re-evaluation.",
    expected_user_benefit: "Continuity without immediate interruption.",
    related_goal_refs: [ref("goal", "goal:current")],
    related_memory_refs: [ref("memory", "memory:promise:1")],
    related_surface_refs: [ref("surface", "surface:current")],
    related_runtime_refs: [ref("runtime_item", "runtime:item:1")],
    source_urge_refs: [ref("urge_candidate", "urge:curiosity:1")],
    drive_basis: "goal stewardship score crossed the internal watch threshold",
    curiosity_basis: "recent runtime evidence may need later interpretation",
    confidence: 0.72,
    intrusion_cost: risk("medium", "surfacing now could interrupt focus"),
    relationship_risk: risk("low", "watching is within the active relationship boundary"),
    staleness_state: "current",
    allowed_moves: ["watch", "hold", "prepare"],
    forbidden_moves: ["speak", "external_side_effect"],
    current_posture: "held",
    maturation: {
      state: "held",
      first_seen_at: NOW,
      last_reinforced_at: NOW,
    },
    revisit_condition: {
      kind: "runtime_event",
      refs: [ref("runtime_event", "runtime:event:next")],
      reason: "revisit only when the runtime emits fresh evidence",
    },
    control_state: "held",
    created_at: NOW,
    updated_at: NOW,
    ...input,
  };
}

describe("companion autonomy attention contracts", () => {
  it("assembles SignalContext without allowing signal or memory to directly create expression or action", () => {
    const signal = SignalContextSchema.parse(signalContext());

    expect(signal.signal_sources).toContain("drive");
    expect(signal.signal_sources).toContain("curiosity");
    expect(signal.active_surface_ref).toMatchObject({ kind: "surface" });

    expect(() => SignalContextSchema.parse(signalContext({
      selected_outcome: "express_to_user",
    }))).toThrow();
    expect(() => SignalContextSchema.parse(signalContext({
      expression_decision_id: "expression:direct-from-signal",
    }))).toThrow();
    expect(() => SignalContextSchema.parse(signalContext({
      action_ref: ref("action_candidate", "action:direct-from-signal"),
    }))).toThrow();
    expect(() => ExpressionDecisionSchema.parse({
      expression_decision_id: "expression:direct-from-memory",
      outcome_decision_ref: ref("memory", "memory:promise:1"),
      outcome_class: "express_to_user",
      created_at: NOW,
      expression_mode: "direct_message",
      target_surface_classes: ["chat"],
      visibility_policy_ref: ref("visibility_policy", "visibility:normal"),
      user_facing_rationale: "invalid direct expression",
    })).toThrow(/ref kind/);
  });

  it("keeps curiosity and concern urges internal until agenda, inhibition, and gate admission", () => {
    const curiosity = UrgeCandidateSchema.parse(urgeCandidate());
    const concern = UrgeCandidateSchema.parse(urgeCandidate({
      urge_id: "urge:concern:1",
      origin: "risk",
      feeling: "concern",
      target: ref("runtime_item", "runtime:item:stalled"),
      strength: 0.8,
      confidence: 0.64,
    }));

    expect(curiosity.maturation.state).toBe("warming");
    expect(concern.feeling).toBe("concern");
    expect(() => UrgeCandidateSchema.parse(urgeCandidate({
      expression_mode: "direct_message",
    }))).toThrow();

    const agenda = AgentAgendaItemSchema.parse(agendaItem());
    expect(agenda.kind).toBe("goal_stewardship");
    expect(agenda.current_posture).toBe("held");
    expect(() => AgentAgendaItemSchema.parse(agendaItem({
      selected_outcome: "express_to_user",
    }))).toThrow();
    expect(() => AgentAgendaItemSchema.parse(agendaItem({
      action_ref: ref("action_candidate", "action:direct-from-agenda"),
    }))).toThrow();
  });

  it("models maturation, decay, stale rejection, and deduplication without duplicate expression pressure", () => {
    expect(AttentionMaturationTransitionSchema.parse({
      transition_id: "transition:warm-to-held",
      candidate_ref: ref("agent_agenda_item", "agenda:goal:1"),
      from_state: "warming",
      to_state: "held",
      cause: "repeated_evidence",
      evidence_refs: [sourceRef("runtime_event", "runtime:event:1")],
    })).toMatchObject({ to_state: "held" });

    expect(AttentionMaturationTransitionSchema.parse({
      transition_id: "transition:low-confidence-decay",
      candidate_ref: ref("urge_candidate", "urge:curiosity:1"),
      from_state: "warming",
      to_state: "decayed",
      cause: "low_confidence",
      evidence_refs: [sourceRef("feedback", "feedback:low-confidence")],
    })).toMatchObject({ to_state: "decayed" });

    expect(AttentionMaturationTransitionSchema.parse({
      transition_id: "transition:stale-rejection",
      candidate_ref: ref("agent_agenda_item", "agenda:goal:1"),
      from_state: "mature",
      to_state: "rejected_stale",
      cause: "stale_target",
      evidence_refs: [sourceRef("runtime_event", "runtime:event:stale")],
    })).toMatchObject({ to_state: "rejected_stale" });

    const merged = AgentAgendaItemSchema.parse(agendaItem({
      source_urge_refs: [
        ref("urge_candidate", "urge:curiosity:1"),
        ref("urge_candidate", "urge:curiosity:2"),
      ],
      merge_trace: {
        dedupe_key: "goal:current|surface:current|goal_stewardship",
        basis: {
          target: true,
          evidence: true,
          surface: true,
          kind: true,
          current_posture: true,
        },
        merged_urge_refs: [
          ref("urge_candidate", "urge:curiosity:1"),
          ref("urge_candidate", "urge:curiosity:2"),
        ],
        reinforced_by_refs: [sourceRef("runtime_event", "runtime:event:2")],
      },
    }));

    expect(merged.source_urge_refs).toHaveLength(2);
    expect(merged.merge_trace?.merged_urge_refs).toHaveLength(2);
    expect(() => AgentAgendaItemSchema.parse(agendaItem({
      merge_trace: {
        ...merged.merge_trace,
        selected_outcome: "express_to_user",
      },
    }))).toThrow();
  });

  it("makes inhibition restraint first-class without selecting expression or action", () => {
    const inhibition = InhibitionDecisionSchema.parse({
      decision_id: "inhibition:hold:1",
      target_ref: ref("agent_agenda_item", "agenda:goal:1"),
      decided_at: NOW,
      decision: "hold",
      reason: "The user is active and the evidence can wait.",
      companion_state_effect: "hold_back",
      updated_maturation_state: "held",
      revisit_condition: {
        kind: "cooldown_elapsed",
        reason: "recheck after cooldown",
      },
      suppressed_alternatives: ["express_to_user", "request_approval"],
      evidence_refs: [sourceRef("user_activity", "activity:focus")],
    });

    expect(inhibition.updated_maturation_state).toBe("held");
    expect(() => InhibitionDecisionSchema.parse({
      ...inhibition,
      decision_id: "inhibition:invalid-selected-outcome",
      selected_outcome: "express_to_user",
    })).toThrow();
    expect(() => InhibitionDecisionSchema.parse({
      ...inhibition,
      decision_id: "inhibition:invalid-decay",
      decision: "decay",
      updated_maturation_state: "mature",
    })).toThrow(/cannot update maturation/);
  });

  it("keeps the Initiative Gate as the only attention boundary that proposes OutcomeClass", () => {
    expect(() => InitiativeGateDecisionSchema.parse({
      decision_id: "gate:block-with-outcome",
      decided_at: NOW,
      status: "blocked",
      input_refs: [ref("inhibition_decision", "inhibition:hold:1")],
      selected_outcome: "express_to_user",
      reason: "blocked gates cannot select outcomes",
    })).toThrow(/must not create an outcome/);

    const selected = InitiativeGateDecisionSchema.parse({
      decision_id: "gate:selected:1",
      decided_at: NOW,
      status: "selected",
      input_refs: [ref("agent_agenda_item", "agenda:goal:1")],
      selected_outcome: "express_to_user",
      reason: "mature, timely, and useful enough to propose expression",
      why_this: "the agenda item has fresh evidence",
      why_now: "the user is interruptible",
      why_this_route: "direct expression is more useful than digest",
      permission_checks: [check("permission")],
      staleness_checks: [check("staleness")],
      sensitivity_checks: [check("safety")],
      side_effect_checks: [check("authority")],
      alternatives_considered: ["add_to_digest", "hold_in_agenda"],
      suppressed_alternatives: ["escalate"],
    });

    expect(selected.selected_outcome).toBe("express_to_user");
    expect(OutcomeClassSchema.safeParse("blocked").success).toBe(false);
    expect(OutcomeClassSchema.safeParse("stale").success).toBe(false);
    expect(OutcomeClassSchema.safeParse("needs_user").success).toBe(false);
    expect(OutcomeClassSchema.safeParse("expired").success).toBe(false);
    expect(OutcomeClassSchema.safeParse("rejected").success).toBe(false);
  });
});

describe("companion autonomy decision contracts", () => {
  it("records runtime-owned OutcomeDecision admission, rejection, and downgrade without fake outcomes", () => {
    const admitted = OutcomeDecisionSchema.parse({
      outcome_decision_id: "outcome:quiet-work",
      initiative_decision_ref: ref("initiative_gate_decision", "gate:selected:quiet-work"),
      decided_at: NOW,
      requested_outcome: "run_authorized_work",
      admission_status: "admitted",
      final_outcome: "run_authorized_work",
      runtime_item_refs: [ref("runtime_item", "runtime:item:quiet-work")],
      authority_checks: [check("authority")],
      staleness_checks: [check("staleness")],
      companion_control_checks: [check("companion_control")],
      safety_checks: [check("safety")],
    });
    expect(admitted.final_outcome).toBe("run_authorized_work");

    expect(() => OutcomeDecisionSchema.parse({
      ...admitted,
      outcome_decision_id: "outcome:quiet-work-invalid-expression",
      expression_decision_ref: ref("expression_decision", "expression:invalid"),
    })).toThrow(/only surface-facing/);

    expect(() => OutcomeDecisionSchema.parse({
      outcome_decision_id: "outcome:rejected-invalid",
      initiative_decision_ref: ref("initiative_gate_decision", "gate:selected:stale"),
      decided_at: NOW,
      requested_outcome: "express_to_user",
      admission_status: "rejected",
      final_outcome: "silence",
      downgrade_or_rejection_reason: {
        code: "stale_target",
        detail: "the Surface was invalidated before admission",
      },
    })).toThrow(/must not invent/);

    expect(() => OutcomeDecisionSchema.parse({
      outcome_decision_id: "outcome:rejected-expression-invalid",
      initiative_decision_ref: ref("initiative_gate_decision", "gate:selected:stale"),
      decided_at: NOW,
      requested_outcome: "express_to_user",
      admission_status: "rejected",
      expression_decision_ref: ref("expression_decision", "expression:must-not-render"),
      downgrade_or_rejection_reason: {
        code: "stale_target",
        detail: "the Surface was invalidated before admission",
      },
    })).toThrow(/must not reference expression decisions/);

    const rejected = OutcomeDecisionSchema.parse({
      outcome_decision_id: "outcome:rejected",
      initiative_decision_ref: ref("initiative_gate_decision", "gate:selected:stale"),
      decided_at: NOW,
      requested_outcome: "express_to_user",
      admission_status: "rejected",
      staleness_checks: [{
        ...check("staleness"),
        status: "failed",
        reason: "surface invalidated",
      }],
      downgrade_or_rejection_reason: {
        code: "stale_target",
        detail: "the Surface was invalidated before admission",
      },
    });
    expect(rejected.final_outcome).toBeUndefined();

    const downgraded = OutcomeDecisionSchema.parse({
      outcome_decision_id: "outcome:digest",
      initiative_decision_ref: ref("initiative_gate_decision", "gate:selected:expression"),
      decided_at: NOW,
      requested_outcome: "express_to_user",
      admission_status: "downgraded",
      final_outcome: "add_to_digest",
      companion_control_checks: [{
        ...check("companion_control"),
        status: "failed",
        reason: "quiet mode blocks immediate expression",
      }],
      downgrade_or_rejection_reason: {
        code: "control_suppressed",
        detail: "quiet mode requires digest instead of immediate expression",
      },
      expression_decision_ref: ref("expression_decision", "expression:digest"),
    });
    expect(downgraded.final_outcome).toBe("add_to_digest");
  });

  it("creates ExpressionDecision only for admitted surface-facing outcomes", () => {
    expect(ExpressionDecisionSchema.parse({
      expression_decision_id: "expression:digest",
      outcome_decision_ref: ref("outcome_decision", "outcome:digest"),
      outcome_class: "add_to_digest",
      created_at: NOW,
      expression_mode: "digest_item",
      target_surface_classes: ["chat", "gui"],
      visibility_policy_ref: ref("visibility_policy", "visibility:digest"),
      user_facing_rationale: "Add the admitted item to the digest.",
    })).toMatchObject({ expression_mode: "digest_item" });

    expect(ExpressionDecisionSchema.parse({
      expression_decision_id: "expression:approval",
      outcome_decision_ref: ref("outcome_decision", "outcome:approval"),
      outcome_class: "request_approval",
      created_at: NOW,
      expression_mode: "approval_request",
      target_surface_classes: ["chat"],
      visibility_policy_ref: ref("visibility_policy", "visibility:approval"),
      user_facing_rationale: "Ask before taking the side-effecting action.",
    })).toMatchObject({ expression_mode: "approval_request" });

    expect(() => ExpressionDecisionSchema.parse({
      expression_decision_id: "expression:invalid-work",
      outcome_decision_ref: ref("outcome_decision", "outcome:quiet-work"),
      outcome_class: "run_authorized_work",
      created_at: NOW,
      expression_mode: "direct_message",
      target_surface_classes: ["chat"],
      visibility_policy_ref: ref("visibility_policy", "visibility:work"),
      user_facing_rationale: "invalid work expression",
    })).toThrow();

    expect(() => ExpressionDecisionSchema.parse({
      expression_decision_id: "expression:invalid-digest-mode",
      outcome_decision_ref: ref("outcome_decision", "outcome:digest"),
      outcome_class: "add_to_digest",
      created_at: NOW,
      expression_mode: "direct_message",
      target_surface_classes: ["chat"],
      visibility_policy_ref: ref("visibility_policy", "visibility:digest"),
      user_facing_rationale: "invalid digest mode",
    })).toThrow(/digest_item/);
  });
});

describe("companion autonomy audit and visibility contracts", () => {
  it("defines inspectable, digest-only, audit-visible, and never-directly-show visibility policies", () => {
    const inspectable = VisibilityPolicySchema.parse({
      visibility_policy_id: "visibility:inspectable-hidden",
      applies_to: [ref("urge_candidate", "urge:low-confidence")],
      hidden_by_default: true,
      visible_in_gui: false,
      visible_in_chat: false,
      visible_in_tui: false,
      visible_in_cli: false,
      visible_in_audit: true,
      visible_in_debug: true,
      digest_only: false,
      never_directly_show: false,
      raw_content_allowed: false,
      rationale: "low-confidence urges are inspection-only",
    });
    expect(canVisibilityPolicyExposeRawContent(inspectable)).toBe(false);

    expect(VisibilityPolicySchema.parse({
      visibility_policy_id: "visibility:digest",
      applies_to: [ref("expression_decision", "expression:digest")],
      hidden_by_default: true,
      visible_in_gui: false,
      visible_in_chat: false,
      visible_in_tui: false,
      visible_in_cli: false,
      visible_in_audit: true,
      visible_in_debug: false,
      digest_only: true,
      visible_in_digest: true,
      never_directly_show: false,
      rationale: "digest items render only through digest surfaces",
    })).toMatchObject({ digest_only: true, visible_in_digest: true });

    const auditVisible = VisibilityPolicySchema.parse({
      visibility_policy_id: "visibility:audit",
      applies_to: [ref("audit_trace", "audit:1")],
      hidden_by_default: true,
      visible_in_gui: false,
      visible_in_chat: false,
      visible_in_tui: false,
      visible_in_cli: false,
      visible_in_audit: true,
      visible_in_debug: false,
      digest_only: false,
      never_directly_show: false,
      raw_content_allowed: true,
      rationale: "active audit state can expose raw non-deleted evidence in audit only",
    });
    expect(canVisibilityPolicyExposeRawContent(auditVisible)).toBe(true);

    const neverShow = VisibilityPolicySchema.parse({
      visibility_policy_id: "visibility:never-direct",
      applies_to: [ref("memory", "memory:sensitive")],
      hidden_by_default: true,
      visible_in_gui: false,
      visible_in_chat: false,
      visible_in_tui: false,
      visible_in_cli: false,
      visible_in_audit: true,
      visible_in_debug: true,
      digest_only: false,
      never_directly_show: true,
      raw_content_allowed: true,
      rationale: "sensitive eligibility calculations may be audited but never directly displayed",
    });
    expect(canVisibilityPolicyExposeRawContent(neverShow)).toBe(false);

    expect(() => VisibilityPolicySchema.parse({
      visibility_policy_id: "visibility:deleted-invalid",
      applies_to: [ref("memory", "memory:deleted")],
      hidden_by_default: true,
      visible_in_gui: false,
      visible_in_chat: false,
      visible_in_tui: false,
      visible_in_cli: false,
      visible_in_audit: true,
      visible_in_debug: true,
      digest_only: false,
      never_directly_show: false,
      content_lifecycle: "deleted",
      redaction_required: false,
      raw_content_allowed: true,
      rationale: "invalid deleted content policy",
    })).toThrow(/cannot be exposed/);
  });

  it("creates an AuditTrace for attention-to-runtime decisions without exposing deleted content", () => {
    const trace = AuditTraceSchema.parse({
      trace_id: "audit:attention-runtime:1",
      subject_ref: ref("outcome_decision", "outcome:digest"),
      trigger_refs: [sourceRef("initiative_gate_decision", "gate:selected:expression")],
      surface_refs: [ref("surface", "surface:current")],
      memory_refs: [sourceRef("memory", "memory:promise:1")],
      permission_checks: [check("permission")],
      staleness_checks: [check("staleness")],
      authority_checks: [check("authority")],
      safety_checks: [check("safety")],
      redaction_state: {
        state: "none",
        redaction_applied: false,
      },
      attention_decision_refs: [
        ref("initiative_gate_decision", "gate:selected:expression"),
        ref("outcome_decision", "outcome:digest"),
      ],
      companion_state_refs: [ref("companion_state", "companion-state:1")],
      actions_taken: [{
        record_id: "audit-record:decision",
        summary: "Runtime downgraded immediate expression to digest.",
      }],
      actions_withheld: [{
        record_id: "audit-record:withheld",
        summary: "Immediate user-facing expression was withheld.",
      }],
      quiet_work: [{
        record_id: "audit-record:quiet-work",
        summary: "The item remains available for digest rendering.",
      }],
      suppressed_alternatives: [{
        record_id: "audit-record:suppressed",
        summary: "Escalation was not selected.",
      }],
      user_visible_outputs: [{
        record_id: "audit-record:visible",
        summary: "A digest item can mention the admitted non-deleted summary.",
      }],
      repair_options: ["stop", "narrow", "reground"],
      visibility_policy_refs: [ref("visibility_policy", "visibility:digest")],
      created_at: NOW,
    });

    expect(trace.repair_options).toEqual(["stop", "narrow", "reground"]);

    expect(() => AuditTraceSchema.parse({
      ...trace,
      trace_id: "audit:deleted-invalid",
      memory_refs: [sourceRef("memory", "memory:deleted", "deleted")],
      redaction_state: {
        state: "none",
        redaction_applied: false,
      },
    })).toThrow(/require redaction/);

    expect(() => AuditTraceSchema.parse({
      ...trace,
      trace_id: "audit:deleted-visible-invalid",
      memory_refs: [sourceRef("memory", "memory:deleted", "deleted")],
      redaction_state: {
        state: "redacted",
        redaction_applied: true,
      },
      user_visible_outputs: [{
        record_id: "audit-record:leak",
        summary: "invalid deleted content output",
        source_refs: [sourceRef("memory", "memory:deleted", "deleted")],
        redacted: false,
      }],
    })).toThrow(/must be redacted/);

    expect(() => AuditTraceSchema.parse({
      ...trace,
      trace_id: "audit:deleted-action-invalid",
      memory_refs: [sourceRef("memory", "memory:deleted", "deleted")],
      redaction_state: {
        state: "redacted",
        redaction_applied: true,
      },
      actions_taken: [{
        record_id: "audit-record:action-leak",
        summary: "invalid deleted content action",
        source_refs: [sourceRef("memory", "memory:deleted", "deleted")],
        redacted: false,
      }],
    })).toThrow(/must be redacted/);

    const redactedQuietWork = AuditTraceSchema.parse({
      ...trace,
      trace_id: "audit:deleted-quiet-redacted",
      memory_refs: [sourceRef("memory", "memory:deleted", "deleted")],
      redaction_state: {
        state: "redacted",
        redaction_applied: true,
      },
      quiet_work: [{
        record_id: "audit-record:quiet-redacted",
        summary: "Redacted quiet-work audit record.",
        source_refs: [sourceRef("memory", "memory:deleted", "deleted")],
        redacted: true,
      }],
    });
    expect(redactedQuietWork.quiet_work[0]?.redacted).toBe(true);

    expect(() => AuditTraceSchema.parse({
      ...trace,
      trace_id: "audit:deleted-check-evidence-invalid",
      permission_checks: [{
        ...check("permission"),
        evidence_refs: [sourceRef("memory", "memory:deleted-permission", "deleted")],
      }],
      redaction_state: {
        state: "none",
        redaction_applied: false,
      },
    })).toThrow(/require redaction/);
  });

  it("keeps permission grant boundaries explicit without treating grants as evaluator bypasses", () => {
    const boundary = PermissionGrantBoundarySchema.parse({
      grant_id: "grant:1",
      state: "active",
      capabilities: ["write_workspace", "run_tests"],
      excluded_capabilities: [
        "destructive_action",
        "delete",
        "write_remote",
        "network_send",
        "external_send",
        "secret_change",
        "protected_path_mutation",
        "production_mutation",
        "unknown_capability",
      ],
      visibility_policy_ref: ref("visibility_policy", "visibility:permission-grant"),
      audit_refs: ["audit:permission-grant"],
    });

    expect(boundary.excluded_capabilities).toContain("external_send");
    expect(boundary.excluded_capabilities).toContain("unknown_capability");
  });
});
