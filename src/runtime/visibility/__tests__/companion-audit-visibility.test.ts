import { describe, expect, it } from "vitest";
import {
  OutcomeDecisionSchema,
  type AuditRepairOption,
  type AutonomyCheck,
  type CompanionAutonomyContentLifecycle,
  type CompanionAutonomyRef,
  type CompanionAutonomySourceRef,
  type OutcomeDecision,
} from "../../types/companion-autonomy.js";
import {
  CompanionStateSnapshotSchema,
  RuntimeItemSchema,
  type Authority,
  type CompanionStateSnapshot,
  type ControlPolicy,
  type RuntimeItem,
  type Staleness,
} from "../../types/companion-state.js";
import {
  createAuditInspectionView,
  createAuditRepairAction,
  createAutonomyAuditTrace,
  createCompanionStateInspectionView,
  createCompanionVisibilityPolicy,
  deriveAuditRepairOptions,
  renderVisibilityPolicyForSurface,
  runtimeItemVisibilityFromPolicy,
} from "../index.js";

const NOW = "2026-05-08T00:00:00.000Z";

function ref(kind: CompanionAutonomyRef["kind"], id: string): CompanionAutonomyRef {
  return { kind, id };
}

function sourceRef(
  kind: CompanionAutonomyRef["kind"],
  id: string,
  lifecycle: CompanionAutonomyContentLifecycle = "active"
): CompanionAutonomySourceRef {
  return {
    ref: ref(kind, id),
    lifecycle,
  };
}

function check(
  kind: AutonomyCheck["kind"],
  status: AutonomyCheck["status"] = "passed"
): AutonomyCheck {
  return {
    check_id: `${kind}:check`,
    kind,
    status,
    reason: `${kind} ${status}`,
    evidence_refs: [],
  };
}

const operationalAuthority: Authority = {
  inspectable: true,
  resumable: true,
  actionable: true,
  speakable: false,
  can_create_urge: false,
  can_update_surface: true,
  can_write_memory: false,
  can_delegate_work: false,
  requires_confirmation: false,
  approval_scope: "bounded_runtime_item",
  authority_reason: "bounded runtime controls are available",
};

const inspectOnlyAuthority: Authority = {
  inspectable: true,
  resumable: false,
  actionable: false,
  speakable: false,
  can_create_urge: false,
  can_update_surface: false,
  can_write_memory: false,
  can_delegate_work: false,
  requires_confirmation: true,
  approval_scope: "inspect_only",
  authority_reason: "inspection is available but action is not",
};

const currentStaleness: Staleness = {
  temporal: { outcome: "current", reason: "fresh test time" },
  world: { outcome: "current", reason: "world current" },
  project: { outcome: "current", reason: "project current" },
  permission: { outcome: "current", reason: "permission current" },
  relationship: { outcome: "current", reason: "relationship current" },
  surface: { outcome: "current", reason: "surface current" },
  goal: { outcome: "current", reason: "goal current" },
  assumption: { outcome: "current", reason: "assumption current" },
  session: { outcome: "current", reason: "session current" },
  browser_session: { outcome: "current", reason: "browser session current" },
  auth_handoff: { outcome: "current", reason: "auth handoff current" },
};

const fullRepairPolicy: ControlPolicy = {
  allowed_controls: [
    "inspect_item",
    "pause_item",
    "cancel_item",
    "forget_item",
    "reground_item",
    "revoke_permission",
    "narrow_permission",
    "require_confirmation",
  ],
  forbidden_controls: [],
  required_confirmation: ["forget_item", "revoke_permission"],
  repair_options: [
    "inspect_item",
    "cancel_item",
    "forget_item",
    "reground_item",
    "revoke_permission",
    "narrow_permission",
    "require_confirmation",
  ],
  reason: "all test repair controls are available",
};

function outcomeDecision(input: Partial<OutcomeDecision> = {}): OutcomeDecision {
  return OutcomeDecisionSchema.parse({
    outcome_decision_id: "outcome:quiet-work",
    initiative_decision_ref: ref("initiative_gate_decision", "gate:quiet-work"),
    decided_at: NOW,
    requested_outcome: "run_authorized_work",
    admission_status: "admitted",
    final_outcome: "run_authorized_work",
    runtime_item_refs: [ref("runtime_item", "runtime:item:quiet-work")],
    authority_checks: [check("authority")],
    staleness_checks: [check("staleness")],
    companion_control_checks: [check("companion_control")],
    safety_checks: [check("safety")],
    ...input,
  });
}

