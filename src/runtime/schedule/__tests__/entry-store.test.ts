import { afterEach, describe, expect, it, vi } from "vitest";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { makeTempDir, cleanupTempDir } from "../../../../tests/helpers/temp-dir.js";
import { ScheduleEntryStore } from "../entry-store.js";
import { openControlDatabase } from "../../store/control-db/index.js";

function makePersistedHeartbeatEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "valid-numeric-schedule",
    layer: "heartbeat",
    trigger: { type: "interval", seconds: 60, jitter_factor: 0 },
    enabled: true,
    heartbeat: {
      check_type: "custom",
      check_config: { command: "echo ok" },
      failure_threshold: 3,
      timeout_ms: 5000,
    },
    baseline_results: [],
    created_at: "2026-04-08T00:00:00.000Z",
    updated_at: "2026-04-08T00:00:00.000Z",
    last_fired_at: null,
    next_fire_at: "2026-04-08T00:01:00.000Z",
    consecutive_failures: 0,
    last_escalation_at: null,
    escalation_timestamps: [],
    total_executions: 0,
    total_tokens_used: 0,
    max_tokens_per_day: 100000,
    tokens_used_today: 0,
    budget_reset_at: null,
    ...overrides,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000, intervalMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for schedule store condition");
}

describe("ScheduleEntryStore", () => {
  let tmpDir: string;

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpDir) cleanupTempDir(tmpDir);
  });

  it("does not depend on a legacy schedule file lock", async () => {
    tmpDir = makeTempDir();
    const lockDir = path.join(tmpDir, "schedules.json.lock");
    await fsp.mkdir(lockDir, { recursive: true });
    await fsp.writeFile(path.join(lockDir, "owner.json"), JSON.stringify({ pid: -1 }), "utf-8");
    const staleTime = new Date(Date.now() - 60_000);
    await fsp.utimes(lockDir, staleTime, staleTime);

    const killSpy = vi.spyOn(process, "kill").mockImplementation(((pid: number | NodeJS.Signals, signal?: NodeJS.Signals | number) => {
      if (pid === -1 && signal === 0) {
        return true;
      }
      throw new Error(`unexpected process probe for ${String(pid)}`);
    }) as typeof process.kill);

    const store = new ScheduleEntryStore(tmpDir, { warn: vi.fn() });

    await expect(store.saveEntries([])).resolves.toBeUndefined();

    expect(killSpy).not.toHaveBeenCalled();
    const ownerRaw = await fsp.readFile(path.join(lockDir, "owner.json"), "utf-8");
    expect(JSON.parse(ownerRaw)).toEqual({ pid: -1 });
  });

  it("serializes schedule mutations through the control database lock", async () => {
    tmpDir = makeTempDir();
    const firstStore = new ScheduleEntryStore(tmpDir, { warn: vi.fn() });
    const secondStore = new ScheduleEntryStore(tmpDir, { warn: vi.fn() });
    const order: string[] = [];
    let releaseFirst: () => void = () => {};

    const first = firstStore.withLock(async () => {
      order.push("first-start");
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push("first-end");
    });
    await waitFor(() => order.includes("first-start"));

    const second = secondStore.withLock(async () => {
      order.push("second");
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(order).toEqual(["first-start"]);

    releaseFirst();
    await Promise.all([first, second]);

    expect(order).toEqual(["first-start", "first-end", "second"]);
  });

  it("skips persisted entries with non-finite or unsafe numeric counters", async () => {
    tmpDir = makeTempDir();
    const logger = { warn: vi.fn() };
    const store = new ScheduleEntryStore(tmpDir, logger);
    await insertRawScheduleEntry(tmpDir, makePersistedHeartbeatEntry(), 0);
    await insertRawScheduleEntry(
      tmpDir,
      makePersistedHeartbeatEntry({
        id: "22222222-2222-4222-8222-222222222222",
        name: "unsafe-execution-counter",
        total_executions: Number.MAX_SAFE_INTEGER + 1,
      }),
      1,
    );
    await insertRawScheduleEntry(
      tmpDir,
      makePersistedHeartbeatEntry({
        id: "33333333-3333-4333-8333-333333333333",
        name: "non-finite-token-budget",
        max_tokens_per_day: Number.MAX_SAFE_INTEGER + 1,
      }),
      2,
    );

    const entries = await store.readEntries();

    expect(entries.map((entry) => entry.name)).toEqual(["valid-numeric-schedule"]);
    expect(logger.warn).toHaveBeenCalledWith(
      "Skipped invalid schedule entries while loading schedule_entries",
      { invalid_count: 2 }
    );
  });

  it("keeps legacy invalid heartbeat configs visible as disabled compatibility entries", async () => {
    tmpDir = makeTempDir();
    const logger = { warn: vi.fn() };
    const store = new ScheduleEntryStore(tmpDir, logger);
    await insertRawScheduleEntry(tmpDir, makePersistedHeartbeatEntry({
      name: "legacy-http-heartbeat",
      metadata: {
        note: "created before strict heartbeat check configs",
      },
      heartbeat: {
        check_type: "http",
        check_config: {},
        failure_threshold: 3,
        timeout_ms: 5000,
      },
    }), 0);

    const entries = await store.readEntries();

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      name: "legacy-http-heartbeat",
      enabled: false,
      heartbeat: {
        check_type: "custom",
        check_config: { command: "false" },
      },
      metadata: {
        note: expect.stringContaining("invalid http check_config"),
      },
    });
    expect(entries[0]?.metadata?.note).toContain("created before strict heartbeat check configs");
    expect(logger.warn).not.toHaveBeenCalled();
  });
});

async function insertRawScheduleEntry(baseDir: string, entry: Record<string, unknown>, sortOrder: number): Promise<void> {
  const database = await openControlDatabase({ baseDir });
  try {
    database.transaction((db) => {
      db.prepare(`
        INSERT INTO schedule_entries (
          entry_id,
          name,
          layer,
          enabled,
          next_fire_at,
          updated_at,
          internal,
          activation_kind,
          goal_id,
          wait_strategy_id,
          sort_order,
          entry_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, json(?))
      `).run(
        entry["id"],
        entry["name"],
        entry["layer"],
        entry["enabled"] === false ? 0 : 1,
        entry["next_fire_at"],
        entry["updated_at"],
        (entry["metadata"] as { internal?: unknown } | undefined)?.internal === true ? 1 : 0,
        (entry["metadata"] as { activation_kind?: unknown } | undefined)?.activation_kind ?? null,
        (entry["metadata"] as { goal_id?: unknown } | undefined)?.goal_id ?? null,
        (entry["metadata"] as { wait_strategy_id?: unknown } | undefined)?.wait_strategy_id ?? null,
        sortOrder,
        JSON.stringify(entry),
      );
    });
  } finally {
    database.close();
  }
}
