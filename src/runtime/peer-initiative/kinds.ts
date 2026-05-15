import { z } from "zod/v3";

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
