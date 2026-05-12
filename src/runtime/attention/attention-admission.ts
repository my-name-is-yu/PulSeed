import {
  type AgendaDecomposition,
  type AgendaDecompositionChild,
  type AttentionScope,
} from "../types/companion-autonomy.js";
import {
  assembleResidentOperationPlans,
  type ResidentAttentionOperationProjection,
} from "../capability-operation-planner.js";
import type { CapabilityOperationPlanAssembly } from "../types/capability-operation-plan.js";
import { stableId } from "./attention-refs.js";
import { attentionScopeKey, permissionScopeAllowsAuthority } from "./attention-scope.js";

export type AttentionAdmissionProposalState =
  | "proposed"
  | "pending_handoff"
  | "handed_off"
  | "confirmed"
  | "terminal"
  | "orphaned_needs_reconcile";

export type AttentionAdmissionCandidate = {
  candidateId: string;
  child: AgendaDecompositionChild;
  agendaRef: string;
  clusterRef: string;
  scope: AttentionScope;
  idempotencyKey: string;
  requiredAuthority: AgendaDecompositionChild["requiredAuthority"];
  policyEpoch: string;
  proposalState: AttentionAdmissionProposalState;
  reasonRefs: string[];
  createdAt: string;
};

export interface BuildAttentionAdmissionCandidatesInput {
  decompositions: readonly AgendaDecomposition[];
  now: string;
  pendingBlockedScopeKeys?: readonly string[];
}

export function buildAttentionAdmissionCandidates(
  input: BuildAttentionAdmissionCandidatesInput,
): AttentionAdmissionCandidate[] {
  const pendingBlockedScopes = new Set(input.pendingBlockedScopeKeys ?? []);
  const candidates: AttentionAdmissionCandidate[] = [];

  for (const decomposition of input.decompositions) {
    if (decomposition.status === "needs_regrounding" || decomposition.status === "suppressed" || decomposition.status === "closed") {
      continue;
    }
    if (pendingBlockedScopes.has(scopeBlockKey(decomposition.scope))) continue;
    for (const child of decomposition.children) {
      if (child.admissionState !== "not_admitted") continue;
      if (child.stalenessSnapshot.state !== "fresh") continue;
      if (!permissionScopeAllowsAuthority(child.permissionScope, child.requiredAuthority)) continue;
      candidates.push({
        candidateId: `attention-admission:${stableId(child.idempotencyKey)}`,
        child,
        agendaRef: child.parentAgendaRef.id,
        clusterRef: child.clusterRef.id,
        scope: decomposition.scope,
        idempotencyKey: child.idempotencyKey,
        requiredAuthority: child.requiredAuthority,
        policyEpoch: decomposition.scope.policyEpoch,
        proposalState: "proposed",
        reasonRefs: [decomposition.agendaRef.id, decomposition.clusterRef.id],
        createdAt: input.now,
      });
    }
  }

  return candidates;
}

export function assembleCapabilityPlansForAttentionAdmissions(input: {
  candidates: readonly AttentionAdmissionCandidate[];
  assembledAt: string;
  goalId?: string | null;
}): CapabilityOperationPlanAssembly[] {
  return input.candidates.flatMap((candidate) => {
    const projection = residentProjectionForAttentionCandidate(candidate);
    if (!projection) return [];
    return [assembleResidentOperationPlans({
      admission: projection,
      assembledAt: input.assembledAt,
      goalId: input.goalId ?? undefined,
    })];
  });
}

export function scopeBlockKey(scope: AttentionScope): string {
  return attentionScopeKey(scope);
}

function residentProjectionForAttentionCandidate(
  candidate: AttentionAdmissionCandidate,
): ResidentAttentionOperationProjection | null {
  if (candidate.child.childType === "prepare" || candidate.child.childType === "digest") {
    return {
      action: "curiosity",
      source_kind: "resident_curiosity",
      attention_input_id: `attention-input:${candidate.candidateId}`,
      signal_context_id: `signal:${candidate.candidateId}`,
      urge_id: `urge:${candidate.candidateId}`,
      agenda_item_id: candidate.agendaRef,
      inhibition_decision_id: `inhibition:${candidate.candidateId}`,
      initiative_gate_decision_id: `gate:${candidate.candidateId}`,
      outcome_decision_id: deterministicRuntimeHandoffId(candidate),
      requested_outcome: "prepare_silently",
      admission_status: "admitted",
      final_outcome: "prepare_silently",
      branch_admitted: true,
    };
  }
  if (candidate.child.childType === "action_candidate") {
    return {
      action: "preemptive_check",
      source_kind: "resident_proactive_maintenance",
      attention_input_id: `attention-input:${candidate.candidateId}`,
      signal_context_id: `signal:${candidate.candidateId}`,
      urge_id: `urge:${candidate.candidateId}`,
      agenda_item_id: candidate.agendaRef,
      inhibition_decision_id: `inhibition:${candidate.candidateId}`,
      initiative_gate_decision_id: `gate:${candidate.candidateId}`,
      outcome_decision_id: deterministicRuntimeHandoffId(candidate),
      requested_outcome: "prepare_action_candidate",
      admission_status: "held",
      final_outcome: undefined,
      branch_admitted: false,
    };
  }
  return null;
}

function deterministicRuntimeHandoffId(candidate: AttentionAdmissionCandidate): string {
  return `outcome:${stableId(`${candidate.idempotencyKey}:${candidate.policyEpoch}:${candidate.scope.permissionScope}`)}`;
}
