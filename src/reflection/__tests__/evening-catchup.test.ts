import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempDir, cleanupTempDir } from "../../../tests/helpers/temp-dir.js";
import { createMockLLMClient } from "../../../tests/helpers/mock-llm.js";
import { runEveningCatchup } from "../evening-catchup.js";
import { todayISO } from "../reflection-utils.js";
import type { Goal } from "../../base/types/goal.js";
import { upsertRelationshipProfileItem } from "../../platform/profile/relationship-profile.js";

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

  it("routes local-planning relationship profile items through an evening Surface", async () => {
    tmpDir = makeTempDir();
    await upsertRelationshipProfileItem(tmpDir, {
      stableKey: "user.preference.catchup",
      kind: "preference",
      value: "Prefer catch-up reports to identify stalls directly.",
      source: "cli_update",
      allowedScopes: ["local_planning"],
      now: "2026-05-02T00:00:00.000Z",
    });
    await upsertRelationshipProfileItem(tmpDir, {
      stableKey: "user.preference.resident_only",
      kind: "preference",
      value: "Resident-only evening detail should not affect catch-up.",
      source: "cli_update",
      allowedScopes: ["resident_behavior"],
      now: "2026-05-02T01:00:00.000Z",
    });
    await upsertRelationshipProfileItem(tmpDir, {
      stableKey: "user.preference.sensitive_catchup",
      kind: "preference",
      value: "Sensitive catch-up detail should stay out of prompts.",
      source: "cli_update",
      sensitivity: "sensitive",
      allowedScopes: ["local_planning"],
      now: "2026-05-02T02:00:00.000Z",
    });
    const goals = [makeGoal("g1")];
    const stateManager = makeStateManager(goals);
    const sendMessage = vi.fn().mockResolvedValue({ content: VALID_LLM_RESPONSE });
    const llmClient = {
      sendMessage,
      parseJSON: vi.fn().mockImplementation((content: string, schema: { parse(value: unknown): unknown }) =>
        schema.parse(JSON.parse(content))
      ),
    };

    await runEveningCatchup({
      stateManager: stateManager as never,
      llmClient: llmClient as never,
      baseDir: tmpDir,
    });

    const prompt = sendMessage.mock.calls[0]?.[0]?.[0]?.content ?? "";
    expect(prompt).toContain("Evening catch-up relationship profile Surface");
    expect(prompt).toContain("requested_use=goal_planning");
    expect(prompt).toContain("Use only Surface-included relationship context below.");
    expect(prompt).not.toContain("Relationship Profile (active items only; consent scope: local_planning)");
    expect(prompt).toContain("Prefer catch-up reports to identify stalls directly.");
    expect(prompt).not.toContain("Resident-only evening detail should not affect catch-up.");
    expect(prompt).not.toContain("Sensitive catch-up detail should stay out of prompts.");
  });

  it("ignores invalid persisted morning reports before prompting", async () => {
    tmpDir = makeTempDir();
    fs.mkdirSync(path.join(tmpDir, "reflections"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "reflections", `morning-${todayISO()}.json`),
      JSON.stringify({
        date: todayISO(),
        created_at: new Date().toISOString(),
        goals_reviewed: Number.MAX_SAFE_INTEGER + 1,
        priorities: [],
        suggestions: ["unsafe morning plan should not appear"],
        concerns: [],
      }),
      "utf-8"
    );
    const goals = [makeGoal("g1")];
    const stateManager = makeStateManager(goals);
    const sendMessage = vi.fn().mockResolvedValue({ content: VALID_LLM_RESPONSE });
    const llmClient = {
      sendMessage,
      parseJSON: vi.fn().mockImplementation((content: string, schema: { parse(value: unknown): unknown }) =>
        schema.parse(JSON.parse(content))
      ),
    };

    await runEveningCatchup({
      stateManager: stateManager as never,
      llmClient: llmClient as never,
      baseDir: tmpDir,
    });

    const prompt = sendMessage.mock.calls[0]?.[0]?.[0]?.content ?? "";
    expect(prompt).not.toContain("Morning plan:");
    expect(prompt).not.toContain("unsafe morning plan should not appear");
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
