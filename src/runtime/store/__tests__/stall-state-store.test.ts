import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { CONTROL_DB_MIGRATIONS, openControlDatabase } from "../control-db/index.js";
import { importLegacyStallState } from "../stall-state-migration.js";
import { StallStateStore } from "../stall-state-store.js";
import type { StallState } from "../../../base/types/stall.js";

describe("StallStateStore", () => {
  let tmpDir: string;
  let store: StallStateStore;

  beforeEach(() => {
    tmpDir = makeTempDir();
    store = new StallStateStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("persists stall state in the control DB without creating the legacy stall file", async () => {
    const state = makeStallState("goal-store", {
      dimension_escalation: { "dim-a": 2 },
      global_escalation: 1,
      decay_factors: { "dim-a": 0.6 },
      recovery_loops: { "dim-a": 3 },
    });

    await store.saveStallState(state.goal_id, state);

    await expect(new StallStateStore(tmpDir).loadStallState(state.goal_id)).resolves.toMatchObject({
      goal_id: "goal-store",
      dimension_escalation: { "dim-a": 2 },
      global_escalation: 1,
      decay_factors: { "dim-a": 0.6 },
      recovery_loops: { "dim-a": 3 },
    });
    expect(fs.existsSync(path.join(tmpDir, "stalls", "goal-store.json"))).toBe(false);
  });

  it("rejects stall state stored under a mismatched goal id", async () => {
    await expect(
      store.saveStallState("goal-key", makeStallState("goal-payload")),
    ).rejects.toThrow(/does not match storage key/);
  });

  it("imports legacy stall files only through the explicit repair boundary", async () => {
    const legacyState = makeStallState("goal-import", {
      dimension_escalation: { "dim-a": 3 },
      global_escalation: 2,
    });
    fs.mkdirSync(path.join(tmpDir, "stalls"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "stalls", "goal-import.json"), JSON.stringify(legacyState));

    await expect(store.loadStallState("goal-import")).resolves.toBeNull();

    const report = await importLegacyStallState(tmpDir);

    expect(report).toMatchObject({
      stallStates: 1,
      skippedAlreadyImported: 0,
      retiredExistingTypedState: 0,
      blockedSources: [],
    });
    await expect(new StallStateStore(tmpDir).loadStallState("goal-import")).resolves.toMatchObject({
      goal_id: "goal-import",
      dimension_escalation: { "dim-a": 3 },
      global_escalation: 2,
    });

    const controlDb = await openControlDatabase({ baseDir: tmpDir });
    try {
      expect(controlDb.listLegacyImports()).toEqual(expect.arrayContaining([
        expect.objectContaining({
          source_kind: "stall_state",
          source_id: "goal-import",
          migration_name: "stall-runtime-state",
          migration_version: 18,
          status: "imported",
        }),
      ]));
    } finally {
      controlDb.close();
    }
  });

  it("migrates existing untyped control DB stall records into the typed stall table", async () => {
    const legacyMigrations = CONTROL_DB_MIGRATIONS.filter((migration) => migration.version < 18);
    const legacyDb = await openControlDatabase({ baseDir: tmpDir, migrations: legacyMigrations });
    try {
      legacyDb.transaction((sqlite) => {
        sqlite.prepare(`
          INSERT INTO goal_stall_records (goal_id, updated_at, record_json)
          VALUES (?, ?, json(?))
        `).run(
          "goal-v17",
          "2026-05-10T00:00:00.000Z",
          JSON.stringify(makeStallState("goal-v17", {
            dimension_escalation: { "dim-a": 2 },
            decay_factors: { "dim-a": 0.7 },
          })),
        );
      });
    } finally {
      legacyDb.close();
    }

    await expect(new StallStateStore(tmpDir).loadStallState("goal-v17")).resolves.toMatchObject({
      goal_id: "goal-v17",
      dimension_escalation: { "dim-a": 2 },
      decay_factors: { "dim-a": 0.7 },
    });
  });

  it("does not let repeated repair import overwrite newer typed stall state", async () => {
    fs.mkdirSync(path.join(tmpDir, "stalls"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "stalls", "goal-idempotent.json"), JSON.stringify(
      makeStallState("goal-idempotent", {
        dimension_escalation: { "dim-a": 1 },
      }),
    ));

    await importLegacyStallState(tmpDir);
    await store.saveStallState("goal-idempotent", makeStallState("goal-idempotent", {
      dimension_escalation: { "dim-a": 3 },
      recovery_loops: { "dim-a": 5 },
    }));

    const secondReport = await importLegacyStallState(tmpDir);

    expect(secondReport).toMatchObject({
      stallStates: 0,
      skippedAlreadyImported: 1,
      retiredExistingTypedState: 0,
      blockedSources: [],
    });
    await expect(new StallStateStore(tmpDir).loadStallState("goal-idempotent")).resolves.toMatchObject({
      dimension_escalation: { "dim-a": 3 },
      recovery_loops: { "dim-a": 5 },
    });
  });

  it("retires stale legacy stall files when typed state already exists before first repair", async () => {
    fs.mkdirSync(path.join(tmpDir, "stalls"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "stalls", "goal-existing.json"), JSON.stringify(
      makeStallState("goal-existing", {
        dimension_escalation: { "dim-a": 1 },
      }),
    ));
    await store.saveStallState("goal-existing", makeStallState("goal-existing", {
      dimension_escalation: { "dim-a": 2 },
    }));

    const report = await importLegacyStallState(tmpDir);

    expect(report).toMatchObject({
      stallStates: 0,
      skippedAlreadyImported: 0,
      retiredExistingTypedState: 1,
      blockedSources: [],
    });
    await expect(new StallStateStore(tmpDir).loadStallState("goal-existing")).resolves.toMatchObject({
      dimension_escalation: { "dim-a": 2 },
    });

    const controlDb = await openControlDatabase({ baseDir: tmpDir });
    try {
      expect(controlDb.listLegacyImports()).toEqual(expect.arrayContaining([
        expect.objectContaining({
          source_kind: "stall_state",
          source_id: "goal-existing",
          migration_name: "stall-runtime-state",
          status: "retired",
          details: expect.objectContaining({ reason: "typed stall state already exists" }),
        }),
      ]));
    } finally {
      controlDb.close();
    }
  });

  it("blocks invalid legacy stall files without normal runtime fallback", async () => {
    fs.mkdirSync(path.join(tmpDir, "stalls"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "stalls", "goal-bad.json"), JSON.stringify({
      goal_id: "other-goal",
      dimension_escalation: { "dim-a": 1 },
    }));

    const report = await importLegacyStallState(tmpDir);

    expect(report.stallStates).toBe(0);
    expect(report.blockedSources).toEqual([
      expect.objectContaining({
        sourceKind: "stall_state",
        sourcePath: path.join("stalls", "goal-bad.json"),
      }),
    ]);
    await expect(new StallStateStore(tmpDir).loadStallState("goal-bad")).resolves.toBeNull();
  });
});

function makeStallState(goalId: string, overrides: Partial<StallState> = {}): StallState {
  return {
    goal_id: goalId,
    dimension_escalation: {},
    global_escalation: 0,
    decay_factors: {},
    recovery_loops: {},
    ...overrides,
  };
}
