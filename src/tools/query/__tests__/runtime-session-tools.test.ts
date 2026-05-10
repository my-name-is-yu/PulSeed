import * as os from "node:os";
import * as path from "node:path";
import * as fsp from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { z } from "zod";

import { StateManager } from "../../../base/state/state-manager.js";
import { ChatSessionDataStore } from "../../../interface/chat/chat-session-data-store.js";
import type { ChatSession } from "../../../interface/chat/chat-history.js";
import { BackgroundRunLedger } from "../../../runtime/store/background-run-store.js";
import { OutboxStore } from "../../../runtime/store/outbox-store.js";
import type { ITool, ToolCallContext } from "../../types.js";
import { toToolDefinition } from "../../tool-definition-adapter.js";
import { RuntimeDreamReviewInputSchema } from "../runtime-dream-review-tool.js";
import * as runtimeSessionSchemaModule from "../runtime-session-tool-schemas.js";
import {
  createRuntimeSessionTools,
  RuntimeRunsObserveInputSchema,
  RuntimeSessionsCancelInputSchema,
  RuntimeSessionsChildrenInputSchema,
  RuntimeSessionsClaimInputSchema,
  RuntimeSessionsHistoryInputSchema,
  RuntimeSessionsListInputSchema,
  RuntimeSessionsReadInputSchema,
  RuntimeSessionsRetryInputSchema,
  RuntimeSessionsSendInputSchema,
  RuntimeSessionsSpawnInputSchema,
  RuntimeSessionsUpdateInputSchema,
} from "../runtime-session-tools.js";

interface RuntimeSessionToolSchemaCase {
  name: string;
  schema: z.ZodTypeAny;
  validInput: Record<string, unknown>;
}

const RUNTIME_SESSION_TOOL_SCHEMA_CASES: RuntimeSessionToolSchemaCase[] = [
  { name: "sessions_list", schema: RuntimeSessionsListInputSchema, validInput: {} },
  { name: "runs_observe", schema: RuntimeRunsObserveInputSchema, validInput: {} },
  { name: "sessions_history", schema: RuntimeSessionsHistoryInputSchema, validInput: { session_id: "session-1" } },
  { name: "sessions_read", schema: RuntimeSessionsReadInputSchema, validInput: { session_id: "session-1" } },
  { name: "sessions_children", schema: RuntimeSessionsChildrenInputSchema, validInput: { session_id: "session-1" } },
  { name: "runtime_dream_review", schema: RuntimeDreamReviewInputSchema, validInput: { run_id: "run-1" } },
  { name: "sessions_spawn", schema: RuntimeSessionsSpawnInputSchema, validInput: { title: "Investigate" } },
  {
    name: "sessions_send",
    schema: RuntimeSessionsSendInputSchema,
    validInput: { session_id: "session-1", message: "Continue here" },
  },
  {
    name: "sessions_update",
    schema: RuntimeSessionsUpdateInputSchema,
    validInput: { session_id: "session-1", status: "running" },
  },
  {
    name: "sessions_claim",
    schema: RuntimeSessionsClaimInputSchema,
    validInput: { session_id: "session-1", owner_id: "agent-1" },
  },
  {
    name: "sessions_cancel",
    schema: RuntimeSessionsCancelInputSchema,
    validInput: { session_id: "session-1", reason: "No longer needed" },
  },
  { name: "sessions_retry", schema: RuntimeSessionsRetryInputSchema, validInput: { session_id: "session-1" } },
];

function makeContext(overrides: Partial<ToolCallContext> = {}): ToolCallContext {
  return {
    cwd: "/repo",
    goalId: "chat",
    trustBalance: 0,
    preApproved: true,
    approvalFn: async () => true,
    ...overrides,
  };
}

