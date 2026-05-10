import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeHealthSnapshot } from "../../../runtime/store/runtime-schemas.js";
import {
  LIVE_RUNTIME_OVERRIDES_STALE_HEALTH_REASON,
  STALE_RUNTIME_HEALTH_REASON,
  formatHistoricalSnapshotContext,
  parseHistoricalObservationTime,
  reconcileRuntimeHealthForDisplay,
} from "../commands/daemon-status-health.js";

function runtimeHealthSnapshot(pid = 12345): RuntimeHealthSnapshot {
  const observedAt = Date.parse("2026-05-10T00:00:00.000Z");
  return {
    status: "ok",
    leader: true,
    checked_at: observedAt,
    components: {
      gateway: "ok",
    },
    kpi: {
      process_alive: {
        status: "ok",
        checked_at: observedAt,
        last_ok_at: observedAt,
      },
      command_acceptance: {
        status: "ok",
        checked_at: observedAt,
        last_ok_at: observedAt,
      },
      task_execution: {
        status: "ok",
        checked_at: observedAt,
        last_ok_at: observedAt,
      },
    },
    long_running: {
      summary: "alive_and_progressing",
      checked_at: observedAt,
      signals: {
        process: {
          status: "alive",
          checked_at: observedAt,
          observed_at: observedAt,
          pid,
        },
        child_activity: {
          status: "active",
          checked_at: observedAt,
          observed_at: observedAt,
          active_count: 1,
        },
        log_freshness: {
          status: "fresh",
          checked_at: observedAt,
          observed_at: observedAt,
          path: "runtime.log",
        },
        artifact_freshness: {
          status: "fresh",
          checked_at: observedAt,
          observed_at: observedAt,
        },
        metric_freshness: {
          status: "fresh",
          checked_at: observedAt,
          observed_at: observedAt,
          metric_name: "success_rate",
        },
        metric_progress: {
          status: "improved",
          checked_at: observedAt,
          observed_at: observedAt,
          metric_name: "success_rate",
          direction: "maximize",
          previous_value: 0.5,
          current_value: 0.75,
        },
        blocker: {
          status: "none",
          checked_at: observedAt,
          observed_at: observedAt,
        },
        resumable: true,
      },
    },
  };
}

describe("daemon status health helpers", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("parses valid historical observation timestamps and ignores invalid values", () => {
    expect(parseHistoricalObservationTime("2026-05-10T00:00:00.000Z")).toBe(Date.parse("2026-05-10T00:00:00.000Z"));
    expect(parseHistoricalObservationTime("not-a-date")).toBeUndefined();
    expect(parseHistoricalObservationTime(null)).toBeUndefined();
  });

  it("formats historical snapshot context with observed, stopped, and checked times", () => {
    const rendered = formatHistoricalSnapshotContext({
      lastObservedAt: Date.parse("2026-05-10T00:00:00.000Z"),
      stoppedAt: "2026-05-10T00:05:00.000Z",
      checkedAt: Date.parse("2026-05-10T00:10:00.000Z"),
    });

    expect(rendered).toContain("historical snapshot");
    expect(rendered).toContain("last observed 2026-05-10T00:00:00.000Z");
    expect(rendered).toContain("stopped 2026-05-10T00:05:00.000Z");
    expect(rendered).toContain("checked 2026-05-10T00:10:00.000Z");
  });

  it("marks stored runtime health as historical when live PID inspection reports stopped", () => {
    const now = Date.parse("2026-05-10T01:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const reconciled = reconcileRuntimeHealthForDisplay(runtimeHealthSnapshot(4321), {
      runtimeAlive: false,
      runtimePid: 9999,
    });

    expect(reconciled?.status).toBe("failed");
    expect(reconciled?.checked_at).toBe(now);
    expect(reconciled?.kpi?.process_alive).toMatchObject({
      status: "failed",
      checked_at: now,
      last_failed_at: now,
      reason: STALE_RUNTIME_HEALTH_REASON,
    });
    expect(reconciled?.kpi?.degraded_at).toBe(now);
    expect(reconciled?.long_running?.summary).toBe("dead_but_resumable");
    expect(reconciled?.long_running?.signals.process).toMatchObject({
      status: "dead",
      pid: 9999,
      checked_at: now,
      observed_at: now,
      reason: STALE_RUNTIME_HEALTH_REASON,
    });
  });

  it("leaves stored runtime health unchanged when live PID inspection reports running", () => {
    const snapshot = runtimeHealthSnapshot();
    expect(reconcileRuntimeHealthForDisplay(snapshot, {
      runtimeAlive: true,
      runtimePid: snapshot.long_running?.signals.process.pid ?? null,
    })).toBe(snapshot);
  });

  it("does not mark aggregate failed health as historical when process health is live", () => {
    const snapshot = runtimeHealthSnapshot();
    snapshot.status = "failed";
    snapshot.components.supervisor = "failed";
    if (snapshot.kpi) {
      snapshot.kpi.command_acceptance.status = "failed";
    }

    expect(reconcileRuntimeHealthForDisplay(snapshot, {
      runtimeAlive: true,
      runtimePid: snapshot.long_running?.signals.process.pid ?? null,
    })).toBe(snapshot);
  });

  it("marks dead stored process health as historical when live PID inspection reports running", () => {
    const now = Date.parse("2026-05-10T01:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const snapshot = runtimeHealthSnapshot(4321);
    snapshot.status = "failed";
    if (snapshot.kpi) {
      snapshot.kpi.process_alive.status = "failed";
      snapshot.kpi.process_alive.last_failed_at = Date.parse("2026-05-10T00:00:00.000Z");
    }
    if (snapshot.long_running) {
      snapshot.long_running.summary = "dead_needs_intervention";
      snapshot.long_running.signals.process.status = "dead";
    }

    const reconciled = reconcileRuntimeHealthForDisplay(snapshot, {
      runtimeAlive: true,
      runtimePid: 9999,
    });

    expect(reconciled).not.toBe(snapshot);
    expect(reconciled?.status).toBe("degraded");
    expect(reconciled?.checked_at).toBe(now);
    expect(reconciled?.kpi?.process_alive).toMatchObject({
      status: "ok",
      checked_at: now,
      last_ok_at: now,
      reason: LIVE_RUNTIME_OVERRIDES_STALE_HEALTH_REASON,
    });
    expect(reconciled?.long_running?.summary).toBe("unknown");
    expect(reconciled?.long_running?.signals.process).toMatchObject({
      status: "alive",
      pid: 9999,
      checked_at: now,
      observed_at: now,
      reason: LIVE_RUNTIME_OVERRIDES_STALE_HEALTH_REASON,
    });
  });
});
