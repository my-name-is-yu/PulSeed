import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TendCommand } from "../tend-command.js";
import type { TendDeps } from "../tend-command.js";
import type { ILLMClient, LLMResponse } from "../../../base/llm/llm-client.js";
import type { GoalNegotiator } from "../../../orchestrator/goal/goal-negotiator.js";
import type { DaemonClient } from "../../../runtime/daemon-client.js";
import type { StateManager } from "../../../base/state/state-manager.js";
import type { Goal } from "../../../base/types/goal.js";
import type { ChatMessage } from "../chat-history.js";
import { BackgroundRunLedger } from "../../../runtime/store/background-run-store.js";

// ─── Factories ───

function makeMockLLMClient(responseText = "Fix the login bug"): ILLMClient {
  const response: LLMResponse = {
    content: responseText,
    usage: { input_tokens: 10, output_tokens: 5 },
    stop_reason: "end_turn",
  };
  return {
    sendMessage: vi.fn().mockResolvedValue(response),
    parseJSON: vi.fn(),
  } as unknown as ILLMClient;
}

function makeTestGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "goal-abc",
    title: "Fix the login bug",
    description: "Resolve the authentication failure",
    status: "active",
    dimensions: [
      {
        name: "tests_passing",
        label: "Tests Passing",
        current_value: 80,
        threshold: { type: "min", value: 100 },
        confidence: 0.8,
        observation_method: { type: "shell", command: "echo ok" },
        last_updated: null,
        history: [],
        weight: 1.0,
        uncertainty_weight: null,
        state_integrity: "ok",
        dimension_mapping: null,
      },
    ],
    constraints: ["source: tend (auto-generated from chat)"],
    ...overrides,
  } as unknown as Goal;
}

function makeMockGoalNegotiator(goal: Goal): GoalNegotiator {
  return {
    negotiate: vi.fn().mockResolvedValue({
      goal,
      response: { accepted: true },
      log: {},
    }),
  } as unknown as GoalNegotiator;
}

function makeMockDaemonClient(): DaemonClient {
  return {
    startGoal: vi.fn().mockResolvedValue({ ok: true }),
  } as unknown as DaemonClient;
}

function makeMockStateManager(goal: Goal | null = null): StateManager {
  return {
    loadGoal: vi.fn().mockResolvedValue(goal),
    getBaseDir: vi.fn().mockReturnValue(fs.mkdtempSync(path.join(os.tmpdir(), "tend-state-"))),
  } as unknown as StateManager;
}

function makeMockBackgroundRunLedger() {
  return {
    create: vi.fn().mockImplementation(async (input) => ({
      schema_version: "background-run-v1",
      child_session_id: null,
      process_session_id: null,
      status: "queued",
      started_at: null,
      completed_at: null,
      summary: null,
      error: null,
      artifacts: [],
      ...input,
      created_at: input.created_at ?? "2026-04-25T00:00:00.000Z",
      updated_at: input.updated_at ?? "2026-04-25T00:00:00.000Z",
    })),
    terminal: vi.fn().mockResolvedValue(undefined),
  };
}

function makeChatHistory(): ChatMessage[] {
  return [
    { role: "user", content: "The login is broken", timestamp: new Date().toISOString(), turnIndex: 0 },
    { role: "assistant", content: "I can help fix that", timestamp: new Date().toISOString(), turnIndex: 1 },
  ];
}

function makeDeps(overrides: Partial<TendDeps> = {}): TendDeps {
  const goal = makeTestGoal();
  return {
    llmClient: makeMockLLMClient(),
    goalNegotiator: makeMockGoalNegotiator(goal),
    daemonClient: makeMockDaemonClient(),
    stateManager: makeMockStateManager(),
    chatHistory: makeChatHistory(),
    backgroundRunLedger: makeMockBackgroundRunLedger() as never,
    ...overrides,
  };
}

// ─── Tests ───

