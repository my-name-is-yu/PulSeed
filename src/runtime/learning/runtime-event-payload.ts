import { z } from "zod/v3";
import { MemoryCorrectionTargetStateSchema } from "../../platform/corrections/memory-correction-ledger.js";
import { CandidateTransitionReasonCodeSchema, CandidateTransitionSchema } from "./candidate-transition.js";
import { ExperienceFrameSchema } from "./experience-frame.js";
import { ExperimentRecordSchema } from "./experiment-record.js";
import { ExperimentValueOutcomeSchema } from "./experiment-value-outcome.js";
import { ExperimentValueScoreSchema } from "./experiment-value-score.js";
import { GeneralizationCandidateSchema, GeneralizationCandidateStatusSchema } from "./generalization-candidate.js";
import { LearningArtifactSchema } from "./learning-artifact.js";
import { LearningExperimentPlanSchema } from "./experiment-plan.js";
import { LearningHypothesisSchema, LearningHypothesisStatusSchema } from "./hypothesis.js";
import { LearningPriorConsumptionRecordSchema } from "./learning-prior-consumption.js";
import { LearningPriorSnapshotSchema } from "./learning-prior.js";
import { LearningTrustEnvelopeSchema } from "./learning-trust.js";
import { MicroProbePlanSchema, MicroProbeRecordSchema, MicroProbeReadSetEntrySchema } from "./micro-probe.js";
import { TrialReuseReadinessGateSchema } from "./trial-reuse-readiness-gate.js";
import { TrialReuseBudgetConsumptionRecordSchema } from "./trial-reuse-budget-consumption.js";

export const ExperienceLearningRuntimeGraphRefsSchema = z.object({
  node_refs: z.array(z.object({ kind: z.string().min(1), ref: z.string().min(1) }).strict()).default([]),
  edge_refs: z.array(z.object({ kind: z.string().min(1), ref: z.string().min(1) }).strict()).default([]),
}).strict();

export const ExperienceLearningRuntimeEventPayloadBaseSchema = z.object({
  schema_version: z.literal("runtime-event-payload/experience-learning/v1"),
  idempotency_key: z.string().min(1),
  goal_id: z.string().min(1),
  run_id: z.string().min(1).optional(),
  loop_index: z.number().int().nonnegative().optional(),
  source_refs: z.object({
    evidence_refs: z.array(z.string().min(1)).default([]),
    event_refs: z.array(z.string().min(1)).default([]),
    runtime_graph_refs: z.array(z.string().min(1)).default([]),
  }).strict(),
  trust: LearningTrustEnvelopeSchema,
  correction_state: MemoryCorrectionTargetStateSchema,
  redaction_class: z.enum(["refs_only", "diagnostic_metadata_only"]),
  graph: ExperienceLearningRuntimeGraphRefsSchema,
}).strict();

