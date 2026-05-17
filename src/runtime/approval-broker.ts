import { randomUUID } from "node:crypto";
import type { Logger } from "./logger.js";
import {
  createSurfaceActionBinding,
  createSurfaceProjection,
  findSurfaceActionBindingByToken,
  normalRuntimeGraphRef,
  normalSourceEventRef,
  renderSurfaceProjectionText,
  validateSurfaceActionBinding,
  type SurfaceActionBinding,
  type SurfaceApprovalPrompt,
  type SurfaceProjection,
} from "./surface-projection-protocol.js";
import type { ApprovalStore } from "./store/approval-store.js";
import type { PermissionWaitPlanStore } from "./store/permission-wait-plan-store.js";
import type { ApprovalOrigin, ApprovalRecord } from "./store/runtime-schemas.js";
import {
  getPendingPermissionTask,
  getPendingPermissionGrantProposal,
  withPermissionExpiry,
  type PendingPermissionGrantProposal,
  type PendingPermissionTarget,
  type PermissionRiskClass,
} from "./permission-dialogue.js";

const MAX_VALID_DATE_MS = 8_640_000_000_000_000;

export interface ApprovalTaskRequest {
  id: string;
  description: string;
  action: string;
  kind?: "permission";
  operation_summary?: string;
  risk_class?: PermissionRiskClass;
  target?: PendingPermissionTarget;
  state_epoch?: string;
  state_version?: string;
  expires_at?: number;
  wait_plan_id?: string;
  permission_level?: string;
  is_destructive?: boolean;
  reversibility?: string;
  grant_proposal?: PendingPermissionGrantProposal;
}

export interface ApprovalRequiredEvent {
  requestId: string;
  goalId?: string;
  task: ApprovalTaskRequest;
  expiresAt: number;
  restored?: boolean;
  origin?: ApprovalOrigin;
  prompt?: string;
  approval_prompt?: SurfaceApprovalPrompt;
  surface_projection?: SurfaceProjection;
}

export interface ConversationalApprovalDelivery {
  delivered: boolean;
  reason?: string;
}

export interface ConversationalApprovalRequest {
  record: ApprovalRecord;
  origin: ApprovalOrigin;
  prompt: string;
  approval_prompt: SurfaceApprovalPrompt;
  surface_projection: SurfaceProjection;
}

export interface ConversationalApprovalOptions {
  origin: ApprovalOrigin;
  timeoutMs?: number;
  approvalId?: string;
  deliverConversationalApproval?: (
    request: ConversationalApprovalRequest
  ) => Promise<ConversationalApprovalDelivery> | ConversationalApprovalDelivery;
}

export interface ApprovalResolutionBinding {
  surfaceActionBindingId?: string;
  surfaceActionBindingToken?: string;
}

export type PendingConversationalApprovalLookup =
  | { status: "found"; approval: ApprovalRecord }
  | { status: "none" }
  | { status: "ambiguous" };

export interface ApprovalBrokerOptions {
  store: ApprovalStore;
  permissionWaitPlanStore?: Pick<PermissionWaitPlanStore, "markApproved" | "markDenied" | "markExpired" | "markCancelled">;
  logger?: Logger;
  broadcast?: (eventType: string, data: unknown) => void;
  deliverConversationalApproval?: (
    request: ConversationalApprovalRequest
  ) => Promise<ConversationalApprovalDelivery> | ConversationalApprovalDelivery;
  now?: () => number;
  createId?: () => string;
  defaultTimeoutMs?: number;
}

interface PendingApprovalSession {
  record: ApprovalRecord;
  resolve?: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
  ready?: Promise<void>;
  finalizing?: boolean;
}

export class ApprovalBroker {
  private readonly store: ApprovalStore;
  private readonly permissionWaitPlanStore?: Pick<PermissionWaitPlanStore, "markApproved" | "markDenied" | "markExpired" | "markCancelled">;
  private readonly logger?: Logger;
  private broadcast?: (eventType: string, data: unknown) => void;
  private readonly deliverConversationalApproval?: (
    request: ConversationalApprovalRequest
  ) => Promise<ConversationalApprovalDelivery> | ConversationalApprovalDelivery;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly defaultTimeoutMs: number;
  private readonly pending = new Map<string, PendingApprovalSession>();
  private approvalIssuanceSequence = 0;
  private started = false;

