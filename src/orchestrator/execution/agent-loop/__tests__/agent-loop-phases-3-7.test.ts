import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { z } from "zod/v3";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { makeTempDir } from "../../../../../tests/helpers/temp-dir.js";
import { createGroundingGateway } from "../../../../grounding/gateway.js";
import { SqliteSoilRepository } from "../../../../platform/soil/sqlite-repository.js";
import { ToolRegistry } from "../../../../tools/registry.js";
import { ToolExecutor } from "../../../../tools/executor.js";
import { ToolPermissionManager } from "../../../../tools/permission.js";
import { ConcurrencyController } from "../../../../tools/concurrency.js";
import { ApplyPatchTool } from "../../../../tools/fs/ApplyPatchTool/ApplyPatchTool.js";
import { ViewImageTool } from "../../../../tools/media/ViewImageTool/ViewImageTool.js";
import { ShellCommandTool } from "../../../../tools/system/ShellCommandTool/ShellCommandTool.js";
import { UpdatePlanTool } from "../../../../tools/system/UpdatePlanTool/UpdatePlanTool.js";
import type { ITool, PermissionCheckResult, ToolCallContext, ToolResult } from "../../../../tools/types.js";
import type { Task } from "../../../../base/types/task.js";
import {
  AgentLoopContextAssembler,
  BoundedAgentLoopRunner,
  ChatAgentLoopRunner,
  CorePhaseRunner,
  ExtractiveAgentLoopCompactor,
  NoopAgentLoopCompactor,
  StaticAgentLoopModelRegistry,
  ToolExecutorAgentLoopToolRuntime,
  ToolRegistryAgentLoopToolRouter,
  createAgentLoopHistory,
  createAgentLoopSession,
  createDaemonBackedCoreLoopControlToolset,
  createCoreLoopControlTools,
  defaultAgentLoopCapabilities,
  type AgentLoopModelClient,
  type AgentLoopModelInfo,
  type AgentLoopModelRequest,
  type AgentLoopModelResponse,
} from "../index.js";
import { SqliteAgentLoopSessionStateStore } from "../agent-loop-session-db-store.js";
import { defaultExecutionPolicy } from "../execution-policy.js";

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

