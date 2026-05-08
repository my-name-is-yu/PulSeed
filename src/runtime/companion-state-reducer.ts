import {
  AuthoritySchema,
  CompanionStateReducerInputSchema,
  CompanionStateSnapshotSchema,
  RuntimeItemControlSchema,
  RuntimeItemSchema,
  StalenessSchema,
  type Authority,
  type CompanionGlobalControlEntry,
  type CompanionStateAssemblyInput,
  type CompanionStateMode,
  type CompanionStateReducerInput,
  type CompanionStateSnapshot,
  type CompanionStateSnapshotFreshness,
  type CompanionWideControl,
  type ControlPolicy,
  type RuntimeItem,
  type RuntimeItemControl,
  type Staleness,
  type StalenessDimension,
} from "./types/companion-state.js";

const FAIL_CLOSED_AUTHORITY_REASON = "authority_missing_or_invalid_fail_closed";
const FAIL_CLOSED_STALENESS_REASON = "staleness_missing_or_invalid_fail_closed";

const ALL_RUNTIME_ITEM_CONTROLS = RuntimeItemControlSchema.options;

type RuntimeSignals = {
  authorityBlockerRefs: string[];
  stalenessBlockerRefs: string[];
  safetyBlockerRefs: string[];
  blockedByBoundaryRefs: string[];
  needsUserRefs: string[];
  staleRefs: string[];
  staleSurfaceRefs: string[];
  invalidatedSurfaceRefs: string[];
  waitingConditions: string[];
};

type GlobalControlDecision = {
  activeControls: CompanionWideControl[];
  matchedControlRefs: string[];
  blockedRefs: string[];
  failClosed: boolean;
  reason: string;
};

export function deriveFailClosedAuthority(reason = FAIL_CLOSED_AUTHORITY_REASON): Authority {
  return {
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
    authority_reason: reason,
  };
}

export function parseAuthorityFailClosed(input: unknown): Authority {
  const parsed = AuthoritySchema.safeParse(input);
  return parsed.success ? parsed.data : deriveFailClosedAuthority();
}

export function deriveFailClosedStaleness(reason = FAIL_CLOSED_STALENESS_REASON): Staleness {
  const dimension: StalenessDimension = {
    outcome: "rejected",
    reason,
  };
  return {
    temporal: dimension,
    world: dimension,
    project: dimension,
    permission: dimension,
    relationship: dimension,
    surface: dimension,
    goal: dimension,
    assumption: dimension,
    session: dimension,
    browser_session: dimension,
    auth_handoff: dimension,
  };
}

export function parseStalenessFailClosed(input: unknown): Staleness {
  const parsed = StalenessSchema.safeParse(input);
  return parsed.success ? parsed.data : deriveFailClosedStaleness();
}

export function deriveRuntimeItemControlPolicy(
  input: unknown,
  activeCompanionControls: CompanionWideControl[] = []
): ControlPolicy {
  const parsed = RuntimeItemSchema.safeParse(input);
  if (!parsed.success) {
    return failClosedControlPolicy("runtime_item_missing_or_invalid_fail_closed");
  }

  const item = parsed.data;
  const companionControls = uniqueControls([
    ...activeCompanionControls,
    ...item.companion_control_state.active_controls,
    ...item.companion_control_state.held_by_controls,
    ...item.companion_control_state.rejected_by_controls,
  ]);
  const forbidden = new Set<RuntimeItemControl>(ALL_RUNTIME_ITEM_CONTROLS);
  const requiredConfirmation = new Set<RuntimeItemControl>();
  const repairOptions = new Set<RuntimeItemControl>();
  const allow = (control: RuntimeItemControl) => {
    forbidden.delete(control);
  };
  const forbid = (control: RuntimeItemControl) => {
    forbidden.add(control);
  };

  if (item.authority.inspectable && item.visibility_policy.inspectable) {
    allow("inspect_item");
  }

  const requiresConfirmation = item.authority.requires_confirmation
    || companionControls.includes("require_confirmation_for_proactivity");
  const globallyHeld = companionControls.includes("suspend_companion")
    || companionControls.includes("stop_all_quiet_work")
    || item.companion_control_state.held_by_controls.length > 0
    || item.companion_control_state.rejected_by_controls.length > 0;
  const blocksResume = globallyHeld
    || hasBlockingStaleness(item.staleness)
    || isPermissionStale(item.staleness.permission)
    || item.posture === "stale"
    || item.posture === "suspended";

  if (item.authority.resumable && !blocksResume && !requiresConfirmation) {
    allow("resume_item");
  } else {
    forbid("resume_item");
  }

  if (item.authority.actionable && !globallyHeld && !requiresConfirmation) {
    allow("pause_item");
    allow("cancel_item");
  }

  if (
    item.status === "completed"
    && item.posture === "ready_to_digest"
    && item.authority.actionable
    && !blocksResume
    && !requiresConfirmation
  ) {
    allow("finalize_item");
  }

  if (
    item.posture === "safe_to_forget"
    && item.authority.actionable
    && !blocksResume
    && !requiresConfirmation
  ) {
    allow("forget_item");
  }

  if (hasBlockingStaleness(item.staleness) || item.related_surface_refs.length > 0) {
    repairOptions.add("reground_item");
  }

  if (item.type === "permission_boundary" || isPermissionStale(item.staleness.permission)) {
    repairOptions.add("narrow_permission");
    repairOptions.add("revoke_permission");
  }

  if (requiresConfirmation) {
    requiredConfirmation.add("require_confirmation");
    repairOptions.add("require_confirmation");
    allow("require_confirmation");
  }

  const allowedControls = ALL_RUNTIME_ITEM_CONTROLS.filter((control) => !forbidden.has(control));
  return {
    allowed_controls: allowedControls,
    forbidden_controls: ALL_RUNTIME_ITEM_CONTROLS.filter((control) => forbidden.has(control)),
    required_confirmation: ALL_RUNTIME_ITEM_CONTROLS.filter((control) => requiredConfirmation.has(control)),
    repair_options: ALL_RUNTIME_ITEM_CONTROLS.filter((control) => repairOptions.has(control)),
    reason: buildControlPolicyReason(item, companionControls),
  };
}

