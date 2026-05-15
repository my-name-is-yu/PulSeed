/**
 * goal-decomposition.ts
 * System prompt and response schema for the "goal_decomposition" purpose.
 * Used by PromptGateway to decompose a goal into measurable dimensions.
 */

import { z } from "zod/v3";

export const GOAL_DECOMPOSITION_SYSTEM_PROMPT = `Decompose the given goal into measurable dimensions.
Each dimension should be independently observable and have clear success criteria.
Use concrete, quantifiable thresholds wherever possible.
Prefer fewer, high-signal dimensions over many redundant ones.`;

export const GoalDecompositionResponseSchema = z.object({
  dimensions: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      threshold_type: z.enum(["min", "max", "range", "present", "match"]),
      threshold_value: z.number().or(z.string()),
      observation_hint: z.string().optional(),
    })
  ),
});

export type GoalDecompositionResponse = z.infer<typeof GoalDecompositionResponseSchema>;
