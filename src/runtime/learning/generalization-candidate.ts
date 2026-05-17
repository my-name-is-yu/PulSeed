import { z } from "zod/v3";
import { MemoryCorrectionTargetStateSchema } from "../../platform/corrections/memory-correction-ledger.js";
import { LearningScopeSchema } from "./learning-scope.js";
import {
  LearningTrustEnvelopeSchema,
  learningTrustIssueForActiveStatus,
} from "./learning-trust.js";
import { RedactedLearningTextSchema } from "./redacted-learning-text.js";

export const LearningConsumerPhaseSchema = z.enum([
  "knowledge_refresh",
  "replanning_options",
  "stall_detection",
  "stall_investigation",
  "task_generation",
  "next_iteration_directive",
]);
export type LearningConsumerPhase = z.infer<typeof LearningConsumerPhaseSchema>;

export const GeneralizationPredicateSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["applicability", "non_applicability", "invariant_match", "expected_delta", "failure_boundary"]),
  subjectRef: z.string().min(1),
  signalRefs: z.array(z.string().min(1)).default([]),
  relation: z.enum([
    "equals",
    "differs",
    "contains",
    "ordered_before",
    "ordered_after",
    "increases",
    "decreases",
    "present",
    "absent",
    "matches_pattern",
  ]),
  expectedValueRef: z.string().min(1).optional(),
  expectedPatternRef: z.string().min(1).optional(),
  evaluatorPort: z.enum([
    "runtime_graph_query",
    "evidence_signal_query",
    "goal_task_snapshot",
    "stall_state_snapshot",
    "attention_diagnostic_snapshot",
    "capability_readiness_snapshot",
    "companion_cognition_ref",
  ]),
  confidence: z.number().min(0).max(1),
  failureBoundary: z.enum(["falsify", "narrow_scope", "defer", "inhibit_reuse"]),
  diagnosticLabel: z.string().min(1),
}).strict();
export type GeneralizationPredicate = z.infer<typeof GeneralizationPredicateSchema>;

export const GeneralizationReuseProposalSchema = z.object({
  proposalKind: z.enum([
    "preserve_invariant",
    "seek_invariant_evidence",
    "prefer_transition",
    "test_transition",
    "inhibit_action",
    "seek_constraint_evidence",
    "avoid_pattern",
    "test_safer_alternative",
    "bias_strategy",
    "compare_strategy",
    "try_procedure_pattern",
    "practice_procedure_pattern",
    "adjust_interaction_threshold",
  ]),
  consumerPhase: LearningConsumerPhaseSchema,
  actionBiasRefs: z.array(z.string().min(1)).default([]),
  strategyBiasRefs: z.array(z.string().min(1)).default([]),
  expectedDeltaRefs: z.array(z.string().min(1)).default([]),
  inhibitionRefs: z.array(z.string().min(1)).default([]),
  experimentPlanRefs: z.array(z.string().min(1)).default([]),
}).strict();
export type GeneralizationReuseProposal = z.infer<typeof GeneralizationReuseProposalSchema>;

export const InteractionPolicyBiasBodySchema = z.object({
  targetDecision: z.enum(["hold", "digest", "ask_confirmation", "direct_suggestion", "intervene"]),
  direction: z.enum(["increase", "decrease"]),
  strength: z.number().min(0).max(1),
  maxApplications: z.number().int().positive(),
  decay: z.union([
    z.object({ kind: z.literal("uses"), value: z.number().int().positive() }).strict(),
    z.object({ kind: z.literal("duration"), value: z.string().min(1) }).strict(),
    z.object({ kind: z.literal("evidence_refresh"), value: z.string().min(1) }).strict(),
  ]),
  cooldown: z.object({ kind: z.literal("duration"), value: z.string().min(1) }).strict(),
  expiresAt: z.string().datetime(),
  applicabilityPredicates: z.array(GeneralizationPredicateSchema).min(1),
  successSignalRefs: z.array(z.string().min(1)).default([]),
  failureSignalRefs: z.array(z.string().min(1)).default([]),
  companionCognitionRefs: z.array(z.string().min(1)).default([]),
  governedMemoryDecisionRef: z.string().min(1),
  governedMemoryUseAuditRef: z.string().min(1),
  requiresAttentionAdmission: z.literal(true),
  surfaceEligible: z.literal(false),
  proactiveEligible: z.literal(false),
}).strict();
export type InteractionPolicyBiasBody = z.infer<typeof InteractionPolicyBiasBodySchema>;

