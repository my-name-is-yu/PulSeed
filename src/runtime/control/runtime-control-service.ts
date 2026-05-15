import { randomUUID } from "node:crypto";
import type { StateManager } from "../../base/state/state-manager.js";
import {
  createRuntimeSessionRegistry,
  type BackgroundRun,
  type RuntimeSession,
} from "../session-registry/index.js";
import { RuntimeEvidenceLedger, type RuntimeEvidenceLedgerPort } from "../store/evidence-ledger.js";
import { RuntimeOperationStore } from "../store/runtime-operation-store.js";
import { AttentionStateStore } from "../store/attention-state-store.js";
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
  PermissionGrantRecord,
  PermissionGrantStore,
} from "../store/permission-grant-store.js";
import type {
  RuntimeControlActor,
  RuntimeControlCompanionStateInspection,
  RuntimeControlOperation,
  RuntimeControlOperationKind,
  RuntimeControlOperationState,
  RuntimeControlReplyTarget,
} from "../store/runtime-operation-schemas.js";
import type { RuntimeControlIntent } from "./runtime-control-intent.js";
import { resolveRuntimeTarget } from "./runtime-target-resolver.js";
import {
  actorKey,
  formatPermissionGrantAudit,
  formatPermissionGrantSummary,
  hasPermissionGrantSelectionContext,
  nextPermissionCapabilities,
  permissionGrantMatchesRequest,
  replacementGrantInput,
} from "./runtime-control-permission-grants.js";
import {
  PersonalAgentRuntimeStore,
  buildPersonalAgentDecisionTrace,
  type CapabilityRegistryDecisionKind,
  type InterventionDecisionKind,
  type RuntimeGraphRef,
} from "../personal-agent/index.js";

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
  companionStateInspection?: RuntimeControlCompanionStateInspection;
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
  attentionStore?: Pick<AttentionStateStore, "listRuntimeItems" | "suppressAgendaForControl">;
  executor?: RuntimeControlExecutor;
  personalAgentRuntime?: Pick<PersonalAgentRuntimeStore, "recordTrace">;
  now?: () => Date;
}

type RuntimeControlStep =
  | { ok: true; operation: RuntimeControlOperation }
  | { ok: false; result: RuntimeControlResult };

