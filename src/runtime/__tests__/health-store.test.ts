import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import { RuntimeHealthStore } from "../store/health-store.js";
import { makeTempDir, cleanupTempDir } from "../../../tests/helpers/temp-dir.js";
import {
  RuntimeHealthSnapshotSchema,
  buildLongRunHealth,
  evolveRuntimeHealthKpi,
  type RuntimeLongRunHealthSignals,
} from "../store/runtime-schemas.js";

function longRunSignals(overrides: Partial<RuntimeLongRunHealthSignals>): RuntimeLongRunHealthSignals {
  const checkedAt = 1_000;
  return {
    process: { status: "alive", checked_at: checkedAt, observed_at: checkedAt, pid: 123 },
    child_activity: { status: "active", checked_at: checkedAt, observed_at: checkedAt, active_count: 1 },
    log_freshness: { status: "fresh", checked_at: checkedAt, observed_at: checkedAt, path: "coreloop.log" },
    artifact_freshness: { status: "fresh", checked_at: checkedAt, observed_at: checkedAt, path: "result.json" },
    metric_freshness: { status: "fresh", checked_at: checkedAt, observed_at: checkedAt, metric_name: "score" },
    metric_progress: {
      status: "unknown",
      checked_at: checkedAt,
      observed_at: checkedAt,
      metric_name: "score",
    },
    blocker: { status: "none", checked_at: checkedAt, observed_at: checkedAt },
    resumable: true,
    ...overrides,
  };
}

