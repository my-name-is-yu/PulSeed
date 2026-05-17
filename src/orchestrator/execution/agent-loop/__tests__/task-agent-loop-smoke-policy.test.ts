import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import type { Task } from "../../../../base/types/task.js";
import { makeTempDir } from "../../../../../tests/helpers/temp-dir.js";
import { ConcurrencyController } from "../../../../tools/concurrency.js";
import { ToolExecutor } from "../../../../tools/executor.js";
import { ApplyPatchTool } from "../../../../tools/fs/ApplyPatchTool/ApplyPatchTool.js";
import { ToolPermissionManager } from "../../../../tools/permission.js";
import { ToolRegistry } from "../../../../tools/registry.js";
import { ShellCommandTool } from "../../../../tools/system/ShellCommandTool/ShellCommandTool.js";
import { ShellTool } from "../../../../tools/system/ShellTool/ShellTool.js";
import {
  BoundedAgentLoopRunner,
  StaticAgentLoopModelRegistry,
  TaskAgentLoopRunner,
  ToolExecutorAgentLoopToolRuntime,
  ToolRegistryAgentLoopToolRouter,
  defaultAgentLoopCapabilities,
  defaultExecutionPolicy,
  withExecutionPolicyOverrides,
  type AgentLoopBudget,
  type AgentLoopModelClient,
  type AgentLoopModelInfo,
  type AgentLoopModelRequest,
  type AgentLoopModelResponse,
  type AgentLoopWorktreePolicy,
} from "../index.js";

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
    return this.responses[this.index++] ?? this.responses[this.responses.length - 1];
  }
}

const SMOKE_COMMAND = ".venv/bin/python src/experiments/train_hgb_engineered_auc.py --smoke-rows 2000";
const SMOKE_ARTIFACT = "reports/smoke-metrics.json";
const DENIED_COMMAND = "pip install forbidden-package";

