import { MemoryWritebackProposalSchema } from "../runtime/cognition/index.js";
import type { CognitionEventRef, MemoryWritebackProposal } from "../runtime/cognition/index.js";
import type { LearningArtifact } from "../runtime/learning/index.js";
import {
  createCognitionWritebackQueueEntry,
  type CognitionWritebackQueueEntry,
} from "./cognition-writeback-queue.js";

export function createExperienceLearningWritebackProposal(input: {
  artifact: LearningArtifact;
  proposalId?: string;
  target?: MemoryWritebackProposal["proposed_target"];
}): MemoryWritebackProposal {
  const sourceRefs = experienceLearningArtifactSourceRefs(input.artifact);
  return MemoryWritebackProposalSchema.parse({
    proposal_id: input.proposalId ?? `writeback:experience-learning:${input.artifact.id}`,
    proposal_kind: "soil_record_candidate",
    source_event_refs: sourceRefs,
    proposed_target: input.target ?? "reflection",
    admission_state: "pending_review",
    user_visible_review_text: "Review whether this promoted learning artifact should become owner-managed memory.",
    auto_apply: false,
    source_content_materialized: false,
  });
}

export function createExperienceLearningWritebackQueueEntry(input: {
  artifact: LearningArtifact;
  queueEntryId?: string;
  createdAt: string;
  target?: MemoryWritebackProposal["proposed_target"];
}): CognitionWritebackQueueEntry {
  const proposal = createExperienceLearningWritebackProposal({
    artifact: input.artifact,
    ...(input.target ? { target: input.target } : {}),
  });
  return createCognitionWritebackQueueEntry({
    queueEntryId: input.queueEntryId ?? `queue:experience-learning:${input.artifact.id}`,
    proposal,
    createdAt: input.createdAt,
  });
}

function experienceLearningArtifactSourceRefs(artifact: LearningArtifact): CognitionEventRef[] {
  const refs = [
    ...artifact.evidence.runtimeEvidenceRefs,
    ...artifact.evidence.experimentRecordIds,
    artifact.id,
  ];
  return [...new Set(refs)].map((ref) => ({
    ref,
    source_store: "runtime_event_log",
    source_event_type: "experience_learning.artifact",
    schema_version: 1,
    replay_key: `experience-learning:${artifact.id}:${ref}`,
    redaction_policy: "metadata_only",
  }));
}