  constructor(options: ApprovalBrokerOptions) {
    this.store = options.store;
    this.permissionWaitPlanStore = options.permissionWaitPlanStore;
    this.logger = options.logger;
    this.broadcast = options.broadcast;
    this.deliverConversationalApproval = options.deliverConversationalApproval;
    this.now = options.now ?? (() => Date.now());
    this.createId =
      options.createId ??
      (() => `approval-${this.now()}-${Math.random().toString(36).slice(2, 8)}`);
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 5 * 60 * 1000;
  }

  setBroadcast(broadcast: (eventType: string, data: unknown) => void): void {
    this.broadcast = broadcast;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;

    const records = await this.store.listPending();
    for (const record of records) {
      if (record.expires_at <= this.now()) {
        await this.finalizeApproval(record.approval_id, {
          state: "expired",
          approved: false,
          reason: "timeout",
          responseChannel: "system",
        });
        continue;
      }
      this.trackPending(record);
    }
  }

  async stop(): Promise<void> {
    for (const session of this.pending.values()) {
      clearTimeout(session.timer);
    }
    this.pending.clear();
    this.started = false;
  }

  async requestApproval(
    goalId: string,
    task: ApprovalTaskRequest,
    timeoutMs = this.defaultTimeoutMs,
    approvalId = this.createId()
  ): Promise<boolean> {
    await this.start();

    const createdAt = this.now();
    const expiresAt = createdAt + timeoutMs;
    const taskWithExpiry = withPermissionExpiry(task, expiresAt);
    const record: ApprovalRecord = {
      approval_id: approvalId,
      surface_issuance_id: this.createApprovalIssuanceId(approvalId),
      goal_id: goalId,
      request_envelope_id: approvalId,
      correlation_id: approvalId,
      state: "pending",
      created_at: createdAt,
      expires_at: expiresAt,
      payload: { task: taskWithExpiry },
    };

    return this.trackApprovalRequest(record);
  }

  async requestConversationalApproval(
    goalId: string,
    task: ApprovalTaskRequest,
    options: ConversationalApprovalOptions
  ): Promise<boolean> {
    await this.start();

    const approvalId = options.approvalId ?? this.createId();
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    const createdAt = this.now();
    const expiresAt = createdAt + timeoutMs;
    const taskWithExpiry = withPermissionExpiry(task, expiresAt);
    const record: ApprovalRecord = {
      approval_id: approvalId,
      surface_issuance_id: this.createApprovalIssuanceId(approvalId),
      goal_id: goalId,
      request_envelope_id: approvalId,
      correlation_id: approvalId,
      state: "pending",
      created_at: createdAt,
      expires_at: expiresAt,
      origin: options.origin,
      payload: { task: taskWithExpiry },
    };

    return this.trackApprovalRequest(record, options.deliverConversationalApproval);
  }

  async resolveApproval(
    approvalId: string,
    approved: boolean,
    responseChannel = "http",
    binding: ApprovalResolutionBinding = {}
  ): Promise<boolean> {
    const pendingRecord = this.pending.get(approvalId)?.record ?? await this.store.loadPending(approvalId);
    if (pendingRecord?.origin) {
      return false;
    }
    if (!pendingRecord || !validateApprovalResolutionBinding(pendingRecord, approved, binding, this.now())) {
      return false;
    }
    const resolved = await this.finalizeApproval(approvalId, {
      state: approved ? "approved" : "denied",
      approved,
      responseChannel,
    });
    return resolved !== null;
  }

