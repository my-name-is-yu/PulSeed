import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { StateManager } from "../base/state/state-manager.js";
import { writeJsonFileAtomic } from "../base/utils/json-io.js";
import type { GoalSummary } from "./types.js";
import type { HookManager } from "../runtime/hook-manager.js";
import type { INotificationDispatcher } from "../runtime/notification-dispatcher.js";

type GapHistoryEntry = { gap_vector: Array<{ normalized_weighted_gap: number }> };

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

export async function persistReflectionReport(
  baseDir: string,
  filename: string,
  report: unknown
): Promise<void> {
  const reflectionsDir = path.join(baseDir, "reflections");
  await fsp.mkdir(reflectionsDir, { recursive: true });
  await writeJsonFileAtomic(path.join(reflectionsDir, filename), report);
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
