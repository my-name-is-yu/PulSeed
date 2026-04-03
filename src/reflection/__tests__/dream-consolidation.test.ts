import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempDir, cleanupTempDir } from "../../../tests/helpers/temp-dir.js";
import { runDreamConsolidation } from "../dream-consolidation.js";

// ─── Fixtures ───

function makeStateManager(goalIds: string[]) {
  return {
    listGoalIds: vi.fn().mockResolvedValue(goalIds),
  };
}

function makeMemoryLifecycle(compressedCount = 5) {
  return {
    compressToLongTerm: vi.fn().mockResolvedValue({
      success: true,
      entries_compressed: compressedCount,
      lessons_created: 1,
    }),
  };
}

function makeKnowledgeManager(staleCount = 2) {
  const staleEntries = Array.from({ length: staleCount }, (_, i) => ({
    id: `stale-${i}`,
    key: `key-${i}`,
    value: "info",
    source: "test",
    created_at: new Date().toISOString(),
    revalidation_due_at: new Date(Date.now() - 1000).toISOString(),
  }));

  return {
    getStaleEntries: vi.fn().mockResolvedValue(staleEntries),
    generateRevalidationTasks: vi.fn().mockResolvedValue(
      staleEntries.map((e) => ({ id: e.id, type: "knowledge_acquisition" }))
    ),
  };
}

// ─── Tests ───

describe("runDreamConsolidation", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) cleanupTempDir(tmpDir);
  });

  it("happy path with all deps: returns full ConsolidationReport", async () => {
    tmpDir = makeTempDir();
    const stateManager = makeStateManager(["g1", "g2"]);
    const memoryLifecycle = makeMemoryLifecycle(3);
    const knowledgeManager = makeKnowledgeManager(2);

    const report = await runDreamConsolidation({
      stateManager: stateManager as never,
      memoryLifecycle: memoryLifecycle as never,
      knowledgeManager: knowledgeManager as never,
      baseDir: tmpDir,
    });

    expect(report.goals_consolidated).toBe(2);
    expect(report.entries_compressed).toBe(30); // 3 per data type * 5 types * 2 goals
    expect(report.stale_entries_found).toBe(2);
    expect(report.revalidation_tasks_created).toBe(2);
    expect(report.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("no goals: returns zero counts", async () => {
    tmpDir = makeTempDir();
    const stateManager = makeStateManager([]);
    const memoryLifecycle = makeMemoryLifecycle();
    const knowledgeManager = makeKnowledgeManager(0);

    const report = await runDreamConsolidation({
      stateManager: stateManager as never,
      memoryLifecycle: memoryLifecycle as never,
      knowledgeManager: knowledgeManager as never,
      baseDir: tmpDir,
    });

    expect(report.goals_consolidated).toBe(0);
    expect(report.entries_compressed).toBe(0);
    expect(memoryLifecycle.compressToLongTerm).not.toHaveBeenCalled();
  });

  it("without memoryLifecycle: skips compression", async () => {
    tmpDir = makeTempDir();
    const stateManager = makeStateManager(["g1"]);

    const report = await runDreamConsolidation({
      stateManager: stateManager as never,
      baseDir: tmpDir,
    });

    expect(report.entries_compressed).toBe(0);
    expect(report.goals_consolidated).toBe(1);
  });

  it("without knowledgeManager: skips stale check", async () => {
    tmpDir = makeTempDir();
    const stateManager = makeStateManager(["g1"]);
    const memoryLifecycle = makeMemoryLifecycle(2);

    const report = await runDreamConsolidation({
      stateManager: stateManager as never,
      memoryLifecycle: memoryLifecycle as never,
      baseDir: tmpDir,
    });

    expect(report.stale_entries_found).toBe(0);
    expect(report.revalidation_tasks_created).toBe(0);
  });

  it("persists report to file", async () => {
    tmpDir = makeTempDir();
    const stateManager = makeStateManager(["g1"]);

    const report = await runDreamConsolidation({
      stateManager: stateManager as never,
      baseDir: tmpDir,
    });

    const filePath = path.join(tmpDir, "reflections", `dream-${report.date}.json`);
    expect(fs.existsSync(filePath)).toBe(true);
    const content = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(content.goals_consolidated).toBe(1);
  });

  it("memoryLifecycle error on one data type: continues with others", async () => {
    tmpDir = makeTempDir();
    const stateManager = makeStateManager(["g1", "g2"]);
    const memoryLifecycle = {
      compressToLongTerm: vi
        .fn()
        .mockRejectedValueOnce(new Error("compression failed"))
        .mockResolvedValue({ success: true, entries_compressed: 2, lessons_created: 1 }),
    };

    const report = await runDreamConsolidation({
      stateManager: stateManager as never,
      memoryLifecycle: memoryLifecycle as never,
      baseDir: tmpDir,
    });

    // first call (g1/experience_log) fails, remaining 9 calls succeed with 2 each
    expect(report.entries_compressed).toBe(18);
    expect(report.goals_consolidated).toBe(2);
  });
});