  async resolveConversationalApproval(
    approvalId: string,
    approved: boolean,
    origin: ApprovalOrigin
  ): Promise<boolean> {
    const record = await this.store.loadPending(approvalId);
    if (record === null || !approvalOriginMatches(record.origin, origin)) {
      return false;
    }
    const surfaceProjection = projectApprovalSurface(record);
    const binding = approvalActionBindingFor(surfaceProjection, approved ? "approve" : "reject");
    if (!binding) {
      return false;
    }
    const validation = validateSurfaceActionBinding({
      binding,
      surface: "approval",
      surfaceInstanceRef: approvalSurfaceInstanceRef(record),
      actionKind: approved ? "approve" : "reject",
      conversationId: origin.conversation_id,
      sessionId: origin.session_id,
      messageId: origin.turn_id,
      now: safeEpochDateTime(this.now()) ?? undefined,
    });
    if (validation.status !== "accepted") {
      return false;
    }
    const resolved = await this.finalizeApproval(approvalId, {
      state: approved ? "approved" : "denied",
      approved,
      responseChannel: origin.channel,
    });
    return resolved !== null;
  }

  async loadPendingApproval(approvalId: string): Promise<ApprovalRecord | null> {
    await this.start();
    return this.pending.get(approvalId)?.record ?? await this.store.loadPending(approvalId);
  }

  async findPendingConversationalApproval(origin: ApprovalOrigin): Promise<PendingConversationalApprovalLookup> {
    await this.start();
    const matches = (await this.store.listPending())
      .filter((record) => conversationalApprovalOriginMatches(record.origin, origin))
      .sort((a, b) => b.created_at - a.created_at);
    if (matches.length === 0) {
      return { status: "none" };
    }
    if (matches.length > 1) {
      return { status: "ambiguous" };
    }
    return { status: "found", approval: matches[0]! };
  }

  getPendingApprovalEvents(): ApprovalRequiredEvent[] {
    return [...this.pending.values()]
      .filter(({ finalizing }) => !finalizing)
      .map(({ record }) => this.toApprovalRequiredEvent(record, true))
      .sort((a, b) => a.expiresAt - b.expiresAt);
  }

  private trackPending(
    record: ApprovalRecord,
    resolve?: (approved: boolean) => void,
    ready?: Promise<void>
  ): void {
    const existing = this.pending.get(record.approval_id);
    if (existing) {
      clearTimeout(existing.timer);
    }

    const msUntilExpiry = Math.max(record.expires_at - this.now(), 0);
    const timer = setTimeout(() => {
      void this.finalizeApproval(record.approval_id, {
        state: "expired",
        approved: false,
        reason: "timeout",
        responseChannel: "system",
      }).catch((err) => {
        this.logger?.error("ApprovalBroker: failed to expire approval", {
          approvalId: record.approval_id,
          error: String(err),
        });
      });
    }, msUntilExpiry);

    this.pending.set(record.approval_id, { record, resolve, timer, ready });
  }

