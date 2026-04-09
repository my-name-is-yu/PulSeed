import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { OutboxStore } from "../store/outbox-store.js";
import { makeTempDir, cleanupTempDir } from "../../../tests/helpers/temp-dir.js";
import { OutboxRecordSchema } from "../store/runtime-schemas.js";

describe("OutboxStore", () => {
  let tmpDir: string;
  let store: OutboxStore;

  beforeEach(() => {
    tmpDir = makeTempDir();
    store = new OutboxStore(tmpDir);
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  function makeRecord(seq: number, eventType = "event") {
    return OutboxRecordSchema.parse({
      seq,
      event_type: eventType,
      goal_id: "goal-1",
      correlation_id: "corr-1",
      created_at: seq,
      payload: { seq },
    });
  }

  it("appends outbox entries with padded sequence numbers", async () => {
    await store.ensureReady();
    const first = await store.append({
      event_type: "goal_activated",
      goal_id: "goal-1",
      correlation_id: "corr-1",
      created_at: 1,
      payload: { kind: "first" },
    });

    expect(first.seq).toBe(1);
    expect(fs.existsSync(path.join(tmpDir, "outbox", "000000000001.json"))).toBe(true);
    expect(await store.load(1)).toMatchObject({ event_type: "goal_activated" });
  });

  it("loads and filters records in sequence order", async () => {
    await store.save(makeRecord(2, "second"));
    await store.save(makeRecord(1, "first"));

    const all = await store.list();
    expect(all.map((record) => record.seq)).toEqual([1, 2]);
    expect((await store.loadLatest())?.seq).toBe(2);
    expect((await store.list(1)).map((record) => record.seq)).toEqual([2]);
  });

  it("returns the next sequence after the highest existing entry", async () => {
    await store.save(makeRecord(4, "fourth"));
    expect(await store.nextSeq()).toBe(5);
  });

  it("two store instances append distinct seq values without overwriting", async () => {
    const storeA = new OutboxStore(tmpDir);
    const storeB = new OutboxStore(tmpDir);
    await Promise.all([
      storeA.append({
        event_type: "alpha",
        goal_id: "goal-1",
        correlation_id: "corr-a",
        created_at: 1,
        payload: { source: "a" },
      }),
      storeB.append({
        event_type: "beta",
        goal_id: "goal-1",
        correlation_id: "corr-b",
        created_at: 2,
        payload: { source: "b" },
      }),
    ]);

    const listed = await store.list();
    expect(listed).toHaveLength(2);
    expect(listed.map((record) => record.seq)).toEqual([1, 2]);
    expect(new Set(listed.map((record) => record.event_type))).toEqual(new Set(["alpha", "beta"]));
  });
});