export function assembleCompanionStateReducerInput(input: CompanionStateAssemblyInput): CompanionStateReducerInput {
  const runtimeItems = input.runtime_items.map((item) => RuntimeItemSchema.parse(item));
  const globalControls = input.global_controls ?? [];
  const baseInput: CompanionStateReducerInput = CompanionStateReducerInputSchema.parse({
    schema_version: input.schema_version ?? "companion-state-reducer-input-v1",
    runtime_items: runtimeItems,
    recent_runtime_events: input.recent_runtime_events,
    active_surface_ref: input.active_surface_ref,
    surface_invalidation_events: input.surface_invalidation_events,
    global_control_state_ref: input.global_control_state_ref,
    global_controls: globalControls,
    active_goal_refs: input.active_goal_refs ?? uniqueStrings(runtimeItems.flatMap((item) => item.related_goal_refs)),
    active_watch_refs: input.active_watch_refs ?? activeRefsOfType(runtimeItems, "watch"),
    active_wait_refs: input.active_wait_refs ?? activeRefsOfType(runtimeItems, "wait"),
    active_quiet_work_refs: input.active_quiet_work_refs ?? activeRefsOfType(runtimeItems, "run", "task"),
    attention_history_refs: input.attention_history_refs ?? uniqueStrings(runtimeItems.flatMap((item) => item.related_agenda_refs)),
    control_overlays: input.control_overlays ?? [],
    pre_suspend_mode: input.pre_suspend_mode ?? null,
    authority_blockers: input.authority_blockers ?? [],
    staleness_blockers: input.staleness_blockers ?? [],
    safety_blockers: input.safety_blockers ?? [],
    user_activity_refs: input.user_activity_refs ?? [],
    feedback_refs: input.feedback_refs ?? [],
    safety_context_refs: input.safety_context_refs ?? [],
    event_high_watermark: input.event_high_watermark,
    current_time: input.current_time,
  });

  const signals = deriveRuntimeSignals(baseInput);
  return CompanionStateReducerInputSchema.parse({
    ...baseInput,
    active_watch_refs: uniqueStrings([...baseInput.active_watch_refs, ...activeRefsOfType(runtimeItems, "watch")]),
    active_wait_refs: uniqueStrings([...baseInput.active_wait_refs, ...activeRefsOfType(runtimeItems, "wait")]),
    active_quiet_work_refs: uniqueStrings([
      ...baseInput.active_quiet_work_refs,
      ...activeRefsOfType(runtimeItems, "run", "task"),
    ]),
    authority_blockers: uniqueStrings([...baseInput.authority_blockers, ...signals.authorityBlockerRefs]),
    staleness_blockers: uniqueStrings([...baseInput.staleness_blockers, ...signals.stalenessBlockerRefs]),
    safety_blockers: uniqueStrings([...baseInput.safety_blockers, ...signals.safetyBlockerRefs]),
  });
}