export const ExperienceLearningRuntimeEventPayloadSchema: z.ZodTypeAny = z.discriminatedUnion("event_kind", [
  ExperienceLearningRuntimeEventPayloadBaseSchema.extend({
    event_kind: z.literal("frame_activated"),
    frame_id: z.string().min(1),
    activated_evidence_refs: z.array(z.string().min(1)).min(1),
    frame: ExperienceFrameSchema.optional(),
  }).strict(),
  ExperienceLearningRuntimeEventPayloadBaseSchema.extend({
    event_kind: z.literal("hypothesis_transitioned"),
    hypothesis_id: z.string().min(1),
    frame_ids: z.array(z.string().min(1)).min(1),
    from_status: LearningHypothesisStatusSchema.nullable(),
    to_status: LearningHypothesisStatusSchema,
    reason_code: z.string().min(1),
    competing_hypothesis_ids: z.array(z.string().min(1)).default([]),
    hypothesis: LearningHypothesisSchema.optional(),
  }).strict(),
  ExperienceLearningRuntimeEventPayloadBaseSchema.extend({
    event_kind: z.literal("generalization_transitioned"),
    generalization_id: z.string().min(1),
    body_kind: z.enum([
      "invariant_relation",
      "state_transition_relation",
      "constraint_predicate",
      "anti_pattern_inhibition",
      "strategy_bias",
      "procedure_pattern",
      "interaction_policy_bias",
    ]),
    transfer_scope_refs: z.array(z.string().min(1)).default([]),
    from_status: GeneralizationCandidateStatusSchema.nullable(),
    to_status: GeneralizationCandidateStatusSchema,
    reason_code: z.string().min(1),
    generalization: GeneralizationCandidateSchema.optional(),
  }).strict(),
  ExperienceLearningRuntimeEventPayloadBaseSchema.extend({
    event_kind: z.literal("micro_probe_recorded"),
    plan_id: z.string().min(1),
    record_id: z.string().min(1),
    read_set: z.array(MicroProbeReadSetEntrySchema).min(1),
    outcome: z.enum(["supported", "weakened", "falsified", "inconclusive", "deferred", "blocked"]),
    plan: MicroProbePlanSchema.optional(),
    record: MicroProbeRecordSchema.optional(),
  }).strict(),
  ExperienceLearningRuntimeEventPayloadBaseSchema.extend({
    event_kind: z.literal("candidate_transition_recorded"),
    transition_id: z.string().min(1),
    target_kind: z.enum(["frame", "hypothesis", "generalization_candidate", "artifact", "prior"]),
    target_id: z.string().min(1),
    from_status: z.string().min(1),
    to_status: z.string().min(1),
    reason_code: CandidateTransitionReasonCodeSchema,
    transition: CandidateTransitionSchema.optional(),
    readiness_gate: TrialReuseReadinessGateSchema.optional(),
    trial_reuse_budget_consumption: TrialReuseBudgetConsumptionRecordSchema.optional(),
  }).strict(),
  ExperienceLearningRuntimeEventPayloadBaseSchema.extend({
    event_kind: z.literal("experiment_plan_registered"),
    plan_id: z.string().min(1),
    plan_kind: LearningExperimentPlanSchema.shape.planKind,
    value_score: ExperimentValueScoreSchema,
    hypothesis_ids: z.array(z.string().min(1)).min(1),
    generalization_ids: z.array(z.string().min(1)).default([]),
    plan: LearningExperimentPlanSchema.optional(),
  }).strict(),
  ExperienceLearningRuntimeEventPayloadBaseSchema.extend({
    event_kind: z.literal("experiment_record_closed"),
    record_id: z.string().min(1),
    plan_id: z.string().min(1),
    outcome: ExperimentRecordSchema.shape.outcome,
    value_outcome_id: z.string().min(1),
    record: ExperimentRecordSchema.optional(),
    value_outcome: ExperimentValueOutcomeSchema.optional(),
  }).strict(),
  ExperienceLearningRuntimeEventPayloadBaseSchema.extend({
    event_kind: z.literal("artifact_transitioned"),
    artifact_id: z.string().min(1),
    source_candidate_ids: z.array(z.string().min(1)).default([]),
    from_status: z.enum(["tentative", "trial_reuse_ready", "strengthened", "narrowed", "weakened", "falsified", "promoted", "retired", "quarantined"]).nullable(),
    to_status: z.enum(["tentative", "trial_reuse_ready", "strengthened", "narrowed", "weakened", "falsified", "promoted", "retired", "quarantined"]),
    reason_code: z.string().min(1),
    artifact: LearningArtifactSchema.optional(),
  }).strict(),
  ExperienceLearningRuntimeEventPayloadBaseSchema.extend({
    event_kind: z.literal("prior_generated"),
    prior_id: z.string().min(1),
    artifact_ids: z.array(z.string().min(1)).min(1),
    eligible_from_iteration: z.number().int().nonnegative(),
    prior: LearningPriorSnapshotSchema.optional(),
  }).strict(),
  ExperienceLearningRuntimeEventPayloadBaseSchema.extend({
    event_kind: z.literal("prior_reserved"),
    consumption_id: z.string().min(1),
    prior_id: z.string().min(1),
    suggestion_id: z.string().min(1),
    consumer_attempt_id: z.string().min(1),
    consumer_decision_ref: z.string().min(1),
    read_set: LearningPriorConsumptionRecordSchema.shape.readSet,
    max_uses_before: z.number().int().nonnegative(),
    max_uses_after_reservation: z.number().int().nonnegative(),
    consumption: LearningPriorConsumptionRecordSchema.optional(),
  }).strict(),
  ExperienceLearningRuntimeEventPayloadBaseSchema.extend({
    event_kind: z.literal("prior_applied"),
    consumption_id: z.string().min(1),
    generated_decision_refs: z.array(z.string().min(1)).min(1),
    consumer_decision_ref: z.string().min(1),
    consumption: LearningPriorConsumptionRecordSchema.optional(),
  }).strict(),
  ExperienceLearningRuntimeEventPayloadBaseSchema.extend({
    event_kind: z.literal("prior_suppressed"),
    consumption_id: z.string().min(1),
    suppression_reason_codes: LearningPriorConsumptionRecordSchema.shape.reasonCodes,
    consumer_attempt_id: z.string().min(1),
    consumption: LearningPriorConsumptionRecordSchema.optional(),
  }).strict(),
  ExperienceLearningRuntimeEventPayloadBaseSchema.extend({
    event_kind: z.literal("prior_invalidated"),
    prior_id: z.string().min(1),
    invalidation_refs: z.array(z.string().min(1)).min(1),
    reason_code: z.string().min(1),
  }).strict(),
  ExperienceLearningRuntimeEventPayloadBaseSchema.extend({
    event_kind: z.literal("projection_enqueued"),
    projection_proposal_id: z.string().min(1),
    artifact_ids: z.array(z.string().min(1)).min(1),
    owner_review_queue_ref: z.string().min(1),
    correction_lineage_refs: z.array(z.string().min(1)).default([]),
  }).strict(),
]);
export type ExperienceLearningRuntimeEventKind =
  | "frame_activated"
  | "hypothesis_transitioned"
  | "generalization_transitioned"
  | "micro_probe_recorded"
  | "candidate_transition_recorded"
  | "experiment_plan_registered"
  | "experiment_record_closed"
  | "artifact_transitioned"
  | "prior_generated"
  | "prior_reserved"
  | "prior_applied"
  | "prior_suppressed"
  | "prior_invalidated"
  | "projection_enqueued";
