import { createHash } from "node:crypto";
import {
  LearningPriorPhaseProjectionSchema,
  LearningPriorSnapshotSchema,
  type LearningPriorPhaseProjection,
  type LearningPriorSnapshot,
  type LearningPriorSuggestion,
} from "./learning-prior.js";
import {
  LearningPriorConsumptionRecordSchema,
  type LearningPriorConsumptionRecord,
} from "./learning-prior-consumption.js";
import { evaluateLearningScopeCompatibility, type LearningScope } from "./learning-scope.js";
import { isLearningTrustActivationAllowed } from "./learning-trust.js";

export interface LearningPriorResolverInput {
  prior: LearningPriorSnapshot;
  consumerPhase: LearningPriorSuggestion["consumerPhase"];
  consumerScope: LearningScope;
  loopIndex: number;
  consumerAttemptId: string;
  consumerDecisionRef: string;
  now?: string;
}

export interface LearningPriorResolverResult {
  record: LearningPriorConsumptionRecord;
  projection: LearningPriorPhaseProjection | null;
}

export class LearningPriorResolver {
  resolveForPhase(input: LearningPriorResolverInput): LearningPriorResolverResult {
    const prior = LearningPriorSnapshotSchema.parse(input.prior);
    const now = input.now ?? new Date().toISOString();
    const compatibility = evaluateLearningScopeCompatibility({
      source: prior.scope,
      consumer: input.consumerScope,
    });
    const suggestion = prior.suggestions.find((item) => item.consumerPhase === input.consumerPhase) ?? null;
    const reasonCodes: LearningPriorConsumptionRecord["reasonCodes"] = [];
    if (!suggestion) reasonCodes.push("scope_unknown");
    if (suggestion && Date.parse(suggestion.expiresAt) <= Date.parse(now)) reasonCodes.push("stale_or_expired");
    if (input.loopIndex < prior.eligibleFromIteration) reasonCodes.push("not_yet_eligible");
    if (compatibility.decision === "unknown") reasonCodes.push("scope_unknown");
    if (compatibility.decision === "conflict") reasonCodes.push("scope_conflict");
    if (!isLearningTrustActivationAllowed(prior.trust)) reasonCodes.push("trust_blocked");
    if (prior.suppressedByCorrectionIds.length > 0) reasonCodes.push("correction_blocked");
    if (prior.suppressedByQuarantineIds.length > 0) reasonCodes.push("quarantine_blocked");
    if (reasonCodes.length === 0) reasonCodes.push("eligible");

    const idempotencyKey = [
      prior.id,
      suggestion?.id ?? "none",
      input.consumerPhase,
      input.loopIndex,
      input.consumerDecisionRef,
    ].join(":");
    const record = LearningPriorConsumptionRecordSchema.parse({
      id: `learning-prior-consumption:${hash(idempotencyKey)}`,
      idempotencyKey,
      consumerAttemptId: input.consumerAttemptId,
      consumerDecisionRef: input.consumerDecisionRef,
      priorId: prior.id,
      suggestionId: suggestion?.id ?? "none",
      consumerPhase: input.consumerPhase,
      loopIndex: input.loopIndex,
      reservedAt: now,
      readSet: [{
        sourceKind: "runtime_event_projection",
        ref: prior.id,
        snapshotId: `prior-snapshot:${prior.id}`,
        runtimeEventProjectionRef: prior.generationEventRef,
        portSchemaVersion: "learning-prior-snapshot/v1",
        versionOrSequence: prior.generationEventRef,
        highWatermark: prior.generationEventRef,
        inputHash: hash(idempotencyKey),
        snapshotPayloadHash: hash(JSON.stringify(prior)),
        redactionClass: "refs_only",
        port: "learning_prior_snapshot",
      }],
      stage: reasonCodes.length === 1 && reasonCodes[0] === "eligible" ? "reserved" : "suppressed",
      reasonCodes,
      generatedDecisionRefs: [],
      runtimeGraphRefs: [],
    });

    if (!suggestion || record.stage === "suppressed") {
      return { record, projection: null };
    }

    const projection = LearningPriorPhaseProjectionSchema.parse(projectionForSuggestion(record.id, suggestion));
    return { record, projection };
  }
}

