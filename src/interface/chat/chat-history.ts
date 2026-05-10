// ─── ChatHistory ───
//
// Manages conversation history for a chat session.
// Persists via the typed chat session store (persist-before-execute principle).

import type { StateManager } from "../../base/state/state-manager.js";
import type { RuntimeReplyTarget } from "../../runtime/session-registry/types.js";
import { redactSetupSecrets, redactSetupSecretsDeep, type SetupSecretIntakeItem } from "./setup-secret-intake.js";
import type { SetupDialoguePublicState } from "./setup-dialogue.js";
import type { ChatEvent, ChatEventContext } from "./chat-events.js";
import type { UserInput } from "./user-input.js";
import { normalizeSessionUsage, normalizeUsageCounter, sumUsageCounters } from "./chat-usage.js";
import {
  type ChatSessionUsage,
  type ChatUsageCounter,
} from "./chat-usage-contracts.js";
import { resolveChatStateBaseDir } from "./chat-state-base-dir.js";
import {
  CHAT_COMPACTION_RECORD_SCHEMA_VERSION,
  ChatCompactionRecordSchema,
  ChatRolloutJournalRecordSchema,
  type ChatCompactionRecord,
  type ChatMessage,
  type ChatRolloutJournalRecord,
  type ChatRolloutJournalRecordKind,
  type ChatSession,
  type RunSpecConfirmationState,
} from "./chat-session-contracts.js";
export {
  CHAT_COMPACTION_RECORD_SCHEMA_VERSION,
  ChatCompactionRecordSchema,
  ChatMessageSchema,
  ChatRolloutJournalRecordKindSchema,
  ChatRolloutJournalRecordSchema,
  ChatSessionAgentLoopMetadataSchema,
  ChatSessionSchema,
  ChatTurnContextSnapshotSchema,
  RunSpecConfirmationStateSchema,
} from "./chat-session-contracts.js";
export type {
  ChatCompactionRecord,
  ChatMessage,
  ChatRolloutJournalRecord,
  ChatRolloutJournalRecordKind,
  ChatSession,
  ChatSessionAgentLoopMetadata,
  ChatTurnContextSnapshot,
  RunSpecConfirmationState,
} from "./chat-session-contracts.js";
export {
  ChatSessionUsageSchema,
  ChatUsageCounterSchema,
} from "./chat-usage-contracts.js";
export type {
  ChatSessionUsage,
  ChatUsageCounter,
} from "./chat-usage-contracts.js";

// ─── ChatHistory ───

export class ChatHistory {
  private readonly stateManager: StateManager;
  private readonly sessionId: string;
  private readonly session: ChatSession;

  constructor(stateManager: StateManager, sessionId: string, cwd: string, existingSession?: ChatSession) {
    this.stateManager = stateManager;
    this.sessionId = sessionId;
    if (existingSession) {
      this.session = {
        ...existingSession,
        id: existingSession.id,
        cwd: existingSession.cwd,
        updatedAt: existingSession.updatedAt ?? existingSession.createdAt,
        messages: [...existingSession.messages],
        ...(existingSession.compactionRecords ? { compactionRecords: cloneCompactionRecords(existingSession.compactionRecords) } : {}),
        ...(existingSession.turnContexts ? { turnContexts: [...existingSession.turnContexts] } : {}),
        ...(existingSession.rolloutJournal ? { rolloutJournal: [...existingSession.rolloutJournal] } : {}),
        ...(existingSession.usage ? { usage: cloneUsage(existingSession.usage) } : {}),
      };
    } else {
      const createdAt = new Date().toISOString();
      this.session = {
        id: sessionId,
        cwd,
        createdAt,
        updatedAt: createdAt,
        messages: [],
      };
    }
  }

  static fromSession(stateManager: StateManager, session: ChatSession): ChatHistory {
    return new ChatHistory(stateManager, session.id, session.cwd, session);
  }