function makeModelInfo(): AgentLoopModelInfo {
  return {
    ref: { providerId: "test", modelId: "model" },
    displayName: "test/model",
    capabilities: { ...defaultAgentLoopCapabilities },
  };
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

function makeRuntime(registry: ToolRegistry) {
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

class ApprovalTool implements ITool<{ value: string }> {
  readonly metadata = {
    name: "approval_tool",
    aliases: [],
    permissionLevel: "write_remote" as const,
    isReadOnly: false,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 0,
    maxOutputChars: 8000,
    tags: ["test"],
  };
  readonly inputSchema = z.object({ value: z.string() });

  description(): string {
    return "Tool that requires approval.";
  }

  async call(input: { value: string }, _context: ToolCallContext): Promise<ToolResult> {
    return {
      success: true,
      data: { approved: input.value },
      summary: `approved ${input.value}`,
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

describe("agentloop phase 3 tools", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = makeTempDir();
    await fsp.writeFile(path.join(tmpDir, "file.txt"), "old\n", "utf-8");
    await run("git", ["init"], tmpDir);
    await run("git", ["config", "user.email", "test@example.com"], tmpDir);
    await run("git", ["config", "user.name", "Test"], tmpDir);
    await run("git", ["add", "file.txt"], tmpDir);
    await run("git", ["commit", "-m", "init"], tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("updates plans, runs shell_command, applies patches, and registers image artifacts", async () => {
    const registry = new ToolRegistry();
    registry.register(new UpdatePlanTool());
    registry.register(new ShellCommandTool());
    registry.register(new ApplyPatchTool());
    registry.register(new ViewImageTool());
    const executor = new ToolExecutor({
      registry,
      permissionManager: new ToolPermissionManager({}),
      concurrency: new ConcurrencyController(),
    });
    const context = {
      cwd: tmpDir,
      goalId: "goal-1",
      trustBalance: 100,
      preApproved: true,
      trusted: true,
      approvalFn: async () => true,
    };

    const plan = await executor.execute("update_plan", { steps: [{ step: "edit", status: "in_progress" }] }, context);
    expect(plan.success).toBe(true);

    const shell = await executor.execute("shell_command", { command: "pwd", cwd: tmpDir }, context);
    expect(shell.success).toBe(true);

    const patch = [
      "diff --git a/file.txt b/file.txt",
      "index 3367afd..3e75765 100644",
      "--- a/file.txt",
      "+++ b/file.txt",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n");
    const applied = await executor.execute("apply_patch", { patch, cwd: tmpDir }, context);
    expect(applied.success).toBe(true);
    expect(await fsp.readFile(path.join(tmpDir, "file.txt"), "utf-8")).toBe("new\n");

    const imagePath = path.join(tmpDir, "image.png");
    await fsp.writeFile(imagePath, "not really png");
    const image = await executor.execute("view_image", { path: imagePath }, context);
    expect(image.success).toBe(true);
    expect(image.artifacts).toEqual([imagePath]);
  });

  it("blocks production agent-loop file mutations inside protected PulSeed roots in consumer mode", async () => {
    const previousRoots = process.env["PULSEED_SELF_PROTECTION_ROOTS"];
    const previousDev = process.env["PULSEED_DEV"];
    process.env["PULSEED_SELF_PROTECTION_ROOTS"] = tmpDir;
    delete process.env["PULSEED_DEV"];
    try {
      const registry = new ToolRegistry();
      registry.register(new ApplyPatchTool());
      registry.register(new ShellCommandTool());
      const { runtime } = makeRuntime(registry);
      const policy = defaultExecutionPolicy(tmpDir);
      const turn = {
        session: createAgentLoopSession(),
        turnId: "turn-1",
        goalId: "goal-1",
        cwd: tmpDir,
        model: makeModelInfo().ref,
        modelInfo: makeModelInfo(),
        messages: [],
        outputSchema: z.object({}),
        budget: defaultBudgetForTest(),
        toolPolicy: { allowedTools: ["apply_patch", "shell_command"] },
        executionPolicy: policy,
        toolCallContext: {
          cwd: tmpDir,
          goalId: "goal-1",
          trustBalance: 100,
          preApproved: true,
          trusted: true,
          approvalFn: async () => true,
          executionPolicy: policy,
        },
      };

      const outputs = await runtime.executeBatch([
        {
          id: "patch-1",
          name: "apply_patch",
          input: {
            cwd: tmpDir,
            patch: [
              "diff --git a/file.txt b/file.txt",
              "index 3367afd..3e75765 100644",
              "--- a/file.txt",
              "+++ b/file.txt",
              "@@ -1 +1 @@",
              "-old",
              "+blocked",
              "",
            ].join("\n"),
          },
        },
        {
          id: "shell-1",
          name: "shell_command",
          input: { command: "touch consumer-blocked.txt", cwd: tmpDir },
        },
      ], turn);

      expect(outputs[0].success).toBe(false);
      expect(outputs[0].content).toContain("protected");
      expect(outputs[1].success).toBe(false);
      expect(outputs[1].content).toContain("protected PulSeed source root");
      expect(await fsp.readFile(path.join(tmpDir, "file.txt"), "utf-8")).toBe("old\n");
      expect(fs.existsSync(path.join(tmpDir, "consumer-blocked.txt"))).toBe(false);

      const interpreterWrite = await runtime.executeBatch([
        {
          id: "shell-interpreter-1",
          name: "shell_command",
          input: { command: "node -e \"require('fs').writeFileSync('interpreter-blocked.txt','x')\"", cwd: tmpDir },
        },
      ], turn);
      expect(interpreterWrite[0].success).toBe(false);
      expect(interpreterWrite[0].content).toContain("protected PulSeed source root");
      expect(fs.existsSync(path.join(tmpDir, "interpreter-blocked.txt"))).toBe(false);

      const outsideDir = makeTempDir();
      try {
        const outsideOutput = await runtime.executeBatch([
          {
            id: "shell-absolute-1",
            name: "shell_command",
            input: { command: `touch ${path.join(tmpDir, "absolute-blocked.txt")}`, cwd: outsideDir },
          },
        ], turn);
        expect(outsideOutput[0].success).toBe(false);
        expect(outsideOutput[0].content).toContain("cwd escapes workspace root");
        expect(fs.existsSync(path.join(tmpDir, "absolute-blocked.txt"))).toBe(false);
      } finally {
        fs.rmSync(outsideDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }

      const deletePatch = [
        "diff --git a/file.txt b/file.txt",
        "deleted file mode 100644",
        "index 3367afd..0000000",
        "--- a/file.txt",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-old",
        "",
      ].join("\n");
      const deleteOutput = await runtime.executeBatch([
        { id: "patch-delete-1", name: "apply_patch", input: { patch: deletePatch, cwd: tmpDir } },
      ], turn);
      expect(deleteOutput[0].success).toBe(false);
      expect(deleteOutput[0].content).toContain("protected");
      expect(fs.existsSync(path.join(tmpDir, "file.txt"))).toBe(true);
    } finally {
      if (previousRoots === undefined) delete process.env["PULSEED_SELF_PROTECTION_ROOTS"];
      else process.env["PULSEED_SELF_PROTECTION_ROOTS"] = previousRoots;
      if (previousDev === undefined) delete process.env["PULSEED_DEV"];
      else process.env["PULSEED_DEV"] = previousDev;
    }
  });

  it("allows the same protected root mutation when dev mode is explicitly enabled", async () => {
    const previousRoots = process.env["PULSEED_SELF_PROTECTION_ROOTS"];
    const previousDev = process.env["PULSEED_DEV"];
    process.env["PULSEED_SELF_PROTECTION_ROOTS"] = tmpDir;
    process.env["PULSEED_DEV"] = "1";
    try {
      const registry = new ToolRegistry();
      registry.register(new ApplyPatchTool());
      const { runtime } = makeRuntime(registry);
      const policy = defaultExecutionPolicy(tmpDir);
      const turn = {
        session: createAgentLoopSession(),
        turnId: "turn-1",
        goalId: "goal-1",
        cwd: tmpDir,
        model: makeModelInfo().ref,
        modelInfo: makeModelInfo(),
        messages: [],
        outputSchema: z.object({}),
        budget: defaultBudgetForTest(),
        toolPolicy: { allowedTools: ["apply_patch"] },
        executionPolicy: policy,
        toolCallContext: {
          cwd: tmpDir,
          goalId: "goal-1",
          trustBalance: 100,
          preApproved: true,
          trusted: true,
          approvalFn: async () => true,
          executionPolicy: policy,
        },
      };

      const outputs = await runtime.executeBatch([
        {
          id: "patch-1",
          name: "apply_patch",
          input: {
            cwd: tmpDir,
            patch: [
              "diff --git a/file.txt b/file.txt",
              "index 3367afd..3e75765 100644",
              "--- a/file.txt",
              "+++ b/file.txt",
              "@@ -1 +1 @@",
              "-old",
              "+dev",
              "",
            ].join("\n"),
          },
        },
      ], turn);

      expect(policy.executionProfile).toBe("dev");
      expect(policy.protectedPaths).toEqual([]);
      expect(outputs[0].success).toBe(true);
      expect(await fsp.readFile(path.join(tmpDir, "file.txt"), "utf-8")).toBe("dev\n");
    } finally {
      if (previousRoots === undefined) delete process.env["PULSEED_SELF_PROTECTION_ROOTS"];
      else process.env["PULSEED_SELF_PROTECTION_ROOTS"] = previousRoots;
      if (previousDev === undefined) delete process.env["PULSEED_DEV"];
      else process.env["PULSEED_DEV"] = previousDev;
    }
  });
});

describe("agentloop phase 4 context injection", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = makeTempDir();
    await fsp.mkdir(path.join(tmpDir, ".git"));
    await fsp.writeFile(path.join(tmpDir, "AGENTS.md"), "Root instruction", "utf-8");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("loads project instructions and injects canonical Soil knowledge blocks", async () => {
    const rootDir = path.join(tmpDir, "soil");
    const repository = await SqliteSoilRepository.create({ rootDir });
    try {
      await repository.applyMutation({
        records: [{
          record_id: "rec-agentloop-soil",
          record_key: "fact.agentloop-soil",
          version: 1,
          record_type: "fact",
          soil_id: "knowledge/agentloop-soil",
          title: "Agent loop Soil result",
          summary: "Soil result for agent-loop grounding",
          canonical_text: "test task test approach done Workspace block Soil result for agent-loop grounding",
          goal_id: null,
          task_id: null,
          status: "active",
          confidence: 0.9,
          importance: 0.7,
          source_reliability: 0.8,
          valid_from: null,
          valid_to: null,
          supersedes_record_id: null,
          is_active: true,
          source_type: "test",
          source_id: "agentloop-soil-source",
          metadata_json: {},
          created_at: "2026-05-02T00:00:00.000Z",
          updated_at: "2026-05-02T00:00:00.000Z",
        }],
        chunks: [{
          chunk_id: "chunk-agentloop-soil",
          record_id: "rec-agentloop-soil",
          soil_id: "knowledge/agentloop-soil",
          chunk_index: 0,
          chunk_kind: "paragraph",
          heading_path_json: ["Knowledge"],
          chunk_text: "test task test approach done Workspace block Soil result for agent-loop grounding",
          token_count: 8,
          checksum: "agentloop-soil-chunk",
          created_at: "2026-05-02T00:00:00.000Z",
        }],
        pages: [{
          page_id: "page-agentloop-soil",
          soil_id: "knowledge/agentloop-soil",
          relative_path: "knowledge/agentloop-soil.md",
          route: "knowledge",
          kind: "knowledge",
          status: "confirmed",
          markdown: "# Agent loop Soil result\n\ntest task test approach done Workspace block Soil result for agent-loop grounding",
          checksum: "agentloop-soil-page",
          projected_at: "2026-05-02T00:00:00.000Z",
        }],
        page_members: [{
          page_id: "page-agentloop-soil",
          record_id: "rec-agentloop-soil",
          ordinal: 0,
          role: "primary",
          confidence: 0.9,
        }],
      });
    } finally {
      repository.close();
    }
    const assembler = new AgentLoopContextAssembler(createGroundingGateway({
      stateManager: {
        getBaseDir: () => tmpDir,
        listGoalIds: async () => [],
        listTasks: async () => [],
        readRaw: async () => null,
        loadGapHistory: async () => [],
      } as never,
    }));
    const assembled = await assembler.assembleTask({
      task: makeTask(),
      cwd: tmpDir,
      workspaceContext: "Workspace block",
    });

    expect(assembled.userPrompt).toContain("Root instruction");
    expect(assembled.userPrompt).toContain("Workspace block");
    expect(assembled.userPrompt).toContain("Soil result");
    expect(assembled.contextBlocks.map((b) => b.id)).toContain("soil-knowledge");
  });
});

describe("agentloop phase 5 compaction", () => {
  it("NoopAgentLoopCompactor preserves history", async () => {
    const history = createAgentLoopHistory([{ role: "user", content: "hello" }]);
    const result = await new NoopAgentLoopCompactor().compact({ history });
    expect(result.compacted).toBe(false);
    expect(result.history.messages).toEqual(history.messages);
  });

  it("pre-turn auto compaction replaces long history before sampling", async () => {
    const modelInfo = makeModelInfo();
    const modelClient = new ScriptedModelClient(modelInfo, [
      { content: JSON.stringify({ status: "done", message: "compacted", evidence: [], blockers: [] }), toolCalls: [], stopReason: "end_turn" },
    ]);
    const registry = new ToolRegistry();
    const { router, runtime } = makeRuntime(registry);
    const runner = new BoundedAgentLoopRunner({
      modelClient,
      toolRouter: router,
      toolRuntime: runtime,
      compactor: new ExtractiveAgentLoopCompactor(),
    });
    const session = createAgentLoopSession();

    const result = await runner.run({
      session,
      turnId: "turn-1",
      goalId: "goal-1",
      cwd: process.cwd(),
      model: modelInfo.ref,
      modelInfo,
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "one ".repeat(120) },
        {
          role: "assistant",
          content: "observe stale run",
          phase: "commentary",
          toolCalls: [{ id: "stale-call", name: "run_observe", input: { runId: "run-stale" } }],
        },
        {
          role: "tool",
          toolCallId: "stale-call",
          toolName: "run_observe",
          content: "stale run finished",
          observation: {
            type: "tool_observation",
            callId: "stale-call",
            toolName: "run_observe",
            arguments: { runId: "run-stale" },
            state: "success",
            success: true,
            durationMs: 1,
            output: { content: "stale run finished", data: { runId: "run-stale" } },
          },
        },
        {
          role: "assistant",
          content: "needs operator approval",
          phase: "commentary",
          toolCalls: [{ id: "denied-call", name: "shell_command", input: { command: "rm -rf tmp" } }],
        },
        {
          role: "tool",
          toolCallId: "denied-call",
          toolName: "shell_command",
          content: "approval denied",
          observation: {
            type: "tool_observation",
            callId: "denied-call",
            toolName: "shell_command",
            arguments: { command: "rm -rf tmp" },
            state: "denied",
            success: false,
            execution: { status: "not_executed", reason: "approval_denied", message: "operator denied" },
            durationMs: 1,
            output: { content: "approval denied", error: "approval denied" },
          },
        },
        {
          role: "assistant",
          content: "observe retained current run",
          phase: "commentary",
          toolCalls: [{ id: "active-call", name: "run_observe", input: { runId: "run-current" } }],
        },
        { role: "user", content: "latest request" },
      ],
      outputSchema: z.object({ status: z.literal("done"), message: z.string(), evidence: z.array(z.string()), blockers: z.array(z.string()) }),
      budget: { ...defaultBudgetForTest(), autoCompactTokenLimit: 10, compactionMaxMessages: 4 },
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
    expect(result.compactions).toBe(1);
    const summaryMessage = modelClient.calls[0].messages.find((m) => m.content.includes("Summary of earlier agentloop context"));
    expect(summaryMessage?.content).toContain("Pending permissions");
    expect(summaryMessage?.content).toContain("Archived stale targets");
    expect(summaryMessage?.content).toContain("Retained active targets");
    expect(modelClient.calls[0].messages.length).toBeLessThan(6);
    const state = await session.stateStore.load();
    const record = state?.compactionRecords?.[0];
    expect(record?.pendingPermissions).toEqual([
      expect.objectContaining({
        toolName: "shell_command",
        execution: expect.objectContaining({ status: "not_executed", reason: "approval_denied" }),
      }),
    ]);
    expect(record?.archivedTargets).toEqual(expect.arrayContaining([
      expect.objectContaining({ state: "archived", toolName: "run_observe", callId: "stale-call" }),
    ]));
    expect(record?.activeTargets).toEqual(expect.arrayContaining([
      expect.objectContaining({ state: "retained", toolName: "run_observe", callId: "active-call" }),
    ]));
    expect(record?.activeTargets).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ callId: "stale-call" }),
    ]));
    expect(record?.replacementHistory.retainedIndexes).toEqual([6, 7]);
  });

  it("mid-turn auto compaction continues after tool output when usage crosses the limit", async () => {
    const modelInfo = makeModelInfo();
    const modelClient = new ScriptedModelClient(modelInfo, [
      {
        content: "",
        toolCalls: [{ id: "call-1", name: "update_plan", input: { steps: [{ step: "work", status: "completed" }] } }],
        stopReason: "tool_use",
        usage: { inputTokens: 100, outputTokens: 100 },
      },
      { content: JSON.stringify({ status: "done", message: "continued", evidence: ["compact"], blockers: [] }), toolCalls: [], stopReason: "end_turn" },
    ]);
    const registry = new ToolRegistry();
    registry.register(new UpdatePlanTool());
    const { router, runtime } = makeRuntime(registry);
    const runner = new BoundedAgentLoopRunner({
      modelClient,
      toolRouter: router,
      toolRuntime: runtime,
      compactor: new ExtractiveAgentLoopCompactor(),
    });

    const result = await runner.run({
      session: createAgentLoopSession(),
      turnId: "turn-1",
      goalId: "goal-1",
      cwd: process.cwd(),
      model: modelInfo.ref,
      modelInfo,
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "one" },
        { role: "assistant", content: "two" },
        { role: "user", content: "three" },
        { role: "assistant", content: "four" },
        { role: "user", content: "do it" },
      ],
      outputSchema: z.object({ status: z.literal("done"), message: z.string(), evidence: z.array(z.string()), blockers: z.array(z.string()) }),
      budget: { ...defaultBudgetForTest(), autoCompactTokenLimit: 50, compactionMaxMessages: 4 },
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
    expect(result.compactions).toBe(1);
    expect(modelClient.calls[1].messages.some((m) => m.role === "tool" && m.toolName === "update_plan")).toBe(true);
    expect(modelClient.calls[1].messages.some((m) => m.content.includes("Summary of earlier agentloop context"))).toBe(true);
  });

  it("resumes from persisted compacted state after an interrupted turn", async () => {
    const stateDir = makeTempDir();
    const stateStore = new SqliteAgentLoopSessionStateStore(stateDir, "session-1", "chat");
    const modelInfo = makeModelInfo();
    const registry = new ToolRegistry();
    registry.register(new UpdatePlanTool());
    const { router, runtime } = makeRuntime(registry);

    const firstModelClient = new ScriptedModelClient(modelInfo, [
      {
        content: "",
        toolCalls: [{ id: "call-1", name: "update_plan", input: { steps: [{ step: "verify", status: "completed" }] } }],
        stopReason: "tool_use",
        usage: { inputTokens: 100, outputTokens: 100 },
      },
    ]);
    const firstRunner = new BoundedAgentLoopRunner({
      modelClient: firstModelClient,
      toolRouter: router,
      toolRuntime: runtime,
      compactor: new ExtractiveAgentLoopCompactor(),
    });

    const first = await firstRunner.run({
      session: createAgentLoopSession({
        sessionId: "session-1",
        traceId: "trace-1",
        stateStore,
      }),
      turnId: "turn-1",
      goalId: "goal-1",
      cwd: process.cwd(),
      model: modelInfo.ref,
      modelInfo,
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "one ".repeat(120) },
        { role: "assistant", content: "two ".repeat(120) },
        { role: "user", content: "three ".repeat(120) },
        { role: "user", content: "continue after resume" },
      ],
      outputSchema: z.object({ status: z.literal("done"), message: z.string(), evidence: z.array(z.string()), blockers: z.array(z.string()) }),
      budget: { ...defaultBudgetForTest(), maxToolCalls: 1, autoCompactTokenLimit: 50, compactionMaxMessages: 4 },
      toolPolicy: {},
      toolCallContext: {
        cwd: process.cwd(),
        goalId: "goal-1",
        trustBalance: 0,
        preApproved: true,
        approvalFn: async () => false,
      },
    });

    expect(first.success).toBe(false);
    expect(first.stopReason).toBe("max_tool_calls");
    expect(first.compactions).toBeGreaterThanOrEqual(1);
    const persistedAfterFirst = await stateStore.load();
    if (!persistedAfterFirst) throw new Error("expected persisted AgentLoop session state");
    expect(persistedAfterFirst.compactionRecords?.[0]).toMatchObject({
      schemaVersion: "agent-loop-compaction-record-v1",
      replacementHistory: {
        summarizedIndexes: expect.arrayContaining([1, 2]),
        retainedIndexes: expect.arrayContaining([3, 4]),
      },
    });
    expect(persistedAfterFirst.compactionRecords?.[0]?.modelVisibleSummary).toContain("User messages");

    const secondModelClient = new ScriptedModelClient(modelInfo, [
      { content: JSON.stringify({ status: "done", message: "resumed", evidence: ["plan update"], blockers: [] }), toolCalls: [], stopReason: "end_turn" },
    ]);
    const secondRunner = new BoundedAgentLoopRunner({
      modelClient: secondModelClient,
      toolRouter: router,
      toolRuntime: runtime,
      compactor: new ExtractiveAgentLoopCompactor(),
    });

    const second = await secondRunner.run({
      session: createAgentLoopSession({
        sessionId: "session-1",
        traceId: "trace-1",
        stateStore,
      }),
      turnId: "turn-1",
      goalId: "goal-1",
      cwd: process.cwd(),
      model: modelInfo.ref,
      modelInfo,
      messages: [{ role: "user", content: "fresh prompt should be replaced by persisted state" }],
      outputSchema: z.object({ status: z.literal("done"), message: z.string(), evidence: z.array(z.string()), blockers: z.array(z.string()) }),
      budget: { ...defaultBudgetForTest(), autoCompactTokenLimit: 50, compactionMaxMessages: 4 },
      toolPolicy: {},
      toolCallContext: {
        cwd: process.cwd(),
        goalId: "goal-1",
        trustBalance: 0,
        preApproved: true,
        approvalFn: async () => false,
      },
    });

    expect(second.success).toBe(true);
    expect(second.compactions).toBeGreaterThanOrEqual(first.compactions);
    expect(secondModelClient.calls[0].messages.some((m) => m.content.includes("Summary of earlier agentloop context"))).toBe(true);
    expect(secondModelClient.calls[0].messages.some((m) => m.role === "tool" && m.toolName === "update_plan")).toBe(true);
    const resumedState = await stateStore.load();
    expect(resumedState?.compactionRecords?.[0]?.modelVisibleSummary).toContain("Replacement history");
  });
});

