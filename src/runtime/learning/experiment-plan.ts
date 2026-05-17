import { z } from "zod/v3";
import { LearningConsumerPhaseSchema } from "./generalization-candidate.js";
import { ExperimentValueScoreSchema } from "./experiment-value-score.js";
import { LearningTrustEnvelopeSchema } from "./learning-trust.js";
import { RedactedLearningTextSchema } from "./redacted-learning-text.js";
import { MicroProbeExpectedSignalSchema } from "./micro-probe.js";
import { LearningExperimentProbeSchema } from "./experiment-probe.js";

export const LearningExperimentPlanSchema = z.object({
  id: z.string().min(1),
  goalId: z.string().min(1),
  runId: z.string().min(1).optional(),
  loopIndex: z.number().int().nonnegative().optional(),
  plannedAt: z.string().datetime(),
  registeredBeforeAction: z.literal(true),
  planKind: z.enum(["discriminating_experiment", "trial_reuse_experiment", "falsification_opportunity"]),
  hypothesisIds: z.array(z.string().min(1)).min(1),
  generalizationCandidateIds: z.array(z.string().min(1)).default([]),
  decisionEvidenceRef: z.string().min(1),
  preActionEvidenceRefs: z.array(z.string().min(1)).min(1),
  preActionEventRefs: z.array(z.string().min(1)).default([]),
  preActionRuntimeGraphRefs: z.array(z.string().min(1)).default([]),
  intendedDiscrimination: RedactedLearningTextSchema,
  valueScore: ExperimentValueScoreSchema,
  expectedByHypothesis: z.array(z.object({
    hypothesisId: z.string().min(1),
    expectedSignals: z.array(MicroProbeExpectedSignalSchema).min(1),
  }).strict()).min(1),
  plannedConsumerPhase: LearningConsumerPhaseSchema,
  probe: LearningExperimentProbeSchema,
  plannedTaskId: z.string().min(1).optional(),
  trust: LearningTrustEnvelopeSchema,
}).strict();
export type LearningExperimentPlan = z.infer<typeof LearningExperimentPlanSchema>;
