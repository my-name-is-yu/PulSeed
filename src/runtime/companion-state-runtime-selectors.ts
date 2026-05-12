import type {
  CompanionStateMode,
  CompanionStateReducerInput,
  CompanionWideControl,
  RuntimeEventRef,
  RuntimeItem,
  Staleness,
  StalenessDimension,
} from "./types/companion-state.js";

export type RuntimeSignals = {
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

export function deriveRuntimeSignals(input: CompanionStateReducerInput): RuntimeSignals {
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

export function selectBlockerMode(signals: RuntimeSignals): {
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
  if (signals.blockedByBoundaryRefs.length > 0) {
    return {
      mode: "overloaded",
      blockedRefs: signals.blockedByBoundaryRefs,
      reason: "runtime_boundary_blocker_fail_closed",
      rejectedModes: ["working", "watching", "reaching_out", "escalating"],
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

export function selectNonSuspendedMode(
  input: CompanionStateReducerInput,
  activeControls: CompanionWideControl[],
  signals: RuntimeSignals
): CompanionStateMode {
  const controls = uniqueControls([...input.control_overlays, ...activeControls]);
  if (controls.includes("enter_quiet_mode")) return "quieted";
  if (controls.includes("pause_proactivity")) return "proactivity_paused";
  if (
    controls.includes("stop_all_quiet_work")
    || controls.includes("stop_all_watches")
    || controls.includes("suppress_nonessential_agenda")
  ) return "holding_back";
  if (signals.waitingConditions.length > 0) return "waiting";
  if (input.runtime_items.some((item) => item.posture === "needs_user")) return "needs_user";
  if (input.runtime_items.some((item) => item.posture === "working")) return "working";
  if (input.runtime_items.some((item) => item.posture === "watching")) return "watching";
  if (input.runtime_items.some((item) => item.posture === "waiting")) return "waiting";
  if (input.runtime_items.some((item) =>
    item.type === "agent_agenda_item"
    && item.status === "mature"
    && !hasBlockingStaleness(item.staleness)
  )) return "watching";
  if (input.runtime_items.some((item) => item.type === "urge_candidate" && item.status === "mature")) return "curious";
  return "resting";
}

export function activeRuntimeRefs(items: RuntimeItem[]): string[] {
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

export function admittedActiveRuntimeRefs(items: RuntimeItem[], activeControls: CompanionWideControl[]): string[] {
  return items
    .filter((item) => activeRuntimeRefs([item]).length > 0)
    .filter((item) => isRuntimeItemAdmittedActive(item, activeControls))
    .map(runtimeItemId);
}

export function activeRefsOfType(items: RuntimeItem[], ...types: RuntimeItem["type"][]): string[] {
  return items
    .filter((item) => types.includes(item.type))
    .filter((item) => activeRuntimeRefs([item]).length > 0)
    .map(runtimeItemId);
}

export function admittedActiveRefsOfType(
  items: RuntimeItem[],
  activeControls: CompanionWideControl[],
  ...types: RuntimeItem["type"][]
): string[] {
  return items
    .filter((item) => types.includes(item.type))
    .filter((item) => activeRuntimeRefs([item]).length > 0)
    .filter((item) => isRuntimeItemAdmittedActive(item, activeControls))
    .map(runtimeItemId);
}

export function heldRuntimeRefs(items: RuntimeItem[]): string[] {
  return items
    .filter((item) => (
      item.posture === "holding"
      || item.posture === "waiting"
      || item.posture === "suppressed"
      || item.posture === "suspended"
      || item.companion_control_state.held_by_controls.length > 0
      || item.companion_control_state.rejected_by_controls.length > 0
    ))
    .map(runtimeItemId);
}

export function heldRuntimeRefsForControls(items: RuntimeItem[], activeControls: CompanionWideControl[]): string[] {
  if (activeControls.length === 0) return [];
  return items
    .filter((item) => {
      if (activeControls.includes("suspend_companion")) return activeRuntimeRefs([item]).length > 0;
      if (activeControls.includes("stop_all_quiet_work") && isQuietWorkRuntimeItem(item)) {
        return activeRuntimeRefs([item]).length > 0;
      }
      if (activeControls.includes("stop_all_watches") && item.type === "watch") {
        return activeRuntimeRefs([item]).length > 0;
      }
      if (activeControls.includes("suppress_nonessential_agenda") && isAgendaRuntimeItem(item)) {
        return activeRuntimeRefs([item]).length > 0;
      }
      if (
        (activeControls.includes("enter_quiet_mode") || activeControls.includes("pause_proactivity"))
        && isAgentOriginAdmissionItem(item)
      ) return activeRuntimeRefs([item]).length > 0;
      return false;
    })
    .map(runtimeItemId);
}

export function runtimeRefsHeldByCompanionControls(
  items: RuntimeItem[],
  activeControls: CompanionWideControl[]
): string[] {
  return uniqueStrings([
    ...heldRuntimeRefsForControls(items, activeControls),
    ...items
      .filter((item) => (
        item.companion_control_state.held_by_controls.length > 0
        || item.companion_control_state.rejected_by_controls.length > 0
      ))
      .map(runtimeItemId),
  ]);
}

export function inputRefs(input: CompanionStateReducerInput): string[] {
  return uniqueStrings([
    ...input.runtime_items.map(runtimeItemId),
    ...input.recent_runtime_events.map(runtimeEventId),
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

export function runtimeEventId(event: RuntimeEventRef): string {
  return typeof event === "string" ? event : event.event_id;
}

export function isQuietWorkRuntimeItem(item: RuntimeItem): boolean {
  return item.type === "run" || item.type === "task" || item.type === "diff_proposal";
}

export function isAgendaRuntimeItem(item: RuntimeItem): boolean {
  return item.type === "urge_candidate" || item.type === "agent_agenda_item";
}

export function isAgentOriginAdmissionItem(item: RuntimeItem): boolean {
  return isAgendaRuntimeItem(item)
    || item.type === "surface_projection"
    || item.authority.speakable
    || item.authority.can_create_urge
    || item.authority.can_write_memory
    || item.authority.can_update_surface
    || item.authority.can_delegate_work;
}

export function hasBlockingStaleness(staleness: Staleness): boolean {
  return Object.values(staleness).some((dimension) => (
    dimension.outcome === "needs_regrounding"
    || dimension.outcome === "not_resumable"
    || dimension.outcome === "not_actionable"
    || dimension.outcome === "rejected"
  ));
}

export function hasAnyStaleness(staleness: Staleness): boolean {
  return Object.values(staleness).some((dimension) => dimension.outcome !== "current");
}

export function isPermissionStale(permission: StalenessDimension): boolean {
  return permission.outcome === "needs_review"
    || permission.outcome === "needs_regrounding"
    || permission.outcome === "not_resumable"
    || permission.outcome === "not_actionable"
    || permission.outcome === "rejected";
}

export function needsRenewedAuthority(item: RuntimeItem): boolean {
  return item.authority.requires_confirmation
    && activeRuntimeRefs([item]).length > 0
    && item.posture !== "holding"
    && item.posture !== "suppressed";
}

export function isSafetyRuntimeItem(item: RuntimeItem): boolean {
  return (item.type === "guardrail_state" || item.type === "backpressure_state")
    && (
      item.status === "blocked"
      || item.status === "failed"
      || item.posture === "blocked_by_boundary"
      || item.posture === "needs_user"
    );
}

export function isContradictoryPosture(item: RuntimeItem): boolean {
  const completedLike = item.status === "completed"
    || item.status === "cancelled"
    || item.status === "expired"
    || item.status === "superseded";
  const activePosture = item.posture === "working"
    || item.posture === "watching"
    || item.posture === "waiting";
  return completedLike && activePosture;
}

export function isSurfaceDependentRuntimeItem(item: RuntimeItem): boolean {
  return item.related_surface_refs.length > 0
    || item.related_memory_refs.length > 0
    || item.authority.speakable
    || item.authority.resumable
    || item.authority.actionable
    || item.authority.can_update_surface
    || item.authority.can_write_memory;
}

export function runtimeItemId(item: RuntimeItem): string {
  return item.item_id;
}

export function uniqueControls(controls: CompanionWideControl[]): CompanionWideControl[] {
  return [...new Set(controls)];
}

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

export function emptyRuntimeSignals(): RuntimeSignals {
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

function isRuntimeItemAdmittedActive(item: RuntimeItem, activeControls: CompanionWideControl[]): boolean {
  if (item.companion_control_state.held_by_controls.length > 0) return false;
  if (item.companion_control_state.rejected_by_controls.length > 0) return false;
  if (activeControls.includes("suspend_companion")) return false;
  if (activeControls.includes("stop_all_quiet_work") && isQuietWorkRuntimeItem(item)) return false;
  if (activeControls.includes("stop_all_watches") && item.type === "watch") return false;
  if (activeControls.includes("suppress_nonessential_agenda") && isAgendaRuntimeItem(item)) return false;
  if (
    (activeControls.includes("enter_quiet_mode") || activeControls.includes("pause_proactivity"))
    && isAgentOriginAdmissionItem(item)
  ) return false;
  return true;
}