type ExperienceLearningRuntimeEventPayloadBase = {
  schema_version: "runtime-event-payload/experience-learning/v1";
  event_kind: ExperienceLearningRuntimeEventKind;
  idempotency_key: string;
  goal_id: string;
  run_id?: string;
  loop_index?: number;
  source_refs: {
    evidence_refs: string[];
    event_refs: string[];
    runtime_graph_refs: string[];
  };
  trust: z.infer<typeof LearningTrustEnvelopeSchema>;
  correction_state: z.infer<typeof MemoryCorrectionTargetStateSchema>;
  redaction_class: "refs_only" | "diagnostic_metadata_only";
  graph: z.infer<typeof ExperienceLearningRuntimeGraphRefsSchema>;
};

export type ExperienceLearningRuntimeEventPayload =
  | (ExperienceLearningRuntimeEventPayloadBase & {
      event_kind: "frame_activated";
      frame_id: string;
      activated_evidence_refs: string[];
      frame?: z.infer<typeof ExperienceFrameSchema>;
    })
  | (ExperienceLearningRuntimeEventPayloadBase & {
      event_kind: "hypothesis_transitioned";
      hypothesis_id: string;
      frame_ids: string[];
      from_status: z.infer<typeof LearningHypothesisStatusSchema> | null;
      to_status: z.infer<typeof LearningHypothesisStatusSchema>;
      reason_code: string;
      competing_hypothesis_ids: string[];
      hypothesis?: z.infer<typeof LearningHypothesisSchema>;
    })
  | (ExperienceLearningRuntimeEventPayloadBase & {
      event_kind: "generalization_transitioned";
      generalization_id: string;
      body_kind: "invariant_relation" | "state_transition_relation" | "constraint_predicate" | "anti_pattern_inhibition" | "strategy_bias" | "procedure_pattern" | "interaction_policy_bias";
      transfer_scope_refs: string[];
      from_status: z.infer<typeof GeneralizationCandidateStatusSchema> | null;
      to_status: z.infer<typeof GeneralizationCandidateStatusSchema>;
      reason_code: string;
      generalization?: z.infer<typeof GeneralizationCandidateSchema>;
    })
  | (ExperienceLearningRuntimeEventPayloadBase & {
      event_kind: "micro_probe_recorded";
      plan_id: string;
      record_id: string;
      read_set: z.infer<typeof MicroProbeReadSetEntrySchema>[];
      outcome: "supported" | "weakened" | "falsified" | "inconclusive" | "deferred" | "blocked";
      plan?: z.infer<typeof MicroProbePlanSchema>;
      record?: z.infer<typeof MicroProbeRecordSchema>;
    })
  | (ExperienceLearningRuntimeEventPayloadBase & {
      event_kind: "candidate_transition_recorded";
      transition_id: string;
      target_kind: "frame" | "hypothesis" | "generalization_candidate" | "artifact" | "prior";
      target_id: string;
      from_status: string;
      to_status: string;
      reason_code: z.infer<typeof CandidateTransitionReasonCodeSchema>;
      transition?: z.infer<typeof CandidateTransitionSchema>;
      readiness_gate?: z.infer<typeof TrialReuseReadinessGateSchema>;
      trial_reuse_budget_consumption?: z.infer<typeof TrialReuseBudgetConsumptionRecordSchema>;
    })
  | (ExperienceLearningRuntimeEventPayloadBase & {
      event_kind: "experiment_plan_registered";
      plan_id: string;
      plan_kind: z.infer<typeof LearningExperimentPlanSchema>["planKind"];
      value_score: z.infer<typeof ExperimentValueScoreSchema>;
      hypothesis_ids: string[];
      generalization_ids: string[];
      plan?: z.infer<typeof LearningExperimentPlanSchema>;
    })
  | (ExperienceLearningRuntimeEventPayloadBase & {
      event_kind: "experiment_record_closed";
      record_id: string;
      plan_id: string;
      outcome: z.infer<typeof ExperimentRecordSchema>["outcome"];
      value_outcome_id: string;
      record?: z.infer<typeof ExperimentRecordSchema>;
      value_outcome?: z.infer<typeof ExperimentValueOutcomeSchema>;
    })
  | (ExperienceLearningRuntimeEventPayloadBase & {
      event_kind: "artifact_transitioned";
      artifact_id: string;
      source_candidate_ids: string[];
      from_status: z.infer<typeof LearningArtifactSchema>["status"] | null;
      to_status: z.infer<typeof LearningArtifactSchema>["status"];
      reason_code: string;
      artifact?: z.infer<typeof LearningArtifactSchema>;
    })
  | (ExperienceLearningRuntimeEventPayloadBase & {
      event_kind: "prior_generated";
      prior_id: string;
      artifact_ids: string[];
      eligible_from_iteration: number;
      prior?: z.infer<typeof LearningPriorSnapshotSchema>;
    })
  | (ExperienceLearningRuntimeEventPayloadBase & {
      event_kind: "prior_reserved";
      consumption_id: string;
      prior_id: string;
      suggestion_id: string;
      consumer_attempt_id: string;
      consumer_decision_ref: string;
      read_set: z.infer<typeof LearningPriorConsumptionRecordSchema>["readSet"];
      max_uses_before: number;
      max_uses_after_reservation: number;
      consumption?: z.infer<typeof LearningPriorConsumptionRecordSchema>;
    })
  | (ExperienceLearningRuntimeEventPayloadBase & {
      event_kind: "prior_applied";
      consumption_id: string;
      generated_decision_refs: string[];
      consumer_decision_ref: string;
      consumption?: z.infer<typeof LearningPriorConsumptionRecordSchema>;
    })
  | (ExperienceLearningRuntimeEventPayloadBase & {
      event_kind: "prior_suppressed";
      consumption_id: string;
      suppression_reason_codes: z.infer<typeof LearningPriorConsumptionRecordSchema>["reasonCodes"];
      consumer_attempt_id: string;
      consumption?: z.infer<typeof LearningPriorConsumptionRecordSchema>;
    })
  | (ExperienceLearningRuntimeEventPayloadBase & {
      event_kind: "prior_invalidated";
      prior_id: string;
      invalidation_refs: string[];
      reason_code: string;
    })
  | (ExperienceLearningRuntimeEventPayloadBase & {
      event_kind: "projection_enqueued";
      projection_proposal_id: string;
      artifact_ids: string[];
      owner_review_queue_ref: string;
      correction_lineage_refs: string[];
    });
