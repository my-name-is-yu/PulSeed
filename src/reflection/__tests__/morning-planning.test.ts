import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempDir, cleanupTempDir } from "../../../tests/helpers/temp-dir.js";
import { createMockLLMClient } from "../../../tests/helpers/mock-llm.js";
import { runMorningPlanning } from "../morning-planning.js";
import { loadReflectionReport } from "../reflection-utils.js";
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
        current_value: 0.3,
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
  priorities: [{ goal_id: "g1", priority: "high", reasoning: "Most urgent" }],
  suggestions: ["Focus on testing"],
  concerns: ["Deadline approaching"],
});

// ─── Tests ───

describe("runMorningPlanning", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) cleanupTempDir(tmpDir);
  });

  it("happy path: returns a valid PlanningReport", async () => {
    tmpDir = makeTempDir();
    const goals = [makeGoal("g1")];
    const stateManager = makeStateManager(goals);
    const llmClient = createMockLLMClient([VALID_LLM_RESPONSE]);

    const report = await runMorningPlanning({
      stateManager: stateManager as never,
      llmClient,
      baseDir: tmpDir,
    });

    expect(report.goals_reviewed).toBe(1);
    expect(report.priorities).toHaveLength(1);
    expect(report.priorities[0]?.goal_id).toBe("g1");
    expect(report.priorities[0]?.priority).toBe("high");
    expect(report.suggestions).toEqual(["Focus on testing"]);
    expect(report.concerns).toEqual(["Deadline approaching"]);
    expect(report.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("empty goals: returns report with zero goals reviewed", async () => {
    tmpDir = makeTempDir();
    const stateManager = makeStateManager([]);
    const llmClient = createMockLLMClient([]);

    const report = await runMorningPlanning({
      stateManager: stateManager as never,
      llmClient,
      baseDir: tmpDir,
    });

    expect(report.goals_reviewed).toBe(0);
    expect(report.priorities).toHaveLength(0);
    expect(llmClient.callCount).toBe(0); // No LLM call when no goals
  });

  it("persists report to typed store without writing legacy JSON", async () => {
    tmpDir = makeTempDir();
    const goals = [makeGoal("g1")];
    const stateManager = makeStateManager(goals);
    const llmClient = createMockLLMClient([VALID_LLM_RESPONSE]);

    const report = await runMorningPlanning({
      stateManager: stateManager as never,
      llmClient,
      baseDir: tmpDir,
    });

    const loaded = await loadReflectionReport(tmpDir, "morning", report.date);
    expect(loaded?.goals_reviewed).toBe(1);
    expect(fs.existsSync(path.join(tmpDir, "reflections", `morning-${report.date}.json`))).toBe(false);
  });

  it("routes local-planning relationship profile items through a planning Surface", async () => {
    tmpDir = makeTempDir();
    await upsertRelationshipProfileItem(tmpDir, {
      stableKey: "user.preference.status",
      kind: "preference",
      value: "Prefer concise planning summaries.",
      source: "cli_update",
      allowedScopes: ["local_planning"],
      now: "2026-05-02T00:00:00.000Z",
    });
    await upsertRelationshipProfileItem(tmpDir, {
      stableKey: "user.preference.proactive_status",
      kind: "preference",
      value: "Prefer lengthy planning summaries.",
      source: "cli_update",
      allowedScopes: ["resident_behavior"],
      now: "2026-05-02T01:00:00.000Z",
    });
    await upsertRelationshipProfileItem(tmpDir, {
      stableKey: "user.preference.sensitive_status",
      kind: "preference",
      value: "Sensitive planning detail should stay out of prompts.",
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

    await runMorningPlanning({
      stateManager: stateManager as never,
      llmClient: llmClient as never,
      baseDir: tmpDir,
    });

    const prompt = sendMessage.mock.calls[0]?.[0]?.[0]?.content ?? "";
    expect(prompt).toContain("Morning planning relationship profile Surface");
    expect(prompt).toContain("requested_use=goal_planning");
    expect(prompt).toContain("Use only Surface-included relationship context below.");
    expect(prompt).not.toContain("Relationship Profile (active items only; consent scope: local_planning)");
    expect(prompt).toContain("Prefer concise planning summaries.");
    expect(prompt).not.toContain("Prefer lengthy planning summaries.");
    expect(prompt).not.toContain("Sensitive planning detail should stay out of prompts.");
  });

  it("LLM error: returns partial report without crashing", async () => {
    tmpDir = makeTempDir();
    const goals = [makeGoal("g1")];
    const stateManager = makeStateManager(goals);
    // Mock LLM that throws
    const llmClient = {
      callCount: 0,
      sendMessage: vi.fn().mockRejectedValue(new Error("LLM timeout")),
      parseJSON: vi.fn(),
    };

    const report = await runMorningPlanning({
      stateManager: stateManager as never,
      llmClient: llmClient as never,
      baseDir: tmpDir,
    });

    expect(report.goals_reviewed).toBe(1);
    expect(report.priorities).toHaveLength(0); // Empty due to LLM error
  });

  it("calls notificationDispatcher when goals present", async () => {
    tmpDir = makeTempDir();
    const goals = [makeGoal("g1")];
    const stateManager = makeStateManager(goals);
    const llmClient = createMockLLMClient([VALID_LLM_RESPONSE]);
    const dispatcher = { dispatch: vi.fn().mockResolvedValue([]) };

    await runMorningPlanning({
      stateManager: stateManager as never,
      llmClient,
      baseDir: tmpDir,
      notificationDispatcher: dispatcher as never,
    });

    expect(dispatcher.dispatch).toHaveBeenCalledOnce();
  });
});
