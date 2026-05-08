import type { Logger } from "./logger.js";
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
}

export interface ConversationalApprovalDelivery {
  delivered: boolean;
  reason?: string;
}

export interface ConversationalApprovalRequest {
  record: ApprovalRecord;
  origin: ApprovalOrigin;
  prompt: string;
}

export interface ConversationalApprovalOptions {
  origin: ApprovalOrigin;
  timeoutMs?: number;
  approvalId?: string;
  deliverConversationalApproval?: (
    request: ConversationalApprovalRequest
  ) => Promise<ConversationalApprovalDelivery> | ConversationalApprovalDelivery;
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
    responseChannel = "http"
  ): Promise<boolean> {
    const pendingRecord = this.pending.get(approvalId)?.record ?? await this.store.loadPending(approvalId);
    if (pendingRecord?.origin) {
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
      const delivery = await deliver({
        record,
        origin: record.origin,
        prompt: renderConversationalApprovalPrompt(record),
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
    const payload = record.payload as { task?: ApprovalTaskRequest };
    const prompt = record.origin ? renderConversationalApprovalPrompt(record) : undefined;
    return {
      requestId: record.approval_id,
      goalId: record.goal_id,
      task: payload.task ?? { id: "", description: "", action: "" },
      expiresAt: record.expires_at,
      restored,
      ...(record.origin ? { origin: record.origin } : {}),
      ...(prompt ? { prompt } : {}),
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
  const payload = record.payload as { task?: ApprovalTaskRequest };
  const task = payload.task ?? { id: record.approval_id, description: "Approval required", action: "unknown" };
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
    if (permission.expires_at) lines.push(`Expires: ${new Date(permission.expires_at).toISOString()}`);
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
