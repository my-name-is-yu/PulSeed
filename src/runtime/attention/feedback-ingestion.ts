import { z } from "zod";
import {
  AutonomyCacheInvalidationEvidenceSchema,
  AutonomyFeedbackSignalSchema,
  type AutonomyCacheInvalidationEvidence,
  type AutonomyFeedbackSignal,
} from "../control/autonomy-governor.js";
import {
  AgentAgendaItemKindSchema,
  CompanionAutonomyRefSchema,
  OutcomeClassSchema,
  UrgeOriginSchema,
  type CompanionAutonomyRef,
} from "../types/companion-autonomy.js";
import {
  ProactiveInterventionOutcomeSchema,
  ProactiveOverreachIndicatorSchema,
  type ProactiveInterventionOutcome,
} from "../store/proactive-intervention-store.js";
import {
  type AttentionFeedbackEvent,
} from "./attention-feedback.js";
import { createAttentionInput, type AttentionInput } from "./attention-input.js";
import { ref, refKey, stableId, uniqueRefs } from "./attention-refs.js";

export const FeedbackIngestionSourceSchema = z.enum([
  "cli",
  "chat",
  "tui",
  "gateway",
  "telegram",
  "runtime",
]);
export type FeedbackIngestionSource = z.infer<typeof FeedbackIngestionSourceSchema>;

export const FeedbackIngestionKindSchema = z.enum([
  "proactive_feedback",
  "surface_dismissal",
  "surface_correction",
  "approval_denied",
  "overreach",
  "runtime_outcome",
  "permission_revoked",
]);
export type FeedbackIngestionKind = z.infer<typeof FeedbackIngestionKindSchema>;

export const FeedbackIngestionOutcomeSchema = z.enum([
  "accepted",
  "ignored",
  "dismissed",
  "corrected",
  "overreach",
  "approval_denied",
  "runtime_success",
  "runtime_failure",
  "permission_revoked",
]);
export type FeedbackIngestionOutcome = z.infer<typeof FeedbackIngestionOutcomeSchema>;

export const FeedbackTargetKindSchema = z.enum([
  "intervention",
  "outcome_decision",
  "expression_decision",
  "agenda_item",
  "permission_grant",
  "runtime_operation",
  "surface",
  "conversation",
  "approval",
]);
export type FeedbackTargetKind = z.infer<typeof FeedbackTargetKindSchema>;

export const FeedbackTargetSchema = z.object({
  kind: FeedbackTargetKindSchema,
  id: z.string().min(1),
}).strict();
export type FeedbackTarget = z.infer<typeof FeedbackTargetSchema>;

export const FeedbackIngestionInputSchema = z.object({
  feedback_id: z.string().min(1).optional(),
  source: FeedbackIngestionSourceSchema,
  feedback_kind: FeedbackIngestionKindSchema,
  outcome: FeedbackIngestionOutcomeSchema,
  target: FeedbackTargetSchema,
  recorded_at: z.string().datetime().optional(),
  reason: z.string().min(1).optional(),
  overreach_indicators: z.array(ProactiveOverreachIndicatorSchema).default([]),
  follow_through_success: z.boolean().nullable().default(null),
  agenda_kind: AgentAgendaItemKindSchema.optional(),
  urge_origin: UrgeOriginSchema.optional(),
  route: OutcomeClassSchema.optional(),
  surface_ref: CompanionAutonomyRefSchema.optional(),
  permission_ref: CompanionAutonomyRefSchema.optional(),
  proactive_event_ref: z.string().min(1).optional(),
  runtime_ref: z.string().min(1).optional(),
  approval_ref: z.string().min(1).optional(),
  correction_ref: z.string().min(1).optional(),
  profile_proposal_refs: z.array(z.string().min(1)).default([]),
  metadata: z.record(z.unknown()).default({}),
}).strict();
export type FeedbackIngestionInput = z.input<typeof FeedbackIngestionInputSchema>;
type ParsedFeedbackIngestionInput = z.infer<typeof FeedbackIngestionInputSchema>;

