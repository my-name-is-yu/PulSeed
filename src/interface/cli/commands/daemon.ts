// ─── pulseed daemon commands (start, stop, cron, status) ───

import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import * as path from "node:path";
import { readJsonFileOrNull } from "../../../base/utils/json-io.js";
import { DaemonStateSchema, DaemonConfigSchema } from "../../../base/types/daemon.js";
import type { DaemonState, DaemonConfig } from "../../../base/types/daemon.js";
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
  loadBuiltinGatewayIntegrations,
} from "../../../runtime/gateway/index.js";
import { ScheduleEngine } from "../../../runtime/schedule/engine.js";
import { RuntimeWatchdog } from "../../../runtime/watchdog.js";
import { LeaderLockManager } from "../../../runtime/leader-lock-manager.js";
import { ProactiveInterventionStore, RuntimeHealthStore } from "../../../runtime/store/index.js";
import type { RuntimeHealthSnapshot } from "../../../runtime/store/index.js";
import { isDaemonRunning, probeDaemonHealth } from "../../../runtime/daemon/client.js";
import { PluginLoader } from "../../../runtime/plugin-loader.js";
import { NotifierRegistry } from "../../../runtime/notifier-registry.js";
import { NotificationDispatcher } from "../../../runtime/notification-dispatcher.js";
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

const WATCHDOG_CHILD_ENV = "PULSEED_WATCHDOG_CHILD";
const STALE_RUNTIME_HEALTH_REASON = "live PID inspection reports runtime stopped; stored health snapshot is historical";

interface HistoricalSnapshotContext {
  lastObservedAt?: number;
  stoppedAt?: string;
  checkedAt: number;
}

function formatHistoricalSnapshotContext(context: HistoricalSnapshotContext): string {
  const parts = ["historical snapshot"];
  if (context.lastObservedAt !== undefined) {
    parts.push(
      `last observed ${new Date(context.lastObservedAt).toISOString()} (${formatRelativeTimestamp(context.lastObservedAt)})`
    );
  }
  if (context.stoppedAt) {
    parts.push(`stopped ${context.stoppedAt} (${formatRelativeTime(context.stoppedAt)})`);
  }
  parts.push(`checked ${new Date(context.checkedAt).toISOString()} (${formatRelativeTimestamp(context.checkedAt)})`);
  return ` (${parts.join("; ")})`;
}

function parseHistoricalObservationTime(value: string | null | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? undefined : parsed;
}

