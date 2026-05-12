import type {
  AttentionPendingBlockRecord,
  AttentionStateStore,
} from "../store/attention-state-store.js";
import type {
  AttentionCluster,
  AgendaDecomposition,
  AttentionScope,
  AttentionSignalRef,
  UrgeCandidate,
} from "../types/companion-autonomy.js";
import {
  createUrgeCandidate,
  projectClustersToAgenda,
  ref,
  assembleSignalContext,
} from "./attention-metabolism.js";
import { mergeUrgesIntoClusters } from "./attention-clustering.js";
import { promoteAttentionClusters } from "./attention-promotion.js";
import { decomposeAgenda } from "./attention-decomposition.js";
import {
  buildAttentionAdmissionCandidates,
  type AttentionAdmissionCandidate,
} from "./attention-admission.js";
import { attentionScopeKey } from "./attention-scope.js";
import { sourceRefKey, stableId } from "./attention-refs.js";

export type AttentionCycleTrigger =
  | "conversation"
  | "wait_resume"
  | "schedule"
  | "runtime_outcome"
  | "correction"
  | "revoke"
  | "suspend"
  | "surface_revocation"
  | "policy_epoch_change"
  | "maintenance";

export type AttentionSafetyTrigger =
  | "correction"
  | "revoke"
  | "suspend"
  | "surface_revocation"
  | "policy_epoch_change";

export type AttentionSourceHighWatermark = {
  source: string;
  highWatermark: string;
};

export type AttentionCycleInput = {
  now: string;
  trigger: AttentionCycleTrigger;
  safetyTrigger?: AttentionSafetyTrigger | null;
  scope: AttentionScope;
  signalRefs: AttentionSignalRef[];
  sourceHighWatermarks: AttentionSourceHighWatermark[];
  expectedProjectionRevision: number;
  cycleIdempotencyKey: string;
  policyEpoch: string;
  mode: "shadow" | "live";
  experimentId?: string | null;
  urges?: UrgeCandidate[];
  maxWrites?: number | null;
  maxNewClustersPerCycle?: number | null;
};

export type AttentionClusterUpdate = {
  clusterRef: string;
  lifecycle: AttentionCluster["lifecycle"];
};

export type AttentionSilenceReason = {
  reason: string;
  refs: string[];
};

export type AttentionAuditRef = {
  ref: string;
};

export type AttentionCycleResult = {
  cycleId: string;
  createdUrges: UrgeCandidate[];
  clusterUpdates: AttentionClusterUpdate[];
  agendaUpdates: ReturnType<typeof projectClustersToAgenda>;
  decompositions: ReturnType<typeof decomposeAgenda>;
  admissionCandidates: AttentionAdmissionCandidate[];
  silenceReasons: AttentionSilenceReason[];
  auditRefs: AttentionAuditRef[];
  projectionRevision: number;
  writeDisposition: "written" | "no_op_elided" | "stale_rejected" | "budget_dropped";
  droppedWriteReasons: string[];
};

