import { MemoryWritebackProposalSchema } from "../runtime/cognition/index.js";
import type { CognitionEventRef, MemoryWritebackProposal } from "../runtime/cognition/index.js";
import {
  ExperienceLearningProjectionProposalSchema,
  stableLearningId,
  type ExperienceLearningProjectionProposal,
  type ExperienceLearningRuntimeEventPayload,
  type LearningArtifact,
} from "../runtime/learning/index.js";
import type { ExperienceLearningStateStore } from "../runtime/store/experience-learning-state-store.js";
import {
  createCognitionWritebackQueueEntry,
  type CognitionWritebackQueueStore,
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

export type ExperienceLearningProjectionEnqueueResult =
  | {
      status: "enqueued";
      proposal: ExperienceLearningProjectionProposal;
      queueEntry: CognitionWritebackQueueEntry;
      runtimeEventId: string;
    }
  | {
      status: "skipped";
      reasonCode: "artifact_not_promoted";
    };

export async function enqueueExperienceLearningProjectionForOwnerReview(input: {
  artifact: LearningArtifact;
  queueStore: CognitionWritebackQueueStore;
  learningStore: Pick<ExperienceLearningStateStore, "appendLifecycleEvent">;
  createdAt: string;
  target?: MemoryWritebackProposal["proposed_target"];
  queueEntryId?: string;
  proposalId?: string;
}): Promise<ExperienceLearningProjectionEnqueueResult> {
  if (input.artifact.status !== "promoted") {
    return { status: "skipped", reasonCode: "artifact_not_promoted" };
  }
  const queueEntry = await input.queueStore.enqueue(createExperienceLearningWritebackQueueEntry({
    artifact: input.artifact,
    queueEntryId: input.queueEntryId,
    createdAt: input.createdAt,
    ...(input.target ? { target: input.target } : {}),
  }));
  const correctionLineageRefs = correctionLineageRefsForArtifact(input.artifact);
  const proposal = ExperienceLearningProjectionProposalSchema.parse({
    id: input.proposalId ?? stableLearningId("learning-projection-proposal", [input.artifact.id, queueEntry.queue_entry_id]),
    sourceArtifactIds: [input.artifact.id],
    ownerReviewQueueRef: queueEntry.queue_entry_id,
    status: "queued",
    correctionLineageRefs,
    invalidationRefs: [],
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  });
  const append = await input.learningStore.appendLifecycleEvent(projectionEnqueuedPayload({
    artifact: input.artifact,
    proposal,
    correctionLineageRefs,
  }));
  return {
    status: "enqueued",
    proposal,
    queueEntry,
    runtimeEventId: append.runtimeEvent.event.event_id,
  };
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

function projectionEnqueuedPayload(input: {
  artifact: LearningArtifact;
  proposal: ExperienceLearningProjectionProposal;
  correctionLineageRefs: readonly string[];
}): Extract<ExperienceLearningRuntimeEventPayload, { event_kind: "projection_enqueued" }> {
  return {
    schema_version: "runtime-event-payload/experience-learning/v1",
    event_kind: "projection_enqueued",
    idempotency_key: `experience-learning:projection-enqueued:${input.proposal.id}`,
    goal_id: input.artifact.sourceGoalId,
    ...(input.artifact.sourceRunId ? { run_id: input.artifact.sourceRunId } : {}),
    source_refs: {
      evidence_refs: [...input.artifact.evidence.runtimeEvidenceRefs],
      event_refs: [],
      runtime_graph_refs: [],
    },
    trust: input.artifact.trust,
    correction_state: input.artifact.correctionState,
    redaction_class: "refs_only",
    graph: {
      node_refs: [
        { kind: "learning_projection_proposal", ref: input.proposal.id },
        { kind: "learning_artifact", ref: input.artifact.id },
      ],
      edge_refs: [],
    },
    projection_proposal_id: input.proposal.id,
    artifact_ids: [input.artifact.id],
    owner_review_queue_ref: input.proposal.ownerReviewQueueRef,
    correction_lineage_refs: [...input.correctionLineageRefs],
  };
}

function correctionLineageRefsForArtifact(artifact: LearningArtifact): string[] {
  return [
    artifact.correctionState.latest_correction_id,
    artifact.trust.correctionState.latest_correction_id,
  ].filter((ref): ref is string => typeof ref === "string" && ref.length > 0);
}
