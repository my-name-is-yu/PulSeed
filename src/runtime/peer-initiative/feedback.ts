import { createHash } from "node:crypto";
import type {
  FeedbackIngestionInput,
  FeedbackIngestionResult,
} from "../attention/feedback-ingestion.js";
import type {
  PeerInitiativeFeedbackAction,
} from "../gateway/outbound-conversation.js";
import {
  PeerFeedbackProjectionSchema,
  type PeerFeedbackProjection,
} from "./store.js";

export type PeerFeedbackSourceSurface = "telegram" | "discord" | "whatsapp" | "slack" | "gui" | "gateway";

export function peerInitiativeFeedbackToIngestionInput(
  action: PeerInitiativeFeedbackAction,
  input: {
    sourceSurface: PeerFeedbackSourceSurface;
    recordedAt: string;
    surfaceRef?: string;
  },
): FeedbackIngestionInput {
  const target = action.feedback_target.kind === "outcome_decision"
    ? { kind: "outcome_decision" as const, id: action.feedback_target.id }
    : { kind: "intervention" as const, id: action.feedback_target.id };
  return {
    source: feedbackSourceForSurface(input.sourceSurface),
    feedback_kind: action.action === "mute_this_kind" ? "permission_revoked" : "proactive_feedback",
    outcome: feedbackOutcomeForPeerAction(action.action),
    target,
    recorded_at: input.recordedAt,
    reason: feedbackReasonForPeerAction(action.action),
    proactive_event_ref: action.candidate_id,
    ...(input.surfaceRef ? { surface_ref: { kind: "surface" as const, id: input.surfaceRef } } : {}),
    metadata: {
      peer_initiative_candidate_id: action.candidate_id,
      peer_initiative_kind: action.initiative_kind,
      peer_feedback_action: action.action,
      peer_feedback_epoch: action.feedback_epoch,
      source_surface: input.sourceSurface,
    },
  };
}

export function projectPeerInitiativeFeedback(input: {
  action: PeerInitiativeFeedbackAction;
  result: FeedbackIngestionResult;
  sourceSurface: PeerFeedbackSourceSurface;
  projectedAt: string;
  nextEligibleAt?: string;
}): PeerFeedbackProjection {
  return PeerFeedbackProjectionSchema.parse({
    projection_id: `peer-feedback:${stableToken([
      input.action.candidate_id,
      input.action.action,
      input.result.record.feedback_id,
    ].join(":"))}`,
    candidate_id: input.action.candidate_id,
    kind: input.action.initiative_kind,
    structured_outcome: input.action.action,
    source_surface: input.sourceSurface,
    projected_at: input.projectedAt,
    feedback_id: input.result.record.feedback_id,
    feedback_effect_refs: input.result.effects.map((effect) => effect.effect_id),
    next_eligible_at: input.nextEligibleAt,
  });
}

function feedbackSourceForSurface(surface: PeerFeedbackSourceSurface): FeedbackIngestionInput["source"] {
  if (surface === "telegram") return "telegram";
  if (surface === "gateway") return "gateway";
  return "gateway";
}

function feedbackOutcomeForPeerAction(
  action: PeerInitiativeFeedbackAction["action"],
): FeedbackIngestionInput["outcome"] {
  switch (action) {
    case "more_like_this":
      return "accepted";
    case "wrong_read":
      return "corrected";
    case "mute_this_kind":
      return "permission_revoked";
    case "less_like_this":
    case "not_now":
      return "dismissed";
  }
}

function feedbackReasonForPeerAction(action: PeerInitiativeFeedbackAction["action"]): string {
  switch (action) {
    case "more_like_this":
      return "User asked for more peer initiatives like this one.";
    case "less_like_this":
      return "User asked for fewer peer initiatives like this one.";
    case "not_now":
      return "User deferred this peer initiative without rejecting the whole channel.";
    case "wrong_read":
      return "User corrected the peer initiative read; do not write a stable profile fact directly.";
    case "mute_this_kind":
      return "User muted this peer initiative kind; narrow future proactive delivery for this kind.";
  }
}

function stableToken(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
