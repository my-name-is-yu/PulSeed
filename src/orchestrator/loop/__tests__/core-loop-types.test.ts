import { describe, it, expect } from "vitest";
import { makeEmptyIterationResult } from "../core-loop/contracts.js";
import type { LoopIterationResult } from "../core-loop/contracts.js";

describe("LoopIterationResult — wait telemetry fields (Gap 6)", () => {
  it("accepts waitSuppressed field", () => {
    const result: LoopIterationResult = makeEmptyIterationResult("goal-1", 0, {
      waitSuppressed: true,
    });
    expect(result.waitSuppressed).toBe(true);
  });

  it("accepts waitExpired field", () => {
    const result: LoopIterationResult = makeEmptyIterationResult("goal-1", 0, {
      waitExpired: true,
    });
    expect(result.waitExpired).toBe(true);
  });

  it("accepts waitStrategyId field", () => {
    const result: LoopIterationResult = makeEmptyIterationResult("goal-1", 0, {
      waitStrategyId: "strategy-abc",
    });
    expect(result.waitStrategyId).toBe("strategy-abc");
  });

  it("leaves wait fields undefined by default", () => {
    const result = makeEmptyIterationResult("goal-1", 0);
    expect(result.waitSuppressed).toBeUndefined();
    expect(result.waitExpired).toBeUndefined();
    expect(result.waitStrategyId).toBeUndefined();
    expect(result.waitObserveOnly).toBeUndefined();
    expect(result.waitExpiryOutcome).toBeUndefined();
    expect(result.waitApprovalId).toBeUndefined();
  });

  it("combines wait telemetry fields", () => {
    const result: LoopIterationResult = makeEmptyIterationResult("goal-1", 1, {
      waitSuppressed: false,
      waitExpired: true,
      waitStrategyId: "ws-123",
      waitObserveOnly: true,
      waitExpiryOutcome: {
        status: "improved",
        goal_id: "goal-1",
        strategy_id: "ws-123",
      },
      waitApprovalId: "wait-goal-1-ws-123",
    });
    expect(result.waitSuppressed).toBe(false);
    expect(result.waitExpired).toBe(true);
    expect(result.waitStrategyId).toBe("ws-123");
    expect(result.waitObserveOnly).toBe(true);
    expect(result.waitExpiryOutcome?.status).toBe("improved");
    expect(result.waitApprovalId).toBe("wait-goal-1-ws-123");
  });
});
