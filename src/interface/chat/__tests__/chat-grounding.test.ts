import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

// Mock context-provider so tests don't walk the real filesystem.
// Must appear before any ChatRunner import.
vi.mock("../../../platform/observation/context-provider.js", () => ({
  resolveGitRoot: (cwd: string) => cwd,
  buildChatContext: (_task: string, cwd: string) => `Working directory: ${cwd}`,
}));

// Mock spawn-helper used by CLI adapters.
// Vitest hoists vi.mock() calls, so this runs before adapter imports.
vi.mock("../../../adapters/spawn-helper.js", () => ({
  spawnWithTimeout: vi.fn().mockResolvedValue({
    stdout: "output",
    stderr: "",
    exitCode: 0,
    timedOut: false,
  }),
  spawnResultToAgentResult: vi.fn().mockImplementation(
    (result: { exitCode: number | null; stdout: string; stderr: string }, elapsed: number) => ({
      success: result.exitCode === 0,
      output: result.stdout,
      error: result.exitCode !== 0 ? result.stderr : null,
      exit_code: result.exitCode,
      elapsed_ms: elapsed,
      stopped_reason: result.exitCode === 0 ? "completed" : "error",
    })
  ),
}));

// ─── Module imports (after mocks) ───
import { buildChatAgentLoopSystemPrompt, buildChatGroundingBundle, buildSystemPrompt } from "../grounding.js";
import { ClaudeAPIAdapter } from "../../../adapters/agents/claude-api.js";
import { ClaudeCodeCLIAdapter } from "../../../adapters/agents/claude-code-cli.js";
import { OpenAICodexCLIAdapter } from "../../../adapters/agents/openai-codex.js";
import { ChatRunner } from "../chat-runner.js";
import type { ChatRunnerDeps } from "../chat-runner-contracts.js";
import type { IAdapter, AgentResult } from "../../../orchestrator/execution/adapter-layer.js";
import type { StateManager } from "../../../base/state/state-manager.js";
import type { ILLMClient } from "../../../base/llm/llm-client.js";
import { spawnWithTimeout } from "../../../adapters/spawn-helper.js";
import { clearIdentityCache } from "../../../base/config/identity-loader.js";
import { writeSeedMd } from "../../cli/commands/setup/steps-runtime.js";

// ─── Shared helpers ───

function makeMockStateManager(
  goalIds: string[] = [],
  goals: Record<string, object> = {}
): StateManager {
  return {
    listGoalIds: vi.fn().mockResolvedValue(goalIds),
    loadGoal: vi.fn().mockImplementation(async (id: string) => goals[id] ?? null),
    listTasks: vi.fn().mockResolvedValue([]),
    writeRaw: vi.fn().mockResolvedValue(undefined),
    readRaw: vi.fn().mockResolvedValue(null),
  } as unknown as StateManager;
}

const CANNED_RESULT: AgentResult = {
  success: true,
  output: "Done.",
  error: null,
  exit_code: 0,
  elapsed_ms: 50,
  stopped_reason: "completed",
};

function makeMockAdapter(result: AgentResult = CANNED_RESULT): IAdapter {
  return {
    adapterType: "mock",
    execute: vi.fn().mockResolvedValue(result),
  } as unknown as IAdapter;
}

function makeDeps(overrides: Partial<ChatRunnerDeps> = {}): ChatRunnerDeps {
  return {
    stateManager: makeMockStateManager(),
    adapter: makeMockAdapter(),
    ...overrides,
  };
}

// ─── buildSystemPrompt tests ───

