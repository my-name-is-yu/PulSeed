import { describe, expect, it } from "vitest";
import {
  GeneralizationCandidateSchema,
  LearningPriorSnapshotSchema,
  MicroProbeRecordSchema,
  RedactedLearningTextSchema,
  TrialReuseReadinessGateSchema,
  defaultRuntimeEvidenceTrust,
  learningPriorSuggestion,
  redactedLearningLabel,
} from "../../src/runtime/learning/index.js";

describe("experience learning contracts", () => {
  it("rejects raw private text in durable redacted learning fields", () => {
    expect(() =>
      RedactedLearningTextSchema.parse({
        label: "raw tool output: SECRET_TOKEN=abc",
        redactionClass: "diagnostic_label",
        sourceRefs: ["evidence-raw"],
        maxLength: 120,
      })
    ).toThrow(/must not persist/);
  });

  it("fails closed for active learning objects with contradicted trust", () => {
    const trust = defaultRuntimeEvidenceTrust({
      targetRef: { kind: "generalization_candidate", id: "candidate-1" },
      verificationStatus: "contradicted",
      provenanceRefs: ["evidence-1"],
    });

    expect(() =>
      GeneralizationCandidateSchema.parse({
        id: "candidate-1",
        goalId: "goal-1",
        kind: "anti_pattern",
        statement: redactedLearningLabel({ label: "Avoid repeated failed action", sourceRefs: ["evidence-1"] }),
        body: {
          kind: "anti_pattern_inhibition",
          failurePatternRefs: ["evidence-1"],
          nonApplicabilityPredicates: [],
          reuseProposalKind: "avoid_pattern",
          reuseProposal: {
            proposalKind: "avoid_pattern",
            consumerPhase: "task_generation",
            actionBiasRefs: [],
            strategyBiasRefs: [],
            expectedDeltaRefs: [],
            inhibitionRefs: ["evidence-1"],
            experimentPlanRefs: [],
          },
        },
        scope: { refs: { goalId: "goal-1" } },
        status: "trial_reuse_ready",
        sourceHypothesisIds: ["hypothesis-1"],
        competingHypothesisIds: [],
        supportRefs: ["evidence-1"],
        counterexampleRefs: [],
        nearMissRefs: [],
        applicabilitySignalRefs: ["evidence-1"],
        nonApplicabilitySignalRefs: [],
        predictedOutcomeDeltaRefs: [],
        invariantRefs: [],
        transferScopes: [{
          scopeRef: "goal:goal-1",
          status: "trial_allowed",
          invariantMatchRefs: ["evidence-1"],
          applicabilityMatchRefs: ["evidence-1"],
          maxTrials: 1,
          attempts: 0,
          successRefs: [],
          negativeTransferRefs: [],
        }],
        compressionScore: 0.6,
        expectedInformationGain: 0.7,
        transferPotential: 0.5,
        overfitRisk: "medium",
        readinessGateIds: ["gate-1"],
        trust,
        correctionState: trust.correctionState,
        createdAt: "2026-05-17T00:00:00.000Z",
        updatedAt: "2026-05-17T00:00:00.000Z",
      })
    ).toThrow(/requires active/);
  });

  it("prevents micro-probe self-confirmation from becoming support", () => {
    const trust = defaultRuntimeEvidenceTrust({
      targetRef: { kind: "micro_probe_record", id: "record-1" },
      provenanceRefs: ["evidence-1"],
    });
    expect(() =>
      MicroProbeRecordSchema.parse({
        id: "record-1",
        planId: "plan-1",
        ranAt: "2026-05-17T00:00:00.000Z",
        outcome: "supported",
        supportEvidenceRefs: ["evidence-1"],
        contradictionEvidenceRefs: [],
        supportEventRefs: [],
        supportRuntimeGraphRefs: [],
        usedIndependentSupport: false,
        replayFingerprint: "replay",
        correctionFilterDecision: "current",
        readSetFingerprint: "readset",
        trust,
      })
    ).toThrow(/self-confirming/);
  });

  it("requires TrialReuseReadinessGate for trial_reuse_ready and N+1 eligibility", () => {
    expect(() =>
      TrialReuseReadinessGateSchema.parse({
        id: "gate-1",
        candidateId: "candidate-1",
        sourceLoopIndex: 2,
        eligibleFromIteration: 2,
        sourceTransitionId: "transition-1",
        disjointSupportRefs: ["evidence-2"],
        actionShape: "reversible",
        risk: "low",
        scopeDecision: "exact",
        transferScopeRef: "goal:goal-1",
        trialReuseBudgetId: "budget-1",
        remainingTrialUses: 1,
        decision: "ready",
        reasonCodes: ["ready"],
      })
    ).toThrow(/N\+1/);
  });

  it("suppresses unknown-scope priors and factory-derives blocked authority classes", () => {
    const trust = defaultRuntimeEvidenceTrust({
      targetRef: { kind: "learning_prior", id: "prior-1" },
      provenanceRefs: ["evidence-1"],
    });
    expect(() =>
      LearningPriorSnapshotSchema.parse({
        id: "prior-1",
        goalId: "goal-1",
        generatedAt: "2026-05-17T00:00:00.000Z",
        sourceLoopIndex: 1,
        eligibleFromIteration: 2,
        generationEventRef: "event-1",
        sourceCandidateTransitionIds: ["transition-1"],
        scope: { refs: { goalId: "goal-1" } },
        compatibility: {
          decision: "unknown",
          reasonCode: "unknown_scope",
          matchedRefs: [],
          missingRefs: ["goalId"],
        },
        sourceArtifactIds: ["artifact-1"],
        suggestions: [
          learningPriorSuggestion({
            id: "suggestion-1",
            kind: "trial_reuse_experiment",
            consumerPhase: "task_generation",
            rationale: redactedLearningLabel({ label: "Try bounded reuse", sourceRefs: ["evidence-1"] }),
            sourceArtifactIds: ["artifact-1"],
            evidenceRefs: ["evidence-1"],
            strength: 0.5,
            risk: "low",
            expiresAt: "2026-05-18T00:00:00.000Z",
            maxUses: 1,
            sourceContext: { kind: "non_user_context", requestedUseClass: "goal_planning" },
          }),
        ],
        staleOrFalsifiedArtifactIds: [],
        suppressedByCorrectionIds: [],
        suppressedByQuarantineIds: [],
        trust,
        sourceTrustStates: [],
        filterDecision: {
          decision: "activated",
          reasonCodes: ["eligible"],
          evaluatedAt: "2026-05-17T00:00:00.000Z",
        },
        confidence: 0.7,
      })
    ).toThrow(/unknown or conflicting scope/);
  });
});
