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
import { createCompanionGadgetPlan } from "../decision/companion-gadget-planning.js";
import {
  FileCognitiveReplayIndexStore,
  createCognitiveReplayIndexEntry,
} from "../visibility/index.js";
import { runProactiveMaintenance, type ProactiveMaintenanceResult } from "./maintenance.js";
import {
  evaluateResidentAttentionAdmission,
  residentAttentionActivityMetadata,
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

export async function proactiveTick(
  context: Pick<
    DaemonRunnerResidentContext,
    "config" | "llmClient" | "state" | "logger" | "saveDaemonState" | "curiosityEngine" | "stateManager" | "goalNegotiator" | "currentGoalIds" | "supervisor" | "refreshOperationalState" | "abortSleep" | "baseDir" | "scheduleEngine" | "knowledgeManager" | "memoryLifecycle" | "driveSystem" | "attentionStateStore" | "residentOperationBoundaryEvaluator"
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

  await persistResidentActivity(context, {
    kind: "skipped",
    trigger: "proactive_tick",
    summary: `Resident proactive tick requested ${proactiveDecision.action}, but no resident executor is wired for it yet.`,
    ...residentActivityMetadata,
  });
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
