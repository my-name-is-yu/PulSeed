import type { StateManager } from "../../../base/state/state-manager.js";
import { makeGoal } from "../../../../tests/helpers/fixtures.js";

export async function seedGoalState(
  stateManager: StateManager,
  goalId: string,
  gap: number = 0.5,
): Promise<void> {
  await stateManager.saveGoal(makeGoal({ id: goalId }));
  await stateManager.saveGapHistory(goalId, [
    {
      iteration: 1,
      timestamp: "2026-05-10T00:00:00.000Z",
      gap_vector: [{ dimension_name: "overall", normalized_weighted_gap: gap }],
      confidence_vector: [{ dimension_name: "overall", confidence: 1 }],
    },
  ]);
}