export const FeedbackIngestionRecordSchema = z.object({
  schema_version: z.literal("feedback-ingestion-record-v1"),
  feedback_id: z.string().min(1),
  source: FeedbackIngestionSourceSchema,
  feedback_kind: FeedbackIngestionKindSchema,
  outcome: FeedbackIngestionOutcomeSchema,
  recorded_at: z.string().datetime(),
  target: FeedbackTargetSchema,
  reason: z.string().min(1).optional(),
  overreach_indicators: z.array(ProactiveOverreachIndicatorSchema).default([]),
  follow_through_success: z.boolean().nullable().default(null),
  profile_proposal_refs: z.array(z.string().min(1)).default([]),
  source_refs: z.object({
    proactive_event_ref: z.string().min(1).optional(),
    runtime_ref: z.string().min(1).optional(),
    approval_ref: z.string().min(1).optional(),
    correction_ref: z.string().min(1).optional(),
    surface_ref: CompanionAutonomyRefSchema.optional(),
    permission_ref: CompanionAutonomyRefSchema.optional(),
  }).strict().default({}),
  metadata: z.record(z.unknown()).default({}),
}).strict();
export type FeedbackIngestionRecord = z.infer<typeof FeedbackIngestionRecordSchema>;

const AttentionFeedbackPayloadSchema = z.object({
  feedback_ref: CompanionAutonomyRefSchema,
  kind: z.enum([
    "accepted",
    "dismissed",
    "correction",
    "overreach",
    "permission_revoked",
    "surface_narrowed",
  ]),
  agenda_kind: AgentAgendaItemKindSchema.optional(),
  urge_origin: UrgeOriginSchema.optional(),
  route: OutcomeClassSchema.optional(),
  surface_ref: CompanionAutonomyRefSchema.optional(),
  permission_ref: CompanionAutonomyRefSchema.optional(),
  sensitivity: z.enum(["public", "internal", "sensitive", "restricted"]).optional(),
}).strict();

const AttentionCooldownPayloadSchema = z.object({
  feedback_ref: CompanionAutonomyRefSchema,
  cooldown_policy: z.enum(["raise_expression_threshold", "raise_attention_threshold", "require_confirmation"]),
  reason: z.string().min(1),
  authority_delta: z.literal("narrow_only"),
}).strict();

const ProactiveInterventionFeedbackPayloadSchema = z.object({
  event_ref: z.string().min(1).optional(),
  intervention_ref: z.string().min(1),
  outcome: ProactiveInterventionOutcomeSchema,
}).strict();

const PermissionNarrowingPayloadSchema = z.object({
  permission_ref: CompanionAutonomyRefSchema,
  required_state: z.enum(["approval_required", "revoked", "narrowed"]),
  reason: z.string().min(1),
  authority_delta: z.literal("narrow_or_revoke_only"),
  invalidation_evidence: AutonomyCacheInvalidationEvidenceSchema,
}).strict();

const ProfileProposalRecommendationPayloadSchema = z.object({
  source: z.literal("feedback_ingestion"),
  requires_approval: z.literal(true),
  suggested_action: z.enum([
    "reduce_frequency",
    "require_confirmation",
    "narrow_scope",
    "avoid_sensitive_context",
    "preserve_success_pattern",
  ]),
  profile_proposal_refs: z.array(z.string().min(1)).default([]),
  authority_delta: z.literal("none"),
  reason: z.string().min(1),
}).strict();

const PositiveReinforcementPayloadSchema = z.object({
  feedback_ref: CompanionAutonomyRefSchema,
  follow_through_success: z.boolean().nullable().default(null),
  authority_delta: z.literal("none"),
  reason: z.string().min(1),
}).strict();

const RuntimeOutcomePayloadSchema = z.object({
  runtime_ref: z.string().min(1),
  status: z.enum(["success", "failure"]),
  authority_delta: z.enum(["none", "narrow_only"]),
  reason: z.string().min(1),
}).strict();

