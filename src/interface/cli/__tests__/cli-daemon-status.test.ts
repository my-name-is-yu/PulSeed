import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { makeTempDir, cleanupTempDir } from "../../../../tests/helpers/temp-dir.js";
import type * as PathsModule from "../../../base/utils/paths.js";

// ─── cmdDaemonStatus tests ───

// We test the command by importing it and mocking paths.getPulseedDirPath
// so it points to a temp directory we control.

vi.mock("../../../base/utils/paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof PathsModule>();
  return {
    ...actual,
    getPulseedDirPath: vi.fn(() => "/tmp/pulseed-test-placeholder"),
  };
});

import { getPulseedDirPath } from "../../../base/utils/paths.js";
import { cmdDaemonStatus } from "../commands/daemon.js";
import { PIDManager } from "../../../runtime/pid-manager.js";
import { RuntimeHealthStore } from "../../../runtime/store/health-store.js";
import { ProactiveInterventionStore } from "../../../runtime/store/proactive-intervention-store.js";
import {
  CONTROL_DB_SCHEMA_VERSION,
  DaemonShutdownStore,
  DaemonStateStore,
  GoalTaskStateStore,
  openControlDatabase,
  SupervisorStateStore,
} from "../../../runtime/store/index.js";
import type { RuntimeLongRunHealth } from "../../../runtime/store/runtime-schemas.js";

function mockPidInspectRunning(runtimePid: number, ownerPid = runtimePid) {
  return vi.spyOn(PIDManager.prototype, "inspect").mockResolvedValue({
    info: {
      pid: runtimePid,
      runtime_pid: runtimePid,
      owner_pid: ownerPid,
      watchdog_pid: ownerPid !== runtimePid ? ownerPid : undefined,
      started_at: new Date().toISOString(),
      runtime_started_at: new Date().toISOString(),
      owner_started_at: new Date().toISOString(),
      watchdog_started_at: ownerPid !== runtimePid ? new Date().toISOString() : undefined,
    },
    running: true,
    runtimePid,
    ownerPid,
    alivePids: ownerPid === runtimePid ? [runtimePid] : [runtimePid, ownerPid],
    stalePids: [],
    verifiedPids: ownerPid === runtimePid ? [runtimePid] : [runtimePid, ownerPid],
    unverifiedLegacyPids: [],
  });
}

async function saveRuntimeHealthFixture(
  baseDir: string,
  daemon: Parameters<RuntimeHealthStore["saveDaemonHealth"]>[0],
  components: Parameters<RuntimeHealthStore["saveComponentsHealth"]>[0]
): Promise<void> {
  const store = new RuntimeHealthStore(path.join(baseDir, "runtime"), { controlBaseDir: baseDir });
  await store.saveDaemonHealth(daemon);
  await store.saveComponentsHealth(components);
}

async function saveDaemonStateFixture(baseDir: string, state: Record<string, unknown>): Promise<void> {
  await new DaemonStateStore(baseDir).save(state as never);
}

async function insertRawDaemonStateFixture(baseDir: string, state: Record<string, unknown>): Promise<void> {
  const database = await openControlDatabase({ baseDir });
  try {
    database.transaction((db) => {
      db.prepare(`
        INSERT INTO daemon_state_snapshots (
          state_id,
          pid,
          status,
          runtime_root,
          loop_count,
          updated_at,
          state_json
        )
        VALUES ('current', ?, ?, ?, ?, ?, json(?))
        ON CONFLICT(state_id) DO UPDATE SET
          pid = excluded.pid,
          status = excluded.status,
          runtime_root = excluded.runtime_root,
          loop_count = excluded.loop_count,
          updated_at = excluded.updated_at,
          state_json = excluded.state_json
      `).run(
        state["pid"] ?? null,
        state["status"] ?? "running",
        state["runtime_root"] ?? null,
        state["loop_count"] ?? 0,
        state["last_loop_at"] ?? state["started_at"] ?? new Date().toISOString(),
        JSON.stringify(state)
      );
    });
  } finally {
    database.close();
  }
}

async function saveShutdownMarkerFixture(baseDir: string, marker: Record<string, unknown>): Promise<void> {
  await new DaemonShutdownStore(baseDir).save(marker as never);
}

async function saveSupervisorStateFixture(baseDir: string, state: {
  workers: Array<Record<string, unknown>>;
  crashCounts: Record<string, number>;
  suspendedGoals: string[];
  updatedAt: number;
}): Promise<void> {
  await new SupervisorStateStore(path.join(baseDir, "runtime"), { controlBaseDir: baseDir }).save(state as never);
}

function runningDaemonState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pid: process.pid,
    started_at: new Date(Date.now() - 60_000).toISOString(),
    last_loop_at: null,
    loop_count: 1,
    active_goals: [],
    status: "running",
    crash_count: 0,
    last_error: null,
    ...overrides,
  };
}

function staleArtifactLongRunHealth(
  now: number,
  overrides: Partial<RuntimeLongRunHealth> = {},
): RuntimeLongRunHealth {
  const base: RuntimeLongRunHealth = {
    summary: "alive_but_artifact_stalled",
    checked_at: now,
    signals: {
      process: { status: "alive", checked_at: now, observed_at: now, pid: process.pid },
      child_activity: { status: "idle", checked_at: now, observed_at: now, active_count: 0 },
      log_freshness: { status: "stale", checked_at: now, observed_at: now - 15 * 60_000 },
      artifact_freshness: { status: "missing", checked_at: now },
      metric_freshness: { status: "missing", checked_at: now },
      metric_progress: { status: "missing", checked_at: now },
      blocker: { status: "none", checked_at: now, observed_at: now },
      resumable: true,
    },
  };
  return {
    ...base,
    ...overrides,
    signals: overrides.signals ?? base.signals,
  };
}