export async function runAttentionCycle(input: {
  store: Pick<
    AttentionStateStore,
    | "loadConcernState"
    | "saveMetabolismCycle"
    | "projectionRevision"
    | "addPendingBlock"
    | "listPendingBlocks"
    | "clearPendingBlocks"
  >;
  cycle: AttentionCycleInput;
}): Promise<AttentionCycleResult> {
  const cycleId = `attention-cycle:${stableId(`${attentionScopeKey(input.cycle.scope)}:${input.cycle.cycleIdempotencyKey}`)}`;
  const shouldClearPendingBlocks = input.cycle.trigger === "runtime_outcome";

  if (isPrioritySafetyTrigger(input.cycle.trigger, input.cycle.safetyTrigger)) {
    await input.store.addPendingBlock({
      scope: input.cycle.scope,
      triggerKind: input.cycle.safetyTrigger ?? input.cycle.trigger,
      reason: "priority safety trigger blocks stale admission cycles until committed",
      createdAt: input.cycle.now,
    });
  }

  if (input.cycle.maxWrites === 0 && !isPrioritySafetyTrigger(input.cycle.trigger, input.cycle.safetyTrigger)) {
    return emptyCycleResult({
      cycleId,
      projectionRevision: input.cycle.expectedProjectionRevision,
      writeDisposition: "budget_dropped",
      reason: "non-critical attention cycle exceeded write budget",
    });
  }

  const state = await input.store.loadConcernState({ scope: input.cycle.scope });
  const createdUrges = input.cycle.urges ?? createUrgesForCycle(input.cycle);
  const merged = mergeUrgesIntoClusters({
    urges: createdUrges,
    existingClusters: state.clusters,
    now: input.cycle.now,
    maxNewClustersPerCycle: input.cycle.maxNewClustersPerCycle ?? undefined,
  });
  const clusters = promoteAttentionClusters({
    clusters: merged.clusters,
    now: input.cycle.now,
    suspended: input.cycle.trigger === "suspend",
  });
  const agenda = projectClustersToAgenda({
    clusters,
    existing_agenda_items: state.agenda_items,
    now: input.cycle.now,
  });
  const decompositions = decomposeAgenda({
    agendaItems: agenda,
    existingDecompositions: state.decompositions,
    now: input.cycle.now,
  });
  const pendingBlocks = await input.store.listPendingBlocks(input.cycle.scope);
  const pendingBlockedScopes = pendingBlocks.map((block) => block.scope_key);
  const admissionCandidates = buildAttentionAdmissionCandidates({
    decompositions,
    now: input.cycle.now,
    pendingBlockedScopeKeys: pendingBlockedScopes,
  });
  const silenceReasons = silenceReasonsFor(clusters, decompositions, admissionCandidates, {
    pendingBlocks,
    unmergedUrgeRefs: merged.unmergedUrgeRefs,
  });
  const resultPayload = {
    cycleId,
    trigger: input.cycle.trigger,
    createdUrgeIds: createdUrges.map((urge) => urge.urge_id),
    clusterIds: clusters.map((cluster) => cluster.id),
    agendaItemIds: agenda.map((item) => item.agenda_item_id),
    decompositionIds: decompositions.map((decomposition) => decomposition.id),
    admissionCandidateIds: admissionCandidates.map((candidate) => candidate.candidateId),
    pendingBlockIds: pendingBlocks.map((block) => block.block_id),
    unmergedUrgeRefs: merged.unmergedUrgeRefs,
    silenceReasons,
    mode: input.cycle.mode,
    experimentId: input.cycle.experimentId ?? null,
  };
  const write = await input.store.saveMetabolismCycle({
    cycle_id: cycleId,
    idempotency_key: input.cycle.cycleIdempotencyKey,
    trigger_kind: input.cycle.trigger,
    scope: input.cycle.scope,
    expected_projection_revision: input.cycle.expectedProjectionRevision,
    source_high_watermarks: input.cycle.sourceHighWatermarks.map((watermark) => `${watermark.source}:${watermark.highWatermark}`),
    clusters,
    agendaItems: agenda,
    decompositions,
    admissionProposals: admissionCandidates,
    events: [
      ...createdUrges.map((urge) => ({
        event_id: `attention-event:${stableId(`${cycleId}:urge:${urge.urge_id}`)}`,
        event_type: "urge_created" as const,
        scope: input.cycle.scope,
        policy_epoch: input.cycle.policyEpoch,
        occurred_at: input.cycle.now,
        mode: input.cycle.mode,
        compactable: false,
        critical: false,
        model_or_classifier_version: urge.modelOrClassifierVersion,
        experiment_id: input.cycle.experimentId ?? null,
        event: {
          urge_id: urge.urge_id,
          signal_refs: urge.signalRefs.map(sourceRefKey),
        },
      })),
      ...merged.mergeEvents.map((event) => ({
        event_id: event.event_id,
        event_type: "cluster_merged" as const,
        scope: input.cycle.scope,
        policy_epoch: input.cycle.policyEpoch,
        occurred_at: event.mergedAt,
        mode: input.cycle.mode,
        compactable: false,
        critical: false,
        experiment_id: input.cycle.experimentId ?? null,
        event: {
          cluster_ref: event.previousClusterRef?.id ?? null,
          urge_ref: event.urgeRef.id,
          reasons: event.reasons,
        },
      })),
    ],
    result: resultPayload,
    created_at: input.cycle.now,
    no_op_hash: stableId(JSON.stringify(resultPayload)),
  });

  if (
    shouldClearPendingBlocks
    && (write.writeDisposition === "written"
      || (write.writeDisposition === "no_op_elided" && write.replayedTriggerKind === "runtime_outcome"))
  ) {
    await input.store.clearPendingBlocks({
      scope: input.cycle.scope,
      clearedAt: input.cycle.now,
      reason: write.writeDisposition === "written"
        ? "runtime outcome committed; pending attention admission block reconciled"
        : "runtime outcome replay reconciled pending attention admission block",
    });
  }

  if (write.writeDisposition !== "written") {
    return emptyCycleResult({
      cycleId,
      projectionRevision: write.projectionRevision,
      writeDisposition: write.writeDisposition,
      reason: `cycle write disposition ${write.writeDisposition} cannot return admission candidates`,
      createdUrges,
      clusterUpdates: clusters.map((cluster) => ({ clusterRef: cluster.id, lifecycle: cluster.lifecycle })),
      agendaUpdates: agenda,
      decompositions,
      silenceReasons,
    });
  }

  return {
    cycleId,
    createdUrges,
    clusterUpdates: clusters.map((cluster) => ({ clusterRef: cluster.id, lifecycle: cluster.lifecycle })),
    agendaUpdates: agenda,
    decompositions,
    admissionCandidates,
    silenceReasons,
    auditRefs: [{ ref: cycleId }],
    projectionRevision: write.projectionRevision,
    writeDisposition: "written",
    droppedWriteReasons: merged.unmergedUrgeRefs.map((urgeRef) =>
      `cluster budget deferred urge ${urgeRef}; source retained in cycle result for replay`
    ),
  };
}

