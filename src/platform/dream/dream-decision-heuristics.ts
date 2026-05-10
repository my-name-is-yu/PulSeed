import { z } from "zod";

export const DreamStrategySelectorSchema = z.object({
  strategy_id: z.string().optional(),
  source_template_id: z.string().optional(),
  strategy_family: z.string().optional(),
  exploration_role: z.enum(["exploitation", "adjacent_exploration", "divergent_exploration"]).optional(),
  smoke_status: z.enum(["not_run", "promote", "defer", "retire"]).optional(),
  metric_trend: z.enum(["improving", "stalled", "noisy", "regressing", "breakthrough"]).optional(),
  failed_lineage_fingerprint: z.string().optional(),
}).strict();
export type DreamStrategySelector = z.infer<typeof DreamStrategySelectorSchema>;

export const DreamDecisionHeuristicSchema = z.object({
  id: z.string(),
  if_stall_count_gte: z.number().int().nonnegative().optional(),
  strategy_id: z.string().optional(),
  candidate_selector: DreamStrategySelectorSchema.optional(),
  prefer_candidate_selector: DreamStrategySelectorSchema.optional(),
  avoid_candidate_selector: DreamStrategySelectorSchema.optional(),
  strategy_hypothesis_includes: z.string().optional(),
  prefer_strategy_hypothesis_includes: z.string().optional(),
  avoid_strategy_hypothesis_includes: z.string().optional(),
  score_delta: z.number().default(0),
  reason: z.string().default("dream heuristic"),
});
export type DreamDecisionHeuristic = z.infer<typeof DreamDecisionHeuristicSchema>;

export const DreamDecisionHeuristicFileSchema = z.object({
  heuristics: z.array(DreamDecisionHeuristicSchema).default([]),
});