function runtimeItem(input: Partial<RuntimeItem> = {}): RuntimeItem {
  return RuntimeItemSchema.parse({
    schema_version: "runtime-item-v1",
    item_id: "runtime:item:quiet-work",
    type: "run",
    status: "running",
    posture: "working",
    source: "companion-audit-visibility-test",
    created_at: NOW,
    updated_at: NOW,
    related_goal_refs: ["goal:1"],
    related_task_refs: [],
    related_session_refs: ["session:1"],
    related_memory_refs: [],
    related_surface_refs: ["surface:1"],
    related_agenda_refs: ["agenda:1"],
    companion_state_refs: ["companion-state:1"],
    companion_control_state: {
      active_controls: [],
      global_control_refs: [],
      held_by_controls: [],
      rejected_by_controls: [],
      reason: "no active companion-wide control",
    },
    authority: operationalAuthority,
    staleness: currentStaleness,
    visibility_policy: {
      display: "normal",
      inspectable: true,
      auditable: true,
      policy_ref: null,
      reason: "normal visibility",
    },
    visibility_policy_ref: null,
    control_policy: fullRepairPolicy,
    audit_trace_refs: ["audit:quiet-work"],
    ...input,
  });
}

function companionSnapshot(input: Partial<CompanionStateSnapshot> = {}): CompanionStateSnapshot {
  return CompanionStateSnapshotSchema.parse({
    schema_version: "companion-state-snapshot-v1",
    snapshot_id: "companion-state:1",
    computed_at: NOW,
    source_event_high_watermark: "event:42",
    active_surface_ref: "surface:1",
    global_control_state_ref: "global-control:1",
    mode: "working",
    control_overlays: ["require_confirmation_for_proactivity"],
    current_capacity: "constrained",
    interruption_budget: 0.25,
    quiet_work_budget: 0.75,
    budgets: {
      quiet_work: 0.75,
      interruption: 0.25,
    },
    attention_thresholds: {
      speak: 0.8,
    },
    expression_thresholds: {
      chat: 0.85,
    },
    threshold_overrides: {},
    cooldowns: [],
    waiting_conditions: [],
    blocked_refs: ["runtime:item:blocked"],
    blocked_by_boundary_refs: [],
    needs_user_refs: [],
    stale_refs: ["runtime:item:stale"],
    stale_surface_refs: [],
    invalidated_refs: [],
    invalidated_surface_refs: [],
    active_refs: ["runtime:item:quiet-work"],
    active_watch_refs: ["watch:1"],
    active_wait_refs: ["wait:1"],
    active_quiet_work_refs: ["runtime:item:quiet-work"],
    pre_suspend_mode: null,
    held_runtime_refs: ["runtime:item:held"],
    derivation_trace: {
      input_refs: ["runtime:item:quiet-work"],
      matched_control_refs: ["global-control:1"],
      matched_blocker_refs: [],
      matched_feedback_refs: [],
      matched_activity_refs: [],
      selected_mode: "working",
      budget_changes: ["quiet_work_budget"],
      threshold_changes: ["speak"],
      rejected_modes: ["reaching_out"],
      reason: "quiet work is active under confirmation overlay",
    },
    ...input,
  });
}

