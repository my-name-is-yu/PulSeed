import { describe, expect, it } from "vitest";
import type { ZodSchema } from "zod/v3";
import type { ILLMClient, LLMMessage, LLMRequestOptions, LLMResponse } from "../../../base/llm/llm-client.js";
import { StateManager } from "../../../base/state/state-manager.js";
import { StrategyDreamStateStore } from "../../../runtime/store/strategy-dream-state-store.js";
import { LearningPipeline } from "../../knowledge/learning/learning-pipeline.js";
import type { ImportanceEntry, IterationLog, SessionLog, WatermarkState } from "../dream-types.js";
import { DreamAnalyzer } from "../dream-analyzer.js";
import { cleanupTempDir, makeTempDir } from "../../../../tests/helpers/temp-dir.js";

function makeMockLLM(patternBatches: unknown[][]): ILLMClient {
  let callIndex = 0;
  return {
    async sendMessage(_messages: LLMMessage[], _options?: LLMRequestOptions): Promise<LLMResponse> {
      const content = JSON.stringify({ patterns: patternBatches[callIndex] ?? [] });
      callIndex += 1;
      return {
        content,
        usage: { input_tokens: 100, output_tokens: 150 },
        stop_reason: "end_turn",
      };
    },
    parseJSON<T>(content: string, schema: ZodSchema<T>): T {
      return schema.parse(JSON.parse(content));
    },
  };
}

async function seedIterationLogs(baseDir: string, records: IterationLog[]): Promise<void> {
  const store = new StrategyDreamStateStore(baseDir);
  for (const record of records) {
    await store.appendIterationLog(record);
  }
}

async function seedImportanceEntries(baseDir: string, records: ImportanceEntry[]): Promise<void> {
  const store = new StrategyDreamStateStore(baseDir);
  for (const record of records) {
    await store.appendImportanceEntry(record);
  }
}

async function seedSessionLogs(baseDir: string, records: SessionLog[]): Promise<void> {
  const store = new StrategyDreamStateStore(baseDir);
  for (const record of records) {
    await store.appendSessionLog(record);
  }
}

function storeFor(baseDir: string): StrategyDreamStateStore {
  return new StrategyDreamStateStore(baseDir);
}

function makeIteration(goalId: string, iteration: number): IterationLog {
  return {
    timestamp: `2026-04-07T00:${iteration.toString().padStart(2, "0")}:00.000Z`,
    goalId,
    iteration,
    sessionId: `${goalId}:session-1`,
    gapAggregate: Math.max(0, 1 - iteration * 0.05),
    taskId: `task-${iteration}`,
    taskAction: iteration % 2 === 0 ? "rerun_verification" : "collect_signal",
    strategyId: iteration < 12 ? "baseline" : "tight-loop",
    verificationResult: {
      verdict: iteration % 3 === 0 ? "pass" : "retry",
      confidence: 0.8,
      timestamp: `2026-04-07T00:${iteration.toString().padStart(2, "0")}:30.000Z`,
    },
    stallDetected: iteration % 7 === 0,
    stallSeverity: iteration % 7 === 0 ? 1 : null,
    tokensUsed: 40,
    elapsedMs: 500,
    completionJudgment: {
      is_complete: false,
      checked_at: `2026-04-07T00:${iteration.toString().padStart(2, "0")}:59.000Z`,
    },
  };
}

