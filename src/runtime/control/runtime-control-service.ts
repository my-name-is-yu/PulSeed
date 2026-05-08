import { randomUUID } from "node:crypto";
import type { StateManager } from "../../base/state/state-manager.js";
import {
  createRuntimeSessionRegistry,
  type BackgroundRun,
  type RuntimeSession,
} from "../session-registry/index.js";
import { RuntimeEvidenceLedger, type RuntimeEvidenceLedgerPort } from "../store/evidence-ledger.js";
import { RuntimeOperationStore } from "../store/runtime-operation-store.js";
import { RuntimeOperatorHandoffStore } from "../store/operator-handoff-store.js";
import { BrowserSessionStore, RuntimeAuthHandoffStore } from "../interactive-automation/index.js";
import { breakerKey, GuardrailStore } from "../guardrails/index.js";
import {
  assembleCompanionStateReducerInput,
  deriveRuntimeItemControlPolicy,
  deriveCompanionStateSnapshot,
} from "../companion-state-reducer.js";
import {
  buildRuntimeEventHighWatermark,
  runtimeItemFromAuthHandoff,
  runtimeItemFromBackgroundRun,
  runtimeItemFromBrowserSession,
  runtimeItemFromGuardrailBreaker,
  runtimeItemsFromBackpressureSnapshot,
} from "../store/runtime-operation-companion.js";
import type {
  CompanionGlobalControlEntry,
  CompanionStateReducerInput,
  CompanionStateSnapshot,
  CompanionWideControl,
  CompanionResumeOutcome,
  RuntimeItem,
} from "../types/companion-state.js";
import type {
  PermissionGrantCapability,
  PermissionGrantCreateInput,
  PermissionGrantRecord,
  PermissionGrantStore,
} from "../store/permission-grant-store.js";
import type {
  RuntimeControlActor,
  RuntimeControlOperation,
  RuntimeControlOperationKind,
  RuntimeControlOperationState,
  RuntimeControlReplyTarget,
} from "../store/runtime-operation-schemas.js";
import type { RuntimeControlIntent } from "./runtime-control-intent.js";
import { resolveRuntimeTarget } from "./runtime-target-resolver.js";

export interface RuntimeControlRequest {
  intent: RuntimeControlIntent;
  cwd: string;
  requestedBy?: RuntimeControlActor;
  replyTarget?: RuntimeControlReplyTarget;
  approvalFn?: (reason: string) => Promise<boolean>;
}

export interface RuntimeRunControlRequestBase {
  runId?: string;
  sessionId?: string;
  reason: string;
  cwd: string;
  requestedBy?: RuntimeControlActor;
  replyTarget?: RuntimeControlReplyTarget;
  approvalFn?: (reason: string) => Promise<boolean>;
}

export interface RuntimeFinalizeRunRequest extends RuntimeRunControlRequestBase {
  externalActions?: string[];
  irreversible?: boolean;
}

export interface RuntimeControlResult {
  success: boolean;
  message: string;
  operationId?: string;
  state?: RuntimeControlOperationState;
  resumeOutcome?: CompanionResumeOutcome;
}

export interface RuntimeCompanionStateBoundaryRequest {
  activeSurfaceRef?: string | null;
  surfaceInvalidationEvents?: string[];
  globalControlStateRef?: string | null;
  globalControls?: CompanionGlobalControlEntry[];
  controlOverlays?: CompanionWideControl[];
  preSuspendMode?: CompanionStateSnapshot["pre_suspend_mode"];
  userActivityRefs?: string[];
  feedbackRefs?: string[];
  safetyContextRefs?: string[];
  eventHighWatermark?: string;
  currentTime?: string;
}

export interface RuntimeCompanionStateBoundaryResult {
  input: CompanionStateReducerInput;
  snapshot: CompanionStateSnapshot;
}

export type RuntimeAutomationControlDomain = "auth_handoff" | "browser_session" | "guardrail" | "backpressure";

export interface RuntimeAutomationControlRequest {
  domain: RuntimeAutomationControlDomain;
  action: string;
  reason: string;
  cwd: string;
  handoffId?: string;
  sessionId?: string;
  providerId?: string;
  serviceKey?: string;
  requestedBy?: RuntimeControlActor;
  replyTarget?: RuntimeControlReplyTarget;
  approvalFn?: (reason: string) => Promise<boolean>;
}

export interface RuntimeControlExecutorResult {
  ok: boolean;
  message?: string;
  state?: RuntimeControlOperationState;
}

export type RuntimeControlExecutor = (
  operation: RuntimeControlOperation,
  request: RuntimeControlRequest
) => Promise<RuntimeControlExecutorResult>;

export interface RuntimeControlServiceOptions {
  operationStore?: RuntimeOperationStore;
  runtimeRoot?: string;
  stateManager?: StateManager;
  sessionRegistry?: Pick<ReturnType<typeof createRuntimeSessionRegistry>, "snapshot">;
  evidenceLedger?: RuntimeEvidenceLedgerPort;
  operatorHandoffStore?: Pick<RuntimeOperatorHandoffStore, "create">;
  permissionGrantStore?: Pick<PermissionGrantStore, "list" | "listActive" | "revoke" | "supersede" | "activate">;
  authHandoffStore?: RuntimeAuthHandoffStore;
  browserSessionStore?: BrowserSessionStore;
  guardrailStore?: GuardrailStore;
  executor?: RuntimeControlExecutor;
  now?: () => Date;
}

type RuntimeControlStep =
  | { ok: true; operation: RuntimeControlOperation }
  | { ok: false; result: RuntimeControlResult };

type TargetResolution =
  | { ok: true; run?: BackgroundRun; goalId?: string | null }
  | { ok: false; result: RuntimeControlResult };

type ProjectedGlobalControls = {
  stateRef: string | null;
  controls: CompanionGlobalControlEntry[];
  activeControls: CompanionWideControl[];
};

type QuietWorkStopResult = {
  itemRef: string;
  operationId: string;
  state: RuntimeControlOperationState;
  ok: boolean;
};

type QuietWorkStopSummary = {
  ok: boolean;
  message: string;
  results: QuietWorkStopResult[];
};

const DEACTIVATES_COMPANION_CONTROL: Partial<Record<CompanionWideControl, CompanionWideControl>> = {
  leave_quiet_mode: "enter_quiet_mode",
  resume_proactivity: "pause_proactivity",
  resume_companion: "suspend_companion",
};

export class RuntimeControlService {
  private readonly operationStore: RuntimeOperationStore;
  private readonly sessionRegistry?: Pick<ReturnType<typeof createRuntimeSessionRegistry>, "snapshot">;
  private readonly evidenceLedger?: RuntimeEvidenceLedgerPort;
  private readonly operatorHandoffStore?: Pick<RuntimeOperatorHandoffStore, "create">;
  private readonly permissionGrantStore?: Pick<PermissionGrantStore, "list" | "listActive" | "revoke" | "supersede" | "activate">;
  private readonly authHandoffStore: RuntimeAuthHandoffStore;
  private readonly browserSessionStore: BrowserSessionStore;
  private readonly guardrailStore: GuardrailStore;
  private readonly executor?: RuntimeControlExecutor;
  private readonly now: () => Date;

  constructor(options: RuntimeControlServiceOptions = {}) {
    this.operationStore = options.operationStore ?? new RuntimeOperationStore(options.runtimeRoot);
    this.sessionRegistry = options.sessionRegistry ?? (options.stateManager
      ? createRuntimeSessionRegistry({ stateManager: options.stateManager })
      : undefined);
    this.evidenceLedger = options.evidenceLedger ?? (options.runtimeRoot ? new RuntimeEvidenceLedger(options.runtimeRoot) : undefined);
    this.operatorHandoffStore = options.operatorHandoffStore ?? (options.runtimeRoot ? new RuntimeOperatorHandoffStore(options.runtimeRoot) : undefined);
    this.permissionGrantStore = options.permissionGrantStore;
    this.authHandoffStore = options.authHandoffStore ?? new RuntimeAuthHandoffStore(options.runtimeRoot);
    this.browserSessionStore = options.browserSessionStore ?? new BrowserSessionStore(options.runtimeRoot);
    this.guardrailStore = options.guardrailStore ?? new GuardrailStore(options.runtimeRoot);
    this.executor = options.executor;
    this.now = options.now ?? (() => new Date());
  }

  async request(request: RuntimeControlRequest): Promise<RuntimeControlResult> {
    if (isCompanionWideControlKind(request.intent.kind)) {
      return this.handleCompanionWideControl(request);
    }

    if (isSessionControlKind(request.intent.kind)) {
      return this.handleSessionControl(request);
    }

    if (isPermissionControlKind(request.intent.kind)) {
      return this.handlePermissionControl(request);
    }

    if (isRunControlKind(request.intent.kind)) {
      return this.handleRunControl(request);
    }

    if (!isExecutableRuntimeControlKind(request.intent.kind)) {
      return {
        success: false,
        message: `Runtime control operation ${request.intent.kind} is not supported by the production executor.`,
        state: "failed",
      };
    }

    const initial = await this.createInitialOperation(request);
    const approved = await this.approveIfRequired(initial, request.approvalFn);
    if (!approved.ok) return approved.result;

    const acknowledged = await this.acknowledge(approved.operation);
    return this.executeAcknowledgedOperation(acknowledged, request);
  }