export function deriveCompanionStateSnapshot(input: unknown): CompanionStateSnapshot {
  const parsed = CompanionStateReducerInputSchema.safeParse(input);
  if (!parsed.success) {
    const now = new Date().toISOString();
    return buildSnapshot({
      input: null,
      computedAt: now,
      highWatermark: "invalid-input",
      activeSurfaceRef: null,
      globalControlStateRef: null,
      mode: "needs_user",
      controlOverlays: ["pause_proactivity", "require_confirmation_for_proactivity"],
      preSuspendMode: null,
      activeRefs: [],
      heldRuntimeRefs: [],
      blockedRefs: ["companion-state-input"],
      staleRefs: [],
      matchedControlRefs: [],
      matchedBlockerRefs: ["companion-state-input"],
      matchedFeedbackRefs: [],
      matchedActivityRefs: [],
      reason: "missing_or_invalid_reducer_input_fail_closed",
      rejectedModes: ["working", "watching", "reaching_out", "escalating"],
      signals: emptyRuntimeSignals(),
    });
  }
  return deriveFromParsedInput(parsed.data);
}

export function evaluateCompanionStateSnapshotFreshness(
  snapshot: CompanionStateSnapshot,
  currentInput: CompanionStateReducerInput
): CompanionStateSnapshotFreshness {
  if (snapshot.source_event_high_watermark !== currentInput.event_high_watermark) {
    return {
      current: false,
      reason: "event_high_watermark_changed",
      stale_refs: uniqueStrings([
        currentInput.event_high_watermark,
        ...currentInput.recent_runtime_events,
        ...currentInput.surface_invalidation_events,
        ...currentInput.global_controls.map((control) => control.source_ref),
        ...currentInput.user_activity_refs,
        ...currentInput.feedback_refs,
      ]),
    };
  }

  if (
    snapshot.active_surface_ref !== null
    && currentInput.surface_invalidation_events.includes(snapshot.active_surface_ref)
  ) {
    return {
      current: false,
      reason: "surface_invalidated",
      stale_refs: [snapshot.active_surface_ref],
    };
  }

  if (snapshot.active_surface_ref !== currentInput.active_surface_ref) {
    return {
      current: false,
      reason: "active_surface_changed",
      stale_refs: uniqueStrings([
        ...(snapshot.active_surface_ref === null ? [] : [snapshot.active_surface_ref]),
        ...(currentInput.active_surface_ref === null ? [] : [currentInput.active_surface_ref]),
      ]),
    };
  }

  if (snapshot.global_control_state_ref !== currentInput.global_control_state_ref) {
    return {
      current: false,
      reason: "global_control_state_changed",
      stale_refs: uniqueStrings([
        ...(snapshot.global_control_state_ref === null ? [] : [snapshot.global_control_state_ref]),
        ...(currentInput.global_control_state_ref === null ? [] : [currentInput.global_control_state_ref]),
        ...currentInput.global_controls.map((control) => control.source_ref),
      ]),
    };
  }

  return {
    current: true,
    reason: "current",
    stale_refs: [],
  };
}

