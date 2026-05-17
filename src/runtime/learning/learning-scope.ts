import { z } from "zod/v3";

export const LearningScopeRefsSchema = z.object({
  goalId: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
  strategyId: z.string().min(1).optional(),
  workspaceRef: z.string().min(1).optional(),
  toolKind: z.string().min(1).optional(),
  surfaceRef: z.string().min(1).optional(),
}).strict();
export type LearningScopeRefs = z.infer<typeof LearningScopeRefsSchema>;

export const LearningScopeSchema = z.object({
  refs: LearningScopeRefsSchema,
  semantic: z.object({
    taskKind: z.string().min(1).optional(),
    environmentKind: z.string().min(1).optional(),
    userContextKind: z.string().min(1).optional(),
    classifierVersion: z.string().min(1).optional(),
    confidence: z.number().min(0).max(1).optional(),
  }).strict().optional(),
}).strict();
export type LearningScope = z.infer<typeof LearningScopeSchema>;

export const ScopeCompatibilitySchema = z.object({
  decision: z.enum(["compatible", "conflict", "unknown"]),
  reasonCode: z.enum([
    "matched_exact_refs",
    "matched_semantic_classifier",
    "missing_required_refs",
    "conflicting_refs",
    "unknown_scope",
  ]),
  diagnosticLabel: z.string().min(1).optional(),
  matchedRefs: z.array(z.string().min(1)).default([]),
  missingRefs: z.array(z.string().min(1)).default([]),
}).strict();
export type ScopeCompatibility = z.infer<typeof ScopeCompatibilitySchema>;

export function evaluateLearningScopeCompatibility(input: {
  source: LearningScope;
  consumer: LearningScope;
  requiredRefs?: readonly (keyof LearningScopeRefs)[];
}): ScopeCompatibility {
  const source = LearningScopeSchema.parse(input.source);
  const consumer = LearningScopeSchema.parse(input.consumer);
  const requiredRefs = input.requiredRefs ?? ["goalId"];
  const matchedRefs: string[] = [];
  const missingRefs: string[] = [];

  for (const key of requiredRefs) {
    const sourceValue = source.refs[key];
    const consumerValue = consumer.refs[key];
    if (!sourceValue || !consumerValue) {
      missingRefs.push(key);
      continue;
    }
    if (sourceValue !== consumerValue) {
      return {
        decision: "conflict",
        reasonCode: "conflicting_refs",
        matchedRefs,
        missingRefs,
        diagnosticLabel: key,
      };
    }
    matchedRefs.push(`${key}:${sourceValue}`);
  }

  if (missingRefs.length > 0) {
    return {
      decision: "unknown",
      reasonCode: "missing_required_refs",
      matchedRefs,
      missingRefs,
    };
  }

  return {
    decision: "compatible",
    reasonCode: "matched_exact_refs",
    matchedRefs,
    missingRefs,
  };
}
