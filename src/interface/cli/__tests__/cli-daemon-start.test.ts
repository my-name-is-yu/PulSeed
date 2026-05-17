import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const {
  buildDepsMock,
  daemonStartMock,
  watchdogStartMock,
  scheduleLoadEntriesMock,
  scheduleEnsureSoilPublishScheduleMock,
  scheduleSyncExternalSourcesMock,
  pluginLoadAllMock,
  setRealtimeSinkMock,
  eventServerBroadcastMock,
  eventServerInstances,
  eventServerArgs,
  scheduleEngineArgs,
  daemonRunnerArgs,
  watchdogArgs,
  notificationDispatcherArgs,
  pluginLoaderArgs,
  pidIsRunningMock,
  pidReadPIDMock,
  pidStopRuntimeMock,
  spawnMock,
  spawnOnMock,
  spawnUnrefMock,
  isDaemonRunningMock,
  probeDaemonHealthMock,
  readDaemonAuthTokenMetadataMock,
  cliLoggerMock,
} = vi.hoisted(() => ({
  buildDepsMock: vi.fn(),
  daemonStartMock: vi.fn().mockResolvedValue(undefined),
  watchdogStartMock: vi.fn().mockResolvedValue(undefined),
  scheduleLoadEntriesMock: vi.fn().mockResolvedValue(undefined),
  scheduleEnsureSoilPublishScheduleMock: vi.fn().mockResolvedValue(null),
  scheduleSyncExternalSourcesMock: vi.fn().mockResolvedValue({ added: 0, updated: 0, disabled: 0, skipped: 0, errors: [] }),
  pluginLoadAllMock: vi.fn().mockResolvedValue(undefined),
  setRealtimeSinkMock: vi.fn(),
  eventServerBroadcastMock: vi.fn(),
  eventServerInstances: [] as Array<{ broadcast: ReturnType<typeof vi.fn> }>,
  eventServerArgs: [] as unknown[][],
  scheduleEngineArgs: [] as unknown[],
  daemonRunnerArgs: [] as unknown[],
  watchdogArgs: [] as unknown[],
  notificationDispatcherArgs: [] as unknown[],
  pluginLoaderArgs: [] as unknown[][],
  pidIsRunningMock: vi.fn().mockResolvedValue(false),
  pidReadPIDMock: vi.fn().mockResolvedValue(null),
  pidStopRuntimeMock: vi.fn().mockResolvedValue({
    info: null,
    runtimePid: null,
    ownerPid: null,
    sentSignalsTo: [],
    forced: false,
    stopped: false,
    alivePids: [],
  }),
  spawnMock: vi.fn(),
  spawnOnMock: vi.fn(),
  spawnUnrefMock: vi.fn(),
  isDaemonRunningMock: vi.fn().mockResolvedValue({ running: true, port: 41700 }),
  probeDaemonHealthMock: vi.fn().mockResolvedValue({
    ok: false,
    port: 41700,
    latency_ms: 0,
    error: "connect ECONNREFUSED 127.0.0.1:41700",
  }),
  readDaemonAuthTokenMetadataMock: vi.fn().mockReturnValue(null),
  cliLoggerMock: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    spawn: spawnMock,
  };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    homedir: vi.fn(() => "/tmp/pulseed-daemon-start-test-home"),
  };
});

vi.mock("../../../runtime/daemon/client.js", () => ({
  isDaemonRunning: isDaemonRunningMock,
  probeDaemonHealth: probeDaemonHealthMock,
  readDaemonAuthTokenMetadata: readDaemonAuthTokenMetadataMock,
}));

vi.mock("../setup.js", () => ({
  buildDeps: buildDepsMock,
}));

vi.mock("../../../runtime/daemon/runner.js", () => ({
  DaemonRunner: vi.fn().mockImplementation(function (deps: unknown) {
    daemonRunnerArgs.push(deps);
    return {
      start: daemonStartMock,
    };
  }),
}));

vi.mock("../../../runtime/watchdog.js", () => ({
  DEFAULT_RUNTIME_WATCHDOG_STARTUP_GRACE_MS: 20_000,
  RuntimeWatchdog: vi.fn().mockImplementation(function (args: unknown) {
    watchdogArgs.push(args);
    return {
      start: watchdogStartMock,
    };
  }),
}));

vi.mock("../../../runtime/pid-manager.js", () => ({
  PIDManager: vi.fn().mockImplementation(function () {
    return {
      isRunning: pidIsRunningMock,
      readPID: pidReadPIDMock,
      stopRuntime: pidStopRuntimeMock,
    };
  }),
}));