describe("runtime session tools", () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let tools: Map<string, ITool>;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pulseed-runtime-session-tools-"));
    stateManager = new StateManager(tmpDir, undefined, { walEnabled: false });
    await stateManager.init();
    tools = new Map(createRuntimeSessionTools(stateManager).map((tool) => [tool.metadata.name, tool]));
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  async function saveChatSession(session: ChatSession): Promise<void> {
    await new ChatSessionDataStore(tmpDir).save(session);
  }

  it.each(RUNTIME_SESSION_TOOL_SCHEMA_CASES)("$name rejects unknown runtime fields", ({ schema, validInput }) => {
    expect(schema.safeParse(validInput).success).toBe(true);
    expect(schema.safeParse({ ...validInput, unexpected: true }).success).toBe(false);
  });

  it.each(RUNTIME_SESSION_TOOL_SCHEMA_CASES)("$name exports a closed model-facing schema", ({ name }) => {
    const tool = tools.get(name);
    expect(tool).toBeDefined();
    const parameters = toToolDefinition(tool!).function.parameters as Record<string, unknown>;
    expect(parameters.additionalProperties).toBe(false);
  });

  it("keeps the legacy module exports aligned with the dedicated schema module", () => {
    expect(RuntimeSessionsListInputSchema).toBe(runtimeSessionSchemaModule.RuntimeSessionsListInputSchema);
    expect(RuntimeRunsObserveInputSchema).toBe(runtimeSessionSchemaModule.RuntimeRunsObserveInputSchema);
    expect(RuntimeSessionsHistoryInputSchema).toBe(runtimeSessionSchemaModule.RuntimeSessionsHistoryInputSchema);
    expect(RuntimeSessionsReadInputSchema).toBe(runtimeSessionSchemaModule.RuntimeSessionsReadInputSchema);
    expect(RuntimeSessionsChildrenInputSchema).toBe(runtimeSessionSchemaModule.RuntimeSessionsChildrenInputSchema);
    expect(RuntimeSessionsSpawnInputSchema).toBe(runtimeSessionSchemaModule.RuntimeSessionsSpawnInputSchema);
    expect(RuntimeSessionsSendInputSchema).toBe(runtimeSessionSchemaModule.RuntimeSessionsSendInputSchema);
    expect(RuntimeSessionsUpdateInputSchema).toBe(runtimeSessionSchemaModule.RuntimeSessionsUpdateInputSchema);
    expect(RuntimeSessionsClaimInputSchema).toBe(runtimeSessionSchemaModule.RuntimeSessionsClaimInputSchema);
    expect(RuntimeSessionsCancelInputSchema).toBe(runtimeSessionSchemaModule.RuntimeSessionsCancelInputSchema);
    expect(RuntimeSessionsRetryInputSchema).toBe(runtimeSessionSchemaModule.RuntimeSessionsRetryInputSchema);
  });

  it("spawns a child conversation session and scopes tree listing to spawned descendants", async () => {
    await saveChatSession({
      id: "root",
      cwd: "/repo",
      createdAt: "2026-04-25T00:00:00.000Z",
      updatedAt: "2026-04-25T00:00:00.000Z",
      title: "Root",
      messages: [],
    });
    await saveChatSession({
      id: "external",
      cwd: "/repo",
      createdAt: "2026-04-25T00:00:00.000Z",
      updatedAt: "2026-04-25T00:00:00.000Z",
      title: "External",
      messages: [],
    });

    const spawn = tools.get("sessions_spawn")!;
    const spawned = await spawn.call({
      title: "Delegated child",
      message: "Investigate this in a separate session",
    }, makeContext({ conversationSessionId: "root", sessionId: "agent-runtime-1" }));
    expect(spawned.success).toBe(true);

    const spawnedData = spawned.data as { sessionId: string; runtimeSessionId: string; parentSessionId: string | null };
    expect(spawnedData.parentSessionId).toBe("root");
    expect(spawnedData.runtimeSessionId).toBe(`session:conversation:${spawnedData.sessionId}`);

    const history = tools.get("sessions_history")!;
    const loaded = await history.call({
      session_id: spawnedData.runtimeSessionId,
      limit: 10,
    }, makeContext());
    expect(loaded.success).toBe(true);
    expect(loaded.data).toMatchObject({
      sessionId: spawnedData.sessionId,
      parentSessionId: "root",
      messages: [
        expect.objectContaining({
          role: "user",
          content: "Investigate this in a separate session",
        }),
      ],
    });

    const list = tools.get("sessions_list")!;
    const treeScoped = await list.call({
      scope: "tree",
      includeRuns: false,
    }, makeContext({ conversationSessionId: "root" }));
    expect(treeScoped.success).toBe(true);
    const treeSessions = (treeScoped.data as { sessions: Array<{ id: string }> }).sessions;
    expect(treeSessions.map((session) => session.id)).toContain("session:conversation:root");
    expect(treeSessions.map((session) => session.id)).toContain(spawnedData.runtimeSessionId);
    expect(treeSessions.map((session) => session.id)).not.toContain("session:conversation:external");
  });

  it("sends a queued message into another conversation session", async () => {
    await saveChatSession({
      id: "target",
      cwd: "/repo",
      createdAt: "2026-04-25T00:00:00.000Z",
      updatedAt: "2026-04-25T00:00:00.000Z",
      title: "Target",
      messages: [],
    });

    const send = tools.get("sessions_send")!;
    const result = await send.call({
      session_id: "session:conversation:target",
      message: "Please continue the heavy work here",
    }, makeContext());

    expect(result.success).toBe(true);
    expect(result.contextModifier).toContain("Resume session:conversation:target later");

    const history = tools.get("sessions_history")!;
    const loaded = await history.call({
      session_id: "target",
      limit: 10,
    }, makeContext());
    expect(loaded.success).toBe(true);
    expect(loaded.data).toMatchObject({
      sessionId: "target",
      messages: [
        expect.objectContaining({
          content: "Please continue the heavy work here",
        }),
      ],
    });
  });

  it("returns a consistent failed ToolResult when a session lookup fails", async () => {
    const read = tools.get("sessions_read")!;
    const result = await read.call({ session_id: "missing-session" }, makeContext());

    expect(result).toMatchObject({
      success: false,
      data: null,
      summary: expect.stringContaining("sessions_read failed:"),
      error: expect.stringContaining("No chat session matched selector"),
    });
    expect(result.durationMs).toEqual(expect.any(Number));
  });

  it("marks a child session completed, appends a parent summary, and writes durable outbox notifications", async () => {
    await saveChatSession({
      id: "parent",
      cwd: "/repo",
      createdAt: "2026-04-25T00:00:00.000Z",
      updatedAt: "2026-04-25T00:00:00.000Z",
      title: "Parent",
      messages: [],
      notificationReplyTarget: {
        channel: "plugin_gateway",
        target_id: "chat-123",
        thread_id: "msg-1",
      },
    });
    await saveChatSession({
      id: "child",
      cwd: "/repo",
      createdAt: "2026-04-25T00:01:00.000Z",
      updatedAt: "2026-04-25T00:01:00.000Z",
      title: "Child",
      parentSessionId: "parent",
      spawnedBySessionId: "parent",
      spawnedAt: "2026-04-25T00:01:00.000Z",
      sessionStatus: "running",
      messages: [],
    });

    const read = tools.get("sessions_read")!;
    const before = await read.call({ session_id: "child" }, makeContext());
    expect(before.success).toBe(true);
    expect(before.data).toMatchObject({
      sessionId: "child",
      parentSessionId: "parent",
      sessionStatus: "running",
    });

    const update = tools.get("sessions_update")!;
    const result = await update.call({
      session_id: "session:conversation:child",
      status: "completed",
      summary: "Heavy work is done.",
      append_assistant_message: true,
      notify_parent: true,
    }, makeContext());
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      sessionId: "child",
      status: "completed",
      parentNotificationStatus: "sent",
      notified: true,
    });

    const after = await read.call({ session_id: "child" }, makeContext());
    expect(after.success).toBe(true);
    expect(after.data).toMatchObject({
      sessionId: "child",
      sessionStatus: "completed",
      sessionSummary: "Heavy work is done.",
      parentNotificationStatus: "sent",
    });

    const parentHistory = tools.get("sessions_history")!;
    const parentLoaded = await parentHistory.call({ session_id: "parent", limit: 10 }, makeContext());
    expect(parentLoaded.success).toBe(true);
    expect(parentLoaded.data).toMatchObject({
      sessionId: "parent",
      messages: [
        expect.objectContaining({
          role: "assistant",
          content: expect.stringContaining('Session child "Child" completed: Heavy work is done.'),
        }),
      ],
    });

    const outbox = await new OutboxStore(tmpDir).list();
    expect(outbox).toHaveLength(2);
    expect(outbox[0]).toMatchObject({
      event_type: "session_completion",
      correlation_id: "child",
      payload: expect.objectContaining({
        session_id: "child",
        parent_session_id: "parent",
        status: "completed",
        summary: "Heavy work is done.",
      }),
    });
    expect(outbox[1]).toMatchObject({
      event_type: "chat_response",
      correlation_id: "child",
      payload: expect.objectContaining({
        status: "completed",
        session_completion: expect.objectContaining({
          session_id: "child",
          summary: "Heavy work is done.",
        }),
      }),
    });
  });

  it("persists goal linkage, waiting conditions, and ownership across spawn, claim, children, and update paths", async () => {
    await saveChatSession({
      id: "root",
      cwd: "/repo",
      createdAt: "2026-04-25T00:00:00.000Z",
      updatedAt: "2026-04-25T00:00:00.000Z",
      title: "Root",
      messages: [],
      notificationReplyTarget: {
        channel: "plugin_gateway",
        target_id: "chat-123",
      },
    });

    const spawn = tools.get("sessions_spawn")!;
    const spawned = await spawn.call({
      title: "Delegated child",
      goal_id: "goal-742",
      strategy_id: "strategy-investigate",
      notification_policy: "periodic",
      owner_id: "agent-alpha",
    }, makeContext({ conversationSessionId: "root", sessionId: "agent-runtime-1" }));
    expect(spawned.success).toBe(true);

    const childSessionId = (spawned.data as { sessionId: string }).sessionId;

    const claim = tools.get("sessions_claim")!;
    const claimResult = await claim.call({
      session_id: childSessionId,
      owner_id: "agent-beta",
    }, makeContext());
    expect(claimResult.success).toBe(true);
    expect(claimResult.data).toMatchObject({
      sessionId: childSessionId,
      ownerId: "agent-beta",
    });

    const update = tools.get("sessions_update")!;
    const waiting = await update.call({
      session_id: childSessionId,
      status: "waiting",
      waiting_until: "2026-04-29T00:00:00.000Z",
      waiting_condition: "wait for user confirmation",
      notification_policy: "periodic",
    }, makeContext());
    expect(waiting.success).toBe(true);

    const read = tools.get("sessions_read")!;
    const loaded = await read.call({ session_id: childSessionId }, makeContext());
    expect(loaded.success).toBe(true);
    expect(loaded.data).toMatchObject({
      sessionId: childSessionId,
      goalId: "goal-742",
      strategyId: "strategy-investigate",
      notificationPolicy: "periodic",
      ownerId: "agent-beta",
      waitingUntil: "2026-04-29T00:00:00.000Z",
      waitingCondition: "wait for user confirmation",
      parentSessionId: "root",
    });

    const children = tools.get("sessions_children")!;
    const tree = await children.call({ session_id: "root" }, makeContext());
    expect(tree.success).toBe(true);
    expect(tree.data).toMatchObject({
      sessionId: "root",
      children: [
        expect.objectContaining({
          sessionId: childSessionId,
          goalId: "goal-742",
          strategyId: "strategy-investigate",
          waitingUntil: "2026-04-29T00:00:00.000Z",
          ownerId: "agent-beta",
        }),
      ],
    });
  });

  it("retries a waiting child session, clears stale waiting fields, and supports explicit cancellation", async () => {
    await saveChatSession({
      id: "parent",
      cwd: "/repo",
      createdAt: "2026-04-25T00:00:00.000Z",
      updatedAt: "2026-04-25T00:00:00.000Z",
      title: "Parent",
      messages: [],
      notificationReplyTarget: {
        channel: "plugin_gateway",
        target_id: "chat-123",
      },
    });
    await saveChatSession({
      id: "child",
      cwd: "/repo",
      createdAt: "2026-04-25T00:01:00.000Z",
      updatedAt: "2026-04-25T00:01:00.000Z",
      title: "Child",
      parentSessionId: "parent",
      sessionStatus: "waiting",
      waitingUntil: "2026-04-30T00:00:00.000Z",
      waitingCondition: "wait for deployment window",
      retryCount: 1,
      messages: [],
    });

    const retry = tools.get("sessions_retry")!;
    const retried = await retry.call({
      session_id: "session:conversation:child",
      message: "Retry after the window opens",
    }, makeContext());
    expect(retried.success).toBe(true);
    expect(retried.data).toMatchObject({
      sessionId: "child",
      retryCount: 2,
      status: "queued",
    });

    const read = tools.get("sessions_read")!;
    const afterRetry = await read.call({ session_id: "child" }, makeContext());
    expect(afterRetry.success).toBe(true);
    expect(afterRetry.data).toMatchObject({
      sessionId: "child",
      sessionStatus: "queued",
      retryCount: 2,
      waitingUntil: null,
      waitingCondition: null,
      parentNotificationStatus: "pending",
    });

    const history = tools.get("sessions_history")!;
    const retriedHistory = await history.call({ session_id: "child", limit: 10 }, makeContext());
    expect(retriedHistory.success).toBe(true);
    expect(retriedHistory.data).toMatchObject({
      messages: [
        expect.objectContaining({
          role: "user",
          content: "Retry after the window opens",
        }),
      ],
    });

    const cancel = tools.get("sessions_cancel")!;
    const canceled = await cancel.call({
      session_id: "child",
      reason: "User canceled this delegated branch",
    }, makeContext());
    expect(canceled.success).toBe(true);
    expect(canceled.data).toMatchObject({
      sessionId: "child",
      status: "failed",
    });

    const afterCancel = await read.call({ session_id: "child" }, makeContext());
    expect(afterCancel.success).toBe(true);
    expect(afterCancel.data).toMatchObject({
      sessionId: "child",
      sessionStatus: "failed",
      sessionSummary: "User canceled this delegated branch",
      parentNotificationStatus: "sent",
    });
  });

  it("exposes read-only Dream sidecar reviews for active background runs", async () => {
    const ledger = new BackgroundRunLedger(path.join(tmpDir, "runtime"));
    await ledger.create({
      id: "run:coreloop:tool-sidecar",
      kind: "coreloop_run",
      notify_policy: "silent",
      reply_target_source: "none",
      status: "running",
      title: "Tool sidecar target",
      workspace: "/repo",
      started_at: "2026-04-30T00:00:00.000Z",
      updated_at: "2026-04-30T00:10:00.000Z",
      summary: "Running tool sidecar target.",
    });

    const review = tools.get("runtime_dream_review")!;
    expect(review.metadata.isReadOnly).toBe(true);
    expect(review.metadata.permissionLevel).toBe("read_only");
    await expect(review.checkPermissions({
      run_id: "run:coreloop:tool-sidecar",
      request_guidance_injection: false,
    }, makeContext())).resolves.toMatchObject({ status: "allowed" });

    const result = await review.call({
      run_id: "run:coreloop:tool-sidecar",
      request_guidance_injection: true,
    }, makeContext());

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      attach_status: "active",
      read_only_enforced: true,
      guidance_injection: {
        status: "approval_required",
        approval_required: true,
        target_run_id: "run:coreloop:tool-sidecar",
      },
    });
    expect(await ledger.load("run:coreloop:tool-sidecar")).toMatchObject({
      status: "running",
      summary: "Running tool sidecar target.",
    });
  });

  it("observes runtime runs with exact ids and epochs for later typed control", async () => {
    await saveChatSession({
      id: "root",
      cwd: "/repo",
      createdAt: "2026-04-25T00:00:00.000Z",
      updatedAt: "2026-04-25T00:10:00.000Z",
      title: "Root",
      messages: [],
    });
    const ledger = new BackgroundRunLedger(path.join(tmpDir, "runtime"));
    await ledger.create({
      id: "run:coreloop:observe-target",
      kind: "coreloop_run",
      parent_session_id: "session:conversation:root",
      goal_id: "goal-observe",
      notify_policy: "silent",
      reply_target_source: "none",
      status: "running",
      title: "Observe target",
      workspace: "/repo",
      created_at: "2026-05-06T00:00:00.000Z",
      started_at: "2026-05-06T00:01:00.000Z",
      updated_at: "2026-05-06T00:02:00.000Z",
    });

    const observe = tools.get("runs_observe")!;
    expect(observe.metadata.isReadOnly).toBe(true);
    const result = await observe.call({
      scope: "tree",
      run_id: "run:coreloop:observe-target",
      includeSessions: true,
    }, makeContext({ conversationSessionId: "root" }));

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      runs: [
        expect.objectContaining({
          id: "run:coreloop:observe-target",
          observed_run_epoch: "2026-05-06T00:02:00.000Z",
          goal_id: "goal-observe",
        }),
      ],
      sessions: [
        expect.objectContaining({
          id: "session:conversation:root",
        }),
      ],
    });
  });
});
