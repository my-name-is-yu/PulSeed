import { randomUUID } from "node:crypto";
import type { Goal } from "../../base/types/goal.js";
import {
  evaluateResidentOperationBoundary,
  residentOperationBoundaryActivityMetadata,
  type ResidentOperationBoundaryResult,
} from "../capability-operation-planner.js";
import {
  CompanionCognitionService,
  FileCognitionAuditSink,
  InMemoryCognitionAuditSink,
  createRelationshipProfileCognitionMemoryPort,
  toolCandidateFromGadgetPlan,
  type CognitionEventRef,
  type CompanionCognitionInput,
  type ToolCandidate,
} from "../cognition/index.js";
import { projectCompanionAction } from "../control/companion-action-projection.js";
import {
  projectOutboundConversationAuthority,
  projectPeerInitiativeDeliveryAuthority,
} from "../control/execution-authority-decision.js";
import { InteractionAuthorityStore } from "../control/interaction-authority-store.js";
import { createCompanionGadgetPlan } from "../decision/companion-gadget-planning.js";
import {
  buildCommitmentGuardAttentionFromCandidates,
  buildSignalContextFromAttentionInputs,
  createExpressionDecisionForOutcome,
  evaluateCommitmentOperationsForAttentionAdmissions,
  ref,
  runAttentionCycle,
  type CommitmentCandidate,
  type CommitmentOperationAdapterOutcome,
} from "../attention/index.js";
import { projectSurfaceDelivery, renderSurfaceDeliveryProjection } from "../attention/surface-delivery.js";
import { attentionScopeKey } from "../attention/attention-scope.js";
import { stableId } from "../attention/attention-refs.js";
import {
  OutboundConversationMessageSchema,
  type OutboundConversationSurface,
} from "../gateway/outbound-conversation.js";
import {
  generatePeerInitiativeCandidates,
  mapPeerInitiativeBoundary,
  peerInitiativeActionButtons,
  selectPeerInitiativeCandidate,
  PeerInitiativeStore,
  PeerInitiativeMessageSchema,
  type PeerInitiativeCandidate,
  type PeerInitiativeSelectedState,
  type PeerInitiativeSelection,
} from "../peer-initiative/index.js";
import {
  OutcomeDecisionSchema,
  VisibilityPolicySchema,
  type OutcomeClass,
  type VisibilityPolicy,
} from "../types/companion-autonomy.js";
import {
  FileCognitiveReplayIndexStore,
  createCognitiveReplayIndexEntry,
} from "../visibility/index.js";
import { runProactiveMaintenance, type ProactiveMaintenanceResult } from "./maintenance.js";
import { resolveDaemonRuntimeRoot } from "./runtime-root.js";
import {
  evaluateResidentAttentionAdmission,
  residentAttentionActivityMetadata,
  type ResidentAttentionAdmission,
} from "./resident-attention-orchestrator.js";
import type {
  ResidentActivityMetadata,
  DaemonRunnerResidentContext,
  ResidentCognitionActivityMetadata,
  ResidentSurfaceActivityMetadata,
} from "./runner-resident-shared.js";
import {
  loadResidentFeedbackDecisionContext,
  persistResidentActivity,
  residentOperationBoundaryAllowsPreparation,
} from "./runner-resident-shared.js";
import {
  runResidentCuriosityCycle,
  runScheduledGoalReview,
  triggerResidentGoalDiscovery,
  triggerResidentInvestigation,
} from "./runner-resident-curiosity.js";
import {
  DEFAULT_RESIDENT_ACTIVATION_POLICY_ID,
  DEFAULT_RESIDENT_ACTIVATION_MAX_DELIVERY_KIND,
  ProactivePolicyStateStore,
  ResidentActivationStore,
  AttentionStateStore,
  applyResidentActivationBindingToPolicyState,
  clearInactiveResidentActivationBudgetFromPolicyState,
} from "../store/index.js";
import {
  PersonalAgentRuntimeStore,
  buildPersonalAgentDecisionTrace,
  type CapabilityRegistryDecisionKind,
  type InterventionDecisionKind,
  type RuntimeGraphRef,
} from "../personal-agent/index.js";

type ResidentPreemptiveTargetValidation =
  | { status: "not_preemptive" }
  | {
      status: "missing_goal_id" | "missing_goal" | "stale_goal";
      goalId?: string;
      summary: string;
      capabilityDecision: CapabilityRegistryDecisionKind;
    }
  | { status: "current_goal"; goalId: string };

function proactiveMaintenanceSurfaceActivityMetadata(
  result: ProactiveMaintenanceResult,
): ResidentSurfaceActivityMetadata {
  if (!result.surface) return {};
  return {
    surface_id: result.surface.surface_id,
    surface_included_count: result.surface.surface_included_count,
    surface_excluded_count: result.surface.surface_excluded_count,
    surface_inspection: result.surface.surface_inspection,
    surface_inspections: [result.surface.surface_inspection],
  };
}

