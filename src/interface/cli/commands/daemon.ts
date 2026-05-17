// ─── pulseed daemon commands (start, stop, restart, cron, status) ───

import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import * as path from "node:path";
import { readJsonFileOrNull } from "../../../base/utils/json-io.js";
import { DaemonStateSchema, DaemonConfigSchema } from "../../../base/types/daemon.js";
import type { DaemonState, DaemonConfig, PIDInfo } from "../../../base/types/daemon.js";
import type { Task } from "../../../base/types/task.js";

import type { StateManager } from "../../../base/state/state-manager.js";
import type { CharacterConfigManager } from "../../../platform/traits/character-config.js";
import { Logger } from "../../../runtime/logger.js";
import { DaemonRunner } from "../../../runtime/daemon/runner.js";
import { readShutdownMarkerFile } from "../../../runtime/daemon/persistence.js";
import { PIDManager } from "../../../runtime/pid-manager.js";
import { EventServer } from "../../../runtime/event/server.js";
import {
  IngressGateway,
  SlackChannelAdapter,
  createGatewayCapabilityDecisionRecorder,
  loadBuiltinGatewayIntegrations,
} from "../../../runtime/gateway/index.js";
import { ScheduleEngine } from "../../../runtime/schedule/engine.js";
import { RuntimeWatchdog } from "../../../runtime/watchdog.js";
import { LeaderLockManager } from "../../../runtime/leader-lock-manager.js";
import {
  DaemonStateStore,
  ProactiveInterventionStore,
  RuntimeHealthStore,
} from "../../../runtime/store/index.js";
import type { RuntimeArtifactExpectation } from "../../../runtime/store/index.js";
import {
  isDaemonRunning,
  probeDaemonHealth,
  readDaemonAuthTokenMetadata,
} from "../../../runtime/daemon/client.js";
import type { DaemonAuthToken } from "../../../runtime/daemon/client.js";
import { PluginLoader } from "../../../runtime/plugin-loader.js";
import { NotifierRegistry } from "../../../runtime/notifier-registry.js";
import { NotificationDispatcher } from "../../../runtime/notification-dispatcher.js";
import { PersonalAgentRuntimeStore } from "../../../runtime/personal-agent/index.js";
import { getNotificationConfigPath, loadNotificationConfig } from "../../../runtime/notification-routing.js";
import { getProviderRuntimeFingerprint } from "../../../base/llm/provider-config.js";
import { buildDeps } from "../setup.js";
import { getGlobalCrossPlatformChatSessionManager } from "../../chat/cross-platform-session.js";
import { registerGlobalCrossPlatformChatSessionManager } from "../../chat/cross-platform-session-global.js";
import { formatOperationError } from "../utils.js";
import { getCliLogger } from "../cli-logger.js";
import { getPulseedDirPath, getLogsDir, getEventsDir } from "../../../base/utils/paths.js";
import { summarizeTaskOutcomeLedgers } from "../../../orchestrator/execution/task/task-outcome-ledger.js";
import { createBuiltinTools } from "../../../tools/index.js";
import {
  formatAbsoluteRelativeTimestamp,
  formatCapabilityLabel,
  formatDurationMs,
  formatGoalMode,
  formatKpiCompactLine,
  formatLongRunHealthLines,
  formatPercent,
  formatRelativeTime,
  formatRelativeTimestamp,
  formatTaskFailureReasonCounts,
  formatTaskOutcomeLine,
  formatTaskSuccessRateLine,
  formatUptime,
  isPidAlive,
  loadDaemonConfig,
  readSupervisorState,
  resolveDaemonRuntimeRoot,
  type RuntimeTaskOutcomeDetails,
} from "./daemon-shared.js";
import {
  LIVE_RUNTIME_OVERRIDES_STALE_HEALTH_REASON,
  STALE_RUNTIME_HEALTH_REASON,
  formatControlDbSchemaDriftMessage,
  formatHistoricalSnapshotContext,
  parseHistoricalObservationTime,
  reconcileRuntimeHealthForDisplay,
} from "./daemon-status-health.js";

const WATCHDOG_CHILD_ENV = "PULSEED_WATCHDOG_CHILD";
const DETACHED_DAEMON_READY_TIMEOUT_MS = 10_000;
const DETACHED_DAEMON_READY_POLL_MS = 250;
const DETACHED_DAEMON_TOKEN_FRESHNESS_SKEW_MS = 1_000;

interface CmdStartOptions {
  childCommandArgs?: string[];
}

type StopDaemonOutcome =
  | { status: "not_running"; messages: string[] }
  | { status: "stopped"; messages: string[] }
  | { status: "failed"; messages: string[] };

async function waitForDetachedDaemonReady(params: {
  baseDir: string;
  eventServerPort: number;
  expectedWatchdogPid: number;
  startedAtMs: number;
}): Promise<
  | { ready: true; port: number }
  | { ready: false; port: number; detail: string }
> {
  const { baseDir, eventServerPort, expectedWatchdogPid, startedAtMs } = params;
  const deadline = Date.now() + DETACHED_DAEMON_READY_TIMEOUT_MS;
  let lastPort = 0;
  let lastDetail = "daemon health endpoint was not checked";

  while (Date.now() < deadline) {
    const ownership = await readDetachedDaemonOwnership(baseDir, expectedWatchdogPid);
    if (!ownership) {
      lastDetail = `daemon pid file is not owned by spawned watchdog PID ${expectedWatchdogPid}`;
    } else {
      const token = readFreshDetachedDaemonToken({
        baseDir,
        eventServerPort,
        ownership,
        startedAtMs,
      });
      const directProbePort = token?.port ?? null;
      if (directProbePort === null) {
        lastDetail = "fresh daemon token for the spawned runtime was not available";
      } else {
        lastPort = directProbePort;
      }
      if (directProbePort !== null) {
        const probe = await probeDaemonHealth({
          host: "127.0.0.1",
          port: directProbePort,
          timeoutMs: detachedDaemonReadyProbeTimeoutMs(deadline),
        });
        if (probe.ok) {
          return { ready: true, port: directProbePort };
        }
        lastDetail = probe.error
          ? `no healthy daemon response on port ${directProbePort}: ${probe.error}`
          : `no healthy daemon response on port ${directProbePort}`;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, DETACHED_DAEMON_READY_POLL_MS));
  }

  return { ready: false, port: lastPort, detail: lastDetail };
}