function projectionForSuggestion(consumptionRecordId: string, suggestion: LearningPriorSuggestion): LearningPriorPhaseProjection {
  switch (suggestion.consumerPhase) {
    case "knowledge_refresh":
      return {
        phase: "knowledge_refresh",
        projectionKind: "knowledge_refresh_evidence_target",
        consumptionRecordId,
        evidenceTargetRefs: suggestion.evidenceRefs,
        questionFocusRefs: suggestion.targetRef ? [`${suggestion.targetRef.kind}:${suggestion.targetRef.id}`] : [],
        queryBiasRefs: suggestion.sourceArtifactIds,
        generalizationBodies: [],
        suppressedSuggestionIds: [],
      };
    case "replanning_options":
      return {
        phase: "replanning_options",
        projectionKind: suggestion.kind === "planning_inhibition" ? "replanning_option_suppression" : "replanning_option_order_bias",
        consumptionRecordId,
        optionOrderBiasRefs: suggestion.kind === "strategy_preference" ? suggestion.sourceArtifactIds : [],
        preferStrategyRefs: suggestion.kind === "strategy_preference" ? suggestion.evidenceRefs : [],
        suppressStrategyRefs: suggestion.kind === "planning_inhibition" ? suggestion.evidenceRefs : [],
        suppressedOptionPatternRefs: suggestion.kind === "planning_inhibition" ? suggestion.sourceArtifactIds : [],
        generalizationCandidateRefs: suggestion.kind === "generalization_to_try" ? suggestion.sourceArtifactIds : [],
        generalizationBodies: [],
        suppressedSuggestionIds: [],
      };
    case "stall_detection":
    case "stall_investigation":
      return {
        phase: suggestion.consumerPhase,
        projectionKind: "stall_focus_bias",
        consumptionRecordId,
        focusEvidenceRefs: suggestion.evidenceRefs,
        blockedLoopPatternRefs: suggestion.kind === "planning_inhibition" ? suggestion.sourceArtifactIds : [],
        experimentPlanIds: suggestion.kind === "hypothesis_to_test" ? suggestion.sourceArtifactIds : [],
        generalizationBodies: [],
        suppressedSuggestionIds: [],
      };
    case "task_generation":
      return {
        phase: "task_generation",
        projectionKind: "task_generation_bias",
        consumptionRecordId,
        ...(suggestion.targetRef?.kind === "dimension" ? { preferredTargetDimension: suggestion.targetRef.id } : {}),
        taskBiasRefs: suggestion.kind === "strategy_preference" || suggestion.kind === "generalization_to_try" ? suggestion.evidenceRefs : [],
        avoidTaskPatternRefs: suggestion.kind === "planning_inhibition" ? suggestion.evidenceRefs : [],
        requiredExperimentPlanIds: suggestion.kind === "trial_reuse_experiment" ? suggestion.experimentPlanIds : [],
        generalizationBodies: [],
        suppressedSuggestionIds: [],
      };
    case "next_iteration_directive":
      return {
        phase: "next_iteration_directive",
        projectionKind: "next_directive_mode_bias",
        consumptionRecordId,
        ...(suggestion.targetRef?.kind === "dimension" ? { preferredFocusDimension: suggestion.targetRef.id } : {}),
        focusRefs: suggestion.kind === "phase_focus" ? suggestion.evidenceRefs : [],
        inhibitionRefs: suggestion.kind === "planning_inhibition" ? suggestion.evidenceRefs : [],
        directiveModeBiasRefs: suggestion.sourceArtifactIds,
        interactionPolicyBiases: [],
        suppressedSuggestionIds: [],
      };
  }
}

function hash(seed: string): string {
  return createHash("sha256").update(seed).digest("hex").slice(0, 16);
}