describe("buildSystemPrompt (grounding.ts)", () => {
  let tmpDir: string;
  let originalPulseedHome: string | undefined;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pulseed-grounding-test-"));
    originalPulseedHome = process.env["PULSEED_HOME"];
    process.env["PULSEED_HOME"] = tmpDir;
    clearIdentityCache();
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
    if (originalPulseedHome === undefined) {
      delete process.env["PULSEED_HOME"];
    } else {
      process.env["PULSEED_HOME"] = originalPulseedHome;
    }
    clearIdentityCache();
  });

  it("includes Seedy identity text", async () => {
    const sm = makeMockStateManager();
    const prompt = await buildSystemPrompt({ stateManager: sm, homeDir: tmpDir });

    expect(prompt).toContain("Seedy");
    expect(prompt).toContain("configured agent identity running PulSeed");
    expect(prompt).toContain("SEED.md, ROOT.md, USER.md");
  });

  it("grounds self-description in runtime identity files instead of provider identity", async () => {
    await fsp.writeFile(path.join(tmpDir, "SEED.md"), "# Sprout\n\nCustom identity.", "utf-8");
    clearIdentityCache();
    const sm = makeMockStateManager();
    const prompt = await buildSystemPrompt({ stateManager: sm, homeDir: tmpDir });

    expect(prompt).toContain("When asked who you are or what your name is, answer as Sprout");
    expect(prompt).toContain("PulSeed runtime identity files (SEED.md, ROOT.md, USER.md) own self-identity");
    expect(prompt).toContain("not as Codex, Claude, ChatGPT");
  });

  it("grounds setup-chosen agent name written to SEED.md", async () => {
    writeSeedMd(tmpDir, "Sprout");
    clearIdentityCache();
    const sm = makeMockStateManager();
    const prompt = await buildSystemPrompt({ stateManager: sm, homeDir: tmpDir });

    expect(prompt).toContain("Active agent name: Sprout");
    expect(prompt).toContain("When asked who you are or what your name is, answer as Sprout");
    expect(prompt).toContain("I'm Sprout");
    expect(prompt).not.toContain("Active agent name: Seedy");
    expect(prompt).not.toContain("I'm Seedy");
  });

  it("includes fixed policy sections", async () => {
    const sm = makeMockStateManager();
    const prompt = await buildSystemPrompt({ stateManager: sm, homeDir: tmpDir });

    expect(prompt).toContain("## Identity");
    expect(prompt).toContain("## Execution Bias");
    expect(prompt).toContain("## Tooling Policy");
    expect(prompt).toContain("## Communication Policy");
    expect(prompt).toContain("## Safety And Approval");
    expect(prompt).toContain("## Dynamic Context");
    expect(prompt).toContain("Platform operating policy overrides persona and customization text if they conflict.");
    expect(prompt.length).toBeGreaterThan(0);
  });

  it("aligns default identity text with direct tool execution", async () => {
    const sm = makeMockStateManager();
    const prompt = await buildSystemPrompt({ stateManager: sm, homeDir: tmpDir });

    expect(prompt).toContain("I use available tools directly when that moves the goal forward safely");
    expect(prompt).not.toContain("I orchestrate, I don't execute tasks directly");
    expect(prompt).not.toContain("I always delegate to agents and observe results");
  });

  it("limits explicit approval guidance to high-impact actions", async () => {
    const sm = makeMockStateManager();
    const prompt = await buildSystemPrompt({ stateManager: sm, homeDir: tmpDir });

    expect(prompt).toContain("Proceed without asking first for routine reads, searches, tests, diffs, and ordinary local code edits.");
    expect(prompt).toContain("Before high-impact configuration changes");
    expect(prompt).not.toContain("Require explicit user approval before applying configuration changes.");
  });

  it("shows goals from stateManager", async () => {
    const sm = makeMockStateManager(
      ["goal-1", "goal-2"],
      {
        "goal-1": { title: "Ship feature X", status: "active", loop_status: "running" },
        "goal-2": { title: "Fix prod bug", status: "pending", loop_status: "idle" },
      }
    );
    const prompt = await buildSystemPrompt({ stateManager: sm, homeDir: tmpDir });

    expect(prompt).toContain("Ship feature X");
    expect(prompt).toContain("goal-1");
    expect(prompt).toContain("Fix prod bug");
    expect(prompt).toContain("goal-2");
    expect(prompt).toContain("### Current Goals");
  });

  it("shows 'No goals configured yet' when no goals", async () => {
    const sm = makeMockStateManager([], {});
    const prompt = await buildSystemPrompt({ stateManager: sm, homeDir: tmpDir });

    expect(prompt).toContain("No goals configured yet");
  });

  it("handles stateManager errors — rejects (error propagates)", async () => {
    const sm = {
      listGoalIds: vi.fn().mockRejectedValue(new Error("DB unavailable")),
      loadGoal: vi.fn(),
    } as unknown as StateManager;

    // buildGoalsBlock rejects, which propagates through buildSystemPrompt
    await expect(buildSystemPrompt({ stateManager: sm, homeDir: tmpDir })).rejects.toThrow("DB unavailable");
  });

  it("reads plugins directory and lists installed plugins", async () => {
    const pluginsDir = path.join(tmpDir, "plugins");
    await fsp.mkdir(pluginsDir);
    await fsp.mkdir(path.join(pluginsDir, "slack-notifier"));
    await fsp.mkdir(path.join(pluginsDir, "github-issues"));

    const sm = makeMockStateManager();
    const prompt = await buildSystemPrompt({ stateManager: sm, homeDir: tmpDir });

    expect(prompt).toContain("slack-notifier");
    expect(prompt).toContain("github-issues");
    expect(prompt).toContain("### Installed Plugins");
  });

  it("shows 'none' when plugins directory is absent", async () => {
    const sm = makeMockStateManager();
    const prompt = await buildSystemPrompt({ stateManager: sm, homeDir: tmpDir });

    expect(prompt).toContain("Installed: none");
  });

  it("reads provider.json and shows llm/adapter info", async () => {
    const providerPath = path.join(tmpDir, "provider.json");
    await fsp.writeFile(
      providerPath,
      JSON.stringify({ llm: "claude-sonnet-4", default_adapter: "claude_api" }),
      "utf-8"
    );

    const sm = makeMockStateManager();
    const prompt = await buildSystemPrompt({ stateManager: sm, homeDir: tmpDir });

    expect(prompt).toContain("claude-sonnet-4");
    expect(prompt).toContain("claude_api");
    expect(prompt).toContain("### Provider");
  });

  it("shows 'not configured' when provider.json is absent", async () => {
    const sm = makeMockStateManager();
    const prompt = await buildSystemPrompt({ stateManager: sm, homeDir: tmpDir });

    expect(prompt).toContain("not configured");
  });

  it("shows loop_status in goal line when not idle", async () => {
    const sm = makeMockStateManager(
      ["goal-running"],
      {
        "goal-running": { title: "Active task", status: "active", loop_status: "running" },
      }
    );
    const prompt = await buildSystemPrompt({ stateManager: sm, homeDir: tmpDir });

    expect(prompt).toContain("[running]");
  });

  it("does not show loop_status bracket when idle", async () => {
    const sm = makeMockStateManager(
      ["goal-idle"],
      {
        "goal-idle": { title: "Idle task", status: "pending", loop_status: "idle" },
      }
    );
    const prompt = await buildSystemPrompt({ stateManager: sm, homeDir: tmpDir });

    expect(prompt).not.toContain("[idle]");
    expect(prompt).toContain("Idle task");
  });

  it("builds a chat grounding bundle with dynamic goal state", async () => {
    const sm = makeMockStateManager(
      ["goal-1"],
      {
        "goal-1": { title: "Ship feature X", status: "active", loop_status: "running" },
      }
    );

    const bundle = await buildChatGroundingBundle({ stateManager: sm, workspaceRoot: "/repo", userMessage: "Ship feature X" });

    expect(bundle.dynamicSections.some((section) => section.key === "goal_state" && section.content.includes("Ship feature X"))).toBe(true);
  });

  it("builds agentloop-oriented chat grounding with workspace facts in the prompt", async () => {
    const sm = makeMockStateManager(
      ["goal-1"],
      {
        "goal-1": { title: "Ship feature X", status: "active", loop_status: "running" },
      }
    );

    const prompt = await buildChatAgentLoopSystemPrompt({
      stateManager: sm,
      workspaceRoot: "/repo",
      userMessage: "Ship feature X",
      workspaceContext: "Working directory: /repo",
    });

    expect(prompt).toContain("## Workspace Facts");
    expect(prompt).toContain("Workspace root: /repo");
    expect(prompt).toContain("Working directory: /repo");
    expect(prompt).toContain("## Provider");
    expect(prompt).toContain("## Installed Plugins");
  });

  it("keeps nested workspace instructions when chat grounding runs below the git root", async () => {
    const repoRoot = path.join(tmpDir, "repo");
    const nestedWorkspace = path.join(repoRoot, "packages", "app");
    await fsp.mkdir(path.join(repoRoot, ".git"), { recursive: true });
    await fsp.mkdir(nestedWorkspace, { recursive: true });
    await fsp.writeFile(path.join(repoRoot, "AGENTS.md"), "Root instructions", "utf-8");
    await fsp.writeFile(path.join(nestedWorkspace, "AGENTS.md"), "Nested instructions", "utf-8");

    const sm = makeMockStateManager();
    const prompt = await buildChatAgentLoopSystemPrompt({
      stateManager: sm,
      workspaceRoot: nestedWorkspace,
      userMessage: "Inspect the package",
      workspaceContext: `Working directory: ${nestedWorkspace}`,
    });

    expect(prompt).toContain("Root instructions");
    expect(prompt).toContain("Nested instructions");
    expect(prompt).toContain(`Workspace root: ${nestedWorkspace}`);
  });
});

