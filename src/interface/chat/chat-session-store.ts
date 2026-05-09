import { StateError } from "../../base/utils/errors.js";
import type { StateManager } from "../../base/state/state-manager.js";
import { ChatSessionSchema, type ChatSession } from "./chat-history.js";
import type { AgentLoopSessionState } from "../../orchestrator/execution/agent-loop/agent-loop-session-state.js";
import { AgentLoopSessionStateCatalog } from "../../orchestrator/execution/agent-loop/agent-loop-session-db-store.js";
import { normalizeSessionUsage } from "./chat-usage.js";
import { ChatSessionDataStore } from "./chat-session-data-store.js";
import { resolveChatStateBaseDir } from "./chat-state-base-dir.js";

const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type ChatSessionAgentLoopStatus = "missing" | "running" | "completed" | "failed";

export interface ChatSessionCatalogEntry {
  id: string;
  cwd: string;
  title: string | null;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  parentSessionId: string | null;
  sessionStatus?: "idle" | "queued" | "running" | "waiting" | "completed" | "failed" | null;
  sessionSummary?: string | null;
  completedAt?: string | null;
  goalId?: string | null;
  strategyId?: string | null;
  notificationPolicy?: "silent" | "important_only" | "periodic" | "all_terminal" | null;
  ownerId?: string | null;
  waitingUntil?: string | null;
  waitingCondition?: string | null;
  notificationReplyTarget?: ChatSession["notificationReplyTarget"];
  agentLoopSessionId?: string | null;
  agentLoopTraceId?: string | null;
  agentLoopStatePath: string | null;
  agentLoopStatus: ChatSessionAgentLoopStatus;
  agentLoopResumable: boolean;
  agentLoopUpdatedAt?: string | null;
}

export interface LoadedChatSession {
  id: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  title: string | null;
  messages: ChatSession["messages"];
  compactionSummary?: string;
  compactionRecords?: ChatSession["compactionRecords"];
  parentSessionId?: string | null;
  spawnedBySessionId?: string | null;
  spawnedByRuntimeSessionId?: string | null;
  spawnedAt?: string | null;
  sessionStatus?: "idle" | "queued" | "running" | "waiting" | "completed" | "failed" | null;
  sessionSummary?: string | null;
  completedAt?: string | null;
  goalId?: string | null;
  strategyId?: string | null;
  notificationPolicy?: "silent" | "important_only" | "periodic" | "all_terminal" | null;
  ownerId?: string | null;
  ownerClaimedAt?: string | null;
  waitingUntil?: string | null;
  waitingCondition?: string | null;
  retryCount?: number | null;
  lastRetryAt?: string | null;
  lastResumedAt?: string | null;
  notificationReplyTarget?: ChatSession["notificationReplyTarget"];
  setupDialogue?: ChatSession["setupDialogue"];
  runSpecConfirmation?: ChatSession["runSpecConfirmation"];
  parentNotificationStatus?: "none" | "pending" | "sent" | "failed" | null;
  parentNotificationSummary?: string | null;
  parentNotifiedAt?: string | null;
  agentLoopSessionId?: string | null;
  agentLoopTraceId?: string | null;
  agentLoopStatePath: string | null;
  agentLoopStatus: ChatSessionAgentLoopStatus;
  agentLoopResumable: boolean;
  agentLoopUpdatedAt?: string | null;
  agentLoop?: ChatSession["agentLoop"];
  turnContexts?: ChatSession["turnContexts"];
  rolloutJournal?: ChatSession["rolloutJournal"];
  usage?: ChatSession["usage"];
  [key: string]: unknown;
}

export interface ChatSessionCleanupOptions {
  dryRun?: boolean;
  activeSessionId?: string;
  olderThanMs?: number;
  now?: number;
}

export interface ChatSessionListOptions {
  cwd?: string;
}

export interface ChatSessionCleanupReport {
  dryRun: boolean;
  olderThanMs: number;
  activeSessionId: string | null;
  totalSessions: number;
  retainedSessionIds: string[];
  removedSessionIds: string[];
  removedAgentLoopStatePaths: string[];
}

