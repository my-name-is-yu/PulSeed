import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  buildDepsMock,
  daemonStartMock,
  scheduleLoadEntriesMock,
  pluginLoadAllMock,
  setRealtimeSinkMock,
  eventServerBroadcastMock,
  eventServerInstances,
  scheduleEngineArgs,
  daemonRunnerArgs,
} = vi.hoisted(() => ({
  buildDepsMock: vi.fn(),
  daemonStartMock: vi.fn().mockResolvedValue(undefined),
  scheduleLoadEntriesMock: vi.fn().mockResolvedValue(undefined),
  pluginLoadAllMock: vi.fn().mockResolvedValue(undefined),
  setRealtimeSinkMock: vi.fn(),
  eventServerBroadcastMock: vi.fn(),
  eventServerInstances: [] as Array<{ broadcast: ReturnType<typeof vi.fn> }>,
  scheduleEngineArgs: [] as unknown[],
  daemonRunnerArgs: [] as unknown[],
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: vi.fn(() => "/tmp/pulseed-daemon-start-test-home"),
  };
});

vi.mock("../setup.js", () => ({
  buildDeps: buildDepsMock,
}));

vi.mock("../../../runtime/daemon-runner.js", () => ({
  DaemonRunner: vi.fn().mockImplementation(function (deps: unknown) {
    daemonRunnerArgs.push(deps);
    return {
      start: daemonStartMock,
    };
  }),
}));

vi.mock("../../../runtime/pid-manager.js", () => ({
  PIDManager: vi.fn().mockImplementation(function () {
    return {
      isRunning: vi.fn().mockResolvedValue(false),
      readPID: vi.fn().mockResolvedValue(null),
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

vi.mock("../../../runtime/event-server.js", () => ({
  EventServer: vi.fn().mockImplementation(function () {
    const instance = {
      broadcast: eventServerBroadcastMock,
    };
    eventServerInstances.push(instance);
    return instance;
  }),
}));

vi.mock("../../../runtime/cron-scheduler.js", () => ({
  CronScheduler: vi.fn().mockImplementation(function () {
    return {};
  }),
}));

vi.mock("../../../runtime/schedule-engine.js", () => ({
  ScheduleEngine: vi.fn().mockImplementation(function (args: unknown) {
    scheduleEngineArgs.push(args);
    return {
      loadEntries: scheduleLoadEntriesMock,
    };
  }),
}));

vi.mock("../../../runtime/plugin-loader.js", () => ({
  PluginLoader: vi.fn().mockImplementation(function () {
    return {
      loadAll: pluginLoadAllMock,
    };
  }),
}));

vi.mock("../../../runtime/notifier-registry.js", () => ({
  NotifierRegistry: vi.fn().mockImplementation(function () {
    return {};
  }),
}));

vi.mock("../../../runtime/notification-dispatcher.js", () => ({
  NotificationDispatcher: vi.fn().mockImplementation(function () {
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

import { cmdStart } from "../commands/daemon.js";

describe("cmdStart", () => {
  beforeEach(() => {
    buildDepsMock.mockReset();
    daemonStartMock.mockClear();
    scheduleLoadEntriesMock.mockClear();
    pluginLoadAllMock.mockClear();
    setRealtimeSinkMock.mockClear();
    eventServerBroadcastMock.mockClear();
    eventServerInstances.length = 0;
    scheduleEngineArgs.length = 0;
    daemonRunnerArgs.length = 0;

    buildDepsMock.mockResolvedValue({
      coreLoop: {},
      driveSystem: {},
      stateManager: { getBaseDir: vi.fn().mockReturnValue("/tmp/pulseed-daemon-start-base") },
      llmClient: {},
      reportingEngine: { setNotificationDispatcher: vi.fn() },
      hookManager: { id: "hook-manager" },
      memoryLifecycleManager: { id: "memory" },
      knowledgeManager: { id: "knowledge" },
    });
  });

  it("wires EventServer realtime sink and full ScheduleEngine deps on normal daemon start", async () => {
    await cmdStart(
      {} as never,
      {} as never,
      ["--goal", "goal-1"]
    );

    expect(setRealtimeSinkMock).toHaveBeenCalledOnce();
    const realtimeSink = setRealtimeSinkMock.mock.calls[0]?.[0] as ((report: unknown) => Promise<void>) | undefined;
    expect(realtimeSink).toBeTypeOf("function");

    await realtimeSink?.({ id: "report-1" });
    expect(eventServerBroadcastMock).toHaveBeenCalledWith("notification_report", { id: "report-1" });

    expect(scheduleEngineArgs).toHaveLength(1);
    expect(scheduleEngineArgs[0]).toEqual(
      expect.objectContaining({
        reportingEngine: expect.any(Object),
        hookManager: { id: "hook-manager" },
        memoryLifecycle: { id: "memory" },
        knowledgeManager: { id: "knowledge" },
      })
    );

    expect(daemonRunnerArgs).toHaveLength(1);
    expect(daemonRunnerArgs[0]).toEqual(
      expect.objectContaining({
        eventServer: eventServerInstances[0],
        reportingEngine: expect.any(Object),
      })
    );
    expect(daemonStartMock).toHaveBeenCalledWith(["goal-1"]);
  });
});
