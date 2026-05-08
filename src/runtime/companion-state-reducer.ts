import {
  AuthoritySchema,
  CompanionStateReducerInputSchema,
  CompanionStateSnapshotSchema,
  StalenessSchema,
  type Authority,
  type CompanionGlobalControlEntry,
  type CompanionStateMode,
  type CompanionStateReducerInput,
  type CompanionStateSnapshot,
  type CompanionWideControl,
  type RuntimeItem,
  type Staleness,
} from "./types/companion-state.js";

const FAIL_CLOSED_AUTHORITY_REASON = "authority_missing_or_invalid_fail_closed";
const FAIL_CLOSED_STALENESS_REASON = "staleness_missing_or_invalid_fail_closed";

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
  const dimension = {
    outcome: "rejected" as const,
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

export function deriveCompanionStateSnapshot(input: unknown): CompanionStateSnapshot {
  const parsed = CompanionStateReducerInputSchema.safeParse(input);
  if (!parsed.success) {
    const now = new Date().toISOString();
    return buildSnapshot({
      computedAt: now,
      highWatermark: "invalid-input",
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
    });
  }
  return deriveFromParsedInput(parsed.data);
}

function deriveFromParsedInput(input: CompanionStateReducerInput): CompanionStateSnapshot {
  const controlDecision = interpretGlobalControls(input.global_controls);
  if (controlDecision.failClosed) {
    return buildSnapshot({
      computedAt: input.current_time,
      highWatermark: input.event_high_watermark,
      mode: "needs_user",
      controlOverlays: uniqueControls([
        ...input.control_overlays,
        "pause_proactivity",
        "require_confirmation_for_proactivity",
      ]),
      preSuspendMode: input.pre_suspend_mode,
      activeRefs: activeRuntimeRefs(input.runtime_items),
      heldRuntimeRefs: heldRuntimeRefs(input.runtime_items),
      blockedRefs: [...input.authority_blockers, ...input.safety_blockers, ...controlDecision.blockedRefs],
      staleRefs: input.staleness_blockers,
      matchedControlRefs: controlDecision.matchedControlRefs,
      matchedBlockerRefs: [...input.authority_blockers, ...input.safety_blockers, ...controlDecision.blockedRefs],
      matchedFeedbackRefs: input.feedback_refs,
      matchedActivityRefs: input.user_activity_refs,
      reason: controlDecision.reason,
      rejectedModes: ["working", "watching", "reaching_out", "escalating"],
    });
  }

  if (controlDecision.activeControls.includes("suspend_companion")) {
    const currentMode = selectNonSuspendedMode(input, controlDecision.activeControls);
    return buildSnapshot({
      computedAt: input.current_time,
      highWatermark: input.event_high_watermark,
      mode: "suspended",
      controlOverlays: uniqueControls([...input.control_overlays, "suspend_companion"]),
      preSuspendMode: input.pre_suspend_mode ?? currentMode,
      activeRefs: [],
      heldRuntimeRefs: activeRuntimeRefs(input.runtime_items),
      blockedRefs: [
        ...input.authority_blockers,
        ...input.safety_blockers,
        ...activeRuntimeRefs(input.runtime_items),
      ],
      staleRefs: input.staleness_blockers,
      matchedControlRefs: controlDecision.matchedControlRefs,
      matchedBlockerRefs: [...input.authority_blockers, ...input.safety_blockers],
      matchedFeedbackRefs: input.feedback_refs,
      matchedActivityRefs: input.user_activity_refs,
      reason: "suspend_companion_fail_closed",
      rejectedModes: ["working", "watching", "waiting", "reaching_out", "escalating"],
    });
  }

  if (input.authority_blockers.length > 0 || input.safety_blockers.length > 0) {
    return buildSnapshot({
      computedAt: input.current_time,
      highWatermark: input.event_high_watermark,
      mode: "needs_user",
      controlOverlays: input.control_overlays,
      preSuspendMode: input.pre_suspend_mode,
      activeRefs: activeRuntimeRefs(input.runtime_items),
      heldRuntimeRefs: heldRuntimeRefs(input.runtime_items),
      blockedRefs: [...input.authority_blockers, ...input.safety_blockers],
      staleRefs: input.staleness_blockers,
      matchedControlRefs: controlDecision.matchedControlRefs,
      matchedBlockerRefs: [...input.authority_blockers, ...input.safety_blockers],
      matchedFeedbackRefs: input.feedback_refs,
      matchedActivityRefs: input.user_activity_refs,
      reason: "authority_or_safety_blocker_fail_closed",
      rejectedModes: ["reaching_out", "escalating"],
    });
  }

  const mode = selectNonSuspendedMode(input, controlDecision.activeControls);
  return buildSnapshot({
    computedAt: input.current_time,
    highWatermark: input.event_high_watermark,
    mode,
    controlOverlays: uniqueControls([...input.control_overlays, ...controlDecision.activeControls]),
    preSuspendMode: input.pre_suspend_mode,
    activeRefs: activeRuntimeRefs(input.runtime_items),
    heldRuntimeRefs: heldRuntimeRefs(input.runtime_items),
    blockedRefs: [],
    staleRefs: input.staleness_blockers,
    matchedControlRefs: controlDecision.matchedControlRefs,
    matchedBlockerRefs: [],
    matchedFeedbackRefs: input.feedback_refs,
    matchedActivityRefs: input.user_activity_refs,
    reason: "companion_state_reducer_skeleton_selected_mode",
    rejectedModes: [],
  });
}

function interpretGlobalControls(globalControls: CompanionGlobalControlEntry[]): {
  activeControls: CompanionWideControl[];
  matchedControlRefs: string[];
  blockedRefs: string[];
  failClosed: boolean;
  reason: string;
} {
  const ambiguous = globalControls.filter((entry) => entry.state === "ambiguous");
  if (globalControls.length === 0) {
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

function selectNonSuspendedMode(
  input: CompanionStateReducerInput,
  activeControls: CompanionWideControl[]
): CompanionStateMode {
  const controls = uniqueControls([...input.control_overlays, ...activeControls]);
  if (controls.includes("enter_quiet_mode")) return "quieted";
  if (controls.includes("pause_proactivity")) return "proactivity_paused";
  if (input.runtime_items.some((item) => item.posture === "needs_user")) return "needs_user";
  if (input.runtime_items.some((item) => item.posture === "working")) return "working";
  if (input.runtime_items.some((item) => item.posture === "watching")) return "watching";
  if (input.runtime_items.some((item) => item.posture === "waiting")) return "waiting";
  return "resting";
}

function activeRuntimeRefs(items: RuntimeItem[]): string[] {
  return items
    .filter((item) => item.status === "running" || item.status === "pending" || item.status === "paused")
    .map((item) => item.id);
}

function heldRuntimeRefs(items: RuntimeItem[]): string[] {
  return items
    .filter((item) => item.posture === "holding" || item.posture === "waiting" || item.posture === "suppressed")
    .map((item) => item.id);
}

function uniqueControls(controls: CompanionWideControl[]): CompanionWideControl[] {
  return [...new Set(controls)];
}

function buildSnapshot(input: {
  computedAt: string;
  highWatermark: string;
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
}): CompanionStateSnapshot {
  return CompanionStateSnapshotSchema.parse({
    schema_version: "companion-state-snapshot-v1",
    snapshot_id: `companion-state:${input.highWatermark}:${input.mode}`,
    computed_at: input.computedAt,
    source_event_high_watermark: input.highWatermark,
    mode: input.mode,
    control_overlays: input.controlOverlays,
    budgets: {},
    threshold_overrides: {},
    cooldowns: [],
    blocked_refs: input.blockedRefs,
    stale_refs: input.staleRefs,
    active_refs: input.activeRefs,
    pre_suspend_mode: input.preSuspendMode,
    held_runtime_refs: input.heldRuntimeRefs,
    derivation_trace: {
      input_refs: input.activeRefs,
      matched_control_refs: input.matchedControlRefs,
      matched_blocker_refs: input.matchedBlockerRefs,
      matched_feedback_refs: input.matchedFeedbackRefs,
      matched_activity_refs: input.matchedActivityRefs,
      selected_mode: input.mode,
      budget_changes: [],
      threshold_changes: [],
      rejected_modes: input.rejectedModes,
      reason: input.reason,
    },
  });
}
