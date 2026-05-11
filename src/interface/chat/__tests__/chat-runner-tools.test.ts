import { afterEach, describe, it, expect, vi } from "vitest";
import { ChatRunner } from "../chat-runner.js";
import type { ChatRunnerDeps } from "../chat-runner-contracts.js";
import type { StateManager } from "../../../base/state/state-manager.js";
import type { IAdapter } from "../../../orchestrator/execution/adapter-layer.js";
import type { ILLMClient, LLMMessage, LLMRequestOptions, LLMResponse } from "../../../base/llm/llm-client.js";
import type { ToolRegistry } from "../../../tools/registry.js";
import { ToolExecutor } from "../../../tools/executor.js";
import { ToolPermissionManager } from "../../../tools/permission.js";
import { ConcurrencyController } from "../../../tools/concurrency.js";
import type { ITool, ToolActivityCategory, ToolResult, ToolCallContext } from "../../../tools/types.js";
import type { ChatEvent } from "../chat-events.js";
import { CapabilityVerificationStore } from "../../../runtime/store/capability-verification-store.js";
import { makeTempDir, cleanupTempDir } from "../../../../tests/helpers/temp-dir.js";
import { z } from "zod";

// Mock context-provider so tests don't walk the real filesystem
vi.mock("../../../platform/observation/context-provider.js", () => ({
  resolveGitRoot: (cwd: string) => cwd,
  buildChatContext: (_task: string, _cwd: string) => Promise.resolve(""),
}));

// ─── Helpers ───

function makeMockStateManager(): StateManager {
  return {
    writeRaw: vi.fn().mockResolvedValue(undefined),
    readRaw: vi.fn().mockResolvedValue(null),
  } as unknown as StateManager;
}

function makeMockAdapter(): IAdapter {
  return {
    adapterType: "mock",
    execute: vi.fn().mockResolvedValue({ success: true, output: "", error: null, elapsed_ms: 10 }),
  } as unknown as IAdapter;
}

/** Create a minimal mock ITool with controllable call behavior. */
function makeMockTool(
  name: string,
  callImpl: (input: Record<string, unknown>, ctx: ToolCallContext) => Promise<ToolResult>,
  activityCategory?: ToolActivityCategory
): ITool {
  return {
    metadata: {
      name,
      aliases: [],
      permissionLevel: "read_only",
      isReadOnly: true,
      isDestructive: false,
      shouldDefer: false,
      alwaysLoad: false,
      maxConcurrency: 0,
      maxOutputChars: 4000,
      tags: [],
      ...(activityCategory ? { activityCategory } : {}),
    },
    inputSchema: z.object({}),
    description: () => "mock tool",
    call: vi.fn().mockImplementation(callImpl),
    checkPermissions: vi.fn().mockResolvedValue({ status: "allowed" }),
    isConcurrencySafe: () => true,
  } as unknown as ITool;
}

/** Create an LLM client that returns a single tool call, then a final text response. */
function makeLLMClientWithToolCall(toolName: string, toolArgs: Record<string, unknown>): ILLMClient {
  let callCount = 0;
  return {
    supportsToolCalling: () => true,
    sendMessage: vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          content: "",
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: "tool_calls",
          tool_calls: [
            {
              id: "tc-001",
              type: "function",
              function: {
                name: toolName,
                arguments: JSON.stringify(toolArgs),
              },
            },
          ],
        } satisfies LLMResponse;
      }
      // Final call: return text after the tool result
      return {
        content: "Tool executed, here is the result.",
        usage: { input_tokens: 1, output_tokens: 1 },
        stop_reason: "completed",
        tool_calls: [],
      } satisfies LLMResponse;
    }),
  } as unknown as ILLMClient;
}

/** Create a ToolRegistry mock that returns the given tool by name. */
function makeMockRegistry(tool: ITool): ToolRegistry {
  return {
    get: vi.fn().mockImplementation((name: string) => (name === tool.metadata.name ? tool : undefined)),
    listAll: vi.fn().mockReturnValue([tool]),
    register: vi.fn(),
  } as unknown as ToolRegistry;
}

function makeMockExecutor(
  executeImpl: (toolName: string, input: unknown, context: ToolCallContext) => Promise<ToolResult>
): ToolExecutor {
  return {
    execute: vi.fn().mockImplementation(executeImpl),
  } as unknown as ToolExecutor;
}

