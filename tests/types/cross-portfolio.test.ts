import { describe, it, expect } from "vitest";
import {
  CrossGoalAllocationSchema,
  CrossGoalPortfolioConfigSchema,
  GoalPriorityFactorsSchema,
  StrategyTemplateSchema,
  CrossGoalRebalanceTriggerEnum,
  CrossGoalRebalanceResultSchema,
  TransferTypeEnum,
  TransferCandidateSchema,
  TransferResultSchema,
  TransferEffectivenessEnum,
  TransferEffectivenessSchema,
} from "../../src/types/cross-portfolio.js";

// ─── CrossGoalAllocationSchema ───

describe("CrossGoalAllocationSchema", () => {
  it("parses valid input", () => {
    const result = CrossGoalAllocationSchema.parse({
      goal_id: "goal-1",
      priority: 0.8,
      resource_share: 0.5,
      adjustment_reason: "deadline approaching",
    });
    expect(result.goal_id).toBe("goal-1");
    expect(result.priority).toBe(0.8);
    expect(result.resource_share).toBe(0.5);
    expect(result.adjustment_reason).toBe("deadline approaching");
  });

  it("accepts boundary values: priority=0 and priority=1", () => {
    const r0 = CrossGoalAllocationSchema.parse({ goal_id: "g", priority: 0, resource_share: 0.5, adjustment_reason: "" });
    expect(r0.priority).toBe(0);
    const r1 = CrossGoalAllocationSchema.parse({ goal_id: "g", priority: 1, resource_share: 0.5, adjustment_reason: "" });
    expect(r1.priority).toBe(1);
  });

  it("accepts boundary values: resource_share=0 and resource_share=1", () => {
    const r0 = CrossGoalAllocationSchema.parse({ goal_id: "g", priority: 0.5, resource_share: 0, adjustment_reason: "" });
    expect(r0.resource_share).toBe(0);
    const r1 = CrossGoalAllocationSchema.parse({ goal_id: "g", priority: 0.5, resource_share: 1, adjustment_reason: "" });
    expect(r1.resource_share).toBe(1);
  });

  it("rejects priority out of range", () => {
    const result = CrossGoalAllocationSchema.safeParse({
      goal_id: "g", priority: 1.5, resource_share: 0.5, adjustment_reason: "",
    });
    expect(result.success).toBe(false);
  });

  it("rejects resource_share below 0", () => {
    const result = CrossGoalAllocationSchema.safeParse({
      goal_id: "g", priority: 0.5, resource_share: -0.1, adjustment_reason: "",
    });
    expect(result.success).toBe(false);
  });
});

// ─── CrossGoalPortfolioConfigSchema ───

describe("CrossGoalPortfolioConfigSchema", () => {
  it("applies defaults when no input provided", () => {
    const result = CrossGoalPortfolioConfigSchema.parse({});
    expect(result.max_concurrent_goals).toBe(5);
    expect(result.priority_rebalance_interval_hours).toBe(168);
    expect(result.min_goal_share).toBe(0.1);
    expect(result.synergy_bonus).toBe(0.2);
  });

  it("parses valid explicit input", () => {
    const result = CrossGoalPortfolioConfigSchema.parse({
      max_concurrent_goals: 3,
      priority_rebalance_interval_hours: 48,
      min_goal_share: 0.2,
      synergy_bonus: 0.5,
    });
    expect(result.max_concurrent_goals).toBe(3);
    expect(result.priority_rebalance_interval_hours).toBe(48);
    expect(result.min_goal_share).toBe(0.2);
    expect(result.synergy_bonus).toBe(0.5);
  });

  it("rejects max_concurrent_goals=0", () => {
    const result = CrossGoalPortfolioConfigSchema.safeParse({ max_concurrent_goals: 0 });
    expect(result.success).toBe(false);
  });

  it("rejects max_concurrent_goals=21 (above max 20)", () => {
    const result = CrossGoalPortfolioConfigSchema.safeParse({ max_concurrent_goals: 21 });
    expect(result.success).toBe(false);
  });
});

// ─── GoalPriorityFactorsSchema ───

