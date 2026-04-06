/**
 * Tests for strategy execution feedback (Item 3 of tool-core integration plan).
 *
 * Tests cover:
 * - recordExecutionFeedback: adds to history
 * - recordExecutionFeedback: buffer bounded at 50 (oldest evicted)
 * - activateBestCandidate: penalizes strategies with <30% success rate (>=3 entries)
 * - activateBestCandidate: no penalty when insufficient history (<3 entries)
 * - activateBestCandidate: no penalty when success rate >= 30%
 */

import { describe, it, expect, beforeEach } from "vitest";
import { makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { createMockLLMClient } from "../../../../tests/helpers/mock-llm.js";
import { StateManager } from "../../../base/state/state-manager.js";
import { StrategyManager } from "../strategy-manager.js";
import type { ExecutionFeedback } from "../strategy-manager-base.js";

// ─── Helpers ───

function makeFeedback(overrides: Partial<ExecutionFeedback> = {}): ExecutionFeedback {
  return {
    strategyId: "strat-a",
    taskId: "task-1",
    success: true,
    verificationPassed: true,
    duration_ms: 100,
    timestamp: Date.now(),
    ...overrides,
  };
}

const TWO_CANDIDATE_RESPONSE = [
  `[
  {
    "hypothesis": "strat-alpha",
    "expected_effect": [
      { "dimension": "coverage", "direction": "increase", "magnitude": "medium" }
    ],
    "resource_estimate": {
      "sessions": 2,
      "duration": { "value": 1, "unit": "days" },
      "llm_calls": null
    },
    "allocation": 0.8
  },
  {
    "hypothesis": "strat-beta",
    "expected_effect": [
      { "dimension": "coverage", "direction": "increase", "magnitude": "medium" }
    ],
    "resource_estimate": {
      "sessions": 2,
      "duration": { "value": 1, "unit": "days" },
      "llm_calls": null
    },
    "allocation": 0.8
  }
]`,
];

// ─── recordExecutionFeedback tests ───

describe("recordExecutionFeedback", () => {
  let sm: StrategyManager;

  beforeEach(() => {
    const tmpDir = makeTempDir("strategy-feedback-test");
    const stateManager = new StateManager(tmpDir);
    const llmClient = createMockLLMClient(TWO_CANDIDATE_RESPONSE);
    sm = new StrategyManager(stateManager, llmClient);
  });

  it("adds feedback to executionHistory", () => {
    const fb = makeFeedback();
    sm.recordExecutionFeedback(fb);
    const history = (sm as unknown as { executionHistory: ExecutionFeedback[] }).executionHistory;
    expect(history).toHaveLength(1);
    expect(history[0]).toEqual(fb);
  });

  it("evicts oldest entry when buffer exceeds 50", () => {
    const internal = sm as unknown as { executionHistory: ExecutionFeedback[] };
    // Fill with 50 entries with taskId 'task-0' through 'task-49'
    for (let i = 0; i < 50; i++) {
      sm.recordExecutionFeedback(makeFeedback({ strategyId: "old", taskId: `task-${i}` }));
    }
    expect(internal.executionHistory).toHaveLength(50);
    // Add one more — oldest (task-0) should be evicted
    sm.recordExecutionFeedback(makeFeedback({ strategyId: "new", taskId: "task-new" }));
    expect(internal.executionHistory).toHaveLength(50);
    expect(internal.executionHistory[49]!.strategyId).toBe("new");
    expect(internal.executionHistory[0]!.taskId).toBe("task-1");
  });
});

// ─── activateBestCandidate with execution history ───

describe("activateBestCandidate with execution history", () => {
  async function setupWithCandidates(): Promise<StrategyManager> {
    const tmpDir = makeTempDir("strategy-feedback-activate-test");
    const stateManager = new StateManager(tmpDir);
    const llmClient = createMockLLMClient(TWO_CANDIDATE_RESPONSE);
    const sm = new StrategyManager(stateManager, llmClient);
    await sm.generateCandidates(
      "goal-1",
      "coverage",
      ["coverage"],
      { currentGap: 0.8, pastStrategies: [] }
    );
    return sm;
  }

  it("penalizes strategies with <30% success rate when >=3 history entries exist", async () => {
    const sm = await setupWithCandidates();

    // 4 failures for strat-alpha (0% success rate) — should be penalized
    for (let i = 0; i < 4; i++) {
      sm.recordExecutionFeedback(makeFeedback({
        strategyId: "strat-alpha",
        success: false,
        verificationPassed: false,
      }));
    }

    const activated = await sm.activateBestCandidate("goal-1");
    // strat-alpha penalized — strat-beta should be chosen
    expect(activated.hypothesis).toBe("strat-beta");
  });

  it("no penalty when fewer than 3 history entries", async () => {
    const sm = await setupWithCandidates();

    // Only 2 failures for strat-alpha — not enough for penalty
    sm.recordExecutionFeedback(makeFeedback({ strategyId: "strat-alpha", success: false }));
    sm.recordExecutionFeedback(makeFeedback({ strategyId: "strat-alpha", success: false }));

    const activated = await sm.activateBestCandidate("goal-1");
    // No penalty applied — first candidate (strat-alpha) should be chosen
    expect(activated.hypothesis).toBe("strat-alpha");
  });

  it("no penalty when success rate is above 30%", async () => {
    const sm = await setupWithCandidates();

    // 3 entries: 1 success + 2 failures = 33.3% success rate (>= 30%)
    sm.recordExecutionFeedback(makeFeedback({ strategyId: "strat-alpha", success: true }));
    sm.recordExecutionFeedback(makeFeedback({ strategyId: "strat-alpha", success: false }));
    sm.recordExecutionFeedback(makeFeedback({ strategyId: "strat-alpha", success: false }));

    const activated = await sm.activateBestCandidate("goal-1");
    // 33% success rate — no penalty, strat-alpha remains first
    expect(activated.hypothesis).toBe("strat-alpha");
  });
});
