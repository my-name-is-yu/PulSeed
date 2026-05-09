import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { StateManager } from "../../base/state/state-manager.js";
import { ChatHistory, ChatSessionSchema, type ChatMessage, type ChatSession } from "../../interface/chat/chat-history.js";
import { ChatSessionCatalog, type LoadedChatSession } from "../../interface/chat/chat-session-store.js";
import { createRuntimeSessionRegistry } from "../../runtime/session-registry/index.js";
import {
  BackgroundRunStatusSchema,
  type BackgroundRun,
  type RuntimeReplyTarget,
  type RuntimeSession,
} from "../../runtime/session-registry/types.js";
import { OutboxStore } from "../../runtime/store/outbox-store.js";
import { RuntimeDreamReviewTool } from "./runtime-dream-review-tool.js";
import type {
  ITool,
  PermissionCheckResult,
  ToolCallContext,
  ToolDescriptionContext,
  ToolMetadata,
  ToolResult,
} from "../types.js";

const READ_ONLY = true;
const READ_PERMISSION = "read_only" as const;
const WRITE_PERMISSION = "write_local" as const;
const TAGS = ["session", "self-grounding"] as const;

function normalizeConversationSelector(selector: string): string {
  return selector.startsWith("session:conversation:")
    ? selector.slice("session:conversation:".length)
    : selector;
}

function toConversationRuntimeId(sessionId: string): string {
  return `session:conversation:${sessionId}`;
}

function normalizeRuntimeSessionSelector(sessionId: string): string {
  return sessionId.startsWith("session:")
    ? sessionId
    : toConversationRuntimeId(sessionId);
}

function backgroundRunEpoch(run: BackgroundRun): string | null {
  return run.updated_at ?? run.started_at ?? run.created_at;
}

function buildCompletionMessage(session: LoadedChatSession, status: "completed" | "failed", summary: string): string {
  const title = session.title ? ` "${session.title}"` : "";
  return `Session ${session.id}${title} ${status}: ${summary}`;
}

function summarizeMessages(messages: ChatMessage[], limit: number): Array<{
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  turnIndex: number;
}> {
  return messages.slice(-limit).map((message) => ({
    role: message.role,
    content: message.content,
    timestamp: message.timestamp,
    turnIndex: message.turnIndex,
  }));
}

function reindexMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message, index) => ({
    role: message.role,
    content: message.content,
    timestamp: message.timestamp,
    turnIndex: index,
  }));
}

function toChatSessionRecord(session: LoadedChatSession): ChatSession {
  return {
    id: session.id,
    cwd: session.cwd,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messages: [...session.messages],
    ...(session.parentSessionId ? { parentSessionId: session.parentSessionId } : {}),
    ...(session.spawnedBySessionId ? { spawnedBySessionId: session.spawnedBySessionId } : {}),
    ...(session.spawnedByRuntimeSessionId ? { spawnedByRuntimeSessionId: session.spawnedByRuntimeSessionId } : {}),
    ...(session.spawnedAt ? { spawnedAt: session.spawnedAt } : {}),
    ...(session.sessionStatus ? { sessionStatus: session.sessionStatus } : {}),
    ...(session.sessionSummary ? { sessionSummary: session.sessionSummary } : {}),
    ...(session.completedAt ? { completedAt: session.completedAt } : {}),
    ...(session.goalId ? { goalId: session.goalId } : {}),
    ...(session.strategyId ? { strategyId: session.strategyId } : {}),
    ...(session.notificationPolicy ? { notificationPolicy: session.notificationPolicy } : {}),
    ...(session.ownerId ? { ownerId: session.ownerId } : {}),
    ...(session.ownerClaimedAt ? { ownerClaimedAt: session.ownerClaimedAt } : {}),
    ...(session.waitingUntil ? { waitingUntil: session.waitingUntil } : {}),
    ...(session.waitingCondition ? { waitingCondition: session.waitingCondition } : {}),
    ...(session.retryCount !== null && session.retryCount !== undefined ? { retryCount: session.retryCount } : {}),
    ...(session.lastRetryAt ? { lastRetryAt: session.lastRetryAt } : {}),
    ...(session.lastResumedAt ? { lastResumedAt: session.lastResumedAt } : {}),
    ...(session.notificationReplyTarget ? { notificationReplyTarget: session.notificationReplyTarget } : {}),
    ...(session.parentNotificationStatus ? { parentNotificationStatus: session.parentNotificationStatus } : {}),
    ...(session.parentNotificationSummary ? { parentNotificationSummary: session.parentNotificationSummary } : {}),
    ...(session.parentNotifiedAt ? { parentNotifiedAt: session.parentNotifiedAt } : {}),
    ...(session.compactionSummary ? { compactionSummary: session.compactionSummary } : {}),
    ...(session.title ? { title: session.title } : {}),
    ...(session.agentLoopSessionId ? { agentLoopSessionId: session.agentLoopSessionId } : {}),
    ...(session.agentLoopTraceId ? { agentLoopTraceId: session.agentLoopTraceId } : {}),
    ...(session.agentLoopStatePath ? { agentLoopStatePath: session.agentLoopStatePath } : {}),
    ...(session.agentLoopStatus === "running" || session.agentLoopStatus === "completed" || session.agentLoopStatus === "failed"
      ? { agentLoopStatus: session.agentLoopStatus }
      : {}),
    ...(session.agentLoopResumable ? { agentLoopResumable: true } : {}),
    ...(session.agentLoopUpdatedAt ? { agentLoopUpdatedAt: session.agentLoopUpdatedAt } : {}),
    ...(session.agentLoop ? { agentLoop: session.agentLoop } : {}),
    ...(session.usage ? { usage: session.usage } : {}),
  };
}

