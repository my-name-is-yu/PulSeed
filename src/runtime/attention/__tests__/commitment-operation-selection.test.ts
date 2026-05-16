import { describe, expect, it } from "vitest";
import {
  buildAttentionAdmissionCandidates,
  buildCommitmentGuardAttentionFromCandidates,
  commitmentCandidateToUrge,
  createAttentionClusterFromUrge,
  createCommitmentCandidate,
  CommitmentCandidateExtractionSchema,
  decomposeAgenda,
  evaluateCommitmentOperationsForAttentionAdmissions,
  projectClustersToAgenda,
  projectCommitmentBoundaryToPeerCandidate,
  projectCommitmentWhyNowForNormalSurface,
  promoteAttentionClusters,
  ref,
} from "../index.js";
import type { AttentionScope } from "../../types/companion-autonomy.js";
import type { ResidentOperationBoundaryResult } from "../../capability-operation-planner.js";

const NOW = "2026-05-17T00:00:00.000Z";

function scope(overrides: Partial<AttentionScope> = {}): AttentionScope {
  return {
    userId: "user-1",
    identityId: "identity-1",
    workspaceId: "workspace-1",
    conversationId: "conversation-1",
    sessionId: "session-1",
    surfaceClass: "telegram",
    surfaceRef: "surface:telegram",
    permissionScope: "read_only",
    sensitivity: "medium",
    memoryOwner: null,
    policyEpoch: "policy:commitment-test",
    ...overrides,
  };
}

function commitmentCandidate(overrides: {
  state?: "shadow_held" | "watching" | "active_care" | "quieted" | "resolved";
  highLoad?: boolean;
  overreach?: boolean;
  permissionScope?: AttentionScope["permissionScope"];
} = {}) {
  const candidate = createCommitmentCandidate({
    extraction: CommitmentCandidateExtractionSchema.parse({
      outcome: "candidate",
      summary: "Review the pitch deck tomorrow.",
      due: {
        window_start: "2026-05-18T00:00:00.000Z",
        window_end: "2026-05-18T12:00:00.000Z",
        uncertainty: "medium",
        reason: "user mentioned tomorrow",
      },
      owner: "user",
      confidence: 0.82,
      sensitivity: "internal",
      allowed_memory_use: "attention_only",
      nudge_policy: "allowed",
      watch_vector: ["deadline", "mood_load", "related_conversation"],
      user_state: {
        high_load: overrides.highLoad ?? false,
        tired: overrides.highLoad ?? false,
        overreach_feedback: overrides.overreach ?? false,
      },
    }),
    scope: scope({ permissionScope: overrides.permissionScope ?? "read_only" }),
    turnId: "turn-1",
    sessionId: "session-1",
    sourceId: "chat:session-1:turn-1:user",
    emittedAt: NOW,
    policyEpoch: "policy:commitment-test",
    activeSurfaceRef: ref("surface", "surface:telegram"),
  });
  expect(candidate).not.toBeNull();
  return {
    ...candidate!,
    materialization_state: overrides.state ?? candidate!.materialization_state,
    next_revisit_at: NOW,
  };
}

