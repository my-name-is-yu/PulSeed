import { describe, it, expect, vi, beforeEach } from "vitest";
import { TendCommand } from "../tend-command.js";
import type { TendDeps } from "../tend-command.js";
import type { ILLMClient, LLMResponse } from "../../../base/llm/llm-client.js";
import type { GoalNegotiator } from "../../../orchestrator/goal/goal-negotiator.js";
import type { DaemonClient } from "../../../runtime/daemon-client.js";
import type { StateManager } from "../../../base/state/state-manager.js";
import type { Goal } from "../../../base/types/goal.js";
import type { ChatMessage } from "../chat-history.js";

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
    startGoal: vi.fn().mockResolvedValue(undefined),
  } as unknown as DaemonClient;
}

function makeMockStateManager(goal: Goal | null = null): StateManager {
  return {
    loadGoal: vi.fn().mockResolvedValue(goal),
  } as unknown as StateManager;
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
      expect(daemonClient.startGoal).toHaveBeenCalledWith("goal-abc");
      expect(result.message).toContain("Started");
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

    it("ignores invalid max value", async () => {
      const goal = makeTestGoal();
      const deps = makeDeps({ stateManager: makeMockStateManager(goal) });
      const result = await cmd.execute("goal-abc --max abc", deps);
      expect(result.success).toBe(true);
      expect(result.message).not.toContain("max");
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
      expect(daemonClient.startGoal).toHaveBeenCalledWith("goal-abc");
    });

    it("handles empty string as no goal-id", async () => {
      const deps = makeDeps({ chatHistory: [] });
      const result = await cmd.execute("", deps);
      expect(result.success).toBe(false);
      expect(result.message).toContain("No conversation yet");
    });
  });
});
