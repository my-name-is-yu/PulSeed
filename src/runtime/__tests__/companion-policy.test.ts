import { describe, expect, it } from "vitest";
import { buildCompanionRuntimeContract } from "../companion-policy.js";
import {
  CompanionTurnPolicySchema,
  MAX_COMPANION_LATENCY_BUDGET_MS,
} from "../types/companion.js";

const VALID_TURN_POLICY = {
  input_modality: "text",
  output_mode: "reply",
  can_interrupt: true,
  latency_budget_ms: 120_000,
  urgency: "normal",
  quieting: "allow",
} as const;

describe("companion runtime policy contracts", () => {
  it("keeps latency budgets finite, safe, and bounded", () => {
    expect(CompanionTurnPolicySchema.safeParse({
      ...VALID_TURN_POLICY,
      latency_budget_ms: MAX_COMPANION_LATENCY_BUDGET_MS,
    }).success).toBe(true);

    for (const latencyBudget of [
      Number.NaN,
      Infinity,
      -Infinity,
      Number.MAX_SAFE_INTEGER + 1,
      MAX_COMPANION_LATENCY_BUDGET_MS + 1,
    ]) {
      expect(CompanionTurnPolicySchema.safeParse({
        ...VALID_TURN_POLICY,
        latency_budget_ms: latencyBudget,
      }).success).toBe(false);
    }
  });

  it("enforces latency budget bounds through the companion runtime builder", () => {
    expect(buildCompanionRuntimeContract({
      turnPolicy: {
        latency_budget_ms: 120_000,
      },
    }).turn_policy.latency_budget_ms).toBe(120_000);

    expect(() => buildCompanionRuntimeContract({
      turnPolicy: {
        latency_budget_ms: Infinity,
      },
    })).toThrow();

    expect(() => buildCompanionRuntimeContract({
      turnPolicy: {
        latency_budget_ms: MAX_COMPANION_LATENCY_BUDGET_MS + 1,
      },
    })).toThrow();
  });
});
