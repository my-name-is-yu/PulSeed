import { z } from "zod/v3";
import { MemoryCorrectionTargetStateSchema } from "../../platform/corrections/memory-correction-ledger.js";
import { LearningScopeSchema } from "./learning-scope.js";
import {
  LearningTrustEnvelopeSchema,
  learningTrustIssueForActiveStatus,
} from "./learning-trust.js";
import { RedactedLearningTextSchema } from "./redacted-learning-text.js";

export const ExperienceFrameTriggerSchema = z.enum([
  "unexpected_change",
  "repeated_failure",
  "contradiction",
  "high_uncertainty",
  "goal_signal",
  "bottleneck",
  "stale_assumption",
  "verification_result",
  "experiment_outcome",
]);
export type ExperienceFrameTrigger = z.infer<typeof ExperienceFrameTriggerSchema>;

export const ExperienceFrameSchema = z.object({
  id: z.string().min(1),
  goalId: z.string().min(1),
  runId: z.string().min(1).optional(),
  loopIndex: z.number().int().nonnegative().optional(),
  createdAt: z.string().datetime(),
  trigger: ExperienceFrameTriggerSchema,
  selectedBy: z.enum(["deterministic_bridge", "attention_admission", "compressor_review"]),
  sourceAuthority: LearningTrustEnvelopeSchema.shape.sourceAuthority,
  summary: RedactedLearningTextSchema,
  evidenceRefs: z.array(z.string().min(1)).min(1),
  cognitionEventRefs: z.array(z.string().min(1)).default([]),
  runtimeGraphRefs: z.array(z.string().min(1)).default([]),
  attentionRefs: z.array(z.string().min(1)).default([]),
  taskRefs: z.array(z.string().min(1)).default([]),
  salience: z.object({
    informationGain: z.number().min(0).max(1),
    goalRelevance: z.number().min(0).max(1),
    recurrence: z.number().min(0).max(1),
    uncertainty: z.number().min(0).max(1),
    risk: z.number().min(0).max(1),
  }).strict(),
  scope: LearningScopeSchema,
  trust: LearningTrustEnvelopeSchema,
  correctionState: MemoryCorrectionTargetStateSchema,
  status: z.enum(["candidate", "consumed", "ignored", "superseded", "quarantined"]),
}).strict().superRefine((value, ctx) => {
  const issue = learningTrustIssueForActiveStatus({
    trust: value.trust,
    status: value.status,
    activeStatuses: ["candidate", "consumed"],
  });
  if (issue) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["trust"], message: issue });
  }
});
export type ExperienceFrame = z.infer<typeof ExperienceFrameSchema>;
