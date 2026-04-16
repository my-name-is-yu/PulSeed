import type { StateManager } from "../base/state/state-manager.js";
import type { ILLMClient } from "../base/llm/llm-client.js";
import type { INotificationDispatcher } from "../runtime/notification-dispatcher.js";
import { z } from "zod";
import type { PlanningReport } from "./types.js";
import { PlanningReportSchema } from "./types.js";
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

const LLMPlanningResponseSchema = z.object({
  priorities: z.array(
    z.object({
      goal_id: z.string(),
      priority: z.enum(["high", "medium", "low"]),
      reasoning: z.string(),
    })
  ),
  suggestions: z.array(z.string()).default([]),
  concerns: z.array(z.string()).default([]),
});

// ─── Main ───

export async function runMorningPlanning(deps: {
  stateManager: StateManager;
  llmClient: ILLMClient;
  baseDir: string;
  notificationDispatcher?: INotificationDispatcher;
  hookManager?: HookManager;
}): Promise<PlanningReport> {
  const { stateManager, llmClient, baseDir, notificationDispatcher, hookManager } = deps;
  const date = todayISO();
  const now = new Date().toISOString();

  const goalSummaries = await loadActiveGoalSummaries(stateManager);

  let priorities: PlanningReport["priorities"] = [];
  let suggestions: string[] = [];
  let concerns: string[] = [];

  if (goalSummaries.length > 0) {
    const prompt = `${getInternalIdentityPrefix("morning planner")} Review these active goals and create a daily plan.

Goals:
${JSON.stringify(goalSummaries, null, 2)}

For each goal, assign priority (high/medium/low) with reasoning.
List any suggestions for new actions or concerns.

Respond with JSON matching this schema:
{ "priorities": [{"goal_id": string, "priority": "high"|"medium"|"low", "reasoning": string}], "suggestions": [string], "concerns": [string] }`;

    try {
      const response = await llmClient.sendMessage([{ role: "user", content: prompt }]);
      const parsed = llmClient.parseJSON(response.content, LLMPlanningResponseSchema);
      priorities = parsed.priorities;
      suggestions = parsed.suggestions ?? [];
      concerns = parsed.concerns ?? [];
    } catch {
      // LLM error — return partial report with empty priorities
    }
  }

  const report = PlanningReportSchema.parse({
    date,
    created_at: now,
    goals_reviewed: goalSummaries.length,
    priorities,
    suggestions,
    concerns,
  });

  await persistReflectionReport(baseDir, `morning-${date}.json`, report);

  emitReflectionComplete(hookManager, "morning_planning");

  // Notify
  if (notificationDispatcher && goalSummaries.length > 0) {
    await dispatchReflectionNotification(notificationDispatcher, {
      id: `morning-planning-${date}`,
      report_type: "daily_summary",
      title: `Morning Planning — ${date}`,
      content: `Reviewed ${goalSummaries.length} goals. ${concerns.length} concern(s).`,
      generated_at: new Date().toISOString(),
    });
  }

  return report;
}