  /** Append a user message and persist to disk BEFORE adapter execution. */
  async appendUserMessage(content: string, options: {
    setupSecretIntake?: Array<Omit<SetupSecretIntakeItem, "value">>;
    eventContext?: ChatEventContext;
    userInput?: UserInput;
  } = {}): Promise<void> {
    const turnIndex = this.session.messages.length;
    this.session.messages.push({
      role: "user",
      content,
      timestamp: new Date().toISOString(),
      turnIndex,
      ...(options.setupSecretIntake && options.setupSecretIntake.length > 0
        ? { setupSecretIntake: options.setupSecretIntake }
        : {}),
    });
    this.pushRolloutRecord({
      kind: "user_input",
      source: "chat_history",
      visibility: "model_visible",
      eventContext: options.eventContext,
      payload: {
        role: "user",
        content,
        turnIndex,
        ...(options.userInput ? { userInput: toReplayableUserInput(options.userInput) } : {}),
        ...(options.setupSecretIntake && options.setupSecretIntake.length > 0
          ? { setupSecretIntake: options.setupSecretIntake }
          : {}),
      },
    });
    await this.persist();
  }

  /** Append an assistant message and persist it as the committed assistant turn. */
  async appendAssistantMessage(content: string, options: { eventContext?: ChatEventContext } = {}): Promise<void> {
    const safeContent = redactSetupSecrets(content);
    const turnIndex = this.session.messages.length;
    this.session.messages.push({
      role: "assistant",
      content: safeContent,
      timestamp: new Date().toISOString(),
      turnIndex,
    });
    this.pushRolloutRecord({
      kind: "model_output",
      source: "chat_history",
      visibility: "model_visible",
      eventContext: options.eventContext,
      payload: {
        role: "assistant",
        content: safeContent,
        turnIndex,
      },
    });
    await this.persist();
  }

  /** Clear all messages and persist the empty state. */
  async clear(): Promise<void> {
    this.session.messages = [];
    delete this.session.compactionSummary;
    delete this.session.compactionRecords;
    this.replaceModelVisibleJournalFromMessages("clear");
    await this.persist();
  }

  /** Persist a compacted summary and keep only the latest turns in message history. */
  async compact(summary: string, keepMessageCount = 4): Promise<{ before: number; after: number }> {
    const before = this.session.messages.length;
    const keepCount = Math.max(0, keepMessageCount);
    const originalMessages = [...this.session.messages];
    const kept = keepCount === 0 ? [] : this.session.messages.slice(-keepCount);
    const removed = keepCount === 0 ? originalMessages : originalMessages.slice(0, -keepCount);
    const record = this.buildCompactionRecord(summary, originalMessages, removed, kept);
    this.session.messages = kept.map((message, index) => ({
      ...message,
      turnIndex: index,
    }));
    this.session.compactionSummary = summary;
    this.session.compactionRecords = [
      ...(this.session.compactionRecords ?? []),
      record,
    ].slice(-50);
    this.replaceModelVisibleJournalFromMessages("compact");
    await this.persist();
    return { before, after: this.session.messages.length };
  }

  async removeLastTurn(): Promise<number> {
    if (this.session.messages.length === 0) return 0;

    let removed = 0;
    while (this.session.messages.length > 0) {
      const message = this.session.messages.pop();
      if (!message) break;
      removed += 1;
      if (message.role === "user") break;
    }

    this.session.messages = this.session.messages.map((message, index) => ({
      ...message,
      turnIndex: index,
    }));
    this.replaceModelVisibleJournalFromMessages("remove_last_turn");
    await this.persist();
    return removed;
  }

  getMessages(): ChatMessage[] {
    return [...this.session.messages];
  }

  getModelVisibleMessages(): ChatMessage[] {
    return reconstructModelVisibleMessagesFromRolloutJournal(this.session.rolloutJournal) ?? this.getMessages();
  }

  getSessionData(): ChatSession {
    return {
      ...this.session,
      messages: [...this.session.messages],
      ...(this.session.compactionRecords ? { compactionRecords: cloneCompactionRecords(this.session.compactionRecords) } : {}),
      ...(this.session.turnContexts ? { turnContexts: [...this.session.turnContexts] } : {}),
      ...(this.session.rolloutJournal ? { rolloutJournal: [...this.session.rolloutJournal] } : {}),
      ...(this.session.usage ? { usage: cloneUsage(this.session.usage) } : {}),
    };
  }

  getSessionId(): string {
    return this.sessionId;
  }

  setTitle(title: string | null): void {
    if (title && title.trim().length > 0) {
      this.session.title = title.trim();
    } else {
      delete this.session.title;
    }
  }

  setAgentLoopStatePath(statePath: string | null): void {
    if (statePath) {
      this.session.agentLoopStatePath = statePath;
    } else {
      delete this.session.agentLoopStatePath;
    }
  }

