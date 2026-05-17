import { describe, expect, it } from "vitest";
import {
  GeneralizationCandidateSchema,
  LearningPriorResolver,
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

  it("requires governed user context and bounded payload for interaction-policy priors", () => {
    const base = {
      id: "suggestion-interaction",
      kind: "interaction_policy_bias" as const,
      consumerPhase: "next_iteration_directive" as const,
      targetRef: { kind: "interaction_policy" as const, id: "ask_confirmation" },
      rationale: redactedLearningLabel({ label: "Bound expression-mode bias", sourceRefs: ["evidence-1"] }),
      sourceArtifactIds: ["artifact-1"],
      evidenceRefs: ["evidence-1"],
      strength: 0.5,
      risk: "low" as const,
      expiresAt: "2026-05-18T00:00:00.000Z",
      maxUses: 2,
    };

    expect(() =>
      learningPriorSuggestion({
        ...base,
        sourceContext: { kind: "non_user_context", requestedUseClass: "expression_mode_selection" },
      })
    ).toThrow(/governed_user_context/);

    expect(() =>
      learningPriorSuggestion({
        ...base,
        sourceContext: {
          kind: "governed_user_context",
          requestedUseClass: "goal_planning",
          governedMemoryDecisionRef: "decision-1",
          governedMemoryUseAuditRef: "audit-1",
          governedMemoryDecisionStatus: "allowed",
          governedMemoryUseAuditOutcome: "allowed",
        },
      })
    ).toThrow(/expression_mode_selection/);

    expect(() =>
      learningPriorSuggestion({
        ...base,
        sourceContext: {
          kind: "governed_user_context",
          requestedUseClass: "expression_mode_selection",
          governedMemoryDecisionRef: "decision-1",
          governedMemoryUseAuditRef: "audit-1",
          governedMemoryDecisionStatus: "allowed",
          governedMemoryUseAuditOutcome: "allowed",
        },
      })
    ).toThrow(/bounded interactionPolicyBias payload/);
  });

  it("projects governed interaction-policy bias through immutable read refs and no surface authority", () => {
    const resolver = new LearningPriorResolver();
    const trust = defaultRuntimeEvidenceTrust({
      targetRef: { kind: "learning_prior", id: "prior-interaction" },
      provenanceRefs: ["evidence-1"],
    });
    const sourceContext = {
      kind: "governed_user_context" as const,
      requestedUseClass: "expression_mode_selection" as const,
      governedMemoryDecisionRef: "governed-memory-decision:accepted-expression-mode",
      governedMemoryUseAuditRef: "governed-memory-audit:accepted-expression-mode",
      governedMemoryDecisionStatus: "allowed" as const,
      governedMemoryUseAuditOutcome: "allowed" as const,
    };
    const prior = LearningPriorSnapshotSchema.parse({
      id: "prior-interaction",
      goalId: "goal-1",
      generatedAt: "2026-05-17T00:00:00.000Z",
      sourceLoopIndex: 1,
      eligibleFromIteration: 2,
      generationEventRef: "runtime-event-projection:experience-learning:prior-interaction",
      sourceCandidateTransitionIds: ["transition-1"],
      scope: { refs: { goalId: "goal-1" } },
      compatibility: {
        decision: "compatible",
        reasonCode: "matched_exact_refs",
        matchedRefs: ["goalId:goal-1"],
        missingRefs: [],
      },
      sourceArtifactIds: ["artifact-1"],
      suggestions: [
        learningPriorSuggestion({
          id: "suggestion-interaction",
          kind: "interaction_policy_bias",
          consumerPhase: "next_iteration_directive",
          targetRef: { kind: "interaction_policy", id: "ask_confirmation" },
          rationale: redactedLearningLabel({ label: "Bound expression-mode bias", sourceRefs: ["evidence-1"] }),
          sourceArtifactIds: ["artifact-1"],
          evidenceRefs: ["evidence-1"],
          strength: 0.5,
          risk: "low",
          expiresAt: "2026-05-18T00:00:00.000Z",
          maxUses: 2,
          sourceContext,
          interactionPolicyBias: {
            targetDecision: "ask_confirmation",
            direction: "increase",
            strength: 0.6,
            maxApplications: 3,
            decay: { kind: "uses", value: 2 },
            cooldown: { kind: "duration", value: "PT30M" },
            expiresAt: "2026-05-18T00:00:00.000Z",
            applicabilityPredicates: [{
              id: "predicate-1",
              kind: "applicability",
              subjectRef: "interaction-policy:ask_confirmation",
              signalRefs: ["evidence-1"],
              relation: "present",
              evaluatorPort: "companion_cognition_ref",
              confidence: 0.8,
              failureBoundary: "defer",
              diagnosticLabel: "accepted governed expression-mode context is current",
            }],
            successSignalRefs: ["success-signal-1"],
            failureSignalRefs: ["failure-signal-1"],
            companionCognitionRefs: ["companion-cognition:decision-1"],
            governedMemoryDecisionRef: sourceContext.governedMemoryDecisionRef,
            governedMemoryUseAuditRef: sourceContext.governedMemoryUseAuditRef,
            requiresAttentionAdmission: true,
            surfaceEligible: false,
            proactiveEligible: false,
          },
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
    });

    const result = resolver.resolveForPhase({
      prior,
      consumerPhase: "next_iteration_directive",
      consumerScope: { refs: { goalId: "goal-1" } },
      loopIndex: 2,
      consumerAttemptId: "attempt-1",
      consumerDecisionRef: "next-directive:goal-1:2",
      now: "2026-05-17T00:05:00.000Z",
    });

    expect(result.record.stage).toBe("reserved");
    expect(result.record.readSet.map((entry) => entry.port)).toEqual([
      "learning_prior_snapshot",
      "governed_memory_decision_snapshot",
      "governed_memory_use_audit_snapshot",
    ]);
    expect(result.projection).toEqual(expect.objectContaining({
      phase: "next_iteration_directive",
      projectionKind: "next_directive_mode_bias",
    }));
    expect(result.projection).toMatchObject({
      interactionPolicyBiases: [{
        priorId: "prior-interaction",
        suggestionId: "suggestion-interaction",
        targetDecision: "ask_confirmation",
        direction: "increase",
        boundedDelta: 0.2,
        strength: 0.5,
        maxUses: 2,
        cooldown: { kind: "duration", value: "PT30M" },
        requiresAttentionAdmission: true,
        surfaceEligible: false,
        proactiveEligible: false,
        successSignalRefs: ["success-signal-1"],
        failureSignalRefs: ["failure-signal-1"],
      }],
    });
  });
});