vi.mock("../../../runtime/logger.js", () => ({
  Logger: vi.fn().mockImplementation(function () {
    return {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
  }),
}));

vi.mock("../cli-logger.js", () => ({
  getCliLogger: vi.fn(() => cliLoggerMock),
}));

vi.mock("../../../runtime/event/server.js", () => ({
  EventServer: vi.fn().mockImplementation(function (...args: unknown[]) {
    eventServerArgs.push(args);
    const instance = {
      broadcast: eventServerBroadcastMock,
    };
    eventServerInstances.push(instance);
    return instance;
  }),
}));

vi.mock("../../../runtime/schedule/engine.js", () => ({
  ScheduleEngine: vi.fn().mockImplementation(function (args: unknown) {
    scheduleEngineArgs.push(args);
    return {
      loadEntries: scheduleLoadEntriesMock,
      syncExternalSources: scheduleSyncExternalSourcesMock,
      ensureSoilPublishSchedule: scheduleEnsureSoilPublishScheduleMock,
    };
  }),
}));

vi.mock("../../../runtime/plugin-loader.js", () => ({
  PluginLoader: vi.fn().mockImplementation(function (...args: unknown[]) {
    pluginLoaderArgs.push(args);
    return {
      loadAll: pluginLoadAllMock,
      getScheduleSources: vi.fn().mockReturnValue([]),
    };
  }),
}));

vi.mock("../../../runtime/notifier-registry.js", () => ({
  NotifierRegistry: vi.fn().mockImplementation(function () {
    return {};
  }),
}));

vi.mock("../../../runtime/notification-dispatcher.js", () => ({
  NotificationDispatcher: vi.fn().mockImplementation(function (...args: unknown[]) {
    notificationDispatcherArgs.push(args);
    return {
      setRealtimeSink: setRealtimeSinkMock,
    };
  }),
}));

vi.mock("../../../orchestrator/execution/adapter-layer.js", () => ({
  AdapterRegistry: vi.fn().mockImplementation(function () {
    return {};
  }),
}));

vi.mock("../../../platform/observation/data-source-adapter.js", () => ({
  DataSourceRegistry: vi.fn().mockImplementation(function () {
    return {};
  }),
}));

import { cmdRestart, cmdStart } from "../commands/daemon.js";
import { dispatchCommand } from "../cli-command-registry.js";
import { CONTROL_DB_SCHEMA_VERSION, openControlDatabase } from "../../../runtime/store/index.js";

describe("cmdStart", () => {
  const mockedHome = "/tmp/pulseed-daemon-start-test-home";

  beforeEach(() => {
    buildDepsMock.mockReset();
    daemonStartMock.mockClear();
    watchdogStartMock.mockClear();
    scheduleLoadEntriesMock.mockClear();
    scheduleEnsureSoilPublishScheduleMock.mockClear();
    scheduleSyncExternalSourcesMock.mockClear();
    pluginLoadAllMock.mockClear();
    setRealtimeSinkMock.mockClear();
    eventServerBroadcastMock.mockClear();
    eventServerInstances.length = 0;
    eventServerArgs.length = 0;
    scheduleEngineArgs.length = 0;
    daemonRunnerArgs.length = 0;
    watchdogArgs.length = 0;
    notificationDispatcherArgs.length = 0;
    pluginLoaderArgs.length = 0;
    pidIsRunningMock.mockReset();
    pidIsRunningMock.mockResolvedValue(false);
    pidReadPIDMock.mockReset();
    pidReadPIDMock.mockResolvedValue(null);
    pidStopRuntimeMock.mockReset();
    pidStopRuntimeMock.mockResolvedValue({
      info: null,
      runtimePid: null,
      ownerPid: null,
      sentSignalsTo: [],
      forced: false,
      stopped: false,
      alivePids: [],
    });
    spawnOnMock.mockClear();
    spawnUnrefMock.mockClear();
    spawnMock.mockReset();
    spawnMock.mockReturnValue({
      pid: 12345,
      on: spawnOnMock,
      unref: spawnUnrefMock,
    });
    isDaemonRunningMock.mockReset();
    isDaemonRunningMock.mockResolvedValue({ running: true, port: 41700 });
    probeDaemonHealthMock.mockReset();
    probeDaemonHealthMock.mockResolvedValue({
      ok: false,
      port: 41700,
      latency_ms: 0,
      error: "connect ECONNREFUSED 127.0.0.1:41700",
    });
    readDaemonAuthTokenMetadataMock.mockReset();
    readDaemonAuthTokenMetadataMock.mockReturnValue(null);
    cliLoggerMock.info.mockClear();
    cliLoggerMock.warn.mockClear();
    cliLoggerMock.error.mockClear();
    delete process.env.PULSEED_WATCHDOG_CHILD;
    fs.rmSync(mockedHome, { recursive: true, force: true });
    fs.rmSync("/tmp/pulseed-daemon-start-base", { recursive: true, force: true });

    buildDepsMock.mockResolvedValue({
      coreLoop: {},
      driveSystem: {},
      stateManager: { getBaseDir: vi.fn().mockReturnValue("/tmp/pulseed-daemon-start-base") },
      llmClient: {},
      reportingEngine: { setNotificationDispatcher: vi.fn() },
      hookManager: { id: "hook-manager" },
      memoryLifecycleManager: { id: "memory" },
      knowledgeManager: { id: "knowledge" },
      adapterRegistry: { id: "adapter-registry" },
      dataSourceRegistry: { id: "data-source-registry" },
      observationEngine: {
        getDataSources: vi.fn().mockReturnValue([]),
        addDataSource: vi.fn(),
      },
    });
  });

  afterEach(() => {
    fs.rmSync(mockedHome, { recursive: true, force: true });
    fs.rmSync("/tmp/pulseed-daemon-start-base", { recursive: true, force: true });
    delete process.env.PULSEED_WATCHDOG_CHILD;
  });

  it("wires EventServer realtime sink and full ScheduleEngine deps in the watchdog child process", async () => {
    process.env.PULSEED_WATCHDOG_CHILD = "1";
    fs.mkdirSync("/tmp/pulseed-daemon-start-base", { recursive: true });
    fs.writeFileSync(
      "/tmp/pulseed-daemon-start-base/notification.json",
      JSON.stringify({
        plugin_notifiers: {
          mode: "only",
          routes: [{ id: "discord-bot", enabled: true, report_types: ["weekly_report"] }],
        },
      }),
      "utf-8"
    );

    await cmdStart(
      { getBaseDir: vi.fn().mockReturnValue("/tmp/pulseed-daemon-start-base") } as never,
      {} as never,
      ["--goal", "goal-1"]
    );

    expect(setRealtimeSinkMock).toHaveBeenCalledOnce();
    expect(notificationDispatcherArgs[0]).toEqual([
      expect.objectContaining({
        plugin_notifiers: {
          mode: "only",
          routes: [{ id: "discord-bot", enabled: true, report_types: ["weekly_report"] }],
        },
      }),
      expect.any(Object),
      expect.objectContaining({
        info: expect.any(Function),
        warn: expect.any(Function),
        error: expect.any(Function),
      }),
      expect.any(Object),
    ]);
    const realtimeSink = setRealtimeSinkMock.mock.calls[0]?.[0] as ((report: unknown) => Promise<void>) | undefined;
    expect(realtimeSink).toBeTypeOf("function");

    await realtimeSink?.({ id: "report-1" });
    expect(eventServerBroadcastMock).toHaveBeenCalledWith("notification_report", { id: "report-1" });
    expect(buildDepsMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      undefined,
      expect.any(Function),
      expect.objectContaining({
        info: expect.any(Function),
        warn: expect.any(Function),
        error: expect.any(Function),
      }),
      undefined,
      undefined,
    );

    expect(scheduleEngineArgs).toHaveLength(1);
    expect(scheduleEngineArgs[0]).toEqual(
      expect.objectContaining({
        reportingEngine: expect.any(Object),
        hookManager: { id: "hook-manager" },
        memoryLifecycle: { id: "memory" },
        knowledgeManager: { id: "knowledge" },
        personalAgentRuntime: expect.any(Object),
      })
    );

    expect(daemonRunnerArgs).toHaveLength(1);
    expect(daemonRunnerArgs[0]).toEqual(
      expect.objectContaining({
        eventServer: eventServerInstances[0],
        gateway: expect.any(Object),
        reportingEngine: expect.any(Object),
      })
    );
    expect(daemonStartMock).toHaveBeenCalledWith(["goal-1"]);
    expect(watchdogStartMock).not.toHaveBeenCalled();
  });

  it("passes explicit daemon workspace into buildDeps and DaemonRunner", async () => {
    process.env.PULSEED_WATCHDOG_CHILD = "1";

    await cmdStart(
      { getBaseDir: vi.fn().mockReturnValue("/tmp/pulseed-daemon-start-base") } as never,
      {} as never,
      ["--workspace", "/tmp/pulseed-workspace"]
    );

    expect(buildDepsMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      undefined,
      expect.any(Function),
      expect.any(Object),
      undefined,
      "/tmp/pulseed-workspace",
    );
    expect(daemonRunnerArgs[0]).toEqual(
      expect.objectContaining({
        config: expect.objectContaining({ workspace_path: "/tmp/pulseed-workspace" }),
      })
    );
  });

  it("wires EventServer health to fail if control DB schema drifts after startup", async () => {
    process.env.PULSEED_WATCHDOG_CHILD = "1";
    const baseDir = "/tmp/pulseed-daemon-start-base";

    await cmdStart(
      { getBaseDir: vi.fn().mockReturnValue(baseDir) } as never,
      {} as never,
      []
    );

    const eventServerConfig = eventServerArgs[0]?.[1] as { healthStatusProvider?: () => Record<string, unknown> } | undefined;
    expect(eventServerConfig?.healthStatusProvider).toBeTypeOf("function");
    expect(eventServerConfig?.healthStatusProvider?.()).toMatchObject({ status: "ok" });

    const database = await openControlDatabase({ baseDir });
    try {
      database.transaction((db) => {
        db.pragma(`user_version = ${CONTROL_DB_SCHEMA_VERSION + 1}`);
      });
    } finally {
      database.close();
    }

    expect(eventServerConfig?.healthStatusProvider?.()).toMatchObject({
      status: "failed",
      reason: "unsupported_control_db_schema",
      detail: expect.stringContaining(`Database schema version ${CONTROL_DB_SCHEMA_VERSION + 1} is newer`),
    });
  });

  it("treats --iterations-per-cycle as a bounded daemon canary cap by default", async () => {
    process.env.PULSEED_WATCHDOG_CHILD = "1";

    await cmdStart(
      { getBaseDir: vi.fn().mockReturnValue("/tmp/pulseed-daemon-start-base") } as never,
      {} as never,
      ["--iterations-per-cycle", "1"]
    );

    expect(daemonRunnerArgs[0]).toEqual(
      expect.objectContaining({
        config: expect.objectContaining({
          iterations_per_cycle: 1,
          run_policy: { mode: "bounded", max_iterations: 1 },
        }),
      })
    );
  });

  it("allows --resident to keep --iterations-per-cycle as daemon telemetry", async () => {
    process.env.PULSEED_WATCHDOG_CHILD = "1";

    await cmdStart(
      { getBaseDir: vi.fn().mockReturnValue("/tmp/pulseed-daemon-start-base") } as never,
      {} as never,
      ["--resident", "--iterations-per-cycle", "3"]
    );

    expect(daemonRunnerArgs[0]).toEqual(
      expect.objectContaining({
        config: expect.objectContaining({
          iterations_per_cycle: 3,
          run_policy: { mode: "resident", max_iterations: null },
        }),
      })
    );
  });

  it("fails closed before watchdog startup when the control DB schema is newer than this build", async () => {
    const baseDir = "/tmp/pulseed-daemon-start-base";
    fs.mkdirSync(baseDir, { recursive: true });
    const database = await openControlDatabase({ baseDir });
    try {
      database.transaction((db) => {
        db.pragma(`user_version = ${CONTROL_DB_SCHEMA_VERSION + 1}`);
      });
    } finally {
      database.close();
    }

    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit:${code ?? ""}`);
    }) as typeof process.exit);

    try {
      await expect(cmdStart(
        { getBaseDir: vi.fn().mockReturnValue(baseDir) } as never,
        {} as never,
        []
      )).rejects.toThrow("process.exit:1");
    } finally {
      exitSpy.mockRestore();
    }

    expect(cliLoggerMock.error).toHaveBeenCalledWith(
      expect.stringContaining(`Database schema version ${CONTROL_DB_SCHEMA_VERSION + 1} is newer`)
    );
    expect(cliLoggerMock.error).toHaveBeenCalledWith(
      expect.stringContaining("runtime readiness is not healthy")
    );
    expect(watchdogStartMock).not.toHaveBeenCalled();
    expect(daemonStartMock).not.toHaveBeenCalled();
    expect(buildDepsMock).not.toHaveBeenCalled();
  });

  it.each([
    ["--check-interval-ms", "10abc"],
    ["--iterations-per-cycle", "1.5"],
    ["--max-concurrent-goals", "0"],
    ["--check-interval-ms", undefined],
  ])("rejects invalid daemon integer flag %s=%s", async (flag, value) => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit:${code ?? ""}`);
    }) as typeof process.exit);

    try {
      const args = value === undefined ? [flag] : [flag, value];
      await expect(cmdStart(
        { getBaseDir: vi.fn().mockReturnValue("/tmp/pulseed-daemon-start-base") } as never,
        {} as never,
        args
      )).rejects.toThrow("process.exit:1");
    } finally {
      exitSpy.mockRestore();
    }

    expect(cliLoggerMock.error).toHaveBeenCalledWith(`${flag} must be a positive integer`);
    expect(watchdogStartMock).not.toHaveBeenCalled();
    expect(daemonStartMock).not.toHaveBeenCalled();
    expect(buildDepsMock).not.toHaveBeenCalled();
  });

  it("keeps legacy daemon.json iterations_per_cycle configs bounded", async () => {
    process.env.PULSEED_WATCHDOG_CHILD = "1";
    fs.mkdirSync("/tmp/pulseed-daemon-start-base", { recursive: true });
    fs.writeFileSync(
      path.join("/tmp/pulseed-daemon-start-base", "daemon.json"),
      JSON.stringify({ event_server_port: 0, iterations_per_cycle: 2 }),
      "utf-8"
    );

    await cmdStart(
      { getBaseDir: vi.fn().mockReturnValue("/tmp/pulseed-daemon-start-base") } as never,
      {} as never,
      []
    );

    expect(daemonRunnerArgs[0]).toEqual(
      expect.objectContaining({
        config: expect.objectContaining({
          iterations_per_cycle: 2,
          run_policy: { mode: "bounded", max_iterations: 2 },
        }),
      })
    );
  });

  it("launches RuntimeWatchdog on the top-level daemon start path", async () => {
    await cmdStart(
      { getBaseDir: vi.fn().mockReturnValue("/tmp/pulseed-daemon-start-base") } as never,
      {} as never,
      ["--goal", "goal-1"]
    );

    expect(watchdogStartMock).toHaveBeenCalledOnce();
    expect(watchdogArgs).toHaveLength(1);
    expect(daemonRunnerArgs).toHaveLength(0);
    expect(buildDepsMock).not.toHaveBeenCalled();
    expect(watchdogArgs[0]).toEqual(
      expect.objectContaining({
        healthProbe: expect.any(Function),
        startChild: expect.any(Function),
      })
    );
  });

  it("warns and falls back to defaults when baseDir daemon.json is invalid", async () => {
    fs.mkdirSync("/tmp/pulseed-daemon-start-base", { recursive: true });
    fs.writeFileSync(path.join("/tmp/pulseed-daemon-start-base", "daemon.json"), "{not-json", "utf-8");

    await cmdStart(
      { getBaseDir: vi.fn().mockReturnValue("/tmp/pulseed-daemon-start-base") } as never,
      {} as never,
      ["--goal", "goal-1"]
    );

    expect(cliLoggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining("Ignoring invalid daemon config at")
    );
    expect(watchdogStartMock).toHaveBeenCalledOnce();
  });

  it("warns and falls back to defaults when baseDir daemon.json uses an invalid event port", async () => {
    process.env.PULSEED_WATCHDOG_CHILD = "1";
    fs.mkdirSync("/tmp/pulseed-daemon-start-base", { recursive: true });
    fs.writeFileSync(
      path.join("/tmp/pulseed-daemon-start-base", "daemon.json"),
      JSON.stringify({ event_server_port: 70_000, check_interval_ms: 1234 }),
      "utf-8"
    );

    await cmdStart(
      { getBaseDir: vi.fn().mockReturnValue("/tmp/pulseed-daemon-start-base") } as never,
      {} as never,
      []
    );

    expect(cliLoggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining("Ignoring invalid daemon config at")
    );
    expect(daemonRunnerArgs[0]).toEqual(
      expect.objectContaining({
        config: expect.objectContaining({
          event_server_port: 41700,
          check_interval_ms: 300_000,
        }),
      })
    );
  });

  it("warns and falls back to defaults when baseDir daemon.json uses unsafe timer controls", async () => {
    process.env.PULSEED_WATCHDOG_CHILD = "1";
    fs.mkdirSync("/tmp/pulseed-daemon-start-base", { recursive: true });
    fs.writeFileSync(
      path.join("/tmp/pulseed-daemon-start-base", "daemon.json"),
      JSON.stringify({ event_server_port: 0, check_interval_ms: 2_147_483_648 }),
      "utf-8"
    );

    await cmdStart(
      { getBaseDir: vi.fn().mockReturnValue("/tmp/pulseed-daemon-start-base") } as never,
      {} as never,
      []
    );

    expect(cliLoggerMock.warn).toHaveBeenCalledWith(
      expect.stringContaining("Ignoring invalid daemon config at")
    );
    expect(daemonRunnerArgs[0]).toEqual(
      expect.objectContaining({
        config: expect.objectContaining({
          event_server_port: 41700,
          check_interval_ms: 300_000,
        }),
      })
    );
  });

  it("loads daemon config and plugins from the active baseDir in watchdog child process", async () => {
    process.env.PULSEED_WATCHDOG_CHILD = "1";
    fs.mkdirSync(path.join("/tmp/pulseed-daemon-start-base", "plugins"), { recursive: true });
    fs.writeFileSync(
      path.join("/tmp/pulseed-daemon-start-base", "daemon.json"),
      JSON.stringify({ event_server_port: 0, check_interval_ms: 1234 }),
      "utf-8"
    );
    fs.mkdirSync(path.join(mockedHome, ".pulseed"), { recursive: true });
    fs.writeFileSync(
      path.join(mockedHome, ".pulseed", "daemon.json"),
      JSON.stringify({ event_server_port: 45678, check_interval_ms: 9999 }),
      "utf-8"
    );

    await cmdStart(
      { getBaseDir: vi.fn().mockReturnValue("/tmp/pulseed-daemon-start-base") } as never,
      {} as never,
      []
    );

    expect(daemonRunnerArgs[0]).toEqual(
      expect.objectContaining({
        config: expect.objectContaining({
          event_server_port: 0,
          check_interval_ms: 1234,
        }),
      })
    );
    expect(pluginLoaderArgs[0]?.[3]).toBe(path.join("/tmp/pulseed-daemon-start-base", "plugins"));
  });

  it("allows idle watchdog startup with zero initial goals", async () => {
    await cmdStart(
      { getBaseDir: vi.fn().mockReturnValue("/tmp/pulseed-daemon-start-base") } as never,
      {} as never,
      []
    );

    expect(watchdogStartMock).toHaveBeenCalledOnce();
    expect(daemonStartMock).not.toHaveBeenCalled();
  });

  it("waits for detached daemon readiness before reporting startup success", async () => {
    pidReadPIDMock.mockResolvedValue({
      pid: 23456,
      owner_pid: 12345,
      watchdog_pid: 12345,
      runtime_pid: 23456,
      started_at: new Date().toISOString(),
    });
    readDaemonAuthTokenMetadataMock.mockReturnValue({
      token: "runtime-token",
      host: "127.0.0.1",
      port: 41700,
      pid: 23456,
      created_at: new Date(Date.now() + 1_000).toISOString(),
    });
    probeDaemonHealthMock
      .mockResolvedValueOnce({
        ok: false,
        port: 41700,
        latency_ms: 1,
        error: "connect ECONNREFUSED 127.0.0.1:41700",
      })
      .mockResolvedValueOnce({
        ok: false,
        port: 41700,
        latency_ms: 1,
        error: "connect ECONNREFUSED 127.0.0.1:41700",
      })
      .mockResolvedValueOnce({
        ok: true,
        port: 41700,
        latency_ms: 1,
        health: { status: "ok" },
      });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit:${code ?? ""}`);
    }) as typeof process.exit);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await expect(cmdStart(
        { getBaseDir: vi.fn().mockReturnValue("/tmp/pulseed-daemon-start-base") } as never,
        {} as never,
        ["--detach"],
        { childCommandArgs: ["daemon", "start", "--detach"] },
      )).rejects.toThrow("process.exit:0");

      expect(spawnMock).toHaveBeenCalledWith(
        process.execPath,
        [expect.any(String), "daemon", "start"],
        expect.objectContaining({
          detached: true,
          stdio: "ignore",
        })
      );
      expect(spawnUnrefMock).toHaveBeenCalledOnce();
      expect(pidReadPIDMock).toHaveBeenCalled();
      expect(probeDaemonHealthMock).toHaveBeenCalledWith({
        host: "127.0.0.1",
        port: 41700,
        timeoutMs: expect.any(Number),
      });
      expect(logSpy).toHaveBeenCalledWith("Daemon started in background (PID: 12345, port: 41700)");
    } finally {
      exitSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("stops the spawned detached daemon before failing a readiness timeout", async () => {
    pidReadPIDMock.mockResolvedValue({
      pid: 23456,
      owner_pid: 12345,
      watchdog_pid: 12345,
      runtime_pid: 23456,
      started_at: new Date().toISOString(),
    });
    pidStopRuntimeMock.mockResolvedValue({
      info: {
        pid: 23456,
        owner_pid: 12345,
        watchdog_pid: 12345,
        runtime_pid: 23456,
        started_at: new Date().toISOString(),
      },
      runtimePid: 23456,
      ownerPid: 12345,
      sentSignalsTo: [12345, 23456],
      forced: false,
      stopped: true,
      alivePids: [],
    });
    readDaemonAuthTokenMetadataMock.mockReturnValue(null);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit:${code ?? ""}`);
    }) as typeof process.exit);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(cmdStart(
        { getBaseDir: vi.fn().mockReturnValue("/tmp/pulseed-daemon-start-base") } as never,
        {} as never,
        ["--detach"],
        {
          childCommandArgs: ["daemon", "start", "--detach"],
          detachedReadyPollMs: 1,
          detachedReadyTimeoutMs: 1,
        },
      )).rejects.toThrow("process.exit:1");

      expect(spawnMock).toHaveBeenCalledOnce();
      expect(pidStopRuntimeMock).toHaveBeenCalledWith({
        timeoutMs: 5_000,
        pollIntervalMs: 100,
      });
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(
        "but the command surface was not ready within 1ms"
      ));
      expect(errorSpy).toHaveBeenCalledWith("Stopped spawned daemon after readiness timeout.");
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("fails before spawning when a configured event server port already hosts PulSeed", async () => {
    fs.mkdirSync("/tmp/pulseed-daemon-start-base", { recursive: true });
    fs.writeFileSync(
      path.join("/tmp/pulseed-daemon-start-base", "daemon.json"),
      JSON.stringify({ event_server_port: 43123 }),
      "utf-8"
    );
    probeDaemonHealthMock.mockResolvedValueOnce({
      ok: true,
      port: 43123,
      latency_ms: 1,
      health: { status: "ok" },
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit:${code ?? ""}`);
    }) as typeof process.exit);

    try {
      await expect(cmdStart(
        { getBaseDir: vi.fn().mockReturnValue("/tmp/pulseed-daemon-start-base") } as never,
        {} as never,
        ["--detach"],
        { childCommandArgs: ["daemon", "start", "--detach"] },
      )).rejects.toThrow("process.exit:1");

      expect(spawnMock).not.toHaveBeenCalled();
      expect(cliLoggerMock.error).toHaveBeenCalledWith(expect.stringContaining(
        "Daemon event server port 43123 already has a PulSeed health endpoint"
      ));
      expect(cliLoggerMock.error).toHaveBeenCalledWith(expect.stringContaining("event_server_port to 0"));
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("probes the daemon-token port while detached dynamic-port startup is still writing state", async () => {
    fs.mkdirSync("/tmp/pulseed-daemon-start-base", { recursive: true });
    fs.writeFileSync(
      path.join("/tmp/pulseed-daemon-start-base", "daemon.json"),
      JSON.stringify({ event_server_port: 0 }),
      "utf-8"
    );
    pidReadPIDMock.mockResolvedValue({
      pid: 23456,
      owner_pid: 12345,
      watchdog_pid: 12345,
      runtime_pid: 23456,
      started_at: new Date().toISOString(),
    });
    readDaemonAuthTokenMetadataMock.mockReturnValue({
      token: "runtime-token",
      host: "127.0.0.1",
      port: 45678,
      pid: 23456,
      created_at: new Date(Date.now() + 1_000).toISOString(),
    });
    probeDaemonHealthMock.mockResolvedValueOnce({
      ok: true,
      port: 45678,
      latency_ms: 1,
      health: { status: "ok" },
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit:${code ?? ""}`);
    }) as typeof process.exit);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await expect(cmdStart(
        { getBaseDir: vi.fn().mockReturnValue("/tmp/pulseed-daemon-start-base") } as never,
        {} as never,
        ["--detach"],
        { childCommandArgs: ["daemon", "start", "--detach"] },
      )).rejects.toThrow("process.exit:0");

      expect(readDaemonAuthTokenMetadataMock).toHaveBeenCalledWith("/tmp/pulseed-daemon-start-base");
      expect(probeDaemonHealthMock).toHaveBeenCalledWith({
        host: "127.0.0.1",
        port: 45678,
        timeoutMs: expect.any(Number),
      });
      expect(logSpy).toHaveBeenCalledWith("Daemon started in background (PID: 12345, port: 45678)");
    } finally {
      exitSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("does not probe the default port for detached dynamic-port startup before the token file exists", async () => {
    fs.mkdirSync("/tmp/pulseed-daemon-start-base", { recursive: true });
    fs.writeFileSync(
      path.join("/tmp/pulseed-daemon-start-base", "daemon.json"),
      JSON.stringify({ event_server_port: 0 }),
      "utf-8"
    );
    pidReadPIDMock.mockResolvedValue({
      pid: 23456,
      owner_pid: 12345,
      watchdog_pid: 12345,
      runtime_pid: 23456,
      started_at: new Date().toISOString(),
    });
    readDaemonAuthTokenMetadataMock
      .mockReturnValueOnce(null)
      .mockReturnValueOnce({
        token: "runtime-token",
        host: "127.0.0.1",
        port: 45678,
        pid: 23456,
        created_at: new Date(Date.now() + 1_000).toISOString(),
      });
    probeDaemonHealthMock.mockResolvedValueOnce({
      ok: true,
      port: 45678,
      latency_ms: 1,
      health: { status: "ok" },
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit:${code ?? ""}`);
    }) as typeof process.exit);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await expect(cmdStart(
        { getBaseDir: vi.fn().mockReturnValue("/tmp/pulseed-daemon-start-base") } as never,
        {} as never,
        ["--detach"],
        { childCommandArgs: ["daemon", "start", "--detach"] },
      )).rejects.toThrow("process.exit:0");

      expect(probeDaemonHealthMock).toHaveBeenCalledOnce();
      expect(probeDaemonHealthMock).toHaveBeenCalledWith({
        host: "127.0.0.1",
        port: 45678,
        timeoutMs: expect.any(Number),
      });
      expect(logSpy).toHaveBeenCalledWith("Daemon started in background (PID: 12345, port: 45678)");
    } finally {
      exitSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("ignores daemon-token ports that do not belong to the spawned runtime", async () => {
    fs.mkdirSync("/tmp/pulseed-daemon-start-base", { recursive: true });
    fs.writeFileSync(
      path.join("/tmp/pulseed-daemon-start-base", "daemon.json"),
      JSON.stringify({ event_server_port: 0 }),
      "utf-8"
    );
    pidReadPIDMock.mockResolvedValue({
      pid: 23456,
      owner_pid: 12345,
      watchdog_pid: 12345,
      runtime_pid: 23456,
      started_at: new Date().toISOString(),
    });
    readDaemonAuthTokenMetadataMock
      .mockReturnValueOnce({
        token: "stale-token",
        host: "127.0.0.1",
        port: 45678,
        pid: 99999,
        created_at: new Date(Date.now() + 1_000).toISOString(),
      })
      .mockReturnValueOnce({
        token: "runtime-token",
        host: "127.0.0.1",
        port: 45679,
        pid: 23456,
        created_at: new Date(Date.now() + 1_000).toISOString(),
      });
    probeDaemonHealthMock.mockResolvedValueOnce({
      ok: true,
      port: 45679,
      latency_ms: 1,
      health: { status: "ok" },
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit:${code ?? ""}`);
    }) as typeof process.exit);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await expect(cmdStart(
        { getBaseDir: vi.fn().mockReturnValue("/tmp/pulseed-daemon-start-base") } as never,
        {} as never,
        ["--detach"],
        { childCommandArgs: ["daemon", "start", "--detach"] },
      )).rejects.toThrow("process.exit:0");

      expect(probeDaemonHealthMock).toHaveBeenCalledOnce();
      expect(probeDaemonHealthMock).toHaveBeenCalledWith({
        host: "127.0.0.1",
        port: 45679,
        timeoutMs: expect.any(Number),
      });
      expect(logSpy).toHaveBeenCalledWith("Daemon started in background (PID: 12345, port: 45679)");
    } finally {
      exitSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("does not spawn a detached daemon over an existing runtime", async () => {
    pidIsRunningMock.mockResolvedValue(true);
    pidReadPIDMock.mockResolvedValue({ pid: 777 });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit:${code ?? ""}`);
    }) as typeof process.exit);

    try {
      await expect(cmdStart(
        { getBaseDir: vi.fn().mockReturnValue("/tmp/pulseed-daemon-start-base") } as never,
        {} as never,
        ["--detach"],
        { childCommandArgs: ["daemon", "start", "--detach"] },
      )).rejects.toThrow("process.exit:1");
    } finally {
      exitSpy.mockRestore();
    }

    expect(spawnMock).not.toHaveBeenCalled();
    expect(isDaemonRunningMock).not.toHaveBeenCalled();
  });
});

describe("cmdRestart", () => {
  const stateManager = { getBaseDir: vi.fn().mockReturnValue("/tmp/pulseed-daemon-start-base") };
  const characterConfigManager = {};

  beforeEach(() => {
    buildDepsMock.mockReset();
    daemonStartMock.mockClear();
    watchdogStartMock.mockClear();
    scheduleLoadEntriesMock.mockClear();
    scheduleEnsureSoilPublishScheduleMock.mockClear();
    scheduleSyncExternalSourcesMock.mockClear();
    pluginLoadAllMock.mockClear();
    setRealtimeSinkMock.mockClear();
    eventServerBroadcastMock.mockClear();
    eventServerInstances.length = 0;
    scheduleEngineArgs.length = 0;
    daemonRunnerArgs.length = 0;
    watchdogArgs.length = 0;
    notificationDispatcherArgs.length = 0;
    pluginLoaderArgs.length = 0;
    pidIsRunningMock.mockReset();
    pidIsRunningMock.mockResolvedValue(false);
    pidReadPIDMock.mockReset();
    pidReadPIDMock.mockResolvedValue(null);
    pidStopRuntimeMock.mockReset();
    probeDaemonHealthMock.mockReset();
    probeDaemonHealthMock.mockResolvedValue({
      ok: false,
      port: 41700,
      latency_ms: 0,
      error: "connect ECONNREFUSED 127.0.0.1:41700",
    });
    delete process.env.PULSEED_WATCHDOG_CHILD;
    fs.rmSync("/tmp/pulseed-daemon-start-base", { recursive: true, force: true });
  });

  afterEach(() => {
    fs.rmSync("/tmp/pulseed-daemon-start-base", { recursive: true, force: true });
    delete process.env.PULSEED_WATCHDOG_CHILD;
  });

  function captureConsoleLog(): {
    spy: ReturnType<typeof vi.spyOn>;
    read: () => string;
  } {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    return {
      spy,
      read: () => spy.mock.calls.map((call) => call.join(" ")).join("\n"),
    };
  }

  it("stops a running daemon before starting it again", async () => {
    pidStopRuntimeMock.mockResolvedValue({
      info: { pid: 123, started_at: new Date("2026-05-10T00:00:00.000Z").toISOString() },
      runtimePid: 456,
      ownerPid: 123,
      sentSignalsTo: [123, 456],
      forced: false,
      stopped: true,
      alivePids: [],
    });
    const consoleCapture = captureConsoleLog();

    try {
      const code = await cmdRestart(stateManager as never, characterConfigManager as never, []);

      expect(code).toBe(0);
      expect(pidStopRuntimeMock).toHaveBeenCalledOnce();
      expect(watchdogStartMock).toHaveBeenCalledOnce();
      expect(daemonStartMock).not.toHaveBeenCalled();
      const output = consoleCapture.read();
      expect(output).toContain("Stopping daemon (PID: 456)...");
      expect(output).toContain("Daemon stopped");
      expect(output).toContain("Starting daemon...");
    } finally {
      consoleCapture.spy.mockRestore();
    }
  });

  it("starts the daemon and reports when there was no running daemon to stop", async () => {
    pidStopRuntimeMock.mockResolvedValue({
      info: null,
      runtimePid: null,
      ownerPid: null,
      sentSignalsTo: [],
      forced: false,
      stopped: false,
      alivePids: [],
    });
    const consoleCapture = captureConsoleLog();

    try {
      const code = await dispatchCommand(
        ["daemon", "restart"],
        false,
        stateManager as never,
        characterConfigManager as never,
        { value: null },
      );

      expect(code).toBe(0);
      expect(pidStopRuntimeMock).toHaveBeenCalledOnce();
      expect(watchdogStartMock).toHaveBeenCalledOnce();
      const output = consoleCapture.read();
      expect(output).toContain("No running daemon found");
      expect(output).toContain("Starting daemon...");
    } finally {
      consoleCapture.spy.mockRestore();
    }
  });

  it("propagates daemon stop failures through the CLI exit code", async () => {
    pidStopRuntimeMock.mockResolvedValue({
      info: { pid: 123, started_at: new Date("2026-05-10T00:00:00.000Z").toISOString() },
      runtimePid: 456,
      ownerPid: 123,
      sentSignalsTo: [123, 456],
      forced: false,
      stopped: false,
      alivePids: [123, 456],
    });
    const consoleCapture = captureConsoleLog();

    try {
      const code = await dispatchCommand(
        ["daemon", "stop"],
        false,
        stateManager as never,
        characterConfigManager as never,
        { value: null },
      );

      expect(code).toBe(1);
      expect(pidStopRuntimeMock).toHaveBeenCalledOnce();
      const output = consoleCapture.read();
      expect(output).toContain("Stopping daemon (PID: 456)...");
      expect(output).toContain("Daemon still running (PIDs: 123, 456)");
    } finally {
      consoleCapture.spy.mockRestore();
    }
  });

  it("does not start a second daemon when the stop path fails", async () => {
    pidStopRuntimeMock.mockResolvedValue({
      info: { pid: 123, started_at: new Date("2026-05-10T00:00:00.000Z").toISOString() },
      runtimePid: 456,
      ownerPid: 123,
      sentSignalsTo: [123, 456],
      forced: false,
      stopped: false,
      alivePids: [123, 456],
    });
    const consoleCapture = captureConsoleLog();

    try {
      const code = await cmdRestart(stateManager as never, characterConfigManager as never, []);

      expect(code).toBe(1);
      expect(pidStopRuntimeMock).toHaveBeenCalledOnce();
      expect(watchdogStartMock).not.toHaveBeenCalled();
      expect(daemonStartMock).not.toHaveBeenCalled();
      const output = consoleCapture.read();
      expect(output).toContain("Daemon still running (PIDs: 123, 456)");
      expect(output).toContain("Daemon restart aborted");
      expect(output).toContain("pulseed daemon status");
    } finally {
      consoleCapture.spy.mockRestore();
    }
  });
});