class RuntimeSessionToolService {
  constructor(private readonly stateManager: StateManager) {}

  private catalog(): ChatSessionCatalog {
    return new ChatSessionCatalog(this.stateManager);
  }

  private registry() {
    return createRuntimeSessionRegistry({ stateManager: this.stateManager });
  }

  private outbox() {
    return new OutboxStore(this.stateManager.getBaseDir());
  }

  async listSessions(
    input: RuntimeSessionsListInput,
    context: ToolCallContext,
  ): Promise<{ sessions: RuntimeSession[]; runs?: BackgroundRun[] }> {
    const snapshot = await this.registry().snapshot();
    const allowedConversationIds = await this.allowedConversationIds(input.scope, context);
    const runtimeAllowedIds = allowedConversationIds
      ? new Set(Array.from(allowedConversationIds, (id) => toConversationRuntimeId(id)))
      : null;
    const kindFilter = input.kinds?.length ? new Set(input.kinds) : null;

    const sessions = snapshot.sessions.filter((session) => {
      if (kindFilter && !kindFilter.has(session.kind)) return false;
      if (input.activeOnly && session.status !== "active") return false;
      if (!runtimeAllowedIds) return true;
      if (session.kind === "conversation") return runtimeAllowedIds.has(session.id);
      return session.parent_session_id ? runtimeAllowedIds.has(session.parent_session_id) : false;
    });

    if (!input.includeRuns) {
      return { sessions };
    }

    const runs = snapshot.background_runs.filter((run) => {
      if (!runtimeAllowedIds) return true;
      if (run.parent_session_id && runtimeAllowedIds.has(run.parent_session_id)) return true;
      return run.child_session_id ? sessions.some((session) => session.id === run.child_session_id) : false;
    });
    return { sessions, runs };
  }

  async observeRuns(
    input: RuntimeRunsObserveInput,
    context: ToolCallContext,
  ): Promise<{
    generatedAt: string;
    observedSnapshotEpoch: string;
    runs: Array<BackgroundRun & { observed_run_epoch: string | null }>;
    sessions?: RuntimeSession[];
  }> {
    const snapshot = await this.registry().snapshot();
    const allowedConversationIds = await this.allowedConversationIds(input.scope, context);
    const runtimeAllowedIds = allowedConversationIds
      ? new Set(Array.from(allowedConversationIds, (id) => toConversationRuntimeId(id)))
      : null;
    const statusFilter = input.statuses?.length ? new Set(input.statuses) : null;
    const sessionSelector = input.session_id ? normalizeRuntimeSessionSelector(input.session_id) : null;
    const runs = snapshot.background_runs
      .filter((run) => {
        if (input.run_id && run.id !== input.run_id) return false;
        if (sessionSelector && run.parent_session_id !== sessionSelector && run.child_session_id !== sessionSelector) return false;
        if (statusFilter && !statusFilter.has(run.status)) return false;
        if (input.activeOnly && run.status !== "queued" && run.status !== "running") return false;
        if (!runtimeAllowedIds) return true;
        if (run.parent_session_id && runtimeAllowedIds.has(run.parent_session_id)) return true;
        return run.child_session_id ? runtimeAllowedIds.has(run.child_session_id) : false;
      })
      .sort((left, right) => Date.parse(backgroundRunEpoch(right) ?? "") - Date.parse(backgroundRunEpoch(left) ?? ""))
      .slice(0, input.limit)
      .map((run) => ({
        ...run,
        observed_run_epoch: backgroundRunEpoch(run),
      }));

    const runSessionIds = new Set<string>();
    for (const run of runs) {
      if (run.parent_session_id) runSessionIds.add(run.parent_session_id);
      if (run.child_session_id) runSessionIds.add(run.child_session_id);
    }

    return {
      generatedAt: snapshot.generated_at,
      observedSnapshotEpoch: snapshot.generated_at,
      runs,
      ...(input.includeSessions
        ? { sessions: snapshot.sessions.filter((session) => runSessionIds.has(session.id)) }
        : {}),
    };
  }

  async loadHistory(selector: string, limit: number): Promise<{
    sessionId: string;
    runtimeSessionId: string;
    title: string | null;
    parentSessionId: string | null;
    cwd: string;
    createdAt: string;
    updatedAt: string;
    compactionSummary?: string;
    messages: Array<{ role: "user" | "assistant"; content: string; timestamp: string; turnIndex: number }>;
  }> {
    const session = await this.resolveConversationSession(selector);
    return {
      sessionId: session.id,
      runtimeSessionId: toConversationRuntimeId(session.id),
      title: session.title,
      parentSessionId: session.parentSessionId ?? null,
      cwd: session.cwd,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      ...(session.compactionSummary ? { compactionSummary: session.compactionSummary } : {}),
      messages: summarizeMessages(session.messages, limit),
    };
  }

