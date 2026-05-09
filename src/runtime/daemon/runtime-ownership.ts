import * as path from "node:path";
import * as fsp from "node:fs/promises";
import type { Dirent } from "node:fs";
import type { Logger } from "../logger.js";
import { DaemonStateStore, ProactiveInterventionStore, SupervisorStateStore } from "../store/index.js";
import type { ApprovalStore, OutboxStore, RuntimeHealthStore } from "../store/index.js";
import type { LeaderLockManager } from "../leader-lock-manager.js";
import { summarizeTaskOutcomeLedgers } from "../../orchestrator/execution/task/task-outcome-ledger.js";
import {
  buildLongRunHealth,
  evolveRuntimeHealthKpi,
  type ApprovalRecord,
  type RuntimeDaemonHealth,
  type RuntimeHealthCapabilityStatuses,
  type RuntimeLongRunBlockerStatus,
  type RuntimeLongRunHealth,
  type RuntimeLongRunHealthSignals,
} from "../store/index.js";

export type RuntimeHealthComponents = Record<
  "gateway" | "queue" | "leases" | "approval" | "outbox" | "supervisor",
  "ok" | "degraded"
>;

interface RuntimeOwnershipDeps {
  baseDir: string | null;
  runtimeRoot: string | null;
  logger: Logger;
  approvalStore: ApprovalStore | null;
  outboxStore: OutboxStore | null;
  runtimeHealthStore: RuntimeHealthStore | null;
  leaderLockManager: LeaderLockManager | null;
  onLeadershipLost: (reason: string) => void;
}

interface RuntimeTaskOutcomeDetails {
  success_rate: number | null;
  terminal_counts: {
    total_tasks: number;
    terminal_tasks: number;
    succeeded: number;
    failed: number;
    abandoned: number;
    retried: number;
  };
  failure_reasons: {
    timeout: number;
    cancelled: number;
    error: number;
    unknown: number;
    other: number;
  };
  healthy_at_0_95: boolean | null;
}

interface LatestFileEvidence {
  path: string;
  mtimeMs: number;
  metric?: {
    name: string;
    value: number;
    direction?: "maximize" | "minimize";
    observedAt: number;
  };
}

interface SupervisorActivity {
  status: RuntimeLongRunHealthSignals["child_activity"]["status"];
  activeCount?: number;
  observedAt?: number;
  activeGoalIds: string[];
}

interface ApprovalScopeSummary {
  total: number;
  goalScoped: number;
  unrelated: number;
}

interface ActiveGoalTaskBlocker {
  status: Extract<RuntimeLongRunBlockerStatus, "blocked">;
  reason: string;
  observedAt?: number;
}

export class RuntimeOwnershipCoordinator {
  private leaderOwnerToken: string | null = null;
  private leaderHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private runtimeHealthPhase = "disabled";
  private runtimeHealthComponents: RuntimeHealthComponents | null = null;

  constructor(private readonly deps: RuntimeOwnershipDeps) {}

  private deriveCapabilityStatuses(
    components: RuntimeHealthComponents
  ): RuntimeHealthCapabilityStatuses {
    return {
      process_alive: "ok",
      command_acceptance:
        components.gateway === "ok" && components.queue === "ok" ? "ok" : "degraded",
      task_execution:
        components.supervisor === "ok" && components.leases === "ok" ? "ok" : "degraded",
    };
  }

  private mergeCapabilityStatus(
    previous: RuntimeHealthCapabilityStatuses[keyof RuntimeHealthCapabilityStatuses] | undefined,
    derived: RuntimeHealthCapabilityStatuses[keyof RuntimeHealthCapabilityStatuses]
  ): RuntimeHealthCapabilityStatuses[keyof RuntimeHealthCapabilityStatuses] {
    const rank = { ok: 0, degraded: 1, failed: 2 } as const;
    if (!previous) {
      return derived;
    }
    return rank[previous] >= rank[derived] ? previous : derived;
  }

