import {
  evaluateResidentOperationBoundary,
  type ResidentAttentionOperationProjection,
  type ResidentOperationBoundaryInput,
  type ResidentOperationBoundaryResult,
} from "../capability-operation-planner.js";
import {
  generatePeerInitiativeCandidates,
  type PeerInitiativeCandidate,
} from "../peer-initiative/index.js";
import type { AttentionAdmissionCandidate } from "./attention-admission.js";
import { stableId } from "./attention-refs.js";

export type CommitmentOperationFamily =
  | "attention.commitment.watch"
  | "attention.commitment.prepare_followup"
  | "attention.commitment.digest"
  | "attention.commitment.ask_if_still_relevant";

export type CommitmentOperationAdapterOutcome =
  | {
      outcome: "trace_only";
      candidate: AttentionAdmissionCandidate;
      reason: string;
    }
  | {
      outcome: "blocked";
      candidate: AttentionAdmissionCandidate;
      reason: string;
      boundary?: ResidentOperationBoundaryResult;
    }
  | {
      outcome: "prepared";
      candidate: AttentionAdmissionCandidate;
      family: CommitmentOperationFamily;
      boundary: ResidentOperationBoundaryResult;
      peerCandidate: PeerInitiativeCandidate | null;
    };

export interface CommitmentOperationAdapterInput {
  candidates: readonly AttentionAdmissionCandidate[];
  assembledAt: string;
  goalId?: string | null;
  surfaceRef?: string | null;
  boundaryEvaluator?: (input: ResidentOperationBoundaryInput) => ResidentOperationBoundaryResult;
}

export function evaluateCommitmentOperationsForAttentionAdmissions(
  input: CommitmentOperationAdapterInput
): CommitmentOperationAdapterOutcome[] {
  const outcomes: CommitmentOperationAdapterOutcome[] = [];
  for (const candidate of input.candidates) {
    if (candidate.parentAgendaKind !== "commitment_guard") continue;
    if (candidate.child.stalenessSnapshot.state !== "fresh") {
      outcomes.push({
        outcome: "blocked",
        candidate,
        reason: "commitment operation adapter requires fresh child source refs",
      });
      continue;
    }
    if (candidate.child.childType === "watch" || candidate.child.childType === "silence") {
      outcomes.push({
        outcome: "trace_only",
        candidate,
        reason: "watch and silence commitment children remain trace-only",
      });
      continue;
    }
    if (candidate.child.childType === "action_candidate") {
      outcomes.push({
        outcome: "blocked",
        candidate,
        reason: "commitment action candidates require explicit approval artifact binding before operation assembly",
      });
      continue;
    }

    const family = commitmentFamilyForChild(candidate);
    const details = commitmentOperationDetails(candidate, family);
    const projection = commitmentProjectionForCandidate(candidate, family);
    const boundary = (input.boundaryEvaluator ?? evaluateResidentOperationBoundary)({
      admission: projection,
      assembledAt: input.assembledAt,
      goalId: input.goalId,
      details,
      surfaceRef: input.surfaceRef,
    });
    if (!boundary.admission_evaluation || !boundary.autonomy_decision) {
      outcomes.push({
        outcome: "blocked",
        candidate,
        boundary,
        reason: "commitment operation boundary did not produce admission and autonomy evidence",
      });
      continue;
    }
    if (!boundary.preparation_allowed) {
      outcomes.push({
        outcome: "blocked",
        candidate,
        boundary,
        reason: "commitment operation boundary denied preparation",
      });
      continue;
    }

    outcomes.push({
      outcome: "prepared",
      candidate,
      family,
      boundary,
      peerCandidate: peerCandidateForPreparedCommitment({
        candidate,
        family,
        details,
        assembledAt: input.assembledAt,
        surfaceRef: input.surfaceRef ?? "surface:resident-daemon",
      }),
    });
  }
  return outcomes;
}

export function projectCommitmentBoundaryToPeerCandidate(input: {
  candidate: AttentionAdmissionCandidate;
  family: CommitmentOperationFamily;
  boundary?: ResidentOperationBoundaryResult | null;
  assembledAt: string;
  surfaceRef?: string | null;
}): PeerInitiativeCandidate | null {
  if (!input.boundary?.admission_evaluation || !input.boundary.autonomy_decision) return null;
  if (!input.boundary.preparation_allowed) return null;
  return peerCandidateForPreparedCommitment({
    candidate: input.candidate,
    family: input.family,
    details: commitmentOperationDetails(input.candidate, input.family),
    assembledAt: input.assembledAt,
    surfaceRef: input.surfaceRef ?? "surface:resident-daemon",
  });
}

function commitmentFamilyForChild(candidate: AttentionAdmissionCandidate): CommitmentOperationFamily {
  switch (candidate.child.childType) {
    case "prepare":
      return "attention.commitment.prepare_followup";
    case "digest":
      return "attention.commitment.digest";
    case "ask":
    case "action_candidate":
      return "attention.commitment.ask_if_still_relevant";
    case "watch":
    case "silence":
      return "attention.commitment.watch";
  }
}