function deriveFromParsedInput(input: CompanionStateReducerInput): CompanionStateSnapshot {
  const controlDecision = interpretGlobalControls(input.global_controls, input.global_control_state_ref);
  const signals = deriveRuntimeSignals(input);
  if (controlDecision.failClosed) {
    return buildSnapshot({
      input,
      computedAt: input.current_time,
      highWatermark: input.event_high_watermark,
      activeSurfaceRef: input.active_surface_ref,
      globalControlStateRef: input.global_control_state_ref,
      mode: "needs_user",
      controlOverlays: uniqueControls([
        ...input.control_overlays,
        "pause_proactivity",
        "require_confirmation_for_proactivity",
      ]),
      preSuspendMode: input.pre_suspend_mode,
      activeRefs: activeRuntimeRefs(input.runtime_items),
      heldRuntimeRefs: heldRuntimeRefs(input.runtime_items),
      blockedRefs: uniqueStrings([
        ...signals.authorityBlockerRefs,
        ...signals.safetyBlockerRefs,
        ...controlDecision.blockedRefs,
      ]),
      staleRefs: signals.staleRefs,
      matchedControlRefs: controlDecision.matchedControlRefs,
      matchedBlockerRefs: uniqueStrings([
        ...signals.authorityBlockerRefs,
        ...signals.safetyBlockerRefs,
        ...controlDecision.blockedRefs,
      ]),
      matchedFeedbackRefs: input.feedback_refs,
      matchedActivityRefs: input.user_activity_refs,
      reason: controlDecision.reason,
      rejectedModes: ["working", "watching", "reaching_out", "escalating"],
      signals,
    });
  }

  if (controlDecision.activeControls.includes("suspend_companion")) {
    const currentMode = selectNonSuspendedMode(input, controlDecision.activeControls, signals);
    return buildSnapshot({
      input,
      computedAt: input.current_time,
      highWatermark: input.event_high_watermark,
      activeSurfaceRef: input.active_surface_ref,
      globalControlStateRef: input.global_control_state_ref,
      mode: "suspended",
      controlOverlays: uniqueControls([...input.control_overlays, "suspend_companion"]),
      preSuspendMode: input.pre_suspend_mode ?? currentMode,
      activeRefs: [],
      heldRuntimeRefs: activeRuntimeRefs(input.runtime_items),
      blockedRefs: uniqueStrings([
        ...signals.authorityBlockerRefs,
        ...signals.safetyBlockerRefs,
        ...activeRuntimeRefs(input.runtime_items),
      ]),
      staleRefs: signals.staleRefs,
      matchedControlRefs: controlDecision.matchedControlRefs,
      matchedBlockerRefs: uniqueStrings([...signals.authorityBlockerRefs, ...signals.safetyBlockerRefs]),
      matchedFeedbackRefs: input.feedback_refs,
      matchedActivityRefs: input.user_activity_refs,
      reason: "suspend_companion_fail_closed",
      rejectedModes: ["working", "watching", "waiting", "reaching_out", "escalating"],
      signals,
    });
  }

  const blockerMode = selectBlockerMode(signals);
  if (blockerMode !== null) {
    return buildSnapshot({
      input,
      computedAt: input.current_time,
      highWatermark: input.event_high_watermark,
      activeSurfaceRef: input.active_surface_ref,
      globalControlStateRef: input.global_control_state_ref,
      mode: blockerMode.mode,
      controlOverlays: uniqueControls([...input.control_overlays, ...controlDecision.activeControls]),
      preSuspendMode: input.pre_suspend_mode,
      activeRefs: activeRuntimeRefs(input.runtime_items),
      heldRuntimeRefs: uniqueStrings([...heldRuntimeRefs(input.runtime_items), ...signals.staleSurfaceRefs]),
      blockedRefs: blockerMode.blockedRefs,
      staleRefs: signals.staleRefs,
      matchedControlRefs: controlDecision.matchedControlRefs,
      matchedBlockerRefs: blockerMode.blockedRefs,
      matchedFeedbackRefs: input.feedback_refs,
      matchedActivityRefs: input.user_activity_refs,
      reason: blockerMode.reason,
      rejectedModes: blockerMode.rejectedModes,
      signals,
    });
  }

  if (input.feedback_refs.length > 0) {
    return buildSnapshot({
      input,
      computedAt: input.current_time,
      highWatermark: input.event_high_watermark,
      activeSurfaceRef: input.active_surface_ref,
      globalControlStateRef: input.global_control_state_ref,
      mode: "cooling_down",
      controlOverlays: uniqueControls([...input.control_overlays, ...controlDecision.activeControls]),
      preSuspendMode: input.pre_suspend_mode,
      activeRefs: activeRuntimeRefs(input.runtime_items),
      heldRuntimeRefs: heldRuntimeRefs(input.runtime_items),
      blockedRefs: [],
      staleRefs: signals.staleRefs,
      matchedControlRefs: controlDecision.matchedControlRefs,
      matchedBlockerRefs: [],
      matchedFeedbackRefs: input.feedback_refs,
      matchedActivityRefs: input.user_activity_refs,
      reason: "recent_feedback_raises_attention_thresholds",
      rejectedModes: ["reaching_out", "escalating"],
      signals,
    });
  }

  const mode = selectNonSuspendedMode(input, controlDecision.activeControls, signals);
  return buildSnapshot({
    input,
    computedAt: input.current_time,
    highWatermark: input.event_high_watermark,
    activeSurfaceRef: input.active_surface_ref,
    globalControlStateRef: input.global_control_state_ref,
    mode,
    controlOverlays: uniqueControls([...input.control_overlays, ...controlDecision.activeControls]),
    preSuspendMode: input.pre_suspend_mode,
    activeRefs: activeRuntimeRefs(input.runtime_items),
    heldRuntimeRefs: heldRuntimeRefs(input.runtime_items),
    blockedRefs: [],
    staleRefs: signals.staleRefs,
    matchedControlRefs: controlDecision.matchedControlRefs,
    matchedBlockerRefs: [],
    matchedFeedbackRefs: input.feedback_refs,
    matchedActivityRefs: input.user_activity_refs,
    reason: "companion_state_reducer_skeleton_selected_mode",
    rejectedModes: [],
    signals,
  });
}