describe("TaskAgentLoopRunner non-interactive smoke command policy", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it("runs workspace-local smoke commands under approvalPolicy=never without interactive approval", async () => {
    const workspace = makeWorkspace();
    writeSmokePythonShim(workspace);
    const modelInfo = makeModelInfo();
    const modelClient = new ScriptedModelClient(modelInfo, [
      {
        content: "",
        toolCalls: [{
          id: "smoke-1",
          name: "shell_command",
          input: { command: SMOKE_COMMAND, cwd: workspace, timeoutMs: 30_000 },
        }],
        stopReason: "tool_use",
      },
      {
        content: "",
        toolCalls: [{
          id: "verify-1",
          name: "shell_command",
          input: { command: `test -f ${SMOKE_ARTIFACT}`, cwd: workspace },
        }],
        stopReason: "tool_use",
      },
      {
        content: JSON.stringify({
          status: "done",
          finalAnswer: "smoke completed",
          summary: "smoke command and artifact verification completed",
          filesChanged: [],
          testsRun: [{ command: `test -f ${SMOKE_ARTIFACT}`, passed: true, outputSummary: "artifact exists" }],
          completionEvidence: ["smoke command completed and fresh artifact exists"],
          verificationHints: [],
          blockers: [],
        }),
        toolCalls: [],
        stopReason: "end_turn",
      },
    ]);
    const policy = withExecutionPolicyOverrides(defaultExecutionPolicy(workspace), {
      approvalPolicy: "never",
    });
    const runner = makeRunner({ workspace, modelInfo, modelClient, defaultExecutionPolicy: policy });

    const result = await runner.runTask({ task: makeTask(), cwd: workspace });

    expect(result.success).toBe(true);
    expect(result.executionPolicy?.approvalPolicy).toBe("never");
    expect(fs.existsSync(path.join(workspace, SMOKE_ARTIFACT))).toBe(true);
    expect(result.commandResults[0]).toMatchObject({
      toolName: "shell_command",
      command: SMOKE_COMMAND,
      success: true,
      execution: { status: "executed" },
    });
    expect(result.commandResults.some((entry) => entry.execution?.reason === "approval_denied")).toBe(false);
  });

  it("returns denied smoke commands as actionable blockers instead of only max turns", async () => {
    const workspace = makeWorkspace();
    const modelInfo = makeModelInfo();
    const modelClient = new ScriptedModelClient(modelInfo, [
      {
        content: "",
        toolCalls: [{
          id: "smoke-1",
          name: "shell_command",
          input: { command: DENIED_COMMAND, cwd: workspace, timeoutMs: 30_000 },
        }],
        stopReason: "tool_use",
      },
    ]);
    const policy = withExecutionPolicyOverrides(defaultExecutionPolicy(workspace), {
      networkAccess: true,
    });
    const runner = makeRunner({
      workspace,
      modelInfo,
      modelClient,
      defaultExecutionPolicy: policy,
      defaultBudget: { maxModelTurns: 1, maxToolCalls: 1 },
    });

    const result = await runner.runTaskAsAgentResult({ task: makeTask(), cwd: workspace });

    expect(result.success).toBe(false);
    expect(result.output).toContain("Command shell_command was not executed (approval_denied)");
    expect(result.output).toContain(DENIED_COMMAND);
    expect(result.output).not.toBe("max_model_turns");
    expect(result.error).toContain("Shell command requires approval under current execution policy");
    expect(result.agentLoop?.approvalPolicy).toBe("on_request");
  });

  it("keeps isolated workspaces when a denied command is followed by premature done", async () => {
    const policyRoot = makeTempDir();
    tmpDirs.push(policyRoot);
    const workspace = makeGitWorkspace(policyRoot);
    const isolatedBaseDir = path.join(policyRoot, "worktrees");
    const modelInfo = makeModelInfo();
    const modelClient = new ScriptedModelClient(modelInfo, [
      {
        content: "",
        toolCalls: [{
          id: "smoke-1",
          name: "shell_command",
          input: { command: DENIED_COMMAND, timeoutMs: 30_000 },
        }],
        stopReason: "tool_use",
      },
      {
        content: JSON.stringify({
          status: "done",
          finalAnswer: "claimed done after denied command",
          summary: "premature success",
          filesChanged: [],
          testsRun: [],
          completionEvidence: ["claimed evidence"],
          verificationHints: [],
          blockers: [],
        }),
        toolCalls: [],
        stopReason: "end_turn",
      },
    ]);
    const policy = withExecutionPolicyOverrides(defaultExecutionPolicy(policyRoot), {
      networkAccess: true,
    });
    const runner = makeRunner({
      workspace,
      modelInfo,
      modelClient,
      defaultExecutionPolicy: policy,
      defaultBudget: { maxModelTurns: 3, maxToolCalls: 3 },
      defaultWorktreePolicy: {
        enabled: true,
        baseDir: isolatedBaseDir,
        cleanupPolicy: "on_success",
      },
    });

    const result = await runner.runTask({ task: makeTask(), cwd: workspace });

    expect(result.success).toBe(false);
    expect(result.output?.status).toBe("done");
    expect(result.workspace).toMatchObject({
      isolated: true,
      cleanupStatus: "kept",
      cleanupReason: "task did not succeed",
    });
    expect(result.workspace?.executionCwd).not.toBe(result.workspace?.requestedCwd);
    expect(fs.existsSync(result.workspace!.executionCwd)).toBe(true);
  });

  it("requires handoff instead of completion when successful work leaves a dirty isolated worktree", async () => {
    const policyRoot = makeTempDir();
    tmpDirs.push(policyRoot);
    const workspace = makeGitWorkspace(policyRoot);
    const isolatedBaseDir = path.join(policyRoot, "worktrees");
    const modelInfo = makeModelInfo();
    const modelClient = new ScriptedModelClient(modelInfo, [
      {
        content: "",
        toolCalls: [{
          id: "edit-1",
          name: "apply_patch",
          input: {
            patch: [
              "*** Begin Patch",
              "*** Update File: README.md",
              "@@",
              "-fixture",
              "+fixture changed in isolated worktree",
              "*** End Patch",
            ].join("\n"),
          },
        }],
        stopReason: "tool_use",
      },
      {
        content: "",
        toolCalls: [{
          id: "verify-1",
          name: "shell_command",
          input: { command: "grep -q 'fixture changed in isolated worktree' README.md", timeoutMs: 30_000 },
        }],
        stopReason: "tool_use",
      },
      {
        content: JSON.stringify({
          status: "done",
          finalAnswer: "implemented change",
          summary: "README updated",
          filesChanged: ["README.md"],
          testsRun: [],
          completionEvidence: ["README.md was updated"],
          verificationHints: [],
          blockers: [],
        }),
        toolCalls: [],
        stopReason: "end_turn",
      },
    ]);
    const task = makeTask({
      success_criteria: [{
        description: "README contains the isolated worktree change",
        verification_method: "grep -q 'fixture changed in isolated worktree' README.md",
        is_blocking: true,
      }],
    });
    const runner = makeRunner({
      workspace,
      modelInfo,
      modelClient,
      defaultExecutionPolicy: withExecutionPolicyOverrides(defaultExecutionPolicy(policyRoot), {
        approvalPolicy: "never",
      }),
      defaultWorktreePolicy: {
        enabled: true,
        baseDir: isolatedBaseDir,
        cleanupPolicy: "on_success",
      },
    });

    const result = await runner.runTaskAsAgentResult({ task, cwd: workspace });

    expect(result.success).toBe(false);
    expect(result.stopped_reason).toBe("error");
    expect(result.output).toContain("operator handoff");
    expect(result.output).toContain(result.agentLoop!.executionCwd!);
    expect(result.agentLoop).toMatchObject({
      requestedCwd: fs.realpathSync(workspace),
      isolatedWorkspace: true,
      workspaceCleanupStatus: "kept",
      workspaceCleanupReason: "worktree has changes",
      workspaceDirty: true,
      workspaceDisposition: "handoff_required",
    });
    expect(result.agentLoop!.executionCwd).not.toBe(workspace);
    expect(fs.readFileSync(path.join(workspace, "README.md"), "utf-8")).toBe("fixture\n");
    expect(fs.readFileSync(path.join(result.agentLoop!.executionCwd!, "README.md"), "utf-8")).toBe(
      "fixture changed in isolated worktree\n",
    );
  });

  it("steers edit tasks away from multiline shell rewrites through the production task runner path", async () => {
    const workspace = makeGitWorkspace();
    const modelInfo = makeModelInfo();
    const modelClient = new ScriptedModelClient(modelInfo, [
      {
        content: "",
        toolCalls: [{
          id: "edit-1",
          name: "apply_patch",
          input: {
            patch: [
              "*** Begin Patch",
              "*** Update File: README.md",
              "@@",
              "-fixture",
              "+fixture edited with typed patch tool",
              "*** End Patch",
            ].join("\n"),
          },
        }],
        stopReason: "tool_use",
      },
      {
        content: "",
        toolCalls: [{
          id: "verify-1",
          name: "shell_command",
          input: { command: "grep -q 'typed patch tool' README.md", timeoutMs: 30_000 },
        }],
        stopReason: "tool_use",
      },
      {
        content: JSON.stringify({
          status: "done",
          finalAnswer: "implemented edit",
          summary: "README updated with apply_patch",
          filesChanged: ["README.md"],
          testsRun: [{ command: "grep -q 'typed patch tool' README.md", passed: true, outputSummary: "verified" }],
          completionEvidence: ["README.md verified after typed patch"],
          verificationHints: [],
          blockers: [],
        }),
        toolCalls: [],
        stopReason: "end_turn",
      },
    ]);
    const task = makeTask({
      work_description: "Edit README.md for a Kaggle training note.",
      approach: "Modify README.md and verify the text.",
      success_criteria: [{
        description: "README contains the typed edit marker",
        verification_method: "grep -q 'typed patch tool' README.md",
        is_blocking: true,
      }],
    });
    const runner = makeRunner({
      workspace,
      modelInfo,
      modelClient,
      defaultExecutionPolicy: withExecutionPolicyOverrides(defaultExecutionPolicy(workspace), {
        approvalPolicy: "never",
      }),
    });

    const result = await runner.runTask({ task, cwd: workspace });

    const firstRequest = modelClient.calls[0]!;
    const systemPrompt = firstRequest.messages.find((message) => message.role === "system")?.content ?? "";
    const shellDescription = firstRequest.tools.find((tool) => tool.function.name === "shell_command")?.function.description ?? "";
    expect(systemPrompt).toContain("Do not use shell or shell_command for file edits");
    expect(systemPrompt).toContain("multiline shell write patterns");
    expect(shellDescription).toContain("Do not use for file edits");
    expect(shellDescription).toContain("heredocs");
    expect(result.toolResults?.map((entry) => entry.toolName)).toEqual(["apply_patch", "shell_command"]);
    expect(result.commandResults.some((entry) => entry.command.includes("\n"))).toBe(false);
    expect(result.commandResults.some((entry) => entry.command.includes("<<"))).toBe(false);
    expect(fs.readFileSync(path.join(workspace, "README.md"), "utf-8")).toBe("fixture edited with typed patch tool\n");
  });

  it("gives the same multiline rewrite guidance when the shell surface is visible", async () => {
    const workspace = makeGitWorkspace();
    const modelInfo = makeModelInfo();
    const modelClient = new ScriptedModelClient(modelInfo, [
      {
        content: "",
        toolCalls: [{
          id: "edit-1",
          name: "apply_patch",
          input: {
            patch: [
              "*** Begin Patch",
              "*** Update File: README.md",
              "@@",
              "-fixture",
              "+fixture edited through typed tool with shell visible",
              "*** End Patch",
            ].join("\n"),
          },
        }],
        stopReason: "tool_use",
      },
      {
        content: JSON.stringify({
          status: "done",
          finalAnswer: "implemented edit",
          summary: "README updated with apply_patch",
          filesChanged: ["README.md"],
          testsRun: [],
          completionEvidence: ["README.md updated"],
          verificationHints: [],
          blockers: [],
        }),
        toolCalls: [],
        stopReason: "end_turn",
      },
    ]);
    const runner = makeRunner({
      workspace,
      modelInfo,
      modelClient,
      includeShellTool: true,
      defaultExecutionPolicy: withExecutionPolicyOverrides(defaultExecutionPolicy(workspace), {
        approvalPolicy: "never",
      }),
    });

    const result = await runner.runTask({ task: makeTask(), cwd: workspace });

    const firstRequest = modelClient.calls[0]!;
    const systemPrompt = firstRequest.messages.find((message) => message.role === "system")?.content ?? "";
    const shellDescription = firstRequest.tools.find((tool) => tool.function.name === "shell")?.function.description ?? "";
    const shellCommandDescription = firstRequest.tools.find((tool) => tool.function.name === "shell_command")?.function.description ?? "";
    expect(firstRequest.tools.map((tool) => tool.function.name)).toEqual(expect.arrayContaining(["shell", "shell_command", "apply_patch"]));
    expect(systemPrompt).toContain("Do not use shell or shell_command for file edits");
    expect(systemPrompt).toContain("heredocs");
    expect(shellDescription).toContain("Do not use for file edits");
    expect(shellDescription).toContain("heredocs");
    expect(shellCommandDescription).toContain("Do not use for file edits");
    expect(result.toolResults?.map((entry) => entry.toolName)).toEqual(["apply_patch"]);
    expect(result.commandResults.some((entry) => entry.command.includes("\n"))).toBe(false);
    expect(result.commandResults.some((entry) => entry.command.includes("<<"))).toBe(false);
  });

  it("does not keep isolated workspaces when a later typed tool recovers after denial", async () => {
    const policyRoot = makeTempDir();
    tmpDirs.push(policyRoot);
    const workspace = makeGitWorkspace(policyRoot);
    const isolatedBaseDir = path.join(policyRoot, "worktrees");
    const modelInfo = makeModelInfo();
    const modelClient = new ScriptedModelClient(modelInfo, [
      {
        content: "",
        toolCalls: [{
          id: "blocked-1",
          name: "shell_command",
          input: { command: "cat dogfood.txt", timeoutMs: 30_000 },
        }],
        stopReason: "tool_use",
      },
      {
        content: "",
        toolCalls: [{
          id: "recover-1",
          name: "apply_patch",
          input: {
            checkOnly: true,
            patch: [
              "*** Begin Patch",
              "*** Update File: README.md",
              "@@",
              "-fixture",
              "+fixture checked",
              "*** End Patch",
            ].join("\n"),
          },
        }],
        stopReason: "tool_use",
      },
      {
        content: JSON.stringify({
          status: "done",
          finalAnswer: "recovered with typed tool",
          summary: "typed tool supplied fresh recovery evidence",
          filesChanged: [],
          testsRun: [],
          completionEvidence: ["apply_patch check-only recovery evidence"],
          verificationHints: [],
          blockers: [],
        }),
        toolCalls: [],
        stopReason: "end_turn",
      },
    ]);
    const policy = withExecutionPolicyOverrides(defaultExecutionPolicy(policyRoot), {
      approvalPolicy: "never",
    });
    const runner = makeRunner({
      workspace,
      modelInfo,
      modelClient,
      defaultExecutionPolicy: policy,
      defaultWorktreePolicy: {
        enabled: true,
        baseDir: isolatedBaseDir,
        cleanupPolicy: "on_success",
      },
      denyShellCommand: (command) => command === "cat dogfood.txt",
    });

    const result = await runner.runTask({ task: makeTask(), cwd: workspace });

    expect(result.success).toBe(true);
    expect(result.toolResults?.map((entry) => entry.toolName)).toEqual(["shell_command", "apply_patch"]);
    expect(result.workspace).toMatchObject({
      isolated: true,
      cleanupStatus: "cleaned_up",
    });
    expect(fs.existsSync(result.workspace!.executionCwd)).toBe(false);
  });

  function makeWorkspace(): string {
    const workspace = makeTempDir();
    tmpDirs.push(workspace);
    fs.mkdirSync(path.join(workspace, "src/experiments"), { recursive: true });
    fs.writeFileSync(path.join(workspace, "src/experiments/train_hgb_engineered_auc.py"), "print('placeholder')\n");
    return workspace;
  }

  function makeGitWorkspace(root?: string): string {
    const workspace = root ? path.join(root, "repo") : makeWorkspace();
    if (root) {
      fs.mkdirSync(path.join(workspace, "src/experiments"), { recursive: true });
      fs.writeFileSync(path.join(workspace, "src/experiments/train_hgb_engineered_auc.py"), "print('placeholder')\n");
    }
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    fs.writeFileSync(path.join(workspace, "README.md"), "fixture\n");
    execFileSync("git", ["add", "README.md"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", [
      "-c",
      "user.email=codex@example.com",
      "-c",
      "user.name=Codex",
      "commit",
      "-m",
      "fixture",
    ], { cwd: workspace, stdio: "ignore" });
    return workspace;
  }
});

