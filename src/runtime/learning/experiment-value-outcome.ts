import { z } from "zod/v3";
import {
  ExperimentValueCostSchema,
  ExperimentValueRiskSchema,
  ExperimentValueTimeToSignalSchema,
} from "./experiment-value-score.js";

export const ExperimentValueOutcomeSchema = z.object({
  id: z.string().min(1),
  planId: z.string().min(1),
  recordId: z.string().min(1),
  realizedInformationGain: z.number().min(0).max(1),
  eliminatedHypothesisIds: z.array(z.string().min(1)).default([]),
  eliminatedHypothesisCount: z.number().int().nonnegative(),
  actualCost: ExperimentValueCostSchema,
  actualRisk: ExperimentValueRiskSchema,
  actualTimeToSignal: ExperimentValueTimeToSignalSchema,
  transferOutcome: z.enum(["not_transfer", "exact_success", "adjacent_success", "negative_transfer", "inconclusive"]),
  calibrationError: z.number().min(0),
  outcomeEvidenceRefs: z.array(z.string().min(1)).min(1),
}).strict().superRefine((value, ctx) => {
  if (value.eliminatedHypothesisCount !== value.eliminatedHypothesisIds.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["eliminatedHypothesisCount"],
      message: "eliminatedHypothesisCount must match eliminatedHypothesisIds",
    });
  }
});
export type ExperimentValueOutcome = z.infer<typeof ExperimentValueOutcomeSchema>;
