import type { AttentionStateStore } from "../store/attention-state-store.js";
import type { AttentionInput } from "./attention-input.js";
import {
  buildCommitmentReemissionInput,
  commitmentCandidateToUrge,
  createCommitmentAttentionInput,
  type CommitmentCandidate,
  type CommitmentReemissionTriggerKind,
} from "./commitment-candidate.js";
import type { UrgeCandidate } from "../types/companion-autonomy.js";

export interface CommitmentGuardProviderResult {
  attentionInputs: AttentionInput[];
  urgeCandidates: UrgeCandidate[];
  heldCommitmentIds: string[];
}

export async function buildCommitmentGuardAttention(input: {
  store: Pick<AttentionStateStore, "listCommitmentCandidates">;
  now: string;
  triggerKind?: CommitmentReemissionTriggerKind;
}): Promise<CommitmentGuardProviderResult> {
  const candidates = await input.store.listCommitmentCandidates({
    states: ["candidate", "shadow_held", "ask_confirmation", "watching", "active_care", "quieted", "snoozed", "stale"],
    dueBefore: input.now,
    includeTerminal: false,
  });
  return buildCommitmentGuardAttentionFromCandidates({
    candidates,
    now: input.now,
    triggerKind: input.triggerKind ?? "revisit_window",
  });
}

export function buildCommitmentGuardAttentionFromCandidates(input: {
  candidates: readonly CommitmentCandidate[];
  now: string;
  triggerKind: CommitmentReemissionTriggerKind;
}): CommitmentGuardProviderResult {
  const attentionInputs: AttentionInput[] = [];
  const urgeCandidates: UrgeCandidate[] = [];
  const heldCommitmentIds: string[] = [];

  for (const candidate of input.candidates) {
    const reemission = buildCommitmentReemissionInput({
      candidate,
      triggerKind: input.triggerKind,
      now: input.now,
    }) ?? createCommitmentAttentionInput({
      candidate,
      emittedAt: input.now,
      replayKey: `${candidate.replay_key}:provider:${candidate.materialization_state}`,
      payloadClass: "attention.commitment.provider.current_state",
      summary: "Commitment guard provider projected current candidate lifecycle into attention.",
    });
    attentionInputs.push(reemission);
    const urge = commitmentCandidateToUrge({
      candidate,
      attentionInput: reemission,
      now: input.now,
    });
    urgeCandidates.push(urge);
    if (urge.maturation.state === "held" || urge.maturation.state === "suppressed") {
      heldCommitmentIds.push(candidate.commitment_id);
    }
  }

  return {
    attentionInputs,
    urgeCandidates,
    heldCommitmentIds,
  };
}
