import { describe, expect, it, vi } from "vitest";
import { CuriosityConfigSchema } from "../../../base/types/curiosity.js";
import type { StallState } from "../../../base/types/stall.js";
import { makeDimension, makeGoal } from "../../../../tests/helpers/fixtures.js";
import {
  checkRepeatedFailures,
  checkTaskQueueEmpty,
  checkUnexpectedObservation,
  evaluateCuriosityTriggers,
  shouldExploreForCuriosity,
} from "../curiosity-triggers.js";

const config = CuriosityConfigSchema.parse({});

describe("curiosity trigger helpers", () => {
  it("treats non-curiosity completed and waiting goals as an empty user queue", () => {
    const trigger = checkTaskQueueEmpty([
      makeGoal({ id: "curiosity-goal", status: "active", origin: "curiosity" }),
      makeGoal({ id: "manual-goal", status: "waiting", origin: "manual" }),
      makeGoal({ id: "user-goal", status: "completed", origin: null }),
    ]);

    expect(trigger?.type).toBe("task_queue_empty");
    expect(trigger?.details).toContain("2 user goal(s)");
  });

  it("detects unexpected numeric observations with the configured threshold", () => {
    const trigger = checkUnexpectedObservation([
      makeGoal({
        id: "goal-observed",
        status: "active",
        dimensions: [
          makeDimension({
            name: "latency",
            current_value: 200,
            history: [48, 50, 52, 50].map((value, index) => ({
              value,
              timestamp: `2026-05-10T00:00:0${index}.000Z`,
              confidence: 0.9,
              source_observation_id: `obs-${index}`,
            })),
          }),
        ],
      }),
    ], config);

    expect(trigger?.type).toBe("unexpected_observation");
    expect(trigger?.source_goal_id).toBe("goal-observed");
  });

  it("checks repeated failures only for active user goals", async () => {
    const stallDetector = {
      getStallState: vi.fn(async (goalId: string) => makeStallState(goalId, { delivery: 1 })),
    };

    const trigger = await checkRepeatedFailures([
      makeGoal({ id: "curiosity-goal", status: "active", origin: "curiosity" }),
      makeGoal({ id: "waiting-goal", status: "waiting", origin: null }),
      makeGoal({ id: "active-user-goal", status: "active", origin: null }),
    ], stallDetector);

    expect(stallDetector.getStallState).toHaveBeenCalledTimes(1);
    expect(stallDetector.getStallState).toHaveBeenCalledWith("active-user-goal");
    expect(trigger?.type).toBe("repeated_failure");
  });

  it("uses the same condition contract for full trigger evaluation and quick exploration checks", async () => {
    const stallDetector = {
      getStallState: vi.fn(async (goalId: string) => makeStallState(goalId, {})),
    };
    const state = { last_exploration_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() };
    const oneHourConfig = CuriosityConfigSchema.parse({ periodic_exploration_hours: 1 });
    const goals = [makeGoal({ id: "active-user-goal", status: "active", origin: null })];

    const triggers = await evaluateCuriosityTriggers(goals, {
      config: oneHourConfig,
      stallDetector,
      state,
    });
    const shouldExplore = await shouldExploreForCuriosity(goals, {
      config: oneHourConfig,
      stallDetector,
      state,
    });

    expect(triggers.map((trigger) => trigger.type)).toContain("periodic_exploration");
    expect(shouldExplore).toBe(true);
  });
});

function makeStallState(goalId: string, dimensionEscalation: Record<string, number>): StallState {
  return {
    goal_id: goalId,
    dimension_escalation: dimensionEscalation,
    global_escalation: 0,
    decay_factors: {},
    recovery_loops: {},
  };
}
