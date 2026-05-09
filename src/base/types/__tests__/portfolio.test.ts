import { describe, expect, it } from "vitest";
import {
  MAX_PORTFOLIO_REBALANCE_INTERVAL_HOURS,
  PortfolioConfigSchema,
} from "../portfolio.js";

describe("PortfolioConfigSchema", () => {
  it("preserves defaults", () => {
    const parsed = PortfolioConfigSchema.parse({});

    expect(parsed.rebalance_interval_hours).toBe(168);
  });

  it("rejects non-finite and over-cap rebalance intervals", () => {
    expect(PortfolioConfigSchema.safeParse({
      rebalance_interval_hours: 0.001,
    }).success).toBe(true);
    expect(PortfolioConfigSchema.safeParse({
      rebalance_interval_hours: MAX_PORTFOLIO_REBALANCE_INTERVAL_HOURS,
    }).success).toBe(true);

    for (const rebalance_interval_hours of [
      0,
      Number.POSITIVE_INFINITY,
      MAX_PORTFOLIO_REBALANCE_INTERVAL_HOURS + 1,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(PortfolioConfigSchema.safeParse({
        rebalance_interval_hours,
      }).success).toBe(false);
    }
  });
});
