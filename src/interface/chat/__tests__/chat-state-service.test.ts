import { describe, expect, it, vi } from "vitest";
import type { StateManager } from "../../../base/state/state-manager.js";
import { ChatStateService } from "../chat-state-service.js";
import { listAllGoalIds } from "../chat-runner-command-helpers.js";

describe("chat state goal listing", () => {
  it("uses typed active and archived goal IDs without probing recoverable legacy archives", async () => {
    const stateManager = {
      listGoalIds: vi.fn(async () => ["active-goal"]),
      listArchivedGoals: vi.fn(async () => ["archived-goal"]),
      listRecoverableArchivedGoalIds: vi.fn(async () => {
        throw new Error("legacy archive recovery should not be queried by normal chat runtime");
      }),
    } as unknown as StateManager;

    await expect(listAllGoalIds(stateManager)).resolves.toEqual(["active-goal", "archived-goal"]);
    await expect(new ChatStateService(stateManager).listAllGoalIds()).resolves.toEqual([
      "active-goal",
      "archived-goal",
    ]);
    expect(stateManager.listRecoverableArchivedGoalIds).not.toHaveBeenCalled();
  });
});