function makeRunner(input: {
  workspace: string;
  modelInfo: AgentLoopModelInfo;
  modelClient: AgentLoopModelClient;
  defaultExecutionPolicy: ReturnType<typeof defaultExecutionPolicy>;
  defaultBudget?: Partial<AgentLoopBudget>;
  defaultWorktreePolicy?: AgentLoopWorktreePolicy;
  denyShellCommand?: (command: string) => boolean;
  includeShellTool?: boolean;
}): TaskAgentLoopRunner {
  const registry = new ToolRegistry();
  registry.register(new ApplyPatchTool());
  registry.register(new ShellCommandTool());
  if (input.includeShellTool) registry.register(new ShellTool());
  const router = new ToolRegistryAgentLoopToolRouter(registry);
  const executor = new ToolExecutor({
    registry,
    permissionManager: new ToolPermissionManager({
      denyRules: input.denyShellCommand
        ? [{
            toolName: "shell_command",
            inputMatcher: (toolInput) =>
              toolInput !== null
              && typeof toolInput === "object"
              && typeof (toolInput as Record<string, unknown>)["command"] === "string"
              && input.denyShellCommand!((toolInput as Record<string, string>)["command"]),
            reason: "test denied shell command",
          }]
        : [],
    }),
    concurrency: new ConcurrencyController(),
  });
  const runtime = new ToolExecutorAgentLoopToolRuntime(executor, router);
  const boundedRunner = new BoundedAgentLoopRunner({
    modelClient: input.modelClient,
    toolRouter: router,
    toolRuntime: runtime,
  });
  return new TaskAgentLoopRunner({
    boundedRunner,
    modelClient: input.modelClient,
    modelRegistry: new StaticAgentLoopModelRegistry([input.modelInfo]),
    defaultModel: input.modelInfo.ref,
    defaultToolPolicy: { allowedTools: input.includeShellTool ? ["shell", "shell_command", "apply_patch"] : ["shell_command", "apply_patch"] },
    defaultBudget: {
      maxModelTurns: 4,
      maxToolCalls: 4,
      maxCompletionValidationAttempts: 1,
      ...input.defaultBudget,
    },
    ...(input.defaultWorktreePolicy ? { defaultWorktreePolicy: input.defaultWorktreePolicy } : {}),
    defaultExecutionPolicy: input.defaultExecutionPolicy,
    cognitionMemoryBaseDir: path.join(input.workspace, ".pulseed-test-cognition"),
    cwd: input.workspace,
  });
}