export const GeneralizationBodySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("invariant_relation"),
    invariantPredicates: z.array(GeneralizationPredicateSchema).min(1),
    predictedDeltaRefs: z.array(z.string().min(1)).default([]),
    reuseProposalKind: z.enum(["preserve_invariant", "seek_invariant_evidence"]),
    reuseProposal: GeneralizationReuseProposalSchema,
  }).strict(),
  z.object({
    kind: z.literal("state_transition_relation"),
    preconditionPredicates: z.array(GeneralizationPredicateSchema).min(1),
    transitionEvidenceRefs: z.array(z.string().min(1)).min(1),
    predictedDeltaRefs: z.array(z.string().min(1)).default([]),
    reuseProposalKind: z.enum(["prefer_transition", "test_transition"]),
    reuseProposal: GeneralizationReuseProposalSchema,
  }).strict(),
  z.object({
    kind: z.literal("constraint_predicate"),
    applicabilityPredicates: z.array(GeneralizationPredicateSchema).min(1),
    blockedActionPatternRefs: z.array(z.string().min(1)).min(1),
    reuseProposalKind: z.enum(["inhibit_action", "seek_constraint_evidence"]),
    reuseProposal: GeneralizationReuseProposalSchema,
  }).strict(),
  z.object({
    kind: z.literal("anti_pattern_inhibition"),
    failurePatternRefs: z.array(z.string().min(1)).min(1),
    nonApplicabilityPredicates: z.array(GeneralizationPredicateSchema).default([]),
    reuseProposalKind: z.enum(["avoid_pattern", "test_safer_alternative"]),
    reuseProposal: GeneralizationReuseProposalSchema,
  }).strict(),
  z.object({
    kind: z.literal("strategy_bias"),
    preferStrategyRefs: z.array(z.string().min(1)).default([]),
    avoidStrategyRefs: z.array(z.string().min(1)).default([]),
    applicabilityPredicates: z.array(GeneralizationPredicateSchema).min(1),
    reuseProposalKind: z.enum(["bias_strategy", "compare_strategy"]),
    reuseProposal: GeneralizationReuseProposalSchema,
  }).strict(),
  z.object({
    kind: z.literal("procedure_pattern"),
    stepPatternRefs: z.array(z.string().min(1)).min(1),
    preconditionPredicates: z.array(GeneralizationPredicateSchema).min(1),
    verificationRecipeRefs: z.array(z.string().min(1)).default([]),
    reuseProposalKind: z.enum(["try_procedure_pattern", "practice_procedure_pattern"]),
    reuseProposal: GeneralizationReuseProposalSchema,
  }).strict(),
  z.object({
    kind: z.literal("interaction_policy_bias"),
    body: InteractionPolicyBiasBodySchema,
    reuseProposalKind: z.literal("adjust_interaction_threshold"),
    reuseProposal: GeneralizationReuseProposalSchema,
  }).strict(),
]);
export type GeneralizationBody = z.infer<typeof GeneralizationBodySchema>;

export const TransferScopeStateSchema = z.object({
  scopeRef: z.string().min(1),
  status: z.enum(["exact", "adjacent_candidate", "trial_allowed", "narrowed", "blocked"]),
  invariantMatchRefs: z.array(z.string().min(1)).default([]),
  applicabilityMatchRefs: z.array(z.string().min(1)).default([]),
  maxTrials: z.number().int().nonnegative(),
  attempts: z.number().int().nonnegative(),
  successRefs: z.array(z.string().min(1)).default([]),
  negativeTransferRefs: z.array(z.string().min(1)).default([]),
  narrowedAt: z.string().datetime().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.attempts > value.maxTrials) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["attempts"], message: "transfer-scope attempts exceed maxTrials" });
  }
});
export type TransferScopeState = z.infer<typeof TransferScopeStateSchema>;

export const GeneralizationCandidateStatusSchema = z.enum([
  "candidate",
  "micro_probe_supported",
  "trial_reuse_ready",
  "strengthened",
  "narrowed",
  "promoted",
  "falsified",
  "retired",
  "quarantined",
]);
export type GeneralizationCandidateStatus = z.infer<typeof GeneralizationCandidateStatusSchema>;

export const GeneralizationCandidateSchema = z.object({
  id: z.string().min(1),
  goalId: z.string().min(1),
  runId: z.string().min(1).optional(),
  kind: z.enum(["invariant", "state_transition_pattern", "procedure_pattern", "constraint", "anti_pattern", "strategy_bias"]),
  statement: RedactedLearningTextSchema,
  body: GeneralizationBodySchema,
  scope: LearningScopeSchema,
  status: GeneralizationCandidateStatusSchema,
  sourceHypothesisIds: z.array(z.string().min(1)).min(1),
  competingHypothesisIds: z.array(z.string().min(1)).default([]),
  supportRefs: z.array(z.string().min(1)).default([]),
  counterexampleRefs: z.array(z.string().min(1)).default([]),
  nearMissRefs: z.array(z.string().min(1)).default([]),
  applicabilitySignalRefs: z.array(z.string().min(1)).default([]),
  nonApplicabilitySignalRefs: z.array(z.string().min(1)).default([]),
  predictedOutcomeDeltaRefs: z.array(z.string().min(1)).default([]),
  invariantRefs: z.array(z.string().min(1)).default([]),
  transferScopes: z.array(TransferScopeStateSchema).min(1),
  compressionScore: z.number().min(0).max(1),
  expectedInformationGain: z.number().min(0).max(1),
  transferPotential: z.number().min(0).max(1),
  overfitRisk: z.enum(["low", "medium", "high"]),
  readinessGateIds: z.array(z.string().min(1)).default([]),
  trust: LearningTrustEnvelopeSchema,
  correctionState: MemoryCorrectionTargetStateSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict().superRefine((value, ctx) => {
  const issue = learningTrustIssueForActiveStatus({
    trust: value.trust,
    status: value.status,
    activeStatuses: ["trial_reuse_ready", "strengthened", "promoted"],
  });
  if (issue) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["trust"], message: issue });
  if (value.status === "trial_reuse_ready" && value.readinessGateIds.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["readinessGateIds"],
      message: "trial_reuse_ready requires a TrialReuseReadinessGate",
    });
  }
});
export type GeneralizationCandidate = z.infer<typeof GeneralizationCandidateSchema>;
