import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
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
import { createSetupRuntimeControlTools } from "../../../tools/runtime/SetupRuntimeControlTools.js";
import type { ApprovalRequest, ITool, ToolCallContext } from "../../../tools/types.js";
import { ToolRegistry } from "../../../tools/registry.js";
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
      name: "check_readme",
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
      JSON.stringify({ kind: "assist", confidence: 0.95, rationale: "generic fallback" }),
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

  it("reuses the same ChatRunner session for the same identity_key across platforms", async () => {
    const stateManager = makeMockStateManager();
    const manager = new CrossPlatformChatSessionManager(makeDeps({ stateManager }));
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
    const manager = new CrossPlatformChatSessionManager(makeDeps({ stateManager }));
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
        content: JSON.stringify({ kind: "assist", confidence: 0.95, rationale: "read-only answer" }),
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
            : JSON.stringify({ kind: "assist", confidence: 0.96, rationale: "casual greeting" }),
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
            function: { name: "check_readme", arguments: "{}" },
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
    const firstOptions = llmClient.sendMessageStream.mock.calls[0]?.[1];
    expect((firstOptions?.tools ?? []).map((item: { function: { name: string } }) => item.function.name))
      .toContain("check_readme");
    expect(events.some((event) => event.type === "tool_start" && event.toolName === "check_readme")).toBe(true);
    expect(events.some((event) => event.type === "tool_end" && event.toolName === "check_readme" && event.success)).toBe(true);
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
            function: { name: "check_readme", arguments: "{}" },
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

  it("does not run post-final evidence repair on ordinary gateway replies", async () => {
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
    expect(result.output).toBe("やあ。PulSeed dogfood 用の作業ディレクトリにいます。何を進めますか？");
    expect(llmClient.sendMessage).not.toHaveBeenCalled();
  });

  it("does not run post-final evidence fail-closed classification on ordinary gateway replies", async () => {
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
    expect(result.output).toBe("PulSeed の daemon は正常に動いています。");
    expect(llmClient.sendMessage).not.toHaveBeenCalled();
  });

  it("streams ordinary gateway model deltas directly without buffered evidence repair", async () => {
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

    await manager.execute("やあ！", {
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
    expect(deltas.map((event) => event.delta).join("")).toContain("作業ディレクトリ");
    expect(llmClient.sendMessage).not.toHaveBeenCalled();
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
            ? JSON.stringify({ kind: "assist", confidence: 0.95, rationale: "read-only answer" })
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
    });
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

  it("does not generate gateway commentary preambles before agent-loop execution", async () => {
    const events: ChatEvent[] = [];
    const order: string[] = [];
    const chatAgentLoopRunner = {
      execute: vi.fn().mockImplementation(async () => {
        order.push("agent-loop");
        return {
          success: true,
          output: "Task completed successfully.",
          error: null,
          exit_code: null,
          elapsed_ms: 42,
          stopped_reason: "completed",
        };
      }),
    };
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager: makeMockStateManager(),
      chatAgentLoopRunner: chatAgentLoopRunner as never,
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
    expect(order).toEqual(["agent-loop"]);
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

  it("enters agent-loop execution without waiting on deleted gateway preamble generation", async () => {
    const order: string[] = [];
    const chatAgentLoopRunner = {
      execute: vi.fn().mockImplementation(async () => {
        order.push("agent-loop");
        return {
          success: true,
          output: "Task completed successfully.",
          error: null,
          exit_code: null,
          elapsed_ms: 42,
          stopped_reason: "completed",
        };
      }),
    };
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager: makeMockStateManager(),
      chatAgentLoopRunner: chatAgentLoopRunner as never,
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
    expect(order).toEqual(["agent-loop"]);
    expect(Date.now() - startedAt).toBeLessThan(2_500);
  });

  it("drains async per-turn event delivery before returning to gateway callers", async () => {
    const stateManager = makeMockStateManager();
    const manager = new CrossPlatformChatSessionManager(makeDeps({ stateManager }));
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
    let resolveActive: ((value: AgentResult) => void) | undefined;
    const chatAgentLoopRunner = {
      execute: vi.fn().mockImplementation((input: { abortSignal?: AbortSignal }) => {
        return new Promise<AgentResult>((resolve) => {
          resolveActive = resolve;
          input.abortSignal?.addEventListener("abort", () => {
            resolve({
              success: false,
              output: "cancelled",
              error: "cancelled",
              exit_code: null,
              elapsed_ms: 10,
              stopped_reason: "error",
            });
          }, { once: true });
        });
      }),
    };
    const events: ChatEvent[] = [];
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager: makeMockStateManager(),
      chatAgentLoopRunner: chatAgentLoopRunner as never,
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
    await vi.waitFor(() => expect(chatAgentLoopRunner.execute).toHaveBeenCalledOnce());

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
    expect(chatAgentLoopRunner.execute).toHaveBeenCalledOnce();
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

    resolveActive?.(CANNED_RESULT);
    await active;
  });

  it("reports active Seedy status from typed turn state without emitting a new reply", async () => {
    let resolveActive: ((value: AgentResult) => void) | undefined;
    const chatAgentLoopRunner = {
      execute: vi.fn().mockImplementation(() => {
        return new Promise<AgentResult>((resolve) => {
          resolveActive = resolve;
        });
      }),
    };
    const events: ChatEvent[] = [];
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager: makeMockStateManager(),
      chatAgentLoopRunner: chatAgentLoopRunner as never,
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
    await vi.waitFor(() => expect(chatAgentLoopRunner.execute).toHaveBeenCalledOnce());
    const eventCountBeforeStatus = events.length;

    const status = manager.getActiveSeedyTurnStatus({
      identity_key: "status-user",
      platform: "slack",
      conversation_id: "status-thread",
    });

    expect(status).toMatchObject({
      active: true,
      phase: "acting",
      subject: "Taking action",
      expected_next: "progress",
      blocked: false,
      action_required: false,
    });
    expect(manager.formatActiveSeedyTurnStatus({
      identity_key: "status-user",
      platform: "slack",
      conversation_id: "status-thread",
    })).toBe("I'm working on it.");
    expect(events).toHaveLength(eventCountBeforeStatus);

    resolveActive?.(CANNED_RESULT);
    await active;
    expect(manager.getActiveSeedyTurnStatus({ identity_key: "status-user" }))
      .toMatchObject({ active: false });
  });

  it("reconstructs resumed gateway history from the rollout journal instead of stale transcript messages", async () => {
    const tmpDir = makeTempDir();
    try {
      const stateManager = new RealStateManager(tmpDir, undefined, { walEnabled: false });
      await stateManager.init();
      const firstAgentLoopRunner = {
        execute: vi.fn().mockResolvedValue({
          success: true,
          output: "First structured answer",
          error: null,
          exit_code: null,
          elapsed_ms: 12,
          stopped_reason: "completed",
        }),
      };
      const firstManager = new CrossPlatformChatSessionManager(makeDeps({
        stateManager,
        chatAgentLoopRunner: firstAgentLoopRunner as never,
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

      const secondAgentLoopRunner = {
        execute: vi.fn().mockResolvedValue({
          success: true,
          output: "Second structured answer",
          error: null,
          exit_code: null,
          elapsed_ms: 10,
          stopped_reason: "completed",
        }),
      };
      const secondManager = new CrossPlatformChatSessionManager(makeDeps({
        stateManager,
        chatAgentLoopRunner: secondAgentLoopRunner as never,
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

      expect(secondAgentLoopRunner.execute).toHaveBeenCalledOnce();
      const agentLoopInput = vi.mocked(secondAgentLoopRunner.execute).mock.calls[0][0] as {
        history: Array<{ role: string; content: string }>;
      };
      expect(agentLoopInput.history).toEqual([
        { role: "user", content: "First structured question" },
        { role: "assistant", content: "First structured answer" },
      ]);
      expect(JSON.stringify(agentLoopInput.history)).not.toContain("STALE transcript");

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
      await vi.waitFor(() => expect(capturedApprovalFn).toBeDefined());

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
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager: makeMockStateManager(),
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
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager: makeMockStateManager(),
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

  it("returns recovery guidance for gateway-visible failures", async () => {
    const adapter = makeMockAdapter({
      ...CANNED_RESULT,
      success: false,
      output: "Agent failed",
      error: "boom",
      exit_code: 1,
    });
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager: makeMockStateManager(),
      adapter,
    }));

    const result = await manager.processIncomingMessage({
      text: "do risky work",
      platform: "slack",
      conversation_id: "C_GENERAL",
      sender_id: "U123",
      cwd: "/repo",
    });

    expect(result).toContain("Agent failed");
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

    expect(result.success).toBe(true);
    expect(result.output).toContain("not authorized to inspect or control PulSeed's running state");
    expect(llmClient.sendMessage).not.toHaveBeenCalled();
    expect(llmClient.sendMessageStream).toHaveBeenCalledTimes(2);
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

    expect(result.success).toBe(true);
    expect(result.output).toContain("not authorized to inspect or control PulSeed's running state");
    expect(result.output).toContain("Nothing was executed");
    expect(result.output).toContain("will not use shell commands as a workaround");
    expect(result.output).not.toContain("restart_daemon");
    expect(result.output).not.toContain("runtime-control");
    expect(llmClient.sendMessage).not.toHaveBeenCalled();
    expect(llmClient.sendMessageStream).toHaveBeenCalledTimes(2);
    expect(events.some((event) =>
      event.type === "tool_end"
      && event.toolName === "request_runtime_control"
      && event.success === false
      && event.summary.includes("not authorized")
    )).toBe(true);
    expect(runtimeControlService.request).not.toHaveBeenCalled();
    expect(chatAgentLoopRunner.execute).not.toHaveBeenCalled();
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it("denies unauthorized runtime status inspection through the model-selected status tool", async () => {
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

    const result = await manager.execute("今のPulSeedの状態を軽く確認して", {
      identity_key: "owner",
      platform: "telegram",
      conversation_id: "telegram-chat-1",
      user_id: "user-1",
      cwd: "/repo",
      metadata: { runtime_control_denied: true },
      onEvent: (event) => { events.push(event); },
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("not authorized to inspect or control PulSeed's running state");
    expect(result.output).toContain("Nothing was executed");
    expect(result.output).toContain("will not use shell commands as a workaround");
    expect(result.output).not.toContain("inspect_companion_state");
    expect(result.output).not.toContain("Runtime control");
    expect(result.output).not.toContain("runtime-control");
    expect(result.output).not.toContain("lifecycle actions");
    expect(llmClient.sendMessage).not.toHaveBeenCalled();
    expect(llmClient.sendMessageStream).toHaveBeenCalledTimes(2);
    expect(events.some((event) =>
      event.type === "tool_end"
      && event.toolName === "get_runtime_status"
      && event.success === false
      && event.summary.includes("not authorized")
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

      expect(result.success).toBe(true);
      expect(result.output).toContain("Nothing was executed");
      expect(result.output).toContain("will not use shell commands as a workaround");
      expect(result.output).not.toContain(operation);
      expect(result.output).not.toContain("runtime-control");
      expect(llmClient.sendMessage).not.toHaveBeenCalled();
      expect(llmClient.sendMessageStream).toHaveBeenCalledTimes(2);
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
        },
      });

      const deadline = Date.now() + 1000;
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
        },
      });

      const deadline = Date.now() + 1000;
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
      const deadline = Date.now() + 1000;
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
      const deadline = Date.now() + 1000;
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
      const deadline = Date.now() + 1000;
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
      const deadline = Date.now() + 1000;
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
        },
      });
      const deadline = Date.now() + 1000;
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
        },
      });
      const deadline = Date.now() + 1000;
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
        },
      });
      const deadline = Date.now() + 1000;
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
        },
      });
      const deadline = Date.now() + 1000;
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
        },
      });
      const deadline = Date.now() + 1000;
      while (Date.now() < deadline && (await store.loadPending("approval-stale-button")) === null) {
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
      const deadline = Date.now() + 1000;
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
    const adapter = {
      adapterType: "mock",
      execute: vi.fn().mockImplementation(async () => {
        activeCalls += 1;
        maxConcurrentCalls = Math.max(maxConcurrentCalls, activeCalls);
        await new Promise((resolve) => setTimeout(resolve, 20));
        activeCalls -= 1;
        return CANNED_RESULT;
      }),
    } as unknown as IAdapter;
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager: makeMockStateManager(),
      adapter,
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

    expect(adapter.execute).toHaveBeenCalledTimes(2);
    expect(maxConcurrentCalls).toBe(1);
  });

  it("passes gateway-routed goal_id into ChatRunner agent-loop execution", async () => {
    const chatAgentLoopRunner = {
      execute: vi.fn().mockResolvedValue({
        success: true,
        output: "Agent loop response",
        error: null,
        exit_code: 0,
        elapsed_ms: 42,
        stopped_reason: "completed",
      }),
    };
    const adapter = makeMockAdapter();
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager: makeMockStateManager(),
      adapter,
      chatAgentLoopRunner: chatAgentLoopRunner as never,
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

    expect(result).toBe("Agent loop response");
    expect(adapter.execute).not.toHaveBeenCalled();
    expect(chatAgentLoopRunner.execute).toHaveBeenCalledTimes(2);
    expect(chatAgentLoopRunner.execute).toHaveBeenNthCalledWith(1, expect.objectContaining({
      goalId: "goal-routed",
    }));
    expect(chatAgentLoopRunner.execute).toHaveBeenNthCalledWith(2, expect.objectContaining({
      goalId: "goal-next",
    }));
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

  it("routes gateway text through the companion contract before ChatRunner execution", async () => {
    const adapter = makeMockAdapter();
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      stateManager: makeMockStateManager(),
      adapter,
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
    expect(adapter.execute).toHaveBeenCalledTimes(1);
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
