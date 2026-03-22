/**
 * memory-distill.ts
 * System prompts and response schemas for memory distillation purposes.
 * Used by PromptGateway for MEMORY_DISTILL_SUMMARIZE and MEMORY_DISTILL_PRIORITIZE.
 */

import { z } from "zod";

// ─── MEMORY_DISTILL_SUMMARIZE ─────────────────────────────────────────────────

export const MEMORY_DISTILL_EXTRACT_PATTERNS_SYSTEM_PROMPT =
  "You are a pattern extraction engine. Analyze experience logs and identify recurring patterns, successes, and failures. Respond with JSON only.";

export const MemoryDistillSummarizeResponseSchema = z.object({
  patterns: z.array(
    z.object({
      type: z.enum(["success_pattern", "failure_pattern", "neutral_observation"]),
      description: z.string(),
      frequency: z.number().int().min(1),
      confidence: z.number().min(0).max(1).optional(),
    })
  ),
});

export type MemoryDistillSummarizeResponse = z.infer<typeof MemoryDistillSummarizeResponseSchema>;

// ─── MEMORY_DISTILL_PRIORITIZE ────────────────────────────────────────────────

export const MEMORY_DISTILL_LESSONS_SYSTEM_PROMPT =
  "You are a lesson distillation engine. Convert experience patterns into structured, actionable lessons. Respond with JSON only.";

export const MemoryDistillPrioritizeResponseSchema = z.object({
  lessons: z.array(
    z.object({
      type: z.enum(["success_pattern", "failure_pattern"]),
      lesson: z.string(),
      importance: z.enum(["HIGH", "MEDIUM", "LOW"]),
      applicability: z.string().optional(),
    })
  ),
});

export type MemoryDistillPrioritizeResponse = z.infer<typeof MemoryDistillPrioritizeResponseSchema>;
