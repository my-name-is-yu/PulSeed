import { z } from "zod";

// --- Cross-Goal Allocation ---

export const CrossGoalAllocationSchema = z.object({
  goal_id: z.string(),
  priority: z.number().min(0).max(1),
  resource_share: z.number().min(0).max(1),
  adjustment_reason: z.string(),
});
export type CrossGoalAllocation = z.infer<typeof CrossGoalAllocationSchema>;

// --- Cross-Goal Portfolio Config ---

export const CrossGoalPortfolioConfigSchema = z.object({
  max_concurrent_goals: z.number().int().min(1).max(20).default(5),
  /** Rebalance interval in hours. Default: 168 (1 week) */
  priority_rebalance_interval_hours: z.number().min(1).default(168),
  min_goal_share: z.number().min(0).max(1).default(0.1),
  synergy_bonus: z.number().min(0).max(2).default(0.2),
});
export type CrossGoalPortfolioConfig = z.infer<typeof CrossGoalPortfolioConfigSchema>;

// --- Goal Priority Factors ---

export const GoalPriorityFactorsSchema = z.object({
  goal_id: z.string(),
  deadline_urgency: z.number().min(0).max(1),
  gap_severity: z.number().min(0).max(1),
  dependency_weight: z.number().min(0).max(1),
  user_priority: z.number().min(0).max(1),
  computed_priority: z.number().min(0).max(1),
});
export type GoalPriorityFactors = z.infer<typeof GoalPriorityFactorsSchema>;

// --- Strategy Template ---

export const StrategyTemplateSchema = z.object({
  template_id: z.string(),
  source_goal_id: z.string(),
  source_strategy_id: z.string(),
  hypothesis_pattern: z.string(),
  domain_tags: z.array(z.string()),
  effectiveness_score: z.number().min(0).max(1),
  applicable_dimensions: z.array(z.string()),
  embedding_id: z.string().nullable().default(null),
  created_at: z.string().datetime(),
});
export type StrategyTemplate = z.infer<typeof StrategyTemplateSchema>;

// --- Cross-Goal Rebalance Trigger ---

export const CrossGoalRebalanceTriggerEnum = z.enum([
  "periodic",
  "goal_completed",
  "goal_added",
  "priority_shift",
]);
export type CrossGoalRebalanceTrigger = z.infer<typeof CrossGoalRebalanceTriggerEnum>;

// --- Cross-Goal Rebalance Result ---

export const CrossGoalRebalanceResultSchema = z.object({
  timestamp: z.string().datetime(),
  allocations: z.array(CrossGoalAllocationSchema),
  triggered_by: CrossGoalRebalanceTriggerEnum,
});
export type CrossGoalRebalanceResult = z.infer<typeof CrossGoalRebalanceResultSchema>;

// --- Transfer Type (14F) ---

export const TransferTypeEnum = z.enum(["knowledge", "strategy", "pattern"]);
export type TransferType = z.infer<typeof TransferTypeEnum>;

// --- Transfer Candidate (14F) ---

export const TransferCandidateSchema = z.object({
  candidate_id: z.string(),
  source_goal_id: z.string(),
  target_goal_id: z.string(),
  type: TransferTypeEnum,
  source_item_id: z.string(),
  similarity_score: z.number().min(0).max(1),
  estimated_benefit: z.string(),
});
export type TransferCandidate = z.infer<typeof TransferCandidateSchema>;

// --- Transfer Result (14F) ---

export const TransferResultSchema = z.object({
  transfer_id: z.string(),
  candidate_id: z.string(),
  applied_at: z.string().datetime(),
  adaptation_description: z.string(),
  success: z.boolean(),
});
export type TransferResult = z.infer<typeof TransferResultSchema>;

// --- Transfer Effectiveness (14F) ---

export const TransferEffectivenessEnum = z.enum(["positive", "negative", "neutral"]);
export type TransferEffectiveness = z.infer<typeof TransferEffectivenessEnum>;

export const TransferEffectivenessSchema = z.object({
  transfer_id: z.string(),
  gap_delta_before: z.number(),
  gap_delta_after: z.number(),
  effectiveness: TransferEffectivenessEnum,
  evaluated_at: z.string().datetime(),
});
export type TransferEffectivenessRecord = z.infer<typeof TransferEffectivenessSchema>;