  private summarizeComponents(components: RuntimeHealthComponents | null): RuntimeDaemonHealth["status"] {
    if (!components) {
      return "degraded";
    }
    return Object.values(components).every((value) => value === "ok") ? "ok" : "degraded";
  }

  private async summarizeTaskOutcomeDetails(): Promise<RuntimeTaskOutcomeDetails | null> {
    if (!this.deps.baseDir) {
      return null;
    }

    const summary = await summarizeTaskOutcomeLedgers(this.deps.baseDir);
    return {
      success_rate: summary.success_rate,
      terminal_counts: {
        total_tasks: summary.total_tasks,
        terminal_tasks: summary.terminal_tasks,
        succeeded: summary.succeeded,
        failed: summary.failed,
        abandoned: summary.abandoned,
        retried: summary.retried,
      },
      failure_reasons: summary.failure_stopped_reasons,
      healthy_at_0_95: summary.success_rate === null ? null : summary.success_rate >= 0.95,
    };
  }

  private async buildHealthDetails(phase: string): Promise<Record<string, unknown>> {
    const details: Record<string, unknown> = {
      pid: process.pid,
      runtime_journal_v2: true,
      runtime_root: this.deps.runtimeRoot,
      phase,
    };
    const taskOutcome = await this.summarizeTaskOutcomeDetails();
    if (taskOutcome) {
      details.task_success_rate = taskOutcome.success_rate;
      details.task_outcome = taskOutcome;
    }
    details.proactive_interventions = await new ProactiveInterventionStore(this.deps.runtimeRoot ?? undefined).summarize();
    return details;
  }

  private freshnessStatus(
    observedAt: number | undefined,
    checkedAt: number,
    staleAfterMs: number
  ): "fresh" | "stale" | "missing" {
    if (observedAt === undefined) {
      return "missing";
    }
    return checkedAt - observedAt <= staleAfterMs ? "fresh" : "stale";
  }

