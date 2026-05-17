// ─── pulseed doctor — installation health check ───

import * as fs from "node:fs";
import * as path from "node:path";
import { getPulseedDirPath, getLogsDir, getPluginsDir } from "../../../base/utils/paths.js";
import { execFileNoThrow } from "../../../base/utils/execFileNoThrow.js";
import { getCliRunnerBuildPath } from "../../../base/utils/pulseed-meta.js";
import {
  isTextFileSizeLimitError,
  readJsonFileOrNull,
  readTextFileWithinLimitSync,
} from "../../../base/utils/json-io.js";
import { isJwtExpired, loadProviderConfig, resolveOpenAIApiKey, validateProviderConfig } from "../../../base/llm/provider-config.js";
import { DaemonConfigSchema } from "../../../base/types/daemon.js";
import { PIDManager } from "../../../runtime/pid-manager.js";
import { probeDaemonHealth } from "../../../runtime/daemon/client.js";
import { readPluginManifestSync } from "../../../runtime/plugin-manifest-reader.js";
import {
  ApprovalStore,
  DaemonStateStore,
  GoalTaskStateStore,
  importLegacyCapabilityDependencyState,
  importLegacyExecutionSessionState,
  importLegacyCapabilityRegistryState,
  importLegacyCuriosityState,
  importLegacyEthicsLogState,
  importLegacyGoalOrchestrationState,
  importLegacyRelationshipProfileProposalState,
  importLegacyStallState,
  importLegacyTransferTrustState,
  importLegacyTrustState,
  OutboxStore,
  RuntimeHealthStore,
  compactRuntimeHealthKpi,
  createRuntimeStorePaths,
  inspectControlDatabase,
  importLegacyGoalTaskDurableLoopState,
  importLegacyKnowledgeMemoryState,
  importLegacyKnowledgeTransferState,
  importLegacyLearningRuntimeState,
  importLegacyMemoryLifecycleState,
  importLegacyPluginChannelRuntimeState,
  importLegacyQueueDaemonScheduleState,
  importLegacyRuntimeEvidenceStrategyDreamState,
  importLegacyRuntimeFileState,
  type RuntimeHealthKpi,
} from "../../../runtime/store/index.js";
import { importLegacyDreamDecisionHeuristics } from "../../../runtime/store/dream-decision-heuristic-migration.js";
import { runRuntimeStoreMaintenanceCycle, type RuntimeMaintenanceLogger } from "../../../runtime/daemon/maintenance.js";
import { migrateLegacyCronTasksIfNeeded } from "../../../runtime/schedule/legacy-cron-migration.js";
import { DaemonStateSchema } from "../../../runtime/types/daemon.js";
import { summarizeTaskOutcomeLedgers } from "../../../orchestrator/execution/task/task-outcome-ledger.js";
import { assessTaskAgentLoopToolProfileFromTools, nativeTaskAgentLoopToolProfile } from "../../../orchestrator/execution/agent-loop/agent-loop-dogfood-benchmark.js";
import { ToolRegistry } from "../../../tools/registry.js";
import { createBuiltinTools } from "../../../tools/builtin/index.js";
import { importLegacyChatAgentLoopSessionState } from "../../chat/chat-agentloop-state-migration.js";
import { importLegacyDriveGoalScheduleState } from "../../../platform/drive/drive-schedule-state-migration.js";
import { importLegacyKnowledgeGraphState } from "../../../platform/knowledge/knowledge-graph-state-migration.js";
import { importLegacyVectorIndexState } from "../../../platform/knowledge/vector-index-state-migration.js";
import { importLegacyStrategyTemplateState } from "../../../orchestrator/strategy/strategy-template-state-migration.js";
import { importLegacyReflectionReportState } from "../../../reflection/reflection-report-state-migration.js";
import {
  formatDurationMs,
  formatPercent,
  formatRelativeTimestamp,
} from "./display-format.js";
import { importLegacyRunSpecState } from "../../../runtime/run-spec/index.js";

// ─── Types ───

type CheckStatus = "pass" | "fail" | "warn";

const DOCTOR_PROVIDER_CONFIG_TEXT_MAX_BYTES = 1024 * 1024;

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
}

function resolveDaemonRuntimeRoot(baseDir: string, configuredRoot?: string): string {
  if (!configuredRoot || configuredRoot.trim() === "") {
    return path.join(baseDir, "runtime");
  }
  return path.isAbsolute(configuredRoot)
    ? configuredRoot
    : path.resolve(baseDir, configuredRoot);
}

async function loadDaemonConfig(baseDir: string) {
  const configPath = path.join(baseDir, "daemon.json");
  const legacyConfigPath = path.join(baseDir, "daemon-config.json");
  const configRaw =
    (await readJsonFileOrNull(configPath)) ??
    (await readJsonFileOrNull(legacyConfigPath));
  const parsed = configRaw !== null ? DaemonConfigSchema.safeParse(configRaw) : null;
  return parsed?.success ? parsed.data : DaemonConfigSchema.parse({});
}

async function resolveRepairRuntimeRoot(baseDir: string): Promise<string> {
  const storedState = await new DaemonStateStore(baseDir).load().catch(() => null);
  if (storedState?.runtime_root) {
    return storedState.runtime_root;
  }

  const legacyStateRaw = await readJsonFileOrNull(path.join(baseDir, "daemon-state.json"));
  const legacyState = DaemonStateSchema.safeParse(legacyStateRaw);
  if (legacyState.success && legacyState.data.runtime_root) {
    return legacyState.data.runtime_root;
  }

  const daemonConfig = await loadDaemonConfig(baseDir);
  return resolveDaemonRuntimeRoot(baseDir, daemonConfig.runtime_root);
}

function formatCompactKpiDetail(kpi: RuntimeHealthKpi): string {
  const compact = compactRuntimeHealthKpi(kpi);
  if (!compact) {
    return "KPI unavailable";
  }
  return `KPI process=${compact.process_alive ? "up" : "down"} accept=${compact.can_accept_command ? "up" : "down"} execute=${compact.can_execute_task ? "up" : "down"} (${compact.status})`;
}

