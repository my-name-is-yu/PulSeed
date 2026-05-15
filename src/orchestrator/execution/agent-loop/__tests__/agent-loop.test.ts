import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { z } from "zod/v3";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import type { ILLMClient, LLMMessage, LLMRequestOptions, LLMResponse } from "../../../../base/llm/llm-client.js";
import type { ITool, PermissionCheckResult, ToolCallContext, ToolResult } from "../../../../tools/types.js";
import { ToolRegistry } from "../../../../tools/registry.js";
import { ToolPermissionManager } from "../../../../tools/permission.js";
import { ConcurrencyController } from "../../../../tools/concurrency.js";
import { ToolExecutor } from "../../../../tools/executor.js";
import { ToolSearchTool } from "../../../../tools/query/ToolSearchTool/ToolSearchTool.js";
import { ApplyPatchTool } from "../../../../tools/fs/ApplyPatchTool/ApplyPatchTool.js";
import { TaskUpdateTool } from "../../../../tools/mutation/TaskUpdateTool/TaskUpdateTool.js";
import { StateManager } from "../../../../base/state/state-manager.js";
import { SessionManager } from "../../session-manager.js";
import { TrustManager } from "../../../../platform/traits/trust-manager.js";
import { StrategyManager } from "../../../strategy/strategy-manager.js";
import { StallDetector } from "../../../../platform/drive/stall-detector.js";
import { TaskLifecycle } from "../../task/task-lifecycle.js";
import type { Task } from "../../../../base/types/task.js";
import { makeTempDir } from "../../../../../tests/helpers/temp-dir.js";
import { createMockLLMClient } from "../../../../../tests/helpers/mock-llm.js";
import { makeGoal } from "../../../../../tests/helpers/fixtures.js";
import {
  BoundedAgentLoopRunner,
  buildAgentLoopBaseInstructions,
  ILLMClientAgentLoopModelClient,
  InMemoryAgentLoopTraceStore,
  StaticAgentLoopModelRegistry,
  TaskAgentLoopRunner,
  ToolExecutorAgentLoopToolRuntime,
  ToolRegistryAgentLoopToolRouter,
  createAgentLoopSession,
  createProviderNativeAgentLoopModelClient,
  defaultAgentLoopCapabilities,
  extractPromptedToolCalls,
  parseAgentLoopModelRef,
  shouldUseNativeTaskAgentLoop,
  withDefaultBudget,
  type AgentLoopModelClient,
  type AgentLoopModelInfo,
  type AgentLoopModelRequest,
  type AgentLoopModelResponse,
  type AgentLoopToolCall,
  type AgentLoopToolOutput,
  type AgentLoopTurnContext,
} from "../index.js";

class EchoTool implements ITool<{ value: string }> {
  readonly metadata = {
    name: "echo",
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
    return "Echo a test value.";
  }