const FeedbackIngestionEffectBaseSchema = z.object({
  schema_version: z.literal("feedback-ingestion-effect-v1"),
  effect_id: z.string().min(1),
  feedback_id: z.string().min(1),
  target_ref: z.string().min(1),
  created_at: z.string().datetime(),
}).strict();

export const FeedbackIngestionEffectSchema = z.discriminatedUnion("effect_kind", [
  FeedbackIngestionEffectBaseSchema.extend({
    effect_kind: z.literal("autonomy_feedback_signal"),
    payload: AutonomyFeedbackSignalSchema,
  }),
  FeedbackIngestionEffectBaseSchema.extend({
    effect_kind: z.literal("attention_feedback"),
    payload: AttentionFeedbackPayloadSchema,
  }),
  FeedbackIngestionEffectBaseSchema.extend({
    effect_kind: z.literal("attention_cooldown"),
    payload: AttentionCooldownPayloadSchema,
  }),
  FeedbackIngestionEffectBaseSchema.extend({
    effect_kind: z.literal("surface_invalidation"),
    payload: AutonomyCacheInvalidationEvidenceSchema,
  }),
  FeedbackIngestionEffectBaseSchema.extend({
    effect_kind: z.literal("permission_narrowing"),
    payload: PermissionNarrowingPayloadSchema,
  }),
  FeedbackIngestionEffectBaseSchema.extend({
    effect_kind: z.literal("profile_proposal_recommendation"),
    payload: ProfileProposalRecommendationPayloadSchema,
  }),
  FeedbackIngestionEffectBaseSchema.extend({
    effect_kind: z.literal("positive_reinforcement"),
    payload: PositiveReinforcementPayloadSchema,
  }),
  FeedbackIngestionEffectBaseSchema.extend({
    effect_kind: z.literal("proactive_intervention_feedback"),
    payload: ProactiveInterventionFeedbackPayloadSchema,
  }),
  FeedbackIngestionEffectBaseSchema.extend({
    effect_kind: z.literal("runtime_outcome"),
    payload: RuntimeOutcomePayloadSchema,
  }),
]);
export type FeedbackIngestionEffect = z.infer<typeof FeedbackIngestionEffectSchema>;

export const FeedbackIngestionResultSchema = z.object({
  schema_version: z.literal("feedback-ingestion-result-v1"),
  record: FeedbackIngestionRecordSchema,
  effects: z.array(FeedbackIngestionEffectSchema),
}).strict();
export type FeedbackIngestionResult = z.infer<typeof FeedbackIngestionResultSchema>;

const NEGATIVE_FEEDBACK_OUTCOMES = new Set<FeedbackIngestionOutcome>([
  "ignored",
  "dismissed",
  "corrected",
  "overreach",
  "approval_denied",
  "runtime_failure",
  "permission_revoked",
]);

