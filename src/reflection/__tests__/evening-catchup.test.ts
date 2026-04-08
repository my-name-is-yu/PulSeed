import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempDir, cleanupTempDir } from "../../../tests/helpers/temp-dir.js";
import { createMockLLMClient } from "../../../tests/helpers/mock-llm.js";
import { runEveningCatchup } from "../evening-catchup.js";
import type { Goal } from "../../base/types/goal.js";

// ─── Fixtures ───

function makeGoal(id: string, overrides: Partial<Goal> = {}): Goal {
  return {
    id,
    parent_id: null,
    node_type: "goal",
    title: `Goal ${id}`,
    description: "",
    status: "active",
    dimensions: [
      {
        name: "progress",
        label: "Progress",
        current_value: 0.5,
        threshold: { type: "min", value: 1.0 },
        confidence: 0.8,
        observation_method: {
          type: "manual",
          source: "self_report",
          schedule: null,
          endpoint: null,
          confidence_tier: "self_report",
        },
        last_updated: null,
        history: [],
        weight: 1.0,
        uncertainty_weight: null,
        state_integrity: "ok",
        dimension_mapping: null,
      },
    ],
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
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeStateManager(goals: Goal[]) {
  return {
    listGoalIds: vi.fn().mockResolvedValue(goals.map((g) => g.id)),
    loadGoal: vi.fn().mockImplementation(async (id: string) => goals.find((g) => g.id === id) ?? null),
    loadGapHistory: vi.fn().mockResolvedValue([]),
  };
}

const VALID_LLM_RESPONSE = JSON.stringify({
  progress_summary: "Good progress made today.",
  completions: ["g1 dimension met"],
  stalls: [],
  concerns: [],
});

// ─── Tests ───

describe("runEveningCatchup", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) cleanupTempDir(tmpDir);
  });

  it("happy path: returns a valid CatchupReport", async () => {
    tmpDir = makeTempDir();
    const goals = [makeGoal("g1"), makeGoal("g2")];
    const stateManager = makeStateManager(goals);
    const llmClient = createMockLLMClient([VALID_LLM_RESPONSE]);

    const report = await runEveningCatchup({
      stateManager: stateManager as never,
      llmClient,
      baseDir: tmpDir,
    });

    expect(report.goals_reviewed).toBe(2);
    expect(report.progress_summary).toBe("Good progress made today.");
    expect(report.completions).toEqual(["g1 dimension met"]);
    expect(report.stalls).toHaveLength(0);
    expect(report.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("empty goals: returns default report", async () => {
    tmpDir = makeTempDir();
    const stateManager = makeStateManager([]);
    const llmClient = createMockLLMClient([]);

    const report = await runEveningCatchup({
      stateManager: stateManager as never,
      llmClient,
      baseDir: tmpDir,
    });

    expect(report.goals_reviewed).toBe(0);
    expect(report.progress_summary).toBe("No active goals to review.");
    expect(llmClient.callCount).toBe(0);
  });

  it("persists report to file", async () => {
    tmpDir = makeTempDir();
    const goals = [makeGoal("g1")];
    const stateManager = makeStateManager(goals);
    const llmClient = createMockLLMClient([VALID_LLM_RESPONSE]);

    const report = await runEveningCatchup({
      stateManager: stateManager as never,
      llmClient,
      baseDir: tmpDir,
    });

    const filePath = path.join(tmpDir, "reflections", `evening-${report.date}.json`);
    expect(fs.existsSync(filePath)).toBe(true);
    const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(content.goals_reviewed).toBe(1);
  });

  it("LLM error: returns partial report without crashing", async () => {
    tmpDir = makeTempDir();
    const goals = [makeGoal("g1")];
    const stateManager = makeStateManager(goals);
    const llmClient = {
      callCount: 0,
      sendMessage: vi.fn().mockRejectedValue(new Error("LLM unavailable")),
      parseJSON: vi.fn(),
    };

    const report = await runEveningCatchup({
      stateManager: stateManager as never,
      llmClient: llmClient as never,
      baseDir: tmpDir,
    });

    expect(report.goals_reviewed).toBe(1);
    expect(report.progress_summary).toBe("Unable to generate summary due to LLM error.");
  });

  it("calls notificationDispatcher when goals present", async () => {
    tmpDir = makeTempDir();
    const goals = [makeGoal("g1")];
    const stateManager = makeStateManager(goals);
    const llmClient = createMockLLMClient([VALID_LLM_RESPONSE]);
    const dispatcher = { dispatch: vi.fn().mockResolvedValue([]) };

    await runEveningCatchup({
      stateManager: stateManager as never,
      llmClient,
      baseDir: tmpDir,
      notificationDispatcher: dispatcher as never,
    });

    expect(dispatcher.dispatch).toHaveBeenCalledOnce();
  });
});