export class ChatSessionSelectorError extends StateError {
  constructor(
    message: string,
    public readonly selector: string,
    public readonly kind: "not_found" | "ambiguous",
    public readonly matches: string[] = [],
  ) {
    super(message);
    this.name = "ChatSessionSelectorError";
  }
}

interface SessionRecord {
  session: LoadedChatSession;
  activityAtMs: number;
}

interface AgentLoopDiscovery {
  sessionId: string | null;
  traceId: string | null;
  statePath: string | null;
  status: ChatSessionAgentLoopStatus;
  resumable: boolean;
  updatedAt: string | null;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeTitle(value: unknown): string | null {
  return optionalString(value);
}

function parseTime(value: string | null | undefined): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function extractSessionActivityAtMs(session: {
  createdAt: string;
  updatedAt?: string | null;
  agentLoopUpdatedAt?: string | null;
  completedAt?: string | null;
}): number {
  const metadataActivity = Math.max(
    parseTime(session.agentLoopUpdatedAt),
    parseTime(session.completedAt),
    parseTime(session.updatedAt),
    parseTime(session.createdAt),
  );
  return metadataActivity === Number.NEGATIVE_INFINITY ? 0 : metadataActivity;
}

function normalizeAgentLoopStatus(
  session: ChatSession,
  agentLoopState: AgentLoopSessionState | null,
): AgentLoopDiscovery {
  const statePath = session.agentLoopStatePath ?? session.agentLoop?.statePath ?? null;
  const topLevelStatePath = optionalString(session.agentLoopStatePath);
  const nestedStatePath = optionalString(session.agentLoop?.statePath);
  const allowNestedMetadata = !topLevelStatePath || topLevelStatePath === nestedStatePath;
  const metadataStatus = session.agentLoopStatus ?? (allowNestedMetadata ? session.agentLoop?.status ?? null : null);
  const resumableMetadata = session.agentLoopResumable ?? (allowNestedMetadata ? session.agentLoop?.resumable ?? null : null);
  const metadataUpdatedAt = session.agentLoopUpdatedAt ?? (allowNestedMetadata ? session.agentLoop?.updatedAt ?? null : null);

  if (agentLoopState) {
    const status = agentLoopState.status;
    return {
      sessionId: agentLoopState.sessionId,
      traceId: agentLoopState.traceId,
      statePath,
      status,
      resumable: status !== "completed",
      updatedAt: agentLoopState.updatedAt,
    };
  }

  if (metadataStatus) {
    return {
      sessionId: optionalString(session.agentLoopSessionId),
      traceId: optionalString(session.agentLoopTraceId),
      statePath,
      status: metadataStatus,
      resumable: resumableMetadata ?? metadataStatus !== "completed",
      updatedAt: metadataUpdatedAt,
    };
  }

  return {
    sessionId: optionalString(session.agentLoopSessionId),
    traceId: optionalString(session.agentLoopTraceId),
    statePath,
    status: "missing",
    resumable: resumableMetadata ?? false,
    updatedAt: metadataUpdatedAt,
  };
}

function buildNormalizedAgentLoopMetadata(agentLoop: AgentLoopDiscovery): ChatSession["agentLoop"] | undefined {
  if (!agentLoop.statePath && agentLoop.status === "missing" && !agentLoop.resumable && !agentLoop.updatedAt) {
    return undefined;
  }
  return {
    ...(agentLoop.statePath ? { statePath: agentLoop.statePath } : {}),
    ...(agentLoop.status !== "missing" ? { status: agentLoop.status } : {}),
    ...(agentLoop.resumable ? { resumable: true } : {}),
    ...(agentLoop.updatedAt ? { updatedAt: agentLoop.updatedAt } : {}),
  };
}

async function loadAgentLoopState(baseDir: string, session: ChatSession): Promise<AgentLoopDiscovery> {
  const candidateSessionId = optionalString(session.agentLoopSessionId) ?? session.id;
  const state = await new AgentLoopSessionStateCatalog(baseDir).load(candidateSessionId);
  const discovery = normalizeAgentLoopStatus(session, state);
  return {
    sessionId: state?.sessionId ?? discovery.sessionId,
    traceId: state?.traceId ?? discovery.traceId,
    statePath: discovery.statePath,
    status: discovery.status,
    resumable: state ? state.status !== "completed" : discovery.resumable,
    updatedAt: state?.updatedAt ?? discovery.updatedAt,
  };
}

function toLoadedSession(session: ChatSession, discovery: AgentLoopDiscovery): LoadedChatSession {
  const normalizedAgentLoop = buildNormalizedAgentLoopMetadata(discovery);
  return {
    id: session.id,
    cwd: session.cwd,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt ?? session.createdAt,
    title: normalizeTitle(session.title),
    messages: [...session.messages],
    parentSessionId: optionalString(session.parentSessionId),
    ...(optionalString(session.spawnedBySessionId) ? { spawnedBySessionId: optionalString(session.spawnedBySessionId) } : {}),
    ...(optionalString(session.spawnedByRuntimeSessionId) ? { spawnedByRuntimeSessionId: optionalString(session.spawnedByRuntimeSessionId) } : {}),
    ...(optionalString(session.spawnedAt) ? { spawnedAt: optionalString(session.spawnedAt) } : {}),
    ...(session.sessionStatus ? { sessionStatus: session.sessionStatus } : {}),
    ...(optionalString(session.sessionSummary) !== null ? { sessionSummary: optionalString(session.sessionSummary) } : {}),
    ...(optionalString(session.completedAt) !== null ? { completedAt: optionalString(session.completedAt) } : {}),
    ...(optionalString(session.goalId) !== null ? { goalId: optionalString(session.goalId) } : {}),
    ...(optionalString(session.strategyId) !== null ? { strategyId: optionalString(session.strategyId) } : {}),
    ...(session.notificationPolicy ? { notificationPolicy: session.notificationPolicy } : {}),
    ...(optionalString(session.ownerId) !== null ? { ownerId: optionalString(session.ownerId) } : {}),
    ...(optionalString(session.ownerClaimedAt) !== null ? { ownerClaimedAt: optionalString(session.ownerClaimedAt) } : {}),
    ...(optionalString(session.waitingUntil) !== null ? { waitingUntil: optionalString(session.waitingUntil) } : {}),
    ...(optionalString(session.waitingCondition) !== null ? { waitingCondition: optionalString(session.waitingCondition) } : {}),
    ...(typeof session.retryCount === "number" ? { retryCount: session.retryCount } : {}),
    ...(optionalString(session.lastRetryAt) !== null ? { lastRetryAt: optionalString(session.lastRetryAt) } : {}),
    ...(optionalString(session.lastResumedAt) !== null ? { lastResumedAt: optionalString(session.lastResumedAt) } : {}),
    ...(session.notificationReplyTarget ? { notificationReplyTarget: session.notificationReplyTarget } : {}),
    ...(session.setupDialogue ? { setupDialogue: session.setupDialogue } : {}),
    ...(session.runSpecConfirmation ? { runSpecConfirmation: session.runSpecConfirmation } : {}),
    ...(session.parentNotificationStatus ? { parentNotificationStatus: session.parentNotificationStatus } : {}),
    ...(optionalString(session.parentNotificationSummary) !== null ? { parentNotificationSummary: optionalString(session.parentNotificationSummary) } : {}),
    ...(optionalString(session.parentNotifiedAt) !== null ? { parentNotifiedAt: optionalString(session.parentNotifiedAt) } : {}),
    ...(session.compactionSummary ? { compactionSummary: session.compactionSummary } : {}),
    ...(session.compactionRecords ? { compactionRecords: [...session.compactionRecords] } : {}),
    agentLoopSessionId: discovery.sessionId,
    agentLoopTraceId: discovery.traceId,
    agentLoopStatePath: discovery.statePath,
    agentLoopStatus: discovery.status,
    agentLoopResumable: discovery.resumable,
    agentLoopUpdatedAt: discovery.updatedAt,
    ...(normalizedAgentLoop ? { agentLoop: normalizedAgentLoop } : {}),
    ...(session.turnContexts ? { turnContexts: [...session.turnContexts] } : {}),
    ...(session.rolloutJournal ? { rolloutJournal: [...session.rolloutJournal] } : {}),
    ...(session.usage ? { usage: normalizeSessionUsage(session.usage) } : {}),
  };
}

function normalizeSessionRecord(session: ChatSession, agentLoop: AgentLoopDiscovery): SessionRecord {
  const loaded = toLoadedSession(session, agentLoop);
  return {
    session: loaded,
    activityAtMs: extractSessionActivityAtMs(loaded),
  };
}

function buildCatalogEntry(record: SessionRecord): ChatSessionCatalogEntry {
  const { session } = record;
  return {
    id: session.id,
    cwd: session.cwd,
    title: session.title,
    messageCount: session.messages.length,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    parentSessionId: session.parentSessionId ?? null,
    sessionStatus: session.sessionStatus ?? null,
    sessionSummary: session.sessionSummary ?? null,
    completedAt: session.completedAt ?? null,
    goalId: session.goalId ?? null,
    strategyId: session.strategyId ?? null,
    notificationPolicy: session.notificationPolicy ?? null,
    ownerId: session.ownerId ?? null,
    waitingUntil: session.waitingUntil ?? null,
    waitingCondition: session.waitingCondition ?? null,
    notificationReplyTarget: session.notificationReplyTarget ?? null,
    agentLoopSessionId: session.agentLoopSessionId,
    agentLoopTraceId: session.agentLoopTraceId,
    agentLoopStatePath: session.agentLoopStatePath,
    agentLoopStatus: session.agentLoopStatus,
    agentLoopResumable: session.agentLoopResumable,
    agentLoopUpdatedAt: session.agentLoopUpdatedAt ?? null,
  };
}

function toPersistedSession(session: LoadedChatSession): ChatSession {
  return ChatSessionSchema.parse({
    id: session.id,
    cwd: session.cwd,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messages: [...session.messages],
    ...(session.parentSessionId !== null ? { parentSessionId: session.parentSessionId } : {}),
    ...(session.spawnedBySessionId !== null && session.spawnedBySessionId !== undefined ? { spawnedBySessionId: session.spawnedBySessionId } : {}),
    ...(session.spawnedByRuntimeSessionId !== null && session.spawnedByRuntimeSessionId !== undefined ? { spawnedByRuntimeSessionId: session.spawnedByRuntimeSessionId } : {}),
    ...(session.spawnedAt !== null && session.spawnedAt !== undefined ? { spawnedAt: session.spawnedAt } : {}),
    ...(session.sessionStatus !== null && session.sessionStatus !== undefined ? { sessionStatus: session.sessionStatus } : {}),
    ...(session.sessionSummary !== null && session.sessionSummary !== undefined ? { sessionSummary: session.sessionSummary } : {}),
    ...(session.completedAt !== null && session.completedAt !== undefined ? { completedAt: session.completedAt } : {}),
    ...(session.goalId !== null && session.goalId !== undefined ? { goalId: session.goalId } : {}),
    ...(session.strategyId !== null && session.strategyId !== undefined ? { strategyId: session.strategyId } : {}),
    ...(session.notificationPolicy !== null && session.notificationPolicy !== undefined ? { notificationPolicy: session.notificationPolicy } : {}),
    ...(session.ownerId !== null && session.ownerId !== undefined ? { ownerId: session.ownerId } : {}),
    ...(session.ownerClaimedAt !== null && session.ownerClaimedAt !== undefined ? { ownerClaimedAt: session.ownerClaimedAt } : {}),
    ...(session.waitingUntil !== null && session.waitingUntil !== undefined ? { waitingUntil: session.waitingUntil } : {}),
    ...(session.waitingCondition !== null && session.waitingCondition !== undefined ? { waitingCondition: session.waitingCondition } : {}),
    ...(session.retryCount !== null && session.retryCount !== undefined ? { retryCount: session.retryCount } : {}),
    ...(session.lastRetryAt !== null && session.lastRetryAt !== undefined ? { lastRetryAt: session.lastRetryAt } : {}),
    ...(session.lastResumedAt !== null && session.lastResumedAt !== undefined ? { lastResumedAt: session.lastResumedAt } : {}),
    ...(session.notificationReplyTarget !== null && session.notificationReplyTarget !== undefined ? { notificationReplyTarget: session.notificationReplyTarget } : {}),
    ...(session.setupDialogue !== null && session.setupDialogue !== undefined ? { setupDialogue: session.setupDialogue } : {}),
    ...(session.runSpecConfirmation !== null && session.runSpecConfirmation !== undefined ? { runSpecConfirmation: session.runSpecConfirmation } : {}),
    ...(session.parentNotificationStatus !== null && session.parentNotificationStatus !== undefined ? { parentNotificationStatus: session.parentNotificationStatus } : {}),
    ...(session.parentNotificationSummary !== null && session.parentNotificationSummary !== undefined ? { parentNotificationSummary: session.parentNotificationSummary } : {}),
    ...(session.parentNotifiedAt !== null && session.parentNotifiedAt !== undefined ? { parentNotifiedAt: session.parentNotifiedAt } : {}),
    ...(session.compactionSummary ? { compactionSummary: session.compactionSummary } : {}),
    ...(session.compactionRecords ? { compactionRecords: [...session.compactionRecords] } : {}),
    ...(session.title !== null ? { title: session.title } : {}),
    ...(session.agentLoopSessionId !== null ? { agentLoopSessionId: session.agentLoopSessionId } : {}),
    ...(session.agentLoopTraceId !== null ? { agentLoopTraceId: session.agentLoopTraceId } : {}),
    ...(session.agentLoopStatePath !== null ? { agentLoopStatePath: session.agentLoopStatePath } : {}),
    ...(session.agentLoopStatus === "running" || session.agentLoopStatus === "completed" || session.agentLoopStatus === "failed"
      ? { agentLoopStatus: session.agentLoopStatus }
      : {}),
    ...(session.agentLoopResumable ? { agentLoopResumable: true } : {}),
    ...(session.agentLoopUpdatedAt !== null && session.agentLoopUpdatedAt !== undefined ? { agentLoopUpdatedAt: session.agentLoopUpdatedAt } : {}),
    ...(session.agentLoop ? { agentLoop: session.agentLoop } : {}),
    ...(session.turnContexts ? { turnContexts: [...session.turnContexts] } : {}),
    ...(session.rolloutJournal ? { rolloutJournal: [...session.rolloutJournal] } : {}),
    ...(session.usage ? { usage: normalizeSessionUsage(session.usage) } : {}),
  });
}

export class ChatSessionCatalog {
  private readonly store: ChatSessionDataStore;
  private readonly resolvedBaseDir: string;

