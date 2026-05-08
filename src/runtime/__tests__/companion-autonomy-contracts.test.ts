import { describe, expect, it } from "vitest";
import {
  AgentAgendaItemSchema,
  AuditTraceSchema,
  canVisibilityPolicyExposeRawContent,
  ExpressionDecisionSchema,
  InitiativeGateDecisionSchema,
  OutcomeDecisionSchema,
  PermissionGrantBoundarySchema,
  UrgeCandidateSchema,
  VisibilityPolicySchema,
} from "../types/companion-autonomy.js";

const sourceRef = {
  ref: {
    kind: "surface",
    id: "surface-current",
  },
};

describe("companion autonomy contract skeletons", () => {
  it("keeps attention signals as internal candidates before agenda and gate decisions", () => {
    const urge = UrgeCandidateSchema.parse({
      urge_id: "urge-1",
      kind: "curiosity",
      created_at: 100,
      source_refs: [sourceRef],
      proposed_agenda_kind: "watch",
      priority_hint: "normal",
      confidence: 0.75,
      maturation: {
        state: "candidate",
        eligible_at: 120,
      },
    });
    expect(urge).toMatchObject({
      schema_version: "urge-candidate-v1",
      proposed_agenda_kind: "watch",
    });

    const agenda = AgentAgendaItemSchema.parse({
      agenda_item_id: "agenda-1",
      kind: "watch",
      created_at: 120,
      updated_at: 120,
      state: "ready_for_gate",
      source_urge_ids: [urge.urge_id],
      source_refs: [sourceRef],
    });
    expect(agenda.source_urge_ids).toEqual(["urge-1"]);

    expect(() => InitiativeGateDecisionSchema.parse({
      decision_id: "gate-1",
      agenda_item_id: "agenda-1",
      decided_at: 130,
      status: "blocked",
      selected_outcome: "expression",
    })).toThrow(/must not create an outcome/);

    expect(InitiativeGateDecisionSchema.parse({
      decision_id: "gate-2",
      agenda_item_id: "agenda-1",
      decided_at: 131,
      status: "admitted",
      selected_outcome: "watch",
    })).toMatchObject({ selected_outcome: "watch" });
  });

  it("records rejected and downgraded outcomes without fake final outcomes", () => {
    expect(() => OutcomeDecisionSchema.parse({
      outcome_decision_id: "outcome-rejected",
      gate_decision_id: "gate-1",
      decided_at: 140,
      requested_outcome: "expression",
      status: "rejected",
      final_outcome: "silence",
      rejection: {
        code: "permission_denied",
        evidence_refs: [],
      },
    })).toThrow(/must not invent a final outcome/);

    expect(OutcomeDecisionSchema.parse({
      outcome_decision_id: "outcome-rejected",
      gate_decision_id: "gate-1",
      decided_at: 140,
      requested_outcome: "expression",
      status: "rejected",
      rejection: {
        code: "permission_denied",
        evidence_refs: [],
      },
    })).toMatchObject({
      status: "rejected",
      rejection: {
        code: "permission_denied",
      },
    });

    expect(OutcomeDecisionSchema.parse({
      outcome_decision_id: "outcome-digest",
      gate_decision_id: "gate-2",
      decided_at: 150,
      requested_outcome: "expression",
      status: "downgraded",
      final_outcome: "digest_item",
    })).toMatchObject({
      status: "downgraded",
      final_outcome: "digest_item",
    });

    expect(ExpressionDecisionSchema.parse({
      expression_decision_id: "expression-digest",
      outcome_decision_id: "outcome-digest",
      created_at: 151,
      expression_mode: "digest_item",
    })).toMatchObject({ expression_mode: "digest_item" });
  });

  it("requires deletion and tombstone redaction across visibility and audit traces", () => {
    expect(() => VisibilityPolicySchema.parse({
      policy_id: "visibility-deleted",
      mode: "audit_visible",
      applies_to: [{ kind: "memory", id: "memory-deleted" }],
      content_lifecycle: "deleted",
      redaction_required: false,
      raw_content_allowed: true,
    })).toThrow(/cannot be exposed/);

    const policy = VisibilityPolicySchema.parse({
      policy_id: "visibility-tombstone",
      mode: "audit_visible",
      applies_to: [{ kind: "memory", id: "memory-tombstone" }],
      content_lifecycle: "tombstone",
      redaction_required: true,
      raw_content_allowed: false,
      inspectable_summary: "A removed memory affected this decision.",
    });
    expect(canVisibilityPolicyExposeRawContent(policy)).toBe(false);

    expect(() => AuditTraceSchema.parse({
      trace_id: "audit-1",
      created_at: 160,
      subject_refs: [{ kind: "runtime_item", id: "item-1" }],
      events: [{
        event_id: "event-1",
        kind: "permission_checked",
        occurred_at: 161,
        evidence_refs: [{
          ref: { kind: "memory", id: "memory-deleted" },
          lifecycle: "deleted",
        }],
        redaction_applied: false,
      }],
    })).toThrow(/require redaction/);
  });

  it("exposes permission grant boundaries without treating grants as hard-policy bypasses", () => {
    const boundary = PermissionGrantBoundarySchema.parse({
      grant_id: "grant-1",
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
      audit_refs: ["audit:grant-1"],
    });

    expect(boundary.excluded_capabilities).toContain("external_send");
    expect(boundary.excluded_capabilities).toContain("unknown_capability");
  });
});