  async readSession(selector: string): Promise<{
    sessionId: string;
    runtimeSessionId: string;
    title: string | null;
    parentSessionId: string | null;
    childSessionIds: string[];
    cwd: string;
    createdAt: string;
    updatedAt: string;
    sessionStatus: string | null;
    sessionSummary: string | null;
    completedAt: string | null;
    goalId: string | null;
    strategyId: string | null;
    notificationPolicy: string | null;
    ownerId: string | null;
    ownerClaimedAt: string | null;
    waitingUntil: string | null;
    waitingCondition: string | null;
    retryCount: number | null;
    lastRetryAt: string | null;
    lastResumedAt: string | null;
    parentNotificationStatus: string | null;
    parentNotifiedAt: string | null;
    notificationReplyTarget: RuntimeReplyTarget | null;
  }> {
    const session = await this.resolveConversationSession(selector);
    const entries = await this.catalog().listSessions();
    return {
      sessionId: session.id,
      runtimeSessionId: toConversationRuntimeId(session.id),
      title: session.title,
      parentSessionId: session.parentSessionId ?? null,
      childSessionIds: entries.filter((entry) => entry.parentSessionId === session.id).map((entry) => entry.id),
      cwd: session.cwd,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      sessionStatus: session.sessionStatus ?? null,
      sessionSummary: session.sessionSummary ?? null,
      completedAt: session.completedAt ?? null,
      goalId: session.goalId ?? null,
      strategyId: session.strategyId ?? null,
      notificationPolicy: session.notificationPolicy ?? null,
      ownerId: session.ownerId ?? null,
      ownerClaimedAt: session.ownerClaimedAt ?? null,
      waitingUntil: session.waitingUntil ?? null,
      waitingCondition: session.waitingCondition ?? null,
      retryCount: session.retryCount ?? null,
      lastRetryAt: session.lastRetryAt ?? null,
      lastResumedAt: session.lastResumedAt ?? null,
      parentNotificationStatus: session.parentNotificationStatus ?? null,
      parentNotifiedAt: session.parentNotifiedAt ?? null,
      notificationReplyTarget: session.notificationReplyTarget ?? null,
    };
  }

  async listChildren(selector: string): Promise<{
    sessionId: string;
    runtimeSessionId: string;
    children: Array<{
      sessionId: string;
      runtimeSessionId: string;
      title: string | null;
      sessionStatus: string | null;
      goalId: string | null;
      strategyId: string | null;
      waitingUntil: string | null;
      ownerId: string | null;
    }>;
  }> {
    const session = await this.resolveConversationSession(selector);
    const entries = await this.catalog().listSessions();
    const loadedChildren = await Promise.all(
      entries
        .filter((entry) => entry.parentSessionId === session.id)
        .map((entry) => this.catalog().loadSession(entry.id)),
    );
    return {
      sessionId: session.id,
      runtimeSessionId: toConversationRuntimeId(session.id),
      children: loadedChildren
        .filter((child): child is LoadedChatSession => child !== null)
        .map((child) => ({
          sessionId: child.id,
          runtimeSessionId: toConversationRuntimeId(child.id),
          title: child.title,
          sessionStatus: child.sessionStatus ?? null,
          goalId: child.goalId ?? null,
          strategyId: child.strategyId ?? null,
          waitingUntil: child.waitingUntil ?? null,
          ownerId: child.ownerId ?? null,
        })),
    };
  }

  async spawnSession(
    input: RuntimeSessionsSpawnInput,
    context: ToolCallContext,
  ): Promise<{
    sessionId: string;
    runtimeSessionId: string;
    parentSessionId: string | null;
    resumeCommand: string;
    messageQueued: boolean;
  }> {
    const now = new Date().toISOString();
    const sessionId = randomUUID();
    const parentSessionId = context.conversationSessionId ?? null;
    const baseSession = input.copy_recent_messages && parentSessionId
      ? await this.catalog().loadSession(parentSessionId)
      : null;
    const seededMessages = input.copy_recent_messages && baseSession
      ? reindexMessages(baseSession.messages.slice(-input.recent_message_limit))
      : [];

    const persisted = ChatSessionSchema.parse({
      id: sessionId,
      cwd: input.cwd?.trim() || context.cwd,
      createdAt: now,
      updatedAt: now,
      messages: seededMessages,
      ...(input.title?.trim() ? { title: input.title.trim() } : {}),
      ...(parentSessionId ? { parentSessionId } : {}),
      ...(parentSessionId ? { spawnedBySessionId: parentSessionId } : {}),
      ...(context.sessionId ? { spawnedByRuntimeSessionId: context.sessionId } : {}),
      spawnedAt: now,
      ...(input.goal_id?.trim() ? { goalId: input.goal_id.trim() } : {}),
      ...(input.strategy_id?.trim() ? { strategyId: input.strategy_id.trim() } : {}),
      notificationPolicy: input.notification_policy ?? (parentSessionId ? "all_terminal" : "important_only"),
      ...(input.owner_id?.trim() ? { ownerId: input.owner_id.trim() } : {}),
      ...(input.owner_id?.trim() ? { ownerClaimedAt: now } : {}),
      sessionStatus: input.message?.trim() ? "queued" : "idle",
      parentNotificationStatus: parentSessionId ? "pending" : "none",
      ...(baseSession?.notificationReplyTarget ? { notificationReplyTarget: baseSession.notificationReplyTarget } : {}),
    });

    const history = ChatHistory.fromSession(this.stateManager, persisted);
    if (input.message?.trim()) {
      await history.appendUserMessage(input.message.trim());
    } else {
      await history.persist();
    }

    return {
      sessionId,
      runtimeSessionId: toConversationRuntimeId(sessionId),
      parentSessionId,
      resumeCommand: `/resume session:conversation:${sessionId}`,
      messageQueued: Boolean(input.message?.trim()),
    };
  }