  constructor(private readonly stateManager: StateManager) {
    this.resolvedBaseDir = resolveChatStateBaseDir(stateManager);
    this.store = new ChatSessionDataStore(this.resolvedBaseDir);
  }

  private get baseDir(): string {
    return this.resolvedBaseDir;
  }

  private async readSessionRecord(sessionId: string): Promise<LoadedChatSession | null> {
    const session = await this.store.load(sessionId);
    if (!session) return null;
    const discovery = await loadAgentLoopState(this.baseDir, session);
    return normalizeSessionRecord(session, discovery).session;
  }

  private async listSessionRecords(options: ChatSessionListOptions = {}): Promise<SessionRecord[]> {
    const sessions = await this.store.list(options);
    const records: SessionRecord[] = [];
    for (const session of sessions) {
      const discovery = await loadAgentLoopState(this.baseDir, session);
      records.push(normalizeSessionRecord(session, discovery));
    }
    records.sort((left, right) => {
      if (right.activityAtMs !== left.activityAtMs) return right.activityAtMs - left.activityAtMs;
      return left.session.id.localeCompare(right.session.id);
    });
    return records;
  }

  async loadSession(sessionId: string): Promise<LoadedChatSession | null> {
    return this.readSessionRecord(sessionId);
  }

  async listSessions(options: ChatSessionListOptions = {}): Promise<ChatSessionCatalogEntry[]> {
    return (await this.listSessionRecords(options)).map(buildCatalogEntry);
  }

