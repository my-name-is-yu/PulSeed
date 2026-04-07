import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { DreamLogCollector } from "../dream-log-collector.js";
import { makeTempDir, cleanupTempDir } from "../../../../tests/helpers/temp-dir.js";
import type { LoopIterationResult } from "../../../orchestrator/loop/core-loop-types.js";

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
  it("writes iteration and session logs in phase 1 format", async () => {
    const tempDir = makeTempDir("dream-log-collector-");
    try {
      const collector = new DreamLogCollector(tempDir);
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

      const iterationPath = path.join(tempDir, "goals", goalId, "iteration-logs.jsonl");
      const sessionPath = path.join(tempDir, "dream", "session-logs.jsonl");

      expect(fs.existsSync(iterationPath)).toBe(true);
      expect(fs.existsSync(sessionPath)).toBe(true);

      const iterationRecord = JSON.parse(fs.readFileSync(iterationPath, "utf-8").trim());
      expect(iterationRecord.goalId).toBe(goalId);
      expect(iterationRecord.sessionId).toBe(sessionId);
      expect(iterationRecord.driveScores[0]).toEqual({
        dimensionName: "test_dimension",
        score: 0.7,
      });

      const sessionRecord = JSON.parse(fs.readFileSync(sessionPath, "utf-8").trim());
      expect(sessionRecord.iterationCount).toBe(1);
      expect(sessionRecord.totalTokensUsed).toBe(17);
      expect(sessionRecord.outcome).toBe("max_iterations");
    } finally {
      cleanupTempDir(tempDir);
    }
  });

  it("rotates oversized iteration logs by pruning oldest lines", async () => {
    const tempDir = makeTempDir("dream-log-rotate-");
    try {
      const collector = new DreamLogCollector(tempDir, undefined, {
        maxFileSizeBytes: 250,
        pruneTargetRatio: 0.5,
      });
      const goalId = "goal-rotate";
      const sessionId = collector.buildSessionId(goalId, "2026-04-07T00:00:00.000Z");

      for (let index = 0; index < 6; index++) {
        const result = makeIterationResult(goalId);
        result.loopIndex = index;
        result.skipReason = `reason-${index}-${"x".repeat(40)}`;
        await collector.appendIterationResult({ goalId, sessionId, iterationResult: result });
      }

      const iterationPath = path.join(tempDir, "goals", goalId, "iteration-logs.jsonl");
      const lines = fs.readFileSync(iterationPath, "utf-8").trim().split("\n");
      expect(lines.length).toBeLessThan(6);
      const newestRecord = JSON.parse(lines[lines.length - 1]!);
      expect(newestRecord.iteration).toBe(5);
    } finally {
      cleanupTempDir(tempDir);
    }
  });
});