  async sendToSession(selector: string, message: string): Promise<{
    sessionId: string;
    runtimeSessionId: string;
    messageCount: number;
    updatedAt: string;
  }> {
    const session = await this.resolveConversationSession(selector);
    const history = ChatHistory.fromSession(this.stateManager, toChatSessionRecord(session));
    history.setSessionLifecycle({ status: "queued" });
    await history.appendUserMessage(message.trim());
    const updated = history.getSessionData();
    return {
      sessionId: session.id,
      runtimeSessionId: toConversationRuntimeId(session.id),
      messageCount: updated.messages.length,
      updatedAt: updated.updatedAt ?? updated.createdAt,
    };
  }

  async updateSession(selector: string, input: RuntimeSessionsUpdateInput): Promise<{
    sessionId: string;
    runtimeSessionId: string;
    status: string;
    parentSessionId: string | null;
    parentNotificationStatus: string | null;
    notified: boolean;
  }> {
    const session = await this.resolveConversationSession(selector);
    const history = ChatHistory.fromSession(this.stateManager, toChatSessionRecord(session));
    const completedAt = input.status === "completed" || input.status === "failed"
      ? (input.completed_at ?? new Date().toISOString())
      : null;
    history.setSessionLifecycle({
      status: input.status,
      summary: input.summary ?? undefined,
      completedAt,
      goalId: input.goal_id ?? undefined,
      strategyId: input.strategy_id ?? undefined,
      notificationPolicy: input.notification_policy ?? undefined,
      waitingUntil: input.waiting_until ?? (input.status === "waiting" ? null : undefined),
      waitingCondition: input.waiting_condition ?? (input.status === "waiting" ? null : undefined),
      lastResumedAt: input.status === "running" ? new Date().toISOString() : undefined,
      parentNotificationStatus: session.parentSessionId && input.notify_parent ? "pending" : undefined,
    });
    if (input.append_assistant_message && input.summary?.trim()) {
      await history.appendAssistantMessage(input.summary.trim());
    } else {
      await history.persist();
    }

    let notified = false;
    let parentNotificationStatus: "none" | "pending" | "sent" | "failed" | null =
      session.parentNotificationStatus ?? null;
    if (
      session.parentSessionId
      && input.notify_parent
      && input.summary?.trim()
      && (input.status === "completed" || input.status === "failed")
    ) {
      try {
        await this.notifyParentSession(session, input.status, input.summary.trim(), completedAt ?? new Date().toISOString());
        parentNotificationStatus = "sent";
        notified = true;
      } catch {
        parentNotificationStatus = "failed";
      }
      const refreshed = ChatHistory.fromSession(this.stateManager, {
        ...history.getSessionData(),
      });
      refreshed.setSessionLifecycle({
        parentNotificationStatus,
        parentNotificationSummary: input.summary.trim(),
        parentNotifiedAt: notified ? new Date().toISOString() : null,
      });
      await refreshed.persist();
    }

    return {
      sessionId: session.id,
      runtimeSessionId: toConversationRuntimeId(session.id),
      status: input.status,
      parentSessionId: session.parentSessionId ?? null,
      parentNotificationStatus,
      notified,
    };
  }

  async claimSession(selector: string, ownerId: string): Promise<{
    sessionId: string;
    runtimeSessionId: string;
    ownerId: string;
    ownerClaimedAt: string;
  }> {
    const session = await this.resolveConversationSession(selector);
    const history = ChatHistory.fromSession(this.stateManager, toChatSessionRecord(session));
    const ownerClaimedAt = new Date().toISOString();
    history.setSessionLifecycle({ ownerId, ownerClaimedAt });
    await history.persist();
    return {
      sessionId: session.id,
      runtimeSessionId: toConversationRuntimeId(session.id),
      ownerId,
      ownerClaimedAt,
    };
  }

  async cancelSession(selector: string, reason: string): Promise<{
    sessionId: string;
    runtimeSessionId: string;
    status: "failed";
  }> {
    await this.updateSession(selector, {
      session_id: selector,
      status: "failed",
      summary: reason,
      append_assistant_message: false,
      notify_parent: true,
    });
    const session = await this.resolveConversationSession(selector);
    return {
      sessionId: session.id,
      runtimeSessionId: toConversationRuntimeId(session.id),
      status: "failed",
    };
  }

  async retrySession(selector: string, message?: string): Promise<{
    sessionId: string;
    runtimeSessionId: string;
    retryCount: number;
    status: "queued";
  }> {
    const session = await this.resolveConversationSession(selector);
    const history = ChatHistory.fromSession(this.stateManager, toChatSessionRecord(session));
    const retryCount = (session.retryCount ?? 0) + 1;
    const now = new Date().toISOString();
    history.setSessionLifecycle({
      status: "queued",
      completedAt: null,
      summary: null,
      retryCount,
      lastRetryAt: now,
      waitingUntil: null,
      waitingCondition: null,
      parentNotificationStatus: session.parentSessionId ? "pending" : session.parentNotificationStatus ?? null,
    });
    if (message?.trim()) {
      await history.appendUserMessage(message.trim());
    } else {
      await history.persist();
    }
    return {
      sessionId: session.id,
      runtimeSessionId: toConversationRuntimeId(session.id),
      retryCount,
      status: "queued",
    };
  }