function formatFailureReasonCounts(failureReasons: {
  timeout: number;
  policy_blocked?: number;
  cancelled: number;
  error: number;
  unknown: number;
  other: number;
}): string | null {
  const policyBlocked = failureReasons.policy_blocked ?? 0;
  const total =
    failureReasons.timeout +
    policyBlocked +
    failureReasons.cancelled +
    failureReasons.error +
    failureReasons.unknown +
    failureReasons.other;
  if (total === 0) return null;
  return `failures timeout=${failureReasons.timeout}, policy_blocked=${policyBlocked}, cancelled=${failureReasons.cancelled}, error=${failureReasons.error}, unknown=${failureReasons.unknown}, other=${failureReasons.other}`;
}

function formatLivePingDetail(latencyMs: number, error?: string): string {
  const latency = formatDurationMs(latencyMs);
  return error ? `live ping failed (${latency}; ${error})` : `live ping ok (${latency})`;
}

function formatOctalMode(mode: number): string {
  return `0${(mode & 0o777).toString(8)}`;
}

function isGroupOrWorldAccessible(mode: number): boolean {
  return (mode & 0o077) !== 0;
}

function formatNameList(names: string[], limit = 5): string {
  const shown = names.slice(0, limit).join(", ");
  return names.length > limit ? `${shown}, +${names.length - limit} more` : shown;
}

function readProviderConfigTextSync(configPath: string): string {
  return readTextFileWithinLimitSync(configPath, {
    maxBytes: DOCTOR_PROVIDER_CONFIG_TEXT_MAX_BYTES,
  });
}

function inspectProviderConfigStoredApiKey(
  configPath: string,
  displayPath: string,
): { status: "ok"; hasStoredApiKey: boolean } | { status: "warn"; detail: string } {
  try {
    const content = readProviderConfigTextSync(configPath);
    const parsed = JSON.parse(content) as unknown;
    const hasStoredApiKey =
      parsed !== null &&
      typeof parsed === "object" &&
      typeof (parsed as Record<string, unknown>)["api_key"] === "string" &&
      ((parsed as Record<string, string>)["api_key"] ?? "").length > 0;
    return { status: "ok", hasStoredApiKey };
  } catch (err) {
    const detail = isTextFileSizeLimitError(err)
      ? `${displayPath} exceeds ${DOCTOR_PROVIDER_CONFIG_TEXT_MAX_BYTES} bytes`
      : `${displayPath} could not be parsed`;
    return { status: "warn", detail };
  }
}

function formatProviderConfigParseFailure(displayPath: string, err: unknown): string {
  if (isTextFileSizeLimitError(err)) {
    return `${displayPath} exceeds ${DOCTOR_PROVIDER_CONFIG_TEXT_MAX_BYTES} bytes`;
  }
  return `${displayPath} is invalid JSON`;
}

// ─── Individual checks ───

export function checkNodeVersion(): CheckResult {
  const version = process.versions.node;
  const major = parseInt(version.split(".")[0] ?? "0", 10);
  if (major >= 20) {
    return { name: "Node.js version", status: "pass", detail: `v${version} (>= 20 required)` };
  }
  return { name: "Node.js version", status: "fail", detail: `v${version} (>= 20 required)` };
}

export function checkPulseedDir(baseDir?: string): CheckResult {
  const dir = baseDir ?? getPulseedDirPath();
  const displayDir = dir.replace(process.env["HOME"] ?? "", "~");
  if (fs.existsSync(dir)) {
    return { name: "PulSeed directory", status: "pass", detail: `${displayDir} exists` };
  }
  return { name: "PulSeed directory", status: "fail", detail: `${displayDir} not found` };
}

export function checkProviderConfig(baseDir?: string): CheckResult {
  const dir = baseDir ?? getPulseedDirPath();
  const configPath = path.join(dir, "provider.json");
  const displayPath = configPath.replace(process.env["HOME"] ?? "", "~");

  if (!fs.existsSync(configPath)) {
    return { name: "Provider config", status: "fail", detail: `${displayPath} not found` };
  }

  try {
    const content = readProviderConfigTextSync(configPath);
    JSON.parse(content);
    return { name: "Provider config", status: "pass", detail: `${displayPath} found` };
  } catch (err) {
    return { name: "Provider config", status: "fail", detail: formatProviderConfigParseFailure(displayPath, err) };
  }
}

function adapterCredentialGuidance(adapter: string): string | null {
  if (adapter === "openai_codex_cli") {
    return "doctor cannot safely inspect Codex CLI runtime auth here; run `pulseed provider show` to confirm a masked resolved key, or run `codex auth login` and rerun `pulseed doctor`";
  }
  return null;
}

export async function checkApiKey(baseDir?: string): Promise<CheckResult> {
  let config;
  try {
    config = await loadProviderConfig({ baseDir, saveMigration: false });
  } catch {
    return {
      name: "API key",
      status: "fail",
      detail: "provider credentials could not be resolved; run `pulseed provider show` to inspect provider config",
    };
  }

  const adapterGuidance = adapterCredentialGuidance(config.adapter);

  if (config.api_key) {
    const sourceDetail = adapterGuidance
      ? "provider config resolved adapter-managed runtime auth credentials from the same source-of-truth as `pulseed provider show`, including provider.json or adapter auth fallback when available"
      : "provider config resolved credentials from the same sources as `pulseed provider show` (env, .env, provider.json)";
    return {
      name: "API key",
      status: "pass",
      detail: `${sourceDetail} for ${config.provider}/${config.adapter}; displayed keys are masked${adapterGuidance ? `; ${adapterGuidance}` : ""}`,
    };
  }

  if (adapterGuidance) {
    return {
      name: "API key",
      status: "pass",
      detail: `${config.provider}/${config.adapter} uses adapter-managed runtime auth instead of a provider API key; ${adapterGuidance}`,
    };
  }

  const validation = validateProviderConfig(config);
  if (validation.valid) {
    return {
      name: "API key",
      status: "pass",
      detail: `${config.provider}/${config.adapter} does not require an API key in provider config; no runtime API key is required for this provider configuration; inspect resolved config with \`pulseed provider show\``,
    };
  }

  return {
    name: "API key",
    status: "fail",
    detail: `${validation.errors.join(" ")} Checked the same provider config sources as \`pulseed provider show\`.`,
  };
}

function isJwtLike(value: string): boolean {
  return value.split(".").length >= 3;
}

