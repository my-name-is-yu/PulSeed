import type { Goal } from "../../../base/types/goal.js";
import type { RuntimeEvidenceEntry } from "../../../runtime/store/evidence-ledger.js";
import {
  ExperienceLearningStateStore,
} from "../../../runtime/store/experience-learning-state-store.js";
import {
  ExperienceFrameSchema,
  CandidateTransitionSchema,
  GeneralizationCandidateSchema,
  LearningArtifactSchema,
  LearningExperimentPlanSchema,
  LearningHypothesisSchema,
  LearningPriorSnapshotSchema,
  MicroProbePlanSchema,
  TrialReuseBudgetConsumptionRecordSchema,
  TrialReuseReadinessGateSchema,
  defaultRuntimeEvidenceTrust,
  learningPriorSuggestion,
  redactedLearningLabel,
  runNoOutwardEffectMicroProbe,
  stableLearningId,
  type CandidateTransition,
  type ExperienceFrame,
  type ExperienceFrameTrigger,
  type ExperienceLearningRuntimeEventPayload,
  type ExperimentValueScore,
  type GeneralizationCandidate,
  type LearningArtifact,
  type LearningExperimentPlan,
  type LearningHypothesis,
  type LearningPriorSnapshot,
  type MicroProbePlan,
  type MicroProbeReadSetEntry,
  type MicroProbeRecord,
  type TrialReuseBudgetConsumptionRecord,
  type TrialReuseReadinessGate,
} from "../../../runtime/learning/index.js";
import type { LoopIterationResult } from "../loop-result-types.js";

export interface ExperienceLearningBridgeInput {
  goal: Goal | null;
  goalId: string;
  runId?: string;
  loopIndex: number;
  result: LoopIterationResult;
  iterationEvidence: readonly RuntimeEvidenceEntry[];
  dryRun: boolean;
  hasEvidenceLedger: boolean;
}

export interface ExperienceLearningBridgeResult {
  status: "processed" | "noop" | "failed";
  reasonCode?: "dry_run" | "no_evidence_ledger" | "no_exact_iteration_evidence" | "no_learning_trigger" | "bridge_error";
  frameIds: string[];
  runtimeEventIds: string[];
  error?: string;
}

export interface ExperienceLearningBridgePort {
  processIteration(input: ExperienceLearningBridgeInput): Promise<ExperienceLearningBridgeResult>;
}

export class ExperienceLearningBridge implements ExperienceLearningBridgePort {
  constructor(private readonly store: ExperienceLearningStateStore) {}

  async processIteration(input: ExperienceLearningBridgeInput): Promise<ExperienceLearningBridgeResult> {
    if (input.dryRun) return noop("dry_run");
    if (!input.hasEvidenceLedger) return noop("no_evidence_ledger");
    if (input.iterationEvidence.length === 0) return noop("no_exact_iteration_evidence");

    const trigger = selectFrameTrigger(input.result);
    if (!trigger) return noop("no_learning_trigger");

    const frame = buildExperienceFrame(input, trigger);
    const payload = frameActivatedPayload(frame, input);
    const append = await this.store.appendLifecycleEvent(payload);
    const runtimeEventIds = [append.runtimeEvent.event.event_id];
    const frames = await this.store.listFrames(input.goalId);
    const existingCandidates = await this.store.listGeneralizationCandidates(input.goalId);
    for (const derivedPayload of buildDerivedLifecyclePayloads(input, trigger, frame, frames, existingCandidates)) {
      const derivedAppend = await this.store.appendLifecycleEvent(derivedPayload);
      runtimeEventIds.push(derivedAppend.runtimeEvent.event.event_id);
    }
    return {
      status: "processed",
      frameIds: [frame.id],
      runtimeEventIds,
    };
  }
}

export async function recordExperienceLearningCheckpoint(input: {
  bridge?: ExperienceLearningBridgePort;
  goal: Goal | null;
  goalId: string;
  runId?: string;
  loopIndex: number;
  result: LoopIterationResult;
  iterationEvidence: readonly RuntimeEvidenceEntry[];
  dryRun: boolean;
  hasEvidenceLedger: boolean;
  logger?: { warn(message: string, data?: Record<string, unknown>): void };
}): Promise<void> {
  if (!input.bridge) return;
  try {
    const bridgeResult = await input.bridge.processIteration({
      goal: input.goal,
      goalId: input.goalId,
      runId: input.runId,
      loopIndex: input.loopIndex,
      result: input.result,
      iterationEvidence: input.iterationEvidence,
      dryRun: input.dryRun,
      hasEvidenceLedger: input.hasEvidenceLedger,
    });
    input.result.experienceLearning = bridgeResult;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    input.result.experienceLearning = { status: "failed", reasonCode: "bridge_error", frameIds: [], runtimeEventIds: [], error: message };
    input.logger?.warn("DurableLoop: experience learning bridge failed", {
      goalId: input.goalId,
      loopIndex: input.loopIndex,
      error: message,
    });
  }
}

function noop(reasonCode: NonNullable<ExperienceLearningBridgeResult["reasonCode"]>): ExperienceLearningBridgeResult {
  return { status: "noop", reasonCode, frameIds: [], runtimeEventIds: [] };
}

function selectFrameTrigger(result: LoopIterationResult): ExperienceFrameTrigger | null {
  if (result.error) return "contradiction";
  if (result.taskResult && result.taskResult.action !== "completed") return "repeated_failure";
  if (result.toolVerification && !result.toolVerification.mechanicalPassed) return "verification_result";
  if (result.stallDetected) return "bottleneck";
  if (result.metricTrendContext) return "high_uncertainty";
  if (result.nextIterationDirective) return "goal_signal";
  return null;
}

