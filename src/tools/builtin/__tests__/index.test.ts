import { describe, expect, it } from "vitest";
import { createBuiltinTools as createBuiltinToolsFromFactory } from "../factory.js";
import { GitHubReadTool as GitHubReadToolFromExports } from "../exports.js";
import {
  createBuiltinTools,
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

describe("tools builtin index", () => {
  it("re-exports the factory and public tool classes", () => {
    expect(createBuiltinTools).toBe(createBuiltinToolsFromFactory);
    expect(GitHubReadTool).toBe(GitHubReadToolFromExports);
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
});
