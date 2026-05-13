import { z } from "zod";
import {
  CharacterConfigSchema,
  type CharacterConfig,
} from "../../platform/traits/types/character.js";
import {
  getCharacterFeasibilityThresholdHint,
  getCharacterStallThresholdMultiplierHint,
} from "../../platform/traits/character-policy.js";
import {
  CognitionContextRefSchema,
  CognitionPolicyRefSchema,
  type CognitionContextRef,
  type CognitionPolicyRef,
} from "./companion-decision-contract.js";

export {
  getCharacterFeasibilityThresholdHint,
  getCharacterStallThresholdMultiplierHint,
} from "../../platform/traits/character-policy.js";

export const CompanionCharacterPolicySourceKindSchema = z.enum([
  "character_config",
  "default_character_config",
  "runtime_setup",
  "surface_policy",
  "decision_policy",
]);
export type CompanionCharacterPolicySourceKind = z.infer<typeof CompanionCharacterPolicySourceKindSchema>;

export const CompanionCharacterPolicySourceRefSchema = z.object({
  kind: CompanionCharacterPolicySourceKindSchema,
  ref: z.string().min(1),
  role: z.enum(["configuration", "decision", "surface", "audit"]).default("configuration"),
}).strict();
export type CompanionCharacterPolicySourceRef = z.infer<typeof CompanionCharacterPolicySourceRefSchema>;

export const CompanionCharacterDirectnessSchema = z.enum([
  "considerate",
  "balanced",
  "direct",
]);
export type CompanionCharacterDirectness = z.infer<typeof CompanionCharacterDirectnessSchema>;

export const CompanionCharacterResponseShapeSchema = z.enum([
  "offer_alternatives",
  "answer_with_context",
  "lead_with_facts",
]);
export type CompanionCharacterResponseShape = z.infer<typeof CompanionCharacterResponseShapeSchema>;

export const CompanionCharacterInitiativePostureSchema = z.enum([
  "events_only",
  "low",
  "balanced",
  "high",
  "high_detail",
]);
export type CompanionCharacterInitiativePosture = z.infer<typeof CompanionCharacterInitiativePostureSchema>;

export const CompanionCharacterCautionStanceSchema = z.enum([
  "very_conservative",
  "conservative",
  "balanced",
  "ambitious",
  "very_ambitious",
]);
export type CompanionCharacterCautionStance = z.infer<typeof CompanionCharacterCautionStanceSchema>;

export const CompanionCharacterStallResponseSchema = z.enum([
  "pivot_fast",
  "flexible",
  "balanced",
  "persistent",
  "very_persistent",
]);
export type CompanionCharacterStallResponse = z.infer<typeof CompanionCharacterStallResponseSchema>;

export const CompanionCharacterExecutionSummaryVerbositySchema = z.enum([
  "brief",
  "normal",
  "detailed",
]);
export type CompanionCharacterExecutionSummaryVerbosity = z.infer<typeof CompanionCharacterExecutionSummaryVerbositySchema>;

export const CompanionCharacterEscalationSuggestionPolicySchema = z.enum([
  "include_for_all_escalations",
  "include_for_non_stall_escalations",
  "suppress_default_suggestions",
]);
export type CompanionCharacterEscalationSuggestionPolicy = z.infer<typeof CompanionCharacterEscalationSuggestionPolicySchema>;

export const CompanionCharacterDialogueStrategySchema = z.object({
  directness: CompanionCharacterDirectnessSchema,
  default_response_shape: CompanionCharacterResponseShapeSchema,
  initiative_posture: CompanionCharacterInitiativePostureSchema,
  clarification_bias: z.enum(["ask_early", "balanced", "act_when_bound"]),
}).strict();
export type CompanionCharacterDialogueStrategy = z.infer<typeof CompanionCharacterDialogueStrategySchema>;

export const CompanionCharacterDecisionPolicySchema = z.object({
  caution_stance: CompanionCharacterCautionStanceSchema,
  stall_response: CompanionCharacterStallResponseSchema,
  initiative_posture: CompanionCharacterInitiativePostureSchema,
  feasibility_threshold_hint: z.number(),
  stall_threshold_multiplier_hint: z.number(),
  character_can_relax_safety_boundary: z.literal(false).default(false),
  character_can_relax_approval_boundary: z.literal(false).default(false),
  character_can_grant_autonomy: z.literal(false).default(false),
}).strict();
export type CompanionCharacterDecisionPolicy = z.infer<typeof CompanionCharacterDecisionPolicySchema>;

export const CompanionCharacterSurfacePolicySchema = z.object({
  normal_companion_user_visible_reason: z.enum(["none", "brief"]),
  execution_summary_verbosity: CompanionCharacterExecutionSummaryVerbositySchema,
  escalation_suggestion_policy: CompanionCharacterEscalationSuggestionPolicySchema,
  normal_companion_raw_policy_state_visible: z.literal(false).default(false),
  normal_companion_capability_catalog_visible: z.literal(false).default(false),
  normal_companion_debug_state_visible: z.literal(false).default(false),
  ordinary_surface_discloses_character_knobs: z.literal(false).default(false),
}).strict();
export type CompanionCharacterSurfacePolicy = z.infer<typeof CompanionCharacterSurfacePolicySchema>;

export const CompanionCharacterPolicyProjectionSchema = z.object({
  schema_version: z.literal("companion-character-policy-projection/v1"),
  projection_id: z.string().min(1),
  evaluated_at: z.string().datetime(),
  character_config: CharacterConfigSchema,
  source_refs: z.array(CompanionCharacterPolicySourceRefSchema).default([]),
  dialogue_strategy: CompanionCharacterDialogueStrategySchema,
  decision_policy: CompanionCharacterDecisionPolicySchema,
  surface_policy: CompanionCharacterSurfacePolicySchema,
  metadata: z.object({
    prompt_dump: z.literal(false).default(false),
    model_text_is_authority: z.literal(false).default(false),
    policy_hint_only: z.literal(true).default(true),
  }).strict().default({}),
}).strict();
export type CompanionCharacterPolicyProjection = z.infer<typeof CompanionCharacterPolicyProjectionSchema>;