function buildExperienceFrame(input: ExperienceLearningBridgeInput, trigger: ExperienceFrameTrigger): ExperienceFrame {
  const evidenceRefs = input.iterationEvidence.map((entry) => entry.id).sort();
  const frameId = stableLearningId("experience-frame", [
    input.goalId,
    input.runId ?? null,
    input.loopIndex,
    evidenceRefs,
    trigger,
  ]);
  const trust = defaultRuntimeEvidenceTrust({
    targetRef: {
      kind: "learning_frame",
      id: frameId,
      scope: {
        goal_id: input.goalId,
        ...(input.runId ? { run_id: input.runId } : {}),
      },
    },
    provenanceRefs: evidenceRefs,
  });
  const now = new Date().toISOString();
  return ExperienceFrameSchema.parse({
    id: frameId,
    goalId: input.goalId,
    ...(input.runId ? { runId: input.runId } : {}),
    loopIndex: input.loopIndex,
    createdAt: now,
    updatedAt: now,
    trigger,
    selectedBy: "deterministic_bridge",
    sourceAuthority: "runtime_evidence",
    summary: redactedLearningLabel({
      label: `DurableLoop ${trigger} frame`,
      sourceRefs: evidenceRefs,
      maxLength: 160,
    }),
    evidenceRefs,
    cognitionEventRefs: [],
    runtimeGraphRefs: [],
    attentionRefs: [],
    taskRefs: input.result.taskResult?.task.id ? [input.result.taskResult.task.id] : [],
    salience: {
      informationGain: trigger === "repeated_failure" || trigger === "bottleneck" ? 0.8 : 0.55,
      goalRelevance: 0.8,
      recurrence: trigger === "repeated_failure" ? 0.7 : 0.3,
      uncertainty: trigger === "high_uncertainty" ? 0.8 : 0.5,
      risk: trigger === "contradiction" ? 0.7 : 0.35,
    },
    scope: {
      refs: {
        goalId: input.goalId,
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.result.taskResult?.task.id ? { taskId: input.result.taskResult.task.id } : {}),
      },
      semantic: input.goal
        ? {
            taskKind: "durable_loop_iteration",
            environmentKind: "pulseed_runtime",
            classifierVersion: "deterministic/experience-learning-bridge/v1",
            confidence: 1,
          }
        : undefined,
    },
    trust,
    correctionState: trust.correctionState,
    status: "candidate",
  });
}

function frameActivatedPayload(frame: ExperienceFrame, input: ExperienceLearningBridgeInput): ExperienceLearningRuntimeEventPayload {
  const eventRefs = input.iterationEvidence.flatMap((entry) =>
    entry.raw_refs
      .filter((ref) => ref.kind === "runtime_event")
      .map((ref) => ref.id)
      .filter((ref): ref is string => typeof ref === "string" && ref.length > 0)
  );
  return {
    schema_version: "runtime-event-payload/experience-learning/v1",
    event_kind: "frame_activated",
    idempotency_key: `experience-learning:frame:${frame.id}`,
    goal_id: input.goalId,
    ...(input.runId ? { run_id: input.runId } : {}),
    loop_index: input.loopIndex,
    source_refs: {
      evidence_refs: frame.evidenceRefs,
      event_refs: eventRefs,
      runtime_graph_refs: [],
    },
    trust: frame.trust,
    correction_state: frame.correctionState,
    redaction_class: "refs_only",
    graph: {
      node_refs: [{ kind: "experience_frame", ref: frame.id }],
      edge_refs: [],
    },
    frame_id: frame.id,
    activated_evidence_refs: frame.evidenceRefs,
    frame,
  };
}