function interpretGlobalControls(
  globalControls: CompanionGlobalControlEntry[],
  globalControlStateRef: string | null
): GlobalControlDecision {
  const ambiguous = globalControls.filter((entry) => entry.state === "ambiguous");
  if (globalControls.length === 0 || globalControlStateRef === null) {
    return {
      activeControls: [],
      matchedControlRefs: [],
      blockedRefs: ["global_controls"],
      failClosed: true,
      reason: "missing_global_control_state_fail_closed",
    };
  }
  if (ambiguous.length > 0) {
    return {
      activeControls: [],
      matchedControlRefs: ambiguous.map((entry) => entry.source_ref),
      blockedRefs: ambiguous.map((entry) => entry.source_ref),
      failClosed: true,
      reason: "ambiguous_global_control_state_fail_closed",
    };
  }
  return {
    activeControls: uniqueControls(
      globalControls
        .filter((entry) => entry.state === "active")
        .map((entry) => entry.control)
    ),
    matchedControlRefs: globalControls
      .filter((entry) => entry.state === "active")
      .map((entry) => entry.source_ref),
    blockedRefs: [],
    failClosed: false,
    reason: "global_control_state_clear",
  };
}

function deriveRuntimeSignals(input: CompanionStateReducerInput): RuntimeSignals {
  const signals = emptyRuntimeSignals();
  signals.authorityBlockerRefs.push(...input.authority_blockers);
  signals.stalenessBlockerRefs.push(...input.staleness_blockers);
  signals.safetyBlockerRefs.push(...input.safety_blockers);
  signals.invalidatedSurfaceRefs.push(...input.surface_invalidation_events);

  if (input.active_surface_ref === null && input.runtime_items.some(isSurfaceDependentRuntimeItem)) {
    signals.stalenessBlockerRefs.push("active_surface_ref");
    signals.staleSurfaceRefs.push("active_surface_ref");
  }

  if (input.surface_invalidation_events.length > 0) {
    signals.stalenessBlockerRefs.push(...input.surface_invalidation_events);
  }

  for (const item of input.runtime_items) {
    const itemId = runtimeItemId(item);

    if (item.posture === "blocked_by_boundary") {
      signals.blockedByBoundaryRefs.push(itemId);
    }
    if (item.posture === "needs_user") {
      signals.needsUserRefs.push(itemId);
    }
    if (item.posture === "waiting") {
      signals.waitingConditions.push(itemId);
    }

    if (hasAnyStaleness(item.staleness)) {
      signals.staleRefs.push(itemId);
    }

    if (item.staleness.surface.outcome !== "current") {
      signals.stalenessBlockerRefs.push(itemId);
      signals.staleSurfaceRefs.push(itemId);
    }

    if (isPermissionStale(item.staleness.permission) || needsRenewedAuthority(item)) {
      signals.authorityBlockerRefs.push(itemId);
      signals.needsUserRefs.push(itemId);
    }

    if (isSafetyRuntimeItem(item) || isContradictoryPosture(item)) {
      signals.safetyBlockerRefs.push(itemId);
      signals.blockedByBoundaryRefs.push(itemId);
    }
  }

  signals.authorityBlockerRefs = uniqueStrings(signals.authorityBlockerRefs);
  signals.stalenessBlockerRefs = uniqueStrings(signals.stalenessBlockerRefs);
  signals.safetyBlockerRefs = uniqueStrings(signals.safetyBlockerRefs);
  signals.blockedByBoundaryRefs = uniqueStrings(signals.blockedByBoundaryRefs);
  signals.needsUserRefs = uniqueStrings(signals.needsUserRefs);
  signals.staleRefs = uniqueStrings(signals.staleRefs);
  signals.staleSurfaceRefs = uniqueStrings(signals.staleSurfaceRefs);
  signals.invalidatedSurfaceRefs = uniqueStrings(signals.invalidatedSurfaceRefs);
  signals.waitingConditions = uniqueStrings(signals.waitingConditions);
  return signals;
}

