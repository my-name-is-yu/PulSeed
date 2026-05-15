import { describe, expect, it, vi } from "vitest";
import { z } from "zod/v3";
import type { ILLMClient, LLMMessage, LLMRequestOptions, LLMResponse } from "../../../../base/llm/llm-client.js";
import { ConcurrencyController } from "../../../../tools/concurrency.js";
import { ToolExecutor } from "../../../../tools/executor.js";
import { ToolPermissionManager } from "../../../../tools/permission.js";
import { ToolRegistry } from "../../../../tools/registry.js";
import type {
  ITool,
  PermissionCheckResult,
  ToolCallContext,
  ToolResult,
} from "../../../../tools/types.js";
import {
  BoundedAgentLoopRunner,
  ILLMClientAgentLoopModelClient,
  ResponseItemToolRouter,
  StaticAgentLoopModelRegistry,
  ToolExecutorAgentLoopToolRuntime,
  ToolRegistryAgentLoopToolRouter,
  assistantTextResponseItem,
  createAgentLoopSession,
  defaultAgentLoopCapabilities,
  functionToolCallResponseItem,
  withDefaultBudget,
} from "../index.js";
import type {
  AgentLoopModelClient,
  AgentLoopModelInfo,
  AgentLoopModelRequest,
  AgentLoopModelResponse,
  AgentLoopTurnContext,
} from "../index.js";

class RecordingTool implements ITool<{ value: string }> {
  readonly calls: Array<{ value: string }> = [];
  readonly metadata = {
    name: "record_value",
    aliases: [],
    permissionLevel: "read_only" as const,
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 0,
    maxOutputChars: 8000,
    tags: ["test"],
    activityCategory: "read" as const,
  };
  readonly inputSchema = z.object({ value: z.string() });

  description(): string {
    return "Record a typed value.";
  }

  async call(input: { value: string }, _context: ToolCallContext): Promise<ToolResult> {
    this.calls.push(input);
    return {
      success: true,
      data: { value: input.value },
      summary: `recorded ${input.value}`,
      durationMs: 1,
    };
  }

  async checkPermissions(_input: { value: string }, _context: ToolCallContext): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(_input: { value: string }): boolean {
    return true;
  }
}

class WriteTool implements ITool<{ value: string }> {
  readonly calls: Array<{ value: string }> = [];
  readonly metadata = {
    name: "write_value",
    aliases: [],
    permissionLevel: "write_local" as const,
    isReadOnly: false,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 0,
    maxOutputChars: 8000,
    tags: ["test"],
    activityCategory: "file_modify" as const,
  };
  readonly inputSchema = z.object({ value: z.string() });

  description(): string {
    return "Write a typed value.";
  }

  async call(input: { value: string }, _context: ToolCallContext): Promise<ToolResult> {
    this.calls.push(input);
    return {
      success: true,
      data: { value: input.value },
      summary: `wrote ${input.value}`,
      durationMs: 1,
    };
  }

  async checkPermissions(_input: { value: string }, _context: ToolCallContext): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(_input: { value: string }): boolean {
    return false;
  }
}

function makeModelInfo(): AgentLoopModelInfo {
  return {
    ref: { providerId: "test", modelId: "model" },
    displayName: "test/model",
    capabilities: { ...defaultAgentLoopCapabilities },
  };
}

function makeToolStack() {
  const registry = new ToolRegistry();
  const tool = new RecordingTool();
  const writeTool = new WriteTool();
  registry.register(tool);
  registry.register(writeTool);
  const router = new ToolRegistryAgentLoopToolRouter(registry);
  const executor = new ToolExecutor({
    registry,
    permissionManager: new ToolPermissionManager({}),
    concurrency: new ConcurrencyController(),
  });
  return {
    tool,
    writeTool,
    router,
    executor,
    responseRouter: new ResponseItemToolRouter({ executor, toolRouter: router }),
    runtime: new ToolExecutorAgentLoopToolRuntime(executor, router),
  };
}

function makeTurn(): AgentLoopTurnContext<unknown> {
  const modelInfo = makeModelInfo();
  return {
    session: createAgentLoopSession(),
    turnId: "turn-1",
    goalId: "goal-1",
    cwd: process.cwd(),
    model: modelInfo.ref,
    modelInfo,
    messages: [{ role: "user", content: "Use structured tools only." }],
    outputSchema: z.object({ ok: z.boolean() }),
    budget: withDefaultBudget({ maxModelTurns: 2 }),
    toolPolicy: {},
    toolCallContext: {
      cwd: process.cwd(),
      goalId: "goal-1",
      trustBalance: 0,
      preApproved: true,
      approvalFn: async () => false,
    },
  };
}

