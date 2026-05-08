import type { BackgroundRun } from "../session-registry/types.js";
import type {
  BackpressureSnapshot,
  BrowserAutomationSessionRecord,
  CircuitBreakerRecord,
  RuntimeAuthHandoffRecord,
} from "./runtime-schemas.js";
import type { RuntimeControlOperation, RuntimeControlOperationState } from "./runtime-operation-schemas.js";
import { deriveRuntimeItemControlPolicy } from "../companion-state-reducer.js";
import {
  RuntimeEventSchema,
  RuntimeItemSchema,
  type Authority,
  type AuthorityDeltaField,
  type RuntimeEvent,
  type RuntimeEventType,
  type RuntimeItem,
  type RuntimeItemCompanionControlState,
  type RuntimeItemPosture,
  type RuntimeItemStatus,
  type Staleness,
  type StalenessDimension,
  type StalenessDimensionKind,
} from "../types/companion-state.js";

const CURRENT_DIMENSION: StalenessDimension = { outcome: "current", reason: "runtime production record is current" };

export function runtimeItemFromOperation(operation: RuntimeControlOperation): RuntimeItem {
  const posture = postureFromOperationState(operation.state, operation);
  const authority = authorityFromOperation(operation);
  const staleness = stalenessFromOperation(operation);
  return withDerivedControlPolicy({
    schema_version: "runtime-item-v1",
    item_id: `runtime-control:${operation.operation_id}`,
    type: itemTypeFromOperation(operation),
    status: itemStatusFromOperationState(operation.state),
    posture,
    source: "runtime-operation-store",
    created_at: operation.requested_at,
    updated_at: operation.updated_at,
    related_goal_refs: operation.target?.goal_id ? [operation.target.goal_id] : [],
    related_task_refs: [],
    related_session_refs: operation.target?.session_id ? [operation.target.session_id] : [],
    related_memory_refs: [],
    related_surface_refs: [],
    related_agenda_refs: [],
    companion_state_refs: [],
    companion_control_state: emptyCompanionControlState("runtime operation is not held by companion-wide controls"),
    authority,
    staleness,
    visibility_policy: {
      display: operation.state === "pending" || operation.state === "running" || operation.state === "restarting"
        ? "normal"
        : "hidden",
      inspectable: true,
      auditable: true,
      policy_ref: null,
      reason: "runtime operation records remain inspectable and auditable",
    },
    visibility_policy_ref: null,
    control_policy: emptyControlPolicy("derived after RuntimeItem parse"),
    audit_trace_refs: [`runtime-control-operation:${operation.operation_id}`],
  });
}

export function runtimeEventFromOperationTransition(
  operation: RuntimeControlOperation,
  previous: RuntimeControlOperation | null,
): RuntimeEvent | null {
  if (previous !== null && previous.state === operation.state && previous.updated_at === operation.updated_at) {
    return null;
  }

  const before = previous ? runtimeItemFromOperation(previous) : null;
  const after = runtimeItemFromOperation(operation);
  const event = RuntimeEventSchema.parse({
    schema_version: "runtime-event-v1",
    event_id: [
      "runtime-event",
      encodeStableId(operation.operation_id),
      encodeStableId(previous?.state ?? "created"),
      encodeStableId(operation.state),
      encodeStableId(operation.updated_at),
    ].join(":"),
    event_type: eventTypeFromRuntimeItem(after, operation),
    item_ref: after.item_id,
    occurred_at: operation.updated_at,
    source: "runtime-operation-store",
    posture_before: before?.posture ?? null,
    posture_after: after.posture,
    authority_delta: {
      before: before?.authority ?? null,
      after: after.authority,
      changed_fields: changedAuthorityFields(before?.authority ?? null, after.authority),
    },
    staleness_delta: {
      before: before?.staleness ?? null,
      after: after.staleness,
      changed_dimensions: changedStalenessDimensions(before?.staleness ?? null, after.staleness),
    },
    companion_control_delta: {
      before: before?.companion_control_state ?? null,
      after: after.companion_control_state,
      changed_controls: companionControlFromOperation(operation),
    },
    surface_refs: after.related_surface_refs,
    companion_state_refs: after.companion_state_refs,
    audit_refs: after.audit_trace_refs,
  });
  return event;
}