describe("TendCommand", () => {
  let cmd: TendCommand;

  beforeEach(() => {
    cmd = new TendCommand();
  });

  describe("summarizeChat", () => {
    it("returns LLM summary from chat history", async () => {
      const history: ChatMessage[] = [
        { role: "user", content: "Fix the login bug", timestamp: new Date().toISOString(), turnIndex: 0 },
        { role: "assistant", content: "Sure, I'll look into it", timestamp: new Date().toISOString(), turnIndex: 1 },
      ];
      const llmClient = makeMockLLMClient("Fix the login authentication bug");
      const result = await cmd.summarizeChat(history, llmClient);
      expect(result).toBe("Fix the login authentication bug");
      expect(llmClient.sendMessage).toHaveBeenCalledOnce();
    });

    it("handles empty history gracefully by passing empty transcript", async () => {
      const llmClient = makeMockLLMClient("No context provided");
      const result = await cmd.summarizeChat([], llmClient);
      expect(typeof result).toBe("string");
      expect(llmClient.sendMessage).toHaveBeenCalledOnce();
    });

    it("throws with helpful message when LLM fails", async () => {
      const llmClient = {
        sendMessage: vi.fn().mockRejectedValue(new Error("Network timeout")),
      } as unknown as ILLMClient;
      const history: ChatMessage[] = [
        { role: "user", content: "Fix the bug", timestamp: new Date().toISOString(), turnIndex: 0 },
      ];
      await expect(cmd.summarizeChat(history, llmClient)).rejects.toThrow("Failed to summarize chat");
    });
  });

  describe("generateGoal", () => {
    it("calls goalNegotiator.negotiate with the summary and correct constraints", async () => {
      const goal = makeTestGoal();
      const goalNegotiator = makeMockGoalNegotiator(goal);
      const result = await cmd.generateGoal("Fix the login bug", goalNegotiator);
      expect(goalNegotiator.negotiate).toHaveBeenCalledWith("Fix the login bug", {
        constraints: ["source: tend (auto-generated from chat)"],
        timeoutMs: 300_000,
      });
      expect(result.id).toBe(goal.id);
    });
  });

  describe("formatConfirmation", () => {
    it("formats goal title and dimensions correctly", () => {
      const goal = makeTestGoal();
      const output = cmd.formatConfirmation(goal);
      expect(output).toContain("🌱 Tend to this goal?");
      expect(output).toContain("Fix the login bug");
      expect(output).toContain("tests_passing");
      expect(output).toContain("min 100");
      expect(output).toContain("[Y/n]");
    });

    it("includes constraints when present", () => {
      const goal = makeTestGoal({ constraints: ["no external APIs"] });
      const output = cmd.formatConfirmation(goal);
      expect(output).toContain("Constraints:");
      expect(output).toContain("no external APIs");
    });

    it("formats range threshold correctly", () => {
      const goal = makeTestGoal();
      (goal.dimensions[0] as any).threshold = { type: "range", low: 70, high: 90 };
      const output = cmd.formatConfirmation(goal);
      expect(output).toContain("70–90");
    });

    it("formats present threshold correctly", () => {
      const goal = makeTestGoal();
      (goal.dimensions[0] as any).threshold = { type: "present" };
      const output = cmd.formatConfirmation(goal);
      expect(output).toContain("present");
    });

    it("formats match threshold correctly", () => {
      const goal = makeTestGoal();
      (goal.dimensions[0] as any).threshold = { type: "match", value: "green" };
      const output = cmd.formatConfirmation(goal);
      expect(output).toContain("match: green");
    });
  });

  describe("execute with goal-id", () => {
    it("validates goal exists and starts daemon", async () => {
      const goal = makeTestGoal();
      const daemonClient = makeMockDaemonClient();
      const deps = makeDeps({
        daemonClient,
        stateManager: makeMockStateManager(goal),
      });
      const result = await cmd.execute("goal-abc", deps);
      expect(result.success).toBe(true);
      expect(result.goalId).toBe("goal-abc");
      expect(daemonClient.startGoal).toHaveBeenCalledWith("goal-abc", expect.objectContaining({
        backgroundRun: expect.objectContaining({
          backgroundRunId: expect.stringMatching(/^run:coreloop:/),
        }),
      }));
      expect(result.message).toContain("Started");
    });

    it("creates a DurableLoop background run with compatible wire tokens and forwarded metadata", async () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tend-bg-"));
      const runtimeRoot = path.join(tmpDir, "runtime");
      const goal = makeTestGoal();
      const ledger = new BackgroundRunLedger(runtimeRoot);
      await ledger.ensureReady();
      const daemonClient = makeMockDaemonClient();
      const deps = makeDeps({
        daemonClient,
        stateManager: makeMockStateManager(goal),
        sessionId: "chat-session-1",
        workspace: "/repo",
        replyTarget: {
          surface: "gateway",
          channel: "plugin_gateway",
          conversation_id: "C123",
          message_id: "1710000000.000100",
          deliveryMode: "thread_reply",
          metadata: { team: "T123" },
        },
        backgroundRunLedger: ledger,
      });

      try {
        const result = await cmd.execute("goal-abc", deps);
        expect(result.success).toBe(true);
        expect(result.backgroundRunId).toMatch(/^run:coreloop:/);
        expect(result.message).toContain(result.backgroundRunId!);
        const run = await ledger.load(result.backgroundRunId!);

        expect(run).toMatchObject({
          id: result.backgroundRunId,
          kind: "coreloop_run",
          parent_session_id: "session:conversation:chat-session-1",
          status: "queued",
          notify_policy: "done_only",
          reply_target_source: "pinned_run",
          pinned_reply_target: expect.objectContaining({
            channel: "plugin_gateway",
            target_id: "C123",
            thread_id: "1710000000.000100",
          }),
          title: "Fix the login bug",
          workspace: "/repo",
        });
        expect(run?.source_refs).toEqual([
          expect.objectContaining({
            kind: "chat_session",
            id: "chat-session-1",
            relative_path: "chat/sessions/chat-session-1.json",
          }),
        ]);
        expect(daemonClient.startGoal).toHaveBeenCalledWith("goal-abc", {
          backgroundRun: expect.objectContaining({
            backgroundRunId: result.backgroundRunId,
            parentSessionId: "session:conversation:chat-session-1",
            notifyPolicy: "done_only",
            replyTargetSource: "pinned_run",
            pinnedReplyTarget: expect.objectContaining({
              channel: "plugin_gateway",
              target_id: "C123",
            }),
          }),
        });
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it("writes the background run to configured daemon runtime_root", async () => {
      const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "tend-runtime-root-"));
      fs.writeFileSync(path.join(baseDir, "daemon.json"), JSON.stringify({
        runtime_root: "runtime-v2",
      }), "utf-8");
      const daemonRuntimeRoot = path.join(baseDir, "runtime-v2");
      const goal = makeTestGoal();
      const daemonClient = makeMockDaemonClient();
      const stateManager = {
        ...makeMockStateManager(goal),
        getBaseDir: vi.fn().mockReturnValue(baseDir),
      } as unknown as StateManager;
      const deps = makeDeps({
        daemonClient,
        stateManager,
        sessionId: "chat-runtime-root",
        backgroundRunLedger: undefined,
      });

      try {
        const result = await cmd.execute("goal-abc", deps);

        expect(result.success).toBe(true);
        expect(result.backgroundRunId).toMatch(/^run:coreloop:/);
        const run = await new BackgroundRunLedger(daemonRuntimeRoot).load(result.backgroundRunId!);
        expect(run).toMatchObject({
          id: result.backgroundRunId,
          kind: "coreloop_run",
          parent_session_id: "session:conversation:chat-runtime-root",
          status: "queued",
        });
      } finally {
        fs.rmSync(baseDir, { recursive: true, force: true });
      }
    });

    it("prefers the running daemon-state runtime_root used by external --config", async () => {
      const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "tend-daemon-state-root-"));
      const daemonRuntimeRoot = path.join(baseDir, "external-runtime");
      fs.writeFileSync(path.join(baseDir, "daemon-state.json"), JSON.stringify({
        pid: process.pid,
        started_at: "2026-04-25T00:00:00.000Z",
        last_loop_at: null,
        loop_count: 0,
        active_goals: ["goal-abc"],
        status: "running",
        runtime_root: daemonRuntimeRoot,
        crash_count: 0,
        last_error: null,
        last_resident_at: null,
        resident_activity: null,
      }), "utf-8");
      const goal = makeTestGoal();
      const stateManager = {
        ...makeMockStateManager(goal),
        getBaseDir: vi.fn().mockReturnValue(baseDir),
      } as unknown as StateManager;
      const deps = makeDeps({
        daemonClient: makeMockDaemonClient(),
        stateManager,
        sessionId: "chat-external-runtime",
        backgroundRunLedger: undefined,
      });

      try {
        const result = await cmd.execute("goal-abc", deps);

        expect(result.success).toBe(true);
        const run = await new BackgroundRunLedger(daemonRuntimeRoot).load(result.backgroundRunId!);
        expect(run).toMatchObject({
          id: result.backgroundRunId,
          parent_session_id: "session:conversation:chat-external-runtime",
          status: "queued",
        });
        expect(await new BackgroundRunLedger(path.join(baseDir, "runtime")).load(result.backgroundRunId!)).toBeNull();
      } finally {
        fs.rmSync(baseDir, { recursive: true, force: true });
      }
    });

    it("returns error for non-existent goal", async () => {
      const deps = makeDeps({ stateManager: makeMockStateManager(null) });
      const result = await cmd.execute("missing-goal", deps);
      expect(result.success).toBe(false);
      expect(result.message).toContain("Goal not found");
      expect(result.message).toContain("missing-goal");
    });

    it("returns error when daemon is unavailable", async () => {
      const goal = makeTestGoal();
      const daemonClient = {
        startGoal: vi.fn().mockRejectedValue(new Error("Connection refused")),
      } as unknown as DaemonClient;
      const deps = makeDeps({ daemonClient, stateManager: makeMockStateManager(goal) });
      const result = await cmd.execute("goal-abc", deps);
      expect(result.success).toBe(false);
      expect(result.message).toContain("Daemon unavailable");
    });
  });

  describe("execute without goal-id", () => {
    it("summarizes chat, generates goal, returns confirmation", async () => {
      const goal = makeTestGoal();
      const deps = makeDeps({
        llmClient: makeMockLLMClient("Fix the login bug"),
        goalNegotiator: makeMockGoalNegotiator(goal),
      });
      const result = await cmd.execute("", deps);
      expect(result.success).toBe(true);
      expect(result.needsConfirmation).toBe(true);
      expect(result.confirmation).toBeDefined();
      expect(result.confirmation).toContain("🌱 Tend to this goal?");
      expect(result.goalId).toBe("goal-abc");
    });

    it("handles empty chat history", async () => {
      const deps = makeDeps({ chatHistory: [] });
      const result = await cmd.execute("", deps);
      expect(result.success).toBe(false);
      expect(result.message).toContain("No conversation yet");
    });

    it("returns error when LLM summarization fails", async () => {
      const failingLLM = {
        sendMessage: vi.fn().mockRejectedValue(new Error("API down")),
      } as unknown as ILLMClient;
      const deps = makeDeps({ llmClient: failingLLM });
      const result = await cmd.execute("", deps);
      expect(result.success).toBe(false);
      expect(result.message).toContain("Could not summarize chat");
    });

    it("returns error when goal generation fails", async () => {
      const failingNegotiator = {
        negotiate: vi.fn().mockRejectedValue(new Error("LLM timeout")),
      } as unknown as GoalNegotiator;
      const deps = makeDeps({ goalNegotiator: failingNegotiator });
      const result = await cmd.execute("", deps);
      expect(result.success).toBe(false);
      expect(result.message).toContain("Could not generate goal");
    });
  });

  describe("execute with --max flag", () => {
    it("includes max iterations note in success message", async () => {
      const goal = makeTestGoal();
      const deps = makeDeps({ stateManager: makeMockStateManager(goal) });
      const result = await cmd.execute("goal-abc --max 10", deps);
      expect(result.success).toBe(true);
      expect(result.message).toContain("max 10 iterations");
    });

    it("rejects invalid max value before daemon start", async () => {
      const goal = makeTestGoal();
      const daemonClient = makeMockDaemonClient();
      const deps = makeDeps({ stateManager: makeMockStateManager(goal), daemonClient });
      const result = await cmd.execute("goal-abc --max abc", deps);
      expect(result.success).toBe(false);
      expect(result.message).toContain("Usage: /tend [goal-id] [--max <positive-integer>]");
      expect(result.message).toContain("--max must be a positive integer");
      expect(daemonClient.startGoal).not.toHaveBeenCalled();
    });

    it("rejects non-decimal max syntax before daemon start", async () => {
      const daemonClient = makeMockDaemonClient();
      const deps = makeDeps({ stateManager: makeMockStateManager(makeTestGoal()), daemonClient });
      const result = await cmd.execute("goal-abc --max 1e3", deps);
      expect(result.success).toBe(false);
      expect(result.message).toContain("--max must be a positive integer");
      expect(daemonClient.startGoal).not.toHaveBeenCalled();
    });
  });

  describe("parseArgs (via execute)", () => {
    it("handles --max before goal-id", async () => {
      const goal = makeTestGoal();
      const deps = makeDeps({ stateManager: makeMockStateManager(goal) });
      const result = await cmd.execute("--max 5 goal-abc", deps);
      expect(result.success).toBe(true);
      expect(result.message).toContain("max 5 iterations");
    });

    it("handles just a goal-id with no flags", async () => {
      const goal = makeTestGoal();
      const daemonClient = makeMockDaemonClient();
      const deps = makeDeps({ stateManager: makeMockStateManager(goal), daemonClient });
      const result = await cmd.execute("goal-abc", deps);
      expect(result.success).toBe(true);
      expect(daemonClient.startGoal).toHaveBeenCalledWith("goal-abc", expect.any(Object));
    });

    it("handles empty string as no goal-id", async () => {
      const deps = makeDeps({ chatHistory: [] });
      const result = await cmd.execute("", deps);
      expect(result.success).toBe(false);
      expect(result.message).toContain("No conversation yet");
    });

    it("rejects missing max value before daemon start", async () => {
      const daemonClient = makeMockDaemonClient();
      const deps = makeDeps({ stateManager: makeMockStateManager(makeTestGoal()), daemonClient });
      const result = await cmd.execute("goal-abc --max", deps);
      expect(result.success).toBe(false);
      expect(result.message).toContain("Missing value for --max");
      expect(daemonClient.startGoal).not.toHaveBeenCalled();
    });

    it("rejects unknown flags before daemon start", async () => {
      const daemonClient = makeMockDaemonClient();
      const deps = makeDeps({ stateManager: makeMockStateManager(makeTestGoal()), daemonClient });
      const result = await cmd.execute("goal-abc --background", deps);
      expect(result.success).toBe(false);
      expect(result.message).toContain("Unknown option: --background");
      expect(daemonClient.startGoal).not.toHaveBeenCalled();
    });

    it("rejects multiple goal ids before daemon start", async () => {
      const daemonClient = makeMockDaemonClient();
      const deps = makeDeps({ stateManager: makeMockStateManager(makeTestGoal()), daemonClient });
      const result = await cmd.execute("goal-abc goal-def", deps);
      expect(result.success).toBe(false);
      expect(result.message).toContain("Expected at most one goal id");
      expect(daemonClient.startGoal).not.toHaveBeenCalled();
    });

    it("rejects duplicate max options before daemon start", async () => {
      const daemonClient = makeMockDaemonClient();
      const deps = makeDeps({ stateManager: makeMockStateManager(makeTestGoal()), daemonClient });
      const result = await cmd.execute("goal-abc --max 1 --max 1000", deps);
      expect(result.success).toBe(false);
      expect(result.message).toContain("Expected at most one --max option");
      expect(daemonClient.startGoal).not.toHaveBeenCalled();
    });
  });
});
