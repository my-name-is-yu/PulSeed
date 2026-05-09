import type { StateManager } from "../../base/state/state-manager.js";
import { getPulseedDirPath } from "../../base/utils/paths.js";
import { loadProviderConfig } from "../../base/llm/provider-config.js";
import { TaskSchema, type Task } from "../../base/types/task.js";
import type { Goal } from "../../base/types/goal.js";
import type { LoadedChatSession } from "./chat-session-store.js";
import type { ChatSession } from "./chat-history.js";
import {
  collectGoalUsage,
  collectScheduleUsage,
  listRecoverableArchivedGoalIds,
  readTasksForGoal,
} from "./chat-runner-state.js";
import { formatGoalListLine } from "../goal-status-display.js";
export {
  formatUsageCounter,
  hasUsage,
  normalizeUsageCounter,
  usageFromLLMResponse,
  zeroUsageCounter,
} from "./chat-usage.js";

export interface ProviderConfigSummary {
  provider: string;
  model: string;
  adapter: string;
  light_model?: string;
  reasoning_effort?: string;
  base_url?: string;
  codex_cli_path?: string;
  has_api_key: boolean;
}

export function formatHistory(session: LoadedChatSession): string {
  const lines = [
    `Chat session ${session.id}`,
    `Title: ${session.title ?? "(untitled)"}`,
    `Created: ${session.createdAt}`,
    `Updated: ${session.updatedAt}`,
    "",
  ];
  for (const message of session.messages) {
    lines.push(`[${message.timestamp}] ${message.role}: ${message.content}`);
  }
  return lines.join("\n");
}

export async function loadGoals(stateManager: StateManager): Promise<Goal[]> {
  const goalIds = await stateManager.listGoalIds();
  const goals = await Promise.all(goalIds.map((goalId) => stateManager.loadGoal(goalId)));
  return goals.filter((goal): goal is Goal => goal !== null);
}

export async function listAllGoalIds(stateManager: StateManager): Promise<string[]> {
  const activeGoalIds = new Set((await loadGoals(stateManager)).map((goal) => goal.id));
  const archivedGoalIds = await listRecoverableArchivedGoalIds(stateManager.getBaseDir());
  for (const goalId of archivedGoalIds) activeGoalIds.add(goalId);
  return Array.from(activeGoalIds);
}

export function activeGoals(goals: Goal[]): Goal[] {
  return goals.filter((goal) => goal.status !== "archived" && goal.status !== "cancelled" && goal.status !== "abandoned");
}

export function formatGoalLine(goal: Goal): string {
  return formatGoalListLine(goal);
}

export function formatDiagnosticGoalLine(goal: Goal): string {
  return formatGoalListLine(goal, { diagnostic: true });
}

export async function readTasksForGoalFromState(stateManager: StateManager, goalId: string): Promise<Task[]> {
  return readTasksForGoal(stateManager.getBaseDir(), goalId);
}

export async function resolveGoalForTasks(
  stateManager: StateManager,
  selector: string
): Promise<{ goalId?: string; error?: string }> {
  if (selector) return { goalId: selector };
  const active = activeGoals(await loadGoals(stateManager));
  if (active.length === 1) return { goalId: active[0]?.id };
  if (active.length === 0) return { error: "No active goals found. Usage: /tasks <goal-id>" };
  return { error: "Multiple active goals found. Usage: /tasks <goal-id>" };
}

export function formatTaskLine(task: Task): string {
  return `- ${task.id} [${task.status}] ${task.work_description}`;
}

export function parseTaskArgs(args: string): { taskId?: string; goalId?: string } {
  const parts = args.split(/\s+/).filter(Boolean);
  const goalFlagIndex = parts.indexOf("--goal");
  if (goalFlagIndex >= 0) {
    const goalId = parts[goalFlagIndex + 1];
    parts.splice(goalFlagIndex, goalId ? 2 : 1);
    return { taskId: parts[0], goalId };
  }
  return { taskId: parts[0], goalId: parts[1] };
}

