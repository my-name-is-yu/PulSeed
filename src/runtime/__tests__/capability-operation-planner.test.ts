import { describe, expect, it } from "vitest";
import { assembleScheduleOperationPlans } from "../capability-operation-planner.js";
import {
  ScheduleEntrySchema,
  ScheduleInternalAttentionProjectionSchema,
  type ScheduleEntry,
  type ScheduleInternalAttentionProjection,
} from "../types/schedule.js";

const NOW = "2026-05-09T00:00:00.000Z";

function entry(overrides: Partial<ScheduleEntry> = {}): ScheduleEntry {
  return ScheduleEntrySchema.parse({
    id: "11111111-1111-4111-8111-111111111111",
    name: "wait resume",
    layer: "goal_trigger",
    trigger: { type: "interval", seconds: 60, jitter_factor: 0 },
    enabled: true,
    metadata: {
      internal: true,
      activation_kind: "wait_resume",
      goal_id: "goal-1",
      strategy_id: "strategy:wait",
      wait_strategy_id: "strategy:wait",
    },
    goal_trigger: {
      goal_id: "goal-1",
      max_iterations: 5,
      skip_if_active: false,
    },
    created_at: NOW,
    updated_at: NOW,
    last_fired_at: null,
    next_fire_at: NOW,
    ...overrides,
  });
}

function projection(): ScheduleInternalAttentionProjection {
  return ScheduleInternalAttentionProjectionSchema.parse({
    kind: "wait_resume_attention_projection",
    projected_at: NOW,
    signal_context_id: `signal:schedule-wake:11111111-1111-4111-8111-111111111111:${NOW}`,
    signal_sources: ["schedule_tick", "wait_expiry"],
    urge_candidate_refs: ["urge:1"],
    agenda_item_refs: ["agenda:1"],
    inhibition_decisions: [],
    initiative_gate_decisions: [{ ref: "gate:1", status: "delayed" }],
    runtime_items: [{
      ref: "runtime:item:1",
      type: "agent_agenda_item",
      status: "pending",
      posture: "holding",
      visibility_display: "hidden",
      inspectable: true,
      auditable: true,
    }],
    non_execution_states: ["delayed", "held", "silent_runtime_item"],
    summary: "wait resume projection",
  });
}

describe("assembleScheduleOperationPlans", () => {
  it("assembles wait-resume attention output into an advisory candidate plan", () => {
    const assembly = assembleScheduleOperationPlans({
      entry: entry(),
      firedAt: NOW,
      projection: projection(),
    });

    expect(assembly.status).toBe("planned");
    expect(assembly.candidate_plans).toHaveLength(1);
    expect(assembly.candidate_plans[0]?.operation_plan).toMatchObject({
      operation_kind: "hint",
      side_effect_profile: "none",
      external_action_authority: false,
      advisory_only: true,
      local_only: true,
      expected_user_visible_effect: false,
    });
    expect(assembly.candidate_plans[0]?.admission_scope).toMatchObject({
      requires_runtime_control: false,
      external_action_authority: false,
      required_permission_capabilities: [],
    });
  });

  it("fails closed when the attention projection belongs to a different schedule tick", () => {
    const assembly = assembleScheduleOperationPlans({
      entry: entry(),
      firedAt: NOW,
      projection: {
        ...projection(),
        signal_context_id: "signal:schedule-wake:11111111-1111-4111-8111-111111111111:2026-05-08T00:00:00.000Z",
      },
    });

    expect(assembly).toMatchObject({
      status: "fail_closed",
      reason: "Wait-resume attention projection does not match the schedule tick context.",
      candidate_plans: [],
    });
  });

  it("fails closed when wait-resume source context is incomplete", () => {
    const assembly = assembleScheduleOperationPlans({
      entry: entry(),
      firedAt: NOW,
    });

    expect(assembly).toMatchObject({
      status: "fail_closed",
      candidate_plans: [],
    });
  });

  it("fails closed when wait-resume metadata does not match the trigger goal", () => {
    const assembly = assembleScheduleOperationPlans({
      entry: entry({
        metadata: {
          internal: true,
          source: "manual",
          dependency_hints: [],
          activation_kind: "wait_resume",
          goal_id: "stale-goal",
          strategy_id: "strategy:wait",
          wait_strategy_id: "strategy:wait",
        },
      }),
      firedAt: NOW,
      projection: projection(),
    });

    expect(assembly).toMatchObject({
      status: "fail_closed",
      candidate_plans: [],
    });
  });
});
