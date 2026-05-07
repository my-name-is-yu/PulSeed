import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { StateManager } from "../../../../base/state/state-manager.js";
import { RuntimeControlService } from "../../../../runtime/control/index.js";
import type { AgentLoopModelClient, AgentLoopModelInfo, AgentLoopModelRequest, AgentLoopModelTurnProtocol } from "../agent-loop-model.js";
import { defaultAgentLoopCapabilities } from "../agent-loop-model.js";
import { BoundedAgentLoopRunner } from "../bounded-agent-loop-runner.js";
import { createAgentLoopSession } from "../agent-loop-session.js";
import { withDefaultBudget } from "../agent-loop-turn-context.js";
import { ToolRegistryAgentLoopToolRouter } from "../agent-loop-tool-router.js";
import { ToolExecutorAgentLoopToolRuntime } from "../agent-loop-tool-runtime.js";
import { assistantTextResponseItem, functionToolCallResponseItem } from "../response-item.js";
import { ToolRegistry } from "../../../../tools/registry.js";
import { ToolExecutor } from "../../../../tools/executor.js";
import { ToolPermissionManager } from "../../../../tools/permission.js";
import { ConcurrencyController } from "../../../../tools/concurrency.js";
import { createRuntimeSessionTools } from "../../../../tools/query/runtime-session-tools.js";
import { createSetupRuntimeControlTools } from "../../../../tools/runtime/SetupRuntimeControlTools.js";
import { BackgroundRunLedger } from "../../../../runtime/store/background-run-store.js";
import { RuntimeOperationStore } from "../../../../runtime/store/runtime-operation-store.js";
import { PermissionWaitPlanStore } from "../../../../runtime/store/permission-wait-plan-store.js";
import type { ITool, PermissionCheckResult, ToolCallContext, ToolResult } from "../../../../tools/types.js";

class ScriptedProtocolModel implements AgentLoopModelClient {
  readonly calls: AgentLoopModelRequest[] = [];
  private index = 0;

  constructor(
    private readonly modelInfo: AgentLoopModelInfo,
    private readonly responses: AgentLoopModelTurnProtocol[],
  ) {}

  async getModelInfo(): Promise<AgentLoopModelInfo> {
    return this.modelInfo;
  }

  async createTurn(): Promise<never> {
    throw new Error("createTurn should not be used when response items are available");
  }

  async createTurnProtocol(input: AgentLoopModelRequest): Promise<AgentLoopModelTurnProtocol> {
    this.calls.push({
      ...input,
      messages: [...input.messages],
      tools: [...input.tools],
    });
    return this.responses[this.index++] ?? this.responses[this.responses.length - 1];
  }
}

function makeModelInfo(): AgentLoopModelInfo {
  return {
    ref: { providerId: "test", modelId: "runtime-tools" },
    displayName: "test/runtime-tools",
    capabilities: { ...defaultAgentLoopCapabilities },
  };
}

function makeToolStack(
  stateManager: StateManager,
  runtimeControlService?: RuntimeControlService,
): {
  router: ToolRegistryAgentLoopToolRouter;
  runtime: ToolExecutorAgentLoopToolRuntime;
} {
  const registry = new ToolRegistry();
  for (const tool of createRuntimeSessionTools(stateManager)) {
    registry.register(tool);
  }
  for (const tool of createSetupRuntimeControlTools({ stateManager, runtimeControlService })) {
    registry.register(tool);
  }
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

function createApprovalRequiredTool(): ITool<{ value: string }> {
  return {
    metadata: {
      name: "write_wait_tool",
      aliases: [],
      permissionLevel: "write_local",
      isReadOnly: false,
      isDestructive: false,
      shouldDefer: false,
      alwaysLoad: false,
      maxConcurrency: 0,
      maxOutputChars: 8000,
      tags: [],
    },
    inputSchema: z.object({ value: z.string() }),
    description: () => "Write wait tool",
    checkPermissions: async (): Promise<PermissionCheckResult> => ({ status: "allowed" }),
    isConcurrencySafe: () => true,
    call: async (_input: { value: string }, _context: ToolCallContext): Promise<ToolResult> => ({
      success: true,
      data: { wrote: true },
      summary: "write_wait_tool executed",
      durationMs: 1,
    }),
  };
}

async function createRunningRun(baseDir: string, input: {
  id: string;
  status?: "queued" | "running" | "succeeded";
  updatedAt: string;
  goalId?: string;
}): Promise<void> {
  const ledger = new BackgroundRunLedger(path.join(baseDir, "runtime"));
  await ledger.create({
    id: input.id,
    kind: "coreloop_run",
    goal_id: input.goalId ?? "goal-runtime",
    notify_policy: "silent",
    reply_target_source: "none",
    status: input.status === "queued" ? "queued" : "running",
    title: input.id,
    workspace: baseDir,
    created_at: "2026-05-06T00:00:00.000Z",
    started_at: "2026-05-06T00:01:00.000Z",
    updated_at: input.updatedAt,
  });
  if (input.status === "succeeded") {
    await ledger.terminal(input.id, {
      status: "succeeded",
      updated_at: input.updatedAt,
      completed_at: input.updatedAt,
      summary: "previous run completed",
    });
  }
}

async function runAgentLoop(input: {
  baseDir: string;
  message: string;
  model: ScriptedProtocolModel;
  runtimeControlService?: RuntimeControlService;
}) {
  const stateManager = new StateManager(input.baseDir, undefined, { walEnabled: false });
  await stateManager.init();
  const { router, runtime } = makeToolStack(stateManager, input.runtimeControlService);
  const modelInfo = await input.model.getModelInfo();
  return new BoundedAgentLoopRunner({
    modelClient: input.model,
    toolRouter: router,
    toolRuntime: runtime,
  }).run({
    session: createAgentLoopSession(),
    turnId: "turn-runtime-tools",
    goalId: "chat",
    cwd: input.baseDir,
    model: modelInfo.ref,
    modelInfo,
    messages: [{ role: "user", content: input.message }],
    outputSchema: z.string(),
    finalOutputMode: "display_text",
    budget: withDefaultBudget({ maxModelTurns: 3, maxToolCalls: 3 }),
    toolPolicy: {
      allowedTools: ["runs_observe", "run_pause", "run_resume", "run_cancel"],
    },
    toolCallContext: {
      cwd: input.baseDir,
      goalId: "chat",
      trustBalance: 0,
      preApproved: true,
      approvalFn: vi.fn().mockResolvedValue(true),
      runtimeControlAllowed: true,
      runtimeControlApprovalMode: "preapproved",
    },
  });
}

const tempDirs: string[] = [];

function trackedTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-runtime-caller-path-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
  vi.restoreAllMocks();
});

