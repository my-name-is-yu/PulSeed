import { describe, it, expect } from "vitest";
import {
  GoalDecompositionConfigSchema,
  DecompositionResultSchema,
  GoalTreeStateSchema,
  PruneReasonEnum,
  PruneDecisionSchema,
  AggregationDirectionEnum,
  StateAggregationRuleSchema,
} from "../../src/types/goal-tree.js";

// ─── GoalDecompositionConfigSchema ───

describe("GoalDecompositionConfigSchema", () => {
  it("parses valid input with explicit values", () => {
    const result = GoalDecompositionConfigSchema.parse({
      max_depth: 3,
      min_specificity: 0.5,
      auto_prune_threshold: 0.4,
      parallel_loop_limit: 2,
    });
    expect(result.max_depth).toBe(3);
    expect(result.min_specificity).toBe(0.5);
    expect(result.auto_prune_threshold).toBe(0.4);
    expect(result.parallel_loop_limit).toBe(2);
  });

  it("applies defaults when no input provided", () => {
    const result = GoalDecompositionConfigSchema.parse({});
    expect(result.max_depth).toBe(5);
    expect(result.min_specificity).toBe(0.7);
    expect(result.auto_prune_threshold).toBe(0.3);
    expect(result.parallel_loop_limit).toBe(3);
  });

  it("accepts boundary values: max_depth=1 (min) and max_depth=10 (max)", () => {
    expect(GoalDecompositionConfigSchema.parse({ max_depth: 1 }).max_depth).toBe(1);
    expect(GoalDecompositionConfigSchema.parse({ max_depth: 10 }).max_depth).toBe(10);
  });

  it("accepts boundary values: parallel_loop_limit=1 (min) and =10 (max)", () => {
    expect(GoalDecompositionConfigSchema.parse({ parallel_loop_limit: 1 }).parallel_loop_limit).toBe(1);
    expect(GoalDecompositionConfigSchema.parse({ parallel_loop_limit: 10 }).parallel_loop_limit).toBe(10);
  });

  it("accepts boundary values: min_specificity=0 and =1", () => {
    expect(GoalDecompositionConfigSchema.parse({ min_specificity: 0 }).min_specificity).toBe(0);
    expect(GoalDecompositionConfigSchema.parse({ min_specificity: 1 }).min_specificity).toBe(1);
  });

  it("accepts boundary values: auto_prune_threshold=0 and =1", () => {
    expect(GoalDecompositionConfigSchema.parse({ auto_prune_threshold: 0 }).auto_prune_threshold).toBe(0);
    expect(GoalDecompositionConfigSchema.parse({ auto_prune_threshold: 1 }).auto_prune_threshold).toBe(1);
  });

  it("rejects max_depth=0 (below min)", () => {
    const result = GoalDecompositionConfigSchema.safeParse({ max_depth: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects max_depth=11 (above max)", () => {
    const result = GoalDecompositionConfigSchema.safeParse({ max_depth: 11 });
    expect(result.success).toBe(false);
  });

  it("rejects min_specificity=-0.1 (below 0)", () => {
    const result = GoalDecompositionConfigSchema.safeParse({ min_specificity: -0.1 });
    expect(result.success).toBe(false);
  });

  it("rejects min_specificity=1.1 (above 1)", () => {
    const result = GoalDecompositionConfigSchema.safeParse({ min_specificity: 1.1 });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer max_depth", () => {
    const result = GoalDecompositionConfigSchema.safeParse({ max_depth: 2.5 });
    expect(result.success).toBe(false);
  });
});

// ─── DecompositionResultSchema ───

describe("DecompositionResultSchema", () => {
  it("parses valid input with all fields", () => {
    const result = DecompositionResultSchema.parse({
      parent_id: "goal-1",
      children: [{ id: "child-1" }, { id: "child-2" }],
      depth: 2,
      specificity_scores: { "child-1": 0.8, "child-2": 0.6 },
      reasoning: "Decomposed for clarity",
    });
    expect(result.parent_id).toBe("goal-1");
    expect(result.children).toHaveLength(2);
    expect(result.depth).toBe(2);
    expect(result.specificity_scores["child-1"]).toBe(0.8);
    expect(result.reasoning).toBe("Decomposed for clarity");
  });

  it("parses with empty children array", () => {
    const result = DecompositionResultSchema.parse({
      parent_id: "goal-1",
      children: [],
      depth: 0,
      specificity_scores: {},
      reasoning: "Leaf node",
    });
    expect(result.children).toHaveLength(0);
  });

  it("parses with empty specificity_scores", () => {
    const result = DecompositionResultSchema.parse({
      parent_id: "goal-1",
      children: [],
      depth: 0,
      specificity_scores: {},
      reasoning: "No scores yet",
    });
    expect(result.specificity_scores).toEqual({});
  });

  it("rejects missing required fields", () => {
    const result = DecompositionResultSchema.safeParse({
      parent_id: "goal-1",
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative depth", () => {
    const result = DecompositionResultSchema.safeParse({
      parent_id: "goal-1",
      children: [],
      depth: -1,
      specificity_scores: {},
      reasoning: "bad",
    });
    expect(result.success).toBe(false);
  });
});

// ─── GoalTreeStateSchema ───

describe("GoalTreeStateSchema", () => {
  it("parses valid input", () => {
    const result = GoalTreeStateSchema.parse({
      root_id: "root-1",
      total_nodes: 5,
      max_depth_reached: 2,
      active_loops: ["loop-1"],
      pruned_nodes: ["node-3"],
    });
    expect(result.root_id).toBe("root-1");
    expect(result.total_nodes).toBe(5);
    expect(result.max_depth_reached).toBe(2);
    expect(result.active_loops).toEqual(["loop-1"]);
    expect(result.pruned_nodes).toEqual(["node-3"]);
  });

  it("parses with empty active_loops array", () => {
    const result = GoalTreeStateSchema.parse({
      root_id: "root-1",
      total_nodes: 1,
      max_depth_reached: 0,
      active_loops: [],
      pruned_nodes: [],
    });
    expect(result.active_loops).toHaveLength(0);
    expect(result.pruned_nodes).toHaveLength(0);
  });

  it("rejects negative total_nodes", () => {
    const result = GoalTreeStateSchema.safeParse({
      root_id: "root-1",
      total_nodes: -1,
      max_depth_reached: 0,
      active_loops: [],
      pruned_nodes: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing root_id", () => {
    const result = GoalTreeStateSchema.safeParse({
      total_nodes: 1,
      max_depth_reached: 0,
      active_loops: [],
      pruned_nodes: [],
    });
    expect(result.success).toBe(false);
  });
});

// ─── PruneReasonEnum ───

describe("PruneReasonEnum", () => {
  it("accepts all 4 valid reasons", () => {
    const reasons = ["no_progress", "superseded", "merged", "user_requested"] as const;
    for (const r of reasons) {
      expect(PruneReasonEnum.parse(r)).toBe(r);
    }
  });

  it("rejects an invalid reason", () => {
    const result = PruneReasonEnum.safeParse("expired");
    expect(result.success).toBe(false);
  });
});

// ─── PruneDecisionSchema ───

describe("PruneDecisionSchema", () => {
  it("parses valid input", () => {
    const result = PruneDecisionSchema.parse({
      goal_id: "goal-1",
      reason: "no_progress",
      replacement_id: "goal-2",
    });
    expect(result.goal_id).toBe("goal-1");
    expect(result.reason).toBe("no_progress");
    expect(result.replacement_id).toBe("goal-2");
  });

  it("defaults replacement_id to null", () => {
    const result = PruneDecisionSchema.parse({
      goal_id: "goal-1",
      reason: "merged",
    });
    expect(result.replacement_id).toBeNull();
  });

  it("accepts explicit null replacement_id", () => {
    const result = PruneDecisionSchema.parse({
      goal_id: "goal-1",
      reason: "superseded",
      replacement_id: null,
    });
    expect(result.replacement_id).toBeNull();
  });

  it("accepts all 4 prune reasons", () => {
    const reasons = ["no_progress", "superseded", "merged", "user_requested"] as const;
    for (const reason of reasons) {
      const r = PruneDecisionSchema.parse({ goal_id: "g", reason });
      expect(r.reason).toBe(reason);
    }
  });

  it("rejects invalid reason", () => {
    const result = PruneDecisionSchema.safeParse({
      goal_id: "g",
      reason: "invalid_reason",
    });
    expect(result.success).toBe(false);
  });
});

// ─── AggregationDirectionEnum ───

describe("AggregationDirectionEnum", () => {
  it("accepts all 3 directions", () => {
    const dirs = ["up", "down", "both"] as const;
    for (const d of dirs) {
      expect(AggregationDirectionEnum.parse(d)).toBe(d);
    }
  });

  it("rejects invalid direction", () => {
    const result = AggregationDirectionEnum.safeParse("sideways");
    expect(result.success).toBe(false);
  });
});

// ─── StateAggregationRuleSchema ───

describe("StateAggregationRuleSchema", () => {
  it("parses valid input", () => {
    const result = StateAggregationRuleSchema.parse({
      parent_id: "parent-1",
      child_ids: ["child-1", "child-2"],
      aggregation: "min",
      propagation_direction: "up",
    });
    expect(result.parent_id).toBe("parent-1");
    expect(result.child_ids).toEqual(["child-1", "child-2"]);
    expect(result.aggregation).toBe("min");
    expect(result.propagation_direction).toBe("up");
  });

  it("accepts all aggregation types", () => {
    const aggs = ["min", "avg", "max", "all_required"] as const;
    for (const aggregation of aggs) {
      const r = StateAggregationRuleSchema.parse({
        parent_id: "p",
        child_ids: [],
        aggregation,
        propagation_direction: "both",
      });
      expect(r.aggregation).toBe(aggregation);
    }
  });

  it("accepts all propagation directions", () => {
    const dirs = ["up", "down", "both"] as const;
    for (const propagation_direction of dirs) {
      const r = StateAggregationRuleSchema.parse({
        parent_id: "p",
        child_ids: [],
        aggregation: "avg",
        propagation_direction,
      });
      expect(r.propagation_direction).toBe(propagation_direction);
    }
  });

  it("accepts multiple child_ids", () => {
    const result = StateAggregationRuleSchema.parse({
      parent_id: "p",
      child_ids: ["c1", "c2", "c3", "c4"],
      aggregation: "max",
      propagation_direction: "down",
    });
    expect(result.child_ids).toHaveLength(4);
  });

  it("rejects invalid aggregation", () => {
    const result = StateAggregationRuleSchema.safeParse({
      parent_id: "p",
      child_ids: [],
      aggregation: "weighted_avg",
      propagation_direction: "up",
    });
    expect(result.success).toBe(false);
  });
});