  private trackApprovalRequest(
    record: ApprovalRecord,
    deliverOverride?: (
      request: ConversationalApprovalRequest
    ) => Promise<ConversationalApprovalDelivery> | ConversationalApprovalDelivery
  ): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      const ready = this.store.savePending(record).then(
        () => {
          const session = this.pending.get(record.approval_id);
          if (!session || session.finalizing) {
            return;
          }
          this.emitApprovalRequired(record, false);
          void this.deliverIfConversational(record, deliverOverride).catch((err) => {
            this.logger?.error("ApprovalBroker: conversational approval delivery failed", {
              approvalId: record.approval_id,
              error: String(err),
            });
          });
        },
        (err) => {
          const session = this.pending.get(record.approval_id);
          if (session) {
            clearTimeout(session.timer);
            this.pending.delete(record.approval_id);
          }
          reject(err);
        }
      );
      this.trackPending(record, resolve, ready);
      void ready.catch(() => undefined);
    });
  }

  private createApprovalIssuanceId(approvalId: string): string {
    this.approvalIssuanceSequence += 1;
    return `${approvalId}:issuance:${this.approvalIssuanceSequence}:${randomUUID()}`;
  }

  private async deliverIfConversational(
    record: ApprovalRecord,
    deliverOverride?: (
      request: ConversationalApprovalRequest
    ) => Promise<ConversationalApprovalDelivery> | ConversationalApprovalDelivery
  ): Promise<void> {
    if (!record.origin) {
      return;
    }

    const deliver = deliverOverride ?? this.deliverConversationalApproval;
    if (!deliver) {
      await this.finalizeApproval(record.approval_id, {
        state: "denied",
        approved: false,
        reason: "approval_channel_unreachable",
        responseChannel: record.origin.channel,
      });
      return;
    }

    try {
      const surfaceProjection = projectApprovalSurface(record);
      const approvalPrompt = surfaceProjection.approval_prompt;
      if (!approvalPrompt) {
        await this.finalizeApproval(record.approval_id, {
          state: "denied",
          approved: false,
          reason: "approval_surface_projection_unavailable",
          responseChannel: record.origin.channel,
        });
        return;
      }
      const delivery = await deliver({
        record,
        origin: record.origin,
        prompt: renderSurfaceProjectionText(surfaceProjection),
        approval_prompt: approvalPrompt,
        surface_projection: surfaceProjection,
      });
      if (!delivery.delivered) {
        await this.finalizeApproval(record.approval_id, {
          state: "denied",
          approved: false,
          reason: delivery.reason ?? "approval_channel_unreachable",
          responseChannel: record.origin.channel,
        });
      }
    } catch (err) {
      this.logger?.error("ApprovalBroker: conversational approval delivery failed", {
        approvalId: record.approval_id,
        error: String(err),
      });
      await this.finalizeApproval(record.approval_id, {
        state: "denied",
        approved: false,
        reason: "approval_channel_unreachable",
        responseChannel: record.origin.channel,
      });
    }
  }

  private async finalizeApproval(
    approvalId: string,
    resolution: {
      state: "approved" | "denied" | "expired" | "cancelled";
      approved: boolean;
      reason?: string;
      responseChannel?: string;
    }
  ): Promise<ApprovalRecord | null> {
    const session = this.pending.get(approvalId);
    if (session?.ready) {
      session.finalizing = true;
      try {
        await session.ready;
      } catch {
        return null;
      }
    }

    const currentSession = this.pending.get(approvalId);
    if (currentSession) {
      clearTimeout(currentSession.timer);
      this.pending.delete(approvalId);
    }

    const resolved = await this.store.resolvePending(approvalId, {
      state: resolution.state,
      resolved_at: this.now(),
      response_channel: resolution.responseChannel,
    });
    if (resolved === null) {
      return null;
    }

    await this.transitionPermissionWaitPlan(resolved, resolution).catch((err) => {
      this.logger?.error("ApprovalBroker: failed to transition permission wait plan", {
        approvalId,
        error: String(err),
      });
    });

    currentSession?.resolve?.(resolution.approved);
    this.broadcast?.("approval_resolved", {
      requestId: approvalId,
      goalId: resolved.goal_id,
      approved: resolution.approved,
      reason: resolution.reason,
      responseChannel: resolution.responseChannel,
    });
    return resolved;
  }

  private emitApprovalRequired(record: ApprovalRecord, restored: boolean): void {
    this.broadcast?.("approval_required", this.toApprovalRequiredEvent(record, restored));
  }

  private toApprovalRequiredEvent(record: ApprovalRecord, restored: boolean): ApprovalRequiredEvent {
    const surfaceProjection = projectApprovalSurface(record);
    const prompt = record.origin ? renderSurfaceProjectionText(surfaceProjection) : undefined;
    return {
      requestId: record.approval_id,
      goalId: record.goal_id,
      task: approvalTaskFromRecord(record, { id: "", description: "", action: "" }),
      expiresAt: record.expires_at,
      restored,
      ...(record.origin ? { origin: record.origin } : {}),
      ...(prompt ? { prompt } : {}),
      ...(surfaceProjection.approval_prompt ? { approval_prompt: surfaceProjection.approval_prompt } : {}),
      surface_projection: surfaceProjection,
    };
  }

  private async transitionPermissionWaitPlan(
    record: ApprovalRecord,
    resolution: {
      state: "approved" | "denied" | "expired" | "cancelled";
      approved: boolean;
      reason?: string;
      responseChannel?: string;
    },
  ): Promise<void> {
    if (!this.permissionWaitPlanStore) return;
    const permission = getPendingPermissionTask(record);
    const waitPlanId = permission?.wait_plan_id;
    if (!waitPlanId) return;
    const input = {
      resolved_at: record.resolved_at ?? this.now(),
      ...(resolution.responseChannel ? { response_channel: resolution.responseChannel } : {}),
      ...(resolution.reason ? { reason: resolution.reason } : {}),
      audit_refs: [`approval:${record.approval_id}`],
    };
    switch (resolution.state) {
      case "approved":
        await this.permissionWaitPlanStore.markApproved(waitPlanId, input);
        return;
      case "denied":
        await this.permissionWaitPlanStore.markDenied(waitPlanId, input);
        return;
      case "expired":
        await this.permissionWaitPlanStore.markExpired(waitPlanId, input);
        return;
      case "cancelled":
        await this.permissionWaitPlanStore.markCancelled(waitPlanId, input);
        return;
    }
  }
}