function detachedDaemonReadyProbeTimeoutMs(deadline: number): number {
  return Math.max(1, Math.min(DETACHED_DAEMON_READY_POLL_MS, deadline - Date.now()));
}

async function readDetachedDaemonOwnership(baseDir: string, expectedWatchdogPid: number): Promise<PIDInfo | null> {
  const info = await new PIDManager(baseDir).readPID();
  if (!info) return null;
  if (info.owner_pid === expectedWatchdogPid || info.watchdog_pid === expectedWatchdogPid) {
    return info;
  }
  return null;
}

function readFreshDetachedDaemonToken(params: {
  baseDir: string;
  eventServerPort: number;
  ownership: PIDInfo;
  startedAtMs: number;
}): DaemonAuthToken | null {
  const token = readDaemonAuthTokenMetadata(params.baseDir);
  if (!token) return null;
  if (!isFreshDetachedDaemonToken(token, params.startedAtMs)) return null;
  const runtimePid = params.ownership.runtime_pid ?? params.ownership.pid;
  if (token.pid !== runtimePid) return null;
  if (!isDetachedDaemonProbePort(token.port)) return null;
  if (params.eventServerPort > 0 && token.port !== params.eventServerPort) return null;
  return token;
}

function isFreshDetachedDaemonToken(token: DaemonAuthToken, startedAtMs: number): boolean {
  if (!token.created_at) return false;
  const createdAtMs = Date.parse(token.created_at);
  return Number.isFinite(createdAtMs)
    && createdAtMs >= startedAtMs - DETACHED_DAEMON_TOKEN_FRESHNESS_SKEW_MS;
}

function isDetachedDaemonProbePort(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 65_535;
}

function resolveStatusArtifactExpectation(params: {
  activeGoalIds: string[];
  activeWorkerCount: number;
  daemonStatus: DaemonState["status"];
  liveRuntimeStopped: boolean;
  workerSnapshotAvailable: boolean;
}): RuntimeArtifactExpectation {
  if (params.liveRuntimeStopped) {
    return { state: "unknown", reason: "historical_runtime_snapshot" };
  }
  if (params.activeGoalIds.length > 0) {
    return { state: "expected", reason: "active_goal" };
  }
  if (params.activeWorkerCount > 0) {
    return { state: "expected", reason: "active_worker" };
  }
  if (params.daemonStatus === "idle") {
    return { state: "none", reason: "idle_no_worker" };
  }
  if (params.workerSnapshotAvailable) {
    return { state: "none", reason: "idle_no_worker" };
  }
  return { state: "unknown", reason: "worker_snapshot_unavailable" };
}