function buildDerivedLifecyclePayloads(
  input: ExperienceLearningBridgeInput,
  trigger: ExperienceFrameTrigger,
  frame: ExperienceFrame,
  frames: readonly ExperienceFrame[],
  existingCandidates: readonly GeneralizationCandidate[],
): ExperienceLearningRuntimeEventPayload[] {
  const now = new Date().toISOString();
  const scopedFrames = frames
    .filter((candidate) =>
      candidate.goalId === input.goalId
      && candidate.trigger === trigger
      && (!input.runId || !candidate.runId || candidate.runId === input.runId)
    )
    .sort((a, b) => (a.loopIndex ?? 0) - (b.loopIndex ?? 0) || a.createdAt.localeCompare(b.createdAt));
  const sourceFrames = tailUniqueById([...scopedFrames, frame], 2);
  const sourceFrameIds = sourceFrames.map((candidate) => candidate.id);
  const sourceEvidenceRefs = unique(sourceFrames.flatMap((candidate) => candidate.evidenceRefs));
  const sourceEventRefs = input.iterationEvidence.flatMap((entry) =>
    entry.raw_refs
      .filter((ref) => ref.kind === "runtime_event")
      .map((ref) => ref.id)
      .filter((ref): ref is string => typeof ref === "string" && ref.length > 0)
  );
  const scope = frame.scope;
  const dimensionName = deriveLearningDimensionName(input);
  const mainHypothesis = buildHypothesis(input, {
    idSuffix: "primary",
    trigger,
    dimensionName,
    now,
    frameIds: sourceFrameIds,
    evidenceRefs: sourceEvidenceRefs,
    scope,
    status: sourceFrames.length >= 2 ? "active" : "candidate",
    competingHypothesisIds: [stableLearningId("learning-hypothesis", [input.goalId, input.runId ?? null, trigger, dimensionName, "alternative"])],
  });
  const competingHypothesis = buildHypothesis(input, {
    idSuffix: "alternative",
    trigger,
    dimensionName,
    now,
    frameIds: [frame.id],
    evidenceRefs: frame.evidenceRefs,
    scope,
    status: "candidate",
    competingHypothesisIds: [mainHypothesis.id],
  });
  const hasIndependentSupport = sourceFrames.length >= 2 && sourceEvidenceRefs.length >= 2;
  const probeSourceEvidenceRefs = hasIndependentSupport
    ? unique(sourceFrames.slice(0, -1).flatMap((candidate) => candidate.evidenceRefs))
    : sourceEvidenceRefs;
  const probeSupportEvidenceRefs = hasIndependentSupport ? frame.evidenceRefs : [];
  const candidate = buildGeneralizationCandidate(input, {
    trigger,
    now,
    dimensionName,
    hypothesis: mainHypothesis,
    competingHypothesisId: competingHypothesis.id,
    sourceFrameIds,
    sourceEvidenceRefs,
    scope,
    status: hasIndependentSupport ? "trial_reuse_ready" : "candidate",
  });
  const existingCandidate = existingCandidates.find((item) => item.id === candidate.id) ?? null;
  const candidateCanReceiveBridgeTransition = !existingCandidate
    || !isPostExperimentCandidateStatus(existingCandidate.status);
  const transitionFromStatus = existingCandidate?.status ?? "candidate";
  const readSet = probeSourceEvidenceRefs.map((ref) => microProbeReadRef(ref, probeSourceEvidenceRefs));
  const microProbePlan = MicroProbePlanSchema.parse({
    id: stableLearningId("micro-probe-plan", [candidate.id, sourceEvidenceRefs]),
    goalId: input.goalId,
    ...(input.runId ? { runId: input.runId } : {}),
    loopIndex: input.loopIndex,
    frameId: frame.id,
    hypothesisIds: [mainHypothesis.id, competingHypothesis.id],
    plannedAt: now,
    mode: "runtime_event_replay",
    sourceEvidenceRefs: probeSourceEvidenceRefs,
    sourceEventRefs,
    sourceRuntimeGraphRefs: [],
    readSet,
    probeSchemaVersion: "micro-probe/v1",
    expectedSignals: [{
      polarity: "if_true",
      signalId: `learning-signal:${candidate.id}`,
      signalKind: "independent_runtime_evidence",
      diagnosticLabel: "independent support for reusable runtime structure",
    }],
  }) satisfies MicroProbePlan;
  const microProbeRecord = runNoOutwardEffectMicroProbe({
    plan: microProbePlan,
    trust: candidate.trust,
    now,
    readResults: readSet.map((readRef) => ({
      readRef,
      payloadHash: readRef.snapshotPayloadHash,
    })),
    supportEvidenceRefs: probeSupportEvidenceRefs,
    supportEventRefs: sourceEventRefs,
  });
  const readinessGate = candidateCanReceiveBridgeTransition && hasIndependentSupport
    ? TrialReuseReadinessGateSchema.parse({
        id: stableLearningId("trial-reuse-gate", [candidate.id, input.loopIndex + 1]),
        candidateId: candidate.id,
        sourceLoopIndex: input.loopIndex,
        eligibleFromIteration: input.loopIndex + 1,
        sourceTransitionId: stableLearningId("candidate-transition", [candidate.id, "trial_reuse_ready", sourceEvidenceRefs]),
        disjointSupportRefs: sourceEvidenceRefs,
        actionShape: "reversible",
        risk: "low",
        scopeDecision: "exact",
        transferScopeRef: candidate.transferScopes[0]?.scopeRef ?? `goal:${input.goalId}`,
        trialReuseBudgetId: stableLearningId("trial-reuse-budget", [candidate.id]),
        remainingTrialUses: 1,
        decision: "ready",
        reasonCodes: ["independent_support", "n_plus_one", "low_risk"],
      })
    : null;
  const transition = candidateCanReceiveBridgeTransition
    ? CandidateTransitionSchema.parse({
        id: readinessGate?.sourceTransitionId ?? stableLearningId("candidate-transition", [candidate.id, "deferred", sourceEvidenceRefs]),
        goalId: input.goalId,
        ...(input.runId ? { runId: input.runId } : {}),
        loopIndex: input.loopIndex,
        targetKind: "generalization_candidate",
        targetId: candidate.id,
        fromStatus: transitionFromStatus,
        toStatus: hasIndependentSupport ? "trial_reuse_ready" : "candidate",
        reasonCode: hasIndependentSupport ? "trial_reuse_ready" : "deferred_requires_durableloop_experiment",
        diagnosticLabel: hasIndependentSupport
          ? "independent runtime evidence allowed a later trial-reuse experiment"
          : "single-frame evidence stayed candidate-only",
        microProbeRecordIds: [microProbeRecord.id],
        evidenceRefs: sourceEvidenceRefs,
        eventRefs: sourceEventRefs,
        runtimeGraphRefs: [],
        ...(readinessGate ? { readinessGateId: readinessGate.id } : {}),
      }) satisfies CandidateTransition
    : null;
  const experimentPlan = readinessGate
    ? buildExperimentPlan(input, {
        now,
        dimensionName,
        candidate,
        hypothesis: mainHypothesis,
        sourceEvidenceRefs,
        sourceEventRefs,
      })
    : null;
  const trialReuseBudgetConsumption = readinessGate && experimentPlan
    ? buildTrialReuseBudgetConsumption(input, {
        now,
        readinessGate,
        experimentPlan,
      })
    : null;
  const artifact = transition
    ? buildLearningArtifact(input, {
        now,
        trigger,
        dimensionName,
        frameIds: sourceFrameIds,
        hypothesisIds: [mainHypothesis.id],
        candidate,
        experimentPlanIds: experimentPlan ? [experimentPlan.id] : [],
        sourceEvidenceRefs,
        status: hasIndependentSupport ? "trial_reuse_ready" : "tentative",
      })
    : null;
  const prior = transition && artifact && artifact.policyEffect.length > 0
    ? buildLearningPrior(input, {
        now,
        dimensionName,
        artifact,
        transition,
        experimentPlanIds: experimentPlan ? [experimentPlan.id] : [],
        sourceEvidenceRefs,
        scope,
      })
    : null;

  const payloads: ExperienceLearningRuntimeEventPayload[] = [
    hypothesisPayload(input, mainHypothesis, null, mainHypothesis.status, "frame_spawned_hypothesis", sourceEventRefs),
    hypothesisPayload(input, competingHypothesis, null, competingHypothesis.status, "competing_alternative_spawned", sourceEventRefs),
    microProbePayload(input, microProbePlan, microProbeRecord, sourceEventRefs),
  ];
  if (transition) {
    payloads.push(
      generalizationPayload(input, candidate, null, candidate.status, "deterministic_generalization_candidate", sourceEventRefs),
      candidateTransitionPayload(input, transition, readinessGate, trialReuseBudgetConsumption, sourceEventRefs),
    );
  }
  if (experimentPlan) payloads.push(experimentPlanPayload(input, experimentPlan, sourceEventRefs));
  if (artifact) payloads.push(artifactPayload(input, artifact, null, artifact.status, "deterministic_compression", sourceEventRefs));
  if (prior) payloads.push(priorGeneratedPayload(input, prior, sourceEventRefs));
  return payloads;
}

