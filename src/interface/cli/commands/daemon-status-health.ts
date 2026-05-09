import type { RuntimeHealthSnapshot } from "../../../runtime/store/runtime-schemas.js";
import {
  formatRelativeTime,
  formatRelativeTimestamp,
} from "./daemon-shared.js";

export const STALE_RUNTIME_HEALTH_REASON = "live PID inspection reports runtime stopped; stored health snapshot is historical";

export interface HistoricalSnapshotContext {
  lastObservedAt?: number;
  stoppedAt?: string;
  checkedAt: number;
}

export function formatHistoricalSnapshotContext(context: HistoricalSnapshotContext): string {
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

export function parseHistoricalObservationTime(value: string | null | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? undefined : parsed;
}

export function reconcileRuntimeHealthForDisplay(
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