export function runtimeItemFromBackgroundRun(run: BackgroundRun, observedAt: string): RuntimeItem {
  const staleness = currentStaleness();
  if (run.status === "succeeded" || run.status === "failed" || run.status === "timed_out" || run.status === "cancelled" || run.status === "lost") {
    staleness.session = { outcome: "not_resumable", reason: `background run is terminal: ${run.status}` };
  }
  return withDerivedControlPolicy({
    schema_version: "runtime-item-v1",
    item_id: `background-run:${run.id}`,
    type: "run",
    status: runtimeItemStatusFromBackgroundRun(run.status),
    posture: runtimeItemPostureFromBackgroundRun(run.status),
    source: "runtime-session-registry",
    created_at: run.created_at ?? observedAt,
    updated_at: run.updated_at ?? observedAt,
    related_goal_refs: run.goal_id ? [run.goal_id] : [],
    related_task_refs: [],
    related_session_refs: [run.parent_session_id, run.child_session_id, run.process_session_id].filter(isString),
    related_memory_refs: [],
    related_surface_refs: [],
    related_agenda_refs: [],
    companion_state_refs: [],
    companion_control_state: emptyCompanionControlState("session registry supplies runtime run state"),
    authority: run.status === "running" || run.status === "queued"
      ? actionableAuthority("runtime session registry selected a live background run", false)
      : inspectOnlyAuthority("terminal background run is inspectable but not resumable"),
    staleness,
    visibility_policy: {
      display: run.status === "running" || run.status === "queued" ? "normal" : "hidden",
      inspectable: true,
      auditable: true,
      policy_ref: null,
      reason: "background run state is shared runtime state",
    },
    visibility_policy_ref: null,
    control_policy: emptyControlPolicy("derived after RuntimeItem parse"),
    audit_trace_refs: [`background-run:${run.id}`],
  });
}

export function runtimeItemFromAuthHandoff(record: RuntimeAuthHandoffRecord, observedAt?: string): RuntimeItem {
  const terminal = record.state === "completed" || record.state === "cancelled" || record.state === "expired" || record.state === "superseded";
  const staleness = currentStaleness();
  if (record.state === "expired" || isPastIso(record.expires_at, observedAt)) {
    staleness.auth_handoff = { outcome: "not_resumable", reason: "auth handoff is expired" };
    staleness.browser_session = { outcome: "not_resumable", reason: "expired auth handoff cannot resume browser work" };
  }
  if (record.state === "superseded") {
    staleness.auth_handoff = { outcome: "summary_only", reason: "auth handoff was superseded" };
  }

  return withDerivedControlPolicy({
    schema_version: "runtime-item-v1",
    item_id: `auth-handoff:${record.handoff_id}`,
    type: "auth_handoff",
    status: terminal ? "completed" : "active",
    posture: terminal ? "ready_to_digest" : "needs_user",
    source: "runtime-auth-handoff-store",
    created_at: record.requested_at,
    updated_at: record.updated_at,
    related_goal_refs: [],
    related_task_refs: [],
    related_session_refs: [record.browser_session_id, record.resumable_session_id].filter(isString),
    related_memory_refs: [],
    related_surface_refs: [],
    related_agenda_refs: [],
    companion_state_refs: [],
    companion_control_state: emptyCompanionControlState("auth handoff is governed by runtime control"),
    authority: terminal
      ? inspectOnlyAuthority("terminal auth handoff is inspectable but not actionable")
      : inspectOnlyAuthority("auth handoff requires operator permission before automation can proceed"),
    staleness,
    visibility_policy: hiddenInspectableVisibility("auth handoff details are inspectable through runtime state"),
    visibility_policy_ref: null,
    control_policy: emptyControlPolicy("derived after RuntimeItem parse"),
    audit_trace_refs: [`auth-handoff:${record.handoff_id}`, ...record.evidence_refs.map((ref) => ref.ref)],
  });
}