function buildHypothesis(
  input: ExperienceLearningBridgeInput,
  data: {
    idSuffix: "primary" | "alternative";
    trigger: ExperienceFrameTrigger;
    dimensionName: string;
    now: string;
    frameIds: string[];
    evidenceRefs: string[];
    scope: ExperienceFrame["scope"];
    status: LearningHypothesis["status"];
    competingHypothesisIds: string[];
  },
): LearningHypothesis {
  const id = stableLearningId("learning-hypothesis", [input.goalId, input.runId ?? null, data.trigger, data.dimensionName, data.idSuffix]);
  const trust = defaultRuntimeEvidenceTrust({
    targetRef: {
      kind: "learning_hypothesis",
      id,
      scope: {
        goal_id: input.goalId,
        ...(input.runId ? { run_id: input.runId } : {}),
      },
    },
    provenanceRefs: data.evidenceRefs,
  });
  return LearningHypothesisSchema.parse({
    id,
    goalId: input.goalId,
    ...(input.runId ? { runId: input.runId } : {}),
    statement: redactedLearningLabel({
      label: data.idSuffix === "primary"
        ? `DurableLoop ${data.trigger} may reveal reusable planning structure`
        : `DurableLoop ${data.trigger} may be local noise only`,
      sourceRefs: data.evidenceRefs,
      maxLength: 180,
    }),
    kind: data.trigger === "repeated_failure" ? "failure_pattern" : "strategy_effect",
    scope: data.scope,
    status: data.status,
    confidence: data.status === "active" ? 0.62 : 0.4,
    supportEvidenceRefs: data.status === "active" ? data.evidenceRefs : [],
    contradictionEvidenceRefs: [],
    spawnedFromFrameIds: data.frameIds,
    competingHypothesisIds: data.competingHypothesisIds,
    falsificationPlan: {
      testNext: data.evidenceRefs,
      expectedSignals: [{
        polarity: "if_true",
        signalId: `learning-signal:${id}`,
        signalKind: "independent_runtime_evidence",
        diagnosticLabel: "future iteration independently supports this hypothesis",
      }],
    },
    trust,
    correctionState: trust.correctionState,
    createdAt: data.now,
    updatedAt: data.now,
  });
}

function buildGeneralizationCandidate(
  input: ExperienceLearningBridgeInput,
  data: {
    trigger: ExperienceFrameTrigger;
    now: string;
    dimensionName: string;
    hypothesis: LearningHypothesis;
    competingHypothesisId: string;
    sourceFrameIds: string[];
    sourceEvidenceRefs: string[];
    scope: ExperienceFrame["scope"];
    status: GeneralizationCandidate["status"];
  },
): GeneralizationCandidate {
  const id = stableLearningId("generalization-candidate", [input.goalId, input.runId ?? null, data.trigger, data.dimensionName]);
  const trust = defaultRuntimeEvidenceTrust({
    targetRef: {
      kind: "generalization_candidate",
      id,
      scope: {
        goal_id: input.goalId,
        ...(input.runId ? { run_id: input.runId } : {}),
      },
    },
    provenanceRefs: data.sourceEvidenceRefs,
  });
  const predicate = {
    id: stableLearningId("generalization-predicate", [id, "applicability"]),
    kind: "applicability" as const,
    subjectRef: `goal:${input.goalId}`,
    signalRefs: data.sourceEvidenceRefs,
    relation: "present" as const,
    evaluatorPort: "evidence_signal_query" as const,
    confidence: 0.7,
    failureBoundary: "narrow_scope" as const,
    diagnosticLabel: "same goal receives comparable runtime evidence",
  };
  return GeneralizationCandidateSchema.parse({
    id,
    goalId: input.goalId,
    ...(input.runId ? { runId: input.runId } : {}),
    kind: "strategy_bias",
    statement: redactedLearningLabel({
      label: `Prefer a bounded experiment around ${data.dimensionName} when similar evidence recurs`,
      sourceRefs: data.sourceEvidenceRefs,
      maxLength: 180,
    }),
    body: {
      kind: "strategy_bias",
      preferStrategyRefs: [`dimension:${data.dimensionName}`],
      avoidStrategyRefs: [],
      applicabilityPredicates: [predicate],
      reuseProposalKind: "compare_strategy",
      reuseProposal: {
        proposalKind: "compare_strategy",
        consumerPhase: "task_generation",
        actionBiasRefs: [`dimension:${data.dimensionName}`],
        strategyBiasRefs: [`dimension:${data.dimensionName}`],
        expectedDeltaRefs: data.sourceEvidenceRefs,
        inhibitionRefs: [],
        experimentPlanRefs: [],
      },
    },
    scope: data.scope,
    status: data.status,
    sourceHypothesisIds: [data.hypothesis.id],
    competingHypothesisIds: [data.competingHypothesisId],
    supportRefs: data.sourceEvidenceRefs,
    counterexampleRefs: [],
    nearMissRefs: data.sourceFrameIds,
    applicabilitySignalRefs: data.sourceEvidenceRefs,
    nonApplicabilitySignalRefs: [],
    predictedOutcomeDeltaRefs: data.sourceEvidenceRefs,
    invariantRefs: data.sourceFrameIds,
    transferScopes: [
      {
        scopeRef: `goal:${input.goalId}`,
        status: data.status === "trial_reuse_ready" ? "trial_allowed" : "exact",
        invariantMatchRefs: data.sourceFrameIds,
        applicabilityMatchRefs: data.sourceEvidenceRefs,
        maxTrials: 1,
        attempts: 0,
        successRefs: [],
        negativeTransferRefs: [],
      },
      ...(data.status === "trial_reuse_ready"
        ? [{
            scopeRef: `adjacent:${input.goalId}:${data.dimensionName}`,
            status: "adjacent_candidate" as const,
            invariantMatchRefs: data.sourceFrameIds,
            applicabilityMatchRefs: data.sourceEvidenceRefs,
            maxTrials: 1,
            attempts: 0,
            successRefs: [],
            negativeTransferRefs: [],
          }]
        : []),
    ],
    compressionScore: 0.6,
    expectedInformationGain: 0.7,
    transferPotential: 0.55,
    overfitRisk: data.sourceEvidenceRefs.length >= 2 ? "low" : "medium",
    readinessGateIds: data.status === "trial_reuse_ready"
      ? [stableLearningId("trial-reuse-gate", [id, input.loopIndex + 1])]
      : [],
    trust,
    correctionState: trust.correctionState,
    createdAt: data.now,
    updatedAt: data.now,
  });
}

