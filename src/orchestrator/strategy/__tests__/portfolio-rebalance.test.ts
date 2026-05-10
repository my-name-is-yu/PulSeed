import { describe, expect, it, vi } from "vitest";
import { selectNextStrategyAcrossGoals } from "../portfolio-rebalance.js";
import type { TaskSelectionResult } from "../types/portfolio.js";

function selectedStrategy(goalId: string): TaskSelectionResult {
  return {
    strategy_id: `strategy-${goalId}`,
    reason: `selected ${goalId}`,
    wait_ratio: 0,
  };
}

describe("selectNextStrategyAcrossGoals", () => {
  it("skips goals with invalid allocations before scoring saturation", async () => {
    const selectStrategy = vi.fn((goalId: string) => selectedStrategy(goalId));

    const result = await selectNextStrategyAcrossGoals(
      ["nan", "zero", "valid"],
      new Map([
        ["nan", Number.NaN],
        ["zero", 0],
        ["valid", 0.5],
      ]),
      new Map([["valid", 1]]),
      selectStrategy,
    );

    expect(result).toMatchObject({
      goal_id: "valid",
      strategy_id: "strategy-valid",
    });
    expect(selectStrategy).toHaveBeenCalledTimes(1);
    expect(selectStrategy).toHaveBeenCalledWith("valid");
    expect(result?.selection_reason).toContain("saturation=2.00");
    expect(result?.selection_reason).not.toMatch(/NaN|Infinity/);
  });

  it("normalizes invalid task counts without leaking non-finite saturation", async () => {
    const selectStrategy = vi.fn((goalId: string) => selectedStrategy(goalId));

    const result = await selectNextStrategyAcrossGoals(
      ["invalid-count", "valid-count"],
      new Map([
        ["invalid-count", 0.5],
        ["valid-count", 0.5],
      ]),
      new Map([
        ["invalid-count", Number.POSITIVE_INFINITY],
        ["valid-count", 1],
      ]),
      selectStrategy,
    );

    expect(result).toMatchObject({
      goal_id: "invalid-count",
      strategy_id: "strategy-invalid-count",
    });
    expect(result?.selection_reason).toContain("saturation=0.00");
    expect(result?.selection_reason).not.toMatch(/NaN|Infinity/);
  });
});