  setAgentLoopSessionIdentity(input: { sessionId: string | null; traceId?: string | null }): void {
    if (input.sessionId) {
      this.session.agentLoopSessionId = input.sessionId;
    } else {
      delete this.session.agentLoopSessionId;
    }
    if (input.traceId) {
      this.session.agentLoopTraceId = input.traceId;
    } else if (input.traceId === null) {
      delete this.session.agentLoopTraceId;
    }
  }

  setNotificationReplyTarget(target: RuntimeReplyTarget | null): void {
    if (target) {
      this.session.notificationReplyTarget = target;
    } else {
      delete this.session.notificationReplyTarget;
    }
  }

  getSetupDialogue(): SetupDialoguePublicState | null {
    return this.session.setupDialogue ?? null;
  }

  setSetupDialogue(dialogue: SetupDialoguePublicState | null): void {
    if (dialogue) {
      this.session.setupDialogue = dialogue;
    } else {
      delete this.session.setupDialogue;
    }
  }

  getRunSpecConfirmation(): RunSpecConfirmationState | null {
    return this.session.runSpecConfirmation ?? null;
  }

  setRunSpecConfirmation(confirmation: RunSpecConfirmationState | null): void {
    if (confirmation) {
      this.session.runSpecConfirmation = confirmation;
    } else {
      delete this.session.runSpecConfirmation;
    }
  }

  async recordTurnContext(snapshot: { schema_version: string; modelVisible: unknown }): Promise<void> {
    this.session.turnContexts = [
      ...(this.session.turnContexts ?? []),
      snapshot,
    ].slice(-20);
    this.pushRolloutRecord({
      kind: "turn_context",
      source: "chat_history",
      visibility: "model_visible",
      eventContext: extractTurnContextEventContext(snapshot),
      payload: snapshot,
    });
    await this.persist();
  }

  async recordChatEvent(event: ChatEvent, options: { persist?: boolean } = {}): Promise<void> {
    assertChatEventInvariants(event);
    const projection = rolloutProjectionFromChatEvent(event);
    this.pushRolloutRecord({
      kind: projection.kind,
      source: projection.source,
      visibility: projection.visibility,
      eventContext: event,
      createdAt: event.createdAt,
      payload: projection.payload,
    });
    if (options.persist !== false) {
      await this.persist();
    }
  }

  setSessionLifecycle(input: {
    status?: "idle" | "queued" | "running" | "waiting" | "completed" | "failed" | null;
    summary?: string | null;
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
    parentNotificationStatus?: "none" | "pending" | "sent" | "failed" | null;
    parentNotificationSummary?: string | null;
    parentNotifiedAt?: string | null;
  }): void {
    if (input.status !== undefined) {
      if (input.status) this.session.sessionStatus = input.status;
      else delete this.session.sessionStatus;
    }
    if (input.summary !== undefined) {
      if (input.summary !== null) this.session.sessionSummary = input.summary;
      else delete this.session.sessionSummary;
    }
    if (input.completedAt !== undefined) {
      if (input.completedAt !== null) this.session.completedAt = input.completedAt;
      else delete this.session.completedAt;
    }
    if (input.goalId !== undefined) {
      if (input.goalId !== null) this.session.goalId = input.goalId;
      else delete this.session.goalId;
    }
    if (input.strategyId !== undefined) {
      if (input.strategyId !== null) this.session.strategyId = input.strategyId;
      else delete this.session.strategyId;
    }
    if (input.notificationPolicy !== undefined) {
      if (input.notificationPolicy !== null) this.session.notificationPolicy = input.notificationPolicy;
      else delete this.session.notificationPolicy;
    }
    if (input.ownerId !== undefined) {
      if (input.ownerId !== null) this.session.ownerId = input.ownerId;
      else delete this.session.ownerId;
    }
    if (input.ownerClaimedAt !== undefined) {
      if (input.ownerClaimedAt !== null) this.session.ownerClaimedAt = input.ownerClaimedAt;
      else delete this.session.ownerClaimedAt;
    }
    if (input.waitingUntil !== undefined) {
      if (input.waitingUntil !== null) this.session.waitingUntil = input.waitingUntil;
      else delete this.session.waitingUntil;
    }
    if (input.waitingCondition !== undefined) {
      if (input.waitingCondition !== null) this.session.waitingCondition = input.waitingCondition;
      else delete this.session.waitingCondition;
    }
    if (input.retryCount !== undefined) {
      if (input.retryCount !== null) this.session.retryCount = input.retryCount;
      else delete this.session.retryCount;
    }
    if (input.lastRetryAt !== undefined) {
      if (input.lastRetryAt !== null) this.session.lastRetryAt = input.lastRetryAt;
      else delete this.session.lastRetryAt;
    }
    if (input.lastResumedAt !== undefined) {
      if (input.lastResumedAt !== null) this.session.lastResumedAt = input.lastResumedAt;
      else delete this.session.lastResumedAt;
    }
    if (input.parentNotificationStatus !== undefined) {
      if (input.parentNotificationStatus) this.session.parentNotificationStatus = input.parentNotificationStatus;
      else delete this.session.parentNotificationStatus;
    }
    if (input.parentNotificationSummary !== undefined) {
      if (input.parentNotificationSummary !== null) this.session.parentNotificationSummary = input.parentNotificationSummary;
      else delete this.session.parentNotificationSummary;
    }
    if (input.parentNotifiedAt !== undefined) {
      if (input.parentNotifiedAt !== null) this.session.parentNotifiedAt = input.parentNotifiedAt;
      else delete this.session.parentNotifiedAt;
    }
  }

