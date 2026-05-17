import { z } from "zod/v3";
import { LearningConsumerPhaseSchema, GeneralizationBodySchema, InteractionPolicyBiasBodySchema } from "./generalization-candidate.js";
import { LearningScopeSchema, ScopeCompatibilitySchema } from "./learning-scope.js";
import { LearningTrustEnvelopeSchema } from "./learning-trust.js";
import { RedactedLearningTextSchema } from "./redacted-learning-text.js";

export const LearningPriorSuggestionKindSchema = z.enum([
  "phase_focus",
  "strategy_preference",
  "planning_inhibition",
  "hypothesis_to_test",
  "evidence_to_seek",
  "generalization_to_try",
  "trial_reuse_experiment",
  "interaction_policy_bias",
]);
export type LearningPriorSuggestionKind = z.infer<typeof LearningPriorSuggestionKindSchema>;

export const LearningPriorSourceContextSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("non_user_context"),
    requestedUseClass: z.enum([
      "goal_planning",
      "behavioral_inhibition",
      "ask_for_confirmation",
      "attention_prioritization",
      "expression_mode_selection",
    ]),
  }).strict(),
  z.object({
    kind: z.literal("governed_user_context"),
    requestedUseClass: z.enum([
      "goal_planning",
      "behavioral_inhibition",
      "ask_for_confirmation",
      "attention_prioritization",
      "expression_mode_selection",
    ]),
    governedMemoryDecisionRef: z.string().min(1),
    governedMemoryUseAuditRef: z.string().min(1),
  }).strict(),
]);
export type LearningPriorSourceContext = z.infer<typeof LearningPriorSourceContextSchema>;

export const LearningPriorSuggestionSchema = z.object({
  id: z.string().min(1),
  kind: LearningPriorSuggestionKindSchema,
  consumerPhase: LearningConsumerPhaseSchema,
  targetRef: z.object({
    kind: z.enum(["goal", "task", "strategy", "dimension", "hypothesis", "generalization_candidate", "interaction_policy", "evidence"]),
    id: z.string().min(1),
  }).strict().optional(),
  rationale: RedactedLearningTextSchema,
  sourceArtifactIds: z.array(z.string().min(1)).min(1),
  experimentPlanIds: z.array(z.string().min(1)).default([]),
  evidenceRefs: z.array(z.string().min(1)).min(1),
  strength: z.number().min(0).max(1),
  risk: z.enum(["low", "medium", "high"]),
  expiresAt: z.string().datetime(),
  maxUses: z.number().int().positive(),
  authorityClass: z.literal("planning_hint_only"),
  blockedUseClasses: z.array(z.enum([
    "side_effect_authorization",
    "stale_session_authorization",
    "proactive_trigger",
    "surface_projection",
    "tool_permission",
    "memory_write",
  ])).min(6),
  sourceContext: LearningPriorSourceContextSchema,
}).strict().superRefine((value, ctx) => {
  const required = blockedUseClassesForSuggestionKind(value.kind);
  const missing = required.filter((item) => !value.blockedUseClasses.includes(item));
  if (missing.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["blockedUseClasses"],
      message: `blockedUseClasses missing ${missing.join(", ")}`,
    });
  }
  if (value.kind === "interaction_policy_bias" && value.sourceContext.requestedUseClass !== "expression_mode_selection") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sourceContext", "requestedUseClass"],
      message: "interaction_policy_bias requires expression_mode_selection",
    });
  }
  if (value.kind === "trial_reuse_experiment" && value.risk !== "low") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["risk"], message: "trial_reuse_experiment priors must be low risk" });
  }
});
export type LearningPriorSuggestion = z.infer<typeof LearningPriorSuggestionSchema>;

export const LearningPriorSnapshotSchema = z.object({
  id: z.string().min(1),
  goalId: z.string().min(1),
  runId: z.string().min(1).optional(),
  generatedAt: z.string().datetime(),
  sourceLoopIndex: z.number().int().nonnegative(),
  eligibleFromIteration: z.number().int().nonnegative(),
  generationEventRef: z.string().min(1),
  sourceCandidateTransitionIds: z.array(z.string().min(1)).min(1),
  scope: LearningScopeSchema,
  compatibility: ScopeCompatibilitySchema,
  sourceArtifactIds: z.array(z.string().min(1)).min(1),
  suggestions: z.array(LearningPriorSuggestionSchema).min(1),
  staleOrFalsifiedArtifactIds: z.array(z.string().min(1)).default([]),
  suppressedByCorrectionIds: z.array(z.string().min(1)).default([]),
  suppressedByQuarantineIds: z.array(z.string().min(1)).default([]),
  trust: LearningTrustEnvelopeSchema,
  sourceTrustStates: z.array(z.object({
    sourceRef: z.string().min(1),
    trust: LearningTrustEnvelopeSchema,
  }).strict()).default([]),
  filterDecision: z.object({
    decision: z.enum(["activated", "suppressed"]),
    reasonCodes: z.array(z.enum([
      "eligible",
      "suppressed_by_scope",
      "suppressed_by_trust",
      "suppressed_by_correction",
      "suppressed_by_quarantine",
      "max_uses_exhausted",
      "not_yet_eligible",
    ])).min(1),
    evaluatedAt: z.string().datetime(),
  }).strict(),
  confidence: z.number().min(0).max(1),
  traceRef: z.string().min(1).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.eligibleFromIteration <= value.sourceLoopIndex) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["eligibleFromIteration"],
      message: "positive learning priors must be eligible no earlier than N+1",
    });
  }
  if (value.compatibility.decision !== "compatible" && value.filterDecision.decision === "activated") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["filterDecision"],
      message: "unknown or conflicting scope must suppress learning priors",
    });
  }
});
export type LearningPriorSnapshot = z.infer<typeof LearningPriorSnapshotSchema>;