function renderConversationalApprovalPrompt(record: ApprovalRecord): string {
  const task = approvalTaskFromRecord(record, {
    id: record.approval_id,
    description: "Approval required",
    action: "unknown",
  });
  const permission = getPendingPermissionTask(record);
  const lines = [
    "Approval required.",
    `Action: ${task.action}`,
    `Target: ${task.id}`,
    `Details: ${task.description}`,
    `Approval ID: ${record.approval_id}`,
  ];
  if (permission) {
    lines.push(
      `Operation: ${permission.operation_summary}`,
      `Risk: ${permission.risk_class}`,
    );
    if (permission.target.tool_id) lines.push(`Tool: ${permission.target.tool_id}`);
    if (permission.target.tool_call_id) lines.push(`Tool call: ${permission.target.tool_call_id}`);
    if (permission.expires_at !== undefined) lines.push(`Expires: ${formatEpochMs(permission.expires_at)}`);
  }
  const grantProposal = getPendingPermissionGrantProposal(record);
  if (grantProposal) {
    lines.push(
      `Reusable permission: ${grantProposal.capabilities.join(", ")}`,
      `Still excluded: ${grantProposal.excluded_capabilities.length > 0 ? grantProposal.excluded_capabilities.join(", ") : "none"}`,
      `Default scope: ${grantProposal.default_scope}`,
    );
  }
  lines.push("Reply in this conversation to approve, reject, or ask for clarification.");
  return lines.join("\n");
}

function projectApprovalSurface(record: ApprovalRecord): SurfaceProjection {
  const task = approvalTaskFromRecord(record, {
    id: record.approval_id,
    description: "Approval required",
    action: "unknown",
  });
  const permission = getPendingPermissionTask(record);
  const createdAt = safeEpochDateTime(record.created_at) ?? new Date(0).toISOString();
  const expiresAt = safeEpochDateTime(record.expires_at);
  const issuanceReplayKey = approvalIssuanceReplayKey(record);
  const surfaceInstanceRef = approvalSurfaceInstanceRef(record);
  const projectionId = `surface:${issuanceReplayKey}`;
  const sourceEventRefs = [
    normalSourceEventRef({
      kind: "approval_request",
      ref: record.approval_id,
      event_type: "approval_required",
      occurred_at: createdAt,
      replay_key: issuanceReplayKey,
    }),
  ];
  const runtimeGraphRefs = [
    normalRuntimeGraphRef({
      kind: "approval",
      ref: record.approval_id,
      role: "target",
    }),
    ...(record.goal_id ? [normalRuntimeGraphRef({
      kind: "goal",
      ref: record.goal_id,
      role: "source",
    })] : []),
  ];
  const approvalPrompt = {
    approval_id: record.approval_id,
    prompt: renderConversationalApprovalPrompt(record),
    action: task.action,
    target_summary: task.description,
    ...(permission?.risk_class ? { risk_class: permission.risk_class } : {}),
    ...(expiresAt ? { expires_at: expiresAt } : {}),
    approve_binding_id: "",
    reject_binding_id: "",
  };
  const approveBinding = createApprovalActionBinding({
    record,
    actionKind: "approve",
    projectionId,
    surfaceInstanceRef,
    createdAt,
    expiresAt,
    sourceEventRefs,
    runtimeGraphRefs,
  });
  const rejectBinding = createApprovalActionBinding({
    record,
    actionKind: "reject",
    projectionId,
    surfaceInstanceRef,
    createdAt,
    expiresAt,
    sourceEventRefs,
    runtimeGraphRefs,
  });
  return createSurfaceProjection({
    projection_id: projectionId,
    surface: "approval",
    view: "normal",
    purpose: "Project an approval request into the current user-visible surface.",
    redaction_class: "normal_safe",
    projected_at: createdAt,
    replay_key: issuanceReplayKey,
    source_event_refs: sourceEventRefs,
    runtime_graph_refs: runtimeGraphRefs,
    approval_prompt: {
      ...approvalPrompt,
      approve_binding_id: approveBinding.binding_id,
      reject_binding_id: rejectBinding.binding_id,
    },
    actions: [
      {
        action_id: `${issuanceReplayKey}:approve`,
        kind: "approve",
        label: "Approve",
        style: "primary",
        binding_id: approveBinding.binding_id,
      },
      {
        action_id: `${issuanceReplayKey}:reject`,
        kind: "reject",
        label: "Reject",
        style: "danger",
        binding_id: rejectBinding.binding_id,
      },
    ],
    action_bindings: [approveBinding, rejectBinding],
  });
}

