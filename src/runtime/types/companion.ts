import { z } from "zod";

export const CompanionPresenceModeSchema = z.enum([
  "idle",
  "available",
  "listening",
  "thinking",
  "speaking",
  "observing",
  "do_not_disturb",
]);
export type CompanionPresenceMode = z.infer<typeof CompanionPresenceModeSchema>;

export const ConversationInputModalitySchema = z.enum([
  "text",
  "voice",
  "tap",
  "notification",
  "sensor",
]);
export type ConversationInputModality = z.infer<typeof ConversationInputModalitySchema>;

export const ConversationOutputModeSchema = z.enum([
  "reply",
  "voice",
  "notification",
  "digest",
  "silent",
  "defer",
]);
export type ConversationOutputMode = z.infer<typeof ConversationOutputModeSchema>;

export const CompanionContextKindSchema = z.enum([
  "work",
  "home",
  "commute",
  "sleep",
  "unknown",
]);
export type CompanionContextKind = z.infer<typeof CompanionContextKindSchema>;

export const CompanionUrgencySchema = z.enum(["low", "normal", "high", "critical"]);
export type CompanionUrgency = z.infer<typeof CompanionUrgencySchema>;

export const CompanionQuietingDecisionSchema = z.enum(["allow", "defer", "suppress"]);
export type CompanionQuietingDecision = z.infer<typeof CompanionQuietingDecisionSchema>;

export const CompanionDialogueKindSchema = z.enum([
  "direct_turn",
  "interruption",
  "proactive",
  "notification",
  "observation",
]);
export type CompanionDialogueKind = z.infer<typeof CompanionDialogueKindSchema>;

export const CompanionCurrentTargetContextSchema = z.object({
  session_key: z.string().min(1).nullable().default(null),
  conversation_id: z.string().min(1).nullable().default(null),
  message_id: z.string().min(1).nullable().default(null),
  run_id: z.string().min(1).nullable().default(null),
  goal_id: z.string().min(1).nullable().default(null),
  reply_target_id: z.string().min(1).nullable().default(null),
});
export type CompanionCurrentTargetContext = z.infer<typeof CompanionCurrentTargetContextSchema>;

export const CompanionPresenceStateSchema = z.object({
  schema_version: z.literal("companion-presence-state-v1").default("companion-presence-state-v1"),
  mode: CompanionPresenceModeSchema,
  interruptible: z.boolean(),
  last_user_activity_at: z.string().datetime().nullable().default(null),
  current_context: CompanionContextKindSchema.default("unknown"),
  reason: z.string().min(1).optional(),
  current_target: CompanionCurrentTargetContextSchema.default({}),
});
export type CompanionPresenceState = z.infer<typeof CompanionPresenceStateSchema>;

export const CompanionTurnPolicySchema = z.object({
  schema_version: z.literal("companion-turn-policy-v1").default("companion-turn-policy-v1"),
  dialogue_kind: CompanionDialogueKindSchema.default("direct_turn"),
  input_modality: ConversationInputModalitySchema,
  output_mode: ConversationOutputModeSchema,
  can_interrupt: z.boolean(),
  latency_budget_ms: z.number().int().positive(),
  urgency: CompanionUrgencySchema,
  quieting: CompanionQuietingDecisionSchema,
  requires_explicit_interruption: z.boolean().default(false),
  current_target: CompanionCurrentTargetContextSchema.default({}),
});
export type CompanionTurnPolicy = z.infer<typeof CompanionTurnPolicySchema>;

export const CompanionRuntimeContractSchema = z.object({
  schema_version: z.literal("companion-runtime-contract-v1").default("companion-runtime-contract-v1"),
  presence: CompanionPresenceStateSchema,
  turn_policy: CompanionTurnPolicySchema,
});
export type CompanionRuntimeContract = z.infer<typeof CompanionRuntimeContractSchema>;

export const CompanionOutputPolicyDecisionSchema = z.object({
  output_mode: ConversationOutputModeSchema,
  quieting: CompanionQuietingDecisionSchema,
  delivered: z.boolean(),
  reason: z.enum([
    "allowed",
    "deferred_by_quieting",
    "suppressed_by_quieting",
    "interruption_requires_explicit_request",
  ]),
});
export type CompanionOutputPolicyDecision = z.infer<typeof CompanionOutputPolicyDecisionSchema>;

export * from "./companion-autonomy.js";
