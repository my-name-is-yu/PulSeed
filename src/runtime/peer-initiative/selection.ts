import {
  PeerInitiativeCandidateSchema,
  PeerInitiativeSelectionSchema,
  ProactiveWorthinessSchema,
  type PeerInitiativeCandidate,
  type PeerInitiativeSelection,
  type ProactiveWorthiness,
} from "./contracts.js";

export function canSelectVisiblePeerInitiative(input: ProactiveWorthiness): boolean {
  const worthiness = ProactiveWorthinessSchema.parse(input);
  return worthiness.can_be_valuable_without_reply === true
    && (worthiness.user_cognitive_load === "none" || worthiness.user_cognitive_load === "low")
    && (worthiness.reply_pressure === "none" || worthiness.reply_pressure === "soft")
    && (worthiness.care_value === "medium" || worthiness.care_value === "high")
    && (worthiness.attention_fit === "medium" || worthiness.attention_fit === "strong")
    && (worthiness.concrete_helpfulness === "medium" || worthiness.concrete_helpfulness === "high")
    && worthiness.self_serving_risk !== "high"
    && worthiness.tutorial_risk !== "high";
}

export function canSelectCareOnlyPeerInitiative(candidate: PeerInitiativeCandidate): boolean {
  const parsed = PeerInitiativeCandidateSchema.parse(candidate);
  const worthiness = parsed.worthiness;
  return parsed.source === "pulseed_initiated"
    && parsed.kind === "care_presence"
    && parsed.action_plan.mode === "care_only"
    && worthiness.can_be_valuable_without_reply === true
    && (worthiness.user_cognitive_load === "none" || worthiness.user_cognitive_load === "low")
    && (worthiness.reply_pressure === "none" || worthiness.reply_pressure === "soft")
    && (worthiness.care_value === "medium" || worthiness.care_value === "high")
    && worthiness.self_serving_risk !== "high"
    && worthiness.tutorial_risk !== "high";
}

export function selectPeerInitiativeCandidate(
  candidates: readonly PeerInitiativeCandidate[]
): PeerInitiativeSelection {
  const parsed = candidates.map((candidate) => PeerInitiativeCandidateSchema.parse(candidate));
  const rejected = parsed.filter((candidate) => rejectionReason(candidate) !== null);
  const eligible = parsed.filter((candidate) =>
    rejectionReason(candidate) === null
      && (canSelectVisiblePeerInitiative(candidate.worthiness) || canSelectCareOnlyPeerInitiative(candidate))
  );

  if (eligible.length === 0) {
    const reason = rejected.some((candidate) => candidate.worthiness.tutorial_risk === "high")
      ? "held_by_tutorial_risk"
      : rejected.some((candidate) => candidate.worthiness.user_cognitive_load === "medium" || candidate.worthiness.user_cognitive_load === "high")
        ? "held_by_cognitive_load"
        : "no_candidate";
    return PeerInitiativeSelectionSchema.parse({
      held_candidate_ids: parsed.map((candidate) => candidate.candidate_id),
      rejected_candidate_ids: rejected.map((candidate) => candidate.candidate_id),
      selection_reason: reason,
    });
  }

  const [selected] = [...eligible].sort(comparePeerCandidates);
  const held = parsed
    .filter((candidate) => candidate.candidate_id !== selected.candidate_id)
    .map((candidate) => candidate.candidate_id);
  return PeerInitiativeSelectionSchema.parse({
    selected_candidate_id: selected.candidate_id,
    held_candidate_ids: held,
    rejected_candidate_ids: rejected.map((candidate) => candidate.candidate_id),
    selection_reason: selectionReasonFor(selected),
  });
}

function comparePeerCandidates(left: PeerInitiativeCandidate, right: PeerInitiativeCandidate): number {
  return candidateScore(right) - candidateScore(left)
    || left.created_at.localeCompare(right.created_at)
    || left.candidate_id.localeCompare(right.candidate_id);
}

function candidateScore(candidate: PeerInitiativeCandidate): number {
  const worthiness = candidate.worthiness;
  return candidate.confidence * 4
    + ordinal(worthiness.care_value, ["none", "low", "medium", "high"])
    + ordinal(worthiness.attention_fit, ["none", "weak", "medium", "strong"])
    + ordinal(worthiness.concrete_helpfulness, ["none", "low", "medium", "high"])
    - ordinal(worthiness.user_cognitive_load, ["none", "low", "medium", "high"])
    - (worthiness.reply_pressure === "strong" ? 3 : worthiness.reply_pressure === "soft" ? 1 : 0)
    - (worthiness.tutorial_risk === "high" ? 5 : worthiness.tutorial_risk === "low" ? 1 : 0)
    - (worthiness.self_serving_risk === "high" ? 5 : worthiness.self_serving_risk === "low" ? 1 : 0)
    + kindBonus(candidate);
}

function kindBonus(candidate: PeerInitiativeCandidate): number {
  switch (candidate.kind) {
    case "attention_preparation":
      return 2.2;
    case "care_presence":
      return 1.8;
    case "contextual_capability_disclosure":
      return 1.4;
    case "gentle_pushback":
      return 1.2;
    case "permissioned_attention_action":
      return 1;
    case "tiny_nudge":
    case "remembered_thread":
    case "repair_followup":
      return 0.8;
    case "playful_curiosity":
      return -4;
  }
}

function selectionReasonFor(candidate: PeerInitiativeCandidate): PeerInitiativeSelection["selection_reason"] {
  switch (candidate.kind) {
    case "care_presence":
      return "care_presence_budget";
    case "contextual_capability_disclosure":
      return "capability_fits_current_need";
    case "gentle_pushback":
      return "timely_gentle_pushback";
    default:
      return "best_attention_preparation";
  }
}

function rejectionReason(candidate: PeerInitiativeCandidate): string | null {
  const worthiness = candidate.worthiness;
  if (candidate.kind === "playful_curiosity" && !candidate.playful_style_enabled) {
    return "too_question_like";
  }
  if (worthiness.self_serving_risk === "high") return "too_self_serving";
  if (worthiness.tutorial_risk === "high") return "too_tutorial_like";
  if (worthiness.user_cognitive_load === "medium" || worthiness.user_cognitive_load === "high") {
    return "too_much_cognitive_load";
  }
  if (worthiness.reply_pressure === "strong") return "too_question_like";
  if (worthiness.attention_fit === "none") return "low_attention_fit";
  if (!worthiness.can_be_valuable_without_reply) return "too_question_like";
  if (
    candidate.action_plan.mode === "contextual_capability_disclosure"
    && !candidate.capability_fit
  ) {
    return "too_tutorial_like";
  }
  return null;
}

function ordinal(value: string, order: readonly string[]): number {
  const index = order.indexOf(value);
  return index === -1 ? 0 : index;
}