  resetAgentLoopState(statePath: string | null): void {
    this.setAgentLoopStatePath(statePath);
    delete this.session.agentLoopStatus;
    delete this.session.agentLoopResumable;
    delete this.session.agentLoopUpdatedAt;
    delete this.session.agentLoop;
  }

  recordUsage(phase: string, usage: ChatUsageCounter): void {
    const normalized = normalizeUsageCounter(usage);
    const nextTotals = sumUsageCounters(
      this.session.usage?.totals,
      normalized
    );
    const currentPhase = this.session.usage?.byPhase?.[phase];
    const nextByPhase = {
      ...(this.session.usage?.byPhase ?? {}),
      [phase]: sumUsageCounters(currentPhase, normalized),
    };
    this.session.usage = {
      totals: nextTotals,
      byPhase: nextByPhase,
      updatedAt: new Date().toISOString(),
    };
  }

  async persist(): Promise<void> {
    this.session.updatedAt = new Date().toISOString();
    const { ChatSessionDataStore } = await import("./chat-session-data-store.js");
    await new ChatSessionDataStore(resolveChatStateBaseDir(this.stateManager)).save(this.session);
  }

  private pushRolloutRecord(input: {
    kind: ChatRolloutJournalRecordKind;
    source: ChatRolloutJournalRecord["source"];
    visibility: ChatRolloutJournalRecord["visibility"];
    payload: unknown;
    eventContext?: Partial<ChatEventContext>;
    createdAt?: string;
  }): void {
    const current = this.session.rolloutJournal ?? [];
    const sequence = nextRolloutSequence(current);
    const runId = typeof input.eventContext?.runId === "string" ? input.eventContext.runId : null;
    const turnId = typeof input.eventContext?.turnId === "string" ? input.eventContext.turnId : null;
    const record = ChatRolloutJournalRecordSchema.parse({
      schema_version: "chat-rollout-journal-record-v1",
      id: `${this.sessionId}:${sequence}`,
      sessionId: this.sessionId,
      runId,
      turnId,
      sequence,
      createdAt: input.createdAt ?? new Date().toISOString(),
      kind: input.kind,
      source: input.source,
      visibility: input.visibility,
      payload: redactSetupSecretsDeep(input.payload),
    });
    this.session.rolloutJournal = [...current, record].slice(-500);
  }

  private replaceModelVisibleJournalFromMessages(reason: "clear" | "compact" | "remove_last_turn"): void {
    const demoted = (this.session.rolloutJournal ?? []).map((record) =>
      record.source === "chat_history"
        && record.visibility === "model_visible"
        && (record.kind === "user_input" || record.kind === "model_output")
        ? {
            ...record,
            visibility: "debug" as const,
            payload: {
              ...(isRecord(record.payload) ? record.payload : {}),
              modelVisibleUntil: reason,
            },
          }
        : record
    );
    this.session.rolloutJournal = demoted;
    for (const message of this.session.messages) {
      this.pushRolloutRecord({
        kind: message.role === "assistant" ? "model_output" : "user_input",
        source: "chat_history",
        visibility: "model_visible",
        payload: {
          role: message.role,
          content: message.content,
          turnIndex: message.turnIndex,
          historyMutation: reason,
          ...(message.setupSecretIntake && message.setupSecretIntake.length > 0
            ? { setupSecretIntake: message.setupSecretIntake }
            : {}),
        },
      });
    }
  }

