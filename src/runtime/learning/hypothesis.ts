import { z } from "zod/v3";
import { MemoryCorrectionTargetStateSchema } from "../../platform/corrections/memory-correction-ledger.js";
import { LearningScopeSchema } from "./learning-scope.js";
import {
  LearningTrustEnvelopeSchema,
  learningTrustIssueForActiveStatus,
} from "./learning-trust.js";
import { RedactedLearningTextSchema } from "./redacted-learning-text.js";
import { MicroProbeExpectedSignalSchema } from "./micro-probe.js";

export const LearningHypothesisKindSchema = z.enum([
  "world_model",
  "goal_model",
  "constraint",
  "failure_pattern",
  "generalization_pattern",
  "procedure_pattern",
  "user_context",
  "tool_behavior",
  "strategy_effect",
]);
export type LearningHypothesisKind = z.infer<typeof LearningHypothesisKindSchema>;

export const LearningHypothesisStatusSchema = z.enum([
  "candidate",
  "active",
  "strengthened",
  "weakened",
  "falsified",
  "retired",
  "promoted",
  "quarantined",
]);
export type LearningHypothesisStatus = z.infer<typeof LearningHypothesisStatusSchema>;

export const LearningHypothesisSchema = z.object({
  id: z.string().min(1),
  goalId: z.string().min(1),
  runId: z.string().min(1).optional(),
  statement: RedactedLearningTextSchema,
  kind: LearningHypothesisKindSchema,
  scope: LearningScopeSchema,
  status: LearningHypothesisStatusSchema,
  confidence: z.number().min(0).max(1),
  supportEvidenceRefs: z.array(z.string().min(1)).default([]),
  contradictionEvidenceRefs: z.array(z.string().min(1)).default([]),
  spawnedFromFrameIds: z.array(z.string().min(1)).min(1),
  competingHypothesisIds: z.array(z.string().min(1)).default([]),
  falsificationPlan: z.object({
    testNext: z.array(z.string().min(1)).default([]),
    expectedSignals: z.array(MicroProbeExpectedSignalSchema).min(1),
  }).strict(),
  trust: LearningTrustEnvelopeSchema,
  correctionState: MemoryCorrectionTargetStateSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict().superRefine((value, ctx) => {
  const issue = learningTrustIssueForActiveStatus({
    trust: value.trust,
    status: value.status,
    activeStatuses: ["active", "strengthened", "promoted"],
  });
  if (issue) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["trust"], message: issue });
  if (value.status === "promoted" && value.supportEvidenceRefs.length < 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["supportEvidenceRefs"], message: "promoted hypotheses require support evidence refs" });
  }
});
export type LearningHypothesis = z.infer<typeof LearningHypothesisSchema>;
