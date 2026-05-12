import type { ResidentActivity } from "../../base/types/daemon.js";
import {
  evaluateResidentOperationBoundary,
  residentOperationBoundaryActivityMetadata,
} from "../capability-operation-planner.js";
import {
  buildRelationshipProfileSurfaceProjection,
  formatRelationshipProfileSurfaceContext,
  loadRelationshipProfileSurfaceContext,
} from "../../grounding/profile-surface.js";
import {
  createSurfaceInspectionAdapterPayload,
  type SurfaceProjection,
} from "../../grounding/surface-contracts.js";
import type { DaemonRunnerResidentContext } from "./runner-resident-shared.js";
import {
  evaluateResidentAttentionAdmission,
  residentAttentionActivityMetadata,
} from "./resident-attention-orchestrator.js";
import {
  gatherResidentWorkspaceContext,
  loadExistingGoalTitles,
  loadKnownGoals,
  mergeResidentSurfaceActivityMetadata,
  persistResidentActivity,
  residentOperationBoundaryAllowsPreparation,
  type ResidentActivityMetadata,
  type ResidentSurfaceActivityMetadata,
  resolveResidentSuggestionSurface,
  resolveResidentWorkspaceDir,
} from "./runner-resident-shared.js";

export async function triggerResidentGoalDiscovery(
  context: Pick<
    DaemonRunnerResidentContext,
    "goalNegotiator" | "currentGoalIds" | "config" | "logger"
  > &
    Pick<DaemonRunnerResidentContext, "saveDaemonState" | "state" | "stateManager">,
  details?: Record<string, unknown>,
  activityMetadata: ResidentActivityMetadata = {},
): Promise<void> {
  if (!context.goalNegotiator) {
    await persistResidentActivity(context, {
      kind: "skipped",
      trigger: "proactive_tick",
      summary: "Resident discovery skipped because goal negotiation is unavailable.",
      ...activityMetadata,
    });
    return;
  }

  if (context.currentGoalIds.length > 0) {
    await persistResidentActivity(context, {
      kind: "skipped",
      trigger: "proactive_tick",
      summary: "Resident discovery skipped because active goals are already running.",
      ...activityMetadata,
    });
    return;
  }
  if (!residentOperationBoundaryAllowsPreparation(activityMetadata)) {
    await persistResidentActivity(context, {
      kind: "skipped",
      trigger: "proactive_tick",
      summary: "Resident discovery skipped because operation boundary did not allow preparation.",
      ...activityMetadata,
    });
    return;
  }

  const hintedDescription =
    typeof details?.["description"] === "string" ? details["description"].trim() : "";
  const hintedTitle =
    typeof details?.["title"] === "string" ? details["title"].trim() : "";

  try {
    const workspaceDir = resolveResidentWorkspaceDir(context.config.workspace_path);
    const workspaceContext = gatherResidentWorkspaceContext(workspaceDir, hintedDescription);
    const existingTitles = await loadExistingGoalTitles(context);
    const suggestionSurface = resolveResidentSuggestionSurface(workspaceDir);
    const suggestions = await context.goalNegotiator.suggestGoals(workspaceContext, {
      maxSuggestions: 1,
      existingGoals: existingTitles,
      repoPath: workspaceDir,
      suggestionSurface,
    });
    const suggestion = suggestions[0];
    const suggestionTitle = suggestion?.title ?? hintedTitle;
    const negotiationDescription = suggestion?.description ?? hintedDescription;

    if (!negotiationDescription) {
      await persistResidentActivity(context, {
        kind: "suggestion",
        trigger: "proactive_tick",
        summary: "Resident discovery ran but found no actionable goal to negotiate.",
        suggestion_title: suggestionTitle || undefined,
        ...activityMetadata,
      });
      return;
    }

    await persistResidentActivity(context, {
      kind: "suggestion",
      trigger: "proactive_tick",
      summary: `Resident discovery recorded an attention candidate: ${suggestionTitle || negotiationDescription}`,
      suggestion_title: suggestionTitle || negotiationDescription,
      ...activityMetadata,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    context.logger.warn("Resident discovery failed", { error: message });
    await persistResidentActivity(context, {
      kind: "error",
      trigger: "proactive_tick",
      summary: `Resident discovery failed: ${message}`,
      ...activityMetadata,
    });
  }
}

export async function runResidentCuriosityCycle(
  context: Pick<
    DaemonRunnerResidentContext,
    "curiosityEngine" | "stateManager" | "saveDaemonState" | "state" | "logger" | "baseDir" | "config" | "attentionStateStore" | "residentOperationBoundaryEvaluator"
  >,
  options?: {
    activityTrigger?: ResidentActivity["trigger"];
    focus?: string;
    reviewLabel?: string;
    skipWhenNoTriggers?: boolean;
    surfaceActivityMetadata?: ResidentActivityMetadata;
  },
): Promise<boolean> {
  const inheritedSurfaceActivityMetadata = options?.surfaceActivityMetadata ?? {};

  if (!context.curiosityEngine) {
    if (options?.skipWhenNoTriggers) {
      return false;
    }
    await persistResidentActivity(context, {
      kind: "skipped",
      trigger: options?.activityTrigger ?? "proactive_tick",
      summary: "Resident investigation skipped because curiosity wiring is unavailable.",
      ...inheritedSurfaceActivityMetadata,
    });
    return true;
  }

  try {
    const goals = await loadKnownGoals(context);
    const triggers = await context.curiosityEngine.evaluateTriggers(goals);
    const focus = options?.focus?.trim() ?? "";
    const attentionSummary = options?.reviewLabel
      ? `Resident ${options.reviewLabel} evaluated curiosity triggers.`
      : `Resident curiosity evaluated${focus ? ` ${focus}` : " trigger state"}.`;

    if (triggers.length === 0) {
      if (options?.skipWhenNoTriggers) {
        return false;
      }
      const attentionAdmission = await evaluateResidentAttentionAdmission(context, {
        action: "curiosity_noop",
        trigger: options?.activityTrigger ?? "proactive_tick",
        summary: attentionSummary,
        surfaceActivityMetadata: inheritedSurfaceActivityMetadata,
      });
      const attentionActivityMetadata = residentAttentionActivityMetadata(attentionAdmission);
      if (!attentionAdmission.branch_admitted) {
        await persistResidentActivity(context, {
          kind: "skipped",
          trigger: options?.activityTrigger ?? "proactive_tick",
          summary: attentionAdmission.summary,
          ...inheritedSurfaceActivityMetadata,
          ...attentionActivityMetadata,
        });
        return true;
      }
      await persistResidentActivity(context, {
        kind: "curiosity",
        trigger: options?.activityTrigger ?? "proactive_tick",
        summary: options?.reviewLabel
          ? `Resident ${options.reviewLabel} ran and found no curiosity triggers.`
          : `Resident investigation ran${focus ? ` for ${focus}` : ""} and found nothing actionable.`,
        ...inheritedSurfaceActivityMetadata,
        ...attentionActivityMetadata,
      });
      return true;
    }

    const attentionAdmission = await evaluateResidentAttentionAdmission(context, {
      action: "curiosity",
      trigger: options?.activityTrigger ?? "proactive_tick",
      summary: attentionSummary,
      surfaceActivityMetadata: inheritedSurfaceActivityMetadata,
    });
    const attentionActivityMetadata = residentAttentionActivityMetadata(attentionAdmission);
    const operationBoundary = (context.residentOperationBoundaryEvaluator ?? evaluateResidentOperationBoundary)({
      admission: attentionAdmission,
      assembledAt: new Date().toISOString(),
      surfaceRef: inheritedSurfaceActivityMetadata.surface_id,
    });
    const operationActivityMetadata = residentOperationBoundaryActivityMetadata(operationBoundary);
    if (!attentionAdmission.branch_admitted) {
      await persistResidentActivity(context, {
        kind: "skipped",
        trigger: options?.activityTrigger ?? "proactive_tick",
        summary: attentionAdmission.summary,
        ...inheritedSurfaceActivityMetadata,
        ...attentionActivityMetadata,
        ...operationActivityMetadata,
      });
      return true;
    }
    if (!residentOperationBoundaryAllowsPreparation(operationActivityMetadata)) {
      await persistResidentActivity(context, {
        kind: "skipped",
        trigger: options?.activityTrigger ?? "proactive_tick",
        summary: `Resident curiosity held by operation boundary: ${operationActivityMetadata.operation_plan_reason}`,
        ...inheritedSurfaceActivityMetadata,
        ...attentionActivityMetadata,
        ...operationActivityMetadata,
      });
      return true;
    }

    const relationshipProfileContext = await loadRelationshipProfileSurfaceContext({
      baseDir: context.stateManager.getBaseDir(),
      scope: "resident_behavior",
      includeSensitive: true,
    });
    const relationshipProfileSurface = buildRelationshipProfileSurfaceProjection({
      context: relationshipProfileContext,
      target: "daemon",
      scopeRef: `resident-curiosity:${options?.activityTrigger ?? "proactive_tick"}`,
      purpose: options?.reviewLabel ? `resident_${options.reviewLabel.replace(/\s+/g, "_")}` : "resident_curiosity",
      requestedUse: "attention_prioritization",
      now: new Date().toISOString(),
    });
    const relationshipProfileSurfaceContext = formatRelationshipProfileSurfaceContext(
      relationshipProfileSurface,
      { title: "Resident relationship profile Surface" },
    );
    const surfaceActivityMetadata = mergeResidentSurfaceActivityMetadata(
      inheritedSurfaceActivityMetadata,
      residentSurfaceActivityMetadata(relationshipProfileSurface),
    );
    const combinedActivityMetadata = {
      ...surfaceActivityMetadata,
      ...attentionActivityMetadata,
      ...operationActivityMetadata,
    };
    const proposals = await context.curiosityEngine.generateProposals(triggers, goals, {
      relationshipProfileContext: relationshipProfileSurfaceContext,
    });
    if (proposals.length === 0) {
      await persistResidentActivity(context, {
        kind: "curiosity",
        trigger: options?.activityTrigger ?? "proactive_tick",
        summary: options?.reviewLabel
          ? `Resident ${options.reviewLabel} ran but produced no curiosity proposals.`
          : `Resident investigation ran${focus ? ` for ${focus}` : ""} but produced no curiosity proposals.`,
        ...combinedActivityMetadata,
      });
      return true;
    }

    const proposal = proposals[0]!;
    await persistResidentActivity(context, {
      kind: "curiosity",
      trigger: options?.activityTrigger ?? "proactive_tick",
      summary: options?.reviewLabel
        ? `Resident ${options.reviewLabel} created ${proposals.length} curiosity proposal(s); next focus: ${proposal.proposed_goal.description}`
        : `Resident investigation created ${proposals.length} curiosity proposal(s); next focus: ${proposal.proposed_goal.description}`,
      suggestion_title: proposal.proposed_goal.description,
      ...combinedActivityMetadata,
    });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    context.logger.warn("Resident investigation failed", { error: message });
    await persistResidentActivity(context, {
      kind: "error",
      trigger: options?.activityTrigger ?? "proactive_tick",
      summary: `Resident investigation failed: ${message}`,
      ...inheritedSurfaceActivityMetadata,
    });
    return true;
  }
}

function residentSurfaceActivityMetadata(
  projection: SurfaceProjection | null,
): ResidentSurfaceActivityMetadata {
  if (!projection) return {};
  const surfaceInspection = createSurfaceInspectionAdapterPayload(projection, "daemon");
  return {
    surface_id: projection.id,
    surface_included_count: projection.included_context.length,
    surface_excluded_count: projection.excluded_context.length,
    surface_inspection: surfaceInspection,
    surface_inspections: [surfaceInspection],
  };
}

export async function triggerResidentInvestigation(
  context: Pick<
    DaemonRunnerResidentContext,
    "curiosityEngine" | "stateManager" | "saveDaemonState" | "state" | "logger" | "baseDir" | "config" | "attentionStateStore" | "residentOperationBoundaryEvaluator"
  >,
  details?: Record<string, unknown>,
  surfaceActivityMetadata: ResidentActivityMetadata = {},
): Promise<void> {
  const focus = typeof details?.["what"] === "string" ? details["what"].trim() : "";
  await runResidentCuriosityCycle(context, {
    activityTrigger: "proactive_tick",
    focus,
    skipWhenNoTriggers: false,
    surfaceActivityMetadata,
  });
}

export async function runScheduledGoalReview(
  context: Pick<
    DaemonRunnerResidentContext,
    "curiosityEngine" | "stateManager" | "saveDaemonState" | "state" | "logger" | "config" | "baseDir" | "attentionStateStore" | "residentOperationBoundaryEvaluator"
  >,
  lastGoalReviewAt: number,
  setLastGoalReviewAt: (value: number) => void,
): Promise<boolean> {
  if (!context.curiosityEngine || !context.config.proactive_mode) {
    return false;
  }
  const now = Date.now();
  if (now - lastGoalReviewAt < context.config.goal_review_interval_ms) {
    return false;
  }
  setLastGoalReviewAt(now);
  return runResidentCuriosityCycle(context, {
    activityTrigger: "schedule",
    reviewLabel: "goal review",
    skipWhenNoTriggers: false,
  });
}
