import { z } from "zod/v3";

export const ExperimentValueCostSchema = z.enum(["low", "medium", "high"]);
export const ExperimentValueRiskSchema = z.enum(["low", "medium", "high"]);
export const ExperimentValueReversibilitySchema = z.enum(["reversible", "append_only", "manual_recovery", "irreversible"]);
export const ExperimentValueTimeToSignalSchema = z.enum(["same_iteration", "next_iteration", "multi_iteration"]);

export const ExperimentValueScoreSchema = z.object({
  candidateId: z.string().min(1),
  expectedInformationGain: z.number().min(0).max(1),
  transferPotential: z.number().min(0).max(1),
  bottleneckRelief: z.number().min(0).max(1),
  estimatedCost: ExperimentValueCostSchema,
  reversibility: ExperimentValueReversibilitySchema,
  risk: ExperimentValueRiskSchema,
  timeToSignal: ExperimentValueTimeToSignalSchema,
  confidenceCalibration: z.number().min(0).max(1),
  rank: z.number().int().positive(),
  rejectedReasonCode: z.enum([
    "lower_information_gain",
    "higher_risk",
    "insufficient_independent_refs",
    "forbidden_authority_needed",
    "scope_unknown",
    "budget_exhausted",
  ]).optional(),
}).strict();
export type ExperimentValueScore = z.infer<typeof ExperimentValueScoreSchema>;