function writeSmokePythonShim(workspace: string): void {
  const binDir = path.join(workspace, ".venv/bin");
  fs.mkdirSync(binDir, { recursive: true });
  const shimPath = path.join(binDir, "python");
  fs.writeFileSync(shimPath, [
    "#!/bin/sh",
    "mkdir -p reports",
    "printf '{\"auc\":0.70}\\n' > reports/smoke-metrics.json",
    "echo smoke-ok \"$@\"",
    "",
  ].join("\n"));
  fs.chmodSync(shimPath, 0o755);
}

function makeModelInfo(): AgentLoopModelInfo {
  return {
    ref: { providerId: "test", modelId: "smoke-policy" },
    displayName: "test/smoke-policy",
    capabilities: { ...defaultAgentLoopCapabilities },
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "smoke-task",
    goal_id: "smoke-goal",
    strategy_id: null,
    target_dimensions: ["execution"],
    primary_dimension: "execution",
    work_description: "Run Kaggle smoke training in the configured workspace.",
    rationale: "Exercise non-interactive task shell policy.",
    approach: "Run workspace-local smoke training and verify the artifact.",
    success_criteria: [{
      description: "smoke metrics artifact exists",
      verification_method: `test -f ${SMOKE_ARTIFACT}`,
      is_blocking: true,
    }],
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
