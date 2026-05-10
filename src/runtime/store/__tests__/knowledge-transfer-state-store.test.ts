import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildKnowledgeTransferSnapshot,
  importLegacyKnowledgeTransferState,
  KnowledgeTransferStateStore,
  openControlDatabase,
  type KnowledgeTransferSnapshot,
} from "../index.js";
import { StateManager } from "../../../base/state/state-manager.js";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kt-state-store-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeSnapshot(): KnowledgeTransferSnapshot {
  const now = "2026-05-10T00:00:00.000Z";
  return buildKnowledgeTransferSnapshot({
    transfers: [{
      candidate_id: "tc_1",
      source_goal_id: "source_goal",
      target_goal_id: "target_goal",
      type: "pattern",
      source_item_id: "pat_1",
      similarity_score: 0.8,
      estimated_benefit: "Reuse a scoped pattern",
      state: "applied",
      domain_tag_match: true,
      adapted_content: null,
      effectiveness_score: null,
      proposed_at: now,
      applied_at: now,
      invalidated_at: null,
    }],
    results: [{
      transfer_id: "tr_1",
      candidate_id: "tc_1",
      applied_at: now,
      adaptation_description: "Adapted pattern",
      success: true,
    }],
    effectivenessRecords: [{
      transfer_id: "tr_1",
      gap_delta_before: 0.7,
      gap_delta_after: 0.2,
      effectiveness: "positive",
      evaluated_at: now,
    }],
    applyContexts: {
      tr_1: {
        candidate: {
          candidate_id: "tc_1",
          source_goal_id: "source_goal",
          target_goal_id: "target_goal",
          type: "pattern",
          source_item_id: "pat_1",
          similarity_score: 0.8,
          estimated_benefit: "Reuse a scoped pattern",
          state: "applied",
          domain_tag_match: true,
          adapted_content: null,
          effectiveness_score: null,
          proposed_at: now,
          applied_at: now,
          invalidated_at: null,
        },
        gap_at_apply: 0.7,
        source_pattern: {
          pattern_id: "pat_1",
          type: "scope_sizing",
          description: "Reduce scope when blocked",
          confidence: 0.8,
          evidence_count: 2,
          source_goal_ids: ["source_goal"],
          applicable_domains: ["testing"],
          embedding_id: null,
          created_at: now,
          last_applied_at: null,
        },
      },
    },
    patternTrackers: {
      pat_1: {
        consecutive_non_positive: 0,
        invalidated: false,
      },
    },
    crossGoalPatterns: [{
      id: "cross_1",
      patternType: "success",
      description: "Small scoped iterations reduce stalled goals.",
      sourceGoalIds: ["source_goal"],
      feedbackType: "scope_sizing",
      confidence: 0.8,
      applicableConditions: ["goal is stalled"],
      suggestedAction: "Reduce scope",
      occurrenceCount: 1,
      lastObserved: now,
    }],
  });
}