describe("agentloop phase 6 CorePhaseRunner", () => {
  it("runs schema-validated core phase evidence through the bounded runner", async () => {
    const modelInfo = makeModelInfo();
    const modelClient = new ScriptedModelClient(modelInfo, [
      { content: JSON.stringify({ confidence: 0.2, evidence: ["premature"] }), toolCalls: [], stopReason: "end_turn" },
      {
        content: "",
        toolCalls: [{ id: "call-1", name: "update_plan", input: { steps: [{ step: "verify", status: "completed" }] } }],
        stopReason: "tool_use",
      },
      { content: JSON.stringify({ confidence: 0.9, evidence: ["ok"] }), toolCalls: [], stopReason: "end_turn" },
    ]);
    const registry = new ToolRegistry();
    registry.register(new UpdatePlanTool());
    const { router, runtime } = makeRuntime(registry);
    const runner = new CorePhaseRunner({
      boundedRunner: new BoundedAgentLoopRunner({ modelClient, toolRouter: router, toolRuntime: runtime }),
      model: modelInfo.ref,
      modelInfo,
      cwd: process.cwd(),
    });

    const result = await runner.run(
      {
        phase: "verification_evidence",
        inputSchema: z.object({ taskId: z.string() }),
        outputSchema: z.object({ confidence: z.number(), evidence: z.array(z.string()) }),
        requiredTools: ["update_plan"],
        allowedTools: [],
        failPolicy: "fail_cycle",
      },
      { taskId: "task-1" },
      { goalId: "goal-1", taskId: "task-1" },
    );

    expect(result.success).toBe(true);
    expect(result.output?.confidence).toBe(0.9);
    expect(modelClient.calls[1].messages.some((m) => m.content.includes("required tool"))).toBe(true);
  });

  it("runs core phase model calls with read-only sandbox posture", async () => {
    const modelInfo = makeModelInfo();
    const modelClient = new ScriptedModelClient(modelInfo, [
      { content: JSON.stringify({ confidence: 0.9, evidence: ["ok"] }), toolCalls: [], stopReason: "end_turn" },
    ]);
    const registry = new ToolRegistry();
    const { router, runtime } = makeRuntime(registry);
    const runner = new CorePhaseRunner({
      boundedRunner: new BoundedAgentLoopRunner({ modelClient, toolRouter: router, toolRuntime: runtime }),
      model: modelInfo.ref,
      modelInfo,
      cwd: process.cwd(),
    });

    const result = await runner.run(
      {
        phase: "observe_evidence",
        inputSchema: z.object({ goalId: z.string() }),
        outputSchema: z.object({ confidence: z.number(), evidence: z.array(z.string()) }),
        requiredTools: [],
        allowedTools: [],
        failPolicy: "fallback_deterministic",
      },
      { goalId: "goal-1" },
      { goalId: "goal-1" },
    );

    expect(result.success).toBe(true);
    expect(modelClient.calls[0]?.sandboxMode).toBe("read_only");
    expect(result.executionPolicy?.sandboxMode).toBe("read_only");
  });
});

