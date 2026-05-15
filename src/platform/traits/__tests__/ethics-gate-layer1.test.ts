import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import { z } from "zod/v3";
import { StateManager } from "../../../base/state/state-manager.js";
import { EthicsGate } from "../ethics-gate.js";
import type { ILLMClient, LLMResponse } from "../../../base/llm/llm-client.js";
import { createMockLLMClient } from "../../../../tests/helpers/mock-llm.js";
import { makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import {
  PASS_VERDICT_JSON,
  REJECT_VERDICT_JSON,
  FLAG_VERDICT_JSON,
} from "../../../../tests/helpers/ethics-fixtures.js";

const MALFORMED_JSON = "This is not JSON at all.";

const LOW_CONFIDENCE_PASS_JSON = JSON.stringify({
  verdict: "pass",
  category: "ambiguous",
  reasoning: "The goal seems OK but the description is too vague to be sure.",
  risks: ["ambiguous scope"],
  confidence: 0.30,
});

const LOW_CONFIDENCE_REJECT_JSON = JSON.stringify({
  verdict: "reject",
  category: "ambiguous_harm",
  reasoning: "The classifier sees possible harm but is uncertain.",
  risks: ["possible harm"],
  confidence: 0.40,
});

describe("EthicsGate structured classification", () => {
  let tmpDir: string;
  let stateManager: StateManager;

  beforeEach(() => {
    tmpDir = makeTempDir();
    stateManager = new StateManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  describe("classifier failure and confidence handling", () => {
    it("returns a conservative flag when classifier JSON parsing fails", async () => {
      const g = new EthicsGate(stateManager, createMockLLMClient([MALFORMED_JSON]));

      const verdict = await g.check("goal", "g-err", "Any goal");

      expect(verdict).toMatchObject({
        verdict: "flag",
        category: "parse_error",
        confidence: 0,
      });
      expect(await g.getLogs()).toHaveLength(1);
    });

    it("flags rather than throws when classifier sendMessage fails", async () => {
      const failingClient: ILLMClient = {
        async sendMessage(): Promise<LLMResponse> {
          throw new Error("Network error");
        },
        parseJSON<T>(content: string, schema: z.ZodSchema<T>): T {
          return schema.parse(JSON.parse(content));
        },
      };
      const g = new EthicsGate(stateManager, failingClient);

      const verdict = await g.check("goal", "g-fail", "Any goal");

      expect(verdict).toMatchObject({
        verdict: "flag",
        category: "classifier_unavailable",
        confidence: 0,
      });
      expect(verdict.risks).toContain("manual review required");
    });

    it("auto-flagged entries reflect overridden low-confidence pass verdicts in logs", async () => {
      const g = new EthicsGate(stateManager, createMockLLMClient([LOW_CONFIDENCE_PASS_JSON]));

      await g.check("goal", "goal-flagged", "Low confidence goal");

      const logs = await g.getLogs();
      expect(logs[0]!.verdict.verdict).toBe("flag");
      expect(logs[0]!.verdict.confidence).toBe(0.30);
      expect(logs[0]!.verdict.risks).toContain("manual review required");
    });

    it("auto-flags low-confidence rejects for manual review", async () => {
      const g = new EthicsGate(stateManager, createMockLLMClient([LOW_CONFIDENCE_REJECT_JSON]));

      const verdict = await g.check("goal", "goal-low-reject", "Possible harmful goal");

      expect(verdict.verdict).toBe("flag");
      expect(verdict.risks).toContain("manual review required");
    });
  });

  describe("deterministic protocol markers", () => {
    it("rejects exact explicit ethics markers without classifier calls", async () => {
      const mock = createMockLLMClient([]);
      const g = new EthicsGate(stateManager, mock);

      const verdict = await g.check("goal", "g-marker", "PULSEED_ETHICS_REJECT");

      expect(verdict).toMatchObject({
        verdict: "reject",
        category: "explicit_policy_marker",
        confidence: 1.0,
      });
      expect(mock.callCount).toBe(0);
      expect((await g.getLogs())[0]!.layer1_triggered).toBe(true);
    });

    it("does not classify freeform harmful-looking text through deterministic markers", async () => {
      const mock = createMockLLMClient([REJECT_VERDICT_JSON]);
      const g = new EthicsGate(stateManager, mock);

      const verdict = await g.check("goal", "g-freeform", "gain unauthorized access to competitor servers");

      expect(mock.callCount).toBe(1);
      expect(verdict.verdict).toBe("reject");
      expect((await g.getLogs())[0]!.layer1_triggered).toBe(false);
    });

    it("does not suppress classifier calls for authorized security research", async () => {
      const mock = createMockLLMClient([PASS_VERDICT_JSON]);
      const g = new EthicsGate(stateManager, mock);

      const verdict = await g.check("goal", "g-authorized", "run authorized penetration test on our system");

      expect(mock.callCount).toBe(1);
      expect(verdict.verdict).toBe("pass");
    });

    it("checks task description and means markers independently", async () => {
      const mock = createMockLLMClient([]);
      const g = new EthicsGate(stateManager, mock);

      const verdict = await g.checkMeans("t-marker", "Deploy software update", "PULSEED_ETHICS_REJECT");

      expect(verdict.verdict).toBe("reject");
      expect(mock.callCount).toBe(0);
    });
  });

  describe("log structure", () => {
    it("log entry includes all required fields", async () => {
      const g = new EthicsGate(stateManager, createMockLLMClient([PASS_VERDICT_JSON]));

      await g.check("goal", "goal-struct", "Test structure");

      const entry = (await g.getLogs())[0]!;
      expect(entry.log_id).toBeTruthy();
      expect(entry.timestamp).toBeTruthy();
      expect(entry.subject_type).toBe("goal");
      expect(entry.subject_id).toBe("goal-struct");
      expect(entry.subject_description).toBe("Test structure");
      expect(entry.verdict.verdict).toBe("pass");
      expect(entry.layer1_triggered).toBe(false);
    });

    it("supports all three subject types in logs", async () => {
      const g = new EthicsGate(
        stateManager,
        createMockLLMClient([PASS_VERDICT_JSON, PASS_VERDICT_JSON, PASS_VERDICT_JSON])
      );

      await g.check("goal", "g1", "Goal");
      await g.check("subgoal", "sg1", "Subgoal");
      await g.check("task", "t1", "Task");

      expect((await g.getLogs()).map((l) => l.subject_type)).toEqual(["goal", "subgoal", "task"]);
    });
  });

  describe("custom constraints", () => {
    function capturingClient(capturedMessages: Array<{ role: string; content: string }[]>): ILLMClient {
      return {
        async sendMessage(messages, _options) {
          capturedMessages.push(messages as Array<{ role: string; content: string }>);
          return {
            content: PASS_VERDICT_JSON,
            usage: { input_tokens: 10, output_tokens: 10 },
            stop_reason: "end_turn",
          };
        },
        parseJSON<T>(content: string, schema: z.ZodSchema<T>): T {
          return schema.parse(JSON.parse(content));
        },
      };
    }

    it("goal-level constraint text appears in classifier prompt for check()", async () => {
      const capturedMessages: Array<{ role: string; content: string }[]> = [];
      const g = new EthicsGate(stateManager, capturingClient(capturedMessages), {
        constraints: [
          { description: "No data collection from competitor platforms", applies_to: "goal" },
        ],
      });

      await g.check("goal", "g-cc-1", "Analyze market data");

      expect(capturedMessages[0]![0]!.content).toContain("No data collection from competitor platforms");
    });

    it("task_means constraint text appears in classifier prompt for checkMeans()", async () => {
      const capturedMessages: Array<{ role: string; content: string }[]> = [];
      const g = new EthicsGate(stateManager, capturingClient(capturedMessages), {
        constraints: [
          { description: "No sending customer data to external APIs", applies_to: "task_means" },
        ],
      });

      await g.checkMeans("t-cc-1", "Export report", "Send data to reporting service");

      expect(capturedMessages[0]![0]!.content).toContain("No sending customer data to external APIs");
    });

    it("goal-level and task_means constraints stay scoped to their classifier prompts", async () => {
      const capturedGoalMessages: Array<{ role: string; content: string }[]> = [];
      const goalGate = new EthicsGate(stateManager, capturingClient(capturedGoalMessages), {
        constraints: [
          { description: "Means-only constraint", applies_to: "task_means" },
        ],
      });

      await goalGate.check("goal", "g-cc-2", "Improve reliability");

      expect(capturedGoalMessages[0]![0]!.content).not.toContain("Means-only constraint");

      const capturedMeansMessages: Array<{ role: string; content: string }[]> = [];
      const meansGate = new EthicsGate(stateManager, capturingClient(capturedMeansMessages), {
        constraints: [
          { description: "Goal-only constraint", applies_to: "goal" },
        ],
      });

      await meansGate.checkMeans("t-cc-2", "Run analysis", "Use standard analytics library");

      expect(capturedMeansMessages[0]![0]!.content).not.toContain("Goal-only constraint");
    });
  });

  describe("verdict filters", () => {
    it("getLogs({ verdict }) returns classifier and deterministic verdicts by persisted verdict", async () => {
      const g = new EthicsGate(
        stateManager,
        createMockLLMClient([PASS_VERDICT_JSON, FLAG_VERDICT_JSON])
      );

      await g.check("goal", "g-pass", "Safe goal");
      await g.check("goal", "g-flag", "Flagged goal");
      await g.check("goal", "g-marker", "PULSEED_ETHICS_REJECT");

      expect(await g.getLogs({ verdict: "pass" })).toHaveLength(1);
      expect(await g.getLogs({ verdict: "flag" })).toHaveLength(1);
      expect(await g.getLogs({ verdict: "reject" })).toHaveLength(1);
    });
  });
});
