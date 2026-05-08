import { describe, expect, it } from "vitest";
import {
  CompanionStateReducerInputSchema,
  RuntimeItemSchema,
  deriveCompanionStateSnapshot,
  parseAuthorityFailClosed,
  parseStalenessFailClosed,
  type Authority,
  type CompanionGlobalControlEntry,
  type CompanionStateReducerInput,
  type ControlPolicy,
  type RuntimeItem,
  type Staleness,
} from "../index.js";

const NOW = "2026-05-08T00:00:00.000Z";

const allowInspectOnlyAuthority: Authority = {
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
  authority_reason: "test inspect-only authority",
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
};

const inspectOnlyPolicy: ControlPolicy = {
  allowed_controls: ["inspect_item"],
  forbidden_controls: ["resume_item", "finalize_item"],
  required_confirmation: ["resume_item"],
  repair_options: ["reground_item"],
  reason: "test policy",
};

function makeControl(
  control: CompanionGlobalControlEntry["control"],
  state: CompanionGlobalControlEntry["state"] = "active"
): CompanionGlobalControlEntry {
  return {
    control,
    state,
    source_ref: `control:${control}:${state}`,
    updated_at: NOW,
    reason: "test control",
  };
}

function makeRuntimeItem(input: Partial<RuntimeItem> = {}): RuntimeItem {
  return RuntimeItemSchema.parse({
    schema_version: "runtime-item-v1",
    id: "run:quiet-work-1",
    type: "quiet_work",
    status: "running",
    posture: "working",
    source: "runtime-control-test",
    created_at: NOW,
    updated_at: NOW,
    related_goal_refs: ["goal:1"],
    related_session_refs: ["session:1"],
    related_memory_refs: [],
    related_surface_refs: ["surface:1"],
    authority: allowInspectOnlyAuthority,
    staleness: currentStaleness,
    companion_state_refs: [],
    visibility_policy_ref: null,
    control_policy: inspectOnlyPolicy,
    audit_trace_refs: ["audit:1"],
    ...input,
  });
}

function makeReducerInput(input: Partial<CompanionStateReducerInput> = {}): CompanionStateReducerInput {
  return CompanionStateReducerInputSchema.parse({
    schema_version: "companion-state-reducer-input-v1",
    runtime_items: [makeRuntimeItem()],
    recent_runtime_events: ["runtime-event:1"],
    active_surface_ref: "surface:1",
    surface_invalidation_events: [],
    global_controls: [makeControl("inspect_companion_state", "inactive")],
    active_goal_refs: ["goal:1"],
    active_watch_refs: [],
    active_wait_refs: [],
    active_quiet_work_refs: ["run:quiet-work-1"],
    control_overlays: [],
    pre_suspend_mode: null,
    authority_blockers: [],
    staleness_blockers: [],
    safety_blockers: [],
    user_activity_refs: ["activity:1"],
    feedback_refs: [],
    event_high_watermark: "event:1",
    current_time: NOW,
    ...input,
  });
}

describe("CompanionState runtime-control contracts", () => {
  it("keeps mechanical RuntimeItem status separate from runtime posture", () => {
    const item = makeRuntimeItem({
      status: "completed",
      posture: "needs_user",
    });

    expect(item.status).toBe("completed");
    expect(item.posture).toBe("needs_user");
  });

  it("fails Authority closed when required authority evidence is missing", () => {
    const authority = parseAuthorityFailClosed({
      inspectable: true,
      authority_reason: "partial authority must not grant action",
    });

    expect(authority).toMatchObject({
      inspectable: false,
      resumable: false,
      actionable: false,
      speakable: false,
      can_create_urge: false,
      can_update_surface: false,
      can_write_memory: false,
      can_delegate_work: false,
      requires_confirmation: true,
      approval_scope: "none",
    });
  });

  it("fails Staleness closed across all dimensions when staleness evidence is contradictory", () => {
    const staleness = parseStalenessFailClosed({
      temporal: { outcome: "current", reason: "fresh" },
      session: { outcome: "current", reason: "fresh" },
      surface: { outcome: "unknown", reason: "not a contract outcome" },
    });

    expect(Object.values(staleness).every((dimension) => dimension.outcome === "rejected")).toBe(true);
  });

  it("forces suspend_companion to select suspended and hold active runtime refs", () => {
    const snapshot = deriveCompanionStateSnapshot(makeReducerInput({
      global_controls: [makeControl("suspend_companion")],
    }));

    expect(snapshot.mode).toBe("suspended");
    expect(snapshot.control_overlays).toContain("suspend_companion");
    expect(snapshot.pre_suspend_mode).toBe("working");
    expect(snapshot.active_refs).toEqual([]);
    expect(snapshot.held_runtime_refs).toEqual(["run:quiet-work-1"]);
    expect(snapshot.blocked_refs).toContain("run:quiet-work-1");
    expect(snapshot.derivation_trace.reason).toBe("suspend_companion_fail_closed");
  });

  it("fails closed when global companion-control state is missing", () => {
    const snapshot = deriveCompanionStateSnapshot(makeReducerInput({
      global_controls: [],
    }));

    expect(snapshot.mode).toBe("needs_user");
    expect(snapshot.control_overlays).toEqual([
      "pause_proactivity",
      "require_confirmation_for_proactivity",
    ]);
    expect(snapshot.blocked_refs).toContain("global_controls");
    expect(snapshot.derivation_trace.rejected_modes).toEqual([
      "working",
      "watching",
      "reaching_out",
      "escalating",
    ]);
  });

  it("fails closed when companion-wide control state is ambiguous", () => {
    const snapshot = deriveCompanionStateSnapshot(makeReducerInput({
      global_controls: [makeControl("resume_companion", "ambiguous")],
    }));

    expect(snapshot.mode).toBe("needs_user");
    expect(snapshot.control_overlays).toContain("pause_proactivity");
    expect(snapshot.control_overlays).toContain("require_confirmation_for_proactivity");
    expect(snapshot.blocked_refs).toEqual(["control:resume_companion:ambiguous"]);
    expect(snapshot.derivation_trace.reason).toBe("ambiguous_global_control_state_fail_closed");
  });

  it("selects quieted mode from active global controls without duplicated overlays", () => {
    const snapshot = deriveCompanionStateSnapshot(makeReducerInput({
      global_controls: [makeControl("enter_quiet_mode")],
      control_overlays: [],
    }));

    expect(snapshot.mode).toBe("quieted");
    expect(snapshot.control_overlays).toEqual(["enter_quiet_mode"]);
  });

  it("selects proactivity_paused mode from active global controls without duplicated overlays", () => {
    const snapshot = deriveCompanionStateSnapshot(makeReducerInput({
      global_controls: [makeControl("pause_proactivity")],
      control_overlays: [],
    }));

    expect(snapshot.mode).toBe("proactivity_paused");
    expect(snapshot.control_overlays).toEqual(["pause_proactivity"]);
  });

  it("returns the same snapshot for the same parsed input and high-watermark", () => {
    const input = makeReducerInput({
      global_controls: [makeControl("pause_proactivity")],
      control_overlays: [],
    });

    expect(deriveCompanionStateSnapshot(input)).toEqual(deriveCompanionStateSnapshot(input));
  });
});
