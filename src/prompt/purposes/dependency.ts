/**
 * dependency.ts
 * System prompt and response schema for the "dependency_analysis" purpose.
 * Used by PromptGateway to auto-detect dependency relationships between goals.
 */

import { z } from "zod";

// ─── DEPENDENCY_ANALYSIS ─────────────────────────────────────────────────────

export const DEPENDENCY_ANALYSIS_SYSTEM_PROMPT = `Analyze dependency relationships between goals.
Identify prerequisite, resource_conflict, synergy, and conflict relationships.
For each relationship found, explain the reasoning and your confidence.
Return an empty array if no dependencies exist.`;

export const DependencyAnalysisResponseSchema = z.array(
  z.object({
    from_goal_id: z.string(),
    to_goal_id: z.string(),
    type: z.enum(["prerequisite", "resource_conflict", "synergy", "conflict"]),
    condition: z.string().nullable().optional(),
    affected_dimensions: z.array(z.string()).optional(),
    reasoning: z.string().nullable().optional(),
    detection_confidence: z.number().min(0).max(1).optional(),
  })
);

export type DependencyAnalysisResponse = z.infer<typeof DependencyAnalysisResponseSchema>;
