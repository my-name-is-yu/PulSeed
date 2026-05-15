import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import { z } from "zod/v3";
import { StateManager } from "../../../base/state/state-manager.js";
import { StrategyManager } from "../strategy-manager.js";
import type { ILLMClient } from "../../../base/llm/llm-client.js";
import { createMockLLMClient } from "../../../../tests/helpers/mock-llm.js";
import { makeGoal } from "../../../../tests/helpers/fixtures.js";
import { makeTempDir } from "../../../../tests/helpers/temp-dir.js";

// ─── Fixtures ───

const CANDIDATE_RESPONSE_ONE = `\`\`\`json
[
  {
    "hypothesis": "Increase daily writing output by dedicating the first 2 hours of each day to writing",
    "expected_effect": [
      { "dimension": "word_count", "direction": "increase", "magnitude": "medium" }
    ],
    "resource_estimate": {
      "sessions": 10,
      "duration": { "value": 14, "unit": "days" },
      "llm_calls": null
    },
    "allocation": 0.8
  }
]
\`\`\``;

const CANDIDATE_RESPONSE_TWO = `\`\`\`json
[
  {
    "hypothesis": "Use the Pomodoro technique for focused research sessions",
    "expected_effect": [
      { "dimension": "research_depth", "direction": "increase", "magnitude": "large" }
    ],
    "resource_estimate": {
      "sessions": 5,
      "duration": { "value": 7, "unit": "days" },
      "llm_calls": 2
    },
    "allocation": 0.6
  },
  {
    "hypothesis": "Create a structured outline before each writing session",
    "expected_effect": [
      { "dimension": "word_count", "direction": "increase", "magnitude": "small" }
    ],
    "resource_estimate": {
      "sessions": 3,
      "duration": { "value": 3, "unit": "days" },
      "llm_calls": null
    },
    "allocation": 0.4
  }
]
\`\`\``;

const EMPTY_CANDIDATES_RESPONSE = `\`\`\`json
[]
\`\`\``;

const KAGGLE_LOCAL_SEARCH_RESPONSE = `\`\`\`json
[
  {
    "hypothesis": "Tune CatBoost class weights and threshold calibration for the irrigation benchmark",
    "expected_effect": [
      { "dimension": "balanced_accuracy", "direction": "increase", "magnitude": "medium" }
    ],
    "resource_estimate": {
      "sessions": 2,
      "duration": { "value": 4, "unit": "hours" },
      "llm_calls": 1
    },
    "allocation": 0.8
  }
]
\`\`\``;

const NEAR_STALL_RECOVERY_RESPONSE = `\`\`\`json
[
  {
    "hypothesis": "Tune CatBoost class weights around the current threshold calibration",
    "expected_effect": [
      { "dimension": "balanced_accuracy", "direction": "increase", "magnitude": "small" }
    ],
    "resource_estimate": {
      "sessions": 2,
      "duration": { "value": 3, "unit": "hours" },
      "llm_calls": 1
    },
    "allocation": 0.3
  },
  {
    "hypothesis": "Search finer threshold and calibration bias around the current CatBoost model",
    "expected_effect": [
      { "dimension": "balanced_accuracy", "direction": "increase", "magnitude": "small" }
    ],
    "resource_estimate": {
      "sessions": 2,
      "duration": { "value": 3, "unit": "hours" },
      "llm_calls": 1
    },
    "allocation": 0.3
  }
]
\`\`\``;

const PARAPHRASE_MULTILINGUAL_RECOVERY_RESPONSE = `\`\`\`json
[
  {
    "hypothesis": "Adjust the learner cutoff and rebalance weights around the same validation plateau",
    "expected_effect": [
      { "dimension": "balanced_accuracy", "direction": "increase", "magnitude": "small" }
    ],
    "resource_estimate": {
      "sessions": 2,
      "duration": { "value": 3, "unit": "hours" },
      "llm_calls": 1
    },
    "allocation": 0.3
  },
  {
    "hypothesis": "現在の分類器のしきい値を少し調整して停滞を確認する",
    "expected_effect": [
      { "dimension": "balanced_accuracy", "direction": "increase", "magnitude": "small" }
    ],
    "resource_estimate": {
      "sessions": 2,
      "duration": { "value": 3, "unit": "hours" },
      "llm_calls": 1
    },
    "allocation": 0.3
  }
]
\`\`\``;

