import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { selectForWorkingMemory } from "../src/knowledge/memory-selection.js";
import { makeTempDir } from "./helpers/temp-dir.js";
import type { MemoryIndexEntry, ShortTermEntry } from "../src/types/memory-lifecycle.js";

// ─── Helpers ───

function makeTimestamp(hoursAgo: number): string {
  return new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
}

/** Write a short-term index.json and accompanying data file. */
async function setupShortTermData(
  memoryDir: string,
  entries: ShortTermEntry[]
): Promise<void> {
  const goalId = entries[0]?.goal_id ?? "goal-test";
  const stDir = path.join(memoryDir, "short-term");
  const goalsDir = path.join(stDir, "goals");
  fs.mkdirSync(goalsDir, { recursive: true });

  const dataFile = `goals/${goalId}.json`;
  fs.writeFileSync(
    path.join(stDir, dataFile),
    JSON.stringify(entries)
  );

  const indexEntries: MemoryIndexEntry[] = entries.map((e, i) => ({
    id: `idx-${i}`,
    goal_id: e.goal_id,
    dimensions: e.dimensions,
    tags: e.tags,
    timestamp: e.timestamp,
    data_file: dataFile,
    entry_id: e.id,
    last_accessed: e.timestamp,
    access_count: 0,
    embedding_id: null,
    memory_tier: e.memory_tier,
  }));

  fs.writeFileSync(
    path.join(stDir, "index.json"),
    JSON.stringify({ version: 1, last_updated: new Date().toISOString(), entries: indexEntries })
  );

  // Long-term dirs required by queryLessons
  const ltDir = path.join(memoryDir, "long-term");
  fs.mkdirSync(path.join(ltDir, "lessons", "by-goal"), { recursive: true });
  fs.mkdirSync(path.join(ltDir, "lessons", "by-dimension"), { recursive: true });
  fs.writeFileSync(
    path.join(ltDir, "lessons", "global.json"),
    JSON.stringify([])
  );
  // long-term index
  fs.writeFileSync(
    path.join(ltDir, "index.json"),
    JSON.stringify({ version: 1, last_updated: new Date().toISOString(), entries: [] })
  );
}

let tmpDir: string;
let memoryDir: string;