  private buildCompactionRecord(
    summary: string,
    originalMessages: ChatMessage[],
    removed: ChatMessage[],
    retained: ChatMessage[],
  ): ChatCompactionRecord {
    const current = this.session.compactionRecords ?? [];
    const sequence = nextCompactionSequence(current);
    const rewrittenTurnIndexes = retained.map((_message, index) => index);
    const rolloutJournal = this.session.rolloutJournal ?? [];
    const record = ChatCompactionRecordSchema.parse({
      schema_version: CHAT_COMPACTION_RECORD_SCHEMA_VERSION,
      id: `${this.sessionId}:compaction:${sequence}`,
      sessionId: this.sessionId,
      sequence,
      createdAt: new Date().toISOString(),
      reason: "manual_command",
      inputMessageCount: originalMessages.length,
      outputMessageCount: retained.length,
      removedMessageCount: removed.length,
      retainedMessageCount: retained.length,
      summary,
      modelVisibleSummary: summary,
      archivedUserMessages: removed.filter((message) => message.role === "user"),
      archivedAssistantMessages: removed.filter((message) => message.role === "assistant"),
      retainedMessages: retained,
      pendingPermissions: collectPendingPermissionRecords(rolloutJournal),
      decisions: collectDecisionRecords(rolloutJournal),
      activeTargets: collectActiveTargets(this.session, retained),
      replacementHistory: {
        removedTurnIndexes: removed.map((message) => message.turnIndex),
        retainedOriginalTurnIndexes: retained.map((message) => message.turnIndex),
        rewrittenTurnIndexes,
        rolloutJournalSequences: rolloutJournal.map((record) => record.sequence),
        turnContextCount: this.session.turnContexts?.length ?? 0,
      },
    });
    return record;
  }
}

export function reconstructModelVisibleMessagesFromRolloutJournal(
  records: ChatRolloutJournalRecord[] | undefined,
): ChatMessage[] | null {
  const modelRecords = (records ?? [])
    .filter((record) =>
      record.source === "chat_history"
      && record.visibility === "model_visible"
      && (record.kind === "user_input" || record.kind === "model_output")
    )
    .sort((left, right) => left.sequence - right.sequence);
  if (modelRecords.length === 0) return null;

  return modelRecords.flatMap((record, index): ChatMessage[] => {
    const payload = isRecord(record.payload) ? record.payload : {};
    const role = payload["role"] === "assistant" ? "assistant" : payload["role"] === "user" ? "user" : null;
    const content = typeof payload["content"] === "string" ? payload["content"] : null;
    if (!role || content === null) return [];
    const setupSecretIntake = Array.isArray(payload["setupSecretIntake"])
      ? { setupSecretIntake: payload["setupSecretIntake"] as ChatMessage["setupSecretIntake"] }
      : {};
    return [{
      role,
      content,
      timestamp: record.createdAt,
      turnIndex: index,
      ...setupSecretIntake,
    }];
  });
}

function nextRolloutSequence(records: ChatRolloutJournalRecord[]): number {
  return records.reduce((max, record) => Math.max(max, record.sequence), -1) + 1;
}

function nextCompactionSequence(records: ChatCompactionRecord[]): number {
  return records.reduce((max, record) => Math.max(max, record.sequence), -1) + 1;
}

function cloneCompactionRecords(records: readonly ChatCompactionRecord[]): ChatCompactionRecord[] {
  return records.map((record) => ChatCompactionRecordSchema.parse(cloneJson(record)));
}

function collectPendingPermissionRecords(records: ChatRolloutJournalRecord[]): ChatCompactionRecord["pendingPermissions"] {
  return records.flatMap((record) => {
    if (record.kind !== "permission_decision") return [];
    const payload = isRecord(record.payload) ? record.payload : {};
    const status = permissionStatus(payload);
    return [{
      sequence: record.sequence,
      source: record.source,
      status,
      invalidatedByCompaction: status === "requested",
      payload: cloneJson(record.payload),
    }];
  });
}