export function createFeedbackIngestion(
  input: FeedbackIngestionInput,
  options: { now?: string } = {}
): FeedbackIngestionResult {
  const recordedAt = input.recorded_at ?? options.now ?? new Date().toISOString();
  const parsed = FeedbackIngestionInputSchema.parse({
    ...input,
    recorded_at: recordedAt,
  });
  const feedbackId = parsed.feedback_id ?? createFeedbackId(parsed);
  const feedbackRef = ref("feedback", feedbackId);
  const targetRef = targetRefForFeedbackTarget(parsed.target);
  const record = FeedbackIngestionRecordSchema.parse({
    schema_version: "feedback-ingestion-record-v1",
    feedback_id: feedbackId,
    source: parsed.source,
    feedback_kind: parsed.feedback_kind,
    outcome: parsed.outcome,
    recorded_at: parsed.recorded_at,
    target: parsed.target,
    reason: parsed.reason,
    overreach_indicators: parsed.overreach_indicators,
    follow_through_success: parsed.follow_through_success,
    profile_proposal_refs: parsed.profile_proposal_refs,
    source_refs: {
      proactive_event_ref: parsed.proactive_event_ref,
      runtime_ref: parsed.runtime_ref,
      approval_ref: parsed.approval_ref,
      correction_ref: parsed.correction_ref,
      surface_ref: parsed.surface_ref,
      permission_ref: parsed.permission_ref,
    },
    metadata: parsed.metadata,
  });

  const effects: FeedbackIngestionEffect[] = [
    effect(record, "autonomy_feedback_signal", targetRef, autonomyFeedbackSignalFor(record)),
    effect(record, "attention_feedback", targetRef, attentionFeedbackEventFor(record, parsed, feedbackRef)),
  ];

  if (parsed.feedback_kind === "proactive_feedback") {
    effects.push(effect(record, "proactive_intervention_feedback", targetRef, {
      event_ref: parsed.proactive_event_ref,
      intervention_ref: parsed.target.id,
      outcome: proactiveOutcomeFor(record.outcome),
    }));
  }

  if (NEGATIVE_FEEDBACK_OUTCOMES.has(record.outcome)) {
    effects.push(effect(record, "attention_cooldown", targetRef, {
      feedback_ref: feedbackRef,
      cooldown_policy: cooldownPolicyFor(record),
      reason: record.reason ?? defaultReasonFor(record),
      authority_delta: "narrow_only",
    }));
  }

  const invalidation = surfaceInvalidationEvidenceFor(record, parsed, targetRef);
  if (invalidation) {
    effects.push(effect(record, "surface_invalidation", invalidation.ref, invalidation));
  }

  const permissionEffect = permissionNarrowingPayloadFor(record, parsed);
  if (permissionEffect) {
    effects.push(effect(record, "permission_narrowing", refKey(permissionEffect.permission_ref), permissionEffect));
  }

  const profileRecommendation = profileRecommendationFor(record);
  if (profileRecommendation) {
    effects.push(effect(record, "profile_proposal_recommendation", targetRef, profileRecommendation));
  }

  if (record.outcome === "accepted" || record.outcome === "runtime_success") {
    effects.push(effect(record, "positive_reinforcement", targetRef, {
      feedback_ref: feedbackRef,
      follow_through_success: record.follow_through_success,
      authority_delta: "none",
      reason: record.reason ?? "Positive feedback reinforces the pattern without granting new external authority.",
    }));
  }

  if (record.feedback_kind === "runtime_outcome") {
    effects.push(effect(record, "runtime_outcome", parsed.runtime_ref ?? targetRef, {
      runtime_ref: parsed.runtime_ref ?? parsed.target.id,
      status: record.outcome === "runtime_success" ? "success" : "failure",
      authority_delta: record.outcome === "runtime_success" ? "none" : "narrow_only",
      reason: record.reason ?? defaultReasonFor(record),
    }));
  }

  return FeedbackIngestionResultSchema.parse({
    schema_version: "feedback-ingestion-result-v1",
    record,
    effects,
  });
}

export function feedbackIngestionToAttentionInput(result: FeedbackIngestionResult): AttentionInput {
  const parsed = FeedbackIngestionResultSchema.parse(result);
  const feedbackRef = ref("feedback", parsed.record.feedback_id);
  const invalidationRefs = uniqueRefs([
    ...parsed.effects.flatMap((item) => refsForEffectInvalidation(item, parsed.record)),
  ]);
  const replayKey = `feedback:${parsed.record.feedback_id}`;

  return createAttentionInput({
    source_kind: "feedback",
    source_id: `feedback:${parsed.record.source}:${parsed.record.feedback_id}`,
    source_epoch: `feedback:${parsed.record.feedback_id}:${parsed.record.recorded_at}`,
    high_watermark: parsed.record.recorded_at,
    replay_key: replayKey,
    emitted_at: parsed.record.recorded_at,
    payload_class: `feedback.${parsed.record.feedback_kind}.${parsed.record.outcome}`,
    summary: `Feedback ${parsed.record.outcome} was ingested for ${parsed.record.target.kind}.`,
    signal_ref: feedbackRef,
    signal_source: "feedback",
    effect_policy: {
      wake: true,
      notify: false,
      speak: false,
      act: false,
    },
    feedback_refs: [feedbackRef],
    invalidation_refs: invalidationRefs,
    audit_refs: [ref("audit_trace", `feedback-ingestion:${parsed.record.feedback_id}`)],
  });
}