async function probeOpenAIEmbeddingAuth(apiKey: string, timeoutMs = 3000): Promise<{ ok: boolean; detail: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: process.env["OPENAI_EMBEDDING_MODEL"] ?? "text-embedding-3-small",
        input: "pulseed doctor embedding auth preflight",
      }),
      signal: controller.signal,
    });
    if (response.ok) {
      return { ok: true, detail: "OpenAI embeddings request succeeded" };
    }
    return {
      ok: false,
      detail: `OpenAI embeddings request failed: ${response.status} ${response.statusText}`,
    };
  } catch (error) {
    const detail = error instanceof Error && error.name === "AbortError"
      ? `OpenAI embeddings request timed out after ${timeoutMs}ms`
      : `OpenAI embeddings request failed: ${error instanceof Error ? error.message : String(error)}`;
    return { ok: false, detail };
  } finally {
    clearTimeout(timeout);
  }
}

export async function checkEmbeddingAuth(baseDir?: string): Promise<CheckResult> {
  const openaiKey = await resolveOpenAIApiKey({ baseDir });

  if (!openaiKey) {
    return {
      name: "Embedding auth",
      status: "warn",
      detail: "No OpenAI key for embeddings; Soil vector retrieval will use non-vector fallback",
    };
  }

  if (isJwtLike(openaiKey) && isJwtExpired(openaiKey)) {
    return {
      name: "Embedding auth",
      status: "warn",
      detail: "OpenAI embedding key appears to be an expired token; refresh auth before durable vector-backed runs",
    };
  }

  const probe = await probeOpenAIEmbeddingAuth(openaiKey);
  if (!probe.ok) {
    return {
      name: "Embedding auth",
      status: "warn",
      detail: `${probe.detail}; Soil vector retrieval will use non-vector fallback`,
    };
  }

  return {
    name: "Embedding auth",
    status: "pass",
    detail: probe.detail,
  };
}

export function checkStateDirectoryPermissions(baseDir?: string): CheckResult {
  const dir = baseDir ?? getPulseedDirPath();
  const displayDir = dir.replace(process.env["HOME"] ?? "", "~");

  if (!fs.existsSync(dir)) {
    return { name: "State permissions", status: "warn", detail: `${displayDir} not found` };
  }

  try {
    const mode = fs.statSync(dir).mode;
    if (isGroupOrWorldAccessible(mode)) {
      return {
        name: "State permissions",
        status: "warn",
        detail: `${displayDir} is ${formatOctalMode(mode)}; recommended 0700`,
      };
    }
    return { name: "State permissions", status: "pass", detail: `${displayDir} is ${formatOctalMode(mode)}` };
  } catch {
    return { name: "State permissions", status: "warn", detail: `${displayDir} could not be inspected` };
  }
}

export function repairStateDirectoryPermissions(baseDir?: string): CheckResult {
  const dir = baseDir ?? getPulseedDirPath();
  const displayDir = dir.replace(process.env["HOME"] ?? "", "~");

  if (!fs.existsSync(dir)) {
    return { name: "State permissions repair", status: "warn", detail: `${displayDir} not found` };
  }

  try {
    const mode = fs.statSync(dir).mode;
    if (!isGroupOrWorldAccessible(mode)) {
      return { name: "State permissions repair", status: "pass", detail: `${displayDir} already ${formatOctalMode(mode)}` };
    }
    fs.chmodSync(dir, 0o700);
    return { name: "State permissions repair", status: "pass", detail: `${displayDir} set to 0700` };
  } catch (err) {
    return {
      name: "State permissions repair",
      status: "warn",
      detail: `${displayDir} could not be repaired${err instanceof Error ? `: ${err.message}` : ""}`,
    };
  }
}

export function checkControlDatabase(baseDir?: string): CheckResult {
  const inspection = inspectControlDatabase({ baseDir });
  const home = process.env["HOME"] ?? "";
  const displayPath = inspection.dbPath.replace(home, "~");

  if (inspection.status === "missing") {
    return {
      name: "Control database",
      status: "warn",
      detail: `${displayPath} not initialized; database-backed runtime stores will create it on first use`,
    };
  }

  if (inspection.status === "unreadable") {
    return {
      name: "Control database",
      status: "fail",
      detail: `${displayPath} could not be read${inspection.error ? `: ${inspection.error}` : ""}`,
    };
  }

  if (inspection.status === "ahead_of_code") {
    return {
      name: "Control database",
      status: "fail",
      detail: `${displayPath} schema version ${inspection.schemaVersion ?? "unknown"} is newer than supported version ${inspection.expectedSchemaVersion}`,
    };
  }

  if (inspection.status === "pending_migration") {
    return {
      name: "Control database",
      status: "warn",
      detail: `${displayPath} schema version ${inspection.schemaVersion ?? 0}/${inspection.expectedSchemaVersion}; ${inspection.pendingMigrations.length} migration(s) pending`,
    };
  }

  return {
    name: "Control database",
    status: "pass",
    detail: `${displayPath} schema version ${inspection.schemaVersion}/${inspection.expectedSchemaVersion}; ${inspection.appliedMigrations.length} migration(s), ${inspection.legacyImportCount ?? 0} legacy import record(s)`,
  };
}

export function checkProviderConfigPermissions(baseDir?: string): CheckResult {
  const dir = baseDir ?? getPulseedDirPath();
  const configPath = path.join(dir, "provider.json");
  const displayPath = configPath.replace(process.env["HOME"] ?? "", "~");

  if (!fs.existsSync(configPath)) {
    return { name: "Provider permissions", status: "warn", detail: `${displayPath} not found` };
  }

  const apiKeyInspection = inspectProviderConfigStoredApiKey(configPath, displayPath);
  if (apiKeyInspection.status === "warn") {
    return { name: "Provider permissions", status: "warn", detail: apiKeyInspection.detail };
  }

  if (!apiKeyInspection.hasStoredApiKey) {
    return { name: "Provider permissions", status: "pass", detail: "no api_key stored in provider.json" };
  }

  try {
    const mode = fs.statSync(configPath).mode;
    if (isGroupOrWorldAccessible(mode)) {
      return {
        name: "Provider permissions",
        status: "warn",
        detail: `${displayPath} is ${formatOctalMode(mode)}; recommended 0600 because it stores api_key`,
      };
    }
    return { name: "Provider permissions", status: "pass", detail: `${displayPath} is ${formatOctalMode(mode)}` };
  } catch {
    return { name: "Provider permissions", status: "warn", detail: `${displayPath} could not be inspected` };
  }
}