const TYPED_LINEAGE_RECOVERY_RESPONSE = `\`\`\`json
[
  {
    "hypothesis": "Run distribution-shift audit against validation folds before another model refinement",
    "expected_effect": [
      { "dimension": "balanced_accuracy", "direction": "increase", "magnitude": "medium" }
    ],
    "resource_estimate": {
      "sessions": 1,
      "duration": { "value": 45, "unit": "minutes" },
      "llm_calls": 1
    },
    "allocation": 0.3,
    "exploration": {
      "schema_version": "strategy-exploration-v1",
      "phase": "divergent_stall_recovery",
      "role": "divergent_exploration",
      "strategy_family": "fold-distribution-audit",
      "novelty_score": 0.84,
      "similarity_to_recent_failures": 0,
      "expected_cost": "low",
      "relationship_to_lineage": "different_assumption",
      "smoke": {
        "status": "not_run",
        "reason": "Run a smoke-scale fold audit before expensive execution."
      },
      "speculative": true,
      "evidence_authority": "speculative_hypothesis"
    }
  },
  {
    "hypothesis": "Repeat threshold sweep with a tighter calibration grid",
    "expected_effect": [
      { "dimension": "balanced_accuracy", "direction": "increase", "magnitude": "small" }
    ],
    "resource_estimate": {
      "sessions": 2,
      "duration": { "value": 4, "unit": "hours" },
      "llm_calls": 1
    },
    "allocation": 0.3,
    "exploration": {
      "schema_version": "strategy-exploration-v1",
      "phase": "divergent_stall_recovery",
      "role": "adjacent_exploration",
      "strategy_family": "threshold_sweep",
      "novelty_score": 0.58,
      "similarity_to_recent_failures": 0,
      "expected_cost": "medium",
      "relationship_to_lineage": "neighbor",
      "smoke": {
        "status": "not_run",
        "reason": "Needs smoke evidence before promotion."
      },
      "speculative": true,
      "evidence_authority": "speculative_hypothesis"
    }
  }
]
\`\`\``;

// ─── Test Setup ───

let tempDir: string;
let stateManager: StateManager;

beforeEach(() => {
  tempDir = makeTempDir();
  stateManager = new StateManager(tempDir);
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true , maxRetries: 3, retryDelay: 100 });
});

// ─── onStallDetected ───