  private async notifyParentSession(
    childSession: LoadedChatSession,
    status: "completed" | "failed",
    summary: string,
    completedAt: string,
  ): Promise<void> {
    const parentSession = await this.resolveConversationSession(childSession.parentSessionId!);
    const parentHistory = ChatHistory.fromSession(this.stateManager, toChatSessionRecord(parentSession));
    const message = buildCompletionMessage(childSession, status, summary);
    await parentHistory.appendAssistantMessage(message);

    const replyTarget = parentSession.notificationReplyTarget ?? childSession.notificationReplyTarget ?? null;
    if (!replyTarget) return;

    const outbox = this.outbox();
    const createdAt = Date.now();
    await outbox.append({
      event_type: "session_completion",
      correlation_id: childSession.id,
      created_at: createdAt,
      payload: {
        session_id: childSession.id,
        runtime_session_id: toConversationRuntimeId(childSession.id),
        parent_session_id: childSession.parentSessionId,
        status,
        summary,
        completed_at: completedAt,
        reply_target: replyTarget,
      },
    });
    await outbox.append({
      event_type: "chat_response",
      correlation_id: childSession.id,
      created_at: Date.now(),
      payload: {
        goalId: `session:${childSession.id}`,
        goal_id: `session:${childSession.id}`,
        message,
        status,
        reply_target: replyTarget,
        session_completion: {
          session_id: childSession.id,
          runtime_session_id: toConversationRuntimeId(childSession.id),
          parent_session_id: childSession.parentSessionId,
          status,
          summary,
          completed_at: completedAt,
        },
      },
    });
  }

  private async resolveConversationSession(selector: string): Promise<LoadedChatSession> {
    const session = await this.catalog().loadSessionBySelector(normalizeConversationSelector(selector));
    if (!session) {
      throw new Error(`No chat session matched selector "${selector}".`);
    }
    return session;
  }

  private async allowedConversationIds(
    scope: RuntimeSessionsScope,
    context: ToolCallContext,
  ): Promise<Set<string> | null> {
    const currentConversationId = context.conversationSessionId ?? null;
    if (scope === "all" || !currentConversationId) return null;
    if (scope === "self") return new Set([currentConversationId]);

    const entries = await this.catalog().listSessions();
    const descendants = new Set<string>([currentConversationId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const entry of entries) {
        if (!entry.parentSessionId) continue;
        if (descendants.has(entry.parentSessionId) && !descendants.has(entry.id)) {
          descendants.add(entry.id);
          changed = true;
        }
      }
    }
    return descendants;
  }
}

export const RuntimeSessionsListInputSchema = z.object({
  scope: z.enum(["self", "tree", "all"]).default("tree"),
  kinds: z.array(z.enum(["conversation", "agent", "coreloop"])).optional(),
  activeOnly: z.boolean().default(false),
  includeRuns: z.boolean().default(false),
});
export type RuntimeSessionsScope = z.infer<typeof RuntimeSessionsListInputSchema>["scope"];
export type RuntimeSessionsListInput = z.infer<typeof RuntimeSessionsListInputSchema>;

export class RuntimeSessionsListTool implements ITool<RuntimeSessionsListInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "sessions_list",
    aliases: ["list_sessions", "runtime_sessions_list"],
    permissionLevel: READ_PERMISSION,
    isReadOnly: READ_ONLY,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 0,
    maxOutputChars: 12000,
    tags: [...TAGS],
  };
  readonly inputSchema = RuntimeSessionsListInputSchema;

  constructor(private readonly service: RuntimeSessionToolService) {}

  description(_context?: ToolDescriptionContext): string {
    return "List PulSeed runtime sessions. Supports current-session scope, spawned-session tree scope, or all sessions.";
  }

  async call(input: RuntimeSessionsListInput, context: ToolCallContext): Promise<ToolResult> {
    const started = Date.now();
    try {
      const data = await this.service.listSessions(input, context);
      return {
        success: true,
        data,
        summary: `Found ${data.sessions.length} session(s)`,
        durationMs: Date.now() - started,
      };
    } catch (error) {
      return {
        success: false,
        data: null,
        summary: `sessions_list failed: ${error instanceof Error ? error.message : String(error)}`,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - started,
      };
    }
  }

  async checkPermissions(): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(): boolean {
    return true;
  }
}

export const RuntimeRunsObserveInputSchema = z.object({
  scope: z.enum(["self", "tree", "all"]).default("tree"),
  run_id: z.string().min(1).optional(),
  session_id: z.string().min(1).optional(),
  statuses: z.array(BackgroundRunStatusSchema).optional(),
  activeOnly: z.boolean().default(false),
  includeSessions: z.boolean().default(true),
  limit: z.number().int().positive().max(50).default(20),
});
export type RuntimeRunsObserveInput = z.infer<typeof RuntimeRunsObserveInputSchema>;

