import { describe, expect, it } from "vitest";
import { DreamLogCollector } from "../dream-log-collector.js";
import { StrategyDreamStateStore } from "../../../runtime/store/strategy-dream-state-store.js";
import { makeTempDir, cleanupTempDir } from "../../../../tests/helpers/temp-dir.js";
import type { LoopIterationResult } from "../../../orchestrator/loop/loop-result-types.js";

function makeIterationResult(goalId: string): LoopIterationResult {
  return {
    loopIndex: 0,
    goalId,
    gapAggregate: 0.42,
    driveScores: [
      {
        dimension_name: "test_dimension",
        dissatisfaction: 0.4,
        deadline: 0.2,
        opportunity: 0.1,
        final_score: 0.7,
        dominant_drive: "dissatisfaction",
      },
    ],
    taskResult: null,
    stallDetected: false,
    stallReport: null,
    pivotOccurred: false,
    completionJudgment: {
      is_complete: false,
      blocking_dimensions: [],
      low_confidence_dimensions: [],
      needs_verification_task: false,
      checked_at: new Date().toISOString(),
    },
    elapsedMs: 123,
    error: null,
    skipped: false,
    waitSuppressed: false,
    tokensUsed: 17,
  };
}

describe("DreamLogCollector", () => {
  it("stores iteration and session logs in the control database", async () => {
    const tempDir = makeTempDir("dream-log-collector-");
    try {
      const collector = new DreamLogCollector(tempDir);
      const store = new StrategyDreamStateStore(tempDir);
      const goalId = "goal-1";
      const sessionId = collector.buildSessionId(goalId, "2026-04-07T00:00:00.000Z");
      const iterationResult = makeIterationResult(goalId);

      await collector.appendIterationResult({ goalId, sessionId, iterationResult });
      await collector.appendSessionSummary({
        goalId,
        sessionId,
        completedAt: "2026-04-07T00:10:00.000Z",
        finalStatus: "max_iterations",
        iterations: [iterationResult],
        totalTokensUsed: 17,
      });

      const [iterationRecord] = await store.listIterationLogs(goalId);
      expect(iterationRecord).toMatchObject({
        goalId,
        sessionId,
        driveScores: [{ dimensionName: "test_dimension", score: 0.7 }],
      });

      const [sessionRecord] = await store.listSessionLogs();
      expect(sessionRecord).toMatchObject({
        iterationCount: 1,
        totalTokensUsed: 17,
        outcome: "max_iterations",
      });
    } finally {
      cleanupTempDir(tempDir);
    }
  });

  it("preserves append order when legacy rotation config is still supplied", async () => {
    const tempDir = makeTempDir("dream-log-rotate-");
    try {
      const collector = new DreamLogCollector(tempDir, undefined, {
        maxFileSizeBytes: 250,
        pruneTargetRatio: 0.5,
        rotationMode: "date",
      });
      const store = new StrategyDreamStateStore(tempDir);
      const goalId = "goal-rotate";
      const sessionId = collector.buildSessionId(goalId, "2026-04-07T00:00:00.000Z");

      for (let index = 0; index < 6; index += 1) {
        const result = makeIterationResult(goalId);
        result.loopIndex = index;
        result.skipReason = `reason-${index}-${"x".repeat(40)}`;
        await collector.appendIterationResult({ goalId, sessionId, iterationResult: result });
      }

      const records = await store.listIterationLogs(goalId);
      expect(records.map((record) => record.iteration)).toEqual([0, 1, 2, 3, 4, 5]);
      expect(records.at(-1)?.skipReason).toContain("reason-5");
    } finally {
      cleanupTempDir(tempDir);
    }
  });

  it("does not update watermarks when watermarkBehavior is readonly", async () => {
    const tempDir = makeTempDir("dream-log-watermarks-");
    try {
      const collector = new DreamLogCollector(tempDir, undefined, {
        watermarkBehavior: "readonly",
      });

      await collector.markGoalProcessed("goal-1", 12, "2026-04-07T00:00:00.000Z");
      await collector.markImportanceCursorProcessed({
        lastProcessedLine: 4,
        lastProcessedTimestamp: "2026-04-07T00:01:00.000Z",
        lastProcessedId: "importance-1",
      });

      await expect(collector.loadWatermarks()).resolves.toEqual({
        goals: {},
        importanceBuffer: {
          lastProcessedLine: 0,
        },
      });
    } finally {
      cleanupTempDir(tempDir);
    }
  });
});
