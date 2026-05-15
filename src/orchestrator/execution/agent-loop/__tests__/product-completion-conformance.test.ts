import * as fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod/v3";

import { makeTempDir } from "../../../../../tests/helpers/temp-dir.js";
import { ConcurrencyController } from "../../../../tools/concurrency.js";
import { ToolExecutor } from "../../../../tools/executor.js";
import { ToolPermissionManager } from "../../../../tools/permission.js";
import { ToolRegistry } from "../../../../tools/registry.js";
import {
  BoundedAgentLoopRunner,
  ChatAgentLoopRunner,
  StaticAgentLoopModelRegistry,
  ToolExecutorAgentLoopToolRuntime,
  ToolRegistryAgentLoopToolRouter,
  createAgentLoopSession,
  withDefaultBudget,
  type AgentLoopCompletionValidationResult,
  type AgentLoopModelClient,
  type AgentLoopModelInfo,
  type AgentLoopModelRequest,
  type AgentLoopModelResponse,
  type AgentLoopToolPolicy,
} from "../index.js";
import { makeAgentLoopModelInfo } from "../../../../../tests/helpers/agent-loop-fixtures.js";

const PROVIDER_ENV_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
] as const;

const ProductCompletionOutputSchema = z.object({
  status: z.enum(["done", "failed", "blocked"]),
  message: z.string(),
  evidence: z.array(z.string()).default([]),
  blockers: z.array(z.string()).default([]),
});
type ProductCompletionOutput = z.infer<typeof ProductCompletionOutputSchema>;

class ScriptedModelClient implements AgentLoopModelClient {
  readonly calls: AgentLoopModelRequest[] = [];
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
    return this.responses[this.index++]
      ?? { content: JSON.stringify({ status: "done", message: "fallback", evidence: [], blockers: [] }), toolCalls: [], stopReason: "end_turn" };
  }
}

function makeModelInfo(): AgentLoopModelInfo {
  return makeAgentLoopModelInfo({
    ref: { providerId: "scripted-product-completion", modelId: "model" },
  });
}

function makeRuntime(registry = new ToolRegistry()) {
  const router = new ToolRegistryAgentLoopToolRouter(registry);
  const executor = new ToolExecutor({
    registry,
    permissionManager: new ToolPermissionManager({}),
    concurrency: new ConcurrencyController(),
  });
  return {
    router,
    runtime: new ToolExecutorAgentLoopToolRuntime(executor, router),
  };
}