describe("GoalPriorityFactorsSchema", () => {
  it("parses valid input with all fields in [0,1]", () => {
    const result = GoalPriorityFactorsSchema.parse({
      goal_id: "goal-1",
      deadline_urgency: 0.9,
      gap_severity: 0.7,
      dependency_weight: 0.5,
      user_priority: 0.8,
      computed_priority: 0.75,
    });
    expect(result.goal_id).toBe("goal-1");
    expect(result.deadline_urgency).toBe(0.9);
    expect(result.computed_priority).toBe(0.75);
  });

  it("accepts all factors at boundary 0", () => {
    const result = GoalPriorityFactorsSchema.parse({
      goal_id: "g",
      deadline_urgency: 0,
      gap_severity: 0,
      dependency_weight: 0,
      user_priority: 0,
      computed_priority: 0,
    });
    expect(result.computed_priority).toBe(0);
  });

  it("accepts all factors at boundary 1", () => {
    const result = GoalPriorityFactorsSchema.parse({
      goal_id: "g",
      deadline_urgency: 1,
      gap_severity: 1,
      dependency_weight: 1,
      user_priority: 1,
      computed_priority: 1,
    });
    expect(result.computed_priority).toBe(1);
  });

  it("rejects gap_severity above 1", () => {
    const result = GoalPriorityFactorsSchema.safeParse({
      goal_id: "g",
      deadline_urgency: 0.5,
      gap_severity: 1.1,
      dependency_weight: 0.5,
      user_priority: 0.5,
      computed_priority: 0.5,
    });
    expect(result.success).toBe(false);
  });
});

// ─── StrategyTemplateSchema ───

describe("StrategyTemplateSchema", () => {
  it("parses valid input", () => {
    const result = StrategyTemplateSchema.parse({
      template_id: "tpl-1",
      source_goal_id: "goal-1",
      source_strategy_id: "strat-1",
      hypothesis_pattern: "Do X to achieve Y",
      domain_tags: ["coding", "testing"],
      effectiveness_score: 0.75,
      applicable_dimensions: ["coverage", "quality"],
      created_at: "2024-01-01T00:00:00.000Z",
    });
    expect(result.template_id).toBe("tpl-1");
    expect(result.domain_tags).toEqual(["coding", "testing"]);
    expect(result.embedding_id).toBeNull();
  });

  it("defaults embedding_id to null", () => {
    const result = StrategyTemplateSchema.parse({
      template_id: "tpl-1",
      source_goal_id: "goal-1",
      source_strategy_id: "strat-1",
      hypothesis_pattern: "pattern",
      domain_tags: [],
      effectiveness_score: 0.5,
      applicable_dimensions: [],
      created_at: "2024-06-15T12:00:00.000Z",
    });
    expect(result.embedding_id).toBeNull();
  });

  it("accepts explicit embedding_id", () => {
    const result = StrategyTemplateSchema.parse({
      template_id: "tpl-1",
      source_goal_id: "goal-1",
      source_strategy_id: "strat-1",
      hypothesis_pattern: "pattern",
      domain_tags: [],
      effectiveness_score: 0.5,
      applicable_dimensions: [],
      embedding_id: "emb-42",
      created_at: "2024-06-15T12:00:00.000Z",
    });
    expect(result.embedding_id).toBe("emb-42");
  });

  it("rejects invalid datetime in created_at", () => {
    const result = StrategyTemplateSchema.safeParse({
      template_id: "tpl-1",
      source_goal_id: "goal-1",
      source_strategy_id: "strat-1",
      hypothesis_pattern: "pattern",
      domain_tags: [],
      effectiveness_score: 0.5,
      applicable_dimensions: [],
      created_at: "not-a-date",
    });
    expect(result.success).toBe(false);
  });
});

// ─── CrossGoalRebalanceTriggerEnum ───

describe("CrossGoalRebalanceTriggerEnum", () => {
  it("accepts all 4 trigger types", () => {
    const triggers = ["periodic", "goal_completed", "goal_added", "priority_shift"] as const;
    for (const t of triggers) {
      expect(CrossGoalRebalanceTriggerEnum.parse(t)).toBe(t);
    }
  });

  it("rejects invalid trigger", () => {
    const result = CrossGoalRebalanceTriggerEnum.safeParse("manual_override");
    expect(result.success).toBe(false);
  });
});

// ─── CrossGoalRebalanceResultSchema ───

describe("CrossGoalRebalanceResultSchema", () => {
  it("parses valid input", () => {
    const result = CrossGoalRebalanceResultSchema.parse({
      timestamp: "2024-01-01T00:00:00.000Z",
      allocations: [
        { goal_id: "g1", priority: 0.6, resource_share: 0.4, adjustment_reason: "higher gap" },
      ],
      triggered_by: "periodic",
    });
    expect(result.triggered_by).toBe("periodic");
    expect(result.allocations).toHaveLength(1);
  });

  it("parses with empty allocations array", () => {
    const result = CrossGoalRebalanceResultSchema.parse({
      timestamp: "2024-01-01T00:00:00.000Z",
      allocations: [],
      triggered_by: "goal_added",
    });
    expect(result.allocations).toHaveLength(0);
  });
});

