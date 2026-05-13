import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempDir, cleanupTempDir } from "../../../../tests/helpers/temp-dir.js";
import { createEnvelope } from "../../types/envelope.js";
import { JournalBackedQueue } from "../../queue/journal-backed-queue.js";
import { ScheduleEntryStore } from "../../schedule/entry-store.js";
import { ScheduleHistoryStore } from "../../schedule/history.js";
import {
  DaemonShutdownStore,
  DaemonStateStore,
  openControlDatabase,
  SupervisorStateStore,
} from "../index.js";
import { importLegacyQueueDaemonScheduleState } from "../queue-daemon-schedule-state-migration.js";

function writeJson(baseDir: string, relativePath: string, value: unknown): void {
  const target = path.join(baseDir, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(value, null, 2), "utf-8");
}

function makeHeartbeatSchedule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "daily-health",
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
    created_at: "2026-05-09T00:00:00.000Z",
    updated_at: "2026-05-09T00:00:00.000Z",
    last_fired_at: null,
    next_fire_at: "2026-05-09T00:01:00.000Z",
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

describe("importLegacyQueueDaemonScheduleState", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) cleanupTempDir(tmpDir);
  });

  it("imports legacy queue, daemon, supervisor, schedule, and history files into control DB stores", async () => {
    tmpDir = makeTempDir("pulseed-legacy-queue-daemon-schedule-import-");
    const runtimeRoot = path.join(tmpDir, "runtime");
    const envelope = createEnvelope({
      type: "event",
      name: "goal-run",
      source: "test",
      payload: { goalId: "goal-1" },
      priority: "high",
    });
    const now = "2026-05-09T00:00:00.000Z";

    writeJson(tmpDir, "runtime/queue.json", {
      version: 1,
      records: {
        [envelope.id]: {
          envelope,
          status: "pending",
          attempt: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      },
      pending: {
        critical: [],
        high: [envelope.id],
        normal: [],
        low: [],
      },
      inflight: {},
    });
    writeJson(tmpDir, "daemon-state.json", {
      pid: process.pid,
      started_at: now,
      last_loop_at: null,
      loop_count: 2,
      active_goals: ["goal-1"],
      status: "running",
      runtime_root: runtimeRoot,
      crash_count: 0,
      last_error: null,
      last_resident_at: null,
      resident_activity: null,
    });
    writeJson(tmpDir, "shutdown-state.json", {
      goal_ids: ["goal-1"],
      loop_index: 3,
      timestamp: now,
      reason: "stop",
      state: "running",
    });
    writeJson(tmpDir, "runtime/supervisor-state.json", {
      workers: [
        {
          workerId: "worker-1",
          goalId: "goal-1",
          startedAt: 1,
          iterations: 2,
        },
      ],
      crashCounts: { "goal-1": 1 },
      suspendedGoals: [],
      updatedAt: 1,
    });
    writeJson(tmpDir, "schedules.json", [
      makeHeartbeatSchedule(),
    ]);
    writeJson(tmpDir, "schedule-history.json", [
      {
        id: "22222222-2222-4222-8222-222222222222",
        entry_id: "11111111-1111-4111-8111-111111111111",
        entry_name: "daily-health",
        layer: "heartbeat",
        status: "ok",
        duration_ms: 10,
        fired_at: now,
        reason: "cadence",
        attempt: 0,
        scheduled_for: null,
        started_at: now,
        finished_at: now,
        retry_at: null,
        tokens_used: 5,
        escalated_to: null,
        activation_kind: null,
        strategy_id: null,
        wait_strategy_id: null,
        internal: false,
      },
    ]);

    const result = await importLegacyQueueDaemonScheduleState({
      baseDir: tmpDir,
      importedAt: "2026-05-09T01:00:00.000Z",
    });

    expect(result).toMatchObject({
      queueRecords: 1,
      daemonState: true,
      shutdownMarker: true,
      supervisorState: true,
      scheduleEntries: 1,
      scheduleHistoryRecords: 1,
    });
    expect(new JournalBackedQueue({
      journalPath: path.join(runtimeRoot, "queue.json"),
      controlBaseDir: tmpDir,
    }).get(envelope.id)?.status).toBe("pending");
    await expect(new DaemonStateStore(tmpDir).load()).resolves.toMatchObject({
      status: "running",
      active_goals: ["goal-1"],
    });
    await expect(new DaemonShutdownStore(tmpDir).load()).resolves.toMatchObject({
      state: "running",
      goal_ids: ["goal-1"],
    });
    await expect(new SupervisorStateStore(runtimeRoot, { controlBaseDir: tmpDir }).load()).resolves.toMatchObject({
      crashCounts: { "goal-1": 1 },
    });
    await expect(new ScheduleEntryStore(tmpDir, { warn: () => {} }).readEntries()).resolves.toMatchObject([
      { id: "11111111-1111-4111-8111-111111111111", name: "daily-health" },
    ]);
    await expect(new ScheduleHistoryStore(tmpDir).load()).resolves.toMatchObject([
      { entry_name: "daily-health", tokens_used: 5 },
    ]);

    const database = await openControlDatabase({ baseDir: tmpDir });
    try {
      const imports = database.listLegacyImports();
      expect(imports.map((record) => record.source_kind).sort()).toEqual([
        "daemon-shutdown-json",
        "daemon-state-json",
        "runtime-queue-json",
        "schedule-entries-json",
        "schedule-history-json",
        "supervisor-state-json",
      ]);
      expect(imports.every((record) => record.migration_version === 4)).toBe(true);
      expect(imports.every((record) => record.status === "imported")).toBe(true);
    } finally {
      database.close();
    }
  });

  it("does not overwrite authoritative control DB state with stale legacy files", async () => {
    tmpDir = makeTempDir("pulseed-legacy-queue-daemon-schedule-skip-stale-");
    const runtimeRoot = path.join(tmpDir, "runtime");
    const now = "2026-05-09T00:00:00.000Z";
    const currentEnvelope = createEnvelope({
      type: "event",
      name: "current-run",
      source: "db",
      payload: { goalId: "goal-current" },
      priority: "normal",
    });
    const staleEnvelope = createEnvelope({
      type: "event",
      name: "stale-run",
      source: "legacy",
      payload: { goalId: "goal-stale" },
      priority: "high",
    });

    const queue = new JournalBackedQueue({
      journalPath: path.join(runtimeRoot, "queue.json"),
      controlBaseDir: tmpDir,
    });
    queue.accept(currentEnvelope);
    await new DaemonStateStore(tmpDir).save({
      pid: process.pid,
      started_at: now,
      last_loop_at: null,
      loop_count: 10,
      active_goals: ["goal-current"],
      status: "running",
      runtime_root: runtimeRoot,
      crash_count: 0,
      last_error: null,
      last_resident_at: null,
      resident_activity: null,
    });
    await new DaemonShutdownStore(tmpDir).save({
      goal_ids: ["goal-current"],
      loop_index: 10,
      timestamp: now,
      reason: "stop",
      state: "clean_shutdown",
    });
    await new SupervisorStateStore(runtimeRoot, { controlBaseDir: tmpDir }).save({
      workers: [{
        workerId: "worker-current",
        goalId: "goal-current",
        startedAt: 10,
        iterations: 3,
      }],
      crashCounts: { "goal-current": 0 },
      suspendedGoals: [],
      updatedAt: 10,
    });
    await new ScheduleEntryStore(tmpDir, { warn: () => {} }).saveEntries([
      makeHeartbeatSchedule({
        id: "33333333-3333-4333-8333-333333333333",
        name: "current-schedule",
      }) as never,
    ]);
    await new ScheduleHistoryStore(tmpDir).save([
      {
        id: "44444444-4444-4444-8444-444444444444",
        entry_id: "33333333-3333-4333-8333-333333333333",
        entry_name: "current-schedule",
        layer: "heartbeat",
        status: "ok",
        duration_ms: 20,
        fired_at: now,
        reason: "cadence",
        attempt: 0,
        scheduled_for: null,
        started_at: now,
        finished_at: now,
        retry_at: null,
        tokens_used: 20,
        escalated_to: null,
        activation_kind: null,
        strategy_id: null,
        wait_strategy_id: null,
        internal: false,
      },
    ]);

    writeJson(tmpDir, "runtime/queue.json", {
      version: 1,
      records: {
        [staleEnvelope.id]: {
          envelope: staleEnvelope,
          status: "pending",
          attempt: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      },
      pending: {
        critical: [],
        high: [staleEnvelope.id],
        normal: [],
        low: [],
      },
      inflight: {},
    });
    writeJson(tmpDir, "daemon-state.json", {
      pid: 999999,
      started_at: now,
      last_loop_at: null,
      loop_count: 1,
      active_goals: ["goal-stale"],
      status: "running",
      runtime_root: runtimeRoot,
      crash_count: 0,
      last_error: null,
      last_resident_at: null,
      resident_activity: null,
    });
    writeJson(tmpDir, "shutdown-state.json", {
      goal_ids: ["goal-stale"],
      loop_index: 1,
      timestamp: now,
      reason: "stale",
      state: "running",
    });
    writeJson(tmpDir, "runtime/supervisor-state.json", {
      workers: [{
        workerId: "worker-stale",
        goalId: "goal-stale",
        startedAt: 1,
        iterations: 1,
      }],
      crashCounts: { "goal-stale": 9 },
      suspendedGoals: ["goal-stale"],
      updatedAt: 1,
    });
    writeJson(tmpDir, "schedules.json", [
      makeHeartbeatSchedule({
        id: "55555555-5555-4555-8555-555555555555",
        name: "stale-schedule",
      }),
    ]);
    writeJson(tmpDir, "schedule-history.json", [
      {
        id: "66666666-6666-4666-8666-666666666666",
        entry_id: "55555555-5555-4555-8555-555555555555",
        entry_name: "stale-schedule",
        layer: "heartbeat",
        status: "ok",
        duration_ms: 1,
        fired_at: now,
        reason: "stale",
        attempt: 0,
        scheduled_for: null,
        started_at: now,
        finished_at: now,
        retry_at: null,
        tokens_used: 1,
        escalated_to: null,
        activation_kind: null,
        strategy_id: null,
        wait_strategy_id: null,
        internal: false,
      },
    ]);

    const result = await importLegacyQueueDaemonScheduleState({
      baseDir: tmpDir,
      importedAt: "2026-05-09T01:00:00.000Z",
    });

    expect(result).toMatchObject({
      queueRecords: 0,
      daemonState: false,
      shutdownMarker: false,
      supervisorState: false,
      scheduleEntries: 0,
      scheduleHistoryRecords: 0,
    });
    expect(queue.get(currentEnvelope.id)?.status).toBe("pending");
    expect(queue.get(staleEnvelope.id)).toBeUndefined();
    await expect(new DaemonStateStore(tmpDir).load()).resolves.toMatchObject({
      active_goals: ["goal-current"],
      loop_count: 10,
    });
    await expect(new DaemonShutdownStore(tmpDir).load()).resolves.toMatchObject({
      goal_ids: ["goal-current"],
      reason: "stop",
    });
    await expect(new SupervisorStateStore(runtimeRoot, { controlBaseDir: tmpDir }).load()).resolves.toMatchObject({
      workers: [expect.objectContaining({ workerId: "worker-current" })],
      crashCounts: { "goal-current": 0 },
    });
    await expect(new ScheduleEntryStore(tmpDir, { warn: () => {} }).readEntries()).resolves.toMatchObject([
      { id: "33333333-3333-4333-8333-333333333333", name: "current-schedule" },
    ]);
    await expect(new ScheduleHistoryStore(tmpDir).load()).resolves.toMatchObject([
      { entry_name: "current-schedule", tokens_used: 20 },
    ]);

    const database = await openControlDatabase({ baseDir: tmpDir });
    try {
      const imports = database.listLegacyImports();
      expect(imports.map((record) => record.status)).toEqual([
        "blocked",
        "blocked",
        "blocked",
        "blocked",
        "blocked",
        "blocked",
      ]);
      expect(imports.every((record) => (
        record.details["skipped_reason"] === "authoritative_db_state_present"
      ))).toBe(true);
    } finally {
      database.close();
    }
  });

  it("imports only safe legacy queue records and rejects unsafe persisted queue scalars", async () => {
    tmpDir = makeTempDir("pulseed-legacy-queue-unsafe-scalars-");
    const runtimeRoot = path.join(tmpDir, "runtime");
    const safeEnvelope = createEnvelope({
      type: "event",
      name: "safe-legacy-command",
      source: "legacy",
      payload: { goalId: "goal-safe" },
      priority: "high",
    });
    const unsafeTimestampEnvelope = {
      ...createEnvelope({
        type: "event",
        name: "unsafe-timestamp",
        source: "legacy",
        payload: { goalId: "goal-unsafe" },
        priority: "normal",
      }),
      created_at: "not-a-number",
    };
    const unsafeLeaseEnvelope = createEnvelope({
      type: "event",
      name: "unsafe-lease",
      source: "legacy",
      payload: { goalId: "goal-unsafe-lease" },
      priority: "low",
    });

    writeJson(tmpDir, "runtime/queue.json", {
      version: 1,
      records: {
        [safeEnvelope.id]: {
          envelope: safeEnvelope,
          status: "pending",
          attempt: 0,
          createdAt: 1,
          updatedAt: 1,
        },
        [unsafeTimestampEnvelope.id]: {
          envelope: unsafeTimestampEnvelope,
          status: "pending",
          attempt: 0,
          createdAt: 2,
          updatedAt: 2,
        },
        [unsafeLeaseEnvelope.id]: {
          envelope: unsafeLeaseEnvelope,
          status: "inflight",
          attempt: 1,
          createdAt: 3,
          updatedAt: 3,
          workerId: "worker-unsafe",
          claimToken: "claim-unsafe",
          leaseUntil: "not-a-number",
        },
      },
      pending: {
        critical: [],
        high: [safeEnvelope.id],
        normal: [unsafeTimestampEnvelope.id],
        low: [],
      },
      inflight: {
        "claim-unsafe": {
          messageId: unsafeLeaseEnvelope.id,
          workerId: "worker-unsafe",
          leaseUntil: "not-a-number",
          attempt: 1,
          claimedAt: 3,
        },
      },
    });

    const result = await importLegacyQueueDaemonScheduleState({
      baseDir: tmpDir,
      importedAt: "2026-05-09T01:00:00.000Z",
    });

    expect(result.queueRecords).toBe(1);
    const importedQueue = new JournalBackedQueue({
      journalPath: path.join(runtimeRoot, "queue.json"),
      controlBaseDir: tmpDir,
    });
    expect(importedQueue.get(safeEnvelope.id)?.status).toBe("pending");
    expect(importedQueue.get(unsafeTimestampEnvelope.id)).toBeUndefined();
    expect(importedQueue.get(unsafeLeaseEnvelope.id)).toBeUndefined();
    expect(importedQueue.snapshot().pending.high).toEqual([safeEnvelope.id]);
    expect(importedQueue.snapshot().pending.normal).toEqual([]);
    expect(importedQueue.inflightSize()).toBe(0);

    const database = await openControlDatabase({ baseDir: tmpDir });
    try {
      const queueRows = database.read((sqlite) =>
        sqlite.prepare("SELECT message_id FROM runtime_queue_records ORDER BY message_id").all() as Array<{ message_id: string }>
      );
      expect(queueRows).toEqual([{ message_id: safeEnvelope.id }]);
      const imports = database.listLegacyImports();
      expect(imports).toEqual(expect.arrayContaining([
        expect.objectContaining({
          source_kind: "runtime-queue-json",
          status: "imported",
          details: expect.objectContaining({ imported_records: 1 }),
        }),
        expect.objectContaining({ source_kind: "daemon-state-json", status: "validated" }),
        expect.objectContaining({ source_kind: "daemon-shutdown-json", status: "validated" }),
        expect.objectContaining({ source_kind: "supervisor-state-json", status: "validated" }),
        expect.objectContaining({ source_kind: "schedule-entries-json", status: "validated" }),
        expect.objectContaining({ source_kind: "schedule-history-json", status: "validated" }),
      ]));
      expect(imports).toHaveLength(6);
    } finally {
      database.close();
    }
  });

  it("keeps invalid legacy sources retryable until they are corrected", async () => {
    tmpDir = makeTempDir("pulseed-legacy-queue-daemon-schedule-invalid-retry-");
    const runtimeRoot = path.join(tmpDir, "runtime");
    const now = "2026-05-09T00:00:00.000Z";
    const envelope = createEnvelope({
      type: "event",
      name: "retry-run",
      source: "legacy",
      payload: { goalId: "goal-retry" },
      priority: "high",
    });

    writeJson(tmpDir, "runtime/queue.json", {});
    writeJson(tmpDir, "daemon-state.json", {});
    writeJson(tmpDir, "shutdown-state.json", {});
    writeJson(tmpDir, "runtime/supervisor-state.json", {});
    writeJson(tmpDir, "schedules.json", {});
    writeJson(tmpDir, "schedule-history.json", {});

    const invalidResult = await importLegacyQueueDaemonScheduleState({
      baseDir: tmpDir,
      importedAt: "2026-05-09T01:00:00.000Z",
    });

    expect(invalidResult).toMatchObject({
      queueRecords: 0,
      daemonState: false,
      shutdownMarker: false,
      supervisorState: false,
      scheduleEntries: 0,
      scheduleHistoryRecords: 0,
    });
    expect(invalidResult.legacyImports.every((record) => record.status === "validated")).toBe(true);
    expect(invalidResult.legacyImports.every((record) => (
      record.details["skipped_reason"] === "invalid_legacy_source"
    ))).toBe(true);

    writeJson(tmpDir, "runtime/queue.json", {
      version: 1,
      records: {
        [envelope.id]: {
          envelope,
          status: "pending",
          attempt: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      },
      pending: {
        critical: [],
        high: [envelope.id],
        normal: [],
        low: [],
      },
      inflight: {},
    });
    writeJson(tmpDir, "daemon-state.json", {
      pid: process.pid,
      started_at: now,
      last_loop_at: null,
      loop_count: 2,
      active_goals: ["goal-retry"],
      status: "running",
      runtime_root: runtimeRoot,
      crash_count: 0,
      last_error: null,
      last_resident_at: null,
      resident_activity: null,
    });
    writeJson(tmpDir, "shutdown-state.json", {
      goal_ids: ["goal-retry"],
      loop_index: 2,
      timestamp: now,
      reason: "stop",
      state: "running",
    });
    writeJson(tmpDir, "runtime/supervisor-state.json", {
      workers: [{
        workerId: "worker-retry",
        goalId: "goal-retry",
        startedAt: 2,
        iterations: 1,
      }],
      crashCounts: { "goal-retry": 0 },
      suspendedGoals: [],
      updatedAt: 2,
    });
    writeJson(tmpDir, "schedules.json", [
      makeHeartbeatSchedule({
        id: "77777777-7777-4777-8777-777777777777",
        name: "retry-schedule",
      }),
    ]);
    writeJson(tmpDir, "schedule-history.json", [
      {
        id: "88888888-8888-4888-8888-888888888888",
        entry_id: "77777777-7777-4777-8777-777777777777",
        entry_name: "retry-schedule",
        layer: "heartbeat",
        status: "ok",
        duration_ms: 10,
        fired_at: now,
        reason: "cadence",
        attempt: 0,
        scheduled_for: null,
        started_at: now,
        finished_at: now,
        retry_at: null,
        tokens_used: 7,
        escalated_to: null,
        activation_kind: null,
        strategy_id: null,
        wait_strategy_id: null,
        internal: false,
      },
    ]);

    const correctedResult = await importLegacyQueueDaemonScheduleState({
      baseDir: tmpDir,
      importedAt: "2026-05-09T02:00:00.000Z",
    });

    expect(correctedResult).toMatchObject({
      queueRecords: 1,
      daemonState: true,
      shutdownMarker: true,
      supervisorState: true,
      scheduleEntries: 1,
      scheduleHistoryRecords: 1,
    });
    expect(new JournalBackedQueue({
      journalPath: path.join(runtimeRoot, "queue.json"),
      controlBaseDir: tmpDir,
    }).get(envelope.id)?.status).toBe("pending");
    await expect(new DaemonStateStore(tmpDir).load()).resolves.toMatchObject({
      active_goals: ["goal-retry"],
    });
    await expect(new DaemonShutdownStore(tmpDir).load()).resolves.toMatchObject({
      goal_ids: ["goal-retry"],
    });
    await expect(new SupervisorStateStore(runtimeRoot, { controlBaseDir: tmpDir }).load()).resolves.toMatchObject({
      workers: [expect.objectContaining({ workerId: "worker-retry" })],
    });
    await expect(new ScheduleEntryStore(tmpDir, { warn: () => {} }).readEntries()).resolves.toMatchObject([
      { id: "77777777-7777-4777-8777-777777777777", name: "retry-schedule" },
    ]);
    await expect(new ScheduleHistoryStore(tmpDir).load()).resolves.toMatchObject([
      { entry_name: "retry-schedule", tokens_used: 7 },
    ]);
  });
});