export function repairProviderConfigPermissions(baseDir?: string): CheckResult {
  const dir = baseDir ?? getPulseedDirPath();
  const configPath = path.join(dir, "provider.json");
  const displayPath = configPath.replace(process.env["HOME"] ?? "", "~");

  if (!fs.existsSync(configPath)) {
    return { name: "Provider permissions repair", status: "warn", detail: `${displayPath} not found` };
  }

  const apiKeyInspection = inspectProviderConfigStoredApiKey(configPath, displayPath);
  if (apiKeyInspection.status === "warn") {
    return { name: "Provider permissions repair", status: "warn", detail: apiKeyInspection.detail };
  }
  if (!apiKeyInspection.hasStoredApiKey) {
    return { name: "Provider permissions repair", status: "pass", detail: "no api_key stored in provider.json" };
  }

  try {
    const mode = fs.statSync(configPath).mode;
    if (!isGroupOrWorldAccessible(mode)) {
      return { name: "Provider permissions repair", status: "pass", detail: `${displayPath} already ${formatOctalMode(mode)}` };
    }
    fs.chmodSync(configPath, 0o600);
    return { name: "Provider permissions repair", status: "pass", detail: `${displayPath} set to 0600` };
  } catch (err) {
    return {
      name: "Provider permissions repair",
      status: "warn",
      detail: `${displayPath} could not be repaired${err instanceof Error ? `: ${err.message}` : ""}`,
    };
  }
}

export function checkPluginPermissionWarnings(baseDir?: string): CheckResult {
  const pluginsDir = getPluginsDir(baseDir ?? getPulseedDirPath());

  if (!fs.existsSync(pluginsDir)) {
    return { name: "Plugin permissions", status: "pass", detail: "no plugins installed" };
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(pluginsDir, { withFileTypes: true });
  } catch {
    return { name: "Plugin permissions", status: "warn", detail: "could not read plugins directory" };
  }

  const shellPlugins: string[] = [];
  let unreadableManifestCount = 0;

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const pluginDir = path.join(pluginsDir, entry.name);
    const parsed = readPluginManifestSync(pluginDir);
    if (!parsed.ok) {
      if (parsed.failure === "missing") continue;
      unreadableManifestCount += 1;
      continue;
    }
    if (parsed.data.permissions.shell) {
      shellPlugins.push(parsed.data.name);
    }
  }

  if (shellPlugins.length > 0) {
    return {
      name: "Plugin permissions",
      status: "warn",
      detail: `${shellPlugins.length} plugin${shellPlugins.length === 1 ? "" : "s"} request shell permission: ${formatNameList(shellPlugins)}`,
    };
  }

  if (unreadableManifestCount > 0) {
    return {
      name: "Plugin permissions",
      status: "warn",
      detail: `${unreadableManifestCount} plugin manifest${unreadableManifestCount === 1 ? "" : "s"} could not be inspected`,
    };
  }

  return { name: "Plugin permissions", status: "pass", detail: "no shell-capable plugins found" };
}

export async function checkGoals(baseDir?: string): Promise<CheckResult> {
  const resolvedBaseDir = baseDir ?? getPulseedDirPath();
  let goalIds: string[];
  try {
    goalIds = await new GoalTaskStateStore(resolvedBaseDir).listGoalIds({ archived: false });
  } catch (err) {
    return { name: "Goals", status: "warn", detail: `could not read goal database: ${String(err)}` };
  }

  if (goalIds.length === 0) {
    return { name: "Goals", status: "warn", detail: "0 goals configured" };
  }

  return { name: "Goals", status: "pass", detail: `${goalIds.length} goal${goalIds.length === 1 ? "" : "s"} configured` };
}

export function checkLogDirectory(baseDir?: string): CheckResult {
  const logsDir = getLogsDir(baseDir ?? getPulseedDirPath());
  const displayDir = logsDir.replace(process.env["HOME"] ?? "", "~");

  if (!fs.existsSync(logsDir)) {
    return { name: "Log directory", status: "fail", detail: `${displayDir} not found` };
  }

  try {
    fs.accessSync(logsDir, fs.constants.W_OK);
    return { name: "Log directory", status: "pass", detail: `${displayDir} writable` };
  } catch {
    return { name: "Log directory", status: "fail", detail: `${displayDir} not writable` };
  }
}

export function checkBuild(buildPath = getCliRunnerBuildPath(import.meta.url)): CheckResult {
  const displayPath = path.relative(process.cwd(), buildPath) || buildPath;

  if (fs.existsSync(buildPath)) {
    return { name: "Build", status: "pass", detail: `${displayPath} exists` };
  }
  return { name: "Build", status: "fail", detail: `${displayPath} not found (run: npm run build)` };
}

