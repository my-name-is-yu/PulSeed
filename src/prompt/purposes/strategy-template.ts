/**
 * strategy-template.ts
 * System prompts and response schemas for strategy template purposes.
 * Used by PromptGateway for STRATEGY_TEMPLATE_MATCH and STRATEGY_TEMPLATE_ADAPT.
 */

import { z } from "zod";

// ─── STRATEGY_TEMPLATE_MATCH ──────────────────────────────────────────────────

export const STRATEGY_TEMPLATE_MATCH_SYSTEM_PROMPT = `Analyze a completed strategy and extract a generalized template.
Identify the hypothesis pattern, domain tags, and applicable dimensions that can be reused across similar goals.
Focus on what made the strategy generalizable, not the specifics of the current goal.
Return ONLY a JSON object with no other text.`;

export const StrategyTemplateMatchResponseSchema = z.object({
  hypothesis_pattern: z.string(),
  domain_tags: z.array(z.string()),
  applicable_dimensions: z.array(z.string()),
});

export type StrategyTemplateMatchResponse = z.infer<typeof StrategyTemplateMatchResponseSchema>;

// ─── STRATEGY_TEMPLATE_ADAPT ─────────────────────────────────────────────────

export const STRATEGY_TEMPLATE_ADAPT_SYSTEM_PROMPT = `Adapt an existing strategy template to the context of a new goal.
Produce a concrete, tailored hypothesis and specify which dimensions are targeted and the expected effects.
Ensure the adapted strategy is specific enough to guide task generation.
Return ONLY a JSON object with no other text.`;

export const StrategyTemplateAdaptResponseSchema = z.object({
  hypothesis: z.string(),
  target_dimensions: z.array(z.string()),
  expected_effect: z.array(
    z.object({
      dimension: z.string(),
      direction: z.enum(["increase", "decrease"]),
      magnitude: z.enum(["small", "medium", "large"]),
    })
  ),
});

export type StrategyTemplateAdaptResponse = z.infer<typeof StrategyTemplateAdaptResponseSchema>;