// ─── ClaudeAPIAdapter system_prompt passthrough ───

describe("ClaudeAPIAdapter — system_prompt passthrough", () => {
  it("passes system_prompt as system option to sendMessage", async () => {
    const sendMessage = vi.fn().mockResolvedValue({
      content: "ok",
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: "end_turn",
    });
    const mockLLMClient = { sendMessage, parseJSON: vi.fn() } as unknown as ILLMClient;
    const adapter = new ClaudeAPIAdapter(mockLLMClient);

    await adapter.execute({
      prompt: "Do the thing",
      timeout_ms: 5000,
      adapter_type: "claude_api",
      system_prompt: "You are PulSeed.",
    });

    expect(sendMessage).toHaveBeenCalledOnce();
    const [, options] = sendMessage.mock.calls[0];
    expect(options).toMatchObject({ system: "You are PulSeed." });
  });

  it("does not pass system option when system_prompt is undefined", async () => {
    const sendMessage = vi.fn().mockResolvedValue({
      content: "ok",
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: "end_turn",
    });
    const mockLLMClient = { sendMessage, parseJSON: vi.fn() } as unknown as ILLMClient;
    const adapter = new ClaudeAPIAdapter(mockLLMClient);

    await adapter.execute({
      prompt: "Do the thing",
      timeout_ms: 5000,
      adapter_type: "claude_api",
    });

    const [, options] = sendMessage.mock.calls[0];
    expect(options).toBeUndefined();
  });
});

