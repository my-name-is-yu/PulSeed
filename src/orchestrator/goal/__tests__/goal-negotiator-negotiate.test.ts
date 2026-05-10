import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { StateManager } from "../../../base/state/state-manager.js";
import { EthicsGate } from "../../../platform/traits/ethics-gate.js";
import { ObservationEngine } from "../../../platform/observation/observation-engine.js";
import { GoalNegotiator } from "../goal-negotiator.js";
import { GoalOrchestrationStateStore } from "../../../runtime/store/goal-orchestration-state-store.js";
import { createMockLLMClient } from "../../../../tests/helpers/mock-llm.js";
import { makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import {
  PASS_VERDICT_SAFE_JSON as PASS_VERDICT,
  REJECT_VERDICT_ILLEGAL_JSON as REJECT_VERDICT,
} from "../../../../tests/helpers/ethics-fixtures.js";

const SINGLE_DIMENSION_RESPONSE = JSON.stringify([
  {
    name: "completion_rate",
    label: "Completion Rate",
    threshold_type: "min",
    threshold_value: 100,
    observation_method_hint: "Check task completion metrics",
  },
]);

const DIMENSIONS_RESPONSE = JSON.stringify([
  {
    name: "test_coverage",
    label: "Test Coverage",
    threshold_type: "min",
    threshold_value: 80,
    observation_method_hint: "Run test suite and check coverage report",
  },
  {
    name: "code_quality",
    label: "Code Quality Score",
    threshold_type: "min",
    threshold_value: 90,
    observation_method_hint: "Run linter and code analysis tools",
  },
]);

const FEASIBILITY_REALISTIC = JSON.stringify({
  assessment: "realistic",
  confidence: "high",
  reasoning: "This target is achievable within the time horizon.",
  key_assumptions: ["Current pace maintained"],
  main_risks: [],
});

const FEASIBILITY_AMBITIOUS = JSON.stringify({
  assessment: "ambitious",
  confidence: "medium",
  reasoning: "This target is ambitious but possible.",
  key_assumptions: ["Increased effort required"],
  main_risks: ["May require extra resources"],
});

const FEASIBILITY_INFEASIBLE = JSON.stringify({
  assessment: "infeasible",
  confidence: "low",
  reasoning: "This target is not achievable in the given timeframe.",
  key_assumptions: ["No acceleration possible"],
  main_risks: ["Target unreachable", "Burnout risk"],
});

const RESPONSE_MESSAGE_ACCEPT = "Your goal has been accepted. Let's get started!";
const RESPONSE_MESSAGE_COUNTER = "This goal is too ambitious. Consider a safer target.";
const RESPONSE_MESSAGE_FLAG = "This goal is ambitious. Please review the risks carefully.";

describe("GoalNegotiator", () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let observationEngine: ObservationEngine;

  beforeEach(() => {
    tmpDir = makeTempDir();
    stateManager = new StateManager(tmpDir);
    observationEngine = new ObservationEngine(stateManager);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true , maxRetries: 3, retryDelay: 100 });
  });

  // ─── negotiate() — Dimension Decomposition ───

  describe("negotiate() dimension decomposition", () => {
    it("does not persist a goal when timeout wins before commit", async () => {
      let callCount = 0;
      const slowLLM = {
        sendMessage: vi.fn(async () => {
          const index = callCount++;
          if (index === 0) {
            return {
              content: SINGLE_DIMENSION_RESPONSE,
              usage: { input_tokens: 10, output_tokens: SINGLE_DIMENSION_RESPONSE.length },
              stop_reason: "end_turn",
            };
          }
          if (index === 1) {
            return {
              content: FEASIBILITY_REALISTIC,
              usage: { input_tokens: 10, output_tokens: FEASIBILITY_REALISTIC.length },
              stop_reason: "end_turn",
            };
          }
          return new Promise((resolve) => {
            setTimeout(() => {
              resolve({
                content: RESPONSE_MESSAGE_ACCEPT,
                usage: { input_tokens: 10, output_tokens: RESPONSE_MESSAGE_ACCEPT.length },
                stop_reason: "end_turn",
              });
            }, 200);
          });
        }),
        parseJSON: <T,>(content: string, schema: { parse: (value: unknown) => T }) => schema.parse(JSON.parse(content)),
      };
      const ethicsGate = {
        check: vi.fn().mockResolvedValue(JSON.parse(PASS_VERDICT)),
      };
      const negotiator = new GoalNegotiator(stateManager, slowLLM as never, ethicsGate as unknown as EthicsGate, observationEngine);

      const result = negotiator.negotiate("Slow goal", { timeoutMs: 100 });
      const observed = result.then(
        () => null,
        (err) => err
      );

      for (let attempt = 0; attempt < 10 && slowLLM.sendMessage.mock.calls.length < 3; attempt += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(slowLLM.sendMessage).toHaveBeenCalledTimes(3);

      await new Promise((resolve) => setTimeout(resolve, 120));
      const err = await observed;
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBe("Goal negotiation timed out after 100ms");

      await new Promise((resolve) => setTimeout(resolve, 200));
      await Promise.resolve();
      await Promise.resolve();
      expect(await stateManager.listGoalIds()).toEqual([]);
    });

    it("records decomposition in negotiation log", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        DIMENSIONS_RESPONSE,
        FEASIBILITY_REALISTIC,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Test goal");
      expect(result.log.step2_decomposition).not.toBeNull();
      expect(result.log.step2_decomposition!.method).toBe("llm");
      expect(result.log.step2_decomposition!.dimensions).toHaveLength(2);
    });

    it("decomposes into correct dimension names", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        DIMENSIONS_RESPONSE,
        FEASIBILITY_REALISTIC,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Test goal");
      const dimNames = result.log.step2_decomposition!.dimensions.map((d) => d.name);
      expect(dimNames).toContain("test_coverage");
      expect(dimNames).toContain("code_quality");
    });

    it("handles single dimension", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Simple goal");
      expect(result.goal.dimensions).toHaveLength(1);
      expect(result.goal.dimensions[0]!.name).toBe("completion_rate");
    });

    it("does not silently map paraphrased dimensions to unrelated DataSource dimensions", async () => {
      const paraphrasedDimension = JSON.stringify([
        {
          name: "shipping_readiness",
          label: "Shipping Readiness",
          threshold_type: "min",
          threshold_value: 0.9,
          observation_method_hint: "Review release checklist evidence",
          dimension_mapping: null,
        },
      ]);
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        paraphrasedDimension,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);
      const mockObsEngine = {
        getAvailableDimensionInfo(): Array<{ name: string; dimensions: string[] }> {
          return [{ name: "github_issues", dimensions: ["completion_ratio", "open_issue_count"] }];
        },
      } as unknown as ObservationEngine;
      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, mockObsEngine);

      const result = await negotiator.negotiate("Confirm the release is ready to ship");

      expect(result.goal.dimensions[0]?.name).toBe("shipping_readiness");
      expect(result.log.step2_decomposition?.dimensions[0]?.dimension_mapping).toBeNull();
    });

    it("keeps substring collisions unknown instead of mutating the dimension name", async () => {
      const substringCollision = JSON.stringify([
        {
          name: "coverage",
          label: "Coverage",
          threshold_type: "min",
          threshold_value: 0.95,
          observation_method_hint: "Review narrative coverage of requirements",
          dimension_mapping: null,
        },
      ]);
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        substringCollision,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);
      const mockObsEngine = {
        getAvailableDimensionInfo(): Array<{ name: string; dimensions: string[] }> {
          return [{ name: "ci", dimensions: ["test_coverage_percent", "branch_coverage_percent"] }];
        },
      } as unknown as ObservationEngine;
      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, mockObsEngine);

      const result = await negotiator.negotiate("Improve requirement coverage");

      expect(result.goal.dimensions[0]?.name).toBe("coverage");
      expect(result.log.step2_decomposition?.dimensions[0]?.dimension_mapping).toBeNull();
    });

    it("preserves explicit typed DataSource mapping metadata in the production negotiation log", async () => {
      const typedMappedDimension = JSON.stringify([
        {
          name: "test_coverage",
          label: "Test Coverage",
          threshold_type: "min",
          threshold_value: 80,
          observation_method_hint: "Use CI coverage report",
          dimension_mapping: {
            kind: "data_source",
            data_source: "ci",
            dimension: "test_coverage_percent",
            confidence: "high",
            rationale: "CI exposes the exact coverage percentage",
          },
        },
      ]);
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        typedMappedDimension,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);
      const mockObsEngine = {
        getAvailableDimensionInfo(): Array<{ name: string; dimensions: string[] }> {
          return [{ name: "ci", dimensions: ["test_coverage_percent"] }];
        },
      } as unknown as ObservationEngine;
      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, mockObsEngine);

      const result = await negotiator.negotiate("Raise automated test coverage");

      expect(result.goal.dimensions[0]?.name).toBe("test_coverage");
      expect(result.log.step2_decomposition?.dimensions[0]?.dimension_mapping).toEqual({
        kind: "data_source",
        data_source: "ci",
        dimension: "test_coverage_percent",
        confidence: "high",
        rationale: "CI exposes the exact coverage percentage",
      });
    });
  });

  // ─── negotiate() — Baseline Observation ───

  describe("negotiate() baseline observation", () => {
    it("records baseline in negotiation log", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Test goal");
      expect(result.log.step3_baseline).not.toBeNull();
      expect(result.log.step3_baseline!.observations).toHaveLength(1);
    });

    it("sets null value for new goal baseline", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Test goal");
      const obs = result.log.step3_baseline!.observations[0]!;
      expect(obs.value).toBeNull();
      expect(obs.confidence).toBe(0);
    });

    it("sets method to initial_baseline for new goals", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Test goal");
      expect(result.log.step3_baseline!.observations[0]!.method).toBe("initial_baseline");
    });
  });

  // ─── negotiate() — Feasibility Evaluation ───

  describe("negotiate() feasibility evaluation", () => {
    it("records feasibility in negotiation log", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Test goal");
      expect(result.log.step4_evaluation).not.toBeNull();
      expect(result.log.step4_evaluation!.dimensions).toHaveLength(1);
    });

    it("realistic assessment results in accept response", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Test goal");
      expect(result.response.type).toBe("accept");
      expect(result.response.accepted).toBe(true);
    });

    it("ambitious assessment results in accept response", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_AMBITIOUS,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Ambitious goal");
      // Ambitious with medium confidence -> could be accept or flag_as_ambitious
      expect(["accept", "flag_as_ambitious"]).toContain(result.response.type);
    });

    it("infeasible assessment results in counter_propose response", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_INFEASIBLE,
        RESPONSE_MESSAGE_COUNTER,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Unrealistic goal");
      expect(result.response.type).toBe("counter_propose");
      expect(result.response.accepted).toBe(false);
    });

    it("counter_propose includes counter_proposal object", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_INFEASIBLE,
        RESPONSE_MESSAGE_COUNTER,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Unrealistic goal");
      expect(result.response.counter_proposal).toBeDefined();
      expect(typeof result.response.counter_proposal!.realistic_target).toBe("number");
      expect(typeof result.response.counter_proposal!.reasoning).toBe("string");
    });

    it("low confidence feasibility results in flag_as_ambitious", async () => {
      const lowConfFeasibility = JSON.stringify({
        assessment: "ambitious",
        confidence: "low",
        reasoning: "Very uncertain outcome.",
        key_assumptions: ["Many unknowns"],
        main_risks: ["High uncertainty"],
      });

      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        lowConfFeasibility,
        RESPONSE_MESSAGE_FLAG,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Uncertain goal");
      expect(result.response.type).toBe("flag_as_ambitious");
      expect(result.response.initial_confidence).toBe("low");
    });

    it("qualitative path is used when no baseline exists", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("New domain goal");
      expect(result.log.step4_evaluation!.dimensions[0]!.path).toBe("qualitative");
    });
  });

  // ─── negotiate() — Response Generation ───

  describe("negotiate() response generation", () => {
    it("response has type field", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Test goal");
      expect(["accept", "counter_propose", "flag_as_ambitious"]).toContain(result.response.type);
    });

    it("response has message from LLM", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Test goal");
      expect(result.response.message).toBeTruthy();
      expect(result.response.message.length).toBeGreaterThan(0);
    });

    it("accept response has accepted=true", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Test goal");
      expect(result.response.accepted).toBe(true);
    });

    it("counter_propose response has accepted=false", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_INFEASIBLE,
        RESPONSE_MESSAGE_COUNTER,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Unrealistic goal");
      expect(result.response.accepted).toBe(false);
    });

    it("response records step5 in log", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Test goal");
      expect(result.log.step5_response).not.toBeNull();
      expect(result.log.step5_response!.type).toBe("accept");
      expect(result.log.step5_response!.accepted).toBe(true);
    });
  });

  // ─── Counter Proposal Calculation ───

  describe("counter proposal calculation", () => {
    it("calculateRealisticTarget uses acceleration factor 1.3", () => {
      // baseline=50, changeRate=1/day, 90 days
      const target = GoalNegotiator.calculateRealisticTarget(50, 1, 90);
      expect(target).toBeCloseTo(50 + 1 * 90 * 1.3);
      expect(target).toBeCloseTo(167);
    });

    it("calculateRealisticTarget with zero change rate returns baseline", () => {
      const target = GoalNegotiator.calculateRealisticTarget(50, 0, 90);
      expect(target).toBe(50);
    });

    it("calculateRealisticTarget with small change rate", () => {
      const target = GoalNegotiator.calculateRealisticTarget(10, 0.5, 30);
      expect(target).toBeCloseTo(10 + 0.5 * 30 * 1.3);
    });
  });

  // ─── getNegotiationLog() ───

  describe("await getNegotiationLog()", () => {
    it("returns null when no log exists", async () => {
      const mockLLM = createMockLLMClient([]);
      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const log = await negotiator.getNegotiationLog("nonexistent");
      expect(log).toBeNull();
    });

    it("returns saved log after negotiation", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Test goal");
      const log = await negotiator.getNegotiationLog(result.goal.id);
      expect(log).not.toBeNull();
      expect(log!.goal_id).toBe(result.goal.id);
    });

    it("persisted log has all steps populated", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Test goal");
      const log = await negotiator.getNegotiationLog(result.goal.id);

      expect(log!.step2_decomposition).not.toBeNull();
      expect(log!.step3_baseline).not.toBeNull();
      expect(log!.step4_evaluation).not.toBeNull();
      expect(log!.step5_response).not.toBeNull();
    });

    it("persisted log is_renegotiation is false for initial negotiation", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Test goal");
      const log = await negotiator.getNegotiationLog(result.goal.id);
      expect(log!.is_renegotiation).toBe(false);
    });

    it("log is persisted to typed control DB state without writing the legacy file", async () => {
      const mockLLM = createMockLLMClient([
        PASS_VERDICT,
        SINGLE_DIMENSION_RESPONSE,
        FEASIBILITY_REALISTIC,
        RESPONSE_MESSAGE_ACCEPT,
      ]);

      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      const result = await negotiator.negotiate("Test goal");
      const logPath = path.join(tmpDir, "goals", result.goal.id, "negotiation-log.json");
      expect(fs.existsSync(logPath)).toBe(false);

      const persisted = await new GoalOrchestrationStateStore(tmpDir).loadNegotiationLog(result.goal.id);
      expect(persisted?.goal_id).toBe(result.goal.id);
      expect(persisted?.step5_response?.type).toBe("accept");
    });

    it("does not treat stale legacy negotiation-log files as authoritative", async () => {
      const legacyGoalId = "legacy-goal";
      const logDir = path.join(tmpDir, "goals", legacyGoalId);
      fs.mkdirSync(logDir, { recursive: true });
      fs.writeFileSync(path.join(logDir, "negotiation-log.json"), JSON.stringify({
        goal_id: legacyGoalId,
        timestamp: "2020-01-01T00:00:00.000Z",
        is_renegotiation: false,
        renegotiation_trigger: null,
      }));

      const mockLLM = createMockLLMClient([]);
      const ethicsGate = new EthicsGate(stateManager, mockLLM);
      const negotiator = new GoalNegotiator(stateManager, mockLLM, ethicsGate, observationEngine);

      await expect(negotiator.getNegotiationLog(legacyGoalId)).resolves.toBeNull();
    });
  });
});
