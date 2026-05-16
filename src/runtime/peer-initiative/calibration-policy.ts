import { z } from "zod/v3";
import {
  ProactivePolicyEventSchema,
  type ProactivePolicyEvent,
} from "../attention/proactive-policy.js";
import type {
  ProactiveInterventionEvent,
  ProactiveInterventionFeedbackEvent,
} from "../store/proactive-intervention-store.js";
import {
  DEFAULT_RESIDENT_ACTIVATION_POLICY_ID,
  DEFAULT_RESIDENT_ACTIVATION_MAX_DELIVERY_KIND,
  ProactivePolicyStateApplyResultSchema,
  type ProactivePolicyStateStore,
} from "../store/index.js";
import type {
  PeerFeedbackProjection,
} from "./store.js";

export const PeerInitiativeCalibrationApplicationSchema = z.object({
  schema_version: z.literal("peer-initiative-calibration-application/v1"),
  generated_at: z.string().datetime(),
  policy_id: z.string().min(1),
  read_only: z.literal(false).default(false),
  mutation_performed: z.boolean(),
  source_counts: z.object({
    proactive_feedback_event_count: z.number().int().nonnegative(),
    peer_feedback_projection_count: z.number().int().nonnegative(),
    calibration_event_count: z.number().int().nonnegative(),
  }).strict(),
  policy_state_result: ProactivePolicyStateApplyResultSchema,
  policy_state_projection: z.object({
    max_delivery_kind: z.string().min(1),
    feedback_ref_count: z.number().int().nonnegative(),
    cooldown_ref_count: z.number().int().nonnegative(),
    budget_debit_count: z.number().int().nonnegative(),
  }).strict(),
  accepted_feedback_escalation_performed: z.literal(false).default(false),
  authority_escalation_performed: z.literal(false).default(false),
  relationship_profile_write_performed: z.literal(false).default(false),
  raw_refs_visible: z.literal(false).default(false),
}).strict();
export type PeerInitiativeCalibrationApplication = z.infer<typeof PeerInitiativeCalibrationApplicationSchema>;
type ProactivePolicyFeedbackKind = Extract<ProactivePolicyEvent, { kind: "feedback" }>["feedback_kind"];

export function peerFeedbackProjectionToProactivePolicyEvent(
  projection: PeerFeedbackProjection
): ProactivePolicyEvent {
  return ProactivePolicyEventSchema.parse({
    kind: "feedback",
    feedback_ref: {
      kind: "peer_feedback_projection",
      ref: projection.projection_id,
    },
    feedback_kind: peerFeedbackKind(projection.structured_outcome),
    recorded_at: projection.projected_at,
  });
}

export function proactiveInterventionFeedbackToPolicyEvent(
  event: ProactiveInterventionFeedbackEvent
): ProactivePolicyEvent | null {
  const feedbackKind = proactiveFeedbackKind(event.outcome);
  if (!feedbackKind) return null;
  return ProactivePolicyEventSchema.parse({
    kind: "feedback",
    feedback_ref: {
      kind: "proactive_intervention_feedback",
      ref: event.event_id,
    },
    feedback_kind: feedbackKind,
    recorded_at: event.recorded_at,
  });
}

export function createPeerInitiativePolicyEvents(input: {
  proactiveEvents: readonly ProactiveInterventionEvent[];
  peerFeedbackProjections: readonly PeerFeedbackProjection[];
}): ProactivePolicyEvent[] {
  const proactiveEvents = input.proactiveEvents.flatMap((event) => {
    if (event.event_type !== "feedback") return [];
    const policyEvent = proactiveInterventionFeedbackToPolicyEvent(event);
    return policyEvent ? [policyEvent] : [];
  });
  const peerEvents = input.peerFeedbackProjections.map(peerFeedbackProjectionToProactivePolicyEvent);
  return [...proactiveEvents, ...peerEvents].sort((left, right) =>
    new Date(left.recorded_at).getTime() - new Date(right.recorded_at).getTime()
  );
}

export async function applyPeerInitiativeCalibrationPolicy(input: {
  policyStore: Pick<ProactivePolicyStateStore, "applyEvents">;
  generatedAt: string;
  proactiveEvents: readonly ProactiveInterventionEvent[];
  peerFeedbackProjections: readonly PeerFeedbackProjection[];
  policyId?: string;
}): Promise<PeerInitiativeCalibrationApplication> {
  const policyId = input.policyId ?? DEFAULT_RESIDENT_ACTIVATION_POLICY_ID;
  const events = createPeerInitiativePolicyEvents({
    proactiveEvents: input.proactiveEvents,
    peerFeedbackProjections: input.peerFeedbackProjections,
  });
  const { state, result } = await input.policyStore.applyEvents({
    policyId,
    now: input.generatedAt,
    maxDeliveryKind: DEFAULT_RESIDENT_ACTIVATION_MAX_DELIVERY_KIND,
    events,
  });
  return PeerInitiativeCalibrationApplicationSchema.parse({
    schema_version: "peer-initiative-calibration-application/v1",
    generated_at: input.generatedAt,
    policy_id: policyId,
    read_only: false,
    mutation_performed: result.applied_event_count > 0,
    source_counts: {
      proactive_feedback_event_count: input.proactiveEvents.filter((event) => event.event_type === "feedback").length,
      peer_feedback_projection_count: input.peerFeedbackProjections.length,
      calibration_event_count: events.length,
    },
    policy_state_result: result,
    policy_state_projection: {
      max_delivery_kind: state.max_delivery_kind,
      feedback_ref_count: state.feedback_refs.length,
      cooldown_ref_count: state.cooldown_refs.length,
      budget_debit_count: state.interruption_budget?.current_debits ?? 0,
    },
    accepted_feedback_escalation_performed: false,
    authority_escalation_performed: false,
    relationship_profile_write_performed: false,
    raw_refs_visible: false,
  });
}

function peerFeedbackKind(outcome: PeerFeedbackProjection["structured_outcome"]): ProactivePolicyFeedbackKind {
  switch (outcome) {
    case "more_like_this":
      return "accepted";
    case "wrong_read":
      return "correction";
    case "mute_this_kind":
      return "permission_revoked";
    case "less_like_this":
    case "not_now":
      return "dismissed";
  }
}

function proactiveFeedbackKind(
  outcome: ProactiveInterventionFeedbackEvent["outcome"]
): ProactivePolicyFeedbackKind | null {
  switch (outcome) {
    case "accepted":
      return "accepted";
    case "dismissed":
      return "dismissed";
    case "corrected":
      return "correction";
    case "overreach":
      return "overreach";
    case "ignored":
      return null;
  }
}
