import type { StateManager } from "../base/state/state-manager.js";
import type { GoalSummary } from "./types.js";
import type { HookManager } from "../runtime/hook-manager.js";
import type { INotificationDispatcher } from "../runtime/notification-dispatcher.js";
import {
  ReflectionReportStateStore,
  type ReflectionReportByType,
  type ReflectionReportStateStoreOptions,
  type ReflectionReportType,
} from "./reflection-report-state-store.js";

type GapHistoryEntry = { gap_vector: Array<{ normalized_weighted_gap: number }> };

export const REFLECTION_REPORT_PROMPT_MAX_BYTES = 1024 * 1024;

export function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function aggregateGapScore(gaps: Array<{ normalized_weighted_gap: number }>): number {
  if (gaps.length === 0) return 0;
  return Math.max(...gaps.map((g) => g.normalized_weighted_gap));
}

export async function loadActiveGoalSummaries(stateManager: StateManager): Promise<GoalSummary[]> {
  const goalIds = await stateManager.listGoalIds();
  const summaries: GoalSummary[] = [];

  for (const id of goalIds) {
    const goal = await stateManager.loadGoal(id);
    if (!goal || goal.status !== "active") continue;

    const gapHistory = await stateManager.loadGapHistory(id);
    const latest = gapHistory.at(-1) as GapHistoryEntry | undefined;
    const gapScore = latest ? aggregateGapScore(latest.gap_vector) : 0;

    summaries.push({
      goal_id: goal.id,
      title: goal.title,
      status: goal.status,
      gap_score: Math.min(1, Math.max(0, gapScore)),
      stall_level: 0,
      dimensions_count: goal.dimensions.length,
    });
  }

  return summaries;
}

export async function saveReflectionReport<TType extends ReflectionReportType>(
  baseDir: string,
  reportType: TType,
  periodKey: string,
  report: ReflectionReportByType[TType],
  options: ReflectionReportStateStoreOptions = {},
): Promise<ReflectionReportByType[TType]> {
  const store = new ReflectionReportStateStore(baseDir, options);
  try {
    return await store.save(reportType, periodKey, report);
  } finally {
    await store.close();
  }
}

export async function loadReflectionReport<TType extends ReflectionReportType>(
  baseDir: string,
  reportType: TType,
  periodKey: string,
  options: ReflectionReportStateStoreOptions = {},
): Promise<ReflectionReportByType[TType] | null> {
  const store = new ReflectionReportStateStore(baseDir, options);
  try {
    return await store.load(reportType, periodKey);
  } finally {
    await store.close();
  }
}

export function formatReflectionReportForPrompt(
  report: unknown,
  options: { maxBytes?: number } = {},
): string | null {
  const maxBytes = options.maxBytes ?? REFLECTION_REPORT_PROMPT_MAX_BYTES;
  const serialized = JSON.stringify(report, null, 2);
  return Buffer.byteLength(serialized, "utf8") <= maxBytes ? serialized : null;
}

export function emitReflectionComplete(hookManager: HookManager | undefined, type: string): void {
  void hookManager?.emit("ReflectionComplete", { data: { type } });
}

export async function dispatchReflectionNotification(
  notificationDispatcher: INotificationDispatcher | undefined,
  notification: {
    id: string;
    report_type: "daily_summary" | "weekly_report";
    title: string;
    content: string;
    generated_at: string;
  }
): Promise<void> {
  if (!notificationDispatcher) return;

  await notificationDispatcher.dispatch({
    id: notification.id,
    report_type: notification.report_type,
    goal_id: null,
    title: notification.title,
    content: notification.content,
    verbosity: "standard",
    generated_at: notification.generated_at,
    delivered_at: null,
    read: false,
  });
}
