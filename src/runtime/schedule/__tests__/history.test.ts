import * as fs from "node:fs/promises";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { ScheduleHistoryStore } from "../history.js";

describe("ScheduleHistoryStore", () => {
  let tempDir: string;
  let store: ScheduleHistoryStore;

  beforeEach(() => {
    tempDir = makeTempDir("schedule-history-");
    store = new ScheduleHistoryStore(tempDir);
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it("rejects unsafe attempt counts before persistence", async () => {
    await expect(store.append({
      entry_id: "33333333-3333-4333-8333-333333333333",
      entry_name: "Unsafe retry",
      layer: "cron",
      result: {
        entry_id: "33333333-3333-4333-8333-333333333333",
        status: "ok",
        duration_ms: 10,
        fired_at: "2026-05-09T00:00:00.000Z",
        tokens_used: 0,
        escalated_to: null,
      },
      reason: "retry",
      attempt: Number.MAX_SAFE_INTEGER + 1,
      started_at: "2026-05-09T00:00:00.000Z",
      finished_at: "2026-05-09T00:00:01.000Z",
    })).rejects.toThrow();

    await expect(fs.stat(path.join(tempDir, "schedule-history.json"))).rejects.toThrow();
  });

  it("skips persisted history records with unsafe attempt counts", async () => {
    await fs.writeFile(path.join(tempDir, "schedule-history.json"), JSON.stringify([
      historyRecord({
        id: "11111111-1111-4111-8111-111111111111",
        attempt: Number.MAX_SAFE_INTEGER + 1,
      }),
      historyRecord({
        id: "22222222-2222-4222-8222-222222222222",
        attempt: 2,
      }),
    ]), "utf8");

    const records = await store.load();

    expect(records).toHaveLength(1);
    expect(records[0]?.id).toBe("22222222-2222-4222-8222-222222222222");
    expect(records[0]?.attempt).toBe(2);
  });
});

function historyRecord(overrides: { id: string; attempt: number }) {
  return {
    id: overrides.id,
    entry_id: "33333333-3333-4333-8333-333333333333",
    entry_name: "Retry schedule",
    layer: "cron",
    reason: "retry",
    attempt: overrides.attempt,
    scheduled_for: "2026-05-09T00:00:00.000Z",
    started_at: "2026-05-09T00:00:00.000Z",
    finished_at: "2026-05-09T00:00:01.000Z",
    retry_at: null,
    status: "ok",
    duration_ms: 10,
    fired_at: "2026-05-09T00:00:00.000Z",
    tokens_used: 0,
    escalated_to: null,
  };
}