  inspectRun(request: RuntimeRunControlRequestBase): Promise<RuntimeControlResult> {
    return this.request({ ...request, intent: { kind: "inspect_run", reason: request.reason, target: targetFromRunRequest(request) } });
  }

  pauseRun(request: RuntimeRunControlRequestBase): Promise<RuntimeControlResult> {
    return this.request({ ...request, intent: { kind: "pause_run", reason: request.reason, target: targetFromRunRequest(request) } });
  }

  resumeRun(request: RuntimeRunControlRequestBase): Promise<RuntimeControlResult> {
    return this.request({ ...request, intent: { kind: "resume_run", reason: request.reason, target: targetFromRunRequest(request) } });
  }

  cancelRun(request: RuntimeRunControlRequestBase): Promise<RuntimeControlResult> {
    return this.request({ ...request, intent: { kind: "cancel_run", reason: request.reason, target: targetFromRunRequest(request) } });
  }

  finalizeRun(request: RuntimeFinalizeRunRequest): Promise<RuntimeControlResult> {
    return this.request({
      ...request,
      intent: {
        kind: "finalize_run",
        reason: request.reason,
        target: targetFromRunRequest(request),
        externalActions: request.externalActions,
        irreversible: request.irreversible ?? true,
      },
    });
  }

  async controlAutomation(request: RuntimeAutomationControlRequest): Promise<RuntimeControlResult> {
    const mutation = request.action !== "inspect";
    if (mutation && !request.approvalFn) {
      return this.recordAutomationOperation(request, "blocked", false, "Runtime automation mutation requires an approval surface.");
    }
    if (mutation) {
      const approved = await request.approvalFn?.(`Runtime automation ${request.domain}.${request.action}: ${request.reason}`);
      if (!approved) {
        return this.recordAutomationOperation(request, "cancelled", false, "Runtime automation operation was not approved.");
      }
    }

    const result = await this.applyAutomationControl(request);
    return this.recordAutomationOperation(
      request,
      result.success ? "verified" : "blocked",
      result.success,
      result.message,
    );
  }

  async assembleCompanionStateInput(
    request: RuntimeCompanionStateBoundaryRequest = {},
  ): Promise<CompanionStateReducerInput> {
    const currentTime = request.currentTime ?? this.nowIso();
    const collectedRuntimeItems = await this.collectRuntimeItems(currentTime);
    const runtimeEvents = await this.operationStore.listRuntimeEvents();
    const projectedControls = request.globalControls
      ? null
      : await this.projectGlobalControlState(collectedRuntimeItems);
    const globalControls = request.globalControls ?? projectedControls?.controls ?? [];
    const activeControls = request.globalControls
      ? globalControls.filter((entry) => entry.state === "active").map((entry) => entry.control)
      : projectedControls?.activeControls ?? [];
    const runtimeItems = applyCompanionControlState(collectedRuntimeItems, globalControls, activeControls);
    return assembleCompanionStateReducerInput({
      runtime_items: runtimeItems,
      recent_runtime_events: runtimeEvents,
      active_surface_ref: request.activeSurfaceRef ?? null,
      surface_invalidation_events: request.surfaceInvalidationEvents ?? [],
      global_control_state_ref: request.globalControlStateRef ?? projectedControls?.stateRef ?? null,
      global_controls: globalControls,
      control_overlays: request.controlOverlays ?? [],
      pre_suspend_mode: request.preSuspendMode ?? null,
      user_activity_refs: request.userActivityRefs ?? [],
      feedback_refs: request.feedbackRefs ?? [],
      safety_context_refs: request.safetyContextRefs ?? [],
      event_high_watermark: request.eventHighWatermark
        ?? buildRuntimeEventHighWatermark(runtimeEvents, `runtime-event-high-watermark:${currentTime}`),
      current_time: currentTime,
    });
  }

  async recomputeCompanionState(
    request: RuntimeCompanionStateBoundaryRequest = {},
  ): Promise<RuntimeCompanionStateBoundaryResult> {
    const input = await this.assembleCompanionStateInput(request);
    return {
      input,
      snapshot: deriveCompanionStateSnapshot(input),
    };
  }

  inspectCompanionState(request: Omit<RuntimeControlRequest, "intent"> & { reason: string }): Promise<RuntimeControlResult> {
    return this.request({ ...request, intent: { kind: "inspect_companion_state", reason: request.reason } });
  }

  setCompanionControl(
    request: Omit<RuntimeControlRequest, "intent"> & { control: CompanionWideControl; reason: string }
  ): Promise<RuntimeControlResult> {
    return this.request({ ...request, intent: { kind: request.control, reason: request.reason } });
  }

  inspectSession(request: RuntimeRunControlRequestBase): Promise<RuntimeControlResult> {
    return this.request({ ...request, intent: { kind: "inspect_session", reason: request.reason, target: targetFromRunRequest(request) } });
  }

  summarizeSessionWithoutResuming(request: RuntimeRunControlRequestBase): Promise<RuntimeControlResult> {
    return this.request({
      ...request,
      intent: { kind: "summarize_session_without_resuming", reason: request.reason, target: targetFromRunRequest(request) },
    });
  }

  private async handleCompanionWideControl(request: RuntimeControlRequest): Promise<RuntimeControlResult> {
    const runtimeItemsBeforeControl = await this.collectRuntimeItems(this.nowIso());
    const initial = await this.createInitialOperation(request);
    const control = request.intent.kind as CompanionWideControl;
    const affectedRefs = affectedRuntimeRefsForControl(
      control,
      runtimeItemsBeforeControl,
    );

    if (request.intent.kind === "inspect_companion_state") {
      const current = await this.recomputeCompanionState({
        activeSurfaceRef: null,
        currentTime: this.nowIso(),
      });
      const inspected = await this.update(initial, "verified", {
        ok: true,
        message: formatCompanionStateSummary(current.snapshot),
      });
      return this.toResult(inspected);
    }

    const quietWorkStop = control === "stop_all_quiet_work"
      ? await this.stopActiveQuietWork(initial, runtimeItemsBeforeControl, request)
      : null;
    const verified = await this.update(initial, "verified", {
      ok: quietWorkStop?.ok ?? true,
      message: [
        formatCompanionControlApplied(control, affectedRefs),
        quietWorkStop?.message,
      ].filter((part): part is string => Boolean(part)).join(" "),
    });
    return this.toResult(verified);
  }

  private async stopActiveQuietWork(
    parentOperation: RuntimeControlOperation,
    runtimeItems: RuntimeItem[],
    request: RuntimeControlRequest,
  ): Promise<QuietWorkStopSummary> {
    const quietItems = runtimeItems
      .filter(activeRuntimeItem)
      .filter(quietWorkRuntimeItem);

    if (quietItems.length === 0) {
      return {
        ok: true,
        message: "No active quiet work needed an interruption request.",
        results: [],
      };
    }

    const results: QuietWorkStopResult[] = [];
    for (const item of quietItems) {
      results.push(await this.stopQuietWorkItem(parentOperation, item, request));
    }

    const sentCount = results.filter((result) => result.ok).length;
    const nonExecutionCount = results.filter((result) => !result.ok).length;
    const pieces = [
      sentCount > 0 ? `Typed pause request sent for ${sentCount} active quiet run(s).` : null,
      nonExecutionCount > 0 ? `${nonExecutionCount} affected quiet item(s) recorded typed non-execution state.` : null,
    ].filter((piece): piece is string => Boolean(piece));

    return {
      ok: nonExecutionCount === 0,
      message: pieces.join(" "),
      results,
    };
  }

  private async stopQuietWorkItem(
    parentOperation: RuntimeControlOperation,
    item: RuntimeItem,
    request: RuntimeControlRequest,
  ): Promise<QuietWorkStopResult> {
    let operation = await this.createQuietWorkPauseOperation(parentOperation, item, request);
    if (!operation.target?.run_id || !operation.target.goal_id) {
      operation = await this.update(operation, "blocked", {
        ok: false,
        message: `Quiet-work item ${item.item_id} was held but not paused because it has no typed goal/runtime bridge.`,
      });
      await this.appendControlEvidence(operation);
      return quietWorkStopResult(item.item_id, operation);
    }

    const approved = await this.approveIfRequired(operation, request.approvalFn);
    if (!approved.ok) {
      const saved = approved.result.operationId
        ? await this.operationStore.load(approved.result.operationId)
        : null;
      operation = saved ?? operation;
      await this.appendControlEvidence(operation);
      return quietWorkStopResult(item.item_id, operation);
    }

    // The parent companion-wide control is the explicit user command; these child
    // operations still pass the normal pause_run approval gate before daemon I/O.
    operation = approved.operation;
    if (!this.executor) {
      const runId = operation.target?.run_id ?? item.item_id;
      operation = await this.update(operation, "blocked", {
        ok: false,
        message: `Quiet-work run ${runId} was held but not paused because no runtime control executor is configured.`,
      });
      await this.appendControlEvidence(operation);
      return quietWorkStopResult(item.item_id, operation);
    }

    const acknowledged = await this.acknowledge(operation);
    const executed = await this.executeAcknowledgedOperation(acknowledged, request);
    const executedOperation = executed.operationId
      ? await this.operationStore.load(executed.operationId)
      : null;
    const saved = executedOperation ?? acknowledged;
    await this.appendControlEvidence(saved);
    return quietWorkStopResult(item.item_id, saved);
  }