function commitmentProjectionForCandidate(
  candidate: AttentionAdmissionCandidate,
  family: CommitmentOperationFamily,
): ResidentAttentionOperationProjection {
  const finalOutcome = finalOutcomeForFamily(family);
  return {
    action: "commitment",
    source_kind: "resident_proactive_maintenance",
    attention_input_id: `attention-input:${candidate.candidateId}`,
    signal_context_id: `signal:${candidate.candidateId}`,
    urge_id: `urge:${candidate.candidateId}`,
    agenda_item_id: candidate.agendaRef,
    inhibition_decision_id: `inhibition:${candidate.candidateId}`,
    initiative_gate_decision_id: `gate:${candidate.candidateId}`,
    outcome_decision_id: `outcome:${stableId(`${candidate.idempotencyKey}:${family}:${candidate.policyEpoch}`)}`,
    requested_outcome: finalOutcome,
    admission_status: "admitted",
    final_outcome: finalOutcome,
    branch_admitted: true,
  };
}

function commitmentOperationDetails(
  candidate: AttentionAdmissionCandidate,
  family: CommitmentOperationFamily,
): Record<string, unknown> {
  return {
    commitment_operation_family: family,
    explicit_permission: candidate.child.childType !== "action_candidate",
    peer_initiative: peerDetailsForFamily(candidate, family),
  };
}

function peerDetailsForFamily(
  candidate: AttentionAdmissionCandidate,
  family: CommitmentOperationFamily,
): Record<string, unknown> {
  if (family === "attention.commitment.prepare_followup") {
    return {
      kind: "care_presence",
      message: "I can keep this as a light follow-up candidate without making it a hard reminder.",
      message_intent: "prepare_commitment_followup_candidate",
      action_plan: {
        mode: "internal_preparation",
        preparation_kind: "followup_candidate",
        prepared_artifact_ref: `commitment-followup:${stableId(candidate.idempotencyKey)}`,
        permission_required: false,
        user_visible_trigger: "show_me",
      },
      worthiness: lowPressureWorthiness("medium"),
      max_delivery_kind: "suggest",
      need_signals: [needSignal(candidate, "unfinished_but_salient_conversation")],
      grounding: ["attention_state", "open_conversation_thread"],
      confidence: 0.72,
    };
  }
  if (family === "attention.commitment.digest") {
    return {
      kind: "care_presence",
      message: "There is a held follow-up candidate that fits better as a digest item than a notification.",
      message_intent: "add_commitment_to_digest",
      action_plan: {
        mode: "care_only",
        permission_required: false,
      },
      worthiness: lowPressureWorthiness("low"),
      max_delivery_kind: "digest",
      need_signals: [needSignal(candidate, "unfinished_but_salient_conversation")],
      grounding: ["attention_state"],
      confidence: 0.7,
    };
  }
  return {
    kind: "care_presence",
    message: "Is this still worth keeping lightly in mind?",
    message_intent: "ask_if_commitment_still_relevant",
    action_plan: {
      mode: "care_only",
      permission_required: false,
    },
    worthiness: lowPressureWorthiness("medium"),
    max_delivery_kind: "suggest",
    need_signals: [needSignal(candidate, "care_presence_appropriate")],
    grounding: ["attention_state", "ambient_care"],
    confidence: 0.68,
  };
}

function peerCandidateForPreparedCommitment(input: {
  candidate: AttentionAdmissionCandidate;
  family: CommitmentOperationFamily;
  details: Record<string, unknown>;
  assembledAt: string;
  surfaceRef: string;
}): PeerInitiativeCandidate | null {
  const [candidate] = generatePeerInitiativeCandidates({
    details: input.details,
    attentionSignalRefs: [
      input.candidate.candidateId,
      input.candidate.agendaRef,
      input.family,
    ],
    policyEpoch: input.candidate.policyEpoch,
    now: input.assembledAt,
    surfaceTarget: input.surfaceRef,
  });
  return candidate ?? null;
}

function finalOutcomeForFamily(family: CommitmentOperationFamily): string {
  switch (family) {
    case "attention.commitment.watch":
      return "keep_watching";
    case "attention.commitment.prepare_followup":
      return "prepare_silently";
    case "attention.commitment.digest":
      return "add_to_digest";
    case "attention.commitment.ask_if_still_relevant":
      return "express_to_user";
  }
}

function needSignal(
  candidate: AttentionAdmissionCandidate,
  kind: "care_presence_appropriate" | "unfinished_but_salient_conversation",
) {
  return {
    signal_id: `need:commitment:${stableId(`${candidate.candidateId}:${kind}`)}`,
    kind,
    created_at: candidate.createdAt,
    attention_signal_refs: [candidate.candidateId, candidate.agendaRef],
    confidence: 0.72,
    summary: "Commitment guard admission produced a low-pressure follow-up need signal.",
  };
}

function lowPressureWorthiness(careValue: "low" | "medium") {
  return {
    can_be_valuable_without_reply: true,
    user_cognitive_load: "low",
    reply_pressure: "none",
    care_value: careValue,
    attention_fit: "strong",
    concrete_helpfulness: careValue,
    self_serving_risk: "low",
    tutorial_risk: "none",
  };
}
