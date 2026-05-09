import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { TaskSchema, type Task } from "../../base/types/task.js";
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

export function resolveStatePath(baseDir: string, ...segments: string[]): string | null {
  const base = path.resolve(baseDir);
  const resolved = path.resolve(base, ...segments);
  if (!resolved.startsWith(base + path.sep)) return null;
  return resolved;
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function addSafeTokenCount(total: number, value: unknown): number {
  if (!isNonnegativeSafeInteger(value)) return total;
  if (value > Number.MAX_SAFE_INTEGER - total) return total;
  return total + value;
}

export async function listRecoverableArchivedGoalIds(baseDir: string): Promise<string[]> {
  const archiveDir = resolveStatePath(baseDir, "archive");
  if (archiveDir === null) return [];
  let entries: Array<{ name: string; isDirectory(): boolean }> = [];
  try {
    entries = await fsp.readdir(archiveDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const goalIds: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === ".staging") continue;
    try {
      await fsp.access(path.join(archiveDir, entry.name, "goal", "goal.json"));
      goalIds.push(entry.name);
    } catch {
      continue;
    }
  }
  return goalIds;
}

export async function readTasksFromDir(tasksDir: string): Promise<Task[]> {
  let entries: string[] = [];
  try {
    entries = await fsp.readdir(tasksDir);
  } catch {
    return [];
  }

  const tasks: Task[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json") || entry === "task-history.json" || entry === "last-failure-context.json") continue;
    let raw: unknown;
    try {
      raw = JSON.parse(await fsp.readFile(path.join(tasksDir, entry), "utf-8"));
    } catch {
      continue;
    }
    const parsed = TaskSchema.safeParse(raw);
    if (parsed.success) tasks.push(parsed.data);
  }
  return tasks.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
}

export async function readTasksForGoal(baseDir: string, goalId: string): Promise<Task[]> {
  const activeTasksDir = resolveStatePath(baseDir, "tasks", goalId);
  const archiveTasksDir = resolveStatePath(baseDir, "archive", goalId, "tasks");
  if (activeTasksDir === null || archiveTasksDir === null) return [];
  const activeTasks = await readTasksFromDir(activeTasksDir);
  if (activeTasks.length > 0) return activeTasks;
  return readTasksFromDir(archiveTasksDir);
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