  private async statFile(filePath: string): Promise<number | undefined> {
    try {
      return Math.floor((await fsp.stat(filePath)).mtimeMs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw err;
    }
  }

  private async latestKnownLogEvidence(): Promise<LatestFileEvidence | null> {
    if (!this.deps.baseDir) {
      return null;
    }

    const candidates = [
      path.join(this.deps.baseDir, "logs", "coreloop.log"),
      path.join(this.deps.baseDir, "logs", "pulseed.log"),
    ];
    let latest: LatestFileEvidence | null = null;
    for (const candidate of candidates) {
      const mtimeMs = await this.statFile(candidate);
      if (mtimeMs === undefined) continue;
      if (!latest || mtimeMs > latest.mtimeMs) {
        latest = { path: candidate, mtimeMs };
      }
    }
    return latest;
  }

  private async latestArtifactEvidence(): Promise<LatestFileEvidence | null> {
    if (!this.deps.runtimeRoot) {
      return null;
    }

    const artifactsDir = path.join(this.deps.runtimeRoot, "artifacts");
    const latestArtifact = await this.findLatestFile(artifactsDir, (filePath) =>
      filePath.endsWith("result.json") ||
      filePath.endsWith("summary.md") ||
      filePath.endsWith("next-action.json")
    );
    if (!latestArtifact) {
      return null;
    }

    const latestResult = await this.findLatestFile(artifactsDir, (filePath) => filePath.endsWith("result.json"));
    return {
      ...latestArtifact,
      metric: latestResult
        ? await this.extractMetricFromResultJson(latestResult.path, latestResult.mtimeMs)
        : undefined,
    };
  }

  private async findLatestFile(
    rootDir: string,
    includeFile: (filePath: string) => boolean,
    depth = 0
  ): Promise<LatestFileEvidence | null> {
    if (depth > 3) {
      return null;
    }

    let entries: Dirent[];
    try {
      entries = await fsp.readdir(rootDir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }

    let latest: LatestFileEvidence | null = null;
    for (const entry of entries) {
      const entryPath = path.join(rootDir, entry.name);
      if (entry.isDirectory()) {
        const nested = await this.findLatestFile(entryPath, includeFile, depth + 1);
        if (nested && (!latest || nested.mtimeMs > latest.mtimeMs)) {
          latest = nested;
        }
        continue;
      }

      if (!entry.isFile() || !includeFile(entryPath)) {
        continue;
      }
      const mtimeMs = await this.statFile(entryPath);
      if (mtimeMs !== undefined && (!latest || mtimeMs > latest.mtimeMs)) {
        latest = { path: entryPath, mtimeMs };
      }
    }
    return latest;
  }

  private async extractMetricFromResultJson(
    filePath: string,
    observedAt: number
  ): Promise<LatestFileEvidence["metric"]> {
    try {
      const raw = JSON.parse(await fsp.readFile(filePath, "utf8")) as unknown;
      if (!raw || typeof raw !== "object") {
        return undefined;
      }
      const evidence = (raw as { evidence?: unknown }).evidence;
      if (!Array.isArray(evidence)) {
        return undefined;
      }
      for (const item of evidence) {
        if (!item || typeof item !== "object") continue;
        const record = item as Record<string, unknown>;
        if (record["kind"] !== "metric") continue;
        if (typeof record["label"] !== "string") continue;
        if (typeof record["value"] !== "number" || !Number.isFinite(record["value"])) continue;
        return {
          name: record["label"],
          value: record["value"],
          ...(record["direction"] === "maximize" || record["direction"] === "minimize"
            ? { direction: record["direction"] }
            : {}),
          observedAt,
        };
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  private async readSupervisorActivity(checkedAt: number): Promise<SupervisorActivity> {
    if (!this.deps.runtimeRoot) {
      return { status: "unknown", activeGoalIds: [] };
    }

    try {
      const raw = await new SupervisorStateStore(this.deps.runtimeRoot, {
        controlBaseDir: this.deps.baseDir ?? undefined,
      }).load();
      if (!raw) {
        return { status: "unknown", activeGoalIds: [] };
      }
      const updatedAt = typeof raw.updatedAt === "number"
        ? raw.updatedAt
        : checkedAt;
      const workers = raw.workers;
      const activeCount = workers.filter((worker) => typeof worker["goalId"] === "string").length;
      const activeGoalIds = this.uniqueStrings(
        workers
          .map((worker) => worker["goalId"])
          .filter((goalId): goalId is string => typeof goalId === "string" && goalId.length > 0)
      );
      return {
        status: activeCount > 0 ? "active" : "idle",
        activeCount,
        observedAt: updatedAt,
        activeGoalIds,
      };
    } catch (err) {
      throw err;
    }
  }

  private async readDaemonActiveGoalIds(): Promise<string[]> {
    if (!this.deps.baseDir) {
      return [];
    }

    try {
      const raw = await new DaemonStateStore(this.deps.baseDir).load();
      const activeGoals = raw?.active_goals ?? [];
      return this.uniqueStrings(
        activeGoals.filter((goalId): goalId is string => typeof goalId === "string" && goalId.length > 0)
      );
    } catch {
      return [];
    }
  }

  private uniqueStrings(values: string[]): string[] {
    return [...new Set(values)];
  }

  private summarizeApprovalScope(
    pendingApprovals: ApprovalRecord[],
    activeGoalIds: string[]
  ): ApprovalScopeSummary {
    if (activeGoalIds.length === 0) {
      return {
        total: pendingApprovals.length,
        goalScoped: pendingApprovals.length,
        unrelated: 0,
      };
    }

    const activeGoals = new Set(activeGoalIds);
    const goalScoped = pendingApprovals.filter((approval) =>
      typeof approval.goal_id === "string" && activeGoals.has(approval.goal_id)
    ).length;
    return {
      total: pendingApprovals.length,
      goalScoped,
      unrelated: pendingApprovals.length - goalScoped,
    };
  }

  private parseTimestamp(value: string | null | undefined): number | undefined {
    if (!value) {
      return undefined;
    }
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  private classifyTaskBlocker(summary: Record<string, unknown>): "policy_blocked" | "blocked" | null {
    const latestEventType = typeof summary["latest_event_type"] === "string"
      ? summary["latest_event_type"]
      : null;
    if (latestEventType !== "failed" && latestEventType !== "abandoned") {
      return null;
    }

    const stoppedReason = typeof summary["stopped_reason"] === "string"
      ? summary["stopped_reason"]
      : null;
    if (stoppedReason === "policy_blocked") {
      return "policy_blocked";
    }
    if (stoppedReason === "blocked" || summary["task_status"] === "blocked") {
      return "blocked";
    }
    return null;
  }

  private async readLatestGoalTaskBlocker(goalId: string): Promise<{
    kind: "policy_blocked" | "blocked";
    observedAt?: number;
  } | null> {
    if (!this.deps.baseDir) {
      return null;
    }

    const ledgerDir = path.join(this.deps.baseDir, "tasks", goalId, "ledger");
    let entries: string[];
    try {
      entries = await fsp.readdir(ledgerDir, { withFileTypes: false });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw err;
    }

    let latest: { summary: Record<string, unknown>; observedAt?: number } | null = null;
    for (const entry of entries.filter((name) => name.endsWith(".json"))) {
      try {
        const raw = JSON.parse(await fsp.readFile(path.join(ledgerDir, entry), "utf8")) as unknown;
        if (!raw || typeof raw !== "object") {
          continue;
        }
        const summary = (raw as { summary?: unknown }).summary;
        if (!summary || typeof summary !== "object") {
          continue;
        }
        const observedAt = this.parseTimestamp((summary as { latest_event_at?: unknown }).latest_event_at as string | null | undefined);
        if (!latest || (observedAt ?? 0) > (latest.observedAt ?? 0)) {
          latest = { summary: summary as Record<string, unknown>, observedAt };
        }
      } catch {
        // Ignore malformed ledger records during health snapshot aggregation.
      }
    }

    if (!latest) {
      return null;
    }
    const kind = this.classifyTaskBlocker(latest.summary);
    return kind ? { kind, observedAt: latest.observedAt } : null;
  }

  private async readActiveGoalTaskBlocker(activeGoalIds: string[]): Promise<ActiveGoalTaskBlocker | null> {
    if (activeGoalIds.length === 0) {
      return null;
    }

    const blockers = (await Promise.all(
      activeGoalIds.map(async (goalId) => ({
        goalId,
        blocker: await this.readLatestGoalTaskBlocker(goalId),
      }))
    )).filter((entry): entry is { goalId: string; blocker: { kind: "policy_blocked" | "blocked"; observedAt?: number } } =>
      entry.blocker !== null
    );
    if (blockers.length === 0) {
      return null;
    }

    const policyBlocked = blockers.filter((entry) => entry.blocker.kind === "policy_blocked");
    const selected = policyBlocked.length > 0 ? policyBlocked : blockers;
    const observedAt = selected
      .map((entry) => entry.blocker.observedAt)
      .filter((value): value is number => typeof value === "number")
      .sort((a, b) => b - a)[0];
    const label = policyBlocked.length > 0 ? "policy-blocked" : "blocked";
    return {
      status: "blocked",
      observedAt,
      reason: `${selected.length} ${label} task${selected.length === 1 ? "" : "s"} for active goal${selected.length === 1 ? "" : "s"}`,
    };
  }

  private async buildLongRunHealthSnapshot(checkedAt: number): Promise<RuntimeLongRunHealth> {
    const [previous, logEvidence, artifactEvidence, supervisorActivity, daemonActiveGoalIds, pendingApprovals] = await Promise.all([
      this.deps.runtimeHealthStore?.loadDaemonHealth(),
      this.latestKnownLogEvidence(),
      this.latestArtifactEvidence(),
      this.readSupervisorActivity(checkedAt),
      this.readDaemonActiveGoalIds(),
      this.deps.approvalStore?.listPending().catch(() => []),
    ]);
    const activeGoalIds = this.uniqueStrings([...supervisorActivity.activeGoalIds, ...daemonActiveGoalIds]);
    const approvalScope = this.summarizeApprovalScope(pendingApprovals ?? [], activeGoalIds);
    const taskBlocker = await this.readActiveGoalTaskBlocker(activeGoalIds);
    const previousMetric = previous?.long_running?.signals.metric_progress.current_value;
    const currentMetric = artifactEvidence?.metric?.value;
    const metricDirection = artifactEvidence?.metric?.direction;
    const metricProgress =
      currentMetric === undefined
        ? "missing"
        : previousMetric === undefined
          ? "unknown"
          : metricDirection === undefined
            ? "unknown"
            : metricDirection === "minimize"
              ? currentMetric < previousMetric
                ? "improved"
                : currentMetric > previousMetric
                  ? "regressed"
                  : "plateau"
              : currentMetric > previousMetric
                ? "improved"
                : currentMetric < previousMetric
                  ? "regressed"
                  : "plateau";
    const blockerStatus: RuntimeLongRunBlockerStatus =
      approvalScope.goalScoped > 0
        ? "approval_wait"
        : taskBlocker?.status ?? "none";
    const blockerReason =
      approvalScope.goalScoped > 0
        ? activeGoalIds.length > 0
          ? `${approvalScope.goalScoped} active-goal pending approval${approvalScope.goalScoped === 1 ? "" : "s"}`
          : `${approvalScope.goalScoped} pending approval${approvalScope.goalScoped === 1 ? "" : "s"}`
        : taskBlocker?.reason;
    return buildLongRunHealth({
      process: {
        status: "alive",
        checked_at: checkedAt,
        observed_at: checkedAt,
        pid: process.pid,
      },
      child_activity: {
        status: supervisorActivity.status,
        checked_at: checkedAt,
        observed_at: supervisorActivity.observedAt,
        active_count: supervisorActivity.activeCount,
      },
      log_freshness: {
        status: this.freshnessStatus(logEvidence?.mtimeMs, checkedAt, 5 * 60_000),
        checked_at: checkedAt,
        observed_at: logEvidence?.mtimeMs,
        path: logEvidence?.path,
      },
      artifact_freshness: {
        status: this.freshnessStatus(artifactEvidence?.mtimeMs, checkedAt, 10 * 60_000),
        checked_at: checkedAt,
        observed_at: artifactEvidence?.mtimeMs,
        path: artifactEvidence?.path,
      },
      metric_freshness: {
        status: artifactEvidence?.metric
          ? this.freshnessStatus(artifactEvidence.metric.observedAt, checkedAt, 10 * 60_000)
          : "missing",
        checked_at: checkedAt,
        observed_at: artifactEvidence?.metric?.observedAt,
        metric_name: artifactEvidence?.metric?.name,
      },
      metric_progress: {
        status: metricProgress,
        checked_at: checkedAt,
        observed_at: artifactEvidence?.metric?.observedAt,
        metric_name: artifactEvidence?.metric?.name,
        ...(artifactEvidence?.metric?.direction ? { direction: artifactEvidence.metric.direction } : {}),
        previous_value: previousMetric,
        current_value: currentMetric,
      },
      blocker: {
        status: blockerStatus,
        checked_at: checkedAt,
        observed_at: taskBlocker?.observedAt ?? checkedAt,
        reason: blockerReason,
        active_goal_ids: activeGoalIds,
        pending_approval_count: approvalScope.total,
        goal_scoped_pending_approval_count: approvalScope.goalScoped,
        unrelated_pending_approval_count: approvalScope.unrelated,
      },
      expected_next_checkpoint_at:
        supervisorActivity.status === "active" ? checkedAt + 5 * 60_000 : undefined,
      resumable: true,
    });
  }

  private async saveDaemonHealthWithKpi(params: {
    status: RuntimeDaemonHealth["status"];
    checkedAt: number;
    capabilityStatuses: RuntimeHealthCapabilityStatuses;
    reasons?: Partial<Record<keyof RuntimeHealthCapabilityStatuses, string>>;
  }): Promise<void> {
    const previous = await this.deps.runtimeHealthStore?.loadDaemonHealth();
    await this.deps.runtimeHealthStore?.saveDaemonHealth({
      status: params.status,
      leader: this.leaderOwnerToken !== null,
      checked_at: params.checkedAt,
      kpi: evolveRuntimeHealthKpi(
        previous?.kpi,
        params.capabilityStatuses,
        params.checkedAt,
        params.reasons,
      ),
      long_running: await this.buildLongRunHealthSnapshot(params.checkedAt),
      details: await this.buildHealthDetails(this.runtimeHealthPhase),
    });
  }

  async initializeFoundation(): Promise<void> {
    await Promise.all([
      this.deps.approvalStore?.ensureReady(),
      this.deps.outboxStore?.ensureReady(),
      this.deps.runtimeHealthStore?.ensureReady(),
    ]);

    this.deps.logger.info("Runtime journal foundation initialized", {
      runtime_root: this.deps.runtimeRoot,
      queue_store: "control-db:runtime_queue_records",
    });
  }

  async saveRuntimeHealthSnapshot(
    phase: string,
    components: RuntimeHealthComponents
  ): Promise<void> {
    this.runtimeHealthPhase = phase;
    this.runtimeHealthComponents = components;
    const checkedAt = Date.now();
    const status = Object.values(components).every((value) => value === "ok") ? "ok" : "degraded";
    const kpiStatuses = this.deriveCapabilityStatuses(components);
    const previous = await this.deps.runtimeHealthStore?.loadDaemonHealth();
    await this.deps.runtimeHealthStore?.saveSnapshot({
      status,
      leader: this.leaderOwnerToken !== null,
      checked_at: checkedAt,
      components,
      kpi: evolveRuntimeHealthKpi(previous?.kpi, kpiStatuses, checkedAt, {
        command_acceptance:
          kpiStatuses.command_acceptance === "ok"
            ? undefined
            : "gateway or queue health degraded",
        task_execution:
          kpiStatuses.task_execution === "ok"
            ? undefined
            : "supervisor or lease health degraded",
      }),
      long_running: await this.buildLongRunHealthSnapshot(checkedAt),
      details: await this.buildHealthDetails(phase),
    });
  }

  async acquireLeadership(leaseMs: number, heartbeatMs: number): Promise<void> {
    if (!this.deps.leaderLockManager) {
      return;
    }

    const acquired = await this.deps.leaderLockManager.acquire({ leaseMs });
    if (!acquired) {
      const current = await this.deps.leaderLockManager.read();
      throw new Error(
        `Runtime daemon leader already active (PID ${current?.pid ?? "unknown"})`
      );
    }

    this.leaderOwnerToken = acquired.owner_token;
    await this.writeRuntimeHeartbeat();
    this.leaderHeartbeatTimer = setInterval(() => {
      void this.renewLeadership(leaseMs).catch((err) => {
        this.deps.logger.error("Failed to renew runtime leader lock", {
          error: err instanceof Error ? err.message : String(err),
        });
        this.deps.onLeadershipLost(
          err instanceof Error ? err.message : String(err)
        );
      });
    }, heartbeatMs);
    this.leaderHeartbeatTimer.unref?.();
  }

  async releaseLeadership(): Promise<void> {
    if (this.leaderHeartbeatTimer !== null) {
      clearInterval(this.leaderHeartbeatTimer);
      this.leaderHeartbeatTimer = null;
    }

    const ownerToken = this.leaderOwnerToken;
    this.leaderOwnerToken = null;
    if (ownerToken) {
      await this.deps.leaderLockManager?.release(ownerToken);
    }
  }

  async saveFinalHealth(status: "failed" | "degraded"): Promise<void> {
    const checkedAt = Date.now();
    const previous = await this.deps.runtimeHealthStore?.loadDaemonHealth();
    await this.deps.runtimeHealthStore?.saveDaemonHealth({
      status,
      leader: false,
      checked_at: checkedAt,
      kpi: evolveRuntimeHealthKpi(previous?.kpi, {
        process_alive: status,
        command_acceptance: status,
        task_execution: status,
      }, checkedAt, {
        process_alive:
          status === "failed" ? "daemon exited unexpectedly" : "daemon stopped",
        command_acceptance:
          status === "failed" ? "daemon exited unexpectedly" : "daemon stopped",
        task_execution:
          status === "failed" ? "daemon exited unexpectedly" : "daemon stopped",
      }),
      long_running: previous?.long_running
        ? buildLongRunHealth({
            ...previous.long_running.signals,
            process: {
              ...previous.long_running.signals.process,
              status: "dead",
              checked_at: checkedAt,
              observed_at: checkedAt,
              reason: status === "failed" ? "daemon exited unexpectedly" : "daemon stopped",
            },
            resumable: status !== "failed",
          }, checkedAt)
        : undefined,
      details: await this.buildHealthDetails(this.runtimeHealthPhase),
    });
  }

  private async renewLeadership(leaseMs: number): Promise<void> {
    if (!this.deps.leaderLockManager || !this.leaderOwnerToken) {
      return;
    }

    const renewed = await this.deps.leaderLockManager.renew(this.leaderOwnerToken, {
      leaseMs,
    });
    if (!renewed) {
      this.deps.onLeadershipLost("Runtime leader lock was lost");
      return;
    }

    await this.writeRuntimeHeartbeat();
  }

  private async writeRuntimeHeartbeat(): Promise<void> {
    if (!this.deps.runtimeHealthStore) {
      return;
    }

    const checkedAt = Date.now();
    const components =
      this.runtimeHealthComponents ??
      {
        gateway: "degraded" as const,
        queue: "degraded" as const,
        leases: "degraded" as const,
        approval: "degraded" as const,
        outbox: "degraded" as const,
          supervisor: "degraded" as const,
      };
    const status = Object.values(components).every((value) => value === "ok") ? "ok" : "degraded";
    const previous = await this.deps.runtimeHealthStore.loadDaemonHealth();
    const derivedStatuses = this.deriveCapabilityStatuses(components);
    await this.saveDaemonHealthWithKpi({
      status,
      checkedAt,
      capabilityStatuses: {
        process_alive: "ok",
        command_acceptance: this.mergeCapabilityStatus(
          previous?.kpi?.command_acceptance.status,
          derivedStatuses.command_acceptance,
        ),
        task_execution: this.mergeCapabilityStatus(
          previous?.kpi?.task_execution.status,
          derivedStatuses.task_execution,
        ),
      },
      reasons: {
        command_acceptance:
          components.gateway === "ok" && components.queue === "ok"
            ? undefined
            : "gateway or queue health degraded",
        task_execution:
          components.supervisor === "ok" && components.leases === "ok"
            ? undefined
            : "supervisor or lease health degraded",
      },
    });
  }

  async observeCommandAcceptance(
    status: Exclude<RuntimeHealthCapabilityStatuses["command_acceptance"], "failed"> | "failed",
    reason?: string
  ): Promise<void> {
    const components = this.runtimeHealthComponents;
    const derivedStatuses = components ? this.deriveCapabilityStatuses(components) : null;
    await this.saveDaemonHealthWithKpi({
      status: status === "failed" ? "failed" : this.summarizeComponents(components),
      checkedAt: Date.now(),
      capabilityStatuses: {
        process_alive: "ok",
        command_acceptance: status,
        task_execution: derivedStatuses?.task_execution ?? "degraded",
      },
      reasons: {
        command_acceptance: reason,
      },
    });
  }

  async observeTaskExecution(
    status: Exclude<RuntimeHealthCapabilityStatuses["task_execution"], "failed"> | "failed",
    reason?: string
  ): Promise<void> {
    const components = this.runtimeHealthComponents;
    const derivedStatuses = components ? this.deriveCapabilityStatuses(components) : null;
    await this.saveDaemonHealthWithKpi({
      status: status === "failed" ? "failed" : this.summarizeComponents(components),
      checkedAt: Date.now(),
      capabilityStatuses: {
        process_alive: "ok",
        command_acceptance: derivedStatuses?.command_acceptance ?? "degraded",
        task_execution: status,
      },
      reasons: {
        task_execution: reason,
      },
    });
  }
}
