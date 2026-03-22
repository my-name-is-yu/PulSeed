/**
 * checkpoint.ts
 * System prompt and response schema for the checkpoint analysis purpose.
 * Used by PromptGateway for CHECKPOINT_ANALYZE.
 */

import { z } from "zod";

// ─── CHECKPOINT_ANALYZE ───────────────────────────────────────────────────────

export const CHECKPOINT_ADAPT_SYSTEM_PROMPT =
  "You are a context adapter for an AI agent orchestration system. " +
  "Help transfer session context from one agent to another, summarizing and adapting the information " +
  "so the new agent can seamlessly continue the work. " +
  "Respond with the adapted context text only — no JSON wrapping needed.";

export const CheckpointAnalyzeResponseSchema = z.object({
  summary: z.string(),
  next_steps: z.array(z.string()).optional(),
  key_context: z.string().optional(),
});

export type CheckpointAnalyzeResponse = z.infer<typeof CheckpointAnalyzeResponseSchema>;
