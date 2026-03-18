import type { Goal, Dimension } from "../../src/types/goal.js";

export function makeDimension(overrides: Partial<Dimension> = {}): Dimension {
  const now = new Date().toISOString();
  return {
    name: "dim1",
    label: "Dimension 1",
    current_value: 5,
    threshold: { type: "min", value: 10 },
    confidence: 0.8,
    observation_method: {
      type: "mechanical",
      source: "test",
      schedule: null,
      endpoint: null,
      confidence_tier: "mechanical",
    },
    last_updated: now,
    history: [],
    weight: 1.0,
    uncertainty_weight: null,
    state_integrity: "ok",
    dimension_mapping: null,
    ...overrides,
  };
}

export function makeGoal(overrides: Partial<Goal> = {}): Goal {
  const now = new Date().toISOString();
  return {
    id: "goal-1",
    parent_id: null,
    node_type: "goal",
    title: "Test Goal",
    description: "A test goal",
    status: "active",
    dimensions: [makeDimension()],
    gap_aggregation: "max",
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
    loop_status: "idle",
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}