export function feedbackEffectsToAutonomyFeedbackSignals(
  effects: readonly FeedbackIngestionEffect[]
): AutonomyFeedbackSignal[] {
  return effects.flatMap((item) => (
    item.effect_kind === "autonomy_feedback_signal" ? [AutonomyFeedbackSignalSchema.parse(item.payload)] : []
  ));
}

export function feedbackEffectsToAttentionFeedbackEvents(
  effects: readonly FeedbackIngestionEffect[]
): AttentionFeedbackEvent[] {
  return effects.flatMap((item) => (
    item.effect_kind === "attention_feedback" ? [item.payload as AttentionFeedbackEvent] : []
  ));
}

export function feedbackEffectsToInvalidationEvidence(
  effects: readonly FeedbackIngestionEffect[]
): AutonomyCacheInvalidationEvidence[] {
  return effects.flatMap((item) => {
    if (item.effect_kind === "surface_invalidation") {
      return [AutonomyCacheInvalidationEvidenceSchema.parse(item.payload)];
    }
    if (item.effect_kind === "permission_narrowing") {
      return [AutonomyCacheInvalidationEvidenceSchema.parse(item.payload.invalidation_evidence)];
    }
    return [];
  });
}

export function feedbackEffectsToCompanionStateFeedbackRefs(
  effects: readonly FeedbackIngestionEffect[]
): string[] {
  return [...new Set(effects.flatMap((item) => {
    if (item.effect_kind !== "attention_cooldown") return [];
    return [refKey(item.payload.feedback_ref)];
  }))];
}

function createFeedbackId(input: ParsedFeedbackIngestionInput): string {
  const parts = [
    input.source,
    input.feedback_kind,
    input.outcome,
    input.target.kind,
    input.target.id,
    input.recorded_at,
    input.reason ?? "",
    input.proactive_event_ref ?? "",
    input.runtime_ref ?? "",
    input.approval_ref ?? "",
    input.correction_ref ?? "",
  ];
  return `feedback-ingestion:${stableId(parts.join("|"))}`;
}

function targetRefForFeedbackTarget(target: FeedbackTarget): string {
  switch (target.kind) {
    case "outcome_decision":
      return refKey(ref("outcome_decision", target.id));
    case "expression_decision":
      return refKey(ref("expression_decision", target.id));
    case "agenda_item":
      return refKey(ref("agent_agenda_item", target.id));
    case "permission_grant":
      return refKey(ref("permission_grant", target.id));
    case "surface":
      return refKey(ref("surface", target.id));
    case "conversation":
      return refKey(ref("conversation", target.id));
    case "approval":
      return refKey(ref("approval", target.id));
    case "runtime_operation":
      return refKey(ref("runtime_item", target.id));
    case "intervention":
      return `intervention:${target.id}`;
  }
}

function effect<T extends FeedbackIngestionEffect["effect_kind"]>(
  record: FeedbackIngestionRecord,
  kind: T,
  targetRef: string,
  payload: Extract<FeedbackIngestionEffect, { effect_kind: T }>["payload"]
): Extract<FeedbackIngestionEffect, { effect_kind: T }> {
  const effectId = `feedback-effect:${record.feedback_id}:${kind}:${stableId(`${targetRef}:${JSON.stringify(payload)}`)}`;
  return FeedbackIngestionEffectSchema.parse({
    schema_version: "feedback-ingestion-effect-v1",
    effect_id: effectId,
    feedback_id: record.feedback_id,
    effect_kind: kind,
    target_ref: targetRef,
    created_at: record.recorded_at,
    payload,
  }) as Extract<FeedbackIngestionEffect, { effect_kind: T }>;
}