  async latestSession(options: ChatSessionListOptions = {}): Promise<ChatSessionCatalogEntry | null> {
    const sessions = await this.listSessions(options);
    return sessions[0] ?? null;
  }

  async resolveSelector(selector: string): Promise<ChatSessionCatalogEntry> {
    const normalizedSelector = selector.trim();
    if (!normalizedSelector) {
      throw new ChatSessionSelectorError("Chat session selector cannot be empty.", selector, "not_found");
    }

    const sessions = await this.listSessions();
    const exactId = sessions.find((session) => session.id === normalizedSelector);
    if (exactId) return exactId;

    const prefixMatches = sessions.filter((session) => session.id.startsWith(normalizedSelector));
    if (prefixMatches.length === 1) return prefixMatches[0];
    if (prefixMatches.length > 1) {
      throw new ChatSessionSelectorError(
        `Ambiguous chat session id prefix "${normalizedSelector}" matches ${prefixMatches.length} sessions.`,
        selector,
        "ambiguous",
        prefixMatches.map((session) => session.id),
      );
    }

    throw new ChatSessionSelectorError(
      `No chat session matched selector "${normalizedSelector}".`,
      selector,
      "not_found",
    );
  }

  async loadSessionBySelector(selector: string): Promise<LoadedChatSession | null> {
    const resolved = await this.resolveSelector(selector);
    return this.loadSession(resolved.id);
  }