describe("runtime tools through the AgentLoop caller path", () => {
  it.each([
    "What runtime run is active right now?",
    "いま動いているruntime runを確認して",
  ])("answers a natural-language runtime question through runs_observe: %s", async (message) => {
    const baseDir = trackedTempDir();
    const stateManager = new StateManager(baseDir, undefined, { walEnabled: false });
    await stateManager.init();
    await createRunningRun(baseDir, {
      id: "run:coreloop:active-caller-path",
      updatedAt: "2026-05-06T00:02:00.000Z",
    });
    const modelInfo = makeModelInfo();
    const model = new ScriptedProtocolModel(modelInfo, [
      {
        assistant: [],
        toolCalls: [{ id: "call-observe", name: "runs_observe", input: { scope: "all", activeOnly: true } }],
        responseItems: [functionToolCallResponseItem({ id: "call-observe", name: "runs_observe", input: { scope: "all", activeOnly: true } })],
        stopReason: "tool_use",
        responseCompleted: true,
      },
      {
        assistant: [{ content: "Observed run: run:coreloop:active-caller-path.", phase: "final_answer" }],
        toolCalls: [],
        responseItems: [assistantTextResponseItem("Observed run: run:coreloop:active-caller-path.", "final_answer")],
        stopReason: "end_turn",
        responseCompleted: true,
      },
    ]);

    const { router, runtime } = makeToolStack(stateManager);
    const result = await new BoundedAgentLoopRunner({
      modelClient: model,
      toolRouter: router,
      toolRuntime: runtime,
    }).run({
      session: createAgentLoopSession(),
      turnId: "turn-runtime-observe",
      goalId: "chat",
      cwd: baseDir,
      model: modelInfo.ref,
      modelInfo,
      messages: [{ role: "user", content: message }],
      outputSchema: z.string(),
      finalOutputMode: "display_text",
      budget: withDefaultBudget({ maxModelTurns: 3, maxToolCalls: 2 }),
      toolPolicy: { allowedTools: ["runs_observe"] },
      toolCallContext: {
        cwd: baseDir,
        goalId: "chat",
        trustBalance: 0,
        preApproved: true,
        approvalFn: vi.fn().mockResolvedValue(true),
      },
    });

    expect(result.success).toBe(true);
    expect(model.calls[0].messages.at(-1)).toMatchObject({ role: "user", content: message });
    expect(model.calls[0].tools.map((tool) => tool.function.name)).toContain("runs_observe");
    expect(result.toolResults?.[0]).toMatchObject({
      toolName: "runs_observe",
      success: true,
    });
    expect(result.toolResults?.[0]?.outputSummary).toContain("run:coreloop:active-caller-path");
    expect(model.calls[1].messages.at(-1)?.content).toContain("2026-05-06T00:02:00.000Z");
  });

  it("rejects a stale previous run target through the real tool caller path", async () => {
    const baseDir = trackedTempDir();
    const stateManager = new StateManager(baseDir, undefined, { walEnabled: false });
    await stateManager.init();
    await createRunningRun(baseDir, {
      id: "run:coreloop:previous-target",
      status: "succeeded",
      updatedAt: "2026-05-06T00:02:00.000Z",
      goalId: "goal-previous",
    });
    await createRunningRun(baseDir, {
      id: "run:coreloop:current-target",
      updatedAt: "2026-05-06T00:05:00.000Z",
      goalId: "goal-current",
    });
    const executor = vi.fn().mockResolvedValue({
      ok: true,
      state: "running",
      message: "pause queued",
    });
    const runtimeControlService = new RuntimeControlService({
      operationStore: new RuntimeOperationStore(path.join(baseDir, "runtime")),
      stateManager,
      executor,
    });
    const modelInfo = makeModelInfo();
    const model = new ScriptedProtocolModel(modelInfo, [
      {
        assistant: [],
        toolCalls: [{
          id: "call-pause-previous",
          name: "run_pause",
          input: {
            run_id: "run:coreloop:previous-target",
            observed_run_epoch: "2026-05-06T00:02:00.000Z",
            reason: "pause the previously observed run",
          },
        }],
        responseItems: [functionToolCallResponseItem({
          id: "call-pause-previous",
          name: "run_pause",
          input: {
            run_id: "run:coreloop:previous-target",
            observed_run_epoch: "2026-05-06T00:02:00.000Z",
            reason: "pause the previously observed run",
          },
        })],
        stopReason: "tool_use",
        responseCompleted: true,
      },
      {
        assistant: [{ content: "The stale previous run was rejected.", phase: "final_answer" }],
        toolCalls: [],
        responseItems: [assistantTextResponseItem("The stale previous run was rejected.", "final_answer")],
        stopReason: "end_turn",
        responseCompleted: true,
      },
    ]);

    const result = await runAgentLoop({
      baseDir,
      message: "さっきのrunをpauseして",
      model,
      runtimeControlService,
    });

    expect(result.success).toBe(true);
    expect(result.toolResults?.[0]).toMatchObject({
      toolName: "run_pause",
      success: false,
    });
    expect(result.toolResults?.[0]?.outputSummary).toContain("stale or terminal");
    expect(executor).not.toHaveBeenCalled();
  });

  it("resumes an approval-gated tool from the stored wait plan through the AgentLoop caller path", async () => {
    const baseDir = trackedTempDir();
    const waitPlanStore = new PermissionWaitPlanStore(path.join(baseDir, "runtime"));
    const registry = new ToolRegistry();
    registry.register(createApprovalRequiredTool());
    const router = new ToolRegistryAgentLoopToolRouter(registry);
    const runtime = new ToolExecutorAgentLoopToolRuntime(new ToolExecutor({
      registry,
      permissionManager: new ToolPermissionManager({}),
      concurrency: new ConcurrencyController(),
    }), router);
    const modelInfo = makeModelInfo();
    const model = new ScriptedProtocolModel(modelInfo, [
      {
        assistant: [],
        toolCalls: [{ id: "call-write-wait", name: "write_wait_tool", input: { value: "ship" } }],
        responseItems: [functionToolCallResponseItem({ id: "call-write-wait", name: "write_wait_tool", input: { value: "ship" } })],
        stopReason: "tool_use",
        responseCompleted: true,
      },
      {
        assistant: [{ content: "The approved stored plan executed.", phase: "final_answer" }],
        toolCalls: [],
        responseItems: [assistantTextResponseItem("The approved stored plan executed.", "final_answer")],
        stopReason: "end_turn",
        responseCompleted: true,
      },
    ]);
    const approvals: string[] = [];

    const result = await new BoundedAgentLoopRunner({
      modelClient: model,
      toolRouter: router,
      toolRuntime: runtime,
    }).run({
      session: createAgentLoopSession(),
      turnId: "turn-wait-plan",
      goalId: "chat",
      cwd: baseDir,
      model: modelInfo.ref,
      modelInfo,
      messages: [{ role: "user", content: "write the approved value" }],
      outputSchema: z.string(),
      finalOutputMode: "display_text",
      budget: withDefaultBudget({ maxModelTurns: 3, maxToolCalls: 2 }),
      toolPolicy: { allowedTools: ["write_wait_tool"] },
      toolCallContext: {
        cwd: baseDir,
        goalId: "chat",
        trustBalance: 0,
        preApproved: true,
        approvalFn: vi.fn().mockImplementation(async (request) => {
          approvals.push(request.permissionWaitPlanId ?? "");
          return true;
        }),
        executionPolicy: {
          executionProfile: "consumer",
          sandboxMode: "workspace_write",
          approvalPolicy: "on_request",
          networkAccess: true,
          workspaceRoot: baseDir,
          protectedPaths: [],
          trustProjectInstructions: true,
        },
        sessionId: "session-wait-plan",
        runId: "run-wait-plan",
        turnId: "turn-wait-plan",
        permissionWaitPlanStore: waitPlanStore,
      },
    });

    expect(result.success).toBe(true);
    expect(result.toolResults?.[0]).toMatchObject({
      toolName: "write_wait_tool",
      success: true,
      execution: { status: "executed" },
    });
    expect(approvals).toHaveLength(1);
    expect(await waitPlanStore.load(approvals[0])).toMatchObject({
      state: "resumed",
      canonical_plan: {
        tool_name: "write_wait_tool",
        input: { value: "ship" },
        target: expect.objectContaining({
          goal_id: "chat",
          session_id: expect.any(String),
          run_id: "run-wait-plan",
          turn_id: "turn-wait-plan",
          tool_call_id: "call-write-wait",
        }),
      },
    });
  });
});
