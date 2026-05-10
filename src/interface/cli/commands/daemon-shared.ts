import * as path from "node:path";
import { DaemonConfigSchema } from "../../../base/types/daemon.js";
import type { DaemonConfig } from "../../../base/types/daemon.js";
import { readDaemonConfigJsonFileSync } from "../../../runtime/daemon/config-json.js";
import type { PIDManager } from "../../../runtime/pid-manager.js";
import {
  compactRuntimeHealthKpi,
  type RuntimeArtifactExpectation,
  type RuntimeHealthKpi,
  type RuntimeLongRunHealth,
  type RuntimeLongRunHealthSummary,
} from "../../../runtime/store/runtime-schemas.js";
import type { SupervisorState } from "../../../runtime/executor/index.js";
import { getCliLogger } from "../cli-logger.js";
import {
  formatAbsoluteRelativeTimestamp,
  formatPercent,
  formatRelativeTimestamp,
} from "./display-format.js";

export {
  formatAbsoluteRelativeTimestamp,
  formatDurationMs,
  formatPercent,
  formatRelativeTime,
  formatRelativeTimestamp,
  formatUptime,
} from "./display-format.js";

export function resolveDaemonRuntimeRoot(baseDir: string, configuredRoot?: string): string {
  if (!configuredRoot || configuredRoot.trim() === "") {
    return path.join(baseDir, "runtime");
  }
  return path.isAbsolute(configuredRoot)
    ? configuredRoot
    : path.resolve(baseDir, configuredRoot);
}

export function formatGoalMode(goalIds: string[]): string {
  return goalIds.length > 0 ? goalIds.join(", ") : "(idle mode)";
}

