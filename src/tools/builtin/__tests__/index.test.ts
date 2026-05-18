import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
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

function makeArcSnapshot() {
  return {
    game_id: "ls20-016295f7601e",
    guid: "guid-state-root",
    frame: [[[0]]],
    state: "NOT_FINISHED",
    levels_completed: 0,
    win_levels: 254,
    action_input: { id: 0, data: {} },
    available_actions: [1, 2, 3],
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
    expect(durableGoalStatus).toHaveBeenCalledWith(
      { goalId: "goal-1" },
      expect.objectContaining({ goalId: "goal-1", preApproved: true }),
    );
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
    expect(legacyGoalStatus).toHaveBeenCalledWith(
      { goalId: "goal-1" },
      expect.objectContaining({ goalId: "goal-1", preApproved: true }),
    );
  });

  it("roots ARC-AGI-3 artifacts under the active state manager base directory", async () => {
    const baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pulseed-builtin-arc-root-"));
    const previousArcKey = process.env["ARC_API_KEY"];
    const previousArcBaseUrl = process.env["ARC_AGI3_BASE_URL"];
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target.endsWith("/api/scorecard/open")) {
        return new Response(JSON.stringify({ card_id: "card-state-root" }), { status: 200 });
      }
      if (target.endsWith("/api/cmd/RESET")) {
        return new Response(JSON.stringify(makeArcSnapshot()), { status: 200 });
      }
      return new Response(JSON.stringify({ error: "unexpected" }), { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
    process.env["ARC_API_KEY"] = "arc-test-key";
    process.env["ARC_AGI3_BASE_URL"] = "https://arc.example.test";
    try {
      const stateManager = {
        getBaseDir: () => baseDir,
      } as NonNullable<BuiltinToolDeps["stateManager"]>;
      const startTool = createBuiltinTools({ stateManager })
        .find((candidate) => candidate.metadata.name === "arc_agi3_start");
      expect(startTool).toBeDefined();

      const result = await startTool!.call({
        game_id: "ls20-016295f7601e",
        run_id: "run-state-root",
      }, {
        ...makeToolContext(),
        providerConfigBaseDir: baseDir,
      });

      expect(result.success).toBe(true);
      const expectedArtifactPath = path.join(baseDir, "arc-agi-3", "runs", "run-state-root", "run.json");
      expect((result.data as { artifact_path?: string }).artifact_path).toBe(expectedArtifactPath);
      expect(fs.existsSync(expectedArtifactPath)).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
      if (previousArcKey === undefined) {
        delete process.env["ARC_API_KEY"];
      } else {
        process.env["ARC_API_KEY"] = previousArcKey;
      }
      if (previousArcBaseUrl === undefined) {
        delete process.env["ARC_AGI3_BASE_URL"];
      } else {
        process.env["ARC_AGI3_BASE_URL"] = previousArcBaseUrl;
      }
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
