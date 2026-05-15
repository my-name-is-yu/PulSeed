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
  loadResidentFeedbackDecisionContext,
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
import {
  PersonalAgentRuntimeStore,
  buildPersonalAgentDecisionTrace,
  type RuntimeGraphRef,
} from "../personal-agent/index.js";

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
    "curiosityEngine" | "stateManager" | "saveDaemonState" | "state" | "logger" | "baseDir" | "config" | "attentionStateStore" | "residentOperationBoundaryEvaluator" | "feedbackIngestionStore"
  > & { personalAgentRuntime?: Pick<PersonalAgentRuntimeStore, "recordTrace"> },
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
    const cycleObservedAt = new Date().toISOString();

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
      await recordResidentProactiveTrace(context, {
        attentionAdmission,
        trigger: options?.activityTrigger ?? "proactive_tick",
        observedAt: cycleObservedAt,
        summary: attentionSummary,
        decision: attentionAdmission.branch_admitted ? "allow" : "hold",
        decisionReason: attentionAdmission.summary,
        surfaceActivityMetadata: inheritedSurfaceActivityMetadata,
      });
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
    const feedbackDecisionContext = await loadResidentFeedbackDecisionContext(context);
    const operationBoundary = (context.residentOperationBoundaryEvaluator ?? evaluateResidentOperationBoundary)({
      admission: attentionAdmission,
      assembledAt: new Date().toISOString(),
      surfaceRef: inheritedSurfaceActivityMetadata.surface_id,
      recentFeedback: feedbackDecisionContext.recentFeedback,
      invalidationEvidence: feedbackDecisionContext.invalidationEvidence,
    });
    const operationActivityMetadata = residentOperationBoundaryActivityMetadata(operationBoundary);
    const operationAllowed = residentOperationBoundaryAllowsPreparation(operationActivityMetadata);
    await recordResidentProactiveTrace(context, {
      attentionAdmission,
      trigger: options?.activityTrigger ?? "proactive_tick",
      observedAt: cycleObservedAt,
      summary: attentionSummary,
      decision: !attentionAdmission.branch_admitted || !operationAllowed ? "hold" : "allow",
      decisionReason: !attentionAdmission.branch_admitted
        ? attentionAdmission.summary
        : operationAllowed
          ? "Resident curiosity was admitted by durable attention and operation boundary before proposal generation."
          : `Resident curiosity held by operation boundary: ${operationActivityMetadata.operation_plan_reason}`,
      surfaceActivityMetadata: inheritedSurfaceActivityMetadata,
      operationRefs: operationActivityMetadata.operation_plan_id
        ? [{ kind: "runtime_control", ref: operationActivityMetadata.operation_plan_id }]
        : [],
    });
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
    if (!operationAllowed) {
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
    if (relationshipProfileSurface) {
      await recordResidentProactiveTrace(context, {
        attentionAdmission,
        trigger: options?.activityTrigger ?? "proactive_tick",
        observedAt: relationshipProfileSurface.created_at,
        summary: "Resident relationship memory projection was evaluated before proposal generation.",
        decision: "allow",
        decisionReason: "Relationship Memory was projected with provenance before influencing resident proposal generation.",
        surfaceActivityMetadata: residentSurfaceActivityMetadata(relationshipProfileSurface),
        memoryRefs: relationshipProfileSurface.source_refs.map((source) => ({
          kind: "memory",
          ref: source.memory_id,
        })),
        operationRefs: operationActivityMetadata.operation_plan_id
          ? [{ kind: "runtime_control", ref: operationActivityMetadata.operation_plan_id }]
          : [],
        replaySuffix: "relationship-memory",
      });
    }
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

async function recordResidentProactiveTrace(
  context: Pick<DaemonRunnerResidentContext, "baseDir" | "stateManager" | "config"> & {
    personalAgentRuntime?: Pick<PersonalAgentRuntimeStore, "recordTrace">;
  },
  input: {
    attentionAdmission: Awaited<ReturnType<typeof evaluateResidentAttentionAdmission>>;
    trigger: ResidentActivity["trigger"];
    observedAt: string;
    summary: string;
    decision: "allow" | "hold";
    decisionReason: string;
    surfaceActivityMetadata?: ResidentActivityMetadata;
    operationRefs?: RuntimeGraphRef[];
    memoryRefs?: RuntimeGraphRef[];
    replaySuffix?: string;
  },
): Promise<void> {
  const store = context.personalAgentRuntime ?? new PersonalAgentRuntimeStore(
    context.baseDir,
    { controlBaseDir: context.stateManager.getBaseDir() },
  );
  const admission = input.attentionAdmission;
  const currentRefs: RuntimeGraphRef[] = [
    { kind: "attention_input", ref: admission.attention_input_id },
    { kind: "signal_context", ref: admission.signal_context_id },
    { kind: "urge_candidate", ref: admission.urge_id },
    { kind: "agent_agenda_item", ref: admission.agenda_item_id },
    { kind: "inhibition_decision", ref: admission.inhibition_decision_id },
    { kind: "initiative_gate_decision", ref: admission.initiative_gate_decision_id },
    ...(admission.outcome_decision_id ? [{ kind: "outcome_decision", ref: admission.outcome_decision_id }] : []),
    ...(input.surfaceActivityMetadata?.surface_id ? [{ kind: "surface", ref: input.surfaceActivityMetadata.surface_id }] : []),
    ...(input.operationRefs ?? []),
  ];
  await store.recordTrace(buildPersonalAgentDecisionTrace({
    callerPath: "resident_proactive",
    source: {
      sourceKind: "resident_observation",
      sourceId: admission.attention_input_id,
      emittedAt: input.observedAt,
      sourceEpoch: `${admission.source_kind}:${input.trigger}:${admission.replay_disposition}`,
      highWatermark: admission.signal_context_id,
      replayKey: [
        "resident_proactive",
        admission.attention_input_id,
        admission.signal_context_id,
        input.replaySuffix ?? "attention-admission",
      ].join(":"),
      summary: input.summary,
      sourceRef: { kind: "attention_input", ref: admission.attention_input_id },
    },
    target: {
      kind: "attention_only",
      ref: { kind: "agent_agenda_item", ref: admission.agenda_item_id },
      effect: input.decision === "allow" ? "hold_concern" : "none",
      summary: admission.summary,
    },
    decision: input.decision,
    decisionReason: input.decisionReason,
    capabilityDecision: "not_applicable",
    policyRef: { kind: "intervention_policy", ref: "policy:resident-proactive-v1" },
    currentRefs,
    memoryRefs: input.memoryRefs ?? [],
    auditRefs: currentRefs,
  }));
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
    "curiosityEngine" | "stateManager" | "saveDaemonState" | "state" | "logger" | "baseDir" | "config" | "attentionStateStore" | "residentOperationBoundaryEvaluator" | "feedbackIngestionStore"
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
    "curiosityEngine" | "stateManager" | "saveDaemonState" | "state" | "logger" | "config" | "baseDir" | "attentionStateStore" | "residentOperationBoundaryEvaluator" | "feedbackIngestionStore"
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