function collectDecisionRecords(records: ChatRolloutJournalRecord[]): ChatCompactionRecord["decisions"] {
  return records.flatMap((record) => {
    if (
      record.kind !== "turn_context"
      && record.kind !== "permission_decision"
      && record.kind !== "completion_state"
    ) {
      return [];
    }
    return [{
      sequence: record.sequence,
      kind: record.kind,
      source: record.source,
      visibility: record.visibility,
      payload: cloneJson(record.payload),
    }];
  });
}

function collectActiveTargets(
  session: ChatSession,
  retainedMessages: ChatMessage[],
): ChatCompactionRecord["activeTargets"] {
  const targets: ChatCompactionRecord["activeTargets"] = [{
    source: "retained_messages",
    state: "retained",
    payload: retainedMessages.map((message) => ({
      role: message.role,
      turnIndex: message.turnIndex,
      timestamp: message.timestamp,
    })),
  }];
  if (session.notificationReplyTarget) {
    targets.push({
      source: "notification_reply_target",
      state: "session",
      payload: cloneJson(session.notificationReplyTarget),
    });
  }
  if (session.agentLoopSessionId || session.agentLoopStatePath || session.agentLoop) {
    targets.push({
      source: "agent_loop",
      state: "session",
      payload: {
        sessionId: session.agentLoopSessionId ?? null,
        traceId: session.agentLoopTraceId ?? null,
        statePath: session.agentLoopStatePath ?? session.agentLoop?.statePath ?? null,
        status: session.agentLoopStatus ?? session.agentLoop?.status ?? null,
        resumable: session.agentLoopResumable ?? session.agentLoop?.resumable ?? null,
        updatedAt: session.agentLoopUpdatedAt ?? session.agentLoop?.updatedAt ?? null,
      },
    });
  }
  if (session.runSpecConfirmation?.state === "pending") {
    targets.push({
      source: "run_spec_confirmation",
      state: "session",
      payload: {
        state: session.runSpecConfirmation.state,
        specId: session.runSpecConfirmation.spec.id,
        createdAt: session.runSpecConfirmation.createdAt,
        updatedAt: session.runSpecConfirmation.updatedAt,
      },
    });
  }
  if (session.setupDialogue) {
    targets.push({
      source: "setup_dialogue",
      state: "session",
      payload: {
        id: session.setupDialogue.id,
        channel: session.setupDialogue.selectedChannel,
        state: session.setupDialogue.state,
        updatedAt: session.setupDialogue.updatedAt,
      },
    });
  }
  return targets;
}

function permissionStatus(payload: Record<string, unknown>): "requested" | "resolved" | "unknown" {
  if (payload["state"] === "requested") return "requested";
  if (payload["state"] === "approved" || payload["state"] === "denied" || payload["state"] === "resolved") {
    return "resolved";
  }
  const item = isRecord(payload["item"]) ? payload["item"] : null;
  if (item?.["status"] === "requested" || item?.["status"] === "awaiting_approval") return "requested";
  if (item?.["status"] === "approved" || item?.["status"] === "denied") return "resolved";
  return "unknown";
}

function extractTurnContextEventContext(snapshot: { modelVisible: unknown }): ChatEventContext | undefined {
  const modelVisible = isRecord(snapshot.modelVisible) ? snapshot.modelVisible : null;
  const turn = modelVisible && isRecord(modelVisible["turn"]) ? modelVisible["turn"] : null;
  const runId = typeof turn?.["runId"] === "string" ? turn["runId"] : undefined;
  const turnId = typeof turn?.["turnId"] === "string" ? turn["turnId"] : undefined;
  return runId && turnId ? { runId, turnId } : undefined;
}

function toReplayableUserInput(input: UserInput): unknown {
  return {
    schema_version: input.schema_version,
    ...(input.rawText !== undefined ? { rawText: input.rawText } : {}),
    items: input.items.map((item) => {
      switch (item.kind) {
        case "text":
          return { kind: "text", text: item.text };
        case "image":
        case "local_image":
          return {
            kind: item.kind,
            ...(item.name ? { name: item.name } : {}),
          };
        case "mention":
          return {
            kind: "mention",
            ...(item.label ? { label: item.label } : {}),
          };
        case "skill":
        case "plugin":
        case "tool":
          return { kind: item.kind, name: item.name };
        case "attachment":
          return {
            kind: "attachment",
            id: item.id,
            ...(item.name ? { name: item.name } : {}),
            ...(item.mimeType ? { mimeType: item.mimeType } : {}),
          };
      }
    }),
  };
}