export async function loadDaemonConfig(baseDir: string): Promise<DaemonConfig> {
  const configPath = path.join(baseDir, "daemon.json");
  const legacyConfigPath = path.join(baseDir, "daemon-config.json");

  function readDaemonConfigFile(filePath: string): DaemonConfig | null {
    try {
      const raw = readDaemonConfigJsonFileSync(filePath);
      const configParsed = DaemonConfigSchema.safeParse(raw);
      if (configParsed.success) {
        return configParsed.data;
      }
      getCliLogger().warn(`Ignoring invalid daemon config at ${filePath}; using defaults.`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      getCliLogger().warn(
        `Ignoring invalid daemon config at ${filePath}; using defaults. ${err instanceof Error ? err.message : String(err)}`
      );
    }

    return null;
  }

  return readDaemonConfigFile(configPath) ?? readDaemonConfigFile(legacyConfigPath) ?? DaemonConfigSchema.parse({});
}

export type RuntimeHealthCapabilityKey = "process_alive" | "command_acceptance" | "task_execution";

export function formatCapabilityLabel(
  label: string,
  kpi: RuntimeHealthKpi,
  key: RuntimeHealthCapabilityKey
): string {
  const capability = kpi[key];
  const reason = capability.reason ? `, ${capability.reason}` : "";
  return `${label.padEnd(16)} ${capability.status} (${formatRelativeTimestamp(capability.checked_at)}${reason})`;
}

export function formatKpiCompactLine(kpi: RuntimeHealthKpi): string {
  const compact = compactRuntimeHealthKpi(kpi);
  if (!compact) {
    return "KPI snapshot:    unavailable";
  }
  return `KPI snapshot:    process=${compact.process_alive ? "up" : "down"} accept=${compact.can_accept_command ? "up" : "down"} execute=${compact.can_execute_task ? "up" : "down"} (${compact.status})`;
}

const LONG_RUN_SUMMARY_LABELS: Record<RuntimeLongRunHealthSummary, string> = {
  alive_and_progressing: "alive and progressing",
  alive_idle_no_artifact_stream: "idle; no active artifact stream expected",
  alive_but_metric_stalled: "alive but metric-stalled",
  alive_but_artifact_stalled: "alive but artifact-stalled",
  alive_but_waiting: "alive but waiting",
  alive_but_stalled: "alive but stalled",
  dead_but_resumable: "dead but resumable",
  dead_needs_intervention: "dead and needs intervention",
  unknown: "unknown",
};

function formatEvidenceTimestamp(timestamp: number | undefined): string {
  return formatAbsoluteRelativeTimestamp(timestamp);
}

function formatArtifactExpectation(expectation: RuntimeArtifactExpectation): string {
  switch (expectation.state) {
    case "none":
      return `none (${expectation.reason})`;
    case "expected":
      return `expected (${expectation.reason})`;
    case "recently_expected":
      return `recently expected (${expectation.reason}, stale after ${expectation.stale_after_ms}ms)`;
    case "unknown":
      return `unknown (${expectation.reason})`;
  }
}

function isArtifactFreshnessProblem(health: RuntimeLongRunHealth): boolean {
  return (
    health.signals.artifact_freshness.status === "stale" ||
    health.signals.artifact_freshness.status === "missing"
  );
}

function formatLongRunSummaryLabel(
  health: RuntimeLongRunHealth,
  expectation: RuntimeArtifactExpectation | undefined
): string {
  if (health.signals.process.status === "dead") {
    return LONG_RUN_SUMMARY_LABELS[health.summary];
  }
  if (expectation?.state === "none" && isArtifactFreshnessProblem(health)) {
    return LONG_RUN_SUMMARY_LABELS.alive_idle_no_artifact_stream;
  }
  if (expectation?.state === "unknown" && isArtifactFreshnessProblem(health)) {
    return LONG_RUN_SUMMARY_LABELS.unknown;
  }
  return LONG_RUN_SUMMARY_LABELS[health.summary];
}

export function formatLongRunHealthLines(
  health: RuntimeLongRunHealth,
  opts: { historical?: boolean; artifactExpectation?: RuntimeArtifactExpectation } = {},
): string[] {
  const signals = health.signals;
  const artifactExpectation = opts.artifactExpectation ?? signals.artifact_expectation;
  const childActivityLabel = opts.historical ? "Historical child activity:" : "Child activity:";
  const lines = [
    `  Summary:        ${formatLongRunSummaryLabel(health, artifactExpectation)} (${formatRelativeTimestamp(health.checked_at)})`,
    `  Process:        ${signals.process.status}${signals.process.pid ? ` pid=${signals.process.pid}` : ""}; evidence=${formatEvidenceTimestamp(signals.process.observed_at ?? signals.process.checked_at)}`,
    `  ${childActivityLabel.padEnd(15)} ${signals.child_activity.status}${signals.child_activity.active_count !== undefined ? ` count=${signals.child_activity.active_count}` : ""}; evidence=${formatEvidenceTimestamp(signals.child_activity.observed_at ?? signals.child_activity.checked_at)}${opts.historical ? " (stale snapshot)" : ""}`,
    `  Log freshness:  ${signals.log_freshness.status}; evidence=${formatEvidenceTimestamp(signals.log_freshness.observed_at)}`,
    `  Artifact fresh: ${signals.artifact_freshness.status}; evidence=${formatEvidenceTimestamp(signals.artifact_freshness.observed_at)}`,
    `  Metric fresh:   ${signals.metric_freshness.status}; evidence=${formatEvidenceTimestamp(signals.metric_freshness.observed_at)}`,
    `  Metric trend:   ${signals.metric_progress.status}; evidence=${formatEvidenceTimestamp(signals.metric_progress.observed_at)}`,
    `  Blocker:        ${signals.blocker.status}; evidence=${formatEvidenceTimestamp(signals.blocker.observed_at ?? signals.blocker.checked_at)}`,
  ];
  if (artifactExpectation) {
    lines.push(`  Artifact stream:${" ".repeat(1)}${formatArtifactExpectation(artifactExpectation)}`);
  }
  if (signals.expected_next_checkpoint_at !== undefined) {
    lines.push(`  Next checkpoint:${" ".repeat(1)}${formatEvidenceTimestamp(signals.expected_next_checkpoint_at)}`);
  }
  if ((signals.blocker.unrelated_pending_approval_count ?? 0) > 0) {
    lines.push(`  Unrelated approvals: ${signals.blocker.unrelated_pending_approval_count} pending outside active goal scope`);
  }
  return lines;
}

export interface RuntimeTaskOutcomeDetails {
  success_rate: number | null;
  terminal_counts: {
    total_tasks: number;
    terminal_tasks: number;
    succeeded: number;
    failed: number;
    abandoned: number;
    retried: number;
  };
  failure_reasons?: {
    timeout: number;
    policy_blocked?: number;
    cancelled: number;
    error: number;
    unknown: number;
    other: number;
  };
  healthy_at_0_95: boolean | null;
}

export function formatTaskFailureReasonCounts(
  failureReasons: RuntimeTaskOutcomeDetails["failure_reasons"] | undefined
): string | null {
  if (!failureReasons) return null;
  const policyBlocked = failureReasons.policy_blocked ?? 0;
  const total =
    failureReasons.timeout +
    policyBlocked +
    failureReasons.cancelled +
    failureReasons.error +
    failureReasons.unknown +
    failureReasons.other;
  if (total === 0) return null;
  return `timeout=${failureReasons.timeout}, policy_blocked=${policyBlocked}, cancelled=${failureReasons.cancelled}, error=${failureReasons.error}, unknown=${failureReasons.unknown}, other=${failureReasons.other}`;
}

export function formatTaskOutcomeLine(taskOutcome: RuntimeTaskOutcomeDetails): string {
  const rate = formatPercent(taskOutcome.success_rate);
  const terminalCounts = taskOutcome.terminal_counts;
  const thresholdLabel =
    taskOutcome.healthy_at_0_95 === null
      ? "threshold n/a"
      : taskOutcome.healthy_at_0_95
      ? "healthy @ 0.95"
      : "degraded @ 0.95";
  const failureReasons = formatTaskFailureReasonCounts(taskOutcome.failure_reasons);
  const failureSuffix = failureReasons ? `, failures: ${failureReasons}` : "";
  return `${rate} (${terminalCounts.succeeded}/${terminalCounts.terminal_tasks} terminal, ${thresholdLabel}${failureSuffix})`;
}

export function formatTaskSuccessRateLine(
  taskSuccessRate: number | null,
  taskOutcome: RuntimeTaskOutcomeDetails | undefined
): string {
  const rate = formatPercent(taskSuccessRate);
  if (!taskOutcome) {
    return `task_success_rate: ${rate}`;
  }

  const terminalCounts = taskOutcome.terminal_counts;
  const thresholdLabel =
    taskOutcome.healthy_at_0_95 === null
      ? "threshold n/a"
      : taskOutcome.healthy_at_0_95
        ? "healthy @ 0.95"
        : "degraded @ 0.95";
  const failureReasons = formatTaskFailureReasonCounts(taskOutcome.failure_reasons);
  const failureSuffix = failureReasons ? `, failures: ${failureReasons}` : "";
  return `task_success_rate: ${rate} (${terminalCounts.succeeded}/${terminalCounts.terminal_tasks} terminal, ${thresholdLabel}${failureSuffix})`;
}

export function isPidAlive(pidStatus: Awaited<ReturnType<PIDManager["inspect"]>>, pid?: number | null): boolean {
  return typeof pid === "number" && pidStatus.alivePids.includes(pid);
}

export async function readSupervisorState(runtimeRoot: string, controlBaseDir?: string): Promise<SupervisorState | null> {
  const { SupervisorStateStore } = await import("../../../runtime/store/supervisor-state-store.js");
  return await new SupervisorStateStore(runtimeRoot, { controlBaseDir }).load() as SupervisorState | null;
}
