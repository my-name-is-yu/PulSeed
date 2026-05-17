import { z } from "zod/v3";
import { PeerInitiativeKindSchema } from "../peer-initiative/kinds.js";
import {
  SurfaceActionBindingSchema,
  SurfaceProjectionSchema,
} from "../surface-projection-protocol.js";

export const OutboundConversationSurfaceSchema = z.enum([
  "telegram",
  "discord",
  "whatsapp",
]);
export type OutboundConversationSurface = z.infer<typeof OutboundConversationSurfaceSchema>;

export const PeerInitiativeTriggerActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("show_prepared"),
    candidate_id: z.string().min(1),
    prepared_artifact_ref: z.string().min(1),
  }).strict(),
  z.object({
    action: z.literal("use_once"),
    candidate_id: z.string().min(1),
    capability_ref: z.string().min(1),
  }).strict(),
  z.object({
    action: z.literal("approve_external_action"),
    candidate_id: z.string().min(1),
    prepared_artifact_ref: z.string().min(1).optional(),
  }).strict(),
]);
export type PeerInitiativeTriggerAction = z.infer<typeof PeerInitiativeTriggerActionSchema>;

export const PeerInitiativeFeedbackActionSchema = z.object({
  action: z.enum([
    "more_like_this",
    "less_like_this",
    "not_now",
    "wrong_read",
    "mute_this_kind",
  ]),
  candidate_id: z.string().min(1),
  initiative_kind: PeerInitiativeKindSchema,
  feedback_target: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("peer_initiative_candidate"),
      id: z.string().min(1),
    }).strict(),
    z.object({
      kind: z.literal("outcome_decision"),
      id: z.string().min(1),
      peer_candidate_id: z.string().min(1),
    }).strict(),
  ]),
  feedback_epoch: z.string().datetime(),
}).strict();
export type PeerInitiativeFeedbackAction = z.infer<typeof PeerInitiativeFeedbackActionSchema>;

export const OutboundConversationTargetSchema = z.object({
  surface: OutboundConversationSurfaceSchema,
  target_binding_ref: z.string().min(1),
  channel_policy_ref: z.string().min(1),
}).strict();
export type OutboundConversationTarget = z.infer<typeof OutboundConversationTargetSchema>;

export const OutboundConversationMessageSchema = z.object({
  message_id: z.string().min(1),
  surface: OutboundConversationSurfaceSchema,
  target_binding_ref: z.string().min(1),
  channel_policy_ref: z.string().min(1),
  text: z.string().trim().min(1).max(500),
  reply_required: z.literal(false),
  source: z.literal("peer_initiative"),
  candidate_id: z.string().min(1),
  expression_decision_ref: z.string().min(1),
  visibility_policy_ref: z.string().min(1),
  trigger_actions: z.array(PeerInitiativeTriggerActionSchema).default([]),
  feedback_actions: z.array(PeerInitiativeFeedbackActionSchema).default([]),
  action_bindings: z.array(SurfaceActionBindingSchema).optional(),
  surface_projection: SurfaceProjectionSchema.optional(),
}).strict();
export type OutboundConversationMessage = z.infer<typeof OutboundConversationMessageSchema>;

export const OutboundConversationDeliveryReceiptSchema = z.object({
  message_id: z.string().min(1),
  surface: OutboundConversationSurfaceSchema,
  target_binding_ref: z.string().min(1),
  delivered_at: z.string().datetime(),
  transport_message_ref: z.string().min(1).optional(),
}).strict();
export type OutboundConversationDeliveryReceipt = z.infer<typeof OutboundConversationDeliveryReceiptSchema>;

export interface GatewayOutboundConversationPort {
  readonly surface: OutboundConversationSurface;
  resolveDefaultTarget(): Promise<OutboundConversationTarget | null>;
  sendOutboundConversationMessage(
    message: OutboundConversationMessage
  ): Promise<OutboundConversationDeliveryReceipt>;
}