describe("commitment operation selection", () => {
  it("keeps tired and overreach commitment candidates held with replayable priority evidence", () => {
    const candidate = commitmentCandidate({ highLoad: true, overreach: true });
    const urge = commitmentCandidateToUrge({ candidate, now: NOW });

    expect(candidate.materialization_state).toBe("shadow_held");
    expect(candidate.priority_evidence.components.interruptibility_penalty.score).toBeGreaterThan(0.7);
    expect(candidate.priority_evidence.components.recent_nudge_penalty.score).toBeGreaterThan(0.7);
    expect(urge).toMatchObject({
      target: { kind: "commitment", id: candidate.commitment_id },
      feeling: "repair_pressure",
      priority_evidence: expect.objectContaining({
        evidence_id: candidate.priority_evidence.evidence_id,
      }),
    });
    expect(urge.forbidden_moves).toEqual(expect.arrayContaining(["ask", "speak", "external_side_effect"]));
    const whyNow = projectCommitmentWhyNowForNormalSurface(candidate).toLowerCase();
    for (const hiddenToken of ["policy", "memory", "trace", "chat:"]) {
      expect(whyNow.includes(hiddenToken)).toBe(false);
    }
  });

  it("turns active watched commitments into commitment_guard agenda and boundary-gated followup plans", () => {
    const candidate = commitmentCandidate({ state: "active_care" });
    const provider = buildCommitmentGuardAttentionFromCandidates({
      candidates: [candidate],
      now: NOW,
      triggerKind: "revisit_window",
    });
    const [cluster] = promoteAttentionClusters({
      clusters: [createAttentionClusterFromUrge(provider.urgeCandidates[0]!, NOW)],
      now: NOW,
    });
    const [agenda] = projectClustersToAgenda({ clusters: cluster ? [cluster] : [], now: NOW });
    const [decomposition] = decomposeAgenda({ agendaItems: agenda ? [agenda] : [], now: NOW });
    const admissions = buildAttentionAdmissionCandidates({
      decompositions: decomposition ? [decomposition] : [],
      now: NOW,
    });

    expect(agenda).toMatchObject({
      kind: "commitment_guard",
      carePosture: "prepare",
      priority_evidence: expect.objectContaining({
        evidence_id: candidate.priority_evidence.evidence_id,
      }),
    });
    expect(decomposition).toMatchObject({
      agendaKind: "commitment_guard",
      commitmentLifecycle: "proposed",
    });
    expect(admissions.map((admission) => admission.parentAgendaKind)).toEqual(
      expect.arrayContaining(["commitment_guard"])
    );
    expect(admissions.some((admission) => admission.child.childType === "prepare")).toBe(true);

    const outcomes = evaluateCommitmentOperationsForAttentionAdmissions({
      candidates: admissions,
      assembledAt: NOW,
      surfaceRef: "surface:telegram",
    });
    const prepared = outcomes.find((outcome) => outcome.outcome === "prepared");

    expect(prepared).toMatchObject({
      outcome: "prepared",
      family: "attention.commitment.prepare_followup",
      boundary: expect.objectContaining({
        admission_evaluation: expect.any(Object),
        autonomy_decision: expect.any(Object),
        preparation_allowed: true,
      }),
      peerCandidate: expect.objectContaining({
        action_plan: expect.objectContaining({
          mode: "internal_preparation",
          preparation_kind: "followup_candidate",
        }),
        max_delivery_kind: "suggest",
      }),
    });
    expect(prepared?.boundary.assembly.candidate_plans[0]?.operation_plan.operation_id)
      .toContain("attention.commitment.prepare_followup");
  });

  it("fails closed before peer projection when boundary evidence is missing", () => {
    const candidate = commitmentCandidate({ state: "active_care" });
    const urge = commitmentCandidateToUrge({ candidate, now: NOW });
    const [decomposition] = decomposeAgenda({
      agendaItems: projectClustersToAgenda({
        clusters: promoteAttentionClusters({
          clusters: [createAttentionClusterFromUrge(urge, NOW)],
          now: NOW,
        }),
        now: NOW,
      }),
      now: NOW,
    });
    const admissions = buildAttentionAdmissionCandidates({
      decompositions: decomposition ? [decomposition] : [],
      now: NOW,
    });
    const fakeBoundary: ResidentOperationBoundaryResult = {
      assembly: {
        schema_version: "capability-operation-plan-assembly/v1",
        assembly_id: "assembly:missing-evidence",
        assembled_at: NOW,
        source: {
          kind: "attention_projection",
          source_ref: "test",
          emitted_at: NOW,
          metadata: {},
        },
        status: "planned",
        reason: "test boundary omitted decisions",
        candidate_plans: [],
      },
      preparation_allowed: true,
      execution_allowed: false,
    };

    const outcomes = evaluateCommitmentOperationsForAttentionAdmissions({
      candidates: admissions,
      assembledAt: NOW,
      boundaryEvaluator: () => fakeBoundary,
    });

    expect(outcomes).toContainEqual(expect.objectContaining({
      outcome: "blocked",
      reason: "commitment operation boundary did not produce admission and autonomy evidence",
    }));
    expect(projectCommitmentBoundaryToPeerCandidate({
      candidate: admissions[0]!,
      family: "attention.commitment.prepare_followup",
      boundary: fakeBoundary,
      assembledAt: NOW,
    })).toBeNull();
  });
});
