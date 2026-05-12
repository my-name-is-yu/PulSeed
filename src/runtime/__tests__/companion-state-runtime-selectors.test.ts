import { describe, expect, it } from "vitest";
import {
  activeRefsOfType,
  admittedActiveRuntimeRefs,
  deriveRuntimeSignals,
  emptyRuntimeSignals,
  heldRuntimeRefsForControls,
  inputRefs,
  runtimeRefsHeldByCompanionControls,
  selectBlockerMode,
  selectNonSuspendedMode,
} from "../companion-state-runtime-selectors.js";
import {
  CompanionStateReducerInputSchema,
  RuntimeItemSchema,
  type Authority,
  type CompanionStateReducerInput,
  type ControlPolicy,
  type RuntimeItem,
  type Staleness,
} from "../types/companion-state.js";

const NOW = "2026-05-10T00:00:00.000Z";

const operationalAuthority: Authority = {
  inspectable: true,
  resumable: true,
  actionable: true,
  speakable: false,
  can_create_urge: false,
  can_update_surface: false,
  can_write_memory: false,
  can_delegate_work: false,
  requires_confirmation: false,
  approval_scope: "bounded_runtime_item",
  authority_reason: "test bounded runtime authority",
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

const inspectOnlyPolicy: ControlPolicy = {
  allowed_controls: ["inspect_item"],
  forbidden_controls: ["resume_item", "finalize_item"],
  required_confirmation: ["resume_item"],
  repair_options: ["reground_item"],
  reason: "test policy",
};

function makeRuntimeItem(input: Partial<RuntimeItem> = {}): RuntimeItem {
  const itemId = input.item_id ?? input.id ?? "run:quiet-work-1";
  return RuntimeItemSchema.parse({
    schema_version: "runtime-item-v1",
    item_id: itemId,
    type: "run",
    status: "running",
    posture: "working",
    source: "runtime-selector-test",
    created_at: NOW,
    updated_at: NOW,
    related_goal_refs: ["goal:1"],
    related_task_refs: [],
    related_session_refs: ["session:1"],
    related_memory_refs: [],
    related_surface_refs: ["surface:1"],
    related_agenda_refs: [],
    companion_state_refs: [],
    companion_control_state: {
      active_controls: [],
      global_control_refs: [],
      held_by_controls: [],
      rejected_by_controls: [],
      reason: "no active companion-wide controls",
    },
    authority: operationalAuthority,
    staleness: currentStaleness,
    visibility_policy: {
      display: "normal",
      inspectable: true,
      auditable: true,
      policy_ref: null,
      reason: "normal test visibility",
    },
    visibility_policy_ref: null,
    control_policy: inspectOnlyPolicy,
    audit_trace_refs: ["audit:1"],
    ...input,
  });
}

function makeReducerInput(input: Partial<CompanionStateReducerInput> = {}): CompanionStateReducerInput {
  return CompanionStateReducerInputSchema.parse({
    schema_version: "companion-state-reducer-input-v1",
    runtime_items: [],
    recent_runtime_events: [],
    active_surface_ref: "surface:1",
    surface_invalidation_events: [],
    global_control_state_ref: "global-control:1",
    global_controls: [],
    active_goal_refs: ["goal:1"],
    active_watch_refs: [],
    active_wait_refs: [],
    active_quiet_work_refs: [],
    attention_history_refs: [],
    control_overlays: [],
    pre_suspend_mode: null,
    authority_blockers: [],
    staleness_blockers: [],
    safety_blockers: [],
    user_activity_refs: [],
    feedback_refs: [],
    safety_context_refs: [],
    event_high_watermark: "event:1",
    current_time: NOW,
    ...input,
  });
}

describe("companion state runtime selectors", () => {
  it("derives deduplicated blocker signals from runtime item authority, surface, and safety state", () => {
    const permissionStaleItem = makeRuntimeItem({
      item_id: "run:needs-permission",
      staleness: {
        ...currentStaleness,
        permission: { outcome: "needs_review", reason: "permission needs review" },
      },
    });
    const staleSurfaceItem = makeRuntimeItem({
      item_id: "surface:stale",
      type: "surface_projection",
      staleness: {
        ...currentStaleness,
        surface: { outcome: "needs_regrounding", reason: "surface invalidated" },
      },
    });
    const safetyItem = makeRuntimeItem({
      item_id: "guardrail:block",
      type: "guardrail_state",
      status: "blocked",
      posture: "blocked_by_boundary",
    });

    const signals = deriveRuntimeSignals(makeReducerInput({
      runtime_items: [permissionStaleItem, staleSurfaceItem, safetyItem],
      active_surface_ref: null,
      surface_invalidation_events: ["surface:invalidated", "surface:invalidated"],
      authority_blockers: ["manual:authority"],
    }));

    expect(signals.authorityBlockerRefs).toEqual(["manual:authority", "run:needs-permission"]);
    expect(signals.staleSurfaceRefs).toEqual(["active_surface_ref", "surface:stale"]);
    expect(signals.invalidatedSurfaceRefs).toEqual(["surface:invalidated"]);
    expect(signals.safetyBlockerRefs).toEqual(["guardrail:block"]);
    expect(signals.blockedByBoundaryRefs).toEqual(["guardrail:block"]);
  });

  it("selects fail-closed blocker modes in deterministic priority order", () => {
    const signals = {
      ...emptyRuntimeSignals(),
      authorityBlockerRefs: ["auth:1"],
      safetyBlockerRefs: ["safety:1"],
      staleSurfaceRefs: ["surface:1"],
      blockedByBoundaryRefs: ["boundary:1"],
      needsUserRefs: ["user:1"],
    };

    expect(selectBlockerMode(signals)).toMatchObject({
      mode: "overloaded",
      blockedRefs: ["safety:1", "boundary:1"],
      reason: "safety_or_contradictory_runtime_state_fail_closed",
    });

    expect(selectBlockerMode({
      ...emptyRuntimeSignals(),
      authorityBlockerRefs: ["auth:1"],
      needsUserRefs: ["user:1"],
    })).toMatchObject({
      mode: "needs_user",
      blockedRefs: ["auth:1", "user:1"],
    });
  });

  it("applies companion-wide controls to active and held runtime refs", () => {
    const quietWork = makeRuntimeItem({ item_id: "run:quiet", type: "run" });
    const watch = makeRuntimeItem({ item_id: "watch:one", type: "watch", posture: "watching" });
    const agenda = makeRuntimeItem({
      item_id: "agenda:one",
      type: "agent_agenda_item",
      status: "mature",
      posture: "working",
    });

    expect(activeRefsOfType([quietWork, watch, agenda], "watch")).toEqual(["watch:one"]);
    expect(admittedActiveRuntimeRefs([quietWork, watch, agenda], ["stop_all_quiet_work"])).toEqual([
      "watch:one",
      "agenda:one",
    ]);
    expect(heldRuntimeRefsForControls([quietWork, watch, agenda], ["stop_all_quiet_work"])).toEqual(["run:quiet"]);
    expect(runtimeRefsHeldByCompanionControls([quietWork, watch, agenda], ["pause_proactivity"])).toEqual([
      "agenda:one",
    ]);
  });

  it("selects non-suspended modes from controls before item posture fallbacks", () => {
    const input = makeReducerInput({
      runtime_items: [
        makeRuntimeItem({ item_id: "wait:one", type: "wait", posture: "waiting" }),
        makeRuntimeItem({ item_id: "run:working", posture: "working" }),
      ],
    });

    expect(selectNonSuspendedMode(input, ["enter_quiet_mode"], emptyRuntimeSignals())).toBe("quieted");
    expect(selectNonSuspendedMode(input, [], {
      ...emptyRuntimeSignals(),
      waitingConditions: ["wait:one"],
    })).toBe("waiting");
    expect(selectNonSuspendedMode(makeReducerInput({ runtime_items: [] }), [], emptyRuntimeSignals())).toBe("resting");
  });

  it("uses only fresh agent agenda items for attention-derived watching mode", () => {
    const freshAgenda = makeRuntimeItem({
      item_id: "agenda:fresh",
      type: "agent_agenda_item",
      status: "mature",
      posture: "proposed",
      authority: {
        ...operationalAuthority,
        resumable: false,
        actionable: false,
        speakable: false,
        requires_confirmation: true,
        approval_scope: "inspect_only",
      },
    });
    const staleAgenda = makeRuntimeItem({
      ...freshAgenda,
      item_id: "agenda:stale",
      staleness: {
        ...currentStaleness,
        temporal: { outcome: "needs_regrounding", reason: "previous turn agenda is stale" },
      },
    });

    expect(selectNonSuspendedMode(
      makeReducerInput({ runtime_items: [freshAgenda] }),
      [],
      emptyRuntimeSignals(),
    )).toBe("watching");
    expect(selectNonSuspendedMode(
      makeReducerInput({ runtime_items: [staleAgenda] }),
      [],
      emptyRuntimeSignals(),
    )).toBe("resting");
  });

  it("collects deterministic input refs from reducer inputs and structured runtime events", () => {
    const refs = inputRefs(makeReducerInput({
      runtime_items: [makeRuntimeItem({ item_id: "run:1" })],
      recent_runtime_events: [
        "event:string",
        {
          schema_version: "runtime-event-v1",
          event_id: "event:structured",
          event_type: "waiting",
          item_ref: "run:1",
          occurred_at: NOW,
          source: "runtime-selector-test",
          posture_before: "working",
          posture_after: "waiting",
          authority_delta: { before: null, after: null, changed_fields: [] },
          staleness_delta: { before: null, after: null, changed_dimensions: [] },
          companion_control_delta: { before: null, after: null, changed_controls: [] },
          surface_refs: [],
          companion_state_refs: [],
          audit_refs: [],
        },
      ],
      active_wait_refs: ["wait:one", "wait:one"],
      feedback_refs: ["feedback:1"],
    }));

    expect(refs).toEqual([
      "run:1",
      "event:string",
      "event:structured",
      "surface:1",
      "global-control:1",
      "goal:1",
      "wait:one",
      "feedback:1",
    ]);
  });
});
