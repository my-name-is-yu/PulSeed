import type { StateManager } from "../base/state/state-manager.js";
import type { ILLMClient } from "../base/llm/llm-client.js";
import type { INotificationDispatcher } from "../runtime/notification-dispatcher.js";
import { z } from "zod/v3";
import type { PlanningReport } from "./types.js";
import { PlanningReportSchema } from "./types.js";
import type { HookManager } from "../runtime/hook-manager.js";
import { getInternalIdentityPrefix } from "../base/config/identity-loader.js";
import {
  dispatchReflectionNotification,
  emitReflectionComplete,
  loadActiveGoalSummaries,
  saveReflectionReport,
  todayISO,
} from "./reflection-utils.js";
import { buildReflectionRelationshipProfileSurfaceContext } from "./reflection-profile-surface.js";

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
    const relationshipProfileSurface = await buildReflectionRelationshipProfileSurfaceContext({
      baseDir,
      scopeRef: "morning-planning",
      purpose: "morning_planning",
      title: "Morning planning relationship profile Surface",
      now,
    });
    const prompt = [
      getInternalIdentityPrefix("morning planner", {
        baseDir,
      }),
      relationshipProfileSurface,
      `Review these active goals and create a daily plan.

Goals:
${JSON.stringify(goalSummaries, null, 2)}

For each goal, assign priority (high/medium/low) with reasoning.
List any suggestions for new actions or concerns.

Respond with JSON matching this schema:
{ "priorities": [{"goal_id": string, "priority": "high"|"medium"|"low", "reasoning": string}], "suggestions": [string], "concerns": [string] }`,
    ].filter((part) => part.trim().length > 0).join("\n\n");

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

  await saveReflectionReport(baseDir, "morning", date, report);

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