export function runtimeItemFromBrowserSession(record: BrowserAutomationSessionRecord, observedAt: string): RuntimeItem {
  const expired = record.state === "expired" || isPastIso(record.expires_at, observedAt);
  const blocked = record.state === "blocked" || record.state === "unavailable";
  const staleness = currentStaleness();
  if (expired) {
    staleness.browser_session = { outcome: "not_resumable", reason: "browser session is expired" };
    staleness.session = { outcome: "not_resumable", reason: "expired browser session cannot be resumed implicitly" };
  } else if (blocked) {
    staleness.browser_session = { outcome: "not_actionable", reason: `browser session is ${record.state}` };
    staleness.session = { outcome: "not_actionable", reason: `browser session is ${record.state}` };
  }
  if (record.state === "auth_required") {
    staleness.permission = { outcome: "needs_review", reason: "browser session requires authentication" };
  }

  return withDerivedControlPolicy({
    schema_version: "runtime-item-v1",
    item_id: `browser-session:${record.session_id}`,
    type: "browser_session",
    status: expired || blocked ? "blocked" : "active",
    posture: expired ? "stale" : blocked ? "blocked_by_boundary" : record.state === "auth_required" ? "needs_user" : "watching",
    source: "browser-session-store",
    created_at: record.created_at,
    updated_at: record.updated_at ?? observedAt,
    related_goal_refs: [],
    related_task_refs: [],
    related_session_refs: [record.session_id],
    related_memory_refs: [],
    related_surface_refs: [],
    related_agenda_refs: [],
    companion_state_refs: [],
    companion_control_state: emptyCompanionControlState("browser session is governed by runtime control"),
    authority: expired || blocked
      ? inspectOnlyAuthority(`browser session is ${expired ? "expired" : record.state}`)
      : inspectOnlyAuthority(
          "browser session state is inspectable but automation still requires runtime admission",
          record.state !== "authenticated" && record.state !== "fresh",
        ),
    staleness,
    visibility_policy: hiddenInspectableVisibility("browser session state is hidden from normal display but inspectable"),
    visibility_policy_ref: null,
    control_policy: emptyControlPolicy("derived after RuntimeItem parse"),
    audit_trace_refs: [`browser-session:${record.session_id}`],
  });
}

export function runtimeItemFromGuardrailBreaker(record: CircuitBreakerRecord): RuntimeItem {
  const blocking = record.state === "open" || record.state === "paused";
  const staleness = currentStaleness();
  if (blocking) {
    staleness.project = { outcome: "not_actionable", reason: `guardrail breaker is ${record.state}` };
  }
  return withDerivedControlPolicy({
    schema_version: "runtime-item-v1",
    item_id: `guardrail:${record.key}`,
    type: "guardrail_state",
    status: blocking ? "blocked" : "active",
    posture: blocking ? "blocked_by_boundary" : "watching",
    source: "guardrail-store",
    created_at: record.opened_at ?? record.updated_at,
    updated_at: record.updated_at,
    related_goal_refs: [],
    related_task_refs: [],
    related_session_refs: [],
    related_memory_refs: [],
    related_surface_refs: [],
    related_agenda_refs: [],
    companion_state_refs: [],
    companion_control_state: emptyCompanionControlState("guardrail state narrows runtime admission"),
    authority: blocking
      ? inspectOnlyAuthority("guardrail state blocks runtime action")
      : inspectOnlyAuthority("guardrail state is inspectable safety evidence", false),
    staleness,
    visibility_policy: hiddenInspectableVisibility("guardrail state remains inspectable safety evidence"),
    visibility_policy_ref: null,
    control_policy: emptyControlPolicy("derived after RuntimeItem parse"),
    audit_trace_refs: [`guardrail:${record.key}`],
  });
}

