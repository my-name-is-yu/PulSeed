import * as fsp from "node:fs/promises";
import * as path from "node:path";
import type { StateManager } from "../base/state/state-manager.js";
import type { ILLMClient } from "../base/llm/llm-client.js";
import type { INotificationDispatcher } from "../runtime/notification-dispatcher.js";
import { z } from "zod";
import type { CatchupReport } from "./types.js";
import { CatchupReportSchema } from "./types.js";
import type { HookManager } from "../runtime/hook-manager.js";
import { getInternalIdentityPrefix } from "../base/config/identity-loader.js";
import {
  dispatchReflectionNotification,
  emitReflectionComplete,
  loadActiveGoalSummaries,
  persistReflectionReport,
  todayISO,
} from "./reflection-utils.js";

// ─── LLM response schema ───

const LLMCatchupResponseSchema = z.object({
  progress_summary: z.string(),
  completions: z.array(z.string()).default([]),
  stalls: z.array(z.string()).default([]),
  concerns: z.array(z.string()).default([]),
});

// ─── Main ───

export async function runEveningCatchup(deps: {
  stateManager: StateManager;
  llmClient: ILLMClient;
  baseDir: string;
  notificationDispatcher?: INotificationDispatcher;
  hookManager?: HookManager;
}): Promise<CatchupReport> {
  const { stateManager, llmClient, baseDir, notificationDispatcher, hookManager } = deps;
  const date = todayISO();
  const now = new Date().toISOString();

  const goalSummaries = await loadActiveGoalSummaries(stateManager);

  let progressSummary = "No active goals to review.";
  let completions: string[] = [];
  let stalls: string[] = [];
  let concerns: string[] = [];

  if (goalSummaries.length > 0) {
    // Load morning report if available for comparison
    const morningPath = path.join(baseDir, "reflections", `morning-${date}.json`);
    let morningData: unknown = null;
    try {
      const raw = await fsp.readFile(morningPath, "utf-8");
      morningData = JSON.parse(raw);
    } catch {
      // No morning report available
    }

    const prompt = `${getInternalIdentityPrefix("evening catch-up assistant")} Review today's goal progress.

Current goal state:
${JSON.stringify(goalSummaries, null, 2)}

${morningData ? `Morning plan:\n${JSON.stringify(morningData, null, 2)}\n` : ""}

Summarize the day's progress. List any completions, stalls, or concerns.

Respond with JSON:
{ "progress_summary": string, "completions": [string], "stalls": [string], "concerns": [string] }`;

    try {
      const response = await llmClient.sendMessage([{ role: "user", content: prompt }]);
      const parsed = llmClient.parseJSON(response.content, LLMCatchupResponseSchema);
      progressSummary = parsed.progress_summary;
      completions = parsed.completions ?? [];
      stalls = parsed.stalls ?? [];
      concerns = parsed.concerns ?? [];
    } catch {
      // LLM error — return partial report
      progressSummary = "Unable to generate summary due to LLM error.";
    }
  }

  const report = CatchupReportSchema.parse({
    date,
    created_at: now,
    goals_reviewed: goalSummaries.length,
    progress_summary: progressSummary,
    completions,
    stalls,
    concerns,
  });

  await persistReflectionReport(baseDir, `evening-${date}.json`, report);

  emitReflectionComplete(hookManager, "evening_catchup");

  // Notify
  if (notificationDispatcher && goalSummaries.length > 0) {
    await dispatchReflectionNotification(notificationDispatcher, {
      id: `evening-catchup-${date}`,
      report_type: "daily_summary",
      title: `Evening Catch-up — ${date}`,
      content: progressSummary,
      generated_at: new Date().toISOString(),
    });
  }

  return report;
}
