import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CrossPlatformChatSessionManager } from "../../../interface/chat/cross-platform-session.js";
import type { ChatEvent } from "../../../interface/chat/chat-events.js";
import type { ChatRunnerDeps } from "../../../interface/chat/chat-runner-contracts.js";
import type { IAdapter, AgentResult } from "../../../orchestrator/execution/adapter-layer.js";
import type { ILLMClient, LLMMessage, LLMRequestOptions, LLMResponse } from "../../../base/llm/llm-client.js";
import type { StateManager } from "../../../base/state/state-manager.js";
import type { ITool } from "../../../tools/types.js";
import { ToolRegistry } from "../../../tools/registry.js";
import { dispatchGatewayChatInput } from "../chat-session-dispatch.js";
import {
  clearRegisteredGatewayChatSessionPort,
  registerGatewayChatSessionPort,
} from "../chat-session-port.js";
import {
  SLACK_GATEWAY_DISPLAY_CONTRACT,
  TELEGRAM_GATEWAY_DISPLAY_CONTRACT,
  createGatewayDisplayPolicy,
} from "../channel-display-policy.js";
import {
  SLACK_SEEDY_PRESENCE_CONTRACT,
  TELEGRAM_SEEDY_PRESENCE_CONTRACT,
  resolveGatewayChannelPresenceContract,
} from "../channel-presence-policy.js";
import { NonTuiDisplayProjector, type NonTuiDisplayMessageRef, type NonTuiDisplayTransport } from "../non-tui-display-projector.js";
import { SeedyPresenceProjector, createSeedyPresenceTransportFromNonTuiDisplay } from "../seedy-presence-projector.js";

const CANNED_RESULT: AgentResult = {
  success: true,
  output: "Adapter fallback should not run.",
  error: null,
  exit_code: 0,
  elapsed_ms: 1,
  stopped_reason: "completed",
};

function makeMockStateManager(): StateManager {
  return {
    writeRaw: vi.fn().mockResolvedValue(undefined),
    readRaw: vi.fn().mockResolvedValue(null),
    listTasks: vi.fn().mockResolvedValue([]),
  } as unknown as StateManager;
}

function makeMockAdapter(): IAdapter {
  return {
    adapterType: "mock",
    execute: vi.fn().mockResolvedValue(CANNED_RESULT),
  } as unknown as IAdapter;
}

function makeDeps(overrides: Partial<ChatRunnerDeps> = {}): ChatRunnerDeps {
  return {
    stateManager: makeMockStateManager(),
    adapter: makeMockAdapter(),
    ...overrides,
  };
}

function makeTextStreamLLM(text: string): ILLMClient & { firstModelRequestAt: number | null; calls: LLMRequestOptions[] } {
  const calls: LLMRequestOptions[] = [];
  const client = {
    firstModelRequestAt: null,
    calls,
    supportsToolCalling: () => true,
    sendMessage: vi.fn(async () => {
      throw new Error("sendMessage should not be used while sendMessageStream is available.");
    }),
    sendMessageStream: vi.fn(async (_messages: LLMMessage[], options: LLMRequestOptions | undefined, handlers) => {
      calls.push(options ?? {});
      client.firstModelRequestAt ??= Date.now();
      handlers.onTextDelta?.(text);
      return {
        content: text,
        usage: { input_tokens: 4, output_tokens: text.length },
        stop_reason: "end_turn",
      };
    }),
    parseJSON: vi.fn((content: string, schema: z.ZodType) => schema.parse(JSON.parse(content))),
  } as ILLMClient & { firstModelRequestAt: number | null; calls: LLMRequestOptions[] };
  return client;
}

function createDeferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface TransportCall {
  kind: "progress_send" | "progress_edit" | "progress_delete" | "final_send" | "final_edit";
  text: string;
  at: number;
}

function createRecordingTransport(): NonTuiDisplayTransport & { calls: TransportCall[] } {
  let nextId = 0;
  const calls: TransportCall[] = [];
  const push = (kind: TransportCall["kind"], text: string): NonTuiDisplayMessageRef => {
    calls.push({ kind, text, at: Date.now() });
    nextId += 1;
    return { id: `${kind}-${nextId}` };
  };
  return {
    calls,
    sendProgress: vi.fn(async (text) => push("progress_send", text)),
    editProgress: vi.fn(async (_ref, text) => { push("progress_edit", text); }),
    deleteProgress: vi.fn(async () => { push("progress_delete", ""); }),
    sendFinal: vi.fn(async (text) => push("final_send", text)),
    editFinal: vi.fn(async (_ref, text) => { push("final_edit", text); }),
  };
}

