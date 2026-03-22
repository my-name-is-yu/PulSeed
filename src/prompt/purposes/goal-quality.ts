/**
 * goal-quality.ts
 * System prompts and response schemas for goal quality purposes.
 * Used by PromptGateway for GOAL_QUALITY_ASSESSMENT, GOAL_QUALITY_IMPROVEMENT, and GOAL_QUALITY_VALIDATION.
 */

import { z } from "zod";

// ─── GOAL_QUALITY_ASSESSMENT ─────────────────────────────────────────────────

export const GOAL_QUALITY_ASSESSMENT_SYSTEM_PROMPT = `Evaluate the concreteness and quality of a goal description on four dimensions.
Determine whether the goal has quantitative thresholds, observable outcomes, time bounds, and clear scope.
Return a precise boolean assessment for each dimension with a brief overall reason.`;

export const GoalQualityAssessmentResponseSchema = z.object({
  hasQuantitativeThreshold: z.boolean(),
  hasObservableOutcome: z.boolean(),
  hasTimebound: z.boolean(),
  hasClearScope: z.boolean(),
  reason: z.string(),
});

export type GoalQualityAssessmentResponse = z.infer<typeof GoalQualityAssessmentResponseSchema>;

// ─── GOAL_QUALITY_IMPROVEMENT ────────────────────────────────────────────────

export const GOAL_QUALITY_IMPROVEMENT_SYSTEM_PROMPT = `Given a goal description, suggest concrete improvements to make it more specific, measurable, and actionable.
Focus on adding quantitative thresholds, observable outcomes, time constraints, and narrowing scope.
Return an improved version of the goal description along with a list of changes made.`;

export const GoalQualityImprovementResponseSchema = z.object({
  improved_description: z.string(),
  changes: z.array(z.string()),
  rationale: z.string().optional(),
});

export type GoalQualityImprovementResponse = z.infer<typeof GoalQualityImprovementResponseSchema>;

// ─── GOAL_QUALITY_VALIDATION ─────────────────────────────────────────────────

export const GOAL_QUALITY_VALIDATION_SYSTEM_PROMPT = `Evaluate whether a decomposed set of subgoals adequately covers the parent goal.
Assess coverage, overlap between subgoals, and actionability of each subgoal.
Lower overlap is better; higher coverage and actionability are better.`;

export const GoalQualityValidationResponseSchema = z.object({
  coverage: z.number().min(0).max(1),
  overlap: z.number().min(0).max(1),
  actionability: z.number().min(0).max(1),
  reasoning: z.string(),
});

export type GoalQualityValidationResponse = z.infer<typeof GoalQualityValidationResponseSchema>;
