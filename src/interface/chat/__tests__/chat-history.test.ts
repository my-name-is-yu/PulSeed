import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  ChatHistory,
  ChatSessionSchema,
  reconstructModelVisibleMessagesFromRolloutJournal,
  type ChatSession,
  type ChatUsageCounter,
} from "../chat-history.js";
import type { StateManager } from "../../../base/state/state-manager.js";
import { ChatSessionDataStore } from "../chat-session-data-store.js";
import { resolveChatStateBaseDir } from "../chat-state-base-dir.js";
import { createSeedyTurnPresence, createUserVisibleSeedyTurnPresence } from "../seedy-turn-presence.js";

function makeMockStateManager(): StateManager {
  return {
    writeRaw: vi.fn().mockResolvedValue(undefined),
    readRaw: vi.fn().mockResolvedValue(null),
  } as unknown as StateManager;
}

describe("ChatHistory", () => {
  let stateManager: StateManager;
  const SESSION_ID = "test-session-123";
  const CWD = "/tmp/test-repo";

  beforeEach(() => {
    stateManager = makeMockStateManager();
  });

  async function loadPersistedSession(sm: StateManager = stateManager): Promise<ChatSession | null> {
    return new ChatSessionDataStore(resolveChatStateBaseDir(sm)).load(SESSION_ID);
  }

  it("creates a session with correct id, cwd, and empty messages", () => {
    const history = new ChatHistory(stateManager, SESSION_ID, CWD);
    const session = history.getSessionData();

    expect(session.id).toBe(SESSION_ID);
    expect(session.cwd).toBe(CWD);
    expect(session.messages).toHaveLength(0);
    expect(session.createdAt).toBeTruthy();
  });

  it("appendUserMessage adds a message with role 'user' and correct content", async () => {
    const history = new ChatHistory(stateManager, SESSION_ID, CWD);
    await history.appendUserMessage("Hello, world!");

    const messages = history.getMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toBe("Hello, world!");
    expect(messages[0].timestamp).toBeTruthy();
  });

  it("appendUserMessage assigns incrementing turnIndex starting at 0", async () => {
    const history = new ChatHistory(stateManager, SESSION_ID, CWD);

    await history.appendUserMessage("First message");
    history.appendAssistantMessage("First reply");
    await history.appendUserMessage("Second message");

    const messages = history.getMessages();
    expect(messages[0].turnIndex).toBe(0);
    expect(messages[1].turnIndex).toBe(1);
    expect(messages[2].turnIndex).toBe(2);
  });

  it("appendAssistantMessage adds a message with role 'assistant'", async () => {
    const history = new ChatHistory(stateManager, SESSION_ID, CWD);
    await history.appendUserMessage("Question");
    history.appendAssistantMessage("Answer");

    const messages = history.getMessages();
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].content).toBe("Answer");
  });

  it("getMessages returns all messages in order", async () => {
    const history = new ChatHistory(stateManager, SESSION_ID, CWD);
    await history.appendUserMessage("msg1");
    history.appendAssistantMessage("msg2");
    await history.appendUserMessage("msg3");

    const messages = history.getMessages();
    expect(messages).toHaveLength(3);
    expect(messages[0].content).toBe("msg1");
    expect(messages[1].content).toBe("msg2");
    expect(messages[2].content).toBe("msg3");
  });

  it("getMessages returns a copy, not the internal array", async () => {
    const history = new ChatHistory(stateManager, SESSION_ID, CWD);
    await history.appendUserMessage("original");

    const messages = history.getMessages();
    messages.push({ role: "user", content: "injected", timestamp: "", turnIndex: 99 });

    expect(history.getMessages()).toHaveLength(1);
  });

  it("clear() resets messages to empty", async () => {
    const history = new ChatHistory(stateManager, SESSION_ID, CWD);
    await history.appendUserMessage("First");
    history.appendAssistantMessage("Reply");

    history.clear();

    expect(history.getMessages()).toHaveLength(0);
  });

  it("persist() saves the session through the chat session data store", async () => {
    const history = new ChatHistory(stateManager, SESSION_ID, CWD);
    await history.persist();

    await expect(loadPersistedSession()).resolves.toMatchObject({
      id: SESSION_ID,
      cwd: CWD,
      messages: [],
    });
  });

  it("appendUserMessage awaits DB persistence before returning", async () => {
    const sm = makeMockStateManager();

    const history = new ChatHistory(sm, SESSION_ID, CWD);
    await history.appendUserMessage("persist-before-execute check");

    await expect(loadPersistedSession(sm)).resolves.toMatchObject({
      messages: [expect.objectContaining({ content: "persist-before-execute check" })],
    });
  });

  it("recordTurnContext persists the snapshot before returning", async () => {
    const sm = makeMockStateManager();

    const history = new ChatHistory(sm, SESSION_ID, CWD);
    await history.recordTurnContext({
      schema_version: "chat-turn-context-v1",
      modelVisible: { turn: { turnId: "turn-1" } },
    });

    await expect(loadPersistedSession(sm)).resolves.toMatchObject({
      turnContexts: [
        expect.objectContaining({
          schema_version: "chat-turn-context-v1",
        }),
      ],
    });
  });

  it("normalizes unsafe usage counters before persistence", async () => {
    const history = new ChatHistory(stateManager, SESSION_ID, CWD);

    history.recordUsage("assist", {
      inputTokens: Number.MAX_SAFE_INTEGER + 1,
      outputTokens: 1.25,
      totalTokens: Number.POSITIVE_INFINITY,
    } as ChatUsageCounter);
    await history.persist();

    await expect(loadPersistedSession()).resolves.toMatchObject({
      usage: {
        totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        byPhase: {
          assist: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        },
        updatedAt: expect.any(String),
      },
    });
  });

  it("normalizes unsafe usage counters from loaded session schemas", () => {
    const parsed = ChatSessionSchema.parse({
      id: SESSION_ID,
      cwd: CWD,
      createdAt: "2026-05-09T00:00:00.000Z",
      updatedAt: "2026-05-09T00:00:00.000Z",
      messages: [],
      usage: {
        totals: {
          inputTokens: Number.MAX_SAFE_INTEGER + 1,
          outputTokens: 1.5,
          totalTokens: Number.POSITIVE_INFINITY,
        },
        byPhase: {
          assist: {
            inputTokens: -1,
            outputTokens: Number.NaN,
            totalTokens: Number.MAX_SAFE_INTEGER + 2,
          },
        },
      },
    });

    expect(parsed.usage).toEqual({
      totals: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      byPhase: {
        assist: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      },
    });
  });

  it("normalizes existing session usage before persisting a resumed session", async () => {
    const existingSession = {
      id: SESSION_ID,
      cwd: CWD,
      createdAt: "2026-05-09T00:00:00.000Z",
      updatedAt: "2026-05-09T00:00:00.000Z",
      messages: [],
      usage: {
        totals: {
          inputTokens: Number.MAX_SAFE_INTEGER + 1,
          outputTokens: 2,
          totalTokens: Number.POSITIVE_INFINITY,
        },
        byPhase: {
          assist: {
            inputTokens: 1.5,
            outputTokens: Number.MAX_SAFE_INTEGER + 1,
            totalTokens: Number.NaN,
          },
        },
      },
    } as ChatSession;

    const history = ChatHistory.fromSession(stateManager, existingSession);
    await history.persist();

    await expect(loadPersistedSession()).resolves.toMatchObject({
      usage: {
        totals: { inputTokens: 0, outputTokens: 2, totalTokens: 2 },
        byPhase: {
          assist: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        },
      },
    });
  });

  it("caps accumulated usage counters at the maximum safe integer", () => {
    const history = new ChatHistory(stateManager, SESSION_ID, CWD);

    history.recordUsage("assist", {
      inputTokens: Number.MAX_SAFE_INTEGER,
      outputTokens: 1,
      totalTokens: Number.MAX_SAFE_INTEGER,
    });
    history.recordUsage("assist", {
      inputTokens: 1,
      outputTokens: Number.MAX_SAFE_INTEGER,
      totalTokens: 1,
    });

    expect(history.getSessionData().usage?.totals).toEqual({
      inputTokens: Number.MAX_SAFE_INTEGER,
      outputTokens: Number.MAX_SAFE_INTEGER,
      totalTokens: Number.MAX_SAFE_INTEGER,
    });
    expect(history.getSessionData().usage?.byPhase.assist).toEqual({
      inputTokens: Number.MAX_SAFE_INTEGER,
      outputTokens: Number.MAX_SAFE_INTEGER,
      totalTokens: Number.MAX_SAFE_INTEGER,
    });
  });

  it("persists replayable rollout records and reconstructs model-visible history from them", async () => {
    const history = new ChatHistory(stateManager, SESSION_ID, CWD);
    const eventContext = { runId: "run-1", turnId: "turn-1" };
    const createdAt = "2026-05-06T00:00:00.000Z";

    await history.appendUserMessage("Please inspect the rollout journal.", {
      eventContext,
      userInput: {
        schema_version: "user-input-v1",
        rawText: "Please inspect the rollout journal.",
        items: [
          { kind: "text", text: "Please inspect the rollout journal." },
          { kind: "local_image", path: "/Users/example/private-screenshot.png", name: "private-screenshot.png" },
        ],
      },
    });
    await history.recordTurnContext({
      schema_version: "chat-turn-context-v1",
      modelVisible: {
        turn: eventContext,
        conversation: { priorTurns: [] },
      },
    });
    await history.recordChatEvent({
      type: "tool_start",
      toolCallId: "call-1",
      toolName: "read_file",
      args: { apiKey: "sk-abcdefghijklmnopqrstuvwxyz123456" },
      runId: eventContext.runId,
      turnId: eventContext.turnId,
      createdAt,
    });
    await history.recordChatEvent({
      type: "tool_end",
      toolCallId: "call-1",
      toolName: "read_file",
      success: true,
      summary: "read complete",
      durationMs: 7,
      runId: eventContext.runId,
      turnId: eventContext.turnId,
      createdAt,
    });
    await history.recordChatEvent({
      type: "tool_update",
      toolCallId: "call-approval",
      toolName: "write_file",
      status: "awaiting_approval",
      message: "write requires approval",
      runId: eventContext.runId,
      turnId: eventContext.turnId,
      createdAt,
    });
    await history.recordChatEvent({
      type: "activity",
      kind: "checkpoint",
      message: "Context gathered",
      runId: eventContext.runId,
      turnId: eventContext.turnId,
      createdAt,
    });
    await history.appendAssistantMessage("The rollout journal is replayable.", { eventContext });
    await history.recordChatEvent({
      type: "lifecycle_end",
      status: "completed",
      elapsedMs: 42,
      persisted: true,
      runId: eventContext.runId,
      turnId: eventContext.turnId,
      createdAt,
    });

    const session = history.getSessionData();
    const rolloutJournal = session.rolloutJournal ?? [];
    expect(rolloutJournal.map((record) => record.kind)).toEqual(expect.arrayContaining([
      "user_input",
      "turn_context",
      "tool_call",
      "tool_result",
      "permission_decision",
      "display_event",
      "model_output",
      "completion_state",
    ]));
    expect(JSON.stringify(rolloutJournal)).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
    expect(JSON.stringify(rolloutJournal)).not.toContain("/Users/example/private-screenshot.png");

    const reconstructed = reconstructModelVisibleMessagesFromRolloutJournal(rolloutJournal);
    expect(reconstructed?.map((message) => [message.role, message.content])).toEqual([
      ["user", "Please inspect the rollout journal."],
      ["assistant", "The rollout journal is replayable."],
    ]);
    expect(history.getModelVisibleMessages().map((message) => message.content)).toEqual([
      "Please inspect the rollout journal.",
      "The rollout journal is replayable.",
    ]);
  });

  it("projects Seedy presence audience into rollout journal visibility", async () => {
    const history = new ChatHistory(stateManager, SESSION_ID, CWD);
    const eventContext = { runId: "run-presence", turnId: "turn-presence" };
    const createdAt = "2026-05-10T05:00:00.000Z";

    await history.recordChatEvent({
      type: "presence_update",
      ...eventContext,
      createdAt,
      presence: createUserVisibleSeedyTurnPresence({
        turn_id: eventContext.turnId,
        phase: "received",
        started_at: createdAt,
      }),
    });
    await history.recordChatEvent({
      type: "presence_update",
      ...eventContext,
      createdAt,
      presence: createSeedyTurnPresence({
        turn_id: eventContext.turnId,
        audience: "diagnostic",
        phase: "acting",
        importance: "status",
        started_at: createdAt,
        updated_at: createdAt,
        diagnostic_ref: "trace:presence-debug",
      }),
    });
    await history.recordChatEvent({
      type: "presence_update",
      ...eventContext,
      createdAt,
      presence: createSeedyTurnPresence({
        turn_id: eventContext.turnId,
        audience: "internal",
        phase: "orienting",
        importance: "ephemeral",
        started_at: createdAt,
        updated_at: createdAt,
      }),
    });

    const presenceRecords = (history.getSessionData().rolloutJournal ?? [])
      .filter((record) => record.kind === "display_event" && record.source === "chat_event");

    expect(presenceRecords.map((record) => record.visibility)).toEqual([
      "display",
      "debug",
      "host_only",
    ]);
    const displayRecords = presenceRecords.filter((record) => record.visibility === "display");
    expect(JSON.stringify(displayRecords)).not.toContain("trace:presence-debug");
  });

  it("compacts into structured records with invalidated pending permissions and retained active targets", async () => {
    const history = new ChatHistory(stateManager, SESSION_ID, CWD);
    const eventContext = { runId: "run-compact", turnId: "turn-compact" };
    const createdAt = "2026-05-06T00:00:00.000Z";

    await history.appendUserMessage("Turn 1: check stale run", { eventContext });
    await history.recordChatEvent({
      type: "tool_update",
      toolCallId: "call-approval",
      toolName: "shell_command",
      status: "awaiting_approval",
      message: "write requires approval",
      runId: eventContext.runId,
      turnId: eventContext.turnId,
      createdAt,
    });
    await history.appendAssistantMessage("Turn 1 answer", { eventContext });
    await history.appendUserMessage("Turn 2: current run is run-current", { eventContext });
    await history.appendAssistantMessage("Turn 2 answer", { eventContext });
    await history.appendUserMessage("Turn 3: continue", { eventContext });
    await history.appendAssistantMessage("Turn 3 answer", { eventContext });

    const result = await history.compact("Summary: Turn 1 established stale run, Turn 2 selected run-current.", 4);

    expect(result).toEqual({ before: 6, after: 4 });
    const session = history.getSessionData();
    const record = session.compactionRecords?.[0];
    expect(record).toMatchObject({
      schema_version: "chat-compaction-record-v1",
      inputMessageCount: 6,
      outputMessageCount: 4,
      removedMessageCount: 2,
      retainedMessageCount: 4,
      replacementHistory: {
        removedTurnIndexes: [0, 1],
        retainedOriginalTurnIndexes: [2, 3, 4, 5],
        rewrittenTurnIndexes: [0, 1, 2, 3],
      },
    });
    expect(record?.archivedUserMessages.map((message) => message.content)).toEqual([
      "Turn 1: check stale run",
    ]);
    expect(record?.pendingPermissions).toEqual([
      expect.objectContaining({
        status: "requested",
        invalidatedByCompaction: true,
        source: "chat_event",
      }),
    ]);
    expect(record?.decisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "permission_decision" }),
    ]));
    expect(record?.activeTargets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: "retained_messages",
        state: "retained",
      }),
    ]));
    expect(history.getModelVisibleMessages().map((message) => message.content)).toEqual([
      "Turn 2: current run is run-current",
      "Turn 2 answer",
      "Turn 3: continue",
      "Turn 3 answer",
    ]);
  });

  it("does not mark confirmed RunSpec confirmations as active compaction targets", async () => {
    const createdAt = "2026-05-06T00:00:00.000Z";
    const existingSession: ChatSession = {
      id: SESSION_ID,
      cwd: CWD,
      createdAt,
      updatedAt: createdAt,
      runSpecConfirmation: {
        state: "confirmed",
        spec: makeRunSpec(createdAt),
        prompt: "Start the confirmed run.",
        createdAt,
        updatedAt: createdAt,
      },
      messages: [
        { role: "user", content: "Old run request", timestamp: createdAt, turnIndex: 0 },
        { role: "assistant", content: "Confirmed and started", timestamp: createdAt, turnIndex: 1 },
        { role: "user", content: "Current request", timestamp: createdAt, turnIndex: 2 },
        { role: "assistant", content: "Current answer", timestamp: createdAt, turnIndex: 3 },
        { role: "user", content: "Latest request", timestamp: createdAt, turnIndex: 4 },
      ],
    };
    const history = ChatHistory.fromSession(stateManager, existingSession);

    await history.compact("The old RunSpec confirmation has already been consumed.", 2);

    const record = history.getSessionData().compactionRecords?.[0];
    expect(record?.activeTargets).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "run_spec_confirmation" }),
    ]));
  });
});