export interface CreateCompanionCharacterPolicyProjectionInput {
  characterConfig: CharacterConfig;
  projectionId?: string;
  evaluatedAt?: string;
  sourceRefs?: CompanionCharacterPolicySourceRef[];
}

export function createCompanionCharacterPolicyProjection(
  input: CreateCompanionCharacterPolicyProjectionInput
): CompanionCharacterPolicyProjection {
  const characterConfig = CharacterConfigSchema.parse(input.characterConfig);
  const evaluatedAt = input.evaluatedAt ?? new Date().toISOString();

  return CompanionCharacterPolicyProjectionSchema.parse({
    schema_version: "companion-character-policy-projection/v1",
    projection_id: input.projectionId ?? `companion-character-policy:${evaluatedAt}`,
    evaluated_at: evaluatedAt,
    character_config: characterConfig,
    source_refs: input.sourceRefs ?? [{
      kind: "character_config",
      ref: "character-config.json",
      role: "configuration",
    }],
    dialogue_strategy: {
      directness: directnessFor(characterConfig.communication_directness),
      default_response_shape: responseShapeFor(characterConfig.communication_directness),
      initiative_posture: initiativePostureFor(characterConfig.proactivity_level),
      clarification_bias: clarificationBiasFor(characterConfig.communication_directness),
    },
    decision_policy: {
      caution_stance: cautionStanceFor(characterConfig.caution_level),
      stall_response: stallResponseFor(characterConfig.stall_flexibility),
      initiative_posture: initiativePostureFor(characterConfig.proactivity_level),
      feasibility_threshold_hint: getCharacterFeasibilityThresholdHint(characterConfig),
      stall_threshold_multiplier_hint: getCharacterStallThresholdMultiplierHint(characterConfig),
      character_can_relax_safety_boundary: false,
      character_can_relax_approval_boundary: false,
      character_can_grant_autonomy: false,
    },
    surface_policy: {
      normal_companion_user_visible_reason: characterConfig.proactivity_level === 1 ? "none" : "brief",
      execution_summary_verbosity: executionSummaryVerbosityFor(characterConfig.proactivity_level),
      escalation_suggestion_policy: escalationSuggestionPolicyFor(characterConfig.communication_directness),
      normal_companion_raw_policy_state_visible: false,
      normal_companion_capability_catalog_visible: false,
      normal_companion_debug_state_visible: false,
      ordinary_surface_discloses_character_knobs: false,
    },
    metadata: {
      prompt_dump: false,
      model_text_is_authority: false,
      policy_hint_only: true,
    },
  });
}

export function createCompanionCharacterPolicyCognitionRef(
  projection: CompanionCharacterPolicyProjection,
  options: { freshness?: CognitionContextRef["freshness"] } = {}
): CognitionContextRef {
  const parsed = CompanionCharacterPolicyProjectionSchema.parse(projection);
  return CognitionContextRefSchema.parse({
    kind: "character_config_policy",
    ref: parsed.projection_id,
    role: "policy",
    freshness: options.freshness ?? "current",
    reason: "typed character policy projection",
  });
}

export function createCompanionCharacterPolicyCognitionPolicyRef(
  projection: CompanionCharacterPolicyProjection
): CognitionPolicyRef {
  const parsed = CompanionCharacterPolicyProjectionSchema.parse(projection);
  return CognitionPolicyRefSchema.parse({
    kind: "character_config_policy",
    ref: parsed.projection_id,
    result: "policy_hint_only",
    epoch: parsed.evaluated_at,
  });
}

function directnessFor(level: number): CompanionCharacterDirectness {
  if (level <= 2) return "considerate";
  if (level === 3) return "balanced";
  return "direct";
}

function responseShapeFor(level: number): CompanionCharacterResponseShape {
  if (level <= 2) return "offer_alternatives";
  if (level === 3) return "answer_with_context";
  return "lead_with_facts";
}

function clarificationBiasFor(level: number): CompanionCharacterDialogueStrategy["clarification_bias"] {
  if (level <= 2) return "ask_early";
  if (level === 3) return "balanced";
  return "act_when_bound";
}

function initiativePostureFor(level: number): CompanionCharacterInitiativePosture {
  if (level === 1) return "events_only";
  if (level === 2) return "low";
  if (level === 3) return "balanced";
  if (level === 4) return "high";
  return "high_detail";
}

function cautionStanceFor(level: number): CompanionCharacterCautionStance {
  if (level === 1) return "very_conservative";
  if (level === 2) return "conservative";
  if (level === 3) return "balanced";
  if (level === 4) return "ambitious";
  return "very_ambitious";
}

function stallResponseFor(level: number): CompanionCharacterStallResponse {
  if (level === 1) return "pivot_fast";
  if (level === 2) return "flexible";
  if (level === 3) return "balanced";
  if (level === 4) return "persistent";
  return "very_persistent";
}

function executionSummaryVerbosityFor(level: number): CompanionCharacterExecutionSummaryVerbosity {
  if (level === 1) return "brief";
  if (level <= 3) return "normal";
  return "detailed";
}

function escalationSuggestionPolicyFor(level: number): CompanionCharacterEscalationSuggestionPolicy {
  if (level <= 2) return "include_for_all_escalations";
  if (level === 3) return "include_for_non_stall_escalations";
  return "suppress_default_suggestions";
}