describe("AgentLoop product-completion conformance", () => {
  let tmpDir: string;
  let providerEnv: Partial<Record<(typeof PROVIDER_ENV_KEYS)[number], string>>;

  beforeEach(() => {
    tmpDir = makeTempDir();
    providerEnv = {};
    for (const key of PROVIDER_ENV_KEYS) {
      providerEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    for (const key of PROVIDER_ENV_KEYS) {
      const previous = providerEnv[key];
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });

  it("fails closed when the scripted provider calls an unavailable tool", async () => {
    const modelInfo = makeModelInfo();
    const modelClient = new ScriptedModelClient(modelInfo, [{
      content: "",
      toolCalls: [{ id: "call-missing", name: "missing_tool", input: { value: "x" } }],
      stopReason: "tool_use",
    }]);
    const { router, runtime } = makeRuntime();

    const result = await runBoundedProductTurn({
      modelInfo,
      modelClient,
      router,
      runtime,
      toolPolicy: { allowedTools: ["missing_tool"] },
      budget: { maxModelTurns: 3, maxConsecutiveToolErrors: 1 },
    });

    expectNoProviderKeys();
    expect(result.success).toBe(false);
    expect(result.stopReason).toBe("consecutive_tool_errors");
    expect(result.failureReason).toBe("consecutive_tool_errors");
    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults?.[0]).toMatchObject({
      toolName: "missing_tool",
      success: false,
      execution: {
        status: "not_executed",
        reason: "tool_error",
      },
    });
    expect(modelClient.calls).toHaveLength(1);
  });

  it("exhausts the model-turn budget before making any provider request", async () => {
    const modelInfo = makeModelInfo();
    const modelClient = new ScriptedModelClient(modelInfo, [{
      content: JSON.stringify({ status: "done", message: "should not run", evidence: [], blockers: [] }),
      toolCalls: [],
      stopReason: "end_turn",
    }]);
    const { router, runtime } = makeRuntime();

    const result = await runBoundedProductTurn({
      modelInfo,
      modelClient,
      router,
      runtime,
      budget: { maxModelTurns: 0 },
    });

    expectNoProviderKeys();
    expect(result.success).toBe(false);
    expect(result.stopReason).toBe("max_model_turns");
    expect(result.failureReason).toBe("max_model_turns");
    expect(modelClient.calls).toHaveLength(0);
  });

  it("fails closed through ChatAgentLoopRunner when a provider refusal never satisfies the schema", async () => {
    const modelInfo = makeModelInfo();
    const modelClient = new ScriptedModelClient(modelInfo, [
      { content: "I cannot produce that structured output.", toolCalls: [], stopReason: "end_turn" },
      { content: "Still refusing without JSON.", toolCalls: [], stopReason: "end_turn" },
    ]);
    const { router, runtime } = makeRuntime();
    const chat = new ChatAgentLoopRunner({
      boundedRunner: new BoundedAgentLoopRunner({ modelClient, toolRouter: router, toolRuntime: runtime }),
      modelClient,
      modelRegistry: new StaticAgentLoopModelRegistry([modelInfo]),
      defaultModel: modelInfo.ref,
      cwd: tmpDir,
    });

    const result = await chat.execute({
      message: "return product-completion status",
      outputMode: { kind: "structured", schema: ProductCompletionOutputSchema },
      budget: { maxSchemaRepairAttempts: 1, maxModelTurns: 3 },
    });

    expectNoProviderKeys();
    expect(result.success).toBe(false);
    expect(result.agentLoop).toMatchObject({
      stopReason: "schema_error",
      failureReason: "schema_validation_failed",
      modelTurns: 2,
    });
    expect(modelClient.calls[1]?.messages.some((message) =>
      message.content.includes("required JSON schema")
    )).toBe(true);
  });

  it("retries after completion verification fails and succeeds only after the validator passes", async () => {
    const modelInfo = makeModelInfo();
    const modelClient = new ScriptedModelClient(modelInfo, [
      {
        content: JSON.stringify({ status: "done", message: "premature", evidence: [], blockers: [] }),
        toolCalls: [],
        stopReason: "end_turn",
      },
      {
        content: JSON.stringify({ status: "done", message: "verified", evidence: ["checked"], blockers: [] }),
        toolCalls: [],
        stopReason: "end_turn",
      },
    ]);
    const { router, runtime } = makeRuntime();
    let attempts = 0;

    const result = await runBoundedProductTurn({
      modelInfo,
      modelClient,
      router,
      runtime,
      budget: { maxModelTurns: 3, maxCompletionValidationAttempts: 1 },
      completionValidator: async () => {
        attempts += 1;
        return attempts === 1
          ? { ok: false, reasons: ["verification evidence is missing"] }
          : { ok: true, reasons: [] };
      },
    });

    expectNoProviderKeys();
    expect(result.success).toBe(true);
    expect(result.output).toMatchObject({
      status: "done",
      message: "verified",
      evidence: ["checked"],
    });
    expect(modelClient.calls).toHaveLength(2);
    expect(modelClient.calls[1]?.messages.some((message) =>
      message.content.includes("verification evidence is missing")
    )).toBe(true);
  });

  it("fails closed when completion verification never passes inside the retry budget", async () => {
    const modelInfo = makeModelInfo();
    const modelClient = new ScriptedModelClient(modelInfo, [{
      content: JSON.stringify({ status: "done", message: "unverified", evidence: [], blockers: [] }),
      toolCalls: [],
      stopReason: "end_turn",
    }]);
    const { router, runtime } = makeRuntime();

    const result = await runBoundedProductTurn({
      modelInfo,
      modelClient,
      router,
      runtime,
      budget: { maxModelTurns: 2, maxCompletionValidationAttempts: 0 },
      completionValidator: async () => ({ ok: false, reasons: ["post-condition was not proven"] }),
    });

    expectNoProviderKeys();
    expect(result.success).toBe(false);
    expect(result.stopReason).toBe("completion_gate_failed");
    expect(result.failureReason).toBe("completion_gate_failed");
    expect(modelClient.calls).toHaveLength(1);
  });

  async function runBoundedProductTurn(input: {
    modelInfo: AgentLoopModelInfo;
    modelClient: ScriptedModelClient;
    router: ReturnType<typeof makeRuntime>["router"];
    runtime: ReturnType<typeof makeRuntime>["runtime"];
    toolPolicy?: AgentLoopToolPolicy;
    budget?: Partial<ReturnType<typeof withDefaultBudget>>;
    completionValidator?: () => AgentLoopCompletionValidationResult | Promise<AgentLoopCompletionValidationResult>;
  }) {
    return new BoundedAgentLoopRunner({
      modelClient: input.modelClient,
      toolRouter: input.router,
      toolRuntime: input.runtime,
    }).run<ProductCompletionOutput>({
      session: createAgentLoopSession(),
      turnId: "turn-product-completion",
      goalId: "goal-product-completion",
      cwd: tmpDir,
      model: input.modelInfo.ref,
      modelInfo: input.modelInfo,
      messages: [{ role: "user", content: "complete product-completion turn" }],
      outputSchema: ProductCompletionOutputSchema,
      budget: withDefaultBudget({
        maxWallClockMs: 30_000,
        ...input.budget,
      }),
      toolPolicy: input.toolPolicy ?? {},
      ...(input.completionValidator ? { completionValidator: input.completionValidator } : {}),
      toolCallContext: {
        cwd: tmpDir,
        goalId: "goal-product-completion",
        trustBalance: 0,
        preApproved: true,
        approvalFn: async () => false,
      },
    });
  }
});

function expectNoProviderKeys(): void {
  for (const key of PROVIDER_ENV_KEYS) {
    expect(process.env[key]).toBeUndefined();
  }
}
