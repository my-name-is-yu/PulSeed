/**
 * verification.ts
 * System prompt and response schema for the "verification" purpose.
 * Used by PromptGateway to review task results against success criteria.
 */

import { z } from "zod/v3";

export const VERIFICATION_SYSTEM_PROMPT = `Review task results objectively against success criteria.
Ignore the executor's self-assessment. Focus on evidence-based verification.
Check whether the observable outcome meets the stated success criteria.
Be strict: partial completion is not a pass unless the criteria explicitly allow it.`;

export const VerificationResponseSchema = z.object({
  passed: z.boolean(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
  evidence: z.array(z.string()).optional(),
});

export type VerificationResponse = z.infer<typeof VerificationResponseSchema>;