function selectBlockerMode(signals: RuntimeSignals): {
  mode: CompanionStateMode;
  blockedRefs: string[];
  reason: string;
  rejectedModes: CompanionStateMode[];
} | null {
  if (signals.safetyBlockerRefs.length > 0) {
    return {
      mode: "overloaded",
      blockedRefs: uniqueStrings([...signals.safetyBlockerRefs, ...signals.blockedByBoundaryRefs]),
      reason: "safety_or_contradictory_runtime_state_fail_closed",
      rejectedModes: ["working", "watching", "reaching_out", "escalating"],
    };
  }
  if (signals.authorityBlockerRefs.length > 0) {
    return {
      mode: "needs_user",
      blockedRefs: uniqueStrings([...signals.authorityBlockerRefs, ...signals.needsUserRefs]),
      reason: "authority_or_confirmation_blocker_fail_closed",
      rejectedModes: ["working", "reaching_out", "escalating"],
    };
  }
  if (signals.staleSurfaceRefs.length > 0 || signals.invalidatedSurfaceRefs.length > 0) {
    return {
      mode: "holding_back",
      blockedRefs: uniqueStrings([...signals.staleSurfaceRefs, ...signals.invalidatedSurfaceRefs]),
      reason: "stale_or_invalid_surface_holds_runtime_state",
      rejectedModes: ["reaching_out", "escalating"],
    };
  }
  return null;
}

function selectNonSuspendedMode(
  input: CompanionStateReducerInput,
  activeControls: CompanionWideControl[],
  signals: RuntimeSignals
): CompanionStateMode {
  const controls = uniqueControls([...input.control_overlays, ...activeControls]);
  if (controls.includes("enter_quiet_mode")) return "quieted";
  if (controls.includes("pause_proactivity")) return "proactivity_paused";
  if (controls.includes("suppress_nonessential_agenda")) return "holding_back";
  if (signals.waitingConditions.length > 0) return "waiting";
  if (input.runtime_items.some((item) => item.posture === "needs_user")) return "needs_user";
  if (input.runtime_items.some((item) => item.posture === "working")) return "working";
  if (input.runtime_items.some((item) => item.posture === "watching")) return "watching";
  if (input.runtime_items.some((item) => item.posture === "waiting")) return "waiting";
  if (input.runtime_items.some((item) => item.type === "urge_candidate" && item.status === "mature")) return "curious";
  return "resting";
}

function activeRuntimeRefs(items: RuntimeItem[]): string[] {
  return items
    .filter((item) => (
      item.status === "running"
      || item.status === "pending"
      || item.status === "paused"
      || item.status === "active"
      || item.status === "mature"
    ))
    .map(runtimeItemId);
}

function activeRefsOfType(items: RuntimeItem[], ...types: RuntimeItem["type"][]): string[] {
  return items
    .filter((item) => types.includes(item.type))
    .filter((item) => activeRuntimeRefs([item]).length > 0)
    .map(runtimeItemId);
}

function heldRuntimeRefs(items: RuntimeItem[]): string[] {
  return items
    .filter((item) => (
      item.posture === "holding"
      || item.posture === "waiting"
      || item.posture === "suppressed"
      || item.posture === "suspended"
    ))
    .map(runtimeItemId);
}

