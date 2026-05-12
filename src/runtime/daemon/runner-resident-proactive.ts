import type { Goal } from "../../base/types/goal.js";
import { runProactiveMaintenance, type ProactiveMaintenanceResult } from "./maintenance.js";
import {
  evaluateResidentAttentionAdmission,
  residentAttentionActivityMetadata,
} from "./resident-attention-orchestrator.js";
import type {
  ResidentActivityMetadata,
  DaemonRunnerResidentContext,
  ResidentSurfaceActivityMetadata,
} from "./runner-resident-shared.js";
import { persistResidentActivity } from "./runner-resident-shared.js";
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
    "config" | "llmClient" | "state" | "logger" | "saveDaemonState" | "curiosityEngine" | "stateManager" | "goalNegotiator" | "currentGoalIds" | "supervisor" | "refreshOperationalState" | "abortSleep" | "baseDir" | "scheduleEngine" | "knowledgeManager" | "memoryLifecycle" | "driveSystem" | "attentionStateStore"
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

  if (!attentionAdmission.branch_admitted) {
    await persistResidentActivity(context, {
      kind: "skipped",
      trigger: "proactive_tick",
      summary: attentionAdmission.summary,
      ...surfaceActivityMetadata,
      ...attentionActivityMetadata,
    });
    return;
  }

  if (result.decision.action === "sleep") {
    await persistResidentActivity(context, {
      kind: "sleep",
      trigger: "proactive_tick",
      summary: "Resident proactive tick stayed idle.",
      ...surfaceActivityMetadata,
      ...attentionActivityMetadata,
    });
    return;
  }

  if (result.decision.action === "suggest_goal") {
    await triggerResidentGoalDiscovery(context, result.decision.details, {
      ...surfaceActivityMetadata,
      ...attentionActivityMetadata,
    });
    return;
  }

  if (result.decision.action === "investigate") {
    await persistResidentActivity(context, {
      kind: "observation",
      trigger: "proactive_tick",
      summary: "Resident proactive maintenance selected investigation.",
      ...surfaceActivityMetadata,
      ...attentionActivityMetadata,
    });
    await triggerResidentInvestigation(context, result.decision.details, {
      ...surfaceActivityMetadata,
      ...attentionActivityMetadata,
    });
    return;
  }

  if (result.decision.action === "preemptive_check") {
    await triggerResidentPreemptiveCheck(context, result.decision.details, {
      ...surfaceActivityMetadata,
      ...attentionActivityMetadata,
    });
    return;
  }

  await persistResidentActivity(context, {
    kind: "skipped",
    trigger: "proactive_tick",
    summary: `Resident proactive tick requested ${result.decision.action}, but no resident executor is wired for it yet.`,
    ...surfaceActivityMetadata,
    ...attentionActivityMetadata,
  });
}

function residentPreemptiveGoalIsCurrent(goal: Goal): boolean {
  return goal.status === "active";
}