  private createQuietWorkPauseOperation(
    parentOperation: RuntimeControlOperation,
    item: RuntimeItem,
    request: RuntimeControlRequest,
  ): Promise<RuntimeControlOperation> {
    const requestedAt = this.nowIso();
    const target = quietWorkPauseTarget(item);
    return this.operationStore.save({
      operation_id: randomUUID(),
      kind: "pause_run",
      state: "pending",
      requested_at: requestedAt,
      updated_at: requestedAt,
      requested_by: request.requestedBy ?? { surface: "chat" },
      reply_target: normalizeReplyTarget(request.replyTarget ?? { surface: "chat" }),
      reason: `Parent stop_all_quiet_work ${parentOperation.operation_id}: ${request.intent.reason}`,
      expected_health: expectedHealthFor("pause_run"),
      ...(target ? { target } : {}),
    });
  }

  private async handleSessionControl(request: RuntimeControlRequest): Promise<RuntimeControlResult> {
    const initial = await this.createInitialOperation(request);
    if (!this.sessionRegistry) {
      const blocked = await this.update(initial, "blocked", {
        ok: false,
        message: "Runtime session catalog is not available for session control.",
      });
      return this.toResult(blocked);
    }

    const sessionId = request.intent.target?.sessionId;
    if (!sessionId) {
      const blocked = await this.update(initial, "blocked", {
        ok: false,
        message: `${request.intent.kind} requires an explicit session id; refusing to fall back to latest session.`,
      });
      return this.toResult(blocked);
    }

    const snapshot = await this.sessionRegistry.snapshot();
    const session = snapshot.sessions.find((candidate) => candidate.id === sessionId);
    if (!session) {
      const blocked = await this.update(initial, "blocked", {
        ok: false,
        message: `Runtime session ${sessionId} was not found; refusing to fall back to latest session.`,
        resumeOutcome: "resume_rejected_stale",
      });
      return this.toResult(blocked);
    }

    const verified = await this.update(initial, "verified", {
      ok: true,
      message: request.intent.kind === "summarize_session_without_resuming"
        ? formatSessionSummaryOnly(session)
        : formatSessionInspection(session),
      resumeOutcome: request.intent.kind === "summarize_session_without_resuming" ? "summary_only" : "inspect_only",
    });
    return this.toResult(verified);
  }

  private async handlePermissionControl(request: RuntimeControlRequest): Promise<RuntimeControlResult> {
    const initial = await this.createInitialOperation(request);
    if (!this.permissionGrantStore) {
      const blocked = await this.update(initial, "blocked", {
        ok: false,
        message: "PermissionGrant control is unavailable because the permission grant store is not configured.",
      });
      return this.toResult(blocked);
    }

    switch (request.intent.kind) {
      case "inspect_permission_boundary": {
        const grants = await this.matchPermissionGrants(request, { activeOnly: true });
        const inspected = await this.update(initial, "verified", {
          ok: true,
          message: formatPermissionGrantSummary(grants),
        });
        return this.toResult(inspected);
      }
      case "audit_permission_check": {
        const grants = await this.matchPermissionGrants(request, { activeOnly: false });
        const audited = await this.update(initial, "verified", {
          ok: true,
          message: formatPermissionGrantAudit(grants),
        });
        return this.toResult(audited);
      }
      case "revoke_permission": {
        const selected = await this.selectSinglePermissionGrant(request);
        if (!selected.ok) {
          const blocked = await this.update(initial, "blocked", { ok: false, message: selected.message });
          return this.toResult(blocked);
        }
        const revoked = await this.permissionGrantStore.revoke(selected.grant.grant_id, {
          revoked_by: actorKey(request.requestedBy),
          reason: request.intent.reason,
          audit_refs: [`runtime-control:${initial.operation_id}`],
        });
        const updated = await this.update(initial, revoked ? "verified" : "blocked", {
          ok: Boolean(revoked),
          message: revoked
            ? `Revoked PermissionGrant ${revoked.grant_id}. Future covered actions will ask again or block according to policy.`
            : `PermissionGrant ${selected.grant.grant_id} could not be revoked.`,
        });
        return this.toResult(updated);
      }
      case "narrow_permission":
      case "extend_permission": {
        const selected = await this.selectSinglePermissionGrant(request);
        if (!selected.ok) {
          const blocked = await this.update(initial, "blocked", { ok: false, message: selected.message });
          return this.toResult(blocked);
        }
        if (request.intent.kind === "extend_permission" && (request.intent.permissionCapabilities?.length ?? 0) === 0) {
          const blocked = await this.update(initial, "blocked", {
            ok: false,
            message: "extend_permission requires at least one explicit grant capability.",
          });
          return this.toResult(blocked);
        }
        const capabilities = nextPermissionCapabilities(selected.grant, request.intent.permissionCapabilities, request.intent.kind);
        if (capabilities.length === 0) {
          const blocked = await this.update(initial, "blocked", {
            ok: false,
            message: `${request.intent.kind} requires at least one explicit grant capability.`,
          });
          return this.toResult(blocked);
        }
        const approval = request.intent.kind === "extend_permission"
          ? await this.approveIfRequired(initial, request.approvalFn)
          : { ok: true as const, operation: initial };
        if (!approval.ok) return approval.result;

        const replacementInput = replacementGrantInput(selected.grant, capabilities, request, approval.operation.operation_id);
        const superseded = await this.permissionGrantStore.supersede(selected.grant.grant_id, replacementInput, {
          audit_refs: [`runtime-control:${approval.operation.operation_id}`],
        });
        const activated = superseded
          ? await this.permissionGrantStore.activate(superseded.replacement.grant_id, {
              audit_refs: [`runtime-control:${approval.operation.operation_id}`],
            })
          : null;
        const updated = await this.update(approval.operation, activated ? "verified" : "blocked", {
          ok: Boolean(activated),
          message: activated
            ? `Updated PermissionGrant ${selected.grant.grant_id}; replacement ${activated.grant_id} allows ${activated.capabilities.join(", ")}.`
            : `PermissionGrant ${selected.grant.grant_id} could not be updated.`,
        });
        return this.toResult(updated);
      }
    }
    const blocked = await this.update(initial, "blocked", {
      ok: false,
      message: `Unsupported permission control operation: ${request.intent.kind}`,
    });
    return this.toResult(blocked);
  }

  private async collectRuntimeItems(currentTime: string): Promise<RuntimeItem[]> {
    const items: RuntimeItem[] = [
      ...await this.operationStore.listRuntimeItems(),
    ];

    if (this.sessionRegistry) {
      const snapshot = await this.sessionRegistry.snapshot();
      items.push(...snapshot.background_runs.map((run) => runtimeItemFromBackgroundRun(run, currentTime)));
    }

    items.push(...(await this.authHandoffStore.list()).map((handoff) => runtimeItemFromAuthHandoff(handoff, currentTime)));
    items.push(...(await this.browserSessionStore.list()).map((session) => runtimeItemFromBrowserSession(session, currentTime)));
    items.push(...(await this.guardrailStore.listBreakers()).map(runtimeItemFromGuardrailBreaker));
    const backpressure = await this.guardrailStore.loadBackpressureSnapshot();
    if (backpressure) {
      items.push(...runtimeItemsFromBackpressureSnapshot(backpressure, currentTime));
    }

    return items;
  }

  private async projectGlobalControlState(runtimeItems: RuntimeItem[]): Promise<ProjectedGlobalControls> {
    const operations = [
      ...await this.operationStore.listCompleted(),
      ...await this.operationStore.listPending(),
    ]
      .filter((operation) => isCompanionWideControlKind(operation.kind))
      .filter((operation) => operation.kind !== "inspect_companion_state")
      .filter((operation) => operation.state === "verified")
      .sort((left, right) => left.updated_at.localeCompare(right.updated_at));

    if (operations.length === 0) {
      return { stateRef: null, controls: [], activeControls: [] };
    }

    const byControl = new Map<CompanionWideControl, CompanionGlobalControlEntry>();
    for (const operation of operations) {
      const control = operation.kind as CompanionWideControl;
      const affectedRefs = affectedRuntimeRefsForControl(control, runtimeItems);
      const deactivated = DEACTIVATES_COMPANION_CONTROL[control];
      if (deactivated) {
        const previous = byControl.get(deactivated);
        const preservedAffectedRefs = uniqueStrings([
          ...(previous?.affected_runtime_refs ?? []),
          ...affectedRefs,
        ]);
        const preservedAuditRefs = uniqueStrings([
          ...(previous?.audit_refs ?? []),
          `runtime-control-operation:${operation.operation_id}`,
        ]);
        byControl.set(deactivated, companionControlEntry({
          control: deactivated,
          state: "inactive",
          operation,
          affectedRefs: preservedAffectedRefs,
          auditRefs: preservedAuditRefs,
        }));
        byControl.set(control, companionControlEntry({
          control,
          state: "inactive",
          operation,
          affectedRefs,
        }));
        continue;
      }
      const existing = byControl.get(control);
      if (existing?.state === "inactive" && existing.updated_at >= operation.updated_at) {
        continue;
      }
      byControl.set(control, companionControlEntry({
        control,
        state: oneShotCompanionControls().has(control) ? "inactive" : "active",
        operation,
        affectedRefs,
      }));
    }

    const latest = operations[operations.length - 1]!;
    const controls = [...byControl.values()].sort((left, right) => left.updated_at.localeCompare(right.updated_at));
    return {
      stateRef: `global-control-state:${latest.operation_id}:${encodeURIComponent(latest.updated_at)}`,
      controls,
      activeControls: controls.filter((entry) => entry.state === "active").map((entry) => entry.control),
    };
  }

