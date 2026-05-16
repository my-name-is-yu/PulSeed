import { createHash } from "node:crypto";
import { z } from "zod/v3";
import {
  CurrentNeedSignalSchema,
  DefaultCompanionStance,
  PeerInitiativeActionPlanSchema,
  PeerInitiativeCandidateSchema,
  PeerInitiativeGroundingSchema,
  PeerInitiativeKindSchema,
  ProactiveWorthinessSchema,
  PulSeedCapabilityFitSchema,
  createPeerInitiativeIdempotencyKey,
  type CurrentNeedSignal,
  type PeerInitiativeActionPlan,
  type PeerInitiativeCandidate,
} from "./contracts.js";

const PeerInitiativeDecisionDetailsSchema = z.object({
  kind: PeerInitiativeKindSchema,
  message: z.string().trim().min(1).max(500),
  message_intent: z.string().min(1).optional(),
  action_plan: PeerInitiativeActionPlanSchema,
  worthiness: ProactiveWorthinessSchema,
  need_signals: z.array(CurrentNeedSignalSchema).default([]),
  capability_fit: PulSeedCapabilityFitSchema.optional(),
  grounding: z.array(PeerInitiativeGroundingSchema).optional(),
  confidence: z.number().min(0).max(1).optional(),
  max_delivery_kind: z.enum(["digest", "suggest", "notify"]).optional(),
  playful_style_enabled: z.boolean().optional(),
}).passthrough();

export interface PeerInitiativeCandidateGenerationInput {
  details?: Record<string, unknown>;
  attentionSignalRefs: string[];
  relationshipProjectionRef?: string;
  policyEpoch: string;
  now: string;
  surfaceTarget: string;
}

export function synthesizeCurrentNeedSignals(
  input: PeerInitiativeCandidateGenerationInput
): CurrentNeedSignal[] {
  const details = parsePeerDetails(input.details);
  if (!details) return [];
  if (details.need_signals.length > 0) return details.need_signals;
  return [CurrentNeedSignalSchema.parse({
    signal_id: `need:peer-care:${stableToken([...input.attentionSignalRefs, input.now].join(":"))}`,
    kind: "care_presence_appropriate",
    created_at: input.now,
    attention_signal_refs: input.attentionSignalRefs,
    ...(input.relationshipProjectionRef ? { relationship_projection_ref: input.relationshipProjectionRef } : {}),
    confidence: 0.68,
    summary: "Resident attention admitted a low-pressure peer initiative candidate.",
  })];
}

export function generatePeerInitiativeCandidates(
  input: PeerInitiativeCandidateGenerationInput
): PeerInitiativeCandidate[] {
  const details = parsePeerDetails(input.details);
  if (!details) return [];
  const needs = synthesizeCurrentNeedSignals(input);
  const primaryNeed = needs[0];
  const actionPlan = details.action_plan;
  const kind = details.kind;
  const worthiness = details.worthiness;
  const attentionSignalRefs = unique([
    ...input.attentionSignalRefs,
    ...needs.flatMap((need) => need.attention_signal_refs),
  ]);
  const preparedArtifactRef = actionPlan.mode === "internal_preparation"
    ? actionPlan.prepared_artifact_ref
    : actionPlan.mode === "permissioned_external_action"
      ? actionPlan.prepared_artifact_ref
      : undefined;
  const messageIntent = details.message_intent ?? messageIntentFor(kind, actionPlan);
  const idempotencyKey = createPeerInitiativeIdempotencyKey({
    kind,
    attentionSignalRefs,
    preparedArtifactRef,
    surfaceTarget: input.surfaceTarget,
    policyEpoch: input.policyEpoch,
    messageIntent,
  });
  const candidate = PeerInitiativeCandidateSchema.parse({
    candidate_id: `peer-candidate:${stableToken(idempotencyKey)}`,
    idempotency_key: idempotencyKey,
    created_at: input.now,
    source: "pulseed_initiated",
    kind,
    grounding: details.grounding ?? groundingFor(kind, primaryNeed),
    stance_ref: DefaultCompanionStance.stance_id,
    attention_signal_refs: attentionSignalRefs,
    ...(input.relationshipProjectionRef ? { relationship_projection_ref: input.relationshipProjectionRef } : {}),
    open_thread_refs: [],
    capability_ref: actionPlan.mode === "contextual_capability_disclosure"
      ? actionPlan.capability_ref
      : undefined,
    current_need_refs: needs.map((need) => need.signal_id),
    ...(details.capability_fit ? { capability_fit: details.capability_fit } : {}),
    message_intent: messageIntent,
    draft_message: details.message,
    reply_required: false,
    action_plan: actionPlan,
    worthiness,
    max_delivery_kind: details.max_delivery_kind ?? "notify",
    external_action_authority: false,
    task_creation_authority: false,
    confidence: details.confidence ?? confidenceForNeeds(needs),
    playful_style_enabled: details.playful_style_enabled ?? false,
  });
  return [candidate];
}

function parsePeerDetails(details: Record<string, unknown> | undefined): z.infer<typeof PeerInitiativeDecisionDetailsSchema> | null {
  const raw = details?.["peer_initiative"];
  if (raw !== undefined && (typeof raw !== "object" || raw === null || Array.isArray(raw))) {
    return null;
  }
  if (raw === undefined) {
    return null;
  }
  const candidate = raw;
  const parsed = PeerInitiativeDecisionDetailsSchema.safeParse(candidate);
  if (parsed.success) return parsed.data;
  return null;
}

function groundingFor(
  kind: PeerInitiativeCandidate["kind"],
  need: CurrentNeedSignal | undefined,
): PeerInitiativeCandidate["grounding"] {
  if (kind === "contextual_capability_disclosure") return ["attention_state", "capability_fit"];
  if (kind === "care_presence") return ["attention_state", "ambient_care"];
  if (need?.kind === "unfinished_but_salient_conversation") return ["attention_state", "open_conversation_thread"];
  return ["attention_state"];
}

function messageIntentFor(
  kind: PeerInitiativeCandidate["kind"],
  actionPlan: PeerInitiativeActionPlan,
): string {
  if (actionPlan.mode === "internal_preparation") return `prepare_${actionPlan.preparation_kind}_before_user_asks`;
  if (actionPlan.mode === "permissioned_external_action") return `ask_before_${actionPlan.proposed_action_kind}`;
  if (actionPlan.mode === "contextual_capability_disclosure") return "offer_contextual_capability_for_current_need";
  return kind === "care_presence" ? "low_pressure_care_presence" : `peer_${kind}`;
}

function confidenceForNeeds(needs: CurrentNeedSignal[]): number {
  if (needs.length === 0) return 0.68;
  return Math.max(...needs.map((need) => need.confidence));
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function stableToken(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}
