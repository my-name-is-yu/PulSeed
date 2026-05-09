import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { StateManager } from "../state-manager.js";
import { readWAL } from "../state-wal.js";
import { appendWALRecord } from "../state-wal.js";
import { listSnapshots } from "../state-snapshot.js";
import { makeTempDir, cleanupTempDir } from "../../../../tests/helpers/temp-dir.js";
import { makeGoal } from "../../../../tests/helpers/fixtures.js";
import type { ObservationLogEntry } from "../../types/state.js";

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
});