function assertChatEventInvariants(event: ChatEvent): void {
  if (event.type !== "presence_update") return;
  if (event.presence.turn_id === event.turnId) return;
  throw new Error(
    `presence.turn_id must match event turnId for presence_update events: ${event.presence.turn_id} !== ${event.turnId}`,
  );
}

function rolloutProjectionFromChatEvent(event: ChatEvent): {
  kind: ChatRolloutJournalRecordKind;
  source: ChatRolloutJournalRecord["source"];
  visibility: ChatRolloutJournalRecord["visibility"];
  payload: unknown;
} {
  if (event.type === "tool_start") {
    return {
      kind: "tool_call",
      source: "chat_event",
      visibility: "debug",
      payload: { event },
    };
  }
  if (event.type === "tool_end") {
    return {
      kind: "tool_result",
      source: "chat_event",
      visibility: "debug",
      payload: { event },
    };
  }
  if (event.type === "tool_update" && event.status === "awaiting_approval") {
    return {
      kind: "permission_decision",
      source: "chat_event",
      visibility: "host_only",
      payload: { state: "requested", event },
    };
  }
  if (event.type === "agent_timeline") {
    return rolloutProjectionFromAgentTimelineEvent(event);
  }
  if (event.type === "assistant_final") {
    return {
      kind: "model_output",
      source: "chat_event",
      visibility: "model_visible",
      payload: {
        role: "assistant",
        content: event.text,
        persisted: event.persisted,
        event,
      },
    };
  }
  if (event.type === "presence_update") {
    return {
      kind: "display_event",
      source: "chat_event",
      visibility: visibilityFromSeedyPresenceAudience(event.presence.audience),
      payload: { event },
    };
  }
  if (event.type === "lifecycle_end" || event.type === "lifecycle_error") {
    return {
      kind: "completion_state",
      source: "chat_event",
      visibility: "debug",
      payload: { event },
    };
  }
  return {
    kind: "display_event",
    source: "chat_event",
    visibility: "display",
    payload: { event },
  };
}

function visibilityFromSeedyPresenceAudience(
  audience: Extract<ChatEvent, { type: "presence_update" }>["presence"]["audience"],
): ChatRolloutJournalRecord["visibility"] {
  switch (audience) {
    case "user":
      return "display";
    case "diagnostic":
      return "debug";
    case "internal":
      return "host_only";
  }
}

function rolloutProjectionFromAgentTimelineEvent(event: Extract<ChatEvent, { type: "agent_timeline" }>): {
  kind: ChatRolloutJournalRecordKind;
  source: "agent_timeline";
  visibility: ChatRolloutJournalRecord["visibility"];
  payload: unknown;
} {
  const item = event.item;
  if (item.kind === "model_request" || item.kind === "assistant_message") {
    return {
      kind: "model_output",
      source: "agent_timeline",
      visibility: item.visibility === "debug" ? "debug" : "model_visible",
      payload: { item },
    };
  }
  if (item.kind === "tool" && item.status === "started") {
    return {
      kind: "tool_call",
      source: "agent_timeline",
      visibility: "debug",
      payload: { item },
    };
  }
  if (item.kind === "tool" || item.kind === "tool_observation") {
    return {
      kind: "tool_result",
      source: "agent_timeline",
      visibility: item.visibility === "debug" ? "debug" : "display",
      payload: { item },
    };
  }
  if (item.kind === "approval") {
    return {
      kind: "permission_decision",
      source: "agent_timeline",
      visibility: "host_only",
      payload: { item },
    };
  }
  if (item.kind === "final" || item.kind === "stopped") {
    return {
      kind: "completion_state",
      source: "agent_timeline",
      visibility: "debug",
      payload: { item },
    };
  }
  return {
    kind: "display_event",
    source: "agent_timeline",
    visibility: item.visibility === "debug" ? "debug" : "display",
    payload: { item },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneUsage(usage: ChatSessionUsage): ChatSessionUsage {
  return normalizeSessionUsage(usage);
}

function cloneJson<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}