function buildExperimentPlan(
  input: ExperienceLearningBridgeInput,
  data: {
    now: string;
    dimensionName: string;
    candidate: GeneralizationCandidate;
    hypothesis: LearningHypothesis;
    sourceEvidenceRefs: string[];
    sourceEventRefs: string[];
  },
): LearningExperimentPlan {
  const valueScore: ExperimentValueScore = {
    candidateId: data.candidate.id,
    expectedInformationGain: 0.72,
    transferPotential: 0.55,
    bottleneckRelief: data.candidate.body.kind === "strategy_bias" ? 0.5 : 0.35,
    estimatedCost: "low",
    reversibility: "reversible",
    risk: "low",
    timeToSignal: "next_iteration",
    confidenceCalibration: 0.65,
    rank: 1,
  };
  const id = stableLearningId("learning-experiment-plan", [data.candidate.id, input.loopIndex + 1]);
  return LearningExperimentPlanSchema.parse({
    id,
    goalId: input.goalId,
    ...(input.runId ? { runId: input.runId } : {}),
    loopIndex: input.loopIndex,
    plannedAt: data.now,
    registeredBeforeAction: true,
    planKind: "trial_reuse_experiment",
    hypothesisIds: [data.hypothesis.id],
    generalizationCandidateIds: [data.candidate.id],
    decisionEvidenceRef: data.sourceEvidenceRefs[0]!,
    preActionEvidenceRefs: data.sourceEvidenceRefs,
    preActionEventRefs: data.sourceEventRefs,
    preActionRuntimeGraphRefs: [],
    intendedDiscrimination: redactedLearningLabel({
      label: `Test whether the ${data.dimensionName} bias helps a later iteration`,
      sourceRefs: data.sourceEvidenceRefs,
      maxLength: 180,
    }),
    valueScore,
    expectedByHypothesis: [{
      hypothesisId: data.hypothesis.id,
      expectedSignals: [{
        polarity: "if_true",
        signalId: `learning-experiment-signal:${id}`,
        signalKind: "task_generation_delta",
        diagnosticLabel: "later task selection changes under normal authority",
      }],
    }],
    plannedConsumerPhase: "task_generation",
    probe: {
      kind: "generalization_reuse_probe",
      informationGain: 0.72,
      estimatedCost: "low",
      reversibility: "reversible",
      interruptionRisk: "none",
      trustRisk: "low",
      capabilityEvidenceRefs: [],
      requiredAuthorityRecheck: true,
      successSignalRefs: data.sourceEvidenceRefs,
      failureSignalRefs: [],
    },
    trust: data.candidate.trust,
  });
}

function buildTrialReuseBudgetConsumption(
  input: ExperienceLearningBridgeInput,
  data: {
    now: string;
    readinessGate: TrialReuseReadinessGate;
    experimentPlan: LearningExperimentPlan;
  },
): TrialReuseBudgetConsumptionRecord {
  const consumerAttemptId = `trial-reuse-plan:${data.experimentPlan.id}:${data.readinessGate.eligibleFromIteration}`;
  const idempotencyKey = [
    "trial-reuse-budget",
    data.readinessGate.id,
    data.experimentPlan.id,
    consumerAttemptId,
  ].join(":");
  return TrialReuseBudgetConsumptionRecordSchema.parse({
    id: stableLearningId("trial-reuse-budget-consumption", [idempotencyKey]),
    gateId: data.readinessGate.id,
    candidateId: data.readinessGate.candidateId,
    planId: data.experimentPlan.id,
    consumerAttemptId,
    loopIndex: data.readinessGate.eligibleFromIteration,
    reservedAt: data.now,
    decision: "reserved",
    reasonCodes: ["ready"],
    idempotencyKey,
  });
}

