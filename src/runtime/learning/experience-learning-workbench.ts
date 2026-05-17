import { createHash } from "node:crypto";
import { z } from "zod/v3";
import { CandidateTransitionSchema } from "./candidate-transition.js";
import { ExperienceFrameSchema } from "./experience-frame.js";
import { ExperimentRecordSchema } from "./experiment-record.js";
import { ExperimentValueOutcomeSchema } from "./experiment-value-outcome.js";
import { GeneralizationCandidateSchema } from "./generalization-candidate.js";
import { LearningArtifactSchema } from "./learning-artifact.js";
import { LearningHypothesisSchema } from "./hypothesis.js";
import { LearningPriorConsumptionRecordSchema } from "./learning-prior-consumption.js";
import { LearningPriorSnapshotSchema } from "./learning-prior.js";
import { LearningExperimentPlanSchema } from "./experiment-plan.js";
import { MicroProbePlanSchema, MicroProbeRecordSchema } from "./micro-probe.js";
import { TrialReuseBudgetConsumptionRecordSchema } from "./trial-reuse-budget-consumption.js";
import { TrialReuseReadinessGateSchema } from "./trial-reuse-readiness-gate.js";

export const ExperienceLearningProjectionProposalSchema = z.object({
  id: z.string().min(1),
  sourceArtifactIds: z.array(z.string().min(1)).min(1),
  ownerReviewQueueRef: z.string().min(1),
  status: z.enum(["queued", "accepted", "rejected", "invalidated"]),
  correctionLineageRefs: z.array(z.string().min(1)).default([]),
  invalidationRefs: z.array(z.string().min(1)).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();
export type ExperienceLearningProjectionProposal = z.infer<typeof ExperienceLearningProjectionProposalSchema>;

export const ExperienceLearningObjectSchema = z.discriminatedUnion("objectKind", [
  z.object({ objectKind: z.literal("frame"), value: ExperienceFrameSchema }).strict(),
  z.object({ objectKind: z.literal("hypothesis"), value: LearningHypothesisSchema }).strict(),
  z.object({ objectKind: z.literal("generalization_candidate"), value: GeneralizationCandidateSchema }).strict(),
  z.object({ objectKind: z.literal("trial_reuse_readiness_gate"), value: TrialReuseReadinessGateSchema }).strict(),
  z.object({ objectKind: z.literal("trial_reuse_budget_consumption"), value: TrialReuseBudgetConsumptionRecordSchema }).strict(),
  z.object({ objectKind: z.literal("micro_probe_plan"), value: MicroProbePlanSchema }).strict(),
  z.object({ objectKind: z.literal("micro_probe_record"), value: MicroProbeRecordSchema }).strict(),
  z.object({ objectKind: z.literal("candidate_transition"), value: CandidateTransitionSchema }).strict(),
  z.object({ objectKind: z.literal("experiment_plan"), value: LearningExperimentPlanSchema }).strict(),
  z.object({ objectKind: z.literal("experiment_record"), value: ExperimentRecordSchema }).strict(),
  z.object({ objectKind: z.literal("experiment_value_outcome"), value: ExperimentValueOutcomeSchema }).strict(),
  z.object({ objectKind: z.literal("artifact"), value: LearningArtifactSchema }).strict(),
  z.object({ objectKind: z.literal("prior_snapshot"), value: LearningPriorSnapshotSchema }).strict(),
  z.object({ objectKind: z.literal("prior_consumption"), value: LearningPriorConsumptionRecordSchema }).strict(),
  z.object({ objectKind: z.literal("projection_proposal"), value: ExperienceLearningProjectionProposalSchema }).strict(),
]);
export type ExperienceLearningObject = z.infer<typeof ExperienceLearningObjectSchema>;

export interface ExperienceLearningWorkbenchDecision {
  readonly id: string;
  readonly createdAt: string;
  readonly sourceEvidenceRefs: readonly string[];
  readonly objects: readonly ExperienceLearningObject[];
}

export function stableLearningId(prefix: string, parts: readonly unknown[]): string {
  return `${prefix}:${createHash("sha256")
    .update(JSON.stringify(sortJson(parts)))
    .digest("hex")
    .slice(0, 16)}`;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    out[key] = sortJson((value as Record<string, unknown>)[key]);
  }
  return out;
}
