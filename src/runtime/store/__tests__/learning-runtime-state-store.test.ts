import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import type {
  FeedbackEntry,
  LearnedPattern,
  StructuralFeedback,
} from "../../../base/types/learning.js";
import { StateManager } from "../../../base/state/state-manager.js";
import { openControlDatabase } from "../control-db/index.js";
import { importLegacyLearningRuntimeState } from "../learning-runtime-state-migration.js";
import { LearningRuntimeStateStore } from "../learning-runtime-state-store.js";

describe("LearningRuntimeStateStore", () => {
  let tmpDir: string;
  let store: LearningRuntimeStateStore;

  beforeEach(() => {
    tmpDir = makeTempDir("pulseed-learning-runtime-state-");
    store = new LearningRuntimeStateStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("persists learning runtime state in the control DB without creating legacy files", async () => {
    const pattern = makePattern("goal-store");
    const feedback = makeFeedback(pattern.pattern_id);
    const structural = makeStructuralFeedback("goal-store");

    await store.saveExperienceLogs("goal-store", [{ event: "observed" }]);
    await store.savePatterns("goal-store", [pattern]);
    await store.saveFeedbackEntries("goal-store", [feedback]);
    await store.saveStructuralFeedback("goal-store", [structural]);

    const reloaded = new LearningRuntimeStateStore(tmpDir);
    await expect(reloaded.loadExperienceLogs("goal-store")).resolves.toEqual([{ event: "observed" }]);
    await expect(reloaded.loadPatterns("goal-store")).resolves.toEqual([pattern]);
    await expect(reloaded.loadAllPatterns()).resolves.toEqual([pattern]);
    await expect(reloaded.loadFeedbackEntries("goal-store")).resolves.toEqual([feedback]);
    await expect(reloaded.loadStructuralFeedback("goal-store")).resolves.toEqual([structural]);
    expect(fs.existsSync(path.join(tmpDir, "learning", "goal-store_logs.json"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "learning", "goal-store_patterns.json"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "learning", "goal-store_feedback.json"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "learning", "goal-store_structural_feedback.json"))).toBe(false);
  });

  it("routes StateManager learning raw compatibility paths to the typed store", async () => {
    const stateManager = new StateManager(tmpDir);
    await stateManager.init();
    const pattern = makePattern("goal-raw");

    await stateManager.writeRaw("learning/goal-raw_logs.json", [{ event: "raw route" }]);
    await stateManager.writeRaw("learning/goal-raw_patterns.json", [pattern]);

    await expect(store.loadExperienceLogs("goal-raw")).resolves.toEqual([{ event: "raw route" }]);
    await expect(stateManager.readRaw("learning/goal-raw_patterns.json")).resolves.toEqual([pattern]);
    expect(fs.existsSync(path.join(tmpDir, "learning", "goal-raw_logs.json"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "learning", "goal-raw_patterns.json"))).toBe(false);
  });

  it("rejects structural feedback stored under a mismatched goal id", async () => {
    await expect(
      store.saveStructuralFeedback("goal-key", [makeStructuralFeedback("goal-payload")]),
    ).rejects.toThrow(/does not match storage key/);
  });

  it("imports legacy learning files only through the explicit repair boundary", async () => {
    fs.mkdirSync(path.join(tmpDir, "learning"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "learning", "goal-import_logs.json"), JSON.stringify([{ event: "legacy" }]));
    fs.writeFileSync(path.join(tmpDir, "learning", "goal-import_patterns.json"), JSON.stringify([makePattern("goal-import")]));
    fs.writeFileSync(path.join(tmpDir, "learning", "goal-import_feedback.json"), JSON.stringify([makeFeedback("pat_goal-import")]));
    fs.writeFileSync(path.join(tmpDir, "learning", "goal-import_structural_feedback.json"), JSON.stringify([makeStructuralFeedback("goal-import")]));

    await expect(store.loadExperienceLogs("goal-import")).resolves.toBeNull();

    const report = await importLegacyLearningRuntimeState(tmpDir);

    expect(report).toMatchObject({
      experienceLogs: 1,
      patterns: 1,
      feedbackEntries: 1,
      structuralFeedback: 1,
      skippedAlreadyImported: 0,
      retiredExistingTypedState: 0,
      blockedSources: [],
    });
    await expect(new LearningRuntimeStateStore(tmpDir).loadExperienceLogs("goal-import")).resolves.toEqual([{ event: "legacy" }]);
    await expect(new LearningRuntimeStateStore(tmpDir).loadPatterns("goal-import")).resolves.toHaveLength(1);
    await expect(new LearningRuntimeStateStore(tmpDir).loadFeedbackEntries("goal-import")).resolves.toHaveLength(1);
    await expect(new LearningRuntimeStateStore(tmpDir).loadStructuralFeedback("goal-import")).resolves.toHaveLength(1);

    const controlDb = await openControlDatabase({ baseDir: tmpDir });
    try {
      expect(controlDb.listLegacyImports()).toEqual(expect.arrayContaining([
        expect.objectContaining({
          source_kind: "learning_experience_logs",
          source_id: "logs:goal-import",
          migration_name: "learning-runtime-state",
          migration_version: 19,
          status: "imported",
        }),
        expect.objectContaining({
          source_kind: "learning_patterns",
          source_id: "patterns:goal-import",
          migration_name: "learning-runtime-state",
          status: "imported",
        }),
      ]));
    } finally {
      controlDb.close();
    }
  });

  it("does not let repeated repair import overwrite newer typed learning state", async () => {
    fs.mkdirSync(path.join(tmpDir, "learning"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "learning", "goal-idempotent_patterns.json"), JSON.stringify([
      makePattern("goal-idempotent", { confidence: 0.1 }),
    ]));

    await importLegacyLearningRuntimeState(tmpDir);
    await store.savePatterns("goal-idempotent", [
      makePattern("goal-idempotent", { confidence: 0.9, description: "new typed pattern" }),
    ]);

    const secondReport = await importLegacyLearningRuntimeState(tmpDir);

    expect(secondReport).toMatchObject({
      experienceLogs: 0,
      patterns: 0,
      feedbackEntries: 0,
      structuralFeedback: 0,
      skippedAlreadyImported: 1,
      retiredExistingTypedState: 0,
      blockedSources: [],
    });
    await expect(store.loadPatterns("goal-idempotent")).resolves.toEqual([
      expect.objectContaining({ confidence: 0.9, description: "new typed pattern" }),
    ]);
  });

  it("retires stale legacy learning files when typed state already exists before first repair", async () => {
    fs.mkdirSync(path.join(tmpDir, "learning"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "learning", "goal-existing_feedback.json"), JSON.stringify([
      makeFeedback("pat_old"),
    ]));
    await store.saveFeedbackEntries("goal-existing", [makeFeedback("pat_typed")]);

    const report = await importLegacyLearningRuntimeState(tmpDir);

    expect(report).toMatchObject({
      experienceLogs: 0,
      patterns: 0,
      feedbackEntries: 0,
      structuralFeedback: 0,
      skippedAlreadyImported: 0,
      retiredExistingTypedState: 1,
      blockedSources: [],
    });
    await expect(store.loadFeedbackEntries("goal-existing")).resolves.toEqual([
      expect.objectContaining({ pattern_id: "pat_typed" }),
    ]);

    const controlDb = await openControlDatabase({ baseDir: tmpDir });
    try {
      expect(controlDb.listLegacyImports()).toEqual(expect.arrayContaining([
        expect.objectContaining({
          source_kind: "learning_feedback_entries",
          source_id: "feedback:goal-existing",
          migration_name: "learning-runtime-state",
          status: "retired",
          details: expect.objectContaining({ reason: "typed learning runtime state already exists" }),
        }),
      ]));
    } finally {
      controlDb.close();
    }
  });

  it("blocks invalid legacy learning files without normal runtime fallback", async () => {
    fs.mkdirSync(path.join(tmpDir, "learning"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "learning", "goal-bad_patterns.json"), JSON.stringify({ not: "an array" }));

    const report = await importLegacyLearningRuntimeState(tmpDir);

    expect(report.patterns).toBe(0);
    expect(report.blockedSources).toEqual([
      expect.objectContaining({
        sourceKind: "learning_patterns",
        sourcePath: path.join("learning", "goal-bad_patterns.json"),
      }),
    ]);
    await expect(store.loadPatterns("goal-bad")).resolves.toEqual([]);
  });
});

function makePattern(goalId: string, overrides: Partial<LearnedPattern> = {}): LearnedPattern {
  return {
    pattern_id: `pat_${goalId}`,
    type: "scope_sizing",
    description: "Reduce task scope when feedback indicates oversizing",
    confidence: 0.8,
    evidence_count: 2,
    source_goal_ids: [goalId],
    applicable_domains: ["testing"],
    embedding_id: null,
    created_at: "2026-05-10T00:00:00.000Z",
    last_applied_at: null,
    ...overrides,
  };
}

function makeFeedback(patternId: string, overrides: Partial<FeedbackEntry> = {}): FeedbackEntry {
  return {
    feedback_id: `fb_${patternId}`,
    pattern_id: patternId,
    target_step: "task",
    adjustment: "Reduce task scope",
    applied_at: "2026-05-10T00:00:00.000Z",
    effect_observed: null,
    ...overrides,
  };
}

function makeStructuralFeedback(goalId: string, overrides: Partial<StructuralFeedback> = {}): StructuralFeedback {
  return {
    id: `sf_${goalId}`,
    goalId,
    iterationId: "iter-1",
    feedbackType: "scope_sizing",
    expected: "small task",
    actual: "large task",
    delta: -0.2,
    timestamp: "2026-05-10T00:00:00.000Z",
    context: { dimension: "scope" },
    ...overrides,
  };
}