export function parseDaemonPositiveInteger(raw: unknown, label: string): number {
  const normalized = typeof raw === "string" ? raw.trim() : "";
  if (!/^[0-9]+$/.test(normalized)) {
    throw new Error(`${label} must be a positive integer`);
  }
  const parsed = Number(normalized);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function readDaemonPositiveInteger(raw: unknown, label: string): number {
  try {
    return parseDaemonPositiveInteger(raw, label);
  } catch (err) {
    getCliLogger().error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

export async function cmdStart(
  stateManager: StateManager,
  characterConfigManager: CharacterConfigManager,
  args: string[],
  options: CmdStartOptions = {},
): Promise<void> {
  let values: { "api-key"?: string; config?: string; goal?: string[]; detach?: boolean; "check-interval-ms"?: string; "iterations-per-cycle"?: string; resident?: boolean; "max-concurrent-goals"?: string; workspace?: string };
  try {
    ({ values } = parseArgs({
      args,
      options: {
        "api-key": { type: "string" },
        config: { type: "string" },
        goal: { type: "string", multiple: true },
        detach: { type: "boolean", short: "d" },
        "check-interval-ms": { type: "string" },
        "iterations-per-cycle": { type: "string" },
        resident: { type: "boolean" },
        "max-concurrent-goals": { type: "string" },
        workspace: { type: "string" },
      },
      strict: false,
    }) as { values: { "api-key"?: string; config?: string; goal?: string[]; detach?: boolean; "check-interval-ms"?: string; "iterations-per-cycle"?: string; resident?: boolean; "max-concurrent-goals"?: string; workspace?: string } });
  } catch (err) {
    getCliLogger().error(formatOperationError("parse start command arguments", err));
    process.exit(1);
  }

  const goalIds = (values.goal as string[]) || [];

  // Gap 1: Load DaemonConfig from --config path (if provided)
  let daemonConfig: Partial<DaemonConfig> | undefined;
  if (values.config) {
    try {
      const raw = await readJsonFileOrNull(values.config);
      if (raw !== null) {
        daemonConfig = DaemonConfigSchema.parse(raw);
      } else {
        getCliLogger().error(`Config file not found: ${values.config}`);
        process.exit(1);
      }
    } catch (err) {
      getCliLogger().error(formatOperationError(`parse daemon config from "${values.config}"`, err));
      process.exit(1);
    }
  }

  const baseDir = stateManager.getBaseDir();

  // Auto-load daemon.json from the active PulSeed base directory when no --config flag was provided.
  if (!values.config) {
    daemonConfig = await loadDaemonConfig(baseDir);
  }

  // Merge CLI flag overrides into daemonConfig
  if (values["check-interval-ms"] !== undefined) {
    const parsed = readDaemonPositiveInteger(values["check-interval-ms"], "--check-interval-ms");
    daemonConfig = daemonConfig ?? {};
    daemonConfig.check_interval_ms = parsed;
  }
  if (values["iterations-per-cycle"] !== undefined) {
    const parsed = readDaemonPositiveInteger(values["iterations-per-cycle"], "--iterations-per-cycle");
    daemonConfig = daemonConfig ?? {};
    daemonConfig.iterations_per_cycle = parsed;
    if (values.resident === true) {
      daemonConfig.run_policy = { mode: "resident", max_iterations: null };
    } else {
      daemonConfig.run_policy = { mode: "bounded", max_iterations: parsed };
    }
  } else if (values.resident === true) {
    daemonConfig = daemonConfig ?? {};
    daemonConfig.run_policy = { mode: "resident", max_iterations: null };
  }
  if (values["max-concurrent-goals"] !== undefined) {
    const parsed = readDaemonPositiveInteger(values["max-concurrent-goals"], "--max-concurrent-goals");
    daemonConfig = daemonConfig ?? {};
    daemonConfig.max_concurrent_goals = parsed;
  }
  if (values.workspace) {
    daemonConfig = daemonConfig ?? {};
    daemonConfig.workspace_path = path.resolve(values.workspace);
  }

  const resolvedDaemonConfig = DaemonConfigSchema.parse(daemonConfig ?? {});
  const isWatchdogChild = process.env[WATCHDOG_CHILD_ENV] === "1";
  const shouldUseWatchdog = !isWatchdogChild;
  const pidManager = new PIDManager(baseDir);
  const logger = new Logger({
    dir: getLogsDir(baseDir),
  });
  const schemaDriftMessage = formatControlDbSchemaDriftMessage(baseDir);
  if (schemaDriftMessage) {
    getCliLogger().error(schemaDriftMessage);
    process.exit(1);
  }

  if (!isWatchdogChild && await pidManager.isRunning()) {
    const info = await pidManager.readPID();
    logger.error(`Daemon already running (PID: ${info?.pid})`);
    process.exit(1);
  }

  // --detach: spawn a background watchdog and only report success after the
  // daemon command surface is actually ready for follow-up commands.
  if (values.detach) {
    const scriptPath = process.argv[1]!;
    const childArgs = (options.childCommandArgs ?? process.argv.slice(2))
      .filter((arg) => arg !== "--detach" && arg !== "-d");

    const startedAtMs = Date.now();
    const child = spawn(process.execPath, [scriptPath, ...childArgs], {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", (err) => {
      console.error(`Failed to start daemon: ${err.message}`);
      process.exit(1);
    });
    child.unref();
    if (child.pid == null) {
      console.error("Failed to start daemon: no PID assigned");
      process.exit(1);
    }
    const readiness = await waitForDetachedDaemonReady({
      baseDir,
      eventServerPort: resolvedDaemonConfig.event_server_port,
      expectedWatchdogPid: child.pid,
      startedAtMs,
    });
    if (!readiness.ready) {
      console.error(
        `Daemon process started in background (PID: ${child.pid}), but the command surface was not ready within ${DETACHED_DAEMON_READY_TIMEOUT_MS}ms: ${readiness.detail}.`
      );
      console.error("Run `pulseed daemon status` or `pulseed logs` to inspect startup.");
      process.exit(1);
    }
    console.log(`Daemon started in background (PID: ${child.pid}, port: ${readiness.port})`);
    process.exit(0);
  }

  if (shouldUseWatchdog) {
    const runtimeRoot = resolveDaemonRuntimeRoot(baseDir, resolvedDaemonConfig.runtime_root);
    const healthStore = new RuntimeHealthStore(runtimeRoot, { controlBaseDir: baseDir });
    const leaderLockManager = new LeaderLockManager(runtimeRoot, undefined, { controlBaseDir: baseDir });
    const scriptPath = process.argv[1]!;
    const childArgs = options.childCommandArgs ?? process.argv.slice(2);
    const healthProbe =
      resolvedDaemonConfig.event_server_port > 0
        ? async () => {
            const probe = await probeDaemonHealth({
              host: "127.0.0.1",
              port: resolvedDaemonConfig.event_server_port,
            });
            return {
              ok: probe.ok,
              detail: probe.ok ? undefined : probe.error,
            };
          }
        : undefined;
    const watchdog = new RuntimeWatchdog({
      pidManager,
      healthStore,
      leaderLockManager,
      logger,
      healthProbe,
      preStartCheck: async () => {
        const detail = formatControlDbSchemaDriftMessage(baseDir);
        return detail ? { ok: false, detail } : { ok: true };
      },
      startChild: () =>
        spawn(process.execPath, [scriptPath, ...childArgs], {
          stdio: "inherit",
          env: {
            ...process.env,
            [WATCHDOG_CHILD_ENV]: "1",
          },
        }),
    });

    const shutdown = (): void => watchdog.stop();
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
    try {
      logger.info(`Starting runtime watchdog for goals: ${formatGoalMode(goalIds)}`);
      await watchdog.start();
    } finally {
      process.removeListener("SIGTERM", shutdown);
      process.removeListener("SIGINT", shutdown);
    }
    return;
  }

  let daemonApprovalProvider:
    | ((task: Task) => Promise<boolean>)
    | null = null;
  const approvalBridge = async (task: Task): Promise<boolean> => {
    if (!daemonApprovalProvider) {
      logger.warn("Daemon approval requested before approval provider was ready", {
        task_id: task.id,
        goal_id: task.goal_id,
      });
      return false;
    }
    return daemonApprovalProvider(task);
  };

  const deps = await buildDeps(
    stateManager,
    characterConfigManager,
    undefined,
    approvalBridge,
    logger,
    undefined,
    resolvedDaemonConfig.workspace_path,
  );

  // Load plugins into the same registries used by the resident runtime.
  const notifierRegistry = new NotifierRegistry();
  const pluginsDir = path.join(baseDir, "plugins");

  const loadPluginsIntoDeps = async (runtimeDeps: Awaited<ReturnType<typeof buildDeps>>): Promise<PluginLoader> => {
    const pluginLoader = new PluginLoader(
      runtimeDeps.adapterRegistry,
      runtimeDeps.dataSourceRegistry,
      notifierRegistry,
      pluginsDir,
      logger,
      (adapter) => {
        if (!runtimeDeps.observationEngine.getDataSources().some((source) => source.sourceId === adapter.sourceId)) {
          runtimeDeps.observationEngine.addDataSource(adapter);
        }
      }
    );
    try {
      await pluginLoader.loadAll();
    } catch (err) {
      getCliLogger().warn(`[daemon] Plugin loading failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }

    if (runtimeDeps.toolRegistry) {
      for (const tool of createBuiltinTools({ pluginLoader, registry: runtimeDeps.toolRegistry })) {
        if (!runtimeDeps.toolRegistry.get(tool.metadata.name)) {
          runtimeDeps.toolRegistry.register(tool);
        }
      }
    }

    return pluginLoader;
  };

  const pluginLoader = await loadPluginsIntoDeps(deps);
  registerGlobalCrossPlatformChatSessionManager(getGlobalCrossPlatformChatSessionManager);
  const daemonBaseDir = deps.stateManager.getBaseDir();
  const personalAgentRuntime = new PersonalAgentRuntimeStore(
    resolveDaemonRuntimeRoot(daemonBaseDir, resolvedDaemonConfig.runtime_root),
    { controlBaseDir: daemonBaseDir },
  );
  const notificationConfig = await loadNotificationConfig(getNotificationConfigPath(daemonBaseDir));
  const notificationDispatcher = new NotificationDispatcher(notificationConfig, notifierRegistry, logger, personalAgentRuntime);
  deps.reportingEngine.setNotificationDispatcher(notificationDispatcher);

  // Create EventServer for event-driven wake-ups and SSE clients.
  const eventServer = new EventServer(
    deps.driveSystem,
    {
      port: resolvedDaemonConfig.event_server_port,
      eventsDir: getEventsDir(daemonBaseDir),
      runtimeRoot: resolveDaemonRuntimeRoot(daemonBaseDir, resolvedDaemonConfig.runtime_root),
      stateManager: deps.stateManager,
      healthStatusProvider: () => {
        const schemaDrift = formatControlDbSchemaDriftMessage(daemonBaseDir);
        return schemaDrift
          ? {
            status: "failed",
            reason: "unsupported_control_db_schema",
            detail: schemaDrift,
          }
          : { status: "ok" };
      },
    },
    logger
  );
  const gateway = new IngressGateway(logger);
  const builtinGatewayIntegrations = await loadBuiltinGatewayIntegrations(daemonBaseDir, logger);
  for (const adapter of builtinGatewayIntegrations.adapters) {
    gateway.registerAdapter(adapter);
  }
  for (const { name, notifier } of builtinGatewayIntegrations.notifiers) {
    notifierRegistry.register(name, notifier);
  }
  const slackGatewayConfig = resolvedDaemonConfig.gateway.slack;
  if (slackGatewayConfig.enabled) {
    if (!slackGatewayConfig.signing_secret) {
      getCliLogger().warn("[daemon] gateway.slack.enabled is true but signing_secret is missing; Slack gateway disabled.");
    } else {
      const slackAdapter = new SlackChannelAdapter({
        signingSecret: slackGatewayConfig.signing_secret,
        botToken: slackGatewayConfig.bot_token,
        channelGoalMap: slackGatewayConfig.channel_goal_map,
        capabilityDecisionRecorder: createGatewayCapabilityDecisionRecorder({ baseDir: daemonBaseDir }),
      });
      eventServer.setSlackChannelAdapter(slackAdapter, slackGatewayConfig.path);
      gateway.registerAdapter(slackAdapter);
    }
  }
  notificationDispatcher.setRealtimeSink(async (report) => {
    eventServer.broadcast("notification_report", report);
  });

  // Create ScheduleEngine with data source registry and LLM client
  const scheduleEngine = new ScheduleEngine({
    baseDir: daemonBaseDir,
    logger,
    dataSourceRegistry: deps.dataSourceRegistry,
    llmClient: deps.llmClient,
    coreLoop: deps.coreLoop,
    stateManager: deps.stateManager,
    notificationDispatcher,
    reportingEngine: deps.reportingEngine,
    hookManager: deps.hookManager,
    memoryLifecycle: deps.memoryLifecycleManager,
    knowledgeManager: deps.knowledgeManager,
    personalAgentRuntime,
  });
  await scheduleEngine.loadEntries();
  await scheduleEngine.syncExternalSources(pluginLoader.getScheduleSources());
  await scheduleEngine.ensureSoilPublishSchedule();

  const refreshResidentDeps = async () => {
    const freshDeps = await buildDeps(
      stateManager,
      characterConfigManager,
      undefined,
      approvalBridge,
      logger,
      undefined,
      resolvedDaemonConfig.workspace_path,
    );
    freshDeps.reportingEngine.setNotificationDispatcher(notificationDispatcher);

    const freshScheduleEngine = new ScheduleEngine({
      baseDir: daemonBaseDir,
      logger,
      dataSourceRegistry: freshDeps.dataSourceRegistry,
      llmClient: freshDeps.llmClient,
      coreLoop: freshDeps.coreLoop,
      stateManager: freshDeps.stateManager,
      notificationDispatcher,
      reportingEngine: freshDeps.reportingEngine,
      hookManager: freshDeps.hookManager,
      memoryLifecycle: freshDeps.memoryLifecycleManager,
      knowledgeManager: freshDeps.knowledgeManager,
      personalAgentRuntime,
    });
    await freshScheduleEngine.loadEntries();
    const freshPluginLoader = await loadPluginsIntoDeps(freshDeps);
    await freshScheduleEngine.syncExternalSources(freshPluginLoader.getScheduleSources());
    await freshScheduleEngine.ensureSoilPublishSchedule();

    return {
      coreLoop: freshDeps.coreLoop,
      curiosityEngine: freshDeps.curiosityEngine,
      goalNegotiator: freshDeps.goalNegotiator,
      llmClient: freshDeps.llmClient,
      reportingEngine: freshDeps.reportingEngine,
      scheduleEngine: freshScheduleEngine,
      memoryLifecycle: freshDeps.memoryLifecycleManager,
      knowledgeManager: freshDeps.knowledgeManager,
    };
  };

  const daemon = new DaemonRunner({
    coreLoop: deps.coreLoop,
    curiosityEngine: deps.curiosityEngine,
    goalNegotiator: deps.goalNegotiator,
    driveSystem: deps.driveSystem,
    stateManager: deps.stateManager,
    pidManager,
    logger,
    reportingEngine: deps.reportingEngine,
    config: resolvedDaemonConfig,
    eventServer,
    gateway,
    llmClient: deps.llmClient,
    scheduleEngine,
    memoryLifecycle: deps.memoryLifecycleManager,
    knowledgeManager: deps.knowledgeManager,
    personalAgentRuntime,
    getProviderRuntimeFingerprint,
    refreshResidentDeps,
  });
  daemonApprovalProvider = async (task: Task) => {
    const provider = daemon.getApprovalFn();
    if (!provider) {
      logger.warn("Daemon approval provider unavailable while processing task", {
        task_id: task.id,
        goal_id: task.goal_id,
      });
      return false;
    }
    return provider(task);
  };

  logger.info(`Starting PulSeed daemon for goals: ${formatGoalMode(goalIds)}`);
  await daemon.start(goalIds);
}

export async function cmdDaemonStatus(_args: string[]): Promise<void> {
  const baseDir = getPulseedDirPath();
  const schemaDriftMessage = formatControlDbSchemaDriftMessage(baseDir);
  if (schemaDriftMessage) {
    console.log([
      "PulSeed Daemon Status",
      "\u2500".repeat(21),
      "Status:          schema drift",
      schemaDriftMessage,
    ].join("\n"));
    return;
  }
  const pidManager = new PIDManager(baseDir);
  const pidStatus = await pidManager.inspect();
  const runtimePid = pidStatus.runtimePid ?? pidStatus.info?.pid ?? null;
  const watchdogPid = pidStatus.info?.watchdog_pid ?? pidStatus.ownerPid ?? null;
  const runtimeAlive = isPidAlive(pidStatus, runtimePid);
  const watchdogAlive = isPidAlive(pidStatus, watchdogPid);

  let loadedState;
  try {
    loadedState = await new DaemonStateStore(baseDir).load();
  } catch (error) {
    console.error(`Invalid daemon state: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (loadedState === null) {
    if (!runtimeAlive && !watchdogAlive) {
      console.log("No daemon state found");
      return;
    }
    if (!runtimeAlive && watchdogAlive) {
      console.log(
        `Daemon watchdog is running, but runtime child is restarting (PID: ${runtimePid ?? "unknown"})`
      );
      return;
    }
    console.log("Daemon process is running, but daemon state is missing");
    return;
  }
  const parsed = DaemonStateSchema.safeParse(loadedState);
  if (!parsed.success) {
    console.error(`Invalid daemon state: ${parsed.error.message}`);
    return;
  }
  const data: DaemonState = parsed.data;

  const resolvedRuntimePid = runtimePid ?? data.pid;
  const resolvedRuntimeAlive = isPidAlive(pidStatus, resolvedRuntimePid);

  // Load daemon config for config section display
  const cfg = await loadDaemonConfig(baseDir);
  const runtimeRoot = data.runtime_root ?? resolveDaemonRuntimeRoot(baseDir, cfg.runtime_root);
  const storedRuntimeHealth = await new RuntimeHealthStore(runtimeRoot, { controlBaseDir: baseDir }).loadSnapshot();
  const runtimeHealth = reconcileRuntimeHealthForDisplay(storedRuntimeHealth, {
    runtimeAlive: resolvedRuntimeAlive,
    runtimePid: resolvedRuntimePid,
  });
  const runtimeHealthReconciled =
    storedRuntimeHealth !== runtimeHealth
    && (storedRuntimeHealth?.kpi !== undefined || storedRuntimeHealth?.long_running !== undefined);
  const runtimeHealthReconciliationReason = resolvedRuntimeAlive
    ? LIVE_RUNTIME_OVERRIDES_STALE_HEALTH_REASON
    : STALE_RUNTIME_HEALTH_REASON;
  const proactiveSummary = await new ProactiveInterventionStore(runtimeRoot, { controlBaseDir: baseDir }).summarize();
  const supervisorState = await readSupervisorState(runtimeRoot, baseDir);
  const shutdownMarker = await readShutdownMarkerFile(baseDir);
  const taskKpis = await summarizeTaskOutcomeLedgers(baseDir);
  const safePauseGoals = Object.values(data.safe_pause_goals ?? {});
  const hasPauseRequested = safePauseGoals.some((pause) => pause.state === "pause_requested");
  const hasPaused = safePauseGoals.some((pause) => pause.state === "paused");

  const status =
    !resolvedRuntimeAlive
      ? watchdogAlive
        ? "restarting"
        : data.status === "crashed"
          ? "crashed"
          : data.status === "stopping"
            ? "stopping"
            : "stopped"
      : hasPauseRequested
        ? "pause requested"
        : hasPaused && data.active_goals.length === 0
          ? "paused"
      : data.status === "crashed" || data.status === "stopping"
        ? data.status
        : data.status === "idle"
          ? "idle"
          : "running";
  const lines: string[] = [
    "PulSeed Daemon Status",
    "\u2500".repeat(21),
    `Status:          ${status} (PID: ${resolvedRuntimePid})`,
  ];
  const liveRuntimeStopped = status === "stopped" || status === "crashed";
  const statusCheckedAt = Date.now();
  const historicalSnapshotContext = liveRuntimeStopped
    ? {
      lastObservedAt: parseHistoricalObservationTime(data.last_loop_at),
      stoppedAt: shutdownMarker?.timestamp,
      checkedAt: statusCheckedAt,
    }
    : null;

  if (watchdogPid && watchdogPid !== resolvedRuntimePid) {
    lines.push(`Watchdog PID:    ${watchdogPid}${watchdogAlive ? "" : " (missing)"}`);
  }

  if (data.started_at) {
    if (resolvedRuntimeAlive) {
      lines.push(`Uptime:          ${formatUptime(data.started_at)}`);
    }
    lines.push(`Started:         ${data.started_at}`);
  }
  if (liveRuntimeStopped) {
    if (shutdownMarker?.timestamp) {
      lines.push(`Stopped:         ${shutdownMarker.timestamp} (${formatRelativeTime(shutdownMarker.timestamp)})`);
    }
    lines.push("Live runtime:    stopped; snapshot fields below are historical until the daemon restarts");
  }

  lines.push("");
  lines.push(`Loops:           ${data.loop_count} cycles completed`);

  const snapshotWorkers = (supervisorState?.workers ?? []).filter((worker) => worker.goalId !== null);
  const activeWorkers = resolvedRuntimeAlive ? snapshotWorkers : [];
  const artifactExpectation = resolveStatusArtifactExpectation({
    activeGoalIds: data.active_goals,
    activeWorkerCount: activeWorkers.length,
    daemonStatus: data.status,
    liveRuntimeStopped,
    workerSnapshotAvailable: supervisorState !== null,
  });
  if (activeWorkers.length > 0) {
    lines.push(`In flight:       ${activeWorkers.length} worker${activeWorkers.length === 1 ? "" : "s"} active`);
    for (const worker of activeWorkers) {
      const started = worker.startedAt > 0 ? formatRelativeTimestamp(worker.startedAt) : "just now";
      const progress =
        worker.iterations > 0 ? `, ${worker.iterations} iteration${worker.iterations === 1 ? "" : "s"}` : "";
      lines.push(`  Worker ${worker.workerId}: ${worker.goalId} (${started}${progress})`);
    }
  }
  if (liveRuntimeStopped && snapshotWorkers.length > 0) {
    const workerHistoricalContext = formatHistoricalSnapshotContext({
      lastObservedAt: supervisorState?.updatedAt,
      stoppedAt: shutdownMarker?.timestamp,
      checkedAt: statusCheckedAt,
    });
    const observedAt = supervisorState?.updatedAt
      ? ` observed ${formatRelativeTimestamp(supervisorState.updatedAt)}`
      : "";
    lines.push(
      `Historical in-flight: ${snapshotWorkers.length} stale worker${snapshotWorkers.length === 1 ? "" : "s"} from stopped snapshot${observedAt}${workerHistoricalContext}`
    );
    for (const worker of snapshotWorkers) {
      const started = worker.startedAt > 0 ? formatRelativeTimestamp(worker.startedAt) : "unknown start";
      const progress =
        worker.iterations > 0 ? `, ${worker.iterations} iteration${worker.iterations === 1 ? "" : "s"}` : "";
      lines.push(`  Stale worker ${worker.workerId}: ${worker.goalId} (${started}${progress})`);
    }
  }

  if (data.last_loop_at) {
    lines.push(`Last cycle:      ${formatRelativeTime(data.last_loop_at)}`);
  }

  lines.push(
    liveRuntimeStopped
      ? `Historical active goals: ${data.active_goals.join(", ") || "(none)"}${formatHistoricalSnapshotContext(historicalSnapshotContext!)}`
      : `Active goals:    ${data.active_goals.join(", ") || "(none)"}`
  );
  const waitingGoals = data.waiting_goals ?? [];
  if (
    waitingGoals.length > 0
    || data.next_observe_at
    || data.last_observe_at
    || data.last_wait_reason
    || data.approval_pending_count
  ) {
    lines.push("");
    lines.push(liveRuntimeStopped ? "Historical wait status:" : "Wait status:");
    lines.push(`  Waiting goals:  ${waitingGoals.length}`);
    if (data.next_observe_at) {
      lines.push(`  Next observe:   ${formatRelativeTime(data.next_observe_at)}`);
    }
    if (data.last_observe_at) {
      lines.push(`  Last observe:   ${formatRelativeTime(data.last_observe_at)}`);
    }
    if (data.last_wait_reason) {
      lines.push(`  Last reason:    ${data.last_wait_reason}`);
    }
    if (data.approval_pending_count !== undefined) {
      lines.push(`  Approvals:      ${data.approval_pending_count} pending`);
    }
    for (const waitGoal of waitingGoals.slice(0, 5)) {
      const approval = waitGoal.approval_pending ? ", approval pending" : "";
      const source = waitGoal.internal_schedule ? ", schedule-projected" : "";
      const activation = waitGoal.activation_kind ? `, ${waitGoal.activation_kind}` : "";
      lines.push(
        `  - ${waitGoal.goal_id}/${waitGoal.strategy_id}: observe `
          + `${formatRelativeTime(waitGoal.next_observe_at)} (${waitGoal.wait_reason}${approval}${source}${activation})`
      );
    }
    if (waitingGoals.length > 5) {
      const remainingGoals = waitingGoals.length - 5;
      lines.push(`  ... ${remainingGoals} more waiting goal${remainingGoals === 1 ? "" : "s"}`);
    }
  }
  if (data.resident_activity) {
    const residentAgo = formatRelativeTime(data.resident_activity.recorded_at);
    lines.push(`Resident:        ${data.resident_activity.kind} (${residentAgo})`);
    if (data.resident_activity.intervention_id) {
      lines.push(`Resident event:  ${data.resident_activity.intervention_id}`);
    }
    lines.push(`Resident note:   ${data.resident_activity.summary}`);
    if (data.resident_activity.goal_id) {
      lines.push(`Resident goal:   ${data.resident_activity.goal_id}`);
    }
  }
  if (proactiveSummary.total_interventions > 0) {
    lines.push("");
    lines.push("Proactive quality:");
    lines.push(`  Interventions: ${proactiveSummary.total_interventions} (${proactiveSummary.pending_count} pending feedback)`);
    lines.push(`  Accepted:      ${proactiveSummary.accepted_count} (${formatPercent(proactiveSummary.accepted_rate)})`);
    lines.push(`  Ignored:       ${proactiveSummary.ignored_count} (${formatPercent(proactiveSummary.ignored_rate)})`);
    lines.push(`  Corrected:     ${proactiveSummary.corrected_count} (${formatPercent(proactiveSummary.correction_rate)})`);
    lines.push(`  Overreach:     ${proactiveSummary.overreach_count} (${formatPercent(proactiveSummary.overreach_rate)})`);
    if (proactiveSummary.policy_adjustment_recommendation) {
      lines.push(`  Policy:        ${proactiveSummary.policy_adjustment_recommendation.suggested_action} for ${proactiveSummary.policy_adjustment_recommendation.relationship_profile_key}`);
    }
  }

  if (safePauseGoals.length > 0) {
    lines.push("");
    lines.push("Safe pause:");
    for (const pause of safePauseGoals.slice(0, 5)) {
      const checkpoint = pause.checkpoint?.checkpointed_at
        ? `, checkpoint ${formatRelativeTimestamp(new Date(pause.checkpoint.checkpointed_at).getTime())}`
        : "";
      lines.push(`  - ${pause.goal_id}: ${pause.state}${checkpoint}`);
      if (pause.checkpoint?.next_action) {
        lines.push(`    Next action: ${pause.checkpoint.next_action}`);
      }
    }
    if (safePauseGoals.length > 5) {
      lines.push(`  ... ${safePauseGoals.length - 5} more safe-pause record${safePauseGoals.length === 6 ? "" : "s"}`);
    }
  }

  if (runtimeHealth?.kpi) {
    lines.push("");
    lines.push("Runtime health:");
    if (runtimeHealthReconciled) {
      lines.push(`  Snapshot note:  ${runtimeHealthReconciliationReason}.`);
    }
    lines.push(`  ${formatCapabilityLabel("Process alive:", runtimeHealth.kpi, "process_alive")}`);
    lines.push(`  ${formatCapabilityLabel("Accept command:", runtimeHealth.kpi, "command_acceptance")}`);
    lines.push(`  ${formatCapabilityLabel("Execute task:", runtimeHealth.kpi, "task_execution")}`);
    lines.push(`  ${formatKpiCompactLine(runtimeHealth.kpi)}`);
    const taskSuccessRate = runtimeHealth.details?.task_success_rate as number | null | undefined;
    const taskOutcome = runtimeHealth.details?.task_outcome as RuntimeTaskOutcomeDetails | undefined;
    if (taskSuccessRate !== undefined) {
      lines.push(`  ${formatTaskSuccessRateLine(taskSuccessRate, taskOutcome)}`);
    }
    if (taskOutcome) {
      lines.push(`  Important task success rate: ${formatTaskOutcomeLine(taskOutcome)}`);
    }
    if (runtimeHealth.kpi.degraded_at !== undefined) {
      lines.push(`  Degraded at:     ${formatAbsoluteRelativeTimestamp(runtimeHealth.kpi.degraded_at)}`);
    }
    if (runtimeHealth.kpi.recovered_at !== undefined) {
      lines.push(`  Recovered at:    ${formatAbsoluteRelativeTimestamp(runtimeHealth.kpi.recovered_at)}`);
    }
  }

  if (runtimeHealth?.long_running) {
    lines.push("");
    lines.push("Long-run health:");
    if (runtimeHealthReconciled) {
      lines.push(`  Snapshot note:  ${runtimeHealthReconciliationReason}.`);
    }
    lines.push(...formatLongRunHealthLines(runtimeHealth.long_running, {
      historical: liveRuntimeStopped,
      artifactExpectation,
    }));
  }

  if (taskKpis.total_tasks > 0) {
    lines.push("");
    lines.push("Task KPIs:");
    lines.push(
      liveRuntimeStopped
        ? `  Historical in-flight: ${taskKpis.inflight_tasks}/${taskKpis.total_tasks} (stale snapshot)${formatHistoricalSnapshotContext(historicalSnapshotContext!)}`
        : `  In-flight:       ${taskKpis.inflight_tasks}/${taskKpis.total_tasks}`
    );
    lines.push(
      `  Success rate:    ${taskKpis.succeeded}/${taskKpis.terminal_tasks} (${formatPercent(taskKpis.success_rate)})`
    );
    lines.push(
      `  Retry rate:      ${taskKpis.retried}/${taskKpis.total_tasks} (${formatPercent(taskKpis.retry_rate)})`
    );
    lines.push(
      `  Abandoned rate:  ${taskKpis.abandoned}/${taskKpis.terminal_tasks} (${formatPercent(taskKpis.abandoned_rate)})`
    );
    const failureReasons = formatTaskFailureReasonCounts(taskKpis.failure_stopped_reasons);
    if (failureReasons) {
      lines.push(`  Failure reasons:${" ".repeat(1)}${failureReasons}`);
    }
    if (taskKpis.p95_created_to_acked_ms !== null) {
      lines.push(`  Ack latency:     p95 ${formatDurationMs(taskKpis.p95_created_to_acked_ms)}`);
    }
    if (taskKpis.p95_started_to_completed_ms !== null) {
      lines.push(`  Run latency:     p95 ${formatDurationMs(taskKpis.p95_started_to_completed_ms)}`);
    }
    if (taskKpis.p95_created_to_completed_ms !== null) {
      lines.push(`  Total latency:   p95 ${formatDurationMs(taskKpis.p95_created_to_completed_ms)}`);
    }
  }

  // Config section
  const intervalMin = Math.round(cfg.check_interval_ms / 60000);
  const adaptiveSleep = cfg.adaptive_sleep.enabled ? "on" : "off";
  const proactive = cfg.proactive_mode ? "on" : "off";
  const crashEnabled = cfg.crash_recovery.enabled ? "enabled" : "disabled";
  const maxRetries = cfg.crash_recovery.max_retries;
  const runPolicy =
    cfg.run_policy.mode === "resident"
      ? "resident (unbounded; iterations reported as telemetry)"
      : `bounded (${cfg.run_policy.max_iterations ?? cfg.iterations_per_cycle} iterations max)`;
  const workerCycle =
    cfg.run_policy.mode === "resident"
      ? `${cfg.iterations_per_cycle} iteration telemetry window`
      : `${cfg.run_policy.max_iterations ?? cfg.iterations_per_cycle} iterations max`;

  lines.push("");
  lines.push("Config:");
  lines.push(`  Interval:      ${intervalMin}m (adaptive sleep: ${adaptiveSleep})`);
  lines.push(`  Run policy:    ${runPolicy}`);
  lines.push(`  Worker cycle:  ${workerCycle}`);
  lines.push(`  Concurrency:   ${cfg.max_concurrent_goals} goal${cfg.max_concurrent_goals === 1 ? "" : "s"}`);
  lines.push(`  Proactive:     ${proactive}`);
  lines.push("  Runtime:       durable auto-recovery");
  if (cfg.runtime_root) {
    lines.push(`  Runtime root:  ${cfg.runtime_root}`);
  }
  lines.push(`  Crash recovery: ${crashEnabled} (${data.crash_count}/${maxRetries} retries used)`);

  lines.push("");
  lines.push(`Last error:      ${data.last_error ?? "none"}`);

  console.log(lines.join("\n"));
}

async function stopDaemonRuntimeForCli(): Promise<StopDaemonOutcome> {
  const pidManager = new PIDManager(getPulseedDirPath());
  const stopResult = await pidManager.stopRuntime();
  if (!stopResult.info || stopResult.sentSignalsTo.length === 0) {
    return { status: "not_running", messages: ["No running daemon found"] };
  }
  const displayPid = stopResult.runtimePid ?? stopResult.ownerPid ?? stopResult.info.pid;
  const messages = [`Stopping daemon (PID: ${displayPid})...`];
  if (!stopResult.stopped) {
    messages.push(`Daemon still running (PIDs: ${stopResult.alivePids.join(", ")})`);
    return { status: "failed", messages };
  }
  if (stopResult.forced) {
    messages.push("Daemon stopped after forcing remaining runtime processes");
    return { status: "stopped", messages };
  }
  messages.push("Daemon stopped");
  return { status: "stopped", messages };
}

export async function cmdStop(_args: string[]): Promise<void> {
  const outcome = await stopDaemonRuntimeForCli();
  for (const message of outcome.messages) {
    console.log(message);
  }
}

export async function cmdRestart(
  stateManager: StateManager,
  characterConfigManager: CharacterConfigManager,
  args: string[],
): Promise<number> {
  const stopOutcome = await stopDaemonRuntimeForCli();
  for (const message of stopOutcome.messages) {
    console.log(message);
  }

  if (stopOutcome.status === "failed") {
    console.log("Daemon restart aborted; run `pulseed daemon status` to inspect the current state.");
    return 1;
  }

  console.log("Starting daemon...");
  await cmdStart(stateManager, characterConfigManager, args, {
    childCommandArgs: ["daemon", "start", ...args],
  });
  return 0;
}

export async function cmdDaemonPing(_args: string[]): Promise<number> {
  const baseDir = getPulseedDirPath();
  const schemaDriftMessage = formatControlDbSchemaDriftMessage(baseDir);
  if (schemaDriftMessage) {
    console.log(`Daemon ping failed: ${schemaDriftMessage}`);
    return 1;
  }
  const cfg = await loadDaemonConfig(baseDir);
  const port = cfg.event_server_port;
  const probe = await probeDaemonHealth({ host: "127.0.0.1", port });

  if (probe.ok) {
    console.log(formatDaemonPong(probe));
    return 0;
  }

  const daemonInfo = await isDaemonRunning(baseDir);
  if (daemonInfo.running && daemonInfo.port !== port) {
    const resolvedProbe = await probeDaemonHealth({ host: "127.0.0.1", port: daemonInfo.port });
    if (resolvedProbe.ok) {
      console.log(formatDaemonPong(resolvedProbe));
      return 0;
    }
  }
  const stateRaw = await new DaemonStateStore(baseDir).load() as Record<string, unknown> | null;
  const stateDetail =
    stateRaw && typeof stateRaw.status === "string"
      ? `, daemon state ${stateRaw.status}`
      : daemonInfo.running
        ? ", daemon state running"
        : ", daemon state unavailable";
  const message = probe.error ?? "unknown error";
  console.log(`Daemon ping failed: no response from EventServer on port ${port}${stateDetail} (${message})`);
  return 1;
}

function formatDaemonPong(probe: Awaited<ReturnType<typeof probeDaemonHealth>>): string {
  const health = probe.health ?? {};
  const status = typeof health.status === "string" ? health.status : "ok";
  const uptime =
    typeof health.uptime === "number" && Number.isFinite(health.uptime)
      ? `, uptime ${health.uptime.toFixed(1)}s`
      : "";
  return `Daemon pong: ${status} (${probe.latency_ms}ms, port ${probe.port}${uptime})`;
}

export async function cmdCron(args: string[]): Promise<number> {
  let values: { goal?: string[]; interval?: string };
  try {
    ({ values } = parseArgs({
      args,
      options: {
        goal: { type: "string", multiple: true },
        interval: { type: "string", default: "60" },
      },
      strict: false,
    }) as { values: { goal?: string[]; interval?: string } });
  } catch (err) {
    getCliLogger().error(formatOperationError("parse cron command arguments", err));
    values = {};
  }

  const goalIds = (values.goal as string[]) || [];
  let intervalMinutes: number;
  try {
    intervalMinutes = parseDaemonPositiveInteger(values.interval ?? "60", "--interval");
  } catch (err) {
    getCliLogger().error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  if (goalIds.length === 0) {
    getCliLogger().error(
      "Error: at least one --goal is required for pulseed cron.\nUsage: pulseed cron --goal <id> [--goal <id> ...]"
    );
    return 1;
  }

  console.log("# PulSeed crontab entries");
  console.log("# Add these to your crontab with: crontab -e");
  for (const goalId of goalIds) {
    console.log(DaemonRunner.generateCronEntry(goalId, intervalMinutes));
  }
  return 0;
}