function buildLearningArtifact(
  input: ExperienceLearningBridgeInput,
  data: {
    now: string;
    trigger: ExperienceFrameTrigger;
    dimensionName: string;
    frameIds: string[];
    hypothesisIds: string[];
    candidate: GeneralizationCandidate;
    experimentPlanIds: string[];
    sourceEvidenceRefs: string[];
    status: LearningArtifact["status"];
  },
): LearningArtifact {
  const id = stableLearningId("learning-artifact", [data.candidate.id, data.status]);
  const expiresAt = new Date(Date.parse(data.now) + 7 * 24 * 60 * 60 * 1000).toISOString();
  const suggestions = data.status === "trial_reuse_ready"
    ? [
        learningPriorSuggestion({
          id: stableLearningId("learning-prior-suggestion", [id, "trial_reuse_experiment"]),
          kind: "trial_reuse_experiment",
          consumerPhase: "task_generation",
          targetRef: { kind: "dimension", id: data.dimensionName },
          rationale: redactedLearningLabel({
            label: `Run a bounded N+1 trial-reuse experiment for ${data.trigger}`,
            sourceRefs: data.sourceEvidenceRefs,
            maxLength: 180,
          }),
          sourceArtifactIds: [id],
          experimentPlanIds: data.experimentPlanIds,
          evidenceRefs: data.sourceEvidenceRefs,
          strength: 0.5,
          risk: "low",
          expiresAt,
          maxUses: 1,
          sourceContext: { kind: "non_user_context", requestedUseClass: "goal_planning" },
        }),
      ]
    : data.status === "promoted"
    ? [
        learningPriorSuggestion({
          id: stableLearningId("learning-prior-suggestion", [id, "task_generation"]),
          kind: "strategy_preference",
          consumerPhase: "task_generation",
          targetRef: { kind: "dimension", id: data.dimensionName },
          rationale: redactedLearningLabel({
            label: `Use promoted ${data.trigger} structure as a bounded task-generation bias`,
            sourceRefs: data.sourceEvidenceRefs,
            maxLength: 180,
          }),
          sourceArtifactIds: [id],
          experimentPlanIds: data.experimentPlanIds,
          evidenceRefs: data.sourceEvidenceRefs,
          strength: 0.55,
          risk: "low",
          expiresAt,
          maxUses: 1,
          sourceContext: { kind: "non_user_context", requestedUseClass: "goal_planning" },
        }),
        learningPriorSuggestion({
          id: stableLearningId("learning-prior-suggestion", [id, "next_iteration_directive"]),
          kind: "phase_focus",
          consumerPhase: "next_iteration_directive",
          targetRef: { kind: "dimension", id: data.dimensionName },
          rationale: redactedLearningLabel({
            label: `Focus next directive on the promoted ${data.trigger} structure`,
            sourceRefs: data.sourceEvidenceRefs,
            maxLength: 180,
          }),
          sourceArtifactIds: [id],
          experimentPlanIds: data.experimentPlanIds,
          evidenceRefs: data.sourceEvidenceRefs,
          strength: 0.5,
          risk: "low",
          expiresAt,
          maxUses: 1,
          sourceContext: { kind: "non_user_context", requestedUseClass: "goal_planning" },
        }),
      ]
    : [];
  return LearningArtifactSchema.parse({
    id,
    sourceGoalId: input.goalId,
    ...(input.runId ? { sourceRunId: input.runId } : {}),
    kind: "generalization_candidate",
    summary: redactedLearningLabel({
      label: `${data.status} reusable structure from ${data.trigger}`,
      sourceRefs: data.sourceEvidenceRefs,
      maxLength: 160,
    }),
    scope: data.candidate.scope,
    evidence: {
      frameIds: data.frameIds,
      hypothesisIds: data.hypothesisIds,
      generalizationCandidateIds: [data.candidate.id],
      experimentPlanIds: data.experimentPlanIds,
      experimentRecordIds: [],
      runtimeEvidenceRefs: data.sourceEvidenceRefs,
    },
    confidence: data.status === "promoted" ? 0.62 : 0.38,
    status: data.status,
    trust: data.candidate.trust,
    correctionState: data.candidate.correctionState,
    policyEffect: suggestions,
    guardrails: {
      authorityClass: "planning_hint_only",
      cannotGrantAuthority: true,
      requiresFreshEvidenceBeforePromotion: data.status !== "promoted",
      contradictionRefs: [],
      falsificationPlanRefs: data.experimentPlanIds,
    },
    createdAt: data.now,
    updatedAt: data.now,
  });
}

function buildLearningPrior(
  input: ExperienceLearningBridgeInput,
  data: {
    now: string;
    dimensionName: string;
    artifact: LearningArtifact;
    transition: CandidateTransition;
    experimentPlanIds: string[];
    sourceEvidenceRefs: string[];
    scope: ExperienceFrame["scope"];
  },
): LearningPriorSnapshot {
  const id = stableLearningId("learning-prior", [data.artifact.id, input.loopIndex + 1]);
  const suggestions = data.artifact.policyEffect.map((suggestion) =>
    suggestion.consumerPhase === "task_generation"
      ? { ...suggestion, experimentPlanIds: data.experimentPlanIds }
      : suggestion
  );
  return LearningPriorSnapshotSchema.parse({
    id,
    goalId: input.goalId,
    ...(input.runId ? { runId: input.runId } : {}),
    generatedAt: data.now,
    sourceLoopIndex: input.loopIndex,
    eligibleFromIteration: input.loopIndex + 1,
    generationEventRef: `runtime-event-projection:experience-learning:${id}`,
    sourceCandidateTransitionIds: [data.transition.id],
    scope: data.scope,
    compatibility: {
      decision: "compatible",
      reasonCode: "matched_exact_refs",
      matchedRefs: [`goalId:${input.goalId}`],
      missingRefs: [],
    },
    sourceArtifactIds: [data.artifact.id],
    suggestions,
    staleOrFalsifiedArtifactIds: [],
    suppressedByCorrectionIds: [],
    suppressedByQuarantineIds: [],
    trust: data.artifact.trust,
    sourceTrustStates: [{
      sourceRef: data.artifact.id,
      trust: data.artifact.trust,
    }],
    filterDecision: {
      decision: "activated",
      reasonCodes: ["eligible"],
      evaluatedAt: data.now,
    },
    confidence: 0.6,
    traceRef: `experience-learning-prior:${id}`,
  });
}

