import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchGatewayChatInput } from "../chat-session-dispatch.js";
import { TelegramGatewayAdapter } from "../telegram-gateway-adapter.js";
import { ChatRunnerEventBridge } from "../../../interface/chat/chat-runner-event-bridge.js";
import { PluginChannelRuntimeStateStore } from "../../store/plugin-channel-runtime-state-store.js";
import { createUserVisibleSeedyTurnPresence, type SeedyTurnPresencePhase } from "../../../interface/chat/seedy-turn-presence.js";
import type { AgentLoopEvent } from "../../../orchestrator/execution/agent-loop/agent-loop-events.js";

vi.mock("../chat-session-dispatch.js", () => ({
  dispatchGatewayChatInput: vi.fn().mockResolvedValue("ok"),
}));

const tempDirs: string[] = [];
const adapters: TelegramGatewayAdapter[] = [];

beforeEach(() => {
  vi.mocked(dispatchGatewayChatInput).mockReset();
  vi.mocked(dispatchGatewayChatInput).mockResolvedValue("ok");
});

afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.stop()));
  vi.unstubAllGlobals();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 10,
  })));
});

describe("TelegramGatewayAdapter", () => {
  it("passes the Telegram message id from polling updates into gateway chat dispatch", async () => {
    const configDir = await writeConfig({
      bot_token: "test-token",
      allowed_user_ids: [42],
      denied_user_ids: [],
      allowed_chat_ids: [],
      denied_chat_ids: [],
      runtime_control_allowed_user_ids: [42],
      chat_goal_map: {},
      user_goal_map: {},
      allow_all: true,
      polling_timeout: 30,
      identity_key: "seedy",
    });
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const method = String(url).split("/").at(-1);
      if (method === "getMe") {
        return telegramResponse({ id: 1, username: "pulseed_test_bot" });
      }
      if (method === "getUpdates") {
        return telegramResponse([
          {
            update_id: 100,
            message: {
              message_id: 2718,
              from: { id: 42 },
              chat: { id: 314 },
              text: "hello",
            },
          },
        ]);
      }
      if (method === "sendMessage") {
        return telegramResponse({ message_id: 9001 });
      }
      if (method === "sendChatAction") {
        return telegramResponse(true);
      }
      throw new Error(`unexpected Telegram method: ${method}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const adapter = TelegramGatewayAdapter.fromConfigDir(configDir);
    adapters.push(adapter);
    vi.mocked(dispatchGatewayChatInput).mockImplementationOnce(async () => {
      await adapter.stop();
      return "ok";
    });

    await adapter.start();

    await vi.waitFor(() => {
      expect(dispatchGatewayChatInput).toHaveBeenCalledWith(expect.objectContaining({
        text: "hello",
        platform: "telegram",
        identity_key: "seedy",
        conversation_id: "314",
        sender_id: "42",
        message_id: "2718",
        metadata: expect.objectContaining({
          chat_id: 314,
          runtime_control_approved: true,
        }),
      }));
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/bottest-token/sendChatAction",
      expect.objectContaining({
        body: JSON.stringify({
          chat_id: 314,
          action: "typing",
        }),
      })
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/bottest-token/getUpdates",
      expect.objectContaining({
        body: JSON.stringify({
          offset: 0,
          timeout: 30,
          allowed_updates: ["message"],
        }),
      })
    );
  });

  it("starts Telegram typing around rendered output events, not received presence", async () => {
    vi.useFakeTimers();
    try {
      const configDir = await writeConfig({
        bot_token: "test-token",
        allowed_user_ids: [42],
        denied_user_ids: [],
        allowed_chat_ids: [],
        denied_chat_ids: [],
        runtime_control_allowed_user_ids: [42],
        chat_goal_map: {},
        user_goal_map: {},
        allow_all: true,
        polling_timeout: 30,
        identity_key: "seedy",
      });
      const sentChatActions: unknown[] = [];
      const sentMessages: string[] = [];
      const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const method = String(url).split("/").at(-1);
        if (method === "sendChatAction") {
          sentChatActions.push(JSON.parse(String(init?.body ?? "{}")));
          return telegramResponse(true);
        }
        if (method === "sendMessage") {
          const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
          sentMessages.push(body.text ?? "");
          return telegramResponse({ message_id: 9000 + sentMessages.length });
        }
        throw new Error(`unexpected Telegram method: ${method}`);
      });
      vi.stubGlobal("fetch", fetchMock);
      const adapter = TelegramGatewayAdapter.fromConfigDir(configDir);
      adapters.push(adapter);
      const presenceHandled = createDeferred();
      const presenceCanContinue = createDeferred();
      const commentaryHandled = createDeferred();
      const dispatchCanFinish = createDeferred();
      vi.mocked(dispatchGatewayChatInput).mockImplementationOnce(async (input) => {
        await input.onEvent?.(presenceEvent("received"));
        presenceHandled.resolve();
        await presenceCanContinue.promise;
        await input.onEvent?.({
          type: "activity",
          runId: "run-1",
          turnId: "turn-1",
          createdAt: "2026-05-10T00:00:00.500Z",
          kind: "commentary",
          message: "I'll check the request context first.",
          sourceId: "preamble:turn-1",
          presentation: { gatewayProgress: "user" },
        });
        commentaryHandled.resolve();
        await dispatchCanFinish.promise;
        await input.onEvent?.(assistantFinalEvent("Done from Telegram."));
        return "Done from Telegram.";
      });

      const processing = (adapter as unknown as {
        processMessage(text: string, fromUserId: number, chatId: number, messageId: number): Promise<void>;
      }).processMessage("hello", 42, 314, 2718);

      await presenceHandled.promise;
      expect(sentChatActions).toEqual([]);
      presenceCanContinue.resolve();

      await commentaryHandled.promise;
      expect(sentChatActions).toEqual([{ chat_id: 314, action: "typing" }]);

      await vi.advanceTimersByTimeAsync(4_000);
      expect(sentChatActions).toHaveLength(1);

      dispatchCanFinish.resolve();
      await processing;
      await vi.advanceTimersByTimeAsync(4_000);

      expect(sentChatActions).toHaveLength(2);
      expect(sentMessages).toContain("Done from Telegram.");
      expect(sentMessages).not.toContain("Received.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops Telegram typing even when fallback final delivery fails", async () => {
    vi.useFakeTimers();
    try {
      const configDir = await writeConfig({
        bot_token: "test-token",
        allowed_user_ids: [42],
        denied_user_ids: [],
        allowed_chat_ids: [],
        denied_chat_ids: [],
        runtime_control_allowed_user_ids: [42],
        chat_goal_map: {},
        user_goal_map: {},
        allow_all: true,
        polling_timeout: 30,
        identity_key: "seedy",
      });
      const sentChatActions: unknown[] = [];
      const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const method = String(url).split("/").at(-1);
        if (method === "sendChatAction") {
          sentChatActions.push(JSON.parse(String(init?.body ?? "{}")));
          return telegramResponse(true);
        }
        if (method === "sendMessage") {
          return {
            ok: false,
            status: 500,
            statusText: "failed",
            json: async () => ({ ok: false }),
            text: async () => "failed",
          } as Response;
        }
        throw new Error(`unexpected Telegram method: ${method}`);
      });
      vi.stubGlobal("fetch", fetchMock);
      const adapter = TelegramGatewayAdapter.fromConfigDir(configDir);
      adapters.push(adapter);
      vi.mocked(dispatchGatewayChatInput).mockResolvedValueOnce("fallback final");

      await expect((adapter as unknown as {
        processMessage(text: string, fromUserId: number, chatId: number, messageId: number): Promise<void>;
      }).processMessage("hello", 42, 314, 2718)).rejects.toThrow("telegram-api: sendMessage returned 500");

      expect(sentChatActions).toEqual([{ chat_id: 314, action: "typing" }]);

      await vi.advanceTimersByTimeAsync(4_000);

      expect(sentChatActions).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not start Telegram typing for operation progress the Telegram adapter drops", async () => {
    vi.useFakeTimers();
    try {
      const configDir = await writeConfig({
        bot_token: "test-token",
        allowed_user_ids: [42],
        denied_user_ids: [],
        allowed_chat_ids: [],
        denied_chat_ids: [],
        runtime_control_allowed_user_ids: [42],
        chat_goal_map: {},
        user_goal_map: {},
        allow_all: true,
        polling_timeout: 30,
        identity_key: "seedy",
      });
      const sentChatActions: unknown[] = [];
      const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const method = String(url).split("/").at(-1);
        if (method === "sendChatAction") {
          sentChatActions.push(JSON.parse(String(init?.body ?? "{}")));
          return telegramResponse(true);
        }
        if (method === "sendMessage") return telegramResponse({ message_id: 9001 });
        throw new Error(`unexpected Telegram method: ${method}`);
      });
      vi.stubGlobal("fetch", fetchMock);
      const adapter = TelegramGatewayAdapter.fromConfigDir(configDir);
      adapters.push(adapter);
      const summaryHandled = createDeferred();
      const dispatchCanFinish = createDeferred();
      vi.mocked(dispatchGatewayChatInput).mockImplementationOnce(async (input) => {
        await input.onEvent?.({
          type: "operation_progress",
          runId: "run-1",
          turnId: "turn-1",
          createdAt: "2026-05-10T00:00:00.000Z",
          item: {
            id: "operation-progress:summary-1",
            kind: "completed",
            operation: "agent_loop",
            title: "Agent-loop activity summarized",
            createdAt: "2026-05-10T00:00:00.000Z",
            metadata: { source: "agent_timeline_activity_summary" },
          },
        });
        summaryHandled.resolve();
        await dispatchCanFinish.promise;
        await input.onEvent?.(assistantFinalEvent("Done from Telegram."));
        return "Done from Telegram.";
      });

      const processing = (adapter as unknown as {
        processMessage(text: string, fromUserId: number, chatId: number, messageId: number): Promise<void>;
      }).processMessage("hello", 42, 314, 2718);

      await summaryHandled.promise;
      expect(sentChatActions).toEqual([]);

      dispatchCanFinish.resolve();
      await processing;

      expect(sentChatActions).toEqual([{ chat_id: 314, action: "typing" }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("logs and suppresses Telegram native typing failures from presence projection", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const configDir = await writeConfig({
        bot_token: "test-token",
        allowed_user_ids: [42],
        denied_user_ids: [],
        allowed_chat_ids: [],
        denied_chat_ids: [],
        runtime_control_allowed_user_ids: [42],
        chat_goal_map: {},
        user_goal_map: {},
        allow_all: true,
        polling_timeout: 30,
        identity_key: "seedy",
      });
      const sentMessages: string[] = [];
      const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
        const method = String(url).split("/").at(-1);
        if (method === "sendChatAction") return telegramErrorResponse(500, "typing unavailable");
        if (method === "sendMessage") {
          const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
          sentMessages.push(body.text ?? "");
          return telegramResponse({ message_id: 9000 + sentMessages.length });
        }
        throw new Error(`unexpected Telegram method: ${method}`);
      });
      vi.stubGlobal("fetch", fetchMock);
      const adapter = TelegramGatewayAdapter.fromConfigDir(configDir);
      adapters.push(adapter);
      vi.mocked(dispatchGatewayChatInput).mockImplementationOnce(async (input) => {
        await input.onEvent?.(presenceEvent("received"));
        await input.onEvent?.(assistantFinalEvent("Typing failed, but the turn completed."));
        return "Typing failed, but the turn completed.";
      });

      await (adapter as unknown as {
        processMessage(text: string, fromUserId: number, chatId: number, messageId: number): Promise<void>;
      }).processMessage("hello", 42, 314, 2718);

      expect(warn).toHaveBeenCalledWith(
        "TelegramGatewayAdapter: typing indicator failed",
        expect.any(Error)
      );
      expect(sentMessages).toContain("Typing failed, but the turn completed.");
    } finally {
      warn.mockRestore();
    }
  });

  it("does not coerce malformed typing conversation ids into Telegram chat ids", async () => {
    const configDir = await writeConfig({
      bot_token: "test-token",
      allowed_user_ids: [42],
      denied_user_ids: [],
      allowed_chat_ids: [],
      denied_chat_ids: [],
      runtime_control_allowed_user_ids: [42],
      chat_goal_map: {},
      user_goal_map: {},
      allow_all: true,
      polling_timeout: 30,
    });
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const method = String(url).split("/").at(-1);
      if (method === "sendChatAction") return telegramResponse(true);
      throw new Error(`unexpected Telegram method: ${method}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const adapter = TelegramGatewayAdapter.fromConfigDir(configDir);
    adapters.push(adapter);

    const malformedSession = await adapter.typingIndicator.start({
      platform: "telegram",
      conversation_id: "0x13a",
    });
    await malformedSession.stop();
    expect(fetchMock).not.toHaveBeenCalled();

    const unsafeSession = await adapter.typingIndicator.start({
      platform: "telegram",
      conversation_id: "9007199254740993",
    });
    await unsafeSession.stop();
    expect(fetchMock).not.toHaveBeenCalled();

    const validSession = await adapter.typingIndicator.start({
      platform: "telegram",
      conversation_id: "-100314",
    });
    await validSession.stop();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/bottest-token/sendChatAction",
      expect.objectContaining({
        body: JSON.stringify({
          chat_id: -100314,
          action: "typing",
        }),
      })
    );
  });

  it("renders operation progress events before the final Telegram reply", async () => {
    const configDir = await writeConfig({
      bot_token: "test-token",
      allowed_user_ids: [42],
      denied_user_ids: [],
      allowed_chat_ids: [],
      denied_chat_ids: [],
      runtime_control_allowed_user_ids: [42],
      chat_goal_map: {},
      user_goal_map: {},
      allow_all: true,
      polling_timeout: 30,
      identity_key: "seedy",
    });
    const sentMessages: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const method = String(url).split("/").at(-1);
      if (method === "getMe") {
        return telegramResponse({ id: 1, username: "pulseed_test_bot" });
      }
      if (method === "getUpdates") {
        return telegramResponse([
          {
            update_id: 100,
            message: {
              message_id: 2718,
              from: { id: 42 },
              chat: { id: 314 },
              text: "telegram setup",
            },
          },
        ]);
      }
      if (method === "sendMessage") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
        sentMessages.push(body.text ?? "");
        return telegramResponse({ message_id: 9000 + sentMessages.length });
      }
      if (method === "editMessageText") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
        sentMessages.push(body.text ?? "");
        return telegramResponse({ message_id: 9100 + sentMessages.length });
      }
      if (method === "sendChatAction") {
        return telegramResponse(true);
      }
      throw new Error(`unexpected Telegram method: ${method}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const adapter = TelegramGatewayAdapter.fromConfigDir(configDir);
    adapters.push(adapter);
    vi.mocked(dispatchGatewayChatInput).mockImplementationOnce(async (input) => {
      await input.onEvent?.({
        type: "lifecycle_start",
        runId: "run-1",
        turnId: "turn-1",
        createdAt: "2026-04-08T00:00:00.000Z",
        input: "telegram setup",
      });
      await input.onEvent?.({
        type: "operation_progress",
        runId: "run-1",
        turnId: "turn-1",
        createdAt: "2026-04-08T00:00:01.000Z",
        item: {
          id: "telegram-configure:read-config",
          kind: "read_config",
          operation: "telegram_setup",
          title: "Read Telegram config",
          detail: "Config file does not exist yet.",
          createdAt: "2026-04-08T00:00:01.000Z",
        },
      });
      await input.onEvent?.({
        type: "assistant_final",
        runId: "run-1",
        turnId: "turn-1",
        createdAt: "2026-04-08T00:00:02.000Z",
        text: "Final setup guidance.",
        persisted: true,
      });
      await adapter.stop();
      return "Final setup guidance.";
    });

    await adapter.start();

    await vi.waitFor(() => {
      expect(sentMessages.some((message) => message.includes("Checking telegram setup so I can verify the current configuration."))).toBe(true);
      expect(sentMessages).toContain("Final setup guidance.");
    });
    expect(sentMessages.filter((message) => message === "Final setup guidance.")).toHaveLength(1);
  });

  it("records dogfood-safe Telegram timing for polling, typing, progress, and final outbound calls", async () => {
    const configDir = await writeConfig({
      bot_token: "test-token",
      allowed_user_ids: [42],
      denied_user_ids: [],
      allowed_chat_ids: [],
      denied_chat_ids: [],
      runtime_control_allowed_user_ids: [42],
      chat_goal_map: {},
      user_goal_map: {},
      allow_all: true,
      polling_timeout: 30,
      identity_key: "seedy",
    });
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const method = String(url).split("/").at(-1);
      if (method === "getMe") return telegramResponse({ id: 1, username: "pulseed_test_bot" });
      if (method === "getUpdates") {
        return telegramResponse([{
          update_id: 100,
          message: { message_id: 2718, from: { id: 42 }, chat: { id: 314 }, text: "check README" },
        }]);
      }
      if (method === "sendMessage") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
        return telegramResponse({ message_id: body.text?.startsWith("Checking") ? 9001 : 9002 });
      }
      if (method === "editMessageText") return telegramResponse(true);
      if (method === "sendChatAction") return telegramResponse(true);
      throw new Error(`unexpected Telegram method: ${method}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const adapter = TelegramGatewayAdapter.fromConfigDir(configDir);
    adapters.push(adapter);
    vi.mocked(dispatchGatewayChatInput).mockImplementationOnce(async (input) => {
      await input.onEvent?.({
        type: "operation_progress",
        runId: "run-1",
        turnId: "turn-1",
        createdAt: "2026-04-08T00:00:01.000Z",
        item: {
          id: "workspace:readme-check",
          kind: "read_file",
          operation: "workspace_inspection",
          title: "Check README",
          detail: "Checking whether the workspace has a README.",
          createdAt: "2026-04-08T00:00:01.000Z",
        },
      });
      await input.onEvent?.({
        type: "assistant_final",
        runId: "run-1",
        turnId: "turn-1",
        createdAt: "2026-04-08T00:00:02.000Z",
        text: "README exists.",
        persisted: true,
      });
      await adapter.stop();
      return "README exists.";
    });

    await adapter.start();

    const store = new PluginChannelRuntimeStateStore(configDir);
    const channelName = path.basename(configDir);
    await vi.waitFor(async () => {
      const health = await store.loadChannelHealth(channelName);
      expect(health?.last_timing).toMatchObject({
        schema_version: "gateway-channel-timing-v1",
        channel: "telegram",
        poll: {
          offset: 0,
          timeout_seconds: 30,
          update_count: 1,
          ok: true,
        },
        turn: {
          update_id: 100,
          message_id: 2718,
          turn_ref: "telegram:message:2718",
          inbound_admitted_at: expect.any(String),
          first_typing_at: expect.any(String),
          first_progress_at: expect.any(String),
          first_final_at: expect.any(String),
          lifecycle_end_at: expect.any(String),
          outbound_calls: expect.arrayContaining([
            expect.objectContaining({ kind: "typing", ok: true, duration_ms: expect.any(Number) }),
            expect.objectContaining({ kind: "progress_send", ok: true, duration_ms: expect.any(Number) }),
            expect.objectContaining({ kind: "final_send", ok: true, duration_ms: expect.any(Number) }),
          ]),
        },
      });
    });
    const health = await store.loadChannelHealth(channelName);
    const serializedTiming = JSON.stringify(health?.last_timing);
    expect(serializedTiming).not.toContain("test-token");
    expect(serializedTiming).not.toContain("check README");
    expect(serializedTiming).not.toContain("README exists.");
  });

  it("keeps Telegram delivery successful when timing persistence fails", async () => {
    const configDir = await writeConfig({
      bot_token: "test-token",
      allowed_user_ids: [42],
      denied_user_ids: [],
      allowed_chat_ids: [],
      denied_chat_ids: [],
      runtime_control_allowed_user_ids: [42],
      chat_goal_map: {},
      user_goal_map: {},
      allow_all: true,
      polling_timeout: 30,
      identity_key: "seedy",
    });
    const sentMessages: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const method = String(url).split("/").at(-1);
      if (method === "sendMessage") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
        sentMessages.push(body.text ?? "");
        return telegramResponse({ message_id: 9000 + sentMessages.length });
      }
      if (method === "sendChatAction") return telegramResponse(true);
      throw new Error(`unexpected Telegram method: ${method}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const failingTimingStore = new TimingFailingStore(configDir);
    const adapter = new TelegramGatewayAdapter(configDir, {
      bot_token: "test-token",
      allowed_user_ids: [42],
      denied_user_ids: [],
      allowed_chat_ids: [],
      denied_chat_ids: [],
      runtime_control_allowed_user_ids: [42],
      chat_goal_map: {},
      user_goal_map: {},
      allow_all: true,
      polling_timeout: 30,
      identity_key: "seedy",
    }, { runtimeStateStore: failingTimingStore });
    adapters.push(adapter);
    vi.mocked(dispatchGatewayChatInput).mockImplementationOnce(async (input) => {
      await input.onEvent?.(assistantFinalEvent("Delivered despite timing store failure."));
      return "Delivered despite timing store failure.";
    });

    await expect((adapter as unknown as {
      processMessage(text: string, fromUserId: number, chatId: number, messageId: number): Promise<void>;
    }).processMessage("hello", 42, 314, 2718)).resolves.toBeUndefined();

    expect(sentMessages).toContain("Delivered despite timing store failure.");
    expect(warnSpy).toHaveBeenCalledWith(
      "TelegramGatewayAdapter: timing instrumentation failed",
      expect.any(Error),
    );
  });

  it("does not count failed outbound attempts as first-visible timing", async () => {
    const configDir = await writeConfig({
      bot_token: "test-token",
      allowed_user_ids: [42],
      denied_user_ids: [],
      allowed_chat_ids: [],
      denied_chat_ids: [],
      runtime_control_allowed_user_ids: [42],
      chat_goal_map: {},
      user_goal_map: {},
      allow_all: true,
      polling_timeout: 30,
      identity_key: "seedy",
    });
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const method = String(url).split("/").at(-1);
      if (method === "sendChatAction") return telegramErrorResponse(500, "typing unavailable");
      if (method === "sendMessage") return telegramResponse({ message_id: 9001 });
      throw new Error(`unexpected Telegram method: ${method}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const adapter = TelegramGatewayAdapter.fromConfigDir(configDir);
    adapters.push(adapter);
    vi.mocked(dispatchGatewayChatInput).mockImplementationOnce(async (input) => {
      await input.onEvent?.(assistantFinalEvent("Final after failed typing."));
      return "Final after failed typing.";
    });

    await (adapter as unknown as {
      processMessage(text: string, fromUserId: number, chatId: number, messageId: number): Promise<void>;
    }).processMessage("hello", 42, 314, 2718);

    const store = new PluginChannelRuntimeStateStore(configDir);
    const timing = (await store.loadChannelHealth(path.basename(configDir)))?.last_timing;
    expect(timing?.turn?.first_typing_at).toBeUndefined();
    expect(timing?.turn?.first_final_at).toEqual(expect.any(String));
    expect(timing?.turn?.outbound_calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "typing", ok: false, error_class: "Error" }),
      expect.objectContaining({ kind: "final_send", ok: true }),
    ]));
    expect(warnSpy).toHaveBeenCalledWith(
      "TelegramGatewayAdapter: typing indicator failed",
      expect.any(Error),
    );
  });

  it("renders shared agent timeline events in the Telegram channel without parsing TUI transcript text", async () => {
    const configDir = await writeConfig({
      bot_token: "test-token",
      allowed_user_ids: [42],
      denied_user_ids: [],
      allowed_chat_ids: [],
      denied_chat_ids: [],
      runtime_control_allowed_user_ids: [42],
      chat_goal_map: {},
      user_goal_map: {},
      allow_all: true,
      polling_timeout: 30,
      identity_key: "seedy",
    });
    const sentMessages: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const method = String(url).split("/").at(-1);
      if (method === "getMe") return telegramResponse({ id: 1, username: "pulseed_test_bot" });
      if (method === "getUpdates") {
        return telegramResponse([{
          update_id: 100,
          message: { message_id: 2718, from: { id: 42 }, chat: { id: 314 }, text: "work on timeline" },
        }]);
      }
      if (method === "sendMessage") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
        sentMessages.push(body.text ?? "");
        return telegramResponse({ message_id: 9000 + sentMessages.length });
      }
      if (method === "editMessageText") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
        sentMessages.push(body.text ?? "");
        return telegramResponse({ message_id: 9100 + sentMessages.length });
      }
      if (method === "sendChatAction") return telegramResponse(true);
      throw new Error(`unexpected Telegram method: ${method}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const adapter = TelegramGatewayAdapter.fromConfigDir(configDir);
    adapters.push(adapter);
    vi.mocked(dispatchGatewayChatInput).mockImplementationOnce(async (input) => {
      await input.onEvent?.({
        type: "activity",
        runId: "run-1",
        turnId: "chat-turn-1",
        createdAt: "2026-04-08T00:00:00.000Z",
        kind: "commentary",
        message: "I understand the request and will inspect visible tool activity.",
        transient: false,
      });
      await input.onEvent?.({
        type: "activity",
        runId: "run-1",
        turnId: "chat-turn-1",
        createdAt: "2026-04-08T00:00:00.000Z",
        kind: "lifecycle",
        message: "Calling model...",
        transient: true,
      });
      await input.onEvent?.({
        type: "activity",
        runId: "run-1",
        turnId: "chat-turn-1",
        createdAt: "2026-04-08T00:00:00.000Z",
        kind: "checkpoint",
        message: "Working turn started: PulSeed can inspect files with visible tool activity.",
        transient: false,
      });
      const bridge = new ChatRunnerEventBridge(() => input.onEvent);
      const sink = bridge.createAgentLoopEventSink({ runId: "run-1", turnId: "chat-turn-1" });
      const emit = (event: Partial<AgentLoopEvent> & { type: AgentLoopEvent["type"]; eventId: string } & {
        createdAt?: string;
      }) => sink.emit({
        sessionId: "session-1",
        traceId: "trace-1",
        turnId: "agent-turn-1",
        goalId: "goal-1",
        createdAt: event.createdAt ?? "2026-04-08T00:00:00.000Z",
        ...event,
      } as AgentLoopEvent);

      await emit({
        type: "started",
        eventId: "started-1",
      });
      await emit({
        type: "turn_context",
        eventId: "turn-context-1",
        cwd: "/Users/yuyoshimuta/PulSeed",
        model: "openai/gpt-5.5",
        visibleTools: ["shell_command", "apply_patch"],
      });
      await emit({
        type: "model_request",
        eventId: "model-request-1",
        model: "openai/gpt-5.5",
        toolCount: 54,
      });
      await emit({
        type: "assistant_message",
        eventId: "commentary-1",
        phase: "commentary",
        contentPreview: "Reviewing the timeline path.",
        toolCallCount: 1,
      });
      await emit({
        type: "tool_call_started",
        eventId: "tool-start-1",
        callId: "call-1",
        toolName: "shell_command",
        activityCategory: "command",
        inputPreview: JSON.stringify({ command: "rg Timeline src/interface/chat" }),
      });
      await emit({
        type: "tool_call_finished",
        eventId: "tool-finish-1",
        callId: "call-1",
        toolName: "shell_command",
        activityCategory: "command",
        inputPreview: JSON.stringify({ command: "rg Timeline src/interface/chat" }),
        success: true,
        outputPreview: "src/interface/chat/chat-events.ts",
        durationMs: 12,
      });
      await emit({
        type: "approval_request",
        eventId: "approval-1",
        callId: "call-2",
        toolName: "shell_command",
        reason: "run a write command",
        permissionLevel: "execute",
        isDestructive: false,
      });
      await emit({
        type: "tool_observation",
        eventId: "observation-denied-1",
        observation: {
          type: "tool_observation",
          callId: "call-2",
          toolName: "shell_command",
          arguments: { command: "npm run release" },
          state: "denied",
          success: false,
          execution: {
            status: "not_executed",
            reason: "approval_denied",
            message: "Operator denied release execution.",
          },
          durationMs: 3,
          output: {
            content: "TOOL NOT EXECUTED (approval_denied): Operator denied release execution.",
          },
          activityCategory: "command",
        },
      });
      await emit({
        type: "context_compaction",
        eventId: "compaction-1",
        phase: "mid_turn",
        reason: "context_limit",
        inputMessages: 12,
        outputMessages: 4,
        summaryPreview: "kept timeline facts",
      });
      await emit({
        type: "final",
        eventId: "final-1",
        success: true,
        outputPreview: "Done from final.",
        createdAt: "2026-04-08T00:00:01.000Z",
      });
      await adapter.stop();
      return "Done from fallback.";
    });

    await adapter.start();

    await vi.waitFor(() => {
      const renderedProgress = sentMessages.join("\n");
      expect(renderedProgress).toContain("Running the tool-backed step so I can gather the result needed for the next step.");
      expect(renderedProgress).toContain("Finalizing the tool-backed step so I can gather the result needed for the next step.");
      expect(renderedProgress).toContain("Approval is needed for a tool action: run a write command.");
      expect(renderedProgress).toContain("Blocked on the requested tool action: Operator denied release execution.");
      expect(renderedProgress).toContain("Finalizing completed tool activity so I can keep the final response grounded in verified work.");
    });
    expect(sentMessages.join("\n")).not.toContain("Approval is needed for the requested tool action");
    expect(sentMessages.some((message) => message.includes("[tool]"))).toBe(false);
    expect(sentMessages.join("\n")).not.toContain("rg Timeline src/interface/chat");
    expect(sentMessages.join("\n")).not.toContain("src/interface/chat/chat-events.ts");
    expect(sentMessages.join("\n")).not.toContain("TOOL NOT EXECUTED");
    expect(sentMessages.join("\n")).not.toContain("I understand the request");
    expect(sentMessages.join("\n")).not.toContain("Calling model");
    expect(sentMessages.join("\n")).not.toContain("Working turn started");
    expect(sentMessages.join("\n")).not.toContain("Started work");
    expect(sentMessages.join("\n")).not.toContain("Prepared turn context");
    expect(sentMessages.join("\n")).not.toContain("openai/gpt");
    expect(sentMessages.join("\n")).not.toContain("available tool");
    expect(sentMessages.join("\n")).not.toContain("Compacted context");
    expect(sentMessages).not.toContain("Done from final.");
    expect(sentMessages).not.toContain("Done from fallback.");
    expect(sentMessages.join("\n")).not.toContain("Agent-loop activity summarized");
    expect(sentMessages.join("\n")).not.toMatch(/\b(Checkpoint|Intent|Current activity|Recent activity)\b/);
  });

  it("does not send fallback after an agent_timeline final marks assistant output", async () => {
    const configDir = await writeConfig({
      bot_token: "test-token",
      allowed_user_ids: [42],
      denied_user_ids: [],
      allowed_chat_ids: [],
      denied_chat_ids: [],
      runtime_control_allowed_user_ids: [42],
      chat_goal_map: {},
      user_goal_map: {},
      allow_all: true,
      polling_timeout: 30,
      identity_key: "seedy",
    });
    const sentMessages: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const method = String(url).split("/").at(-1);
      if (method === "getMe") return telegramResponse({ id: 1, username: "pulseed_test_bot" });
      if (method === "getUpdates") {
        return telegramResponse([{
          update_id: 100,
          message: { message_id: 2718, from: { id: 42 }, chat: { id: 314 }, text: "hello" },
        }]);
      }
      if (method === "sendMessage") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
        sentMessages.push(body.text ?? "");
        return telegramResponse({ message_id: 9000 + sentMessages.length });
      }
      if (method === "sendChatAction") return telegramResponse(true);
      throw new Error(`unexpected Telegram method: ${method}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const adapter = TelegramGatewayAdapter.fromConfigDir(configDir);
    adapters.push(adapter);
    vi.mocked(dispatchGatewayChatInput).mockImplementationOnce(async (input) => {
      void input.onEvent?.({
        type: "agent_timeline",
        runId: "run-1",
        turnId: "turn-1",
        createdAt: "2026-04-08T00:00:02.000Z",
        item: {
          id: "agent-timeline:final-1",
          sourceEventId: "final-1",
          sourceType: "final",
          sessionId: "session-1",
          traceId: "trace-1",
          turnId: "agent-turn-1",
          goalId: "goal-1",
          createdAt: "2026-04-08T00:00:02.000Z",
          visibility: "user",
          kind: "final",
          success: true,
          outputPreview: "Final timeline answer.",
        },
      });
      await adapter.stop();
      return "Fallback should not send.";
    });

    await adapter.start();
    expect(sentMessages).not.toContain("Final timeline answer.");
    expect(sentMessages).not.toContain("Fallback should not send.");

    await vi.waitFor(() => {
      expect(sentMessages).not.toContain("Fallback should not send.");
    });
  });

  it("does not send fallback while async assistant_final delivery is still draining", async () => {
    const configDir = await writeConfig({
      bot_token: "test-token",
      allowed_user_ids: [42],
      denied_user_ids: [],
      allowed_chat_ids: [],
      denied_chat_ids: [],
      runtime_control_allowed_user_ids: [42],
      chat_goal_map: {},
      user_goal_map: {},
      allow_all: true,
      polling_timeout: 30,
      identity_key: "seedy",
    });
    const finalSendStarted = createDeferred();
    const finalSendCanFinish = createDeferred();
    const sentMessages: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const method = String(url).split("/").at(-1);
      if (method === "getMe") {
        return telegramResponse({ id: 1, username: "pulseed_test_bot" });
      }
      if (method === "getUpdates") {
        return telegramResponse([
          {
            update_id: 100,
            message: {
              message_id: 2718,
              from: { id: 42 },
              chat: { id: 314 },
              text: "hello",
            },
          },
        ]);
      }
      if (method === "sendMessage") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
        sentMessages.push(body.text ?? "");
        if (body.text === "Final setup guidance.") {
          finalSendStarted.resolve();
          await finalSendCanFinish.promise;
        }
        return telegramResponse({ message_id: 9000 + sentMessages.length });
      }
      if (method === "sendChatAction") {
        return telegramResponse(true);
      }
      throw new Error(`unexpected Telegram method: ${method}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const adapter = TelegramGatewayAdapter.fromConfigDir(configDir);
    adapters.push(adapter);
    vi.mocked(dispatchGatewayChatInput).mockImplementationOnce(async (input) => {
      await input.onEvent?.({
        type: "assistant_final",
        runId: "run-1",
        turnId: "turn-1",
        createdAt: "2026-04-08T00:00:02.000Z",
        text: "Final setup guidance.",
        persisted: true,
      });
      await adapter.stop();
      return "Final setup guidance.";
    });

    await adapter.start();
    await finalSendStarted.promise;
    expect(sentMessages.filter((message) => message === "Final setup guidance.")).toHaveLength(1);
    finalSendCanFinish.resolve();

    await vi.waitFor(() => {
      expect(sentMessages.filter((message) => message === "Final setup guidance.")).toHaveLength(1);
    });
  });

  it("binds first /sethome sender without enabling runtime control", async () => {
    const configDir = await writeConfig({
      bot_token: "test-token",
      allowed_user_ids: [],
      denied_user_ids: [],
      allowed_chat_ids: [],
      denied_chat_ids: [],
      runtime_control_allowed_user_ids: [],
      chat_goal_map: {},
      user_goal_map: {},
      allow_all: false,
      polling_timeout: 30,
    });
    const sentMessages: string[] = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const method = String(url).split("/").at(-1);
      if (method === "getMe") return telegramResponse({ id: 1, username: "pulseed_test_bot" });
      if (method === "getUpdates") {
        return telegramResponse([{
          update_id: 100,
          message: { message_id: 2718, from: { id: 42 }, chat: { id: 314 }, text: "/sethome" },
        }]);
      }
      if (method === "sendMessage") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
        sentMessages.push(body.text ?? "");
        await adapter.stop();
        return telegramResponse({ message_id: 9001 });
      }
      throw new Error(`unexpected Telegram method: ${method}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const adapter = TelegramGatewayAdapter.fromConfigDir(configDir);
    adapters.push(adapter);

    await adapter.start();

    await vi.waitFor(async () => {
      const config = JSON.parse(await fs.readFile(path.join(configDir, "config.json"), "utf-8")) as Record<string, unknown>;
      expect(config).toMatchObject({
        allowed_user_ids: [],
        runtime_control_allowed_user_ids: [],
        allow_all: false,
      });
      expect(config["chat_id"]).toBeUndefined();
      const store = new PluginChannelRuntimeStateStore(configDir);
      const channelName = path.basename(configDir);
      await expect(store.loadChannelBinding(channelName)).resolves.toMatchObject({
        home_target_id: "314",
        first_bound_actor_id: "42",
      });
      await expect(store.loadChannelHealth(channelName)).resolves.toMatchObject({
        last_outbound_at: expect.any(String),
        last_error: null,
      });
      await expect(fs.access(path.join(configDir, "health.json"))).rejects.toThrow();
    });
    expect(dispatchGatewayChatInput).not.toHaveBeenCalled();
    expect(sentMessages[0]).toContain("Runtime control still requires its own allow list.");
  });
});

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function presenceEvent(phase: SeedyTurnPresencePhase) {
  return {
    type: "presence_update" as const,
    runId: "run-1",
    turnId: "turn-1",
    createdAt: "2026-05-10T00:00:00.000Z",
    presence: createUserVisibleSeedyTurnPresence({
      turn_id: "turn-1",
      phase,
      started_at: "2026-05-10T00:00:00.000Z",
      updated_at: "2026-05-10T00:00:00.000Z",
    }),
  };
}

function assistantFinalEvent(text: string) {
  return {
    type: "assistant_final" as const,
    runId: "run-1",
    turnId: "turn-1",
    createdAt: "2026-05-10T00:00:01.000Z",
    text,
    persisted: true,
  };
}

async function writeConfig(config: Record<string, unknown>): Promise<string> {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "pulseed-telegram-gateway-"));
  tempDirs.push(configDir);
  await fs.writeFile(path.join(configDir, "config.json"), JSON.stringify(config), "utf-8");
  return configDir;
}

function telegramResponse(result: unknown): Response {
  return {
    ok: true,
    json: async () => ({ ok: true, result }),
  } as Response;
}

function telegramErrorResponse(status: number, body: string): Response {
  return {
    ok: false,
    status,
    text: async () => body,
  } as Response;
}

class TimingFailingStore extends PluginChannelRuntimeStateStore {
  override async saveChannelHealth(
    channelName: string,
    update: Parameters<PluginChannelRuntimeStateStore["saveChannelHealth"]>[1],
  ): ReturnType<PluginChannelRuntimeStateStore["saveChannelHealth"]> {
    if (update.last_timing !== undefined) {
      throw new Error("timing store unavailable");
    }
    return super.saveChannelHealth(channelName, update);
  }
}