  private async handleRunControl(request: RuntimeControlRequest): Promise<RuntimeControlResult> {
    const initial = await this.createInitialOperation(request);
    if (initial.state === "blocked") return this.toResult(initial);

    if (request.intent.kind === "inspect_run") {
      const inspected = await this.update(initial, "verified", {
        ok: true,
        message: await this.formatInspection(initial),
      });
      await this.appendControlEvidence(inspected);
      return this.toResult(inspected);
    }

    if (request.intent.kind === "finalize_run") {
      const proposed = await this.proposeFinalize(initial, request);
      await this.appendControlEvidence(proposed);
      return this.toResult(proposed);
    }

    if (!initial.target?.goal_id) {
      const blocked = await this.update(initial, "blocked", {
        ok: false,
        message: `Runtime control ${request.intent.kind} is blocked: selected run ${initial.target?.run_id ?? "unknown"} has no typed goal/runtime bridge yet.`,
        ...(request.intent.kind === "resume_run" ? { resumeOutcome: "resume_rejected_safety" as const } : {}),
      });
      await this.appendControlEvidence(blocked);
      return this.toResult(blocked);
    }

    if (request.intent.kind === "resume_run") {
      const resumeDecision = await this.decideRunResume(initial);
      if (resumeDecision.outcome !== "resume_allowed") {
        const blocked = await this.update(initial, "blocked", {
          ok: false,
          message: resumeDecision.message,
          resumeOutcome: resumeDecision.outcome,
        });
        await this.appendControlEvidence(blocked);
        return this.toResult(blocked);
      }
    }

    const approved = await this.approveIfRequired(initial, request.approvalFn);
    if (!approved.ok) return approved.result;

    const acknowledged = await this.acknowledge(approved.operation);
    const result = await this.executeAcknowledgedOperation(acknowledged, request);
    if (result.operationId) {
      const operation = await this.operationStore.load(result.operationId);
      if (operation) await this.appendControlEvidence(operation);
    }
    return result;
  }

  private async decideRunResume(operation: RuntimeControlOperation): Promise<{
    outcome: CompanionResumeOutcome;
    message: string;
  }> {
    if (!this.sessionRegistry || !operation.target?.run_id) {
      return {
        outcome: "resume_rejected_safety",
        message: "Resume is blocked because runtime session evidence is unavailable.",
      };
    }
    const snapshot = await this.sessionRegistry.snapshot();
    const run = snapshot.background_runs.find((candidate) => candidate.id === operation.target?.run_id);
    if (!run) {
      return {
        outcome: "resume_rejected_stale",
        message: `Runtime run ${operation.target.run_id} was not found; refusing to fall back to latest run.`,
      };
    }
    if (run.status !== "running" && run.status !== "queued") {
      return {
        outcome: "resume_requires_regrounding",
        message: `Runtime run ${run.id} is ${run.status}; resume requires explicit re-grounding or inspect/summary first.`,
      };
    }
    const runtimeItems = await this.collectRuntimeItems(this.nowIso());
    const projectedControls = await this.projectGlobalControlState(runtimeItems);
    const controlledItems = applyCompanionControlState(
      runtimeItems,
      projectedControls.controls,
      projectedControls.activeControls,
    );
    const runtimeItem = controlledItems.find((item) => item.item_id === `background-run:${run.id}`);
    if (!runtimeItem) {
      return {
        outcome: "resume_rejected_stale",
        message: `Runtime run ${run.id} has no RuntimeItem projection; refusing to fall back to latest run.`,
      };
    }
    if (runtimeItem.control_policy.forbidden_controls.includes("resume_item")) {
      return resumeBlockedByRuntimeItemPolicy(run.id, runtimeItem);
    }
    return {
      outcome: "resume_allowed",
      message: `Runtime run ${run.id} is current for resume admission.`,
    };
  }

  private async matchPermissionGrants(
    request: RuntimeControlRequest,
    options: { activeOnly: boolean },
  ): Promise<PermissionGrantRecord[]> {
    if (!this.permissionGrantStore) return [];
    const grants = options.activeOnly
      ? await this.permissionGrantStore.listActive()
      : await this.permissionGrantStore.list();
    const grantId = request.intent.target?.grantId;
    if (grantId) {
      const exact = grants.filter((grant) => grant.grant_id === grantId);
      if (!hasPermissionGrantSelectionContext(request)) return exact;
      return exact.filter((grant) => permissionGrantMatchesRequest(grant, request));
    }
    const contextual = grants.filter((grant) => permissionGrantMatchesRequest(grant, request));
    if (contextual.length > 0) return contextual;
    return hasPermissionGrantSelectionContext(request) ? [] : grants;
  }

  private async selectSinglePermissionGrant(
    request: RuntimeControlRequest,
  ): Promise<{ ok: true; grant: PermissionGrantRecord } | { ok: false; message: string }> {
    const grants = await this.matchPermissionGrants(request, { activeOnly: true });
    if (grants.length === 0) {
      return { ok: false, message: "No active PermissionGrant matches this chat/runtime context." };
    }
    if (grants.length > 1 && !request.intent.target?.grantId) {
      return {
        ok: false,
        message: `Multiple active PermissionGrants match this context. Specify one grant id: ${grants.map((grant) => grant.grant_id).join(", ")}`,
      };
    }
    return { ok: true, grant: grants[0]! };
  }

  private async createInitialOperation(request: RuntimeControlRequest): Promise<RuntimeControlOperation> {
    const target = await this.resolveTarget(request);
    if (!target.ok) {
      return this.createBlockedOperation(request, target.result.message);
    }

    const requestedAt = this.nowIso();
    const risk = riskForIntent(request.intent);
    const directTarget = directTargetFromIntent(request.intent);
    const operation: RuntimeControlOperation = {
      operation_id: randomUUID(),
      kind: request.intent.kind,
      state: "pending",
      requested_at: requestedAt,
      updated_at: requestedAt,
      requested_by: request.requestedBy ?? { surface: "chat" },
      reply_target: normalizeReplyTarget(request.replyTarget ?? { surface: "chat" }),
      reason: request.intent.reason,
      expected_health: expectedHealthFor(request.intent.kind),
      ...(target.run
        ? {
            target: {
              run_id: target.run.id,
              ...(target.run.child_session_id ? { session_id: target.run.child_session_id } : {}),
              ...(target.goalId ? { goal_id: target.goalId } : {}),
            },
          }
        : directTarget
          ? { target: directTarget }
          : {}),
      ...(risk ? { risk } : {}),
    };

    return this.operationStore.save(operation);
  }

  private async createBlockedOperation(
    request: RuntimeControlRequest,
    message: string
  ): Promise<RuntimeControlOperation> {
    const now = this.nowIso();
    return this.operationStore.save({
      operation_id: randomUUID(),
      kind: request.intent.kind,
      state: "blocked",
      requested_at: now,
      updated_at: now,
      requested_by: request.requestedBy ?? { surface: "chat" },
      reply_target: normalizeReplyTarget(request.replyTarget ?? { surface: "chat" }),
      reason: request.intent.reason,
      expected_health: expectedHealthFor(request.intent.kind),
      result: { ok: false, message },
    });
  }