function hypothesisPayload(
  input: ExperienceLearningBridgeInput,
  hypothesis: LearningHypothesis,
  fromStatus: LearningHypothesis["status"] | null,
  toStatus: LearningHypothesis["status"],
  reasonCode: string,
  eventRefs: string[],
): ExperienceLearningRuntimeEventPayload {
  const evidenceRefs = hypothesis.supportEvidenceRefs.length > 0 ? hypothesis.supportEvidenceRefs : hypothesis.spawnedFromFrameIds;
  return {
    ...payloadBase(input, {
      idempotencyKey: transitionIdempotencyKey(input, {
        kind: "hypothesis",
        targetId: hypothesis.id,
        toStatus,
        evidenceRefs,
        eventRefs,
      }),
      evidenceRefs,
      eventRefs,
      trust: hypothesis.trust,
      graphNodeRefs: [{ kind: "learning_hypothesis", ref: hypothesis.id }],
    }),
    event_kind: "hypothesis_transitioned",
    hypothesis_id: hypothesis.id,
    frame_ids: hypothesis.spawnedFromFrameIds,
    from_status: fromStatus,
    to_status: toStatus,
    reason_code: reasonCode,
    competing_hypothesis_ids: hypothesis.competingHypothesisIds,
    hypothesis,
  };
}

function generalizationPayload(
  input: ExperienceLearningBridgeInput,
  candidate: GeneralizationCandidate,
  fromStatus: GeneralizationCandidate["status"] | null,
  toStatus: GeneralizationCandidate["status"],
  reasonCode: string,
  eventRefs: string[],
): ExperienceLearningRuntimeEventPayload {
  return {
    ...payloadBase(input, {
      idempotencyKey: transitionIdempotencyKey(input, {
        kind: "generalization",
        targetId: candidate.id,
        toStatus,
        evidenceRefs: candidate.supportRefs,
        eventRefs,
      }),
      evidenceRefs: candidate.supportRefs,
      eventRefs,
      trust: candidate.trust,
      graphNodeRefs: [{ kind: "generalization_candidate", ref: candidate.id }],
    }),
    event_kind: "generalization_transitioned",
    generalization_id: candidate.id,
    body_kind: candidate.body.kind,
    transfer_scope_refs: candidate.transferScopes.map((scope) => scope.scopeRef),
    from_status: fromStatus,
    to_status: toStatus,
    reason_code: reasonCode,
    generalization: candidate,
  };
}

function microProbePayload(
  input: ExperienceLearningBridgeInput,
  plan: MicroProbePlan,
  record: MicroProbeRecord,
  eventRefs: string[],
): ExperienceLearningRuntimeEventPayload {
  return {
    ...payloadBase(input, {
      idempotencyKey: `experience-learning:micro-probe:${record.id}`,
      evidenceRefs: plan.sourceEvidenceRefs,
      eventRefs,
      trust: record.trust,
      graphNodeRefs: [{ kind: "micro_probe", ref: record.id }],
    }),
    event_kind: "micro_probe_recorded",
    plan_id: plan.id,
    record_id: record.id,
    read_set: recordReadSet(plan.readSet),
    outcome: record.outcome,
    plan,
    record,
  };
}

function candidateTransitionPayload(
  input: ExperienceLearningBridgeInput,
  transition: CandidateTransition,
  readinessGate: TrialReuseReadinessGate | null,
  trialReuseBudgetConsumption: TrialReuseBudgetConsumptionRecord | null,
  eventRefs: string[],
): ExperienceLearningRuntimeEventPayload {
  const trust = defaultRuntimeEvidenceTrust({
    targetRef: {
      kind: "candidate_transition",
      id: transition.id,
      scope: {
        goal_id: input.goalId,
        ...(input.runId ? { run_id: input.runId } : {}),
      },
    },
    provenanceRefs: transition.evidenceRefs,
  });
  return {
    ...payloadBase(input, {
      idempotencyKey: `experience-learning:candidate-transition:${transition.id}`,
      evidenceRefs: transition.evidenceRefs,
      eventRefs,
      trust,
      graphNodeRefs: [
        { kind: "candidate_transition", ref: transition.id },
        ...(readinessGate ? [{ kind: "generalization_candidate", ref: readinessGate.candidateId }] : []),
      ],
    }),
    event_kind: "candidate_transition_recorded",
    transition_id: transition.id,
    target_kind: transition.targetKind,
    target_id: transition.targetId,
    from_status: transition.fromStatus,
    to_status: transition.toStatus,
    reason_code: transition.reasonCode,
    transition,
    ...(readinessGate ? { readiness_gate: readinessGate } : {}),
    ...(trialReuseBudgetConsumption ? { trial_reuse_budget_consumption: trialReuseBudgetConsumption } : {}),
  };
}

function experimentPlanPayload(
  input: ExperienceLearningBridgeInput,
  plan: LearningExperimentPlan,
  eventRefs: string[],
): ExperienceLearningRuntimeEventPayload {
  return {
    ...payloadBase(input, {
      idempotencyKey: `experience-learning:experiment-plan:${plan.id}`,
      evidenceRefs: plan.preActionEvidenceRefs,
      eventRefs,
      trust: plan.trust,
      graphNodeRefs: [{ kind: "learning_experiment_plan", ref: plan.id }],
    }),
    event_kind: "experiment_plan_registered",
    plan_id: plan.id,
    plan_kind: plan.planKind,
    value_score: plan.valueScore,
    hypothesis_ids: plan.hypothesisIds,
    generalization_ids: plan.generalizationCandidateIds,
    plan,
  };
}

