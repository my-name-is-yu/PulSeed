import { z } from "zod";

const ReflectionNonnegativeSafeIntSchema = z.number().finite().int().nonnegative().safe();

// ─── GoalSummary ───

export const GoalSummarySchema = z.object({
  goal_id: z.string(),
  title: z.string(),
  status: z.string(),
  gap_score: z.number().finite().min(0).max(1),
  stall_level: z.number().int().min(0).max(3),
  dimensions_count: ReflectionNonnegativeSafeIntSchema,
});
export type GoalSummary = z.infer<typeof GoalSummarySchema>;

// ─── PlanningReport ───

export const PlanningReportSchema = z.object({
  date: z.string(),
  created_at: z.string(),
  goals_reviewed: ReflectionNonnegativeSafeIntSchema,
  priorities: z.array(
    z.object({
      goal_id: z.string(),
      priority: z.enum(["high", "medium", "low"]),
      reasoning: z.string(),
    })
  ),
  suggestions: z.array(z.string()),
  concerns: z.array(z.string()),
});
export type PlanningReport = z.infer<typeof PlanningReportSchema>;

// ─── CatchupReport ───

export const CatchupReportSchema = z.object({
  date: z.string(),
  created_at: z.string(),
  goals_reviewed: ReflectionNonnegativeSafeIntSchema,
  progress_summary: z.string(),
  completions: z.array(z.string()),
  stalls: z.array(z.string()),
  concerns: z.array(z.string()),
});
export type CatchupReport = z.infer<typeof CatchupReportSchema>;

// ─── ConsolidationReport ───

export const ConsolidationReportSchema = z.object({
  date: z.string(),
  created_at: z.string(),
  goals_consolidated: ReflectionNonnegativeSafeIntSchema,
  entries_compressed: ReflectionNonnegativeSafeIntSchema,
  stale_entries_found: ReflectionNonnegativeSafeIntSchema,
  revalidation_tasks_created: ReflectionNonnegativeSafeIntSchema,
  cognition_writeback_inputs_read: ReflectionNonnegativeSafeIntSchema.default(0),
  cognition_runtime_authority_granted: z.literal(false).default(false),
});
export type ConsolidationReport = z.infer<typeof ConsolidationReportSchema>;

// ─── WeeklyReviewReport ───

export const WeeklyReviewReportSchema = z.object({
  week: z.string(),
  created_at: z.string(),
  goals_reviewed: ReflectionNonnegativeSafeIntSchema,
  rankings: z.array(
    z.object({
      goal_id: z.string(),
      progress_rate: z.number().min(0).max(1),
      strategy_effectiveness: z.enum(["high", "medium", "low"]),
      recommendation: z.string(),
    })
  ),
  suggested_additions: z.array(z.string()),
  suggested_removals: z.array(z.string()),
  summary: z.string(),
});
export type WeeklyReviewReport = z.infer<typeof WeeklyReviewReportSchema>;
