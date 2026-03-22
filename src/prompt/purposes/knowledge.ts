/**
 * knowledge.ts
 * System prompts and response schemas for knowledge management purposes.
 * Used by PromptGateway for KNOWLEDGE_EXTRACTION, KNOWLEDGE_CONSOLIDATION,
 * KNOWLEDGE_QUERY, KNOWLEDGE_DECISION, and KNOWLEDGE_REVALIDATION.
 */

import { z } from "zod";

// ─── Legacy exports (kept for backward compatibility) ─────────────────────────

export const KNOWLEDGE_GAP_DETECTION_SYSTEM_PROMPT =
  "You are a knowledge gap detector. Analyze contexts to identify missing domain knowledge. Respond with JSON only.";

export const KNOWLEDGE_ACQUISITION_SYSTEM_PROMPT =
  "You generate knowledge acquisition tasks. Produce 3-5 specific research questions. Respond with JSON only.";

export const KNOWLEDGE_CONTRADICTION_SYSTEM_PROMPT =
  "You are a knowledge consistency checker. Detect factual contradictions between knowledge entries. Respond with JSON only.";

export const KNOWLEDGE_ENRICHMENT_SYSTEM_PROMPT =
  "You extract structured lessons from decision records. Respond with JSON only.";

export const KNOWLEDGE_STABILITY_SYSTEM_PROMPT =
  "You classify knowledge domain stability. Respond with JSON only.";

// ─── KNOWLEDGE_EXTRACTION ─────────────────────────────────────────────────────

export const KNOWLEDGE_EXTRACTION_SYSTEM_PROMPT = `You are a knowledge gap detector. Analyze contexts to identify missing domain knowledge.
Look for gaps that are blocking goal progress. Be specific about what knowledge is needed and why.
Respond with JSON only.`;

export const KnowledgeExtractionResponseSchema = z.object({
  has_gap: z.boolean(),
  gap_description: z.string().nullable().optional(),
  missing_knowledge: z.string().nullable().optional(),
  source_step: z.enum(["gap_recognition", "strategy_selection", "task_generation"]).nullable().optional(),
  related_dimension: z.string().nullable().optional(),
});

export type KnowledgeExtractionResponse = z.infer<typeof KnowledgeExtractionResponseSchema>;

// ─── KNOWLEDGE_CONSOLIDATION ──────────────────────────────────────────────────

export const KNOWLEDGE_CONSOLIDATION_SYSTEM_PROMPT = `You generate knowledge acquisition tasks. Produce 3-5 specific research questions or tasks needed to close a knowledge gap.
Focus on questions that can be answered through concrete investigation.
Respond with JSON only.`;

export const KnowledgeConsolidationResponseSchema = z.object({
  knowledge_questions: z.array(z.string()),
  in_scope: z.array(z.string()),
  out_of_scope: z.array(z.string()),
});

export type KnowledgeConsolidationResponse = z.infer<typeof KnowledgeConsolidationResponseSchema>;

// ─── KNOWLEDGE_QUERY ──────────────────────────────────────────────────────────

export const KNOWLEDGE_QUERY_SYSTEM_PROMPT = `You are a knowledge retrieval assistant. Given a query and available knowledge entries, determine which entries are most relevant.
Rank relevance clearly and explain why each entry is or is not useful for the current context.
Respond with JSON only.`;

export const KnowledgeQueryResponseSchema = z.object({
  relevant_entries: z.array(z.string()),
  relevance_reasoning: z.string(),
});

export type KnowledgeQueryResponse = z.infer<typeof KnowledgeQueryResponseSchema>;

// ─── KNOWLEDGE_DECISION ───────────────────────────────────────────────────────

export const KNOWLEDGE_DECISION_SYSTEM_PROMPT = `You are a knowledge consistency checker. Detect factual contradictions between knowledge entries.
If a contradiction exists, identify the conflicting entries and suggest a resolution.
Respond with JSON only.`;

export const KnowledgeDecisionResponseSchema = z.object({
  has_contradiction: z.boolean(),
  conflicting_entry_id: z.string().nullable().optional(),
  resolution: z.string().nullable().optional(),
});

export type KnowledgeDecisionResponse = z.infer<typeof KnowledgeDecisionResponseSchema>;

// ─── KNOWLEDGE_REVALIDATION ───────────────────────────────────────────────────

export const KNOWLEDGE_REVALIDATION_SYSTEM_PROMPT = `You classify knowledge domain stability.
Determine whether a knowledge entry is stable (rarely changes), moderate (changes occasionally), or volatile (changes frequently).
Respond with JSON only.`;

export const KnowledgeRevalidationResponseSchema = z.object({
  stability: z.enum(["stable", "moderate", "volatile"]),
  rationale: z.string(),
});

export type KnowledgeRevalidationResponse = z.infer<typeof KnowledgeRevalidationResponseSchema>;