describe("companion audit and visibility runtime helpers", () => {
  it("records silence, withheld outcomes, quiet work, and suppressed alternatives before any user-visible output", () => {
    const quietTrace = createAutonomyAuditTrace({
      trace_id: "audit:quiet-work",
      subject_ref: ref("outcome_decision", "outcome:quiet-work"),
      trigger_refs: [sourceRef("initiative_gate_decision", "gate:quiet-work")],
      created_at: NOW,
      outcome_decision: outcomeDecision(),
      repair_options: ["stop", "inspect"],
      suppressed_outcomes: ["express_to_user", "escalate"],
      visibility_policy_refs: [ref("visibility_policy", "visibility:inspectable-hidden")],
    });

    expect(quietTrace.quiet_work.map((record) => record.summary).join("\n"))
      .toContain("run_authorized_work");
    expect(quietTrace.user_visible_outputs).toEqual([]);
    expect(quietTrace.suppressed_alternatives).toHaveLength(2);

    const silenceTrace = createAutonomyAuditTrace({
      trace_id: "audit:silence",
      subject_ref: ref("outcome_decision", "outcome:silence"),
      trigger_refs: [sourceRef("initiative_gate_decision", "gate:silence")],
      created_at: NOW,
      outcome_decision: outcomeDecision({
        outcome_decision_id: "outcome:silence",
        initiative_decision_ref: ref("initiative_gate_decision", "gate:silence"),
        requested_outcome: "silence",
        admission_status: "admitted",
        final_outcome: "silence",
        runtime_item_refs: [],
      }),
      repair_options: ["inspect"],
    });

    expect(silenceTrace.actions_taken).toEqual([
      expect.objectContaining({
        summary: expect.stringContaining("silence"),
      }),
    ]);
    expect(silenceTrace.user_visible_outputs).toEqual([]);

    const withheldTrace = createAutonomyAuditTrace({
      trace_id: "audit:withheld-expression",
      subject_ref: ref("outcome_decision", "outcome:withheld-expression"),
      trigger_refs: [sourceRef("initiative_gate_decision", "gate:withheld-expression")],
      created_at: NOW,
      outcome_decision: outcomeDecision({
        outcome_decision_id: "outcome:withheld-expression",
        initiative_decision_ref: ref("initiative_gate_decision", "gate:withheld-expression"),
        requested_outcome: "express_to_user",
        admission_status: "held",
        final_outcome: undefined,
        runtime_item_refs: [],
      }),
      repair_options: ["inspect", "reground"],
    });

    expect(withheldTrace.actions_withheld).toEqual([
      expect.objectContaining({
        summary: expect.stringContaining("express_to_user"),
      }),
    ]);
    expect(withheldTrace.user_visible_outputs).toEqual([]);
  });

  it("derives repair affordances from typed authority and runtime control policy", () => {
    const item = runtimeItem();

    expect(deriveAuditRepairOptions({
      authority: item.authority,
      control_policy: item.control_policy,
      extra_options: ["suppress"],
    })).toEqual([
      "inspect",
      "stop",
      "forget",
      "reground",
      "revoke",
      "narrow",
      "retry",
      "suppress",
    ] satisfies AuditRepairOption[]);

    expect(createAuditRepairAction({
      option: "stop",
      runtime_item: item,
      reason: "user asked quiet work to stop",
    })).toMatchObject({
      kind: "runtime_control",
      control: "cancel_item",
      requires_confirmation: false,
    });

    expect(createAuditRepairAction({
      option: "forget",
      runtime_item: item,
      reason: "memory-derived runtime item should be forgotten",
    })).toMatchObject({
      kind: "memory_correction",
      control: "forget_item",
      requires_confirmation: true,
    });

    expect(createAuditRepairAction({
      option: "narrow",
      runtime_item: item,
      reason: "permission should be narrowed",
    })).toMatchObject({
      kind: "permission_control",
      control: "narrow_permission",
    });

    expect(createAuditRepairAction({
      option: "suppress",
      runtime_item: item,
      reason: "surface projection should be suppressed",
      extra_options: ["suppress"],
    })).toMatchObject({
      kind: "surface_control",
      control: null,
    });

    const inspectOnlyItem = runtimeItem({
      authority: inspectOnlyAuthority,
      control_policy: {
        ...fullRepairPolicy,
        allowed_controls: ["inspect_item", "reground_item"],
        repair_options: ["inspect_item", "reground_item"],
      },
    });

    expect(deriveAuditRepairOptions({
      authority: inspectOnlyItem.authority,
      control_policy: inspectOnlyItem.control_policy,
    })).toEqual(["inspect", "reground"]);
    expect(() => createAuditRepairAction({
      option: "revoke",
      runtime_item: inspectOnlyItem,
      reason: "not authorized",
    })).toThrow(/not available/);
  });

  it("keeps hidden, digest-only, audit-visible, never-direct, and redacted policies consistent across surfaces", () => {
    const inspectableHidden = createCompanionVisibilityPolicy({
      visibility_policy_id: "visibility:inspectable-hidden",
      applies_to: [ref("runtime_item", "runtime:item:quiet-work")],
      preset: "inspectable_hidden",
      rationale: "quiet work is inspectable but not directly rendered",
      inspectable_summary: "quiet work held for inspection",
    });
    expect(renderVisibilityPolicyForSurface(inspectableHidden, "chat")).toMatchObject({
      visible: false,
      raw_content_allowed: false,
      inspectable: true,
    });
    expect(renderVisibilityPolicyForSurface(inspectableHidden, "audit")).toMatchObject({
      visible: true,
      raw_content_allowed: false,
    });
    expect(runtimeItemVisibilityFromPolicy(inspectableHidden)).toMatchObject({
      display: "hidden",
      inspectable: true,
      auditable: true,
    });

    const digestOnly = createCompanionVisibilityPolicy({
      visibility_policy_id: "visibility:digest-only",
      applies_to: [ref("expression_decision", "expression:digest")],
      preset: "digest_only",
      rationale: "item can render only through digest",
    });
    expect(renderVisibilityPolicyForSurface(digestOnly, "chat").visible).toBe(false);
    expect(renderVisibilityPolicyForSurface(digestOnly, "tui").visible).toBe(false);
    expect(renderVisibilityPolicyForSurface(digestOnly, "digest").visible).toBe(true);

    const auditVisible = createCompanionVisibilityPolicy({
      visibility_policy_id: "visibility:audit-visible",
      applies_to: [ref("audit_trace", "audit:quiet-work")],
      preset: "audit_visible",
      rationale: "audit-only active trace can expose raw details in audit",
    });
    expect(renderVisibilityPolicyForSurface(auditVisible, "audit")).toMatchObject({
      visible: true,
      raw_content_allowed: true,
    });
    expect(renderVisibilityPolicyForSurface(auditVisible, "gateway").visible).toBe(false);

    const neverDirect = createCompanionVisibilityPolicy({
      visibility_policy_id: "visibility:never-direct",
      applies_to: [ref("memory", "memory:sensitive")],
      preset: "never_direct",
      rationale: "sensitive eligibility metadata is audit-only",
    });
    expect(renderVisibilityPolicyForSurface(neverDirect, "chat").visible).toBe(false);
    expect(renderVisibilityPolicyForSurface(neverDirect, "audit")).toMatchObject({
      visible: true,
      raw_content_allowed: false,
    });

    const redacted = createCompanionVisibilityPolicy({
      visibility_policy_id: "visibility:redacted",
      applies_to: [ref("memory", "memory:removed")],
      preset: "redacted",
      content_lifecycle: "deleted",
      rationale: "removed memory can expose only tombstone metadata",
    });
    expect(renderVisibilityPolicyForSurface(redacted, "audit")).toMatchObject({
      visible: true,
      raw_content_allowed: false,
      redacted: true,
    });
  });

  it("redacts deleted and tombstoned content through audit inspection and companion-state inspection", () => {
    const trace = createAutonomyAuditTrace({
      trace_id: "audit:redaction",
      subject_ref: ref("outcome_decision", "outcome:redaction"),
      trigger_refs: [sourceRef("memory", "deleted-secret-raw", "deleted")],
      created_at: NOW,
      actions_taken: [{
        record_id: "audit-record:deleted-source",
        summary: "RAW DELETED SECRET should not survive inspection",
        source_refs: [sourceRef("memory", "deleted-secret-raw", "deleted")],
        redacted: false,
      }],
      user_visible_outputs: [{
        record_id: "audit-record:tombstone-source",
        summary: "TOMBSTONE DETAIL should not survive inspection",
        source_refs: [sourceRef("memory", "tombstone-secret-raw", "tombstone")],
        redacted: false,
      }],
      memory_refs: [
        sourceRef("memory", "deleted-secret-raw", "deleted"),
        sourceRef("memory", "tombstone-secret-raw", "tombstone"),
      ],
      repair_options: ["forget", "inspect"],
    });

    expect(trace.redaction_state).toMatchObject({
      state: "deleted_source_removed",
      redaction_applied: true,
      deleted_content_visible: false,
    });
    expect(JSON.stringify(trace)).not.toContain("RAW DELETED SECRET");
    expect(JSON.stringify(trace)).not.toContain("TOMBSTONE DETAIL");
    expect(JSON.stringify(trace)).not.toContain("deleted-secret-raw");

    const auditView = createAuditInspectionView(trace);
    expect(JSON.stringify(auditView)).not.toContain("RAW DELETED SECRET");
    expect(JSON.stringify(auditView)).not.toContain("tombstone-secret-raw");

    const item = runtimeItem({
      visibility_policy: runtimeItemVisibilityFromPolicy(createCompanionVisibilityPolicy({
        visibility_policy_id: "visibility:redacted-runtime-item",
        applies_to: [ref("runtime_item", "runtime:item:redacted")],
        preset: "redacted",
        content_lifecycle: "tombstone",
        rationale: "runtime item is backed by removed source content",
      })),
    });
    const stateView = createCompanionStateInspectionView({
      snapshot: companionSnapshot(),
      runtime_items: [item],
      audit_traces: [trace],
    });

    expect(JSON.stringify(stateView)).not.toContain("RAW DELETED SECRET");
    expect(JSON.stringify(stateView)).not.toContain("deleted-secret-raw");
    expect(stateView.audit_traces[0]?.actions_taken[0]).toMatchObject({
      redacted: true,
      summary: expect.stringContaining("Redacted audit record"),
    });
  });

  it("exposes companion-state inspection without mutating snapshot or runtime items", () => {
    const item = runtimeItem();
    const snapshot = companionSnapshot();
    const itemBefore = JSON.stringify(item);
    const snapshotBefore = JSON.stringify(snapshot);

    const view = createCompanionStateInspectionView({
      snapshot,
      runtime_items: [item],
    });

    expect(view).toMatchObject({
      schema_version: "companion-state-inspection-view-v1",
      mode: "working",
      current_capacity: "constrained",
      control_overlays: ["require_confirmation_for_proactivity"],
      held_runtime_refs: ["runtime:item:held"],
      active_quiet_work_refs: ["runtime:item:quiet-work"],
      blocked_refs: ["runtime:item:blocked"],
      stale_refs: ["runtime:item:stale"],
    });
    expect(view.budgets).toEqual({
      interruption_budget: 0.25,
      quiet_work_budget: 0.75,
      named: {
        quiet_work: 0.75,
        interruption: 0.25,
      },
    });
    expect(view.affected_runtime_items[0]).toMatchObject({
      item_id: "runtime:item:quiet-work",
      authority: {
        approval_scope: "bounded_runtime_item",
        inspectable: true,
        actionable: true,
      },
      control_policy: {
        repair_options: expect.arrayContaining(["forget_item", "reground_item"]),
      },
    });
    expect(JSON.stringify(item)).toBe(itemBefore);
    expect(JSON.stringify(snapshot)).toBe(snapshotBefore);

    for (const mode of ["quieted", "suspended", "holding_back"] satisfies CompanionStateSnapshot["mode"][]) {
      const postureSnapshot = companionSnapshot({
        snapshot_id: `companion-state:${mode}`,
        mode,
        pre_suspend_mode: mode === "suspended" ? "working" : null,
      });
      const postureBefore = JSON.stringify(postureSnapshot);
      const postureView = createCompanionStateInspectionView({
        snapshot: postureSnapshot,
        runtime_items: [item],
      });

      expect(postureView.mode).toBe(mode);
      expect(postureView.control_overlays).toEqual(["require_confirmation_for_proactivity"]);
      expect(postureView.held_runtime_refs).toEqual(["runtime:item:held"]);
      expect(JSON.stringify(postureSnapshot)).toBe(postureBefore);
    }
  });

  it("uses one shared visibility policy for chat, TUI, gateway, and audit decisions", () => {
    const policy = createCompanionVisibilityPolicy({
      visibility_policy_id: "visibility:shared-hidden",
      applies_to: [ref("agent_agenda_item", "agenda:hidden")],
      preset: "inspectable_hidden",
      rationale: "agenda detail is hidden from direct surfaces until admitted",
      inspectable_summary: "hidden agenda item",
    });

    expect(renderVisibilityPolicyForSurface(policy, "chat")).toMatchObject({
      visible: false,
      raw_content_allowed: false,
    });
    expect(renderVisibilityPolicyForSurface(policy, "tui")).toMatchObject({
      visible: false,
      raw_content_allowed: false,
    });
    expect(renderVisibilityPolicyForSurface(policy, "gateway")).toMatchObject({
      visible: false,
      raw_content_allowed: false,
    });
    expect(renderVisibilityPolicyForSurface(policy, "audit")).toMatchObject({
      visible: true,
      raw_content_allowed: false,
      summary: "hidden agenda item",
    });

    const directPolicy = createCompanionVisibilityPolicy({
      visibility_policy_id: "visibility:shared-direct",
      applies_to: [ref("runtime_item", "runtime:item:direct")],
      preset: "normal_runtime",
      rationale: "normal runtime item can render on direct surfaces",
    });
    expect(renderVisibilityPolicyForSurface(directPolicy, "chat").visible).toBe(true);
    expect(renderVisibilityPolicyForSurface(directPolicy, "tui").visible).toBe(true);
    expect(renderVisibilityPolicyForSurface(directPolicy, "gateway").raw_content_allowed).toBe(true);
  });
});