describe("onStallDetected", () => {
  it("activateBestCandidate enforces wait budgets for WaitStrategy candidates", async () => {
    const manager = new StrategyManager(stateManager, createMockLLMClient([]));
    const wait = await manager.createWaitStrategy("goal-1", {
      hypothesis: "Wait for external signal",
      wait_reason: "External process needs time",
      wait_until: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      measurement_plan: "Check again later",
      fallback_strategy_id: null,
      target_dimensions: ["word_count"],
      primary_dimension: "word_count",
    });

    await expect(
      manager.activateBestCandidate("goal-1", {
        getCurrentGap: async () => 0.4,
        canAffordWait: async () => false,
      })
    ).rejects.toThrow("cannot be activated because the goal cannot afford waiting");

    const stored = await manager.getPortfolio("goal-1");
    const candidate = stored?.strategies.find((strategy) => strategy.id === wait.id);
    expect(candidate?.state).toBe("candidate");
  });

  it("returns null when stallCount === 1", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);

    await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });
    await manager.activateBestCandidate("goal-1");

    const result = await manager.onStallDetected("goal-1", 1);
    expect(result).toBeNull();
  });

  it("does not change active strategy when stallCount === 1", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);

    await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });
    const original = await manager.activateBestCandidate("goal-1");

    await manager.onStallDetected("goal-1", 1);

    const still = await manager.getActiveStrategy("goal-1");
    expect(still?.id).toBe(original.id);
    expect(still?.state).toBe("active");
  });

  it("terminates current strategy when stallCount >= 2", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE, CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);

    await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });
    const original = await manager.activateBestCandidate("goal-1");

    await manager.onStallDetected("goal-1", 2);

    const history = await manager.getStrategyHistory("goal-1");
    const terminated = history.find((s) => s.id === original.id);
    expect(terminated).toBeDefined();
    expect(terminated!.state).toBe("terminated");
  });

  it("generates new candidates and activates best when stallCount >= 2", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE, CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);

    await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });
    const original = await manager.activateBestCandidate("goal-1");

    const newStrategy = await manager.onStallDetected("goal-1", 2);

    expect(newStrategy).not.toBeNull();
    expect(newStrategy!.state).toBe("active");
    expect(newStrategy!.id).not.toBe(original.id);
  });

  it("returns null when no candidates can be generated (LLM returns empty)", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE, EMPTY_CANDIDATES_RESPONSE]);
    const manager = new StrategyManager(stateManager, mock);

    await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });
    await manager.activateBestCandidate("goal-1");

    const result = await manager.onStallDetected("goal-1", 2);
    expect(result).toBeNull();
  });

  it("returns null when candidate generation throws (LLM error)", async () => {
    const failingMock: ILLMClient = {
      async sendMessage() {
        throw new Error("LLM unavailable");
      },
      parseJSON<T>(content: string, schema: z.ZodSchema<T>): T {
        return schema.parse(JSON.parse(content));
      },
    };

    // We need a fresh manager with an initial candidate so we have an active strategy
    const setupMock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, setupMock);

    await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });
    await manager.activateBestCandidate("goal-1");

    // Now switch to failing mock for the stall call
    const failingManager = new StrategyManager(stateManager, failingMock);
    const result = await failingManager.onStallDetected("goal-1", 2);
    expect(result).toBeNull();
  });

  it("works when there is no active strategy (goal-1 has no active)", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);

    // Goal with no strategies at all
    const result = await manager.onStallDetected("goal-1", 2);

    // No active strategy to terminate, new candidates are generated and activated
    expect(result).not.toBeNull();
    expect(result!.state).toBe("active");
  });

  it("adds a high-novelty divergent portfolio when sustained stall recovery stays near failed lineage", async () => {
    const mock = createMockLLMClient([KAGGLE_LOCAL_SEARCH_RESPONSE, NEAR_STALL_RECOVERY_RESPONSE]);
    const manager = new StrategyManager(stateManager, mock);

    await manager.generateCandidates("goal-1", "balanced_accuracy", ["balanced_accuracy"], {
      currentGap: 0.2,
      pastStrategies: [],
    });
    const original = await manager.activateBestCandidate("goal-1");

    const next = await manager.onStallDetected("goal-1", 2, "kaggle", undefined, {
      metric_key: "balanced_accuracy",
      direction: "maximize",
      trend: "stalled",
      latest_value: 0.9708,
      latest_observed_at: "2026-04-30T00:00:00.000Z",
      best_value: 0.9708,
      best_observed_at: "2026-04-30T00:00:00.000Z",
      observation_count: 6,
      recent_slope_per_observation: 0,
      best_delta: 0.0001,
      last_meaningful_improvement_delta: null,
      last_breakthrough_delta: null,
      time_since_last_meaningful_improvement_ms: 86_400_000,
      improvement_threshold: 0.01,
      breakthrough_threshold: 0.05,
      noise_band: 0.005,
      confidence: 0.9,
      source_refs: [],
      summary: "balanced_accuracy stalled near the current best.",
    });

    expect(next).not.toBeNull();
    expect(next?.id).not.toBe(original.id);
    const portfolio = await manager.getPortfolio("goal-1");
    const recoveryCandidates = portfolio?.strategies.filter(
      (strategy) => strategy.exploration?.phase === "divergent_stall_recovery"
    ) ?? [];
    expect(recoveryCandidates.length).toBeGreaterThanOrEqual(3);
    expect(recoveryCandidates).toContainEqual(expect.objectContaining({
      exploration: expect.objectContaining({
        role: "divergent_exploration",
        strategy_family: "framing-audit-smoke",
        novelty_score: expect.any(Number),
        expected_cost: "low",
        relationship_to_lineage: "different_assumption",
        evidence_authority: "speculative_hypothesis",
      }),
    }));
    expect(recoveryCandidates.some((strategy) =>
      strategy.exploration?.downrank_reason === "low_confidence_lineage_assessment"
    )).toBe(true);
  });

  it("keeps paraphrased and multilingual novelty ambiguous when no typed lineage evidence exists", async () => {
    const mock = createMockLLMClient([KAGGLE_LOCAL_SEARCH_RESPONSE, PARAPHRASE_MULTILINGUAL_RECOVERY_RESPONSE]);
    const manager = new StrategyManager(stateManager, mock);

    await manager.generateCandidates("goal-1", "balanced_accuracy", ["balanced_accuracy"], {
      currentGap: 0.2,
      pastStrategies: [],
    });
    await manager.activateBestCandidate("goal-1");

    await manager.onStallDetected("goal-1", 2, "kaggle");

    const portfolio = await manager.getPortfolio("goal-1");
    const recoveryCandidates = portfolio?.strategies.filter(
      (strategy) => strategy.exploration?.phase === "divergent_stall_recovery"
    ) ?? [];
    const rawCandidates = recoveryCandidates.filter((strategy) =>
      strategy.exploration?.lineage_assessment?.novelty_basis === "diagnostic_text_overlap"
      || strategy.exploration?.lineage_assessment?.novelty_basis === "unknown"
    );
    expect(rawCandidates).toHaveLength(2);
    expect(rawCandidates.every((strategy) =>
      strategy.exploration?.role !== "divergent_exploration"
      && (strategy.exploration?.lineage_assessment?.confidence ?? 1) < 0.65
      && strategy.exploration?.downrank_reason === "low_confidence_lineage_assessment"
    )).toBe(true);
    expect(recoveryCandidates.some((strategy) =>
      strategy.exploration?.lineage_assessment?.summary ===
        "Fallback smoke audit is intentionally separated from recorded failed lineage keys."
    )).toBe(true);
  });

  it("uses typed failed-lineage evidence and strategy metadata in production stall recovery ranking", async () => {
    const mock = createMockLLMClient([KAGGLE_LOCAL_SEARCH_RESPONSE, TYPED_LINEAGE_RECOVERY_RESPONSE]);
    const manager = new StrategyManager(stateManager, mock);

    await manager.generateCandidates("goal-1", "balanced_accuracy", ["balanced_accuracy"], {
      currentGap: 0.2,
      pastStrategies: [],
    });
    await manager.activateBestCandidate("goal-1");

    await manager.onStallDetected("goal-1", 2, "kaggle", undefined, undefined, [{
      fingerprint: "threshold_sweep|balanced_accuracy|threshold_sweep",
      count: 3,
      first_seen_at: "2026-04-30T00:00:00.000Z",
      last_seen_at: "2026-05-01T00:00:00.000Z",
      strategy_family: "threshold_sweep",
      primary_dimension: "balanced_accuracy",
      task_action: "threshold_sweep",
      representative_entry_id: "evidence://failed-lineage/latest",
      representative_summary: "Threshold sweeps repeatedly failed.",
      evidence_entry_ids: ["evidence://failed-lineage/1", "evidence://failed-lineage/2"],
    }]);

    const portfolio = await manager.getPortfolio("goal-1");
    const recoveryCandidates = portfolio?.strategies.filter(
      (strategy) => strategy.exploration?.phase === "divergent_stall_recovery"
    ) ?? [];
    const divergent = recoveryCandidates.find((strategy) =>
      strategy.exploration?.strategy_family === "fold-distribution-audit"
    );
    const failedLineage = recoveryCandidates.find((strategy) =>
      strategy.exploration?.strategy_family === "threshold_sweep"
    );

    expect(divergent?.exploration?.lineage_assessment).toMatchObject({
      confidence: 0.72,
      novelty_basis: "strategy_metadata",
      relationship_to_lineage: "different_assumption",
    });
    expect(failedLineage?.exploration?.lineage_assessment).toMatchObject({
      confidence: 0.9,
      novelty_basis: "typed_lineage_evidence",
      relationship_to_lineage: "failed_lineage",
      matched_failed_lineage_fingerprints: ["threshold_sweep|balanced_accuracy|threshold_sweep"],
    });
    expect(failedLineage?.exploration?.downrank_reason).toBe("similar_to_recent_failed_lineage_without_new_evidence");
    expect((divergent?.exploration?.novelty_score ?? 0) > (failedLineage?.exploration?.novelty_score ?? 1)).toBe(true);
  });

  it("records smoke promote defer and retire decisions without treating speculative candidates as proven", async () => {
    const mock = createMockLLMClient([KAGGLE_LOCAL_SEARCH_RESPONSE, NEAR_STALL_RECOVERY_RESPONSE]);
    const manager = new StrategyManager(stateManager, mock);

    await manager.generateCandidates("goal-1", "balanced_accuracy", ["balanced_accuracy"], {
      currentGap: 0.2,
      pastStrategies: [],
    });
    await manager.activateBestCandidate("goal-1");

    const candidates = await manager.prepareDivergentExplorationOnStall("goal-1", {
      primaryDimension: "balanced_accuracy",
      targetDimensions: ["balanced_accuracy"],
      currentGap: 0.2,
      stallCount: 2,
      trigger: "sustained_stall",
    });

    expect(candidates.length).toBeGreaterThanOrEqual(3);
    const [promoted, deferred, retired] = candidates;
    await manager.recordDivergentSmokeResult("goal-1", promoted!.id, {
      status: "promote",
      reason: "Smoke probe improved validation score.",
      evidenceRef: "evidence://smoke/promote",
    });
    await manager.recordDivergentSmokeResult("goal-1", deferred!.id, {
      status: "defer",
      reason: "Smoke probe needs more data before full execution.",
    });
    await manager.recordDivergentSmokeResult("goal-1", retired!.id, {
      status: "retire",
      reason: "Smoke probe reproduced a dead end.",
    });

    const portfolio = await manager.getPortfolio("goal-1");
    expect(portfolio?.strategies.find((strategy) => strategy.id === promoted!.id)?.exploration).toMatchObject({
      smoke: { status: "promote", evidence_ref: "evidence://smoke/promote" },
      evidence_authority: "speculative_hypothesis",
    });
    expect(portfolio?.strategies.find((strategy) => strategy.id === deferred!.id)?.exploration?.smoke.status).toBe("defer");
    expect(portfolio?.strategies.find((strategy) => strategy.id === retired!.id)?.exploration?.smoke.status).toBe("retire");
  });
});

