import { describe, it, expect, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod/v3";
import { CrossPlatformChatSessionManager } from "../cross-platform-session.js";
import type { CrossPlatformChatSessionOptions } from "../cross-platform-session.js";
import type { ChatRunnerDeps } from "../chat-runner-contracts.js";
import { ApprovalBroker } from "../../../runtime/approval-broker.js";
import { RuntimeControlService } from "../../../runtime/control/index.js";
import { ApprovalStore } from "../../../runtime/store/approval-store.js";
import { PermissionGrantStore } from "../../../runtime/store/permission-grant-store.js";
import type { StateManager } from "../../../base/state/state-manager.js";
import type { IAdapter, AgentResult } from "../../../orchestrator/execution/adapter-layer.js";
import { createMockLLMClient, createSingleMockLLMClient } from "../../../../tests/helpers/mock-llm.js";
import { makeTempDir, cleanupTempDir } from "../../../../tests/helpers/temp-dir.js";
import { StateManager as RealStateManager } from "../../../base/state/state-manager.js";
import type { LLMMessage } from "../../../base/llm/llm-client.js";
import { createSetupRuntimeControlTools } from "../../../tools/runtime/SetupRuntimeControlTools.js";
import type { ApprovalRequest, ITool, ToolCallContext, ToolResult } from "../../../tools/types.js";
import { ToolRegistry } from "../../../tools/registry.js";
import { ReadTool } from "../../../tools/fs/ReadTool/ReadTool.js";
import { AskHumanTool } from "../../../tools/interaction/AskHumanTool/AskHumanTool.js";
import type { ChatEvent } from "../chat-events.js";
import {
  buildExternalSurfaceDecision,
  evaluateChannelAccess,
  resolveChannelRoute,
} from "../../../runtime/gateway/channel-policy.js";
import { ChatSessionCatalog } from "../chat-session-store.js";
import { ChatSessionDataStore } from "../chat-session-data-store.js";
import { createRunSpecStore } from "../../../runtime/run-spec/index.js";
import type { RunSpec } from "../../../runtime/run-spec/index.js";
import { selectGatewayModelLoopTools } from "../chat-runner-routes.js";

vi.mock("../../../platform/observation/context-provider.js", () => ({
  resolveGitRoot: (cwd: string) => cwd,
  buildChatContext: (_task: string, cwd: string) => Promise.resolve(`Working directory: ${cwd}`),
}));

const CANNED_RESULT: AgentResult = {
  success: true,
  output: "Task completed successfully.",
  error: null,
  exit_code: 0,
  elapsed_ms: 50,
  stopped_reason: "completed",
};

async function storedRunSpecs(baseDir: string): Promise<RunSpec[]> {
  const store = createRunSpecStore({ getBaseDir: () => baseDir });
  return store.list();
}

function makeMockAdapter(result: AgentResult = CANNED_RESULT): IAdapter {
  return {
    adapterType: "mock",
    execute: vi.fn().mockResolvedValue(result),
  } as unknown as IAdapter;
}

function makeMockStateManager(): StateManager {
  return {
    writeRaw: vi.fn().mockResolvedValue(undefined),
    readRaw: vi.fn().mockResolvedValue(null),
  } as unknown as StateManager;
}

function makeGatewayReadTool(): ITool {
  return {
    metadata: {
      name: "read",
      aliases: [],
      permissionLevel: "read_only",
      isReadOnly: true,
      isDestructive: false,
      shouldDefer: false,
      alwaysLoad: true,
      maxConcurrency: 0,
      maxOutputChars: 8000,
      tags: ["read"],
      activityCategory: "read",
      gatewayExposure: "default_safe",
    },
    inputSchema: z.object({}),
    description: () => "Check whether the current repository has a README.",
    call: vi.fn().mockResolvedValue({
      success: true,
      data: { readme_exists: true, path: "README.md" },
      summary: "README.md exists.",
      durationMs: 1,
    }),
    checkPermissions: vi.fn().mockResolvedValue({ status: "allowed" }),
    isConcurrencySafe: () => true,
  };
}

function makeGatewayRuntimeStatusTool(): ITool {
  return {
    metadata: {
      name: "get_runtime_status",
      aliases: [],
      permissionLevel: "read_only",
      isReadOnly: true,
      isDestructive: false,
      shouldDefer: false,
      alwaysLoad: true,
      maxConcurrency: 0,
      maxOutputChars: 8000,
      tags: ["runtime", "status"],
      activityCategory: "read",
      gatewayExposure: "runtime_control",
    },
    inputSchema: z.object({}),
    description: () => "Read PulSeed runtime status.",
    call: vi.fn().mockResolvedValue({
      success: true,
      data: { daemon: "idle" },
      summary: "PulSeed daemon is idle.",
      durationMs: 1,
    }),
    checkPermissions: vi.fn().mockResolvedValue({ status: "allowed" }),
    isConcurrencySafe: () => true,
  };
}

function makeScopedTool(name: string, overrides: Partial<ITool["metadata"]> = {}): ITool {
  const permissionLevel = overrides.permissionLevel ?? "read_only";
  const isReadOnly = overrides.isReadOnly ?? permissionLevel === "read_only";
  const gatewayExposure = overrides.gatewayExposure
    ?? (isReadOnly && permissionLevel === "read_only" && !overrides.isDestructive
      ? "default_safe"
      : "never");
  return {
    metadata: {
      name,
      aliases: [],
      permissionLevel,
      isReadOnly,
      isDestructive: overrides.isDestructive ?? !isReadOnly,
      shouldDefer: overrides.shouldDefer ?? false,
      alwaysLoad: overrides.alwaysLoad ?? false,
      maxConcurrency: overrides.maxConcurrency ?? 0,
      maxOutputChars: overrides.maxOutputChars ?? 8000,
      tags: overrides.tags ?? [],
      gatewayExposure,
      ...(overrides.activityCategory ? { activityCategory: overrides.activityCategory } : {}),
    },
    inputSchema: z.object({}).passthrough(),
    description: () => `${name} test tool`,
    call: vi.fn().mockResolvedValue({
      success: true,
      data: { ok: true },
      summary: `${name} ran`,
      durationMs: 1,
    }),
    checkPermissions: vi.fn().mockResolvedValue({ status: "allowed" }),
    isConcurrencySafe: () => true,
  };
}

function makeRegistryWithTools(tools: ITool[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of tools) registry.register(tool);
  return registry;
}

function makeDeps(overrides: Partial<ChatRunnerDeps> = {}): ChatRunnerDeps {
  return {
    stateManager: makeMockStateManager(),
    adapter: makeMockAdapter(),
    ...overrides,
  };
}

function makeStreamingLLMClient(responses: Array<{
  content: string;
  stop_reason?: "end_turn" | "tool_calls";
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}>) {
  const sendMessageStream = vi.fn();
  for (const response of responses) {
    sendMessageStream.mockResolvedValueOnce({
      content: response.content,
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: response.stop_reason ?? "end_turn",
      tool_calls: response.tool_calls ?? [],
    });
  }
  return {
    sendMessage: vi.fn().mockRejectedValue(new Error("unexpected non-stream model request")),
    sendMessageStream,
    supportsToolCalling: vi.fn(() => true),
    parseJSON: vi.fn((content: string, schema: { parse(value: unknown): unknown }) => schema.parse(JSON.parse(content))),
  };
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function interruptDecision(kind: "diff" | "review" | "summary" | "background" | "redirect" | "unknown", confidence = 0.93): string {
  return JSON.stringify({ kind, confidence, rationale: `test ${kind}` });
}

describe("CrossPlatformChatSessionManager", () => {
  it("keeps gateway long-running requests in the default model loop even without a tool registry", async () => {
    const baseDir = makeTempDir();
    try {
      const stateManager = new RealStateManager(baseDir, undefined, { walEnabled: false });
      const adapter = makeMockAdapter();
      const chatAgentLoopRunner = { execute: vi.fn().mockResolvedValue(CANNED_RESULT) };
      const llmClient = createMockLLMClient(["Default gateway loop handled the long-running request."]);
      const manager = new CrossPlatformChatSessionManager(makeDeps({
        stateManager,
        adapter,
        llmClient,
        chatAgentLoopRunner: chatAgentLoopRunner as never,
      }));

      const result = await manager.execute("Please keep improving this Kaggle run until score exceeds 0.98.", {
        identity_key: "telegram:user-1",
        platform: "telegram",
        conversation_id: "telegram-chat-1",
        user_id: "user-1",
        message_id: "message-1",
        cwd: "/repo/kaggle",
        metadata: { gateway_message: true },
      });

      expect(result.success).toBe(true);
      expect(result.output).toBe("Default gateway loop handled the long-running request.");
      expect(adapter.execute).not.toHaveBeenCalled();
      expect(chatAgentLoopRunner.execute).not.toHaveBeenCalled();
      await expect(storedRunSpecs(baseDir)).resolves.toHaveLength(0);
    } finally {
      cleanupTempDir(baseDir);
    }
  });

  it("does not run freeform RunSpec/configuration classifiers before the gateway model loop", async () => {
    const baseDir = makeTempDir();
    try {
      const stateManager = new RealStateManager(baseDir, undefined, { walEnabled: false });
      const adapter = makeMockAdapter();
      const llmClient = {
        sendMessage: vi.fn().mockResolvedValue({
          content: "The default model loop handled this request.",
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: "end_turn",
        }),
        parseJSON: vi.fn((content: string, schema: { parse(value: unknown): unknown }) => schema.parse(JSON.parse(content))),
      };
      const manager = new CrossPlatformChatSessionManager(makeDeps({
        stateManager,
        adapter,
        llmClient: llmClient as never,
      }));

      const result = await manager.execute("DurableloopのほうでKaggleのタスクに取り組んで", {
        identity_key: "telegram:user-1",
        channel: "plugin_gateway",
        platform: "telegram",
        conversation_id: "telegram-chat-1",
        cwd: "/repo/kaggle",
        runtimeControl: {
          allowed: true,
          approvalMode: "interactive",
        },
      });

      expect(result.success).toBe(true);
      expect(result.output).toBe("The default model loop handled this request.");
      expect(adapter.execute).not.toHaveBeenCalled();
      expect(llmClient.sendMessage).toHaveBeenCalledTimes(1);
      const [, options] = llmClient.sendMessage.mock.calls[0]!;
      expect(String(options?.system ?? "")).toContain("gateway chat surface");
      expect(String(options?.system ?? "")).not.toContain("Classify the user's chat request");
      await expect(storedRunSpecs(baseDir)).resolves.toHaveLength(0);
    } finally {
      cleanupTempDir(baseDir);
    }
  });

  it("routes token-only setup follow-up through typed secret intake instead of adapter execution", async () => {
    const token = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";
    const stateManager = makeMockStateManager();
    const adapter = makeMockAdapter();
    const llmClient = createMockLLMClient([
      "unused model response",
    ]);
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager,
      adapter,
      llmClient,
    }));

    const result = await manager.execute(token, {
      identity_key: "telegram:user-1",
      platform: "telegram",
      conversation_id: "telegram-chat-1",
      user_id: "user-1",
      cwd: "/repo",
      metadata: { runtime_control_approved: true },
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("I received a Telegram bot token");
    expect(result.output).not.toContain(token);
    expect(adapter.execute).not.toHaveBeenCalled();
    expect(JSON.stringify((stateManager.writeRaw as ReturnType<typeof vi.fn>).mock.calls)).not.toContain(token);
  });

  it("fails ordinary gateway chat explicitly when the direct model loop has no LLM instead of falling back to legacy routes", async () => {
    const adapter = makeMockAdapter();
    const chatAgentLoopRunner = { execute: vi.fn().mockResolvedValue(CANNED_RESULT) };
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      adapter,
      chatAgentLoopRunner: chatAgentLoopRunner as never,
    }));

    const result = await manager.execute("普通に会話して", {
      identity_key: "telegram:no-llm",
      platform: "telegram",
      conversation_id: "telegram-no-llm",
      user_id: "user-1",
      cwd: "/repo",
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("no language model client is configured");
    expect(adapter.execute).not.toHaveBeenCalled();
    expect(chatAgentLoopRunner.execute).not.toHaveBeenCalled();
  });

  it("fails closed before gateway tool catalog use when the provider cannot preserve native tool transcripts", async () => {
    const readTool = makeGatewayReadTool();
    const llmClient = {
      sendMessageStream: vi.fn().mockResolvedValue({
        content: "This provider should not receive the gateway tool catalog.",
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: "end_turn",
        tool_calls: [],
      }),
      supportsToolCalling: vi.fn(() => false),
      parseJSON: vi.fn(),
    };
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      llmClient: llmClient as never,
      registry: makeRegistryWithTools([readTool]),
    }));

    const result = await manager.execute("README を確認して", {
      identity_key: "gateway-no-native-tools-user",
      platform: "telegram",
      conversation_id: "gateway-no-native-tools",
      user_id: "user-1",
      cwd: "/repo",
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("native tool-calling support");
    expect(llmClient.sendMessageStream).not.toHaveBeenCalled();
    expect(readTool.call).not.toHaveBeenCalled();
  });

  it("reuses the same ChatRunner session for the same identity_key across platforms", async () => {
    const stateManager = makeMockStateManager();
    const llmClient = makeStreamingLLMClient([
      { content: "Slack gateway reply." },
      { content: "Discord gateway reply." },
    ]);
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager,
      llmClient: llmClient as never,
      registry: makeRegistryWithTools([]),
    }));
    const events: string[] = [];

    const first = await manager.execute("hello from slack", {
      identity_key: "user-123",
      platform: "slack",
      conversation_id: "conv-1",
      user_id: "user-a",
      cwd: "/repo",
      onEvent: (event) => {
        events.push(event.type);
      },
    });

    const second = await manager.execute("hello from discord", {
      identity_key: "user-123",
      platform: "discord",
      conversation_id: "thread-9",
      user_id: "user-a",
      cwd: "/repo",
    });

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);

    const sessions = await new ChatSessionCatalog(stateManager).listSessions();
    expect(new Set(sessions.map((session) => session.id)).size).toBe(1);

    const info = manager.getSessionInfo({ identity_key: "user-123" } satisfies CrossPlatformChatSessionOptions);
    expect(info).not.toBeNull();
    expect(info?.identity_key).toBe("user-123");
    expect(info?.platform).toBe("slack");
    expect(info?.conversation_id).toBe("conv-1");
    expect(info?.cwd).toBe("/repo");
    expect(info?.metadata).toMatchObject({
      channel: "plugin_gateway",
      platform: "discord",
      conversation_id: "thread-9",
      user_id: "user-a",
    });
    expect(info?.active_reply_target).toMatchObject({
      surface: "gateway",
      platform: "discord",
      conversation_id: "thread-9",
      identity_key: "user-123",
      user_id: "user-a",
    });

    expect(events).toContain("lifecycle_start");
    expect(events).toContain("assistant_final");
  });

  it("keeps sessions isolated when identity_key is omitted", async () => {
    const stateManager = makeMockStateManager();
    const manager = new CrossPlatformChatSessionManager(makeDeps({ stateManager }));

    const sharedOptions: Omit<CrossPlatformChatSessionOptions, "identity_key" | "platform"> = {
      conversation_id: "conv-1",
      user_id: "user-a",
      cwd: "/repo",
    };

    await manager.execute("hello from slack", {
      ...sharedOptions,
      platform: "slack",
    });

    await manager.execute("hello from discord", {
      ...sharedOptions,
      platform: "discord",
    });

    const sessions = await new ChatSessionCatalog(stateManager).listSessions();
    expect(new Set(sessions.map((session) => session.id)).size).toBe(2);
  });

  it("streams ChatEvent updates through the per-turn callback", async () => {
    const stateManager = makeMockStateManager();
    const llmClient = {
      sendMessage: vi.fn().mockRejectedValue(new Error("sendMessage should not run")),
      sendMessageStream: vi.fn().mockImplementation(async (_messages, _options, handlers) => {
        handlers.onTextDelta?.("streamed");
        return {
          content: "streamed",
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: "end_turn",
          tool_calls: [],
        };
      }),
      supportsToolCalling: vi.fn(() => true),
      parseJSON: vi.fn((content: string, schema: { parse(value: unknown): unknown }) => schema.parse(JSON.parse(content))),
    };
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager,
      llmClient: llmClient as never,
      registry: makeRegistryWithTools([]),
    }));
    const events: Array<{ type: string; text?: string }> = [];

    const result = await manager.execute("stream this turn", {
      identity_key: "stream-user",
      platform: "web",
      conversation_id: "web-1",
      cwd: "/repo",
      onEvent: (event) => {
        events.push({ type: event.type, text: "text" in event ? event.text : undefined });
      },
    });

    expect(result.success).toBe(true);
    expect(events.length).toBeGreaterThan(0);
    expect(events.some((event) => event.type === "lifecycle_start")).toBe(true);
    expect(events.some((event) => event.type === "assistant_delta")).toBe(true);
    expect(events.some((event) => event.type === "assistant_final")).toBe(true);
    expect(events.at(-1)?.type).toBe("lifecycle_end");
  });

  it("emits multiple assistant deltas before final for a production gateway assist turn", async () => {
    const stateManager = makeMockStateManager();
    const events: ChatEvent[] = [];
    const llmClient = {
      sendMessage: vi.fn().mockResolvedValue({
        content: "unused model response",
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: "end_turn",
      }),
      sendMessageStream: vi.fn().mockImplementation(async (_messages, _options, handlers) => {
        handlers.onTextDelta?.("First sentence.");
        handlers.onTextDelta?.(" Second sentence.");
        return {
          content: "First sentence. Second sentence.",
          usage: { input_tokens: 1, output_tokens: 2 },
          stop_reason: "end_turn",
        };
      }),
      parseJSON: vi.fn((content: string, schema: { parse(value: unknown): unknown }) => schema.parse(JSON.parse(content))),
    };
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager,
      llmClient: llmClient as never,
    }));

    const result = await manager.execute("What is this project?", {
      identity_key: "stream-gateway-user",
      platform: "telegram",
      conversation_id: "telegram-chat-1",
      user_id: "user-1",
      cwd: "/repo",
      onEvent: (event) => { events.push(event); },
    });

    const finalIndex = events.findIndex((event) => event.type === "assistant_final");
    const deltaEvents = events.filter((event): event is Extract<ChatEvent, { type: "assistant_delta" }> =>
      event.type === "assistant_delta"
    );

    expect(result.success).toBe(true);
    expect(deltaEvents).toHaveLength(2);
    expect(deltaEvents.map((event) => event.delta)).toEqual(["First sentence.", " Second sentence."]);
    expect(events.findIndex((event) => event === deltaEvents[0])).toBeLessThan(finalIndex);
    expect(events.findIndex((event) => event === deltaEvents[1])).toBeLessThan(finalIndex);
    expect((events[finalIndex] as Extract<ChatEvent, { type: "assistant_final" }>).text).toBe("First sentence. Second sentence.");
  });

  it("streams a Japanese no-tool gateway assist turn through the production caller path", async () => {
    const stateManager = makeMockStateManager();
    const events: ChatEvent[] = [];
    const llmClient = {
      sendMessage: vi.fn().mockImplementation(async (_messages, options?: { system?: string }) => {
        const isRecoveryClassification = options?.system?.includes("recover or resume prior chat work");
        return {
          content: isRecoveryClassification
            ? JSON.stringify({ kind: "none", confidence: 0.99, rationale: "casual greeting" })
            : "unused model response",
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: "end_turn",
        };
      }),
      sendMessageStream: vi.fn().mockImplementation(async (_messages, _options, handlers) => {
        handlers.onTextDelta?.("やあ。");
        handlers.onTextDelta?.("元気です。");
        return {
          content: "やあ。元気です。",
          usage: { input_tokens: 1, output_tokens: 2 },
          stop_reason: "end_turn",
        };
      }),
      parseJSON: vi.fn((content: string, schema: { parse(value: unknown): unknown }) => schema.parse(JSON.parse(content))),
    };
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager,
      llmClient: llmClient as never,
    }));

    const result = await manager.execute("やあ！", {
      identity_key: "ja-stream-gateway-user",
      platform: "telegram",
      conversation_id: "telegram-chat-1",
      user_id: "user-1",
      cwd: "/repo",
      onEvent: (event) => { events.push(event); },
    });

    const deltaEvents = events.filter((event): event is Extract<ChatEvent, { type: "assistant_delta" }> =>
      event.type === "assistant_delta"
    );
    const final = events.find((event): event is Extract<ChatEvent, { type: "assistant_final" }> =>
      event.type === "assistant_final"
    );

    expect(result.success).toBe(true);
    expect(deltaEvents.map((event) => event.delta)).toEqual(["やあ。", "元気です。"]);
    expect(final?.text).toBe("やあ。元気です。");
  });

  it("uses the default gateway model/tool-choice loop for Japanese ordinary greeting without heavy agent routing", async () => {
    const events: ChatEvent[] = [];
    const surfaceContext = { platform: "telegram", senderId: "user-1", conversationId: "telegram-default-model-loop" };
    const externalSurface = buildExternalSurfaceDecision(
      surfaceContext,
      evaluateChannelAccess({ allowAll: true }, surfaceContext),
      resolveChannelRoute({ defaultGoalId: "goal-1" }, surfaceContext),
    );
    const llmClient = {
      sendMessage: vi.fn().mockResolvedValue({
        content: JSON.stringify({ verdict: "allow", reason: "ordinary greeting" }),
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: "end_turn",
      }),
      sendMessageStream: vi.fn().mockImplementation(async (_messages, _options, handlers) => {
        handlers.onTextDelta?.("やあ。");
        return {
          content: "やあ。",
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: "end_turn",
          tool_calls: [],
        };
      }),
      supportsToolCalling: vi.fn(() => true),
      parseJSON: vi.fn((content: string, schema: { parse(value: unknown): unknown }) => schema.parse(JSON.parse(content))),
    };
    const chatAgentLoopRunner = {
      execute: vi.fn().mockResolvedValue(CANNED_RESULT),
    };
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager: makeMockStateManager(),
      llmClient: llmClient as never,
      registry: makeRegistryWithTools([]),
      chatAgentLoopRunner: chatAgentLoopRunner as never,
    }));

    const result = await manager.execute("やあ！", {
      identity_key: "ja-default-gateway-model-loop-user",
      platform: "telegram",
      conversation_id: "telegram-default-model-loop",
      user_id: "user-1",
      cwd: "/repo",
      externalSurface,
      onEvent: (event) => { events.push(event); },
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe("やあ。");
    expect(chatAgentLoopRunner.execute).not.toHaveBeenCalled();
    expect(llmClient.sendMessageStream).toHaveBeenCalledTimes(1);
    expect(llmClient.sendMessage).not.toHaveBeenCalled();
    const [messages, options] = llmClient.sendMessageStream.mock.calls[0]!;
    expect(JSON.stringify(messages)).not.toContain("Working directory:");
    expect(String(options?.system ?? "")).toContain("gateway chat surface");
    expect(llmClient.sendMessage.mock.calls.some(([, callOptions]) =>
      String(callOptions?.system ?? "").includes("You classify one operator chat message for PulSeed runtime control routing")
    )).toBe(false);
    expect(events.some((event) =>
      event.type === "activity"
      && event.presentation?.gatewayNarration?.audience === "user"
    )).toBe(false);
    expect(events.some((event) =>
      event.type === "activity"
      && event.sourceId === "checkpoint:context"
    )).toBe(false);
    const firstVisible = events.find((event) =>
      event.type === "assistant_delta"
      || event.type === "assistant_final"
      || (event.type === "activity" && event.presentation?.gatewayProgress === "user")
      || (event.type === "activity" && event.presentation?.gatewayNarration?.audience === "user")
    );
    expect(firstVisible?.type).toBe("assistant_delta");
  });

  it("uses the same default gateway model/tool-choice loop for English ordinary greeting", async () => {
    const llmClient = {
      sendMessage: vi.fn().mockResolvedValue({
        content: JSON.stringify({ verdict: "allow", reason: "ordinary greeting" }),
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: "end_turn",
      }),
      sendMessageStream: vi.fn().mockResolvedValue({
        content: "Hi. What would you like to work on?",
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: "end_turn",
        tool_calls: [],
      }),
      supportsToolCalling: vi.fn(() => true),
      parseJSON: vi.fn((content: string, schema: { parse(value: unknown): unknown }) => schema.parse(JSON.parse(content))),
    };
    const chatAgentLoopRunner = { execute: vi.fn().mockResolvedValue(CANNED_RESULT) };
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      llmClient: llmClient as never,
      registry: makeRegistryWithTools([]),
      chatAgentLoopRunner: chatAgentLoopRunner as never,
    }));

    const result = await manager.execute("hey!", {
      identity_key: "en-default-gateway-model-loop-user",
      platform: "telegram",
      conversation_id: "telegram-default-model-loop-en",
      user_id: "user-1",
      cwd: "/repo",
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe("Hi. What would you like to work on?");
    expect(chatAgentLoopRunner.execute).not.toHaveBeenCalled();
    const [, options] = llmClient.sendMessageStream.mock.calls[0]!;
    expect(String(options?.system ?? "")).toContain("gateway chat surface");
  });

  it.each([
    ["Japanese", "やあ！", "やあ。"],
    ["English", "hello", "Hi."],
  ])("keeps %s ordinary approved gateway greetings on the first default model request", async (_label, input, output) => {
    const llmClient = makeStreamingLLMClient([{ content: output }]);
    const chatAgentLoopRunner = { execute: vi.fn().mockResolvedValue(CANNED_RESULT) };
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      llmClient: llmClient as never,
      registry: makeRegistryWithTools([]),
      chatAgentLoopRunner: chatAgentLoopRunner as never,
    }));

    const result = await manager.execute(input, {
      identity_key: `approved-greeting-${input}`,
      platform: "telegram",
      conversation_id: `approved-greeting-${input}`,
      user_id: "user-1",
      cwd: "/repo",
      metadata: { runtime_control_approved: true },
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe(output);
    expect(llmClient.sendMessage).not.toHaveBeenCalled();
    expect(llmClient.sendMessageStream).toHaveBeenCalledTimes(1);
    expect(chatAgentLoopRunner.execute).not.toHaveBeenCalled();
  });

  it("keeps the default gateway catalog scoped to read, search, and approval-request tools", () => {
    const tools = [
      makeScopedTool("read"),
      makeScopedTool("grep"),
      makeScopedTool("get_runtime_status", { gatewayExposure: "runtime_control" }),
      makeScopedTool("ask-human"),
      makeScopedTool("prepare_gateway_config_write", {
        permissionLevel: "write_local",
        isReadOnly: false,
        gatewayExposure: "approval_required",
      }),
      makeScopedTool("start_durable_run", { permissionLevel: "write_local", isReadOnly: false }),
      makeScopedTool("request_runtime_control", {
        permissionLevel: "write_local",
        isReadOnly: false,
        gatewayExposure: "runtime_control",
      }),
      makeScopedTool("shell", { permissionLevel: "execute", isReadOnly: false }),
    ];

    expect(selectGatewayModelLoopTools(tools).map((tool) => tool.metadata.name)).toEqual([
      "read",
      "grep",
      "ask-human",
    ]);
    expect(selectGatewayModelLoopTools(tools, { approvedWrite: true }).map((tool) => tool.metadata.name))
      .toEqual(["read", "grep", "ask-human"]);
    expect(selectGatewayModelLoopTools(tools, { approvedDurableRun: true }).map((tool) => tool.metadata.name))
      .toEqual(["read", "grep", "ask-human"]);
    expect(selectGatewayModelLoopTools(tools, { approvedExecute: true }).map((tool) => tool.metadata.name))
      .toEqual(["read", "grep", "ask-human"]);
    expect(selectGatewayModelLoopTools(tools, {
      approvedGatewayActions: [{
        toolName: "prepare_gateway_config_write",
        normalizedToolName: "prepare_gateway_config_write",
        argsFingerprint: "{}",
      }],
    }).map((tool) => tool.metadata.name))
      .toEqual(["read", "grep", "ask-human", "prepare_gateway_config_write"]);
    expect(selectGatewayModelLoopTools(tools, {
      runtimeControlAllowed: true,
      runtimeControlApprovalMode: "interactive",
    }).map((tool) => tool.metadata.name))
      .toEqual(["read", "grep", "get_runtime_status", "ask-human", "request_runtime_control"]);
  });

  it("does not expand the default gateway catalog just because an approval handler exists", async () => {
    const llmClient = makeStreamingLLMClient([{ content: "default tools only." }]);
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      llmClient: llmClient as never,
      registry: makeRegistryWithTools([
        makeScopedTool("read"),
        makeScopedTool("ask-human"),
        makeScopedTool("create_schedule", { permissionLevel: "write_local", isReadOnly: false }),
        makeScopedTool("start_durable_run", { permissionLevel: "write_local", isReadOnly: false }),
        makeScopedTool("shell", { permissionLevel: "execute", isReadOnly: false }),
      ]),
      approvalFn: vi.fn().mockResolvedValue(true),
    }));

    const result = await manager.execute("Run the approved maintenance command.", {
      identity_key: "approved-execute-user",
      platform: "telegram",
      conversation_id: "approved-execute-chat",
      user_id: "user-1",
      cwd: "/repo",
    });

    expect(result.success).toBe(true);
    const toolNames = (llmClient.sendMessageStream.mock.calls[0]?.[1]?.tools ?? [])
      .map((tool: { function: { name: string } }) => tool.function.name);
    expect(toolNames).toEqual(["read", "ask-human"]);
    expect(toolNames).not.toContain("create_schedule");
    expect(toolNames).not.toContain("start_durable_run");
    expect(toolNames).not.toContain("shell");
  });

  it("keeps preapproved gateway runtime-control scoped to runtime-control tools only", async () => {
    const llmClient = makeStreamingLLMClient([{ content: "runtime control tool is available." }]);
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      llmClient: llmClient as never,
      registry: makeRegistryWithTools([
        makeScopedTool("read"),
        makeScopedTool("request_runtime_control", {
          permissionLevel: "write_local",
          isReadOnly: false,
          gatewayExposure: "runtime_control",
        }),
        makeScopedTool("start_durable_run", { permissionLevel: "write_local", isReadOnly: false }),
        makeScopedTool("shell", { permissionLevel: "execute", isReadOnly: false }),
      ]),
    }));

    const result = await manager.execute("Run the already authorized maintenance command.", {
      identity_key: "preapproved-execute-user",
      platform: "telegram",
      conversation_id: "preapproved-execute-chat",
      user_id: "user-1",
      cwd: "/repo",
      runtimeControl: {
        allowed: true,
        approvalMode: "preapproved",
      },
    });

    expect(result.success).toBe(true);
    const toolNames = (llmClient.sendMessageStream.mock.calls[0]?.[1]?.tools ?? [])
      .map((tool: { function: { name: string } }) => tool.function.name);
    expect(toolNames).toEqual(["read", "request_runtime_control"]);
    expect(toolNames).not.toContain("start_durable_run");
    expect(toolNames).not.toContain("shell");
  });

  it("lets gateway default model-loop choose tools and uses tool evidence for the final", async () => {
    const events: ChatEvent[] = [];
    const tool = makeGatewayReadTool();
    const llmClient = {
      sendMessage: vi.fn().mockResolvedValue({
        content: JSON.stringify({ verdict: "allow", reason: "The read tool evidence supports the answer." }),
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: "end_turn",
      }),
      sendMessageStream: vi.fn()
        .mockResolvedValueOnce({
          content: "確認します。",
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: "tool_calls",
          tool_calls: [{
            id: "call-readme",
            type: "function",
            function: { name: "read", arguments: "{}" },
          }],
        })
        .mockResolvedValueOnce({
          content: "README.md はあります。",
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: "end_turn",
          tool_calls: [],
        }),
      supportsToolCalling: vi.fn(() => true),
      parseJSON: vi.fn((content: string, schema: { parse(value: unknown): unknown }) => schema.parse(JSON.parse(content))),
    };
    const chatAgentLoopRunner = { execute: vi.fn().mockResolvedValue(CANNED_RESULT) };
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      llmClient: llmClient as never,
      registry: makeRegistryWithTools([tool]),
      chatAgentLoopRunner: chatAgentLoopRunner as never,
    }));

    const result = await manager.execute("このリポジトリにREADMEがあるかだけ軽く見て", {
      identity_key: "gateway-tool-choice-user",
      platform: "telegram",
      conversation_id: "telegram-tool-choice",
      user_id: "user-1",
      cwd: "/repo",
      onEvent: (event) => { events.push(event); },
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe("README.md はあります。");
    expect(chatAgentLoopRunner.execute).not.toHaveBeenCalled();
    expect(tool.call).toHaveBeenCalledOnce();
    expect(llmClient.sendMessageStream).toHaveBeenCalledTimes(2);
    const secondMessages = llmClient.sendMessageStream.mock.calls[1]?.[0] as LLMMessage[];
    expect(secondMessages).toEqual(expect.arrayContaining([expect.objectContaining({
      role: "tool",
      tool_call_id: "call-readme",
      name: "read",
    })]));
    expect(secondMessages.some((message) =>
      message.role === "user" && message.content.includes("Tool result for read")
    )).toBe(false);
    const firstOptions = llmClient.sendMessageStream.mock.calls[0]?.[1];
    expect((firstOptions?.tools ?? []).map((item: { function: { name: string } }) => item.function.name))
      .toContain("read");
    expect(firstOptions?.system).toContain("Default gateway tool contract");
    expect(firstOptions?.system).toContain("use the relevant available tool before answering");
    expect(firstOptions?.system).toContain("Do not answer tool-available inspection requests by telling the user to run local commands");
    expect(events.some((event) => event.type === "tool_start" && event.toolName === "read")).toBe(true);
    expect(events.some((event) => event.type === "tool_end" && event.toolName === "read" && event.success)).toBe(true);
  });

  it("lets the production gateway model loop read the active PulSeed workspace when self-protection is enabled", async () => {
    const baseDir = makeTempDir();
    const workspace = makeTempDir();
    try {
      await fs.writeFile(
        path.join(workspace, "package.json"),
        JSON.stringify({
          name: "pulseed",
          scripts: {
            "smoke:gateway-direct-chat-latency": "npm run build && node dist/runtime/gateway/direct-chat-latency-smoke.js",
          },
        }),
      );
      const stateManager = new RealStateManager(baseDir, undefined, { walEnabled: false });
      const events: ChatEvent[] = [];
      const llmClient = makeStreamingLLMClient([
        {
          content: "",
          stop_reason: "tool_calls",
          tool_calls: [{
            id: "call-read-package",
            type: "function",
            function: { name: "read", arguments: JSON.stringify({ file_path: "package.json", limit: 20 }) },
          }],
        },
        {
          content: "npm run build && node dist/runtime/gateway/direct-chat-latency-smoke.js",
        },
      ]);
      const manager = new CrossPlatformChatSessionManager(makeDeps({
        stateManager,
        llmClient: llmClient as never,
        registry: makeRegistryWithTools([new ReadTool()]),
        chatAgentLoopRunner: { execute: vi.fn().mockResolvedValue(CANNED_RESULT) } as never,
      }));

      const result = await manager.execute(
        "package.json を実際に読んで、scripts の smoke:gateway-direct-chat-latency の値を文字列だけで返して",
        {
          identity_key: "gateway-real-read-user",
          platform: "telegram",
          conversation_id: "telegram-real-read",
          user_id: "user-1",
          cwd: workspace,
          onEvent: (event) => { events.push(event); },
        },
      );

      expect(result.success).toBe(true);
      expect(result.output).toBe("npm run build && node dist/runtime/gateway/direct-chat-latency-smoke.js");
      expect(events.some((event) => event.type === "tool_end" && event.toolName === "read" && event.success)).toBe(true);
      expect(events.some((event) => event.type === "tool_update" && event.status === "awaiting_approval")).toBe(false);
      expect(llmClient.sendMessageStream).toHaveBeenCalledTimes(2);
    } finally {
      cleanupTempDir(workspace);
      cleanupTempDir(baseDir);
    }
  });

  it("keeps authorized runtime status checks in the same gateway tool-choice loop", async () => {
    const events: ChatEvent[] = [];
    const tool = makeGatewayRuntimeStatusTool();
    const llmClient = makeStreamingLLMClient([
      {
        content: "",
        stop_reason: "tool_calls",
        tool_calls: [{
          id: "call-runtime-status",
          type: "function",
          function: { name: "get_runtime_status", arguments: "{}" },
        }],
      },
      {
        content: "PulSeed daemon is idle.",
      },
    ]);
    const chatAgentLoopRunner = { execute: vi.fn().mockResolvedValue(CANNED_RESULT) };
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      llmClient: llmClient as never,
      registry: makeRegistryWithTools([tool]),
      chatAgentLoopRunner: chatAgentLoopRunner as never,
    }));

    const result = await manager.execute("今のPulSeed gateway/daemon statusを見て", {
      identity_key: "gateway-runtime-status-user",
      platform: "telegram",
      conversation_id: "telegram-runtime-status",
      user_id: "user-1",
      cwd: "/repo",
      runtimeControl: {
        allowed: true,
        approvalMode: "interactive",
      },
      onEvent: (event) => { events.push(event); },
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe("PulSeed daemon is idle.");
    expect(chatAgentLoopRunner.execute).not.toHaveBeenCalled();
    expect(tool.call).toHaveBeenCalledOnce();
    expect(llmClient.sendMessage).not.toHaveBeenCalled();
    expect(llmClient.sendMessageStream).toHaveBeenCalledTimes(2);
    const firstOptions = llmClient.sendMessageStream.mock.calls[0]?.[1];
    expect((firstOptions?.tools ?? []).map((item: { function: { name: string } }) => item.function.name))
      .toContain("get_runtime_status");
    expect(firstOptions?.system).toContain("Default gateway tool contract");
    expect(firstOptions?.system).toContain("PulSeed runtime/gateway/daemon/session state");
    expect(events.some((event) => event.type === "tool_start" && event.toolName === "get_runtime_status")).toBe(true);
    expect(events.some((event) => event.type === "tool_end" && event.toolName === "get_runtime_status" && event.success)).toBe(true);
  });

  it("turns explicit gateway write-scope approval denial into a terminal failure without executing the write", async () => {
    const events: ChatEvent[] = [];
    const approvalFn = vi.fn(async () => false);
    const askHuman = new AskHumanTool();
    const tool = makeScopedTool("confirm_gateway_config_write", {
      permissionLevel: "write_local",
      isReadOnly: false,
      isDestructive: true,
      tags: ["automation"],
      gatewayExposure: "approval_required",
    });
    const llmClient = makeStreamingLLMClient([
      {
        content: "設定を書き込む前に許可が必要です。",
        stop_reason: "tool_calls",
        tool_calls: [{
          id: "call-ask-approval",
          type: "function",
          function: {
            name: "ask-human",
            arguments: JSON.stringify({
              question: "Write Telegram gateway config from the redacted token?",
              options: ["Approve", "Deny"],
              approval_scope: "write",
              approval_target: {
                tool_name: "confirm_gateway_config_write",
                arguments: { channel: "telegram" },
              },
            }),
          },
        }],
      },
      {
        content: "This second model request must not run after denial.",
      },
    ]);
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      llmClient: llmClient as never,
      registry: makeRegistryWithTools([askHuman, tool]),
      approvalFn,
    }));

    const result = await manager.execute("その Telegram 設定を書き込んで", {
      identity_key: "gateway-approval-denial-user",
      platform: "telegram",
      conversation_id: "gateway-approval-denial",
      user_id: "user-1",
      cwd: "/repo",
      onEvent: (event) => { events.push(event); },
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("設定を書き込む前に許可が必要です。");
    expect(result.output).toContain("Type: Permission failure");
    expect(approvalFn).toHaveBeenCalledOnce();
    expect(tool.call).not.toHaveBeenCalled();
    expect(llmClient.sendMessageStream).toHaveBeenCalledTimes(1);
    expect(events.some((event) =>
      event.type === "tool_update"
      && event.toolName === "ask-human"
      && event.status === "result"
    )).toBe(true);
    expect(events.some((event) => event.type === "assistant_final")).toBe(false);
  });

  it("expands gateway write tools only after an explicit scoped approval request succeeds", async () => {
    const approvalFn = vi.fn(async () => true);
    const askHuman = new AskHumanTool();
    const writeTool = makeScopedTool("confirm_gateway_config_write", {
      permissionLevel: "write_local",
      isReadOnly: false,
      isDestructive: true,
      gatewayExposure: "approval_required",
    });
    const llmClient = makeStreamingLLMClient([
      {
        content: "設定を書き込む前に許可を確認します。",
        stop_reason: "tool_calls",
        tool_calls: [{
          id: "call-ask-write-approval",
          type: "function",
          function: {
            name: "ask-human",
            arguments: JSON.stringify({
              question: "Write Telegram gateway config?",
              options: ["Approve", "Deny"],
              approval_scope: "write",
              approval_target: {
                tool_name: "confirm_gateway_config_write",
                arguments: { channel: "telegram" },
              },
            }),
          },
        }],
      },
      {
        content: "承認されたので設定を書き込みます。",
        stop_reason: "tool_calls",
        tool_calls: [{
          id: "call-confirm-config",
          type: "function",
          function: { name: "confirm_gateway_config_write", arguments: JSON.stringify({ channel: "telegram" }) },
        }],
      },
      {
        content: "設定を書き込みました。",
      },
    ]);
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      llmClient: llmClient as never,
      registry: makeRegistryWithTools([askHuman, writeTool]),
      approvalFn,
    }));

    const result = await manager.execute("その Telegram 設定を書き込んで", {
      identity_key: "gateway-approval-approved-user",
      platform: "telegram",
      conversation_id: "gateway-approval-approved",
      user_id: "user-1",
      cwd: "/repo",
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe("設定を書き込みました。");
    expect(approvalFn).toHaveBeenCalledOnce();
    expect(writeTool.call).toHaveBeenCalledOnce();
    const firstToolNames = (llmClient.sendMessageStream.mock.calls[0]?.[1]?.tools ?? [])
      .map((tool: { function: { name: string } }) => tool.function.name);
    const secondToolNames = (llmClient.sendMessageStream.mock.calls[1]?.[1]?.tools ?? [])
      .map((tool: { function: { name: string } }) => tool.function.name);
    expect(firstToolNames).toEqual(["ask-human"]);
    expect(secondToolNames).toEqual(["ask-human", "confirm_gateway_config_write"]);
  });

  it("blocks a gateway write when the model changes arguments after approval", async () => {
    const approvalFn = vi.fn(async () => true);
    const askHuman = new AskHumanTool();
    const writeTool = makeScopedTool("confirm_gateway_config_write", {
      permissionLevel: "write_local",
      isReadOnly: false,
      isDestructive: true,
      gatewayExposure: "approval_required",
    });
    const llmClient = makeStreamingLLMClient([
      {
        content: "設定を書き込む前に許可を確認します。",
        stop_reason: "tool_calls",
        tool_calls: [{
          id: "call-ask-write-approval",
          type: "function",
          function: {
            name: "ask-human",
            arguments: JSON.stringify({
              question: "Write Telegram gateway config?",
              options: ["Approve", "Deny"],
              approval_scope: "write",
              approval_target: {
                tool_name: "confirm_gateway_config_write",
                arguments: { channel: "telegram" },
              },
            }),
          },
        }],
      },
      {
        content: "承認されたので別の設定を書き込みます。",
        stop_reason: "tool_calls",
        tool_calls: [{
          id: "call-confirm-config",
          type: "function",
          function: { name: "confirm_gateway_config_write", arguments: JSON.stringify({ channel: "slack" }) },
        }],
      },
      {
        content: "This third model request must not run after argument mismatch.",
      },
    ]);
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      llmClient: llmClient as never,
      registry: makeRegistryWithTools([askHuman, writeTool]),
      approvalFn,
    }));

    const result = await manager.execute("その Telegram 設定を書き込んで", {
      identity_key: "gateway-approval-args-mismatch-user",
      platform: "telegram",
      conversation_id: "gateway-approval-args-mismatch",
      user_id: "user-1",
      cwd: "/repo",
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("approval_target.arguments");
    expect(approvalFn).toHaveBeenCalledOnce();
    expect(writeTool.call).not.toHaveBeenCalled();
    expect(llmClient.sendMessageStream).toHaveBeenCalledTimes(2);
    const secondToolNames = (llmClient.sendMessageStream.mock.calls[1]?.[1]?.tools ?? [])
      .map((tool: { function: { name: string } }) => tool.function.name);
    expect(secondToolNames).toEqual(["ask-human", "confirm_gateway_config_write"]);
  });

  it("does not expose or execute a different approval-required tool after one request is approved", async () => {
    const approvalFn = vi.fn(async () => true);
    const askHuman = new AskHumanTool();
    const writeTool = makeScopedTool("confirm_gateway_config_write", {
      permissionLevel: "write_local",
      isReadOnly: false,
      isDestructive: true,
      gatewayExposure: "approval_required",
    });
    const otherWriteTool = makeScopedTool("delete_gateway_config", {
      permissionLevel: "write_local",
      isReadOnly: false,
      isDestructive: true,
      gatewayExposure: "approval_required",
    });
    const llmClient = makeStreamingLLMClient([
      {
        content: "設定を書き込む前に許可を確認します。",
        stop_reason: "tool_calls",
        tool_calls: [{
          id: "call-ask-write-approval",
          type: "function",
          function: {
            name: "ask-human",
            arguments: JSON.stringify({
              question: "Write Telegram gateway config?",
              options: ["Approve", "Deny"],
              approval_scope: "write",
              approval_target: {
                tool_name: "confirm_gateway_config_write",
                arguments: { channel: "telegram" },
              },
            }),
          },
        }],
      },
      {
        content: "承認されたので削除します。",
        stop_reason: "tool_calls",
        tool_calls: [{
          id: "call-delete-config",
          type: "function",
          function: { name: "delete_gateway_config", arguments: JSON.stringify({ channel: "telegram" }) },
        }],
      },
    ]);
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      llmClient: llmClient as never,
      registry: makeRegistryWithTools([askHuman, writeTool, otherWriteTool]),
      approvalFn,
    }));

    const result = await manager.execute("その Telegram 設定を書き込んで", {
      identity_key: "gateway-approval-other-tool-user",
      platform: "telegram",
      conversation_id: "gateway-approval-other-tool",
      user_id: "user-1",
      cwd: "/repo",
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("delete_gateway_config requires explicit approval");
    expect(approvalFn).toHaveBeenCalledOnce();
    expect(writeTool.call).not.toHaveBeenCalled();
    expect(otherWriteTool.call).not.toHaveBeenCalled();
    expect(llmClient.sendMessageStream).toHaveBeenCalledTimes(2);
    const secondToolNames = (llmClient.sendMessageStream.mock.calls[1]?.[1]?.tools ?? [])
      .map((tool: { function: { name: string } }) => tool.function.name);
    expect(secondToolNames).toEqual(["ask-human", "confirm_gateway_config_write"]);
  });

  it("does not expand gateway write tools when approval omits the exact target tool", async () => {
    const approvalFn = vi.fn(async () => true);
    const askHuman = new AskHumanTool();
    const writeTool = makeScopedTool("confirm_gateway_config_write", {
      permissionLevel: "write_local",
      isReadOnly: false,
      isDestructive: true,
      gatewayExposure: "approval_required",
    });
    const llmClient = makeStreamingLLMClient([
      {
        content: "設定を書き込む前に許可を確認します。",
        stop_reason: "tool_calls",
        tool_calls: [{
          id: "call-ask-write-approval",
          type: "function",
          function: {
            name: "ask-human",
            arguments: JSON.stringify({
              question: "Write Telegram gateway config?",
              options: ["Approve", "Deny"],
              approval_scope: "write",
            }),
          },
        }],
      },
      {
        content: "承認されたので設定を書き込みます。",
        stop_reason: "tool_calls",
        tool_calls: [{
          id: "call-confirm-config",
          type: "function",
          function: { name: "confirm_gateway_config_write", arguments: JSON.stringify({ channel: "telegram" }) },
        }],
      },
    ]);
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      llmClient: llmClient as never,
      registry: makeRegistryWithTools([askHuman, writeTool]),
      approvalFn,
    }));

    const result = await manager.execute("その Telegram 設定を書き込んで", {
      identity_key: "gateway-approval-missing-target-user",
      platform: "telegram",
      conversation_id: "gateway-approval-missing-target",
      user_id: "user-1",
      cwd: "/repo",
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("confirm_gateway_config_write requires explicit approval");
    expect(approvalFn).toHaveBeenCalledOnce();
    expect(writeTool.call).not.toHaveBeenCalled();
    expect(llmClient.sendMessageStream).toHaveBeenCalledTimes(2);
    const secondToolNames = (llmClient.sendMessageStream.mock.calls[1]?.[1]?.tools ?? [])
      .map((tool: { function: { name: string } }) => tool.function.name);
    expect(secondToolNames).toEqual(["ask-human"]);
  });

  it("does not treat legacy approval_target_tool as broad dangerous-tool permission", async () => {
    const approvalFn = vi.fn(async () => true);
    const askHuman = new AskHumanTool();
    const writeTool = makeScopedTool("confirm_gateway_config_write", {
      permissionLevel: "write_local",
      isReadOnly: false,
      isDestructive: true,
      gatewayExposure: "approval_required",
    });
    const llmClient = makeStreamingLLMClient([
      {
        content: "設定を書き込む前に許可を確認します。",
        stop_reason: "tool_calls",
        tool_calls: [{
          id: "call-ask-write-approval",
          type: "function",
          function: {
            name: "ask-human",
            arguments: JSON.stringify({
              question: "Write Telegram gateway config?",
              options: ["Approve", "Deny"],
              approval_scope: "write",
              approval_target_tool: "confirm_gateway_config_write",
            }),
          },
        }],
      },
      {
        content: "承認されたので任意の設定を書き込みます。",
        stop_reason: "tool_calls",
        tool_calls: [{
          id: "call-confirm-config",
          type: "function",
          function: { name: "confirm_gateway_config_write", arguments: JSON.stringify({ channel: "telegram" }) },
        }],
      },
    ]);
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      llmClient: llmClient as never,
      registry: makeRegistryWithTools([askHuman, writeTool]),
      approvalFn,
    }));

    const result = await manager.execute("その Telegram 設定を書き込んで", {
      identity_key: "gateway-legacy-tool-target-user",
      platform: "telegram",
      conversation_id: "gateway-legacy-tool-target",
      user_id: "user-1",
      cwd: "/repo",
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("confirm_gateway_config_write requires explicit approval");
    expect(approvalFn).toHaveBeenCalledOnce();
    expect(writeTool.call).not.toHaveBeenCalled();
    expect(llmClient.sendMessageStream).toHaveBeenCalledTimes(2);
    const secondToolNames = (llmClient.sendMessageStream.mock.calls[1]?.[1]?.tools ?? [])
      .map((tool: { function: { name: string } }) => tool.function.name);
    expect(secondToolNames).toEqual(["ask-human"]);
  });

  it("applies scoped gateway approval before checking the next tool call in the same response", async () => {
    const approvalFn = vi.fn(async () => true);
    const askHuman = new AskHumanTool();
    const writeTool = makeScopedTool("confirm_gateway_config_write", {
      permissionLevel: "write_local",
      isReadOnly: false,
      isDestructive: true,
      gatewayExposure: "approval_required",
    });
    const llmClient = makeStreamingLLMClient([
      {
        content: "設定を書き込む前に許可を確認します。",
        stop_reason: "tool_calls",
        tool_calls: [
          {
            id: "call-ask-write-approval",
            type: "function",
            function: {
              name: "ask-human",
              arguments: JSON.stringify({
                question: "Write Telegram gateway config?",
                options: ["Approve", "Deny"],
                approval_scope: "write",
                approval_target: {
                  tool_name: "confirm_gateway_config_write",
                  arguments: { channel: "telegram" },
                },
              }),
            },
          },
          {
            id: "call-confirm-config",
            type: "function",
            function: { name: "confirm_gateway_config_write", arguments: JSON.stringify({ channel: "telegram" }) },
          },
        ],
      },
      {
        content: "設定を書き込みました。",
      },
    ]);
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      llmClient: llmClient as never,
      registry: makeRegistryWithTools([askHuman, writeTool]),
      approvalFn,
    }));

    const result = await manager.execute("その Telegram 設定を書き込んで", {
      identity_key: "gateway-same-response-approval-user",
      platform: "telegram",
      conversation_id: "gateway-same-response-approval",
      user_id: "user-1",
      cwd: "/repo",
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe("設定を書き込みました。");
    expect(approvalFn).toHaveBeenCalledOnce();
    expect(writeTool.call).toHaveBeenCalledOnce();
    const firstToolNames = (llmClient.sendMessageStream.mock.calls[0]?.[1]?.tools ?? [])
      .map((tool: { function: { name: string } }) => tool.function.name);
    const secondToolNames = (llmClient.sendMessageStream.mock.calls[1]?.[1]?.tools ?? [])
      .map((tool: { function: { name: string } }) => tool.function.name);
    expect(firstToolNames).toEqual(["ask-human"]);
    expect(secondToolNames).toEqual(["ask-human", "confirm_gateway_config_write"]);
  });

  it("blocks unauthorized runtime-control mutations in the gateway catalog without falling back to shell", async () => {
    const requestRuntimeControl = makeScopedTool("request_runtime_control", {
      permissionLevel: "write_local",
      isReadOnly: false,
      isDestructive: true,
      gatewayExposure: "runtime_control",
    });
    const shell = makeScopedTool("shell", {
      permissionLevel: "execute",
      isReadOnly: false,
      isDestructive: true,
      gatewayExposure: "never",
    });
    const llmClient = makeStreamingLLMClient([
      {
        content: "デーモン再起動を試します。",
        stop_reason: "tool_calls",
        tool_calls: [{
          id: "call-runtime-control",
          type: "function",
          function: {
            name: "request_runtime_control",
            arguments: JSON.stringify({ operation: "restart_daemon", reason: "user asked" }),
          },
        }],
      },
    ]);
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      llmClient: llmClient as never,
      registry: makeRegistryWithTools([requestRuntimeControl, shell]),
    }));

    const result = await manager.execute("daemon を restart して", {
      identity_key: "gateway-runtime-control-block-user",
      platform: "telegram",
      conversation_id: "gateway-runtime-control-block",
      user_id: "user-1",
      cwd: "/repo",
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("request_runtime_control requires runtime-control authorization");
    expect(result.output).toContain("Type: Permission failure");
    expect(requestRuntimeControl.call).not.toHaveBeenCalled();
    expect(shell.call).not.toHaveBeenCalled();
    const firstOptions = llmClient.sendMessageStream.mock.calls[0]?.[1];
    const toolNames = (firstOptions?.tools ?? []).map((item: { function: { name: string } }) => item.function.name);
    expect(toolNames).not.toContain("request_runtime_control");
    expect(toolNames).not.toContain("shell");
  });

  it("does not fail on one harmless repeated tool cycle when the model then answers", async () => {
    const events: ChatEvent[] = [];
    const readTool = makeScopedTool("read", { activityCategory: "read" });
    const llmClient = makeStreamingLLMClient([
      {
        content: "確認します。",
        stop_reason: "tool_calls",
        tool_calls: [{
          id: "call-read-1",
          type: "function",
          function: { name: "read", arguments: JSON.stringify({ file_path: "README.md" }) },
        }],
      },
      {
        content: "もう一度確認します。",
        stop_reason: "tool_calls",
        tool_calls: [{
          id: "call-read-2",
          type: "function",
          function: { name: "read", arguments: JSON.stringify({ file_path: "README.md" }) },
        }],
      },
      {
        content: "README.md exists.",
      },
    ]);
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      llmClient: llmClient as never,
      registry: makeRegistryWithTools([readTool]),
    }));

    const result = await manager.execute("README を読んで答えて", {
      identity_key: "gateway-stuck-loop-user",
      platform: "telegram",
      conversation_id: "gateway-stuck-loop",
      user_id: "user-1",
      cwd: "/repo",
      onEvent: (event) => { events.push(event); },
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe("README.md exists.");
    expect(readTool.call).toHaveBeenCalledTimes(2);
    expect(llmClient.sendMessageStream).toHaveBeenCalledTimes(3);
    expect(events.some((event) => event.type === "assistant_final")).toBe(true);
  });

  it("returns unavailable tool errors to the gateway model before answering", async () => {
    const readTool = makeScopedTool("read", { activityCategory: "read" });
    const llmClient = makeStreamingLLMClient([
      {
        content: "README を読もうとします。",
        stop_reason: "tool_calls",
        tool_calls: [{
          id: "call-read-file",
          type: "function",
          function: { name: "read_file", arguments: JSON.stringify({ file_path: "README.md" }) },
        }],
      },
      {
        content: "この gateway では read_file は使えないため、確認できません。",
      },
    ]);
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      llmClient: llmClient as never,
      registry: makeRegistryWithTools([readTool]),
    }));

    const result = await manager.execute("README を読んで答えて", {
      identity_key: "gateway-unavailable-tool-user",
      platform: "telegram",
      conversation_id: "gateway-unavailable-tool",
      user_id: "user-1",
      cwd: "/repo",
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("read_file");
    expect(readTool.call).not.toHaveBeenCalled();
    expect(llmClient.sendMessageStream).toHaveBeenCalledTimes(2);
    const secondMessages = llmClient.sendMessageStream.mock.calls[1]?.[0] as LLMMessage[];
    const toolResult = secondMessages.find((message) => message.role === "tool");
    expect(toolResult).toMatchObject({
      role: "tool",
      tool_call_id: "call-read-file",
      name: "read_file",
    });
    expect(toolResult?.content).toContain("\"denial_class\":\"unknown_tool\"");
  });

  it("eventually fails repeated no-progress gateway tool cycles with loop-safety evidence", async () => {
    const events: ChatEvent[] = [];
    const readTool = makeScopedTool("read", { activityCategory: "read" });
    const repeatedReadCall = (id: string) => ({
      content: "同じファイルを確認します。",
      stop_reason: "tool_calls" as const,
      tool_calls: [{
        id,
        type: "function" as const,
        function: { name: "read", arguments: JSON.stringify({ file_path: "README.md" }) },
      }],
    });
    const llmClient = makeStreamingLLMClient([
      repeatedReadCall("call-read-1"),
      repeatedReadCall("call-read-2"),
      repeatedReadCall("call-read-3"),
      repeatedReadCall("call-read-4"),
      { content: "This final answer must not run." },
    ]);
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      llmClient: llmClient as never,
      registry: makeRegistryWithTools([readTool]),
    }));

    const result = await manager.execute("README を読んで答えて", {
      identity_key: "gateway-repeated-loop-user",
      platform: "telegram",
      conversation_id: "gateway-repeated-loop",
      user_id: "user-1",
      cwd: "/repo",
      onEvent: (event) => { events.push(event); },
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("repeated the same tool call");
    expect(result.output).toContain("Recovery");
    expect(readTool.call).toHaveBeenCalledTimes(4);
    expect(llmClient.sendMessageStream).toHaveBeenCalledTimes(4);
    expect(events.some((event) => event.type === "assistant_final")).toBe(false);
  });

  it("propagates gateway timeout budget into model requests and returns a terminal timeout", async () => {
    let capturedOptions: { abortSignal?: AbortSignal; timeoutMs?: number } | undefined;
    const events: ChatEvent[] = [];
    const sendMessageStream = vi.fn(async (_messages, options?: { abortSignal?: AbortSignal; timeoutMs?: number }) => {
      capturedOptions = options;
      throw new Error("model request timed out");
    });
    const llmClient = {
      sendMessage: vi.fn().mockRejectedValue(new Error("sendMessage should not run")),
      sendMessageStream,
      supportsToolCalling: vi.fn(() => true),
      parseJSON: vi.fn((content: string, schema: { parse(value: unknown): unknown }) => schema.parse(JSON.parse(content))),
    };
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      llmClient: llmClient as never,
      registry: makeRegistryWithTools([]),
    }));

    const result = await manager.execute("hello", {
      identity_key: "gateway-timeout-user",
      platform: "telegram",
      conversation_id: "gateway-timeout",
      user_id: "user-1",
      cwd: "/repo",
      timeoutMs: 10_000,
      onEvent: (event) => { events.push(event); },
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("timed out");
    expect(result.output).toContain("Recovery");
    expect(capturedOptions?.abortSignal).toBeInstanceOf(AbortSignal);
    expect(capturedOptions?.timeoutMs).toBeGreaterThan(0);
    expect(capturedOptions?.timeoutMs).toBeLessThanOrEqual(10_000);
    const lifecycleError = events.find((event): event is Extract<ChatEvent, { type: "lifecycle_error" }> =>
      event.type === "lifecycle_error"
    );
    expect(lifecycleError?.recovery.kind).toBe("runtime_interruption");
  });

  it("aborts the in-flight gateway model request when the timeout budget expires", async () => {
    let capturedSignal: AbortSignal | undefined;
    let abortObserved = false;
    const sendMessageStream = vi.fn((_messages, options?: { abortSignal?: AbortSignal; timeoutMs?: number }) => {
      capturedSignal = options?.abortSignal;
      return new Promise((resolve) => {
        options?.abortSignal?.addEventListener("abort", () => {
          abortObserved = true;
          resolve({
            content: "late success",
            usage: { input_tokens: 1, output_tokens: 1 },
            stop_reason: "end_turn",
            tool_calls: [],
          });
        }, { once: true });
      });
    });
    const llmClient = {
      sendMessage: vi.fn().mockRejectedValue(new Error("sendMessage should not run")),
      sendMessageStream,
      supportsToolCalling: vi.fn(() => true),
      parseJSON: vi.fn((content: string, schema: { parse(value: unknown): unknown }) => schema.parse(JSON.parse(content))),
    };
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      llmClient: llmClient as never,
      registry: makeRegistryWithTools([]),
    }));

    const result = await manager.execute("hello", {
      identity_key: "gateway-model-timeout-abort-user",
      platform: "telegram",
      conversation_id: "gateway-model-timeout-abort",
      user_id: "user-1",
      cwd: "/repo",
      timeoutMs: 1_000,
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("timed out");
    expect(capturedSignal?.aborted).toBe(true);
    expect(abortObserved).toBe(true);
  });

  it("aborts the in-flight gateway tool call when the timeout budget expires", async () => {
    let capturedSignal: AbortSignal | undefined;
    let abortObserved = false;
    const readTool = makeScopedTool("read");
    readTool.call = vi.fn((_input, context?: ToolCallContext) => {
      capturedSignal = context?.abortSignal;
      return new Promise<ToolResult>((resolve) => {
        context?.abortSignal?.addEventListener("abort", () => {
          abortObserved = true;
          resolve({
            success: true,
            data: { late: true },
            summary: "late success",
            durationMs: 1,
          });
        }, { once: true });
      });
    });
    const llmClient = makeStreamingLLMClient([{
      content: "I'll read that.",
      stop_reason: "tool_calls",
      tool_calls: [{
        id: "call-read-timeout",
        type: "function",
        function: { name: "read", arguments: "{}" },
      }],
    }]);
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      llmClient: llmClient as never,
      registry: makeRegistryWithTools([readTool]),
    }));

    const result = await manager.execute("README を読んで", {
      identity_key: "gateway-tool-timeout-abort-user",
      platform: "telegram",
      conversation_id: "gateway-tool-timeout-abort",
      user_id: "user-1",
      cwd: "/repo",
      timeoutMs: 1_000,
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("timed out");
    expect(capturedSignal?.aborted).toBe(true);
    expect(abortObserved).toBe(true);
    expect(readTool.call).toHaveBeenCalledTimes(1);
    expect(llmClient.sendMessageStream).toHaveBeenCalledTimes(1);
  });

  it("keeps natural-language setup/run-spec requests inside the default gateway model tool-choice loop", async () => {
    const tool = makeGatewayReadTool();
    const llmClient = {
      sendMessage: vi.fn().mockResolvedValue({
        content: JSON.stringify({ verdict: "allow", reason: "No unsupported local claim." }),
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: "end_turn",
      }),
      sendMessageStream: vi.fn()
        .mockResolvedValueOnce({
          content: "セットアップ方針を確認します。",
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: "tool_calls",
          tool_calls: [{
            id: "call-setup",
            type: "function",
            function: { name: "read", arguments: "{}" },
          }],
        })
        .mockResolvedValueOnce({
          content: "次の安全な手順を案内します。",
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: "end_turn",
          tool_calls: [],
        }),
      supportsToolCalling: vi.fn(() => true),
      parseJSON: vi.fn((content: string, schema: { parse(value: unknown): unknown }) => schema.parse(JSON.parse(content))),
    };
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      llmClient: llmClient as never,
      registry: makeRegistryWithTools([tool]),
      chatAgentLoopRunner: { execute: vi.fn().mockResolvedValue(CANNED_RESULT) } as never,
    }));

    await manager.execute("Telegram bot のセットアップを進めたい", {
      identity_key: "gateway-natural-setup-user",
      platform: "telegram",
      conversation_id: "telegram-natural-setup",
      user_id: "user-1",
      cwd: "/repo",
    });

    expect(tool.call).toHaveBeenCalledOnce();
    expect(llmClient.sendMessageStream).toHaveBeenCalled();
    expect(llmClient.sendMessage.mock.calls.some(([, options]) =>
      String(options?.system ?? "").includes("Classify the user's chat request")
    )).toBe(false);
  });

  it("repairs unsupported workspace claims before gateway final projection", async () => {
    const llmClient = {
      sendMessage: vi.fn().mockResolvedValue({
        content: JSON.stringify({
          verdict: "repair",
          reason: "The workspace phrase is unsupported, but the greeting is safe.",
          claim_domain: "workspace_state",
          safe_repaired_answer: "やあ。何を進めますか？",
        }),
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: "end_turn",
      }),
      sendMessageStream: vi.fn().mockResolvedValue({
        content: "やあ。PulSeed dogfood 用の作業ディレクトリにいます。何を進めますか？",
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: "end_turn",
        tool_calls: [],
      }),
      supportsToolCalling: vi.fn(() => true),
      parseJSON: vi.fn((content: string, schema: { parse(value: unknown): unknown }) => schema.parse(JSON.parse(content))),
    };
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      llmClient: llmClient as never,
      registry: makeRegistryWithTools([]),
    }));

    const result = await manager.execute("やあ！", {
      identity_key: "gateway-repair-user",
      platform: "telegram",
      conversation_id: "telegram-repair",
      user_id: "user-1",
      cwd: "/repo",
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe("やあ。何を進めますか？");
    expect(llmClient.sendMessage).toHaveBeenCalledOnce();
  });

  it("fails closed before final projection when a runtime claim has no evidence and the gate is unavailable", async () => {
    const llmClient = {
      sendMessage: vi.fn().mockRejectedValue(new Error("classifier unavailable")),
      sendMessageStream: vi.fn().mockResolvedValue({
        content: "PulSeed の daemon は正常に動いています。",
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: "end_turn",
        tool_calls: [],
      }),
      supportsToolCalling: vi.fn(() => true),
      parseJSON: vi.fn(),
    };
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      llmClient: llmClient as never,
      registry: makeRegistryWithTools([]),
    }));

    const result = await manager.execute("今のPulSeedの状態を軽く確認して", {
      identity_key: "gateway-fail-closed-user",
      platform: "telegram",
      conversation_id: "telegram-fail-closed",
      user_id: "user-1",
      cwd: "/repo",
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("I can't verify the current local state");
    expect(result.output).not.toContain("daemon は正常");
    expect(llmClient.sendMessage).toHaveBeenCalledOnce();
  });

  it("holds streamed evidence-sensitive gateway deltas until the safety gate decides", async () => {
    const events: ChatEvent[] = [];
    const llmClient = {
      sendMessage: vi.fn().mockImplementation(async (messages: Array<{ content: string }>) => {
        const payload = JSON.parse(messages[0]!.content) as { assistant_final: string };
        if (payload.assistant_final.includes("作業ディレクトリ")) {
          return {
            content: JSON.stringify({
              verdict: "block",
              reason: "Unsupported workspace claim.",
              claim_domain: "workspace_state",
            }),
            usage: { input_tokens: 1, output_tokens: 1 },
            stop_reason: "end_turn",
          };
        }
        return {
          content: JSON.stringify({ verdict: "allow", reason: "Safe conversational span." }),
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: "end_turn",
        };
      }),
      sendMessageStream: vi.fn().mockImplementation(async (_messages, _options, handlers) => {
        handlers.onTextDelta?.("やあ。");
        handlers.onTextDelta?.("PulSeed dogfood 用の作業ディレクトリにいます。");
        return {
          content: "やあ。PulSeed dogfood 用の作業ディレクトリにいます。",
          usage: { input_tokens: 1, output_tokens: 2 },
          stop_reason: "end_turn",
          tool_calls: [],
        };
      }),
      supportsToolCalling: vi.fn(() => true),
      parseJSON: vi.fn((content: string, schema: { parse(value: unknown): unknown }) => schema.parse(JSON.parse(content))),
    };
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      llmClient: llmClient as never,
      registry: makeRegistryWithTools([]),
    }));

    const result = await manager.execute("やあ！", {
      identity_key: "gateway-safe-stream-user",
      platform: "telegram",
      conversation_id: "telegram-safe-stream",
      user_id: "user-1",
      cwd: "/repo",
      onEvent: (event) => { events.push(event); },
    });

    const deltas = events.filter((event): event is Extract<ChatEvent, { type: "assistant_delta" }> =>
      event.type === "assistant_delta"
    );
    expect(deltas.map((event) => event.delta)).toContain("やあ。");
    expect(deltas.map((event) => event.delta).join("")).not.toContain("作業ディレクトリ");
    expect(result.output).toContain("current workspace or repository state");
    expect(llmClient.sendMessage).toHaveBeenCalledOnce();
  });

  it("streams native agent-loop final text directly without a runtime evidence gate", async () => {
    const stateManager = makeMockStateManager();
    const events: ChatEvent[] = [];
    const chatAgentLoopRunner = {
      execute: vi.fn().mockImplementation(async (input: { eventSink?: { emit(event: unknown): Promise<void> } }) => {
        await input.eventSink?.emit({
          type: "tool_call_finished",
          eventId: "event-tool-end",
          sessionId: "session-1",
          traceId: "trace-1",
          turnId: "turn-1",
          goalId: "goal-1",
          createdAt: "2026-05-10T00:00:00.000Z",
          callId: "call-1",
          toolName: "read_file",
          success: true,
          outputPreview: "read project context",
          durationMs: 5,
        });
        await input.eventSink?.emit({
          type: "assistant_message",
          eventId: "event-final-candidate-1",
          sessionId: "session-1",
          traceId: "trace-1",
          turnId: "turn-1",
          goalId: "goal-1",
          createdAt: "2026-05-10T00:00:01.000Z",
          phase: "final_candidate",
          contentPreview: "First sentence.",
          toolCallCount: 1,
        });
        await input.eventSink?.emit({
          type: "assistant_message",
          eventId: "event-final-candidate-2",
          sessionId: "session-1",
          traceId: "trace-1",
          turnId: "turn-1",
          goalId: "goal-1",
          createdAt: "2026-05-10T00:00:02.000Z",
          phase: "final_candidate",
          contentPreview: "First sentence. Second sentence.",
          toolCallCount: 1,
        });
        return {
          success: true,
          output: "First sentence. Second sentence.",
          error: null,
          exit_code: null,
          elapsed_ms: 42,
          stopped_reason: "completed",
        };
      }),
    };
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager,
      chatAgentLoopRunner: chatAgentLoopRunner as never,
    }));

    const result = await manager.execute("Inspect the project and answer", {
      identity_key: "agent-loop-stream-user",
      channel: "cli",
      platform: "telegram",
      conversation_id: "telegram-chat-1",
      user_id: "user-1",
      cwd: "/repo",
      onEvent: (event) => { events.push(event); },
    });

    const finalIndex = events.findIndex((event) => event.type === "assistant_final");
    const deltaEvents = events.filter((event): event is Extract<ChatEvent, { type: "assistant_delta" }> =>
      event.type === "assistant_delta"
    );

    expect(result.success).toBe(true);
    expect(deltaEvents.map((event) => event.delta)).toEqual(["First sentence.", " Second sentence."]);
    expect(events.findIndex((event) => event === deltaEvents[0])).toBeLessThan(finalIndex);
    expect((events[finalIndex] as Extract<ChatEvent, { type: "assistant_final" }>).text).toBe("First sentence. Second sentence.");
  });

  it("keeps native agent-loop output direct without post-final runtime evidence checkpoints", async () => {
    const stateManager = makeMockStateManager();
    const events: ChatEvent[] = [];
    const now = "2026-05-10T00:00:00.000Z";
    const chatAgentLoopRunner = {
      execute: vi.fn().mockImplementation(async (input: { eventSink?: { emit(event: unknown): Promise<void> } }) => {
        await input.eventSink?.emit({
          type: "tool_call_started",
          eventId: "event-tool-start",
          sessionId: "session-1",
          traceId: "trace-1",
          turnId: "turn-1",
          goalId: "goal-1",
          createdAt: now,
          callId: "call-1",
          toolName: "runtime_status",
          inputPreview: "{}",
        });
        await input.eventSink?.emit({
          type: "tool_call_finished",
          eventId: "event-tool-end",
          sessionId: "session-1",
          traceId: "trace-1",
          turnId: "turn-1",
          goalId: "goal-1",
          createdAt: now,
          callId: "call-1",
          toolName: "runtime_status",
          success: true,
          outputPreview: "daemon: idle",
          durationMs: 5,
        });
        return {
          success: true,
          output: "The runtime status tool reported daemon: idle.",
          error: null,
          exit_code: null,
          elapsed_ms: 42,
          stopped_reason: "completed",
        };
      }),
    };
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager,
      chatAgentLoopRunner: chatAgentLoopRunner as never,
    }));

    const result = await manager.execute("PulSeed runtime status を確認して", {
      identity_key: "runtime-status-user-with-evidence",
      channel: "cli",
      platform: "telegram",
      conversation_id: "telegram-chat-1",
      user_id: "user-1",
      cwd: "/repo",
      onEvent: (event) => { events.push(event); },
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe("The runtime status tool reported daemon: idle.");
    expect(events.some((event) => event.type === "tool_start")).toBe(true);
    expect(events.some((event) => event.type === "tool_end")).toBe(true);
    expect(events.some((event) =>
      event.type === "activity"
      && event.sourceId === "checkpoint:runtime-evidence"
    )).toBe(false);
  });

  it("emits Seedy presence before the first gateway model request", async () => {
    const order: string[] = [];
    let resolveOrientingDelivery: (() => void) | undefined;
    const orientingDelivered = new Promise<void>((resolve) => {
      resolveOrientingDelivery = resolve;
    });
    const llmClient = {
      sendMessage: vi.fn().mockImplementation(async (_messages, options?: { system?: string }) => {
        const isRouteClassification = options?.system?.includes("Route the operator's freeform chat message");
        order.push(isRouteClassification ? "llm:route" : "llm:model");
        return {
          content: isRouteClassification
            ? JSON.stringify({ kind: "none", confidence: 0.95, rationale: "legacy route classifier must not run" })
            : "Plain answer",
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: "end_turn",
        };
      }),
      parseJSON: vi.fn((content: string, schema: { parse(value: unknown): unknown }) => schema.parse(JSON.parse(content))),
    };
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager: makeMockStateManager(),
      llmClient: llmClient as never,
    }));

    const run = manager.processIncomingMessage({
      text: "What is this project?",
      platform: "slack",
      identity_key: "presence-user",
      conversation_id: "C123",
      sender_id: "U123",
      cwd: "/repo",
      onEvent: (event) => {
        if (event.type === "presence_update") {
          order.push(`presence:${event.presence.phase}`);
        }
        if (event.type === "presence_update" && event.presence.phase === "orienting") {
          return orientingDelivered.then(() => undefined);
        }
        return undefined;
      },
    });

    await vi.waitFor(() => {
      expect(order).toContain("presence:orienting");
    }, { timeout: 5_000 });
    expect(order).not.toContain("llm:model");
    resolveOrientingDelivery?.();

    const result = await run;
    expect(result).toBe("Plain answer");
    expect(order).not.toContain("llm:route");
    expect(order.indexOf("presence:received")).toBeLessThan(order.indexOf("llm:model"));
    expect(order.indexOf("presence:orienting")).toBeLessThan(order.indexOf("llm:model"));
    expect(order).toContain("presence:thinking");
    expect(order).toContain("presence:finalizing");
    expect(order).toContain("presence:complete");
  });

  it("does not generate gateway commentary preambles before gateway model-loop execution", async () => {
    const events: ChatEvent[] = [];
    const order: string[] = [];
    const llmClient = {
      sendMessage: vi.fn().mockRejectedValue(new Error("sendMessage should not run")),
      sendMessageStream: vi.fn().mockImplementation(async () => {
        order.push("model-loop");
        return {
          content: "Task completed successfully.",
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: "end_turn",
          tool_calls: [],
        };
      }),
      supportsToolCalling: vi.fn(() => true),
      parseJSON: vi.fn((content: string, schema: { parse(value: unknown): unknown }) => schema.parse(JSON.parse(content))),
    };
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager: makeMockStateManager(),
      llmClient: llmClient as never,
      registry: makeRegistryWithTools([]),
    }));

    const result = await manager.execute("Inspect the project and run the relevant checks", {
      identity_key: "commentary-user",
      platform: "telegram",
      conversation_id: "telegram-chat-1",
      user_id: "user-1",
      cwd: "/repo",
      onEvent: (event) => {
        events.push(event);
        if (
          event.type === "activity"
          && event.kind === "commentary"
          && event.presentation?.gatewayProgress === "user"
        ) {
          order.push("commentary");
        }
      },
    });

    expect(result).toMatchObject({
      success: true,
      output: "Task completed successfully.",
    });
    expect(order).toEqual(["model-loop"]);
    expect(events.some((event) =>
      event.type === "activity"
      && event.kind === "commentary"
      && event.presentation?.gatewayProgress === "user"
    )).toBe(false);
    const final = events.find((event): event is Extract<ChatEvent, { type: "assistant_final" }> =>
      event.type === "assistant_final"
    );
    expect(final?.text).toBe("Task completed successfully.");
  });

  it("enters gateway model-loop execution without waiting on deleted gateway preamble generation", async () => {
    const order: string[] = [];
    const llmClient = {
      sendMessage: vi.fn().mockRejectedValue(new Error("sendMessage should not run")),
      sendMessageStream: vi.fn().mockImplementation(async () => {
        order.push("model-loop");
        return {
          content: "Task completed successfully.",
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: "end_turn",
          tool_calls: [],
        };
      }),
      supportsToolCalling: vi.fn(() => true),
      parseJSON: vi.fn((content: string, schema: { parse(value: unknown): unknown }) => schema.parse(JSON.parse(content))),
    };
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager: makeMockStateManager(),
      llmClient: llmClient as never,
      registry: makeRegistryWithTools([]),
    }));

    const startedAt = Date.now();
    const result = await manager.execute("Inspect the project and run the relevant checks", {
      identity_key: "commentary-timeout-user",
      platform: "telegram",
      conversation_id: "telegram-chat-timeout",
      user_id: "user-1",
      cwd: "/repo",
    });

    expect(result.success).toBe(true);
    expect(order).toEqual(["model-loop"]);
    expect(Date.now() - startedAt).toBeLessThan(2_500);
  });

  it("drains async per-turn event delivery before returning to gateway callers", async () => {
    const stateManager = makeMockStateManager();
    const llmClient = makeStreamingLLMClient([{ content: "Task completed successfully." }]);
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager,
      llmClient: llmClient as never,
      registry: makeRegistryWithTools([]),
    }));
    const finalDelivery = createDeferred();
    let finalHandlerEntered = false;
    let finalDelivered = false;

    const run = manager.processIncomingMessage({
      text: "stream this gateway turn",
      platform: "slack",
      identity_key: "workspace:U123",
      conversation_id: "C123:1700.1",
      sender_id: "U123",
      message_id: "1700.2",
      cwd: "/repo",
      onEvent: async (event) => {
        if (event.type !== "assistant_final") return;
        finalHandlerEntered = true;
        await finalDelivery.promise;
        finalDelivered = true;
      },
    });

    await vi.waitFor(() => {
      expect(finalHandlerEntered).toBe(true);
    });
    await expect(Promise.race([
      run.then(() => "returned"),
      Promise.resolve().then(() => "pending"),
    ])).resolves.toBe("pending");

    finalDelivery.resolve();
    await expect(run).resolves.toBe("Task completed successfully.");
    expect(finalDelivered).toBe(true);
  });

  it("steers active gateway input without starting a second agent-loop turn or reusing a stale reply target", async () => {
    const llmClient = {
      sendMessage: vi.fn().mockResolvedValue({
        content: interruptDecision("summary"),
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: "end_turn",
      }),
      sendMessageStream: vi.fn((_messages, options?: { abortSignal?: AbortSignal }) => {
        return new Promise((resolve) => {
          options?.abortSignal?.addEventListener("abort", () => {
            resolve({
              content: "cancelled",
              usage: { input_tokens: 1, output_tokens: 1 },
              stop_reason: "end_turn",
              tool_calls: [],
            });
          }, { once: true });
        });
      }),
      supportsToolCalling: vi.fn(() => true),
      parseJSON: vi.fn((content: string, schema: { parse(value: unknown): unknown }) => schema.parse(JSON.parse(content))),
    };
    const events: ChatEvent[] = [];
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager: makeMockStateManager(),
      llmClient: llmClient as never,
      registry: makeRegistryWithTools([]),
    }));

    const active = manager.execute("Implement a feature", {
      identity_key: "shared-user",
      platform: "slack",
      conversation_id: "stale-thread",
      user_id: "U123",
      message_id: "stale-message",
      cwd: "/repo",
      onEvent: (event) => {
        events.push(event);
      },
    });
    await vi.waitFor(() => expect(llmClient.sendMessageStream).toHaveBeenCalledOnce());

    const steered = await manager.execute("このターンを止めて要約して", {
      identity_key: "shared-user",
      platform: "slack",
      conversation_id: "current-thread",
      user_id: "U123",
      message_id: "current-message",
      cwd: "/stale-cwd",
      onEvent: (event) => {
        events.push(event);
      },
    });

    expect(steered.success).toBe(true);
    expect(steered.output).toContain("Interrupted the active turn");
    expect(llmClient.sendMessageStream).toHaveBeenCalledOnce();
    const steer = events.find((event): event is Extract<ChatEvent, { type: "turn_steer" }> =>
      event.type === "turn_steer"
    );
    expect(steer).toBeDefined();
    expect(steer?.operation).toMatchObject({
      kind: "TurnSteer",
      activeTurn: {
        cwd: "/repo",
      },
      userInput: {
        schema_version: "user-input-v1",
        rawText: "このターンを止めて要約して",
        items: [{
          kind: "text",
          text: "このターンを止めて要約して",
        }],
      },
    });
    const info = manager.getSessionInfo({ identity_key: "shared-user" });
    expect(info?.last_message_id).toBe("current-message");
    expect(info?.active_reply_target).toMatchObject({
      platform: "slack",
      conversation_id: "current-thread",
      identity_key: "shared-user",
      user_id: "U123",
    });

    await active;
  });

  it("reports active Seedy status from typed turn state without emitting a new reply", async () => {
    let resolveActive: ((value: {
      content: string;
      usage: { input_tokens: number; output_tokens: number };
      stop_reason: "end_turn";
      tool_calls: [];
    }) => void) | undefined;
    const llmClient = {
      sendMessage: vi.fn().mockRejectedValue(new Error("sendMessage should not run")),
      sendMessageStream: vi.fn(() => {
        return new Promise((resolve) => {
          resolveActive = resolve;
        });
      }),
      supportsToolCalling: vi.fn(() => true),
      parseJSON: vi.fn((content: string, schema: { parse(value: unknown): unknown }) => schema.parse(JSON.parse(content))),
    };
    const events: ChatEvent[] = [];
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager: makeMockStateManager(),
      llmClient: llmClient as never,
      registry: makeRegistryWithTools([]),
    }));

    const active = manager.execute("Implement a feature", {
      identity_key: "status-user",
      platform: "slack",
      conversation_id: "status-thread",
      user_id: "U123",
      message_id: "status-message",
      cwd: "/repo",
      onEvent: (event) => {
        events.push(event);
      },
    });
    await vi.waitFor(() => expect(llmClient.sendMessageStream).toHaveBeenCalledOnce());
    const eventCountBeforeStatus = events.length;

    const status = manager.getActiveSeedyTurnStatus({
      identity_key: "status-user",
      platform: "slack",
      conversation_id: "status-thread",
    });

    expect(status).toMatchObject({
      active: true,
      phase: "thinking",
      subject: "Reading message",
      expected_next: "final",
      blocked: false,
      action_required: false,
    });
    expect(manager.formatActiveSeedyTurnStatus({
      identity_key: "status-user",
      platform: "slack",
      conversation_id: "status-thread",
    })).toContain("I'm thinking through the next step.");
    expect(events).toHaveLength(eventCountBeforeStatus);

    resolveActive?.({
      content: "Task completed successfully.",
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: "end_turn",
      tool_calls: [],
    });
    await active;
    expect(manager.getActiveSeedyTurnStatus({ identity_key: "status-user" }))
      .toMatchObject({ active: false });
  });

  it("reconstructs resumed gateway history from the rollout journal instead of stale transcript messages", async () => {
    const tmpDir = makeTempDir();
    try {
      const stateManager = new RealStateManager(tmpDir, undefined, { walEnabled: false });
      await stateManager.init();
      const firstLlmClient = makeStreamingLLMClient([{ content: "First structured answer" }]);
      const firstManager = new CrossPlatformChatSessionManager(makeDeps({
        stateManager,
        llmClient: firstLlmClient as never,
        registry: makeRegistryWithTools([]),
      }));

      await expect(firstManager.processIncomingMessage({
        text: "First structured question",
        platform: "slack",
        identity_key: "workspace:U123",
        conversation_id: "C123",
        sender_id: "U123",
        message_id: "1700.1",
        cwd: "/repo",
      })).resolves.toBe("First structured answer");
      const sessionInfo = firstManager.getSessionInfo({ identity_key: "workspace:U123" });
      expect(sessionInfo?.chat_session_id).toBeTruthy();
      const sessionStore = new ChatSessionDataStore(tmpDir);
      const storedSession = await sessionStore.load(sessionInfo!.chat_session_id!);
      expect(Array.isArray(storedSession?.rolloutJournal)).toBe(true);
      await sessionStore.save({
        ...storedSession!,
        messages: [
          {
            role: "user",
            content: "STALE transcript user text",
            timestamp: "2026-05-06T00:00:00.000Z",
            turnIndex: 0,
          },
          {
            role: "assistant",
            content: "STALE transcript assistant text",
            timestamp: "2026-05-06T00:00:01.000Z",
            turnIndex: 1,
          },
        ],
      });

      const secondLlmClient = makeStreamingLLMClient([{ content: "Second structured answer" }]);
      const secondManager = new CrossPlatformChatSessionManager(makeDeps({
        stateManager,
        llmClient: secondLlmClient as never,
        registry: makeRegistryWithTools([]),
      }));

      await expect(secondManager.processIncomingMessage({
        text: "Second structured question",
        platform: "slack",
        identity_key: "workspace:U123",
        conversation_id: "C123",
        sender_id: "U123",
        message_id: "1700.2",
        cwd: "/repo",
      })).resolves.toBe("Second structured answer");

      expect(secondLlmClient.sendMessageStream).toHaveBeenCalledOnce();
      const modelMessages = vi.mocked(secondLlmClient.sendMessageStream).mock.calls[0][0] as Array<{ role: string; content: string }>;
      expect(JSON.stringify(modelMessages)).toContain("First structured question");
      expect(JSON.stringify(modelMessages)).toContain("First structured answer");
      expect(JSON.stringify(modelMessages)).not.toContain("STALE transcript");

      const reconstructedSession = await sessionStore.load(sessionInfo!.chat_session_id!);
      const kinds = (reconstructedSession?.rolloutJournal as Array<Record<string, unknown>>)
        .map((record) => record["kind"]);
      expect(kinds).toEqual(expect.arrayContaining([
        "user_input",
        "turn_context",
        "model_output",
        "display_event",
        "completion_state",
      ]));
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("uses the current steer handler for approvals while the active turn keeps running", async () => {
    const tmpDir = makeTempDir();
    try {
      let capturedApprovalFn: ((request: ApprovalRequest) => Promise<boolean>) | undefined;
      let resolveActive: ((value: AgentResult) => void) | undefined;
      const chatAgentLoopRunner = {
        execute: vi.fn().mockImplementation((input: {
          approvalFn?: (request: ApprovalRequest) => Promise<boolean>;
        }) => {
          capturedApprovalFn = input.approvalFn;
          return new Promise<AgentResult>((resolve) => {
            resolveActive = resolve;
          });
        }),
      };
      const store = new ApprovalStore(tmpDir);
      const approvalBroker = new ApprovalBroker({
        store,
        createId: () => "approval-steer-current",
      });
      const staleEvents: ChatEvent[] = [];
      const currentEvents: ChatEvent[] = [];
      const manager = new CrossPlatformChatSessionManager(makeDeps({
        stateManager: makeMockStateManager(),
        chatAgentLoopRunner: chatAgentLoopRunner as never,
        llmClient: createMockLLMClient([interruptDecision("background")]),
        approvalBroker,
      }));

      const active = manager.execute("Implement a feature", {
        identity_key: "shared-user",
        channel: "cli",
        platform: "slack",
        conversation_id: "stale-thread",
        user_id: "U123",
        message_id: "stale-message",
        cwd: "/repo",
        onEvent: (event) => {
          staleEvents.push(event);
        },
      });
      await vi.waitFor(() => expect(capturedApprovalFn).toBeDefined(), { timeout: 5000 });

      const redirected = await manager.execute("continúa esto en segundo plano", {
        identity_key: "shared-user",
        channel: "cli",
        platform: "slack",
        conversation_id: "current-thread",
        user_id: "U123",
        message_id: "current-message",
        cwd: "/repo",
        onEvent: (event) => {
          currentEvents.push(event);
        },
      });

      expect(redirected.success).toBe(true);
      expect(redirected.output).toContain("background is not available yet");
      const approval = capturedApprovalFn!({
        toolName: "edit",
        input: {},
        reason: "Needs current approval.",
        permissionLevel: "write_local",
        isDestructive: false,
        reversibility: "reversible",
      });

      await vi.waitFor(() => {
        expect(currentEvents.some((event) =>
          event.type === "activity"
          && event.message.includes("Approval ID: approval-steer-current")
        )).toBe(true);
      });
      expect(staleEvents.some((event) =>
        event.type === "activity"
        && event.message.includes("Approval ID: approval-steer-current")
      )).toBe(false);

      await expect(manager.processIncomingMessage({
        text: "",
        platform: "slack",
        identity_key: "shared-user",
        conversation_id: "current-thread",
        sender_id: "U123",
        message_id: "current-message",
        cwd: "/repo",
        approvalResponse: {
          approval_id: "approval-steer-current",
          approved: true,
        },
      })).resolves.toBe("Approval response recorded.");
      await expect(approval).resolves.toBe(true);

      resolveActive?.(CANNED_RESULT);
      await active;
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("isolates async event delivery failures and still returns the chat result", async () => {
    const llmClient = makeStreamingLLMClient([{ content: "Task completed successfully." }]);
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager: makeMockStateManager(),
      llmClient: llmClient as never,
      registry: makeRegistryWithTools([]),
    }));
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const result = await manager.processIncomingMessage({
      text: "stream this gateway turn",
      platform: "discord",
      conversation_id: "D123",
      sender_id: "U123",
      cwd: "/repo",
      onEvent: async (event) => {
        if (event.type === "assistant_final") {
          throw new Error("discord delivery failed");
        }
      },
    });

    expect(result).toBe("Task completed successfully.");
    expect(warnSpy).toHaveBeenCalledWith("[chat] event delivery failed", expect.objectContaining({
      eventType: "assistant_final",
      error: "discord delivery failed",
    }));
    warnSpy.mockRestore();
  });

  it("does not duplicate final or progress output when presence updates surround a direct gateway reply", async () => {
    const llmClient = makeStreamingLLMClient([{ content: "Task completed successfully." }]);
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager: makeMockStateManager(),
      llmClient: llmClient as never,
      registry: makeRegistryWithTools([]),
    }));
    const events: ChatEvent[] = [];

    const result = await manager.processIncomingMessage({
      text: "quick direct task",
      platform: "slack",
      conversation_id: "C_DIRECT",
      sender_id: "U123",
      cwd: "/repo",
      onEvent: (event) => {
        events.push(event);
      },
    });

    expect(result).toBe("Task completed successfully.");
    expect(events.some((event) =>
      event.type === "activity"
      && event.kind === "commentary"
      && event.presentation?.gatewayProgress === "user"
    )).toBe(false);
    expect(events.filter((event) => event.type === "assistant_final")).toHaveLength(1);
    expect(events.filter((event) => event.type === "operation_progress")).toHaveLength(0);
    expect(events.filter((event) => event.type === "presence_update").map((event) => event.presence.phase))
      .toEqual(expect.arrayContaining(["received", "orienting", "thinking", "finalizing", "complete"]));
  });

  it("returns recovery guidance for gateway model-loop failures", async () => {
    const llmClient = {
      sendMessage: vi.fn().mockRejectedValue(new Error("sendMessage should not run")),
      sendMessageStream: vi.fn().mockRejectedValue(new Error("Agent failed: boom")),
      supportsToolCalling: vi.fn(() => true),
      parseJSON: vi.fn((content: string, schema: { parse(value: unknown): unknown }) => schema.parse(JSON.parse(content))),
    };
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager: makeMockStateManager(),
      llmClient: llmClient as never,
      registry: makeRegistryWithTools([]),
    }));

    const result = await manager.processIncomingMessage({
      text: "do risky work",
      platform: "slack",
      conversation_id: "C_GENERAL",
      sender_id: "U123",
      cwd: "/repo",
    });

    expect(result).toContain("Agent failed: boom");
    expect(result).toContain("Recovery");
    expect(result).toContain("Next actions");
  });

  it("routes natural-language restart with the current platform reply target", async () => {
    const stateManager = makeMockStateManager();
    const adapter = makeMockAdapter();
    const runtimeControlService = {
      request: vi.fn().mockResolvedValue({
        success: true,
        message: "restart queued",
        operationId: "op-1",
        state: "acknowledged",
      }),
    };
    const llmClient = makeStreamingLLMClient([
      {
        content: "",
        stop_reason: "tool_calls",
        tool_calls: [{
          id: "call-restart-daemon",
          type: "function",
          function: {
            name: "request_runtime_control",
            arguments: JSON.stringify({
              operation: "restart_daemon",
              reason: "PulSeed を再起動して",
            }),
          },
        }],
      },
      { content: "restart queued" },
    ]);
    const tools = createSetupRuntimeControlTools({
      stateManager,
      runtimeControlService: runtimeControlService as never,
    });
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager,
      adapter,
      llmClient: llmClient as never,
      registry: makeRegistryWithTools(tools),
      runtimeControlService,
      approvalFn: vi.fn().mockResolvedValue(true),
    }));

    const result = await manager.execute("PulSeed を再起動して", {
      identity_key: "owner",
      platform: "telegram",
      conversation_id: "telegram-chat-1",
      user_id: "user-1",
      cwd: "/repo",
      metadata: { runtime_control_approved: true },
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe("restart queued");
    expect(adapter.execute).not.toHaveBeenCalled();
    expect(llmClient.sendMessage).not.toHaveBeenCalled();
    expect(llmClient.sendMessageStream).toHaveBeenCalledTimes(2);
    expect(runtimeControlService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: expect.objectContaining({ kind: "restart_daemon" }),
        replyTarget: expect.objectContaining({
          surface: "gateway",
          platform: "telegram",
          conversation_id: "telegram-chat-1",
          identity_key: "owner",
          user_id: "user-1",
        }),
        requestedBy: expect.objectContaining({
          surface: "gateway",
          platform: "telegram",
          conversation_id: "telegram-chat-1",
        }),
      })
    );

    const info = manager.getSessionInfo({ identity_key: "owner" });
    expect(info?.active_reply_target).toMatchObject({
      surface: "gateway",
      platform: "telegram",
      conversation_id: "telegram-chat-1",
      identity_key: "owner",
      user_id: "user-1",
    });
  });

  it("keeps stale reply-target surface metadata out of current runtime-control admission", async () => {
    const stateManager = makeMockStateManager();
    const adapter = makeMockAdapter();
    const runtimeControlService = {
      request: vi.fn().mockResolvedValue({
        success: true,
        message: "restart queued",
        operationId: "op-1",
        state: "acknowledged",
      }),
    };
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager,
      adapter,
      llmClient: createSingleMockLLMClient(JSON.stringify({
        intent: "restart_daemon",
        reason: "PulSeed を再起動して",
      })),
      runtimeControlService,
    }));
    const staleContext = { platform: "slack", senderId: "user-1", conversationId: "old-thread" };
    const staleSurface = buildExternalSurfaceDecision(
      staleContext,
      evaluateChannelAccess({ allowAll: true }, staleContext),
      resolveChannelRoute({ defaultGoalId: "old-goal" }, staleContext)
    );
    const currentContext = { platform: "telegram", senderId: "user-1", conversationId: "current-chat" };
    const currentSurface = buildExternalSurfaceDecision(
      currentContext,
      evaluateChannelAccess({ allowAll: true, runtimeControlAllowedSenderIds: ["user-1"] }, currentContext),
      resolveChannelRoute({ defaultGoalId: "current-goal" }, currentContext)
    );

    const result = await manager.execute("PulSeed を再起動して", {
      identity_key: "owner",
      platform: "telegram",
      conversation_id: "current-chat",
      user_id: "user-1",
      message_id: "current-message",
      cwd: "/repo",
      runtimeControl: {
        allowed: true,
        approvalMode: "preapproved",
        explicit: true,
      },
      externalSurface: currentSurface,
      replyTarget: {
        metadata: {
          external_surface: staleSurface,
          notification_route_id: "old-route",
        },
      },
    });

    expect(result.success).toBe(true);
    expect(runtimeControlService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        replyTarget: expect.objectContaining({
          platform: "telegram",
          conversation_id: "current-chat",
          message_id: "current-message",
          metadata: expect.objectContaining({
            external_surface: expect.objectContaining({
              channel: "telegram",
              notification_route_policy: expect.objectContaining({
                may_notify: false,
              }),
              runtime_control_policy: expect.objectContaining({
                allowed: true,
                approval_mode: "preapproved",
              }),
              autonomy_authority: expect.objectContaining({
                may_initiate: false,
              }),
            }),
          }),
        }),
      })
    );
    expect(runtimeControlService.request.mock.calls[0]?.[0].replyTarget.metadata.external_surface.channel).not.toBe("slack");
    expect(runtimeControlService.request.mock.calls[0]?.[0].replyTarget.metadata.notification_route_id).not.toBe("old-route");
  });

  it("keeps the current denied external surface enforced at the runtime-control tool boundary", async () => {
    const stateManager = makeMockStateManager();
    const adapter = makeMockAdapter();
    const chatAgentLoopRunner = {
      execute: vi.fn().mockResolvedValue(CANNED_RESULT),
    };
    const runtimeControlService = {
      request: vi.fn().mockResolvedValue({
        success: true,
        message: "restart queued",
      }),
    };
    const llmClient = makeStreamingLLMClient([
      {
        content: "",
        stop_reason: "tool_calls",
        tool_calls: [{
          id: "call-denied-restart",
          type: "function",
          function: {
            name: "request_runtime_control",
            arguments: JSON.stringify({
              operation: "restart_daemon",
              reason: "PulSeed を再起動して",
            }),
          },
        }],
      },
      {
        content: "This chat is not authorized to inspect or control PulSeed's running state. Nothing was executed, and I will not use shell commands as a workaround.",
      },
    ]);
    const tools = createSetupRuntimeControlTools({
      stateManager,
      runtimeControlService: runtimeControlService as never,
    });
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager,
      adapter,
      chatAgentLoopRunner: chatAgentLoopRunner as never,
      llmClient: llmClient as never,
      registry: makeRegistryWithTools(tools),
      runtimeControlService,
    }));
    const currentContext = { platform: "telegram", senderId: "user-1", conversationId: "current-chat" };
    const deniedSurface = buildExternalSurfaceDecision(
      currentContext,
      evaluateChannelAccess({ allowAll: true }, currentContext),
      resolveChannelRoute({ defaultGoalId: "current-goal" }, currentContext)
    );

    const result = await manager.execute("PulSeed を再起動して", {
      identity_key: "owner",
      platform: "telegram",
      conversation_id: "current-chat",
      user_id: "user-1",
      message_id: "current-message",
      cwd: "/repo",
      externalSurface: deniedSurface,
      metadata: { runtime_control_approved: true },
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("request_runtime_control requires runtime-control authorization");
    expect(result.output).toContain("Type: Permission failure");
    expect(llmClient.sendMessage).not.toHaveBeenCalled();
    expect(llmClient.sendMessageStream).toHaveBeenCalledTimes(1);
    expect(runtimeControlService.request).not.toHaveBeenCalled();
    expect(chatAgentLoopRunner.execute).not.toHaveBeenCalled();
  });

  it("fails closed for natural-language daemon restart when runtime control is unavailable", async () => {
    const stateManager = makeMockStateManager();
    const adapter = makeMockAdapter();
    const chatAgentLoopRunner = {
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: "agent loop should not run shell fallback",
        error: null,
        exit_code: null,
        elapsed_ms: 42,
        stopped_reason: "completed",
      }),
    };
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager,
      adapter,
      chatAgentLoopRunner: chatAgentLoopRunner as never,
      llmClient: createMockLLMClient([
        JSON.stringify({
          intent: "restart_daemon",
          reason: "PulSeed を再起動して",
        }),
      ]),
    }));

    const result = await manager.execute("PulSeed を再起動して", {
      identity_key: "owner",
      platform: "telegram",
      conversation_id: "telegram-chat-1",
      user_id: "user-1",
      cwd: "/repo",
      runtimeControl: {
        allowed: true,
        approvalMode: "interactive",
        explicit: true,
      },
      metadata: { runtime_control_explicit: true },
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("cannot reach PulSeed's authorized management service");
    expect(result.output).toContain("Nothing was executed");
    expect(result.output).toContain("will not use shell commands as a workaround");
    expect(chatAgentLoopRunner.execute).not.toHaveBeenCalled();
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it("fails closed for default local daemon restart when runtime control is unavailable", async () => {
    const stateManager = makeMockStateManager();
    const adapter = makeMockAdapter();
    const chatAgentLoopRunner = {
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: "agent loop should not run shell fallback",
        error: null,
        exit_code: null,
        elapsed_ms: 42,
        stopped_reason: "completed",
      }),
    };
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager,
      adapter,
      chatAgentLoopRunner: chatAgentLoopRunner as never,
      llmClient: createMockLLMClient([
        JSON.stringify({
          intent: "restart_daemon",
          reason: "PulSeed を再起動して",
        }),
      ]),
    }));

    const result = await manager.execute("PulSeed を再起動して", {
      identity_key: "local",
      cwd: "/repo",
      runtimeControl: {
        allowed: true,
        approvalMode: "interactive",
        explicit: true,
      },
      metadata: { runtime_control_explicit: true },
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("cannot reach PulSeed's authorized management service");
    expect(chatAgentLoopRunner.execute).not.toHaveBeenCalled();
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it("does not preempt ordinary disallowed gateway setup when runtime-control service is wired", async () => {
    const stateManager = makeMockStateManager();
    const adapter = makeMockAdapter();
    const runtimeControlService = {
      request: vi.fn().mockResolvedValue({
        success: true,
        message: "runtime control should not run",
      }),
    };
    const chatAgentLoopRunner = {
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: "agent loop should not run",
        error: null,
        exit_code: null,
        elapsed_ms: 42,
        stopped_reason: "completed",
      }),
    };
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager,
      adapter,
      chatAgentLoopRunner: chatAgentLoopRunner as never,
      llmClient: makeStreamingLLMClient([
        { content: "Setup help should stay in the default gateway model loop." },
      ]) as never,
      runtimeControlService,
    }));

    const result = await manager.execute("Telegram bot setup help", {
      identity_key: "owner",
      platform: "telegram",
      conversation_id: "telegram-chat-1",
      user_id: "user-1",
      cwd: "/repo",
      metadata: { runtime_control_denied: true },
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe("Setup help should stay in the default gateway model loop.");
    expect(runtimeControlService.request).not.toHaveBeenCalled();
    expect(chatAgentLoopRunner.execute).not.toHaveBeenCalled();
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it("denies unauthorized gateway daemon restart through the model-selected runtime-control tool", async () => {
    const events: ChatEvent[] = [];
    const stateManager = makeMockStateManager();
    const adapter = makeMockAdapter();
    const chatAgentLoopRunner = {
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: "agent loop should not run shell fallback",
        error: null,
        exit_code: null,
        elapsed_ms: 42,
        stopped_reason: "completed",
      }),
    };
    const runtimeControlService = {
      request: vi.fn().mockResolvedValue({
        success: true,
        message: "runtime control should not run",
      }),
    };
    const llmClient = makeStreamingLLMClient([
      {
        content: "",
        stop_reason: "tool_calls",
        tool_calls: [{
          id: "call-denied-daemon-restart",
          type: "function",
          function: {
            name: "request_runtime_control",
            arguments: JSON.stringify({
              operation: "restart_daemon",
              reason: "PulSeed を再起動して",
            }),
          },
        }],
      },
      {
        content: "This chat is not authorized to inspect or control PulSeed's running state. Nothing was executed, and I will not use shell commands as a workaround.",
      },
    ]);
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager,
      adapter,
      chatAgentLoopRunner: chatAgentLoopRunner as never,
      llmClient: llmClient as never,
      registry: makeRegistryWithTools(createSetupRuntimeControlTools({
        stateManager,
        runtimeControlService: runtimeControlService as never,
      })),
      runtimeControlService,
    }));

    const result = await manager.execute("PulSeed を再起動して", {
      identity_key: "owner",
      platform: "telegram",
      conversation_id: "telegram-chat-1",
      user_id: "user-1",
      cwd: "/repo",
      metadata: { runtime_control_denied: true },
      onEvent: (event) => { events.push(event); },
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("request_runtime_control requires runtime-control authorization");
    expect(result.output).toContain("Type: Permission failure");
    expect(llmClient.sendMessage).not.toHaveBeenCalled();
    expect(llmClient.sendMessageStream).toHaveBeenCalledTimes(1);
    expect(events.some((event) =>
      event.type === "tool_end"
      && event.toolName === "request_runtime_control"
      && event.success === false
      && event.summary.includes("requires runtime-control authorization")
    )).toBe(true);
    expect(runtimeControlService.request).not.toHaveBeenCalled();
    expect(chatAgentLoopRunner.execute).not.toHaveBeenCalled();
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it("does not expose runtime status inspection on a runtime-control denied gateway turn", async () => {
    const events: ChatEvent[] = [];
    const stateManager = makeMockStateManager();
    const adapter = makeMockAdapter();
    const chatAgentLoopRunner = {
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: "agent loop should not inspect state",
        error: null,
        exit_code: null,
        elapsed_ms: 42,
        stopped_reason: "completed",
      }),
    };
    const runtimeControlService = {
      request: vi.fn().mockResolvedValue({
        success: true,
        message: "runtime control should not run",
      }),
    };
    const llmClient = makeStreamingLLMClient([
      {
        content: "",
        stop_reason: "tool_calls",
        tool_calls: [{
          id: "call-denied-runtime-status",
          type: "function",
          function: {
            name: "get_runtime_status",
            arguments: "{}",
          },
        }],
      },
      {
        content: "This second model request must not run after runtime status denial.",
      },
    ]);
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager,
      adapter,
      chatAgentLoopRunner: chatAgentLoopRunner as never,
      llmClient: llmClient as never,
      registry: makeRegistryWithTools(createSetupRuntimeControlTools({
        stateManager,
        runtimeControlService: runtimeControlService as never,
      })),
      runtimeControlService,
    }));

    const result = await manager.execute("今のPulSeedの状態を軽く確認して", {
      identity_key: "owner",
      platform: "telegram",
      conversation_id: "telegram-chat-1",
      user_id: "user-1",
      cwd: "/repo",
      metadata: { runtime_control_denied: true },
      onEvent: (event) => { events.push(event); },
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("get_runtime_status requires runtime-control authorization");
    expect(result.output).toContain("Type: Permission failure");
    expect(result.output).not.toContain("inspect_companion_state");
    expect(llmClient.sendMessage).not.toHaveBeenCalled();
    expect(llmClient.sendMessageStream).toHaveBeenCalledTimes(1);
    const firstToolNames = (llmClient.sendMessageStream.mock.calls[0]?.[1]?.tools ?? [])
      .map((tool: { function: { name: string } }) => tool.function.name);
    expect(firstToolNames).not.toContain("get_runtime_status");
    expect(events.some((event) =>
      event.type === "tool_start"
      && event.toolName === "get_runtime_status"
    )).toBe(false);
    expect(events.some((event) =>
      event.type === "tool_end"
      && event.toolName === "get_runtime_status"
      && event.success === false
      && event.summary.includes("requires runtime-control authorization")
    )).toBe(true);
    expect(runtimeControlService.request).not.toHaveBeenCalled();
    expect(chatAgentLoopRunner.execute).not.toHaveBeenCalled();
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it("denies reload_config and self_update through the model-selected runtime-control tool", async () => {
    for (const operation of ["reload_config", "self_update"] as const) {
      const stateManager = makeMockStateManager();
      const adapter = makeMockAdapter();
      const chatAgentLoopRunner = {
        execute: vi.fn().mockResolvedValue({
          success: true,
          output: "agent loop should not run shell fallback",
          error: null,
          exit_code: null,
          elapsed_ms: 42,
          stopped_reason: "completed",
        }),
      };
      const runtimeControlService = {
        request: vi.fn().mockResolvedValue({
          success: true,
          message: "runtime control should not run",
        }),
      };
      const llmClient = makeStreamingLLMClient([
        {
          content: "",
          stop_reason: "tool_calls",
          tool_calls: [{
            id: `call-denied-${operation}`,
            type: "function",
            function: {
              name: "request_runtime_control",
              arguments: JSON.stringify({
                operation,
                reason: `request ${operation}`,
              }),
            },
          }],
        },
        {
          content: "This chat is not authorized to inspect or control PulSeed's running state. Nothing was executed, and I will not use shell commands as a workaround.",
        },
      ]);
      const manager = new CrossPlatformChatSessionManager(makeDeps({
        stateManager,
        adapter,
        chatAgentLoopRunner: chatAgentLoopRunner as never,
        llmClient: llmClient as never,
        registry: makeRegistryWithTools(createSetupRuntimeControlTools({
          stateManager,
          runtimeControlService: runtimeControlService as never,
        })),
        runtimeControlService,
      }));

      const result = await manager.execute(`Please ${operation}`, {
        identity_key: "owner",
        platform: "telegram",
        conversation_id: "telegram-chat-1",
        user_id: "user-1",
        cwd: "/repo",
        metadata: { runtime_control_denied: true },
      });

      expect(result.success).toBe(false);
      expect(result.output).toContain("request_runtime_control requires runtime-control authorization");
      expect(result.output).toContain("Type: Permission failure");
      expect(result.output).not.toContain(operation);
      expect(llmClient.sendMessage).not.toHaveBeenCalled();
      expect(llmClient.sendMessageStream).toHaveBeenCalledTimes(1);
      expect(runtimeControlService.request).not.toHaveBeenCalled();
      expect(chatAgentLoopRunner.execute).not.toHaveBeenCalled();
      expect(adapter.execute).not.toHaveBeenCalled();
    }
  });

  it("blocks explicit runtime-control metadata when no typed operation can be derived", async () => {
    const stateManager = makeMockStateManager();
    const adapter = makeMockAdapter();
    const chatAgentLoopRunner = {
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: "agent loop should not run shell fallback",
        error: null,
        exit_code: null,
        elapsed_ms: 42,
        stopped_reason: "completed",
      }),
    };
    const runtimeControlService = {
      request: vi.fn().mockResolvedValue({
        success: true,
        message: "runtime control should not run",
      }),
    };
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager,
      adapter,
      chatAgentLoopRunner: chatAgentLoopRunner as never,
      llmClient: createMockLLMClient([
        "{not valid runtime-control json",
      ]),
      runtimeControlService,
    }));

    const result = await manager.execute("その操作をやって", {
      identity_key: "owner",
      platform: "telegram",
      conversation_id: "telegram-chat-1",
      user_id: "user-1",
      cwd: "/repo",
      metadata: {
        runtime_control_explicit: true,
        runtime_control_denied: true,
      },
    });

    expect(result.success).toBe(false);
    expect(result.output).toContain("could not identify a supported safe action");
    expect(result.output).toContain("will not use shell commands as a workaround");
    expect(result.output).not.toContain("runtime-control");
    expect(runtimeControlService.request).not.toHaveBeenCalled();
    expect(chatAgentLoopRunner.execute).not.toHaveBeenCalled();
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it("routes gateway natural-language run pause to runtime control with current reply target", async () => {
    const stateManager = makeMockStateManager();
    const adapter = makeMockAdapter();
    const runtimeControlService = {
      request: vi.fn().mockResolvedValue({
        success: true,
        message: "pause queued",
        operationId: "op-1",
        state: "running",
      }),
    };
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager,
      adapter,
      llmClient: createSingleMockLLMClient(JSON.stringify({
        intent: "pause_run",
        reason: "この実行を一時停止して",
      })),
      runtimeControlService,
      runtimeControlApprovalFn: vi.fn().mockResolvedValue(true),
    }));

    const result = await manager.execute("この実行を一時停止して", {
      identity_key: "owner",
      platform: "telegram",
      conversation_id: "telegram-chat-1",
      user_id: "user-1",
      cwd: "/repo",
      runtimeControl: {
        allowed: true,
        approvalMode: "interactive",
        explicit: true,
      },
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe("pause queued");
    expect(adapter.execute).not.toHaveBeenCalled();
    expect(runtimeControlService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: expect.objectContaining({ kind: "pause_run" }),
        replyTarget: expect.objectContaining({
          surface: "gateway",
          platform: "telegram",
          conversation_id: "telegram-chat-1",
          identity_key: "owner",
          user_id: "user-1",
        }),
        requestedBy: expect.objectContaining({
          surface: "gateway",
          platform: "telegram",
          conversation_id: "telegram-chat-1",
        }),
      })
    );
  });

  it("routes gateway natural-language run pause through processIncomingMessage without adapter fallback", async () => {
    const adapter = makeMockAdapter();
    const runtimeControlService = {
      request: vi.fn().mockResolvedValue({
        success: true,
        message: "pause queued",
        operationId: "op-process-ingress",
        state: "running",
      }),
    };
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      adapter,
      llmClient: createSingleMockLLMClient(JSON.stringify({
        intent: "pause_run",
        reason: "pause the currently active gateway run",
      })),
      runtimeControlService,
      runtimeControlApprovalFn: vi.fn().mockResolvedValue(true),
    }));

    const result = await manager.processIncomingMessage({
      text: "Pause the currently active run.",
      platform: "telegram",
      identity_key: "telegram:user-1",
      conversation_id: "telegram-chat-1",
      sender_id: "user-1",
      message_id: "message-1",
      cwd: "/repo",
      runtimeControl: {
        allowed: true,
        approvalMode: "interactive",
        explicit: true,
      },
    });

    expect(result).toBe("pause queued");
    expect(adapter.execute).not.toHaveBeenCalled();
    expect(runtimeControlService.request).toHaveBeenCalledWith(
      expect.objectContaining({
        intent: expect.objectContaining({ kind: "pause_run" }),
        replyTarget: expect.objectContaining({
          surface: "gateway",
          platform: "telegram",
          conversation_id: "telegram-chat-1",
          identity_key: "telegram:user-1",
          user_id: "user-1",
          message_id: "message-1",
        }),
        requestedBy: expect.objectContaining({
          surface: "gateway",
          platform: "telegram",
          conversation_id: "telegram-chat-1",
          identity_key: "telegram:user-1",
          user_id: "user-1",
        }),
      })
    );
  });

  it.each(["cli", "tui"] as const)(
    "preserves explicit runtime-control metadata for %s execute turns before agent-loop fallback",
    async (channel) => {
      const adapter = makeMockAdapter();
      const chatAgentLoopRunner = {
        execute: vi.fn().mockResolvedValue({
          success: true,
          output: "agent loop should not receive explicit runtime control",
          error: null,
          exit_code: null,
          elapsed_ms: 42,
          stopped_reason: "completed",
        }),
      };
      const runtimeControlService = {
        request: vi.fn().mockResolvedValue({
          success: true,
          message: "pause queued",
          operationId: `op-${channel}-pause`,
          state: "running",
        }),
      };
      const manager = new CrossPlatformChatSessionManager(makeDeps({
        adapter,
        chatAgentLoopRunner: chatAgentLoopRunner as never,
        llmClient: createSingleMockLLMClient(JSON.stringify({
          intent: "pause_run",
          reason: "Pause the current non-gateway runtime turn.",
        })),
        runtimeControlService,
        runtimeControlApprovalFn: vi.fn().mockResolvedValue(true),
      }));

      const result = await manager.execute("Pause the current run.", {
        identity_key: `${channel}-runtime-user`,
        channel,
        cwd: "/repo",
        runtimeControl: {
          allowed: true,
          approvalMode: "interactive",
          explicit: true,
        },
      });

      expect(result.success).toBe(true);
      expect(result.output).toBe("pause queued");
      expect(chatAgentLoopRunner.execute).not.toHaveBeenCalled();
      expect(adapter.execute).not.toHaveBeenCalled();
      expect(runtimeControlService.request).toHaveBeenCalledWith(
        expect.objectContaining({
          intent: expect.objectContaining({ kind: "pause_run" }),
          requestedBy: expect.objectContaining({ surface: channel }),
          replyTarget: expect.objectContaining({ surface: channel }),
        })
      );
    }
  );

  it("routes runtime-control approval through the originating conversation metadata", async () => {
    const tmpDir = makeTempDir();
    const events: string[] = [];
    try {
      const store = new ApprovalStore(tmpDir);
      const approvalBroker = new ApprovalBroker({
        store,
        createId: () => "approval-cross-platform",
      });
      const runtimeControlService = {
        request: vi.fn(async (request: {
          approvalFn?: (description: string) => Promise<boolean>;
        }) => {
          const approved = await request.approvalFn?.("Restart the resident daemon.");
          return {
            success: approved === true,
            message: approved === true ? "restart queued" : "not approved",
            operationId: "op-approval",
            state: approved === true ? "acknowledged" as const : "blocked" as const,
          };
        }),
      };
      const manager = new CrossPlatformChatSessionManager(makeDeps({
        llmClient: createSingleMockLLMClient(JSON.stringify({
          intent: "restart_daemon",
          reason: "PulSeed を再起動して",
        })),
        runtimeControlService,
        approvalBroker,
      }));

      const resultPromise = manager.processIncomingMessage({
        text: "PulSeed を再起動して",
        platform: "slack",
        identity_key: "workspace:U123",
        conversation_id: "C123:1700.1",
        sender_id: "U123",
        message_id: "1700.2",
        cwd: "/repo",
        onEvent: (event) => {
          if (event.type === "activity") {
            events.push(event.message);
          }
        },
        runtimeControl: {
          allowed: true,
          approvalMode: "interactive",
          explicit: true,
        },
      });

      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && !events.some((message) => message.includes("Approval ID: approval-cross-platform"))) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await expect(manager.processIncomingMessage({
        text: "",
        platform: "slack",
        identity_key: "workspace:U123",
        conversation_id: "C123:1700.1",
        sender_id: "U123",
        message_id: "1700.2",
        cwd: "/repo",
        approvalResponse: {
          approval_id: "approval-cross-platform",
          approved: true,
        },
      })).resolves.toBe("Approval response recorded.");

      const result = await resultPromise;
      expect(result).toBe("restart queued");
      expect(events.some((message) =>
        message.includes("Approval required.")
        && message.includes("Restart the resident daemon.")
        && message.includes("Approval ID: approval-cross-platform")
      )).toBe(true);
      const resolved = await store.loadResolved("approval-cross-platform");
      expect(resolved).toMatchObject({
        state: "approved",
        response_channel: "slack",
        origin: {
          channel: "slack",
          conversation_id: "C123:1700.1",
          user_id: "U123",
          session_id: "identity:workspace:U123",
          turn_id: "1700.2",
        },
      });
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("parses a same-conversation natural-language approval reply through the production ingress path", async () => {
    const tmpDir = makeTempDir();
    const events: string[] = [];
    try {
      const store = new ApprovalStore(tmpDir);
      const approvalBroker = new ApprovalBroker({
        store,
        createId: () => "approval-natural-language",
      });
      const runtimeControlService = {
        request: vi.fn(async (request: {
          approvalFn?: (description: string) => Promise<boolean>;
        }) => {
          const approved = await request.approvalFn?.("Restart the resident daemon.");
          return {
            success: approved === true,
            message: approved === true ? "restart queued" : "not approved",
            operationId: "op-natural-language",
            state: approved === true ? "acknowledged" as const : "blocked" as const,
          };
        }),
      };
      const manager = new CrossPlatformChatSessionManager(makeDeps({
        llmClient: createMockLLMClient([
          JSON.stringify({
            intent: "restart_daemon",
            reason: "PulSeed を再起動して",
          }),
          JSON.stringify({
            decision: "approve",
            confidence: 0.94,
            rationale: "The reply explicitly authorizes the active restart request.",
          }),
        ]),
        runtimeControlService,
        approvalBroker,
      }));

      const resultPromise = manager.processIncomingMessage({
        text: "PulSeed を再起動して",
        platform: "slack",
        identity_key: "workspace:U123",
        conversation_id: "C123:1700.1",
        sender_id: "U123",
        message_id: "1700.2",
        cwd: "/repo",
        onEvent: (event) => {
          if (event.type === "activity") {
            events.push(event.message);
          }
        },
        runtimeControl: {
          allowed: true,
          approvalMode: "interactive",
          explicit: true,
        },
      });

      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && !events.some((message) => message.includes("approval-natural-language"))) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await expect(manager.processIncomingMessage({
        text: "問題ありません。進めてください",
        platform: "slack",
        identity_key: "workspace:U123",
        conversation_id: "C123:1700.1",
        sender_id: "U123",
        message_id: "1700.3",
        cwd: "/repo",
      })).resolves.toBe("Approval response recorded.");

      await expect(resultPromise).resolves.toBe("restart queued");
      await expect(store.loadResolved("approval-natural-language")).resolves.toMatchObject({
        state: "approved",
        response_channel: "slack",
      });
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("persists tool permission prompts with typed target and risk metadata", async () => {
    const tmpDir = makeTempDir();
    const events: string[] = [];
    try {
      const store = new ApprovalStore(tmpDir);
      const approvalBroker = new ApprovalBroker({
        store,
        createId: () => "approval-tool-metadata",
      });
      const chatAgentLoopRunner = {
        execute: vi.fn(async (input: {
          approvalFn?: (request: ApprovalRequest) => Promise<boolean>;
        }) => {
          const approved = await input.approvalFn?.({
            toolName: "write_file",
            input: { path: "notes.md" },
            reason: "Write notes.md in the workspace.",
            permissionLevel: "write_local",
            isDestructive: false,
            reversibility: "reversible",
            callId: "call-write-file",
          });
          return {
            success: approved === true,
            output: approved === true ? "write approved" : "not approved",
            error: null,
            exit_code: null,
            elapsed_ms: 5,
            stopped_reason: "completed",
          };
        }),
      };
      const manager = new CrossPlatformChatSessionManager(makeDeps({
        chatAgentLoopRunner: chatAgentLoopRunner as never,
        approvalBroker,
      }));

      const resultPromise = manager.processIncomingMessage({
        text: "Write the notes file",
        channel: "cli",
        platform: "slack",
        identity_key: "workspace:U123",
        conversation_id: "C123:1700.1",
        sender_id: "U123",
        message_id: "1700.2",
        cwd: "/repo",
        onEvent: (event) => {
          if (event.type === "activity") {
            events.push(event.message);
          }
        },
      });
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && (await store.loadPending("approval-tool-metadata")) === null) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      const pending = await store.loadPending("approval-tool-metadata");
      expect(pending).toMatchObject({
        payload: {
          task: {
            kind: "permission",
            id: "call-write-file",
            action: "write_file",
            operation_summary: "Write notes.md in the workspace.",
            risk_class: "medium",
            target: {
              session_id: "identity:workspace:U123",
              tool_id: "write_file",
              tool_call_id: "call-write-file",
            },
            state_epoch: "1700.2",
            permission_level: "write_local",
            is_destructive: false,
          },
        },
      });
      expect(events.some((message) =>
        message.includes("Tool: write_file")
        && message.includes("Tool call: call-write-file")
        && message.includes("Risk: medium")
      )).toBe(true);

      await approvalBroker.resolveConversationalApproval("approval-tool-metadata", true, {
        channel: "slack",
        conversation_id: "C123:1700.1",
        user_id: "U123",
        session_id: "identity:workspace:U123",
        turn_id: "1700.2",
      });
      await expect(resultPromise).resolves.toBe("write approved");
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("creates a current-run PermissionGrant from a natural-language grant approval through the chat caller path", async () => {
    const tmpDir = makeTempDir();
    try {
      const store = new ApprovalStore(tmpDir);
      const permissionGrantStore = new PermissionGrantStore(tmpDir);
      const approvalBroker = new ApprovalBroker({
        store,
        createId: () => "approval-grant-run",
      });
      const chatAgentLoopRunner = {
        execute: vi.fn(async (input: {
          approvalFn?: (request: ApprovalRequest) => Promise<boolean>;
          toolCallContext?: ToolCallContext;
        }) => {
          const approved = await input.approvalFn?.({
            toolName: "write_file",
            input: { path: "notes.md" },
            reason: "Write notes.md and run tests in the workspace.",
            permissionLevel: "write_local",
            isDestructive: false,
            reversibility: "reversible",
            callId: "call-grant-run",
            ...(input.toolCallContext?.sessionId ? { sessionId: input.toolCallContext.sessionId } : {}),
            ...(input.toolCallContext?.runId ? { runId: input.toolCallContext.runId } : {}),
            ...(input.toolCallContext?.turnId ? { turnId: input.toolCallContext.turnId } : {}),
            permissionGrantDecision: {
              status: "missing_grant",
              allowed: false,
              reason: "No active PermissionGrant covers the requested local work.",
              requiredCapabilities: ["write_workspace", "run_tests"],
              excludedCapabilities: [],
              consideredGrantIds: [],
            },
          });
          return {
            success: approved === true,
            output: approved === true ? "write approved" : "not approved",
            error: null,
            exit_code: null,
            elapsed_ms: 5,
            stopped_reason: "completed",
          };
        }),
      };
      const manager = new CrossPlatformChatSessionManager(makeDeps({
        chatAgentLoopRunner: chatAgentLoopRunner as never,
        llmClient: createSingleMockLLMClient(JSON.stringify({
          decision: "approve_current_run",
          confidence: 0.94,
          rationale: "The reply allows the proposed local work for the current run.",
        })),
        approvalBroker,
        permissionGrantStore,
      }));

      const resultPromise = manager.processIncomingMessage({
        text: "Write the notes file and run tests",
        channel: "cli",
        platform: "slack",
        identity_key: "workspace:U123",
        conversation_id: "C123:1700.1",
        sender_id: "U123",
        message_id: "1700.2",
        cwd: "/repo",
        onEvent: () => undefined,
      });
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && (await store.loadPending("approval-grant-run")) === null) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await expect(store.loadPending("approval-grant-run")).resolves.toMatchObject({
        payload: {
          task: {
            grant_proposal: {
              capabilities: ["write_workspace", "run_tests"],
              default_scope: "run",
            },
          },
        },
      });

      await expect(manager.processIncomingMessage({
        text: "この実行中はローカル編集とテストを進めてください",
        platform: "slack",
        identity_key: "workspace:U123",
        conversation_id: "C123:1700.1",
        sender_id: "U123",
        message_id: "1700.3",
        cwd: "/repo",
      })).resolves.toBe("Permission grant recorded. Approval response recorded.");

      await expect(resultPromise).resolves.toBe("write approved");
      const grants = await permissionGrantStore.list();
      expect(grants).toHaveLength(1);
      expect(grants[0]).toMatchObject({
        state: "active",
        scope: {
          kind: "run",
        },
        duration: {
          kind: "until_run_done",
        },
        capabilities: ["write_workspace", "run_tests"],
        excluded_capabilities: [],
        origin: {
          conversation_id: "C123:1700.1",
          user_id: "U123",
          session_id: "identity:workspace:U123",
        },
      });
      expect(grants[0]?.scope.kind === "run" ? grants[0].scope.run_id : null).toBeTruthy();
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("rejects stale natural-language PermissionGrant replies through the chat caller path", async () => {
    const tmpDir = makeTempDir();
    try {
      const store = new ApprovalStore(tmpDir);
      const permissionGrantStore = new PermissionGrantStore(tmpDir);
      const approvalBroker = new ApprovalBroker({
        store,
        createId: () => "unused",
        deliverConversationalApproval: async () => ({ delivered: true }),
      });
      const manager = new CrossPlatformChatSessionManager(makeDeps({
        approvalBroker,
        permissionGrantStore,
      }));
      await manager.processIncomingMessage({
        text: "ordinary state-changing turn",
        platform: "slack",
        identity_key: "workspace:U123",
        conversation_id: "C123:1700.1",
        sender_id: "U123",
        message_id: "1700.3",
        cwd: "/repo",
      });

      const staleRequest = approvalBroker.requestConversationalApproval("goal-1", {
        kind: "permission",
        id: "call-old-grant",
        description: "Write the old file and run tests.",
        action: "write_file",
        operation_summary: "Write the old file and run tests.",
        risk_class: "medium",
        target: {
          session_id: "identity:workspace:U123",
          tool_id: "write_file",
          tool_call_id: "call-old-grant",
        },
        state_epoch: "1700.2",
        state_version: "2026-05-06T00:00:00.000Z",
        grant_proposal: {
          schema_version: "permission-grant-proposal-v1",
          capabilities: ["write_workspace", "run_tests"],
          current_request_capabilities: ["write_workspace", "run_tests"],
          excluded_capabilities: [],
          default_scope: "run",
          allowed_scopes: ["once", "run", "goal"],
          summary: "Allow the old local edit/test request.",
        },
      }, {
        approvalId: "approval-old-grant-stale",
        timeoutMs: 30_000,
        origin: {
          channel: "slack",
          conversation_id: "C123:1700.1",
          user_id: "U123",
          session_id: "identity:workspace:U123",
          turn_id: "1700.2",
        },
      });
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && (await store.loadPending("approval-old-grant-stale")) === null) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      await expect(manager.processIncomingMessage({
        text: "この実行中はローカル編集とテストを進めてください",
        platform: "slack",
        identity_key: "workspace:U123",
        conversation_id: "C123:1700.1",
        sender_id: "U123",
        message_id: "1700.4",
        cwd: "/repo",
      })).resolves.toContain("approval target changed after the prompt");
      await expect(staleRequest).resolves.toBe(false);
      await expect(store.loadResolved("approval-old-grant-stale")).resolves.toMatchObject({
        state: "denied",
      });
      await expect(permissionGrantStore.list()).resolves.toHaveLength(0);
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("records narrowed grant replies without executing the excluded current request", async () => {
    const tmpDir = makeTempDir();
    try {
      const store = new ApprovalStore(tmpDir);
      const permissionGrantStore = new PermissionGrantStore(tmpDir);
      const approvalBroker = new ApprovalBroker({
        store,
        createId: () => "approval-grant-narrow",
      });
      const chatAgentLoopRunner = {
        execute: vi.fn(async (input: {
          approvalFn?: (request: ApprovalRequest) => Promise<boolean>;
          toolCallContext?: ToolCallContext;
        }) => {
          const approved = await input.approvalFn?.({
            toolName: "write_file",
            input: { path: "notes.md" },
            reason: "Write notes.md and run tests in the workspace.",
            permissionLevel: "write_local",
            isDestructive: false,
            reversibility: "reversible",
            callId: "call-grant-narrow",
            ...(input.toolCallContext?.sessionId ? { sessionId: input.toolCallContext.sessionId } : {}),
            ...(input.toolCallContext?.runId ? { runId: input.toolCallContext.runId } : {}),
            ...(input.toolCallContext?.turnId ? { turnId: input.toolCallContext.turnId } : {}),
            permissionGrantDecision: {
              status: "missing_grant",
              allowed: false,
              reason: "No active PermissionGrant covers the requested local work.",
              requiredCapabilities: ["write_workspace", "run_tests"],
              excludedCapabilities: [],
              consideredGrantIds: [],
            },
          });
          return {
            success: approved === true,
            output: approved === true ? "write approved" : "not approved",
            error: null,
            exit_code: null,
            elapsed_ms: 5,
            stopped_reason: "completed",
          };
        }),
      };
      const manager = new CrossPlatformChatSessionManager(makeDeps({
        chatAgentLoopRunner: chatAgentLoopRunner as never,
        llmClient: createSingleMockLLMClient(JSON.stringify({
          decision: "narrow_scope",
          confidence: 0.92,
          capabilities: ["run_tests"],
          rationale: "The reply allows tests but not edits.",
        })),
        approvalBroker,
        permissionGrantStore,
      }));

      const resultPromise = manager.processIncomingMessage({
        text: "Write the notes file and run tests",
        channel: "cli",
        platform: "slack",
        identity_key: "workspace:U123",
        conversation_id: "C123:1700.1",
        sender_id: "U123",
        message_id: "1700.2",
        cwd: "/repo",
        onEvent: () => undefined,
      });
      const deadline = Date.now() + 5000;
      let pendingApproval = await store.loadPending("approval-grant-narrow");
      while (Date.now() < deadline && pendingApproval === null) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        pendingApproval = await store.loadPending("approval-grant-narrow");
      }
      expect(pendingApproval).not.toBeNull();

      await expect(manager.processIncomingMessage({
        text: "Tests are fine, but do not edit files yet.",
        platform: "slack",
        identity_key: "workspace:U123",
        conversation_id: "C123:1700.1",
        sender_id: "U123",
        message_id: "1700.3",
        cwd: "/repo",
      })).resolves.toBe("Permission grant recorded with a narrower boundary; the current approval was not executed.");

      await expect(resultPromise).resolves.toContain("not approved");
      const grants = await permissionGrantStore.list();
      expect(grants).toHaveLength(1);
      expect(grants[0]).toMatchObject({
        state: "active",
        capabilities: ["run_tests"],
      });
      await expect(store.loadResolved("approval-grant-narrow")).resolves.toMatchObject({
        state: "denied",
      });
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("requires explicit second confirmation before creating standing workspace grants", async () => {
    const tmpDir = makeTempDir();
    try {
      const store = new ApprovalStore(tmpDir);
      const permissionGrantStore = new PermissionGrantStore(tmpDir);
      const approvalBroker = new ApprovalBroker({
        store,
        createId: () => "approval-grant-standing",
      });
      const chatAgentLoopRunner = {
        execute: vi.fn(async (input: {
          approvalFn?: (request: ApprovalRequest) => Promise<boolean>;
          toolCallContext?: ToolCallContext;
        }) => {
          const approved = await input.approvalFn?.({
            toolName: "write_file",
            input: { path: "notes.md" },
            reason: "Write notes.md in the workspace.",
            permissionLevel: "write_local",
            isDestructive: false,
            reversibility: "reversible",
            callId: "call-grant-standing",
            ...(input.toolCallContext?.sessionId ? { sessionId: input.toolCallContext.sessionId } : {}),
            ...(input.toolCallContext?.runId ? { runId: input.toolCallContext.runId } : {}),
            ...(input.toolCallContext?.turnId ? { turnId: input.toolCallContext.turnId } : {}),
            permissionGrantDecision: {
              status: "missing_grant",
              allowed: false,
              reason: "No active PermissionGrant covers the requested local work.",
              requiredCapabilities: ["write_workspace"],
              excludedCapabilities: [],
              consideredGrantIds: [],
            },
          });
          return {
            success: approved === true,
            output: approved === true ? "write approved" : "not approved",
            error: null,
            exit_code: null,
            elapsed_ms: 5,
            stopped_reason: "completed",
          };
        }),
      };
      const manager = new CrossPlatformChatSessionManager(makeDeps({
        chatAgentLoopRunner: chatAgentLoopRunner as never,
        llmClient: createMockLLMClient([
          JSON.stringify({
            decision: "extend_scope",
            confidence: 0.95,
            requested_scope: "standing",
            rationale: "The reply asks for standing permission.",
          }),
          JSON.stringify({
            decision: "extend_scope",
            confidence: 0.99,
            requested_scope: "standing",
            standing_confirmation: {
              scope: "workspace",
            },
            rationale: "The reply explicitly confirms the standing workspace boundary.",
          }),
        ]),
        approvalBroker,
        permissionGrantStore,
      }));

      const resultPromise = manager.processIncomingMessage({
        text: "Write the notes file",
        channel: "cli",
        platform: "slack",
        identity_key: "workspace:U123",
        conversation_id: "C123:1700.1",
        sender_id: "U123",
        message_id: "1700.2",
        cwd: "/repo",
        onEvent: () => undefined,
      });
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && (await store.loadPending("approval-grant-standing")) === null) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      await expect(manager.processIncomingMessage({
        text: "Always allow this from now on.",
        platform: "slack",
        identity_key: "workspace:U123",
        conversation_id: "C123:1700.1",
        sender_id: "U123",
        message_id: "1700.3",
        cwd: "/repo",
      })).resolves.toContain("requires a second explicit confirmation");

      await expect(permissionGrantStore.list()).resolves.toHaveLength(0);
      await expect(store.loadPending("approval-grant-standing")).resolves.toMatchObject({
        state: "pending",
      });

      await expect(manager.processIncomingMessage({
        text: "I explicitly confirm standing workspace permission for write_workspace, excluding write_remote and network_send, and I can revoke it later.",
        platform: "slack",
        identity_key: "workspace:U123",
        conversation_id: "C123:1700.1",
        sender_id: "U123",
        message_id: "1700.4",
        cwd: "/repo",
      })).resolves.toContain("Standing permission grant recorded");

      await expect(resultPromise).resolves.toBe("write approved");
      const grants = await permissionGrantStore.list();
      expect(grants).toHaveLength(1);
      expect(grants[0]).toMatchObject({
        state: "active",
        scope: {
          kind: "workspace",
          workspace_root: "/repo",
        },
        duration: {
          kind: "standing",
        },
        review: {
          kind: "periodic",
        },
        capabilities: ["write_workspace"],
        excluded_capabilities: expect.arrayContaining(["write_remote", "network_send", "destructive_action", "unknown_capability"]),
      });
      expect(grants[0]?.review.kind === "periodic" ? grants[0].review.due_at : 0).toBeGreaterThan(Date.now());
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("routes natural-language permission inspect and revoke through typed runtime control", async () => {
    const tmpDir = makeTempDir();
    try {
      const runtimeRoot = `${tmpDir}/runtime`;
      const permissionGrantStore = new PermissionGrantStore(runtimeRoot);
      await permissionGrantStore.createActive({
        grant_id: "grant-chat-visible",
        subject: { kind: "operator", id: "U123" },
        origin: {
          channel: "slack",
          platform: "slack",
          conversation_id: "C123:1700.1",
          user_id: "U123",
          session_id: "identity:workspace:U123",
          turn_id: "1700.2",
        },
        source: {
          kind: "redacted_text",
          redacted_text: "sensitive approval text",
          redaction_reason: "test",
        },
        scope: { kind: "run", run_id: "run-chat-visible" },
        duration: { kind: "until_run_done" },
        capabilities: ["write_workspace", "run_tests"],
        excluded_capabilities: ["write_remote"],
      });
      const runtimeControlService = new RuntimeControlService({
        runtimeRoot,
        permissionGrantStore,
      });
      const manager = new CrossPlatformChatSessionManager(makeDeps({
        llmClient: createMockLLMClient([
          JSON.stringify({
            intent: "inspect_permission_boundary",
            reason: "inspect active permissions",
          }),
          JSON.stringify({
            intent: "revoke_permission",
            reason: "revoke active permission",
          }),
        ]),
        runtimeControlService,
        permissionGrantStore,
      }));

      await expect(manager.processIncomingMessage({
        text: "今 PulSeed は何を許可されていますか？",
        platform: "slack",
        identity_key: "workspace:U123",
        conversation_id: "C123:1700.1",
        sender_id: "U123",
        message_id: "1700.3",
        cwd: "/repo",
        runtimeControl: {
          allowed: true,
          approvalMode: "interactive",
          explicit: true,
        },
      })).resolves.toContain("Active permission boundary");

      await expect(manager.processIncomingMessage({
        text: "その権限を取り消して",
        platform: "slack",
        identity_key: "workspace:U123",
        conversation_id: "C123:1700.1",
        sender_id: "U123",
        message_id: "1700.4",
        cwd: "/repo",
        runtimeControl: {
          allowed: true,
          approvalMode: "interactive",
          explicit: true,
        },
      })).resolves.toContain("Future covered actions will ask again or block");

      await expect(permissionGrantStore.load("grant-chat-visible")).resolves.toMatchObject({
        state: "revoked",
      });
      await expect(permissionGrantStore.listActive()).resolves.toHaveLength(0);
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("keeps approvals pending for clarification replies and rejects wrong-context replies", async () => {
    const tmpDir = makeTempDir();
    try {
      const store = new ApprovalStore(tmpDir);
      const approvalBroker = new ApprovalBroker({
        store,
        createId: () => "approval-clarify",
      });
      const runtimeControlService = {
        request: vi.fn(async (request: {
          approvalFn?: (description: string) => Promise<boolean>;
        }) => {
          const approved = await request.approvalFn?.("Restart the resident daemon.");
          return {
            success: approved === true,
            message: approved === true ? "restart queued" : "not approved",
            operationId: "op-clarify",
            state: approved === true ? "acknowledged" as const : "blocked" as const,
          };
        }),
      };
      const manager = new CrossPlatformChatSessionManager(makeDeps({
        llmClient: createMockLLMClient([
          JSON.stringify({
            intent: "restart_daemon",
            reason: "PulSeed を再起動して",
          }),
          JSON.stringify({
            decision: "clarify",
            confidence: 0.92,
            clarification: "Approval is still pending while the restart target is clarified.",
          }),
        ]),
        runtimeControlService,
        approvalBroker,
      }));

      const resultPromise = manager.processIncomingMessage({
        text: "PulSeed を再起動して",
        platform: "slack",
        identity_key: "workspace:U123",
        conversation_id: "C123:1700.1",
        sender_id: "U123",
        message_id: "1700.2",
        cwd: "/repo",
        onEvent: () => undefined,
        runtimeControl: {
          allowed: true,
          approvalMode: "interactive",
          explicit: true,
        },
      });
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && (await store.loadPending("approval-clarify")) === null) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      await expect(manager.processIncomingMessage({
        text: "Before deciding, which daemon will restart?",
        platform: "slack",
        identity_key: "workspace:U123",
        conversation_id: "C123:1700.1",
        sender_id: "U123",
        message_id: "1700.3",
        cwd: "/repo",
      })).resolves.toBe("Approval is still pending while the restart target is clarified.");
      await expect(store.loadPending("approval-clarify")).resolves.toMatchObject({
        state: "pending",
      });

      await expect(manager.processIncomingMessage({
        text: "",
        platform: "slack",
        identity_key: "workspace:U999",
        conversation_id: "C123:1700.1",
        sender_id: "U999",
        message_id: "1700.4",
        cwd: "/repo",
        approvalResponse: {
          approval_id: "approval-clarify",
          approved: true,
        },
      })).resolves.toBe("Approval response did not match an active approval for this conversation.");
      await expect(store.loadPending("approval-clarify")).resolves.toMatchObject({
        state: "pending",
      });

      await approvalBroker.resolveConversationalApproval("approval-clarify", false, {
        channel: "slack",
        conversation_id: "C123:1700.1",
        user_id: "U123",
        session_id: "identity:workspace:U123",
        turn_id: "1700.2",
      });
      await expect(resultPromise).resolves.toContain("not approved");
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("routes approval side questions through normal chat while keeping the approval pending", async () => {
    const tmpDir = makeTempDir();
    try {
      const store = new ApprovalStore(tmpDir);
      const approvalBroker = new ApprovalBroker({
        store,
        createId: () => "approval-side-question",
      });
      const runtimeControlService = {
        request: vi.fn(async (request: {
          approvalFn?: (description: string) => Promise<boolean>;
        }) => {
          const approved = await request.approvalFn?.("Restart the resident daemon.");
          return {
            success: approved === true,
            message: approved === true ? "restart queued" : "not approved",
            operationId: "op-side-question",
            state: approved === true ? "acknowledged" as const : "blocked" as const,
          };
        }),
      };
      const adapter = makeMockAdapter({
        ...CANNED_RESULT,
        output: "The daemon restart target is the resident daemon.",
      });
      const manager = new CrossPlatformChatSessionManager(makeDeps({
        adapter,
        llmClient: createMockLLMClient([
          JSON.stringify({
            intent: "restart_daemon",
            reason: "PulSeed を再起動して",
          }),
          JSON.stringify({
            decision: "side_question",
            confidence: 0.93,
            clarification: "Route the side question through normal chat.",
          }),
          "The daemon restart target is the resident daemon.",
        ]),
        runtimeControlService,
        approvalBroker,
      }));

      const resultPromise = manager.processIncomingMessage({
        text: "PulSeed を再起動して",
        platform: "slack",
        identity_key: "workspace:U123",
        conversation_id: "C123:1700.1",
        sender_id: "U123",
        message_id: "1700.2",
        cwd: "/repo",
        onEvent: () => undefined,
        runtimeControl: {
          allowed: true,
          approvalMode: "interactive",
          explicit: true,
        },
      });
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && (await store.loadPending("approval-side-question")) === null) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      await expect(manager.processIncomingMessage({
        text: "Before deciding, which daemon will restart?",
        platform: "slack",
        identity_key: "workspace:U123",
        conversation_id: "C123:1700.1",
        sender_id: "U123",
        message_id: "1700.3",
        cwd: "/repo",
      })).resolves.toBe("The daemon restart target is the resident daemon.");
      await expect(store.loadPending("approval-side-question")).resolves.toMatchObject({
        state: "pending",
      });

      await approvalBroker.resolveConversationalApproval("approval-side-question", false, {
        channel: "slack",
        conversation_id: "C123:1700.1",
        user_id: "U123",
        session_id: "identity:workspace:U123",
        turn_id: "1700.2",
      });
      await expect(resultPromise).resolves.toContain("not approved");
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("reconstructs pending permission epoch after manager restart before rejecting stale typed approvals", async () => {
    const tmpDir = makeTempDir();
    let approvalBroker1: ApprovalBroker | undefined;
    let approvalBroker2: ApprovalBroker | undefined;
    let approvalBroker3: ApprovalBroker | undefined;
    try {
      const stateManager = new RealStateManager(tmpDir, undefined, { walEnabled: false });
      await stateManager.init();
      const store = new ApprovalStore(tmpDir);
      approvalBroker1 = new ApprovalBroker({
        store,
        createId: () => "approval-reconstructed-epoch",
      });
      const runtimeControlService = {
        request: vi.fn(async (request: {
          approvalFn?: (description: string) => Promise<boolean>;
        }) => {
          const approved = await request.approvalFn?.("Restart the resident daemon.");
          return {
            success: approved === true,
            message: approved === true ? "restart queued" : "not approved",
            operationId: "op-reconstructed-epoch",
            state: approved === true ? "acknowledged" as const : "blocked" as const,
          };
        }),
      };
      const firstManager = new CrossPlatformChatSessionManager(makeDeps({
        stateManager,
        llmClient: createMockLLMClient([
          JSON.stringify({
            intent: "restart_daemon",
            reason: "PulSeed を再起動して",
          }),
        ]),
        runtimeControlService,
        approvalBroker: approvalBroker1,
      }));

      void firstManager.processIncomingMessage({
        text: "PulSeed を再起動して",
        platform: "slack",
        identity_key: "workspace:U123",
        conversation_id: "C123:1700.1",
        sender_id: "U123",
        message_id: "1700.2",
        cwd: "/repo",
        onEvent: () => undefined,
        runtimeControl: {
          allowed: true,
          approvalMode: "interactive",
          explicit: true,
        },
      });
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && (await store.loadPending("approval-reconstructed-epoch")) === null) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await expect(store.loadPending("approval-reconstructed-epoch")).resolves.toMatchObject({
        state: "pending",
        payload: {
          task: {
            state_epoch: "1700.2",
          },
        },
      });
      await approvalBroker1.stop();

      approvalBroker2 = new ApprovalBroker({
        store,
        createId: () => "unused-approval-id",
      });
      const secondManager = new CrossPlatformChatSessionManager(makeDeps({
        stateManager,
        llmClient: createMockLLMClient([
          JSON.stringify({
            decision: "side_question",
            confidence: 0.93,
            clarification: "Route the side question through normal chat.",
          }),
          "The daemon restart target is the resident daemon.",
        ]),
        approvalBroker: approvalBroker2,
      }));

      await expect(secondManager.processIncomingMessage({
        text: "Before deciding, which daemon will restart?",
        platform: "slack",
        identity_key: "workspace:U123",
        conversation_id: "C123:1700.1",
        sender_id: "U123",
        message_id: "1700.3",
        cwd: "/repo",
      })).resolves.toBe("The daemon restart target is the resident daemon.");
      expect(secondManager.getSessionInfo({ identity_key: "workspace:U123" })?.last_message_id).toBe("1700.3");
      await expect(store.loadPending("approval-reconstructed-epoch")).resolves.toMatchObject({
        state: "pending",
      });
      await approvalBroker2.stop();

      approvalBroker3 = new ApprovalBroker({
        store,
        createId: () => "unused-approval-id",
      });
      const thirdManager = new CrossPlatformChatSessionManager(makeDeps({
        stateManager,
        approvalBroker: approvalBroker3,
      }));

      await expect(thirdManager.processIncomingMessage({
        text: "",
        platform: "slack",
        identity_key: "workspace:U123",
        conversation_id: "C123:1700.1",
        sender_id: "U123",
        message_id: "1700.4",
        cwd: "/repo",
        approvalResponse: {
          approval_id: "approval-reconstructed-epoch",
          approved: true,
        },
      })).resolves.toContain("approval target changed after the prompt");
      await expect(store.loadResolved("approval-reconstructed-epoch")).resolves.toMatchObject({
        state: "denied",
      });
    } finally {
      await approvalBroker1?.stop();
      await approvalBroker2?.stop();
      await approvalBroker3?.stop();
      cleanupTempDir(tmpDir);
    }
  });

  it("rejects natural-language approval after the pending target state epoch changes", async () => {
    const tmpDir = makeTempDir();
    try {
      const store = new ApprovalStore(tmpDir);
      const approvalBroker = new ApprovalBroker({
        store,
        createId: () => "approval-stale-target",
      });
      const runtimeControlService = {
        request: vi.fn(async (request: {
          approvalFn?: (description: string) => Promise<boolean>;
        }) => {
          const approved = await request.approvalFn?.("Restart the resident daemon.");
          return {
            success: approved === true,
            message: approved === true ? "restart queued" : "not approved",
            operationId: "op-stale-target",
            state: approved === true ? "acknowledged" as const : "blocked" as const,
          };
        }),
      };
      const adapter = makeMockAdapter({
        ...CANNED_RESULT,
        output: "The daemon restart target is the resident daemon.",
      });
      const manager = new CrossPlatformChatSessionManager(makeDeps({
        adapter,
        llmClient: createMockLLMClient([
          JSON.stringify({
            intent: "restart_daemon",
            reason: "PulSeed を再起動して",
          }),
          JSON.stringify({
            decision: "side_question",
            confidence: 0.93,
            clarification: "Route the side question through normal chat.",
          }),
          "The daemon restart target is the resident daemon.",
        ]),
        runtimeControlService,
        approvalBroker,
      }));

      const resultPromise = manager.processIncomingMessage({
        text: "PulSeed を再起動して",
        platform: "slack",
        identity_key: "workspace:U123",
        conversation_id: "C123:1700.1",
        sender_id: "U123",
        message_id: "1700.2",
        cwd: "/repo",
        onEvent: () => undefined,
        runtimeControl: {
          allowed: true,
          approvalMode: "interactive",
          explicit: true,
        },
      });
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && (await store.loadPending("approval-stale-target")) === null) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      await expect(manager.processIncomingMessage({
        text: "Before deciding, which daemon will restart?",
        platform: "slack",
        identity_key: "workspace:U123",
        conversation_id: "C123:1700.1",
        sender_id: "U123",
        message_id: "1700.3",
        cwd: "/repo",
      })).resolves.toBe("The daemon restart target is the resident daemon.");

      await expect(manager.processIncomingMessage({
        text: "問題ありません。進めてください",
        platform: "slack",
        identity_key: "workspace:U123",
        conversation_id: "C123:1700.1",
        sender_id: "U123",
        message_id: "1700.4",
        cwd: "/repo",
      })).resolves.toContain("approval target changed after the prompt");
      await expect(resultPromise).resolves.toContain("not approved");
      await expect(store.loadResolved("approval-stale-target")).resolves.toMatchObject({
        state: "denied",
      });
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("rejects typed approval responses after the pending target state epoch changes", async () => {
    const tmpDir = makeTempDir();
    try {
      const store = new ApprovalStore(tmpDir);
      const approvalBroker = new ApprovalBroker({
        store,
        createId: () => "approval-stale-button",
      });
      const runtimeControlService = {
        request: vi.fn(async (request: {
          approvalFn?: (description: string) => Promise<boolean>;
        }) => {
          const approved = await request.approvalFn?.("Restart the resident daemon.");
          return {
            success: approved === true,
            message: approved === true ? "restart queued" : "not approved",
            operationId: "op-stale-button",
            state: approved === true ? "acknowledged" as const : "blocked" as const,
          };
        }),
      };
      const adapter = makeMockAdapter({
        ...CANNED_RESULT,
        output: "The daemon restart target is the resident daemon.",
      });
      const llmClient = createMockLLMClient([
        JSON.stringify({
          intent: "restart_daemon",
          reason: "PulSeed を再起動して",
        }),
        JSON.stringify({
          decision: "side_question",
          confidence: 0.93,
          clarification: "Route the side question through normal chat.",
        }),
        "The daemon restart target is the resident daemon.",
      ]);
      const manager = new CrossPlatformChatSessionManager(makeDeps({
        adapter,
        llmClient,
        runtimeControlService,
        approvalBroker,
      }));

      const resultPromise = manager.processIncomingMessage({
        text: "PulSeed を再起動して",
        platform: "slack",
        identity_key: "workspace:U123",
        conversation_id: "C123:1700.1",
        sender_id: "U123",
        message_id: "1700.2",
        cwd: "/repo",
        onEvent: () => undefined,
        runtimeControl: {
          allowed: true,
          approvalMode: "interactive",
          explicit: true,
        },
      });
      const deadline = Date.now() + 5_000;
      while (
        Date.now() < deadline
        && ((await store.loadPending("approval-stale-button")) === null || llmClient.callCount < 1)
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await expect(store.loadPending("approval-stale-button")).resolves.toMatchObject({
        state: "pending",
      });
      expect(llmClient.callCount).toBeGreaterThanOrEqual(1);

      await expect(manager.processIncomingMessage({
        text: "Before deciding, which daemon will restart?",
        platform: "slack",
        identity_key: "workspace:U123",
        conversation_id: "C123:1700.1",
        sender_id: "U123",
        message_id: "1700.3",
        cwd: "/repo",
      })).resolves.toBe("The daemon restart target is the resident daemon.");

      await expect(manager.processIncomingMessage({
        text: "",
        platform: "slack",
        identity_key: "workspace:U123",
        conversation_id: "C123:1700.1",
        sender_id: "U123",
        message_id: "1700.2",
        cwd: "/repo",
        approvalResponse: {
          approval_id: "approval-stale-button",
          approved: true,
        },
      })).resolves.toContain("approval target changed after the prompt");
      await expect(resultPromise).resolves.toContain("not approved");
      await expect(store.loadResolved("approval-stale-button")).resolves.toMatchObject({
        state: "denied",
      });
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("rejects stale typed approval responses even when another pending approval makes lookup ambiguous", async () => {
    const tmpDir = makeTempDir();
    try {
      const store = new ApprovalStore(tmpDir);
      const approvalBroker = new ApprovalBroker({
        store,
        createId: () => "unused",
        deliverConversationalApproval: async () => ({ delivered: true }),
      });
      const manager = new CrossPlatformChatSessionManager(makeDeps({ approvalBroker }));
      await manager.processIncomingMessage({
        text: "ordinary state-changing turn",
        platform: "slack",
        identity_key: "workspace:U123",
        conversation_id: "C123:1700.1",
        sender_id: "U123",
        message_id: "1700.3",
        cwd: "/repo",
      });
      const oldRequest = approvalBroker.requestConversationalApproval("goal-1", {
        kind: "permission",
        id: "call-old",
        description: "Write the old file.",
        action: "write_file",
        operation_summary: "Write the old file.",
        risk_class: "medium",
        target: {
          session_id: "identity:workspace:U123",
          tool_id: "write_file",
          tool_call_id: "call-old",
        },
        state_epoch: "1700.2",
        state_version: "2026-05-06T00:00:00.000Z",
      }, {
        approvalId: "approval-old-stale",
        timeoutMs: 30_000,
        origin: {
          channel: "slack",
          conversation_id: "C123:1700.1",
          user_id: "U123",
          session_id: "identity:workspace:U123",
          turn_id: "1700.2",
        },
      });
      const newRequest = approvalBroker.requestConversationalApproval("goal-1", {
        kind: "permission",
        id: "call-new",
        description: "Write the new file.",
        action: "write_file",
        operation_summary: "Write the new file.",
        risk_class: "medium",
        target: {
          session_id: "identity:workspace:U123",
          tool_id: "write_file",
          tool_call_id: "call-new",
        },
        state_epoch: "1700.3",
        state_version: "2026-05-06T00:00:01.000Z",
      }, {
        approvalId: "approval-new-pending",
        timeoutMs: 30_000,
        origin: {
          channel: "slack",
          conversation_id: "C123:1700.1",
          user_id: "U123",
          session_id: "identity:workspace:U123",
          turn_id: "1700.3",
        },
      });
      const deadline = Date.now() + 5_000;
      while (
        Date.now() < deadline
        && (
          (await store.loadPending("approval-old-stale")) === null
          || (await store.loadPending("approval-new-pending")) === null
        )
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      await expect(manager.processIncomingMessage({
        text: "",
        platform: "slack",
        identity_key: "workspace:U123",
        conversation_id: "C123:1700.1",
        sender_id: "U123",
        message_id: "1700.2",
        cwd: "/repo",
        approvalResponse: {
          approval_id: "approval-old-stale",
          approved: true,
        },
      })).resolves.toContain("approval target changed after the prompt");
      await expect(store.loadResolved("approval-old-stale")).resolves.toMatchObject({
        state: "denied",
      });
      await expect(store.loadPending("approval-new-pending")).resolves.toMatchObject({
        state: "pending",
      });
      await expect(oldRequest).resolves.toBe(false);
      await approvalBroker.resolveConversationalApproval("approval-new-pending", false, {
        channel: "slack",
        conversation_id: "C123:1700.1",
        user_id: "U123",
        session_id: "identity:workspace:U123",
        turn_id: "1700.3",
      });
      await expect(newRequest).resolves.toBe(false);
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("fails closed when the originating conversation delivery handler rejects", async () => {
    const tmpDir = makeTempDir();
    try {
      const store = new ApprovalStore(tmpDir);
      const approvalBroker = new ApprovalBroker({
        store,
        createId: () => "approval-delivery-failure",
      });
      const runtimeControlService = {
        request: vi.fn(async (request: {
          approvalFn?: (description: string) => Promise<boolean>;
        }) => {
          const approved = await request.approvalFn?.("Restart the resident daemon.");
          return {
            success: approved === true,
            message: approved === true ? "restart queued" : "not approved",
            operationId: "op-approval",
            state: approved === true ? "acknowledged" as const : "blocked" as const,
          };
        }),
      };
      const manager = new CrossPlatformChatSessionManager(makeDeps({
        llmClient: createSingleMockLLMClient(JSON.stringify({
          intent: "restart_daemon",
          reason: "PulSeed を再起動して",
        })),
        runtimeControlService,
        approvalBroker,
      }));

      const result = await manager.processIncomingMessage({
        text: "PulSeed を再起動して",
        platform: "slack",
        identity_key: "workspace:U123",
        conversation_id: "C123:1700.1",
        sender_id: "U123",
        message_id: "1700.2",
        cwd: "/repo",
        onEvent: async () => {
          throw new Error("slack delivery failed");
        },
        runtimeControl: {
          allowed: true,
          approvalMode: "interactive",
          explicit: true,
        },
      });

      expect(result).toContain("not approved");
      const resolved = await store.loadResolved("approval-delivery-failure");
      expect(resolved).toMatchObject({
        state: "denied",
        response_channel: "slack",
      });
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("does not route broad finish text to runtime control without run context", async () => {
    const stateManager = makeMockStateManager();
    const adapter = makeMockAdapter();
    const chatAgentLoopRunner = {
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: "agent loop should not run",
        error: null,
        exit_code: null,
        elapsed_ms: 42,
        stopped_reason: "completed",
      }),
    };
    const runtimeControlService = {
      request: vi.fn().mockResolvedValue({
        success: true,
        message: "runtime control should not run",
      }),
    };
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager,
      adapter,
      chatAgentLoopRunner: chatAgentLoopRunner as never,
      llmClient: createMockLLMClient([
        "Default model loop handles ordinary finish request.",
      ]),
      runtimeControlService,
      runtimeControlApprovalFn: vi.fn().mockResolvedValue(true),
    }));

    const result = await manager.execute("finish the implementation", {
      identity_key: "owner",
      platform: "telegram",
      conversation_id: "telegram-chat-1",
      user_id: "user-1",
      cwd: "/repo",
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe("Default model loop handles ordinary finish request.");
    expect(chatAgentLoopRunner.execute).not.toHaveBeenCalled();
    expect(adapter.execute).not.toHaveBeenCalled();
    expect(runtimeControlService.request).not.toHaveBeenCalled();
  });

  it("lets gateway Telegram setup requests call setup guidance from the default model loop", async () => {
    const stateManager = makeMockStateManager();
    const adapter = makeMockAdapter();
    const guidanceTool = createSetupRuntimeControlTools({
      stateManager,
      gatewaySetupStatusProvider: {
        getTelegramStatus: vi.fn().mockResolvedValue({
          channel: "telegram",
          state: "unconfigured",
          configPath: "/tmp/pulseed/gateway/channels/telegram-bot/config.json",
          daemon: { running: true, port: 41700 },
          gateway: { loadState: "unknown" },
          config: {
            exists: false,
            hasBotToken: false,
            hasHomeChat: false,
            allowAll: false,
            allowedUserCount: 0,
            runtimeControlAllowedUserCount: 0,
            identityKeyConfigured: false,
          },
        }),
      },
    }).find((tool) => tool.metadata.name === "prepare_gateway_setup_guidance")!;
    const guidanceCall = vi.spyOn(guidanceTool, "call");
    const chatAgentLoopRunner = {
      execute: vi.fn().mockResolvedValue(CANNED_RESULT),
    };
    const llmClient = {
      sendMessage: vi.fn().mockResolvedValue({
        content: JSON.stringify({ verdict: "allow", reason: "setup guidance used tool evidence" }),
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: "end_turn",
      }),
      sendMessageStream: vi.fn()
        .mockResolvedValueOnce({
          content: "設定状況を確認します。",
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: "tool_calls",
          tool_calls: [{
            id: "call-setup-guidance",
            type: "function",
            function: {
              name: "prepare_gateway_setup_guidance",
              arguments: JSON.stringify({
                channel: "telegram",
                request: "telegramからseedyと会話できるようにしたい",
                language: "ja",
              }),
            },
          }],
        })
        .mockResolvedValueOnce({
          content: "Telegram gateway status\nchat-assisted setup\npulseed daemon status",
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: "end_turn",
          tool_calls: [],
        }),
      supportsToolCalling: vi.fn(() => true),
      parseJSON: vi.fn((content: string, schema: { parse(value: unknown): unknown }) => schema.parse(JSON.parse(content))),
    };
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager,
      adapter,
      chatAgentLoopRunner: chatAgentLoopRunner as never,
      llmClient: llmClient as never,
      registry: makeRegistryWithTools([guidanceTool]),
    }));

    const result = await manager.execute("telegramからseedyと会話できるようにしたい", {
      identity_key: "owner",
      platform: "telegram",
      conversation_id: "telegram-chat-1",
      user_id: "user-1",
      cwd: "/repo",
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("Telegram gateway status");
    expect(result.output).toContain("chat-assisted setup");
    expect(result.output).toContain("pulseed daemon status");
    expect(guidanceCall).toHaveBeenCalledOnce();
    expect(llmClient.sendMessageStream).toHaveBeenCalledTimes(2);
    expect(chatAgentLoopRunner.execute).not.toHaveBeenCalled();
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it("routes long-running work through the native agent loop and leaves durable handoff to tools", async () => {
    const stateManager = makeMockStateManager();
    const adapter = makeMockAdapter();
    const chatAgentLoopRunner = {
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: "Agent loop can choose core_tend_goal when durable DurableLoop handoff is needed.",
        error: null,
        exit_code: null,
        elapsed_ms: 42,
        stopped_reason: "completed",
      }),
    };
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager,
      adapter,
      chatAgentLoopRunner: chatAgentLoopRunner as never,
    }));

    const result = await manager.execute("coreloopの方でscore0.98行くまで取り組んで", {
      identity_key: "owner",
      channel: "tui",
      platform: "local_tui",
      conversation_id: "tui-session",
      cwd: "/repo",
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("core_tend_goal");
    expect(chatAgentLoopRunner.execute).toHaveBeenCalledWith(expect.objectContaining({
      message: "coreloopの方でscore0.98行くまで取り組んで",
      cwd: "/repo",
    }));
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it("serializes concurrent turns for the same shared session across channels", async () => {
    let activeCalls = 0;
    let maxConcurrentCalls = 0;
    const llmClient = {
      sendMessage: vi.fn().mockRejectedValue(new Error("sendMessage should not run")),
      sendMessageStream: vi.fn().mockImplementation(async () => {
        activeCalls += 1;
        maxConcurrentCalls = Math.max(maxConcurrentCalls, activeCalls);
        await new Promise((resolve) => setTimeout(resolve, 20));
        activeCalls -= 1;
        return {
          content: "Task completed successfully.",
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: "end_turn",
          tool_calls: [],
        };
      }),
      supportsToolCalling: vi.fn(() => true),
      parseJSON: vi.fn((content: string, schema: { parse(value: unknown): unknown }) => schema.parse(JSON.parse(content))),
    };
    const adapter = makeMockAdapter();
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager: makeMockStateManager(),
      adapter,
      llmClient: llmClient as never,
      registry: makeRegistryWithTools([]),
    }));

    await Promise.all([
      manager.processIncomingMessage({
        text: "turn one",
        identity_key: "shared-user",
        platform: "discord",
        conversation_id: "discord-1",
        sender_id: "u-1",
        cwd: "/repo",
      }),
      manager.processIncomingMessage({
        text: "turn two",
        identity_key: "shared-user",
        platform: "telegram",
        conversation_id: "telegram-2",
        sender_id: "u-1",
        cwd: "/repo",
      }),
    ]);

    expect(llmClient.sendMessageStream).toHaveBeenCalledTimes(2);
    expect(adapter.execute).not.toHaveBeenCalled();
    expect(maxConcurrentCalls).toBe(1);
  });

  it("passes gateway-routed goal_id into gateway model-loop tool context", async () => {
    const adapter = makeMockAdapter();
    const observedGoalIds: string[] = [];
    const tool = makeScopedTool("read");
    tool.call = vi.fn().mockImplementation(async (_input: unknown, context: ToolCallContext) => {
      observedGoalIds.push(context.goalId);
      return {
        success: true,
        data: { ok: true },
        summary: "read ran",
        durationMs: 1,
      };
    });
    const llmClient = makeStreamingLLMClient([
      {
        content: "",
        stop_reason: "tool_calls",
        tool_calls: [{
          id: "call-goal-1",
          type: "function",
          function: { name: "read", arguments: "{}" },
        }],
      },
      { content: "Gateway loop response" },
      {
        content: "",
        stop_reason: "tool_calls",
        tool_calls: [{
          id: "call-goal-2",
          type: "function",
          function: { name: "read", arguments: "{}" },
        }],
      },
      { content: "Gateway loop response next" },
    ]);
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager: makeMockStateManager(),
      adapter,
      llmClient: llmClient as never,
      registry: makeRegistryWithTools([tool]),
    }));

    const result = await manager.processIncomingMessage({
      text: "implement this",
      platform: "slack",
      conversation_id: "C_GENERAL",
      sender_id: "U123",
      goal_id: "goal-routed",
      metadata: { goal_id: "goal-metadata-only" },
      cwd: "/repo",
    });
    await manager.processIncomingMessage({
      text: "implement next thing",
      platform: "slack",
      conversation_id: "C_GENERAL",
      sender_id: "U123",
      goal_id: "goal-next",
      cwd: "/repo",
    });

    expect(result).toBe("Gateway loop response");
    expect(adapter.execute).not.toHaveBeenCalled();
    expect(observedGoalIds).toEqual(["goal-routed", "goal-next"]);
    const info = manager.getSessionInfo({
      platform: "slack",
      conversation_id: "C_GENERAL",
      user_id: "U123",
    });
    expect(info?.active_companion_contract?.turn_policy.current_target).toMatchObject({
      conversation_id: "C_GENERAL",
      message_id: null,
      goal_id: "goal-next",
    });
    expect(info?.active_companion_contract?.turn_policy.current_target.goal_id).not.toBe("goal-routed");
  });

  it("does not let stale companion target overrides replace the current gateway turn", async () => {
    const adapter = makeMockAdapter();
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager: makeMockStateManager(),
      adapter,
    }));

    await manager.processIncomingMessage({
      text: "Use current target",
      platform: "slack",
      identity_key: "owner",
      conversation_id: "current-thread",
      message_id: "current-message",
      goal_id: "goal-current",
      sender_id: "owner-user",
      cwd: "/repo",
      companion: {
        presence: {
          mode: "listening",
          interruptible: true,
          current_target: {
            session_key: "identity:stale",
            conversation_id: "stale-thread",
            message_id: "stale-message",
            run_id: "run-stale",
            goal_id: "goal-stale",
            reply_target_id: "stale-thread",
          },
        },
        turnPolicy: {
          dialogue_kind: "direct_turn",
          input_modality: "text",
          output_mode: "reply",
          urgency: "normal",
          current_target: {
            session_key: "identity:stale",
            conversation_id: "stale-thread",
            message_id: "stale-message",
            run_id: "run-stale",
            goal_id: "goal-stale",
            reply_target_id: "stale-thread",
          },
        },
      },
    });

    const contract = manager.getSessionInfo({ identity_key: "owner" })?.active_companion_contract;
    expect(contract?.presence.current_target).toMatchObject({
      session_key: "identity:owner",
      conversation_id: "current-thread",
      message_id: "current-message",
      goal_id: "goal-current",
      reply_target_id: "current-thread",
    });
    expect(contract?.turn_policy.current_target).toMatchObject({
      session_key: "identity:owner",
      conversation_id: "current-thread",
      message_id: "current-message",
      goal_id: "goal-current",
      reply_target_id: "current-thread",
    });
    expect(contract?.turn_policy.current_target.goal_id).not.toBe("goal-stale");
  });

  it("renormalizes pre-populated ingress companion targets before execution", async () => {
    const adapter = makeMockAdapter();
    const llmClient = makeStreamingLLMClient([{ content: "Task completed successfully." }]);
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager: makeMockStateManager(),
      adapter,
      llmClient: llmClient as never,
      registry: makeRegistryWithTools([]),
    }));

    const result = await manager.executeIngress({
      ingress_id: "ingress-current",
      received_at: "2026-05-13T00:00:00.000Z",
      channel: "plugin_gateway",
      platform: "slack",
      identity_key: "owner",
      conversation_id: "current-thread",
      message_id: "current-message",
      goal_id: "goal-current",
      user_id: "owner-user",
      text: "Use current target",
      userInput: {
        schema_version: "user-input-v1",
        rawText: "Use current target",
        items: [{ kind: "text", text: "Use current target" }],
      },
      actor: {
        surface: "chat",
        platform: "slack",
        conversation_id: "current-thread",
        identity_key: "owner",
        user_id: "owner-user",
      },
      runtimeControl: {
        allowed: true,
        approvalMode: "interactive",
        approval_mode: "interactive",
      },
      companion: {
        schema_version: "companion-runtime-contract-v1",
        presence: {
          schema_version: "companion-presence-state-v1",
          mode: "listening",
          interruptible: true,
          last_user_activity_at: "2026-05-13T00:00:00.000Z",
          current_context: "work",
          current_target: {
            session_key: "identity:stale",
            conversation_id: "stale-thread",
            message_id: "stale-message",
            run_id: "run-stale",
            goal_id: "goal-stale",
            reply_target_id: "stale-thread",
          },
        },
        turn_policy: {
          schema_version: "companion-turn-policy-v1",
          dialogue_kind: "direct_turn",
          input_modality: "text",
          output_mode: "reply",
          can_interrupt: true,
          latency_budget_ms: 30_000,
          urgency: "normal",
          quieting: "allow",
          requires_explicit_interruption: false,
          current_target: {
            session_key: "identity:stale",
            conversation_id: "stale-thread",
            message_id: "stale-message",
            run_id: "run-stale",
            goal_id: "goal-stale",
            reply_target_id: "stale-thread",
          },
        },
      },
      replyTarget: {
        surface: "chat",
        channel: "plugin_gateway",
        platform: "slack",
        conversation_id: "current-thread",
        message_id: "current-message",
        identity_key: "owner",
        user_id: "owner-user",
        metadata: {},
      },
      metadata: {},
    }, { cwd: "/repo" });

    const contract = manager.getSessionInfo({ identity_key: "owner" })?.active_companion_contract;
    expect(result.success).toBe(true);
    expect(contract?.presence.current_target).toMatchObject({
      session_key: "identity:owner",
      conversation_id: "current-thread",
      message_id: "current-message",
      goal_id: "goal-current",
      reply_target_id: "current-thread",
    });
    expect(contract?.turn_policy.current_target).toMatchObject({
      session_key: "identity:owner",
      conversation_id: "current-thread",
      message_id: "current-message",
      goal_id: "goal-current",
      reply_target_id: "current-thread",
    });
    expect(contract?.turn_policy.current_target.goal_id).not.toBe("goal-stale");
    expect(contract?.turn_policy.current_target.run_id).toBeNull();
  });

  it("routes gateway text through the companion contract before gateway model-loop execution", async () => {
    const adapter = makeMockAdapter();
    const llmClient = makeStreamingLLMClient([{ content: "Task completed successfully." }]);
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager: makeMockStateManager(),
      adapter,
      llmClient: llmClient as never,
      registry: makeRegistryWithTools([]),
    }));

    const result = await manager.processIncomingMessage({
      text: "Please look at this",
      platform: "telegram",
      identity_key: "owner",
      conversation_id: "telegram-thread",
      message_id: "msg-current",
      goal_id: "goal-current",
      sender_id: "owner-user",
      cwd: "/repo",
      companion: {
        presence: {
          mode: "listening",
          interruptible: true,
          current_context: "work",
        },
        turnPolicy: {
          dialogue_kind: "direct_turn",
          input_modality: "text",
          output_mode: "reply",
          urgency: "normal",
        },
      },
    });

    const receivedIngress = manager.getSessionInfo({ identity_key: "owner" })?.active_companion_contract ?? null;
    expect(result).toBe("Task completed successfully.");
    expect(adapter.execute).not.toHaveBeenCalled();
    expect(llmClient.sendMessageStream).toHaveBeenCalledOnce();
    expect(receivedIngress).toMatchObject({
      turn_policy: {
        current_target: {
          session_key: "identity:owner",
          conversation_id: "telegram-thread",
          message_id: "msg-current",
          goal_id: "goal-current",
        },
      },
    });
  });

  it("suppresses non-urgent proactive output while presence is do-not-disturb", async () => {
    const adapter = makeMockAdapter();
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager: makeMockStateManager(),
      adapter,
    }));

    const result = await manager.processIncomingMessage({
      text: "A gentle proactive check-in",
      platform: "slack",
      conversation_id: "C_DND",
      sender_id: "U123",
      cwd: "/repo",
      companion: {
        presence: {
          mode: "do_not_disturb",
          interruptible: false,
          current_context: "sleep",
        },
        turnPolicy: {
          dialogue_kind: "proactive",
          input_modality: "notification",
          output_mode: "notification",
          urgency: "normal",
        },
      },
    });

    expect(result).toContain("suppressed by the current quieting policy");
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it("requires explicit interruption when the current turn is non-interruptible", async () => {
    const adapter = makeMockAdapter();
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager: makeMockStateManager(),
      adapter,
    }));

    const result = await manager.interruptAndRedirect({
      text: "別の作業に切り替えて",
      platform: "telegram",
      conversation_id: "thread-noninterruptible",
      sender_id: "owner",
      cwd: "/repo",
      companion: {
        presence: {
          mode: "thinking",
          interruptible: false,
          current_context: "work",
        },
        turnPolicy: {
          dialogue_kind: "interruption",
          input_modality: "text",
          output_mode: "reply",
          can_interrupt: false,
          urgency: "normal",
        },
      },
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("non-interruptible");
    expect(adapter.execute).not.toHaveBeenCalled();
  });
});