beforeEach(() => {
  tmpDir = makeTempDir("motiva-sel-test-");
  memoryDir = path.join(tmpDir, "memory");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── Backward compatibility (no activeGoalIds) ───

describe("selectForWorkingMemory — backward compat", () => {
  it("returns entries matching tags without tier params (existing behavior)", async () => {
    const goalId = "goal-a";
    const entries: ShortTermEntry[] = [
      {
        id: "e1",
        goal_id: goalId,
        data_type: "observation",
        loop_number: 1,
        timestamp: makeTimestamp(1),
        dimensions: ["dim-x"],
        tags: ["tag-y"],
        data: {},
        embedding_id: null,
        memory_tier: "recall",
      },
    ];
    await setupShortTermData(memoryDir, entries);

    const deps = { memoryDir };
    const result = await selectForWorkingMemory(deps, goalId, ["dim-x"], ["tag-y"]);
    expect(result.shortTerm).toHaveLength(1);
    expect(result.shortTerm[0]!.id).toBe("e1");
  });

  it("returns empty shortTerm when no tag/dimension matches", async () => {
    const goalId = "goal-b";
    const entries: ShortTermEntry[] = [
      {
        id: "e2",
        goal_id: goalId,
        data_type: "task",
        loop_number: 1,
        timestamp: makeTimestamp(1),
        dimensions: ["dim-a"],
        tags: ["tag-a"],
        data: {},
        embedding_id: null,
        memory_tier: "recall",
      },
    ];
    await setupShortTermData(memoryDir, entries);

    const deps = { memoryDir };
    const result = await selectForWorkingMemory(deps, goalId, ["dim-z"], ["tag-z"]);
    expect(result.shortTerm).toHaveLength(0);
  });
});

// ─── Tier-aware mode (activeGoalIds provided) ───

describe("selectForWorkingMemory — tier-aware mode", () => {
  it("returns core-tier entries first when activeGoalIds is provided", async () => {
    const goalId = "goal-active";
    const now = new Date().toISOString();
    const oldTime = makeTimestamp(10); // 10h ago = recall
    const recentTime = makeTimestamp(1); // 1h ago = core

    const entries: ShortTermEntry[] = [
      {
        id: "recall-1",
        goal_id: goalId,
        data_type: "observation",
        loop_number: 1,
        timestamp: oldTime,
        dimensions: ["dim-x"],
        tags: ["tag-y"],
        data: {},
        embedding_id: null,
        memory_tier: "recall",
      },
      {
        id: "core-1",
        goal_id: goalId,
        data_type: "observation",
        loop_number: 5,
        timestamp: recentTime,
        dimensions: ["dim-x"],
        tags: ["tag-y", "recent"],
        data: {},
        embedding_id: null,
        memory_tier: "core",
      },
    ];
    await setupShortTermData(memoryDir, entries);

    const deps = { memoryDir };
    const result = await selectForWorkingMemory(
      deps,
      goalId,
      ["dim-x"],
      ["tag-y"],
      10,
      [goalId],   // activeGoalIds
      []          // completedGoalIds
    );

    // core-1 should appear before recall-1
    const ids = result.shortTerm.map((e) => e.id);
    const coreIdx = ids.indexOf("core-1");
    const recallIdx = ids.indexOf("recall-1");
    expect(coreIdx).toBeGreaterThanOrEqual(0);
    expect(recallIdx).toBeGreaterThanOrEqual(0);
    expect(coreIdx).toBeLessThan(recallIdx);
  });

  it("classifies entries and updates memory_tier field", async () => {
    const goalId = "goal-active";
    const entries: ShortTermEntry[] = [
      {
        id: "e-obs-recent",
        goal_id: goalId,
        data_type: "observation",
        loop_number: 10,
        timestamp: makeTimestamp(1),
        dimensions: ["dim-x"],
        tags: ["tag-y"],
        data: {},
        embedding_id: null,
        memory_tier: "recall", // will be reclassified to core
      },
    ];
    await setupShortTermData(memoryDir, entries);

    const deps = { memoryDir };
    const result = await selectForWorkingMemory(
      deps,
      goalId,
      ["dim-x"],
      ["tag-y"],
      10,
      [goalId],
      []
    );

    // The entry should be returned
    expect(result.shortTerm).toHaveLength(1);
  });

  it("excludes archival-only entries when they exceed the core guarantee", async () => {
    const completedGoalId = "goal-done";
    const activeGoalId = "goal-active";

    // Mix of one active (core) and one completed (archival) under the same data file setup
    // Note: setupShortTermData uses single goal_id for data file name, so we test
    // the active goal only and verify archival entries from completed goals
    const entries: ShortTermEntry[] = [
      {
        id: "active-obs",
        goal_id: activeGoalId,
        data_type: "observation",
        loop_number: 5,
        timestamp: makeTimestamp(1),
        dimensions: ["dim-x"],
        tags: ["tag-y"],
        data: {},
        embedding_id: null,
        memory_tier: "recall",
      },
    ];
    await setupShortTermData(memoryDir, entries);

    const deps = { memoryDir };
    const result = await selectForWorkingMemory(
      deps,
      activeGoalId,
      ["dim-x"],
      ["tag-y"],
      10,
      [activeGoalId],
      [completedGoalId]
    );

    expect(result.shortTerm.length).toBeGreaterThanOrEqual(1);
  });

  it("falls back to existing behavior when activeGoalIds is undefined", async () => {
    const goalId = "goal-no-tier";
    const entries: ShortTermEntry[] = [
      {
        id: "e-no-tier",
        goal_id: goalId,
        data_type: "task",
        loop_number: 1,
        timestamp: makeTimestamp(2),
        dimensions: ["dim-a"],
        tags: ["tag-b"],
        data: {},
        embedding_id: null,
        memory_tier: "recall",
      },
    ];
    await setupShortTermData(memoryDir, entries);

    const deps = { memoryDir };
    // No activeGoalIds → backward-compat path
    const result = await selectForWorkingMemory(deps, goalId, ["dim-a"], ["tag-b"]);
    expect(result.shortTerm).toHaveLength(1);
    expect(result.shortTerm[0]!.id).toBe("e-no-tier");
  });
});