// ─── getActiveStrategy ───

describe("getActiveStrategy", () => {
  it("returns null when no strategy exists", async () => {
    const mock = createMockLLMClient([]);
    const manager = new StrategyManager(stateManager, mock);

    expect(await manager.getActiveStrategy("goal-1")).toBeNull();
  });

  it("returns null when only candidates exist", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);

    await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });

    expect(await manager.getActiveStrategy("goal-1")).toBeNull();
  });

  it("returns the active strategy after activation", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);

    await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });
    const activated = await manager.activateBestCandidate("goal-1");

    const result = await manager.getActiveStrategy("goal-1");
    expect(result).not.toBeNull();
    expect(result!.id).toBe(activated.id);
    expect(result!.state).toBe("active");
  });

  it("returns null after active strategy is terminated", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);

    await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });
    const activated = await manager.activateBestCandidate("goal-1");
    await manager.updateState(activated.id, "terminated");

    expect(await manager.getActiveStrategy("goal-1")).toBeNull();
  });
});

// ─── getPortfolio ───

describe("getPortfolio", () => {
  it("returns null before any operations", async () => {
    const mock = createMockLLMClient([]);
    const manager = new StrategyManager(stateManager, mock);

    expect(await manager.getPortfolio("goal-1")).toBeNull();
  });

  it("returns portfolio after generating candidates", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);

    await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });

    const portfolio = await manager.getPortfolio("goal-1");
    expect(portfolio).not.toBeNull();
    expect(portfolio!.goal_id).toBe("goal-1");
    expect(portfolio!.strategies).toHaveLength(1);
  });

  it("persists portfolio across manager instances", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager1 = new StrategyManager(stateManager, mock);

    await manager1.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });

    // Create new instance with same stateManager
    const manager2 = new StrategyManager(stateManager, createMockLLMClient([]));
    const portfolio = await manager2.getPortfolio("goal-1");
    expect(portfolio).not.toBeNull();
    expect(portfolio!.strategies).toHaveLength(1);
  });

  it("accumulates multiple candidates across calls", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE, CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);

    await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });
    await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.6,
      pastStrategies: [],
    });

    const portfolio = await manager.getPortfolio("goal-1");
    expect(portfolio!.strategies).toHaveLength(2);
  });
});

