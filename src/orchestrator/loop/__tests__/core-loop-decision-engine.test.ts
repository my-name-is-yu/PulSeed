import { describe, expect, it } from "vitest";
import { CoreDecisionEngine } from "../durable-loop/decision-engine.js";
import type { LoopIterationResult } from "../loop-result-types.js";

function makeIterationResult(overrides: Partial<LoopIterationResult> = {}): LoopIterationResult {
  return {
    loopIndex: 0,
    goalId: "goal-1",
    gapAggregate: 0.4,
    driveScores: [],
    taskResult: null,
    stallDetected: false,
    stallReport: null,
    pivotOccurred: false,
    completionJudgment: {
      is_complete: false,
      blocking_dimensions: ["dim1"],
      low_confidence_dimensions: [],
      needs_verification_task: false,
      checked_at: new Date().toISOString(),
    },
    elapsedMs: 0,
    error: null,
    ...overrides,
  };
}

describe("CoreDecisionEngine", () => {
  it("stops as completed only after minIterations is satisfied", () => {
    const engine = new CoreDecisionEngine();
    const decision = engine.evaluateRunDecision({
      iterationResult: makeIterationResult({
        completionJudgment: {
          is_complete: true,
          blocking_dimensions: [],
          low_confidence_dimensions: [],
          needs_verification_task: false,
          checked_at: new Date().toISOString(),
        },
      }),
      loopIndex: 1,
      minIterations: 2,
      maxConsecutiveErrors: 3,
      counters: {
        consecutiveErrors: 0,
        consecutiveDenied: 0,
        consecutiveEscalations: 0,
      },
    });

    expect(decision.shouldStop).toBe(true);
    expect(decision.finalStatus).toBe("completed");
  });

  it("stops as stalled when escalation level reaches 3", () => {
    const engine = new CoreDecisionEngine();
    const decision = engine.evaluateRunDecision({
      iterationResult: makeIterationResult({
        stallDetected: true,
        stallReport: {
          stall_type: "dimension_stall",
          goal_id: "goal-1",
          dimension_name: "dim1",
          task_id: null,
          detected_at: new Date().toISOString(),
          escalation_level: 3,
          suggested_cause: "approach_failure",
          decay_factor: 0.5,
        },
      }),
      loopIndex: 0,
      minIterations: 1,
      maxConsecutiveErrors: 3,
      counters: {
        consecutiveErrors: 0,
        consecutiveDenied: 0,
        consecutiveEscalations: 0,
      },
    });

    expect(decision.shouldStop).toBe(true);
    expect(decision.finalStatus).toBe("stalled");
  });

  it("stops as finalization when the deadline buffer requires handoff", () => {
    const engine = new CoreDecisionEngine();
    const decision = engine.evaluateRunDecision({
      iterationResult: makeIterationResult({
        finalizationStatus: {
          mode: "finalization",
          deadline: "2026-04-30T01:00:00.000Z",
          evaluated_at: "2026-04-30T00:45:00.000Z",
          remaining_ms: 15 * 60_000,
          reserved_finalization_ms: 30 * 60_000,
          remaining_exploration_ms: 0,
          consolidation_buffer_ms: 0,
          reason: "Inside finalization buffer.",
          finalization_plan: {
            deliverable_contract: "Prepare final report",
            best_artifact_selection: "best_evidence",
            best_artifact: null,
            reproducibility_manifest: {
              required: false,
              status: "not_required",
              reason: "Reproducibility manifest is not required by this finalization policy.",
            },
            verification_steps: [],
            approval_required_actions: [],
            handoff_required: false,
          },
        },
        skipped: true,
        skipReason: "deadline_finalization",
      }),
      loopIndex: 0,
      minIterations: 1,
      maxConsecutiveErrors: 3,
      counters: {
        consecutiveErrors: 0,
        consecutiveDenied: 0,
        consecutiveEscalations: 0,
      },
    });

    expect(decision.shouldStop).toBe(true);
    expect(decision.finalStatus).toBe("finalization");
  });

  it("requests knowledge acquisition only for worthwhile high-confidence refresh evidence", () => {
    const engine = new CoreDecisionEngine();
    const decision = engine.evaluateKnowledgeAcquisition({
      phase: {
        status: "completed",
        output: {
          summary: "Need migration constraints",
          required_knowledge: ["Database migration constraints"],
          acquisition_candidates: ["soil lookup"],
          confidence: 0.82,
          worthwhile: true,
        },
      },
      hasKnowledgeManager: true,
      hasToolExecutor: true,
    });

    expect(decision.shouldAcquire).toBe(true);
    expect(decision.question).toContain("Database migration constraints");
  });

  it("does not request knowledge acquisition for low-confidence refresh evidence", () => {
    const engine = new CoreDecisionEngine();
    const decision = engine.evaluateKnowledgeAcquisition({
      phase: {
        status: "low_confidence",
        output: {
          summary: "Maybe need more info",
          required_knowledge: ["Something vague"],
          acquisition_candidates: [],
          confidence: 0.4,
          worthwhile: true,
        },
      },
      hasKnowledgeManager: true,
      hasToolExecutor: true,
    });

    expect(decision.shouldAcquire).toBe(false);
  });

  it("builds task generation hints from high-confidence replanning evidence", () => {
    const engine = new CoreDecisionEngine();
    const hints = engine.buildTaskGenerationHints({
      phase: {
        status: "completed",
        output: {
          summary: "Prefer the focused path",
          recommended_action: "pivot",
          candidates: [
            {
              title: "Patch dim1 first",
              rationale: "smallest fix",
              expected_evidence_gain: "high",
              blast_radius: "low",
              target_dimensions: ["dim1"],
              dependencies: [],
            },
          ],
          confidence: 0.9,
        },
      },
      goalDimensions: ["dim1", "dim2"],
    });

    expect(hints.targetDimensionOverride).toBe("dim1");
    expect(hints.knowledgeContextPrefix).toContain("Replanning directive:");
    expect(hints.knowledgeContextPrefix).toContain("Patch dim1 first");
  });

  it("builds stall action hints from high-confidence replanning evidence", () => {
    const engine = new CoreDecisionEngine();
    const hints = engine.buildStallActionHints({
      phase: {
        status: "completed",
        output: {
          summary: "Stay on current course",
          recommended_action: "continue",
          candidates: [
            {
              title: "Keep current path",
              rationale: "smallest change",
              expected_evidence_gain: "medium",
              blast_radius: "low",
              target_dimensions: [],
              dependencies: [],
            },
          ],
          confidence: 0.9,
        },
      },
    });

    expect(hints.recommendedAction).toBe("continue");
  });

  it("builds next-iteration directive from replanning evidence", () => {
    const engine = new CoreDecisionEngine();
    const directive = engine.buildNextIterationDirective({
      knowledgeRefreshPhase: null,
      replanningPhase: {
        status: "completed",
        output: {
          summary: "Shift to dim1",
          recommended_action: "pivot",
          candidates: [
            {
              title: "Focus dim1",
              rationale: "best payoff",
              expected_evidence_gain: "high",
              blast_radius: "low",
              target_dimensions: ["dim1"],
              dependencies: [],
            },
          ],
          confidence: 0.9,
        },
      },
      goalDimensions: ["dim1", "dim2"],
      fallbackFocusDimension: "dim2",
    });

    expect(directive).toEqual(
      expect.objectContaining({
        sourcePhase: "replanning_options",
        focusDimension: "dim1",
        preferredAction: "pivot",
      })
    );
  });

  it("builds learning-prior directives through typed refs without raw prior text transport", () => {
    const engine = new CoreDecisionEngine();
    const directive = engine.buildNextIterationDirective({
      learningProjection: {
        phase: "next_iteration_directive",
        projectionKind: "next_directive_mode_bias",
        consumptionRecordId: "consumption-1",
        preferredFocusDimension: "dim-prior",
        focusRefs: ["evidence-1"],
        inhibitionRefs: [],
        directiveModeBiasRefs: ["artifact-1"],
        interactionPolicyBiases: [{
          priorId: "prior-1",
          suggestionId: "suggestion-1",
          consumptionRecordId: "consumption-1",
          targetDecision: "ask_confirmation",
          direction: "increase",
          boundedDelta: 0.1,
          strength: 0.5,
          expiresAt: "2026-05-18T00:00:00.000Z",
          maxUses: 1,
          cooldown: { kind: "duration", value: "PT30M" },
          requiresAttentionAdmission: true,
          surfaceEligible: false,
          proactiveEligible: false,
          successSignalRefs: ["success-signal-1"],
          failureSignalRefs: ["failure-signal-1"],
        }],
        suppressedSuggestionIds: [],
      },
      knowledgeRefreshPhase: null,
      replanningPhase: null,
      goalDimensions: ["dim1", "dim-prior"],
      fallbackFocusDimension: "dim1",
    });

    expect(directive).toEqual(expect.objectContaining({
      sourcePhase: "learning_prior",
      reason: "learning_prior_phase_projection",
      focusDimension: "dim-prior",
      learning_prior_consumption_ref: "consumption-1",
      focus_refs: ["evidence-1"],
      interaction_policy_biases: [expect.objectContaining({
        targetDecision: "ask_confirmation",
        boundedDelta: 0.1,
        requiresAttentionAdmission: true,
        surfaceEligible: false,
        proactiveEligible: false,
      })],
    }));
    expect(directive?.reason).not.toContain("artifact-1");
  });

  it("preserves worthwhile knowledge-refresh directives when attaching learning-prior projection refs", () => {
    const engine = new CoreDecisionEngine();
    const directive = engine.buildNextIterationDirective({
      learningProjection: {
        phase: "next_iteration_directive",
        projectionKind: "next_directive_mode_bias",
        consumptionRecordId: "consumption-knowledge-prior",
        preferredFocusDimension: "dim-prior",
        focusRefs: ["evidence-prior"],
        inhibitionRefs: ["inhibition-prior"],
        directiveModeBiasRefs: ["artifact-prior"],
        interactionPolicyBiases: [],
        suppressedSuggestionIds: [],
      },
      knowledgeRefreshPhase: {
        status: "completed",
        output: {
          summary: "Acquire current missing API evidence",
          required_knowledge: ["current API contract"],
          acquisition_candidates: ["official docs"],
          confidence: 0.92,
          worthwhile: true,
        },
      },
      replanningPhase: null,
      goalDimensions: ["dim1", "dim-prior"],
      fallbackFocusDimension: "dim1",
    });

    expect(directive).toEqual(expect.objectContaining({
      sourcePhase: "knowledge_refresh",
      requestedPhase: "knowledge_refresh",
      reason: "Acquire current missing API evidence",
      focusDimension: "dim-prior",
      learning_prior_consumption_ref: "consumption-knowledge-prior",
      phase_projection_ref: "learning-prior-projection:consumption-knowledge-prior",
      focus_refs: ["evidence-prior"],
      inhibition_refs: ["inhibition-prior"],
    }));
  });
});