describe("cmdDaemonStatus", () => {
  let tmpDir: string;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = makeTempDir("pulseed-status-test-");
    vi.mocked(getPulseedDirPath).mockReturnValue(tmpDir);
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
    vi.restoreAllMocks();
    cleanupTempDir(tmpDir);
  });

  it("prints 'No daemon state found' when state file does not exist", async () => {
    await cmdDaemonStatus([]);

    expect(consoleSpy).toHaveBeenCalledWith("No daemon state found");
  });

  it("reports unsupported newer control DB schema before daemon health", async () => {
    const database = await openControlDatabase({ baseDir: tmpDir });
    try {
      database.transaction((db) => {
        db.pragma(`user_version = ${CONTROL_DB_SCHEMA_VERSION + 1}`);
      });
    } finally {
      database.close();
    }

    await cmdDaemonStatus([]);

    const output = consoleSpy.mock.calls[0]?.[0] as string;
    expect(output).toContain("Status:          schema drift");
    expect(output).toContain(`Database schema version ${CONTROL_DB_SCHEMA_VERSION + 1} is newer`);
    expect(output).toContain(`supports (${CONTROL_DB_SCHEMA_VERSION})`);
    expect(output).toContain("runtime readiness is not healthy");
    expect(output).not.toContain("No daemon state found");
  });

  it("shows stopped status when PID is not running", async () => {
    // Write a state file with a PID that is almost certainly not running
    const state = {
      pid: 999999999,
      started_at: "2026-01-01T00:00:00.000Z",
      last_loop_at: null,
      loop_count: 5,
      active_goals: ["goal-a", "goal-b"],
      status: "running",
      crash_count: 1,
      last_error: null,
    };
    await saveDaemonStateFixture(tmpDir, state);

    await cmdDaemonStatus([]);

    const output = consoleSpy.mock.calls[0]?.[0] as string;
    expect(output).toContain("stopped (PID: 999999999)");
    expect(output).toContain("Live runtime:    stopped; snapshot fields below are historical until the daemon restarts");
    expect(output).toContain("Historical active goals: goal-a, goal-b");
    expect(output).toContain("goal-a");
    expect(output).toContain("goal-b");
    expect(output).toContain("5 cycles completed");
    expect(output).toContain("1/3 retries used");
  });

  it("shows running status when PID is the current process", async () => {
    // Use our own PID — guaranteed to be running
    const state = {
      pid: process.pid,
      started_at: new Date(Date.now() - 60_000).toISOString(),
      last_loop_at: new Date().toISOString(),
      loop_count: 10,
      active_goals: ["goal-x"],
      status: "running",
      crash_count: 0,
      last_error: null,
      last_resident_at: null,
      resident_activity: null,
    };
    await insertRawDaemonStateFixture(tmpDir, state);
    fs.writeFileSync(
      path.join(tmpDir, "pulseed.pid"),
      JSON.stringify({
        pid: process.pid,
        runtime_pid: process.pid,
        owner_pid: process.pid,
        started_at: new Date().toISOString(),
      })
    );
    const inspectSpy = mockPidInspectRunning(process.pid);

    await cmdDaemonStatus([]);
    inspectSpy.mockRestore();

    const output = consoleSpy.mock.calls[0]?.[0] as string;
    expect(output).toContain(`running (PID: ${process.pid})`);
    expect(output).toContain("Uptime:");
    expect(output).toContain("10 cycles completed");
    expect(output).toContain("0/3 retries used");
  });

  it("shows persisted wait status details", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-24T12:00:00.000Z"));
    const state = {
      pid: process.pid,
      started_at: "2026-04-24T11:00:00.000Z",
      last_loop_at: "2026-04-24T12:00:00.000Z",
      loop_count: 3,
      active_goals: ["goal-wait"],
      status: "running",
      crash_count: 0,
      last_error: null,
      waiting_goals: [
        {
          goal_id: "goal-wait",
          strategy_id: "wait-1",
          next_observe_at: "2026-04-24T12:30:00.000Z",
          wait_until: "2026-04-24T12:30:00.000Z",
          wait_reason: "approval required before resume",
          approval_pending: true,
          activation_kind: "wait_resume",
          internal_schedule: true,
        },
      ],
      next_observe_at: "2026-04-24T12:30:00.000Z",
      last_observe_at: "2026-04-24T11:45:00.000Z",
      last_wait_reason: "approval required before resume",
      approval_pending_count: 1,
    };
    await saveDaemonStateFixture(tmpDir, state);
    const inspectSpy = mockPidInspectRunning(process.pid);

    try {
      await cmdDaemonStatus([]);
    } finally {
      inspectSpy.mockRestore();
      vi.useRealTimers();
    }

    const output = consoleSpy.mock.calls[0]?.[0] as string;
    expect(output).toContain("Wait status:");
    expect(output).toContain("Waiting goals:  1");
    expect(output).toContain("Next observe:   30m from now");
    expect(output).toContain("Last observe:   15m ago");
    expect(output).toContain("Approvals:      1 pending");
    expect(output).toContain("goal-wait/wait-1");
    expect(output).toContain("observe 30m from now");
    expect(output).toContain("approval required before resume, approval pending, schedule-projected, wait_resume");
  });

  it("rejects persisted daemon state with unsafe count metadata", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const state = {
      pid: process.pid,
      started_at: "2026-04-24T11:00:00.000Z",
      last_loop_at: "2026-04-24T12:00:00.000Z",
      loop_count: Number.MAX_SAFE_INTEGER + 1,
      active_goals: ["goal-unsafe"],
      status: "running",
      crash_count: 0,
      last_error: null,
      last_resident_at: null,
      resident_activity: null,
    };
    await insertRawDaemonStateFixture(tmpDir, state);

    await cmdDaemonStatus([]);

    expect(errorSpy.mock.calls[0]?.[0]).toContain("Invalid daemon state");
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("prints runtime KPI status when health snapshot exists", async () => {
    const now = Date.now();
    fs.mkdirSync(path.join(tmpDir, "tasks", "goal-kpi", "ledger"), { recursive: true });
    await saveRuntimeHealthFixture(
      tmpDir,
      {
        status: "degraded",
        leader: true,
        checked_at: now,
        kpi: {
          process_alive: { status: "ok", checked_at: now, last_ok_at: now },
          command_acceptance: {
            status: "degraded",
            checked_at: now,
            last_degraded_at: now,
            reason: "gateway or queue health degraded",
          },
          task_execution: { status: "ok", checked_at: now, last_ok_at: now },
          degraded_at: now,
        },
        long_running: {
          summary: "alive_but_waiting",
          checked_at: now,
          signals: {
            process: { status: "alive", checked_at: now, observed_at: now, pid: process.pid },
            child_activity: { status: "active", checked_at: now, observed_at: now, active_count: 1 },
            log_freshness: { status: "fresh", checked_at: now, observed_at: now, path: "coreloop.log" },
            artifact_freshness: {
              status: "fresh",
              checked_at: now,
              observed_at: now - 1_000,
              path: "result.json",
            },
            metric_freshness: {
              status: "fresh",
              checked_at: now,
              observed_at: now - 1_000,
              metric_name: "score",
            },
            metric_progress: {
              status: "plateau",
              checked_at: now,
              observed_at: now - 1_000,
              metric_name: "score",
              previous_value: 0.7,
              current_value: 0.7,
            },
            blocker: {
              status: "approval_wait",
              checked_at: now,
              observed_at: now,
              reason: "submission requires approval",
            },
            expected_next_checkpoint_at: now + 60_000,
            resumable: true,
          },
        },
        details: { pid: process.pid },
      },
      {
        checked_at: now,
        components: {
          gateway: "degraded",
          queue: "ok",
          leases: "ok",
          approval: "ok",
          outbox: "ok",
          supervisor: "ok",
        },
      }
    );
    await new GoalTaskStateStore(tmpDir).saveTaskOutcomeLedger({
        task_id: "task-1",
        goal_id: "goal-kpi",
        events: [
          { type: "acked", ts: new Date(now - 5_000).toISOString() },
          { type: "started", ts: new Date(now - 4_000).toISOString() },
          { type: "succeeded", ts: new Date(now - 1_000).toISOString() },
        ],
        summary: {
          latest_event_type: "succeeded",
          latencies: {
            created_to_acked_ms: 1000,
            acked_to_started_ms: 200,
            started_to_completed_ms: 2500,
            completed_to_verification_ms: 150,
            created_to_completed_ms: 3700,
          },
        },
      });
    await saveDaemonStateFixture(tmpDir, {
        pid: process.pid,
        started_at: new Date(now - 60_000).toISOString(),
        last_loop_at: new Date(now).toISOString(),
        loop_count: 2,
        active_goals: ["goal-kpi"],
        status: "running",
        crash_count: 0,
        last_error: null,
      });
    fs.writeFileSync(
      path.join(tmpDir, "pulseed.pid"),
      JSON.stringify({
        pid: process.pid,
        runtime_pid: process.pid,
        owner_pid: process.pid,
        started_at: new Date(now).toISOString(),
      })
    );
    const inspectSpy = mockPidInspectRunning(process.pid);

    await cmdDaemonStatus([]);
    inspectSpy.mockRestore();

    const output = consoleSpy.mock.calls[0]?.[0] as string;
    expect(output).toContain("Runtime health:");
    expect(output).toContain("Process alive:");
    expect(output).toContain("Accept command:");
    expect(output).toContain("Execute task:");
    expect(output).toContain("KPI snapshot:    process=up accept=down execute=up (degraded)");
    expect(output).toContain("Degraded at:");
    expect(output).toContain("Long-run health:");
    expect(output).toContain("Summary:        alive but waiting");
    expect(output).toContain("Artifact fresh: fresh; evidence=");
    expect(output).toContain("Metric trend:   plateau; evidence=");
    expect(output).toContain("Blocker:        approval_wait; evidence=");
    expect(output).toContain("Task KPIs:");
    expect(output).toContain("Success rate:    1/1 (100.0%)");
    expect(output).toContain("Ack latency:     p95 1.0s");
  });

  it("does not lead idle no-active-goal status with artifact-stalled when no artifact stream is expected", async () => {
    const now = Date.now();
    await saveRuntimeHealthFixture(
      tmpDir,
      {
        status: "ok",
        leader: true,
        checked_at: now,
        kpi: {
          process_alive: { status: "ok", checked_at: now, last_ok_at: now },
          command_acceptance: { status: "ok", checked_at: now, last_ok_at: now },
          task_execution: { status: "ok", checked_at: now, last_ok_at: now },
        },
        long_running: staleArtifactLongRunHealth(now),
        details: { pid: process.pid },
      },
      {
        checked_at: now,
        components: {
          gateway: "ok",
          queue: "ok",
          leases: "ok",
          approval: "ok",
          outbox: "ok",
          supervisor: "ok",
        },
      }
    );
    await saveDaemonStateFixture(tmpDir, runningDaemonState({
      active_goals: [],
      status: "idle",
    }));
    const inspectSpy = mockPidInspectRunning(process.pid);

    await cmdDaemonStatus([]);
    inspectSpy.mockRestore();

    const output = consoleSpy.mock.calls[0]?.[0] as string;
    expect(output).toContain("Status:          idle");
    expect(output).toContain("Active goals:    (none)");
    expect(output).toContain("Summary:        idle; no active artifact stream expected");
    expect(output).toContain("Artifact fresh: missing; evidence=");
    expect(output).toContain("Artifact stream: none (idle_no_worker)");
    expect(output).not.toContain("Summary:        alive but artifact-stalled");
  });

  it("keeps active-goal missing artifacts visible as artifact-stalled", async () => {
    const now = Date.now();
    await saveRuntimeHealthFixture(
      tmpDir,
      {
        status: "degraded",
        leader: true,
        checked_at: now,
        kpi: {
          process_alive: { status: "ok", checked_at: now, last_ok_at: now },
          command_acceptance: { status: "ok", checked_at: now, last_ok_at: now },
          task_execution: { status: "degraded", checked_at: now, last_degraded_at: now },
          degraded_at: now,
        },
        long_running: staleArtifactLongRunHealth(now, {
          signals: {
            ...staleArtifactLongRunHealth(now).signals,
            child_activity: { status: "active", checked_at: now, observed_at: now, active_count: 1 },
          },
        }),
        details: { pid: process.pid },
      },
      {
        checked_at: now,
        components: {
          gateway: "ok",
          queue: "ok",
          leases: "ok",
          approval: "ok",
          outbox: "ok",
          supervisor: "degraded",
        },
      }
    );
    await saveDaemonStateFixture(tmpDir, runningDaemonState({
      active_goals: ["goal-stale"],
      status: "running",
    }));
    const inspectSpy = mockPidInspectRunning(process.pid);

    await cmdDaemonStatus([]);
    inspectSpy.mockRestore();

    const output = consoleSpy.mock.calls[0]?.[0] as string;
    expect(output).toContain("Active goals:    goal-stale");
    expect(output).toContain("Summary:        alive but artifact-stalled");
    expect(output).toContain("Artifact fresh: missing; evidence=");
    expect(output).toContain("Artifact stream: expected (active_goal)");
  });

  it("does not throw on out-of-range persisted runtime health timestamps", async () => {
    const now = Date.now();
    const outOfDateRangeTimestamp = 9_000_000_000_000_000;
    await saveRuntimeHealthFixture(
      tmpDir,
      {
        status: "degraded",
        leader: true,
        checked_at: now,
        kpi: {
          process_alive: { status: "ok", checked_at: now, last_ok_at: now },
          command_acceptance: { status: "degraded", checked_at: now, last_degraded_at: now },
          task_execution: { status: "ok", checked_at: now, last_ok_at: now },
          degraded_at: outOfDateRangeTimestamp,
          recovered_at: outOfDateRangeTimestamp,
        },
      },
      {
        checked_at: now,
        components: {
          gateway: "degraded",
          queue: "ok",
          leases: "ok",
          approval: "ok",
          outbox: "ok",
          supervisor: "ok",
        },
      }
    );
    await saveDaemonStateFixture(tmpDir, runningDaemonState({
      pid: process.pid,
      started_at: new Date(now - 60_000).toISOString(),
      last_loop_at: new Date(now).toISOString(),
    }));
    fs.writeFileSync(
      path.join(tmpDir, "pulseed.pid"),
      JSON.stringify({
        pid: process.pid,
        runtime_pid: process.pid,
        owner_pid: process.pid,
        started_at: new Date(now).toISOString(),
      })
    );
    const inspectSpy = mockPidInspectRunning(process.pid);

    await cmdDaemonStatus([]);
    inspectSpy.mockRestore();

    const output = consoleSpy.mock.calls[0]?.[0] as string;
    expect(output).toContain("Runtime health:");
    expect(output).toContain("Degraded at:     n/a");
    expect(output).toContain("Recovered at:    n/a");
    expect(output).not.toContain("Invalid Date");
    expect(output).not.toContain("NaN");
    expect(output).not.toContain("Infinity");
  });

  it("separates unrelated approvals from the active goal blocker in long-run health output", async () => {
    const now = Date.now();
    await saveRuntimeHealthFixture(
      tmpDir,
      {
        status: "degraded",
        leader: true,
        checked_at: now,
        long_running: {
          summary: "alive_but_waiting",
          checked_at: now,
          signals: {
            process: { status: "alive", checked_at: now, observed_at: now, pid: process.pid },
            child_activity: { status: "active", checked_at: now, observed_at: now, active_count: 1 },
            log_freshness: { status: "fresh", checked_at: now, observed_at: now, path: "coreloop.log" },
            artifact_freshness: { status: "fresh", checked_at: now, observed_at: now, path: "result.json" },
            metric_freshness: { status: "fresh", checked_at: now, observed_at: now, metric_name: "score" },
            metric_progress: {
              status: "plateau",
              checked_at: now,
              observed_at: now,
              metric_name: "score",
              previous_value: 0.7,
              current_value: 0.7,
            },
            blocker: {
              status: "blocked",
              checked_at: now,
              observed_at: now,
              reason: "1 policy-blocked task for active goal",
              active_goal_ids: ["goal-active"],
              pending_approval_count: 1,
              goal_scoped_pending_approval_count: 0,
              unrelated_pending_approval_count: 1,
            },
            expected_next_checkpoint_at: now + 60_000,
            resumable: true,
          },
        },
        details: { pid: process.pid },
      },
      {
        checked_at: now,
        components: {
          gateway: "ok",
          queue: "ok",
          leases: "ok",
          approval: "ok",
          outbox: "ok",
          supervisor: "ok",
        },
      }
    );
    await saveDaemonStateFixture(tmpDir, {
        pid: process.pid,
        started_at: new Date(now - 60_000).toISOString(),
        last_loop_at: new Date(now).toISOString(),
        loop_count: 2,
        active_goals: ["goal-active"],
        status: "running",
        crash_count: 0,
        last_error: null,
      });
    fs.writeFileSync(
      path.join(tmpDir, "pulseed.pid"),
      JSON.stringify({
        pid: process.pid,
        runtime_pid: process.pid,
        owner_pid: process.pid,
        started_at: new Date(now).toISOString(),
      })
    );
    const inspectSpy = mockPidInspectRunning(process.pid);

    await cmdDaemonStatus([]);
    inspectSpy.mockRestore();

    const output = consoleSpy.mock.calls[0]?.[0] as string;
    expect(output).toContain("Long-run health:");
    expect(output).toContain("Blocker:        blocked; evidence=");
    expect(output).toContain("Unrelated approvals: 1 pending outside active goal scope");
    expect(output).not.toContain("Blocker:        approval_wait");
  });

  it("reconciles stale runtime health with stopped live PID state", async () => {
    const now = Date.now();
    const stalePid = 999999991;
    await saveRuntimeHealthFixture(
      tmpDir,
      {
        status: "ok",
        leader: true,
        checked_at: now - 60_000,
        kpi: {
          process_alive: { status: "ok", checked_at: now - 60_000, last_ok_at: now - 60_000 },
          command_acceptance: { status: "ok", checked_at: now - 60_000, last_ok_at: now - 60_000 },
          task_execution: { status: "ok", checked_at: now - 60_000, last_ok_at: now - 60_000 },
        },
        long_running: {
          summary: "alive_but_waiting",
          checked_at: now - 60_000,
          signals: {
            process: { status: "alive", checked_at: now - 60_000, observed_at: now - 60_000, pid: stalePid },
            child_activity: { status: "active", checked_at: now - 60_000, observed_at: now - 60_000, active_count: 2 },
            log_freshness: { status: "fresh", checked_at: now - 60_000, observed_at: now - 60_000 },
            artifact_freshness: { status: "missing", checked_at: now - 60_000 },
            metric_freshness: { status: "missing", checked_at: now - 60_000 },
            metric_progress: { status: "plateau", checked_at: now - 60_000, observed_at: now - 60_000 },
            blocker: { status: "none", checked_at: now - 60_000, observed_at: now - 60_000 },
            resumable: true,
          },
        },
        details: { pid: stalePid },
      },
      {
        checked_at: now - 60_000,
        components: {
          gateway: "ok",
          queue: "ok",
          leases: "ok",
          approval: "ok",
          outbox: "ok",
          supervisor: "ok",
        },
      }
    );
    await saveDaemonStateFixture(tmpDir, {
        pid: stalePid,
        started_at: new Date(now - 120_000).toISOString(),
        last_loop_at: new Date(now - 90_000).toISOString(),
        loop_count: 4,
        active_goals: ["goal-stale"],
        status: "running",
        crash_count: 0,
        last_error: null,
      });
    await saveShutdownMarkerFixture(tmpDir, {
        goal_ids: ["goal-stale"],
        loop_index: 4,
        timestamp: new Date(now - 10_000).toISOString(),
        reason: "stop",
        state: "clean_shutdown",
      });
    const inspectSpy = vi.spyOn(PIDManager.prototype, "inspect").mockResolvedValue({
      info: {
        pid: stalePid,
        runtime_pid: stalePid,
        owner_pid: stalePid,
        started_at: new Date(now - 120_000).toISOString(),
        runtime_started_at: new Date(now - 120_000).toISOString(),
        owner_started_at: new Date(now - 120_000).toISOString(),
      },
      running: false,
      runtimePid: stalePid,
      ownerPid: stalePid,
      alivePids: [],
      stalePids: [stalePid],
      verifiedPids: [],
      unverifiedLegacyPids: [],
    });

    await cmdDaemonStatus([]);
    inspectSpy.mockRestore();

    const output = consoleSpy.mock.calls[0]?.[0] as string;
    expect(output).toContain(`stopped (PID: ${stalePid})`);
    expect(output).toContain(`Stopped:         ${new Date(now - 10_000).toISOString()}`);
    expect(output).toContain("Live runtime:    stopped; snapshot fields below are historical until the daemon restarts");
    expect(output).toContain("Snapshot note:  live PID inspection reports runtime stopped");
    expect(output).toContain("Process alive:   failed");
    expect(output).toContain("KPI snapshot:    process=down accept=up execute=up (failed)");
    expect(output).toContain("Summary:        dead but resumable");
    expect(output).not.toContain("Summary:        unknown");
    expect(output).toContain(`Process:        dead pid=${stalePid}`);
    expect(output).toContain("Artifact fresh: missing; evidence=");
    expect(output).toContain("Artifact stream: unknown (historical_runtime_snapshot)");
    expect(output).toContain("Historical child activity: active count=2; evidence=");
    expect(output).toContain("(stale snapshot)");
    expect(output).not.toContain("Process alive:   ok");
    expect(output).not.toContain(`Process:        alive pid=${stalePid}`);
  });

  it("shows in-flight worker progress from supervisor state when loops are still zero", async () => {
    const now = Date.now();
    fs.mkdirSync(path.join(tmpDir, "runtime"), { recursive: true });
    await saveSupervisorStateFixture(tmpDir, {
        workers: [
          {
            workerId: "worker-1",
            goalId: "goal-live",
            startedAt: now - 20_000,
            iterations: 0,
          },
        ],
        crashCounts: {},
        suspendedGoals: [],
        updatedAt: now,
      });
    await saveDaemonStateFixture(tmpDir, {
        pid: process.pid,
        started_at: new Date(now - 60_000).toISOString(),
        last_loop_at: null,
        loop_count: 0,
        active_goals: ["goal-live"],
        status: "running",
        crash_count: 0,
        last_error: null,
      });
    fs.writeFileSync(
      path.join(tmpDir, "pulseed.pid"),
      JSON.stringify({
        pid: process.pid,
        runtime_pid: process.pid,
        owner_pid: process.pid,
        started_at: new Date(now).toISOString(),
      })
    );
    const inspectSpy = mockPidInspectRunning(process.pid);

    await cmdDaemonStatus([]);
    inspectSpy.mockRestore();

    const output = consoleSpy.mock.calls[0]?.[0] as string;
    expect(output).toContain("Loops:           0 cycles completed");
    expect(output).toContain("In flight:       1 worker active");
    expect(output).toContain("Worker worker-1: goal-live");
  });

  it("labels stale in-flight worker state as historical when the runtime is stopped", async () => {
    const now = Date.now();
    fs.mkdirSync(path.join(tmpDir, "runtime"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "tasks", "goal-stale", "ledger"), { recursive: true });
    await saveSupervisorStateFixture(tmpDir, {
        workers: [
          {
            workerId: "worker-stale",
            goalId: "goal-stale",
            startedAt: now - 20_000,
            iterations: 0,
          },
        ],
        crashCounts: {},
        suspendedGoals: [],
        updatedAt: now,
      });
    await saveRuntimeHealthFixture(
      tmpDir,
      {
        status: "ok",
        leader: true,
        checked_at: now - 15_000,
        kpi: {
          process_alive: { status: "ok", checked_at: now - 15_000, last_ok_at: now - 15_000 },
          command_acceptance: { status: "ok", checked_at: now - 15_000, last_ok_at: now - 15_000 },
          task_execution: { status: "ok", checked_at: now - 15_000, last_ok_at: now - 15_000 },
        },
        long_running: {
          summary: "alive_but_waiting",
          checked_at: now - 15_000,
          signals: {
            process: { status: "alive", checked_at: now - 15_000, observed_at: now - 15_000, pid: 999999999 },
            child_activity: { status: "active", checked_at: now - 15_000, observed_at: now - 15_000, active_count: 3 },
            log_freshness: { status: "fresh", checked_at: now - 15_000, observed_at: now - 15_000 },
            artifact_freshness: { status: "fresh", checked_at: now - 15_000, observed_at: now - 15_000 },
            metric_freshness: { status: "fresh", checked_at: now - 15_000, observed_at: now - 15_000 },
            metric_progress: { status: "plateau", checked_at: now - 15_000, observed_at: now - 15_000 },
            blocker: { status: "none", checked_at: now - 15_000, observed_at: now - 15_000 },
            resumable: true,
          },
        },
        details: { pid: 999999999 },
      },
      {
        checked_at: now - 15_000,
        components: {
          gateway: "ok",
          queue: "ok",
          leases: "ok",
          approval: "ok",
          outbox: "ok",
          supervisor: "ok",
        },
      }
    );
    await saveDaemonStateFixture(tmpDir, {
        pid: 999999999,
        started_at: new Date(now - 60_000).toISOString(),
        last_loop_at: new Date(now - 15_000).toISOString(),
        loop_count: 0,
        active_goals: ["goal-stale"],
        status: "stopped",
        crash_count: 0,
        last_error: null,
      });
    await saveShutdownMarkerFixture(tmpDir, {
        goal_ids: ["goal-stale"],
        loop_index: 0,
        timestamp: new Date(now - 5_000).toISOString(),
        reason: "stop",
        state: "clean_shutdown",
      });
    await new GoalTaskStateStore(tmpDir).saveTaskOutcomeLedger({
        task_id: "task-stale",
        goal_id: "goal-stale",
        events: [
          { type: "acked", ts: new Date(now - 30_000).toISOString() },
          { type: "started", ts: new Date(now - 25_000).toISOString() },
        ],
        summary: {
          latest_event_type: "started",
          latencies: {},
        },
      });

    await cmdDaemonStatus([]);

    const output = consoleSpy.mock.calls[0]?.[0] as string;
    expect(output).not.toContain("In flight:");
    expect(output).toContain("Live runtime:    stopped; snapshot fields below are historical until the daemon restarts");
    expect(output).toContain("Historical active goals: goal-stale");
    expect(output).toContain("Historical in-flight: 1 stale worker from stopped snapshot");
    expect(output).toContain("last observed");
    expect(output).toContain(`stopped ${new Date(now - 5_000).toISOString()}`);
    expect(output).toContain("checked");
    expect(output).toContain("Stale worker worker-stale: goal-stale");
    expect(output).toContain("Historical child activity: active count=3; evidence=");
    expect(output).toContain("(stale snapshot)");
    expect(output).toContain("Task KPIs:");
    expect(output).toContain("Historical in-flight: 1/1 (stale snapshot)");
    expect(output).not.toContain("Worker worker-stale");
  });

  it("shows idle status and watchdog PID when the daemon is running without goals", async () => {
    const runtimePid = process.pid;
    const watchdogPid = 424242;
    const state = {
      pid: runtimePid,
      started_at: new Date(Date.now() - 30_000).toISOString(),
      last_loop_at: null,
      loop_count: 0,
      active_goals: [],
      status: "idle",
      crash_count: 0,
      last_error: null,
    };
    await saveDaemonStateFixture(tmpDir, state);
    fs.writeFileSync(
      path.join(tmpDir, "pulseed.pid"),
      JSON.stringify({
        pid: runtimePid,
        runtime_pid: runtimePid,
        owner_pid: watchdogPid,
        watchdog_pid: watchdogPid,
        started_at: new Date().toISOString(),
      })
    );
    const inspectSpy = mockPidInspectRunning(runtimePid, watchdogPid);

    await cmdDaemonStatus([]);
    inspectSpy.mockRestore();

    const output = consoleSpy.mock.calls[0]?.[0] as string;
    expect(output).toContain(`idle (PID: ${runtimePid})`);
    expect(output).toContain(`Watchdog PID:    ${watchdogPid}`);
    expect(output).toContain("Active goals:    (none)");
  });

  it("shows restarting status when the watchdog is alive but the runtime child is dead", async () => {
    const runtimePid = 999999999;
    const watchdogPid = process.pid;
    const state = {
      pid: runtimePid,
      started_at: new Date(Date.now() - 30_000).toISOString(),
      last_loop_at: null,
      loop_count: 0,
      active_goals: [],
      status: "running",
      crash_count: 0,
      last_error: null,
    };
    await saveDaemonStateFixture(tmpDir, state);
    fs.writeFileSync(
      path.join(tmpDir, "pulseed.pid"),
      JSON.stringify({
        pid: runtimePid,
        runtime_pid: runtimePid,
        owner_pid: watchdogPid,
        watchdog_pid: watchdogPid,
        started_at: new Date().toISOString(),
      })
    );
    const inspectSpy = vi.spyOn(PIDManager.prototype, "inspect").mockResolvedValue({
      info: {
        pid: runtimePid,
        runtime_pid: runtimePid,
        owner_pid: watchdogPid,
        watchdog_pid: watchdogPid,
        started_at: new Date().toISOString(),
        runtime_started_at: new Date().toISOString(),
        owner_started_at: new Date().toISOString(),
        watchdog_started_at: new Date().toISOString(),
      },
      running: true,
      runtimePid,
      ownerPid: watchdogPid,
      alivePids: [watchdogPid],
      stalePids: [runtimePid],
      verifiedPids: [watchdogPid],
      unverifiedLegacyPids: [],
    });

    await cmdDaemonStatus([]);
    inspectSpy.mockRestore();

    const output = consoleSpy.mock.calls[0]?.[0] as string;
    expect(output).toContain(`restarting (PID: ${runtimePid})`);
    expect(output).toContain(`Watchdog PID:    ${watchdogPid}`);
  });

  it("shows resident activity when the daemon has autonomous work history", async () => {
    const state = {
      pid: process.pid,
      started_at: new Date(Date.now() - 60_000).toISOString(),
      last_loop_at: null,
      loop_count: 1,
      active_goals: ["resident-goal"],
      status: "running",
      crash_count: 0,
      last_error: null,
      last_resident_at: new Date(Date.now() - 5_000).toISOString(),
      resident_activity: {
        kind: "negotiation",
        trigger: "proactive_tick",
        summary: "Resident discovery negotiated a new goal: Add resident daemon coverage",
        recorded_at: new Date(Date.now() - 5_000).toISOString(),
        suggestion_title: "Add resident daemon coverage",
        goal_id: "resident-goal",
      },
    };
    await saveDaemonStateFixture(tmpDir, state);
    fs.writeFileSync(
      path.join(tmpDir, "pulseed.pid"),
      JSON.stringify({
        pid: process.pid,
        runtime_pid: process.pid,
        owner_pid: process.pid,
        started_at: new Date().toISOString(),
      })
    );
    const inspectSpy = mockPidInspectRunning(process.pid);

    await cmdDaemonStatus([]);
    inspectSpy.mockRestore();

    const output = consoleSpy.mock.calls[0]?.[0] as string;
    expect(output).toContain("Resident:        negotiation");
    expect(output).toContain("Resident note:   Resident discovery negotiated a new goal");
    expect(output).toContain("Resident goal:   resident-goal");
  });

  it("shows proactive quality summary when feedback history exists", async () => {
    const state = {
      pid: process.pid,
      started_at: new Date(Date.now() - 60_000).toISOString(),
      last_loop_at: null,
      loop_count: 1,
      active_goals: ["resident-goal"],
      status: "running",
      crash_count: 0,
      last_error: null,
      last_resident_at: new Date(Date.now() - 5_000).toISOString(),
      resident_activity: {
        intervention_id: "resident-feedback-status",
        kind: "suggestion",
        trigger: "proactive_tick",
        summary: "Resident suggested a new goal.",
        recorded_at: new Date(Date.now() - 5_000).toISOString(),
        goal_id: "resident-goal",
      } as const,
    };
    await saveDaemonStateFixture(tmpDir, state);
    fs.writeFileSync(
      path.join(tmpDir, "pulseed.pid"),
      JSON.stringify({
        pid: process.pid,
        runtime_pid: process.pid,
        owner_pid: process.pid,
        started_at: new Date().toISOString(),
      })
    );
    const store = new ProactiveInterventionStore(path.join(tmpDir, "runtime"));
    await store.appendIntervention({
      activity: state.resident_activity,
    });
    await store.appendFeedback({
      interventionId: "resident-feedback-status",
      outcome: "accepted",
      recordedAt: new Date().toISOString(),
    });
    const inspectSpy = mockPidInspectRunning(process.pid);

    await cmdDaemonStatus([]);
    inspectSpy.mockRestore();

    const output = consoleSpy.mock.calls[0]?.[0] as string;
    expect(output).toContain("Resident event:  resident-feedback-status");
    expect(output).toContain("Proactive quality:");
    expect(output).toContain("Accepted:      1");
  });

  it("uses the persisted daemon runtime root before daemon config for runtime-root-backed status stores", async () => {
    const actualRuntimeRoot = path.join(tmpDir, "actual-runtime");
    fs.writeFileSync(
      path.join(tmpDir, "daemon.json"),
      JSON.stringify({ runtime_root: "configured-runtime" }),
      "utf-8"
    );
    await saveDaemonStateFixture(tmpDir, runningDaemonState({
      runtime_root: actualRuntimeRoot,
      active_goals: ["resident-goal"],
      resident_activity: {
        intervention_id: "persisted-root-intervention",
        kind: "suggestion",
        trigger: "proactive_tick",
        summary: "Resident suggested a root-specific goal.",
        recorded_at: new Date(Date.now() - 5_000).toISOString(),
        goal_id: "resident-goal",
      },
    }));
    fs.writeFileSync(
      path.join(tmpDir, "pulseed.pid"),
      JSON.stringify({
        pid: process.pid,
        runtime_pid: process.pid,
        owner_pid: process.pid,
        started_at: new Date().toISOString(),
      })
    );
    const store = new ProactiveInterventionStore(actualRuntimeRoot, { controlBaseDir: tmpDir });
    await store.appendIntervention({
      activity: {
        intervention_id: "persisted-root-intervention",
        kind: "suggestion",
        trigger: "proactive_tick",
        summary: "Resident suggested a root-specific goal.",
        recorded_at: new Date(Date.now() - 5_000).toISOString(),
        goal_id: "resident-goal",
      },
    });
    await store.appendFeedback({
      interventionId: "persisted-root-intervention",
      outcome: "accepted",
      recordedAt: new Date().toISOString(),
    });
    const inspectSpy = mockPidInspectRunning(process.pid);

    await cmdDaemonStatus([]);
    inspectSpy.mockRestore();

    const output = consoleSpy.mock.calls[0]?.[0] as string;
    expect(output).toContain("Resident event:  persisted-root-intervention");
    expect(output).toContain("Proactive quality:");
    expect(output).toContain("Accepted:      1");
  });

  it("shows dream resident activity without requiring a goal id", async () => {
    const state = {
      pid: process.pid,
      started_at: new Date(Date.now() - 60_000).toISOString(),
      last_loop_at: null,
      loop_count: 1,
      active_goals: [],
      status: "idle",
      crash_count: 0,
      last_error: null,
      last_resident_at: new Date(Date.now() - 5_000).toISOString(),
      resident_activity: {
        kind: "dream",
        trigger: "proactive_tick",
        summary: "Resident dream applied pending suggestion \"Dream resident schedule\" into schedule schedule-entry-1.",
        recorded_at: new Date(Date.now() - 5_000).toISOString(),
      },
    };
    await saveDaemonStateFixture(tmpDir, state);
    fs.writeFileSync(
      path.join(tmpDir, "pulseed.pid"),
      JSON.stringify({
        pid: process.pid,
        runtime_pid: process.pid,
        owner_pid: process.pid,
        started_at: new Date().toISOString(),
      })
    );
    const inspectSpy = mockPidInspectRunning(process.pid);

    await cmdDaemonStatus([]);
    inspectSpy.mockRestore();

    const output = consoleSpy.mock.calls[0]?.[0] as string;
    expect(output).toContain("Resident:        dream");
    expect(output).toContain("Resident note:   Resident dream applied pending suggestion");
    expect(output).not.toContain("Resident goal:");
  });

  it("shows last_error when present", async () => {
    const state = {
      pid: 999999999,
      started_at: "2026-01-01T00:00:00.000Z",
      last_loop_at: null,
      loop_count: 0,
      active_goals: [],
      status: "crashed",
      crash_count: 3,
      last_error: "something went wrong",
    };
    await saveDaemonStateFixture(tmpDir, state);

    await cmdDaemonStatus([]);

    const output = consoleSpy.mock.calls[0]?.[0] as string;
    expect(output).toContain("Last error:      something went wrong");
  });

  it("handles empty active_goals gracefully", async () => {
    const state = {
      pid: 999999999,
      started_at: "2026-01-01T00:00:00.000Z",
      last_loop_at: null,
      loop_count: 0,
      active_goals: [],
      status: "stopped",
      crash_count: 0,
      last_error: null,
    };
    await saveDaemonStateFixture(tmpDir, state);

    await cmdDaemonStatus([]);

    const output = consoleSpy.mock.calls[0]?.[0] as string;
    expect(output).toContain("Historical active goals: (none)");
  });

  it("shows header and separator", async () => {
    const state = {
      pid: 999999999,
      started_at: "2026-01-01T00:00:00.000Z",
      last_loop_at: null,
      loop_count: 0,
      active_goals: [],
      status: "stopped",
      crash_count: 0,
      last_error: null,
    };
    await saveDaemonStateFixture(tmpDir, state);

    await cmdDaemonStatus([]);

    const output = consoleSpy.mock.calls[0]?.[0] as string;
    expect(output).toContain("PulSeed Daemon Status");
    expect(output).toContain("\u2500".repeat(21));
  });

  it("shows config section with defaults when no config file", async () => {
    const state = {
      pid: 999999999,
      started_at: "2026-01-01T00:00:00.000Z",
      last_loop_at: null,
      loop_count: 0,
      active_goals: [],
      status: "stopped",
      crash_count: 0,
      last_error: null,
    };
    await saveDaemonStateFixture(tmpDir, state);

    await cmdDaemonStatus([]);

    const output = consoleSpy.mock.calls[0]?.[0] as string;
    expect(output).toContain("Config:");
    expect(output).toContain("5m (adaptive sleep: off)");
    expect(output).toContain("resident (unbounded; iterations reported as telemetry)");
    expect(output).toContain("10 iteration telemetry window");
    expect(output).toContain("Proactive:     off");
    expect(output).toContain("Runtime:       durable auto-recovery");
    expect(output).toContain("enabled");
  });

  it("reads config file when present and shows its values", async () => {
    const state = {
      pid: 999999999,
      started_at: "2026-01-01T00:00:00.000Z",
      last_loop_at: null,
      loop_count: 0,
      active_goals: [],
      status: "stopped",
      crash_count: 0,
      last_error: null,
    };
    const config = {
      check_interval_ms: 120_000, // 2 min
      iterations_per_cycle: 5,
      proactive_mode: true,
      runtime_journal_v2: true,
      runtime_root: "/tmp/pulseed-runtime",
      adaptive_sleep: { enabled: true },
      crash_recovery: { enabled: true, max_retries: 5 },
    };
    await saveDaemonStateFixture(tmpDir, state);
    fs.writeFileSync(path.join(tmpDir, "daemon-config.json"), JSON.stringify(config));

    await cmdDaemonStatus([]);

    const output = consoleSpy.mock.calls[0]?.[0] as string;
    expect(output).toContain("2m (adaptive sleep: on)");
    expect(output).toContain("bounded (5 iterations max)");
    expect(output).toContain("5 iterations max");
    expect(output).toContain("Proactive:     on");
    expect(output).toContain("Runtime:       durable auto-recovery");
    expect(output).toContain("/tmp/pulseed-runtime");
    expect(output).toContain("0/5 retries used");
  });

  it("falls back to daemon.json when daemon-config.json is absent", async () => {
    const state = {
      pid: 999999999,
      started_at: "2026-01-01T00:00:00.000Z",
      last_loop_at: null,
      loop_count: 0,
      active_goals: [],
      status: "stopped",
      crash_count: 0,
      last_error: null,
    };
    const config = {
      check_interval_ms: 180_000,
      iterations_per_cycle: 3,
      runtime_journal_v2: true,
    };
    await saveDaemonStateFixture(tmpDir, state);
    fs.writeFileSync(path.join(tmpDir, "daemon.json"), JSON.stringify(config));

    await cmdDaemonStatus([]);

    const output = consoleSpy.mock.calls[0]?.[0] as string;
    expect(output).toContain("3m (adaptive sleep: off)");
    expect(output).toContain("bounded (3 iterations max)");
    expect(output).toContain("3 iterations max");
    expect(output).toContain("Runtime:       durable auto-recovery");
  });

  it("prefers daemon.json over daemon-config.json when both exist", async () => {
    const state = {
      pid: 999999999,
      started_at: "2026-01-01T00:00:00.000Z",
      last_loop_at: null,
      loop_count: 0,
      active_goals: [],
      status: "stopped",
      crash_count: 0,
      last_error: null,
    };
    await saveDaemonStateFixture(tmpDir, state);
    fs.writeFileSync(
      path.join(tmpDir, "daemon.json"),
      JSON.stringify({ iterations_per_cycle: 7, runtime_journal_v2: true })
    );
    fs.writeFileSync(
      path.join(tmpDir, "daemon-config.json"),
      JSON.stringify({ iterations_per_cycle: 2, runtime_journal_v2: false })
    );

    await cmdDaemonStatus([]);

    const output = consoleSpy.mock.calls[0]?.[0] as string;
    expect(output).toContain("bounded (7 iterations max)");
    expect(output).toContain("7 iterations max");
    expect(output).toContain("Runtime:       durable auto-recovery");
  });

  it("falls back before parsing oversized daemon.json config", async () => {
    const state = {
      pid: 999999999,
      started_at: "2026-01-01T00:00:00.000Z",
      last_loop_at: null,
      loop_count: 0,
      active_goals: [],
      status: "stopped",
      crash_count: 0,
      last_error: null,
    };
    await saveDaemonStateFixture(tmpDir, state);
    fs.writeFileSync(path.join(tmpDir, "daemon.json"), `{ "padding": "${"x".repeat(1024 * 1024)}" }`);
    fs.writeFileSync(
      path.join(tmpDir, "daemon-config.json"),
      JSON.stringify({ iterations_per_cycle: 4, runtime_journal_v2: true })
    );

    await cmdDaemonStatus([]);

    const output = consoleSpy.mock.calls[0]?.[0] as string;
    expect(output).toContain("bounded (4 iterations max)");
    expect(output).toContain("4 iterations max");
    expect(output).toContain("Runtime:       durable auto-recovery");
  });

  it("shows last cycle relative time when last_loop_at is present", async () => {
    const lastLoop = new Date(Date.now() - 3 * 60 * 1000).toISOString(); // 3 minutes ago
    const state = {
      pid: 999999999,
      started_at: "2026-01-01T00:00:00.000Z",
      last_loop_at: lastLoop,
      loop_count: 7,
      active_goals: ["goal-z"],
      status: "stopped",
      crash_count: 0,
      last_error: null,
    };
    await saveDaemonStateFixture(tmpDir, state);

    await cmdDaemonStatus([]);

    const output = consoleSpy.mock.calls[0]?.[0] as string;
    expect(output).toContain("Last cycle:");
    expect(output).toMatch(/\d+m ago/);
  });

  it("shows 'Last error: none' when no error", async () => {
    const state = {
      pid: 999999999,
      started_at: "2026-01-01T00:00:00.000Z",
      last_loop_at: null,
      loop_count: 0,
      active_goals: [],
      status: "stopped",
      crash_count: 0,
      last_error: null,
    };
    await saveDaemonStateFixture(tmpDir, state);

    await cmdDaemonStatus([]);

    const output = consoleSpy.mock.calls[0]?.[0] as string;
    expect(output).toContain("Last error:      none");
  });
});
