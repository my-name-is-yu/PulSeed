import { describe, expect, it } from "vitest";
import {
  LearningArtifactSchema,
  defaultRuntimeEvidenceTrust,
  redactedLearningLabel,
  type LearningArtifact,
} from "../../runtime/learning/index.js";
import {
  createExperienceLearningWritebackProposal,
  createExperienceLearningWritebackQueueEntry,
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