// ─── appendToHistory dedup branch ───

describe("appendToHistory dedup", () => {
  it("updates existing entry in history when same strategy is appended twice", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);

    const [candidate] = await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });

    await manager.updateState(candidate.id, "active");
    // First termination archives the strategy
    await manager.updateState(candidate.id, "terminated");

    // Manually call terminateStrategy (which calls appendToHistory again) — use same goal
    // We can't call updateState again (invalid transition), so verify history length stays at 1
    const history = await manager.getStrategyHistory("goal-1");
    expect(history).toHaveLength(1);
    expect(history[0].state).toBe("terminated");
  });
});

// ─── resolveGoalId — directory scan fallback ───

describe("resolveGoalId fallback scan", () => {
  it("finds strategy via directory scan when not in memory index", async () => {
    // manager1 creates the candidate (stores in portfolio)
    const mock1 = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager1 = new StrategyManager(stateManager, mock1);
    const [candidate] = await manager1.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });

    // Register the goal ID so resolveGoalId can scan the typed goal registry.
    await stateManager.saveGoal(makeGoal({ id: "goal-1" }));

    // manager2 has a fresh in-memory index (no strategyIndex entry)
    const manager2 = new StrategyManager(stateManager, createMockLLMClient([]));
    // updateState triggers resolveGoalId — should fall back to scanning
    await expect(manager2.updateState(candidate.id, "active")).resolves.not.toThrow();

    const portfolio = await manager2.getPortfolio("goal-1");
    const updated = portfolio!.strategies.find((s) => s.id === candidate.id);
    expect(updated!.state).toBe("active");
  });
});