function createUrgesForCycle(cycle: AttentionCycleInput): UrgeCandidate[] {
  if (cycle.signalRefs.length === 0) return [];
  const signalContext = assembleSignalContext({
    signal_context_id: `signal:${stableId(cycle.cycleIdempotencyKey)}`,
    assembled_at: cycle.now,
    signals: cycle.signalRefs.map((signalRef) => ({
      source: signalRef.ref.kind === "schedule_tick" ? "schedule_tick" : signalRef.ref.kind === "wait" ? "wait_expiry" : "runtime_event",
      ref: signalRef.ref,
      lifecycle: signalRef.lifecycle,
      redaction_reason: signalRef.redaction_reason,
    })),
  });
  const target = cycle.signalRefs[0]?.ref ?? ref("runtime_event", cycle.cycleIdempotencyKey);
  return [createUrgeCandidate({
    urge_id: `urge:${stableId(cycle.cycleIdempotencyKey)}`,
    signal_context: signalContext,
    origin: cycle.trigger === "wait_resume" || cycle.trigger === "schedule" ? "schedule" : "runtime_event",
    target,
    feeling: cycle.trigger === "correction" ? "repair_pressure" : "care",
    subject: `Re-evaluate attention for ${cycle.trigger}.`,
    strength: cycle.trigger === "runtime_outcome" ? 0.65 : 0.55,
    confidence: 0.72,
    expected_user_benefit: "PulSeed can update internal care state without acting directly.",
    scope: cycle.scope,
    signalRefs: cycle.signalRefs,
    policyEpoch: cycle.policyEpoch,
    maturation_state: "warming",
  })];
}

function isPrioritySafetyTrigger(trigger: AttentionCycleTrigger, safetyTrigger?: AttentionSafetyTrigger | null): boolean {
  return !!safetyTrigger || trigger === "correction" || trigger === "revoke" || trigger === "suspend"
    || trigger === "surface_revocation" || trigger === "policy_epoch_change";
}

function emptyCycleResult(input: {
  cycleId: string;
  projectionRevision: number;
  writeDisposition: AttentionCycleResult["writeDisposition"];
  reason: string;
  createdUrges?: UrgeCandidate[];
  clusterUpdates?: AttentionClusterUpdate[];
  agendaUpdates?: AttentionCycleResult["agendaUpdates"];
  decompositions?: AttentionCycleResult["decompositions"];
  silenceReasons?: AttentionSilenceReason[];
}): AttentionCycleResult {
  return {
    cycleId: input.cycleId,
    createdUrges: input.createdUrges ?? [],
    clusterUpdates: input.clusterUpdates ?? [],
    agendaUpdates: input.agendaUpdates ?? [],
    decompositions: input.decompositions ?? [],
    admissionCandidates: [],
    silenceReasons: input.silenceReasons?.length
      ? input.silenceReasons
      : [{ reason: input.reason, refs: [input.cycleId] }],
    auditRefs: [{ ref: input.cycleId }],
    projectionRevision: input.projectionRevision,
    writeDisposition: input.writeDisposition,
    droppedWriteReasons: input.writeDisposition === "budget_dropped" ? [input.reason] : [],
  };
}

function silenceReasonsFor(
  clusters: readonly AttentionCluster[],
  decompositions: readonly AgendaDecomposition[],
  admissionCandidates: readonly AttentionAdmissionCandidate[],
  context: {
    pendingBlocks?: readonly AttentionPendingBlockRecord[];
    unmergedUrgeRefs?: readonly string[];
  } = {},
): AttentionSilenceReason[] {
  if (admissionCandidates.length > 0) return [];
  const reasons = new Map<string, Set<string>>();
  for (const block of context.pendingBlocks ?? []) {
    addSilenceReason(reasons, `pending block ${block.trigger_kind}: ${block.reason}`, block.block_id);
  }
  for (const urgeRef of context.unmergedUrgeRefs ?? []) {
    addSilenceReason(reasons, "cluster budget deferred an urge for a later scoped cycle", urgeRef);
  }
  for (const cluster of clusters) {
    if (cluster.lifecycle !== "mature") addSilenceReason(reasons, `cluster ${cluster.id} is ${cluster.lifecycle}`, cluster.id);
  }
  for (const decompositionList of decompositions) {
    if (decompositionList.status !== "open" && decompositionList.status !== "partially_admitted") {
      addSilenceReason(reasons, `decomposition ${decompositionList.id} is ${decompositionList.status}`, decompositionList.id);
    }
  }
  if (reasons.size === 0) addSilenceReason(reasons, "no decomposition child met admission requirements");
  return [...reasons.entries()].map(([reason, refs]) => ({ reason, refs: [...refs] }));
}

function addSilenceReason(
  reasons: Map<string, Set<string>>,
  reason: string,
  refValue?: string,
): void {
  const refs = reasons.get(reason) ?? new Set<string>();
  if (refValue) refs.add(refValue);
  reasons.set(reason, refs);
}
