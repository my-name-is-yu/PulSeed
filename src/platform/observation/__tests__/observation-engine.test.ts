import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { ObservationEngine } from "../observation-engine.js";
import { StateManager } from "../../../base/state/state-manager.js";
import type { Goal } from "../../../base/types/goal.js";
import type { ObservationLogEntry } from "../../../base/types/state.js";
import type { ObservationLayer, ObservationMethod, ObservationTrigger } from "../../../base/types/core.js";
import type { KnowledgeGapSignal } from "../../../base/types/knowledge.js";
import type { IDataSourceAdapter } from "../data-source-adapter.js";
import type { DataSourceConfig } from "../../../base/types/data-source.js";
import type { ILLMClient } from "../../../base/llm/llm-client.js";
import { makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { makeGoal } from "../../../../tests/helpers/fixtures.js";
import { randomUUID } from "node:crypto";
import { createWorkspaceArtifactMetricDataSource } from "../../../adapters/datasources/artifact-metric-datasource.js";

// ─── Helpers ───

const defaultMethod: ObservationMethod = {
  type: "mechanical",
  source: "test-runner",
  schedule: null,
  endpoint: null,
  confidence_tier: "mechanical",
};

const testDimension = {
  name: "test_dim",
  label: "Test Dimension",
  current_value: 50,
  threshold: { type: "min" as const, value: 100 },
  confidence: 0.9,
  observation_method: defaultMethod,
  last_updated: new Date().toISOString(),
  history: [],
  weight: 1.0,
  uncertainty_weight: null,
  state_integrity: "ok" as const,
  dimension_mapping: null,
};

function makeEntry(overrides: Partial<ObservationLogEntry> = {}): ObservationLogEntry {
  return {
    observation_id: randomUUID(),
    timestamp: new Date().toISOString(),
    trigger: "post_task",
    goal_id: "goal-1",
    dimension_name: "test_dim",
    layer: "mechanical",
    method: defaultMethod,
    raw_result: 80,
    extracted_value: 80,
    confidence: 0.9,
    notes: null,
    ...overrides,
  };
}

function makeMockLLMClient(score = 0.25): ILLMClient {
  return {
    sendMessage: vi.fn().mockResolvedValue({
      content: JSON.stringify({ score, reason: "llm fallback" }),
      usage: { input_tokens: 100, output_tokens: 20 },
      stop_reason: "end_turn",
    }),
    parseJSON: vi.fn().mockReturnValue({ score, reason: "llm fallback" }),
  };
}

// ─── Tests ───

describe("ObservationEngine", () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let engine: ObservationEngine;

  beforeEach(() => {
    tmpDir = makeTempDir();
    stateManager = new StateManager(tmpDir);
    engine = new ObservationEngine(stateManager);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true , maxRetries: 3, retryDelay: 100 });
  });

  // ─── applyProgressCeiling ───

  describe("applyProgressCeiling", () => {
    it("mechanical: returns progress unchanged when below ceiling (1.0)", () => {
      expect(engine.applyProgressCeiling(0.75, "mechanical")).toBe(0.75);
    });

    it("mechanical: allows progress = 1.0", () => {
      expect(engine.applyProgressCeiling(1.0, "mechanical")).toBe(1.0);
    });

    it("mechanical: caps at 1.0 if somehow above", () => {
      expect(engine.applyProgressCeiling(1.5, "mechanical")).toBe(1.0);
    });

    it("independent_review: caps at 0.90", () => {
      expect(engine.applyProgressCeiling(0.95, "independent_review")).toBe(0.90);
    });

    it("independent_review: returns progress unchanged when below ceiling", () => {
      expect(engine.applyProgressCeiling(0.80, "independent_review")).toBe(0.80);
    });

    it("self_report: caps at 0.70", () => {
      expect(engine.applyProgressCeiling(0.85, "self_report")).toBe(0.70);
    });

    it("self_report: returns progress unchanged when below ceiling", () => {
      expect(engine.applyProgressCeiling(0.50, "self_report")).toBe(0.50);
    });

    it("all layers: progress = 0 returns 0", () => {
      const layers: ObservationLayer[] = ["mechanical", "independent_review", "self_report"];
      for (const layer of layers) {
        expect(engine.applyProgressCeiling(0, layer)).toBe(0);
      }
    });

    it("self_report: progress exactly at ceiling (0.70) is unchanged", () => {
      expect(engine.applyProgressCeiling(0.70, "self_report")).toBe(0.70);
    });

    it("independent_review: progress exactly at ceiling (0.90) is unchanged", () => {
      expect(engine.applyProgressCeiling(0.90, "independent_review")).toBe(0.90);
    });
  });

  // ─── getConfidenceTier ───

  describe("getConfidenceTier", () => {
    it("mechanical: returns tier=mechanical with range [0.85, 1.0]", () => {
      const result = engine.getConfidenceTier("mechanical");
      expect(result.tier).toBe("mechanical");
      expect(result.range).toEqual([0.85, 1.0]);
    });

    it("independent_review: returns tier=independent_review with range [0.50, 0.84]", () => {
      const result = engine.getConfidenceTier("independent_review");
      expect(result.tier).toBe("independent_review");
      expect(result.range).toEqual([0.50, 0.84]);
    });

    it("self_report: returns tier=self_report with range [0.10, 0.49]", () => {
      const result = engine.getConfidenceTier("self_report");
      expect(result.tier).toBe("self_report");
      expect(result.range).toEqual([0.10, 0.49]);
    });
  });

  // ─── createObservationEntry ───

  describe("createObservationEntry", () => {
    it("generates a unique observation_id (uuid)", () => {
      const entry = engine.createObservationEntry({
        goalId: "goal-1",
        dimensionName: "test_dim",
        layer: "mechanical",
        method: defaultMethod,
        trigger: "post_task",
        rawResult: 80,
        extractedValue: 80,
        confidence: 0.95,
      });
      expect(typeof entry.observation_id).toBe("string");
      expect(entry.observation_id.length).toBeGreaterThan(0);
    });

    it("generates different ids for successive calls", () => {
      const params = {
        goalId: "goal-1",
        dimensionName: "test_dim",
        layer: "mechanical" as ObservationLayer,
        method: defaultMethod,
        trigger: "post_task" as ObservationTrigger,
        rawResult: 80,
        extractedValue: 80,
        confidence: 0.95,
      };
      const e1 = engine.createObservationEntry(params);
      const e2 = engine.createObservationEntry(params);
      expect(e1.observation_id).not.toBe(e2.observation_id);
    });

    it("sets timestamp to a valid ISO string", () => {
      const before = Date.now();
      const entry = engine.createObservationEntry({
        goalId: "goal-1",
        dimensionName: "test_dim",
        layer: "mechanical",
        method: defaultMethod,
        trigger: "periodic",
        rawResult: null,
        extractedValue: null,
        confidence: 0.90,
      });
      const after = Date.now();
      const ts = new Date(entry.timestamp).getTime();
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(after);
    });

    it("mechanical: clamps confidence above tier max (1.0) to 1.0", () => {
      const entry = engine.createObservationEntry({
        goalId: "goal-1",
        dimensionName: "test_dim",
        layer: "mechanical",
        method: defaultMethod,
        trigger: "post_task",
        rawResult: 1,
        extractedValue: 1,
        confidence: 1.5, // above max
      });
      expect(entry.confidence).toBe(1.0);
    });

    it("mechanical: clamps confidence below tier min (0.85) to 0.85", () => {
      const entry = engine.createObservationEntry({
        goalId: "goal-1",
        dimensionName: "test_dim",
        layer: "mechanical",
        method: defaultMethod,
        trigger: "post_task",
        rawResult: 1,
        extractedValue: 1,
        confidence: 0.5, // below mechanical min
      });
      expect(entry.confidence).toBe(0.85);
    });

    it("self_report: clamps confidence above tier max (0.49) to 0.49", () => {
      const entry = engine.createObservationEntry({
        goalId: "goal-1",
        dimensionName: "test_dim",
        layer: "self_report",
        method: { ...defaultMethod, confidence_tier: "self_report" },
        trigger: "post_task",
        rawResult: "done",
        extractedValue: 1,
        confidence: 0.80, // above self_report max
      });
      expect(entry.confidence).toBe(0.49);
    });

    it("self_report: clamps confidence below tier min (0.10) to 0.10", () => {
      const entry = engine.createObservationEntry({
        goalId: "goal-1",
        dimensionName: "test_dim",
        layer: "self_report",
        method: { ...defaultMethod, confidence_tier: "self_report" },
        trigger: "post_task",
        rawResult: "done",
        extractedValue: 1,
        confidence: 0.01, // below self_report min
      });
      expect(entry.confidence).toBe(0.10);
    });

    it("sets notes to null when not provided", () => {
      const entry = engine.createObservationEntry({
        goalId: "goal-1",
        dimensionName: "test_dim",
        layer: "mechanical",
        method: defaultMethod,
        trigger: "post_task",
        rawResult: 80,
        extractedValue: 80,
        confidence: 0.90,
      });
      expect(entry.notes).toBeNull();
    });

    it("preserves provided notes", () => {
      const entry = engine.createObservationEntry({
        goalId: "goal-1",
        dimensionName: "test_dim",
        layer: "independent_review",
        method: { ...defaultMethod, confidence_tier: "independent_review" },
        trigger: "event_driven",
        rawResult: { score: 0.75 },
        extractedValue: 0.75,
        confidence: 0.70,
        notes: "Reviewed by LLM session 42",
      });
      expect(entry.notes).toBe("Reviewed by LLM session 42");
    });

    it("preserves all provided fields correctly", () => {
      const entry = engine.createObservationEntry({
        goalId: "goal-abc",
        dimensionName: "coverage",
        layer: "mechanical",
        method: defaultMethod,
        trigger: "post_task",
        rawResult: 95,
        extractedValue: 95,
        confidence: 0.98,
      });
      expect(entry.goal_id).toBe("goal-abc");
      expect(entry.dimension_name).toBe("coverage");
      expect(entry.layer).toBe("mechanical");
      expect(entry.trigger).toBe("post_task");
      expect(entry.extracted_value).toBe(95);
    });
  });

  // ─── needsVerificationTask ───

  describe("needsVerificationTask", () => {
    it("returns true when progress >= threshold AND confidence < 0.85", () => {
      expect(engine.needsVerificationTask(0.80, 0.70, 0.80)).toBe(true);
    });

    it("returns true when progress exactly equals threshold and confidence < 0.85", () => {
      expect(engine.needsVerificationTask(0.90, 0.50, 0.90)).toBe(true);
    });

    it("returns false when progress < threshold regardless of confidence", () => {
      expect(engine.needsVerificationTask(0.50, 0.30, 0.80)).toBe(false);
    });

    it("returns false when confidence >= 0.85 regardless of progress", () => {
      expect(engine.needsVerificationTask(1.0, 0.90, 0.80)).toBe(false);
    });

    it("returns false when both progress < threshold and confidence >= 0.85", () => {
      expect(engine.needsVerificationTask(0.40, 0.90, 0.90)).toBe(false);
    });

    it("boundary: confidence exactly 0.85 returns false (not < 0.85)", () => {
      expect(engine.needsVerificationTask(1.0, 0.85, 0.80)).toBe(false);
    });

    it("boundary: progress = 0 with threshold > 0, returns false", () => {
      expect(engine.needsVerificationTask(0, 0.30, 0.5)).toBe(false);
    });
  });

  // ─── resolveContradiction ───

  describe("resolveContradiction", () => {
    it("throws when entries is empty", () => {
      expect(() => engine.resolveContradiction([])).toThrow();
    });

    it("returns the single entry when only one provided", () => {
      const entry = makeEntry({ layer: "self_report", confidence: 0.30 });
      expect(engine.resolveContradiction([entry])).toEqual(entry);
    });

    it("mechanical beats self_report", () => {
      const mechanicalEntry = makeEntry({ layer: "mechanical", confidence: 0.90, extracted_value: 80 });
      const selfReportEntry = makeEntry({ layer: "self_report", confidence: 0.30, extracted_value: 95 });
      const winner = engine.resolveContradiction([selfReportEntry, mechanicalEntry]);
      expect(winner.layer).toBe("mechanical");
    });

    it("mechanical beats independent_review", () => {
      const mechanicalEntry = makeEntry({ layer: "mechanical", confidence: 0.90, extracted_value: 70 });
      const reviewEntry = makeEntry({ layer: "independent_review", confidence: 0.65, extracted_value: 90 });
      const winner = engine.resolveContradiction([reviewEntry, mechanicalEntry]);
      expect(winner.layer).toBe("mechanical");
    });

    it("independent_review beats self_report", () => {
      const reviewEntry = makeEntry({ layer: "independent_review", confidence: 0.65, extracted_value: 75 });
      const selfEntry = makeEntry({ layer: "self_report", confidence: 0.30, extracted_value: 90 });
      const winner = engine.resolveContradiction([selfEntry, reviewEntry]);
      expect(winner.layer).toBe("independent_review");
    });

    it("within same layer (mechanical): pessimistic (lower numeric) wins", () => {
      const high = makeEntry({ layer: "mechanical", confidence: 0.92, extracted_value: 90 });
      const low = makeEntry({ layer: "mechanical", confidence: 0.88, extracted_value: 60 });
      const winner = engine.resolveContradiction([high, low]);
      expect(winner.extracted_value).toBe(60);
    });

    it("within same layer (self_report): pessimistic wins", () => {
      const e1 = makeEntry({ layer: "self_report", confidence: 0.40, extracted_value: 55 });
      const e2 = makeEntry({ layer: "self_report", confidence: 0.35, extracted_value: 30 });
      const winner = engine.resolveContradiction([e1, e2]);
      expect(winner.extracted_value).toBe(30);
    });

    it("within same layer with non-numeric values: returns first entry", () => {
      const e1 = makeEntry({ layer: "self_report", confidence: 0.40, extracted_value: "done" });
      const e2 = makeEntry({ layer: "self_report", confidence: 0.35, extracted_value: "partial" });
      const winner = engine.resolveContradiction([e1, e2]);
      // Non-numeric: first entry in the group is returned
      expect(winner.extracted_value).toBe("done");
    });
  });

  // ─── applyObservation ───

  describe("applyObservation", () => {
    it("throws when goal is not found", async () => {
      const entry = makeEntry({ goal_id: "nonexistent" });
      await expect(engine.applyObservation("nonexistent", entry)).rejects.toThrow(
        /goal "nonexistent" not found/
      );
    });

    it("throws when dimension is not found in goal", async () => {
      const goal = makeGoal({ id: "goal-1" });
      await stateManager.saveGoal(goal);
      const entry = makeEntry({ goal_id: "goal-1", dimension_name: "nonexistent_dim" });
      await expect(engine.applyObservation("goal-1", entry)).rejects.toThrow(
        /dimension "nonexistent_dim" not found/
      );
    });

    it("updates dimension current_value after applying observation", async () => {
      const goal = makeGoal({ id: "goal-1", dimensions: [testDimension] });
      await stateManager.saveGoal(goal);

      const entry = engine.createObservationEntry({
        goalId: "goal-1",
        dimensionName: "test_dim",
        layer: "mechanical",
        method: defaultMethod,
        trigger: "post_task",
        rawResult: 80,
        extractedValue: 80,
        confidence: 0.95,
      });

      await engine.applyObservation("goal-1", entry);

      const updatedGoal = await stateManager.loadGoal("goal-1");
      expect(updatedGoal).not.toBeNull();
      const dim = updatedGoal!.dimensions.find((d) => d.name === "test_dim");
      expect(dim).not.toBeNull();
      expect(dim!.current_value).toBe(80);
    });

    it("updates dimension confidence after applying observation", async () => {
      const goal = makeGoal({ id: "goal-1", dimensions: [testDimension] });
      await stateManager.saveGoal(goal);

      const entry = engine.createObservationEntry({
        goalId: "goal-1",
        dimensionName: "test_dim",
        layer: "mechanical",
        method: defaultMethod,
        trigger: "post_task",
        rawResult: 80,
        extractedValue: 80,
        confidence: 0.95,
      });

      await engine.applyObservation("goal-1", entry);

      const updatedGoal = await stateManager.loadGoal("goal-1");
      const dim = updatedGoal!.dimensions.find((d) => d.name === "test_dim");
      expect(dim!.confidence).toBe(entry.confidence);
    });

    it("appends entry to dimension history with correct source_observation_id", async () => {
      const goal = makeGoal({ id: "goal-1", dimensions: [testDimension] });
      await stateManager.saveGoal(goal);

      const entry = engine.createObservationEntry({
        goalId: "goal-1",
        dimensionName: "test_dim",
        layer: "mechanical",
        method: defaultMethod,
        trigger: "post_task",
        rawResult: 80,
        extractedValue: 80,
        confidence: 0.95,
      });

      await engine.applyObservation("goal-1", entry);

      const updatedGoal = await stateManager.loadGoal("goal-1");
      const dim = updatedGoal!.dimensions.find((d) => d.name === "test_dim");
      expect(dim!.history).toHaveLength(1);
      expect(dim!.history[0]!.source_observation_id).toBe(entry.observation_id);
      expect(dim!.history[0]!.value).toBe(80);
    });

    it("persists the observation entry in the observation log", async () => {
      const goal = makeGoal({ id: "goal-1", dimensions: [testDimension] });
      await stateManager.saveGoal(goal);

      const entry = engine.createObservationEntry({
        goalId: "goal-1",
        dimensionName: "test_dim",
        layer: "mechanical",
        method: defaultMethod,
        trigger: "post_task",
        rawResult: 80,
        extractedValue: 80,
        confidence: 0.95,
      });

      await engine.applyObservation("goal-1", entry);

      const log = await stateManager.loadObservationLog("goal-1");
      expect(log).not.toBeNull();
      expect(log!.entries).toHaveLength(1);
      expect(log!.entries[0]!.observation_id).toBe(entry.observation_id);
    });

    it("accumulates multiple observations in history", async () => {
      const goal = makeGoal({ id: "goal-1", dimensions: [testDimension] });
      await stateManager.saveGoal(goal);

      for (let i = 0; i < 3; i++) {
        const entry = engine.createObservationEntry({
          goalId: "goal-1",
          dimensionName: "test_dim",
          layer: "mechanical",
          method: defaultMethod,
          trigger: "post_task",
          rawResult: 60 + i * 10,
          extractedValue: 60 + i * 10,
          confidence: 0.90,
        });
        await engine.applyObservation("goal-1", entry);
      }

      const updatedGoal = await stateManager.loadGoal("goal-1");
      const dim = updatedGoal!.dimensions.find((d) => d.name === "test_dim");
      expect(dim!.history).toHaveLength(3);
      expect(dim!.current_value).toBe(80); // last applied value
    });
  });

  // ─── getObservationLog / saveObservationLog ───

  describe("getObservationLog", () => {
    it("returns empty log when none exists", async () => {
      const log = await engine.getObservationLog("goal-nonexistent");
      expect(log.goal_id).toBe("goal-nonexistent");
      expect(log.entries).toHaveLength(0);
    });

    it("returns existing log after entries are appended", async () => {
      const goal = makeGoal({ id: "goal-2", dimensions: [testDimension] });
      await stateManager.saveGoal(goal);

      const entry = engine.createObservationEntry({
        goalId: "goal-2",
        dimensionName: "test_dim",
        layer: "mechanical",
        method: defaultMethod,
        trigger: "post_task",
        rawResult: 70,
        extractedValue: 70,
        confidence: 0.92,
      });
      await engine.applyObservation("goal-2", entry);

      const log = await engine.getObservationLog("goal-2");
      expect(log.goal_id).toBe("goal-2");
      expect(log.entries).toHaveLength(1);
      expect(log.entries[0]!.observation_id).toBe(entry.observation_id);
    });
  });

  describe("saveObservationLog", () => {
    it("persists a log and allows round-trip retrieval", async () => {
      const entry1 = makeEntry({ goal_id: "goal-3", observation_id: "obs-1", extracted_value: 55 });
      const entry2 = makeEntry({ goal_id: "goal-3", observation_id: "obs-2", extracted_value: 70 });
      const log = { goal_id: "goal-3", entries: [entry1, entry2] };

      await engine.saveObservationLog("goal-3", log);

      const loaded = await engine.getObservationLog("goal-3");
      expect(loaded.goal_id).toBe("goal-3");
      expect(loaded.entries).toHaveLength(2);
      expect(loaded.entries[0]!.observation_id).toBe("obs-1");
      expect(loaded.entries[1]!.observation_id).toBe("obs-2");
    });

    it("overwrites previous log on second save", async () => {
      const entry1 = makeEntry({ goal_id: "goal-4", observation_id: "obs-a", extracted_value: 40 });
      await engine.saveObservationLog("goal-4", { goal_id: "goal-4", entries: [entry1] });

      const entry2 = makeEntry({ goal_id: "goal-4", observation_id: "obs-b", extracted_value: 80 });
      await engine.saveObservationLog("goal-4", { goal_id: "goal-4", entries: [entry2] });

      const loaded = await engine.getObservationLog("goal-4");
      expect(loaded.entries).toHaveLength(1);
      expect(loaded.entries[0]!.observation_id).toBe("obs-b");
    });
  });

  // ─── detectKnowledgeGap ───

  describe("detectKnowledgeGap", () => {
    it("returns null when entries array is empty", () => {
      const result = engine.detectKnowledgeGap([]);
      expect(result).toBeNull();
    });

    it("returns null when all entries have confidence >= 0.3", () => {
      const entry = makeEntry({ layer: "self_report", confidence: 0.30 });
      const result = engine.detectKnowledgeGap([entry]);
      expect(result).toBeNull();
    });

    it("returns null when at least one entry has confidence >= 0.3", () => {
      const low = makeEntry({ layer: "self_report", confidence: 0.10 });
      const ok = makeEntry({ layer: "self_report", confidence: 0.40 });
      const result = engine.detectKnowledgeGap([low, ok]);
      expect(result).toBeNull();
    });

    it("returns interpretation_difficulty signal when all entries have confidence < 0.3", () => {
      const e1 = makeEntry({ layer: "self_report", confidence: 0.10 });
      const e2 = makeEntry({ layer: "self_report", confidence: 0.20 });
      const result = engine.detectKnowledgeGap([e1, e2]);
      expect(result).not.toBeNull();
      expect(result!.signal_type).toBe("interpretation_difficulty");
    });

    it("signal has source_step = gap_recognition", () => {
      const entry = makeEntry({ layer: "self_report", confidence: 0.10 });
      const result = engine.detectKnowledgeGap([entry]);
      expect(result!.source_step).toBe("gap_recognition");
    });

    it("signal has non-empty missing_knowledge description", () => {
      const entry = makeEntry({ layer: "self_report", confidence: 0.10 });
      const result = engine.detectKnowledgeGap([entry]);
      expect(result!.missing_knowledge.length).toBeGreaterThan(0);
    });

    it("signal carries the provided dimensionName in related_dimension", () => {
      const entry = makeEntry({ layer: "self_report", confidence: 0.10 });
      const result = engine.detectKnowledgeGap([entry], "coverage");
      expect(result!.related_dimension).toBe("coverage");
    });

    it("related_dimension is null when dimensionName is omitted", () => {
      const entry = makeEntry({ layer: "self_report", confidence: 0.10 });
      const result = engine.detectKnowledgeGap([entry]);
      expect(result!.related_dimension).toBeNull();
    });
  });
});

