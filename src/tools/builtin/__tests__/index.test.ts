import { describe, expect, it, vi } from "vitest";
import type { ToolCallContext } from "../../types.js";
import { createBuiltinTools as createBuiltinToolsFromFactory } from "../factory.js";
import type { BuiltinToolDeps } from "../factory.js";
import { GitHubReadTool as GitHubReadToolFromExports } from "../exports.js";
import {
  createBuiltinTools,
  CodeReadContextTool,
  CodeSearchRepairTool,
  CodeSearchTool,
  GitHubReadTool,
  KaggleCompareExperimentsTool,
  KaggleExperimentListTool,
  KaggleExperimentReadTool,
  KaggleExperimentStartTool,
  KaggleExperimentStopTool,
  KaggleLeaderboardSnapshotTool,
  KaggleListSubmissionsTool,
  KaggleMetricReportTool,
  KaggleSubmissionPrepareTool,
  KaggleSubmitTool,
  KaggleWorkspacePrepareTool,
} from "../index.js";

function makeToolContext(): ToolCallContext {
  return {
    cwd: process.cwd(),
    goalId: "goal-1",
    trustBalance: 0,
    preApproved: true,
    approvalFn: async () => true,
  };
}

function findCoreGoalStatusTool(deps: BuiltinToolDeps) {
  const tool = createBuiltinTools(deps).find((candidate) => candidate.metadata.name === "core_goal_status");
  expect(tool).toBeDefined();
  return tool!;
}

describe("tools builtin index", () => {
  it("re-exports the factory and public tool classes", () => {
    expect(createBuiltinTools).toBe(createBuiltinToolsFromFactory);
    expect(GitHubReadTool).toBe(GitHubReadToolFromExports);
    expect(CodeSearchTool).toBeDefined();
    expect(CodeReadContextTool).toBeDefined();
    expect(CodeSearchRepairTool).toBeDefined();
    expect(KaggleWorkspacePrepareTool).toBeDefined();
    expect(KaggleExperimentStartTool).toBeDefined();
    expect(KaggleExperimentReadTool).toBeDefined();
    expect(KaggleExperimentListTool).toBeDefined();
    expect(KaggleExperimentStopTool).toBeDefined();
    expect(KaggleLeaderboardSnapshotTool).toBeDefined();
    expect(KaggleListSubmissionsTool).toBeDefined();
    expect(KaggleMetricReportTool).toBeDefined();
    expect(KaggleCompareExperimentsTool).toBeDefined();
    expect(KaggleSubmissionPrepareTool).toBeDefined();
    expect(KaggleSubmitTool).toBeDefined();
  });

  it("wires DurableLoop control deps through the builtin factory", async () => {
    const durableGoalStatus = vi.fn().mockResolvedValue({ source: "durable" });
    const legacyGoalStatus = vi.fn().mockResolvedValue({ source: "legacy" });
    const tool = findCoreGoalStatusTool({
      stateManager: {} as NonNullable<BuiltinToolDeps["stateManager"]>,
      durableLoopControl: { goalStatus: durableGoalStatus },
      coreLoopControl: { goalStatus: legacyGoalStatus },
    });

    const result = await tool.call({ goalId: "goal-1" }, makeToolContext());

    expect(result).toMatchObject({ success: true, data: { source: "durable" } });
    expect(durableGoalStatus).toHaveBeenCalledWith({ goalId: "goal-1" });
    expect(legacyGoalStatus).not.toHaveBeenCalled();
  });

  it("keeps legacy CoreLoop control deps as a compatibility fallback", async () => {
    const legacyGoalStatus = vi.fn().mockResolvedValue({ source: "legacy" });
    const tool = findCoreGoalStatusTool({
      stateManager: {} as NonNullable<BuiltinToolDeps["stateManager"]>,
      coreLoopControl: { goalStatus: legacyGoalStatus },
    });

    const result = await tool.call({ goalId: "goal-1" }, makeToolContext());

    expect(result).toMatchObject({ success: true, data: { source: "legacy" } });
    expect(legacyGoalStatus).toHaveBeenCalledWith({ goalId: "goal-1" });
  });
});