async function runFakeTelegramLikeTurn(inputText: string): Promise<{
  result: string | null;
  transport: ReturnType<typeof createRecordingTransport>;
  firstProjectedAssistantText: TransportCall | undefined;
  firstProjectedAssistantTextMs: number | null;
  startAt: number;
  events: ChatEvent[];
  llmClient: ILLMClient & { firstModelRequestAt: number | null; calls: LLMRequestOptions[] };
}> {
  const events: ChatEvent[] = [];
  const transport = createRecordingTransport();
  const displayProjector = new NonTuiDisplayProjector({
    display: {
      capabilities: TELEGRAM_GATEWAY_DISPLAY_CONTRACT.capabilities,
      policy: {
        ...createGatewayDisplayPolicy(TELEGRAM_GATEWAY_DISPLAY_CONTRACT.capabilities),
        progressSurface: "editable",
        finalSurface: "edit_stream",
        cleanupPolicy: "collapse",
      },
    },
    transport,
  });
  const presenceProjector = new SeedyPresenceProjector({
    presence: resolveGatewayChannelPresenceContract(TELEGRAM_SEEDY_PRESENCE_CONTRACT),
    transport: createSeedyPresenceTransportFromNonTuiDisplay(transport),
  });
  const llmClient = makeTextStreamLLM("やあ！");
  const registry = new ToolRegistry();
  const manager = new CrossPlatformChatSessionManager(makeDeps({
    llmClient,
    registry,
  }));
  registerGatewayChatSessionPort(async () => manager);

  const startAt = Date.now();
  const result = await dispatchGatewayChatInput({
    text: inputText,
    platform: "telegram",
    identity_key: "fake-telegram-user",
    conversation_id: "fake-telegram-chat",
    sender_id: "fake-telegram-user",
    message_id: "fake-message-1",
    cwd: "/repo",
    onEvent: async (event) => {
      const chatEvent = event as unknown as ChatEvent;
      events.push(chatEvent);
      await displayProjector.handle(chatEvent);
      await presenceProjector.prepareForEvent(chatEvent);
      await presenceProjector.handle(chatEvent, {
        assistantOutputRendered: displayProjector.deliveredAssistantOutput,
        meaningfulProgressRendered: displayProjector.deliveredProgressOutput,
      });
    },
    metadata: { fake_telegram_inbound_admitted_at: new Date(startAt).toISOString() },
  });

  const firstProjectedAssistantText = transport.calls.find((call) =>
    call.kind === "final_send" || call.kind === "final_edit"
  );
  return {
    result,
    transport,
    firstProjectedAssistantText,
    firstProjectedAssistantTextMs: firstProjectedAssistantText ? firstProjectedAssistantText.at - startAt : null,
    startAt,
    events,
    llmClient,
  };
}

afterEach(() => {
  clearRegisteredGatewayChatSessionPort();
  vi.useRealTimers();
});