// ─── detectStrategyGap ───

describe("detectStrategyGap", () => {
  it("returns strategy_deadlock signal when candidates array is empty", async () => {
    const mock = createMockLLMClient([]);
    const manager = new StrategyManager(stateManager, mock);
    const result = manager.detectStrategyGap([]);
    expect(result).not.toBeNull();
    expect(result!.signal_type).toBe("strategy_deadlock");
  });

  it("returns null when candidates array has a viable strategy (no effectiveness score)", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);
    const candidates = await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });
    const result = manager.detectStrategyGap(candidates);
    // Candidates have effectiveness_score=null (unscored), so no deadlock
    expect(result).toBeNull();
  });

  it("returns strategy_deadlock when all candidates have effectiveness_score < 0.3", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_ONE]);
    const manager = new StrategyManager(stateManager, mock);
    const candidates = await manager.generateCandidates("goal-1", "word_count", ["word_count"], {
      currentGap: 0.7,
      pastStrategies: [],
    });
    // Simulate low effectiveness
    const lowCandidates = candidates.map((c) => ({ ...c, effectiveness_score: 0.1 }));
    const result = manager.detectStrategyGap(lowCandidates);
    expect(result).not.toBeNull();
    expect(result!.signal_type).toBe("strategy_deadlock");
  });

  it("returns null when at least one candidate has effectiveness_score >= 0.3", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE_TWO]);
    const manager = new StrategyManager(stateManager, mock);
    const candidates = await manager.generateCandidates("goal-1", "research_depth", ["research_depth"], {
      currentGap: 0.5,
      pastStrategies: [],
    });
    const mixed = candidates.map((c, i) => ({
      ...c,
      effectiveness_score: i === 0 ? 0.8 : 0.1,
    }));
    const result = manager.detectStrategyGap(mixed);
    expect(result).toBeNull();
  });

  it("empty signal has source_step = strategy_selection", async () => {
    const mock = createMockLLMClient([]);
    const manager = new StrategyManager(stateManager, mock);
    const result = manager.detectStrategyGap([]);
    expect(result!.source_step).toBe("strategy_selection");
  });

  it("signal has non-empty missing_knowledge description", async () => {
    const mock = createMockLLMClient([]);
    const manager = new StrategyManager(stateManager, mock);
    const result = manager.detectStrategyGap([]);
    expect(result!.missing_knowledge.length).toBeGreaterThan(0);
  });

  it("related_dimension is null for strategy deadlock signal", async () => {
    const mock = createMockLLMClient([]);
    const manager = new StrategyManager(stateManager, mock);
    const result = manager.detectStrategyGap([]);
    expect(result!.related_dimension).toBeNull();
  });
});
