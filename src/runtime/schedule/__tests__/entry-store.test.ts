import { afterEach, describe, expect, it, vi } from "vitest";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { makeTempDir, cleanupTempDir } from "../../../../tests/helpers/temp-dir.js";
import { ScheduleEntryStore } from "../entry-store.js";

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

describe("ScheduleEntryStore", () => {
  let tmpDir: string;

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpDir) cleanupTempDir(tmpDir);
  });

  it("reclaims an aged schedule file lock when owner pid is not a safe process id", async () => {
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

    let ownerDuringPersist: unknown;
    const store = new ScheduleEntryStore(tmpDir, { warn: vi.fn() }, async () => {
      const ownerRaw = await fsp.readFile(path.join(lockDir, "owner.json"), "utf-8");
      ownerDuringPersist = JSON.parse(ownerRaw);
    });

    await expect(store.saveEntries([])).resolves.toBeUndefined();

    expect(killSpy).not.toHaveBeenCalled();
    expect(ownerDuringPersist).toMatchObject({ pid: process.pid });
    await expect(fsp.access(lockDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("skips persisted entries with non-finite or unsafe numeric counters", async () => {
    tmpDir = makeTempDir();
    const logger = { warn: vi.fn() };
    const store = new ScheduleEntryStore(tmpDir, logger);
    const persistedSchedules = JSON.stringify([
      makePersistedHeartbeatEntry(),
      makePersistedHeartbeatEntry({
        id: "22222222-2222-4222-8222-222222222222",
        name: "unsafe-execution-counter",
        total_executions: Number.MAX_SAFE_INTEGER + 1,
      }),
      makePersistedHeartbeatEntry({
        id: "33333333-3333-4333-8333-333333333333",
        name: "non-finite-token-budget",
        max_tokens_per_day: "__NON_FINITE_NUMBER__",
      }),
    ], null, 2).replace("\"__NON_FINITE_NUMBER__\"", "1e309");
    await fsp.writeFile(path.join(tmpDir, "schedules.json"), persistedSchedules, "utf-8");

    const entries = await store.readEntries();

    expect(entries.map((entry) => entry.name)).toEqual(["valid-numeric-schedule"]);
    expect(logger.warn).toHaveBeenCalledWith(
      "Skipped invalid schedule entries while loading schedules.json",
      { invalid_count: 2 }
    );
  });

  it("keeps legacy invalid heartbeat configs visible as disabled compatibility entries", async () => {
    tmpDir = makeTempDir();
    const logger = { warn: vi.fn() };
    const store = new ScheduleEntryStore(tmpDir, logger);
    await fsp.writeFile(
      path.join(tmpDir, "schedules.json"),
      JSON.stringify([
        makePersistedHeartbeatEntry({
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
        }),
      ], null, 2),
      "utf-8"
    );

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
