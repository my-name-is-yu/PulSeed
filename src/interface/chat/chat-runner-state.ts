import { ScheduleHistoryStore } from "../../runtime/schedule/history.js";
import { GoalTaskStateStore } from "../../runtime/store/goal-task-state-store.js";
import { parseUsagePeriodMs } from "../usage-period.js";

export interface GoalUsageSummary {
  goalId: string;
  totalTokens: number;
  taskCount: number;
  terminalTaskCount: number;
}

export interface ScheduleUsageSummary {
  period: string;
  runs: number;
  totalTokens: number;
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function addSafeTokenCount(total: number, value: unknown): number {
  if (!isNonnegativeSafeInteger(value)) return total;
  if (value > Number.MAX_SAFE_INTEGER - total) return total;
  return total + value;
}

export { parseUsagePeriodMs };

export async function collectGoalUsage(baseDir: string, goalId: string): Promise<GoalUsageSummary> {
  const ledgers = (await new GoalTaskStateStore(baseDir).listTaskOutcomeLedgers())
    .filter((record) => record.goal_id === goalId);
  let totalTokens = 0;
  let taskCount = 0;
  let terminalTaskCount = 0;
  for (const ledger of ledgers) {
    taskCount += 1;
    totalTokens = addSafeTokenCount(totalTokens, ledger.summary?.["tokens_used"]);
    if (ledger.summary?.["latest_event_type"] === "succeeded"
      || ledger.summary?.["latest_event_type"] === "failed"
      || ledger.summary?.["latest_event_type"] === "abandoned") {
      terminalTaskCount += 1;
    }
  }

  return { goalId, totalTokens, taskCount, terminalTaskCount };
}

export async function collectScheduleUsage(
  baseDir: string,
  period: string,
  now = Date.now()
): Promise<ScheduleUsageSummary> {
  const periodMs = parseUsagePeriodMs(period);
  const since = now - periodMs;
  const raw = await new ScheduleHistoryStore(baseDir).load();
  let runs = 0;
  let totalTokens = 0;
  for (const record of raw) {
    if (!record || typeof record !== "object") continue;
    const finishedAt = (record as Record<string, unknown>)["finished_at"];
    const firedAt = typeof finishedAt === "string" ? Date.parse(finishedAt) : Number.NaN;
    if (!Number.isFinite(firedAt) || firedAt < since) continue;
    runs += 1;
    const tokensUsed = (record as Record<string, unknown>)["tokens_used"];
    totalTokens = addSafeTokenCount(totalTokens, tokensUsed);
  }
  return { period, runs, totalTokens };
}