  private async applyAutomationControl(request: RuntimeAutomationControlRequest): Promise<{ success: boolean; message: string }> {
    if (request.domain === "auth_handoff") {
      if (!request.handoffId) return { success: false, message: "auth_handoff control requires handoffId." };
      const handoff = await this.authHandoffStore.load(request.handoffId);
      if (!handoff) return { success: false, message: `Auth handoff not found: ${request.handoffId}` };
      if (request.action === "inspect") return { success: true, message: `Auth handoff ${handoff.handoff_id} is ${handoff.state}.` };
      if (handoff.state === "completed" || handoff.state === "cancelled" || handoff.state === "expired" || handoff.state === "superseded") {
        return { success: false, message: `Auth handoff ${handoff.handoff_id} is terminal: ${handoff.state}.` };
      }
      if (isPastIso(handoff.expires_at)) {
        await this.authHandoffStore.transition(handoff.handoff_id, "expired");
        return { success: false, message: `Auth handoff ${handoff.handoff_id} is expired.` };
      }
      if (request.action === "complete") {
        const sessionId = handoff.browser_session_id ?? handoff.resumable_session_id ?? null;
        if (!sessionId) {
          return { success: false, message: `Auth handoff ${handoff.handoff_id} has no linked browser session.` };
        }
        const session = await this.browserSessionStore.load(sessionId);
        if (!session) {
          return { success: false, message: `Linked browser session not found: ${sessionId}` };
        }
        if (isPastIso(session.expires_at)) {
          return { success: false, message: `Linked browser session ${sessionId} is expired.` };
        }
        await this.authHandoffStore.transition(handoff.handoff_id, "completed", {
          browser_session_id: sessionId,
          resumable_session_id: handoff.resumable_session_id ?? sessionId,
        });
        const marked = await this.browserSessionStore.markAuthenticated(sessionId);
        if (!marked) return { success: false, message: `Linked browser session not found: ${sessionId}` };
        return { success: true, message: `Auth handoff ${handoff.handoff_id} completed.` };
      }
      if (request.action === "cancel" || request.action === "expire") {
        await this.authHandoffStore.transition(handoff.handoff_id, request.action === "cancel" ? "cancelled" : "expired");
        return { success: true, message: `Auth handoff ${handoff.handoff_id} ${request.action === "cancel" ? "cancelled" : "expired"}.` };
      }
    }

    if (request.domain === "browser_session") {
      if (!request.sessionId) return { success: false, message: "browser_session control requires sessionId." };
      const session = await this.browserSessionStore.load(request.sessionId);
      if (!session) return { success: false, message: `Browser session not found: ${request.sessionId}` };
      if (request.action === "inspect") return { success: true, message: `Browser session ${session.session_id} is ${session.state}.` };
      if (request.action === "expire") {
        await this.browserSessionStore.upsert({ ...session, state: "expired", updated_at: this.nowIso() });
        return { success: true, message: `Browser session ${session.session_id} expired.` };
      }
    }

    if (request.domain === "guardrail") {
      if (!request.providerId || !request.serviceKey) return { success: false, message: "guardrail control requires providerId and serviceKey." };
      const key = breakerKey(request.providerId, request.serviceKey);
      const breaker = await this.guardrailStore.loadBreaker(key);
      if (request.action === "inspect") return { success: true, message: `Guardrail ${key} is ${breaker?.state ?? "closed"}.` };
      const now = this.nowIso();
      if (request.action === "reset" || request.action === "unpause") {
        await this.guardrailStore.saveBreaker({
          key,
          provider_id: request.providerId,
          service_key: request.serviceKey,
          state: "closed",
          failure_count: 0,
          last_failure_code: null,
          last_failure_message: null,
          last_failure_at: null,
          opened_at: null,
          cooldown_until: null,
          updated_at: now,
        });
        return { success: true, message: `Guardrail ${key} reset.` };
      }
      if (request.action === "pause") {
        await this.guardrailStore.saveBreaker({
          key,
          provider_id: request.providerId,
          service_key: request.serviceKey,
          state: "paused",
          failure_count: breaker?.failure_count ?? 0,
          last_failure_code: breaker?.last_failure_code ?? null,
          last_failure_message: breaker?.last_failure_message ?? null,
          last_failure_at: breaker?.last_failure_at ?? null,
          opened_at: breaker?.opened_at ?? now,
          cooldown_until: null,
          updated_at: now,
        });
        return { success: true, message: `Guardrail ${key} paused.` };
      }
      if (request.action === "half_open") {
        if (!breaker) return { success: false, message: `Guardrail not found: ${key}` };
        await this.guardrailStore.saveBreaker({ ...breaker, state: "half_open", updated_at: now });
        return { success: true, message: `Guardrail ${key} moved to half_open.` };
      }
    }

    if (request.domain === "backpressure") {
      const snapshot = await this.guardrailStore.loadBackpressureSnapshot();
      if (request.action === "inspect") return { success: true, message: `Backpressure active leases: ${snapshot?.active.length ?? 0}.` };
      if (request.action === "reset") {
        await this.guardrailStore.saveBackpressureSnapshot({ updated_at: this.nowIso(), active: [], throttled: [] });
        return { success: true, message: "Backpressure leases reset." };
      }
    }

    return { success: false, message: `Unsupported runtime automation operation: ${request.domain}.${request.action}` };
  }

  private async recordAutomationOperation(
    request: RuntimeAutomationControlRequest,
    state: Extract<RuntimeControlOperationState, "verified" | "blocked" | "cancelled">,
    ok: boolean,
    message: string,
  ): Promise<RuntimeControlResult> {
    const now = this.nowIso();
    const operation = await this.operationStore.save({
      operation_id: randomUUID(),
      kind: "automation_control",
      state,
      requested_at: now,
      updated_at: now,
      requested_by: request.requestedBy ?? { surface: "chat" },
      reply_target: normalizeReplyTarget(request.replyTarget ?? { surface: "chat" }),
      reason: request.reason,
      target: {
        ...(request.handoffId ? { handoff_id: request.handoffId } : {}),
        ...(request.sessionId ? { session_id: request.sessionId } : {}),
        ...(request.providerId ? { provider_id: request.providerId } : {}),
        ...(request.serviceKey ? { service_key: request.serviceKey } : {}),
      },
      automation_control: { domain: request.domain, action: request.action },
      risk: {
        requires_approval: request.action !== "inspect",
        irreversible: request.action === "cancel" || request.action === "expire" || request.action === "reset",
        external_actions: [],
      },
      expected_health: expectedHealthFor("automation_control"),
      completed_at: now,
      result: { ok, message },
    });
    return { success: ok, message, operationId: operation.operation_id, state };
  }

  private async resolveTarget(request: RuntimeControlRequest): Promise<TargetResolution> {
    if (!isRunControlKind(request.intent.kind)) return { ok: true };
    if (!this.sessionRegistry) {
      return blocked("Runtime session catalog is not available for run control.");
    }

    const snapshot = await this.sessionRegistry.snapshot();
    const resolution = resolveRuntimeTarget({
      snapshot,
      operation: request.intent.kind,
      target: request.intent.target,
      selector: request.intent.targetSelector,
      conversationId: request.replyTarget?.conversation_id ?? request.requestedBy?.conversation_id ?? null,
    });

    if (resolution.status === "ambiguous") {
      return blocked(`Multiple runtime runs match this request. Specify one run id: ${resolution.evidence.candidates.map((candidate) => candidate.run_id).join(", ")}`);
    }
    if (resolution.status === "unknown") {
      return blocked(`No runtime run matched this request: ${resolution.evidence.reason}.`);
    }
    if (resolution.status === "stale") {
      return blocked(`${resolution.evidence.reason}; refusing to reuse previous-session state.`);
    }
    return { ok: true, run: resolution.run, goalId: resolution.goalId };
  }

  private async proposeFinalize(
    operation: RuntimeControlOperation,
    request: RuntimeControlRequest
  ): Promise<RuntimeControlOperation> {
    const approved = await this.approveIfRequired(operation, request.approvalFn);
    if (!approved.ok) return this.operationStore.load(operation.operation_id).then((saved) => saved ?? operation);

    const handoff = await this.operatorHandoffStore?.create({
      handoff_id: `handoff:${operation.target?.run_id ?? operation.operation_id}:runtime-finalize`,
      ...(operation.target?.goal_id ? { goal_id: operation.target.goal_id } : {}),
      ...(operation.target?.run_id ? { run_id: operation.target.run_id } : {}),
      triggers: [
        "finalization",
        ...(operation.risk?.irreversible ? ["irreversible_action" as const] : []),
        ...((operation.risk?.external_actions.length ?? 0) > 0 ? ["external_action" as const] : []),
      ],
      title: "Runtime finalization approval required",
      summary: operation.reason,
      current_status: `Run ${operation.target?.run_id ?? "unknown"} is awaiting operator finalization approval.`,
      recommended_action: "Review the proposed finalization. External submit/publish/secret/production/destructive actions remain blocked until explicit approval.",
      candidate_options: [
        { id: "approve_finalize", label: "Approve finalization", tradeoff: "Allows the runtime to finalize without external submission." },
        { id: "keep_running", label: "Keep running", tradeoff: "Leaves the background run unchanged." },
      ],
      risks: [
        "Finalization may be irreversible.",
        ...((operation.risk?.external_actions ?? []).map((action) => `External action requested but not executed: ${action}`)),
      ],
      required_approvals: ["operator_finalization"],
      next_action: {
        label: "approve runtime finalization",
        approval_required: true,
      },
      gate: {
        autonomous_task_generation: "pause",
        external_action_requires_approval: true,
      },
    });

    return this.update(approved.operation, "blocked", {
      ok: true,
      message: [
        `Finalization proposal recorded for ${operation.target?.run_id ?? "the selected run"}.`,
        handoff ? `Operator handoff: ${handoff.handoff_id}.` : "Operator handoff store is not configured.",
        "No external submit/publish/secret/production/destructive action was executed.",
      ].join(" "),
    });
  }