// ─── observeFromDataSource ───

function makeDsConfig(overrides: Partial<DataSourceConfig> = {}): DataSourceConfig {
  return {
    id: "mock-ds",
    name: "Mock Data Source",
    type: "file",
    connection: { path: "/tmp/mock.json" },
    enabled: true,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeMockDataSource(overrides: Partial<IDataSourceAdapter> = {}): IDataSourceAdapter {
  return {
    sourceId: "mock-ds",
    sourceType: "file",
    config: makeDsConfig(),
    connect: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue({
      value: 42,
      raw: { metrics: { cpu: 42 } },
      timestamp: new Date().toISOString(),
      source_id: "mock-ds",
    }),
    disconnect: vi.fn().mockResolvedValue(undefined),
    healthCheck: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

describe("observeFromDataSource", () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let mockDs: IDataSourceAdapter;
  let engineWithDs: ObservationEngine;

  beforeEach(() => {
    tmpDir = makeTempDir();
    stateManager = new StateManager(tmpDir);
    mockDs = makeMockDataSource();
    engineWithDs = new ObservationEngine(stateManager, [mockDs]);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true , maxRetries: 3, retryDelay: 100 });
  });

  it("creates observation entry from data source query result", async () => {
    const goal = makeGoal({
      id: "goal-ds-1",
      dimensions: [
        {
          name: "cpu",
          label: "CPU Usage",
          current_value: 0,
          threshold: { type: "max", value: 80 },
          confidence: 0.5,
          observation_method: defaultMethod,
          last_updated: new Date().toISOString(),
          history: [],
          weight: 1.0,
          uncertainty_weight: null,
          state_integrity: "ok",
          dimension_mapping: null,
        },
      ],
    });
    await stateManager.saveGoal(goal);

    const entry = await engineWithDs.observeFromDataSource("goal-ds-1", "cpu", "mock-ds");

    expect(entry).not.toBeNull();
    expect(entry.goal_id).toBe("goal-ds-1");
    expect(entry.dimension_name).toBe("cpu");
    expect(entry.extracted_value).toBe(42);
    expect(entry.layer).toBe("mechanical");
    expect(typeof entry.observation_id).toBe("string");
    expect(entry.observation_id.length).toBeGreaterThan(0);
  });

  it("throws when source is not found in dataSources", async () => {
    await expect(
      engineWithDs.observeFromDataSource("goal-ds-1", "cpu", "nonexistent-ds")
    ).rejects.toThrow(/nonexistent-ds/);
  });

  // ─── findDataSourceForDimension scoped-priority ───

  describe("findDataSourceForDimension scoped-priority", () => {
    it("prefers scoped datasource over unscoped when both support the same dimension", async () => {
      const goalId = "goal-scoped-test";

      const unscopedDs = makeMockDataSource({
        sourceId: "unscoped-ds",
        config: makeDsConfig({ id: "unscoped-ds" }),
        getSupportedDimensions: () => ["metric_x"],
        query: vi.fn().mockResolvedValue({
          value: 1,
          raw: { value: 1 },
          timestamp: new Date().toISOString(),
          source_id: "unscoped-ds",
        }),
      });

      const scopedDs = makeMockDataSource({
        sourceId: "scoped-ds",
        config: makeDsConfig({ id: "scoped-ds", scope_goal_id: goalId } as never),
        getSupportedDimensions: () => ["metric_x"],
        query: vi.fn().mockResolvedValue({
          value: 99,
          raw: { value: 99 },
          timestamp: new Date().toISOString(),
          source_id: "scoped-ds",
        }),
      });

      // unscoped appears first in the array — scoped must still win
      const eng = new ObservationEngine(stateManager, [unscopedDs, scopedDs]);

      const goal = makeGoal({
        id: goalId,
        dimensions: [
          {
            name: "metric_x",
            label: "Metric X",
            current_value: 0,
            threshold: { type: "min", value: 100 },
            confidence: 0.5,
            observation_method: defaultMethod,
            last_updated: new Date().toISOString(),
            history: [],
            weight: 1.0,
            uncertainty_weight: null,
            state_integrity: "ok",
            dimension_mapping: null,
          },
        ],
      });
      await stateManager.saveGoal(goal);

      const entry = await eng.observeFromDataSource(goalId, "metric_x", "scoped-ds");
      expect(entry.extracted_value).toBe(99);
      expect(scopedDs.query).toHaveBeenCalled();
      expect(unscopedDs.query).not.toHaveBeenCalled();
    });

    it("falls back to unscoped datasource when no scoped datasource exists", async () => {
      const goalId = "goal-fallback-test";

      const unscopedDs = makeMockDataSource({
        sourceId: "only-ds",
        config: makeDsConfig({ id: "only-ds" }),
        getSupportedDimensions: () => ["metric_y"],
        query: vi.fn().mockResolvedValue({
          value: 55,
          raw: { value: 55 },
          timestamp: new Date().toISOString(),
          source_id: "only-ds",
        }),
      });

      const eng = new ObservationEngine(stateManager, [unscopedDs]);

      const goal = makeGoal({
        id: goalId,
        dimensions: [
          {
            name: "metric_y",
            label: "Metric Y",
            current_value: 0,
            threshold: { type: "min", value: 100 },
            confidence: 0.5,
            observation_method: defaultMethod,
            last_updated: new Date().toISOString(),
            history: [],
            weight: 1.0,
            uncertainty_weight: null,
            state_integrity: "ok",
            dimension_mapping: null,
          },
        ],
      });
      await stateManager.saveGoal(goal);

      const entry = await eng.observeFromDataSource(goalId, "metric_y", "only-ds");
      expect(entry.extracted_value).toBe(55);
      expect(unscopedDs.query).toHaveBeenCalled();
    });

    it("falls back to a datasource scoped to a different goal when no exact or unscoped match exists", async () => {
      const goalIdA = "goal-a";
      const goalIdB = "goal-b";

      // Datasource scoped to goal-a covers "todo_count"
      const scopedToA = makeMockDataSource({
        sourceId: "ds-scoped-to-a",
        config: makeDsConfig({ id: "ds-scoped-to-a", scope_goal_id: goalIdA } as never),
        getSupportedDimensions: () => ["todo_count"],
        query: vi.fn().mockResolvedValue({
          value: 42,
          raw: { value: 42 },
          timestamp: new Date().toISOString(),
          source_id: "ds-scoped-to-a",
        }),
      });

      // goal-b uses the same dimension name but dedup prevented creating its own datasource
      const eng = new ObservationEngine(stateManager, [scopedToA]);

      const goalB = makeGoal({
        id: goalIdB,
        dimensions: [
          {
            name: "todo_count",
            label: "Todo Count",
            current_value: 0,
            threshold: { type: "min", value: 10 },
            confidence: 0.5,
            observation_method: defaultMethod,
            last_updated: new Date().toISOString(),
            history: [],
            weight: 1.0,
            uncertainty_weight: null,
            state_integrity: "ok",
            dimension_mapping: null,
          },
        ],
      });
      await stateManager.saveGoal(goalB);

      const entry = await eng.observeFromDataSource(goalIdB, "todo_count", "ds-scoped-to-a");
      expect(entry.extracted_value).toBe(42);
      expect(scopedToA.query).toHaveBeenCalled();
    });
  });

  it("uses dimension_mapping from config to build expression when present", async () => {
    const dsWithMapping = makeMockDataSource({
      sourceId: "mapped-ds",
      config: makeDsConfig({
        id: "mapped-ds",
        dimension_mapping: { cpu: "metrics.cpu" },
      }),
    });
    const engineMapped = new ObservationEngine(stateManager, [dsWithMapping]);

    const goal = makeGoal({
      id: "goal-mapped",
      dimensions: [
        {
          name: "cpu",
          label: "CPU",
          current_value: 0,
          threshold: { type: "max", value: 90 },
          confidence: 0.6,
          observation_method: defaultMethod,
          last_updated: new Date().toISOString(),
          history: [],
          weight: 1.0,
          uncertainty_weight: null,
          state_integrity: "ok",
          dimension_mapping: null,
        },
      ],
    });
    await stateManager.saveGoal(goal);

    await engineMapped.observeFromDataSource("goal-mapped", "cpu", "mapped-ds");

    // query should have been called with expression from dimension_mapping
    const queryMock = dsWithMapping.query as ReturnType<typeof vi.fn>;
    expect(queryMock).toHaveBeenCalledWith(
      expect.objectContaining({ expression: "metrics.cpu" })
    );
  });

  it("observes semantic dimensions through typed DataSource observation mappings", async () => {
    const wrongDs = makeMockDataSource({
      sourceId: "wrong-ds",
      config: makeDsConfig({ id: "wrong-ds", name: "wrong" }),
      getSupportedDimensions: () => ["test_coverage_percent"],
      query: vi.fn().mockResolvedValue({
        value: 1,
        raw: { coverage: 1 },
        timestamp: new Date().toISOString(),
        source_id: "wrong-ds",
      }),
    });
    const typedMappedDs = makeMockDataSource({
      sourceId: "ci-ds",
      config: makeDsConfig({ id: "ci-ds", name: "ci" }),
      getSupportedDimensions: () => ["test_coverage_percent"],
      query: vi.fn().mockResolvedValue({
        value: 83,
        raw: { coverage: 83 },
        timestamp: new Date().toISOString(),
        source_id: "ci-ds",
      }),
    });
    const engineMapped = new ObservationEngine(stateManager, [wrongDs, typedMappedDs]);

    const goal = makeGoal({
      id: "goal-observation-mapping",
      dimensions: [
        {
          name: "test_coverage",
          label: "Test Coverage",
          current_value: 0,
          threshold: { type: "min", value: 80 },
          confidence: 0.6,
          observation_method: defaultMethod,
          last_updated: new Date().toISOString(),
          history: [],
          weight: 1.0,
          uncertainty_weight: null,
          state_integrity: "ok",
          observation_mapping: {
            kind: "data_source",
            data_source: "ci",
            dimension: "test_coverage_percent",
            confidence: "high",
          },
          dimension_mapping: null,
        },
      ],
    });
    await stateManager.saveGoal(goal);

    await engineMapped.observe("goal-observation-mapping", []);

    const queryMock = typedMappedDs.query as ReturnType<typeof vi.fn>;
    expect(queryMock).toHaveBeenCalledWith(
      expect.objectContaining({ dimension_name: "test_coverage_percent" })
    );
    expect(wrongDs.query).not.toHaveBeenCalled();
    const updated = await stateManager.loadGoal("goal-observation-mapping");
    expect(updated?.dimensions[0]?.name).toBe("test_coverage");
    expect(updated?.dimensions[0]?.current_value).toBe(83);
  });

  it("falls back instead of persisting non-finite datasource numbers", async () => {
    const nonFiniteDs = makeMockDataSource({
      getSupportedDimensions: () => ["accuracy"],
      query: vi.fn().mockResolvedValue({
        value: Infinity,
        raw: { accuracy: Infinity },
        timestamp: new Date().toISOString(),
        source_id: "mock-ds",
      }),
    });
    const llmClient = makeMockLLMClient(0.37);
    const engineWithFallback = new ObservationEngine(
      stateManager,
      [nonFiniteDs],
      llmClient,
      async () => "workspace context exists",
    );

    const goal = makeGoal({
      id: "goal-non-finite-datasource",
      dimensions: [
        {
          name: "accuracy",
          label: "Accuracy",
          current_value: 0,
          threshold: { type: "min", value: 1 },
          confidence: 0.5,
          observation_method: defaultMethod,
          last_updated: new Date().toISOString(),
          history: [],
          weight: 1.0,
          uncertainty_weight: null,
          state_integrity: "ok",
          dimension_mapping: null,
        },
      ],
    });
    await stateManager.saveGoal(goal);

    await engineWithFallback.observe("goal-non-finite-datasource", []);

    const updated = await stateManager.loadGoal("goal-non-finite-datasource");
    expect(updated?.dimensions[0]?.current_value).toBe(0.37);
    expect(updated?.dimensions[0]?.last_observed_layer).toBe("independent_review");
    expect(nonFiniteDs.query).toHaveBeenCalled();
    expect(llmClient.sendMessage).toHaveBeenCalled();
  });

  it("observes goal-workspace Kaggle experiment metrics before LLM fallback", async () => {
    const daemonWorkspace = path.join(tmpDir, "daemon-workspace");
    const goalWorkspace = path.join(tmpDir, "kaggle-workspace");
    fs.mkdirSync(daemonWorkspace, { recursive: true });
    writeJsonFile(path.join(goalWorkspace, "experiments", "smoke-hgb-50k", "metrics.json"), {
      metric_name: "roc_auc",
      direction: "maximize",
      cv_score: 0.9331832527157385,
      status: "completed",
    });
    writeJsonFile(path.join(daemonWorkspace, "experiments", "wrong", "metrics.json"), {
      metric_name: "roc_auc",
      cv_score: 0.1,
    });
    const llmClient = makeMockLLMClient(0.2);
    const engine = new ObservationEngine(
      stateManager,
      [createWorkspaceArtifactMetricDataSource(daemonWorkspace)],
      llmClient,
      async () => "workspace context exists",
    );
    const goal = makeGoal({
      id: "goal-kaggle-roc-auc",
      constraints: [`workspace_path:${goalWorkspace}`],
      dimensions: [
        {
          name: "roc_auc",
          label: "ROC AUC",
          current_value: 0,
          threshold: { type: "min", value: 0.95 },
          confidence: 0.5,
          observation_method: defaultMethod,
          last_updated: new Date().toISOString(),
          history: [],
          weight: 1.0,
          uncertainty_weight: null,
          state_integrity: "ok",
          dimension_mapping: null,
        },
      ],
    });
    await stateManager.saveGoal(goal);

    await engine.observe("goal-kaggle-roc-auc", []);

    const updated = await stateManager.loadGoal("goal-kaggle-roc-auc");
    expect(updated?.dimensions[0]?.current_value).toBe(0.9331832527157385);
    expect(updated?.dimensions[0]?.last_observed_layer).toBe("mechanical");
    expect(llmClient.sendMessage).not.toHaveBeenCalled();
    const log = await stateManager.loadObservationLog("goal-kaggle-roc-auc");
    expect(log).not.toBeNull();
    expect(log!.entries[0]?.raw_result).toMatchObject({
      root: goalWorkspace,
      selected: {
        relativePath: "experiments/smoke-hgb-50k/metrics.json",
        key: "roc_auc",
        keyPath: "cv_score",
      },
    });
  });

  it("lets fresh canonical Kaggle artifact evidence override prior no-evidence reset before LLM jump suppression", async () => {
    const goalWorkspace = path.join(tmpDir, "fresh-reset-kaggle-workspace");
    const goalCreatedAt = new Date(Date.now() - 60_000);
    writeJsonFile(path.join(goalWorkspace, "experiments", "hgb_cv_auc_fast", "metrics.json"), {
      roc_auc: 0.9078005508190139,
    });
    const llmClient = makeMockLLMClient(0.9078005508190139);
    const engine = new ObservationEngine(
      stateManager,
      [],
      llmClient,
      async () => "workspace context exists",
    );
    const goal = makeGoal({
      id: "goal-fresh-reset-kaggle-roc-auc",
      created_at: goalCreatedAt.toISOString(),
      constraints: [`workspace_path:${goalWorkspace}`, "artifact_contract:required"],
      dimensions: [
        {
          name: "roc_auc",
          label: "ROC AUC",
          current_value: 0,
          threshold: { type: "min", value: 0.95 },
          confidence: 0.3,
          observation_method: defaultMethod,
          last_updated: new Date().toISOString(),
          history: [{
            timestamp: new Date(goalCreatedAt.getTime() + 1_000).toISOString(),
            value: 0,
            confidence: 0.1,
            source_observation_id: "obs-prior-no-evidence-reset",
          }],
          weight: 1.0,
          uncertainty_weight: null,
          state_integrity: "ok",
          dimension_mapping: null,
          last_observed_layer: "independent_review",
        },
      ],
    });
    await stateManager.saveGoal(goal);

    await engine.observe("goal-fresh-reset-kaggle-roc-auc", []);

    const updated = await stateManager.loadGoal("goal-fresh-reset-kaggle-roc-auc");
    expect(updated?.dimensions[0]?.current_value).toBe(0.9078005508190139);
    expect(updated?.dimensions[0]?.last_observed_layer).toBe("mechanical");
    expect(llmClient.sendMessage).not.toHaveBeenCalled();
    const log = await stateManager.loadObservationLog("goal-fresh-reset-kaggle-roc-auc");
    expect(log?.entries[0]).toMatchObject({
      layer: "mechanical",
      extracted_value: 0.9078005508190139,
      raw_result: {
        selected: {
          relativePath: "experiments/hgb_cv_auc_fast/metrics.json",
          key: "roc_auc",
          keyPath: "roc_auc",
          freshnessStatus: "fresh",
          currentRun: true,
        },
        freshness: {
          scope: "goal",
          scope_id: "goal-fresh-reset-kaggle-roc-auc",
          current_progress_status: "eligible",
        },
      },
    });
  });

  it("observes builtin-supported artifact metrics from the goal workspace over daemon datasource", async () => {
    const daemonWorkspace = path.join(tmpDir, "daemon-workspace");
    const goalWorkspace = path.join(tmpDir, "builtin-metric-workspace");
    writeJsonFile(path.join(daemonWorkspace, "artifacts", "wrong", "metrics.json"), {
      oof_balanced_accuracy: 0.1,
    });
    writeJsonFile(path.join(goalWorkspace, "artifacts", "probe-balanced", "metrics.json"), {
      oof_balanced_accuracy: 0.88,
      status: "completed",
    });
    const engine = new ObservationEngine(
      stateManager,
      [createWorkspaceArtifactMetricDataSource(daemonWorkspace)],
    );
    const goal = makeGoal({
      id: "goal-builtin-artifact-metrics",
      constraints: [`workspace_path:${goalWorkspace}`],
      dimensions: [
        {
          name: "best_oof_balanced_accuracy",
          label: "Best OOF balanced accuracy",
          current_value: 0,
          threshold: { type: "min", value: 0.95 },
          confidence: 0.5,
          observation_method: defaultMethod,
          last_updated: new Date().toISOString(),
          history: [],
          weight: 1.0,
          uncertainty_weight: null,
          state_integrity: "ok",
          dimension_mapping: null,
        },
      ],
    });
    await stateManager.saveGoal(goal);

    await engine.observe("goal-builtin-artifact-metrics", []);

    const updated = await stateManager.loadGoal("goal-builtin-artifact-metrics");
    expect(updated?.dimensions[0]?.current_value).toBe(0.88);
    const log = await stateManager.loadObservationLog("goal-builtin-artifact-metrics");
    expect(log).not.toBeNull();
    expect(log!.entries[0]?.raw_result).toMatchObject({
      root: goalWorkspace,
      selected: {
        relativePath: "artifacts/probe-balanced/metrics.json",
        key: "oof_balanced_accuracy",
      },
    });
  });

  it("resolves legacy relative workspace_path artifact metrics under the configured workspace base", async () => {
    const daemonWorkspace = path.join(tmpDir, "daemon-relative-workspace");
    const workspaceBase = path.join(tmpDir, "workspace-base");
    const goalWorkspace = path.join(workspaceBase, "relative-metric-workspace");
    writeJsonFile(path.join(daemonWorkspace, "artifacts", "wrong", "metrics.json"), {
      oof_balanced_accuracy: 0.1,
    });
    writeJsonFile(path.join(goalWorkspace, "artifacts", "probe-balanced", "metrics.json"), {
      oof_balanced_accuracy: 0.91,
      status: "completed",
    });
    const engine = new ObservationEngine(
      stateManager,
      [createWorkspaceArtifactMetricDataSource(daemonWorkspace)],
      undefined,
      undefined,
      { workspaceBasePath: workspaceBase },
    );
    const goal = makeGoal({
      id: "goal-relative-artifact-metrics",
      constraints: ["workspace_path:relative-metric-workspace"],
      dimensions: [
        {
          name: "best_oof_balanced_accuracy",
          label: "Best OOF balanced accuracy",
          current_value: 0,
          threshold: { type: "min", value: 0.95 },
          confidence: 0.5,
          observation_method: defaultMethod,
          last_updated: new Date().toISOString(),
          history: [],
          weight: 1.0,
          uncertainty_weight: null,
          state_integrity: "ok",
          dimension_mapping: null,
        },
      ],
    });
    await stateManager.saveGoal(goal);

    await engine.observe("goal-relative-artifact-metrics", []);

    const updated = await stateManager.loadGoal("goal-relative-artifact-metrics");
    expect(updated?.dimensions[0]?.current_value).toBe(0.91);
    const log = await stateManager.loadObservationLog("goal-relative-artifact-metrics");
    expect(log!.entries[0]?.raw_result).toMatchObject({
      root: goalWorkspace,
      selected: {
        relativePath: "artifacts/probe-balanced/metrics.json",
        key: "oof_balanced_accuracy",
      },
    });
  });

  it("scopes required artifact metric progress to the current task freshness anchor", async () => {
    const goalWorkspace = path.join(tmpDir, "task-scoped-metric-workspace");
    const taskStart = new Date(Date.now() - 60_000);
    const oldMetricPath = path.join(goalWorkspace, "experiments", "old-best", "metrics.json");
    const freshMetricPath = path.join(goalWorkspace, "reports", "current-task", "metrics.json");
    writeJsonFile(oldMetricPath, {
      metric_name: "balanced_accuracy",
      cv_score: 0.9473134912423415,
      status: "completed",
    });
    writeJsonFile(freshMetricPath, {
      balanced_accuracy: 0.71,
      status: "completed",
    });
    fs.utimesSync(oldMetricPath, new Date(taskStart.getTime() - 5_000), new Date(taskStart.getTime() - 5_000));
    fs.utimesSync(freshMetricPath, new Date(taskStart.getTime() + 5_000), new Date(taskStart.getTime() + 5_000));
    const engine = new ObservationEngine(stateManager, []);
    const goal = makeGoal({
      id: "goal-task-scoped-artifact-metrics",
      created_at: new Date(taskStart.getTime() - 120_000).toISOString(),
      constraints: [
        `workspace_path:${goalWorkspace}`,
        "run_spec_profile:kaggle",
        "artifact_contract:required",
      ],
      dimensions: [
        {
          name: "best_balanced_accuracy",
          label: "Best balanced accuracy",
          current_value: 0,
          threshold: { type: "min", value: 0.95 },
          confidence: 0.5,
          observation_method: defaultMethod,
          last_updated: new Date().toISOString(),
          history: [],
          weight: 1.0,
          uncertainty_weight: null,
          state_integrity: "ok",
          dimension_mapping: null,
        },
      ],
    });
    await stateManager.saveGoal(goal);
    await stateManager.writeRaw("tasks/goal-task-scoped-artifact-metrics/task-current.json", makeTaskRecord({
      id: "task-current",
      goal_id: "goal-task-scoped-artifact-metrics",
      primary_dimension: "best_balanced_accuracy",
      target_dimensions: ["best_balanced_accuracy"],
      constraints: ["run_spec_profile:kaggle"],
      started_at: taskStart.toISOString(),
      created_at: new Date(taskStart.getTime() - 10_000).toISOString(),
    }));

    await engine.observe("goal-task-scoped-artifact-metrics", []);

    const updated = await stateManager.loadGoal("goal-task-scoped-artifact-metrics");
    expect(updated?.dimensions[0]?.current_value).toBe(0.71);
    const log = await stateManager.loadObservationLog("goal-task-scoped-artifact-metrics");
    expect(log).not.toBeNull();
    expect(log!.entries[0]?.raw_result).toMatchObject({
      selected: {
        relativePath: "reports/current-task/metrics.json",
        freshnessStatus: "fresh",
        currentRun: true,
      },
      freshness: {
        scope: "task",
        scope_id: "task-current",
        selected_path: "reports/current-task/metrics.json",
        selected_freshness_status: "fresh",
        selected_current_run: true,
        current_progress_status: "eligible",
      },
      ineligible_candidates: [
        {
          path: "experiments/old-best/metrics.json",
          freshness_status: "pre_scope",
          current_run: false,
        },
      ],
    });
  });

  it("lowers confidence when required task-scoped artifact metrics are age-stale", async () => {
    const goalWorkspace = path.join(tmpDir, "task-scoped-stale-metric-workspace");
    const taskStart = new Date(Date.now() - 72 * 60 * 60 * 1000);
    const staleMetricPath = path.join(goalWorkspace, "reports", "current-task", "metrics.json");
    writeJsonFile(staleMetricPath, {
      balanced_accuracy: 0.9473134912423415,
      status: "completed",
    });
    fs.utimesSync(
      staleMetricPath,
      new Date(Date.now() - 48 * 60 * 60 * 1000),
      new Date(Date.now() - 48 * 60 * 60 * 1000),
    );
    const engine = new ObservationEngine(stateManager, []);
    const goal = makeGoal({
      id: "goal-task-scoped-stale-artifact-metrics",
      created_at: new Date(taskStart.getTime() - 120_000).toISOString(),
      constraints: [
        `workspace_path:${goalWorkspace}`,
        "artifact_contract:required",
      ],
      dimensions: [
        {
          name: "best_balanced_accuracy",
          label: "Best balanced accuracy",
          current_value: 0.94,
          threshold: { type: "min", value: 0.95 },
          confidence: 0.9,
          observation_method: defaultMethod,
          last_updated: new Date().toISOString(),
          history: [],
          weight: 1.0,
          uncertainty_weight: null,
          state_integrity: "ok",
          last_observed_layer: "mechanical",
          dimension_mapping: null,
        },
      ],
    });
    await stateManager.saveGoal(goal);
    await stateManager.writeRaw("tasks/goal-task-scoped-stale-artifact-metrics/task-current.json", makeTaskRecord({
      id: "task-current",
      goal_id: "goal-task-scoped-stale-artifact-metrics",
      primary_dimension: "best_balanced_accuracy",
      target_dimensions: ["best_balanced_accuracy"],
      constraints: ["artifact_contract:required"],
      started_at: taskStart.toISOString(),
      created_at: new Date(taskStart.getTime() - 10_000).toISOString(),
    }));

    await engine.observe("goal-task-scoped-stale-artifact-metrics", []);

    const updated = await stateManager.loadGoal("goal-task-scoped-stale-artifact-metrics");
    expect(updated?.dimensions[0]?.current_value).toBe(0.94);
    expect(updated?.dimensions[0]?.confidence).toBe(0.35);
    expect(updated?.dimensions[0]?.last_observed_layer).toBe("mechanical");
    const log = await stateManager.loadObservationLog("goal-task-scoped-stale-artifact-metrics");
    expect(log?.entries[0]).toMatchObject({
      layer: "mechanical",
      extracted_value: 0,
      confidence: 0.35,
      raw_result: {
        selected: null,
        freshness: {
          scope: "task",
          scope_id: "task-current",
          current_progress_status: "ineligible_artifact_metrics_only",
        },
        ineligible_candidates: [
          {
            path: "reports/current-task/metrics.json",
            freshness_status: "stale",
            current_run: true,
          },
        ],
      },
    });
  });

  it("does not accept stale goal-scoped artifact metrics as mechanical progress", async () => {
    const goalWorkspace = path.join(tmpDir, "stale-metric-workspace");
    const staleMetricPath = path.join(goalWorkspace, "experiments", "old-run", "metrics.json");
    writeJsonFile(staleMetricPath, {
      metric_name: "roc_auc",
      cv_score: 0.99,
      status: "completed",
    });
    const staleTime = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(staleMetricPath, staleTime, staleTime);
    const llmClient = makeMockLLMClient(0.31);
    const engine = new ObservationEngine(
      stateManager,
      [],
      llmClient,
      async () => "workspace context exists",
    );
    const goal = makeGoal({
      id: "goal-stale-artifact-metric",
      constraints: [`workspace_path:${goalWorkspace}`],
      dimensions: [
        {
          name: "roc_auc",
          label: "ROC AUC",
          current_value: 0,
          threshold: { type: "min", value: 0.95 },
          confidence: 0.5,
          observation_method: defaultMethod,
          last_updated: new Date().toISOString(),
          history: [],
          weight: 1.0,
          uncertainty_weight: null,
          state_integrity: "ok",
          dimension_mapping: null,
        },
      ],
    });
    await stateManager.saveGoal(goal);

    await engine.observe("goal-stale-artifact-metric", []);

    const updated = await stateManager.loadGoal("goal-stale-artifact-metric");
    expect(updated?.dimensions[0]?.current_value).toBe(0.31);
    expect(updated?.dimensions[0]?.last_observed_layer).toBe("independent_review");
    expect(llmClient.sendMessage).toHaveBeenCalled();
    const log = await stateManager.loadObservationLog("goal-stale-artifact-metric");
    expect(log?.entries[0]?.layer).toBe("independent_review");
  });

  it("does not accept running goal-scoped artifact metrics as mechanical progress", async () => {
    const goalWorkspace = path.join(tmpDir, "running-metric-workspace");
    writeJsonFile(path.join(goalWorkspace, "experiments", "live-run", "metrics.json"), {
      metric_name: "roc_auc",
      cv_score: 0.98,
      status: "running",
    });
    const llmClient = makeMockLLMClient(0.27);
    const engine = new ObservationEngine(
      stateManager,
      [],
      llmClient,
      async () => "workspace context exists",
    );
    const goal = makeGoal({
      id: "goal-running-artifact-metric",
      constraints: [`workspace_path:${goalWorkspace}`],
      dimensions: [
        {
          name: "roc_auc",
          label: "ROC AUC",
          current_value: 0,
          threshold: { type: "min", value: 0.95 },
          confidence: 0.5,
          observation_method: defaultMethod,
          last_updated: new Date().toISOString(),
          history: [],
          weight: 1.0,
          uncertainty_weight: null,
          state_integrity: "ok",
          dimension_mapping: null,
        },
      ],
    });
    await stateManager.saveGoal(goal);

    await engine.observe("goal-running-artifact-metric", []);

    const updated = await stateManager.loadGoal("goal-running-artifact-metric");
    expect(updated?.dimensions[0]?.current_value).toBe(0.27);
    expect(updated?.dimensions[0]?.last_observed_layer).toBe("independent_review");
    expect(llmClient.sendMessage).toHaveBeenCalled();
    const log = await stateManager.loadObservationLog("goal-running-artifact-metric");
    expect(log?.entries[0]?.layer).toBe("independent_review");
  });

  it("falls back to LLM when the goal-scoped artifact metric is absent", async () => {
    const goalWorkspace = path.join(tmpDir, "kaggle-workspace-without-metrics");
    fs.mkdirSync(goalWorkspace, { recursive: true });
    const llmClient = makeMockLLMClient(0.42);
    const engine = new ObservationEngine(
      stateManager,
      [],
      llmClient,
      async () => "workspace context exists",
    );
    const goal = makeGoal({
      id: "goal-kaggle-llm-fallback",
      constraints: [`workspace_path:${goalWorkspace}`],
      dimensions: [
        {
          name: "roc_auc",
          label: "ROC AUC",
          current_value: 0,
          threshold: { type: "min", value: 0.95 },
          confidence: 0.5,
          observation_method: defaultMethod,
          last_updated: new Date().toISOString(),
          history: [],
          weight: 1.0,
          uncertainty_weight: null,
          state_integrity: "ok",
          dimension_mapping: null,
        },
      ],
    });
    await stateManager.saveGoal(goal);

    await engine.observe("goal-kaggle-llm-fallback", []);

    const updated = await stateManager.loadGoal("goal-kaggle-llm-fallback");
    expect(updated?.dimensions[0]?.current_value).toBe(0.42);
    expect(updated?.dimensions[0]?.last_observed_layer).toBe("independent_review");
    expect(llmClient.sendMessage).toHaveBeenCalled();
  });

  it("handles non-numeric values from data source", async () => {
    const stringDs = makeMockDataSource({
      query: vi.fn().mockResolvedValue({
        value: "healthy",
        raw: { status: "healthy" },
        timestamp: new Date().toISOString(),
        source_id: "mock-ds",
      }),
    });
    const engineStr = new ObservationEngine(stateManager, [stringDs]);

    const goal = makeGoal({
      id: "goal-str",
      dimensions: [
        {
          name: "test_dim",
          label: "Status",
          current_value: 0,
          threshold: { type: "min", value: 1 },
          confidence: 0.5,
          observation_method: defaultMethod,
          last_updated: new Date().toISOString(),
          history: [],
          weight: 1.0,
          uncertainty_weight: null,
          state_integrity: "ok",
          dimension_mapping: null,
        },
      ],
    });
    await stateManager.saveGoal(goal);

    const entry = await engineStr.observeFromDataSource("goal-str", "test_dim", "mock-ds");

    expect(entry.extracted_value).toBe("healthy");
  });

  it("does not partially parse datasource strings with numeric prefixes", async () => {
    const stringDs = makeMockDataSource({
      query: vi.fn().mockResolvedValue({
        value: "42ms",
        raw: { latency: "42ms" },
        timestamp: new Date().toISOString(),
        source_id: "mock-ds",
      }),
    });
    const engineStr = new ObservationEngine(stateManager, [stringDs]);

    const goal = makeGoal({
      id: "goal-partial-string",
      dimensions: [
        {
          name: "latency",
          label: "Latency",
          current_value: 0,
          threshold: { type: "max", value: 100 },
          confidence: 0.5,
          observation_method: defaultMethod,
          last_updated: new Date().toISOString(),
          history: [],
          weight: 1.0,
          uncertainty_weight: null,
          state_integrity: "ok",
          dimension_mapping: null,
        },
      ],
    });
    await stateManager.saveGoal(goal);

    const entry = await engineStr.observeFromDataSource("goal-partial-string", "latency", "mock-ds");

    expect(entry.extracted_value).toBe("42ms");
  });

  it("keeps exact finite datasource numeric strings numeric", async () => {
    const stringDs = makeMockDataSource({
      query: vi.fn().mockResolvedValue({
        value: "4.2e1",
        raw: { latency: "4.2e1" },
        timestamp: new Date().toISOString(),
        source_id: "mock-ds",
      }),
    });
    const engineStr = new ObservationEngine(stateManager, [stringDs]);

    const goal = makeGoal({
      id: "goal-exact-number-string",
      dimensions: [
        {
          name: "latency",
          label: "Latency",
          current_value: 0,
          threshold: { type: "max", value: 100 },
          confidence: 0.5,
          observation_method: defaultMethod,
          last_updated: new Date().toISOString(),
          history: [],
          weight: 1.0,
          uncertainty_weight: null,
          state_integrity: "ok",
          dimension_mapping: null,
        },
      ],
    });
    await stateManager.saveGoal(goal);

    const entry = await engineStr.observeFromDataSource("goal-exact-number-string", "latency", "mock-ds");

    expect(entry.extracted_value).toBe(42);
  });
});

function writeJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function makeTaskRecord(overrides: Record<string, unknown>): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    id: "task-1",
    goal_id: "goal-1",
    strategy_id: null,
    target_dimensions: ["test_dim"],
    primary_dimension: "test_dim",
    work_description: "Run a fresh artifact-producing experiment",
    rationale: "Fresh artifact evidence is required",
    approach: "Create metrics and submission artifacts",
    success_criteria: [],
    scope_boundary: {
      in_scope: ["workspace"],
      out_of_scope: ["external submission"],
      blast_radius: "workspace-local",
    },
    constraints: [],
    plateau_until: null,
    estimated_duration: null,
    consecutive_failure_count: 0,
    reversibility: "unknown",
    task_category: "normal",
    status: "completed",
    started_at: now,
    completed_at: now,
    timeout_at: null,
    heartbeat_at: null,
    created_at: now,
    ...overrides,
  };
}