export async function checkDaemon(baseDir?: string): Promise<CheckResult> {
  const dir = baseDir ?? getPulseedDirPath();
  const pidManager = new PIDManager(dir);
  const pidFileExists = fs.existsSync(pidManager.getPath());
  const pidStatus = await pidManager.inspect();
  const daemonConfig = await loadDaemonConfig(dir);
  const daemonStateRaw = await new DaemonStateStore(dir).load();
  const daemonState = daemonStateRaw !== null
    ? DaemonStateSchema.safeParse(daemonStateRaw)
    : null;
  const runtimeRoot = daemonState?.success && daemonState.data.runtime_root
    ? daemonState.data.runtime_root
    : resolveDaemonRuntimeRoot(dir, daemonConfig.runtime_root);
  const runtimeHealth = await new RuntimeHealthStore(runtimeRoot, { controlBaseDir: dir }).loadSnapshot();

  if (!pidFileExists && !pidStatus.running) {
    return { name: "Daemon", status: "pass", detail: "stopped (clean state)" };
  }

  const pidInfo = pidStatus.info ?? await pidManager.readPID();
  if (pidInfo === null && pidFileExists) {
    return { name: "Daemon", status: "warn", detail: "PID file exists but is unreadable" };
  }

  const runtimePid = pidStatus.runtimePid ?? pidInfo?.runtime_pid ?? pidInfo?.pid ?? null;
  const watchdogPid = pidInfo?.watchdog_pid ?? pidStatus.ownerPid ?? null;
  const runtimeAlive = typeof runtimePid === "number" && pidStatus.alivePids.includes(runtimePid);
  const watchdogAlive = typeof watchdogPid === "number" && pidStatus.alivePids.includes(watchdogPid);
  const runtimeState = daemonState?.success ? daemonState.data.status : null;
  const runtimeKpi = runtimeHealth?.kpi;
  const kpiSummary = runtimeKpi ? formatCompactKpiDetail(runtimeKpi) : null;
  const healthStatus = runtimeKpi
    ? compactRuntimeHealthKpi(runtimeKpi)?.status ?? "degraded"
    : "degraded";
  const taskKpis = await summarizeTaskOutcomeLedgers(dir);
  const failureReasonSummary = formatFailureReasonCounts(taskKpis.failure_stopped_reasons);
  const taskSummary =
    taskKpis.total_tasks > 0
      ? `task success=${taskKpis.succeeded}/${taskKpis.terminal_tasks} (${formatPercent(taskKpis.success_rate)}), in-flight=${taskKpis.inflight_tasks}/${taskKpis.total_tasks}, retry=${taskKpis.retried}/${taskKpis.total_tasks} (${formatPercent(taskKpis.retry_rate)})${
          failureReasonSummary !== null
            ? `, ${failureReasonSummary}`
            : ""
        }${
          taskKpis.p95_created_to_completed_ms !== null
            ? `, total p95=${formatDurationMs(taskKpis.p95_created_to_completed_ms)}`
            : ""
        }`
      : null;
  const liveProbe = runtimeAlive
    ? await probeDaemonHealth({ host: "127.0.0.1", port: daemonConfig.event_server_port })
    : null;
  const livePingSummary = liveProbe
    ? formatLivePingDetail(liveProbe.latency_ms, liveProbe.ok ? undefined : liveProbe.error)
    : null;

  if (runtimeState === "crashed" || runtimeState === "stopping") {
    return {
      name: "Daemon",
      status: "fail",
      detail:
        runtimeState === "crashed"
          ? `daemon state reports crashed${kpiSummary ? `; ${kpiSummary}` : ""}`
          : `daemon state reports stopping${kpiSummary ? `; ${kpiSummary}` : ""}`,
    };
  }

  if (!runtimeAlive) {
    if (watchdogAlive) {
      return {
        name: "Daemon",
        status: "fail",
        detail: runtimePid !== null
          ? `daemon restarting (runtime PID: ${runtimePid}, watchdog PID: ${watchdogPid})`
          : `daemon restarting (watchdog PID: ${watchdogPid})`,
      };
    }
    return {
      name: "Daemon",
      status: pidFileExists ? "warn" : "pass",
      detail: runtimePid !== null
        ? `stale PID file (PID: ${runtimePid} not running)`
        : "stopped (clean state)",
    };
  }

  if (watchdogPid && watchdogPid !== runtimePid && !watchdogAlive) {
    return {
      name: "Daemon",
      status: "warn",
      detail: `running (PID: ${runtimePid}), watchdog PID: ${watchdogPid} missing`,
    };
  }

  const detailPrefix =
    runtimeState === "idle"
      ? `idle daemon running (PID: ${runtimePid})`
      : `running (PID: ${runtimePid})`;
  const detail =
    watchdogPid && watchdogPid !== runtimePid
      ? `${detailPrefix}, watchdog PID: ${watchdogPid}`
      : detailPrefix;
  const detailWithHealth = kpiSummary
    ? `${detail}; ${kpiSummary}${
        runtimeKpi?.degraded_at !== undefined
          ? `; degraded ${formatRelativeTimestamp(runtimeKpi.degraded_at)}`
          : runtimeKpi?.recovered_at !== undefined
            ? `; recovered ${formatRelativeTimestamp(runtimeKpi.recovered_at)}`
            : ""
      }${livePingSummary ? `; ${livePingSummary}` : ""}${taskSummary ? `; ${taskSummary}` : ""}`
    : `${detail}; KPI telemetry unavailable${livePingSummary ? `; ${livePingSummary}` : ""}${taskSummary ? `; ${taskSummary}` : ""}`;
  const effectiveHealthStatus = liveProbe && !liveProbe.ok ? "failed" : healthStatus;
  return {
    name: "Daemon",
    status:
      effectiveHealthStatus === "failed"
        ? "fail"
        : effectiveHealthStatus === "degraded"
          ? "warn"
          : "pass",
    detail: detailWithHealth,
  };
}

export function checkNotifications(baseDir?: string): CheckResult {
  const dir = baseDir ?? getPulseedDirPath();
  const notifPath = path.join(dir, "notification.json");

  if (fs.existsSync(notifPath)) {
    return { name: "Notifications", status: "pass", detail: "notification.json found" };
  }
  return { name: "Notifications", status: "warn", detail: "not configured (optional)" };
}

export async function checkDiskUsage(baseDir?: string): Promise<CheckResult> {
  const dir = baseDir ?? getPulseedDirPath();
  const displayDir = dir.replace(process.env["HOME"] ?? "", "~");

  const result = await execFileNoThrow("du", ["-sh", dir], { timeoutMs: 5000 });
  if (result.exitCode === 0 && result.stdout) {
    const size = result.stdout.split("\t")[0]?.trim() ?? "unknown";
    return { name: "Disk space", status: "warn", detail: `${displayDir} is ${size}` };
  }
  return { name: "Disk space", status: "warn", detail: `${displayDir} (could not determine size)` };
}

export function checkNativeTaskAgentLoopTools(): CheckResult {
  const registry = new ToolRegistry();
  const tools = createBuiltinTools({ registry });
  for (const tool of tools) {
    registry.register(tool);
  }

  const assessment = assessTaskAgentLoopToolProfileFromTools(registry.listAll());
  const requiredTotal = nativeTaskAgentLoopToolProfile.requiredToolNames.length;
  const recommendedTotal = nativeTaskAgentLoopToolProfile.recommendedToolNames.length;
  const requiredAvailable = requiredTotal - assessment.missingRequiredToolNames.length;
  const recommendedAvailable = recommendedTotal - assessment.missingRecommendedToolNames.length;
  const coverage = `required ${requiredAvailable}/${requiredTotal}, recommended ${recommendedAvailable}/${recommendedTotal}`;

  if (!assessment.ready) {
    return {
      name: "Native AgentLoop tools",
      status: "fail",
      detail: `${coverage}; missing required: ${assessment.missingRequiredToolNames.join(", ")}`,
    };
  }
  if (assessment.missingRecommendedToolNames.length > 0) {
    return {
      name: "Native AgentLoop tools",
      status: "warn",
      detail: `${coverage}; missing recommended: ${assessment.missingRecommendedToolNames.join(", ")}`,
    };
  }
  return {
    name: "Native AgentLoop tools",
    status: "pass",
    detail: `${coverage}; ${assessment.profileName} profile ready`,
  };
}