// ─── CLI adapters — system_prompt prepend ───

describe("ClaudeCodeCLIAdapter — system_prompt prepend", () => {
  beforeEach(() => {
    (spawnWithTimeout as ReturnType<typeof vi.fn>).mockClear();
    (spawnWithTimeout as ReturnType<typeof vi.fn>).mockResolvedValue({
      stdout: "output",
      stderr: "",
      exitCode: 0,
      timedOut: false,
    });
  });

  it("prepends [System Context] block when system_prompt is set", async () => {
    const adapter = new ClaudeCodeCLIAdapter("echo");

    await adapter.execute({
      prompt: "Do the thing",
      timeout_ms: 5000,
      adapter_type: "claude_code_cli",
      system_prompt: "You are PulSeed.",
    });

    expect(spawnWithTimeout).toHaveBeenCalledOnce();
    const opts = (spawnWithTimeout as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(opts.stdinData).toContain("[System Context]");
    expect(opts.stdinData).toContain("You are PulSeed.");
    expect(opts.stdinData).toContain("[User Request]");
    expect(opts.stdinData).toContain("Do the thing");
  });

  it("passes prompt directly when system_prompt is undefined", async () => {
    const adapter = new ClaudeCodeCLIAdapter("echo");

    await adapter.execute({
      prompt: "Do the thing",
      timeout_ms: 5000,
      adapter_type: "claude_code_cli",
    });

    const opts = (spawnWithTimeout as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(opts.stdinData).toBe("Do the thing");
    expect(opts.stdinData).not.toContain("[System Context]");
  });
});

describe("OpenAICodexCLIAdapter — system_prompt prepend", () => {
  beforeEach(() => {
    (spawnWithTimeout as ReturnType<typeof vi.fn>).mockClear();
    (spawnWithTimeout as ReturnType<typeof vi.fn>).mockResolvedValue({
      stdout: "output",
      stderr: "",
      exitCode: 0,
      timedOut: false,
    });
  });

  it("prepends [System Context] block when system_prompt is set", async () => {
    const adapter = new OpenAICodexCLIAdapter({ cliPath: "echo", sandboxPolicy: null });

    await adapter.execute({
      prompt: "Analyze the repo",
      timeout_ms: 5000,
      adapter_type: "openai_codex_cli",
      system_prompt: "You are PulSeed.",
    });

    expect(spawnWithTimeout).toHaveBeenCalledOnce();
    const opts = (spawnWithTimeout as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(opts.stdinData).toContain("[System Context]");
    expect(opts.stdinData).toContain("You are PulSeed.");
    expect(opts.stdinData).toContain("[User Request]");
    expect(opts.stdinData).toContain("Analyze the repo");
  });

  it("passes prompt directly when system_prompt is undefined", async () => {
    const adapter = new OpenAICodexCLIAdapter({ cliPath: "echo", sandboxPolicy: null });

    await adapter.execute({
      prompt: "Analyze the repo",
      timeout_ms: 5000,
      adapter_type: "openai_codex_cli",
    });

    const opts = (spawnWithTimeout as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(opts.stdinData).toBe("Analyze the repo");
    expect(opts.stdinData).not.toContain("[System Context]");
  });
});

// ─── ChatRunner integration tests (direct model loop grounding) ───

function makeRecordingLLMClient(output = "Done."): ILLMClient {
  return {
    supportsToolCalling: () => true,
    sendMessage: vi.fn().mockResolvedValue({
      content: output,
      usage: { input_tokens: 1, output_tokens: 1 },
      stop_reason: "end_turn",
      tool_calls: [],
    }),
  } as unknown as ILLMClient;
}

describe("ChatRunner — direct model loop grounding", () => {
  it("sets the system prompt on the direct model request without using the legacy adapter", async () => {
    const adapter = makeMockAdapter();
    const llmClient = makeRecordingLLMClient();
    const runner = new ChatRunner(makeDeps({ adapter, llmClient }));

    await runner.execute("Hello", "/repo");

    expect(adapter.execute).not.toHaveBeenCalled();
    expect(llmClient.sendMessage).toHaveBeenCalledOnce();
    const [, options] = (llmClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(options?.system ?? "")).toContain("## Identity");
    expect(String(options?.system ?? "")).toContain("gateway chat surface");
  });

  it("includes conversation history in the direct model prompt for subsequent turns", async () => {
    const adapter = makeMockAdapter();
    const llmClient = makeRecordingLLMClient();
    const runner = new ChatRunner(makeDeps({ adapter, llmClient }));

    runner.startSession("/repo");
    await runner.execute("First message", "/repo");
    await runner.execute("Second message", "/repo");

    expect(adapter.execute).not.toHaveBeenCalled();
    const secondMessages = (llmClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[1][0];
    const secondPrompt = secondMessages[0].content;
    expect(secondPrompt).toContain("Previous conversation");
    expect(secondPrompt).toContain("First message");
  });

  it("limits direct model prompt history to the last 10 model-visible messages", async () => {
    const adapter = makeMockAdapter();
    const llmClient = makeRecordingLLMClient();
    const runner = new ChatRunner(makeDeps({ adapter, llmClient }));

    runner.startSession("/repo");
    for (let i = 1; i <= 12; i++) {
      await runner.execute(`Message ${i}`, "/repo");
    }

    await runner.execute("Message 13", "/repo");
    const lastMessages = (llmClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls[12][0];
    const lastPrompt = lastMessages[0].content;

    expect(lastPrompt).toContain("Message 12");
    const promptLines = lastPrompt.split("\n");
    const exactMsg1 = promptLines.find((line: string) => line === "User: Message 1");
    expect(exactMsg1).toBeUndefined();
  });
});