export async function triggerResidentPreemptiveCheck(
  context: Pick<
    DaemonRunnerResidentContext,
    "stateManager" | "saveDaemonState" | "state" | "logger"
  >,
  details?: Record<string, unknown>,
  surfaceActivityMetadata: ResidentActivityMetadata = {},
): Promise<void> {
  const goalId =
    typeof details?.["goal_id"] === "string" ? details["goal_id"].trim() : "";

  if (!goalId) {
    await persistResidentActivity(context, {
      kind: "skipped",
      trigger: "proactive_tick",
      summary: "Resident preemptive check skipped because no goal_id was provided.",
      ...surfaceActivityMetadata,
    });
    return;
  }

  try {
    const goal = await context.stateManager.loadGoal(goalId).catch(() => null);
    if (!goal) {
      await persistResidentActivity(context, {
        kind: "skipped",
        trigger: "proactive_tick",
        summary: `Resident preemptive check skipped because goal "${goalId}" was not found.`,
        goal_id: goalId,
        ...surfaceActivityMetadata,
      });
      return;
    }
    if (!residentPreemptiveGoalIsCurrent(goal)) {
      await persistResidentActivity(context, {
        kind: "skipped",
        trigger: "proactive_tick",
        summary: `Resident preemptive check skipped because goal "${goalId}" is not current.`,
        goal_id: goalId,
        ...surfaceActivityMetadata,
      });
      return;
    }
    if (!residentOperationBoundaryAllowsPreparation(surfaceActivityMetadata)) {
      await persistResidentActivity(context, {
        kind: "skipped",
        trigger: "proactive_tick",
        summary: `Resident preemptive check skipped because goal "${goalId}" was not allowed to prepare by the operation boundary.`,
        goal_id: goalId,
        ...surfaceActivityMetadata,
      });
      return;
    }

    await persistResidentActivity(context, {
      kind: "observation",
      trigger: "proactive_tick",
      summary: `Resident preemptive check remained an attention candidate for goal "${goalId}".`,
      goal_id: goalId,
      ...surfaceActivityMetadata,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    context.logger.warn("Resident preemptive check failed", { error: message, goal_id: goalId });
    await persistResidentActivity(context, {
      kind: "error",
      trigger: "proactive_tick",
      summary: `Resident preemptive check failed: ${message}`,
      goal_id: goalId || undefined,
      ...surfaceActivityMetadata,
    });
  }
}

export async function runResidentCommitmentAttentionCycle(
  context: Pick<
    DaemonRunnerResidentContext,
    "baseDir" | "config" | "state" | "logger" | "saveDaemonState" | "gateway" | "attentionStateStore" | "residentOperationBoundaryEvaluator" | "feedbackIngestionStore"
  >,
  now = new Date().toISOString(),
): Promise<boolean> {
  const store = residentCommitmentAttentionStore(context);
  const dueCandidates = await store.listCommitmentCandidates({
    states: ["candidate", "shadow_held", "ask_confirmation", "watching", "active_care", "snoozed", "stale"],
    dueBefore: now,
    includeTerminal: false,
  });
  if (dueCandidates.length === 0) return false;

  const feedbackContext = await loadResidentFeedbackDecisionContext(context);
  const preparedCandidates = materializeCommitmentsForResidentCycle({
    candidates: dueCandidates,
    now,
    feedbackRefs: feedbackContext.feedbackRefs,
    overreach: recentFeedbackSuppressesCommitmentDelivery(feedbackContext.recentFeedback),
  });
  const provider = buildCommitmentGuardAttentionFromCandidates({
    candidates: preparedCandidates,
    now,
    triggerKind: feedbackContext.feedbackRefs.length > 0 ? "feedback_cooldown" : "revisit_window",
  });
  const storedCandidates = clearResidentActiveCareRevisitDeadlines({
    candidates: preparedCandidates,
    now,
  });
  const materializedCount = countChangedCommitments(dueCandidates, storedCandidates);
  await store.saveCommitmentCandidates(storedCandidates, { callerPath: "resident_proactive" });
  if (provider.attentionInputs.length === 0 && provider.urgeCandidates.length === 0) {
    if (materializedCount > 0) {
      await persistResidentActivity(context, {
        kind: "skipped",
        trigger: "proactive_tick",
        summary: `Resident commitment attention updated ${materializedCount} commitment candidate(s) without visible follow-up selection.`,
      });
      return true;
    }
    return false;
  }

  await store.saveCycle({
    attentionInputs: provider.attentionInputs,
    signalContext: buildSignalContextFromAttentionInputs({
      inputs: provider.attentionInputs,
      assembled_at: now,
      signal_context_id: `signal:resident-commitment:${now}`,
    }),
    recordedAt: now,
  });
  if (provider.urgeCandidates.length === 0) {
    await persistResidentActivity(context, {
      kind: "skipped",
      trigger: "proactive_tick",
      summary: materializedCount > 0
        ? `Resident commitment attention updated ${materializedCount} commitment candidate(s) without visible follow-up selection.`
        : "Resident commitment attention recorded non-urgent commitment inputs without operation selection.",
    });
    return true;
  }

  let preparedCount = 0;
  let blockedCount = 0;
  let traceOnlyCount = 0;
  for (const candidates of groupCommitmentCandidatesByScope(preparedCandidates)) {
    const scope = candidates[0]!.scope;
    const sourceIds = new Set(candidates.map((candidate) => candidate.source_ref.id));
    const scopeInputs = provider.attentionInputs.filter((input) =>
      input.user_activity_refs.some((userActivityRef) => sourceIds.has(userActivityRef.id))
    );
    const scopeUrges = provider.urgeCandidates.filter((urge) =>
      candidates.some((candidate) => urge.target.kind === "commitment" && urge.target.id === candidate.commitment_id)
    );
    const revision = await store.projectionRevision(scope);
    const cycle = await runAttentionCycle({
      store,
      cycle: {
        now,
        trigger: "maintenance",
        scope,
        signalRefs: scopeInputs.map((input) => input.signal_ref),
        sourceHighWatermarks: scopeInputs.map((input) => ({
          source: input.source.source_kind,
          highWatermark: input.source.high_watermark,
        })),
        expectedProjectionRevision: revision,
        cycleIdempotencyKey: `resident-commitment:${scope.policyEpoch}:${now}`,
        policyEpoch: scope.policyEpoch,
        mode: "live",
        urges: scopeUrges,
      },
    });
    const outcomes = evaluateCommitmentOperationsForAttentionAdmissions({
      candidates: cycle.admissionCandidates,
      assembledAt: now,
      surfaceRef: scope.surfaceRef,
      recentFeedback: feedbackContext.recentFeedback,
      invalidationEvidence: feedbackContext.invalidationEvidence,
      boundaryEvaluator: context.residentOperationBoundaryEvaluator,
    });
    for (const outcome of outcomes) {
      if (outcome.outcome === "trace_only") {
        traceOnlyCount += 1;
        continue;
      }
      if (outcome.outcome === "blocked") {
        blockedCount += 1;
        await persistResidentActivity(context, {
          kind: "skipped",
          trigger: "proactive_tick",
          summary: `Resident commitment operation held: ${outcome.reason}`,
          ...(outcome.boundary
            ? residentOperationBoundaryActivityMetadata(outcome.boundary)
            : {
                operation_plan_assembly_id: `operation-plan-assembly:commitment:block:${outcome.candidate.candidateId}`,
                operation_plan_status: "fail_closed" as const,
                operation_plan_reason: outcome.reason,
                operation_preparation_allowed: false,
                operation_execution_allowed: false,
              }),
        });
        continue;
      }
      if (outcome.peerCandidate) {
        preparedCount += 1;
        await triggerResidentPeerInitiative(context, peerInitiativeDetailsFromCommitmentOutcome(outcome), {
          attentionAdmission: residentAdmissionFromCommitmentOutcome(outcome, now),
          operationBoundary: outcome.boundary,
          selectionSurfaceRef: scope.surfaceRef ?? undefined,
          metadata: residentOperationBoundaryActivityMetadata(outcome.boundary),
        });
      }
    }
  }

  if (preparedCount === 0 && blockedCount === 0 && traceOnlyCount > 0) {
    await persistResidentActivity(context, {
      kind: "observation",
      trigger: "proactive_tick",
      summary: "Resident commitment attention remained trace-only.",
    });
  }
  if (preparedCount === 0 && blockedCount === 0 && traceOnlyCount === 0 && materializedCount > 0) {
    await persistResidentActivity(context, {
      kind: "skipped",
      trigger: "proactive_tick",
      summary: `Resident commitment attention updated ${materializedCount} commitment candidate(s) without operation selection.`,
    });
    return true;
  }
  return preparedCount > 0 || blockedCount > 0;
}

function residentCommitmentAttentionStore(
  context: Pick<DaemonRunnerResidentContext, "baseDir" | "config" | "attentionStateStore">,
): Pick<
  AttentionStateStore,
  | "saveCycle"
  | "saveCommitmentCandidates"
  | "listCommitmentCandidates"
  | "loadConcernState"
  | "saveMetabolismCycle"
  | "projectionRevision"
  | "listPendingBlocks"
  | "clearPendingBlocks"
> {
  const store = context.attentionStateStore;
  if (
    store?.saveCycle
    && store.saveCommitmentCandidates
    && store.listCommitmentCandidates
    && store.loadConcernState
    && store.saveMetabolismCycle
    && store.projectionRevision
    && store.listPendingBlocks
    && store.clearPendingBlocks
  ) {
    return store as Pick<
      AttentionStateStore,
      | "saveCycle"
      | "saveCommitmentCandidates"
      | "listCommitmentCandidates"
      | "loadConcernState"
      | "saveMetabolismCycle"
      | "projectionRevision"
      | "listPendingBlocks"
      | "clearPendingBlocks"
    >;
  }
  return new AttentionStateStore(
    resolveDaemonRuntimeRoot(context.baseDir, context.config.runtime_root),
    { controlBaseDir: context.baseDir },
  );
}

function materializeCommitmentsForResidentCycle(input: {
  candidates: readonly CommitmentCandidate[];
  now: string;
  feedbackRefs: readonly string[];
  overreach: boolean;
}): CommitmentCandidate[] {
  return input.candidates.map((candidate) => {
    if (input.overreach && candidate.materialization_state !== "quieted") {
      return {
        ...candidate,
        materialization_state: "quieted" as const,
        nudge_policy: "disabled" as const,
        suppression_refs: [...new Set([...candidate.suppression_refs, ...input.feedbackRefs])],
        feedback_refs: [...new Set([...candidate.feedback_refs, ...input.feedbackRefs])],
        next_revisit_at: null,
        updated_at: input.now,
      };
    }
    if (
      candidate.nudge_policy === "ask_first"
      && (
        candidate.materialization_state === "watching"
        || candidate.materialization_state === "candidate"
        || candidate.materialization_state === "snoozed"
      )
    ) {
      return {
        ...candidate,
        materialization_state: "ask_confirmation" as const,
        updated_at: input.now,
      };
    }
    if (
      candidate.nudge_policy === "allowed"
      && (
        candidate.materialization_state === "watching"
        || candidate.materialization_state === "candidate"
        || candidate.materialization_state === "snoozed"
      )
    ) {
      return {
        ...candidate,
        materialization_state: "active_care" as const,
        updated_at: input.now,
      };
    }
    return candidate;
  });
}

function clearResidentActiveCareRevisitDeadlines(input: {
  candidates: readonly CommitmentCandidate[];
  now: string;
}): CommitmentCandidate[] {
  return input.candidates.map((candidate) => {
    if (
      candidate.materialization_state === "active_care"
      && candidate.next_revisit_at
      && candidate.next_revisit_at <= input.now
    ) {
      return {
        ...candidate,
        next_revisit_at: null,
        updated_at: input.now,
      };
    }
    return candidate;
  });
}

function countChangedCommitments(
  before: readonly CommitmentCandidate[],
  after: readonly CommitmentCandidate[],
): number {
  const beforeById = new Map(before.map((candidate) => [candidate.commitment_id, candidate]));
  return after.filter((candidate) => {
    const previous = beforeById.get(candidate.commitment_id);
    return !previous
      || previous.materialization_state !== candidate.materialization_state
      || previous.nudge_policy !== candidate.nudge_policy
      || previous.next_revisit_at !== candidate.next_revisit_at
      || previous.updated_at !== candidate.updated_at;
  }).length;
}

function recentFeedbackSuppressesCommitmentDelivery(
  feedback: readonly { outcome: string; overreach_indicators?: readonly string[]; policy_adjustment?: string }[],
): boolean {
  return feedback.some((item) =>
    item.outcome === "overreach"
    || item.outcome === "dismissed"
    || item.policy_adjustment === "reduce_frequency"
    || item.policy_adjustment === "require_confirmation"
    || (item.overreach_indicators?.length ?? 0) > 0
  );
}

function groupCommitmentCandidatesByScope(
  candidates: readonly CommitmentCandidate[],
): CommitmentCandidate[][] {
  const groups = new Map<string, CommitmentCandidate[]>();
  for (const candidate of candidates) {
    const key = attentionScopeKey(candidate.scope);
    const group = groups.get(key) ?? [];
    group.push(candidate);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function peerInitiativeDetailsFromCommitmentOutcome(
  outcome: Extract<CommitmentOperationAdapterOutcome, { outcome: "prepared" }>,
): Record<string, unknown> {
  const candidate = outcome.peerCandidate;
  if (!candidate) return {};
  return {
    peer_initiative: {
      kind: candidate.kind,
      message: candidate.draft_message,
      message_intent: candidate.message_intent,
      action_plan: candidate.action_plan,
      worthiness: candidate.worthiness,
      grounding: candidate.grounding,
      confidence: candidate.confidence,
      max_delivery_kind: candidate.max_delivery_kind,
      ...(candidate.capability_fit ? { capability_fit: candidate.capability_fit } : {}),
      playful_style_enabled: candidate.playful_style_enabled,
    },
  };
}

function residentAdmissionFromCommitmentOutcome(
  outcome: Extract<CommitmentOperationAdapterOutcome, { outcome: "prepared" }>,
  now: string,
): ResidentAttentionAdmission {
  const deliveryOutcome = surfaceOutcomeForCommitmentOutcome(outcome);
  const outcomeDecisionId = `outcome:resident-commitment:${stableId(`${outcome.candidate.idempotencyKey}:${outcome.family}`)}`;
  const outcomeDecision = OutcomeDecisionSchema.parse({
    outcome_decision_id: outcomeDecisionId,
    initiative_decision_ref: ref("initiative_gate_decision", `gate:${outcome.candidate.candidateId}`),
    decided_at: now,
    requested_outcome: deliveryOutcome,
    admission_status: "admitted",
    final_outcome: deliveryOutcome,
    runtime_item_refs: [ref("runtime_item", outcome.candidate.agendaRef)],
    authority_checks: [{
      check_id: `authority:resident-commitment:${outcome.candidate.candidateId}`,
      kind: "authority",
      status: "passed",
      reason: "commitment operation boundary admitted preparation before peer delivery mapping",
      evidence_refs: [],
    }],
    staleness_checks: [{
      check_id: `staleness:resident-commitment:${outcome.candidate.candidateId}`,
      kind: "staleness",
      status: "passed",
      reason: "commitment child source refs were fresh at operation selection",
      evidence_refs: [],
    }],
    companion_control_checks: [],
    safety_checks: [{
      check_id: `safety:resident-commitment:${outcome.candidate.candidateId}`,
      kind: "safety",
      status: "passed",
      reason: "commitment operation adapter cannot execute external actions directly",
      evidence_refs: [],
    }],
    visibility_checks: [{
      check_id: `visibility:resident-commitment:${outcome.candidate.candidateId}`,
      kind: "visibility",
      status: "passed",
      reason: "peer initiative visibility path must still admit rendering",
      evidence_refs: [],
    }],
    visibility_policy_ref: ref("visibility_policy", `visibility:resident-commitment:${outcome.candidate.candidateId}`),
    audit_ref: ref("audit_trace", `resident-commitment:${outcome.candidate.candidateId}`),
  });
  return {
    action: "peer_initiative",
    source_kind: "resident_proactive_maintenance",
    attention_input_id: `attention-input:${outcome.candidate.candidateId}`,
    signal_context_id: `signal:${outcome.candidate.candidateId}`,
    urge_id: `urge:${outcome.candidate.candidateId}`,
    agenda_item_id: outcome.candidate.agendaRef,
    inhibition_decision_id: `inhibition:${outcome.candidate.candidateId}`,
    initiative_gate_decision_id: `gate:${outcome.candidate.candidateId}`,
    outcome_decision_id: outcomeDecision.outcome_decision_id,
    replay_disposition: "accepted",
    requested_outcome: deliveryOutcome,
    admission_status: "admitted",
    final_outcome: deliveryOutcome,
    outcome_decision: outcomeDecision,
    branch_admitted: true,
    summary: "Resident commitment operation prepared a peer initiative follow-up candidate.",
  };
}

function surfaceOutcomeForCommitmentOutcome(
  outcome: Extract<CommitmentOperationAdapterOutcome, { outcome: "prepared" }>,
): OutcomeClass {
  if (outcome.peerCandidate?.max_delivery_kind === "digest" || outcome.family === "attention.commitment.digest") {
    return "add_to_digest";
  }
  return "express_to_user";
}

export async function proactiveTick(
  context: Pick<
    DaemonRunnerResidentContext,
    "config" | "llmClient" | "state" | "logger" | "saveDaemonState" | "curiosityEngine" | "stateManager" | "goalNegotiator" | "currentGoalIds" | "supervisor" | "gateway" | "refreshOperationalState" | "abortSleep" | "baseDir" | "scheduleEngine" | "knowledgeManager" | "memoryLifecycle" | "driveSystem" | "attentionStateStore" | "residentOperationBoundaryEvaluator"
    | "feedbackIngestionStore"
  > & { personalAgentRuntime?: Pick<PersonalAgentRuntimeStore, "recordTrace"> },
  lastProactiveTickAt: number,
  setLastProactiveTickAt: (value: number) => void,
  lastGoalReviewAt: number,
  setLastGoalReviewAt: (value: number) => void,
): Promise<void> {
  if (!context.config.proactive_mode) {
    return;
  }

  if (await runScheduledGoalReview(context, lastGoalReviewAt, setLastGoalReviewAt)) {
    return;
  }

  const curiosityTriggered = await runResidentCuriosityCycle(context, {
    activityTrigger: "proactive_tick",
    skipWhenNoTriggers: true,
  });
  if (curiosityTriggered) {
    return;
  }

  if (await runResidentCommitmentAttentionCycle(context)) {
    return;
  }

  const result = await runProactiveMaintenance({
    baseDir: context.baseDir,
    config: context.config,
    llmClient: context.llmClient,
    state: context.state,
    lastProactiveTickAt,
    logger: context.logger,
  });
  setLastProactiveTickAt(result.lastProactiveTickAt);
  if (!result.decision) {
    return;
  }
  const proactiveDecision = result.decision;

  const surfaceActivityMetadata = proactiveMaintenanceSurfaceActivityMetadata(result);
  const attentionAdmission = await evaluateResidentAttentionAdmission(context, {
    action: proactiveDecision.action,
    trigger: "proactive_tick",
    details: proactiveDecision.details,
    goalId: typeof proactiveDecision.details?.["goal_id"] === "string"
      ? proactiveDecision.details["goal_id"].trim()
      : undefined,
    summary: `Resident proactive maintenance selected ${proactiveDecision.action}.`,
    surfaceActivityMetadata,
  });
  const attentionActivityMetadata = residentAttentionActivityMetadata(attentionAdmission);
  const preemptiveTargetValidation = await validateResidentPreemptiveTarget(context, proactiveDecision);
  if (preemptiveTargetValidation.status !== "not_preemptive" && preemptiveTargetValidation.status !== "current_goal") {
    const residentActivityMetadata = {
      ...surfaceActivityMetadata,
      ...attentionActivityMetadata,
    };
    await recordResidentPreemptiveTargetTrace(context, {
      result: { ...result, decision: proactiveDecision },
      attentionAdmission,
      residentActivityMetadata,
      validation: preemptiveTargetValidation,
    });
    await persistResidentActivity(context, {
      kind: "skipped",
      trigger: "proactive_tick",
      summary: preemptiveTargetValidation.summary,
      goal_id: preemptiveTargetValidation.goalId,
      ...residentActivityMetadata,
    });
    return;
  }

  const feedbackDecisionContext = await loadResidentFeedbackDecisionContext(context);
  const operationBoundary = (context.residentOperationBoundaryEvaluator ?? evaluateResidentOperationBoundary)({
    admission: attentionAdmission,
    assembledAt: new Date().toISOString(),
    details: proactiveDecision.details,
    goalId: typeof proactiveDecision.details?.["goal_id"] === "string"
      ? proactiveDecision.details["goal_id"].trim()
      : undefined,
    surfaceRef: surfaceActivityMetadata.surface_id,
    recentFeedback: feedbackDecisionContext.recentFeedback,
    invalidationEvidence: feedbackDecisionContext.invalidationEvidence,
  });
  const operationActivityMetadata = residentOperationBoundaryActivityMetadata(operationBoundary);
  const cognitionActivityMetadata = await evaluateResidentProactiveCognition({
    attentionAdmission,
    operationBoundary,
    operationActivityMetadata,
    surfaceActivityMetadata,
    baseDir: context.baseDir,
    goalId: typeof proactiveDecision.details?.["goal_id"] === "string"
      ? proactiveDecision.details["goal_id"].trim()
      : undefined,
    logger: context.logger,
  });
  const residentActivityMetadata = {
    ...surfaceActivityMetadata,
    ...attentionActivityMetadata,
    ...operationActivityMetadata,
    ...cognitionActivityMetadata,
  };
  const operationAllowed = residentOperationBoundaryAllowsPreparation(operationActivityMetadata);
  await recordResidentMaintenanceTrace(context, {
    result: { ...result, decision: proactiveDecision },
    attentionAdmission,
    operationBoundary,
    residentActivityMetadata,
    decision: !attentionAdmission.branch_admitted || !operationAllowed
      ? "hold"
      : proactiveDecision.action === "sleep"
        ? "suppress"
        : "allow",
    decisionReason: !attentionAdmission.branch_admitted
      ? attentionAdmission.summary
      : operationAllowed
        ? `Resident proactive maintenance action ${proactiveDecision.action} passed durable attention and operation boundary before execution.`
        : `Resident proactive maintenance action ${proactiveDecision.action} held by operation boundary: ${operationActivityMetadata.operation_plan_reason}`,
  });

  if (!attentionAdmission.branch_admitted) {
    await persistResidentActivity(context, {
      kind: "skipped",
      trigger: "proactive_tick",
      summary: attentionAdmission.summary,
      ...residentActivityMetadata,
    });
    return;
  }

  if (proactiveDecision.action === "sleep") {
    await persistResidentActivity(context, {
      kind: "sleep",
      trigger: "proactive_tick",
      summary: "Resident proactive tick stayed idle.",
      ...residentActivityMetadata,
    });
    return;
  }

  if (!operationAllowed) {
    await persistResidentActivity(context, {
      kind: "skipped",
      trigger: "proactive_tick",
      summary: `Resident ${proactiveDecision.action} held by operation boundary: ${operationActivityMetadata.operation_plan_reason}`,
      ...residentActivityMetadata,
    });
    return;
  }

  if (proactiveDecision.action === "suggest_goal") {
    await triggerResidentGoalDiscovery(context, proactiveDecision.details, {
      ...residentActivityMetadata,
    });
    return;
  }

  if (proactiveDecision.action === "investigate") {
    await persistResidentActivity(context, {
      kind: "observation",
      trigger: "proactive_tick",
      summary: "Resident proactive maintenance selected investigation.",
      ...residentActivityMetadata,
    });
    await triggerResidentInvestigation(context, proactiveDecision.details, {
      ...residentActivityMetadata,
    });
    return;
  }

  if (proactiveDecision.action === "preemptive_check") {
    await triggerResidentPreemptiveCheck(context, proactiveDecision.details, {
      ...residentActivityMetadata,
    });
    return;
  }

  if (proactiveDecision.action === "peer_initiative") {
    await triggerResidentPeerInitiative(context, proactiveDecision.details, {
      attentionAdmission,
      operationBoundary,
      selectionSurfaceRef: surfaceActivityMetadata.surface_id,
      metadata: residentActivityMetadata,
    });
    return;
  }

  await persistResidentActivity(context, {
    kind: "skipped",
    trigger: "proactive_tick",
    summary: `Resident proactive tick requested ${proactiveDecision.action}, but no resident executor is wired for it yet.`,
    ...residentActivityMetadata,
  });
}

export async function triggerResidentPeerInitiative(
  context: Pick<
    DaemonRunnerResidentContext,
    "baseDir" | "config" | "gateway" | "logger" | "state" | "saveDaemonState"
  >,
  details: Record<string, unknown> | undefined,
  input: {
    attentionAdmission: Awaited<ReturnType<typeof evaluateResidentAttentionAdmission>>;
    operationBoundary: ResidentOperationBoundaryResult;
    selectionSurfaceRef?: string;
    metadata: ResidentActivityMetadata;
  },
): Promise<void> {
  const now = new Date().toISOString();
  const runtimeRoot = resolveDaemonRuntimeRoot(context.baseDir, context.config.runtime_root);
  const store = new PeerInitiativeStore(
    runtimeRoot,
    { controlBaseDir: context.baseDir },
  );
  const authorityStore = new InteractionAuthorityStore(runtimeRoot, { controlBaseDir: context.baseDir });
  const policyStore = new ProactivePolicyStateStore(runtimeRoot, { controlBaseDir: context.baseDir });
  const activationStore = new ResidentActivationStore(runtimeRoot, { controlBaseDir: context.baseDir });
  const candidates = generatePeerInitiativeCandidates({
    details,
    attentionSignalRefs: [
      input.attentionAdmission.attention_input_id,
      input.attentionAdmission.signal_context_id,
      input.attentionAdmission.agenda_item_id,
    ],
    relationshipProjectionRef: input.selectionSurfaceRef,
    policyEpoch: input.attentionAdmission.initiative_gate_decision_id,
    now,
    surfaceTarget: "telegram",
  });
  const selection = selectPeerInitiativeCandidate(candidates);
  const selected = selectedPeerCandidate(candidates, selection);
  if (!selected) {
    await persistPeerInitiativeSelection(store, candidates, selection, "held");
    await persistResidentActivity(context, {
      kind: "skipped",
      trigger: "proactive_tick",
      summary: `Resident peer initiative held: ${selection.selection_reason}`,
      ...input.metadata,
      peer_initiative_selection_reason: selection.selection_reason,
    });
    return;
  }

  await store.upsertCandidate({
    candidate: selected,
    selectedState: "held",
  });
  const artifactRef = await persistPreparedPeerArtifact(store, selected, now);
  const activationBinding = await activationStore.loadActiveBinding();
  const policyState = await policyStore.updateState({
    policyId: DEFAULT_RESIDENT_ACTIVATION_POLICY_ID,
    now,
    maxDeliveryKind: DEFAULT_RESIDENT_ACTIVATION_MAX_DELIVERY_KIND,
    updater: (basePolicyState) => activationBinding
      ? applyResidentActivationBindingToPolicyState({
          state: basePolicyState,
          binding: activationBinding,
          now,
        })
      : clearInactiveResidentActivationBudgetFromPolicyState({
          state: basePolicyState,
          now,
        }),
  });
  const boundary = mapPeerInitiativeBoundary({
    candidate: selected,
    attentionAdmission: input.attentionAdmission,
    operationBoundary: input.operationBoundary,
    policyState,
    now,
  });
  const peerMetadata = {
    peer_initiative_candidate_id: selected.candidate_id,
    peer_initiative_selection_reason: selection.selection_reason,
    peer_initiative_boundary_mapping_id: boundary.mapping.mapping_id,
    peer_initiative_boundary: boundary.mapping.mapped_boundary,
    peer_initiative_threshold_delivery_kind: boundary.thresholdDecision.display_delivery_kind,
    ...(artifactRef ? { peer_prepared_artifact_ref: artifactRef } : {}),
  };
  await store.upsertCandidate({
    candidate: selected,
    selectedState: boundary.thresholdDecision.allowed_delivery_kind === "digest"
      ? "digested"
      : boundary.shouldRender ? "suggested" : "held",
  });

  const digestOnly = boundary.thresholdDecision.allowed_delivery_kind === "digest";
  if (digestOnly || !boundary.shouldRender || !input.attentionAdmission.outcome_decision) {
    const authorityDecision = await authorityStore.recordDecision(projectPeerInitiativeDeliveryAuthority({
      candidateId: selected.candidate_id,
      deliveryId: `peer-delivery:${selected.candidate_id}:held`,
      surface: "telegram",
      decidedAt: now,
      outcome: digestOnly ? "held" : "suppressed",
      canHold: true,
      canSuppress: !digestOnly,
      suppressed: !digestOnly,
      reason: digestOnly
        ? "Peer initiative was held for digest-only delivery before transport."
        : boundary.thresholdDecision.downgrade_reasons.join(", ") || "Peer initiative held by threshold or missing outcome before transport.",
      quietingRef: digestOnly ? "peer-threshold:digest-only" : "peer-threshold:render-held",
      normalSurfaceProjectionRef: `normal-surface:peer-initiative:${selected.candidate_id}`,
    }));
    await store.recordDelivery({
      delivery_id: `peer-delivery:${selected.candidate_id}:held`,
      candidate_id: selected.candidate_id,
      surface: "telegram",
      status: "held",
      failure_reason: digestOnly
        ? "peer initiative held for digest-only delivery"
        : boundary.thresholdDecision.downgrade_reasons.join(", ") || "peer initiative held by threshold or missing outcome",
      authority_decision_ref: authorityDecision.decision_id,
      authority_decision: authorityDecision,
    });
    await persistResidentActivity(context, {
      kind: "skipped",
      trigger: "proactive_tick",
      summary: "Resident peer initiative held before outbound delivery.",
      ...input.metadata,
      ...peerMetadata,
      peer_initiative_delivery_status: "held",
    });
    return;
  }

  const visibilityPolicy = createPeerInitiativeVisibilityPolicy({
    policyId: input.attentionAdmission.outcome_decision.visibility_policy_ref?.id,
    outcomeDecisionId: input.attentionAdmission.outcome_decision.outcome_decision_id,
    candidate: selected,
    digestOnly: input.attentionAdmission.outcome_decision.final_outcome === "add_to_digest",
  });
  const expression = createExpressionDecisionForOutcome({
    expression_decision_id: `expression:peer-initiative:${selected.candidate_id}`,
    outcome_decision: input.attentionAdmission.outcome_decision,
    created_at: now,
    target_surface_classes: ["gateway"],
    visibility_policy_ref: ref("visibility_policy", visibilityPolicy.visibility_policy_id),
    user_facing_rationale: selected.draft_message,
  });
  const surfaceDelivery = projectSurfaceDelivery({
    renderId: `peer-initiative:${selected.candidate_id}`,
    renderedAt: now,
    surfaceClass: "gateway",
    outcomeDecision: input.attentionAdmission.outcome_decision,
    expressionDecision: expression,
    visibilityPolicy,
    auditRef: ref("audit_trace", boundary.mapping.mapping_id),
  });
  const text = renderSurfaceDeliveryProjection(surfaceDelivery);
  if (!expression || !surfaceDelivery?.should_render || !text) {
    const authorityDecision = await authorityStore.recordDecision(projectPeerInitiativeDeliveryAuthority({
      candidateId: selected.candidate_id,
      deliveryId: `peer-delivery:${selected.candidate_id}:visibility-held`,
      surface: "telegram",
      decidedAt: now,
      outcome: "suppressed",
      canHold: true,
      canSuppress: true,
      suppressed: true,
      expressionDecisionRef: expression?.expression_decision_id,
      visibilityPolicyRef: visibilityPolicy.visibility_policy_id,
      reason: surfaceDelivery?.quiet_audit_reason ?? "Peer initiative expression or visibility policy suppressed transport.",
      quietingRef: surfaceDelivery?.quiet_audit_reason ?? "visibility-policy:quiet",
      normalSurfaceProjectionRef: `normal-surface:peer-initiative:${selected.candidate_id}`,
    }));
    await store.recordDelivery({
      delivery_id: `peer-delivery:${selected.candidate_id}:visibility-held`,
      candidate_id: selected.candidate_id,
      surface: "telegram",
      status: "held",
      expression_decision_ref: expression?.expression_decision_id,
      visibility_policy_ref: visibilityPolicy.visibility_policy_id,
      failure_reason: surfaceDelivery?.quiet_audit_reason ?? "peer expression did not render",
      authority_decision_ref: authorityDecision.decision_id,
      authority_decision: authorityDecision,
    });
    await store.upsertCandidate({
      candidate: selected,
      selectedState: "held",
    });
    await persistResidentActivity(context, {
      kind: "skipped",
      trigger: "proactive_tick",
      summary: "Resident peer initiative held by expression or visibility policy.",
      ...input.metadata,
      ...peerMetadata,
      peer_initiative_delivery_status: "held",
    });
    return;
  }

  const delivery = await deliverPeerInitiativeMessage({
    context,
    store,
    authorityStore,
    candidate: selected,
    text,
    outcomeDecisionId: input.attentionAdmission.outcome_decision.outcome_decision_id,
    expressionDecisionId: expression.expression_decision_id,
    visibilityPolicyId: visibilityPolicy.visibility_policy_id,
    now,
    canNotify: boundary.thresholdDecision.allowed_delivery_kind === "notify",
  });
  await store.upsertCandidate({
    candidate: selected,
    selectedState: selectedStateForPeerDelivery(
      delivery.status,
      boundary.thresholdDecision.allowed_delivery_kind,
    ),
    deliveredAt: delivery.status === "delivered" ? delivery.delivered_at ?? now : undefined,
  });
  if (
    boundary.thresholdDecision.budget_debit > 0
    && delivery.status === "delivered"
    && delivery.fresh_delivery
  ) {
    await policyStore.recordBudgetDebit({
      policyId: DEFAULT_RESIDENT_ACTIVATION_POLICY_ID,
      amount: boundary.thresholdDecision.budget_debit,
      debitedAt: delivery.delivered_at ?? now,
    });
  }
  await persistResidentActivity(context, {
    kind: delivery.status === "delivered" ? "observation" : "skipped",
    trigger: "proactive_tick",
    summary: delivery.status === "delivered"
      ? "Resident peer initiative delivered through outbound conversation port."
      : `Resident peer initiative delivery ${delivery.status}.`,
    ...input.metadata,
    ...peerMetadata,
    peer_initiative_message_id: delivery.message_id,
    peer_initiative_delivery_id: delivery.delivery_id,
    peer_initiative_delivery_status: delivery.status,
  });
}

function selectedStateForPeerDelivery(
  status: "pending_send" | "delivered" | "held" | "failed",
  allowedDeliveryKind: string,
): PeerInitiativeSelectedState {
  if (status === "held" || status === "failed") return "held";
  if (status === "delivered" && allowedDeliveryKind === "notify") return "notified";
  return "suggested";
}

function selectedPeerCandidate(
  candidates: readonly PeerInitiativeCandidate[],
  selection: PeerInitiativeSelection,
): PeerInitiativeCandidate | null {
  if (!selection.selected_candidate_id) return null;
  return candidates.find((candidate) => candidate.candidate_id === selection.selected_candidate_id) ?? null;
}

async function persistPeerInitiativeSelection(
  store: PeerInitiativeStore,
  candidates: readonly PeerInitiativeCandidate[],
  selection: PeerInitiativeSelection,
  selectedState: "held" | "rejected",
): Promise<void> {
  for (const candidate of candidates) {
    await store.upsertCandidate({
      candidate,
      selectedState: selection.rejected_candidate_ids.includes(candidate.candidate_id) ? "rejected" : selectedState,
    });
  }
}

async function persistPreparedPeerArtifact(
  store: PeerInitiativeStore,
  candidate: PeerInitiativeCandidate,
  now: string,
): Promise<string | undefined> {
  const plan = candidate.action_plan;
  if (plan.mode !== "internal_preparation") return undefined;
  await store.appendPreparedArtifact({
    artifact_ref: plan.prepared_artifact_ref,
    candidate_id: candidate.candidate_id,
    preparation_kind: plan.preparation_kind,
    created_at: now,
    summary: candidate.message_intent,
    content_preview: candidate.draft_message,
  });
  return plan.prepared_artifact_ref;
}

function createPeerInitiativeVisibilityPolicy(input: {
  policyId?: string;
  outcomeDecisionId: string;
  candidate: PeerInitiativeCandidate;
  digestOnly: boolean;
}): VisibilityPolicy {
  const policyId = input.policyId ?? `visibility:peer-initiative:${input.candidate.candidate_id}`;
  return VisibilityPolicySchema.parse({
    schema_version: "visibility-policy-v1",
    visibility_policy_id: policyId,
    applies_to: [ref("outcome_decision", input.outcomeDecisionId)],
    hidden_by_default: false,
    visible_in_gui: false,
    visible_in_chat: !input.digestOnly,
    visible_in_tui: false,
    visible_in_cli: false,
    visible_in_audit: true,
    visible_in_debug: true,
    digest_only: input.digestOnly,
    visible_in_digest: input.digestOnly,
    never_directly_show: false,
    // This allows only the post-gated draft message selected by the peer initiative
    // delivery path. It does not expose raw memory, trace, policy, or evidence refs.
    raw_content_allowed: true,
    inspectable_summary: input.candidate.message_intent,
    rationale: "Peer initiative passed attention, threshold, and visibility gates for a low-pressure outbound message.",
    audit_refs: [ref("audit_trace", input.candidate.candidate_id)],
  });
}

async function deliverPeerInitiativeMessage(input: {
  context: Pick<DaemonRunnerResidentContext, "gateway" | "logger">;
  store: PeerInitiativeStore;
  authorityStore: InteractionAuthorityStore;
  candidate: PeerInitiativeCandidate;
  text: string;
  outcomeDecisionId: string;
  expressionDecisionId: string;
  visibilityPolicyId: string;
  now: string;
  canNotify: boolean;
}): Promise<{
  delivery_id: string;
  message_id?: string;
  delivered_at?: string;
  status: "pending_send" | "delivered" | "held" | "failed";
  fresh_delivery: boolean;
}> {
  const surface: OutboundConversationSurface = "telegram";
  const deliveryId = `peer-delivery:${input.candidate.candidate_id}:${surface}`;
  const authorityStore = input.authorityStore;
  const existingDelivery = await input.store.getDelivery(deliveryId);
  if (existingDelivery?.status === "delivered") {
    return {
      delivery_id: deliveryId,
      message_id: existingDelivery.message_id,
      delivered_at: existingDelivery.delivered_at,
      status: "delivered",
      fresh_delivery: false,
    };
  }
  const port = input.context.gateway?.getOutboundConversationPort(surface);
  if (!port) {
    const authorityDecision = await authorityStore.recordDecision(projectPeerInitiativeDeliveryAuthority({
      candidateId: input.candidate.candidate_id,
      deliveryId,
      surface,
      decidedAt: input.now,
      outcome: "held",
      canHold: true,
      reason: "No live gateway outbound conversation port for Telegram.",
      normalSurfaceProjectionRef: `normal-surface:peer-initiative:${input.candidate.candidate_id}`,
    }));
    await input.store.recordDelivery({
      delivery_id: deliveryId,
      candidate_id: input.candidate.candidate_id,
      surface,
      status: "held",
      failure_reason: "no live gateway outbound conversation port for telegram",
      authority_decision_ref: authorityDecision.decision_id,
      authority_decision: authorityDecision,
    });
    return { delivery_id: deliveryId, status: "held", fresh_delivery: false };
  }
  const target = await port.resolveDefaultTarget();
  if (!target) {
    const authorityDecision = await authorityStore.recordDecision(projectPeerInitiativeDeliveryAuthority({
      candidateId: input.candidate.candidate_id,
      deliveryId,
      surface,
      decidedAt: input.now,
      outcome: "held",
      canHold: true,
      reason: "Telegram outbound conversation target is not bound.",
      normalSurfaceProjectionRef: `normal-surface:peer-initiative:${input.candidate.candidate_id}`,
    }));
    await input.store.recordDelivery({
      delivery_id: deliveryId,
      candidate_id: input.candidate.candidate_id,
      surface,
      status: "held",
      failure_reason: "telegram outbound conversation target is not bound",
      authority_decision_ref: authorityDecision.decision_id,
      authority_decision: authorityDecision,
    });
    return { delivery_id: deliveryId, status: "held", fresh_delivery: false };
  }
  const actionButtons = peerInitiativeActionButtons({
    candidate: input.candidate,
    outcomeDecisionId: input.outcomeDecisionId,
    feedbackEpoch: input.now,
  });
  const peerMessage = PeerInitiativeMessageSchema.parse({
    message_id: `peer-message:${input.candidate.candidate_id}`,
    candidate_id: input.candidate.candidate_id,
    expression_decision_ref: input.expressionDecisionId,
    visibility_policy_ref: input.visibilityPolicyId,
    surface,
    text: input.text,
    reply_required: false,
    action_buttons: actionButtons,
    thread_behavior: "new_lightweight_thread",
  });
  const outbound = OutboundConversationMessageSchema.parse({
    message_id: peerMessage.message_id,
    surface,
    target_binding_ref: target.target_binding_ref,
    channel_policy_ref: target.channel_policy_ref,
    text: peerMessage.text,
    reply_required: false,
    source: "peer_initiative",
    candidate_id: peerMessage.candidate_id,
    expression_decision_ref: peerMessage.expression_decision_ref,
    visibility_policy_ref: peerMessage.visibility_policy_ref,
    trigger_actions: actionButtons.filter((action) =>
      action.action === "show_prepared"
        || action.action === "use_once"
        || action.action === "approve_external_action"
    ),
    feedback_actions: actionButtons.filter((action) =>
      action.action === "more_like_this"
        || action.action === "less_like_this"
        || action.action === "not_now"
        || action.action === "wrong_read"
        || action.action === "mute_this_kind"
    ),
  });
  const claim = await input.store.claimDelivery({
    delivery_id: deliveryId,
    candidate_id: input.candidate.candidate_id,
    surface,
    status: "pending_send",
    message_id: peerMessage.message_id,
    target_binding_ref: target.target_binding_ref,
    expression_decision_ref: input.expressionDecisionId,
    visibility_policy_ref: input.visibilityPolicyId,
    outbound_message: outbound,
  });
  if (claim.status === "existing") {
    return {
      delivery_id: deliveryId,
      message_id: claim.record.message_id,
      delivered_at: claim.record.delivered_at,
      status: claim.record.status,
      fresh_delivery: false,
    };
  }
  try {
    const authorityDecision = await authorityStore.recordDecision(projectOutboundConversationAuthority({
      message: outbound,
      currentTarget: target,
      decidedAt: input.now,
      decisionId: `execution-authority:${deliveryId}:send`,
      canNotify: input.canNotify,
      deliveryRef: deliveryId,
      surfaceClass: "mutation_owner",
      normalSurfaceProjectionRef: `normal-surface:peer-initiative:${input.candidate.candidate_id}`,
    }));
    if (!authorityDecision.can_send) {
      await input.store.recordDelivery({
        delivery_id: deliveryId,
        candidate_id: input.candidate.candidate_id,
        surface,
        status: "held",
        message_id: peerMessage.message_id,
        target_binding_ref: target.target_binding_ref,
        expression_decision_ref: input.expressionDecisionId,
        visibility_policy_ref: input.visibilityPolicyId,
        outbound_message: outbound,
        failure_reason: authorityDecision.reason,
        authority_decision_ref: authorityDecision.decision_id,
        authority_decision: authorityDecision,
      });
      return {
        delivery_id: deliveryId,
        message_id: peerMessage.message_id,
        status: "held",
        fresh_delivery: false,
      };
    }
    const receipt = await port.sendOutboundConversationMessage(outbound);
    const deliveredAuthorityDecision = await authorityStore.recordDecision(projectOutboundConversationAuthority({
      message: outbound,
      currentTarget: target,
      receipt,
      decidedAt: receipt.delivered_at,
      decisionId: authorityDecision.decision_id,
      canNotify: input.canNotify,
      deliveryRef: deliveryId,
      surfaceClass: "mutation_owner",
      normalSurfaceProjectionRef: `normal-surface:peer-initiative:${input.candidate.candidate_id}`,
    }));
    await input.store.recordDelivery({
      delivery_id: deliveryId,
      candidate_id: input.candidate.candidate_id,
      surface,
      status: "delivered",
      delivered_at: receipt.delivered_at,
      message_id: receipt.message_id,
      transport_message_ref: receipt.transport_message_ref,
      target_binding_ref: receipt.target_binding_ref,
      expression_decision_ref: input.expressionDecisionId,
      visibility_policy_ref: input.visibilityPolicyId,
      outbound_message: outbound,
      authority_decision_ref: deliveredAuthorityDecision.decision_id,
      authority_decision: deliveredAuthorityDecision,
    });
    return {
      delivery_id: deliveryId,
      message_id: receipt.message_id,
      delivered_at: receipt.delivered_at,
      status: "delivered",
      fresh_delivery: true,
    };
  } catch (error) {
    const authorityDecision = await authorityStore.recordDecision(projectPeerInitiativeDeliveryAuthority({
      candidateId: input.candidate.candidate_id,
      deliveryId,
      surface,
      decidedAt: new Date().toISOString(),
      outcome: "fail_closed",
      failClosed: true,
      targetBindingRef: target.target_binding_ref,
      channelPolicyRef: target.channel_policy_ref,
      expressionDecisionRef: input.expressionDecisionId,
      visibilityPolicyRef: input.visibilityPolicyId,
      reason: error instanceof Error ? error.message : String(error),
      normalSurfaceProjectionRef: `normal-surface:peer-initiative:${input.candidate.candidate_id}`,
    }));
    await input.store.recordDelivery({
      delivery_id: deliveryId,
      candidate_id: input.candidate.candidate_id,
      surface,
      status: "failed",
      message_id: peerMessage.message_id,
      target_binding_ref: target.target_binding_ref,
      expression_decision_ref: input.expressionDecisionId,
      visibility_policy_ref: input.visibilityPolicyId,
      outbound_message: outbound,
      failure_reason: error instanceof Error ? error.message : String(error),
      authority_decision_ref: authorityDecision.decision_id,
      authority_decision: authorityDecision,
    });
    input.context.logger.warn("Resident peer initiative outbound delivery failed", {
      candidate_id: input.candidate.candidate_id,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      delivery_id: deliveryId,
      message_id: peerMessage.message_id,
      status: "failed",
      fresh_delivery: false,
    };
  }
}

async function validateResidentPreemptiveTarget(
  context: Pick<DaemonRunnerResidentContext, "stateManager">,
  decision: NonNullable<ProactiveMaintenanceResult["decision"]>,
): Promise<ResidentPreemptiveTargetValidation> {
  if (decision.action !== "preemptive_check") {
    return { status: "not_preemptive" };
  }
  const goalId = typeof decision.details?.["goal_id"] === "string"
    ? decision.details["goal_id"].trim()
    : "";
  if (!goalId) {
    return {
      status: "missing_goal_id",
      summary: "Resident preemptive check skipped because no goal_id was provided.",
      capabilityDecision: "missing",
    };
  }
  const goal = await context.stateManager.loadGoal(goalId).catch(() => null);
  if (!goal) {
    return {
      status: "missing_goal",
      goalId,
      summary: `Resident preemptive check skipped because goal "${goalId}" was not found.`,
      capabilityDecision: "missing",
    };
  }
  if (!residentPreemptiveGoalIsCurrent(goal)) {
    return {
      status: "stale_goal",
      goalId,
      summary: `Resident preemptive check skipped because goal "${goalId}" is not current.`,
      capabilityDecision: "blocked",
    };
  }
  return { status: "current_goal", goalId };
}

async function recordResidentPreemptiveTargetTrace(
  context: Pick<DaemonRunnerResidentContext, "baseDir"> & {
    personalAgentRuntime?: Pick<PersonalAgentRuntimeStore, "recordTrace">;
  },
  input: {
    result: ProactiveMaintenanceResult & { decision: NonNullable<ProactiveMaintenanceResult["decision"]> };
    attentionAdmission: Awaited<ReturnType<typeof evaluateResidentAttentionAdmission>>;
    residentActivityMetadata: ResidentActivityMetadata;
    validation: Extract<
      ResidentPreemptiveTargetValidation,
      { status: "missing_goal_id" | "missing_goal" | "stale_goal" }
    >;
  },
): Promise<void> {
  const store = context.personalAgentRuntime ?? new PersonalAgentRuntimeStore(
    context.baseDir,
    { controlBaseDir: context.baseDir },
  );
  const observedAt = new Date().toISOString();
  const targetRef: RuntimeGraphRef = input.validation.goalId
    ? { kind: "goal", ref: input.validation.goalId }
    : {
        kind: "resident_action",
        ref: [
          "proactive_tick",
          input.result.lastProactiveTickAt,
          input.result.decision.action,
          "goal:none",
        ].join(":"),
      };
  const goalRef = input.validation.goalId ? [{ kind: "goal", ref: input.validation.goalId } satisfies RuntimeGraphRef] : [];
  await store.recordTrace(buildPersonalAgentDecisionTrace({
    callerPath: "resident_proactive",
    source: {
      sourceKind: "resident_observation",
      sourceId: `proactive_tick:${input.result.lastProactiveTickAt}:${input.result.decision.action}`,
      emittedAt: observedAt,
      sourceEpoch: String(input.result.lastProactiveTickAt),
      highWatermark: input.attentionAdmission.initiative_gate_decision_id,
      replayKey: [
        "resident_proactive_maintenance",
        input.result.lastProactiveTickAt,
        input.result.decision.action,
        input.validation.goalId ?? "goal:none",
        input.validation.status,
        input.attentionAdmission.initiative_gate_decision_id,
      ].join(":"),
      summary: `Resident proactive maintenance selected ${input.result.decision.action}.`,
      sourceRef: { kind: "attention_input", ref: input.attentionAdmission.attention_input_id },
    },
    target: {
      kind: "attention_only",
      ref: targetRef,
      effect: "hold_concern",
      summary: `Resident preemptive target validation ${input.validation.status}.`,
    },
    decision: "block",
    decisionReason: input.validation.summary,
    capabilityDecision: input.validation.capabilityDecision,
    capabilityRefs: goalRef,
    policyRef: { kind: "intervention_policy", ref: "policy:resident-proactive-maintenance-v1" },
    currentRefs: [
      { kind: "agent_agenda_item", ref: input.attentionAdmission.agenda_item_id },
    ],
    staleRefs: input.validation.status === "stale_goal" ? goalRef : [],
    uncertaintyRefs: input.validation.status === "missing_goal" || input.validation.status === "missing_goal_id"
      ? goalRef
      : [],
    auditRefs: [
      { kind: "initiative_gate_decision", ref: input.attentionAdmission.initiative_gate_decision_id },
      ...goalRef,
    ],
  }));
}

async function recordResidentMaintenanceTrace(
  context: Pick<DaemonRunnerResidentContext, "baseDir"> & {
    personalAgentRuntime?: Pick<PersonalAgentRuntimeStore, "recordTrace">;
  },
  input: {
    result: ProactiveMaintenanceResult & { decision: NonNullable<ProactiveMaintenanceResult["decision"]> };
    attentionAdmission: Awaited<ReturnType<typeof evaluateResidentAttentionAdmission>>;
    operationBoundary: ResidentOperationBoundaryResult;
    residentActivityMetadata: ResidentActivityMetadata;
    decision: InterventionDecisionKind;
    decisionReason: string;
  },
): Promise<void> {
  const store = context.personalAgentRuntime ?? new PersonalAgentRuntimeStore(
    context.baseDir,
    { controlBaseDir: context.baseDir },
  );
  const observedAt = new Date().toISOString();
  const goalId = typeof input.result.decision.details?.["goal_id"] === "string"
    ? input.result.decision.details["goal_id"].trim()
    : undefined;
  const targetRef = residentMaintenanceTargetRef(input.result, goalId);
  const operationRefs = residentMaintenanceOperationRefs(input.residentActivityMetadata);
  await store.recordTrace(buildPersonalAgentDecisionTrace({
    callerPath: "resident_proactive",
    source: {
      sourceKind: "resident_observation",
      sourceId: `proactive_tick:${input.result.lastProactiveTickAt}:${input.result.decision.action}`,
      emittedAt: observedAt,
      sourceEpoch: String(input.result.lastProactiveTickAt),
      highWatermark: input.attentionAdmission.initiative_gate_decision_id,
      replayKey: [
        "resident_proactive_maintenance",
        input.result.lastProactiveTickAt,
        input.result.decision.action,
        goalId ?? "goal:none",
        input.attentionAdmission.initiative_gate_decision_id,
      ].join(":"),
      summary: `Resident proactive maintenance selected ${input.result.decision.action}.`,
      sourceRef: { kind: "attention_input", ref: input.attentionAdmission.attention_input_id },
    },
    target: {
      kind: input.result.decision.action === "suggest_goal" ? "task" : "attention_only",
      ref: targetRef,
      effect: input.result.decision.action === "suggest_goal" ? "create_task" : "continue_route",
      summary: `Resident proactive maintenance action ${input.result.decision.action}.`,
    },
    decision: input.decision,
    decisionReason: input.decisionReason,
    capabilityDecision: input.operationBoundary.preparation_allowed ? "available" : "blocked",
    capabilityRefs: operationRefs,
    policyRef: { kind: "intervention_policy", ref: "policy:resident-proactive-maintenance-v1" },
    currentRefs: [
      { kind: "agent_agenda_item", ref: input.attentionAdmission.agenda_item_id },
      ...(goalId ? [{ kind: "goal", ref: goalId }] : []),
    ],
    auditRefs: [
      { kind: "initiative_gate_decision", ref: input.attentionAdmission.initiative_gate_decision_id },
      ...operationRefs,
    ],
  }));
}

function residentMaintenanceTargetRef(
  result: ProactiveMaintenanceResult & { decision: NonNullable<ProactiveMaintenanceResult["decision"]> },
  goalId: string | undefined,
): RuntimeGraphRef {
  if (result.decision.action === "preemptive_check" && goalId) {
    return { kind: "goal", ref: goalId };
  }
  return {
    kind: "resident_action",
    ref: [
      "proactive_tick",
      result.lastProactiveTickAt,
      result.decision.action,
      goalId ?? "goal:none",
    ].join(":"),
  };
}

function residentMaintenanceOperationRefs(metadata: ResidentActivityMetadata): RuntimeGraphRef[] {
  return [
    metadata.operation_plan_assembly_id
      ? { kind: "operation_plan_assembly", ref: metadata.operation_plan_assembly_id }
      : null,
    metadata.operation_plan_id
      ? { kind: "runtime_control", ref: metadata.operation_plan_id }
      : null,
    metadata.operation_admission_evaluation_id
      ? { kind: "operation_admission_evaluation", ref: metadata.operation_admission_evaluation_id }
      : null,
    metadata.autonomy_decision_id
      ? { kind: "autonomy_decision", ref: metadata.autonomy_decision_id }
      : null,
  ].filter((ref): ref is RuntimeGraphRef => ref !== null);
}

export async function evaluateResidentProactiveCognition(input: {
  attentionAdmission: Awaited<ReturnType<typeof evaluateResidentAttentionAdmission>>;
  operationBoundary?: ResidentOperationBoundaryResult;
  operationActivityMetadata: ResidentActivityMetadata;
  surfaceActivityMetadata: ResidentSurfaceActivityMetadata;
  baseDir?: string;
  goalId?: string;
  logger: DaemonRunnerResidentContext["logger"];
}): Promise<ResidentCognitionActivityMetadata> {
  const cognitionId = residentProactiveCognitionId(input.attentionAdmission.initiative_gate_decision_id);
  const eventRef = {
    ref: input.attentionAdmission.initiative_gate_decision_id,
    source_store: "attention_ledger" as const,
    source_event_type: "resident_attention_admission",
    schema_version: 1,
    source_epoch: input.attentionAdmission.initiative_gate_decision_id,
    redaction_policy: "metadata_only" as const,
  };
  const operationBoundary = residentOperationBoundaryAllowsPreparation(input.operationActivityMetadata)
    ? "allowed"
    : input.operationActivityMetadata.operation_plan_status === "planned"
      ? "held"
      : "blocked";
  const maxDeliveryKind = operationBoundary === "allowed" ? "suggest" : "hold";
  const cognitionInput: CompanionCognitionInput = {
    cognition_id: cognitionId,
    caller_path: "resident_proactive_check",
    event_refs: [eventRef],
    working_context: {
      input_ref: eventRef,
      route_ref: {
        kind: "resident_action",
        ref: input.attentionAdmission.action,
      },
      turn_started_at: new Date().toISOString(),
      hidden_prompt_content_materialized: false,
    },
    attention_context: {
      attention_input_ref: {
        kind: "attention_input",
        ref: input.attentionAdmission.attention_input_id,
      },
      agenda_ref: {
        kind: "agent_agenda_item",
        ref: input.attentionAdmission.agenda_item_id,
      },
      admission_status: input.attentionAdmission.admission_status === "admitted"
        ? "admitted"
        : input.attentionAdmission.replay_disposition === "duplicate"
          ? "duplicate"
          : input.attentionAdmission.admission_status === "not_selected"
            ? "not_selected"
            : "held",
      initiative_gate_decision_id: input.attentionAdmission.initiative_gate_decision_id,
      operation_boundary: operationBoundary,
      ...(input.operationActivityMetadata.operation_plan_id ? { operation_plan_ref: input.operationActivityMetadata.operation_plan_id } : {}),
      max_delivery_kind: maxDeliveryKind,
      feedback_policy_refs: [],
    },
    goal_context: input.goalId
      ? {
          active_goals: [{
            goal_id: input.goalId,
            goal_ref: {
              kind: "goal",
              ref: input.goalId,
            },
            lifecycle: "active",
            priority: "unknown",
          }],
          active_intention_refs: [],
          stale_target_refs: [],
        }
      : undefined,
    proposed_tool_candidates: input.operationBoundary
      ? residentToolCandidatesFromOperationBoundary({
          cognitionId,
          boundary: input.operationBoundary,
          eventRef,
        })
      : [],
    memory_context_request: {
      request_id: `${cognitionId}:memory-request`,
      requested_uses: ["proactive_action_candidate", "behavioral_inhibition"],
      caller_path: "resident_proactive_check",
      query_ref: eventRef,
      surface_projection_required: true,
      side_effect_authorization_allowed: false,
      include_sensitive_content: false,
    },
    surface_target: "internal_audit",
  };

  try {
    const auditSink = new InMemoryCognitionAuditSink();
    const output = await new CompanionCognitionService({
      auditSink,
      ...(input.baseDir
        ? {
            memoryPort: createRelationshipProfileCognitionMemoryPort({
              baseDir: input.baseDir,
            }),
          }
        : {}),
    }).evaluateIntervention(cognitionInput);
    const replayRecord = auditSink.list()[0];
    let replayRecordId: string | undefined;
    let replayIndexEntryId: string | undefined;
    if (input.baseDir && replayRecord) {
      try {
        await new FileCognitionAuditSink(input.baseDir).recordCognition(replayRecord);
        replayRecordId = replayRecord.record_id;
        const replayIndexEntry = createCognitiveReplayIndexEntry({
          indexEntryId: `${cognitionId}:replay-index`,
          record: replayRecord,
        });
        await new FileCognitiveReplayIndexStore(input.baseDir).upsert(replayIndexEntry);
        replayIndexEntryId = replayIndexEntry.index_entry_id;
      } catch (err) {
        input.logger.warn("Resident proactive cognition replay persistence failed; continuing with resident gates", {
          error: err instanceof Error ? err.message : String(err),
          cognition_id: cognitionId,
        });
      }
    }
    return {
      cognition_id: output.cognition_id,
      cognition_response_plan_id: output.response_plan.plan_id,
      cognition_delivery_kind: output.response_plan.delivery_kind,
      cognition_writeback_proposal_count: output.memory_writeback.length,
      cognition_tool_candidate_count: output.tool_candidates.length,
      ...(replayRecordId ? { cognition_replay_record_id: replayRecordId } : {}),
      ...(replayIndexEntryId ? { cognition_replay_index_entry_id: replayIndexEntryId } : {}),
    };
  } catch (err) {
    input.logger.warn("Resident proactive cognition failed; continuing with resident gates", {
      error: err instanceof Error ? err.message : String(err),
      cognition_id: cognitionId,
    });
    return {
      cognition_id: cognitionId,
      cognition_delivery_kind: "hold",
      cognition_writeback_proposal_count: 0,
      cognition_tool_candidate_count: 0,
    };
  }
}

function residentProactiveCognitionId(initiativeGateDecisionId: string): string {
  return `cognition:resident:${initiativeGateDecisionId}:evaluation:${randomUUID()}`;
}

function residentToolCandidatesFromOperationBoundary(input: {
  cognitionId: string;
  boundary: ResidentOperationBoundaryResult;
  eventRef: CognitionEventRef;
}): ToolCandidate[] {
  const operationCandidate = input.boundary.assembly.candidate_plans[0];
  if (
    !input.boundary.preparation_allowed
    || !operationCandidate
    || !input.boundary.admission_evaluation
    || !input.boundary.autonomy_decision
  ) {
    return [];
  }
  const projection = projectCompanionAction({
    decision: input.boundary.autonomy_decision,
    context: {
      surface_ref: "surface:resident-daemon",
      surface_kind: "normal_companion",
      quieted: !input.boundary.preparation_allowed,
    },
    evaluated_at: input.boundary.assembly.assembled_at,
  });
  const gadgetPlan = createCompanionGadgetPlan({
    assetKind: "capability",
    operationCandidate,
    admissionEvaluation: input.boundary.admission_evaluation,
    autonomyDecision: input.boundary.autonomy_decision,
    actionProjection: projection,
    generatedAt: input.boundary.assembly.assembled_at,
  });
  return [
    toolCandidateFromGadgetPlan({
      candidateId: `${input.cognitionId}:tool-candidate:${operationCandidate.plan_id}`,
      plan: gadgetPlan,
      originRef: input.eventRef,
    }),
  ];
}

function residentPreemptiveGoalIsCurrent(goal: Goal): boolean {
  return goal.status === "active";
}