describe("DreamAnalyzer", () => {
  it("runs phase 2 analysis, persists patterns and schedule suggestions, and advances resumable watermarks", async () => {
      const tempDir = makeTempDir("dream-analyzer-");
    try {
      const goalA = "goal-a";
      const goalB = "goal-b";
      await seedIterationLogs(
        tempDir,
        Array.from({ length: 12 }, (_, index) => makeIteration(goalA, index))
      );
      await seedIterationLogs(
        tempDir,
        Array.from({ length: 15 }, (_, index) => makeIteration(goalB, index))
      );
      await seedImportanceEntries(tempDir, [
        {
          id: "imp-1",
          timestamp: "2026-04-07T01:00:00.000Z",
          goalId: goalA,
          source: "verification",
          importance: 0.9,
          reason: "Repeated verification recovery",
          data_ref: `iter:${goalA}:5`,
          tags: ["verification"],
          processed: false,
        },
        {
          id: "imp-2",
          timestamp: "2026-04-07T01:05:00.000Z",
          goalId: goalB,
          source: "stall",
          importance: 0.75,
          reason: "Recurring stall precursor",
          data_ref: `iter:${goalB}:7`,
          tags: ["stall"],
          processed: false,
        },
      ]);
      await seedSessionLogs(tempDir, [
        {
          timestamp: "2026-04-07T03:00:00.000Z",
          goalId: goalB,
          sessionId: "goal-b:1",
          iterationCount: 15,
          finalGapAggregate: 0.25,
          initialGapAggregate: 0.95,
          totalTokensUsed: 600,
          totalElapsedMs: 12000,
          stallCount: 1,
          outcome: "max_iterations",
          strategiesUsed: ["baseline", "tight-loop"],
        },
        {
          timestamp: "2026-04-08T03:20:00.000Z",
          goalId: goalB,
          sessionId: "goal-b:2",
          iterationCount: 14,
          finalGapAggregate: 0.2,
          initialGapAggregate: 0.9,
          totalTokensUsed: 550,
          totalElapsedMs: 11000,
          stallCount: 0,
          outcome: "max_iterations",
          strategiesUsed: ["tight-loop"],
        },
        {
          timestamp: "2026-04-09T03:40:00.000Z",
          goalId: goalB,
          sessionId: "goal-b:3",
          iterationCount: 16,
          finalGapAggregate: 0.1,
          initialGapAggregate: 0.88,
          totalTokensUsed: 530,
          totalElapsedMs: 10500,
          stallCount: 0,
          outcome: "goal_complete",
          strategiesUsed: ["tight-loop"],
        },
      ]);

      const stateManager = new StateManager(tempDir, undefined, { walEnabled: false });
      await stateManager.init();
      const learningPipeline = new LearningPipeline(makeMockLLM([[]]), null, stateManager);
      const analyzer = new DreamAnalyzer({
        baseDir: tempDir,
        llmClient: makeMockLLM([
          [],
          [
            {
              pattern_type: "task_generation",
              confidence: 0.88,
              summary: "Retry verification after drift to recover progress.",
              evidence_refs: [`iter:${goalA}:5`, `iter:${goalA}:6`],
              metadata: { taskAction: "rerun_verification", applicable_domains: ["verification"] },
            },
          ],
        ]),
        learningPipeline,
        config: {
          minIterationsForAnalysis: 5,
          patternConfidenceThreshold: 0.7,
        },
      });

      const report = await analyzer.runDeep();

      expect(report.phasesCompleted).toEqual(["A", "B", "C"]);
      expect(report.patternsPersisted).toBeGreaterThan(0);
      expect(report.scheduleSuggestions).toBe(1);
      expect(report.goalsProcessed[0]).toBe(goalB);

      const patternsA = await learningPipeline.getPatterns(goalA);
      const patternsB = await learningPipeline.getPatterns(goalB);
      expect(patternsA).toHaveLength(1);
      expect(patternsB).toEqual([]);
      expect(patternsA[0]?.type).toBe("task_generation");
      expect(patternsA[0]?.description).toContain("Retry verification");

      const scheduleSuggestions = await storeFor(tempDir).loadScheduleSuggestions();
      expect(scheduleSuggestions.suggestions).toEqual([
        expect.objectContaining({
          goalId: goalB,
          proposal: "0 3 * * *",
          type: "goal_trigger",
          trigger: {
            type: "cron",
            expression: "0 3 * * *",
            timezone: "UTC",
          },
        }),
      ]);

      const watermarks = await storeFor(tempDir).loadWatermarks();
      expect(watermarks.goals[goalA]?.lastProcessedLine).toBe(12);
      expect(watermarks.goals[goalB]?.lastProcessedLine).toBe(15);
      expect(watermarks.goals[goalB]?.lastProcessedTimestamp).toBeTruthy();
      expect(watermarks.importanceBuffer.lastProcessedLine).toBe(2);
      expect(watermarks.importanceBuffer.lastProcessedId).toBe("imp-2");
    } finally {
      cleanupTempDir(tempDir);
    }
  });

  it("keeps watermarks retryable when LLM pattern types do not match the contract", async () => {
      const tempDir = makeTempDir("dream-analyzer-pattern-type-");
    try {
      const goalId = "goal-pattern-type";
      await seedIterationLogs(
        tempDir,
        Array.from({ length: 2 }, (_, index) => makeIteration(goalId, index))
      );

      const stateManager = new StateManager(tempDir, undefined, { walEnabled: false });
      await stateManager.init();
      const learningPipeline = new LearningPipeline(makeMockLLM([[]]), null, stateManager);
      const analyzer = new DreamAnalyzer({
        baseDir: tempDir,
        llmClient: makeMockLLM([[
          {
            pattern_type: "strategy_effectiveness",
            confidence: 0.91,
            summary: "Old free-form labels should not be reclassified by substring matching.",
            evidence_refs: [`iter:${goalId}:1`],
            metadata: { applicable_domains: ["strategy"] },
          },
        ]]),
        learningPipeline,
        config: { minIterationsForAnalysis: 1 },
      });

      const report = await analyzer.runDeep({ goalIds: [goalId], phases: ["A", "B"] });

      expect(report.partial).toBe(true);
      expect(report.patternsPersisted).toBe(0);
      await expect(learningPipeline.getPatterns(goalId)).resolves.toEqual([]);
      expect(await storeFor(tempDir).loadWatermarks()).toEqual({
        goals: {},
        importanceBuffer: { lastProcessedLine: 0 },
      });
    } finally {
      cleanupTempDir(tempDir);
    }
  });

  it("falls back to timestamp-based resume when iteration logs were pruned", async () => {
      const tempDir = makeTempDir("dream-analyzer-pruned-");
    try {
      const goalId = "goal-pruned";
      await seedIterationLogs(
        tempDir,
        [makeIteration(goalId, 3), makeIteration(goalId, 4), makeIteration(goalId, 5)]
      );
      const prunedWatermarks: WatermarkState = {
        goals: {
          [goalId]: {
            lastProcessedLine: 10,
            lastProcessedTimestamp: makeIteration(goalId, 4).timestamp,
          },
        },
        importanceBuffer: { lastProcessedLine: 0 },
      };
      await storeFor(tempDir).saveWatermarks(prunedWatermarks);

      const stateManager = new StateManager(tempDir, undefined, { walEnabled: false });
      await stateManager.init();
      const learningPipeline = new LearningPipeline(makeMockLLM([[]]), null, stateManager);
      const analyzer = new DreamAnalyzer({
        baseDir: tempDir,
        llmClient: makeMockLLM([[{
          pattern_type: "strategy_selection",
          confidence: 0.91,
          summary: "Recent post-prune iteration was analyzed.",
          evidence_refs: [`iter:${goalId}:5`],
          metadata: { applicable_domains: ["strategy"] },
        }]]),
        learningPipeline,
        config: { minIterationsForAnalysis: 1 },
      });

      const report = await analyzer.runDeep({ goalIds: [goalId], phases: ["A", "B"] });

      expect(report.stats.linesRead).toBe(1);
      expect(report.patternsPersisted).toBe(1);
    } finally {
      cleanupTempDir(tempDir);
    }
  });

  it("does not advance importance watermark past excluded goals", async () => {
      const tempDir = makeTempDir("dream-analyzer-importance-");
    try {
      const goalA = "goal-a";
      const goalB = "goal-b";
      await seedIterationLogs(
        tempDir,
        Array.from({ length: 6 }, (_, index) => makeIteration(goalA, index))
      );
      await seedIterationLogs(
        tempDir,
        Array.from({ length: 6 }, (_, index) => makeIteration(goalB, index))
      );
      await seedImportanceEntries(tempDir, [
        {
          id: "imp-a",
          timestamp: "2026-04-07T01:00:00.000Z",
          goalId: goalA,
          source: "verification",
          importance: 0.8,
          reason: "A",
          data_ref: `iter:${goalA}:2`,
          tags: [],
          processed: false,
        },
        {
          id: "imp-b",
          timestamp: "2026-04-07T01:01:00.000Z",
          goalId: goalB,
          source: "stall",
          importance: 0.9,
          reason: "B",
          data_ref: `iter:${goalB}:2`,
          tags: [],
          processed: false,
        },
      ]);

      const stateManager = new StateManager(tempDir, undefined, { walEnabled: false });
      await stateManager.init();
      const learningPipeline = new LearningPipeline(makeMockLLM([[]]), null, stateManager);
      const analyzer = new DreamAnalyzer({
        baseDir: tempDir,
        llmClient: makeMockLLM([[{
          pattern_type: "task_generation",
          confidence: 0.8,
          summary: "Goal A processed",
          evidence_refs: [`iter:${goalA}:2`],
          metadata: {},
        }]]),
        learningPipeline,
        config: { minIterationsForAnalysis: 1, maxGoalsPerRun: 1 },
      });

      await analyzer.runDeep({ phases: ["A", "B"] });

      const watermarks = await storeFor(tempDir).loadWatermarks();
      expect(watermarks.importanceBuffer.lastProcessedLine).toBe(1);
      expect(watermarks.importanceBuffer.lastProcessedId).toBe("imp-a");
    } finally {
      cleanupTempDir(tempDir);
    }
  });

  it("marks the run partial and skips persistence when the token budget is exhausted before analysis", async () => {
      const tempDir = makeTempDir("dream-analyzer-budget-");
    try {
      const goalId = "goal-budget";
      await seedIterationLogs(
        tempDir,
        Array.from({ length: 25 }, (_, index) => makeIteration(goalId, index))
      );

      const stateManager = new StateManager(tempDir, undefined, { walEnabled: false });
      await stateManager.init();
      const learningPipeline = new LearningPipeline(makeMockLLM([[]]), null, stateManager);
      const analyzer = new DreamAnalyzer({
        baseDir: tempDir,
        llmClient: makeMockLLM([
          [
            {
              pattern_type: "strategy_selection",
              confidence: 0.91,
              summary: "Tight loops outperform baseline strategy.",
              evidence_refs: [`iter:${goalId}:10`],
              metadata: { applicable_domains: ["strategy"] },
            },
          ],
        ]),
        learningPipeline,
        config: {
          minIterationsForAnalysis: 5,
        },
      });

      const report = await analyzer.runDeep({ tokenBudget: 10 });

      expect(report.partial).toBe(true);
      expect(report.phasesCompleted).toEqual(["A", "B"]);
      expect(report.patternsPersisted).toBe(0);
      expect(report.scheduleSuggestions).toBe(0);
      expect(await learningPipeline.getPatterns(goalId)).toEqual([]);
      expect(await storeFor(tempDir).loadWatermarks()).toEqual({
        goals: {},
        importanceBuffer: { lastProcessedLine: 0 },
      });
      expect((await storeFor(tempDir).loadScheduleSuggestions()).suggestions).toEqual([]);
    } finally {
      cleanupTempDir(tempDir);
    }
  });
});