describe("gateway direct chat first visible projection", () => {
  it("projects ordinary no-tool gateway chat as model-authored assistant text without pre-model classifiers or evidence repair", async () => {
    const result = await runFakeTelegramLikeTurn("やあ！");

    expect(result.result).toBe("やあ！");
    expect(result.firstProjectedAssistantText).toMatchObject({
      kind: "final_send",
      text: "やあ！",
    });
    expect(result.firstProjectedAssistantTextMs).not.toBeNull();
    expect(result.firstProjectedAssistantTextMs!).toBeLessThanOrEqual(2_000);
    expect(result.llmClient.firstModelRequestAt).not.toBeNull();
    expect(result.llmClient.firstModelRequestAt!).toBeGreaterThanOrEqual(result.startAt);
    expect(result.llmClient.calls).toHaveLength(1);
    expect(result.llmClient.calls[0]?.tools ?? []).toEqual([]);
    expect(result.transport.calls[0]).toMatchObject({
      kind: "final_send",
      text: "やあ！",
    });
    expect(result.events.some((event) =>
      event.type === "activity"
      && (event.presentation?.gatewayNarration?.audience === "user" || event.message === "I'm still working...")
    )).toBe(false);
    expect(result.transport.calls.some((call) =>
      call.kind.startsWith("progress") && (
        call.text.includes("Calling model")
        || call.text.includes("I'm still working")
      )
    )).toBe(false);
    expect(result.events.some((event) =>
      event.type === "activity" && event.sourceId === "checkpoint:runtime-evidence"
    )).toBe(false);
  });

  it("projects assistant_delta to the Telegram-shaped final surface before model terminal completion", async () => {
    const transport = createRecordingTransport();
    const displayProjector = new NonTuiDisplayProjector({
      display: {
        capabilities: TELEGRAM_GATEWAY_DISPLAY_CONTRACT.capabilities,
        policy: {
          ...createGatewayDisplayPolicy(TELEGRAM_GATEWAY_DISPLAY_CONTRACT.capabilities),
          progressSurface: "editable",
          finalSurface: "edit_stream",
          cleanupPolicy: "collapse",
        },
      },
      transport,
    });
    const terminal = createDeferred<LLMResponse>();
    let sawDelta = false;
    let dispatchSettled = false;
    const llmClient: ILLMClient = {
      supportsToolCalling: () => true,
      sendMessage: vi.fn(async () => {
        throw new Error("sendMessage should not be used.");
      }),
      sendMessageStream: vi.fn(async (_messages, _options, handlers) => {
        handlers.onTextDelta?.("やあ！");
        sawDelta = true;
        return terminal.promise;
      }),
      parseJSON: vi.fn((content: string, schema: z.ZodType) => schema.parse(JSON.parse(content))),
    };
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      llmClient,
      registry: new ToolRegistry(),
    }));
    registerGatewayChatSessionPort(async () => manager);

    const pending = dispatchGatewayChatInput({
      text: "やあ！",
      platform: "telegram",
      identity_key: "fake-telegram-stream-user",
      conversation_id: "fake-telegram-stream-chat",
      sender_id: "fake-telegram-user",
      message_id: "fake-message-stream",
      cwd: "/repo",
      onEvent: async (event) => {
        await displayProjector.handle(event as unknown as ChatEvent);
      },
    }).finally(() => {
      dispatchSettled = true;
    });
    await waitUntil(() => sawDelta && transport.calls.length > 0);

    expect(sawDelta).toBe(true);
    expect(dispatchSettled).toBe(false);
    expect(transport.calls[0]).toMatchObject({
      kind: "final_send",
      text: "やあ！",
    });

    terminal.resolve({
      content: "やあ！",
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: "end_turn",
      tool_calls: [],
    });
    await expect(pending).resolves.toBe("やあ！");
  });

  it("does not emit generic fallback acknowledgements for ordinary fake Telegram admission/orienting presence", async () => {
    vi.useFakeTimers();
    const transport = {
      sendStatus: vi.fn(async () => ({ id: "status-1" })),
      editStatus: vi.fn(async () => undefined),
      deleteStatus: vi.fn(async () => undefined),
      sendFallbackAck: vi.fn(async () => ({ id: "fallback-1" })),
    };
    const projector = new SeedyPresenceProjector({
      presence: resolveGatewayChannelPresenceContract(TELEGRAM_SEEDY_PRESENCE_CONTRACT),
      transport,
    });

    await projector.handle({
      type: "presence_update",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-05-11T00:00:00.000Z",
      presence: {
        schema_version: "seedy-turn-presence-v1",
        turn_id: "turn-1",
        phase: "received",
        audience: "user",
        importance: "ephemeral",
        expected_next: "progress",
        started_at: "2026-05-11T00:00:00.000Z",
        updated_at: "2026-05-11T00:00:00.000Z",
      },
    });
    await projector.handle({
      type: "presence_update",
      runId: "run-1",
      turnId: "turn-1",
      createdAt: "2026-05-11T00:00:00.000Z",
      presence: {
        schema_version: "seedy-turn-presence-v1",
        turn_id: "turn-1",
        phase: "orienting",
        audience: "user",
        importance: "ephemeral",
        expected_next: "progress",
        started_at: "2026-05-11T00:00:00.000Z",
        updated_at: "2026-05-11T00:00:00.000Z",
      },
    });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(transport.sendFallbackAck).not.toHaveBeenCalled();
    expect(projector.hasSentFallbackAck).toBe(false);
  });

  it("does not project Slack editable progress before delayed ordinary model-authored final text", async () => {
    const events: ChatEvent[] = [];
    const transport = createRecordingTransport();
    const displayProjector = new NonTuiDisplayProjector({
      display: {
        capabilities: SLACK_GATEWAY_DISPLAY_CONTRACT.capabilities,
        policy: createGatewayDisplayPolicy(SLACK_GATEWAY_DISPLAY_CONTRACT.capabilities),
      },
      transport,
    });
    const presenceProjector = new SeedyPresenceProjector({
      presence: resolveGatewayChannelPresenceContract(SLACK_SEEDY_PRESENCE_CONTRACT),
      transport: createSeedyPresenceTransportFromNonTuiDisplay(transport),
    });
    const firstDeltaGate = createDeferred<void>();
    let modelRequestStarted = false;
    const llmClient: ILLMClient = {
      supportsToolCalling: () => true,
      sendMessage: vi.fn(async () => {
        throw new Error("sendMessage should not be used.");
      }),
      sendMessageStream: vi.fn(async (_messages, _options, handlers) => {
        modelRequestStarted = true;
        await firstDeltaGate.promise;
        handlers.onTextDelta?.("Hello.");
        return {
          content: "Hello.",
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: "end_turn",
          tool_calls: [],
        };
      }),
      parseJSON: vi.fn((content: string, schema: z.ZodType) => schema.parse(JSON.parse(content))),
    };
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      llmClient,
      registry: new ToolRegistry(),
    }));
    registerGatewayChatSessionPort(async () => manager);

    const pending = dispatchGatewayChatInput({
      text: "hello",
      platform: "slack",
      identity_key: "fake-slack-user",
      conversation_id: "fake-slack-channel",
      sender_id: "fake-slack-user",
      message_id: "fake-slack-message",
      cwd: "/repo",
      onEvent: async (event) => {
        const chatEvent = event as unknown as ChatEvent;
        events.push(chatEvent);
        await displayProjector.handle(chatEvent);
        await presenceProjector.prepareForEvent(chatEvent);
        await presenceProjector.handle(chatEvent, {
          assistantOutputRendered: displayProjector.deliveredAssistantOutput,
          meaningfulProgressRendered: displayProjector.deliveredProgressOutput,
        });
      },
    });

    await waitUntil(() => modelRequestStarted);
    await new Promise((resolve) => setTimeout(resolve, 2_100));

    expect(transport.calls.some((call) => call.kind.startsWith("progress"))).toBe(false);
    expect(events.filter((event) => event.type === "presence_update").map((event) => event.presence.phase))
      .toEqual(expect.arrayContaining(["received", "orienting", "thinking"]));

    firstDeltaGate.resolve();
    await expect(pending).resolves.toBe("Hello.");
    expect(transport.calls[0]).toMatchObject({
      kind: "final_send",
      text: "Hello.",
    });
  });

  it("keeps approval-required gateway tool calls visible as natural-language permission requests before execution", async () => {
    const events: ChatEvent[] = [];
    const approvalTool: ITool = {
      metadata: {
        name: "confirm_gateway_config_write",
        aliases: [],
        permissionLevel: "write_local",
        isReadOnly: false,
        isDestructive: true,
        shouldDefer: false,
        alwaysLoad: true,
        maxConcurrency: 0,
        maxOutputChars: 1000,
        tags: ["automation"],
      },
      inputSchema: z.object({ channel: z.literal("telegram").default("telegram") }).strict(),
      description: () => "Write Telegram gateway config after explicit permission.",
      checkPermissions: vi.fn().mockResolvedValue({
        status: "needs_approval",
        reason: "I need explicit permission before writing Telegram gateway config.",
      }),
      call: vi.fn().mockResolvedValue({ success: true, summary: "deleted", data: null }),
      isConcurrencySafe: () => true,
    };
    const registry = new ToolRegistry();
    registry.register(approvalTool);
    let modelCalls = 0;
    const llmClient: ILLMClient = {
      supportsToolCalling: () => true,
      sendMessage: vi.fn(async (): Promise<LLMResponse> => {
        modelCalls += 1;
        if (modelCalls === 1) {
          return {
            content: "I need to ask permission before doing that.",
            usage: { input_tokens: 5, output_tokens: 5 },
            stop_reason: "tool_use",
            tool_calls: [{
              id: "call-1",
              type: "function",
              function: {
                name: "confirm_gateway_config_write",
                arguments: JSON.stringify({ channel: "telegram" }),
              },
            }],
          };
        }
        return {
          content: "I did not delete it because permission was not granted.",
          usage: { input_tokens: 5, output_tokens: 5 },
          stop_reason: "end_turn",
        };
      }),
      parseJSON: vi.fn((content: string, schema: z.ZodType) => schema.parse(JSON.parse(content))),
    };
    const approvalFn = vi.fn(async (_description: string): Promise<boolean> => false);
    const manager = new CrossPlatformChatSessionManager(makeDeps({
      llmClient,
      registry,
      approvalFn,
    }));
    registerGatewayChatSessionPort(async () => manager);

    await dispatchGatewayChatInput({
      text: "tmp/demo.txt を削除して",
      platform: "telegram",
      identity_key: "fake-telegram-approval-user",
      conversation_id: "fake-telegram-approval-chat",
      sender_id: "fake-telegram-user",
      cwd: "/repo",
      onEvent: (event) => { events.push(event as unknown as ChatEvent); },
    });

    expect(approvalTool.call).not.toHaveBeenCalled();
    expect(approvalFn).toHaveBeenCalledOnce();
    expect(approvalFn.mock.calls[0]?.[0]).toBe("I need explicit permission before writing Telegram gateway config.");
    expect(events.some((event) =>
      event.type === "tool_update"
      && event.toolName === "confirm_gateway_config_write"
      && event.status === "awaiting_approval"
      && event.message.includes("explicit permission")
    )).toBe(true);
  });
});
