import { describe, expect, it } from "vitest";
import {
  findLinkedRuntimeBudget,
  formatRuntimeBudgetSummary,
  type RuntimeBudgetProjection,
} from "../../runtime-budget-summary.js";
import type { Goal } from "../../../base/types/goal.js";
import type { RuntimeBudgetRecord, RuntimeBudgetStatus } from "../../../runtime/store/budget-store.js";
import type { RuntimeSessionRegistrySnapshot } from "../../../runtime/session-registry/types.js";

const baseGoal: Goal = {
  id: "goal-a",
  title: "Daily work",
  description: "Daily work",
  status: "active",
  loop_status: "running",
  dimensions: [],
  children_ids: [],
  parent_id: null,
  created_at: "2026-05-09T00:00:00.000Z",
  updated_at: "2026-05-09T00:00:00.000Z",
} as unknown as Goal;

function projection(overrides: Partial<RuntimeBudgetStatus> = {}): RuntimeBudgetProjection {
  const status: RuntimeBudgetStatus = {
    budget_id: "budget-a",
    scope: { goal_id: "goal-a" },
    mode: "exploration",
    dimensions: [{
      dimension: "iterations",
      limit: 5,
      used: 4,
      remaining: 1,
      exhausted: false,
      exhaustion_policy: "approval_required",
      threshold_actions: [],
    }],
    approval_required: false,
    handoff_required: false,
    finalization_required: false,
    exhausted: false,
    recent_consumption: [],
    ...overrides,
  };
  const budget: RuntimeBudgetRecord = {
    schema_version: "runtime-budget-v1",
    budget_id: status.budget_id,
    scope: status.scope,
    title: "Runtime budget",
    created_at: "2026-05-09T00:00:00.000Z",
    updated_at: "2026-05-09T00:01:00.000Z",
    limits: status.dimensions.map((dimension) => ({
      dimension: dimension.dimension,
      limit: dimension.limit,
      exhaustion_policy: dimension.exhaustion_policy,
    })),
    usage: status.dimensions.map((dimension) => ({
      dimension: dimension.dimension,
      used: dimension.used,
      updated_at: "2026-05-09T00:01:00.000Z",
      recent: [],
    })),
  };
  return { budget, status };
}

describe("runtime budget summary", () => {
  it("renders plain threshold states for everyday status output", () => {
    expect(formatRuntimeBudgetSummary(projection({ approval_required: true }))).toContain("approval needed to continue");
    expect(formatRuntimeBudgetSummary(projection({ handoff_required: true }))).toContain("handoff needed");
    expect(formatRuntimeBudgetSummary(projection({ finalization_required: true }))).toContain("finalization should start");
    expect(formatRuntimeBudgetSummary(projection({
      exhausted: true,
      mode: "exhausted",
      dimensions: [{
        dimension: "iterations",
        limit: 5,
        used: 5,
        remaining: 0,
        exhausted: true,
        exhaustion_policy: "approval_required",
        threshold_actions: ["approval_required"],
      }],
      approval_required: true,
    }))).toContain("budget spent");
  });

  it("links budgets only through typed goal and run IDs", () => {
    const byRun = projection({
      budget_id: "budget-run",
      scope: { run_id: "run:coreloop:goal-a" },
    });
    const unrelated = projection({
      budget_id: "budget-unrelated",
      scope: { goal_id: "goal-b" },
    });
    const snapshot: RuntimeSessionRegistrySnapshot = {
      schema_version: "runtime-session-registry-v1",
      generated_at: "2026-05-09T00:00:00.000Z",
      sessions: [],
      background_runs: [{
        schema_version: "background-run-v1",
        id: "run:coreloop:goal-a",
        kind: "coreloop_run",
        parent_session_id: null,
        child_session_id: null,
        process_session_id: null,
        goal_id: "goal-a",
        status: "running",
        notify_policy: "silent",
        reply_target_source: "none",
        pinned_reply_target: null,
        title: null,
        workspace: null,
        created_at: null,
        started_at: null,
        updated_at: null,
        completed_at: null,
        summary: null,
        error: null,
        artifacts: [],
        source_refs: [],
      }],
      warnings: [],
    };

    expect(findLinkedRuntimeBudget(baseGoal, [unrelated, byRun], snapshot)?.budget.budget_id).toBe("budget-run");
    expect(findLinkedRuntimeBudget(baseGoal, [unrelated], snapshot)).toBeNull();
  });
});