export class RuntimeRunsObserveTool implements ITool<RuntimeRunsObserveInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "runs_observe",
    aliases: ["observe_runs", "runtime_runs_observe"],
    permissionLevel: READ_PERMISSION,
    isReadOnly: READ_ONLY,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 0,
    maxOutputChars: 12000,
    tags: [...TAGS, "runtime-control"],
  };
  readonly inputSchema = RuntimeRunsObserveInputSchema;

  constructor(private readonly service: RuntimeSessionToolService) {}

  description(): string {
    return "Observe typed background runtime runs and return exact run ids plus observed_run_epoch values required by mutating run-control tools.";
  }

  async call(input: RuntimeRunsObserveInput, context: ToolCallContext): Promise<ToolResult> {
    const started = Date.now();
    try {
      const data = await this.service.observeRuns(input, context);
      return {
        success: true,
        data,
        summary: `Observed ${data.runs.length} runtime run(s)`,
        durationMs: Date.now() - started,
      };
    } catch (error) {
      return {
        success: false,
        data: null,
        summary: `runs_observe failed: ${error instanceof Error ? error.message : String(error)}`,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - started,
      };
    }
  }

  async checkPermissions(): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(): boolean {
    return true;
  }
}

export const RuntimeSessionsHistoryInputSchema = z.object({
  session_id: z.string().min(1, "session_id is required"),
  limit: z.number().int().positive().max(100).default(20),
});
export type RuntimeSessionsHistoryInput = z.infer<typeof RuntimeSessionsHistoryInputSchema>;

export class RuntimeSessionsHistoryTool implements ITool<RuntimeSessionsHistoryInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "sessions_history",
    aliases: ["read_session_history", "runtime_session_history"],
    permissionLevel: READ_PERMISSION,
    isReadOnly: READ_ONLY,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 0,
    maxOutputChars: 12000,
    tags: [...TAGS],
  };
  readonly inputSchema = RuntimeSessionsHistoryInputSchema;

  constructor(private readonly service: RuntimeSessionToolService) {}

  description(_context?: ToolDescriptionContext): string {
    return "Read recent message history from a PulSeed chat conversation session by chat id or runtime session id.";
  }

  async call(input: RuntimeSessionsHistoryInput, _context: ToolCallContext): Promise<ToolResult> {
    const started = Date.now();
    try {
      const data = await this.service.loadHistory(input.session_id, input.limit);
      return {
        success: true,
        data,
        summary: `Loaded ${data.messages.length} message(s) from session ${data.sessionId}`,
        durationMs: Date.now() - started,
      };
    } catch (error) {
      return {
        success: false,
        data: null,
        summary: `sessions_history failed: ${error instanceof Error ? error.message : String(error)}`,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - started,
      };
    }
  }

  async checkPermissions(): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(): boolean {
    return true;
  }
}

export const RuntimeSessionsReadInputSchema = z.object({
  session_id: z.string().min(1, "session_id is required"),
});
export type RuntimeSessionsReadInput = z.infer<typeof RuntimeSessionsReadInputSchema>;

export class RuntimeSessionsReadTool implements ITool<RuntimeSessionsReadInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "sessions_read",
    aliases: ["read_session", "runtime_session_read"],
    permissionLevel: READ_PERMISSION,
    isReadOnly: READ_ONLY,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 0,
    maxOutputChars: 12000,
    tags: [...TAGS],
  };
  readonly inputSchema = RuntimeSessionsReadInputSchema;

  constructor(private readonly service: RuntimeSessionToolService) {}

  description(): string {
    return "Read one PulSeed conversation session with parent/child relationships, lifecycle state, and notification metadata.";
  }

  async call(input: RuntimeSessionsReadInput, _context: ToolCallContext): Promise<ToolResult> {
    const started = Date.now();
    try {
      const data = await this.service.readSession(input.session_id);
      return {
        success: true,
        data,
        summary: `Loaded session ${data.sessionId}`,
        durationMs: Date.now() - started,
      };
    } catch (error) {
      return {
        success: false,
        data: null,
        summary: `sessions_read failed: ${error instanceof Error ? error.message : String(error)}`,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - started,
      };
    }
  }

  async checkPermissions(): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(): boolean {
    return true;
  }
}

export const RuntimeSessionsChildrenInputSchema = z.object({
  session_id: z.string().min(1, "session_id is required"),
});
export type RuntimeSessionsChildrenInput = z.infer<typeof RuntimeSessionsChildrenInputSchema>;

export class RuntimeSessionsChildrenTool implements ITool<RuntimeSessionsChildrenInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "sessions_children",
    aliases: ["list_session_children", "runtime_session_children"],
    permissionLevel: READ_PERMISSION,
    isReadOnly: READ_ONLY,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 0,
    maxOutputChars: 12000,
    tags: [...TAGS],
  };
  readonly inputSchema = RuntimeSessionsChildrenInputSchema;

  constructor(private readonly service: RuntimeSessionToolService) {}

  description(): string {
    return "List child conversation sessions spawned from a PulSeed conversation session.";
  }

  async call(input: RuntimeSessionsChildrenInput, _context: ToolCallContext): Promise<ToolResult> {
    const started = Date.now();
    try {
      const data = await this.service.listChildren(input.session_id);
      return {
        success: true,
        data,
        summary: `Loaded ${data.children.length} child session(s) for ${data.sessionId}`,
        durationMs: Date.now() - started,
      };
    } catch (error) {
      return {
        success: false,
        data: null,
        summary: `sessions_children failed: ${error instanceof Error ? error.message : String(error)}`,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - started,
      };
    }
  }

  async checkPermissions(): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(): boolean {
    return true;
  }
}

export const RuntimeSessionsSpawnInputSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  message: z.string().trim().min(1).optional(),
  cwd: z.string().trim().min(1).optional(),
  goal_id: z.string().trim().min(1).optional(),
  strategy_id: z.string().trim().min(1).optional(),
  notification_policy: z.enum(["silent", "important_only", "periodic", "all_terminal"]).optional(),
  owner_id: z.string().trim().min(1).optional(),
  copy_recent_messages: z.boolean().default(false),
  recent_message_limit: z.number().int().positive().max(20).default(6),
});
export type RuntimeSessionsSpawnInput = z.infer<typeof RuntimeSessionsSpawnInputSchema>;

export class RuntimeSessionsSpawnTool implements ITool<RuntimeSessionsSpawnInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "sessions_spawn",
    aliases: ["spawn_session_runtime", "delegate_session"],
    permissionLevel: WRITE_PERMISSION,
    isReadOnly: false,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: 8000,
    tags: [...TAGS],
  };
  readonly inputSchema = RuntimeSessionsSpawnInputSchema;

  constructor(private readonly service: RuntimeSessionToolService) {}

  description(_context?: ToolDescriptionContext): string {
    return "Create a new PulSeed chat conversation session, optionally seeded with a task message, so work can be moved into a separate session.";
  }

  async call(input: RuntimeSessionsSpawnInput, context: ToolCallContext): Promise<ToolResult> {
    const started = Date.now();
    try {
      const data = await this.service.spawnSession(input, context);
      return {
        success: true,
        data,
        summary: `Spawned session ${data.sessionId}`,
        contextModifier: `Use ${data.resumeCommand} to continue the delegated work in that separate session.`,
        durationMs: Date.now() - started,
      };
    } catch (error) {
      return {
        success: false,
        data: null,
        summary: `sessions_spawn failed: ${error instanceof Error ? error.message : String(error)}`,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - started,
      };
    }
  }

  async checkPermissions(): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(): boolean {
    return false;
  }
}

export const RuntimeSessionsSendInputSchema = z.object({
  session_id: z.string().min(1, "session_id is required"),
  message: z.string().trim().min(1, "message is required"),
});
export type RuntimeSessionsSendInput = z.infer<typeof RuntimeSessionsSendInputSchema>;

export class RuntimeSessionsSendTool implements ITool<RuntimeSessionsSendInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "sessions_send",
    aliases: ["send_session_message", "enqueue_session_message"],
    permissionLevel: WRITE_PERMISSION,
    isReadOnly: false,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: 8000,
    tags: [...TAGS],
  };
  readonly inputSchema = RuntimeSessionsSendInputSchema;

  constructor(private readonly service: RuntimeSessionToolService) {}

  description(_context?: ToolDescriptionContext): string {
    return "Append a user message to another PulSeed chat conversation session by chat id or runtime session id.";
  }

  async call(input: RuntimeSessionsSendInput, _context: ToolCallContext): Promise<ToolResult> {
    const started = Date.now();
    try {
      const data = await this.service.sendToSession(input.session_id, input.message);
      return {
        success: true,
        data,
        summary: `Queued a message for session ${data.sessionId}`,
        contextModifier: `Resume ${data.runtimeSessionId} later to act on the queued message in that separate session.`,
        durationMs: Date.now() - started,
      };
    } catch (error) {
      return {
        success: false,
        data: null,
        summary: `sessions_send failed: ${error instanceof Error ? error.message : String(error)}`,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - started,
      };
    }
  }

  async checkPermissions(): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(): boolean {
    return false;
  }
}

export const RuntimeSessionsUpdateInputSchema = z.object({
  session_id: z.string().min(1, "session_id is required"),
  status: z.enum(["queued", "running", "waiting", "completed", "failed"]),
  summary: z.string().trim().min(1).optional(),
  goal_id: z.string().trim().min(1).optional(),
  strategy_id: z.string().trim().min(1).optional(),
  notification_policy: z.enum(["silent", "important_only", "periodic", "all_terminal"]).optional(),
  waiting_until: z.string().trim().min(1).nullable().optional(),
  waiting_condition: z.string().trim().min(1).nullable().optional(),
  append_assistant_message: z.boolean().default(false),
  notify_parent: z.boolean().default(false),
  completed_at: z.string().optional(),
}).superRefine((value, ctx) => {
  if ((value.status === "completed" || value.status === "failed") && !value.summary) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["summary"],
      message: "summary is required when marking a session completed or failed",
    });
  }
  if (value.status === "waiting" && !value.waiting_until && !value.waiting_condition) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["waiting_until"],
      message: "waiting_until or waiting_condition is required when marking a session waiting",
    });
  }
});
export type RuntimeSessionsUpdateInput = z.infer<typeof RuntimeSessionsUpdateInputSchema>;

export class RuntimeSessionsUpdateTool implements ITool<RuntimeSessionsUpdateInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "sessions_update",
    aliases: ["update_session_status", "complete_session", "fail_session"],
    permissionLevel: WRITE_PERMISSION,
    isReadOnly: false,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: 8000,
    tags: [...TAGS],
  };
  readonly inputSchema = RuntimeSessionsUpdateInputSchema;

  constructor(private readonly service: RuntimeSessionToolService) {}

  description(): string {
    return "Update a PulSeed conversation session lifecycle state. Can mark child sessions completed or failed and notify the parent session durably.";
  }

  async call(input: RuntimeSessionsUpdateInput, _context: ToolCallContext): Promise<ToolResult> {
    const started = Date.now();
    try {
      const data = await this.service.updateSession(input.session_id, input);
      return {
        success: true,
        data,
        summary: `Updated session ${data.sessionId} to ${data.status}`,
        durationMs: Date.now() - started,
      };
    } catch (error) {
      return {
        success: false,
        data: null,
        summary: `sessions_update failed: ${error instanceof Error ? error.message : String(error)}`,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - started,
      };
    }
  }

  async checkPermissions(): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(): boolean {
    return false;
  }
}

