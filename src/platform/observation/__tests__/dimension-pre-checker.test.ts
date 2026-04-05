import { describe, it, expect, vi, beforeEach } from "vitest";
import { DimensionPreChecker } from "../dimension-pre-checker.js";
import type { ObservationLogEntry } from "../../../base/types/state.js";
import type { Dimension } from "../../../base/types/goal.js";

// Minimal stub for ObservationLogEntry
function makeObs(overrides: Partial<ObservationLogEntry> = {}): ObservationLogEntry {
  return {
    observation_id: "obs-1",
    timestamp: new Date(Date.now() - 120_000).toISOString(), // 2 min ago
    trigger: "periodic",
    goal_id: "goal-1",
    dimension_name: "dim",
    layer: "mechanical",
    method: { type: "api_query", source: "api", schedule: null },
    raw_response: null,
    extracted_value: null,
    confidence: 0.8,
    notes: null,
    ...overrides,
  } as ObservationLogEntry;
}

// Minimal stub for Dimension
const mockDimension: Dimension = {
  name: "test_dim",
  description: "test",
  threshold: { type: "min", value: 1 },
  weight: 1,
  layer: "mechanical",
  observation_method: { type: "api_query", source: "api", schedule: null },
} as unknown as Dimension;

describe("DimensionPreChecker", () => {
  describe("check() — no lastObservation", () => {
    it("returns changed=true when no previous observation exists", async () => {
      const checker = new DimensionPreChecker({ strategies: ["age", "git_diff"] });
      const result = await checker.check(mockDimension, null, {});
      expect(result.changed).toBe(true);
    });
  });

  describe("check() — age strategy", () => {
    it("returns changed=false when last observation is recent", async () => {
      const checker = new DimensionPreChecker({
        min_observation_interval_sec: 300,
        strategies: ["age"],
      });
      const recentObs = makeObs({ timestamp: new Date(Date.now() - 10_000).toISOString() });
      const result = await checker.check(mockDimension, recentObs, {});
      expect(result.changed).toBe(false);
    });

    it("defers to other strategies when age threshold exceeded", async () => {
      const checker = new DimensionPreChecker({
        min_observation_interval_sec: 1,
        strategies: ["age"],
      });
      const oldObs = makeObs({ timestamp: new Date(Date.now() - 5_000).toISOString() });
      // Only age strategy, no other strategy → falls back to changed=true
      const result = await checker.check(mockDimension, oldObs, {});
      expect(result.changed).toBe(true);
    });
  });

  describe("check() — git_diff strategy with ToolExecutor", () => {
    it("returns changed=false when both staged and unstaged are empty", async () => {
      const mockExecutor = {
        execute: vi.fn().mockResolvedValue({ success: true, data: "", summary: "", durationMs: 5 }),
      };

      const checker = new DimensionPreChecker({
        strategies: ["git_diff"],
        toolExecutor: mockExecutor as any,
      });
      const obs = makeObs();
      const result = await checker.check(mockDimension, obs, { workspace_path: "/fake/path" });
      expect(result.changed).toBe(false);
      expect(mockExecutor.execute).toHaveBeenCalledTimes(2);
    });

    it("returns changed=true when unstaged diff is non-empty", async () => {
      const mockExecutor = {
        execute: vi.fn()
          .mockResolvedValueOnce({ success: true, data: "M some-file.ts", summary: "", durationMs: 5 })
          .mockResolvedValueOnce({ success: true, data: "", summary: "", durationMs: 5 }),
      };

      const checker = new DimensionPreChecker({
        strategies: ["git_diff"],
        toolExecutor: mockExecutor as any,
      });
      const obs = makeObs();
      const result = await checker.check(mockDimension, obs, { workspace_path: "/fake/path" });
      expect(result.changed).toBe(true);
      expect(result.hint).toContain("M some-file.ts");
    });

    it("returns changed=true when staged diff is non-empty", async () => {
      const mockExecutor = {
        execute: vi.fn()
          .mockResolvedValueOnce({ success: true, data: "", summary: "", durationMs: 5 })
          .mockResolvedValueOnce({ success: true, data: "A new-file.ts", summary: "", durationMs: 5 }),
      };

      const checker = new DimensionPreChecker({
        strategies: ["git_diff"],
        toolExecutor: mockExecutor as any,
      });
      const obs = makeObs();
      const result = await checker.check(mockDimension, obs, { workspace_path: "/fake/path" });
      expect(result.changed).toBe(true);
    });

    it("falls back to execFile when ToolExecutor throws", async () => {
      const mockExecutor = {
        execute: vi.fn().mockRejectedValue(new Error("tool error")),
      };

      // No real git repo at /tmp/nonexistent-repo — execFile will throw too, so result is null
      // → no applicable strategy → changed=true
      const checker = new DimensionPreChecker({
        strategies: ["git_diff"],
        toolExecutor: mockExecutor as any,
      });
      const obs = makeObs();
      const result = await checker.check(mockDimension, obs, { workspace_path: "/tmp/nonexistent-repo-xyz" });
      // Both ToolExecutor and execFile failed → no result → changed=true
      expect(result.changed).toBe(true);
    });

    it("returns null (skips) when workspace_path is not provided", async () => {
      const mockExecutor = { execute: vi.fn() };
      const checker = new DimensionPreChecker({
        strategies: ["git_diff"],
        toolExecutor: mockExecutor as any,
      });
      const obs = makeObs();
      const result = await checker.check(mockDimension, obs, {});
      // no workspace_path → git_diff strategy skipped → no applicable → changed=true
      expect(result.changed).toBe(true);
      expect(mockExecutor.execute).not.toHaveBeenCalled();
    });
  });

  describe("check() — combined strategies", () => {
    it("returns changed=true if git_diff signals change even when age says unchanged", async () => {
      const mockExecutor = {
        execute: vi.fn().mockResolvedValue({ success: true, data: "M file.ts", summary: "", durationMs: 5 }),
      };

      const checker = new DimensionPreChecker({
        min_observation_interval_sec: 300,
        strategies: ["age", "git_diff"],
        toolExecutor: mockExecutor as any,
      });
      const recentObs = makeObs({ timestamp: new Date(Date.now() - 10_000).toISOString() });
      // age says { changed: false } (recent), git_diff says { changed: true }
      // find(r => r.changed) picks the git_diff result -> changed=true
      const result = await checker.check(mockDimension, recentObs, { workspace_path: "/fake/path" });
      expect(result.changed).toBe(true);
    });

    it("returns changed=false when all strategies agree no change", async () => {
      const mockExecutor = {
        execute: vi.fn().mockResolvedValue({ success: true, data: "", summary: "", durationMs: 5 }),
      };

      const checker = new DimensionPreChecker({
        min_observation_interval_sec: 300,
        strategies: ["age", "git_diff"],
        toolExecutor: mockExecutor as any,
      });
      const recentObs = makeObs({ timestamp: new Date(Date.now() - 10_000).toISOString() });
      const result = await checker.check(mockDimension, recentObs, { workspace_path: "/fake/path" });
      expect(result.changed).toBe(false);
    });
  });
});