function createApprovalActionBinding(input: {
  record: ApprovalRecord;
  actionKind: "approve" | "reject";
  projectionId: string;
  surfaceInstanceRef: string;
  createdAt: string;
  expiresAt: string | null;
  sourceEventRefs: ReturnType<typeof normalSourceEventRef>[];
  runtimeGraphRefs: ReturnType<typeof normalRuntimeGraphRef>[];
}): SurfaceActionBinding {
  const origin = input.record.origin;
  return createSurfaceActionBinding({
    action_kind: input.actionKind,
    surface: "approval",
    surface_instance_ref: input.surfaceInstanceRef,
    target: {
      kind: "approval",
      ref: input.record.approval_id,
      surface_instance_ref: input.surfaceInstanceRef,
      ...(origin?.conversation_id ? { conversation_id: origin.conversation_id } : {}),
      ...(origin?.session_id ? { session_id: origin.session_id } : {}),
      ...(origin?.turn_id ? { message_id: origin.turn_id } : {}),
    },
    source_projection_id: input.projectionId,
    source_event_refs: input.sourceEventRefs,
    runtime_graph_refs: input.runtimeGraphRefs,
    replay_key: [
      approvalIssuanceReplayKey(input.record),
      input.actionKind,
      origin?.channel ?? "event",
      origin?.conversation_id ?? "",
      origin?.session_id ?? "",
      origin?.turn_id ?? "",
    ].join(":"),
    redaction_class: "normal_safe",
    created_at: input.createdAt,
    expires_at: input.expiresAt,
  });
}

function approvalActionBindingFor(
  projection: SurfaceProjection,
  actionKind: "approve" | "reject",
): SurfaceActionBinding | null {
  const action = projection.actions.find((candidate) => candidate.kind === actionKind);
  const bindingId = action?.binding_id ?? projection.approval_prompt?.[
    actionKind === "approve" ? "approve_binding_id" : "reject_binding_id"
  ];
  if (!bindingId) {
    return null;
  }
  return projection.action_bindings.find((binding) => binding.binding_id === bindingId) ?? null;
}