function makeDeps(overrides: Partial<ChatRunnerDeps> = {}): ChatRunnerDeps {
  return {
    stateManager: makeMockStateManager(),
    adapter: makeMockAdapter(),
    ...overrides,
  };
}

const runtimeRoots: string[] = [];

afterEach(() => {
  for (const runtimeRoot of runtimeRoots.splice(0)) {
    cleanupTempDir(runtimeRoot);
  }
});

// ─── Tests ───

describe("ChatRunner — tool status callbacks", () => {
  const toolName = "read";
  const toolArgs = {};

  describe("onToolStart callback", () => {
    it("is called with correct toolName before tool execution", async () => {
      const onToolStart = vi.fn();
      const tool = makeMockTool(toolName, async () => ({
        success: true,
        data: null,
        summary: "done",
        durationMs: 5,
      }));
      const deps = makeDeps({
        llmClient: makeLLMClientWithToolCall(toolName, toolArgs),
        registry: makeMockRegistry(tool),
        onToolStart,
      });
      const runner = new ChatRunner(deps);
      await runner.execute("test", "/repo");

      expect(onToolStart).toHaveBeenCalledOnce();
      expect(onToolStart).toHaveBeenCalledWith(toolName, toolArgs);
    });

    it("routes tool calls through ToolExecutor when available", async () => {
      const onToolStart = vi.fn();
      const onToolEnd = vi.fn();
      const tool = makeMockTool(toolName, async () => {
        throw new Error("raw tool.call should not run");
      });
      const executor = makeMockExecutor(async (executedName, input, context) => {
        expect(executedName).toBe(toolName);
        expect(input).toEqual(toolArgs);
        const approved = await context.approvalFn({
          toolName: executedName,
          input,
          reason: "approval required",
          permissionLevel: "write_local",
          isDestructive: false,
          reversibility: "unknown",
        });
        expect(approved).toBe(false);
        return {
          success: false,
          data: null,
          summary: "User denied approval",
          durationMs: 5,
        };
      });
      const deps = makeDeps({
        llmClient: makeLLMClientWithToolCall(toolName, toolArgs),
        registry: makeMockRegistry(tool),
        onToolStart,
        onToolEnd,
        toolExecutor: executor,
      });
      const runner = new ChatRunner(deps);

      const result = await runner.execute("test", "/repo");

      expect((executor.execute as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
      expect(tool.call).not.toHaveBeenCalled();
      expect(onToolStart).toHaveBeenCalledOnce();
      expect(onToolEnd).toHaveBeenCalledOnce();
      expect(result.output).toBe("Tool executed, here is the result.");
    });

    it("passes the capability verification store through the production chat tool caller path", async () => {
      const runtimeRoot = makeTempDir("pulseed-chat-capability-verification-");
      runtimeRoots.push(runtimeRoot);
      const capabilityVerificationStore = new CapabilityVerificationStore(runtimeRoot);
      const saveVerificationSpy = vi.spyOn(capabilityVerificationStore, "saveVerification");
      const saveAuditSpy = vi.spyOn(capabilityVerificationStore, "saveAudit");
      const capabilityExecutionResolver = vi.fn().mockResolvedValue({
        operationId: "workspace_status",
        providerRef: "runtime:workspace",
        assetRef: "asset:runtime/workspace-status",
        capabilityId: "capability:workspace_status",
        operationKind: "read",
        toolName: "read",
        payloadClass: "workspace_status_payload",
        riskClass: "low",
        sideEffectProfile: "read",
        readinessSnapshotRefs: ["readiness:capability:workspace_status:runtime:workspace:workspace_status"],
      });
      const tool = makeMockTool("read", async () => ({
        success: true,
        data: { clean: true },
        summary: "workspace clean",
        durationMs: 5,
      }), "read");
      const registry = makeMockRegistry(tool);
      const toolExecutor = new ToolExecutor({
        registry,
        permissionManager: new ToolPermissionManager({}),
        concurrency: new ConcurrencyController(),
      });
      const warnings: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
      const seenContexts: ToolCallContext[] = [];
      const executorResults: ToolResult[] = [];
      const dispatchingExecutor = {
        execute: vi.fn(async (toolName: string, input: unknown, context: ToolCallContext) => {
          seenContexts.push(context);
          const result = await toolExecutor.execute(toolName, input, {
            ...context,
            logger: {
              debug: vi.fn(),
              warn: (msg, meta) => { warnings.push({ msg, meta }); },
              error: vi.fn(),
            },
          });
          executorResults.push(result);
          return result;
        }),
      } as unknown as ToolExecutor;
      const deps = makeDeps({
        llmClient: makeLLMClientWithToolCall("read", {}),
        registry,
        toolExecutor: dispatchingExecutor,
        capabilityVerificationStore,
        capabilityExecutionResolver,
      });
      const runner = new ChatRunner(deps);

      await runner.execute("Could you inspect the workspace state?", process.cwd());

      expect(dispatchingExecutor.execute).toHaveBeenCalledOnce();
      expect(seenContexts[0]?.capabilityVerificationStore).toBe(capabilityVerificationStore);
      expect(executorResults[0]).toMatchObject({ success: true, summary: "workspace clean" });
      expect(executorResults[0]?.execution?.status).not.toBe("not_executed");
      expect(warnings).toEqual([]);
      expect(capabilityExecutionResolver).toHaveBeenCalledWith(expect.objectContaining({
        toolName: "read",
        operationKind: "read",
        payloadClass: "tool-input:read",
        riskClass: "low",
        sideEffectProfile: "read",
      }));
      expect(saveVerificationSpy).toHaveBeenCalledOnce();
      expect(saveAuditSpy).toHaveBeenCalledOnce();
      await expect(capabilityVerificationStore.listReadinessEvidenceSummaries()).resolves.toEqual([
        expect.objectContaining({
          capability_id: "capability:workspace_status",
          provider_ref: "runtime:workspace",
          asset_ref: "asset:runtime/workspace-status",
          operation_kind: "read",
          tool_name: "read",
          payload_class: "workspace_status_payload",
          risk_class: "low",
          side_effect_profile: "read",
          verification_class: "production_caller_path",
          evidence_stage: "production_succeeded",
          result: "passed",
          readiness_effect: "supports_readiness",
        }),
      ]);
      await expect(capabilityVerificationStore.listAudits()).resolves.toEqual([
        expect.objectContaining({
          user_directed: true,
          initiated_by: "user",
          source_surface: "chat",
          capability_refs: ["capability:workspace_status"],
          provider_refs: ["runtime:workspace"],
          readiness_snapshot_refs: ["readiness:capability:workspace_status:runtime:workspace:workspace_status"],
          result: "succeeded",
          follow_up_policy_effect: "record_only",
        }),
      ]);
    });

    it("is called before tool.call() executes", async () => {
      const callOrder: string[] = [];
      const onToolStart = vi.fn().mockImplementation(() => callOrder.push("onToolStart"));
      const tool = makeMockTool(toolName, async () => {
        callOrder.push("tool.call");
        return { success: true, data: null, summary: "done", durationMs: 5 };
      });
      const deps = makeDeps({
        llmClient: makeLLMClientWithToolCall(toolName, toolArgs),
        registry: makeMockRegistry(tool),
        onToolStart,
      });
      const runner = new ChatRunner(deps);
      await runner.execute("test", "/repo");

      expect(callOrder).toEqual(["onToolStart", "tool.call"]);
    });
  });

  describe("onToolEnd callback — success path", () => {
    it("is called with success=true and correct summary after successful execution", async () => {
      const onToolEnd = vi.fn();
      const tool = makeMockTool(toolName, async () => ({
        success: true,
        data: null,
        summary: "operation completed",
        durationMs: 5,
      }));
      const deps = makeDeps({
        llmClient: makeLLMClientWithToolCall(toolName, toolArgs),
        registry: makeMockRegistry(tool),
        onToolEnd,
      });
      const runner = new ChatRunner(deps);
      await runner.execute("test", "/repo");

      expect(onToolEnd).toHaveBeenCalledOnce();
      const [calledName, result] = (onToolEnd as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(calledName).toBe(toolName);
      expect(result.success).toBe(true);
      expect(result.summary).toBe("operation completed");
    });

    it("passes durationMs as a positive number", async () => {
      const onToolEnd = vi.fn();
      const tool = makeMockTool(toolName, async () => ({
        success: true,
        data: null,
        summary: "ok",
        durationMs: 5,
      }));
      const deps = makeDeps({
        llmClient: makeLLMClientWithToolCall(toolName, toolArgs),
        registry: makeMockRegistry(tool),
        onToolEnd,
      });
      const runner = new ChatRunner(deps);
      await runner.execute("test", "/repo");

      const [, result] = (onToolEnd as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(typeof result.durationMs).toBe("number");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("uses '...' as fallback summary when tool returns empty summary", async () => {
      const onToolEnd = vi.fn();
      const tool = makeMockTool(toolName, async () => ({
        success: true,
        data: { key: "value" },
        summary: "",
        durationMs: 5,
      }));
      const deps = makeDeps({
        llmClient: makeLLMClientWithToolCall(toolName, toolArgs),
        registry: makeMockRegistry(tool),
        onToolEnd,
      });
      const runner = new ChatRunner(deps);
      await runner.execute("test", "/repo");

      const [, result] = (onToolEnd as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(result.summary).toBe("...");
    });
  });

  it("emits typed activity categories through the production tool-loop event path", async () => {
    const events: ChatEvent[] = [];
    const tool = makeMockTool("grep", async () => ({
      success: true,
      data: null,
      summary: "done",
      durationMs: 5,
    }), "search");
    const deps = makeDeps({
      llmClient: makeLLMClientWithToolCall("grep", {}),
      registry: makeMockRegistry(tool),
      onEvent: (event) => { events.push(event); },
    });
    const runner = new ChatRunner(deps);

    await runner.execute("Could you inspect the workspace surface?", "/repo");

    const toolEvents = events.filter((event): event is Extract<ChatEvent, { type: "tool_start" | "tool_update" | "tool_end" }> =>
      event.type === "tool_start" || event.type === "tool_update" || event.type === "tool_end"
    );
    expect(toolEvents).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "tool_start", toolName: "grep", activityCategory: "search" }),
      expect.objectContaining({ type: "tool_update", toolName: "grep", activityCategory: "search" }),
      expect.objectContaining({ type: "tool_end", toolName: "grep", activityCategory: "search" }),
    ]));
  });

  describe("onToolEnd callback — failure path", () => {
    it("is called with success=false when tool.call() throws", async () => {
      const onToolEnd = vi.fn();
      const tool = makeMockTool(toolName, async () => {
        throw new Error("tool exploded");
      });
      const deps = makeDeps({
        llmClient: makeLLMClientWithToolCall(toolName, toolArgs),
        registry: makeMockRegistry(tool),
        onToolEnd,
      });
      const runner = new ChatRunner(deps);
      await runner.execute("test", "/repo");

      expect(onToolEnd).toHaveBeenCalledOnce();
      const [calledName, result] = (onToolEnd as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(calledName).toBe(toolName);
      expect(result.success).toBe(false);
      expect(result.summary).toBe("tool exploded");
    });

    it("includes durationMs even when tool throws", async () => {
      const onToolEnd = vi.fn();
      const tool = makeMockTool(toolName, async () => {
        throw new Error("boom");
      });
      const deps = makeDeps({
        llmClient: makeLLMClientWithToolCall(toolName, toolArgs),
        registry: makeMockRegistry(tool),
        onToolEnd,
      });
      const runner = new ChatRunner(deps);
      await runner.execute("test", "/repo");

      const [, result] = (onToolEnd as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(typeof result.durationMs).toBe("number");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe("optional callbacks", () => {
    it("does not throw when onToolStart is not provided", async () => {
      const tool = makeMockTool(toolName, async () => ({
        success: true,
        data: null,
        summary: "ok",
        durationMs: 5,
      }));
      const deps = makeDeps({
        llmClient: makeLLMClientWithToolCall(toolName, toolArgs),
        registry: makeMockRegistry(tool),
        // onToolStart intentionally omitted
      });
      const runner = new ChatRunner(deps);
      await expect(runner.execute("test", "/repo")).resolves.toBeDefined();
    });

    it("does not throw when onToolEnd is not provided", async () => {
      const tool = makeMockTool(toolName, async () => ({
        success: true,
        data: null,
        summary: "ok",
        durationMs: 5,
      }));
      const deps = makeDeps({
        llmClient: makeLLMClientWithToolCall(toolName, toolArgs),
        registry: makeMockRegistry(tool),
        // onToolEnd intentionally omitted
      });
      const runner = new ChatRunner(deps);
      await expect(runner.execute("test", "/repo")).resolves.toBeDefined();
    });

    it("does not throw when neither callback is provided", async () => {
      const tool = makeMockTool(toolName, async () => ({
        success: true,
        data: null,
        summary: "ok",
        durationMs: 5,
      }));
      const deps = makeDeps({
        llmClient: makeLLMClientWithToolCall(toolName, toolArgs),
        registry: makeMockRegistry(tool),
      });
      const runner = new ChatRunner(deps);
      await expect(runner.execute("test", "/repo")).resolves.toBeDefined();
    });

    it("does not call callbacks when no tool calls are made (text-only response)", async () => {
      const onToolStart = vi.fn();
      const onToolEnd = vi.fn();
      const llmClient: ILLMClient = {
        supportsToolCalling: () => true,
        sendMessage: vi.fn().mockResolvedValue({
          content: "Just a text response, no tools needed.",
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: "completed",
          tool_calls: [],
        } satisfies LLMResponse),
      } as unknown as ILLMClient;
      const deps = makeDeps({
        llmClient,
        registry: makeMockRegistry(makeMockTool(toolName, async () => ({ success: true, data: null, summary: "ok", durationMs: 5 }))),
        onToolStart,
        onToolEnd,
      });
      const runner = new ChatRunner(deps);
      await runner.execute("test", "/repo");

      expect(onToolStart).not.toHaveBeenCalled();
      expect(onToolEnd).not.toHaveBeenCalled();
    });
  });
});

describe("ChatRunner — Codex-like model request builder path", () => {
  it("presents the same typed tool schema for paraphrased English and Japanese freeform requests", async () => {
    const capturedToolRequests: Array<{ messages: LLMMessage[]; options?: LLMRequestOptions }> = [];
    const tool = {
      metadata: {
        name: "grep",
        aliases: [],
        permissionLevel: "read_only",
        isReadOnly: true,
        isDestructive: false,
        shouldDefer: false,
        alwaysLoad: false,
        maxConcurrency: 0,
        maxOutputChars: 4000,
        tags: [],
      },
      inputSchema: z.object({
        pattern: z.string(),
      }),
      description: () => "Search workspace content through the typed tool boundary.",
      call: vi.fn().mockResolvedValue({
        success: true,
        data: { clean: true },
        summary: "workspace clean",
        durationMs: 1,
      }),
      checkPermissions: vi.fn().mockResolvedValue({ status: "allowed" }),
      isConcurrencySafe: () => true,
    } as unknown as ITool;
    let callIndex = 0;
    const llmClient = {
      supportsToolCalling: () => true,
      sendMessage: vi.fn().mockImplementation(async (messages: LLMMessage[], options?: LLMRequestOptions) => {
        callIndex += 1;
        const stage = ((callIndex - 1) % 2) + 1;
        if (stage === 1) {
          capturedToolRequests.push({ messages, options });
          return {
            content: "",
            usage: { input_tokens: 1, output_tokens: 1 },
            stop_reason: "tool_calls",
            tool_calls: [{
              id: `tc-${callIndex}`,
              type: "function",
              function: {
                name: "grep",
                arguments: JSON.stringify({ pattern: "workspace" }),
              },
            }],
          } satisfies LLMResponse;
        }
        return {
          content: "workspace clean",
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: "completed",
          tool_calls: [],
        } satisfies LLMResponse;
      }),
      parseJSON: vi.fn((content: string, schema: z.ZodSchema) => schema.parse(JSON.parse(content))),
    } as unknown as ILLMClient;

    const runner = new ChatRunner(makeDeps({
      llmClient,
      registry: makeMockRegistry(tool),
    }));

    await runner.execute("Could you inspect the workspace state?", "/repo");
    await runner.execute("作業ツリーの状態を確認して", "/repo");

    expect(tool.call).toHaveBeenCalledTimes(2);
    expect(capturedToolRequests).toHaveLength(2);
    for (const request of capturedToolRequests) {
      expect(request.options?.tools?.map((definition) => definition.function.name)).toEqual(["grep"]);
      expect(request.options?.tools?.[0]?.function.parameters).toMatchObject({
        type: "object",
        properties: {
          pattern: expect.objectContaining({ type: "string" }),
        },
        required: ["pattern"],
      });
      expect(request.options?.system).toContain("## Turn Context");
      expect(request.options?.system).not.toContain("return exactly one JSON object");
    }
    expect(capturedToolRequests[0].messages.at(-1)?.content).toContain("Could you inspect the workspace state?");
    expect(capturedToolRequests[1].messages.at(-1)?.content).toContain("作業ツリーの状態を確認して");
  });
});