// ─── TransferTypeEnum ───

describe("TransferTypeEnum", () => {
  it("accepts all 3 transfer types", () => {
    const types = ["knowledge", "strategy", "pattern"] as const;
    for (const t of types) {
      expect(TransferTypeEnum.parse(t)).toBe(t);
    }
  });

  it("rejects invalid transfer type", () => {
    const result = TransferTypeEnum.safeParse("experience");
    expect(result.success).toBe(false);
  });
});

// ─── TransferCandidateSchema ───

describe("TransferCandidateSchema", () => {
  it("parses valid input", () => {
    const result = TransferCandidateSchema.parse({
      candidate_id: "cand-1",
      source_goal_id: "goal-1",
      target_goal_id: "goal-2",
      type: "knowledge",
      source_item_id: "item-5",
      similarity_score: 0.85,
      estimated_benefit: "reduce rework",
    });
    expect(result.candidate_id).toBe("cand-1");
    expect(result.type).toBe("knowledge");
    expect(result.similarity_score).toBe(0.85);
  });

  it("rejects similarity_score above 1", () => {
    const result = TransferCandidateSchema.safeParse({
      candidate_id: "c",
      source_goal_id: "g1",
      target_goal_id: "g2",
      type: "pattern",
      source_item_id: "i",
      similarity_score: 1.1,
      estimated_benefit: "benefit",
    });
    expect(result.success).toBe(false);
  });
});

// ─── TransferResultSchema ───

describe("TransferResultSchema", () => {
  it("parses valid input with success=true", () => {
    const result = TransferResultSchema.parse({
      transfer_id: "tr-1",
      candidate_id: "cand-1",
      applied_at: "2024-03-15T10:00:00.000Z",
      adaptation_description: "adapted for new context",
      success: true,
    });
    expect(result.success).toBe(true);
  });

  it("parses valid input with success=false", () => {
    const result = TransferResultSchema.parse({
      transfer_id: "tr-2",
      candidate_id: "cand-2",
      applied_at: "2024-03-15T10:00:00.000Z",
      adaptation_description: "failed to adapt",
      success: false,
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid applied_at datetime", () => {
    const result = TransferResultSchema.safeParse({
      transfer_id: "tr-1",
      candidate_id: "cand-1",
      applied_at: "bad-date",
      adaptation_description: "desc",
      success: true,
    });
    expect(result.success).toBe(false);
  });
});

// ─── TransferEffectivenessEnum ───

describe("TransferEffectivenessEnum", () => {
  it("accepts all 3 effectiveness values", () => {
    const values = ["positive", "negative", "neutral"] as const;
    for (const v of values) {
      expect(TransferEffectivenessEnum.parse(v)).toBe(v);
    }
  });

  it("rejects invalid effectiveness value", () => {
    const result = TransferEffectivenessEnum.safeParse("inconclusive");
    expect(result.success).toBe(false);
  });
});

// ─── TransferEffectivenessSchema ───

describe("TransferEffectivenessSchema", () => {
  it("parses valid input", () => {
    const result = TransferEffectivenessSchema.parse({
      transfer_id: "tr-1",
      gap_delta_before: 0.4,
      gap_delta_after: 0.2,
      effectiveness: "positive",
      evaluated_at: "2024-03-20T08:00:00.000Z",
    });
    expect(result.transfer_id).toBe("tr-1");
    expect(result.effectiveness).toBe("positive");
    expect(result.gap_delta_before).toBe(0.4);
  });

  it("accepts negative gap deltas", () => {
    const result = TransferEffectivenessSchema.parse({
      transfer_id: "tr-2",
      gap_delta_before: -0.1,
      gap_delta_after: -0.3,
      effectiveness: "negative",
      evaluated_at: "2024-03-20T08:00:00.000Z",
    });
    expect(result.gap_delta_before).toBe(-0.1);
  });

  it("rejects missing evaluated_at", () => {
    const result = TransferEffectivenessSchema.safeParse({
      transfer_id: "tr-1",
      gap_delta_before: 0.1,
      gap_delta_after: 0.0,
      effectiveness: "neutral",
    });
    expect(result.success).toBe(false);
  });
});
