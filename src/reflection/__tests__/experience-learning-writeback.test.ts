import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LearningArtifactSchema,
  defaultRuntimeEvidenceTrust,
  redactedLearningLabel,
  type LearningArtifact,
} from "../../runtime/learning/index.js";
import { ExperienceLearningStateStore } from "../../runtime/store/experience-learning-state-store.js";
import { FileCognitionWritebackQueueStore } from "../cognition-writeback-queue.js";
import {
  createExperienceLearningWritebackProposal,
  createExperienceLearningWritebackQueueEntry,
  enqueueExperienceLearningProjectionForOwnerReview,
} from "../experience-learning-writeback.js";

describe("experience learning owner-review writeback", () => {
  it("wraps promoted artifacts in owner-review queue contracts without owner writes", () => {
    const artifact = makeArtifact();
    const proposal = createExperienceLearningWritebackProposal({ artifact });
    expect(proposal).toEqual(expect.objectContaining({
      proposal_id: `writeback:experience-learning:${artifact.id}`,
      proposed_target: "reflection",
      auto_apply: false,
      source_content_materialized: false,
      source_event_refs: expect.arrayContaining([
        expect.objectContaining({
          ref: "runtime-evidence-1",
          source_store: "runtime_event_log",
          redaction_policy: "metadata_only",
        }),
        expect.objectContaining({
          ref: artifact.id,
          source_store: "runtime_event_log",
          redaction_policy: "metadata_only",
        }),
      ]),
    }));

    const entry = createExperienceLearningWritebackQueueEntry({
      artifact,
      createdAt: "2026-05-17T00:00:00.000Z",
    });
    expect(entry).toEqual(expect.objectContaining({
      queue_entry_id: `queue:experience-learning:${artifact.id}`,
      review_required: true,
      owner_write_performed: false,
      runtime_authority: false,
      state: "queued",
    }));
  });

  it("enqueues promoted artifacts through owner review and records a projection event", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "pulseed-experience-learning-writeback-"));
    const learningStore = new ExperienceLearningStateStore(join(tempDir, "runtime"), { controlBaseDir: tempDir });
    const queueStore = new FileCognitionWritebackQueueStore(tempDir);
    try {
      const artifact = makeArtifact();
      const result = await enqueueExperienceLearningProjectionForOwnerReview({
        artifact,
        learningStore,
        queueStore,
        createdAt: "2026-05-17T00:01:00.000Z",
      });

      expect(result.status).toBe("enqueued");
      if (result.status !== "enqueued") throw new Error("expected promoted artifact to enqueue");
      expect(result.queueEntry).toEqual(expect.objectContaining({
        queue_entry_id: `queue:experience-learning:${artifact.id}`,
        owner_write_performed: false,
        runtime_authority: false,
        state: "queued",
      }));
      await expect(queueStore.list()).resolves.toEqual([result.queueEntry]);
      await expect(learningStore.listProjectionProposals(artifact.id)).resolves.toEqual([
        expect.objectContaining({
          id: result.proposal.id,
          sourceArtifactIds: [artifact.id],
          ownerReviewQueueRef: result.queueEntry.queue_entry_id,
          status: "queued",
          correctionLineageRefs: [],
        }),
      ]);
    } finally {
      await learningStore.close();
      rmSync(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it("records projection events before enqueueing owner-review items", async () => {
    const artifact = makeArtifact();
    const appendLifecycleEvent = vi.fn().mockRejectedValue(new Error("projection write failed"));
    const enqueue = vi.fn().mockResolvedValue(createExperienceLearningWritebackQueueEntry({
      artifact,
      createdAt: "2026-05-17T00:01:00.000Z",
    }));

    await expect(enqueueExperienceLearningProjectionForOwnerReview({
      artifact,
      createdAt: "2026-05-17T00:01:00.000Z",
      queueStore: {
        enqueue,
        update: vi.fn(),
        list: vi.fn().mockResolvedValue([]),
      },
      learningStore: {
        appendLifecycleEvent,
      },
    })).rejects.toThrow("projection write failed");

    expect(appendLifecycleEvent).toHaveBeenCalledWith(expect.objectContaining({
      event_kind: "projection_enqueued",
      owner_review_queue_ref: `queue:experience-learning:${artifact.id}`,
    }));
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("does not enqueue tentative artifacts for owner review", async () => {
    const tentativeArtifact = LearningArtifactSchema.parse({
      ...makeArtifact(),
      id: "artifact-learning-tentative",
      status: "tentative",
      guardrails: {
        ...makeArtifact().guardrails,
        requiresFreshEvidenceBeforePromotion: true,
      },
    });
    const result = await enqueueExperienceLearningProjectionForOwnerReview({
      artifact: tentativeArtifact,
      createdAt: "2026-05-17T00:01:00.000Z",
      queueStore: {
        enqueue: async () => {
          throw new Error("tentative artifact must not enqueue");
        },
        update: async () => {
          throw new Error("tentative artifact must not update queue");
        },
        list: async () => [],
      },
      learningStore: {
        appendLifecycleEvent: async () => {
          throw new Error("tentative artifact must not append projection event");
        },
      },
    });

    expect(result).toEqual({ status: "skipped", reasonCode: "artifact_not_promoted" });
  });
});

function makeArtifact(): LearningArtifact {
  const trust = defaultRuntimeEvidenceTrust({
    targetRef: { kind: "learning_artifact", id: "artifact-learning-1" },
    provenanceRefs: ["runtime-evidence-1", "runtime-evidence-2"],
  });
  return LearningArtifactSchema.parse({
    id: "artifact-learning-1",
    sourceGoalId: "goal-learning",
    kind: "generalization_candidate",
    summary: redactedLearningLabel({
      label: "Promoted bounded learning artifact",
      sourceRefs: ["runtime-evidence-1", "runtime-evidence-2"],
    }),
    scope: { refs: { goalId: "goal-learning" } },
    evidence: {
      frameIds: ["frame-1", "frame-2"],
      hypothesisIds: ["hypothesis-1"],
      generalizationCandidateIds: ["candidate-1"],
      experimentPlanIds: ["plan-1"],
      experimentRecordIds: [],
      runtimeEvidenceRefs: ["runtime-evidence-1", "runtime-evidence-2"],
    },
    confidence: 0.7,
    status: "promoted",
    trust,
    correctionState: trust.correctionState,
    policyEffect: [],
    guardrails: {
      authorityClass: "planning_hint_only",
      cannotGrantAuthority: true,
      requiresFreshEvidenceBeforePromotion: false,
      contradictionRefs: [],
      falsificationPlanRefs: ["plan-1"],
    },
    createdAt: "2026-05-17T00:00:00.000Z",
    updatedAt: "2026-05-17T00:00:00.000Z",
  });
}