  private async formatInspection(operation: RuntimeControlOperation): Promise<string> {
    if (!this.sessionRegistry || !operation.target?.run_id) return "Runtime run inspection is unavailable.";
    const snapshot = await this.sessionRegistry.snapshot();
    const run = snapshot.background_runs.find((candidate) => candidate.id === operation.target?.run_id);
    if (!run) return `Runtime run ${operation.target.run_id} was not found.`;
    return [
      `Runtime run ${run.id}: ${run.status}.`,
      run.title ? `Title: ${run.title}.` : null,
      run.summary ? `Summary: ${run.summary}.` : null,
      run.error ? `Error: ${run.error}.` : null,
      `Updated: ${run.updated_at ?? "unknown"}.`,
    ].filter((line): line is string => Boolean(line)).join(" ");
  }

  private async appendControlEvidence(operation: RuntimeControlOperation): Promise<void> {
    if (!this.evidenceLedger || !operation.target?.run_id) return;
    await this.evidenceLedger.append({
      kind: operation.state === "failed" || operation.state === "blocked" ? "decision" : "execution",
      scope: { run_id: operation.target.run_id },
      outcome: operation.result?.ok ? "continued" : "blocked",
      summary: operation.result?.message ?? ackMessage(operation.kind),
      result: {
        status: operation.state,
        summary: operation.result?.message ?? ackMessage(operation.kind),
      },
      raw_refs: [{ kind: "runtime_control_operation", id: operation.operation_id }],
    });
  }

  private async approveIfRequired(
    operation: RuntimeControlOperation,
    approvalFn: RuntimeControlRequest["approvalFn"]
  ): Promise<RuntimeControlStep> {
    if (!requiresApproval(operation.kind)) {
      return { ok: true, operation };
    }

    if (!approvalFn) {
      return this.failStep(
        operation,
        "failed",
        "Runtime control requires approval, but no approval handler is configured."
      );
    }

    let approved: boolean;
    try {
      approved = await approvalFn(approvalReason(operation));
    } catch (err) {
      return this.failStep(
        operation,
        "failed",
        err instanceof Error ? err.message : String(err)
      );
    }

    if (!approved) {
      return this.failStep(operation, "cancelled", "Runtime control operation was not approved.");
    }

    const updated = await this.operationStore.save({
      ...operation,
      state: "approved",
      updated_at: this.nowIso(),
    });
    return { ok: true, operation: updated };
  }

  private acknowledge(operation: RuntimeControlOperation): Promise<RuntimeControlOperation> {
    return this.update(operation, "acknowledged", {
      ok: true,
      message: ackMessage(operation.kind),
    });
  }

  private async executeAcknowledgedOperation(
    operation: RuntimeControlOperation,
    request: RuntimeControlRequest
  ): Promise<RuntimeControlResult> {
    if (!this.executor) {
      const failed = await this.update(operation, "failed", {
        ok: false,
        message: "Runtime control executor is not configured; operation was recorded but not started.",
      });
      return this.toResult(failed);
    }

    let executed: RuntimeControlExecutorResult;
    try {
      executed = await this.executor(operation, request);
    } catch (err) {
      const failed = await this.update(operation, "failed", {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      });
      return this.toResult(failed);
    }

    const nextState = executed.state ?? (executed.ok ? "acknowledged" : "failed");
    const saved = await this.update(operation, nextState, {
      ok: executed.ok,
      message: executed.message ?? ackMessage(operation.kind),
    });
    return this.toResult(saved);
  }

  private async failStep(
    operation: RuntimeControlOperation,
    state: Extract<RuntimeControlOperationState, "failed" | "cancelled">,
    message: string
  ): Promise<RuntimeControlStep> {
    const saved = await this.update(operation, state, {
      ok: false,
      message,
    });
    return { ok: false, result: this.toResult(saved) };
  }

  private toResult(operation: RuntimeControlOperation): RuntimeControlResult {
    return {
      success: operation.result?.ok ?? false,
      message: operation.result?.message ?? ackMessage(operation.kind),
      operationId: operation.operation_id,
      state: operation.state,
      ...(operation.result?.resume_outcome ? { resumeOutcome: operation.result.resume_outcome } : {}),
    };
  }

  private async update(
    operation: RuntimeControlOperation,
    state: RuntimeControlOperationState,
    result: { ok: boolean; message: string; resumeOutcome?: CompanionResumeOutcome }
  ): Promise<RuntimeControlOperation> {
    const updated: RuntimeControlOperation = {
      ...operation,
      state,
      updated_at: this.nowIso(),
      result: {
        ok: result.ok,
        message: result.message,
        ...(result.resumeOutcome ? { resume_outcome: result.resumeOutcome } : {}),
      },
    };
    return this.operationStore.save(updated);
  }

  private nowIso(): string {
    return this.now().toISOString();
  }
}

export function isExecutableRuntimeControlKind(
  kind: RuntimeControlOperationKind
): kind is Extract<RuntimeControlOperationKind, "restart_daemon" | "restart_gateway" | "reload_config" | "self_update" | "pause_run" | "resume_run" | "cancel_run"> {
  return kind === "restart_daemon"
    || kind === "restart_gateway"
    || kind === "reload_config"
    || kind === "self_update"
    || kind === "pause_run"
    || kind === "resume_run"
    || kind === "cancel_run";
}

function isPermissionControlKind(
  kind: RuntimeControlOperationKind
): kind is Extract<RuntimeControlOperationKind, "inspect_permission_boundary" | "revoke_permission" | "narrow_permission" | "extend_permission" | "audit_permission_check"> {
  return kind === "inspect_permission_boundary"
    || kind === "revoke_permission"
    || kind === "narrow_permission"
    || kind === "extend_permission"
    || kind === "audit_permission_check";
}

function isCompanionWideControlKind(kind: RuntimeControlOperationKind): kind is CompanionWideControl {
  return kind === "inspect_companion_state"
    || kind === "enter_quiet_mode"
    || kind === "leave_quiet_mode"
    || kind === "pause_proactivity"
    || kind === "resume_proactivity"
    || kind === "suspend_companion"
    || kind === "resume_companion"
    || kind === "stop_all_quiet_work"
    || kind === "stop_all_watches"
    || kind === "suppress_nonessential_agenda"
    || kind === "require_confirmation_for_proactivity";
}

function isSessionControlKind(
  kind: RuntimeControlOperationKind
): kind is Extract<RuntimeControlOperationKind, "inspect_session" | "summarize_session_without_resuming"> {
  return kind === "inspect_session" || kind === "summarize_session_without_resuming";
}

function isRunControlKind(
  kind: RuntimeControlOperationKind
): kind is Extract<RuntimeControlOperationKind, "inspect_run" | "pause_run" | "resume_run" | "cancel_run" | "finalize_run"> {
  return kind === "inspect_run" || kind === "pause_run" || kind === "resume_run" || kind === "cancel_run" || kind === "finalize_run";
}

function requiresApproval(kind: RuntimeControlOperationKind): boolean {
  return kind === "restart_daemon"
    || kind === "restart_gateway"
    || kind === "reload_config"
    || kind === "self_update"
    || kind === "pause_run"
    || kind === "resume_run"
    || kind === "cancel_run"
    || kind === "finalize_run"
    || kind === "extend_permission";
}

function normalizeReplyTarget(target: RuntimeControlReplyTarget): RuntimeControlReplyTarget {
  return {
    ...target,
    channel: target.channel ?? defaultChannelForSurface(target.surface),
  };
}

function defaultChannelForSurface(
  surface: RuntimeControlReplyTarget["surface"]
): RuntimeControlReplyTarget["channel"] {
  switch (surface) {
    case "gateway":
      return "plugin_gateway";
    case "cli":
    case "tui":
      return surface;
    case "chat":
    case undefined:
      return undefined;
  }
}

function expectedHealthFor(kind: RuntimeControlOperationKind): { daemon_ping: boolean; gateway_acceptance: boolean } {
  return {
    daemon_ping: isExecutableRuntimeControlKind(kind),
    gateway_acceptance: isExecutableRuntimeControlKind(kind),
  };
}

function approvalReason(operation: RuntimeControlOperation): string {
  const target = operation.target?.run_id ? ` for ${operation.target.run_id}` : "";
  return `Runtime control ${operation.kind}${target}: ${operation.reason}`;
}

function isPastIso(value?: string | null): boolean {
  if (!value) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms <= Date.now();
}