export async function findTask(
  stateManager: StateManager,
  taskId: string,
  goalId?: string
): Promise<{ task?: Task; matches: Array<{ goalId: string; task: Task }> }> {
  const goalIds = goalId ? [goalId] : await listAllGoalIds(stateManager);
  const matches: Array<{ goalId: string; task: Task }> = [];
  for (const candidateGoalId of goalIds) {
    let raw: unknown | null = null;
    try {
      raw = await stateManager.readRaw(`tasks/${candidateGoalId}/${taskId}.json`);
    } catch {
      raw = null;
    }
    if (!raw) {
      const tasks = await readTasksForGoalFromState(stateManager, candidateGoalId);
      const matched = tasks.find((task) => task.id === taskId || task.id.startsWith(taskId));
      if (matched) matches.push({ goalId: candidateGoalId, task: matched });
      continue;
    }
    const parsed = TaskSchema.safeParse(raw);
    if (parsed.success) matches.push({ goalId: candidateGoalId, task: parsed.data });
  }
  return { task: matches.length === 1 ? matches[0]?.task : undefined, matches };
}

export function formatTask(task: Task): string {
  const lines = [
    `Task: ${task.id}`,
    `Goal: ${task.goal_id}`,
    `Status: ${task.status}`,
    `Category: ${task.task_category}`,
    `Created: ${task.created_at}`,
    `Work: ${task.work_description}`,
    `Approach: ${task.approach}`,
  ];
  if (task.started_at) lines.push(`Started: ${task.started_at}`);
  if (task.completed_at) lines.push(`Completed: ${task.completed_at}`);
  if (task.verification_verdict) lines.push(`Verification: ${task.verification_verdict}`);
  if (task.verification_evidence?.length) lines.push(`Evidence: ${task.verification_evidence.join("; ")}`);
  if (task.success_criteria.length > 0) {
    lines.push("Success criteria:");
    lines.push(...task.success_criteria.map((criterion) => `- ${criterion.description}`));
  }
  return lines.join("\n");
}

export function providerConfigBaseDir(stateManager: StateManager): string {
  const stateManagerWithBaseDir = stateManager as StateManager & { getBaseDir?: () => string };
  return typeof stateManagerWithBaseDir.getBaseDir === "function"
    ? stateManagerWithBaseDir.getBaseDir()
    : getPulseedDirPath();
}

export async function readProviderConfigSummary(stateManager: StateManager): Promise<ProviderConfigSummary> {
  const config = await loadProviderConfig({
    baseDir: providerConfigBaseDir(stateManager),
    saveMigration: false,
  });
  return {
    provider: config.provider,
    model: config.model,
    adapter: config.adapter,
    light_model: config.light_model,
    reasoning_effort: config.reasoning_effort,
    base_url: config.base_url,
    codex_cli_path: config.codex_cli_path,
    has_api_key: Boolean(config.api_key),
  };
}

export function formatConfig(config: ProviderConfigSummary): string {
  return Object.entries(config)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${typeof value === "string" && /key|token|secret/i.test(key) ? "[masked]" : String(value)}`)
    .join("\n");
}

export async function buildGoalUsageSummary(stateManager: StateManager, goalId: string): Promise<string[]> {
  const summary = await collectGoalUsage(stateManager.getBaseDir(), goalId);
  return [
    "Usage summary (goal scope)",
    `Goal: ${summary.goalId}`,
    `Tasks observed: ${summary.taskCount}`,
    `Terminal tasks: ${summary.terminalTaskCount}`,
    `Total tokens: ${summary.totalTokens}`,
  ];
}

export async function buildScheduleUsageSummary(stateManager: StateManager, period: string): Promise<string[]> {
  const summary = await collectScheduleUsage(stateManager.getBaseDir(), period);
  return [
    `Usage summary (schedule, ${summary.period})`,
    `Runs: ${summary.runs}`,
    `Total tokens: ${summary.totalTokens}`,
  ];
}

export function deterministicChatSummary(messages: ChatSession["messages"]): string {
  const lines = messages.map((message) => `${message.role}: ${message.content.replace(/\s+/g, " ").trim()}`);
  return lines.join("\n").slice(0, 4_000);
}
