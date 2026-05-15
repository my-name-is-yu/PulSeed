import { createHash } from "node:crypto";
import { z } from "zod/v3";
import {
  PeerInitiativeFeedbackActionSchema,
  PeerInitiativeTriggerActionSchema,
  type PeerInitiativeFeedbackAction,
  type PeerInitiativeTriggerAction,
} from "../gateway/outbound-conversation.js";

const DateTimeStringSchema = z.string().datetime();

export const PeerInitiativeSourceSchema = z.enum([
  "user_requested_followup",
  "pulseed_initiated",
]);
export type PeerInitiativeSource = z.infer<typeof PeerInitiativeSourceSchema>;

export const PeerInitiativeGroundingSchema = z.enum([
  "attention_state",
  "relationship_context",
  "open_conversation_thread",
  "ambient_care",
  "capability_fit",
  "shared_ritual",
]);
export type PeerInitiativeGrounding = z.infer<typeof PeerInitiativeGroundingSchema>;

export const PeerInitiativeKindSchema = z.enum([
  "care_presence",
  "attention_preparation",
  "permissioned_attention_action",
  "contextual_capability_disclosure",
  "gentle_pushback",
  "tiny_nudge",
  "remembered_thread",
  "repair_followup",
  "playful_curiosity",
]);
export type PeerInitiativeKind = z.infer<typeof PeerInitiativeKindSchema>;

export const CurrentNeedSignalKindSchema = z.enum([
  "care_presence_appropriate",
  "decision_load_high",
  "overpacked_day",
  "stalled_thread",
  "unfinished_but_salient_conversation",
  "capability_would_reduce_current_burden",
  "gentle_pushback_appropriate",
]);
export type CurrentNeedSignalKind = z.infer<typeof CurrentNeedSignalKindSchema>;

export const CurrentNeedSignalSchema = z.object({
  signal_id: z.string().min(1),
  kind: CurrentNeedSignalKindSchema,
  created_at: DateTimeStringSchema,
  attention_signal_refs: z.array(z.string().min(1)).default([]),
  relationship_projection_ref: z.string().min(1).optional(),
  confidence: z.number().min(0).max(1),
  summary: z.string().min(1),
}).strict();
export type CurrentNeedSignal = z.infer<typeof CurrentNeedSignalSchema>;

export const CompanionStanceSchema = z.object({
  stance_id: z.string().min(1),
  version: z.number().int().positive(),
  posture: z.enum([
    "on_your_side",
    "steady",
    "lightly_challenging",
    "carefully_helpful",
    "low_pressure",
  ]),
  durable_commitment: z.enum([
    "support_user_long_term_flourishing",
    "notice_current_attention_state_without_waiting_for_commands",
    "prepare_small_next_steps_before_user_asks",
    "reduce_user_cognitive_load",
    "push_back_when_user_is_self_undermining",
  ]),
  forbidden_posture: z.enum([
    "servile_tool",
    "engagement_optimizer",
    "product_tutorial_bot",
    "authority_figure",
    "sole_support",
  ]),
}).strict();
export type CompanionStance = z.infer<typeof CompanionStanceSchema>;

export const DefaultCompanionStance: CompanionStance = {
  stance_id: "peer-friend-low-pressure-v1",
  version: 1,
  posture: "low_pressure",
  durable_commitment: "prepare_small_next_steps_before_user_asks",
  forbidden_posture: "product_tutorial_bot",
};

export const ProactiveWorthinessSchema = z.object({
  can_be_valuable_without_reply: z.boolean(),
  user_cognitive_load: z.enum(["none", "low", "medium", "high"]),
  reply_pressure: z.enum(["none", "soft", "strong"]),
  care_value: z.enum(["none", "low", "medium", "high"]),
  attention_fit: z.enum(["none", "weak", "medium", "strong"]),
  concrete_helpfulness: z.enum(["none", "low", "medium", "high"]),
  self_serving_risk: z.enum(["none", "low", "high"]),
  tutorial_risk: z.enum(["none", "low", "high"]),
}).strict();
export type ProactiveWorthiness = z.infer<typeof ProactiveWorthinessSchema>;

export const PeerInitiativeActionPlanSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("care_only"),
    permission_required: z.literal(false),
  }).strict(),
  z.object({
    mode: z.literal("internal_preparation"),
    preparation_kind: z.enum([
      "priority_trim",
      "decision_options",
      "thread_summary",
      "draft_reply",
      "minimum_viable_plan",
      "reminder_candidate",
      "followup_candidate",
    ]),
    prepared_artifact_ref: z.string().min(1),
    permission_required: z.literal(false),
    user_visible_trigger: z.enum(["show_me", "use_this", "open_when_ready"]),
  }).strict(),
  z.object({
    mode: z.literal("permissioned_external_action"),
    proposed_action_kind: z.enum([
      "send_message",
      "create_calendar_event",
      "schedule_reminder",
      "commit_setting",
      "share_artifact",
    ]),
    prepared_artifact_ref: z.string().min(1).optional(),
    permission_required: z.literal(true),
    confirmation_phrase: z.string().min(1),
  }).strict(),
  z.object({
    mode: z.literal("contextual_capability_disclosure"),
    capability_ref: z.string().min(1),
    current_need_ref: z.string().min(1),
    try_once_available: z.literal(true),
    permission_required: z.boolean(),
  }).strict(),
]);
export type PeerInitiativeActionPlan = z.infer<typeof PeerInitiativeActionPlanSchema>;

