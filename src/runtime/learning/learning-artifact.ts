import { z } from "zod/v3";
import { MemoryCorrectionTargetStateSchema } from "../../platform/corrections/memory-correction-ledger.js";
import { LearningScopeSchema } from "./learning-scope.js";
import {
  LearningTrustEnvelopeSchema,
  learningTrustIssueForActiveStatus,
} from "./learning-trust.js";
import { RedactedLearningTextSchema } from "./redacted-learning-text.js";
import { LearningPriorSuggestionSchema } from "./learning-prior.js";

export const LearningArtifactSchema = z.object({
  id: z.string().min(1),
  sourceGoalId: z.string().min(1),
  sourceRunId: z.string().min(1).optional(),
  kind: z.enum([
    "hypothesis",
    "constraint",
    "failure_pattern",
    "generalization_candidate",
    "goal_signal",
    "anti_pattern",
    "procedure_pattern",
    "tool_behavior",
    "user_context",
  ]),
  summary: RedactedLearningTextSchema,
  scope: LearningScopeSchema,
  evidence: z.object({
    frameIds: z.array(z.string().min(1)).default([]),
    hypothesisIds: z.array(z.string().min(1)).default([]),
    generalizationCandidateIds: z.array(z.string().min(1)).default([]),
    experimentPlanIds: z.array(z.string().min(1)).default([]),
    experimentRecordIds: z.array(z.string().min(1)).default([]),
    runtimeEvidenceRefs: z.array(z.string().min(1)).min(1),
  }).strict(),
  confidence: z.number().min(0).max(1),
  status: z.enum([
    "tentative",
    "trial_reuse_ready",
    "strengthened",
    "narrowed",
    "weakened",
    "falsified",
    "promoted",
    "retired",
    "quarantined",
  ]),
  trust: LearningTrustEnvelopeSchema,
  correctionState: MemoryCorrectionTargetStateSchema,
  policyEffect: z.array(LearningPriorSuggestionSchema).default([]),
  guardrails: z.object({
    authorityClass: z.literal("planning_hint_only"),
    cannotGrantAuthority: z.literal(true),
    requiresFreshEvidenceBeforePromotion: z.boolean(),
    contradictionRefs: z.array(z.string().min(1)).default([]),
    falsificationPlanRefs: z.array(z.string().min(1)).default([]),
  }).strict(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict().superRefine((value, ctx) => {
  const issue = learningTrustIssueForActiveStatus({
    trust: value.trust,
    status: value.status,
    activeStatuses: ["trial_reuse_ready", "strengthened", "promoted"],
  });
  if (issue) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["trust"], message: issue });
  if (value.status === "promoted" && value.evidence.experimentRecordIds.length === 0 && value.evidence.runtimeEvidenceRefs.length < 2) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["status"],
      message: "promotion requires a pre-registered experiment record or independent support evidence",
    });
  }
});
export type LearningArtifact = z.infer<typeof LearningArtifactSchema>;