function proactiveOutcomeFor(outcome: FeedbackIngestionOutcome): ProactiveInterventionOutcome {
  switch (outcome) {
    case "accepted":
    case "runtime_success":
      return "accepted";
    case "ignored":
      return "ignored";
    case "dismissed":
    case "approval_denied":
      return "dismissed";
    case "overreach":
      return "overreach";
    case "corrected":
    case "permission_revoked":
    case "runtime_failure":
      return "corrected";
  }
}

function policyAdjustmentFor(record: FeedbackIngestionRecord): AutonomyFeedbackSignal["policy_adjustment"] {
  if (record.outcome === "accepted" || record.outcome === "runtime_success") return undefined;
  if (record.outcome === "overreach") {
    if (record.overreach_indicators.includes("sensitive")) return "avoid_sensitive_context";
    if (record.overreach_indicators.includes("too_frequent")) return "reduce_frequency";
    if (record.overreach_indicators.includes("wrong_context")) return "narrow_scope";
    return "require_confirmation";
  }
  if (record.outcome === "ignored" || record.outcome === "dismissed") return "reduce_frequency";
  if (record.outcome === "permission_revoked") return "narrow_scope";
  return "require_confirmation";
}

function autonomyFeedbackSignalFor(record: FeedbackIngestionRecord): AutonomyFeedbackSignal {
  return AutonomyFeedbackSignalSchema.parse({
    ref: `feedback:${record.feedback_id}`,
    outcome: proactiveOutcomeFor(record.outcome),
    reason: record.reason ?? defaultReasonFor(record),
    overreach_indicators: record.overreach_indicators,
    follow_through_success: record.follow_through_success,
    recorded_at: record.recorded_at,
    policy_adjustment: policyAdjustmentFor(record),
  });
}

function attentionFeedbackEventFor(
  record: FeedbackIngestionRecord,
  input: ParsedFeedbackIngestionInput,
  feedbackRef: CompanionAutonomyRef
): z.infer<typeof AttentionFeedbackPayloadSchema> {
  const permissionRef = input.permission_ref
    ?? (record.target.kind === "permission_grant" ? ref("permission_grant", record.target.id) : undefined);
  const surfaceRef = input.surface_ref
    ?? (record.target.kind === "surface" ? ref("surface", record.target.id) : undefined);

  return AttentionFeedbackPayloadSchema.parse({
    feedback_ref: feedbackRef,
    kind: attentionFeedbackKindFor(record),
    agenda_kind: input.agenda_kind,
    urge_origin: input.urge_origin,
    route: input.route,
    surface_ref: surfaceRef,
    permission_ref: permissionRef,
    sensitivity: record.overreach_indicators.includes("sensitive") ? "sensitive" : undefined,
  });
}

function attentionFeedbackKindFor(record: FeedbackIngestionRecord): z.infer<typeof AttentionFeedbackPayloadSchema>["kind"] {
  if (record.outcome === "accepted" || record.outcome === "runtime_success") return "accepted";
  if (record.outcome === "overreach") return "overreach";
  if (record.outcome === "permission_revoked") return "permission_revoked";
  if (record.feedback_kind === "surface_correction") return "correction";
  if (record.feedback_kind === "surface_dismissal" && record.target.kind === "surface") return "surface_narrowed";
  if (record.outcome === "corrected" || record.outcome === "approval_denied" || record.outcome === "runtime_failure") {
    return "correction";
  }
  return "dismissed";
}