function ackMessage(kind: RuntimeControlOperationKind): string {
  switch (kind) {
    case "restart_gateway":
      return "Gateway restart has started. A result will be returned to this conversation after recovery.";
    case "restart_daemon":
      return "PulSeed daemon restart has started. A result will be returned to this conversation after recovery.";
    case "reload_config":
      return "Runtime configuration reload has started.";
    case "self_update":
      return "PulSeed self-update preparation has started. Changes will be reviewed before execution.";
    case "inspect_run":
      return "Runtime run status was inspected.";
    case "pause_run":
      return "Runtime run safe pause was requested.";
    case "resume_run":
      return "Runtime run resume was requested.";
    case "cancel_run":
      return "Runtime run cancellation was requested.";
    case "finalize_run":
      return "Runtime run finalization proposal will be created.";
    case "inspect_permission_boundary":
      return "Active permission boundary was inspected.";
    case "revoke_permission":
      return "Permission grant revocation was recorded.";
    case "narrow_permission":
      return "Permission grant narrowing was recorded.";
    case "extend_permission":
      return "Permission grant extension was recorded.";
    case "audit_permission_check":
      return "Permission grant audit was inspected.";
    case "inspect_companion_state":
      return "Companion state was inspected.";
    case "enter_quiet_mode":
      return "Quiet mode was enabled.";
    case "leave_quiet_mode":
      return "Quiet mode was disabled. Held items were not resumed automatically.";
    case "pause_proactivity":
      return "Proactivity pause was enabled.";
    case "resume_proactivity":
      return "Proactivity pause was disabled. Held items require re-evaluation.";
    case "suspend_companion":
      return "Companion suspend was enabled.";
    case "resume_companion":
      return "Companion suspend was disabled. Held items were not resumed automatically.";
    case "stop_all_quiet_work":
      return "Quiet-work stop request was recorded.";
    case "stop_all_watches":
      return "Watch stop request was recorded.";
    case "suppress_nonessential_agenda":
      return "Nonessential agenda suppression was recorded.";
    case "require_confirmation_for_proactivity":
      return "Confirmation was required for proactivity.";
    case "inspect_session":
      return "Runtime session was inspected.";
    case "summarize_session_without_resuming":
      return "Runtime session was summarized without resuming.";
    case "automation_control":
      return "Runtime automation control was recorded.";
  }
}

function targetFromRunRequest(request: RuntimeRunControlRequestBase): RuntimeControlIntent["target"] | undefined {
  if (!request.runId && !request.sessionId) return undefined;
  return {
    ...(request.runId ? { runId: request.runId } : {}),
    ...(request.sessionId ? { sessionId: request.sessionId } : {}),
  };
}

function directTargetFromIntent(intent: RuntimeControlIntent): RuntimeControlOperation["target"] | undefined {
  const target = intent.target;
  if (!target?.runId && !target?.sessionId && !target?.grantId) return undefined;
  return {
    ...(target.runId ? { run_id: target.runId } : {}),
    ...(target.sessionId ? { session_id: target.sessionId } : {}),
    ...(target.grantId ? { grant_id: target.grantId } : {}),
  };
}

function riskForIntent(intent: RuntimeControlIntent): RuntimeControlOperation["risk"] | null {
  if (intent.kind !== "finalize_run") return null;
  return {
    requires_approval: true,
    irreversible: intent.irreversible ?? true,
    external_actions: intent.externalActions ?? [],
  };
}

function blocked(message: string): TargetResolution {
  return { ok: false, result: { success: false, message, state: "blocked" } };
}

function permissionGrantMatchesRequest(grant: PermissionGrantRecord, request: RuntimeControlRequest): boolean {
  const target = request.intent.target;
  const hasTargetContext = Boolean(target?.runId || target?.sessionId);
  const targetMatches = Boolean(
    (target?.runId && grant.scope.kind === "run" && grant.scope.run_id === target.runId)
      || (target?.sessionId && (grant.scope.session_id === target.sessionId || grant.origin.session_id === target.sessionId))
  );
  const conversationId = request.replyTarget?.conversation_id ?? request.requestedBy?.conversation_id;
  const userId = request.replyTarget?.user_id ?? request.requestedBy?.user_id;
  const chatSurface = request.replyTarget?.surface === "chat" || request.requestedBy?.surface === "chat";

  if (conversationId) {
    if (grant.origin.conversation_id !== conversationId) return false;
    if (userId && grant.origin.user_id && grant.origin.user_id !== userId) return false;
    return hasTargetContext ? targetMatches : true;
  }
  if (userId) {
    if (grant.origin.user_id !== userId) return false;
    return hasTargetContext ? targetMatches : true;
  }
  if (chatSurface) return false;
  return targetMatches;
}

function hasPermissionGrantSelectionContext(request: RuntimeControlRequest): boolean {
  const target = request.intent.target;
  return Boolean(
    target?.runId
    || target?.sessionId
    || request.replyTarget?.conversation_id
    || request.requestedBy?.conversation_id
    || request.replyTarget?.user_id
    || request.requestedBy?.user_id
    || request.replyTarget?.surface === "chat"
    || request.requestedBy?.surface === "chat"
  );
}

function formatPermissionGrantSummary(grants: PermissionGrantRecord[]): string {
  if (grants.length === 0) {
    return "No active PermissionGrant matches this chat/runtime context.";
  }
  return [
    "Active permission boundary:",
    ...grants.map((grant) => [
      `- ${grant.grant_id}`,
      `scope=${formatGrantScope(grant)}`,
      `duration=${grant.duration.kind}`,
      `review=${grant.review.kind === "periodic" ? new Date(grant.review.due_at).toISOString() : "none"}`,
      `capabilities=${grant.capabilities.join(", ")}`,
      `excluded=${grant.excluded_capabilities.length > 0 ? grant.excluded_capabilities.join(", ") : "none"}`,
      `uses=${grant.usage_count}`,
      "source=redacted",
    ].join("; ")),
  ].join("\n");
}

function formatPermissionGrantAudit(grants: PermissionGrantRecord[]): string {
  if (grants.length === 0) {
    return "No PermissionGrant audit records match this chat/runtime context.";
  }
  return [
    "PermissionGrant audit:",
    ...grants.map((grant) => [
      `- ${grant.grant_id}`,
      `state=${grant.state}`,
      `scope=${formatGrantScope(grant)}`,
      `review=${grant.review.kind === "periodic" ? new Date(grant.review.due_at).toISOString() : "none"}`,
      `capabilities=${grant.capabilities.join(", ")}`,
      `excluded=${grant.excluded_capabilities.length > 0 ? grant.excluded_capabilities.join(", ") : "none"}`,
      `uses=${grant.usage_count}`,
      `last_used=${grant.last_used_at ? new Date(grant.last_used_at).toISOString() : "never"}`,
      `audit_refs=${grant.audit_refs.length > 0 ? grant.audit_refs.join(", ") : "none"}`,
    ].join("; ")),
    "Covered local actions may reuse matching active grants. Excluded, stale, revoked, unknown, remote, destructive, or hard-boundary actions still ask again or block.",
  ].join("\n");
}

function formatGrantScope(grant: PermissionGrantRecord): string {
  switch (grant.scope.kind) {
    case "turn":
      return `turn:${grant.scope.turn_id}`;
    case "run":
      return `run:${grant.scope.run_id}`;
    case "goal":
      return `goal:${grant.scope.goal_id}`;
    case "session":
      return `session:${grant.scope.session_id}`;
    case "workspace":
      return `workspace:${grant.scope.workspace_root}`;
    case "project":
      return `project:${grant.scope.project_id}`;
    case "global":
      return "global";
  }
}

function nextPermissionCapabilities(
  grant: PermissionGrantRecord,
  requested: PermissionGrantCapability[] | undefined,
  kind: Extract<RuntimeControlOperationKind, "narrow_permission" | "extend_permission">,
): PermissionGrantCapability[] {
  const requestedUnique = uniqueCapabilities(requested ?? []);
  if (kind === "narrow_permission") {
    const allowed = new Set(grant.capabilities);
    return requestedUnique.filter((capability) => allowed.has(capability));
  }
  return uniqueCapabilities([...grant.capabilities, ...requestedUnique]);
}

function uniqueCapabilities(capabilities: PermissionGrantCapability[]): PermissionGrantCapability[] {
  return [...new Set(capabilities)];
}

function applyCompanionControlState(
  runtimeItems: RuntimeItem[],
  globalControls: CompanionGlobalControlEntry[],
  activeControls: CompanionWideControl[],
): RuntimeItem[] {
  const inactiveHeldControlRefs = globalControls.filter((entry) => (
    entry.state === "inactive"
    && controlRequiresReadmissionAfterLift(entry.control)
    && entry.affected_runtime_refs.length > 0
  ));
  if (activeControls.length === 0 && inactiveHeldControlRefs.length === 0) return runtimeItems;
  const globalControlRefs = globalControls
    .filter((entry) => entry.state === "active" || inactiveHeldControlRefs.includes(entry))
    .map((entry) => entry.source_ref);
  return runtimeItems.map((item) => {
    const heldByControls = activeControls.filter((control) => controlHoldsRuntimeItem(control, item));
    const historicallyHeldByControls = inactiveHeldControlRefs
      .filter((entry) => entry.affected_runtime_refs.includes(item.item_id))
      .map((entry) => entry.control);
    const rejectedByControls = activeControls.filter((control) => controlRejectsRuntimeItem(control, item));
    if (heldByControls.length === 0 && historicallyHeldByControls.length === 0 && rejectedByControls.length === 0) {
      return item;
    }
    const controlled = {
      ...item,
      companion_control_state: {
        active_controls: uniqueControls([
          ...item.companion_control_state.active_controls,
          ...activeControls,
        ]),
        global_control_refs: uniqueStrings([
          ...item.companion_control_state.global_control_refs,
          ...globalControlRefs,
        ]),
        held_by_controls: uniqueControls([
          ...item.companion_control_state.held_by_controls,
          ...heldByControls,
          ...historicallyHeldByControls,
        ]),
        rejected_by_controls: uniqueControls([
          ...item.companion_control_state.rejected_by_controls,
          ...rejectedByControls,
        ]),
        reason: "companion-wide global controls applied at runtime admission boundary",
      },
    };
    return {
      ...controlled,
      control_policy: deriveRuntimeItemControlPolicy(controlled),
    };
  });
}