function buildSnapshot(input: {
  input: CompanionStateReducerInput | null;
  computedAt: string;
  highWatermark: string;
  activeSurfaceRef: string | null;
  globalControlStateRef: string | null;
  mode: CompanionStateMode;
  controlOverlays: CompanionWideControl[];
  preSuspendMode: CompanionStateMode | null;
  activeRefs: string[];
  heldRuntimeRefs: string[];
  blockedRefs: string[];
  staleRefs: string[];
  matchedControlRefs: string[];
  matchedBlockerRefs: string[];
  matchedFeedbackRefs: string[];
  matchedActivityRefs: string[];
  reason: string;
  rejectedModes: CompanionStateMode[];
  signals: RuntimeSignals;
}): CompanionStateSnapshot {
  const budgets = deriveBudgets(input.mode, input.controlOverlays, input.matchedFeedbackRefs, input.signals);
  const runtimeInput = input.input;
  return CompanionStateSnapshotSchema.parse({
    schema_version: "companion-state-snapshot-v1",
    snapshot_id: `companion-state:${input.highWatermark}:${input.mode}`,
    computed_at: input.computedAt,
    source_event_high_watermark: input.highWatermark,
    active_surface_ref: input.activeSurfaceRef,
    global_control_state_ref: input.globalControlStateRef,
    mode: input.mode,
    control_overlays: input.controlOverlays,
    current_capacity: budgets.currentCapacity,
    interruption_budget: budgets.interruptionBudget,
    quiet_work_budget: budgets.quietWorkBudget,
    budgets: {
      current_capacity: budgets.capacityScore,
      interruption_budget: budgets.interruptionBudget,
      quiet_work_budget: budgets.quietWorkBudget,
    },
    attention_thresholds: budgets.attentionThresholds,
    expression_thresholds: budgets.expressionThresholds,
    threshold_overrides: budgets.thresholdOverrides,
    cooldowns: budgets.cooldowns,
    waiting_conditions: input.signals.waitingConditions,
    blocked_refs: input.blockedRefs,
    blocked_by_boundary_refs: input.signals.blockedByBoundaryRefs,
    needs_user_refs: input.signals.needsUserRefs,
    stale_refs: input.staleRefs,
    stale_surface_refs: input.signals.staleSurfaceRefs,
    invalidated_refs: input.signals.invalidatedSurfaceRefs,
    invalidated_surface_refs: input.signals.invalidatedSurfaceRefs,
    active_refs: input.activeRefs,
    active_watch_refs: runtimeInput === null
      ? []
      : uniqueStrings([...runtimeInput.active_watch_refs, ...activeRefsOfType(runtimeInput.runtime_items, "watch")]),
    active_wait_refs: runtimeInput === null
      ? []
      : uniqueStrings([...runtimeInput.active_wait_refs, ...activeRefsOfType(runtimeInput.runtime_items, "wait")]),
    active_quiet_work_refs: runtimeInput === null
      ? []
      : uniqueStrings([
        ...runtimeInput.active_quiet_work_refs,
        ...activeRefsOfType(runtimeInput.runtime_items, "run", "task"),
      ]),
    pre_suspend_mode: input.preSuspendMode,
    held_runtime_refs: input.heldRuntimeRefs,
    derivation_trace: {
      input_refs: runtimeInput === null ? [] : inputRefs(runtimeInput),
      matched_control_refs: input.matchedControlRefs,
      matched_blocker_refs: input.matchedBlockerRefs,
      matched_feedback_refs: input.matchedFeedbackRefs,
      matched_activity_refs: input.matchedActivityRefs,
      selected_mode: input.mode,
      budget_changes: budgets.budgetChanges,
      threshold_changes: budgets.thresholdChanges,
      rejected_modes: input.rejectedModes,
      reason: input.reason,
    },
  });
}

function deriveBudgets(
  mode: CompanionStateMode,
  controls: CompanionWideControl[],
  feedbackRefs: string[],
  signals: RuntimeSignals
): {
  currentCapacity: "available" | "constrained" | "exhausted";
  capacityScore: number;
  interruptionBudget: number;
  quietWorkBudget: number;
  attentionThresholds: Record<string, number>;
  expressionThresholds: Record<string, number>;
  thresholdOverrides: Record<string, number>;
  cooldowns: string[];
  budgetChanges: string[];
  thresholdChanges: string[];
} {
  const attentionThresholds: Record<string, number> = {
    urge_maturation: 0.7,
    outreach: 0.9,
  };
  const expressionThresholds: Record<string, number> = {
    user_facing_expression: 0.85,
  };
  const thresholdOverrides: Record<string, number> = {};
  const budgetChanges: string[] = [];
  const thresholdChanges: string[] = [];
  const cooldowns: string[] = [];

  let currentCapacity: "available" | "constrained" | "exhausted" = "available";
  let capacityScore = 1;
  let interruptionBudget = 0.5;
  let quietWorkBudget = 0.75;

  if (mode === "suspended" || mode === "overloaded" || mode === "needs_user") {
    currentCapacity = "exhausted";
    capacityScore = 0;
    interruptionBudget = 0;
    quietWorkBudget = mode === "suspended" ? 0 : 0.15;
    budgetChanges.push(`${mode}_fail_closed_capacity`);
  } else if (
    mode === "quieted"
    || mode === "proactivity_paused"
    || mode === "holding_back"
    || mode === "cooling_down"
    || controls.includes("require_confirmation_for_proactivity")
  ) {
    currentCapacity = "constrained";
    capacityScore = 0.4;
    interruptionBudget = 0;
    quietWorkBudget = 0.35;
    budgetChanges.push(`${mode}_constrains_interruption`);
  } else if (mode === "working" || mode === "waiting" || mode === "watching") {
    currentCapacity = "constrained";
    capacityScore = 0.65;
    interruptionBudget = 0.2;
    quietWorkBudget = 0.6;
    budgetChanges.push(`${mode}_preserves_authorized_work`);
  }

  if (feedbackRefs.length > 0) {
    attentionThresholds.urge_maturation = 0.85;
    expressionThresholds.user_facing_expression = 0.95;
    thresholdOverrides.recent_feedback = 0.95;
    cooldowns.push(...feedbackRefs);
    thresholdChanges.push("recent_feedback_raised_expression_threshold");
  }

  if (signals.staleSurfaceRefs.length > 0 || signals.invalidatedSurfaceRefs.length > 0) {
    expressionThresholds.user_facing_expression = 1;
    thresholdOverrides.surface_stale_or_invalid = 1;
    thresholdChanges.push("surface_blocker_maximized_expression_threshold");
  }

  return {
    currentCapacity,
    capacityScore,
    interruptionBudget,
    quietWorkBudget,
    attentionThresholds,
    expressionThresholds,
    thresholdOverrides,
    cooldowns,
    budgetChanges,
    thresholdChanges,
  };
}

