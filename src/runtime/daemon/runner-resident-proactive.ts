import type { Goal } from "../../base/types/goal.js";
import {
  evaluateResidentOperationBoundary,
  residentOperationBoundaryActivityMetadata,
} from "../capability-operation-planner.js";
import { CompanionCognitionService, type CompanionCognitionInput } from "../cognition/index.js";
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
  >,
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

  const surfaceActivityMetadata = proactiveMaintenanceSurfaceActivityMetadata(result);
  if (result.decision.action === "preemptive_check") {
    const goalId = typeof result.decision.details?.["goal_id"] === "string"
      ? result.decision.details["goal_id"].trim()
      : "";
    const goal = goalId
      ? await context.stateManager.loadGoal(goalId).catch(() => null)
      : null;
    if (!goal || !residentPreemptiveGoalIsCurrent(goal)) {
      await triggerResidentPreemptiveCheck(context, result.decision.details, surfaceActivityMetadata);
      return;
    }
  }

  const attentionAdmission = await evaluateResidentAttentionAdmission(context, {
    action: result.decision.action,
    trigger: "proactive_tick",
    details: result.decision.details,
    goalId: typeof result.decision.details?.["goal_id"] === "string"
      ? result.decision.details["goal_id"].trim()
      : undefined,
    summary: `Resident proactive maintenance selected ${result.decision.action}.`,
    surfaceActivityMetadata,
  });
  const attentionActivityMetadata = residentAttentionActivityMetadata(attentionAdmission);
  const feedbackDecisionContext = await loadResidentFeedbackDecisionContext(context);
  const operationBoundary = (context.residentOperationBoundaryEvaluator ?? evaluateResidentOperationBoundary)({
    admission: attentionAdmission,
    assembledAt: new Date().toISOString(),
    details: result.decision.details,
    goalId: typeof result.decision.details?.["goal_id"] === "string"
      ? result.decision.details["goal_id"].trim()
      : undefined,
    surfaceRef: surfaceActivityMetadata.surface_id,
    recentFeedback: feedbackDecisionContext.recentFeedback,
    invalidationEvidence: feedbackDecisionContext.invalidationEvidence,
  });
  const operationActivityMetadata = residentOperationBoundaryActivityMetadata(operationBoundary);
  const cognitionActivityMetadata = await evaluateResidentProactiveCognition({
    attentionAdmission,
    operationActivityMetadata,
    surfaceActivityMetadata,
    goalId: typeof result.decision.details?.["goal_id"] === "string"
      ? result.decision.details["goal_id"].trim()
      : undefined,
    logger: context.logger,
  });
  const residentActivityMetadata = {
    ...surfaceActivityMetadata,
    ...attentionActivityMetadata,
    ...operationActivityMetadata,
    ...cognitionActivityMetadata,
  };

  if (!attentionAdmission.branch_admitted) {
    await persistResidentActivity(context, {
      kind: "skipped",
      trigger: "proactive_tick",
      summary: attentionAdmission.summary,
      ...residentActivityMetadata,
    });
    return;
  }

  if (result.decision.action === "sleep") {
    await persistResidentActivity(context, {
      kind: "sleep",
      trigger: "proactive_tick",
      summary: "Resident proactive tick stayed idle.",
      ...residentActivityMetadata,
    });
    return;
  }

  if (!residentOperationBoundaryAllowsPreparation(operationActivityMetadata)) {
    await persistResidentActivity(context, {
      kind: "skipped",
      trigger: "proactive_tick",
      summary: `Resident ${result.decision.action} held by operation boundary: ${operationActivityMetadata.operation_plan_reason}`,
      ...residentActivityMetadata,
    });
    return;
  }

  if (result.decision.action === "suggest_goal") {
    await triggerResidentGoalDiscovery(context, result.decision.details, {
      ...residentActivityMetadata,
    });
    return;
  }

  if (result.decision.action === "investigate") {
    await persistResidentActivity(context, {
      kind: "observation",
      trigger: "proactive_tick",
      summary: "Resident proactive maintenance selected investigation.",
      ...residentActivityMetadata,
    });
    await triggerResidentInvestigation(context, result.decision.details, {
      ...residentActivityMetadata,
    });
    return;
  }

  if (result.decision.action === "preemptive_check") {
    await triggerResidentPreemptiveCheck(context, result.decision.details, {
      ...residentActivityMetadata,
    });
    return;
  }

  await persistResidentActivity(context, {
    kind: "skipped",
    trigger: "proactive_tick",
    summary: `Resident proactive tick requested ${result.decision.action}, but no resident executor is wired for it yet.`,
    ...residentActivityMetadata,
  });
}

export async function evaluateResidentProactiveCognition(input: {
  attentionAdmission: Awaited<ReturnType<typeof evaluateResidentAttentionAdmission>>;
  operationActivityMetadata: ResidentActivityMetadata;
  surfaceActivityMetadata: ResidentSurfaceActivityMetadata;
  goalId?: string;
  logger: DaemonRunnerResidentContext["logger"];
}): Promise<ResidentCognitionActivityMetadata> {
  const cognitionId = `cognition:resident:${input.attentionAdmission.initiative_gate_decision_id}`;
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
    const output = await new CompanionCognitionService().evaluateIntervention(cognitionInput);
    return {
      cognition_id: output.cognition_id,
      cognition_response_plan_id: output.response_plan.plan_id,
      cognition_delivery_kind: output.response_plan.delivery_kind,
      cognition_writeback_proposal_count: output.memory_writeback.length,
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
    };
  }
}

function residentPreemptiveGoalIsCurrent(goal: Goal): boolean {
  return goal.status === "active";
}