export const PulSeedCapabilityFitSchema = z.object({
  capability_ref: z.string().min(1),
  user_has_not_used_capability: z.boolean(),
  current_need_ref: z.string().min(1),
  burden_reduced: z.enum([
    "remember_later",
    "reduce_decision_load",
    "turn_thread_into_plan",
    "draft_before_action",
    "watch_without_interrupting",
    "summarize_scattered_context",
  ]),
  disclosure_style: z.literal("in_context_one_line"),
  activation: z.enum(["try_once", "enable_for_this_thread", "ask_before_external_action"]),
  tutorial_copy_allowed: z.literal(false),
}).strict();
export type PulSeedCapabilityFit = z.infer<typeof PulSeedCapabilityFitSchema>;

export const PeerInitiativeCandidateSchema = z.object({
  candidate_id: z.string().min(1),
  idempotency_key: z.string().min(1),
  created_at: DateTimeStringSchema,
  source: PeerInitiativeSourceSchema,
  kind: PeerInitiativeKindSchema,
  grounding: z.array(PeerInitiativeGroundingSchema).min(1),
  stance_ref: z.string().min(1),
  attention_signal_refs: z.array(z.string().min(1)).default([]),
  relationship_projection_ref: z.string().min(1).optional(),
  open_thread_refs: z.array(z.string().min(1)).default([]),
  capability_ref: z.string().min(1).optional(),
  current_need_refs: z.array(z.string().min(1)).default([]),
  capability_fit: PulSeedCapabilityFitSchema.optional(),
  message_intent: z.string().min(1),
  draft_message: z.string().trim().min(1).max(500),
  reply_required: z.literal(false),
  action_plan: PeerInitiativeActionPlanSchema,
  worthiness: ProactiveWorthinessSchema,
  max_delivery_kind: z.enum(["digest", "suggest", "notify"]),
  external_action_authority: z.literal(false),
  task_creation_authority: z.literal(false),
  confidence: z.number().min(0).max(1),
  playful_style_enabled: z.boolean().default(false),
}).strict().superRefine((candidate, ctx) => {
  if (
    candidate.kind === "playful_curiosity" &&
    !candidate.playful_style_enabled &&
    !candidate.grounding.includes("shared_ritual")
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["kind"],
      message: "playful curiosity peer initiatives require shared ritual or explicit style enablement",
    });
  }
  if (
    candidate.action_plan.mode === "contextual_capability_disclosure" &&
    candidate.action_plan.current_need_ref.trim().length === 0
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["action_plan", "current_need_ref"],
      message: "contextual capability disclosure requires a current need ref",
    });
  }
});
export type PeerInitiativeCandidate = z.infer<typeof PeerInitiativeCandidateSchema>;

export const PeerInitiativeBoundaryMappingSchema = z.object({
  mapping_id: z.string().min(1),
  action_plan_ref: z.string().min(1),
  autonomy_operation_plan_ref: z.string().min(1).optional(),
  admission_evaluation_ref: z.string().min(1).optional(),
  autonomy_decision_ref: z.string().min(1).optional(),
  proactive_threshold_decision_ref: z.string().min(1),
  outcome_decision_ref: z.string().min(1).optional(),
  companion_action_projection_ref: z.string().min(1).optional(),
  mapped_boundary: z.enum([
    "care_suggest",
    "attention_prepare_draft",
    "permission_request",
    "capability_suggest",
    "capability_prepare_draft",
    "capability_ask_for_approval",
    "held_by_threshold",
  ]),
}).strict();
export type PeerInitiativeBoundaryMapping = z.infer<typeof PeerInitiativeBoundaryMappingSchema>;

export const PeerInitiativeSelectionSchema = z.object({
  selected_candidate_id: z.string().min(1).optional(),
  held_candidate_ids: z.array(z.string().min(1)).default([]),
  rejected_candidate_ids: z.array(z.string().min(1)).default([]),
  selection_reason: z.enum([
    "no_candidate",
    "care_presence_budget",
    "best_attention_preparation",
    "timely_gentle_pushback",
    "capability_fits_current_need",
    "held_by_attention",
    "held_by_repetition",
    "held_by_cognitive_load",
    "held_by_tutorial_risk",
  ]),
}).strict();
export type PeerInitiativeSelection = z.infer<typeof PeerInitiativeSelectionSchema>;

