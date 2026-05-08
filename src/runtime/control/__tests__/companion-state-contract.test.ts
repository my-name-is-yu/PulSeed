import { describe, expect, it } from "vitest";
import {
  SurfaceProjectionSchema,
  attachSurfaceDependencyRef,
  createSurfaceDerivedRuntimeRef,
  invalidateSurfaceProjectionFromMemoryCorrection,
  surfaceInvalidationEventsToRuntimeStateRefs,
} from "../../../grounding/surface-contracts.js";
import {
  CompanionStateReducerInputSchema,
  RuntimeEventSchema,
  RuntimeItemSchema,
  RuntimeItemTypeSchema,
  assembleCompanionStateReducerInput,
  deriveCompanionStateSnapshot,
  deriveRuntimeItemControlPolicy,
  evaluateCompanionStateSnapshotFreshness,
  parseAuthorityFailClosed,
  parseStalenessFailClosed,
  type Authority,
  type CompanionGlobalControlEntry,
  type CompanionStateReducerInput,
  type ControlPolicy,
  type RuntimeEvent,
  type RuntimeItem,
  type Staleness,
} from "../index.js";

const NOW = "2026-05-08T00:00:00.000Z";

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
    changed_by: null,
    affected_runtime_refs: [],
    audit_refs: [],
  };
}