interface RuntimeControlTraceOptions {
  operation?: RuntimeControlOperation;
  decision?: InterventionDecisionKind;
  capabilityDecision?: CapabilityRegistryDecisionKind;
  permissionRequired?: boolean;
  decisionReason?: string;
  replayStage?: string;
  outcomeSummary?: string;
}

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
  private readonly attentionStore?: Pick<AttentionStateStore, "listRuntimeItems" | "suppressAgendaForControl">;
  private readonly executor?: RuntimeControlExecutor;
  private readonly personalAgentRuntime: Pick<PersonalAgentRuntimeStore, "recordTrace">;
  private readonly now: () => Date;

  constructor(options: RuntimeControlServiceOptions = {}) {
    const runtimeRoot = options.runtimeRoot ?? options.operationStore?.runtimeRootDir();
    const controlDbOptions = options.stateManager
      ? { controlBaseDir: options.stateManager.getBaseDir() }
      : options.operationStore?.runtimeControlDbOptions();
    this.operationStore = options.operationStore ?? new RuntimeOperationStore(
      runtimeRoot,
      controlDbOptions,
    );
    this.sessionRegistry = options.sessionRegistry ?? (options.stateManager
      ? createRuntimeSessionRegistry({ stateManager: options.stateManager })
      : undefined);
    this.evidenceLedger = options.evidenceLedger ?? (runtimeRoot ? new RuntimeEvidenceLedger(runtimeRoot) : undefined);
    this.operatorHandoffStore = options.operatorHandoffStore ?? (runtimeRoot ? new RuntimeOperatorHandoffStore(runtimeRoot, controlDbOptions) : undefined);
    this.permissionGrantStore = options.permissionGrantStore;
    this.authHandoffStore = options.authHandoffStore ?? new RuntimeAuthHandoffStore(runtimeRoot, controlDbOptions);
    this.browserSessionStore = options.browserSessionStore ?? new BrowserSessionStore(runtimeRoot, controlDbOptions);
    this.guardrailStore = options.guardrailStore ?? new GuardrailStore(runtimeRoot, controlDbOptions);
    this.attentionStore = options.attentionStore ?? (runtimeRoot ? new AttentionStateStore(runtimeRoot, controlDbOptions) : undefined);
    this.executor = options.executor;
    this.personalAgentRuntime = options.personalAgentRuntime ?? new PersonalAgentRuntimeStore(
      runtimeRoot ?? this.operationStore.runtimeRootDir(),
      controlDbOptions,
    );
    this.now = options.now ?? (() => new Date());
  }

  async request(request: RuntimeControlRequest): Promise<RuntimeControlResult> {
    await this.recordRuntimeControlTrace(request);
    let result: RuntimeControlResult;
    if (isCompanionWideControlKind(request.intent.kind)) {
      result = await this.handleCompanionWideControl(request);
      await this.recordRuntimeControlResultTrace(request, result);
      return result;
    }

    if (isSessionControlKind(request.intent.kind)) {
      result = await this.handleSessionControl(request);
      await this.recordRuntimeControlResultTrace(request, result);
      return result;
    }

    if (isPermissionControlKind(request.intent.kind)) {
      result = await this.handlePermissionControl(request);
      await this.recordRuntimeControlResultTrace(request, result);
      return result;
    }

    if (isRunControlKind(request.intent.kind)) {
      result = await this.handleRunControl(request);
      await this.recordRuntimeControlResultTrace(request, result);
      return result;
    }

    if (!isExecutableRuntimeControlKind(request.intent.kind)) {
      result = {
        success: false,
        message: `Runtime control operation ${request.intent.kind} is not supported by the production executor.`,
        state: "failed",
      };
      await this.recordRuntimeControlResultTrace(request, result);
      return result;
    }

    const initial = await this.createInitialOperation(request);
    const approved = await this.approveIfRequired(initial, request.approvalFn, request);
    if (!approved.ok) {
      await this.recordRuntimeControlResultTrace(request, approved.result);
      return approved.result;
    }

    const acknowledged = await this.acknowledge(approved.operation);
    result = await this.executeAcknowledgedOperation(acknowledged, request);
    await this.recordRuntimeControlResultTrace(request, result);
    return result;
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
    await this.recordAutomationControlTrace(request, mutation);
    if (mutation && !request.approvalFn) {
      const result = await this.recordAutomationOperation(request, "blocked", false, "Runtime automation mutation requires an approval surface.");
      await this.recordAutomationResultTrace(request, result);
      return result;
    }
    if (mutation) {
      const approved = await request.approvalFn?.(`Runtime automation ${request.domain}.${request.action}: ${request.reason}`);
      if (!approved) {
        const result = await this.recordAutomationOperation(request, "cancelled", false, "Runtime automation operation was not approved.");
        await this.recordAutomationResultTrace(request, result);
        return result;
      }
      await this.recordAutomationControlTrace(request, mutation, {
        decision: "allow",
        capabilityDecision: "available",
        permissionRequired: false,
        replayStage: "approved",
        decisionReason: `Runtime automation ${request.domain}.${request.action} was approved by policy confirmation before execution.`,
      });
    }

    const result = await this.applyAutomationControl(request);
    const operationResult = await this.recordAutomationOperation(
      request,
      result.success ? "verified" : "blocked",
      result.success,
      result.message,
    );
    await this.recordAutomationResultTrace(request, operationResult);
    return operationResult;
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
      const inspection = buildCompanionStateInspection(current.input.runtime_items, current.snapshot);
      const inspected = await this.update(initial, "verified", {
        ok: true,
        message: formatCompanionStateSummary(current.snapshot, inspection),
        companionStateInspection: inspection,
      });
      return this.toResult(inspected);
    }

    const quietWorkStop = control === "stop_all_quiet_work"
      ? await this.stopActiveQuietWork(initial, runtimeItemsBeforeControl, request)
      : null;
    const agendaSuppression = isDurableAgendaSuppressionControl(control) && this.attentionStore
      ? await this.attentionStore.suppressAgendaForControl({
          control,
          reason: request.intent.reason,
          now: this.nowIso(),
          auditRef: { kind: "audit_trace", id: `runtime-control-operation:${initial.operation_id}` },
        })
      : null;
    const verified = await this.update(initial, "verified", {
      ok: quietWorkStop?.ok ?? true,
      message: [
        formatCompanionControlApplied(control, affectedRefs),
        quietWorkStop?.message,
        agendaSuppression && agendaSuppression.suppressed_count > 0
          ? `Durable attention agenda suppressed ${agendaSuppression.suppressed_count} item(s); held items will not flush automatically.`
          : null,
      ].filter((part): part is string => Boolean(part)).join(" "),
      affectedRuntimeRefs: affectedRefs,
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

    const approved = await this.approveIfRequired(operation, request.approvalFn, request);
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
          ? await this.approveIfRequired(initial, request.approvalFn, request)
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
    if (this.attentionStore) {
      items.push(...await this.attentionStore.listRuntimeItems(currentTime));
    }

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
      const affectedRefs = operation.result?.affected_runtime_refs
        ?? affectedRuntimeRefsForControl(control, runtimeItems);
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

    const approved = await this.approveIfRequired(initial, request.approvalFn, request);
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

  private async recordAutomationResultTrace(
    request: RuntimeAutomationControlRequest,
    result: RuntimeControlResult,
  ): Promise<void> {
    const operation = result.operationId ? await this.operationStore.load(result.operationId) : null;
    await this.recordAutomationControlTrace(request, request.action !== "inspect", {
      ...(operation ? { operation } : {}),
      decision: result.success ? "allow" : "block",
      capabilityDecision: result.success ? "available" : "blocked",
      permissionRequired: false,
      replayStage: `outcome:${operation?.state ?? result.state ?? (result.success ? "success" : "failed")}`,
      decisionReason: result.message,
      outcomeSummary: result.message,
    });
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
    const approved = await this.approveIfRequired(operation, request.approvalFn, request);
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
    approvalFn: RuntimeControlRequest["approvalFn"],
    request?: RuntimeControlRequest,
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
    if (request) {
      await this.recordRuntimeControlTrace(request, {
        operation: updated,
        decision: "allow",
        capabilityDecision: "available",
        permissionRequired: false,
        replayStage: "approved",
        decisionReason: `Runtime control ${updated.kind} was approved by policy confirmation before execution.`,
      });
    }
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
      ...(operation.result?.companion_state_inspection ? { companionStateInspection: operation.result.companion_state_inspection } : {}),
    };
  }

  private async update(
    operation: RuntimeControlOperation,
    state: RuntimeControlOperationState,
    result: {
      ok: boolean;
      message: string;
      resumeOutcome?: CompanionResumeOutcome;
      companionStateInspection?: RuntimeControlCompanionStateInspection;
      affectedRuntimeRefs?: string[];
    }
  ): Promise<RuntimeControlOperation> {
    const updated: RuntimeControlOperation = {
      ...operation,
      state,
      updated_at: this.nowIso(),
      result: {
        ...operation.result,
        ok: result.ok,
        message: result.message,
        ...(result.resumeOutcome ? { resume_outcome: result.resumeOutcome } : {}),
        ...(result.companionStateInspection ? { companion_state_inspection: result.companionStateInspection } : {}),
        ...(result.affectedRuntimeRefs ? { affected_runtime_refs: result.affectedRuntimeRefs } : {}),
      },
    };
    return this.operationStore.save(updated);
  }

  private nowIso(): string {
    return this.now().toISOString();
  }

  private async recordRuntimeControlResultTrace(
    request: RuntimeControlRequest,
    result: RuntimeControlResult,
  ): Promise<void> {
    const operation = result.operationId ? await this.operationStore.load(result.operationId) : null;
    await this.recordRuntimeControlTrace(request, {
      ...(operation ? { operation } : {}),
      decision: result.success ? "allow" : "block",
      capabilityDecision: result.success ? "available" : "blocked",
      permissionRequired: false,
      replayStage: `outcome:${operation?.state ?? result.state ?? (result.success ? "success" : "failed")}`,
      decisionReason: result.message,
      outcomeSummary: result.message,
    });
  }

  private async recordRuntimeControlTrace(
    request: RuntimeControlRequest,
    options: RuntimeControlTraceOptions = {},
  ): Promise<void> {
    const operation = options.operation;
    const kind = operation?.kind ?? request.intent.kind;
    const permissionRequired = options.permissionRequired ?? requiresApproval(kind);
    const supported = isSupportedRuntimeControlKind(kind);
    const targetRef = operation
      ? runtimeControlOperationTargetRef(operation)
      : runtimeControlTargetRef(request.intent);
    const decision = options.decision ?? (!supported
      ? "block"
      : permissionRequired
        ? "confirm_required"
        : "allow");
    const capabilityDecision = options.capabilityDecision ?? (!supported
      ? "blocked"
      : permissionRequired
        ? "permission_required"
        : "available");
    const decisionReason = options.decisionReason ?? (!supported
      ? `Runtime control operation ${kind} is not supported by the production executor.`
      : permissionRequired
        ? `Runtime control ${kind} requires policy confirmation before execution.`
        : `Runtime control ${kind} is allowed by the typed control policy.`);
    await this.personalAgentRuntime.recordTrace(buildPersonalAgentDecisionTrace({
      callerPath: "runtime_control",
      source: {
        sourceKind: "runtime_control_request",
        sourceId: operation ? runtimeControlOperationSourceId(operation) : runtimeControlSourceId(request),
        emittedAt: this.nowIso(),
        sourceEpoch: kind,
        highWatermark: operation ? runtimeControlOperationHighWatermark(operation) : runtimeControlHighWatermark(request),
        replayKey: operation
          ? runtimeControlOperationReplayKey(request, operation, options.replayStage ?? decision)
          : runtimeControlReplayKey(request, options.replayStage),
        summary: operation
          ? `Runtime-control operation "${operation.operation_id}" entered InterventionPolicy as ${kind}.`
          : `Runtime-control request "${kind}" entered InterventionPolicy.`,
        sourceRef: operation
          ? { kind: "runtime_control_operation", ref: operation.operation_id }
          : { kind: "runtime_control_intent", ref: kind },
      },
      target: {
        kind: "runtime_control",
        ref: targetRef,
        effect: runtimeControlEffectFor(kind),
        summary: `Runtime-control ${kind}`,
      },
      decision,
      decisionReason,
      capabilityDecision,
      capabilityRefs: operation
        ? runtimeControlOperationCapabilityRefs(operation, request)
        : runtimeControlCapabilityRefs(request),
      policyRef: { kind: "runtime_control_policy", ref: "policy:runtime-control-v1" },
      permissionRequired,
      currentRefs: [
        ...runtimeControlCurrentRefs(request),
        ...(operation ? runtimeControlOperationCurrentRefs(operation) : []),
      ],
      ...(options.outcomeSummary
        ? {
            outcomeEvent: {
              type: "action_outcome" as const,
              summary: options.outcomeSummary,
              targetRef,
            },
          }
        : {}),
    }));
  }

  private async recordAutomationControlTrace(
    request: RuntimeAutomationControlRequest,
    mutation: boolean,
    options: RuntimeControlTraceOptions = {},
  ): Promise<void> {
    const operation = options.operation;
    const permissionRequired = options.permissionRequired ?? mutation;
    const decision = options.decision ?? (mutation ? "confirm_required" : "allow");
    const capabilityDecision = options.capabilityDecision ?? (mutation ? "permission_required" : "available");
    const decisionReason = options.decisionReason ?? (mutation
      ? "Runtime automation mutation requires policy confirmation before execution."
      : "Runtime automation inspection is allowed by the typed control policy.");
    const targetRef = operation
      ? runtimeControlOperationTargetRef(operation)
      : { kind: "runtime_automation" as const, ref: `${request.domain}:${request.action}` };
    await this.personalAgentRuntime.recordTrace(buildPersonalAgentDecisionTrace({
      callerPath: "runtime_control",
      source: {
        sourceKind: "runtime_control_request",
        sourceId: operation
          ? runtimeControlOperationSourceId(operation)
          : runtimeAutomationSourceId(request),
        emittedAt: this.nowIso(),
        sourceEpoch: request.domain,
        highWatermark: operation ? runtimeControlOperationHighWatermark(operation) : request.action,
        replayKey: operation
          ? runtimeControlOperationReplayKey(automationAsRuntimeControlRequest(request), operation, options.replayStage ?? decision)
          : runtimeAutomationReplayKey(request, options.replayStage),
        summary: operation
          ? `Runtime automation operation "${operation.operation_id}" entered InterventionPolicy as ${request.domain}.${request.action}.`
          : `Runtime automation control ${request.domain}.${request.action} entered InterventionPolicy.`,
        sourceRef: operation
          ? { kind: "runtime_control_operation", ref: operation.operation_id }
          : { kind: "runtime_control_intent", ref: `automation:${request.domain}:${request.action}` },
      },
      target: {
        kind: "runtime_control",
        ref: targetRef,
        effect: mutation ? "mutate_runtime_control" : "continue_route",
        summary: `Runtime automation ${request.domain}.${request.action}`,
      },
      decision,
      decisionReason,
      capabilityDecision,
      capabilityRefs: [{ kind: "runtime_automation_domain", ref: request.domain }],
      policyRef: { kind: "runtime_control_policy", ref: "policy:runtime-automation-v1" },
      permissionRequired,
      currentRefs: [
        ...(request.handoffId ? [{ kind: "auth_handoff", ref: request.handoffId }] : []),
        ...(request.sessionId ? [{ kind: "browser_session", ref: request.sessionId }] : []),
        ...(request.providerId ? [{ kind: "provider", ref: request.providerId }] : []),
        ...(operation ? runtimeControlOperationCurrentRefs(operation) : []),
      ],
      ...(options.outcomeSummary
        ? {
            outcomeEvent: {
              type: "action_outcome" as const,
              summary: options.outcomeSummary,
              targetRef,
            },
          }
        : {}),
    }));
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

function isSupportedRuntimeControlKind(kind: RuntimeControlOperationKind): boolean {
  return isExecutableRuntimeControlKind(kind)
    || isPermissionControlKind(kind)
    || isCompanionWideControlKind(kind)
    || isSessionControlKind(kind)
    || isRunControlKind(kind);
}

function runtimeControlEffectFor(kind: RuntimeControlOperationKind) {
  if (kind === "inspect_run"
    || kind === "inspect_session"
    || kind === "inspect_companion_state"
    || kind === "summarize_session_without_resuming"
    || kind === "inspect_permission_boundary"
    || kind === "audit_permission_check") {
    return "continue_route" as const;
  }
  return "mutate_runtime_control" as const;
}

function runtimeControlTargetRef(intent: RuntimeControlIntent): RuntimeGraphRef {
  const target = intent.target;
  if (target?.runId) return { kind: "run", ref: target.runId };
  if (target?.sessionId) return { kind: "session", ref: target.sessionId };
  if (target?.grantId) return { kind: "permission_grant", ref: target.grantId };
  if (intent.targetSelector) {
    return {
      kind: `${intent.targetSelector.scope}_selector`,
      ref: `${intent.targetSelector.reference}:${intent.targetSelector.sourceText}`,
    };
  }
  return { kind: "runtime_control_intent", ref: intent.kind };
}

function runtimeControlCapabilityRefs(request: RuntimeControlRequest): RuntimeGraphRef[] {
  const refs: RuntimeGraphRef[] = [
    { kind: "runtime_control_capability", ref: request.intent.kind },
  ];
  for (const capability of request.intent.permissionCapabilities ?? []) {
    refs.push({ kind: "permission_capability", ref: capability });
  }
  for (const capability of request.intent.permissionExcludedCapabilities ?? []) {
    refs.push({ kind: "permission_excluded_capability", ref: capability });
  }
  for (const action of request.intent.externalActions ?? []) {
    refs.push({ kind: "external_action", ref: action });
  }
  return refs;
}

function runtimeControlCurrentRefs(request: RuntimeControlRequest): RuntimeGraphRef[] {
  const refs: RuntimeGraphRef[] = [];
  if (request.intent.target?.runId) refs.push({ kind: "run", ref: request.intent.target.runId });
  if (request.intent.target?.sessionId) refs.push({ kind: "session", ref: request.intent.target.sessionId });
  if (request.intent.target?.grantId) refs.push({ kind: "permission_grant", ref: request.intent.target.grantId });
  if (request.replyTarget) {
    refs.push({
      kind: "reply_target",
      ref: [
        request.replyTarget.surface,
        request.replyTarget.channel ?? "",
        request.replyTarget.conversation_id ?? request.replyTarget.identity_key ?? request.replyTarget.response_channel ?? "",
      ].join(":"),
    });
  }
  if (request.requestedBy) {
    refs.push({
      kind: "runtime_control_actor",
      ref: [
        request.requestedBy.surface ?? "",
        request.requestedBy.identity_key ?? request.requestedBy.user_id ?? request.requestedBy.conversation_id ?? "",
      ].join(":"),
    });
  }
  return refs;
}

function runtimeControlSourceId(request: RuntimeControlRequest): string {
  const target = request.intent.target;
  return [
    request.intent.kind,
    target?.runId ?? "",
    target?.sessionId ?? "",
    target?.grantId ?? "",
    request.intent.targetSelector?.scope ?? "",
    request.intent.targetSelector?.reference ?? "",
    request.intent.reason,
  ].join(":");
}

function runtimeControlReplayKey(request: RuntimeControlRequest, stage?: string): string {
  const parts = [
    "runtime_control",
    runtimeControlSourceId(request),
    ...(stage ? [stage] : []),
    request.cwd,
    request.requestedBy?.identity_key ?? request.requestedBy?.user_id ?? request.requestedBy?.conversation_id ?? "",
  ];
  return parts.join(":");
}

function runtimeAutomationSourceId(request: RuntimeAutomationControlRequest): string {
  return `automation:${request.domain}:${request.action}:${request.handoffId ?? request.sessionId ?? request.providerId ?? "target:none"}`;
}

function runtimeAutomationReplayKey(request: RuntimeAutomationControlRequest, stage?: string): string {
  return [
    "runtime_control",
    "automation",
    request.domain,
    request.action,
    ...(stage ? [stage] : []),
    request.handoffId ?? "",
    request.sessionId ?? "",
    request.providerId ?? "",
    request.serviceKey ?? "",
  ].join(":");
}

function automationAsRuntimeControlRequest(request: RuntimeAutomationControlRequest): RuntimeControlRequest {
  return {
    intent: {
      kind: "automation_control",
      reason: request.reason,
    },
    cwd: request.cwd,
    ...(request.requestedBy ? { requestedBy: request.requestedBy } : {}),
    ...(request.replyTarget ? { replyTarget: request.replyTarget } : {}),
  };
}

function runtimeControlOperationSourceId(operation: RuntimeControlOperation): string {
  return [
    "operation",
    operation.operation_id,
    operation.kind,
    operation.target?.run_id ?? "",
    operation.target?.session_id ?? "",
    operation.target?.grant_id ?? "",
  ].join(":");
}

function runtimeControlOperationReplayKey(
  request: RuntimeControlRequest,
  operation: RuntimeControlOperation,
  stage: string,
): string {
  return [
    "runtime_control",
    runtimeControlOperationSourceId(operation),
    stage,
    request.cwd,
    request.requestedBy?.identity_key ?? request.requestedBy?.user_id ?? request.requestedBy?.conversation_id ?? "",
  ].join(":");
}

function runtimeControlOperationHighWatermark(operation: RuntimeControlOperation): string {
  return [
    operation.kind,
    operation.operation_id,
    operation.state,
    operation.updated_at,
  ].join(":");
}

function runtimeControlOperationTargetRef(operation: RuntimeControlOperation): RuntimeGraphRef {
  if (operation.target?.run_id) return { kind: "run", ref: operation.target.run_id };
  if (operation.target?.session_id) return { kind: "session", ref: operation.target.session_id };
  if (operation.target?.goal_id) return { kind: "goal", ref: operation.target.goal_id };
  if (operation.target?.grant_id) return { kind: "permission_grant", ref: operation.target.grant_id };
  if (operation.target?.handoff_id) return { kind: "auth_handoff", ref: operation.target.handoff_id };
  if (operation.target?.provider_id) return { kind: "automation_provider", ref: operation.target.provider_id };
  if (operation.target?.service_key) return { kind: "runtime_service", ref: operation.target.service_key };
  return { kind: "runtime_control_operation", ref: operation.operation_id };
}

function runtimeControlOperationCapabilityRefs(
  operation: RuntimeControlOperation,
  request: RuntimeControlRequest,
): RuntimeGraphRef[] {
  if (operation.kind !== request.intent.kind) {
    return [{ kind: "runtime_control_capability", ref: operation.kind }];
  }
  return runtimeControlCapabilityRefs(request);
}

function runtimeControlOperationCurrentRefs(operation: RuntimeControlOperation): RuntimeGraphRef[] {
  const refs: RuntimeGraphRef[] = [
    { kind: "runtime_control_operation", ref: operation.operation_id },
  ];
  if (operation.target?.run_id) refs.push({ kind: "run", ref: operation.target.run_id });
  if (operation.target?.session_id) refs.push({ kind: "session", ref: operation.target.session_id });
  if (operation.target?.goal_id) refs.push({ kind: "goal", ref: operation.target.goal_id });
  if (operation.target?.grant_id) refs.push({ kind: "permission_grant", ref: operation.target.grant_id });
  if (operation.target?.handoff_id) refs.push({ kind: "auth_handoff", ref: operation.target.handoff_id });
  if (operation.target?.provider_id) refs.push({ kind: "automation_provider", ref: operation.target.provider_id });
  if (operation.target?.service_key) refs.push({ kind: "runtime_service", ref: operation.target.service_key });
  return refs;
}

function runtimeControlHighWatermark(request: RuntimeControlRequest): string {
  return [
    request.intent.kind,
    request.intent.target?.runId ?? "",
    request.intent.target?.sessionId ?? "",
    request.intent.target?.grantId ?? "",
    request.intent.targetSelector?.sourceText ?? "",
  ].join(":");
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

function isDurableAgendaSuppressionControl(
  control: CompanionWideControl
): control is Extract<CompanionWideControl, "stop_all_quiet_work" | "stop_all_watches" | "suppress_nonessential_agenda"> {
  return control === "stop_all_quiet_work"
    || control === "stop_all_watches"
    || control === "suppress_nonessential_agenda";
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

function buildCompanionStateInspection(
  runtimeItems: RuntimeItem[],
  snapshot: CompanionStateSnapshot,
): RuntimeControlCompanionStateInspection {
  const inspectedItems = runtimeItems
    .filter((item) => (
      item.authority.inspectable
      && item.visibility_policy.inspectable
      && item.control_policy.allowed_controls.includes("inspect_item")
    ))
    .filter((item) => companionInspectionItem(item, snapshot))
    .map((item) => ({
      ref: item.item_id,
      type: item.type,
      status: item.status,
      posture: item.posture,
      visibility_display: item.visibility_policy.display,
      inspectable: item.visibility_policy.inspectable,
      auditable: item.visibility_policy.auditable,
      authority_scope: item.authority.approval_scope,
      authority: {
        resumable: item.authority.resumable,
        actionable: item.authority.actionable,
        speakable: item.authority.speakable,
        can_create_urge: item.authority.can_create_urge,
        can_update_surface: item.authority.can_update_surface,
        can_write_memory: item.authority.can_write_memory,
        can_delegate_work: item.authority.can_delegate_work,
        requires_confirmation: item.authority.requires_confirmation,
      },
      staleness_outcomes: Object.fromEntries(
        Object.entries(item.staleness).map(([dimension, value]) => [dimension, value.outcome]),
      ),
      allowed_controls: item.control_policy.allowed_controls,
      repair_options: item.control_policy.repair_options,
      audit_trace_refs: item.audit_trace_refs,
    }));
  const allRuntimeItemRefs = new Set(runtimeItems.map((item) => item.item_id));
  const inspectableRuntimeItemRefs = new Set(inspectedItems.map((item) => item.ref));
  const inspectableSnapshotRefs = (refs: string[]) => refs.filter((candidate) => (
    !allRuntimeItemRefs.has(candidate) || inspectableRuntimeItemRefs.has(candidate)
  ));

  return {
    snapshot_id: snapshot.snapshot_id,
    mode: snapshot.mode,
    inspected_at: snapshot.computed_at,
    active_controls: snapshot.control_overlays,
    active_refs: inspectableSnapshotRefs(snapshot.active_refs),
    held_runtime_refs: inspectableSnapshotRefs(snapshot.held_runtime_refs),
    blocked_refs: inspectableSnapshotRefs(snapshot.blocked_refs),
    hidden_refs: inspectedItems
      .filter((item) => item.visibility_display !== "normal")
      .map((item) => item.ref),
    non_executable_refs: inspectedItems
      .filter((item) => !runtimeItemGrantsExecution(item.authority))
      .map((item) => item.ref),
    repairable_refs: inspectedItems
      .filter((item) => item.repair_options.length > 0)
      .map((item) => item.ref),
    runtime_items: inspectedItems,
  };
}

function companionInspectionItem(item: RuntimeItem, snapshot: CompanionStateSnapshot): boolean {
  return item.visibility_policy.display !== "normal"
    || snapshot.held_runtime_refs.includes(item.item_id)
    || snapshot.blocked_refs.includes(item.item_id)
    || !runtimeItemGrantsExecution(item.authority)
    || item.control_policy.repair_options.length > 0
    || Object.values(item.staleness).some((dimension) => dimension.outcome !== "current");
}

type RuntimeExecutionAuthority = Pick<
  RuntimeItem["authority"],
  | "resumable"
  | "actionable"
  | "speakable"
  | "can_create_urge"
  | "can_update_surface"
  | "can_write_memory"
  | "can_delegate_work"
>;

function runtimeItemGrantsExecution(authority: RuntimeExecutionAuthority): boolean {
  return authority.resumable
    || authority.actionable
    || authority.speakable
    || authority.can_create_urge
    || authority.can_update_surface
    || authority.can_write_memory
    || authority.can_delegate_work;
}

function formatCompanionStateSummary(
  snapshot: CompanionStateSnapshot,
  inspection?: RuntimeControlCompanionStateInspection,
): string {
  return [
    `CompanionState ${snapshot.snapshot_id}: mode=${snapshot.mode}.`,
    `active_controls=${snapshot.control_overlays.length > 0 ? snapshot.control_overlays.join(", ") : "none"}.`,
    `active_refs=${snapshot.active_refs.length}.`,
    `held_refs=${snapshot.held_runtime_refs.length}.`,
    `blocked_refs=${snapshot.blocked_refs.length}.`,
    inspection ? `hidden_items=${inspection.hidden_refs.length}.` : null,
    inspection ? `non_executable_items=${inspection.non_executable_refs.length}.` : null,
    inspection ? `repairable_items=${inspection.repairable_refs.length}.` : null,
  ].filter((part): part is string => Boolean(part)).join(" ");
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