function makeRunSpec(now: string): NonNullable<ChatSession["runSpecConfirmation"]>["spec"] {
  return {
    schema_version: "run-spec-v1",
    id: "runspec-12345678-1234-4234-9234-123456789abc",
    status: "confirmed",
    profile: "generic",
    source_text: "Start the confirmed run.",
    objective: "Start the confirmed run.",
    workspace: { path: "/tmp/test-repo", source: "user", confidence: "high" },
    execution_target: { kind: "daemon", remote_host: null, confidence: "high" },
    metric: null,
    progress_contract: {
      kind: "open_ended",
      dimension: null,
      threshold: null,
      semantics: "Complete the requested work.",
      confidence: "high",
    },
    deadline: null,
    budget: {
      max_trials: null,
      max_wall_clock_minutes: null,
      resident_policy: "best_effort",
    },
    approval_policy: {
      submit: "unspecified",
      publish: "unspecified",
      secret: "unspecified",
      external_action: "approval_required",
      irreversible_action: "approval_required",
    },
    artifact_contract: {
      expected_artifacts: [],
      discovery_globs: [],
      primary_outputs: [],
    },
    risk_flags: [],
    missing_fields: [],
    confidence: "high",
    links: {
      goal_id: null,
      runtime_session_id: null,
      conversation_id: null,
    },
    origin: {
      channel: "chat",
      session_id: "test-session-123",
      reply_target: null,
      metadata: {},
    },
    created_at: now,
    updated_at: now,
  };
}
