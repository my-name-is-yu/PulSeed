/**
 * knowledge-transfer.ts
 * System prompts and response schemas for knowledge transfer purposes.
 * Used by PromptGateway for KNOWLEDGE_TRANSFER_EXTRACT, KNOWLEDGE_TRANSFER_APPLY,
 * and KNOWLEDGE_TRANSFER_VALIDATE.
 */

import { z } from "zod";

// ─── KNOWLEDGE_TRANSFER_EXTRACT ───────────────────────────────────────────────

export const KNOWLEDGE_TRANSFER_META_PATTERNS_SYSTEM_PROMPT =
  "You are a cross-domain pattern analyst. Extract meta-patterns that apply across multiple goal domains. Respond with JSON only.";

export const KnowledgeTransferExtractResponseSchema = z.object({
  meta_patterns: z.array(
    z.object({
      description: z.string(),
      applicable_domains: z.array(z.string()),
      source_pattern_ids: z.array(z.string()),
    })
  ),
});

export type KnowledgeTransferExtractResponse = z.infer<typeof KnowledgeTransferExtractResponseSchema>;

// ─── KNOWLEDGE_TRANSFER_APPLY ─────────────────────────────────────────────────

export const KNOWLEDGE_TRANSFER_ADAPT_SYSTEM_PROMPT =
  "You are a knowledge transfer assistant. Adapt learned patterns from one goal context to another. Respond with JSON only.";

export const KnowledgeTransferApplyResponseSchema = z.object({
  adapted_lesson: z.string(),
  confidence: z.number().min(0).max(1),
  adaptation_notes: z.string().optional(),
});

export type KnowledgeTransferApplyResponse = z.infer<typeof KnowledgeTransferApplyResponseSchema>;

// ─── KNOWLEDGE_TRANSFER_VALIDATE ──────────────────────────────────────────────

export const KNOWLEDGE_TRANSFER_INCREMENTAL_SYSTEM_PROMPT =
  "You extract cross-domain meta-patterns from newly learned patterns. Respond with JSON only.";

export const KnowledgeTransferValidateResponseSchema = z.object({
  meta_patterns: z.array(
    z.object({
      description: z.string(),
      applicable_domains: z.array(z.string()),
      source_pattern_ids: z.array(z.string()),
    })
  ),
});

export type KnowledgeTransferValidateResponse = z.infer<typeof KnowledgeTransferValidateResponseSchema>;