function validateApprovalResolutionBinding(
  record: ApprovalRecord,
  approved: boolean,
  bindingInput: ApprovalResolutionBinding,
  now: number,
): boolean {
  const surfaceProjection = projectApprovalSurface(record);
  const expectedAction = approved ? "approve" : "reject";
  const expectedBinding = approvalActionBindingFor(surfaceProjection, expectedAction);
  if (!expectedBinding) {
    return false;
  }
  const inputRef = bindingInput.surfaceActionBindingId ?? bindingInput.surfaceActionBindingToken;
  if (!inputRef) {
    return false;
  }
  const providedBinding = findSurfaceActionBindingByToken(surfaceProjection.action_bindings, inputRef);
  if (!providedBinding || providedBinding.binding_id !== expectedBinding.binding_id) {
    return false;
  }
  const validation = validateSurfaceActionBinding({
    binding: providedBinding,
    surface: "approval",
    surfaceInstanceRef: approvalSurfaceInstanceRef(record),
    actionKind: expectedAction,
    now: safeEpochDateTime(now) ?? undefined,
  });
  return validation.status === "accepted";
}

function approvalSurfaceInstanceRef(record: ApprovalRecord): string {
  const origin = record.origin;
  const issuanceValue = approvalIssuanceIdentity(record);
  if (!origin) {
    return `approval:event:${encodeSurfacePart(record.approval_id)}:issued:${encodeSurfacePart(issuanceValue)}`;
  }
  return [
    "approval",
    origin.channel,
    origin.conversation_id,
    origin.user_id ?? "anonymous",
    origin.session_id ?? "sessionless",
    origin.turn_id ?? "turnless",
    "issued",
    issuanceValue,
  ].map(encodeSurfacePart).join(":");
}

function approvalIssuanceReplayKey(record: ApprovalRecord): string {
  return `approval:${record.approval_id}:issued:${approvalIssuanceIdentity(record)}`;
}

function approvalIssuanceIdentity(record: ApprovalRecord): string {
  return record.surface_issuance_id ?? safeEpochDateTime(record.created_at) ?? String(record.created_at);
}

function safeEpochDateTime(value: number): string | null {
  if (!Number.isFinite(value) || Math.abs(value) > MAX_VALID_DATE_MS) {
    return null;
  }
  return new Date(value).toISOString();
}

function encodeSurfacePart(value: string): string {
  return encodeURIComponent(value).replace(/%/g, "_");
}

function formatEpochMs(value: number): string {
  if (!Number.isFinite(value) || Math.abs(value) > MAX_VALID_DATE_MS) {
    return "unavailable";
  }
  return new Date(value).toISOString();
}

function approvalTaskFromRecord(record: ApprovalRecord, fallback: ApprovalTaskRequest): ApprovalTaskRequest {
  const permission = getPendingPermissionTask(record);
  if (permission) {
    return permission;
  }
  const payload = record.payload;
  if (!isRecord(payload)) {
    return fallback;
  }
  const task = payload["task"];
  return isGenericApprovalTaskRequest(task) ? task : fallback;
}

function isGenericApprovalTaskRequest(value: unknown): value is ApprovalTaskRequest {
  if (!isRecord(value)) {
    return false;
  }
  if (value["kind"] !== undefined) {
    return false;
  }
  return typeof value["id"] === "string"
    && typeof value["description"] === "string"
    && typeof value["action"] === "string"
    && hasSafeOptionalTaskExpiry(value["expires_at"]);
}

function hasSafeOptionalTaskExpiry(value: unknown): boolean {
  return value === undefined
    || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function approvalOriginMatches(expected: ApprovalOrigin | undefined, actual: ApprovalOrigin): boolean {
  if (!expected) {
    return false;
  }
  return expected.channel === actual.channel
    && expected.conversation_id === actual.conversation_id
    && requiredFieldMatches(expected.user_id, actual.user_id)
    && requiredFieldMatches(expected.session_id, actual.session_id)
    && requiredFieldMatches(expected.turn_id, actual.turn_id);
}

function requiredFieldMatches(expected: string | undefined, actual: string | undefined): boolean {
  return expected !== undefined && expected === actual;
}

function conversationalApprovalOriginMatches(expected: ApprovalOrigin | undefined, actual: ApprovalOrigin): boolean {
  if (!expected) {
    return false;
  }
  return expected.channel === actual.channel
    && expected.conversation_id === actual.conversation_id
    && requiredFieldMatches(expected.user_id, actual.user_id)
    && requiredFieldMatches(expected.session_id, actual.session_id);
}
