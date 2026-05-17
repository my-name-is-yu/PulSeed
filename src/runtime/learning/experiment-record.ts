import { z } from "zod/v3";
import { LearningTrustEnvelopeSchema } from "./learning-trust.js";

export const ExperimentRecordSchema = z.object({
  id: z.string().min(1),
  planId: z.string().min(1),
  goalId: z.string().min(1),
  runId: z.string().min(1).optional(),
  loopIndex: z.number().int().nonnegative().optional(),
  taskId: z.string().min(1).optional(),
  actionRefs: z.array(z.string().min(1)).default([]),
  executedAt: z.string().datetime(),
  outcome: z.enum(["supported", "weakened", "falsified", "inconclusive", "blocked"]),
  outcomeEvidenceRefs: z.array(z.string().min(1)).min(1),
  outcomeEventRefs: z.array(z.string().min(1)).default([]),
  outcomeRuntimeGraphRefs: z.array(z.string().min(1)).default([]),
  eliminatedHypothesisIds: z.array(z.string().min(1)).default([]),
  testedGeneralizationCandidateIds: z.array(z.string().min(1)).default([]),
  narrowedGeneralizationCandidateIds: z.array(z.string().min(1)).default([]),
  negativeTransferRefs: z.array(z.string().min(1)).default([]),
  followUpFrameIds: z.array(z.string().min(1)).default([]),
  trust: LearningTrustEnvelopeSchema,
}).strict();
export type ExperimentRecord = z.infer<typeof ExperimentRecordSchema>;
