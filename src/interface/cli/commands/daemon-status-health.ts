import type { RuntimeHealthSnapshot } from "../../../runtime/store/runtime-schemas.js";
import { inspectControlDatabase } from "../../../runtime/store/index.js";
import {
  formatAbsoluteRelativeTimestamp,
  formatRelativeTime,
} from "./daemon-shared.js";

export const STALE_RUNTIME_HEALTH_REASON = "live PID inspection reports runtime stopped; stored health snapshot is historical";
export const LIVE_RUNTIME_OVERRIDES_STALE_HEALTH_REASON =
  "live PID inspection reports runtime running; stored process health is a historical snapshot";

export interface HistoricalSnapshotContext {
  lastObservedAt?: number;
  stoppedAt?: string;
  checkedAt: number;
}

function formatHistoricalTimestamp(timestamp: number | undefined): string | null {
  const rendered = formatAbsoluteRelativeTimestamp(timestamp);
  return rendered === "n/a" ? null : rendered;
}

export function formatHistoricalSnapshotContext(context: HistoricalSnapshotContext): string {
  const parts = ["historical snapshot"];
  const lastObservedAt = formatHistoricalTimestamp(context.lastObservedAt);
  if (lastObservedAt !== null) {
    parts.push(`last observed ${lastObservedAt}`);
  }
  if (context.stoppedAt) {
    parts.push(`stopped ${context.stoppedAt} (${formatRelativeTime(context.stoppedAt)})`);
  }
  parts.push(`checked ${formatHistoricalTimestamp(context.checkedAt) ?? "unknown"}`);
  return ` (${parts.join("; ")})`;
}

export function parseHistoricalObservationTime(value: string | null | undefined): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function formatControlDbSchemaDriftMessage(baseDir: string): string | null {
  const inspection = inspectControlDatabase({ baseDir });
  if (inspection.status !== "ahead_of_code") {
    return null;
  }
  return [
    "Control DB schema drift detected.",
    `Database schema version ${inspection.schemaVersion ?? "unknown"} is newer than this PulSeed build supports (${inspection.expectedSchemaVersion}).`,
    "Update/rebuild PulSeed before starting the daemon or gateway; runtime readiness is not healthy while this mismatch remains.",
  ].join(" ");
}

export function reconcileRuntimeHealthForDisplay(
  snapshot: RuntimeHealthSnapshot | null,
  opts: { runtimeAlive: boolean; runtimePid: number | null }
): RuntimeHealthSnapshot | null {
  if (!snapshot) {
    return snapshot;
  }
  if (opts.runtimeAlive) {
    if (!runtimeHealthContradictsLivePid(snapshot)) {
      return snapshot;
    }
    const checkedAt = Date.now();
    const kpi: RuntimeHealthSnapshot["kpi"] = snapshot.kpi
      ? {
        ...snapshot.kpi,
        process_alive: {
          ...snapshot.kpi.process_alive,
          status: "ok",
          checked_at: checkedAt,
          last_ok_at: checkedAt,
          reason: LIVE_RUNTIME_OVERRIDES_STALE_HEALTH_REASON,
        },
        recovered_at: snapshot.kpi.recovered_at ?? checkedAt,
      }
      : undefined;
    const longRunning: RuntimeHealthSnapshot["long_running"] = snapshot.long_running
      ? {
        ...snapshot.long_running,
        summary: snapshot.long_running.summary === "dead_but_resumable" || snapshot.long_running.summary === "dead_needs_intervention"
          ? "unknown"
          : snapshot.long_running.summary,
        checked_at: checkedAt,
        signals: {
          ...snapshot.long_running.signals,
          process: {
            ...snapshot.long_running.signals.process,
            status: "alive",
            pid: opts.runtimePid ?? snapshot.long_running.signals.process.pid,
            checked_at: checkedAt,
            observed_at: checkedAt,
            reason: LIVE_RUNTIME_OVERRIDES_STALE_HEALTH_REASON,
          },
        },
      }
      : undefined;

    return {
      ...snapshot,
      status: snapshot.status === "failed" ? "degraded" : snapshot.status,
      checked_at: checkedAt,
      kpi,
      long_running: longRunning,
    };
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

function runtimeHealthContradictsLivePid(snapshot: RuntimeHealthSnapshot): boolean {
  return snapshot.kpi?.process_alive.status === "failed"
    || snapshot.long_running?.signals.process.status === "dead";
}
