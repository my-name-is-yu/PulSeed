import { createHash } from "node:crypto";
import {
  InteractionPolicyBiasProjectionSchema,
  LearningPriorPhaseProjectionSchema,
  LearningPriorSnapshotSchema,
  type InteractionPolicyBiasProjection,
  type LearningPriorPhaseProjection,
  type LearningPriorSnapshot,
  type LearningPriorSuggestion,
} from "./learning-prior.js";
import {
  LearningPriorConsumptionRecordSchema,
  type LearningPriorConsumptionRecord,
  type LearningPriorConsumptionReadSetEntry,
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
      readSet: priorConsumptionReadSet({ prior, suggestion, idempotencyKey }),
      stage: reasonCodes.length === 1 && reasonCodes[0] === "eligible" ? "reserved" : "suppressed",
      reasonCodes,
      generatedDecisionRefs: [],
      runtimeGraphRefs: [],
    });

    if (!suggestion || record.stage === "suppressed") {
      return { record, projection: null };
    }

    const projection = LearningPriorPhaseProjectionSchema.parse(projectionForSuggestion(record.id, prior, suggestion));
    return { record, projection };
  }
}

function projectionForSuggestion(
  consumptionRecordId: string,
  prior: LearningPriorSnapshot,
  suggestion: LearningPriorSuggestion,
): LearningPriorPhaseProjection {
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
        experimentPlanIds: suggestion.kind === "hypothesis_to_test" ? suggestion.experimentPlanIds : [],
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
        interactionPolicyBiases: interactionPolicyBiasProjections({ prior, suggestion, consumptionRecordId }),
        suppressedSuggestionIds: [],
      };
  }
}

function priorConsumptionReadSet(input: {
  prior: LearningPriorSnapshot;
  suggestion: LearningPriorSuggestion | null;
  idempotencyKey: string;
}): LearningPriorConsumptionReadSetEntry[] {
  const readSet: LearningPriorConsumptionReadSetEntry[] = [{
    sourceKind: "runtime_event_projection",
    ref: input.prior.id,
    snapshotId: `prior-snapshot:${input.prior.id}`,
    runtimeEventProjectionRef: input.prior.generationEventRef,
    portSchemaVersion: "learning-prior-snapshot/v1",
    versionOrSequence: input.prior.generationEventRef,
    highWatermark: input.prior.generationEventRef,
    inputHash: hash(input.idempotencyKey),
    snapshotPayloadHash: hash(JSON.stringify(input.prior)),
    redactionClass: "refs_only",
    port: "learning_prior_snapshot",
  }];

  if (input.suggestion?.sourceContext.kind === "governed_user_context") {
    const sourceContext = input.suggestion.sourceContext;
    readSet.push(
      governedReadSetEntry({
        port: "governed_memory_decision_snapshot",
        ref: sourceContext.governedMemoryDecisionRef,
        schemaVersion: "governed-memory-use-decision/v1",
        idempotencyKey: input.idempotencyKey,
        requestedUseClass: sourceContext.requestedUseClass,
        acceptedState: sourceContext.governedMemoryDecisionStatus,
      }),
      governedReadSetEntry({
        port: "governed_memory_use_audit_snapshot",
        ref: sourceContext.governedMemoryUseAuditRef,
        schemaVersion: "governed-memory-use-audit/v1",
        idempotencyKey: input.idempotencyKey,
        requestedUseClass: sourceContext.requestedUseClass,
        acceptedState: sourceContext.governedMemoryUseAuditOutcome,
      })
    );
  }

  return readSet;
}

function governedReadSetEntry(input: {
  port: "governed_memory_decision_snapshot" | "governed_memory_use_audit_snapshot";
  ref: string;
  schemaVersion: string;
  idempotencyKey: string;
  requestedUseClass: string;
  acceptedState: string;
}): LearningPriorConsumptionReadSetEntry {
  return {
    sourceKind: "snapshot_event",
    ref: input.ref,
    snapshotId: `${input.port}:${input.ref}`,
    snapshotEventRef: input.ref,
    portSchemaVersion: input.schemaVersion,
    versionOrSequence: input.ref,
    highWatermark: input.ref,
    inputHash: hash(`${input.idempotencyKey}:${input.port}`),
    snapshotPayloadHash: hash(JSON.stringify({
      ref: input.ref,
      requestedUseClass: input.requestedUseClass,
      acceptedState: input.acceptedState,
    })),
    redactionClass: "refs_only",
    port: input.port,
  };
}

function interactionPolicyBiasProjections(input: {
  prior: LearningPriorSnapshot;
  suggestion: LearningPriorSuggestion;
  consumptionRecordId: string;
}): InteractionPolicyBiasProjection[] {
  if (input.suggestion.kind !== "interaction_policy_bias" || !input.suggestion.interactionPolicyBias) {
    return [];
  }

  const body = input.suggestion.interactionPolicyBias;
  return [
    InteractionPolicyBiasProjectionSchema.parse({
      priorId: input.prior.id,
      suggestionId: input.suggestion.id,
      consumptionRecordId: input.consumptionRecordId,
      targetDecision: body.targetDecision,
      direction: body.direction,
      boundedDelta: Math.min(0.2, body.strength * input.suggestion.strength),
      strength: input.suggestion.strength,
      expiresAt: earlierIso(input.suggestion.expiresAt, body.expiresAt),
      maxUses: Math.min(input.suggestion.maxUses, body.maxApplications),
      cooldown: body.cooldown,
      requiresAttentionAdmission: true,
      surfaceEligible: false,
      proactiveEligible: false,
      successSignalRefs: body.successSignalRefs,
      failureSignalRefs: body.failureSignalRefs,
    }),
  ];
}

function earlierIso(first: string, second: string): string {
  return Date.parse(first) <= Date.parse(second) ? first : second;
}

function hash(seed: string): string {
  return createHash("sha256").update(seed).digest("hex").slice(0, 16);
}
