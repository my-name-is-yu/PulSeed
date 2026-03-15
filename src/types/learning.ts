import { z } from "zod";

// --- Learning Trigger Type ---

export const LearningTriggerTypeEnum = z.enum([
  "milestone_reached",
  "stall_detected",
  "periodic_review",
  "goal_completed",
]);
export type LearningTriggerType = z.infer<typeof LearningTriggerTypeEnum>;

// --- Learning Trigger ---

export const LearningTriggerSchema = z.object({
  type: LearningTriggerTypeEnum,
  goal_id: z.string(),
  context: z.string(),
  timestamp: z.string().datetime(),
});
export type LearningTrigger = z.infer<typeof LearningTriggerSchema>;

// --- Learned Pattern Type ---

export const LearnedPatternTypeEnum = z.enum([
  "observation_accuracy",
  "strategy_selection",
  "scope_sizing",
  "task_generation",
]);
export type LearnedPatternType = z.infer<typeof LearnedPatternTypeEnum>;

// --- Learned Pattern ---

export const LearnedPatternSchema = z.object({
  pattern_id: z.string(),
  type: LearnedPatternTypeEnum,
  description: z.string(),
  confidence: z.number().min(0).max(1),
  evidence_count: z.number().int().min(0),
  source_goal_ids: z.array(z.string()),
  applicable_domains: z.array(z.string()),
  embedding_id: z.string().nullable().default(null),
  created_at: z.string().datetime(),
  last_applied_at: z.string().datetime().nullable().default(null),
});
export type LearnedPattern = z.infer<typeof LearnedPatternSchema>;

// --- Feedback Target Step ---

export const FeedbackTargetStepEnum = z.enum([
  "observation",
  "gap",
  "strategy",
  "task",
]);
export type FeedbackTargetStep = z.infer<typeof FeedbackTargetStepEnum>;

// --- Feedback Effect ---

export const FeedbackEffectEnum = z.enum(["positive", "negative", "neutral"]);
export type FeedbackEffect = z.infer<typeof FeedbackEffectEnum>;

// --- Feedback Entry ---

export const FeedbackEntrySchema = z.object({
  feedback_id: z.string(),
  pattern_id: z.string(),
  target_step: FeedbackTargetStepEnum,
  adjustment: z.string(),
  applied_at: z.string().datetime(),
  effect_observed: FeedbackEffectEnum.nullable().default(null),
});
export type FeedbackEntry = z.infer<typeof FeedbackEntrySchema>;

// --- Learning Pipeline Config ---

export const LearningPipelineConfigSchema = z.object({
  min_confidence_threshold: z.number().min(0).max(1).default(0.6),
  /** Periodic review interval in hours. Default: 72 (3 days) */
  periodic_review_interval_hours: z.number().min(1).default(72),
  max_patterns_per_goal: z.number().int().min(1).default(50),
  cross_goal_sharing_enabled: z.boolean().default(true),
});
export type LearningPipelineConfig = z.infer<typeof LearningPipelineConfigSchema>;