export function runtimeItemsFromBackpressureSnapshot(snapshot: BackpressureSnapshot, observedAt: string): RuntimeItem[] {
  const active = snapshot.active.map((lease) => withDerivedControlPolicy({
    schema_version: "runtime-item-v1" as const,
    item_id: `backpressure:active:${lease.provider_id}:${lease.service_key}:${lease.run_key}`,
    type: "backpressure_state" as const,
    status: "active" as const,
    posture: "watching" as const,
    source: "backpressure-snapshot",
    created_at: lease.acquired_at,
    updated_at: snapshot.updated_at,
    related_goal_refs: [],
    related_task_refs: [lease.run_key],
    related_session_refs: [],
    related_memory_refs: [],
    related_surface_refs: [],
    related_agenda_refs: [],
    companion_state_refs: [],
    companion_control_state: emptyCompanionControlState("backpressure lease constrains capacity"),
    authority: inspectOnlyAuthority("backpressure lease is inspectable capacity evidence", false),
    staleness: currentStaleness(),
    visibility_policy: hiddenInspectableVisibility("backpressure state remains inspectable"),
    visibility_policy_ref: null,
    control_policy: emptyControlPolicy("derived after RuntimeItem parse"),
    audit_trace_refs: [`backpressure:${lease.provider_id}:${lease.service_key}:${lease.run_key}`],
  }));
  const throttled = snapshot.throttled.map((entry) => withDerivedControlPolicy({
    schema_version: "runtime-item-v1" as const,
    item_id: `backpressure:throttled:${entry.provider_id}:${entry.service_key}:${encodeStableId(entry.at)}`,
    type: "backpressure_state" as const,
    status: "blocked" as const,
    posture: "blocked_by_boundary" as const,
    source: "backpressure-snapshot",
    created_at: entry.at,
    updated_at: snapshot.updated_at ?? observedAt,
    related_goal_refs: [],
    related_task_refs: [],
    related_session_refs: [],
    related_memory_refs: [],
    related_surface_refs: [],
    related_agenda_refs: [],
    companion_state_refs: [],
    companion_control_state: emptyCompanionControlState("backpressure throttle blocks work admission"),
    authority: inspectOnlyAuthority("backpressure throttle blocks work admission"),
    staleness: {
      ...currentStaleness(),
      project: { outcome: "not_actionable", reason: entry.reason },
    },
    visibility_policy: hiddenInspectableVisibility("backpressure throttle remains inspectable"),
    visibility_policy_ref: null,
    control_policy: emptyControlPolicy("derived after RuntimeItem parse"),
    audit_trace_refs: [`backpressure:${entry.provider_id}:${entry.service_key}:${entry.at}`],
  }));
  return [...active, ...throttled];
}

export function buildRuntimeEventHighWatermark(events: RuntimeEvent[], fallback: string): string {
  const latest = [...events].sort((a, b) => b.occurred_at.localeCompare(a.occurred_at))[0];
  return latest?.event_id ?? fallback;
}

function withDerivedControlPolicy(input: Omit<RuntimeItem, "control_policy"> & { control_policy: RuntimeItem["control_policy"] }): RuntimeItem {
  const parsed = RuntimeItemSchema.parse(input);
  return RuntimeItemSchema.parse({
    ...parsed,
    control_policy: deriveRuntimeItemControlPolicy(parsed),
  });
}

function currentStaleness(): Staleness {
  return {
    temporal: CURRENT_DIMENSION,
    world: CURRENT_DIMENSION,
    project: CURRENT_DIMENSION,
    permission: CURRENT_DIMENSION,
    relationship: CURRENT_DIMENSION,
    surface: CURRENT_DIMENSION,
    goal: CURRENT_DIMENSION,
    assumption: CURRENT_DIMENSION,
    session: CURRENT_DIMENSION,
    browser_session: CURRENT_DIMENSION,
    auth_handoff: CURRENT_DIMENSION,
  };
}

function emptyControlPolicy(reason: string): RuntimeItem["control_policy"] {
  return {
    allowed_controls: [],
    forbidden_controls: [],
    required_confirmation: [],
    repair_options: [],
    reason,
  };
}

