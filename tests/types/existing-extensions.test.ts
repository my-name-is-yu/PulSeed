import { describe, it, expect } from "vitest";
import { GoalSchema, GoalNodeTypeEnum } from "../../src/types/goal.js";
import { StrategySchema } from "../../src/types/strategy.js";
import { DependencyTypeEnum } from "../../src/types/core.js";

// Helper: minimal valid Goal input
function makeGoalInput(overrides: Record<string, unknown> = {}) {
  return {
    id: "goal-1",
    title: "Test Goal",
    dimensions: [],
    created_at: "2024-01-01T00:00:00.000Z",
    updated_at: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// Helper: minimal valid Strategy input
function makeStrategyInput(overrides: Record<string, unknown> = {}) {
  return {
    id: "strat-1",
    goal_id: "goal-1",
    target_dimensions: ["coverage"],
    primary_dimension: "coverage",
    hypothesis: "increase test coverage",
    expected_effect: [],
    resource_estimate: {
      sessions: 3,
      duration: { value: 2, unit: "days" },
    },
    created_at: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// ─── GoalSchema Stage 14 fields ───

describe("GoalSchema — Stage 14 decomposition fields", () => {
  it("defaults decomposition_depth to 0", () => {
    const result = GoalSchema.parse(makeGoalInput());
    expect(result.decomposition_depth).toBe(0);
  });

  it("defaults specificity_score to null", () => {
    const result = GoalSchema.parse(makeGoalInput());
    expect(result.specificity_score).toBeNull();
  });

  it("defaults loop_status to 'idle'", () => {
    const result = GoalSchema.parse(makeGoalInput());
    expect(result.loop_status).toBe("idle");
  });

  it("accepts explicit decomposition_depth", () => {
    const result = GoalSchema.parse(makeGoalInput({ decomposition_depth: 3 }));
    expect(result.decomposition_depth).toBe(3);
  });

  it("accepts explicit specificity_score in [0,1]", () => {
    const result = GoalSchema.parse(makeGoalInput({ specificity_score: 0.75 }));
    expect(result.specificity_score).toBe(0.75);
  });

  it("accepts all loop_status values: idle, running, paused", () => {
    const statuses = ["idle", "running", "paused"] as const;
    for (const loop_status of statuses) {
      const r = GoalSchema.parse(makeGoalInput({ loop_status }));
      expect(r.loop_status).toBe(loop_status);
    }
  });

  it("rejects decomposition_depth below 0", () => {
    const result = GoalSchema.safeParse(makeGoalInput({ decomposition_depth: -1 }));
    expect(result.success).toBe(false);
  });

  it("rejects specificity_score above 1", () => {
    const result = GoalSchema.safeParse(makeGoalInput({ specificity_score: 1.1 }));
    expect(result.success).toBe(false);
  });

  it("rejects invalid loop_status", () => {
    const result = GoalSchema.safeParse(makeGoalInput({ loop_status: "stopped" }));
    expect(result.success).toBe(false);
  });
});

// ─── GoalNodeTypeEnum — 'leaf' ───

describe("GoalNodeTypeEnum", () => {
  it("accepts 'leaf' as a valid node type", () => {
    expect(GoalNodeTypeEnum.parse("leaf")).toBe("leaf");
  });

  it("accepts all 4 node types: goal, subgoal, milestone, leaf", () => {
    const types = ["goal", "subgoal", "milestone", "leaf"] as const;
    for (const t of types) {
      expect(GoalNodeTypeEnum.parse(t)).toBe(t);
    }
  });

  it("GoalSchema accepts node_type='leaf'", () => {
    const result = GoalSchema.parse(makeGoalInput({ node_type: "leaf" }));
    expect(result.node_type).toBe("leaf");
  });
});

// ─── StrategySchema Stage 14 fields ───

describe("StrategySchema — Stage 14 cross-goal fields", () => {
  it("defaults source_template_id to null", () => {
    const result = StrategySchema.parse(makeStrategyInput());
    expect(result.source_template_id).toBeNull();
  });

  it("defaults cross_goal_context to null", () => {
    const result = StrategySchema.parse(makeStrategyInput());
    expect(result.cross_goal_context).toBeNull();
  });

  it("accepts explicit source_template_id", () => {
    const result = StrategySchema.parse(makeStrategyInput({ source_template_id: "tpl-5" }));
    expect(result.source_template_id).toBe("tpl-5");
  });

  it("accepts explicit cross_goal_context", () => {
    const result = StrategySchema.parse(makeStrategyInput({ cross_goal_context: "Transferred from goal-2" }));
    expect(result.cross_goal_context).toBe("Transferred from goal-2");
  });

  it("accepts explicit null for source_template_id", () => {
    const result = StrategySchema.parse(makeStrategyInput({ source_template_id: null }));
    expect(result.source_template_id).toBeNull();
  });

  it("accepts explicit null for cross_goal_context", () => {
    const result = StrategySchema.parse(makeStrategyInput({ cross_goal_context: null }));
    expect(result.cross_goal_context).toBeNull();
  });
});

// ─── DependencyTypeEnum — strategy_dependency ───

describe("DependencyTypeEnum", () => {
  it("accepts 'strategy_dependency' as a valid dependency type", () => {
    expect(DependencyTypeEnum.parse("strategy_dependency")).toBe("strategy_dependency");
  });

  it("accepts all 5 dependency types", () => {
    const types = [
      "prerequisite",
      "resource_conflict",
      "synergy",
      "conflict",
      "strategy_dependency",
    ] as const;
    for (const t of types) {
      expect(DependencyTypeEnum.parse(t)).toBe(t);
    }
  });

  it("rejects invalid dependency type", () => {
    const result = DependencyTypeEnum.safeParse("optional");
    expect(result.success).toBe(false);
  });
});