export const RuntimeSessionsClaimInputSchema = z.object({
  session_id: z.string().min(1, "session_id is required"),
  owner_id: z.string().trim().min(1, "owner_id is required"),
});
export type RuntimeSessionsClaimInput = z.infer<typeof RuntimeSessionsClaimInputSchema>;

export class RuntimeSessionsClaimTool implements ITool<RuntimeSessionsClaimInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "sessions_claim",
    aliases: ["claim_session", "runtime_session_claim"],
    permissionLevel: WRITE_PERMISSION,
    isReadOnly: false,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: 8000,
    tags: [...TAGS],
  };
  readonly inputSchema = RuntimeSessionsClaimInputSchema;

  constructor(private readonly service: RuntimeSessionToolService) {}

  description(): string {
    return "Claim ownership of a PulSeed conversation session so delegated work has an explicit owner.";
  }

  async call(input: RuntimeSessionsClaimInput, _context: ToolCallContext): Promise<ToolResult> {
    const started = Date.now();
    try {
      const data = await this.service.claimSession(input.session_id, input.owner_id);
      return {
        success: true,
        data,
        summary: `Claimed session ${data.sessionId} for ${data.ownerId}`,
        durationMs: Date.now() - started,
      };
    } catch (error) {
      return {
        success: false,
        data: null,
        summary: `sessions_claim failed: ${error instanceof Error ? error.message : String(error)}`,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - started,
      };
    }
  }

  async checkPermissions(): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(): boolean {
    return false;
  }
}

export const RuntimeSessionsCancelInputSchema = z.object({
  session_id: z.string().min(1, "session_id is required"),
  reason: z.string().trim().min(1, "reason is required"),
});
export type RuntimeSessionsCancelInput = z.infer<typeof RuntimeSessionsCancelInputSchema>;

export class RuntimeSessionsCancelTool implements ITool<RuntimeSessionsCancelInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "sessions_cancel",
    aliases: ["cancel_session", "runtime_session_cancel"],
    permissionLevel: WRITE_PERMISSION,
    isReadOnly: false,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: 8000,
    tags: [...TAGS],
  };
  readonly inputSchema = RuntimeSessionsCancelInputSchema;

  constructor(private readonly service: RuntimeSessionToolService) {}

  description(): string {
    return "Cancel a PulSeed conversation session by marking it failed and notifying its parent if configured.";
  }

  async call(input: RuntimeSessionsCancelInput, _context: ToolCallContext): Promise<ToolResult> {
    const started = Date.now();
    try {
      const data = await this.service.cancelSession(input.session_id, input.reason);
      return {
        success: true,
        data,
        summary: `Canceled session ${data.sessionId}`,
        durationMs: Date.now() - started,
      };
    } catch (error) {
      return {
        success: false,
        data: null,
        summary: `sessions_cancel failed: ${error instanceof Error ? error.message : String(error)}`,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - started,
      };
    }
  }

  async checkPermissions(): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(): boolean {
    return false;
  }
}

export const RuntimeSessionsRetryInputSchema = z.object({
  session_id: z.string().min(1, "session_id is required"),
  message: z.string().trim().min(1).optional(),
});
export type RuntimeSessionsRetryInput = z.infer<typeof RuntimeSessionsRetryInputSchema>;

export class RuntimeSessionsRetryTool implements ITool<RuntimeSessionsRetryInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "sessions_retry",
    aliases: ["retry_session", "runtime_session_retry"],
    permissionLevel: WRITE_PERMISSION,
    isReadOnly: false,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: 8000,
    tags: [...TAGS],
  };
  readonly inputSchema = RuntimeSessionsRetryInputSchema;

  constructor(private readonly service: RuntimeSessionToolService) {}

  description(): string {
    return "Re-queue a PulSeed conversation session for another attempt, preserving retry metadata.";
  }

  async call(input: RuntimeSessionsRetryInput, _context: ToolCallContext): Promise<ToolResult> {
    const started = Date.now();
    try {
      const data = await this.service.retrySession(input.session_id, input.message);
      return {
        success: true,
        data,
        summary: `Retried session ${data.sessionId}`,
        durationMs: Date.now() - started,
      };
    } catch (error) {
      return {
        success: false,
        data: null,
        summary: `sessions_retry failed: ${error instanceof Error ? error.message : String(error)}`,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - started,
      };
    }
  }

  async checkPermissions(): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(): boolean {
    return false;
  }
}

export function createRuntimeSessionTools(stateManager: StateManager): ITool[] {
  const service = new RuntimeSessionToolService(stateManager);
  return [
    new RuntimeSessionsListTool(service),
    new RuntimeRunsObserveTool(service),
    new RuntimeSessionsHistoryTool(service),
    new RuntimeSessionsReadTool(service),
    new RuntimeSessionsChildrenTool(service),
    new RuntimeSessionsSpawnTool(service),
    new RuntimeSessionsSendTool(service),
    new RuntimeSessionsUpdateTool(service),
    new RuntimeSessionsClaimTool(service),
    new RuntimeSessionsCancelTool(service),
    new RuntimeSessionsRetryTool(service),
    new RuntimeDreamReviewTool(stateManager),
  ];
}