function makeRuntimeItem(input: Partial<RuntimeItem> = {}): RuntimeItem {
  const itemId = input.item_id ?? input.id ?? "run:quiet-work-1";
  return RuntimeItemSchema.parse({
    schema_version: "runtime-item-v1",
    item_id: itemId,
    type: "run",
    status: "running",
    posture: "working",
    source: "runtime-control-test",
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

function makeRuntimeEvent(input: Partial<RuntimeEvent> = {}): RuntimeEvent {
  return RuntimeEventSchema.parse({
    schema_version: "runtime-event-v1",
    event_id: "runtime-event:1",
    event_type: "working",
    item_ref: "run:quiet-work-1",
    occurred_at: NOW,
    source: "runtime-control-test",
    posture_before: "waiting",
    posture_after: "working",
    authority_delta: {
      before: null,
      after: operationalAuthority,
      changed_fields: [
        "inspectable",
        "resumable",
        "actionable",
        "speakable",
        "can_create_urge",
        "can_update_surface",
        "can_write_memory",
        "can_delegate_work",
        "requires_confirmation",
        "approval_scope",
      ],
    },
    staleness_delta: {
      before: null,
      after: currentStaleness,
      changed_dimensions: [
        "temporal",
        "world",
        "project",
        "permission",
        "relationship",
        "surface",
        "goal",
        "assumption",
        "session",
        "browser_session",
        "auth_handoff",
      ],
    },
    companion_control_delta: {
      before: null,
      after: {
        active_controls: [],
        global_control_refs: [],
        held_by_controls: [],
        rejected_by_controls: [],
        reason: "no active companion-wide controls",
      },
      changed_controls: [],
    },
    surface_refs: ["surface:1"],
    companion_state_refs: [],
    audit_refs: ["audit:1"],
    ...input,
  });
}

function makeReducerInput(input: Partial<CompanionStateReducerInput> = {}): CompanionStateReducerInput {
  return CompanionStateReducerInputSchema.parse({
    schema_version: "companion-state-reducer-input-v1",
    runtime_items: [makeRuntimeItem()],
    recent_runtime_events: [makeRuntimeEvent()],
    active_surface_ref: "surface:1",
    surface_invalidation_events: [],
    global_control_state_ref: "global-control-state:1",
    global_controls: [makeControl("inspect_companion_state", "inactive")],
    active_goal_refs: ["goal:1"],
    active_watch_refs: [],
    active_wait_refs: [],
    active_quiet_work_refs: ["run:quiet-work-1"],
    attention_history_refs: [],
    control_overlays: [],
    pre_suspend_mode: null,
    authority_blockers: [],
    staleness_blockers: [],
    safety_blockers: [],
    user_activity_refs: ["activity:1"],
    feedback_refs: [],
    safety_context_refs: [],
    event_high_watermark: "event:1",
    current_time: NOW,
    ...input,
  });
}

function surfaceOwnerRef() {
  return {
    kind: "relationship_profile",
    store_ref: "relationship-profile.json",
    record_ref: "memory:1",
  };
}

function surfaceDependencyRef(overrides: Record<string, unknown> = {}) {
  return {
    kind: "memory_record",
    ref: "memory:1",
    owning_store_ref: surfaceOwnerRef(),
    content_state: "materialized",
    lifecycle: "active",
    correction_state: "current",
    superseded_by_memory_id: null,
    ...overrides,
  };
}

function surfaceSourceRef(overrides: Record<string, unknown> = {}) {
  return {
    memory_id: "memory:1",
    owning_store_ref: surfaceOwnerRef(),
    role: "relationship",
    record_kind: "preference",
    domain_fields: {
      target: "status reports",
      preference: "concise",
      confidence: 0.9,
      scope: "operator collaboration",
      allowed_uses: ["surface_projection"],
      review_condition: "when corrected",
    },
    allowed_uses: ["surface_projection", "user_facing_reference"],
    not_allowed_uses: ["side_effect_authorization", "stale_session_authorization"],
    lifecycle: "active",
    correction_state: "current",
    superseded_by_memory_id: null,
    sensitivity: "private",
    content_state: "materialized",
    dependency_ref: surfaceDependencyRef(),
    ...overrides,
  };
}

function surfaceGate(gateName: string, status = "passed") {
  return {
    gate: gateName,
    status,
    reason_ref: `reason:${gateName}:${status}`,
    evaluated_at: NOW,
  };
}

function surfacePassedGates() {
  return [
    surfaceGate("scope"),
    surfaceGate("lifecycle"),
    surfaceGate("staleness"),
    surfaceGate("sensitivity"),
    surfaceGate("permission"),
    surfaceGate("allowed_use"),
    surfaceGate("forbidden_use"),
    surfaceGate("projection"),
    surfaceGate("audit"),
  ];
}

function surfaceRelationshipPermission() {
  return {
    permission_id: "permission:surface:1",
    context_scope: "operator collaboration",
    memory_role_scope: ["relationship"],
    observation_permission: "allowed",
    memory_use_permission: "allowed",
    speakability: "allowed",
    proactive_permission: "ask_first",
    interruption_tolerance: "low",
    autonomy_level: "ask_first",
    confirmation_requirement: "before_action",
    emotional_language_boundary: "neutral",
    preferred_expression_modes: ["concise"],
    forbidden_moves: ["overfamiliarity"],
    valid_from: NOW,
    source_refs: [{
      memory_id: "memory:1",
      owning_store_ref: surfaceOwnerRef(),
    }],
  };
}

function makeSurfaceProjection() {
  const source = surfaceSourceRef();
  return SurfaceProjectionSchema.parse({
    id: "surface:1",
    version: 1,
    target: "gateway",
    scope: { kind: "runtime_item", ref: "run:quiet-work-1" },
    purpose: "runtime invalidation test",
    requested_use: "surface_projection",
    source_refs: [source],
    relationship_permissions: [surfaceRelationshipPermission()],
    included_context: [{
      lane: "relationship",
      source_ref: source,
      use_class: "surface_projection",
      excerpt: "The user prefers concise status reports.",
      gates: surfacePassedGates(),
    }],
    excluded_context: [],
    allowed_runtime_uses: ["surface_projection"],
    not_allowed_runtime_uses: ["side_effect_authorization", "stale_session_authorization"],
    staleness_checks: ["staleness:surface:1"],
    sensitivity_checks: ["sensitivity:surface:1"],
    rationale_entries: [{
      source_ref: source,
      decision: "included",
      gate: "audit",
      reason_ref: "rationale:surface:1:memory:1",
      policy_refs: ["policy:surface"],
    }],
    metadata: {
      staleness: "fresh",
      sensitivity: "private",
      permission_state: "granted",
      invalidation_state: "valid",
      audit_refs: ["audit:surface:1"],
    },
    created_at: NOW,
  });
}

function makeSurfaceDerivedRef(kind: "runtime_item" | "outcome_decision" | "expression_decision" | "session_resume_attempt") {
  return createSurfaceDerivedRuntimeRef({
    kind,
    ref: `${kind}:surface:1`,
    related_surface_refs: ["surface:1"],
    related_memory_refs: ["memory:1"],
    permission_check_refs: ["permission:surface:1"],
    staleness_check_refs: ["staleness:surface:1"],
    use_class: "surface_projection",
    audit_refs: ["audit:surface:1"],
  });
}

describe("CompanionState runtime-control contracts", () => {
  it("defines the RuntimeItem vocabulary from the runtime control design", () => {
    expect(RuntimeItemTypeSchema.options).toEqual([
      "run",
      "task",
      "session",
      "goal",
      "wait",
      "watch",
      "hold",
      "urge_candidate",
      "agent_agenda_item",
      "surface_projection",
      "permission_boundary",
      "audit_trace",
      "diff_proposal",
      "auth_handoff",
      "browser_session",
      "guardrail_state",
      "backpressure_state",
    ]);
  });

  it("keeps mechanical RuntimeItem status separate from runtime posture", () => {
    const completedNeedsUser = makeRuntimeItem({
      item_id: "run:completed-needs-user",
      status: "completed",
      posture: "needs_user",
    });
    const activeStale = makeRuntimeItem({
      item_id: "session:active-stale",
      type: "session",
      status: "active",
      posture: "stale",
    });
    const matureSuppressed = makeRuntimeItem({
      item_id: "urge:mature-suppressed",
      type: "urge_candidate",
      status: "mature",
      posture: "suppressed",
    });

    expect(completedNeedsUser.status).toBe("completed");
    expect(completedNeedsUser.posture).toBe("needs_user");
    expect(activeStale.status).toBe("active");
    expect(activeStale.posture).toBe("stale");
    expect(matureSuppressed.status).toBe("mature");
    expect(matureSuppressed.posture).toBe("suppressed");
  });

  it("keeps hidden runtime items inspectable and auditable through shared state", () => {
    const item = makeRuntimeItem({
      item_id: "watch:hidden",
      type: "watch",
      status: "running",
      posture: "watching",
      visibility_policy: {
        display: "hidden",
        inspectable: true,
        auditable: true,
        policy_ref: "visibility:quiet-watch",
        reason: "hidden from normal display but inspectable",
      },
    });

    expect(item.visibility_policy.display).toBe("hidden");
    expect(item.visibility_policy.inspectable).toBe(true);
    expect(item.visibility_policy.auditable).toBe(true);
  });

  it("fails Authority closed when authority evidence is missing or contradictory", () => {
    const partialAuthority = parseAuthorityFailClosed({
      inspectable: true,
      authority_reason: "partial authority must not grant action",
    });
    const contradictoryAuthority = parseAuthorityFailClosed({
      ...inspectOnlyAuthority,
      actionable: true,
    });

    expect(partialAuthority).toMatchObject({
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
    expect(contradictoryAuthority).toMatchObject({
      inspectable: false,
      actionable: false,
      requires_confirmation: true,
      approval_scope: "none",
    });
  });

  it("proves inspectable authority does not imply resume action speech or writes", () => {
    expect(inspectOnlyAuthority.inspectable).toBe(true);
    expect(inspectOnlyAuthority.resumable).toBe(false);
    expect(inspectOnlyAuthority.actionable).toBe(false);
    expect(inspectOnlyAuthority.speakable).toBe(false);
    expect(inspectOnlyAuthority.can_write_memory).toBe(false);
    expect(inspectOnlyAuthority.can_update_surface).toBe(false);
    expect(inspectOnlyAuthority.can_delegate_work).toBe(false);
  });

  it("fails Staleness closed across all dimensions when staleness evidence is contradictory", () => {
    const staleness = parseStalenessFailClosed({
      temporal: { outcome: "current", reason: "fresh" },
      session: { outcome: "current", reason: "fresh" },
      surface: { outcome: "unknown", reason: "not a contract outcome" },
    });

    expect(Object.values(staleness).every((dimension) => dimension.outcome === "rejected")).toBe(true);
  });

  it("models stale browser session permission Surface and assumption independently", () => {
    const item = makeRuntimeItem({
      staleness: {
        ...currentStaleness,
        browser_session: { outcome: "not_resumable", reason: "browser session went away" },
        permission: { outcome: "needs_review", reason: "permission may have expired" },
        surface: { outcome: "needs_regrounding", reason: "Surface invalidated" },
        assumption: { outcome: "summary_only", reason: "old assumption can only be summarized" },
      },
    });

    expect(item.staleness.browser_session.outcome).toBe("not_resumable");
    expect(item.staleness.permission.outcome).toBe("needs_review");
    expect(item.staleness.surface.outcome).toBe("needs_regrounding");
    expect(item.staleness.assumption.outcome).toBe("summary_only");
  });

  it("derives per-item ControlPolicy with inspect allowed resume forbidden and reground repair", () => {
    const item = makeRuntimeItem({
      authority: inspectOnlyAuthority,
      staleness: {
        ...currentStaleness,
        surface: { outcome: "needs_regrounding", reason: "Surface is stale" },
      },
    });
    const policy = deriveRuntimeItemControlPolicy(item);

    expect(policy.allowed_controls).toContain("inspect_item");
    expect(policy.forbidden_controls).toContain("resume_item");
    expect(policy.repair_options).toContain("reground_item");
  });

  it("does not expose side-effect controls as allowed before required confirmation", () => {
    const item = makeRuntimeItem({
      item_id: "run:approval-required",
      authority: {
        ...operationalAuthority,
        requires_confirmation: true,
      },
    });
    const policy = deriveRuntimeItemControlPolicy(item);

    expect(policy.allowed_controls).toContain("inspect_item");
    expect(policy.allowed_controls).toContain("require_confirmation");
    expect(policy.forbidden_controls).toContain("resume_item");
    expect(policy.forbidden_controls).toContain("pause_item");
    expect(policy.forbidden_controls).toContain("cancel_item");
    expect(policy.required_confirmation).toEqual(["require_confirmation"]);
  });

  it("uses RuntimeItem companion-control state to prevent stale resume bypasses", () => {
    const item = makeRuntimeItem({
      item_id: "run:held-by-suspend",
      companion_control_state: {
        active_controls: [],
        global_control_refs: ["control:suspend_companion:active"],
        held_by_controls: ["suspend_companion"],
        rejected_by_controls: [],
        reason: "held by companion suspend",
      },
    });
    const policy = deriveRuntimeItemControlPolicy(item);

    expect(policy.forbidden_controls).toContain("resume_item");
    expect(policy.forbidden_controls).toContain("pause_item");
    expect(policy.forbidden_controls).toContain("cancel_item");
    expect(policy.reason).toBe("global_suspend_forbids_runtime_item_resume");
  });

  it("requires action authority for finalize and forget side-effect controls", () => {
    const finalizePolicy = deriveRuntimeItemControlPolicy(makeRuntimeItem({
      item_id: "run:inspect-only-finalize",
      status: "completed",
      posture: "ready_to_digest",
      authority: inspectOnlyAuthority,
    }));
    const forgetPolicy = deriveRuntimeItemControlPolicy(makeRuntimeItem({
      item_id: "run:inspect-only-forget",
      posture: "safe_to_forget",
      authority: inspectOnlyAuthority,
    }));

    expect(finalizePolicy.forbidden_controls).toContain("finalize_item");
    expect(forgetPolicy.forbidden_controls).toContain("forget_item");
  });

  it("blocks finalize and forget side-effect controls when staleness blocks action", () => {
    const staleForAction: Staleness = {
      ...currentStaleness,
      permission: { outcome: "not_actionable", reason: "permission is stale for action" },
    };
    const staleForReview: Staleness = {
      ...currentStaleness,
      permission: { outcome: "needs_review", reason: "permission needs review before action" },
    };
    const finalizePolicy = deriveRuntimeItemControlPolicy(makeRuntimeItem({
      item_id: "run:stale-finalize",
      status: "completed",
      posture: "ready_to_digest",
      staleness: staleForAction,
    }));
    const forgetPolicy = deriveRuntimeItemControlPolicy(makeRuntimeItem({
      item_id: "run:stale-forget",
      posture: "safe_to_forget",
      staleness: staleForAction,
    }));
    const reviewFinalizePolicy = deriveRuntimeItemControlPolicy(makeRuntimeItem({
      item_id: "run:review-finalize",
      status: "completed",
      posture: "ready_to_digest",
      staleness: staleForReview,
    }));
    const reviewForgetPolicy = deriveRuntimeItemControlPolicy(makeRuntimeItem({
      item_id: "run:review-forget",
      posture: "safe_to_forget",
      staleness: staleForReview,
    }));

    expect(finalizePolicy.forbidden_controls).toContain("finalize_item");
    expect(forgetPolicy.forbidden_controls).toContain("forget_item");
    expect(reviewFinalizePolicy.forbidden_controls).toContain("finalize_item");
    expect(reviewForgetPolicy.forbidden_controls).toContain("forget_item");
    expect(finalizePolicy.repair_options).toContain("reground_item");
    expect(forgetPolicy.repair_options).toContain("reground_item");
    expect(reviewFinalizePolicy.repair_options).toContain("narrow_permission");
    expect(reviewForgetPolicy.repair_options).toContain("narrow_permission");
  });

  it("assembles reducer input from runtime items after posture changes and Surface invalidations", () => {
    const input = assembleCompanionStateReducerInput({
      runtime_items: [
        makeRuntimeItem({
          item_id: "watch:posture-change",
          type: "watch",
          posture: "waiting",
          related_surface_refs: ["surface:old"],
        }),
      ],
      recent_runtime_events: [makeRuntimeEvent({
        event_id: "runtime-event:watch-posture",
        event_type: "waiting",
        item_ref: "watch:posture-change",
        posture_before: "watching",
        posture_after: "waiting",
      })],
      active_surface_ref: "surface:1",
      surface_invalidation_events: ["surface:old"],
      global_control_state_ref: "global-control-state:1",
      global_controls: [makeControl("inspect_companion_state", "inactive")],
      event_high_watermark: "event:watch-posture",
      current_time: NOW,
    });

    expect(input.active_watch_refs).toEqual(["watch:posture-change"]);
    expect(input.staleness_blockers).toContain("surface:old");
    expect(input.event_high_watermark).toBe("event:watch-posture");
  });

  it("crosses memory correction through Surface invalidation into runtime state rechecks", () => {
    let surface = makeSurfaceProjection();
    for (const kind of ["runtime_item", "outcome_decision", "expression_decision", "session_resume_attempt"] as const) {
      surface = attachSurfaceDependencyRef(surface, makeSurfaceDerivedRef(kind));
    }
    const runtimeItem = makeRuntimeItem({
      item_id: "run:memory-dependent",
      related_surface_refs: [surface.id],
      related_memory_refs: ["memory:1"],
    });
    const beforeInput = assembleCompanionStateReducerInput({
      runtime_items: [runtimeItem],
      recent_runtime_events: ["runtime-event:surface-before"],
      active_surface_ref: surface.id,
      surface_invalidation_events: [],
      global_control_state_ref: "global-control-state:1",
      global_controls: [makeControl("inspect_companion_state", "inactive")],
      event_high_watermark: "event:surface-stable",
      current_time: NOW,
    });
    const beforeSnapshot = deriveCompanionStateSnapshot(beforeInput);
    const invalidation = invalidateSurfaceProjectionFromMemoryCorrection({
      projection: surface,
      correction_event: {
        event_id: "correction:delete-memory:1",
        target_memory_ref: "memory:1",
        action: "delete",
        affected_use_classes: ["surface_projection", "user_facing_reference"],
        invalidation_ref: "surface-invalidation:delete-memory:1",
        audit_ref: "audit:correction:delete-memory:1",
        created_at: NOW,
      },
      occurred_at: NOW,
      redaction_ref: "redaction:memory:1",
    });
    const invalidatedSurfaceRefs = surfaceInvalidationEventsToRuntimeStateRefs([invalidation.event]);
    const afterInput = assembleCompanionStateReducerInput({
      runtime_items: [runtimeItem],
      recent_runtime_events: ["runtime-event:surface-before"],
      active_surface_ref: surface.id,
      surface_invalidation_events: invalidatedSurfaceRefs,
      global_control_state_ref: "global-control-state:1",
      global_controls: [makeControl("inspect_companion_state", "inactive")],
      event_high_watermark: beforeInput.event_high_watermark,
      current_time: NOW,
    });
    const afterSnapshot = deriveCompanionStateSnapshot(afterInput);

    expect(afterInput.staleness_blockers).toContain(surface.id);
    expect(afterSnapshot.mode).toBe("holding_back");
    expect(afterSnapshot.invalidated_surface_refs).toContain(surface.id);
    expect(afterSnapshot.derivation_trace.reason).toBe("stale_or_invalid_surface_holds_runtime_state");
    expect(invalidation.blocked_admissions.map((admission) => admission.operation)).toEqual([
      "action",
      "action",
      "speech",
      "session_resume",
    ]);
    expect(invalidation.blocked_admissions.every((admission) => admission.reason === "invalid_surface")).toBe(true);
    expect(evaluateCompanionStateSnapshotFreshness(beforeSnapshot, afterInput)).toMatchObject({
      current: false,
      reason: "surface_invalidated",
      stale_refs: [surface.id],
    });
    expect(JSON.stringify(invalidation.inspection)).not.toContain("The user prefers concise status reports.");
  });

  it("represents missing Surface state as a blocker instead of silently omitting it", () => {
    const input = assembleCompanionStateReducerInput({
      runtime_items: [makeRuntimeItem()],
      recent_runtime_events: [makeRuntimeEvent({
        event_id: "runtime-event:missing-surface",
        event_type: "stale_context_detected",
        item_ref: "run:quiet-work-1",
        surface_refs: [],
      })],
      active_surface_ref: null,
      surface_invalidation_events: [],
      global_control_state_ref: "global-control-state:1",
      global_controls: [makeControl("inspect_companion_state", "inactive")],
      event_high_watermark: "event:missing-surface",
      current_time: NOW,
    });
    const snapshot = deriveCompanionStateSnapshot(input);

    expect(input.staleness_blockers).toContain("active_surface_ref");
    expect(snapshot.mode).toBe("holding_back");
    expect(snapshot.stale_surface_refs).toContain("active_surface_ref");
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
    expect(snapshot.quiet_work_budget).toBe(0);
    expect(snapshot.derivation_trace.reason).toBe("suspend_companion_fail_closed");
  });

  it("does not leak active watch wait or quiet-work refs while suspended", () => {
    const snapshot = deriveCompanionStateSnapshot(makeReducerInput({
      runtime_items: [
        makeRuntimeItem({ item_id: "run:active-quiet-work", type: "run", status: "running", posture: "working" }),
        makeRuntimeItem({ item_id: "watch:active", type: "watch", status: "running", posture: "watching" }),
        makeRuntimeItem({ item_id: "wait:active", type: "wait", status: "active", posture: "waiting" }),
      ],
      active_watch_refs: ["watch:active"],
      active_wait_refs: ["wait:active"],
      active_quiet_work_refs: ["run:active-quiet-work"],
      global_controls: [makeControl("suspend_companion")],
    }));

    expect(snapshot.mode).toBe("suspended");
    expect(snapshot.active_refs).toEqual([]);
    expect(snapshot.active_watch_refs).toEqual([]);
    expect(snapshot.active_wait_refs).toEqual([]);
    expect(snapshot.active_quiet_work_refs).toEqual([]);
    expect(snapshot.held_runtime_refs).toEqual(expect.arrayContaining([
      "run:active-quiet-work",
      "watch:active",
      "wait:active",
    ]));
    expect(snapshot.pre_suspend_mode).toBe("waiting");
  });

  it("prevents urge pressure from overriding suspend", () => {
    const snapshot = deriveCompanionStateSnapshot(makeReducerInput({
      runtime_items: [
        makeRuntimeItem({
          item_id: "urge:ready",
          type: "urge_candidate",
          status: "mature",
          posture: "proposed",
          related_surface_refs: [],
        }),
      ],
      global_controls: [makeControl("suspend_companion")],
    }));

    expect(snapshot.mode).toBe("suspended");
    expect(snapshot.derivation_trace.rejected_modes).toContain("reaching_out");
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

  it("fails closed when the global companion-control state ref is missing", () => {
    const snapshot = deriveCompanionStateSnapshot(makeReducerInput({
      global_control_state_ref: null,
      global_controls: [makeControl("inspect_companion_state", "inactive")],
    }));

    expect(snapshot.mode).toBe("needs_user");
    expect(snapshot.blocked_refs).toContain("global_controls");
    expect(snapshot.derivation_trace.reason).toBe("missing_global_control_state_fail_closed");
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

  it("selects quieted and proactivity_paused modes from active global controls", () => {
    const quieted = deriveCompanionStateSnapshot(makeReducerInput({
      global_controls: [makeControl("enter_quiet_mode")],
      control_overlays: [],
    }));
    const paused = deriveCompanionStateSnapshot(makeReducerInput({
      global_controls: [makeControl("pause_proactivity")],
      control_overlays: [],
    }));

    expect(quieted.mode).toBe("quieted");
    expect(quieted.control_overlays).toEqual(["enter_quiet_mode"]);
    expect(paused.mode).toBe("proactivity_paused");
    expect(paused.control_overlays).toEqual(["pause_proactivity"]);
  });

  it("blocks agent-origin admission for quiet and proactivity pause while preserving inspection", () => {
    const agentAgendaItem = makeRuntimeItem({
      item_id: "agenda:expression",
      type: "agent_agenda_item",
      status: "active",
      posture: "proposed",
      authority: {
        ...operationalAuthority,
        speakable: true,
        can_create_urge: true,
      },
    });
    const quieted = deriveCompanionStateSnapshot(makeReducerInput({
      runtime_items: [agentAgendaItem],
      global_controls: [makeControl("enter_quiet_mode")],
    }));
    const paused = deriveCompanionStateSnapshot(makeReducerInput({
      runtime_items: [agentAgendaItem],
      global_controls: [makeControl("pause_proactivity")],
    }));
    const quietPolicy = deriveRuntimeItemControlPolicy(agentAgendaItem, ["enter_quiet_mode"]);
    const pausePolicy = deriveRuntimeItemControlPolicy(agentAgendaItem, ["pause_proactivity"]);

    expect(quieted.mode).toBe("quieted");
    expect(quieted.active_refs).toEqual([]);
    expect(quieted.held_runtime_refs).toContain("agenda:expression");
    expect(paused.mode).toBe("proactivity_paused");
    expect(paused.active_refs).toEqual([]);
    expect(quietPolicy.allowed_controls).toContain("inspect_item");
    expect(quietPolicy.forbidden_controls).toContain("resume_item");
    expect(quietPolicy.reason).toBe("global_companion_control_forbids_agent_origin_admission");
    expect(pausePolicy.forbidden_controls).toContain("resume_item");
  });

  it("stops quiet work watches and nonessential agenda without admitting new active refs", () => {
    const runtimeItems = [
      makeRuntimeItem({ item_id: "run:quiet", type: "run", status: "running", posture: "working" }),
      makeRuntimeItem({ item_id: "watch:quiet", type: "watch", status: "running", posture: "watching" }),
      makeRuntimeItem({ item_id: "urge:nonessential", type: "urge_candidate", status: "mature", posture: "proposed" }),
    ];
    const stoppedQuietWork = deriveCompanionStateSnapshot(makeReducerInput({
      runtime_items: runtimeItems,
      active_quiet_work_refs: ["run:quiet"],
      global_controls: [makeControl("stop_all_quiet_work")],
    }));
    const stoppedWatches = deriveCompanionStateSnapshot(makeReducerInput({
      runtime_items: runtimeItems,
      active_watch_refs: ["watch:quiet"],
      global_controls: [makeControl("stop_all_watches")],
    }));
    const suppressedAgenda = deriveCompanionStateSnapshot(makeReducerInput({
      runtime_items: runtimeItems,
      global_controls: [makeControl("suppress_nonessential_agenda")],
    }));

    expect(stoppedQuietWork.mode).toBe("holding_back");
    expect(stoppedQuietWork.active_quiet_work_refs).toEqual([]);
    expect(stoppedQuietWork.quiet_work_budget).toBe(0);
    expect(stoppedQuietWork.held_runtime_refs).toContain("run:quiet");
    expect(stoppedWatches.active_watch_refs).toEqual([]);
    expect(stoppedWatches.held_runtime_refs).toContain("watch:quiet");
    expect(suppressedAgenda.active_refs).not.toContain("urge:nonessential");
    expect(suppressedAgenda.held_runtime_refs).toContain("urge:nonessential");
  });

  it("does not flush held items when quiet pause or suspend controls are lifted", () => {
    const heldPing = makeRuntimeItem({
      item_id: "urge:held-ping",
      type: "urge_candidate",
      status: "mature",
      posture: "holding",
      companion_control_state: {
        active_controls: [],
        global_control_refs: ["control:enter_quiet_mode:active"],
        held_by_controls: ["enter_quiet_mode"],
        rejected_by_controls: [],
        reason: "held while quiet mode was active",
      },
    });
    const heldResumeAttempt = makeRuntimeItem({
      item_id: "session:held-resume",
      type: "session",
      status: "active",
      posture: "holding",
      companion_control_state: {
        active_controls: [],
        global_control_refs: ["control:suspend_companion:active"],
        held_by_controls: ["suspend_companion"],
        rejected_by_controls: [],
        reason: "resume attempt held while companion was suspended",
      },
    });
    const snapshot = deriveCompanionStateSnapshot(makeReducerInput({
      runtime_items: [heldPing, heldResumeAttempt],
      global_controls: [
        makeControl("leave_quiet_mode", "inactive"),
        makeControl("resume_companion", "inactive"),
      ],
    }));

    expect(snapshot.active_refs).toEqual([]);
    expect(snapshot.held_runtime_refs).toEqual(expect.arrayContaining([
      "urge:held-ping",
      "session:held-resume",
    ]));
    expect(deriveRuntimeItemControlPolicy(heldPing).forbidden_controls).toContain("resume_item");
    expect(deriveRuntimeItemControlPolicy(heldResumeAttempt).forbidden_controls).toContain("resume_item");
  });

  it("holds back running watches when the active Surface is stale", () => {
    const snapshot = deriveCompanionStateSnapshot(makeReducerInput({
      runtime_items: [
        makeRuntimeItem({
          item_id: "watch:surface-stale",
          type: "watch",
          status: "running",
          posture: "watching",
          staleness: {
            ...currentStaleness,
            surface: { outcome: "needs_regrounding", reason: "Surface expired" },
          },
        }),
      ],
    }));

    expect(snapshot.mode).toBe("holding_back");
    expect(snapshot.active_watch_refs).toEqual(["watch:surface-stale"]);
    expect(snapshot.stale_surface_refs).toEqual(["watch:surface-stale"]);
    expect(snapshot.derivation_trace.rejected_modes).toContain("reaching_out");
  });

  it("forces needs_user for approval requirements and overloaded for safety blockers", () => {
    const approvalSnapshot = deriveCompanionStateSnapshot(makeReducerInput({
      runtime_items: [
        makeRuntimeItem({
          item_id: "permission:stale",
          type: "permission_boundary",
          authority: inspectOnlyAuthority,
          staleness: {
            ...currentStaleness,
            permission: { outcome: "needs_review", reason: "permission must be renewed" },
          },
        }),
      ],
    }));
    const safetySnapshot = deriveCompanionStateSnapshot(makeReducerInput({
      runtime_items: [
        makeRuntimeItem({
          item_id: "guardrail:active",
          type: "guardrail_state",
          status: "active",
          posture: "blocked_by_boundary",
        }),
      ],
    }));

    expect(approvalSnapshot.mode).toBe("needs_user");
    expect(approvalSnapshot.needs_user_refs).toContain("permission:stale");
    expect(safetySnapshot.mode).toBe("overloaded");
    expect(safetySnapshot.blocked_by_boundary_refs).toContain("guardrail:active");
  });

  it("records budget threshold cooldown and trace changes for feedback-driven cooling down", () => {
    const snapshot = deriveCompanionStateSnapshot(makeReducerInput({
      feedback_refs: ["feedback:dismissed"],
    }));

    expect(snapshot.mode).toBe("cooling_down");
    expect(snapshot.current_capacity).toBe("constrained");
    expect(snapshot.interruption_budget).toBe(0);
    expect(snapshot.cooldowns).toEqual(["feedback:dismissed"]);
    expect(snapshot.expression_thresholds.user_facing_expression).toBe(0.95);
    expect(snapshot.derivation_trace.threshold_changes).toContain("recent_feedback_raised_expression_threshold");
    expect(snapshot.derivation_trace.rejected_modes).toContain("reaching_out");
  });

  it("returns the same snapshot for the same parsed input and high-watermark", () => {
    const input = makeReducerInput({
      global_controls: [makeControl("pause_proactivity")],
      control_overlays: [],
    });

    expect(deriveCompanionStateSnapshot(input)).toEqual(deriveCompanionStateSnapshot(input));
  });

  it("keeps legacy runtime event id refs readable while production stores emit typed RuntimeEvent facts", () => {
    const input = makeReducerInput({
      recent_runtime_events: ["runtime-event:legacy-ref"],
      event_high_watermark: "runtime-event:legacy-ref",
    });

    const snapshot = deriveCompanionStateSnapshot(input);

    expect(input.recent_runtime_events).toEqual(["runtime-event:legacy-ref"]);
    expect(snapshot.derivation_trace.input_refs).toContain("runtime-event:legacy-ref");
  });

  it("rejects stale snapshots when later runtime or Surface evidence changes the high-watermark", () => {
    const input = makeReducerInput();
    const snapshot = deriveCompanionStateSnapshot(input);
    const laterInput = makeReducerInput({
      recent_runtime_events: [makeRuntimeEvent({
        event_id: "runtime-event:2",
        event_type: "stale_context_detected",
        item_ref: "run:quiet-work-1",
      })],
      surface_invalidation_events: ["surface:1"],
      event_high_watermark: "event:2",
    });

    expect(evaluateCompanionStateSnapshotFreshness(snapshot, input)).toEqual({
      current: true,
      reason: "current",
      stale_refs: [],
    });
    expect(evaluateCompanionStateSnapshotFreshness(snapshot, laterInput)).toMatchObject({
      current: false,
      reason: "event_high_watermark_changed",
    });
  });

  it("rejects stale snapshots when global control state changes under the same high-watermark", () => {
    const input = makeReducerInput();
    const snapshot = deriveCompanionStateSnapshot(input);
    const changedControlInput = makeReducerInput({
      global_control_state_ref: "global-control-state:2",
      global_controls: [makeControl("pause_proactivity")],
      event_high_watermark: input.event_high_watermark,
    });

    expect(evaluateCompanionStateSnapshotFreshness(snapshot, changedControlInput)).toMatchObject({
      current: false,
      reason: "global_control_state_changed",
      stale_refs: expect.arrayContaining([
        "global-control-state:1",
        "global-control-state:2",
        "control:pause_proactivity:active",
      ]),
    });
  });

  it("rejects stale snapshots when the active Surface changes under the same high-watermark", () => {
    const input = makeReducerInput({
      active_surface_ref: "surface:1",
      event_high_watermark: "event:same",
    });
    const snapshot = deriveCompanionStateSnapshot(input);
    const changedSurfaceInput = makeReducerInput({
      active_surface_ref: "surface:2",
      event_high_watermark: "event:same",
    });

    expect(evaluateCompanionStateSnapshotFreshness(snapshot, changedSurfaceInput)).toMatchObject({
      current: false,
      reason: "active_surface_changed",
      stale_refs: ["surface:1", "surface:2"],
    });
  });
});