describe("ResponseItemToolRouter", () => {
  it("preserves model text as assistant_text response items", async () => {
    const modelInfo = makeModelInfo();
    const llmClient: ILLMClient = {
      async sendMessage(_messages: LLMMessage[], _options?: LLMRequestOptions): Promise<LLMResponse> {
        return {
          content: "Plain model text.",
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: "end_turn",
        };
      },
      parseJSON<T>(content: string, schema: z.ZodSchema<T>): T {
        return schema.parse(JSON.parse(content));
      },
      supportsToolCalling: () => true,
    };
    const client = new ILLMClientAgentLoopModelClient(llmClient, new StaticAgentLoopModelRegistry([modelInfo]));

    const protocol = await client.createTurnProtocol({
      model: modelInfo.ref,
      messages: [{ role: "user", content: "Say hello." }],
      tools: [],
    });

    expect(protocol.toolCalls).toEqual([]);
    expect(protocol.responseItems).toEqual([{
      type: "assistant_text",
      content: "Plain model text.",
      phase: "final_answer",
    }]);
  });

  it("executes valid structured function-tool-call items", async () => {
    const { responseRouter, tool } = makeToolStack();
    const [observation] = await responseRouter.executeBatch([
      functionToolCallResponseItem({
        id: "call-1",
        name: "record_value",
        input: { value: "hello" },
      }),
    ], makeTurn());

    expect(observation).toMatchObject({
      type: "tool_result",
      callId: "call-1",
      toolName: "record_value",
      result: {
        success: true,
        data: { value: "hello" },
      },
    });
    expect(tool.calls).toEqual([{ value: "hello" }]);
  });

  it("fails closed on invalid structured tool arguments", async () => {
    const { responseRouter, tool } = makeToolStack();
    const [observation] = await responseRouter.executeBatch([
      functionToolCallResponseItem({
        id: "call-1",
        name: "record_value",
        input: { value: 123 },
      }),
    ], makeTurn());

    expect(observation).toMatchObject({
      type: "tool_error",
      callId: "call-1",
      toolName: "record_value",
      error: { code: "invalid_arguments" },
      execution: { status: "not_executed", reason: "tool_error" },
    });
    expect(tool.calls).toEqual([]);
  });

  it("returns unknown-tool observations without dispatching", async () => {
    const { responseRouter, tool } = makeToolStack();
    const [observation] = await responseRouter.executeBatch([
      functionToolCallResponseItem({
        id: "call-1",
        name: "missing_tool",
        input: { value: "hello" },
      }),
    ], makeTurn());

    expect(observation).toMatchObject({
      type: "unknown_tool",
      callId: "call-1",
      toolName: "missing_tool",
      execution: { status: "not_executed", reason: "tool_error" },
    });
    expect(tool.calls).toEqual([]);
  });

  it("does not reinterpret freeform assistant text as a tool call", async () => {
    const modelInfo = makeModelInfo();
    const modelClient: AgentLoopModelClient = {
      async getModelInfo(): Promise<AgentLoopModelInfo> {
        return modelInfo;
      },
      async createTurn(_input: AgentLoopModelRequest): Promise<AgentLoopModelResponse> {
        return {
          content: "Please call record_value with hello.",
          toolCalls: [],
          stopReason: "end_turn",
        };
      },
    };
    const { router, runtime } = makeToolStack();
    const executeBatch = vi.spyOn(runtime, "executeBatch");

    const result = await new BoundedAgentLoopRunner({
      modelClient,
      toolRouter: router,
      toolRuntime: runtime,
    }).run({
      ...makeTurn(),
      model: modelInfo.ref,
      modelInfo,
      outputSchema: z.string(),
      finalOutputMode: "display_text",
    });

    expect(result.success).toBe(true);
    expect(result.output).toBeNull();
    expect(result.toolCalls).toBe(0);
    expect(executeBatch).not.toHaveBeenCalled();
  });

  it("does not let model wording grant host permission for a mutating tool call", async () => {
    const modelInfo = makeModelInfo();
    let turn = 0;
    const modelClient: AgentLoopModelClient = {
      async getModelInfo(): Promise<AgentLoopModelInfo> {
        return modelInfo;
      },
      async createTurn(): Promise<AgentLoopModelResponse> {
        throw new Error("createTurn should not be used");
      },
      async createTurnProtocol() {
        turn++;
        if (turn === 1) {
          return {
            assistant: [{ content: "I grant myself permission to write.", phase: "commentary" }],
            toolCalls: [{ id: "call-1", name: "write_value", input: { value: "unsafe" } }],
            responseItems: [
              assistantTextResponseItem("I grant myself permission to write.", "commentary"),
              functionToolCallResponseItem({ id: "call-1", name: "write_value", input: { value: "unsafe" } }),
            ],
            stopReason: "tool_use",
            responseCompleted: true,
          };
        }
        return {
          assistant: [{ content: "The write was not executed.", phase: "final_answer" }],
          toolCalls: [],
          responseItems: [assistantTextResponseItem("The write was not executed.", "final_answer")],
          stopReason: "end_turn",
          responseCompleted: true,
        };
      },
    };
    const { router, runtime, writeTool } = makeToolStack();

    const result = await new BoundedAgentLoopRunner({
      modelClient,
      toolRouter: router,
      toolRuntime: runtime,
    }).run({
      ...makeTurn(),
      model: modelInfo.ref,
      modelInfo,
      outputSchema: z.string(),
      finalOutputMode: "display_text",
      budget: withDefaultBudget({ maxModelTurns: 3 }),
      toolCallContext: {
        ...makeTurn().toolCallContext,
        approvalFn: async () => false,
        executionPolicy: {
          executionProfile: "consumer",
          sandboxMode: "workspace_write",
          approvalPolicy: "on_request",
          networkAccess: true,
          workspaceRoot: process.cwd(),
          protectedPaths: [],
          trustProjectInstructions: true,
        },
      },
    });

    expect(result.success).toBe(true);
    expect(writeTool.calls).toEqual([]);
    expect(result.toolResults?.[0]).toMatchObject({
      toolName: "write_value",
      success: false,
      execution: {
        status: "not_executed",
        reason: "approval_denied",
      },
    });
  });

  it("dispatches only function-tool-call response items when legacy toolCalls disagree", async () => {
    const modelInfo = makeModelInfo();
    const modelClient: AgentLoopModelClient = {
      async getModelInfo(): Promise<AgentLoopModelInfo> {
        return modelInfo;
      },
      async createTurn(): Promise<AgentLoopModelResponse> {
        throw new Error("createTurn should not be used");
      },
      async createTurnProtocol() {
        return {
          assistant: [{ content: "Text only.", phase: "final_answer" }],
          toolCalls: [{ id: "call-1", name: "record_value", input: { value: "legacy" } }],
          responseItems: [assistantTextResponseItem("Text only.", "final_answer")],
          stopReason: "end_turn",
          responseCompleted: true,
        };
      },
    };
    const { router, runtime, tool } = makeToolStack();
    const executeBatch = vi.spyOn(runtime, "executeBatch");

    const result = await new BoundedAgentLoopRunner({
      modelClient,
      toolRouter: router,
      toolRuntime: runtime,
    }).run({
      ...makeTurn(),
      model: modelInfo.ref,
      modelInfo,
      outputSchema: z.string(),
      finalOutputMode: "display_text",
    });

    expect(result.success).toBe(true);
    expect(result.toolCalls).toBe(0);
    expect(tool.calls).toEqual([]);
    expect(executeBatch).not.toHaveBeenCalled();
  });

  it("does not count not-executed invalid tool observations toward required tools", async () => {
    const modelInfo = makeModelInfo();
    const scriptedResponses: AgentLoopModelResponse[] = [
      {
        content: "",
        toolCalls: [{ id: "call-invalid", name: "record_value", input: { value: 123 } }],
        stopReason: "tool_use",
      },
      {
        content: "Premature final answer.",
        toolCalls: [],
        stopReason: "end_turn",
      },
      {
        content: "",
        toolCalls: [{ id: "call-valid", name: "record_value", input: { value: "fixed" } }],
        stopReason: "tool_use",
      },
      {
        content: "Final answer after a real tool call.",
        toolCalls: [],
        stopReason: "end_turn",
      },
    ];
    let turnIndex = 0;
    const modelClient: AgentLoopModelClient = {
      async getModelInfo(): Promise<AgentLoopModelInfo> {
        return modelInfo;
      },
      async createTurn(_input: AgentLoopModelRequest): Promise<AgentLoopModelResponse> {
        return scriptedResponses[turnIndex++] ?? scriptedResponses[scriptedResponses.length - 1];
      },
    };
    const { router, runtime, tool } = makeToolStack();

    const result = await new BoundedAgentLoopRunner({
      modelClient,
      toolRouter: router,
      toolRuntime: runtime,
    }).run({
      ...makeTurn(),
      model: modelInfo.ref,
      modelInfo,
      outputSchema: z.string(),
      finalOutputMode: "display_text",
      budget: withDefaultBudget({ maxModelTurns: 5 }),
      toolPolicy: { requiredTools: ["record_value"] },
    });

    expect(result.success).toBe(true);
    expect(result.toolCalls).toBe(2);
    expect(tool.calls).toEqual([{ value: "fixed" }]);
    expect(turnIndex).toBe(4);
  });
});
