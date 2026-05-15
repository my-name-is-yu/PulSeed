/**
 * observation.ts
 * System prompt and response schema for the "observation" purpose.
 * Used by PromptGateway to evaluate current state of a goal dimension.
 */

import { z } from "zod/v3";

export const OBSERVATION_SYSTEM_PROMPT = `You are an objective evaluator of software project progress.
Evaluate the current state of the specified dimension based on the provided context.
Consider the observation history trend when available.
Return a score between 0 and 1, where 0 means no progress and 1 means fully achieved.`;

export const ObservationResponseSchema = z.object({
  score: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
  evidence: z.array(z.string()).optional(),
});

export type ObservationResponse = z.infer<typeof ObservationResponseSchema>;