function emptyCompanionControlState(reason: string): RuntimeItemCompanionControlState {
  return {
    active_controls: [],
    global_control_refs: [],
    held_by_controls: [],
    rejected_by_controls: [],
    reason,
  };
}

function hiddenInspectableVisibility(reason: string): RuntimeItem["visibility_policy"] {
  return {
    display: "hidden",
    inspectable: true,
    auditable: true,
    policy_ref: null,
    reason,
  };
}

function inspectOnlyAuthority(reason: string, requiresConfirmation = true): Authority {
  return {
    inspectable: true,
    resumable: false,
    actionable: false,
    speakable: false,
    can_create_urge: false,
    can_update_surface: false,
    can_write_memory: false,
    can_delegate_work: false,
    requires_confirmation: requiresConfirmation,
    approval_scope: "inspect_only",
    authority_reason: reason,
  };
}

function actionableAuthority(reason: string, requiresConfirmation = true): Authority {
  return {
    inspectable: true,
    resumable: true,
    actionable: true,
    speakable: false,
    can_create_urge: false,
    can_update_surface: false,
    can_write_memory: false,
    can_delegate_work: false,
    requires_confirmation: requiresConfirmation,
    approval_scope: "bounded_runtime_item",
    authority_reason: reason,
  };
}

function authorityFromOperation(operation: RuntimeControlOperation): Authority {
  if (operation.state === "verified" || operation.state === "cancelled") {
    return inspectOnlyAuthority(`runtime operation is terminal: ${operation.state}`);
  }
  if (operation.state === "blocked" || operation.state === "failed") {
    return inspectOnlyAuthority(operation.result?.message ?? "runtime operation is blocked");
  }
  if (operation.kind === "inspect_run" || operation.kind === "inspect_permission_boundary" || operation.kind === "audit_permission_check") {
    return inspectOnlyAuthority("inspection operation grants no side-effect authority");
  }
  return actionableAuthority(
    operation.state === "pending"
      ? "runtime control operation is pending shared execution admission"
      : "runtime control operation has passed shared execution admission",
    operation.state === "pending" && operation.risk?.requires_approval === true,
  );
}

function stalenessFromOperation(operation: RuntimeControlOperation): Staleness {
  const staleness = currentStaleness();
  if (operation.state === "blocked" || operation.state === "failed") {
    staleness.project = { outcome: "not_actionable", reason: operation.result?.message ?? "runtime operation blocked" };
  }
  if (operation.target?.session_id && (operation.state === "blocked" || operation.state === "failed")) {
    staleness.session = { outcome: "needs_review", reason: operation.result?.message ?? "runtime session target needs review" };
  }
  return staleness;
}

function itemTypeFromOperation(operation: RuntimeControlOperation): RuntimeItem["type"] {
  if (operation.kind === "inspect_session" || operation.kind === "summarize_session_without_resuming") {
    return "session";
  }
  if (companionControlFromOperation(operation).length > 0) {
    return operation.kind === "inspect_companion_state" ? "audit_trace" : "hold";
  }
  if (operation.kind === "automation_control") {
    switch (operation.automation_control?.domain) {
      case "auth_handoff":
        return "auth_handoff";
      case "browser_session":
        return "browser_session";
      case "guardrail":
        return "guardrail_state";
      case "backpressure":
        return "backpressure_state";
    }
  }
  if (operation.kind === "inspect_permission_boundary"
    || operation.kind === "revoke_permission"
    || operation.kind === "narrow_permission"
    || operation.kind === "extend_permission"
    || operation.kind === "audit_permission_check") {
    return "permission_boundary";
  }
  return "run";
}

function companionControlFromOperation(
  operation: RuntimeControlOperation
): RuntimeEvent["companion_control_delta"]["changed_controls"] {
  switch (operation.kind) {
    case "inspect_companion_state":
    case "enter_quiet_mode":
    case "leave_quiet_mode":
    case "pause_proactivity":
    case "resume_proactivity":
    case "suspend_companion":
    case "resume_companion":
    case "stop_all_quiet_work":
    case "stop_all_watches":
    case "suppress_nonessential_agenda":
    case "require_confirmation_for_proactivity":
      return [operation.kind];
    default:
      return [];
  }
}

