import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { OutboxStore } from "../store/outbox-store.js";
import { makeTempDir, cleanupTempDir } from "../../../tests/helpers/temp-dir.js";
import { OutboxRecordSchema } from "../store/runtime-schemas.js";
import {
  PersonalAgentRuntimeStore,
  type PersonalAgentDecisionTrace,
} from "../personal-agent/index.js";
import {
  CONTROL_DB_MIGRATIONS,
  openControlDatabase,
} from "../store/control-db/index.js";

describe("OutboxStore", () => {
  let tmpDir: string;
  let store: OutboxStore;

  beforeEach(() => {
    tmpDir = makeTempDir();
    store = new OutboxStore(tmpDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  it("records notification admission before appending outbox entries", async () => {
    const order: string[] = [];
    const captured: PersonalAgentDecisionTrace[] = [];
    const originalRecordTrace = PersonalAgentRuntimeStore.prototype.recordTrace;
    vi.spyOn(PersonalAgentRuntimeStore.prototype, "recordTrace")
      .mockImplementation(async function (this: PersonalAgentRuntimeStore, trace) {
        order.push("trace");
        captured.push(trace);
        expect(await store.list()).toEqual([]);
        return originalRecordTrace.call(this, trace);
      });

    const first = await store.append({
      event_type: "goal_activated",
      goal_id: "goal-1",
      correlation_id: "corr-1",
      created_at: 1,
      payload: { kind: "first" },
    });
    order.push("append");

    expect(first.seq).toBe(1);
    expect(order).toEqual(["trace", "append"]);
    const trace = captured[0];
    expect(trace).toBeDefined();
    expect(trace?.situation_frame.caller_path).toBe("notification_interruption");
    expect(trace?.task_candidates[0]).toMatchObject({
      target_kind: "notification",
      desired_effect: "send_notification",
      task_created: false,
    });
    expect(trace?.intervention_decisions[0]).toMatchObject({
      decision: "allow",
      target_effect: "send_notification",
      policy_ref: { kind: "intervention_policy", ref: "policy:notification-interruption-v1" },
    });
  });

  it("does not append outbox entries when notification admission fails", async () => {
    vi.spyOn(PersonalAgentRuntimeStore.prototype, "recordTrace")
      .mockRejectedValueOnce(new Error("trace unavailable"));

    await expect(store.append({
      event_type: "goal_activated",
      goal_id: "goal-1",
      correlation_id: "corr-1",
      created_at: 1,
      payload: { kind: "first" },
    })).rejects.toThrow("trace unavailable");

    await expect(store.list()).resolves.toEqual([]);
  });

  it("restricts direct save to explicit migration/import/debug seeding boundaries", async () => {
    await expect(store.save(makeRecord(1, "direct"))).rejects.toThrow("restricted");

    await expect(store.save(makeRecord(1, "debug"), { boundary: "test_seed" }))
      .resolves.toMatchObject({ seq: 1, event_type: "debug" });
  });

  it("rejects unsafe outbox sequence and timestamp values", async () => {
    const unsafeInteger = Number.MAX_SAFE_INTEGER + 1;

    await expect(store.save({
      seq: unsafeInteger,
      event_type: "unsafe_seq",
      created_at: 1,
      payload: {},
    }, { boundary: "test_seed" })).rejects.toThrow();

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
    await store.save(makeRecord(2, "second"), { boundary: "test_seed" });
    await store.save(makeRecord(1, "first"), { boundary: "test_seed" });

    const all = await store.list();
    expect(all.map((record) => record.seq)).toEqual([1, 2]);
    expect((await store.loadLatest())?.seq).toBe(2);
    expect((await store.list(1)).map((record) => record.seq)).toEqual([2]);
  });

  it("returns the next sequence after the highest existing entry", async () => {
    await store.save(makeRecord(4, "fourth"), { boundary: "test_seed" });
    expect(await store.nextSeq()).toBe(5);
  });

  it("returns the existing outbox record when append replays the same notification input", async () => {
    const input = {
      event_type: "goal_activated",
      goal_id: "goal-1",
      correlation_id: "corr-1",
      created_at: 1,
      payload: { kind: "first", nested: { b: 2, a: 1 } },
    };

    const first = await store.append(input);
    const replay = await store.append({
      ...input,
      created_at: 2,
      payload: { nested: { a: 1, b: 2 }, kind: "first" },
    });

    expect(replay.seq).toBe(first.seq);
    expect(await store.list()).toHaveLength(1);
  });

  it("appends repeated payload-equal events when no explicit correlation id is present", async () => {
    const input = {
      event_type: "schedule_run_requested",
      created_at: 1,
      payload: { scheduleId: "schedule-1", allowEscalation: false },
    };

    const first = await store.append(input);
    const second = await store.append({
      ...input,
      created_at: 2,
    });

    expect(second.seq).toBe(first.seq + 1);
    expect(await store.list()).toHaveLength(2);
  });

  it("records distinct admissions for repeated payload-equal events without correlation ids", async () => {
    const captured: PersonalAgentDecisionTrace[] = [];
    const originalRecordTrace = PersonalAgentRuntimeStore.prototype.recordTrace;
    vi.spyOn(PersonalAgentRuntimeStore.prototype, "recordTrace")
      .mockImplementation(async function (this: PersonalAgentRuntimeStore, trace) {
        captured.push(trace);
        return originalRecordTrace.call(this, trace);
      });

    const input = {
      event_type: "schedule_run_requested",
      created_at: 1,
      payload: { scheduleId: "schedule-1", allowEscalation: false },
    };

    const first = await store.append(input);
    const second = await store.append(input);

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(captured).toHaveLength(2);
    expect(new Set(captured.map((trace) => trace.trace_id)).size).toBe(2);
  });

  it("deduplicates replayed notifications against pre-v33 outbox rows without dedupe keys", async () => {
    const legacyRecord = OutboxRecordSchema.parse({
      seq: 1,
      event_type: "goal_activated",
      goal_id: "goal-legacy",
      correlation_id: "corr-legacy",
      created_at: 1,
      payload: { kind: "legacy", nested: { b: 2, a: 1 } },
    });
    const legacyDb = await openControlDatabase({
      baseDir: tmpDir,
      migrations: CONTROL_DB_MIGRATIONS.filter((migration) => migration.version < 33),
    });
    try {
      legacyDb.transaction((sqlite) => {
        sqlite.prepare(`
          INSERT INTO outbox_records (seq, created_at, kind, record_json)
          VALUES (?, ?, ?, json(?))
        `).run(
          legacyRecord.seq,
          legacyRecord.created_at,
          legacyRecord.event_type,
          JSON.stringify(legacyRecord),
        );
      });
    } finally {
      legacyDb.close();
    }

    const replay = await new OutboxStore(tmpDir).append({
      event_type: legacyRecord.event_type,
      goal_id: legacyRecord.goal_id,
      correlation_id: legacyRecord.correlation_id,
      created_at: 2,
      payload: { nested: { a: 1, b: 2 }, kind: "legacy" },
    });

    expect(replay.seq).toBe(legacyRecord.seq);
    expect(await new OutboxStore(tmpDir).list()).toHaveLength(1);
    const upgradedDb = await openControlDatabase({ baseDir: tmpDir });
    try {
      const row = upgradedDb.read((sqlite) =>
        sqlite.prepare("SELECT dedupe_key FROM outbox_records WHERE seq = 1").get() as { dedupe_key: string | null }
      );
      expect(row.dedupe_key).toEqual(expect.stringContaining("goal_activated:goal-legacy:corr-legacy:"));
    } finally {
      upgradedDb.close();
    }
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