function artifactPayload(
  input: ExperienceLearningBridgeInput,
  artifact: LearningArtifact,
  fromStatus: LearningArtifact["status"] | null,
  toStatus: LearningArtifact["status"],
  reasonCode: string,
  eventRefs: string[],
): ExperienceLearningRuntimeEventPayload {
  return {
    ...payloadBase(input, {
      idempotencyKey: `experience-learning:artifact:${artifact.id}:${toStatus}`,
      evidenceRefs: artifact.evidence.runtimeEvidenceRefs,
      eventRefs,
      trust: artifact.trust,
      graphNodeRefs: [{ kind: "learning_artifact", ref: artifact.id }],
    }),
    event_kind: "artifact_transitioned",
    artifact_id: artifact.id,
    source_candidate_ids: artifact.evidence.generalizationCandidateIds,
    from_status: fromStatus,
    to_status: toStatus,
    reason_code: reasonCode,
    artifact,
  };
}

function priorGeneratedPayload(
  input: ExperienceLearningBridgeInput,
  prior: LearningPriorSnapshot,
  eventRefs: string[],
): ExperienceLearningRuntimeEventPayload {
  return {
    ...payloadBase(input, {
      idempotencyKey: `experience-learning:prior-generated:${prior.id}`,
      evidenceRefs: prior.suggestions.flatMap((suggestion) => suggestion.evidenceRefs),
      eventRefs,
      trust: prior.trust,
      graphNodeRefs: [{ kind: "learning_prior", ref: prior.id }],
    }),
    event_kind: "prior_generated",
    prior_id: prior.id,
    artifact_ids: prior.sourceArtifactIds,
    eligible_from_iteration: prior.eligibleFromIteration,
    prior,
  };
}

function payloadBase(
  input: ExperienceLearningBridgeInput,
  data: {
    idempotencyKey: string;
    evidenceRefs: readonly string[];
    eventRefs: readonly string[];
    trust: ExperienceFrame["trust"];
    graphNodeRefs: Array<{ kind: string; ref: string }>;
  },
): Omit<ExperienceLearningRuntimeEventPayload, "event_kind"> {
  return {
    schema_version: "runtime-event-payload/experience-learning/v1",
    idempotency_key: data.idempotencyKey,
    goal_id: input.goalId,
    ...(input.runId ? { run_id: input.runId } : {}),
    loop_index: input.loopIndex,
    source_refs: {
      evidence_refs: unique(data.evidenceRefs),
      event_refs: unique(data.eventRefs),
      runtime_graph_refs: [],
    },
    trust: data.trust,
    correction_state: data.trust.correctionState,
    redaction_class: "refs_only",
    graph: {
      node_refs: data.graphNodeRefs,
      edge_refs: [],
    },
  } as Omit<ExperienceLearningRuntimeEventPayload, "event_kind">;
}

function transitionIdempotencyKey(
  input: ExperienceLearningBridgeInput,
  data: {
    kind: "hypothesis" | "generalization";
    targetId: string;
    toStatus: string;
    evidenceRefs: readonly string[];
    eventRefs: readonly string[];
  },
): string {
  const inputFingerprint = stableLearningId(`${data.kind}-transition-input`, [
    input.loopIndex,
    unique([...data.evidenceRefs, ...data.eventRefs]).sort(),
  ]);
  return `experience-learning:${data.kind}:${data.targetId}:${data.toStatus}:loop:${input.loopIndex}:${inputFingerprint}`;
}

function deriveLearningDimensionName(input: ExperienceLearningBridgeInput): string {
  const goalDimensionNames = input.goal?.dimensions
    .map((dimension) => dimension.name)
    .filter((name) => name.length > 0) ?? [];
  const candidates = unique([
    ...input.iterationEvidence.map((entry) => entry.task?.primary_dimension ?? ""),
    input.result.taskResult?.task.primary_dimension ?? "",
    ...(input.result.taskResult?.task.target_dimensions ?? []),
    input.result.stallReport?.dimension_name ?? "",
    ...input.result.completionJudgment.blocking_dimensions,
    ...input.result.completionJudgment.low_confidence_dimensions,
    ...input.result.driveScores.map((score) => score.dimension_name),
  ]);
  return candidates.find((candidate) => goalDimensionNames.includes(candidate))
    ?? candidates[0]
    ?? goalDimensionNames[0]
    ?? "goal_progress";
}

function isPostExperimentCandidateStatus(status: GeneralizationCandidate["status"]): boolean {
  return status === "promoted"
    || status === "narrowed"
    || status === "falsified"
    || status === "retired"
    || status === "quarantined";
}

function microProbeReadRef(ref: string, allRefs: readonly string[]): MicroProbeReadSetEntry {
  return {
    sourceKind: "snapshot_evidence",
    ref,
    snapshotId: `runtime-evidence:${ref}`,
    snapshotEvidenceRef: ref,
    portSchemaVersion: "runtime-evidence-entry/v1",
    versionOrSequence: ref,
    highWatermark: allRefs[allRefs.length - 1] ?? ref,
    inputHash: stableLearningId("micro-probe-input", allRefs),
    snapshotPayloadHash: stableLearningId("runtime-evidence-payload", [ref]),
    redactionClass: "refs_only",
    port: "runtime_evidence_entry",
  };
}

function recordReadSet(readSet: readonly MicroProbeReadSetEntry[]): MicroProbeReadSetEntry[] {
  return readSet.map((entry) => ({ ...entry }));
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function tailUniqueById<T extends { id: string }>(values: readonly T[], max: number): T[] {
  const byId = new Map<string, T>();
  for (const value of values) byId.set(value.id, value);
  return [...byId.values()].slice(-max);
}