function itemStatusFromOperationState(state: RuntimeControlOperationState): RuntimeItemStatus {
  switch (state) {
    case "pending":
    case "approved":
      return "pending";
    case "acknowledged":
    case "running":
    case "restarting":
      return "running";
    case "verified":
      return "completed";
    case "blocked":
      return "blocked";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
}

function postureFromOperationState(
  state: RuntimeControlOperationState,
  operation: RuntimeControlOperation,
): RuntimeItemPosture {
  switch (state) {
    case "pending":
    case "approved":
      return "waiting";
    case "acknowledged":
    case "running":
    case "restarting":
      return "working";
    case "verified":
      return "ready_to_digest";
    case "blocked":
      return operation.risk?.requires_approval ? "needs_user" : "blocked_by_boundary";
    case "failed":
      return operation.risk?.requires_approval ? "needs_user" : "blocked_by_boundary";
    case "cancelled":
      return "rejected";
  }
}

function eventTypeFromRuntimeItem(item: RuntimeItem, operation: RuntimeControlOperation): RuntimeEventType {
  if (operation.kind === "finalize_run" && operation.state === "blocked" && operation.result?.ok === true) {
    return "action_candidate_prepared";
  }
  if (item.staleness.surface.outcome === "needs_regrounding" || item.staleness.session.outcome === "not_resumable") {
    return "resume_requires_regrounding";
  }
  switch (item.posture) {
    case "holding":
      return "holding_urge";
    case "waiting":
      return "waiting";
    case "working":
      return "working";
    case "blocked_by_boundary":
      return "blocked_by_boundary";
    case "needs_user":
      return "needs_permission";
    case "ready_to_digest":
      return "ready_to_digest";
    case "stale":
      return "stale_context_detected";
    case "suppressed":
      return "chose_silence";
    case "watching":
      return "observing";
    case "proposed":
      return "action_candidate_prepared";
    case "cooling_down":
    case "safe_to_forget":
    case "suspended":
    case "committed":
    case "rejected":
      return "observing";
  }
}

function runtimeItemStatusFromBackgroundRun(status: BackgroundRun["status"]): RuntimeItemStatus {
  switch (status) {
    case "queued":
      return "pending";
    case "running":
      return "running";
    case "succeeded":
      return "completed";
    case "failed":
    case "timed_out":
    case "lost":
    case "unknown":
      return "failed";
    case "cancelled":
      return "cancelled";
  }
}

function runtimeItemPostureFromBackgroundRun(status: BackgroundRun["status"]): RuntimeItemPosture {
  switch (status) {
    case "queued":
      return "waiting";
    case "running":
      return "working";
    case "succeeded":
      return "ready_to_digest";
    case "failed":
    case "timed_out":
    case "lost":
    case "unknown":
      return "blocked_by_boundary";
    case "cancelled":
      return "rejected";
  }
}

function changedAuthorityFields(before: Authority | null, after: Authority): AuthorityDeltaField[] {
  const fields: AuthorityDeltaField[] = [
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
  ];
  if (!before) return fields;
  return fields.filter((field) => before[field] !== after[field]);
}

function changedStalenessDimensions(before: Staleness | null, after: Staleness): StalenessDimensionKind[] {
  const dimensions: StalenessDimensionKind[] = [
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
  ];
  if (!before) return dimensions;
  return dimensions.filter((dimension) => (
    before[dimension].outcome !== after[dimension].outcome
    || before[dimension].reason !== after[dimension].reason
  ));
}

function isPastIso(value?: string | null, nowIso?: string): boolean {
  if (!value) return false;
  const ms = Date.parse(value);
  const nowMs = nowIso ? Date.parse(nowIso) : Date.now();
  return Number.isFinite(ms) && Number.isFinite(nowMs) && ms <= nowMs;
}

function isString(value: string | null | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function encodeStableId(value: string): string {
  return encodeURIComponent(value).replaceAll("%", "_");
}