  async renameSession(selector: string, title: string | null): Promise<LoadedChatSession> {
    const resolved = await this.resolveSelector(selector);
    const session = await this.loadSession(resolved.id);
    if (!session) {
      throw new ChatSessionSelectorError(
        `Chat session "${resolved.id}" disappeared before it could be renamed.`,
        selector,
        "not_found",
      );
    }

    const normalizedTitle = normalizeTitle(title);
    const updatedAt = new Date().toISOString();
    const persisted = toPersistedSession(session);
    const { title: _existingTitle, ...withoutTitle } = persisted;
    const updated: ChatSession = {
      ...(normalizedTitle !== null ? persisted : withoutTitle),
      ...(normalizedTitle !== null ? { title: normalizedTitle } : {}),
      updatedAt,
    };
    await this.store.save(updated);
    const discovery = await loadAgentLoopState(this.baseDir, updated);
    return normalizeSessionRecord(updated, discovery).session;
  }

  async cleanupSessions(options: ChatSessionCleanupOptions = {}): Promise<ChatSessionCleanupReport> {
    const dryRun = options.dryRun ?? true;
    const activeSessionId = options.activeSessionId?.trim() || null;
    const olderThanMs = options.olderThanMs ?? DEFAULT_SESSION_TTL_MS;
    const now = options.now ?? Date.now();
    const threshold = now - olderThanMs;
    const sessions = await this.listSessionRecords();
    const retainedSessionIds: string[] = [];
    const removedSessionIds: string[] = [];
    const removedAgentLoopStatePaths: string[] = [];

    for (const record of sessions) {
      const protectedSession = activeSessionId !== null && record.session.id === activeSessionId;
      const isOld = record.activityAtMs < threshold;
      if (!protectedSession && isOld) {
        removedSessionIds.push(record.session.id);
        if (record.session.agentLoopStatePath) removedAgentLoopStatePaths.push(record.session.agentLoopStatePath);
        continue;
      }
      retainedSessionIds.push(record.session.id);
    }

    if (!dryRun) {
      await this.store.deleteSessions(removedSessionIds);
    }

    return {
      dryRun,
      olderThanMs,
      activeSessionId,
      totalSessions: sessions.length,
      retainedSessionIds,
      removedSessionIds,
      removedAgentLoopStatePaths: [...new Set(removedAgentLoopStatePaths)],
    };
  }
}
