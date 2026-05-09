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

  it("appends outbox entries into the control database", async () => {
    await store.ensureReady();
    const first = await store.append({
      event_type: "goal_activated",
      goal_id: "goal-1",
      correlation_id: "corr-1",
      created_at: 1,
      payload: { kind: "first" },
    });

    expect(first.seq).toBe(1);
    expect(fs.existsSync(path.join(tmpDir, "state", "pulseed-control.sqlite"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "outbox", "000000000001.json"))).toBe(false);
    expect(await store.load(1)).toMatchObject({ event_type: "goal_activated" });
  });

  it("rejects unsafe outbox sequence and timestamp values", async () => {
    const unsafeInteger = Number.MAX_SAFE_INTEGER + 1;

    await expect(store.save({
      seq: unsafeInteger,
      event_type: "unsafe_seq",
      created_at: 1,
      payload: {},
    })).rejects.toThrow();

    await expect(store.append({
      event_type: "unsafe_created_at",
      created_at: unsafeInteger,
      payload: {},
    })).rejects.toThrow();

    await expect(store.list()).resolves.toEqual([]);
  });

  it("does not read legacy outbox JSON on the normal store path", async () => {
    fs.mkdirSync(path.join(tmpDir, "outbox"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "outbox", "000000000001.json"),
      JSON.stringify(makeRecord(1, "legacy"), null, 2),
      "utf-8",
    );

    await expect(store.load(1)).resolves.toBeNull();
    await expect(store.list()).resolves.toEqual([]);
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