describe("RuntimeHealthStore", () => {
  let tmpDir: string;
  let store: RuntimeHealthStore;

  beforeEach(() => {
    tmpDir = makeTempDir();
    store = new RuntimeHealthStore(tmpDir);
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  it("saves and loads a combined health snapshot", async () => {
    const snapshot = RuntimeHealthSnapshotSchema.parse({
      status: "degraded",
      leader: true,
      checked_at: 123,
      components: {
        gateway: "ok",
        queue: "degraded",
      },
      kpi: evolveRuntimeHealthKpi(null, {
        process_alive: "ok",
        command_acceptance: "degraded",
        task_execution: "ok",
      }, 123),
      details: { lag: 3 },
    });

    await store.saveSnapshot(snapshot);
    const daemonPath = path.join(tmpDir, "health", "daemon.json");
    const componentsPath = path.join(tmpDir, "health", "components.json");

    expect(fs.existsSync(daemonPath)).toBe(true);
    expect(fs.existsSync(componentsPath)).toBe(true);

    const loaded = await store.loadSnapshot();
    expect(loaded).toMatchObject({
      status: snapshot.status,
      leader: snapshot.leader,
      checked_at: snapshot.checked_at,
      components: snapshot.components,
      details: snapshot.details,
    });
    expect(loaded?.kpi?.command_acceptance.status).toBe("degraded");
  });

  it("returns null for a partial health state", async () => {
    await store.saveDaemonHealth({
      status: "ok",
      leader: false,
      checked_at: 1,
    });
    expect(await store.loadSnapshot()).toBeNull();
  });

  it("loads the individual health records", async () => {
    await store.saveDaemonHealth({
      status: "ok",
      leader: true,
      checked_at: 1,
      kpi: evolveRuntimeHealthKpi(null, {
        process_alive: "ok",
        command_acceptance: "ok",
        task_execution: "ok",
      }, 1),
    });
    await store.saveComponentsHealth({
      checked_at: 2,
      components: { gateway: "ok", queue: "ok" },
    });

    expect(await store.loadDaemonHealth()).toMatchObject({ leader: true });
    expect(await store.loadComponentsHealth()).toMatchObject({ components: { gateway: "ok" } });
  });

  it("rejects unsafe health timestamps before persistence", async () => {
    const unsafeInteger = Number.MAX_SAFE_INTEGER + 1;

    await expect(store.saveDaemonHealth({
      status: "ok",
      leader: true,
      checked_at: unsafeInteger,
    })).rejects.toThrow();
    expect(fs.existsSync(path.join(tmpDir, "health", "daemon.json"))).toBe(false);

    await expect(store.saveComponentsHealth({
      checked_at: unsafeInteger,
      components: { gateway: "ok" },
    })).rejects.toThrow();
    expect(fs.existsSync(path.join(tmpDir, "health", "components.json"))).toBe(false);

    await expect(store.saveSnapshot({
      status: "ok",
      leader: true,
      checked_at: 1,
      components: { gateway: "ok" },
      kpi: {
        process_alive: { status: "ok", checked_at: unsafeInteger },
        command_acceptance: { status: "ok", checked_at: 1 },
        task_execution: { status: "ok", checked_at: 1 },
      },
    })).rejects.toThrow();
    expect(fs.existsSync(path.join(tmpDir, "health", "daemon.json"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "health", "components.json"))).toBe(false);
  });

  it("skips persisted health records with unsafe timestamps", async () => {
    fs.mkdirSync(path.join(tmpDir, "health"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "health", "daemon.json"), JSON.stringify({
      status: "ok",
      leader: true,
      checked_at: Number.MAX_SAFE_INTEGER + 1,
    }), "utf-8");
    fs.writeFileSync(path.join(tmpDir, "health", "components.json"), JSON.stringify({
      checked_at: Number.MAX_SAFE_INTEGER + 1,
      components: { gateway: "ok" },
    }), "utf-8");

    await expect(store.loadDaemonHealth()).resolves.toBeNull();
    await expect(store.loadComponentsHealth()).resolves.toBeNull();
    await expect(store.loadSnapshot()).resolves.toBeNull();
  });

  it("rejects unsafe long-running health counters through snapshot persistence", async () => {
    const unsafeInteger = Number.MAX_SAFE_INTEGER + 1;

    await expect(store.saveSnapshot({
      status: "ok",
      leader: true,
      checked_at: 1,
      components: { gateway: "ok" },
      long_running: {
        summary: "alive_and_progressing",
        checked_at: 1,
        signals: longRunSignals({
          child_activity: {
            status: "active",
            checked_at: 1,
            observed_at: 1,
            active_count: unsafeInteger,
          },
        }),
      },
    })).rejects.toThrow();

    expect(fs.existsSync(path.join(tmpDir, "health", "daemon.json"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "health", "components.json"))).toBe(false);
  });

  it("rejects non-finite long-running metric values before JSON persistence", async () => {
    await expect(store.saveSnapshot({
      status: "ok",
      leader: true,
      checked_at: 1,
      components: { gateway: "ok" },
      long_running: {
        summary: "alive_and_progressing",
        checked_at: 1,
        signals: longRunSignals({
          metric_progress: {
            status: "improved",
            checked_at: 1,
            observed_at: 1,
            metric_name: "score",
            previous_value: 0.7,
            current_value: Infinity,
          },
        }),
      },
    })).rejects.toThrow();

    expect(fs.existsSync(path.join(tmpDir, "health", "daemon.json"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "health", "components.json"))).toBe(false);
  });

  it("rejects unsafe long-running metric values before JSON persistence", async () => {
    await expect(store.saveSnapshot({
      status: "ok",
      leader: true,
      checked_at: 1,
      components: { gateway: "ok" },
      long_running: {
        summary: "alive_and_progressing",
        checked_at: 1,
        signals: longRunSignals({
          metric_progress: {
            status: "improved",
            checked_at: 1,
            observed_at: 1,
            metric_name: "score",
            previous_value: 0.7,
            current_value: Number.MAX_SAFE_INTEGER + 1,
          },
        }),
      },
    })).rejects.toThrow();

    expect(fs.existsSync(path.join(tmpDir, "health", "daemon.json"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "health", "components.json"))).toBe(false);
  });

  it("preserves KPI data when repairing a partial snapshot", async () => {
    await store.saveDaemonHealth({
      status: "degraded",
      leader: true,
      checked_at: 50,
      kpi: evolveRuntimeHealthKpi(null, {
        process_alive: "ok",
        command_acceptance: "degraded",
        task_execution: "ok",
      }, 50),
    });

    const repaired = await store.reconcile(100);
    expect(repaired.kpi).toBeDefined();
    expect(repaired.kpi?.command_acceptance.status).toBe("degraded");
  });

  it("classifies alive runs with no new artifacts as artifact-stalled", () => {
    const health = buildLongRunHealth(longRunSignals({
      artifact_freshness: { status: "stale", checked_at: 2_000, observed_at: 1_000, path: "result.json" },
      metric_freshness: { status: "stale", checked_at: 2_000, observed_at: 1_000, metric_name: "score" },
      metric_progress: { status: "unknown", checked_at: 2_000, observed_at: 1_000, metric_name: "score" },
    }));

    expect(health.summary).toBe("alive_but_artifact_stalled");
    expect(health.signals.process.status).toBe("alive");
    expect(health.signals.artifact_freshness.observed_at).toBe(1_000);
  });

  it("classifies alive runs with a new artifact but no metric improvement as metric-stalled", () => {
    const health = buildLongRunHealth(longRunSignals({
      artifact_freshness: { status: "fresh", checked_at: 2_000, observed_at: 2_000, path: "result.json" },
      metric_progress: {
        status: "plateau",
        checked_at: 2_000,
        observed_at: 2_000,
        metric_name: "score",
        previous_value: 0.7,
        current_value: 0.7,
      },
    }));

    expect(health.summary).toBe("alive_but_metric_stalled");
    expect(health.signals.metric_progress.previous_value).toBe(0.7);
  });

  it("classifies alive runs with an improved metric as progressing", () => {
    const health = buildLongRunHealth(longRunSignals({
      metric_progress: {
        status: "improved",
        checked_at: 2_000,
        observed_at: 2_000,
        metric_name: "score",
        previous_value: 0.7,
        current_value: 0.73,
      },
    }));

    expect(health.summary).toBe("alive_and_progressing");
  });

  it("classifies approval waits separately from stalls", () => {
    const health = buildLongRunHealth(longRunSignals({
      artifact_freshness: { status: "stale", checked_at: 2_000, observed_at: 1_000, path: "result.json" },
      metric_progress: { status: "plateau", checked_at: 2_000, observed_at: 1_000, metric_name: "score" },
      blocker: {
        status: "approval_wait",
        checked_at: 2_000,
        observed_at: 2_000,
        reason: "submission requires operator approval",
      },
    }));

    expect(health.summary).toBe("alive_but_waiting");
    expect(health.signals.blocker.status).toBe("approval_wait");
  });

  it("persists long-running health alongside daemon health", async () => {
    const longRunning = buildLongRunHealth(longRunSignals({
      metric_progress: { status: "improved", checked_at: 2_000, observed_at: 2_000, metric_name: "score" },
    }));
    await store.saveSnapshot(RuntimeHealthSnapshotSchema.parse({
      status: "ok",
      leader: true,
      checked_at: 2_000,
      components: { gateway: "ok" },
      long_running: longRunning,
    }));

    const loaded = await store.loadSnapshot();
    expect(loaded?.long_running?.summary).toBe("alive_and_progressing");
    expect(loaded?.long_running?.signals.metric_progress.observed_at).toBe(2_000);
  });
});