function failClosedControlPolicy(reason: string): ControlPolicy {
  return {
    allowed_controls: [],
    forbidden_controls: ALL_RUNTIME_ITEM_CONTROLS,
    required_confirmation: [],
    repair_options: ["reground_item"],
    reason,
  };
}

function buildControlPolicyReason(item: RuntimeItem, activeCompanionControls: CompanionWideControl[]): string {
  if (activeCompanionControls.includes("suspend_companion")) return "global_suspend_forbids_runtime_item_resume";
  if (hasBlockingStaleness(item.staleness)) return "runtime_item_staleness_requires_repair";
  if (item.authority.requires_confirmation) return "runtime_item_authority_requires_confirmation";
  return "runtime_item_authority_and_staleness_policy";
}

function hasBlockingStaleness(staleness: Staleness): boolean {
  return Object.values(staleness).some((dimension) => (
    dimension.outcome === "needs_regrounding"
    || dimension.outcome === "not_resumable"
    || dimension.outcome === "not_actionable"
    || dimension.outcome === "rejected"
  ));
}

function hasAnyStaleness(staleness: Staleness): boolean {
  return Object.values(staleness).some((dimension) => dimension.outcome !== "current");
}

function isPermissionStale(permission: StalenessDimension): boolean {
  return permission.outcome === "needs_review"
    || permission.outcome === "needs_regrounding"
    || permission.outcome === "not_resumable"
    || permission.outcome === "not_actionable"
    || permission.outcome === "rejected";
}

function needsRenewedAuthority(item: RuntimeItem): boolean {
  return item.authority.requires_confirmation
    && activeRuntimeRefs([item]).length > 0
    && item.posture !== "holding"
    && item.posture !== "suppressed";
}

function isSafetyRuntimeItem(item: RuntimeItem): boolean {
  return (item.type === "guardrail_state" || item.type === "backpressure_state")
    && (item.status === "running" || item.status === "active" || item.status === "blocked");
}

function isContradictoryPosture(item: RuntimeItem): boolean {
  const completedLike = item.status === "completed"
    || item.status === "cancelled"
    || item.status === "expired"
    || item.status === "superseded";
  const activePosture = item.posture === "working"
    || item.posture === "watching"
    || item.posture === "waiting";
  return completedLike && activePosture;
}

function isSurfaceDependentRuntimeItem(item: RuntimeItem): boolean {
  return item.related_surface_refs.length > 0
    || item.related_memory_refs.length > 0
    || item.authority.speakable
    || item.authority.resumable
    || item.authority.actionable
    || item.authority.can_update_surface
    || item.authority.can_write_memory;
}

function runtimeItemId(item: RuntimeItem): string {
  return item.item_id;
}

function uniqueControls(controls: CompanionWideControl[]): CompanionWideControl[] {
  return [...new Set(controls)];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function emptyRuntimeSignals(): RuntimeSignals {
  return {
    authorityBlockerRefs: [],
    stalenessBlockerRefs: [],
    safetyBlockerRefs: [],
    blockedByBoundaryRefs: [],
    needsUserRefs: [],
    staleRefs: [],
    staleSurfaceRefs: [],
    invalidatedSurfaceRefs: [],
    waitingConditions: [],
  };
}

function inputRefs(input: CompanionStateReducerInput): string[] {
  return uniqueStrings([
    ...input.runtime_items.map(runtimeItemId),
    ...input.recent_runtime_events,
    ...(input.active_surface_ref === null ? [] : [input.active_surface_ref]),
    ...input.surface_invalidation_events,
    ...(input.global_control_state_ref === null ? [] : [input.global_control_state_ref]),
    ...input.active_goal_refs,
    ...input.active_watch_refs,
    ...input.active_wait_refs,
    ...input.active_quiet_work_refs,
    ...input.attention_history_refs,
    ...input.user_activity_refs,
    ...input.feedback_refs,
    ...input.safety_context_refs,
  ]);
}