describe("KnowledgeTransferStateStore", () => {
  it("persists snapshot and meta-pattern watermark in the control DB", async () => {
    const tmpDir = makeTmpDir();
    const store = new KnowledgeTransferStateStore(tmpDir);
    const snapshot = makeSnapshot();

    await store.saveSnapshot(snapshot);
    await store.saveLastAggregatedAt("2026-05-10T01:00:00.000Z");

    await expect(store.loadSnapshot()).resolves.toEqual(snapshot);
    await expect(store.loadLastAggregatedAt()).resolves.toBe("2026-05-10T01:00:00.000Z");
    await expect(store.readRawPath("knowledge-transfer/snapshot.json")).resolves.toMatchObject({
      handled: true,
      value: snapshot,
    });
    await expect(store.readRawPath("meta-patterns/last_aggregated_at.json")).resolves.toEqual({
      handled: true,
      value: { ts: "2026-05-10T01:00:00.000Z" },
    });
    expect(fs.existsSync(path.join(tmpDir, "knowledge-transfer", "snapshot.json"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "meta-patterns", "last_aggregated_at.json"))).toBe(false);
  });

  it("normalizes duplicate slash raw paths before StateManager compatibility routing", async () => {
    const tmpDir = makeTmpDir();
    const stateManager = new StateManager(tmpDir);
    const store = new KnowledgeTransferStateStore(tmpDir);
    const snapshot = makeSnapshot();

    await stateManager.writeRaw("knowledge-transfer//snapshot.json", snapshot);
    await stateManager.writeRaw("meta-patterns//last_aggregated_at.json", {
      ts: "2026-05-10T01:00:00.000Z",
    });

    await expect(store.loadSnapshot()).resolves.toEqual(snapshot);
    await expect(store.loadLastAggregatedAt()).resolves.toBe("2026-05-10T01:00:00.000Z");
    await expect(stateManager.readRaw("knowledge-transfer//snapshot.json")).resolves.toEqual(snapshot);
    await expect(stateManager.readRaw("meta-patterns//last_aggregated_at.json")).resolves.toEqual({
      ts: "2026-05-10T01:00:00.000Z",
    });
    expect(fs.existsSync(path.join(tmpDir, "knowledge-transfer", "snapshot.json"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "meta-patterns", "last_aggregated_at.json"))).toBe(false);
  });

  it("imports legacy snapshot and watermark only through the repair boundary", async () => {
    const tmpDir = makeTmpDir();
    const snapshot = makeSnapshot();
    fs.mkdirSync(path.join(tmpDir, "knowledge-transfer"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "meta-patterns"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "knowledge-transfer", "snapshot.json"), JSON.stringify(snapshot));
    fs.writeFileSync(path.join(tmpDir, "meta-patterns", "last_aggregated_at.json"), JSON.stringify({
      ts: "2026-05-10T01:00:00.000Z",
    }));

    const report = await importLegacyKnowledgeTransferState(tmpDir);

    expect(report).toMatchObject({
      snapshots: 1,
      metaPatternWatermarks: 1,
      skippedAlreadyImported: 0,
      retiredExistingTypedState: 0,
      blockedSources: [],
    });
    const store = new KnowledgeTransferStateStore(tmpDir);
    await expect(store.loadSnapshot()).resolves.toEqual(snapshot);
    await expect(store.loadLastAggregatedAt()).resolves.toBe("2026-05-10T01:00:00.000Z");

    const controlDb = await openControlDatabase({ baseDir: tmpDir });
    try {
      expect(controlDb.listLegacyImports()).toEqual(expect.arrayContaining([
        expect.objectContaining({
          source_kind: "knowledge_transfer_snapshot",
          source_id: "current",
          migration_name: "knowledge-transfer-runtime-state",
          status: "imported",
        }),
        expect.objectContaining({
          source_kind: "knowledge_transfer_meta_pattern_last_aggregated_at",
          source_id: "current",
          migration_name: "knowledge-transfer-runtime-state",
          status: "imported",
        }),
      ]));
    } finally {
      controlDb.close();
    }
  });

  it("retires stale legacy files when typed state already exists", async () => {
    const tmpDir = makeTmpDir();
    const typedSnapshot = makeSnapshot();
    const staleSnapshot = buildKnowledgeTransferSnapshot({
      ...typedSnapshot,
      transfers: [],
      results: [],
      effectivenessRecords: [],
      applyContexts: {},
      patternTrackers: {},
      crossGoalPatterns: [],
    });
    const store = new KnowledgeTransferStateStore(tmpDir);
    await store.saveSnapshot(typedSnapshot);
    await store.saveLastAggregatedAt("2026-05-10T01:00:00.000Z");
    fs.mkdirSync(path.join(tmpDir, "knowledge-transfer"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "meta-patterns"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "knowledge-transfer", "snapshot.json"), JSON.stringify(staleSnapshot));
    fs.writeFileSync(path.join(tmpDir, "meta-patterns", "last_aggregated_at.json"), JSON.stringify({
      ts: "2026-05-09T01:00:00.000Z",
    }));

    const report = await importLegacyKnowledgeTransferState(tmpDir);

    expect(report).toMatchObject({
      snapshots: 0,
      metaPatternWatermarks: 0,
      retiredExistingTypedState: 2,
    });
    await expect(store.loadSnapshot()).resolves.toEqual(typedSnapshot);
    await expect(store.loadLastAggregatedAt()).resolves.toBe("2026-05-10T01:00:00.000Z");
  });
});