function reconcileRuntimeHealthForDisplay(
  snapshot: RuntimeHealthSnapshot | null,
  opts: { runtimeAlive: boolean; runtimePid: number | null }
): RuntimeHealthSnapshot | null {
  if (!snapshot || opts.runtimeAlive) {
    return snapshot;
  }

  const checkedAt = Date.now();
  const staleRuntimePid = opts.runtimePid ?? snapshot.long_running?.signals.process.pid;
  const kpi: RuntimeHealthSnapshot["kpi"] = snapshot.kpi
    ? {
      ...snapshot.kpi,
      process_alive: {
        ...snapshot.kpi.process_alive,
        status: "failed",
        checked_at: checkedAt,
        last_failed_at: checkedAt,
        reason: STALE_RUNTIME_HEALTH_REASON,
      },
      degraded_at: snapshot.kpi.degraded_at ?? checkedAt,
    }
    : undefined;

  const longRunning: RuntimeHealthSnapshot["long_running"] = snapshot.long_running
    ? {
      ...snapshot.long_running,
      summary: snapshot.long_running.signals.resumable ? "dead_but_resumable" : "dead_needs_intervention",
      checked_at: checkedAt,
      signals: {
        ...snapshot.long_running.signals,
        process: {
          ...snapshot.long_running.signals.process,
          status: "dead",
          pid: staleRuntimePid,
          checked_at: checkedAt,
          observed_at: checkedAt,
          reason: STALE_RUNTIME_HEALTH_REASON,
        },
      },
    }
    : undefined;

  return {
    ...snapshot,
    status: "failed",
    checked_at: checkedAt,
    kpi,
    long_running: longRunning,
  };
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
  args: string[]
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

  // --detach: spawn a detached process and exit immediately.
  // The detached process becomes the watchdog parent.
  if (values.detach) {
    const scriptPath = process.argv[1]!;
    const childArgs = process.argv
      .slice(2)
      .filter((arg) => arg !== "--detach" && arg !== "-d");

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
    console.log(`Daemon started in background (PID: ${child.pid})`);
    process.exit(0);
  }

  if (!isWatchdogChild && await pidManager.isRunning()) {
    const info = await pidManager.readPID();
    logger.error(`Daemon already running (PID: ${info?.pid})`);
    process.exit(1);
  }

  if (shouldUseWatchdog) {
    const runtimeRoot = resolveDaemonRuntimeRoot(baseDir, resolvedDaemonConfig.runtime_root);
    const healthStore = new RuntimeHealthStore(runtimeRoot);
    const leaderLockManager = new LeaderLockManager(runtimeRoot);
    const scriptPath = process.argv[1]!;
    const childArgs = process.argv.slice(2);
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
  const notificationConfig = await loadNotificationConfig(getNotificationConfigPath(daemonBaseDir));
  const notificationDispatcher = new NotificationDispatcher(notificationConfig, notifierRegistry);
  deps.reportingEngine.setNotificationDispatcher(notificationDispatcher);

  // Create EventServer for event-driven wake-ups and SSE clients.
  const eventServer = new EventServer(
    deps.driveSystem,
    {
      port: resolvedDaemonConfig.event_server_port,
      eventsDir: getEventsDir(daemonBaseDir),
      runtimeRoot: resolveDaemonRuntimeRoot(daemonBaseDir, resolvedDaemonConfig.runtime_root),
      stateManager: deps.stateManager,
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
  const statePath = path.join(baseDir, "daemon-state.json");
  const pidManager = new PIDManager(baseDir);
  const pidStatus = await pidManager.inspect();
  const runtimePid = pidStatus.runtimePid ?? pidStatus.info?.pid ?? null;
  const watchdogPid = pidStatus.info?.watchdog_pid ?? pidStatus.ownerPid ?? null;
  const runtimeAlive = isPidAlive(pidStatus, runtimePid);
  const watchdogAlive = isPidAlive(pidStatus, watchdogPid);

  const raw = await readJsonFileOrNull(statePath);
  if (raw === null) {
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
    console.log("Daemon process is running, but daemon-state.json is missing");
    return;
  }
  const parsed = DaemonStateSchema.safeParse(raw);
  if (!parsed.success) {
    console.error(`Invalid daemon state: ${parsed.error.message}`);
    return;
  }
  const data: DaemonState = parsed.data;

  const resolvedRuntimePid = runtimePid ?? data.pid;
  const resolvedRuntimeAlive = isPidAlive(pidStatus, resolvedRuntimePid);

  // Load daemon config for config section display
  const cfg = await loadDaemonConfig(baseDir);
  const runtimeRoot = resolveDaemonRuntimeRoot(baseDir, cfg.runtime_root);
  const storedRuntimeHealth = await new RuntimeHealthStore(runtimeRoot).loadSnapshot();
  const runtimeHealth = reconcileRuntimeHealthForDisplay(storedRuntimeHealth, {
    runtimeAlive: resolvedRuntimeAlive,
    runtimePid: resolvedRuntimePid,
  });
  const runtimeHealthReconciled =
    storedRuntimeHealth !== runtimeHealth
    && (storedRuntimeHealth?.kpi !== undefined || storedRuntimeHealth?.long_running !== undefined);
  const proactiveSummary = await new ProactiveInterventionStore(runtimeRoot).summarize();
  const supervisorState = await readSupervisorState(runtimeRoot);
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
      lines.push(`  Snapshot note:  ${STALE_RUNTIME_HEALTH_REASON}.`);
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
      lines.push(
        `  Degraded at:     ${new Date(runtimeHealth.kpi.degraded_at).toISOString()} (${formatRelativeTimestamp(runtimeHealth.kpi.degraded_at)})`
      );
    }
    if (runtimeHealth.kpi.recovered_at !== undefined) {
      lines.push(
        `  Recovered at:    ${new Date(runtimeHealth.kpi.recovered_at).toISOString()} (${formatRelativeTimestamp(runtimeHealth.kpi.recovered_at)})`
      );
    }
  }

  if (runtimeHealth?.long_running) {
    lines.push("");
    lines.push("Long-run health:");
    if (runtimeHealthReconciled) {
      lines.push(`  Snapshot note:  ${STALE_RUNTIME_HEALTH_REASON}.`);
    }
    lines.push(...formatLongRunHealthLines(runtimeHealth.long_running, { historical: liveRuntimeStopped }));
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

export async function cmdStop(_args: string[]): Promise<void> {
  const pidManager = new PIDManager(getPulseedDirPath());
  const stopResult = await pidManager.stopRuntime();
  if (!stopResult.info || stopResult.sentSignalsTo.length === 0) {
    console.log("No running daemon found");
    return;
  }
  const displayPid = stopResult.runtimePid ?? stopResult.ownerPid ?? stopResult.info.pid;
  console.log(`Stopping daemon (PID: ${displayPid})...`);
  if (!stopResult.stopped) {
    console.log(`Daemon still running (PIDs: ${stopResult.alivePids.join(", ")})`);
    return;
  }
  if (stopResult.forced) {
    console.log("Daemon stopped after forcing remaining runtime processes");
    return;
  }
  console.log("Daemon stopped");
}

export async function cmdDaemonPing(_args: string[]): Promise<number> {
  const baseDir = getPulseedDirPath();
  const cfg = await loadDaemonConfig(baseDir);
  const port = cfg.event_server_port;
  const probe = await probeDaemonHealth({ host: "127.0.0.1", port });

  if (probe.ok) {
    const health = probe.health ?? {};
    const latencyMs = probe.latency_ms;
    const status = typeof health.status === "string" ? health.status : "ok";
    const uptime =
      typeof health.uptime === "number" && Number.isFinite(health.uptime)
        ? `, uptime ${health.uptime.toFixed(1)}s`
        : "";
    console.log(`Daemon pong: ${status} (${latencyMs}ms, port ${port}${uptime})`);
    return 0;
  }

  const daemonInfo = await isDaemonRunning(baseDir);
  const stateRaw = await readJsonFileOrNull(path.join(baseDir, "daemon-state.json")) as Record<string, unknown> | null;
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