  async call(input: { value: string }, _context: ToolCallContext): Promise<ToolResult> {
    return {
      success: true,
      data: { echoed: input.value },
      summary: `echoed ${input.value}`,
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

class VerifyTool implements ITool<{ command: string; cwd?: string }> {
  readonly metadata = {
    name: "verify",
    aliases: [],
    permissionLevel: "read_only" as const,
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 0,
    maxOutputChars: 8000,
    tags: ["test", "verification"],
    activityCategory: "test" as const,
  };
  readonly inputSchema = z.object({ command: z.string(), cwd: z.string().optional() });

  description(): string {
    return "Record a verification command for tests.";
  }

  async call(input: { command: string; cwd?: string }, context: ToolCallContext): Promise<ToolResult> {
    return {
      success: true,
      data: { verified: input.command, cwd: input.cwd ?? context.cwd },
      summary: `verified ${input.command}`,
      durationMs: 1,
      contextModifier: `Verification output: ${input.command}`,
    };
  }

  async checkPermissions(_input: { command: string; cwd?: string }, _context: ToolCallContext): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(_input: { command: string; cwd?: string }): boolean {
    return true;
  }
}

class ShellCommandLikeTool implements ITool<{ command: string; cwd?: string }> {
  readonly metadata = {
    name: "shell_command",
    aliases: [],
    permissionLevel: "read_metrics" as const,
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 0,
    maxOutputChars: 8000,
    tags: ["command"],
    activityCategory: "command" as const,
  };
  readonly inputSchema = z.object({ command: z.string(), cwd: z.string().optional() });

  description(): string {
    return "Records shell-like command output for agent-loop tests.";
  }

  async call(input: { command: string; cwd?: string }, context: ToolCallContext): Promise<ToolResult> {
    return {
      success: true,
      data: { command: input.command, cwd: input.cwd ?? context.cwd },
      summary: `command completed: ${input.command}`,
      durationMs: 1,
      contextModifier: `Command output: ${input.command}`,
    };
  }

  async checkPermissions(_input: { command: string; cwd?: string }, _context: ToolCallContext): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(_input: { command: string; cwd?: string }): boolean {
    return true;
  }
}

class DeferredTool extends EchoTool {
  readonly metadata = {
    ...new EchoTool().metadata,
    name: "deferred_echo",
    shouldDefer: true,
  };
}

class ScriptedModelClient implements AgentLoopModelClient {
  calls: AgentLoopModelRequest[] = [];
  private index = 0;

  constructor(
    private readonly modelInfo: AgentLoopModelInfo,
    private readonly responses: AgentLoopModelResponse[],
  ) {}

  async getModelInfo(): Promise<AgentLoopModelInfo> {
    return this.modelInfo;
  }

  async createTurn(input: AgentLoopModelRequest): Promise<AgentLoopModelResponse> {
    this.calls.push(input);
    return this.responses[this.index++] ?? this.responses[this.responses.length - 1];
  }
}

function makeModelInfo(overrides: Partial<AgentLoopModelInfo> = {}): AgentLoopModelInfo {
  return {
    ref: { providerId: "test", modelId: "model" },
    displayName: "test/model",
    capabilities: { ...defaultAgentLoopCapabilities },
    ...overrides,
  };
}

function makeToolRuntime() {
  const registry = new ToolRegistry();
  registry.register(new EchoTool());
  const router = new ToolRegistryAgentLoopToolRouter(registry);
  const executor = new ToolExecutor({
    registry,
    permissionManager: new ToolPermissionManager({}),
    concurrency: new ConcurrencyController(),
  });
  return {
    registry,
    router,
    runtime: new ToolExecutorAgentLoopToolRuntime(executor, router),
  };
}

function namedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    goal_id: "goal-1",
    strategy_id: null,
    target_dimensions: ["dim"],
    primary_dimension: "dim",
    work_description: "test task",
    rationale: "test rationale",
    approach: "test approach",
    success_criteria: [{ description: "done", verification_method: "unit", is_blocking: true }],
    scope_boundary: { in_scope: ["."], out_of_scope: [], blast_radius: "low" },
    constraints: [],
    plateau_until: null,
    estimated_duration: { value: 1, unit: "hours" },
    consecutive_failure_count: 0,
    reversibility: "reversible",
    task_category: "normal",
    status: "pending",
    started_at: null,
    completed_at: null,
    timeout_at: null,
    heartbeat_at: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function finalJson(status = "done") {
  return JSON.stringify({
    status,
    finalAnswer: "finished",
    summary: "summary",
    filesChanged: ["src/example.ts"],
    testsRun: [{ command: "npm test", passed: true, outputSummary: "ok" }],
    completionEvidence: ["unit evidence"],
    verificationHints: ["hint"],
    blockers: [],
  });
}

describe("agentloop phase 0", () => {
  it("enables native task agentloop regardless of legacy adapter or native tool support", () => {
    const parseJSON = <T,>(content: string, schema: z.ZodSchema<T>): T => schema.parse(JSON.parse(content));
    const toolCallingClient: ILLMClient = {
      async sendMessage(): Promise<LLMResponse> {
        return { content: "{}", usage: { input_tokens: 0, output_tokens: 0 }, stop_reason: "end_turn" };
      },
      parseJSON,
      supportsToolCalling: () => true,
    };
    const noToolCallingClient: ILLMClient = {
      async sendMessage(): Promise<LLMResponse> {
        return { content: "{}", usage: { input_tokens: 0, output_tokens: 0 }, stop_reason: "end_turn" };
      },
      parseJSON,
      supportsToolCalling: () => false,
    };

    expect(shouldUseNativeTaskAgentLoop({
      provider: "openai",
      model: "gpt-5.4-mini",
      adapter: "openai_api",
    }, toolCallingClient)).toBe(true);
    expect(shouldUseNativeTaskAgentLoop({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      adapter: "claude_code_cli",
      api_key: "sk-ant-test",
    }, toolCallingClient)).toBe(true);
    expect(shouldUseNativeTaskAgentLoop({
      provider: "openai",
      model: "gpt-5.4-mini",
      adapter: "openai_codex_cli",
    }, noToolCallingClient)).toBe(true);
    expect(shouldUseNativeTaskAgentLoop({
      provider: "ollama",
      model: "qwen3:4b",
      adapter: "openai_api",
    }, noToolCallingClient)).toBe(true);
  });

  it("keeps non-tool-calling clients on the prompted protocol even when provider config has an API key", () => {
    const modelInfo = makeModelInfo({ ref: { providerId: "openai", modelId: "gpt-5.4-mini" } });
    const noToolCallingClient: ILLMClient = {
      async sendMessage(): Promise<LLMResponse> {
        return { content: "{}", usage: { input_tokens: 0, output_tokens: 0 }, stop_reason: "end_turn" };
      },
      parseJSON<T>(content: string, schema: z.ZodSchema<T>): T {
        return schema.parse(JSON.parse(content));
      },
      supportsToolCalling: () => false,
    };

    const modelClient = createProviderNativeAgentLoopModelClient({
      providerConfig: {
        provider: "openai",
        model: "gpt-5.4-mini",
        adapter: "openai_codex_cli",
        api_key: "codex-oauth-token",
      },
      llmClient: noToolCallingClient,
      modelRegistry: new StaticAgentLoopModelRegistry([modelInfo]),
    });

    expect(modelClient).toBeInstanceOf(ILLMClientAgentLoopModelClient);
  });

  it("adds a targeted-inspection guardrail to the chat base instructions", () => {
    const prompt = buildAgentLoopBaseInstructions({ mode: "chat" });
    expect(prompt).toContain("Start with targeted inspection first");
    expect(prompt).toContain("avoid repo-wide glob or grep sweeps");
  });

  it("parses explicit prompted tool-call JSON and preserves unknown tools for runtime feedback", () => {
    let id = 0;
    const calls = extractPromptedToolCalls({
      content: `\`\`\`json
      {
        "tool_calls": [
          { "name": "echo", "arguments": "{ \\"value\\": \\"hello\\", }" },
          { "name": "unknown_tool", "input": {} }
        ],
      }
      \`\`\``,
      tools: [{
        type: "function",
        function: {
          name: "echo",
          description: "Echo a value.",
          parameters: { type: "object" },
        },
      }],
      createId: () => `call-test-${++id}`,
    });

    expect(calls).toEqual([{
      id: "call-test-1",
      name: "echo",
      input: { value: "hello" },
    }, {
      id: "call-test-2",
      name: "unknown_tool",
      input: {},
    }]);
  });

  it("stores trace events and parses provider/model refs", async () => {
    const ref = parseAgentLoopModelRef("openai/gpt-test");
    expect(ref).toEqual({ providerId: "openai", modelId: "gpt-test" });

    const store = new InMemoryAgentLoopTraceStore();
    await store.append({
      type: "started",
      eventId: "event-1",
      sessionId: "session-1",
      traceId: "trace-1",
      turnId: "turn-1",
      goalId: "goal-1",
      createdAt: new Date().toISOString(),
    });
    expect(await store.list("trace-1")).toHaveLength(1);
  });
});

describe("agentloop phase 1", () => {
  it("exposes structured tool schemas to the model", () => {
    const { router } = makeToolRuntime();
    const tools = router.modelVisibleTools({
      session: createAgentLoopSession(),
      turnId: "turn-1",
      goalId: "goal-1",
      taskId: "task-1",
      cwd: process.cwd(),
      model: { providerId: "test", modelId: "model" },
      modelInfo: makeModelInfo(),
      messages: [{ role: "user", content: "schema" }],
      outputSchema: z.object({ ok: z.boolean() }),
      budget: withDefaultBudget({}),
      toolPolicy: {},
      toolCallContext: {
        cwd: process.cwd(),
        goalId: "goal-1",
        trustBalance: 0,
        preApproved: true,
        approvalFn: async () => false,
      },
    });

    expect(tools[0]?.function.name).toBe("echo");
    expect(tools[0]?.function.parameters).toMatchObject({
      type: "object",
      properties: {
        value: {
          type: "string",
        },
      },
      required: ["value"],
    });
  });

  it("uses a no-tool finalization reserve instead of stopping on a post-tool max_model_turns", async () => {
    const cwd = makeTempDir();
    const modelInfo = makeModelInfo();
    const modelClient = new ScriptedModelClient(modelInfo, [
      {
        content: "",
        toolCalls: [{ id: "echo-1", name: "echo", input: { value: "evidence" } }],
        stopReason: "tool_use",
      },
      {
        content: JSON.stringify({ ok: true }),
        toolCalls: [],
        stopReason: "end_turn",
      },
    ]);
    const { router, runtime } = makeToolRuntime();
    const boundedRunner = new BoundedAgentLoopRunner({ modelClient, toolRouter: router, toolRuntime: runtime });

    try {
      const result = await boundedRunner.run({
        session: createAgentLoopSession(),
        turnId: "turn-finalize",
        goalId: "goal-1",
        taskId: "task-1",
        cwd,
        model: modelInfo.ref,
        modelInfo,
        messages: [{ role: "user", content: "Use the tool, then finish." }],
        outputSchema: z.object({ ok: z.boolean() }),
        budget: withDefaultBudget({ maxModelTurns: 1 }),
        toolPolicy: {},
        toolCallContext: {
          cwd,
          goalId: "goal-1",
          trustBalance: 0,
          preApproved: true,
          approvalFn: async () => false,
        },
      });

      expect(result.stopReason).toBe("completed");
      expect(result.output).toEqual({ ok: true });
      expect(modelClient.calls).toHaveLength(2);
      expect(modelClient.calls[1]?.tools).toEqual([]);
      expect(modelClient.calls[1]?.messages.some((message) =>
        message.role === "user" && message.content.includes("Do not call any more tools")
      )).toBe(true);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("exposes required deferred tools to the model without enabling all deferred tools", () => {
    const registry = new ToolRegistry();
    registry.register(new EchoTool());
    registry.register(new DeferredTool());
    const router = new ToolRegistryAgentLoopToolRouter(registry);

    const tools = router.modelVisibleTools({
      session: createAgentLoopSession(),
      turnId: "turn-1",
      goalId: "goal-1",
      taskId: "task-1",
      cwd: process.cwd(),
      model: { providerId: "test", modelId: "model" },
      modelInfo: makeModelInfo(),
      messages: [{ role: "user", content: "schema" }],
      outputSchema: z.object({ ok: z.boolean() }),
      budget: withDefaultBudget({}),
      toolPolicy: { requiredTools: ["deferred_echo"] },
      toolCallContext: {
        cwd: process.cwd(),
        goalId: "goal-1",
        trustBalance: 0,
        preApproved: true,
        approvalFn: async () => false,
      },
    });

	    expect(tools.map((tool) => tool.function.name)).toEqual(["echo", "deferred_echo"]);
	  });

	  it("activates deferred tools returned by tool_search on the next native agent-loop turn", async () => {
	    const modelInfo = makeModelInfo();
	    const modelClient = new ScriptedModelClient(modelInfo, [
	      {
	        content: "",
	        toolCalls: [{ id: "search-1", name: "tool_search", input: { query: "deferred" } }],
	        stopReason: "tool_use",
	      },
	      { content: finalJson(), toolCalls: [], stopReason: "end_turn" },
	    ]);
	    const registry = new ToolRegistry();
	    registry.register(new EchoTool());
	    registry.register(new DeferredTool());
	    registry.register(new ToolSearchTool(registry));
	    const router = new ToolRegistryAgentLoopToolRouter(registry);
	    const executor = new ToolExecutor({
	      registry,
	      permissionManager: new ToolPermissionManager({}),
	      concurrency: new ConcurrencyController(),
	    });

	    await new BoundedAgentLoopRunner({
	      modelClient,
	      toolRouter: router,
	      toolRuntime: new ToolExecutorAgentLoopToolRuntime(executor, router),
	    }).run({
	      session: createAgentLoopSession(),
	      turnId: "turn-1",
	      goalId: "goal-1",
	      cwd: process.cwd(),
	      model: modelInfo.ref,
	      modelInfo,
	      messages: [{ role: "user", content: "Find the deferred tool." }],
	      outputSchema: z.object({ status: z.string() }).passthrough(),
	      budget: withDefaultBudget({ maxModelTurns: 3 }),
	      toolPolicy: { allowedTools: ["echo", "deferred_echo", "tool_search"] },
	      toolCallContext: {
	        cwd: process.cwd(),
	        goalId: "goal-1",
	        trustBalance: 0,
	        preApproved: true,
	        approvalFn: async () => false,
	      },
	    });

	    expect(modelClient.calls[0]?.tools.map((tool) => tool.function.name)).not.toContain("deferred_echo");
	    expect(modelClient.calls[1]?.tools.map((tool) => tool.function.name)).toContain("deferred_echo");
	  });

  it("executes model-selected tools and returns schema-valid final output", async () => {
    const modelInfo = makeModelInfo();
    const modelClient = new ScriptedModelClient(modelInfo, [
      {
        content: "",
        toolCalls: [{ id: "call-1", name: "echo", input: { value: "hello" } }],
        stopReason: "tool_use",
      },
      { content: finalJson(), toolCalls: [], stopReason: "end_turn" },
    ]);
    const { router, runtime } = makeToolRuntime();
    const runner = new BoundedAgentLoopRunner({ modelClient, toolRouter: router, toolRuntime: runtime });
    const session = createAgentLoopSession();

    const result = await runner.run({
      session,
      turnId: "turn-1",
      goalId: "goal-1",
      taskId: "task-1",
      cwd: process.cwd(),
      model: modelInfo.ref,
      modelInfo,
      messages: [{ role: "user", content: "do it" }],
      outputSchema: z.object({ status: z.literal("done"), finalAnswer: z.string() }),
      budget: withDefaultBudget({ maxModelTurns: 4 }),
      toolPolicy: {},
      toolCallContext: {
        cwd: process.cwd(),
        goalId: "goal-1",
        trustBalance: 0,
        preApproved: true,
        approvalFn: async () => false,
      },
    });

    expect(result.success).toBe(true);
    expect(result.output?.finalAnswer).toBe("finished");
    expect(result.toolCalls).toBe(1);
    const followUpToolMessage = modelClient.calls[1].messages.find((message) => message.role === "tool");
    expect(followUpToolMessage).toMatchObject({
      toolCallId: "call-1",
      toolName: "echo",
      observation: {
        type: "tool_observation",
        callId: "call-1",
        toolName: "echo",
        state: "success",
        execution: { status: "executed" },
        output: {
          summary: "echoed hello",
          data: { echoed: "hello" },
        },
      },
    });
    const persisted = await session.stateStore.load();
    expect(persisted?.messages.find((message) => message.role === "tool")).toMatchObject({
      observation: {
        type: "tool_observation",
        callId: "call-1",
        state: "success",
      },
    });
    const events = await session.traceStore.list(session.traceId);
    expect(events.find((event) => event.type === "tool_observation")).toMatchObject({
      observation: {
        type: "tool_observation",
        callId: "call-1",
        state: "success",
      },
    });
    expect(events.findIndex((event) => event.type === "tool_call_started")).toBeLessThan(
      events.findIndex((event) => event.type === "tool_call_finished"),
    );
    expect(events.findIndex((event) => event.type === "tool_call_finished")).toBeLessThan(
      events.findIndex((event) => event.type === "tool_observation"),
    );
    expect(events.some((event) => event.type === "final")).toBe(true);
    expect(events.find((event) => event.type === "tool_call_started")).toMatchObject({
      toolName: "echo",
      activityCategory: "read",
    });
    expect(events.find((event) => event.type === "tool_call_finished")).toMatchObject({
      toolName: "echo",
      activityCategory: "read",
    });
    const assistantMessages = events.filter((event) => event.type === "assistant_message");
    expect(assistantMessages).toHaveLength(2);
    expect(assistantMessages[0]).toMatchObject({ phase: "commentary" });
    expect(assistantMessages[1]).toMatchObject({ phase: "final_candidate" });
  });

  it("captures changed paths for apply_patch in a non-git workspace", async () => {
    const workspace = makeTempDir();
    try {
      const modelInfo = makeModelInfo();
      const modelClient = new ScriptedModelClient(modelInfo, [
        {
          content: "",
          toolCalls: [{
            id: "patch-1",
            name: "apply_patch",
            input: {
              cwd: workspace,
              patch: [
                "*** Begin Patch",
                "*** Add File: reports/hgb.json",
                "+{\"score\":0.95}",
                "*** End Patch",
              ].join("\n"),
            },
          }],
          stopReason: "tool_use",
        },
        {
          content: JSON.stringify({
            status: "done",
            finalAnswer: "finished",
            summary: "created report",
            filesChanged: [],
            testsRun: [],
            completionEvidence: [],
            verificationHints: [],
            blockers: [],
          }),
          toolCalls: [],
          stopReason: "end_turn",
        },
      ]);
      const registry = new ToolRegistry();
      registry.register(new ApplyPatchTool());
      const router = new ToolRegistryAgentLoopToolRouter(registry);
      const executor = new ToolExecutor({
        registry,
        permissionManager: new ToolPermissionManager({}),
        concurrency: new ConcurrencyController(),
      });
      const runner = new BoundedAgentLoopRunner({
        modelClient,
        toolRouter: router,
        toolRuntime: new ToolExecutorAgentLoopToolRuntime(executor, router),
      });

      const result = await runner.run({
        session: createAgentLoopSession(),
        turnId: "turn-1",
        goalId: "goal-1",
        taskId: "task-1",
        cwd: workspace,
        model: modelInfo.ref,
        modelInfo,
        messages: [{ role: "user", content: "write report" }],
        outputSchema: z.object({ status: z.literal("done"), finalAnswer: z.string() }).passthrough(),
        budget: withDefaultBudget({ maxModelTurns: 4 }),
        toolPolicy: { allowedTools: ["apply_patch"] },
        toolCallContext: {
          cwd: workspace,
          goalId: "goal-1",
          trustBalance: 100,
          preApproved: true,
          trusted: true,
          approvalFn: async () => true,
        },
      });

      expect(result.success).toBe(true);
      expect(result.toolResults?.[0]).toMatchObject({
        toolName: "apply_patch",
        checkOnly: false,
        artifacts: ["reports/hgb.json"],
      });
      expect(result.changedFiles).toContain("reports/hgb.json");
      expect(fs.readFileSync(path.join(workspace, "reports", "hgb.json"), "utf-8")).toContain("0.95");
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("persists typed tool observations for success, failure, denied, blocked, timed out, and interrupted results", async () => {
    const modelInfo = makeModelInfo();
    const toolCalls = [
      { id: "success-1", name: "success_case", input: { value: "ok" } },
      { id: "failure-1", name: "failure_case", input: { value: "fail" } },
      { id: "denied-1", name: "denied_case", input: { value: "deny" } },
      { id: "blocked-1", name: "blocked_case", input: { value: "block" } },
      { id: "timed-1", name: "timed_case", input: { value: "slow" } },
      { id: "interrupted-1", name: "interrupted_case", input: { value: "stop" } },
    ];
    const modelClient = new ScriptedModelClient(modelInfo, [
      {
        content: "",
        toolCalls,
        stopReason: "tool_use",
      },
      { content: finalJson(), toolCalls: [], stopReason: "end_turn" },
    ]);
    const { router } = makeToolRuntime();
    const runtime = {
      executeBatch: vi.fn(async (calls: AgentLoopToolCall[]): Promise<AgentLoopToolOutput[]> => calls.map((call) => {
        if (call.name === "success_case") {
          return {
            callId: call.id,
            toolName: call.name,
            success: true,
            content: "success output",
            durationMs: 1,
            rawResult: {
              success: true,
              data: { ok: true },
              summary: "success summary",
              durationMs: 1,
            },
          };
        }
        if (call.name === "failure_case") {
          return {
            callId: call.id,
            toolName: call.name,
            success: false,
            content: "failure output",
            durationMs: 2,
            rawResult: {
              success: false,
              data: null,
              summary: "failure summary",
              error: "failed",
              durationMs: 2,
            },
          };
        }
        if (call.name === "denied_case") {
          return {
            callId: call.id,
            toolName: call.name,
            success: false,
            content: "permission denied",
            durationMs: 3,
            execution: { status: "not_executed", reason: "permission_denied", message: "operator policy denied" },
          };
        }
        if (call.name === "blocked_case") {
          return {
            callId: call.id,
            toolName: call.name,
            success: false,
            content: "policy blocked",
            durationMs: 4,
            execution: { status: "not_executed", reason: "policy_blocked", message: "sandbox blocked" },
          };
        }
        if (call.name === "timed_case") {
          return {
            callId: call.id,
            toolName: call.name,
            success: false,
            content: "timed out",
            durationMs: 5,
            execution: { status: "executed", reason: "timed_out", message: "deadline exceeded" },
          };
        }
        return {
          callId: call.id,
          toolName: call.name,
          success: false,
          content: "interrupted",
          durationMs: 6,
          execution: { status: "executed", reason: "interrupted", message: "operator interrupted" },
        };
      })),
    };
    const session = createAgentLoopSession();

    const result = await new BoundedAgentLoopRunner({
      modelClient,
      toolRouter: router,
      toolRuntime: runtime,
    }).run({
      session,
      turnId: "turn-1",
      goalId: "goal-1",
      taskId: "task-1",
      cwd: process.cwd(),
      model: modelInfo.ref,
      modelInfo,
      messages: [{ role: "user", content: "run all cases" }],
      outputSchema: z.object({ status: z.literal("done") }).passthrough(),
      budget: withDefaultBudget({ maxModelTurns: 3, maxConsecutiveToolErrors: 10 }),
      toolPolicy: {},
      toolCallContext: {
        cwd: process.cwd(),
        goalId: "goal-1",
        trustBalance: 0,
        preApproved: true,
        approvalFn: async () => false,
      },
    });

    expect(result.success).toBe(true);
    expect(modelClient.calls).toHaveLength(2);
    const observedStates = modelClient.calls[1].messages
      .filter((message) => message.role === "tool")
      .map((message) => message.observation?.state);
    expect(observedStates).toEqual(["success", "failure", "denied", "blocked", "timed_out", "interrupted"]);

    const persisted = await session.stateStore.load();
    expect(persisted?.messages
      .filter((message) => message.role === "tool")
      .map((message) => message.observation?.state)).toEqual(observedStates);
    expect((await session.traceStore.list(session.traceId))
      .filter((event) => event.type === "tool_observation")
      .map((event) => event.observation.state)).toEqual(observedStates);
  });

  it("stops after an abort that arrives with the model response before running tools", async () => {
    const modelInfo = makeModelInfo();
    const abortController = new AbortController();
    const modelClient: AgentLoopModelClient = {
      async getModelInfo(): Promise<AgentLoopModelInfo> {
        return modelInfo;
      },
      async createTurn(): Promise<AgentLoopModelResponse> {
        throw new Error("createTurn should not be used");
      },
      async createTurnProtocol() {
        abortController.abort();
        return {
          assistant: [{ content: "Calling echo", phase: "commentary" }],
          toolCalls: [{ id: "call-1", name: "echo", input: { value: "hello" } }],
          stopReason: "tool_use",
          responseCompleted: true,
        };
      },
    };
    const { router, runtime } = makeToolRuntime();
    const executeBatch = vi.spyOn(runtime, "executeBatch");
    const runner = new BoundedAgentLoopRunner({ modelClient, toolRouter: router, toolRuntime: runtime });
    const session = createAgentLoopSession();

    const result = await runner.run({
      session,
      turnId: "turn-1",
      goalId: "goal-1",
      taskId: "task-1",
      cwd: process.cwd(),
      model: modelInfo.ref,
      modelInfo,
      messages: [{ role: "user", content: "do it" }],
      outputSchema: z.object({ status: z.literal("done"), finalAnswer: z.string() }),
      budget: withDefaultBudget({ maxModelTurns: 4 }),
      toolPolicy: {},
      toolCallContext: {
        cwd: process.cwd(),
        goalId: "goal-1",
        trustBalance: 0,
        preApproved: true,
        approvalFn: async () => false,
      },
      abortSignal: abortController.signal,
    });

    expect(result.success).toBe(false);
    expect(result.stopReason).toBe("cancelled");
    expect(executeBatch).not.toHaveBeenCalled();
  });

  it("bounds native tool execution with the remaining wall-clock budget", async () => {
    const modelInfo = makeModelInfo();
    const startedAt = Date.now();
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => startedAt);
    const modelClient = new ScriptedModelClient(modelInfo, [
      {
        content: "",
        toolCalls: [{ id: "call-1", name: "echo", input: { value: "hello" } }],
        stopReason: "tool_use",
      },
      { content: finalJson(), toolCalls: [], stopReason: "end_turn" },
    ]);
    const { router } = makeToolRuntime();
    let capturedTimeoutMs: number | undefined;
    let capturedSignalAborted = false;
    const runtime = {
      executeBatch: vi.fn(async (_calls, turn: AgentLoopTurnContext<unknown>): Promise<AgentLoopToolOutput[]> => {
        capturedTimeoutMs = turn.toolCallContext.timeoutMs;
        await new Promise<void>((resolve) => turn.abortSignal?.addEventListener("abort", () => resolve(), { once: true }));
        await new Promise((resolve) => setTimeout(resolve, 5));
        capturedSignalAborted = turn.abortSignal?.aborted === true;
        return [{
          callId: "call-1",
          toolName: "echo",
          success: false,
          content: "aborted",
          durationMs: capturedTimeoutMs ?? 0,
          disposition: "cancelled",
        }];
      }),
    };
    const runner = new BoundedAgentLoopRunner({ modelClient, toolRouter: router, toolRuntime: runtime });

    const result = await (async () => {
      try {
        return await runner.run({
          session: createAgentLoopSession(),
          turnId: "turn-1",
          goalId: "goal-1",
          taskId: "task-1",
          cwd: process.cwd(),
          model: modelInfo.ref,
          modelInfo,
          messages: [{ role: "user", content: "do it" }],
          outputSchema: z.object({ status: z.literal("done"), finalAnswer: z.string() }),
          budget: withDefaultBudget({ maxWallClockMs: 1000, maxModelTurns: 4 }),
          toolPolicy: {},
          toolCallContext: {
            cwd: process.cwd(),
            goalId: "goal-1",
            trustBalance: 0,
            preApproved: true,
            approvalFn: async () => false,
          },
        });
      } finally {
        dateNow.mockRestore();
      }
    })();

    expect(result.success).toBe(false);
    expect(result.stopReason).toBe("timeout");
    expect(result.failureReason).toBe("tool_batch_timed_out");
    expect(capturedTimeoutMs).toBeGreaterThan(0);
    expect(capturedTimeoutMs).toBeLessThanOrEqual(1000);
    expect(capturedSignalAborted).toBe(true);
  });

  it("does not start mutating tools when the remaining wall-clock budget is exhausted", async () => {
    const modelInfo = makeModelInfo();
    let nowMs = 0;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const modelClient: AgentLoopModelClient = {
      async getModelInfo(): Promise<AgentLoopModelInfo> {
        return modelInfo;
      },
      async createTurn(): Promise<AgentLoopModelResponse> {
        nowMs = 60;
        return {
          content: "",
          toolCalls: [{
            id: "call-1",
            name: "apply_patch",
            input: {
              patch: [
                "*** Begin Patch",
                "*** Add File: wall-clock-budget.txt",
                "+patched",
                "*** End Patch",
              ].join("\n"),
            },
          }],
          stopReason: "tool_use",
        };
      },
    };
    const registry = new ToolRegistry();
    registry.register(new ApplyPatchTool());
    const router = new ToolRegistryAgentLoopToolRouter(registry);
    const runtime = {
      executeBatch: vi.fn(async (): Promise<AgentLoopToolOutput[]> => {
        throw new Error("mutating tool runtime should not be called");
      }),
    };
    const session = createAgentLoopSession();
    const runner = new BoundedAgentLoopRunner({ modelClient, toolRouter: router, toolRuntime: runtime });

    try {
      const result = await runner.run({
        session,
        turnId: "turn-1",
        goalId: "goal-1",
        taskId: "task-1",
        cwd: process.cwd(),
        model: modelInfo.ref,
        modelInfo,
        messages: [{ role: "user", content: "patch it" }],
        outputSchema: z.object({ status: z.literal("done"), finalAnswer: z.string() }),
        budget: withDefaultBudget({ maxWallClockMs: 50, maxModelTurns: 4, maxToolCalls: 2 }),
        toolPolicy: { allowedTools: ["apply_patch"] },
        toolCallContext: {
          cwd: process.cwd(),
          goalId: "goal-1",
          trustBalance: 0,
          preApproved: true,
          approvalFn: async () => false,
        },
      });

      expect(runtime.executeBatch).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
      expect(result.stopReason).toBe("timeout");
      expect(result.failureReason).toBe("tool_batch_deadline_exceeded");
      expect(result.toolCalls).toBe(0);
      expect(result.finalText).toContain("wall-clock budget is exhausted");
      expect(result.finalText).not.toContain("Calling apply_patch");
      const persisted = await session.stateStore.load();
      expect(persisted?.finalText).toContain("wall-clock budget is exhausted");
      expect(persisted?.finalText).not.toContain("Calling apply_patch");
      const events = await session.traceStore.list(session.traceId);
      expect(events.some((event) => event.type === "tool_call_started")).toBe(false);
    } finally {
      dateNow.mockRestore();
    }
  });

  it("does not start mutating tools when remaining wall-clock is below the minimum budget", async () => {
    const modelInfo = makeModelInfo();
    let nowMs = 0;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const modelClient: AgentLoopModelClient = {
      async getModelInfo(): Promise<AgentLoopModelInfo> {
        return modelInfo;
      },
      async createTurn(): Promise<AgentLoopModelResponse> {
        nowMs = 100;
        return {
          content: "",
          toolCalls: [{ id: "call-1", name: "apply_patch", input: { patch: "*** Begin Patch\n*** End Patch" } }],
          stopReason: "tool_use",
        };
      },
    };
    const registry = new ToolRegistry();
    registry.register(new ApplyPatchTool());
    const router = new ToolRegistryAgentLoopToolRouter(registry);
    const runtime = {
      executeBatch: vi.fn(async (): Promise<AgentLoopToolOutput[]> => {
        throw new Error("mutating tool runtime should not be called");
      }),
    };
    const session = createAgentLoopSession();
    const runner = new BoundedAgentLoopRunner({ modelClient, toolRouter: router, toolRuntime: runtime });

    try {
      const result = await runner.run({
        session,
        turnId: "turn-1",
        goalId: "goal-1",
        taskId: "task-1",
        cwd: process.cwd(),
        model: modelInfo.ref,
        modelInfo,
        messages: [{ role: "user", content: "patch it" }],
        outputSchema: z.object({ status: z.literal("done"), finalAnswer: z.string() }),
        budget: withDefaultBudget({ maxWallClockMs: 999, maxModelTurns: 4, maxToolCalls: 2 }),
        toolPolicy: { allowedTools: ["apply_patch"] },
        toolCallContext: {
          cwd: process.cwd(),
          goalId: "goal-1",
          trustBalance: 0,
          preApproved: true,
          approvalFn: async () => false,
        },
      });

      expect(runtime.executeBatch).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
      expect(result.stopReason).toBe("timeout");
      expect(result.failureReason).toBe("tool_batch_deadline_exceeded");
      expect(result.toolCalls).toBe(0);
      expect(result.finalText).toContain("below the 1000ms minimum");
      expect(result.finalText).toContain("apply_patch");
      expect(result.finalText).not.toContain("Calling apply_patch");
      const events = await session.traceStore.list(session.traceId);
      expect(events.some((event) => event.type === "tool_call_started")).toBe(false);
    } finally {
      dateNow.mockRestore();
    }
  });

  it("falls back to a text protocol when the LLM client cannot use native tools", async () => {
    const modelInfo = makeModelInfo({ capabilities: { ...defaultAgentLoopCapabilities, toolCalling: false } });
    const llmCalls: Array<{ messages: LLMMessage[]; options?: LLMRequestOptions }> = [];
    let callIndex = 0;
    const llmClient: ILLMClient = {
      async sendMessage(messages: LLMMessage[], options?: LLMRequestOptions): Promise<LLMResponse> {
        llmCalls.push({ messages, options });
        callIndex++;
        if (callIndex === 1) {
          return {
            content: '{ "tool_calls": [{ "name": "echo", "input": { "value": "hello", }, }, { "name": "echo", "input": { "value": "again" } }] }',
            usage: { input_tokens: 1, output_tokens: 1 },
            stop_reason: "end_turn",
          };
        }
        return {
          content: finalJson(),
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: "end_turn",
        };
      },
      parseJSON<T>(content: string, schema: z.ZodSchema<T>): T {
        return schema.parse(JSON.parse(content));
      },
      supportsToolCalling: () => false,
    };
    const { router, runtime } = makeToolRuntime();
    const modelClient = new ILLMClientAgentLoopModelClient(llmClient, new StaticAgentLoopModelRegistry([modelInfo]));
    const runner = new BoundedAgentLoopRunner({ modelClient, toolRouter: router, toolRuntime: runtime });

    const result = await runner.run({
      session: createAgentLoopSession(),
      turnId: "turn-1",
      goalId: "goal-1",
      taskId: "task-1",
      cwd: process.cwd(),
      model: modelInfo.ref,
      modelInfo,
      messages: [{ role: "user", content: "do it" }],
      outputSchema: z.object({ status: z.literal("done"), finalAnswer: z.string() }),
      budget: withDefaultBudget({ maxModelTurns: 4 }),
      toolPolicy: {},
      toolCallContext: {
        cwd: process.cwd(),
        goalId: "goal-1",
        trustBalance: 0,
        preApproved: true,
        approvalFn: async () => false,
      },
    });

    expect(result.success).toBe(true);
    expect(result.output?.finalAnswer).toBe("finished");
    expect(result.toolCalls).toBe(2);
    expect(llmCalls).toHaveLength(2);
    expect(llmCalls[0]?.options?.tools).toBeUndefined();
    expect(llmCalls[0]?.options?.system).toContain("You do not have native function/tool calling");
    expect(llmCalls[0]?.options?.system).toContain("Available tools:");
    expect(llmCalls[0]?.options?.system).toContain("avoid repo-wide glob or grep sweeps");
    const fallbackToolResult = llmCalls[1]?.messages.find((message) => message.role === "user" && message.content.startsWith("Tool result"));
    expect(fallbackToolResult?.content).toContain("\"type\": \"tool_observation\"");
    expect(fallbackToolResult?.content).toContain("\"state\": \"success\"");
  });

  it("does not wrap external agent runtime clients in the prompted tool protocol", async () => {
    const modelInfo = makeModelInfo({ capabilities: { ...defaultAgentLoopCapabilities, toolCalling: false } });
    const llmCalls: Array<{ messages: LLMMessage[]; options?: LLMRequestOptions }> = [];
    const cwd = process.cwd();
    const llmClient: ILLMClient = {
      async sendMessage(messages: LLMMessage[], options?: LLMRequestOptions): Promise<LLMResponse> {
        llmCalls.push({ messages, options });
        return {
          content: finalJson(),
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: "end_turn",
        };
      },
      parseJSON<T>(content: string, schema: z.ZodSchema<T>): T {
        return schema.parse(JSON.parse(content));
      },
      supportsToolCalling: () => false,
      usesExternalAgentRuntime: () => true,
    };
    const { router, runtime } = makeToolRuntime();
    const modelClient = new ILLMClientAgentLoopModelClient(llmClient, new StaticAgentLoopModelRegistry([modelInfo]));
    const runner = new BoundedAgentLoopRunner({ modelClient, toolRouter: router, toolRuntime: runtime });

    const result = await runner.run({
      session: createAgentLoopSession(),
      turnId: "turn-1",
      goalId: "goal-1",
      taskId: "task-1",
      cwd,
      model: modelInfo.ref,
      modelInfo,
      messages: [{ role: "user", content: "do it" }],
      outputSchema: z.object({ status: z.literal("done"), finalAnswer: z.string() }),
      budget: withDefaultBudget({ maxModelTurns: 2, maxWallClockMs: 123_456 }),
      toolPolicy: {},
      toolCallContext: {
        cwd,
        goalId: "goal-1",
        trustBalance: 0,
        preApproved: true,
        approvalFn: async () => false,
      },
    });

    expect(result.success).toBe(true);
    expect(result.toolCalls).toBe(0);
    expect(llmCalls).toHaveLength(1);
    expect(llmCalls[0]?.options?.tools).toBeUndefined();
    expect(llmCalls[0]?.options?.cwd).toBe(cwd);
    expect(llmCalls[0]?.options?.timeoutMs).toBeGreaterThan(0);
    expect(llmCalls[0]?.options?.timeoutMs).toBeLessThanOrEqual(123_456);
    expect(llmCalls[0]?.options?.idleTimeoutMs).toBe(llmCalls[0]?.options?.timeoutMs);
    expect(llmCalls[0]?.options?.system ?? "").not.toContain("You do not have native function/tool calling");
  });

  it("detects external runtime file changes inside ignored disposable workspaces", async () => {
    const repo = makeTempDir();
    fs.writeFileSync(path.join(repo, "tracked.txt"), "base\n", "utf-8");
    fs.writeFileSync(path.join(repo, ".gitignore"), "tmp/\n", "utf-8");
    execFileSync("git", ["init"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
    execFileSync("git", ["add", "tracked.txt", ".gitignore"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repo });
    const workspace = path.join(repo, "tmp", "canary-workspace");
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, "README.md"), "ignored disposable workspace\n", "utf-8");

    const modelInfo = makeModelInfo({ capabilities: { ...defaultAgentLoopCapabilities, toolCalling: false } });
    let turnCount = 0;
    const modelClient: AgentLoopModelClient = {
      async getModelInfo(): Promise<AgentLoopModelInfo> {
        return modelInfo;
      },
      async createTurn(input: AgentLoopModelRequest): Promise<AgentLoopModelResponse> {
        const protocol = await this.createTurnProtocol!(input);
        return {
          content: protocol.assistant.map((message) => message.content).join("\n"),
          toolCalls: protocol.toolCalls,
          stopReason: protocol.stopReason,
          usage: protocol.usage,
        };
      },
      async createTurnProtocol(input: AgentLoopModelRequest) {
        turnCount += 1;
        if (turnCount === 1) {
          const outputPath = path.join(input.cwd ?? workspace, "reports", "external-runtime.json");
          fs.mkdirSync(path.dirname(outputPath), { recursive: true });
          fs.writeFileSync(outputPath, JSON.stringify({ ok: true }), "utf-8");
        }
        const content = turnCount === 1
          ? JSON.stringify({ status: "done", verified: true })
          : turnCount === 2
            ? JSON.stringify({ finalAnswer: "missing status after repair" })
            : JSON.stringify({
                status: "done",
                finalAnswer: "wrote ignored workspace artifact",
                filesChanged: [],
                completionEvidence: ["external runtime wrote reports/external-runtime.json"],
                blockers: [],
              });
        return {
          assistant: [{
            content,
            phase: "final_answer" as const,
          }],
          toolCalls: [],
          responseItems: [],
          stopReason: "end_turn",
          responseCompleted: true,
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const { router, runtime } = makeToolRuntime();
    const runner = new BoundedAgentLoopRunner({ modelClient, toolRouter: router, toolRuntime: runtime });

    const result = await runner.run({
      session: createAgentLoopSession(),
      turnId: "turn-1",
      goalId: "goal-1",
      taskId: "task-1",
      cwd: workspace,
      model: modelInfo.ref,
      modelInfo,
      messages: [{ role: "user", content: "write artifact" }],
      outputSchema: z.object({
        status: z.literal("done"),
        finalAnswer: z.string(),
        filesChanged: z.array(z.string()).default([]),
        completionEvidence: z.array(z.string()).default([]),
        blockers: z.array(z.string()).default([]),
      }),
      budget: withDefaultBudget({ maxModelTurns: 3 }),
      toolPolicy: {},
      toolCallContext: {
        cwd: workspace,
        goalId: "goal-1",
        trustBalance: 0,
        preApproved: true,
        approvalFn: async () => false,
      },
    });

    expect(result.success).toBe(true);
    expect(result.changedFiles).toEqual(["reports/external-runtime.json"]);
  });

  it("stops after the schema repair budget is exhausted", async () => {
    const modelInfo = makeModelInfo();
    const modelClient = new ScriptedModelClient(modelInfo, [
      { content: "not json", toolCalls: [], stopReason: "end_turn" },
      { content: "still not json", toolCalls: [], stopReason: "end_turn" },
      { content: "still not json", toolCalls: [], stopReason: "end_turn" },
    ]);
    const { router, runtime } = makeToolRuntime();
    const runner = new BoundedAgentLoopRunner({ modelClient, toolRouter: router, toolRuntime: runtime });

    const result = await runner.run({
      session: createAgentLoopSession(),
      turnId: "turn-1",
      goalId: "goal-1",
      cwd: process.cwd(),
      model: modelInfo.ref,
      modelInfo,
      messages: [{ role: "user", content: "final only" }],
      outputSchema: z.object({ ok: z.boolean() }),
      budget: withDefaultBudget({ maxSchemaRepairAttempts: 2, maxModelTurns: 5 }),
      toolPolicy: {},
      toolCallContext: {
        cwd: process.cwd(),
        goalId: "goal-1",
        trustBalance: 0,
        preApproved: true,
        approvalFn: async () => false,
      },
    });

    expect(result.success).toBe(false);
    expect(result.stopReason).toBe("schema_error");
    expect(modelClient.calls).toHaveLength(3);
  });

  it("stops when the model repeats the same tool loop too many times", async () => {
    const modelInfo = makeModelInfo();
    const repeatedResponse: AgentLoopModelResponse = {
      content: "",
      toolCalls: [{ id: "call-1", name: "echo", input: { value: "loop" } }],
      stopReason: "tool_use",
    };
    const modelClient = new ScriptedModelClient(modelInfo, [
      repeatedResponse,
      repeatedResponse,
      repeatedResponse,
      repeatedResponse,
      repeatedResponse,
    ]);
    const { router, runtime } = makeToolRuntime();
    const runner = new BoundedAgentLoopRunner({ modelClient, toolRouter: router, toolRuntime: runtime });

    const result = await runner.run({
      session: createAgentLoopSession(),
      turnId: "turn-1",
      goalId: "goal-1",
      taskId: "task-1",
      cwd: process.cwd(),
      model: modelInfo.ref,
      modelInfo,
      messages: [{ role: "user", content: "loop" }],
      outputSchema: z.object({ status: z.literal("done"), finalAnswer: z.string() }),
      budget: withDefaultBudget({ maxModelTurns: 8, maxRepeatedToolCalls: 3 }),
      toolPolicy: {},
      toolCallContext: {
        cwd: process.cwd(),
        goalId: "goal-1",
        trustBalance: 0,
        preApproved: true,
        approvalFn: async () => false,
      },
    });

    expect(result.success).toBe(false);
    expect(result.stopReason).toBe("stalled_tool_loop");
    expect(result.failureReason).toBe("repeated_tool_calls");
  });

  it("records typed failure reason when the tool runtime throws", async () => {
    const modelInfo = makeModelInfo();
    const modelClient = new ScriptedModelClient(modelInfo, [{
      content: "",
      toolCalls: [{ id: "call-1", name: "echo", input: { value: "hello" } }],
      stopReason: "tool_use",
    }]);
    const { router } = makeToolRuntime();
    const runtime = {
      executeBatch: vi.fn(async (): Promise<AgentLoopToolOutput[]> => {
        throw new Error("tool runtime broke");
      }),
    };
    const runner = new BoundedAgentLoopRunner({ modelClient, toolRouter: router, toolRuntime: runtime });

    const result = await runner.run({
      session: createAgentLoopSession(),
      turnId: "turn-tool-runtime",
      goalId: "goal-1",
      taskId: "task-1",
      cwd: process.cwd(),
      model: modelInfo.ref,
      modelInfo,
      messages: [{ role: "user", content: "run tool" }],
      outputSchema: z.object({ status: z.literal("done"), finalAnswer: z.string() }),
      budget: withDefaultBudget({ maxModelTurns: 4 }),
      toolPolicy: {},
      toolCallContext: {
        cwd: process.cwd(),
        goalId: "goal-1",
        trustBalance: 0,
        preApproved: true,
        approvalFn: async () => false,
      },
    });

    expect(result.success).toBe(false);
    expect(result.stopReason).toBe("fatal_error");
    expect(result.failureReason).toBe("tool_runtime_failure");
    expect(result.failureDetail).toContain("tool runtime broke");
  });

  it("records typed failure reason for repeated tool errors", async () => {
    const modelInfo = makeModelInfo();
    const modelClient = new ScriptedModelClient(modelInfo, [
      { content: "", toolCalls: [{ id: "call-1", name: "echo", input: { value: "one" } }], stopReason: "tool_use" },
      { content: "", toolCalls: [{ id: "call-2", name: "echo", input: { value: "two" } }], stopReason: "tool_use" },
    ]);
    const { router } = makeToolRuntime();
    const runtime = {
      executeBatch: vi.fn(async (calls: AgentLoopToolCall[]): Promise<AgentLoopToolOutput[]> =>
        calls.map((call) => ({
          callId: call.id,
          toolName: call.name,
          success: false,
          content: "tool failed",
          durationMs: 1,
        }))
      ),
    };
    const runner = new BoundedAgentLoopRunner({ modelClient, toolRouter: router, toolRuntime: runtime });

    const result = await runner.run({
      session: createAgentLoopSession(),
      turnId: "turn-tool-errors",
      goalId: "goal-1",
      taskId: "task-1",
      cwd: process.cwd(),
      model: modelInfo.ref,
      modelInfo,
      messages: [{ role: "user", content: "run tools" }],
      outputSchema: z.object({ status: z.literal("done"), finalAnswer: z.string() }),
      budget: withDefaultBudget({ maxModelTurns: 4, maxConsecutiveToolErrors: 2 }),
      toolPolicy: {},
      toolCallContext: {
        cwd: process.cwd(),
        goalId: "goal-1",
        trustBalance: 0,
        preApproved: true,
        approvalFn: async () => false,
      },
    });

    expect(result.success).toBe(false);
    expect(result.stopReason).toBe("consecutive_tool_errors");
    expect(result.failureReason).toBe("consecutive_tool_errors");
  });

  it("records a stopped trace with typed timeout details when the model call throws a structured timeout", async () => {
    const modelInfo = makeModelInfo();
    const modelClient: AgentLoopModelClient = {
      async getModelInfo(): Promise<AgentLoopModelInfo> {
        return modelInfo;
      },
      async createTurn(): Promise<AgentLoopModelResponse> {
        throw namedError("TimeoutError", "provider response did not arrive");
      },
    };
    const { router, runtime } = makeToolRuntime();
    const runner = new BoundedAgentLoopRunner({ modelClient, toolRouter: router, toolRuntime: runtime });
    const session = createAgentLoopSession();

    const result = await runner.run({
      session,
      turnId: "turn-timeout",
      goalId: "goal-1",
      cwd: process.cwd(),
      model: modelInfo.ref,
      modelInfo,
      messages: [{ role: "user", content: "do it" }],
      outputSchema: z.object({ status: z.literal("done"), finalAnswer: z.string() }),
      budget: withDefaultBudget({ maxModelTurns: 4 }),
      toolPolicy: {},
      toolCallContext: {
        cwd: process.cwd(),
        goalId: "goal-1",
        trustBalance: 0,
        preApproved: true,
        approvalFn: async () => false,
      },
    });

    expect(result.success).toBe(false);
    expect(result.stopReason).toBe("timeout");
    expect(result.failureReason).toBe("model_request_timeout");
    expect(result.failureDetail).toContain("provider response did not arrive");
    expect(result.finalText).toContain("timed out");
    const events = await session.traceStore.list(session.traceId);
    const stopped = events.at(-1);
    expect(stopped).toMatchObject({
      type: "stopped",
      reason: "timeout",
      failureReason: "model_request_timeout",
    });
    expect(stopped).toHaveProperty("reasonDetail");
    expect((stopped as { reasonDetail?: string }).reasonDetail).toContain("provider response did not arrive");
    const persisted = await session.stateStore.load();
    expect(persisted?.failureReason).toBe("model_request_timeout");
  });

  it("keeps provider error text display-only when no structured timeout signal exists", async () => {
    const modelInfo = makeModelInfo();
    const modelClient: AgentLoopModelClient = {
      async getModelInfo(): Promise<AgentLoopModelInfo> {
        return modelInfo;
      },
      async createTurn(): Promise<AgentLoopModelResponse> {
        throw new Error("LLM timeout-looking localized text without structured code");
      },
    };
    const { router, runtime } = makeToolRuntime();
    const runner = new BoundedAgentLoopRunner({ modelClient, toolRouter: router, toolRuntime: runtime });

    const result = await runner.run({
      session: createAgentLoopSession(),
      turnId: "turn-provider-text",
      goalId: "goal-1",
      cwd: process.cwd(),
      model: modelInfo.ref,
      modelInfo,
      messages: [{ role: "user", content: "do it" }],
      outputSchema: z.object({ status: z.literal("done"), finalAnswer: z.string() }),
      budget: withDefaultBudget({ maxModelTurns: 4 }),
      toolPolicy: {},
      toolCallContext: {
        cwd: process.cwd(),
        goalId: "goal-1",
        trustBalance: 0,
        preApproved: true,
        approvalFn: async () => false,
      },
    });

    expect(result.success).toBe(false);
    expect(result.stopReason).toBe("fatal_error");
    expect(result.failureReason).toBe("provider_failure");
    expect(result.failureDetail).toContain("timeout-looking localized text");
    expect(result.finalText).toContain("model request failed");
  });

  it("records operator-aborted model work as cancelled instead of timeout", async () => {
    const modelInfo = makeModelInfo();
    const abortController = new AbortController();
    const modelClient: AgentLoopModelClient = {
      async getModelInfo(): Promise<AgentLoopModelInfo> {
        return modelInfo;
      },
      async createTurn(): Promise<AgentLoopModelResponse> {
        abortController.abort(new Error("operator stop requested"));
        throw new DOMException("operator stop requested", "AbortError");
      },
    };
    const { router, runtime } = makeToolRuntime();
    const runner = new BoundedAgentLoopRunner({ modelClient, toolRouter: router, toolRuntime: runtime });
    const session = createAgentLoopSession();

    const result = await runner.run({
      session,
      turnId: "turn-abort",
      goalId: "goal-1",
      cwd: process.cwd(),
      model: modelInfo.ref,
      modelInfo,
      messages: [{ role: "user", content: "do it" }],
      outputSchema: z.object({ status: z.literal("done"), finalAnswer: z.string() }),
      budget: withDefaultBudget({ maxModelTurns: 4 }),
      toolPolicy: {},
      toolCallContext: {
        cwd: process.cwd(),
        goalId: "goal-1",
        trustBalance: 0,
        preApproved: true,
        approvalFn: async () => false,
      },
      abortSignal: abortController.signal,
    });

    expect(result.success).toBe(false);
    expect(result.stopReason).toBe("cancelled");
    expect(result.failureReason).toBe("operator_cancelled");
    expect(result.finalText).toContain("operator stop");
    const stopped = (await session.traceStore.list(session.traceId)).at(-1);
    expect(stopped).toMatchObject({
      type: "stopped",
      reason: "cancelled",
    });
  });

  it("does not classify provider AbortError as operator cancellation when the turn was not aborted", async () => {
    const modelInfo = makeModelInfo();
    const abortController = new AbortController();
    const modelClient: AgentLoopModelClient = {
      async getModelInfo(): Promise<AgentLoopModelInfo> {
        return modelInfo;
      },
      async createTurn(): Promise<AgentLoopModelResponse> {
        throw new DOMException("provider aborted the request", "AbortError");
      },
    };
    const { router, runtime } = makeToolRuntime();
    const runner = new BoundedAgentLoopRunner({ modelClient, toolRouter: router, toolRuntime: runtime });

    const result = await runner.run({
      session: createAgentLoopSession(),
      turnId: "turn-provider-abort",
      goalId: "goal-1",
      cwd: process.cwd(),
      model: modelInfo.ref,
      modelInfo,
      messages: [{ role: "user", content: "do it" }],
      outputSchema: z.object({ status: z.literal("done"), finalAnswer: z.string() }),
      budget: withDefaultBudget({ maxModelTurns: 4 }),
      toolPolicy: {},
      toolCallContext: {
        cwd: process.cwd(),
        goalId: "goal-1",
        trustBalance: 0,
        preApproved: true,
        approvalFn: async () => false,
      },
      abortSignal: abortController.signal,
    });

    expect(result.success).toBe(false);
    expect(result.stopReason).toBe("fatal_error");
    expect(result.failureReason).toBe("model_request_aborted");
  });
});

describe("agentloop phase 2", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("runs TaskLifecycle execution through TaskAgentLoopRunner and owns task status updates", async () => {
    const modelInfo = makeModelInfo();
    fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    const registry = new StaticAgentLoopModelRegistry([modelInfo]);
    let llmCallCount = 0;
    const llmClient: ILLMClient = {
      async sendMessage(_messages: LLMMessage[], _options?: LLMRequestOptions): Promise<LLMResponse> {
        llmCallCount++;
        if (llmCallCount === 1) {
          return {
            content: "",
            usage: { input_tokens: 1, output_tokens: 1 },
            stop_reason: "tool_use",
            tool_calls: [{
              id: "patch-1",
              function: {
                name: "apply_patch",
                arguments: JSON.stringify({
                  cwd: tmpDir,
                  patch: [
                    "*** Begin Patch",
                    "*** Add File: src/example.ts",
                    "+export const example = true;",
                    "*** End Patch",
                  ].join("\n"),
                }),
              },
            }],
          };
        }
        if (llmCallCount === 2) {
          return {
            content: "",
            usage: { input_tokens: 1, output_tokens: 1 },
            stop_reason: "tool_use",
            tool_calls: [{
              id: "call-1",
              function: {
                name: "verify",
                arguments: JSON.stringify({ command: "test -f src/example.ts", cwd: tmpDir }),
              },
            }],
          };
        }
        return {
          content: finalJson(),
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: "end_turn",
        };
      },
      parseJSON<T>(content: string, schema: z.ZodSchema<T>): T {
        return schema.parse(JSON.parse(content));
      },
      supportsToolCalling: () => true,
    };
    const modelClient = new ILLMClientAgentLoopModelClient(llmClient, registry);
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(new ApplyPatchTool());
    toolRegistry.register(new VerifyTool());
    const router = new ToolRegistryAgentLoopToolRouter(toolRegistry);
    const executor = new ToolExecutor({
      registry: toolRegistry,
      permissionManager: new ToolPermissionManager({}),
      concurrency: new ConcurrencyController(),
    });
    const runtime = new ToolExecutorAgentLoopToolRuntime(executor, router);
    const boundedRunner = new BoundedAgentLoopRunner({ modelClient, toolRouter: router, toolRuntime: runtime });
    const taskRunner = new TaskAgentLoopRunner({
      boundedRunner,
      modelClient,
      modelRegistry: registry,
      defaultModel: modelInfo.ref,
      defaultToolPolicy: { allowedTools: ["apply_patch", "verify"] },
    });

    const stateManager = new StateManager(tmpDir);
    const sessionManager = new SessionManager(stateManager);
    const trustManager = new TrustManager(stateManager);
    const strategyManager = new StrategyManager(stateManager, llmClient);
    const lifecycle = new TaskLifecycle(
      stateManager,
      llmClient,
      sessionManager,
      trustManager,
      strategyManager,
      new StallDetector(stateManager),
      {
        agentLoopRunner: taskRunner,
        execFileSyncFn: (_cmd, args) => {
          if (args[0] === "diff" && args[1] === "--name-only") {
            return fs.existsSync(path.join(tmpDir, "src/example.ts")) ? "src/example.ts\n" : "";
          }
          if (args[0] === "diff" && args[1] === "--cached") return "";
          if (args[0] === "ls-files") return "";
          if (args[0] === "diff" && args.includes("src/example.ts")) {
            return "diff --git a/src/example.ts b/src/example.ts\n@@ -0,0 +1 @@\n+export const example = true;\n";
          }
          return "";
        },
      },
    );
    const task = makeTask({
      constraints: [`workspace_path:${tmpDir}`],
      success_criteria: [{ description: "example exists", verification_method: "test -f src/example.ts", is_blocking: true }],
    });
    await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);

    const result = await lifecycle.executeTaskWithAgentLoop(task, "workspace context", "knowledge context");

    expect(result.success).toBe(true);
    expect(result.output).toBe("finished");
    const persisted = await stateManager.readRaw(`tasks/${task.goal_id}/${task.id}.json`) as Task;
    expect(persisted.status).toBe("completed");
    expect(persisted.execution_output).toBe("finished");

    expect(result.stopped_reason).toBe("completed");
    expect(result.agentLoop).toMatchObject({
      stopReason: "completed",
      completionEvidence: expect.arrayContaining(["unit evidence", "verified command: test -f src/example.ts"]),
      verificationHints: ["hint"],
      filesChangedPaths: ["src/example.ts"],
    });
  });

  it("ignores active task lifecycle-owned task_update on the production task AgentLoop path", async () => {
    const modelInfo = makeModelInfo();
    const stateManager = new StateManager(tmpDir);
    const modelClient = new ScriptedModelClient(modelInfo, [
      {
        content: "",
        toolCalls: [{
          id: "update-current-task",
          name: "task_update",
          input: {
            goalId: "goal-1",
            taskId: "task-1",
            status: "completed",
            verification_verdict: "pass",
            verification_evidence: ["self-declared success"],
          },
        }],
        stopReason: "tool_use",
      },
      {
        content: JSON.stringify({
          status: "done",
          finalAnswer: "Returned final task result after lifecycle-owned task_update was ignored.",
          summary: "completed",
          filesChanged: [],
          testsRun: [],
          completionEvidence: ["final JSON returned"],
          verificationHints: [],
          blockers: [],
        }),
        toolCalls: [],
        stopReason: "end_turn",
      },
    ]);
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(new TaskUpdateTool(stateManager));
    const router = new ToolRegistryAgentLoopToolRouter(toolRegistry);
    const executor = new ToolExecutor({
      registry: toolRegistry,
      permissionManager: new ToolPermissionManager({}),
      concurrency: new ConcurrencyController(),
    });
    const runtime = new ToolExecutorAgentLoopToolRuntime(executor, router);
    const boundedRunner = new BoundedAgentLoopRunner({ modelClient, toolRouter: router, toolRuntime: runtime });
    const taskRunner = new TaskAgentLoopRunner({
      boundedRunner,
      modelClient,
      modelRegistry: new StaticAgentLoopModelRegistry([modelInfo]),
      defaultModel: modelInfo.ref,
      defaultToolPolicy: { allowedTools: ["task_update"] },
    });
    const llmClient = createMockLLMClient([]);
    const lifecycle = new TaskLifecycle(
      stateManager,
      llmClient,
      new SessionManager(stateManager),
      new TrustManager(stateManager),
      new StrategyManager(stateManager, llmClient),
      new StallDetector(stateManager),
      { agentLoopRunner: taskRunner, execFileSyncFn: () => "" },
    );
    const task = makeTask({ id: "task-1", task_category: "observation" });
    await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);

    const result = await lifecycle.executeTaskWithAgentLoop(task, "workspace context", "knowledge context");

    expect(result.success).toBe(true);
    expect(result.stopped_reason).toBe("completed");
    const persisted = await stateManager.readRaw(`tasks/${task.goal_id}/${task.id}.json`) as Task;
    expect(persisted.status).toBe("completed");
    expect(persisted.verification_verdict).toBeUndefined();
    const ledger = await stateManager.readRaw(`tasks/${task.goal_id}/ledger/${task.id}.json`) as {
      events: Array<{ type: string; stopped_reason: string | null; verification_verdict?: string }>;
      summary: { latest_event_type: string | null; task_status: string; stopped_reason: string | null; verification_verdict?: string };
    };
    expect(ledger.events.map((event) => event.type)).toEqual(["started", "succeeded"]);
    expect(ledger.events.filter((event) => event.type === "succeeded")).toHaveLength(1);
    expect(ledger.events.at(-1)).toMatchObject({ type: "succeeded" });
    expect(ledger.summary).toMatchObject({
      latest_event_type: "succeeded",
      task_status: "completed",
      stopped_reason: null,
    });
    expect(ledger.summary.verification_verdict).toBeUndefined();
  });

  it("uses the goal workspace_path for native task execution when daemon cwd differs", async () => {
    const daemonDir = tmpDir;
    const goalWorkspace = makeTempDir();
    try {
      fs.mkdirSync(goalWorkspace, { recursive: true });
      fs.mkdirSync(path.join(goalWorkspace, ".git"), { recursive: true });
      fs.mkdirSync(path.join(goalWorkspace, "src"), { recursive: true });
      const modelInfo = makeModelInfo();
      const modelClient = new ScriptedModelClient(modelInfo, [
        {
          content: "",
          toolCalls: [{
            id: "patch-1",
            name: "apply_patch",
            input: {
              cwd: goalWorkspace,
              patch: [
                "*** Begin Patch",
                "*** Add File: src/example.ts",
                "+export const example = true;",
                "*** End Patch",
              ].join("\n"),
            },
          }],
          stopReason: "tool_use",
        },
        {
          content: "",
          toolCalls: [{ id: "call-1", name: "verify", input: { command: "test -d ." } }],
          stopReason: "tool_use",
        },
        {
          content: finalJson(),
          toolCalls: [],
          stopReason: "end_turn",
        },
      ]);
      const registry = new ToolRegistry();
      registry.register(new ApplyPatchTool());
      registry.register(new VerifyTool());
      const router = new ToolRegistryAgentLoopToolRouter(registry);
      const executor = new ToolExecutor({
        registry,
        permissionManager: new ToolPermissionManager({}),
        concurrency: new ConcurrencyController(),
      });
      const runtime = new ToolExecutorAgentLoopToolRuntime(executor, router);
      const boundedRunner = new BoundedAgentLoopRunner({ modelClient, toolRouter: router, toolRuntime: runtime });
      const taskRunner = new TaskAgentLoopRunner({
        boundedRunner,
        modelClient,
        modelRegistry: new StaticAgentLoopModelRegistry([modelInfo]),
        defaultModel: modelInfo.ref,
        defaultToolPolicy: { allowedTools: ["apply_patch", "verify"] },
        cwd: daemonDir,
      });
      const diffCwds: string[] = [];
      const stateManager = new StateManager(daemonDir);
      await stateManager.saveGoal(makeGoal({
        id: "goal-1",
        constraints: [`workspace_path:${goalWorkspace}`],
      }));
      const llmClient: ILLMClient = {
        async sendMessage(): Promise<LLMResponse> {
          return { content: finalJson(), usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: "end_turn" };
        },
        parseJSON<T>(content: string, schema: z.ZodSchema<T>): T {
          return schema.parse(JSON.parse(content));
        },
        supportsToolCalling: () => true,
      };
      const sessionManager = new SessionManager(stateManager);
      const lifecycle = new TaskLifecycle(
        stateManager,
        llmClient,
        sessionManager,
        new TrustManager(stateManager),
        new StrategyManager(stateManager, llmClient),
        new StallDetector(stateManager),
        {
          agentLoopRunner: taskRunner,
          execFileSyncFn: (_cmd, args, opts) => {
            diffCwds.push(opts.cwd);
            if (args[0] === "diff" && args[1] === "--name-only") {
              return fs.existsSync(path.join(goalWorkspace, "src/example.ts")) ? "src/example.ts\n" : "";
            }
            if (args[0] === "diff" && args[1] === "--cached") return "";
            if (args[0] === "ls-files") return "";
            if (args[0] === "diff" && args.includes("src/example.ts")) {
              return "diff --git a/src/example.ts b/src/example.ts\n@@ -0,0 +1 @@\n+export const example = true;\n";
            }
            return "";
          },
        },
      );
      const task = makeTask({
        success_criteria: [{ description: "workspace exists", verification_method: "test -d .", is_blocking: true }],
      });
      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);

      const result = await lifecycle.executeTaskWithAgentLoop(task, "workspace context", "knowledge context");

      expect(result.success).toBe(true);
      expect(result.agentLoop?.requestedCwd).toBe(fs.realpathSync(goalWorkspace));
      expect(result.agentLoop?.executionCwd).toBe(fs.realpathSync(goalWorkspace));
      expect(result.agentLoop?.requestedCwd).not.toBe(fs.realpathSync(daemonDir));
      expect(diffCwds).toEqual(expect.arrayContaining([fs.realpathSync(goalWorkspace)]));
      expect(diffCwds).not.toContain(fs.realpathSync(daemonDir));
    } finally {
      fs.rmSync(goalWorkspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it("populates file diffs for non-git native task execution through TaskLifecycle", async () => {
    const daemonDir = tmpDir;
    const goalWorkspace = makeTempDir();
    try {
      fs.mkdirSync(goalWorkspace, { recursive: true });
      const modelInfo = makeModelInfo();
      const modelClient = new ScriptedModelClient(modelInfo, [
        {
          content: "",
          toolCalls: [{
            id: "patch-1",
            name: "apply_patch",
            input: {
              cwd: goalWorkspace,
              patch: [
                "*** Begin Patch",
                "*** Add File: reports/hgb.json",
                "+{\"score\":0.95}",
                "*** End Patch",
              ].join("\n"),
            },
          }],
          stopReason: "tool_use",
        },
        {
          content: "",
          toolCalls: [{ id: "verify-1", name: "verify", input: { command: "test -f reports/hgb.json" } }],
          stopReason: "tool_use",
        },
        {
          content: JSON.stringify({
            status: "done",
            finalAnswer: "finished",
            summary: "created report",
            filesChanged: [],
            testsRun: [],
            completionEvidence: [],
            verificationHints: [],
            blockers: [],
          }),
          toolCalls: [],
          stopReason: "end_turn",
        },
      ]);
      const registry = new ToolRegistry();
      registry.register(new ApplyPatchTool());
      registry.register(new VerifyTool());
      const router = new ToolRegistryAgentLoopToolRouter(registry);
      const executor = new ToolExecutor({
        registry,
        permissionManager: new ToolPermissionManager({}),
        concurrency: new ConcurrencyController(),
      });
      const runtime = new ToolExecutorAgentLoopToolRuntime(executor, router);
      const boundedRunner = new BoundedAgentLoopRunner({ modelClient, toolRouter: router, toolRuntime: runtime });
      const taskRunner = new TaskAgentLoopRunner({
        boundedRunner,
        modelClient,
        modelRegistry: new StaticAgentLoopModelRegistry([modelInfo]),
        defaultModel: modelInfo.ref,
        defaultToolPolicy: { allowedTools: ["apply_patch", "verify"] },
        cwd: daemonDir,
      });
      const stateManager = new StateManager(daemonDir);
      await stateManager.saveGoal(makeGoal({
        id: "goal-1",
        constraints: [`workspace_path:${goalWorkspace}`],
      }));
      const llmClient: ILLMClient = {
        async sendMessage(): Promise<LLMResponse> {
          return { content: finalJson(), usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: "end_turn" };
        },
        parseJSON<T>(content: string, schema: z.ZodSchema<T>): T {
          return schema.parse(JSON.parse(content));
        },
        supportsToolCalling: () => true,
      };
      const sessionManager = new SessionManager(stateManager);
      const execFileSyncFn = vi.fn(() => {
        throw new Error("git should not be probed for non-git fallback diff evidence");
      });
      const lifecycle = new TaskLifecycle(
        stateManager,
        llmClient,
        sessionManager,
        new TrustManager(stateManager),
        new StrategyManager(stateManager, llmClient),
        new StallDetector(stateManager),
        { agentLoopRunner: taskRunner, execFileSyncFn },
      );
      const task = makeTask({
        success_criteria: [{ description: "report exists", verification_method: "test -f reports/hgb.json", is_blocking: true }],
      });
      await stateManager.writeRaw(`tasks/${task.goal_id}/${task.id}.json`, task);

      const result = await lifecycle.executeTaskWithAgentLoop(task, "workspace context", "knowledge context");

      expect(result.success).toBe(true);
      expect(result.filesChangedPaths).toEqual(["reports/hgb.json"]);
      expect(result.fileDiffs).toEqual([
        expect.objectContaining({
          path: "reports/hgb.json",
          patch: expect.stringContaining("+{\"score\":0.95}"),
        }),
      ]);
      expect(execFileSyncFn).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(goalWorkspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it("rejects premature done until runtime verification evidence exists", async () => {
    const modelInfo = makeModelInfo();
    const modelClient = new ScriptedModelClient(modelInfo, [
      {
        content: JSON.stringify({
          status: "done",
          finalAnswer: "finished",
          summary: "summary",
          filesChanged: ["src/example.ts"],
          testsRun: [],
          completionEvidence: [],
          verificationHints: [],
          blockers: [],
        }),
        toolCalls: [],
        stopReason: "end_turn",
      },
      {
        content: "",
        toolCalls: [{ id: "call-1", name: "verify", input: { command: "test -f src/example.ts", cwd: tmpDir } }],
        stopReason: "tool_use",
      },
      {
        content: JSON.stringify({
          status: "done",
          finalAnswer: "finished after verify",
          summary: "summary",
          filesChanged: ["src/example.ts"],
          testsRun: [],
          completionEvidence: [],
          verificationHints: [],
          blockers: [],
        }),
        toolCalls: [],
        stopReason: "end_turn",
      },
    ]);
    const registry = new ToolRegistry();
    registry.register(new EchoTool());
    registry.register(new VerifyTool());
    const router = new ToolRegistryAgentLoopToolRouter(registry);
    const executor = new ToolExecutor({
      registry,
      permissionManager: new ToolPermissionManager({}),
      concurrency: new ConcurrencyController(),
    });
    const runtime = new ToolExecutorAgentLoopToolRuntime(executor, router);
    const boundedRunner = new BoundedAgentLoopRunner({ modelClient, toolRouter: router, toolRuntime: runtime });
    const taskRunner = new TaskAgentLoopRunner({
      boundedRunner,
      modelClient,
      modelRegistry: new StaticAgentLoopModelRegistry([modelInfo]),
      defaultModel: modelInfo.ref,
      defaultToolPolicy: { allowedTools: ["echo", "verify"] },
    });

    const result = await taskRunner.runTask({
      task: makeTask({
        success_criteria: [{ description: "example exists", verification_method: "test -f src/example.ts", is_blocking: true }],
      }),
      cwd: tmpDir,
    });

    expect(result.success).toBe(true);
    expect(result.commandResults).toHaveLength(1);
    expect(result.commandResults[0]).toMatchObject({ toolName: "verify", command: "test -f src/example.ts", success: true });
    expect(modelClient.calls[1].messages.some((message) =>
      message.role === "user" && message.content.includes("premature"))
    ).toBe(true);
  });

  it("uses the task verification plan on the production caller path instead of command keyword evidence", async () => {
    const modelInfo = makeModelInfo();
    const declaredVerificationCommand = "printf proof > evidence.txt";
    const doneWithoutEvidence = {
      status: "done",
      finalAnswer: "finished",
      summary: "summary",
      filesChanged: ["evidence.txt"],
      testsRun: [],
      completionEvidence: [],
      verificationHints: [],
      blockers: [],
    };
    const modelClient = new ScriptedModelClient(modelInfo, [
      {
        content: JSON.stringify(doneWithoutEvidence),
        toolCalls: [],
        stopReason: "end_turn",
      },
      {
        content: "",
        toolCalls: [{ id: "stale-1", name: "shell_command", input: { command: "test -f stale-target.txt", cwd: tmpDir } }],
        stopReason: "tool_use",
      },
      {
        content: JSON.stringify(doneWithoutEvidence),
        toolCalls: [],
        stopReason: "end_turn",
      },
      {
        content: "",
        toolCalls: [{ id: "planned-1", name: "shell_command", input: { command: declaredVerificationCommand, cwd: tmpDir } }],
        stopReason: "tool_use",
      },
      {
        content: JSON.stringify({ ...doneWithoutEvidence, finalAnswer: "finished after planned verification" }),
        toolCalls: [],
        stopReason: "end_turn",
      },
    ]);
    const registry = new ToolRegistry();
    registry.register(new ShellCommandLikeTool());
    const router = new ToolRegistryAgentLoopToolRouter(registry);
    const executor = new ToolExecutor({
      registry,
      permissionManager: new ToolPermissionManager({}),
      concurrency: new ConcurrencyController(),
    });
    const runtime = new ToolExecutorAgentLoopToolRuntime(executor, router);
    const boundedRunner = new BoundedAgentLoopRunner({ modelClient, toolRouter: router, toolRuntime: runtime });
    const taskRunner = new TaskAgentLoopRunner({
      boundedRunner,
      modelClient,
      modelRegistry: new StaticAgentLoopModelRegistry([modelInfo]),
      defaultModel: modelInfo.ref,
      defaultToolPolicy: { allowedTools: ["shell_command"] },
    });

    const result = await taskRunner.runTask({
      task: makeTask({
        success_criteria: [{
          description: "evidence command ran",
          verification_method: declaredVerificationCommand,
          is_blocking: true,
        }],
      }),
      cwd: tmpDir,
    });

    expect(result.success).toBe(true);
    expect(result.commandResults).toEqual([
      expect.objectContaining({
        command: "test -f stale-target.txt",
        category: "other",
        evidenceEligible: false,
      }),
      expect.objectContaining({
        command: declaredVerificationCommand,
        category: "verification",
        evidenceEligible: true,
        evidenceSource: "verification_plan",
      }),
    ]);
    expect(modelClient.calls[1].messages.some((message) =>
      message.role === "user" && message.content.includes("premature"))
    ).toBe(true);
    expect(modelClient.calls[3].messages.some((message) =>
      message.role === "user" && message.content.includes("premature"))
    ).toBe(true);
  });

});
