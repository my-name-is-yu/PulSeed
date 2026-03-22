/**
 * learning.ts
 * System prompts and response schemas for learning pipeline purposes.
 * Used by PromptGateway for LEARNING_PATTERN_EXTRACT and LEARNING_INSIGHT_GENERATE.
 */

import { z } from "zod";

// ─── LEARNING_PATTERN_EXTRACT ─────────────────────────────────────────────────

export const LEARNING_EXTRACTION_SYSTEM_PROMPT = `You are a learning analyst for an AI agent orchestration system.
Your task is to extract (context, action, result) triplets from goal execution logs.
Each triplet captures a specific moment where a decision was made and a measurable result followed.
Return only valid JSON, no markdown or explanation outside the JSON.`;

export const LearningPatternExtractResponseSchema = z.object({
  triplets: z.array(
    z.object({
      context: z.string(),
      action: z.string(),
      result: z.string(),
    })
  ),
});

export type LearningPatternExtractResponse = z.infer<typeof LearningPatternExtractResponseSchema>;

// ─── LEARNING_INSIGHT_GENERATE ────────────────────────────────────────────────

export const LEARNING_PATTERNIZE_SYSTEM_PROMPT = `You are a pattern recognition specialist for an AI agent orchestrator.
Given a set of (context, action, result) triplets, identify recurring patterns that explain success or failure.
Focus on patterns that are specific, actionable, and have consistent results.
Return only valid JSON, no markdown or explanation outside the JSON.`;

export const LearningInsightGenerateResponseSchema = z.object({
  patterns: z.array(
    z.object({
      type: z.enum(["success_pattern", "failure_pattern"]),
      description: z.string(),
      frequency: z.number().int().min(1),
      applicability: z.string().optional(),
    })
  ),
});

export type LearningInsightGenerateResponse = z.infer<typeof LearningInsightGenerateResponseSchema>;