export const InteractionPolicyBiasProjectionSchema = z.object({
  priorId: z.string().min(1),
  suggestionId: z.string().min(1),
  consumptionRecordId: z.string().min(1),
  targetDecision: InteractionPolicyBiasBodySchema.shape.targetDecision,
  direction: InteractionPolicyBiasBodySchema.shape.direction,
  boundedDelta: z.number().min(0).max(1),
  strength: z.number().min(0).max(1),
  expiresAt: z.string().datetime(),
  maxUses: z.number().int().positive(),
  cooldown: InteractionPolicyBiasBodySchema.shape.cooldown,
  requiresAttentionAdmission: z.literal(true),
  surfaceEligible: z.literal(false),
  proactiveEligible: z.literal(false),
  successSignalRefs: z.array(z.string().min(1)).default([]),
  failureSignalRefs: z.array(z.string().min(1)).default([]),
}).strict();
export type InteractionPolicyBiasProjection = z.infer<typeof InteractionPolicyBiasProjectionSchema>;

export const LearningPriorPhaseProjectionSchema = z.union([
  z.object({
    phase: z.literal("knowledge_refresh"),
    projectionKind: z.literal("knowledge_refresh_evidence_target"),
    consumptionRecordId: z.string().min(1),
    evidenceTargetRefs: z.array(z.string().min(1)).default([]),
    questionFocusRefs: z.array(z.string().min(1)).default([]),
    queryBiasRefs: z.array(z.string().min(1)).default([]),
    generalizationBodies: z.array(GeneralizationBodySchema).default([]),
    suppressedSuggestionIds: z.array(z.string().min(1)).default([]),
  }).strict(),
  z.object({
    phase: z.literal("replanning_options"),
    projectionKind: z.enum(["replanning_option_order_bias", "replanning_option_suppression"]),
    consumptionRecordId: z.string().min(1),
    optionOrderBiasRefs: z.array(z.string().min(1)).default([]),
    preferStrategyRefs: z.array(z.string().min(1)).default([]),
    suppressStrategyRefs: z.array(z.string().min(1)).default([]),
    suppressedOptionPatternRefs: z.array(z.string().min(1)).default([]),
    generalizationCandidateRefs: z.array(z.string().min(1)).default([]),
    generalizationBodies: z.array(GeneralizationBodySchema).default([]),
    suppressedSuggestionIds: z.array(z.string().min(1)).default([]),
  }).strict(),
  z.object({
    phase: z.enum(["stall_detection", "stall_investigation"]),
    projectionKind: z.literal("stall_focus_bias"),
    consumptionRecordId: z.string().min(1),
    focusEvidenceRefs: z.array(z.string().min(1)).default([]),
    blockedLoopPatternRefs: z.array(z.string().min(1)).default([]),
    experimentPlanIds: z.array(z.string().min(1)).default([]),
    generalizationBodies: z.array(GeneralizationBodySchema).default([]),
    suppressedSuggestionIds: z.array(z.string().min(1)).default([]),
  }).strict(),
  z.object({
    phase: z.literal("task_generation"),
    projectionKind: z.literal("task_generation_bias"),
    consumptionRecordId: z.string().min(1),
    preferredTargetDimension: z.string().min(1).optional(),
    taskBiasRefs: z.array(z.string().min(1)).default([]),
    avoidTaskPatternRefs: z.array(z.string().min(1)).default([]),
    requiredExperimentPlanIds: z.array(z.string().min(1)).default([]),
    generalizationBodies: z.array(GeneralizationBodySchema).default([]),
    suppressedSuggestionIds: z.array(z.string().min(1)).default([]),
  }).strict(),
  z.object({
    phase: z.literal("next_iteration_directive"),
    projectionKind: z.literal("next_directive_mode_bias"),
    consumptionRecordId: z.string().min(1),
    preferredFocusDimension: z.string().min(1).optional(),
    focusRefs: z.array(z.string().min(1)).default([]),
    inhibitionRefs: z.array(z.string().min(1)).default([]),
    directiveModeBiasRefs: z.array(z.string().min(1)).default([]),
    interactionPolicyBiases: z.array(InteractionPolicyBiasProjectionSchema).default([]),
    suppressedSuggestionIds: z.array(z.string().min(1)).default([]),
  }).strict(),
]);
export type LearningPriorPhaseProjection = z.infer<typeof LearningPriorPhaseProjectionSchema>;

export function blockedUseClassesForSuggestionKind(_kind: LearningPriorSuggestionKind): LearningPriorSuggestion["blockedUseClasses"] {
  return [
    "side_effect_authorization",
    "stale_session_authorization",
    "proactive_trigger",
    "surface_projection",
    "tool_permission",
    "memory_write",
  ];
}

export function learningPriorSuggestion(input: Omit<z.input<typeof LearningPriorSuggestionSchema>, "authorityClass" | "blockedUseClasses">): LearningPriorSuggestion {
  return LearningPriorSuggestionSchema.parse({
    ...input,
    authorityClass: "planning_hint_only",
    blockedUseClasses: blockedUseClassesForSuggestionKind(input.kind as LearningPriorSuggestionKind),
  });
}