function companionControlEntry(input: {
  control: CompanionWideControl;
  state: CompanionGlobalControlEntry["state"];
  operation: RuntimeControlOperation;
  affectedRefs: string[];
  auditRefs?: string[];
}): CompanionGlobalControlEntry {
  return {
    control: input.control,
    state: input.state,
    source_ref: `runtime-control:${input.operation.operation_id}`,
    updated_at: input.operation.updated_at,
    reason: input.operation.reason,
    changed_by: input.operation.requested_by,
    affected_runtime_refs: input.affectedRefs,
    audit_refs: input.auditRefs ?? [`runtime-control-operation:${input.operation.operation_id}`],
  };
}

function oneShotCompanionControls(): Set<CompanionWideControl> {
  return new Set([
    "leave_quiet_mode",
    "resume_proactivity",
    "resume_companion",
  ]);
}

function controlRequiresReadmissionAfterLift(control: CompanionWideControl): boolean {
  return control === "enter_quiet_mode"
    || control === "pause_proactivity"
    || control === "suspend_companion"
    || control === "stop_all_quiet_work"
    || control === "stop_all_watches"
    || control === "suppress_nonessential_agenda"
    || control === "require_confirmation_for_proactivity";
}

function affectedRuntimeRefsForControl(control: CompanionWideControl, runtimeItems: RuntimeItem[]): string[] {
  return runtimeItems
    .filter((item) => activeRuntimeItem(item))
    .filter((item) => {
      if (control === "suspend_companion" || control === "resume_companion") return true;
      if (control === "stop_all_quiet_work") return quietWorkRuntimeItem(item);
      if (control === "stop_all_watches") return item.type === "watch";
      if (control === "suppress_nonessential_agenda") return agendaRuntimeItem(item);
      if (control === "enter_quiet_mode" || control === "pause_proactivity") return agentOriginAdmissionItem(item);
      if (control === "require_confirmation_for_proactivity") return agentOriginAdmissionItem(item);
      return false;
    })
    .map((item) => item.item_id);
}

function controlHoldsRuntimeItem(control: CompanionWideControl, item: RuntimeItem): boolean {
  if (!activeRuntimeItem(item)) return false;
  if (control === "suspend_companion") return true;
  if (control === "stop_all_quiet_work") return quietWorkRuntimeItem(item);
  if (control === "stop_all_watches") return item.type === "watch";
  if (control === "suppress_nonessential_agenda") return agendaRuntimeItem(item);
  return false;
}

function controlRejectsRuntimeItem(control: CompanionWideControl, item: RuntimeItem): boolean {
  if (!activeRuntimeItem(item)) return false;
  if (control === "suspend_companion") return true;
  if (control === "enter_quiet_mode" || control === "pause_proactivity") return agentOriginAdmissionItem(item);
  return false;
}

function activeRuntimeItem(item: RuntimeItem): boolean {
  return item.status === "running"
    || item.status === "pending"
    || item.status === "paused"
    || item.status === "active"
    || item.status === "mature";
}

function quietWorkRuntimeItem(item: RuntimeItem): boolean {
  if (item.source === "runtime-operation-store") return false;
  return item.type === "run" || item.type === "task" || item.type === "diff_proposal";
}

function quietWorkPauseTarget(item: RuntimeItem): RuntimeControlOperation["target"] | null {
  const runId = backgroundRunIdFromRuntimeItem(item);
  const sessionId = item.related_session_refs[0];
  const goalId = item.related_goal_refs[0];
  const target = {
    ...(runId ? { run_id: runId } : {}),
    ...(sessionId ? { session_id: sessionId } : {}),
    ...(goalId ? { goal_id: goalId } : {}),
  };
  return Object.keys(target).length > 0 ? target : null;
}

function backgroundRunIdFromRuntimeItem(item: RuntimeItem): string | null {
  const prefix = "background-run:";
  if (!item.item_id.startsWith(prefix)) return null;
  return item.item_id.slice(prefix.length);
}

function quietWorkStopResult(itemRef: string, operation: RuntimeControlOperation): QuietWorkStopResult {
  return {
    itemRef,
    operationId: operation.operation_id,
    state: operation.state,
    ok: operation.result?.ok ?? false,
  };
}

function agendaRuntimeItem(item: RuntimeItem): boolean {
  return item.type === "urge_candidate" || item.type === "agent_agenda_item";
}

function agentOriginAdmissionItem(item: RuntimeItem): boolean {
  return agendaRuntimeItem(item)
    || item.type === "surface_projection"
    || item.authority.speakable
    || item.authority.can_create_urge
    || item.authority.can_write_memory
    || item.authority.can_update_surface
    || item.authority.can_delegate_work;
}

function formatCompanionStateSummary(snapshot: CompanionStateSnapshot): string {
  return [
    `CompanionState ${snapshot.snapshot_id}: mode=${snapshot.mode}.`,
    `active_controls=${snapshot.control_overlays.length > 0 ? snapshot.control_overlays.join(", ") : "none"}.`,
    `active_refs=${snapshot.active_refs.length}.`,
    `held_refs=${snapshot.held_runtime_refs.length}.`,
    `blocked_refs=${snapshot.blocked_refs.length}.`,
  ].join(" ");
}

function formatCompanionControlApplied(control: CompanionWideControl, affectedRefs: string[]): string {
  const suffix = affectedRefs.length > 0
    ? ` Affected runtime items: ${affectedRefs.join(", ")}.`
    : " No currently active runtime items were affected.";
  if (control === "leave_quiet_mode" || control === "resume_proactivity" || control === "resume_companion") {
    return `${control} recorded. Held, stale, or suppressed runtime items were not resumed automatically.${suffix}`;
  }
  return `${control} recorded as companion-wide global control.${suffix}`;
}

function formatSessionInspection(session: RuntimeSession): string {
  return [
    `Runtime session ${session.id}: ${session.status}.`,
    `Kind: ${session.kind}.`,
    session.title ? `Title: ${session.title}.` : null,
    `Inspectable: true.`,
    `Resumable: ${session.resumable ? "requires runtime admission" : "false"}.`,
    `Updated: ${session.updated_at ?? "unknown"}.`,
  ].filter((line): line is string => Boolean(line)).join(" ");
}

function formatSessionSummaryOnly(session: RuntimeSession): string {
  return [
    `Runtime session ${session.id} summary-only view: ${session.status}.`,
    session.title ? `Title: ${session.title}.` : null,
    `No action, speech, memory write, Surface refresh, or side-effect authority was granted.`,
  ].filter((line): line is string => Boolean(line)).join(" ");
}

function resumeBlockedByRuntimeItemPolicy(runId: string, item: RuntimeItem): {
  outcome: CompanionResumeOutcome;
  message: string;
} {
  if (
    item.companion_control_state.held_by_controls.includes("suspend_companion")
    || item.companion_control_state.rejected_by_controls.includes("suspend_companion")
  ) {
    return {
      outcome: "resume_rejected_safety",
      message: `Runtime run ${runId} cannot resume while companion suspend state requires explicit re-admission.`,
    };
  }
  if (item.companion_control_state.held_by_controls.length > 0 || item.companion_control_state.rejected_by_controls.length > 0) {
    return {
      outcome: "resume_requires_regrounding",
      message: `Runtime run ${runId} is held by companion-wide controls and requires re-grounding before resume.`,
    };
  }
  if (item.staleness.permission.outcome !== "current") {
    return {
      outcome: "resume_rejected_permission",
      message: `Runtime run ${runId} cannot resume because permission state is ${item.staleness.permission.outcome}.`,
    };
  }
  if (item.staleness.surface.outcome !== "current") {
    return {
      outcome: "resume_rejected_surface",
      message: `Runtime run ${runId} cannot resume because Surface state is ${item.staleness.surface.outcome}.`,
    };
  }
  return {
    outcome: "resume_requires_regrounding",
    message: `Runtime run ${runId} is not allowed by runtime item control policy: ${item.control_policy.reason}.`,
  };
}

function uniqueControls(controls: CompanionWideControl[]): CompanionWideControl[] {
  return [...new Set(controls)];
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function replacementGrantInput(
  grant: PermissionGrantRecord,
  capabilities: PermissionGrantCapability[],
  request: RuntimeControlRequest,
  operationId: string,
): PermissionGrantCreateInput {
  const now = Date.now();
  return {
    grant_id: `permission-grant:${operationId}:${randomUUID()}`,
    subject: grant.subject,
    origin: grant.origin,
    source: grant.source,
    scope: grant.scope,
    duration: grant.duration,
    review: grant.review,
    capabilities,
    excluded_capabilities: request.intent.permissionExcludedCapabilities ?? grant.excluded_capabilities,
    staleness: grant.staleness,
    audit_refs: [`runtime-control:${operationId}`],
    supersedes: [grant.grant_id],
    created_at: now,
  };
}

function actorKey(actor: RuntimeControlActor | undefined): string {
  return actor?.identity_key ?? actor?.user_id ?? actor?.conversation_id ?? actor?.surface ?? "operator";
}