// ─── Output helpers ───

function statusIcon(status: CheckStatus): string {
  switch (status) {
    case "pass": return "\u2713";
    case "fail": return "\u2717";
    case "warn": return "\u26a0";
  }
}

function formatRow(result: CheckResult): string {
  const icon = statusIcon(result.status);
  const name = result.name.padEnd(20);
  return `${icon} ${name} ${result.detail}`;
}

// ─── Main command ───

export async function cmdDoctor(_args: string[]): Promise<number> {
  const baseDir = getPulseedDirPath();
  const repair = _args.includes("--repair");

  if (repair) {
    const permissionRepairResults = [
      repairStateDirectoryPermissions(baseDir),
      repairProviderConfigPermissions(baseDir),
    ];
    for (const result of permissionRepairResults) {
      const level = result.status === "warn" ? "warn" : "info";
      console.log(`[repair][${level}] ${result.name}: ${result.detail}`);
    }

    const runtimeRoot = await resolveRepairRuntimeRoot(baseDir);
    const runtimePaths = createRuntimeStorePaths(runtimeRoot);
    const repairLogger: RuntimeMaintenanceLogger = {
      debug: (message: string, context?: Record<string, unknown>) => {
        console.log(`[repair][debug] ${message}${context ? ` ${JSON.stringify(context)}` : ""}`);
      },
      info: (message: string, context?: Record<string, unknown>) => {
        console.log(`[repair][info] ${message}${context ? ` ${JSON.stringify(context)}` : ""}`);
      },
      warn: (message: string, context?: Record<string, unknown>) => {
        console.log(`[repair][warn] ${message}${context ? ` ${JSON.stringify(context)}` : ""}`);
      },
      error: (message: string, context?: Record<string, unknown>) => {
        console.log(`[repair][error] ${message}${context ? ` ${JSON.stringify(context)}` : ""}`);
      },
    };

    const legacyImportReport = await importLegacyQueueDaemonScheduleState({
      baseDir,
      runtimeRoot,
      importedAt: new Date().toISOString(),
    });
    const chatAgentLoopImportReport = await importLegacyChatAgentLoopSessionState(baseDir);
    const executionSessionImportReport = await importLegacyExecutionSessionState(baseDir);
    const runSpecImportReport = await importLegacyRunSpecState(baseDir);
    const driveScheduleImportReport = await importLegacyDriveGoalScheduleState(baseDir);
    const strategyTemplateImportReport = await importLegacyStrategyTemplateState(baseDir);
    const vectorIndexImportReport = await importLegacyVectorIndexState(baseDir);
    const knowledgeGraphImportReport = await importLegacyKnowledgeGraphState(baseDir);
    const reflectionReportImportReport = await importLegacyReflectionReportState(baseDir);
    const goalTaskImportReport = await importLegacyGoalTaskDurableLoopState(baseDir);
    const goalOrchestrationImportReport = await importLegacyGoalOrchestrationState(baseDir);
    const stallStateImportReport = await importLegacyStallState(baseDir);
    const capabilityRegistryImportReport = await importLegacyCapabilityRegistryState(baseDir);
    const capabilityDependencyImportReport = await importLegacyCapabilityDependencyState(baseDir);
    const evidenceStrategyDreamImportReport = await importLegacyRuntimeEvidenceStrategyDreamState(baseDir, { runtimeRoot });
    const runtimeFileStateImportReport = await importLegacyRuntimeFileState({
      runtimeRootOrPaths: runtimeRoot,
      controlBaseDir: baseDir,
      importedAt: new Date().toISOString(),
    });
    const curiosityImportReport = await importLegacyCuriosityState(baseDir);
    const trustImportReport = await importLegacyTrustState(baseDir);
    const ethicsImportReport = await importLegacyEthicsLogState(baseDir);
    const relationshipProfileProposalImportReport = await importLegacyRelationshipProfileProposalState(baseDir);
    const knowledgeMemoryImportReport = await importLegacyKnowledgeMemoryState(baseDir);
    const knowledgeTransferImportReport = await importLegacyKnowledgeTransferState(baseDir);
    const transferTrustImportReport = await importLegacyTransferTrustState(baseDir);
    const learningRuntimeImportReport = await importLegacyLearningRuntimeState(baseDir);
    const memoryLifecycleImportReport = await importLegacyMemoryLifecycleState(baseDir);
    const dreamDecisionHeuristicImportReport = await importLegacyDreamDecisionHeuristics(baseDir);
    const pluginChannelImportReport = await importLegacyPluginChannelRuntimeState(baseDir);
    const migratedLegacyCronTasks = await migrateLegacyCronTasksIfNeeded({
      baseDir,
      logger: repairLogger,
    });
    const maintenanceReport = await runRuntimeStoreMaintenanceCycle({
      runtimeRoot,
      approvalStore: new ApprovalStore(runtimePaths, { controlBaseDir: baseDir }),
      outboxStore: new OutboxStore(runtimePaths, { controlBaseDir: baseDir }),
      runtimeHealthStore: new RuntimeHealthStore(runtimePaths, { controlBaseDir: baseDir }),
      logger: repairLogger,
      controlBaseDir: baseDir,
    });

    console.log(
      `Repair: approvals pruned=${maintenanceReport.approvals.prunedResolved}, outbox pruned=${maintenanceReport.outbox.pruned}, claims pruned=${maintenanceReport.claims.pruned}, health=${maintenanceReport.health.status ?? "unknown"}`
    );
    console.log(
      `Repair legacy import: queue=${legacyImportReport.queueRecords}, daemon=${legacyImportReport.daemonState ? "imported" : "none"}, shutdown=${legacyImportReport.shutdownMarker ? "imported" : "none"}, supervisor=${legacyImportReport.supervisorState ? "imported" : "none"}, schedules=${legacyImportReport.scheduleEntries}, schedule history=${legacyImportReport.scheduleHistoryRecords}, legacy cron=${migratedLegacyCronTasks ? "imported" : "none"}`
    );
    console.log(
      `Repair chat import: chat sessions=${chatAgentLoopImportReport.importedChatSessions}, cross-platform sessions=${chatAgentLoopImportReport.importedCrossPlatformSessions}, agentloop states=${chatAgentLoopImportReport.importedAgentLoopStates}, agentloop trace events=${chatAgentLoopImportReport.importedTraceEvents}, blocked=${chatAgentLoopImportReport.blockedSources.length}`
    );
    console.log(
      `Repair execution session import: legacy session files=${executionSessionImportReport.legacySessionFiles}, imported=${executionSessionImportReport.importedSessions}, legacy index files=${executionSessionImportReport.legacyIndexFiles}, stale index entries=${executionSessionImportReport.staleIndexEntries}, blocked=${executionSessionImportReport.blockedSources.length}`
    );
    console.log(
      `Repair RunSpec import: files=${runSpecImportReport.runSpecFiles}, imported=${runSpecImportReport.importedRunSpecs}, skipped already imported=${runSpecImportReport.skippedAlreadyImported}, blocked=${runSpecImportReport.blockedSources.length}`
    );
    console.log(
      `Repair Drive schedule import: files=${driveScheduleImportReport.scheduleFiles}, imported=${driveScheduleImportReport.importedSchedules}, skipped already imported=${driveScheduleImportReport.skippedAlreadyImported}, blocked=${driveScheduleImportReport.blockedSources.length}`
    );
    console.log(
      `Repair strategy template import: files=${strategyTemplateImportReport.strategyTemplateFiles}, imported=${strategyTemplateImportReport.importedTemplates}, skipped already imported=${strategyTemplateImportReport.skippedAlreadyImported}, retired existing typed state=${strategyTemplateImportReport.retiredExistingTypedState}, blocked=${strategyTemplateImportReport.blockedSources.length}`
    );
    console.log(
      `Repair vector index import: files=${vectorIndexImportReport.vectorIndexFiles}, imported=${vectorIndexImportReport.importedEntries}, skipped already imported=${vectorIndexImportReport.skippedAlreadyImported}, retired existing typed state=${vectorIndexImportReport.retiredExistingTypedState}, blocked=${vectorIndexImportReport.blockedSources.length}`
    );
    console.log(
      `Repair knowledge graph import: files=${knowledgeGraphImportReport.knowledgeGraphFiles}, nodes=${knowledgeGraphImportReport.importedNodes}, edges=${knowledgeGraphImportReport.importedEdges}, skipped already imported=${knowledgeGraphImportReport.skippedAlreadyImported}, retired existing typed state=${knowledgeGraphImportReport.retiredExistingTypedState}, blocked=${knowledgeGraphImportReport.blockedSources.length}`
    );
    console.log(
      `Repair reflection report import: files=${reflectionReportImportReport.reflectionReportFiles}, imported=${reflectionReportImportReport.importedReports}, skipped already imported=${reflectionReportImportReport.skippedAlreadyImported}, retired existing typed state=${reflectionReportImportReport.retiredExistingTypedState}, blocked=${reflectionReportImportReport.blockedSources.length}`
    );
    console.log(
      `Repair goal/task import: goals=${goalTaskImportReport.goals}, legacy WAL files=${goalTaskImportReport.legacyWalFiles}, legacy WAL intents=${goalTaskImportReport.legacyWalIntents}, tasks=${goalTaskImportReport.tasks}, histories=${goalTaskImportReport.taskHistoryRecords}, ledgers=${goalTaskImportReport.taskOutcomeLedgers}, verification=${goalTaskImportReport.verificationResults}, checkpoints=${goalTaskImportReport.checkpoints}, pipelines=${goalTaskImportReport.pipelines}, blocked=${goalTaskImportReport.blockedSources.length}`
    );
    console.log(
      `Repair goal orchestration import: negotiation logs=${goalOrchestrationImportReport.negotiationLogs}, dependency graphs=${goalOrchestrationImportReport.dependencyGraphs}, skipped already imported=${goalOrchestrationImportReport.skippedAlreadyImported}, retired existing typed state=${goalOrchestrationImportReport.retiredExistingTypedState}, blocked=${goalOrchestrationImportReport.blockedSources.length}`
    );
    console.log(
      `Repair stall state import: stall states=${stallStateImportReport.stallStates}, skipped already imported=${stallStateImportReport.skippedAlreadyImported}, retired existing typed state=${stallStateImportReport.retiredExistingTypedState}, blocked=${stallStateImportReport.blockedSources.length}`
    );
    console.log(
      `Repair capability registry import: registry files=${capabilityRegistryImportReport.registryFiles}, capabilities=${capabilityRegistryImportReport.importedCapabilities}, blocked=${capabilityRegistryImportReport.blockedSources.length}`
    );
    console.log(
      `Repair capability dependency import: files=${capabilityDependencyImportReport.dependencyFiles}, dependencies=${capabilityDependencyImportReport.dependencies}, skipped already imported=${capabilityDependencyImportReport.skippedAlreadyImported}, retired existing typed state=${capabilityDependencyImportReport.retiredExistingTypedState}, blocked=${capabilityDependencyImportReport.blockedSources.length}`
    );
    console.log(
      `Repair evidence/strategy/dream import: evidence=${evidenceStrategyDreamImportReport.runtimeEvidenceEntries}, strategy=${evidenceStrategyDreamImportReport.strategyRecords}, iteration logs=${evidenceStrategyDreamImportReport.dreamIterationLogs}, session logs=${evidenceStrategyDreamImportReport.dreamSessionLogs}, event logs=${evidenceStrategyDreamImportReport.dreamEventLogs}, importance=${evidenceStrategyDreamImportReport.dreamImportanceEntries}, watermarks=${evidenceStrategyDreamImportReport.dreamWatermarks ? "imported" : "none"}, suggestions=${evidenceStrategyDreamImportReport.dreamScheduleSuggestions}, playbooks=${evidenceStrategyDreamImportReport.dreamPlaybooks}, activation artifacts=${evidenceStrategyDreamImportReport.dreamActivationArtifacts}, workflows=${evidenceStrategyDreamImportReport.dreamWorkflows}, blocked=${evidenceStrategyDreamImportReport.blockedSources.length}`
    );
    console.log(
      `Repair runtime file-state import: operator handoffs=${runtimeFileStateImportReport.operatorHandoffs}, budgets=${runtimeFileStateImportReport.budgets}, experiment queues=${runtimeFileStateImportReport.experimentQueues}, capability verifications=${runtimeFileStateImportReport.capabilityVerifications}, capability audits=${runtimeFileStateImportReport.capabilityAudits}, browser sessions=${runtimeFileStateImportReport.browserSessions}, auth handoffs=${runtimeFileStateImportReport.authHandoffs}, proactive events=${runtimeFileStateImportReport.proactiveInterventionEvents}, invalid=${runtimeFileStateImportReport.invalidLegacyRecords}`
    );
    console.log(
      `Repair curiosity import: state files=${curiosityImportReport.stateFiles}, proposals=${curiosityImportReport.importedProposals}, learning records=${curiosityImportReport.importedLearningRecords}, rejected hashes=${curiosityImportReport.importedRejectedHashes}, blocked=${curiosityImportReport.blockedSources.length}`
    );
    console.log(
      `Repair trust/ethics/profile import: trust files=${trustImportReport.trustStoreFiles}, balances=${trustImportReport.importedBalances}, permanent gates=${trustImportReport.importedPermanentGates}, overrides=${trustImportReport.importedOverrideEvents}, ethics files=${ethicsImportReport.ethicsLogFiles}, ethics logs=${ethicsImportReport.importedLogs}, profile proposal files=${relationshipProfileProposalImportReport.proposalStoreFiles}, profile proposals=${relationshipProfileProposalImportReport.importedProposals}, blocked=${trustImportReport.blockedSources.length + ethicsImportReport.blockedSources.length + relationshipProfileProposalImportReport.blockedSources.length}`
    );
    console.log(
      `Repair knowledge/memory import: domain=${knowledgeMemoryImportReport.domainKnowledge}, shared=${knowledgeMemoryImportReport.sharedKnowledgeEntries}, agent memory=${knowledgeMemoryImportReport.agentMemoryEntries}, corrections=${knowledgeMemoryImportReport.agentMemoryCorrections}, blocked=${knowledgeMemoryImportReport.blockedSources.length}`
    );
    console.log(
      `Repair knowledge transfer import: snapshots=${knowledgeTransferImportReport.snapshots}, meta-pattern watermarks=${knowledgeTransferImportReport.metaPatternWatermarks}, skipped already imported=${knowledgeTransferImportReport.skippedAlreadyImported}, retired existing typed state=${knowledgeTransferImportReport.retiredExistingTypedState}, blocked=${knowledgeTransferImportReport.blockedSources.length}`
    );
    console.log(
      `Repair transfer trust import: index entries=${transferTrustImportReport.indexEntries}, scores=${transferTrustImportReport.scores}, history entries=${transferTrustImportReport.historyEntries}, skipped already imported=${transferTrustImportReport.skippedAlreadyImported}, retired existing typed state=${transferTrustImportReport.retiredExistingTypedState}, blocked=${transferTrustImportReport.blockedSources.length}`
    );
    console.log(
      `Repair learning runtime import: logs=${learningRuntimeImportReport.experienceLogs}, patterns=${learningRuntimeImportReport.patterns}, feedback entries=${learningRuntimeImportReport.feedbackEntries}, structural feedback=${learningRuntimeImportReport.structuralFeedback}, skipped already imported=${learningRuntimeImportReport.skippedAlreadyImported}, retired existing typed state=${learningRuntimeImportReport.retiredExistingTypedState}, blocked=${learningRuntimeImportReport.blockedSources.length}`
    );
    console.log(
      `Repair memory lifecycle import: short-term files=${memoryLifecycleImportReport.shortTermFiles}, short-term entries=${memoryLifecycleImportReport.shortTermEntries}, indexes=${memoryLifecycleImportReport.indexFiles}, index entries=${memoryLifecycleImportReport.indexEntries}, lesson files=${memoryLifecycleImportReport.lessonFiles}, lessons=${memoryLifecycleImportReport.lessons}, statistics=${memoryLifecycleImportReport.statisticsFiles}, archives=${memoryLifecycleImportReport.archives}, blocked=${memoryLifecycleImportReport.blockedSources.length}`
    );
    console.log(
      `Repair dream decision heuristics import: ${dreamDecisionHeuristicImportReport.imported ? "imported" : dreamDecisionHeuristicImportReport.skipped ?? "blocked"}, heuristics=${dreamDecisionHeuristicImportReport.heuristicCount}, blocked=${dreamDecisionHeuristicImportReport.blocked ? 1 : 0}`
    );
    console.log(
      `Repair plugin/channel import: plugin states=${pluginChannelImportReport.pluginStates}, channel health=${pluginChannelImportReport.channelHealth}, imported plugin reviews=${pluginChannelImportReport.importedPluginReviews}, assets=${pluginChannelImportReport.assetRecords}, blocked=${pluginChannelImportReport.blockedSources.length}`
    );
  }

  const checks: CheckResult[] = [
    checkNodeVersion(),
    checkPulseedDir(baseDir),
    checkProviderConfig(baseDir),
    await checkApiKey(baseDir),
    await checkEmbeddingAuth(baseDir),
    checkStateDirectoryPermissions(baseDir),
    checkControlDatabase(baseDir),
    checkProviderConfigPermissions(baseDir),
    checkPluginPermissionWarnings(baseDir),
    await checkGoals(baseDir),
    checkLogDirectory(baseDir),
    checkBuild(),
    checkNativeTaskAgentLoopTools(),
    await checkDaemon(baseDir),
    checkNotifications(baseDir),
    await checkDiskUsage(baseDir),
  ];

  const passed = checks.filter((c) => c.status === "pass").length;
  const failed = checks.filter((c) => c.status === "fail").length;
  const warned = checks.filter((c) => c.status === "warn").length;

  console.log("PulSeed Doctor");
  console.log("\u2500".repeat(14));

  for (const check of checks) {
    console.log(formatRow(check));
  }

  console.log("");
  console.log(`Summary: ${passed} passed, ${failed} failed, ${warned} warnings`);

  return failed > 0 ? 1 : 0;
}