function cooldownPolicyFor(
  record: FeedbackIngestionRecord
): z.infer<typeof AttentionCooldownPayloadSchema>["cooldown_policy"] {
  if (record.outcome === "corrected" || record.outcome === "approval_denied" || record.outcome === "runtime_failure") {
    return "require_confirmation";
  }
  if (record.outcome === "permission_revoked") return "require_confirmation";
  if (record.feedback_kind === "surface_correction") return "raise_attention_threshold";
  return "raise_expression_threshold";
}

function surfaceInvalidationEvidenceFor(
  record: FeedbackIngestionRecord,
  input: ParsedFeedbackIngestionInput,
  targetRef: string
): AutonomyCacheInvalidationEvidence | null {
  if (
    record.outcome !== "corrected"
    && record.outcome !== "overreach"
    && record.outcome !== "permission_revoked"
    && record.feedback_kind !== "surface_correction"
    && record.feedback_kind !== "surface_dismissal"
  ) {
    return null;
  }

  const surfaceRef = input.surface_ref
    ?? (record.target.kind === "surface" ? ref("surface", record.target.id) : undefined);
  const refValue = surfaceRef ? refKey(surfaceRef) : targetRef;
  return AutonomyCacheInvalidationEvidenceSchema.parse({
    kind: record.outcome === "permission_revoked" ? "revocation" : "correction",
    ref: refValue,
    reason: record.reason ?? defaultReasonFor(record),
    epoch: record.recorded_at,
  });
}

function permissionNarrowingPayloadFor(
  record: FeedbackIngestionRecord,
  input: ParsedFeedbackIngestionInput
): z.infer<typeof PermissionNarrowingPayloadSchema> | null {
  if (record.outcome !== "permission_revoked" && record.feedback_kind !== "permission_revoked") return null;
  const permissionRef = input.permission_ref
    ?? (record.target.kind === "permission_grant" ? ref("permission_grant", record.target.id) : null);
  if (!permissionRef) return null;
  const reason = record.reason ?? "Permission feedback revoked or narrowed future autonomous initiation.";
  return PermissionNarrowingPayloadSchema.parse({
    permission_ref: permissionRef,
    required_state: "revoked",
    reason,
    authority_delta: "narrow_or_revoke_only",
    invalidation_evidence: {
      kind: "revocation",
      ref: refKey(permissionRef),
      reason,
      epoch: record.recorded_at,
    },
  });
}

function profileRecommendationFor(
  record: FeedbackIngestionRecord
): z.infer<typeof ProfileProposalRecommendationPayloadSchema> | null {
  const suggestedAction = policyAdjustmentFor(record);
  if (suggestedAction) {
    return ProfileProposalRecommendationPayloadSchema.parse({
      source: "feedback_ingestion",
      requires_approval: true,
      suggested_action: suggestedAction,
      profile_proposal_refs: record.profile_proposal_refs,
      authority_delta: "none",
      reason: record.reason ?? defaultReasonFor(record),
    });
  }
  if ((record.outcome === "accepted" || record.outcome === "runtime_success") && record.follow_through_success === true) {
    return ProfileProposalRecommendationPayloadSchema.parse({
      source: "feedback_ingestion",
      requires_approval: true,
      suggested_action: "preserve_success_pattern",
      profile_proposal_refs: record.profile_proposal_refs,
      authority_delta: "none",
      reason: record.reason ?? "Successful feedback can become a governed profile proposal but cannot grant authority.",
    });
  }
  return null;
}

function refsForEffectInvalidation(
  effectRecord: FeedbackIngestionEffect,
  record: FeedbackIngestionRecord
): CompanionAutonomyRef[] {
  if (effectRecord.effect_kind === "permission_narrowing") return [effectRecord.payload.permission_ref];
  if (effectRecord.effect_kind === "surface_invalidation") {
    if (record.source_refs.surface_ref) return [record.source_refs.surface_ref];
    if (record.target.kind === "surface") return [ref("surface", record.target.id)];
    return [];
  }
  return [];
}

function defaultReasonFor(record: FeedbackIngestionRecord): string {
  return `Feedback ${record.outcome} was recorded for ${record.feedback_kind}.`;
}