describe("agentloop phase 7 ChatAgentLoopRunner and CoreLoopControlTools", () => {
  it("accepts plain final markdown in default display text chat mode", async () => {
    const modelInfo = makeModelInfo();
    const modelClient = new ScriptedModelClient(modelInfo, [
      {
        content: "Plain **Markdown** answer.",
        toolCalls: [],
        stopReason: "end_turn",
      },
    ]);
    const registry = new ToolRegistry();
    const { router, runtime } = makeRuntime(registry);
    const registryModel = new StaticAgentLoopModelRegistry([modelInfo]);
    const chat = new ChatAgentLoopRunner({
      boundedRunner: new BoundedAgentLoopRunner({ modelClient, toolRouter: router, toolRuntime: runtime }),
      modelClient,
      modelRegistry: registryModel,
      defaultModel: modelInfo.ref,
    });

    const result = await chat.execute({ message: "answer plainly" });

    expect(result.success).toBe(true);
    expect(result.output).toBe("Plain **Markdown** answer.");
    expect(result.structuredOutput).toBeUndefined();
    expect(modelClient.calls).toHaveLength(1);
  });

  it("repairs empty final text before completing default display text chat mode", async () => {
    const modelInfo = makeModelInfo();
    const modelClient = new ScriptedModelClient(modelInfo, [
      {
        content: "   ",
        toolCalls: [],
        stopReason: "end_turn",
      },
      {
        content: "Recovered answer.",
        toolCalls: [],
        stopReason: "end_turn",
      },
    ]);
    const registry = new ToolRegistry();
    const { router, runtime } = makeRuntime(registry);
    const registryModel = new StaticAgentLoopModelRegistry([modelInfo]);
    const chat = new ChatAgentLoopRunner({
      boundedRunner: new BoundedAgentLoopRunner({ modelClient, toolRouter: router, toolRuntime: runtime }),
      modelClient,
      modelRegistry: registryModel,
      defaultModel: modelInfo.ref,
    });

    const result = await chat.execute({
      message: "answer plainly",
      budget: { maxSchemaRepairAttempts: 1 },
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe("Recovered answer.");
    expect(modelClient.calls).toHaveLength(2);
    expect(modelClient.calls[1].messages.some((m) => m.content.includes("final answer was empty"))).toBe(true);
  });

  it("uses schema repair and structuredOutput only for explicit structured chat mode", async () => {
    const modelInfo = makeModelInfo();
    const modelClient = new ScriptedModelClient(modelInfo, [
      {
        content: "Plain text is invalid for this structured turn.",
        toolCalls: [],
        stopReason: "end_turn",
      },
      {
        content: JSON.stringify({
          status: "done",
          answer: "Structured answer.",
          payload: { ok: true },
        }),
        toolCalls: [],
        stopReason: "end_turn",
      },
    ]);
    const registry = new ToolRegistry();
    const { router, runtime } = makeRuntime(registry);
    const registryModel = new StaticAgentLoopModelRegistry([modelInfo]);
    const chat = new ChatAgentLoopRunner({
      boundedRunner: new BoundedAgentLoopRunner({ modelClient, toolRouter: router, toolRuntime: runtime }),
      modelClient,
      modelRegistry: registryModel,
      defaultModel: modelInfo.ref,
    });
    const schema = z.object({
      status: z.literal("done"),
      answer: z.string(),
      payload: z.object({ ok: z.boolean() }),
    });

    const result = await chat.execute({
      message: "return structured data",
      outputMode: { kind: "structured", schema },
      budget: { maxSchemaRepairAttempts: 1 },
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe("Structured answer.");
    expect(result.structuredOutput).toEqual({
      status: "done",
      answer: "Structured answer.",
      payload: { ok: true },
    });
    expect(modelClient.calls).toHaveLength(2);
    expect(modelClient.calls[1].messages.some((m) => m.content.includes("required JSON schema"))).toBe(true);
  });

  it("lets chat use CoreLoop control only as tools", async () => {
    const modelInfo = makeModelInfo();
    const modelClient = new ScriptedModelClient(modelInfo, [
      {
        content: "",
        toolCalls: [{ id: "call-1", name: "core_goal_status", input: { goalId: "goal-1" } }],
        stopReason: "tool_use",
      },
      {
        content: JSON.stringify({ status: "done", message: "Goal is running", evidence: ["tool result"], blockers: [] }),
        toolCalls: [],
        stopReason: "end_turn",
      },
    ]);
    const registry = new ToolRegistry();
    for (const tool of createCoreLoopControlTools({
      goalStatus: async (input) => ({ goalId: input.goalId, loopStatus: "running" }),
    })) {
      registry.register(tool);
    }
    const { router, runtime } = makeRuntime(registry);
    const registryModel = new StaticAgentLoopModelRegistry([modelInfo]);
    const chat = new ChatAgentLoopRunner({
      boundedRunner: new BoundedAgentLoopRunner({ modelClient, toolRouter: router, toolRuntime: runtime }),
      modelClient,
      modelRegistry: registryModel,
      defaultModel: modelInfo.ref,
      defaultToolPolicy: { allowedTools: ["core_goal_status"] },
    });

    const result = await chat.execute({ message: "status?", goalId: "goal-1" });

    expect(result.success).toBe(true);
    expect(result.output.startsWith("Goal is running")).toBe(true);
    expect(result.output).toContain("### Evidence");
    expect(modelClient.calls[1].messages.some((m) => m.role === "tool" && m.toolName === "core_goal_status")).toBe(true);
  });

  it("lets chat hand long-running work off to daemon-backed CoreLoop with one tool call", async () => {
    const stateDir = makeTempDir();
    const modelInfo = makeModelInfo();
    const modelClient = new ScriptedModelClient(modelInfo, [
      {
        content: "",
        toolCalls: [{ id: "call-1", name: "core_tend_goal", input: { description: "Improve Kaggle score beyond 0.98" } }],
        stopReason: "tool_use",
      },
      {
        content: JSON.stringify({ status: "done", message: "CoreLoop started", evidence: ["core_tend_goal"], blockers: [] }),
        toolCalls: [],
        stopReason: "end_turn",
      },
    ]);
    let savedGoal: { id: string; title: string } | null = null;
    const startGoal = async (goalId: string, options: unknown) => ({
      ok: true,
      goalId,
      backgroundRunId: (options as { backgroundRun?: { backgroundRunId?: string } }).backgroundRun?.backgroundRunId,
    });
    const stateManager = {
      getBaseDir: () => stateDir,
      saveGoal: async (goal: { id: string; title: string }) => {
        savedGoal = goal;
      },
      loadGoal: async (goalId: string) => savedGoal && savedGoal.id === goalId
        ? { ...savedGoal, status: "active", loop_status: "idle", dimensions: [], updated_at: "now" }
        : null,
      listTasks: async () => [],
      loadTask: async () => null,
    };
    const registry = new ToolRegistry();
    for (const tool of createCoreLoopControlTools(createDaemonBackedCoreLoopControlToolset({
      stateManager: stateManager as never,
      daemonClientFactory: async () => ({
        startGoal,
        stopGoal: async () => ({ ok: true }),
        getSnapshot: async () => ({ active_workers: [] }),
      }) as never,
    }))) {
      registry.register(tool);
    }
    const { router, runtime } = makeRuntime(registry);
    const registryModel = new StaticAgentLoopModelRegistry([modelInfo]);
    const chat = new ChatAgentLoopRunner({
      boundedRunner: new BoundedAgentLoopRunner({ modelClient, toolRouter: router, toolRuntime: runtime }),
      modelClient,
      modelRegistry: registryModel,
      defaultModel: modelInfo.ref,
      defaultToolPolicy: { allowedTools: ["core_tend_goal"] },
    });

    try {
      const result = await chat.execute({ message: "coreloopで0.98を超えるまでやってほしい" });

      expect(result.success).toBe(true);
      expect(result.output.startsWith("CoreLoop started")).toBe(true);
      expect(savedGoal).toMatchObject({ title: "Improve Kaggle score beyond 0.98" });
      expect(modelClient.calls[1].messages.some((m) => m.role === "tool" && m.toolName === "core_tend_goal")).toBe(true);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it("does not register daemon-backed CoreLoop control tools without real handlers", () => {
    const stateManager = {
      getBaseDir: () => "/tmp/pulseed-test",
    };

    const toolNames = createCoreLoopControlTools(createDaemonBackedCoreLoopControlToolset({
      stateManager: stateManager as never,
      daemonClientFactory: async () => ({
        startGoal: async () => ({ ok: true }),
        stopGoal: async () => ({ ok: true }),
        getSnapshot: async () => ({ active_workers: [] }),
      }) as never,
    })).map((tool) => tool.metadata.name);

    expect(toolNames).toEqual(expect.arrayContaining([
      "core_goal_status",
      "core_goal_create",
      "core_tend_goal",
      "core_goal_start",
      "core_goal_pause",
      "core_goal_resume",
      "core_goal_cancel",
      "core_task_status",
    ]));
    expect(toolNames).not.toContain("core_task_prioritize");
    expect(toolNames).not.toContain("core_run_cycle");
  });

  it("emits approval_request and continues when chat approval is granted", async () => {
    const modelInfo = makeModelInfo();
    const modelClient = new ScriptedModelClient(modelInfo, [
      {
        content: "",
        toolCalls: [{ id: "call-1", name: "approval_tool", input: { value: "ship" } }],
        stopReason: "tool_use",
      },
      {
        content: JSON.stringify({ status: "done", message: "approved path", evidence: ["tool result"], blockers: [] }),
        toolCalls: [],
        stopReason: "end_turn",
      },
    ]);
    const registry = new ToolRegistry();
    registry.register(new ApprovalTool());
    const { router, runtime } = makeRuntime(registry);
    const registryModel = new StaticAgentLoopModelRegistry([modelInfo]);
    const events: Array<{ type: string; toolName?: string; reason?: string }> = [];
    const chat = new ChatAgentLoopRunner({
      boundedRunner: new BoundedAgentLoopRunner({ modelClient, toolRouter: router, toolRuntime: runtime }),
      modelClient,
      modelRegistry: registryModel,
      defaultModel: modelInfo.ref,
      defaultToolPolicy: { allowedTools: ["approval_tool"] },
    });

    const result = await chat.execute({
      message: "do it",
      goalId: "goal-1",
      approvalFn: async () => true,
      eventSink: {
        emit(event) {
          events.push({
            type: event.type,
            ...("toolName" in event ? { toolName: event.toolName } : {}),
            ...("reason" in event ? { reason: event.reason } : {}),
          });
        },
      },
    });

    expect(result.success).toBe(true);
    expect(result.output.startsWith("approved path")).toBe(true);
    expect(result.output).toContain("### Evidence");
    expect(events.some((event) => event.type === "approval_request" && event.toolName === "approval_tool")).toBe(true);
    expect(modelClient.calls[1].messages.some((m) => m.role === "tool" && m.toolName === "approval_tool")).toBe(true);
  });

  it("uses the latest chat input even when a typed session id is provided and reused", async () => {
    const stateDir = makeTempDir();
    try {
      const modelInfo = makeModelInfo();
      const modelClient = new ScriptedModelClient(modelInfo, [
        {
          content: JSON.stringify({ status: "done", message: "first", evidence: [], blockers: [] }),
          toolCalls: [],
          stopReason: "end_turn",
        },
        {
          content: JSON.stringify({ status: "done", message: "second", evidence: [], blockers: [] }),
          toolCalls: [],
          stopReason: "end_turn",
        },
      ]);
      const registry = new ToolRegistry();
      const { router, runtime } = makeRuntime(registry);
      const registryModel = new StaticAgentLoopModelRegistry([modelInfo]);
      const chat = new ChatAgentLoopRunner({
        boundedRunner: new BoundedAgentLoopRunner({ modelClient, toolRouter: router, toolRuntime: runtime }),
        modelClient,
        modelRegistry: registryModel,
        defaultModel: modelInfo.ref,
        createSession: (input) =>
          createAgentLoopSession({
            sessionId: input.resumeSessionId ?? "chat-session",
            traceId: "chat-trace",
            stateStore: new SqliteAgentLoopSessionStateStore(
              stateDir,
              input.resumeSessionId ?? "chat-session",
              "chat",
            ),
          }),
      });

      await chat.execute({ message: "first input", resumeSessionId: "chat-session" });
      await chat.execute({ message: "second input", resumeSessionId: "chat-session" });

      const firstLastUser = [...modelClient.calls[0].messages].reverse().find((message) => message.role === "user")?.content ?? "";
      const secondLastUser = [...modelClient.calls[1].messages].reverse().find((message) => message.role === "user")?.content ?? "";
      expect(firstLastUser).toContain("first input");
      expect(secondLastUser).toContain("second input");
      expect(secondLastUser).not.toContain("first input");
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it("loads persisted state for explicit resumeOnly chat turns", async () => {
    const stateDir = makeTempDir();
    try {
      const modelInfo = makeModelInfo();
      const modelClient = new ScriptedModelClient(modelInfo, [
        {
          content: JSON.stringify({ status: "done", message: "initial", evidence: [], blockers: [] }),
          toolCalls: [],
          stopReason: "end_turn",
        },
        {
          content: JSON.stringify({ status: "done", message: "resumed", evidence: [], blockers: [] }),
          toolCalls: [],
          stopReason: "end_turn",
        },
      ]);
      const registry = new ToolRegistry();
      const { router, runtime } = makeRuntime(registry);
      const registryModel = new StaticAgentLoopModelRegistry([modelInfo]);
      const chat = new ChatAgentLoopRunner({
        boundedRunner: new BoundedAgentLoopRunner({ modelClient, toolRouter: router, toolRuntime: runtime }),
        modelClient,
        modelRegistry: registryModel,
        defaultModel: modelInfo.ref,
        createSession: () =>
          createAgentLoopSession({
            sessionId: "resume-session",
            traceId: "resume-trace",
            stateStore: new SqliteAgentLoopSessionStateStore(stateDir, "resume-session", "chat"),
          }),
      });

      await chat.execute({ message: "persist this input" });
      await chat.execute({ message: "fresh input should be ignored on resume", resumeOnly: true });

      const secondUserMessages = modelClient.calls[1].messages
        .filter((message) => message.role === "user")
        .map((message) => message.content);
      expect(secondUserMessages.some((content) => content.includes("persist this input"))).toBe(true);
      expect(secondUserMessages.some((content) => content.includes("fresh input should be ignored on resume"))).toBe(false);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });
});

function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { cwd });
    let stderr = "";
    proc.stderr.setEncoding("utf-8");
    proc.stderr.on("data", (chunk: string) => { stderr += chunk; });
    proc.on("close", (code) => code === 0 ? resolve() : reject(new Error(stderr || `${command} failed`)));
  });
}

function defaultBudgetForTest() {
  return {
    maxModelTurns: 12,
    maxToolCalls: 40,
    maxWallClockMs: 10 * 60 * 1000,
    maxConsecutiveToolErrors: 3,
    maxRepeatedToolCalls: 4,
    maxSchemaRepairAttempts: 2,
    maxCompletionValidationAttempts: 2,
    maxCompactions: 3,
    compactionMaxMessages: 8,
  };
}
