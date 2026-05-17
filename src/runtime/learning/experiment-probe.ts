import { z } from "zod/v3";
import {
  ExperimentValueCostSchema,
  ExperimentValueReversibilitySchema,
} from "./experiment-value-score.js";

export const LearningExperimentProbeSchema = z.object({
  kind: z.enum([
    "runtime_trace_check",
    "verification_probe",
    "stall_investigation_probe",
    "capability_readiness_probe",
    "task_outcome_probe",
    "attention_suppression_probe",
    "user_response_probe",
    "generalization_reuse_probe",
  ]),
  informationGain: z.number().min(0).max(1),
  estimatedCost: ExperimentValueCostSchema,
  reversibility: ExperimentValueReversibilitySchema,
  interruptionRisk: z.enum(["none", "low", "medium", "high"]),
  trustRisk: z.enum(["low", "medium", "high"]),
  capabilityEvidenceRefs: z.array(z.string().min(1)).default([]),
  requiredAuthorityRecheck: z.literal(true),
  successSignalRefs: z.array(z.string().min(1)).default([]),
  failureSignalRefs: z.array(z.string().min(1)).default([]),
}).strict();
export type LearningExperimentProbe = z.infer<typeof LearningExperimentProbeSchema>;