export const PeerInitiativeMessageSchema = z.object({
  message_id: z.string().min(1),
  candidate_id: z.string().min(1),
  expression_decision_ref: z.string().min(1),
  visibility_policy_ref: z.string().min(1),
  surface: z.enum(["telegram", "discord", "whatsapp", "slack", "gui"]),
  text: z.string().trim().min(1).max(500),
  reply_required: z.literal(false),
  action_buttons: z.array(z.union([
    PeerInitiativeTriggerActionSchema,
    PeerInitiativeFeedbackActionSchema,
  ])).default([]),
  thread_behavior: z.enum([
    "new_lightweight_thread",
    "append_to_existing_relationship_thread",
  ]),
}).strict();
export type PeerInitiativeMessage = z.infer<typeof PeerInitiativeMessageSchema>;

export const PeerInitiativeSelectedStateSchema = z.enum([
  "held",
  "digested",
  "suggested",
  "notified",
  "rejected",
]);
export type PeerInitiativeSelectedState = z.infer<typeof PeerInitiativeSelectedStateSchema>;

export const PeerInitiativeRecordSchema = z.object({
  candidate_id: z.string().min(1),
  created_at: DateTimeStringSchema,
  source: PeerInitiativeSourceSchema,
  kind: PeerInitiativeKindSchema,
  grounding: z.array(PeerInitiativeGroundingSchema).default([]),
  attention_signal_refs: z.array(z.string().min(1)).default([]),
  prepared_artifact_ref: z.string().min(1).optional(),
  capability_ref: z.string().min(1).optional(),
  selected_state: PeerInitiativeSelectedStateSchema,
  rejection_reason: z.enum([
    "low_attention_fit",
    "too_much_cognitive_load",
    "too_self_serving",
    "too_tutorial_like",
    "too_question_like",
    "repetition",
    "quiet_mode",
  ]).optional(),
  delivered_at: DateTimeStringSchema.optional(),
  feedback_projection_ref: z.string().min(1).optional(),
  next_eligible_at: DateTimeStringSchema.optional(),
  idempotency_key: z.string().min(1),
  candidate: PeerInitiativeCandidateSchema,
}).strict();
export type PeerInitiativeRecord = z.infer<typeof PeerInitiativeRecordSchema>;

export function createPeerInitiativeIdempotencyKey(input: {
  kind: PeerInitiativeKind;
  attentionSignalRefs: readonly string[];
  preparedArtifactRef?: string;
  surfaceTarget: string;
  policyEpoch: string;
  messageIntent: string;
}): string {
  const hash = createHash("sha256").update(JSON.stringify({
    kind: input.kind,
    attentionSignalRefs: [...input.attentionSignalRefs].sort(),
    preparedArtifactRef: input.preparedArtifactRef ?? null,
    surfaceTarget: input.surfaceTarget,
    policyEpoch: input.policyEpoch,
    messageIntent: input.messageIntent,
  })).digest("hex").slice(0, 24);
  return `peer-initiative:${hash}`;
}

export function peerInitiativeActionButtons(input: {
  candidate: PeerInitiativeCandidate;
  outcomeDecisionId?: string;
  feedbackEpoch: string;
}): Array<PeerInitiativeTriggerAction | PeerInitiativeFeedbackAction> {
  const feedbackTarget = input.outcomeDecisionId
    ? { kind: "outcome_decision" as const, id: input.outcomeDecisionId, peer_candidate_id: input.candidate.candidate_id }
    : { kind: "peer_initiative_candidate" as const, id: input.candidate.candidate_id };
  const feedbackActions: PeerInitiativeFeedbackAction[] = [
    "more_like_this",
    "less_like_this",
    "not_now",
    "wrong_read",
  ].map((action) => PeerInitiativeFeedbackActionSchema.parse({
    action,
    candidate_id: input.candidate.candidate_id,
    initiative_kind: input.candidate.kind,
    feedback_target: feedbackTarget,
    feedback_epoch: input.feedbackEpoch,
  }));

  const triggerActions: PeerInitiativeTriggerAction[] = [];
  const plan = input.candidate.action_plan;
  if (plan.mode === "internal_preparation") {
    triggerActions.push(PeerInitiativeTriggerActionSchema.parse({
      action: "show_prepared",
      candidate_id: input.candidate.candidate_id,
      prepared_artifact_ref: plan.prepared_artifact_ref,
    }));
  }
  if (plan.mode === "contextual_capability_disclosure") {
    triggerActions.push(PeerInitiativeTriggerActionSchema.parse({
      action: "use_once",
      candidate_id: input.candidate.candidate_id,
      capability_ref: plan.capability_ref,
    }));
  }
  if (plan.mode === "permissioned_external_action") {
    triggerActions.push(PeerInitiativeTriggerActionSchema.parse({
      action: "approve_external_action",
      candidate_id: input.candidate.candidate_id,
      ...(plan.prepared_artifact_ref ? { prepared_artifact_ref: plan.prepared_artifact_ref } : {}),
    }));
  }
  return [...triggerActions, ...feedbackActions];
}

