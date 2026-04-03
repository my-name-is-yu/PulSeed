import { describe, it, expect } from "vitest";
import {
  RefineConfigSchema,
  LeafDimensionSchema,
  LeafTestResultSchema,
  RefineResultSchema,
} from "../goal-refiner.js";

// ─── RefineConfigSchema ───

describe("RefineConfigSchema", () => {
  it("parses a full valid config", () => {
    const result = RefineConfigSchema.parse({
      maxDepth: 4,
      tokenBudget: 20000,
      feasibilityCheck: false,
      minSpecificity: 0.8,
      maxChildrenPerNode: 3,
    });
    expect(result.maxDepth).toBe(4);
    expect(result.feasibilityCheck).toBe(false);
  });

  it("applies defaults when fields are omitted", () => {
    const result = RefineConfigSchema.parse({});
    expect(result.maxDepth).toBe(3);
    expect(result.tokenBudget).toBe(50000);
    expect(result.feasibilityCheck).toBe(true);
    expect(result.minSpecificity).toBe(0.7);
    expect(result.maxChildrenPerNode).toBe(5);
  });

  it("rejects maxDepth below 1", () => {
    expect(() => RefineConfigSchema.parse({ maxDepth: 0 })).toThrow();
  });

  it("rejects minSpecificity above 1", () => {
    expect(() => RefineConfigSchema.parse({ minSpecificity: 1.5 })).toThrow();
  });
});

// ─── LeafDimensionSchema ───

describe("LeafDimensionSchema", () => {
  it("parses a valid leaf dimension with numeric threshold_value", () => {
    const result = LeafDimensionSchema.parse({
      name: "test_coverage",
      label: "Test Coverage",
      threshold_type: "min",
      threshold_value: 80,
      data_source: "shell",
      observation_command: "npm test -- --coverage | grep Statements",
    });
    expect(result.name).toBe("test_coverage");
    expect(result.threshold_type).toBe("min");
  });

  it("parses a valid leaf dimension with null threshold_value", () => {
    const result = LeafDimensionSchema.parse({
      name: "license_present",
      label: "License File",
      threshold_type: "present",
      threshold_value: null,
      data_source: "file_existence",
      observation_command: "test -f LICENSE",
    });
    expect(result.threshold_value).toBeNull();
  });

  it("parses string threshold_value", () => {
    const result = LeafDimensionSchema.parse({
      name: "build_status",
      label: "Build Status",
      threshold_type: "match",
      threshold_value: "passing",
      data_source: "shell",
      observation_command: "npm run build && echo passing",
    });
    expect(result.threshold_value).toBe("passing");
  });

  it("rejects invalid threshold_type", () => {
    expect(() =>
      LeafDimensionSchema.parse({
        name: "x",
        label: "X",
        threshold_type: "exact",
        threshold_value: 1,
        data_source: "shell",
        observation_command: "echo 1",
      })
    ).toThrow();
  });

  it("rejects missing required fields", () => {
    expect(() =>
      LeafDimensionSchema.parse({
        name: "x",
        label: "X",
        threshold_type: "min",
        threshold_value: 10,
        // data_source and observation_command missing
      })
    ).toThrow();
  });
});

// ─── LeafTestResultSchema ───

describe("LeafTestResultSchema", () => {
  it("parses measurable result with dimensions", () => {
    const result = LeafTestResultSchema.parse({
      is_measurable: true,
      dimensions: [
        {
          name: "coverage",
          label: "Coverage",
          threshold_type: "min",
          threshold_value: 80,
          data_source: "shell",
          observation_command: "npm test",
        },
      ],
      reason: "Can be measured via shell command.",
    });
    expect(result.is_measurable).toBe(true);
    expect(result.dimensions).toHaveLength(1);
  });

  it("parses non-measurable result with null dimensions", () => {
    const result = LeafTestResultSchema.parse({
      is_measurable: false,
      dimensions: null,
      reason: "Too abstract to measure directly.",
    });
    expect(result.is_measurable).toBe(false);
    expect(result.dimensions).toBeNull();
  });

  it("rejects missing reason", () => {
    expect(() =>
      LeafTestResultSchema.parse({
        is_measurable: false,
        dimensions: null,
      })
    ).toThrow();
  });
});

// ─── RefineResultSchema ───

describe("RefineResultSchema", () => {
  const now = new Date().toISOString();

  function makeGoalObj(id: string) {
    return {
      id,
      parent_id: null,
      node_type: "leaf" as const,
      title: "Test goal",
      description: "Test description",
      status: "active" as const,
      dimensions: [],
      gap_aggregation: "max" as const,
      dimension_mapping: null,
      constraints: [],
      children_ids: [],
      target_date: null,
      origin: null,
      pace_snapshot: null,
      deadline: null,
      confidence_flag: null,
      user_override: false,
      feasibility_note: null,
      uncertainty_weight: 1.0,
      decomposition_depth: 0,
      specificity_score: null,
      loop_status: "idle" as const,
      created_at: now,
      updated_at: now,
    };
  }

  it("parses a leaf RefineResult with no children", () => {
    const result = RefineResultSchema.parse({
      goal: makeGoalObj("g1"),
      leaf: true,
      children: null,
      feasibility: null,
      tokensUsed: 500,
      reason: "Goal is directly measurable.",
    });
    expect(result.leaf).toBe(true);
    expect(result.children).toBeNull();
    expect(result.tokensUsed).toBe(500);
  });

  it("parses a non-leaf RefineResult with children", () => {
    const child = {
      goal: makeGoalObj("g2"),
      leaf: true,
      children: null,
      feasibility: null,
      tokensUsed: 200,
      reason: "Sub-goal is measurable.",
    };
    const result = RefineResultSchema.parse({
      goal: makeGoalObj("g1"),
      leaf: false,
      children: [child],
      feasibility: null,
      tokensUsed: 800,
      reason: "Decomposed into sub-goals.",
    });
    expect(result.leaf).toBe(false);
    expect(result.children).toHaveLength(1);
  });

  it("rejects negative tokensUsed", () => {
    expect(() =>
      RefineResultSchema.parse({
        goal: makeGoalObj("g1"),
        leaf: true,
        children: null,
        feasibility: null,
        tokensUsed: -1,
        reason: "ok",
      })
    ).toThrow();
  });
});
