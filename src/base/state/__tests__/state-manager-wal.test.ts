import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { StateManager } from "../state-manager.js";
import { readWAL } from "../legacy-state-wal.js";
import { appendWALRecord } from "../legacy-state-wal.js";
import { recoverStateManagerLegacyWAL } from "../legacy-state-manager-wal-recovery.js";
import { listSnapshots } from "../state-snapshot.js";
import { makeTempDir, cleanupTempDir } from "../../../../tests/helpers/temp-dir.js";
import { makeGoal } from "../../../../tests/helpers/fixtures.js";
import type { ObservationLogEntry } from "../../types/state.js";
import type { GapHistoryEntry } from "../../types/gap.js";

describe("StateManager DB-backed goal persistence", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = makeTempDir("pulseed-sm-wal-");
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  it("saveGoal with WAL enabled uses the DB store without legacy WAL records", async () => {
    const sm = new StateManager(tmpDir, undefined, { walEnabled: true });
    await sm.init();
    const goal = makeGoal({ id: "g1" });
    await sm.saveGoal(goal);

    const records = await readWAL("g1", tmpDir);
    expect(records.length).toBe(0);
    const loaded = await sm.loadGoal("g1");
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe("g1");
  });

  it("saveGoal with WAL disabled creates no WAL records", async () => {
    const sm = new StateManager(tmpDir, undefined, { walEnabled: false });
    await sm.init();
    const goal = makeGoal({ id: "g2" });
    await sm.saveGoal(goal);

    const records = await readWAL("g2", tmpDir);
    expect(records.length).toBe(0);

    // Data should still be persisted
    const loaded = await sm.loadGoal("g2");
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe("g2");
  });

  it("normal init does not replay legacy uncommitted WAL intent", async () => {
    // Step 1: create goal dir and write an intent without commit
    const goalId = "g-crash";
    const goalDir = path.join(tmpDir, "goals", goalId);
    fs.mkdirSync(goalDir, { recursive: true });

    const goal = makeGoal({ id: goalId });
    await appendWALRecord(goalId, tmpDir, {
      op: "save_goal",
      data: goal,
      ts: new Date().toISOString(),
    });

    // No goal.json exists yet
    expect(fs.existsSync(path.join(goalDir, "goal.json"))).toBe(false);

    // Step 2: init uses the SQLite store; legacy WAL import belongs to an explicit migration boundary.
    const sm = new StateManager(tmpDir, undefined, { walEnabled: true });
    await sm.init();

    const loaded = await sm.loadGoal(goalId);
    expect(loaded).toBeNull();
  });

  it("normal init does not replay combined legacy observation + goal WAL intent", async () => {
    const goalId = "g-observation-apply";
    const goalDir = path.join(tmpDir, "goals", goalId);
    fs.mkdirSync(goalDir, { recursive: true });

    const goal = makeGoal({
      id: goalId,
      dimensions: [
        {
          name: "dim-a",
          label: "Dimension A",
          current_value: 1,
          threshold: { type: "min", value: 1 },
          confidence: 0.9,
          observation_method: {
            type: "mechanical",
            source: "test",
            schedule: null,
            endpoint: null,
            confidence_tier: "mechanical",
          },
          last_updated: new Date().toISOString(),
          history: [],
          weight: 1,
          uncertainty_weight: null,
          state_integrity: "ok",
          dimension_mapping: null,
        },
      ],
    });

    const entry: ObservationLogEntry = {
      observation_id: "obs-apply",
      timestamp: new Date().toISOString(),
      trigger: "periodic",
      goal_id: goalId,
      dimension_name: "dim-a",
      layer: "mechanical",
      method: {
        type: "mechanical",
        source: "test",
        schedule: null,
        endpoint: null,
        confidence_tier: "mechanical",
      },
      raw_result: 2,
      extracted_value: 2,
      confidence: 0.9,
      notes: null,
    };

    await appendWALRecord(goalId, tmpDir, {
      op: "append_observation_and_save_goal",
      data: {
        observationLog: {
          goal_id: goalId,
          entries: [entry],
        },
        goal,
      },
      ts: new Date().toISOString(),
    });

    const sm = new StateManager(tmpDir, undefined, { walEnabled: true });
    await sm.init();

    const loadedGoal = await sm.loadGoal(goalId);
    expect(loadedGoal).toBeNull();

    const loadedLog = await sm.loadObservationLog(goalId);
    expect(loadedLog).toBeNull();
  });

  it("DB-backed saveGoal does not create legacy snapshots every 50 writes", async () => {
    const sm = new StateManager(tmpDir, undefined, { walEnabled: true });
    await sm.init();

    for (let i = 0; i < 50; i++) {
      await sm.saveGoal(makeGoal({ id: "g-snap", description: `v${i}` }));
    }

    const snaps = await listSnapshots("g-snap", tmpDir);
    expect(snaps.length).toBe(0);
  });

  it("DB-backed saveGoal leaves no committed legacy WAL intents after 100 writes", async () => {
    const sm = new StateManager(tmpDir, undefined, { walEnabled: true });
    await sm.init();

    for (let i = 0; i < 100; i++) {
      await sm.saveGoal(makeGoal({ id: "g-compact", description: `v${i}` }));
    }

    // After compaction, committed records should be removed
    const records = await readWAL("g-compact", tmpDir);
    // Compaction leaves only uncommitted intents (none here) + compaction markers
    const intents = records.filter((r) => r.op !== "commit" && r.op !== "compaction_start" && r.op !== "compaction_complete");
    expect(intents.length).toBe(0);
  }, 20_000);

  it("concurrent saveGoal for same goal both succeed", async () => {
    const sm = new StateManager(tmpDir, undefined, { walEnabled: true });
    await sm.init();

    const g1 = makeGoal({ id: "g-concurrent", description: "first" });
    const g2 = makeGoal({ id: "g-concurrent", description: "second" });

    await Promise.all([sm.saveGoal(g1), sm.saveGoal(g2)]);

    const loaded = await sm.loadGoal("g-concurrent");
    expect(loaded).not.toBeNull();
    // One of the two should have won
    expect(["first", "second"]).toContain(loaded!.description);
  });

  it("concurrent saveGoal for different goals both succeed", async () => {
    const sm = new StateManager(tmpDir, undefined, { walEnabled: true });
    await sm.init();

    const gA = makeGoal({ id: "g-a" });
    const gB = makeGoal({ id: "g-b" });

    await Promise.all([sm.saveGoal(gA), sm.saveGoal(gB)]);

    const loadedA = await sm.loadGoal("g-a");
    const loadedB = await sm.loadGoal("g-b");
    expect(loadedA).not.toBeNull();
    expect(loadedB).not.toBeNull();
  });

  it("serializes goal writes across StateManager instances through the control DB lock", async () => {
    const goalId = "g-cross-manager-lock";
    const sm1 = new StateManager(tmpDir, undefined, { walEnabled: true });
    const sm2 = new StateManager(tmpDir, undefined, { walEnabled: true });
    await sm1.init();
    await sm2.init();
    await sm1.saveGoal(makeGoal({ id: goalId, description: "base" }));

    let releaseFirst: () => void = () => {
      throw new Error("releaseFirst was not initialized");
    };
    const firstEntered = new Promise<void>((resolve) => {
      sm1.setWriteFence(goalId, async ({ op }) => {
        if (op !== "append_observation_and_save_goal") return;
        resolve();
        await new Promise<void>((release) => {
          releaseFirst = release;
        });
      });
    });

    const entry: ObservationLogEntry = {
      observation_id: "obs-cross-manager-lock",
      timestamp: new Date().toISOString(),
      trigger: "periodic",
      goal_id: goalId,
      dimension_name: "progress",
      layer: "mechanical",
      method: {
        type: "mechanical",
        source: "test",
        schedule: null,
        endpoint: null,
        confidence_tier: "mechanical",
      },
      raw_result: 1,
      extracted_value: 1,
      confidence: 0.9,
      notes: null,
    };

    const first = sm1.appendObservationAndSaveGoal(goalId, entry, (goal) => ({
      ...goal,
      description: "first",
      updated_at: new Date().toISOString(),
    }));
    await firstEntered;

    let secondResolved = false;
    const second = sm2.saveGoal(makeGoal({ id: goalId, description: "second" }))
      .then(() => {
        secondResolved = true;
      });

    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(secondResolved).toBe(false);

    releaseFirst();
    await Promise.all([first, second]);

    expect(secondResolved).toBe(true);
    await expect(sm1.loadObservationLog(goalId)).resolves.toMatchObject({
      entries: [expect.objectContaining({ observation_id: "obs-cross-manager-lock" })],
    });
  });

  it("serializes goal deletion across StateManager instances through the control DB lock", async () => {
    const goalId = "g-cross-manager-delete-lock";
    const sm1 = new StateManager(tmpDir, undefined, { walEnabled: true });
    const sm2 = new StateManager(tmpDir, undefined, { walEnabled: true });
    await sm1.init();
    await sm2.init();
    await sm1.saveGoal(makeGoal({ id: goalId, description: "base" }));

    let releaseFirst: () => void = () => {
      throw new Error("releaseFirst was not initialized");
    };
    const firstEntered = new Promise<void>((resolve) => {
      sm1.setWriteFence(goalId, async ({ op }) => {
        if (op !== "append_observation_and_save_goal") return;
        resolve();
        await new Promise<void>((release) => {
          releaseFirst = release;
        });
      });
    });

    const entry: ObservationLogEntry = {
      observation_id: "obs-cross-manager-delete-lock",
      timestamp: new Date().toISOString(),
      trigger: "periodic",
      goal_id: goalId,
      dimension_name: "progress",
      layer: "mechanical",
      method: {
        type: "mechanical",
        source: "test",
        schedule: null,
        endpoint: null,
        confidence_tier: "mechanical",
      },
      raw_result: 1,
      extracted_value: 1,
      confidence: 0.9,
      notes: null,
    };

    const first = sm1.appendObservationAndSaveGoal(goalId, entry, (goal) => ({
      ...goal,
      description: "first",
      updated_at: new Date().toISOString(),
    }));
    await firstEntered;

    let deleteResolved = false;
    const deletion = sm2.deleteGoal(goalId).then((result) => {
      deleteResolved = true;
      return result;
    });

    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(deleteResolved).toBe(false);

    releaseFirst();
    await first;
    await expect(deletion).resolves.toBe(true);

    expect(deleteResolved).toBe(true);
    await expect(sm1.loadGoal(goalId)).resolves.toBeNull();
    await expect(sm1.loadObservationLog(goalId)).resolves.toBeNull();
  });

  it("backward compatible constructor without options", async () => {
    const sm = new StateManager(tmpDir);
    await sm.init();
    const goal = makeGoal({ id: "g-compat" });
    await sm.saveGoal(goal);

    const loaded = await sm.loadGoal("g-compat");
    expect(loaded).not.toBeNull();
  });

  it("legacy WAL files remain untouched across repeated init", async () => {
    // Step 1: create goal dir and write an intent without commit
    const goalId = "g-idempotent";
    const goalDir = path.join(tmpDir, "goals", goalId);
    fs.mkdirSync(goalDir, { recursive: true });

    const goal = makeGoal({ id: goalId, description: "original" });
    await appendWALRecord(goalId, tmpDir, {
      op: "save_goal",
      data: goal,
      ts: "2026-01-01T00:00:00.000Z",
    });

    const sm1 = new StateManager(tmpDir, undefined, { walEnabled: true });
    await sm1.init();

    const loaded1 = await sm1.loadGoal(goalId);
    expect(loaded1).toBeNull();

    const recordsAfterFirst = await readWAL(goalId, tmpDir);
    const commits = recordsAfterFirst.filter((r) => r.op === "commit");
    expect(commits.length).toBe(0);

    const sm2 = new StateManager(tmpDir, undefined, { walEnabled: true });
    await sm2.init();

    const loaded2 = await sm2.loadGoal(goalId);
    expect(loaded2).toBeNull();

    const recordsAfterSecond = await readWAL(goalId, tmpDir);
    const commitsAfterSecond = recordsAfterSecond.filter((r) => r.op === "commit");
    expect(commitsAfterSecond.length).toBe(commits.length);
  });

  it("explicit legacy WAL recovery imports old goal state into the typed DB store", async () => {
    const goalId = "g-legacy-repair";
    const goalDir = path.join(tmpDir, "goals", goalId);
    fs.mkdirSync(goalDir, { recursive: true });

    const goal = makeGoal({
      id: goalId,
      description: "legacy WAL goal",
      dimensions: [
        {
          name: "dim-a",
          label: "Dimension A",
          current_value: 1,
          threshold: { type: "min", value: 1 },
          confidence: 0.9,
          observation_method: {
            type: "mechanical",
            source: "test",
            schedule: null,
            endpoint: null,
            confidence_tier: "mechanical",
          },
          last_updated: "2026-01-01T00:00:00.000Z",
          history: [],
          weight: 1,
          uncertainty_weight: null,
          state_integrity: "ok",
          dimension_mapping: null,
        },
      ],
    });
    const entry: ObservationLogEntry = {
      observation_id: "obs-repair",
      timestamp: "2026-01-01T00:00:01.000Z",
      trigger: "periodic",
      goal_id: goalId,
      dimension_name: "dim-a",
      layer: "mechanical",
      method: {
        type: "mechanical",
        source: "test",
        schedule: null,
        endpoint: null,
        confidence_tier: "mechanical",
      },
      raw_result: 2,
      extracted_value: 2,
      confidence: 0.9,
      notes: null,
    };
    const gapEntry: GapHistoryEntry = {
      iteration: 1,
      timestamp: "2026-01-01T00:00:02.000Z",
      gap_vector: [{ dimension_name: "dim-a", normalized_weighted_gap: 0.1 }],
      confidence_vector: [{ dimension_name: "dim-a", confidence: 0.9 }],
    };

    await appendWALRecord(goalId, tmpDir, {
      op: "append_observation_and_save_goal",
      data: {
        observationLog: { goal_id: goalId, entries: [entry] },
        goal,
      },
      ts: "2026-01-01T00:00:03.000Z",
    });
    await appendWALRecord(goalId, tmpDir, {
      op: "save_gap_history",
      data: { goalId, entries: [gapEntry] },
      ts: "2026-01-01T00:00:04.000Z",
    });

    await recoverStateManagerLegacyWAL({
      baseDir: tmpDir,
      listGoalIds: async () => [goalId],
    });

    const sm = new StateManager(tmpDir);
    await sm.init();
    const loadedGoal = await sm.loadGoal(goalId);
    const loadedLog = await sm.loadObservationLog(goalId);
    const loadedGaps = await sm.loadGapHistory(goalId);

    expect(loadedGoal?.description).toBe("legacy WAL goal");
    expect(loadedLog?.entries.map((loaded) => loaded.observation_id)).toEqual(["obs-repair"]);
    expect(loadedGaps.map((loaded) => loaded.iteration)).toEqual([1]);
    expect(fs.existsSync(path.join(goalDir, "goal.json"))).toBe(false);
    expect(fs.existsSync(path.join(goalDir, "observations.json"))).toBe(false);
    expect(fs.existsSync(path.join(goalDir, "gap-history.json"))).toBe(false);

    const recordsAfterRepair = await readWAL(goalId, tmpDir);
    expect(recordsAfterRepair.filter((record) => record.op === "commit")).toHaveLength(2);

    await recoverStateManagerLegacyWAL({
      baseDir: tmpDir,
      listGoalIds: async () => [goalId],
    });

    const logAfterSecondRepair = await sm.loadObservationLog(goalId);
    expect(logAfterSecondRepair?.entries.map((loaded) => loaded.observation_id)).toEqual(["obs-repair"]);
  });
});
