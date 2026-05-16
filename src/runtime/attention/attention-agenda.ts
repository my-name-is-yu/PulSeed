import {
  AgentAgendaItemSchema,
  type AgentAgendaItem,
  type AgentAgendaItemKind,
  type AgentCarePosture,
  type AgendaPosture,
  type AttentionCluster,
  type AttentionMaturation,
  type AttentionMaturationState,
  type AttentionMove,
  type AttentionRevisitCondition,
  type CompanionAutonomySourceRef,
  type UrgeCandidate,
  type UrgeOrigin,
} from "../types/companion-autonomy.js";
import type { RuntimeItem } from "../types/companion-state.js";
import {
  ref,
  refKey,
  refsOfKind,
  sourceRefKey,
  stableId,
  uniqueRefs,
  uniqueSourceRefs,
} from "./attention-refs.js";

export const INTERNAL_PRE_GATE_MOVES: readonly AttentionMove[] = [
  "notice",
  "watch",
  "hold",
  "prepare",
];

export const OUTWARD_PRE_GATE_FORBIDDEN_MOVES: readonly AttentionMove[] = [
  "ask",
  "speak",
  "run_authorized_work",
  "delegate_bounded_work",
  "write_memory_candidate",
  "update_surface_candidate",
  "escalate",
  "external_side_effect",
];

export const DEFAULT_REVISIT_CONDITION: AttentionRevisitCondition = {
  kind: "runtime_event",
  refs: [],
  reason: "re-evaluate when fresh typed runtime evidence arrives",
};

export type MergeUrgesIntoAgendaInput = {
  urges: UrgeCandidate[];
  existing_agenda_items?: AgentAgendaItem[];
  now: string;
};

export type ProjectClustersToAgendaInput = {
  clusters: AttentionCluster[];
  existing_agenda_items?: AgentAgendaItem[];
  now: string;
};

export function mergeUrgesIntoAgenda(input: MergeUrgesIntoAgendaInput): AgentAgendaItem[] {
  const agendaByKey = new Map<string, AgentAgendaItem>();

  for (const item of input.existing_agenda_items ?? []) {
    agendaByKey.set(dedupeKeyForAgenda(item), item);
  }

  for (const urge of input.urges) {
    const kind = agendaKindForUrge(urge);
    const key = dedupeKeyForUrge(urge, kind);
    const existing = agendaByKey.get(key);
    if (!existing) {
      const created = createAgendaItemFromUrge(urge, kind, input.now, key);
      agendaByKey.set(key, created);
      continue;
    }

    const mergedUrgeRefs = uniqueRefs([
      ...existing.source_urge_refs,
      ref("urge_candidate", urge.urge_id),
    ]);
    const reinforcedByRefs = uniqueSourceRefs([
      ...(existing.merge_trace?.reinforced_by_refs ?? []),
      ...urge.evidence_refs,
    ]);
    const maturation = reinforceMaturation(existing.maturation, urge, input.now);
    const currentPosture = agendaPostureForMaturation(maturation.state);
    const updatedDedupeKey = [
      `target:${refKey(urge.target)}`,
      `surface:${urge.surface_ref ? refKey(urge.surface_ref) : "none"}`,
      `kind:${existing.kind}`,
      `posture:${currentPosture}`,
    ].join("|");
    const evidenceOverlap = urge.evidence_refs.some((evidence) =>
      (existing.merge_trace?.reinforced_by_refs ?? []).some((existingEvidence) =>
        sourceRefKey(existingEvidence) === sourceRefKey(evidence)
      )
    );

    agendaByKey.set(key, AgentAgendaItemSchema.parse({
      ...existing,
      confidence: Math.max(existing.confidence, urge.confidence),
      updated_at: input.now,
      source_urge_refs: mergedUrgeRefs,
      current_posture: currentPosture,
      control_state: currentPosture === "expired" ? "expired" : currentPosture === "suppressed" ? "suppressed" : "held",
      maturation,
      merge_trace: {
        dedupe_key: updatedDedupeKey,
        basis: {
          target: true,
          evidence: evidenceOverlap || existing.source_urge_refs.length > 0,
          surface: true,
          kind: true,
          current_posture: true,
        },
        merged_urge_refs: mergedUrgeRefs,
        reinforced_by_refs: reinforcedByRefs,
        audit_refs: existing.merge_trace?.audit_refs ?? [],
      },
    }));
  }

  return [...agendaByKey.values()];
}

export function projectClustersToAgenda(input: ProjectClustersToAgendaInput): AgentAgendaItem[] {
  const agendaByCluster = new Map<string, AgentAgendaItem>();
  const agendaByUrgeRef = new Map<string, AgentAgendaItem>();
  for (const item of input.existing_agenda_items ?? []) {
    if (item.clusterRef) agendaByCluster.set(item.clusterRef.id, item);
    for (const urgeRef of item.source_urge_refs) {
      agendaByUrgeRef.set(refKey(urgeRef), item);
    }
  }

  for (const cluster of input.clusters) {
    const existing = agendaByCluster.get(cluster.id)
      ?? cluster.memberUrgeRefs.map((urgeRef) => agendaByUrgeRef.get(refKey(urgeRef))).find(Boolean);
    const projected = createAgendaItemFromCluster(cluster, input.now, existing);
    agendaByCluster.set(cluster.id, projected);
  }

  return [...agendaByCluster.values()];
}

export function runtimeItemsForAgenda(items: AgentAgendaItem[], now: string): RuntimeItem[] {
  return items.map((item) => ({
    schema_version: "runtime-item-v1",
    item_id: item.agenda_item_id,
    type: "agent_agenda_item",
    status: runtimeStatusForAgendaPosture(item.current_posture),
    posture: agendaPostureToRuntimePosture(item.current_posture),
    source: "attention-metabolism",
    created_at: item.created_at,
    updated_at: now,
    related_goal_refs: item.related_goal_refs.map((candidate) => candidate.id),
    related_task_refs: [],
    related_session_refs: [],
    related_memory_refs: item.related_memory_refs.map((candidate) => candidate.id),
    related_surface_refs: item.related_surface_refs.map((candidate) => candidate.id),
    related_agenda_refs: [item.agenda_item_id],
    companion_state_refs: [],
    companion_control_state: {
      active_controls: [],
      global_control_refs: [],
      held_by_controls: [],
      rejected_by_controls: [],
      reason: "agenda runtime item awaits runtime-control admission",
    },
    authority: {
      inspectable: true,
      resumable: false,
      actionable: false,
      speakable: false,
      can_create_urge: false,
      can_update_surface: false,
      can_write_memory: false,
      can_delegate_work: false,
      requires_confirmation: true,
      approval_scope: "inspect_only",
      authority_reason: "attention agenda is inspect-only before runtime admission",
    },
    staleness: stalenessForAgenda(item),
    visibility_policy: {
      display: "hidden",
      inspectable: true,
      auditable: true,
      policy_ref: null,
      reason: "agenda remains hidden from normal display until admitted by runtime control",
    },
    visibility_policy_ref: null,
    control_policy: {
      allowed_controls: ["inspect_item"],
      forbidden_controls: [
        "pause_item",
        "resume_item",
        "cancel_item",
        "finalize_item",
        "forget_item",
        "reground_item",
        "revoke_permission",
        "narrow_permission",
        "require_confirmation",
      ],
      required_confirmation: ["require_confirmation"],
      repair_options: [],
      reason: "agenda runtime mirror is inspection-only before admission",
    },
    audit_trace_refs: item.audit_refs.map((candidate) => candidate.id),
  }));
}

function runtimeStatusForAgendaPosture(posture: AgendaPosture): RuntimeItem["status"] {
  switch (posture) {
    case "ready_for_gate":
      return "mature";
    case "suppressed":
      return "blocked";
    case "expired":
    case "rejected_stale":
      return "expired";
    case "admitted":
      return "completed";
    case "new":
    case "warming":
    case "held":
    case "prepared":
      return "active";
  }
}

export function intersectMoves(moves: readonly AttentionMove[], allowed: readonly AttentionMove[]): AttentionMove[] {
  return uniqueMoves(moves.filter((move) => allowed.includes(move)));
}

export function uniqueMoves(moves: readonly AttentionMove[]): AttentionMove[] {
  return unique(moves);
}

function createAgendaItemFromUrge(
  urge: UrgeCandidate,
  kind: AgentAgendaItemKind,
  now: string,
  dedupeKey: string
): AgentAgendaItem {
  const sourceUrgeRef = ref("urge_candidate", urge.urge_id);
  const posture = agendaPostureForMaturation(urge.maturation.state);
  const evidenceRefs = uniqueSourceRefs(urge.evidence_refs);

  return AgentAgendaItemSchema.parse({
    agenda_item_id: `agenda:${stableId(dedupeKey)}`,
    origin: urge.origin,
    kind,
    subject: urge.subject,
    why_pulseed_cares: `typed ${urge.origin} ${urge.feeling} pressure requires internal attention`,
    expected_user_benefit: urge.expected_user_benefit,
    related_goal_refs: refsOfKind([urge.target, ...evidenceRefs.map((evidence) => evidence.ref)], "goal"),
    related_memory_refs: refsOfKind([urge.target, ...evidenceRefs.map((evidence) => evidence.ref)], "memory"),
    related_surface_refs: uniqueRefs([
      ...(urge.surface_ref ? [urge.surface_ref] : []),
      ...refsOfKind(evidenceRefs.map((evidence) => evidence.ref), "surface"),
    ]),
    related_runtime_refs: refsOfKind(
      [urge.target, ...evidenceRefs.map((evidence) => evidence.ref)],
      "runtime_item",
      "runtime_event"
    ),
    source_urge_refs: [sourceUrgeRef],
    drive_basis: urge.origin === "drive" ? "drive contributes care pressure only" : undefined,
    curiosity_basis: urge.origin === "curiosity" || urge.feeling === "curiosity"
      ? "curiosity contributes exploration pressure only"
      : undefined,
    confidence: urge.confidence,
    intrusion_cost: urge.user_cost,
    relationship_risk: urge.relationship_risk,
    staleness_state: stalenessStateForEvidence(evidenceRefs),
    allowed_moves: intersectMoves(urge.allowed_moves, INTERNAL_PRE_GATE_MOVES),
    forbidden_moves: uniqueMoves([...urge.forbidden_moves, ...OUTWARD_PRE_GATE_FORBIDDEN_MOVES]),
    current_posture: posture,
    maturation: urge.maturation,
    revisit_condition: posture === "ready_for_gate"
      ? { kind: "manual_review", refs: [], reason: "ready for Initiative Gate evaluation" }
      : DEFAULT_REVISIT_CONDITION,
    control_state: posture === "expired" ? "expired" : posture === "suppressed" ? "suppressed" : "held",
    clusterRef: null,
    carePosture: carePostureForMaturation(urge.maturation.state),
    revisitCondition: posture === "ready_for_gate"
      ? { kind: "manual_review", refs: [], reason: "ready for Initiative Gate evaluation" }
      : DEFAULT_REVISIT_CONDITION,
    abandonmentCondition: urge.maturation.expires_at
      ? { kind: "time", due_at: urge.maturation.expires_at, refs: [], reason: "abandon when source evidence expires" }
      : { kind: "staleness_change", refs: [], reason: "abandon when source grounding becomes stale" },
    suppressionReason: null,
    commitmentLifecycle: posture === "ready_for_gate" ? "proposed" : "held",
    priority_evidence: urge.priority_evidence,
    needsRegrounding: urge.stalenessSnapshot.state !== "fresh" || urge.scope.policyEpoch === "unknown",
    scope: urge.scope,
    policyEpoch: urge.policyEpoch,
    merge_trace: {
      dedupe_key: dedupeKey,
      basis: {
        target: true,
        evidence: true,
        surface: true,
        kind: true,
        current_posture: true,
      },
      merged_urge_refs: [sourceUrgeRef],
      reinforced_by_refs: evidenceRefs,
    },
    created_at: now,
    updated_at: now,
    audit_refs: urge.audit_refs,
  });
}

function createAgendaItemFromCluster(
  cluster: AttentionCluster,
  now: string,
  existing?: AgentAgendaItem,
): AgentAgendaItem {
  const posture = agendaPostureForCluster(cluster);
  const carePosture = carePostureForCluster(cluster);
  const sourceUrgeRefs = uniqueRefs(cluster.memberUrgeRefs);
  const clusterRef = ref("attention_cluster", cluster.id);

  return AgentAgendaItemSchema.parse({
    schema_version: "agent-agenda-item-v1",
    agenda_item_id: existing?.agenda_item_id ?? `agenda:${stableId(`cluster:${cluster.id}`)}`,
    origin: existing?.origin ?? "runtime_event",
    kind: existing?.kind ?? agendaKindForCluster(cluster),
    subject: cluster.theme.label,
    why_pulseed_cares: "scoped attention cluster matured into an internal care posture",
    expected_user_benefit: "PulSeed can keep related concerns together without acting before admission",
    related_goal_refs: refsOfKind(cluster.theme.structuredRefs.map((structuredRef) => structuredRef.ref), "goal"),
    related_memory_refs: refsOfKind(cluster.theme.structuredRefs.map((structuredRef) => structuredRef.ref), "memory"),
    related_surface_refs: refsOfKind(cluster.theme.structuredRefs.map((structuredRef) => structuredRef.ref), "surface"),
    related_runtime_refs: refsOfKind(cluster.theme.structuredRefs.map((structuredRef) => structuredRef.ref), "runtime_item", "runtime_event"),
    source_urge_refs: sourceUrgeRefs,
    confidence: cluster.aggregateConfidence,
    intrusion_cost: {
      level: cluster.scope.permissionScope === "notify_allowed" ? "medium" : "low",
      reason: "cluster projection is internal before decomposition admission",
      evidence_refs: cluster.signalRefs,
    },
    relationship_risk: {
      level: cluster.scope.sensitivity === "high" ? "high" : "low",
      reason: "risk follows derived cluster sensitivity",
      evidence_refs: cluster.signalRefs,
    },
    staleness_state: cluster.lifecycle === "needs_regrounding" ? "needs_regrounding" : "current",
    allowed_moves: movesForCarePosture(carePosture),
    forbidden_moves: OUTWARD_PRE_GATE_FORBIDDEN_MOVES,
    current_posture: posture,
    maturation: cluster.maturation,
    revisit_condition: cluster.lifecycle === "mature"
      ? { kind: "manual_review", refs: [clusterRef], reason: "mature cluster can be decomposed for admission review" }
      : DEFAULT_REVISIT_CONDITION,
    control_state: cluster.lifecycle === "suppressed" ? "suppressed" : cluster.lifecycle === "forgotten" ? "expired" : "held",
    clusterRef,
    carePosture,
    revisitCondition: cluster.lifecycle === "mature"
      ? { kind: "manual_review", refs: [clusterRef], reason: "mature cluster can be decomposed for admission review" }
      : DEFAULT_REVISIT_CONDITION,
    abandonmentCondition: cluster.forgetAfter
      ? { kind: "time", due_at: cluster.forgetAfter, refs: [clusterRef], reason: "cluster retention window elapsed" }
      : { kind: "staleness_change", refs: [clusterRef], reason: "cluster must be regrounded when source state changes" },
    suppressionReason: cluster.suppression?.reason ?? null,
    commitmentLifecycle: cluster.lifecycle === "mature" ? "proposed" : cluster.lifecycle === "forgotten" ? "terminal" : "held",
    priority_evidence: existing?.priority_evidence,
    needsRegrounding: cluster.lifecycle === "needs_regrounding" || cluster.scope.policyEpoch === "unknown",
    scope: cluster.scope,
    policyEpoch: cluster.scope.policyEpoch,
    created_at: existing?.created_at ?? cluster.createdAt,
    updated_at: now,
    audit_refs: existing?.audit_refs ?? [],
  });
}

function agendaKindForUrge(urge: UrgeCandidate): AgentAgendaItemKind {
  const byOrigin: Record<UrgeOrigin, AgentAgendaItemKind> = {
    goal: "goal_stewardship",
    memory: "memory_conflict",
    schedule: "preparation_opportunity",
    runtime_event: "stall_concern",
    world_change: "project_drift",
    user_pattern: "preparation_opportunity",
    curiosity: "curiosity_followup",
    drive: "goal_stewardship",
    risk: "permission_boundary",
    guardrail: "permission_boundary",
    backpressure: "user_overload",
    correction: "unresolved_decision",
  };
  if (urge.feeling === "staleness_pressure") return "surface_staleness";
  if (urge.feeling === "repair_pressure") return "commitment_guard";
  return byOrigin[urge.origin];
}

function agendaKindForCluster(cluster: AttentionCluster): AgentAgendaItemKind {
  const refs = cluster.theme.structuredRefs.map((structuredRef) => structuredRef.ref.kind);
  if (refs.includes("goal")) return "goal_stewardship";
  if (refs.includes("wait") || refs.includes("schedule_tick")) return "commitment_guard";
  if (refs.includes("memory")) return "memory_conflict";
  if (refs.includes("surface")) return "surface_staleness";
  return "self_maintenance";
}

function agendaPostureForCluster(cluster: AttentionCluster): AgendaPosture {
  switch (cluster.lifecycle) {
    case "mature":
      return "ready_for_gate";
    case "suppressed":
      return "suppressed";
    case "forgotten":
      return "expired";
    case "needs_regrounding":
      return "rejected_stale";
    case "split_pending":
      return "held";
    case "watching":
      return "held";
    case "forming":
      return "warming";
  }
}

function carePostureForCluster(cluster: AttentionCluster): AgentCarePosture {
  switch (cluster.lifecycle) {
    case "mature":
      return cluster.scope.permissionScope === "write_allowed" ? "act_candidate" : "prepare";
    case "split_pending":
      return "ask";
    case "suppressed":
    case "forgotten":
      return "silence";
    case "needs_regrounding":
      return "watch";
    case "forming":
    case "watching":
      return "watch";
  }
}

function movesForCarePosture(carePosture: AgentCarePosture): AttentionMove[] {
  switch (carePosture) {
    case "notice":
      return ["notice"];
    case "watch":
      return ["watch"];
    case "hold":
    case "ask":
    case "offer":
      return ["hold"];
    case "prepare":
    case "act_candidate":
      return ["prepare"];
    case "silence":
      return [];
  }
}

function dedupeKeyForUrge(urge: UrgeCandidate, kind: AgentAgendaItemKind): string {
  return [
    `target:${refKey(urge.target)}`,
    `surface:${urge.surface_ref ? refKey(urge.surface_ref) : "none"}`,
    `kind:${kind}`,
    `posture:${agendaPostureForMaturation(urge.maturation.state)}`,
  ].join("|");
}

function dedupeKeyForAgenda(item: AgentAgendaItem): string {
  if (item.merge_trace) return item.merge_trace.dedupe_key;
  return [
    `target:${item.related_goal_refs[0] ? refKey(item.related_goal_refs[0]) : item.agenda_item_id}`,
    `surface:${item.related_surface_refs[0] ? refKey(item.related_surface_refs[0]) : "none"}`,
    `kind:${item.kind}`,
    `posture:${item.current_posture}`,
  ].join("|");
}

function reinforceMaturation(
  existing: AttentionMaturation,
  urge: UrgeCandidate,
  now: string
): AttentionMaturation {
  const state = existing.state === "new"
    ? "warming"
    : existing.state === "warming"
      ? "held"
      : existing.state;

  return {
    ...existing,
    state,
    last_reinforced_at: now,
    reinforcement_refs: uniqueSourceRefs([...existing.reinforcement_refs, ...urge.evidence_refs]),
  };
}

function agendaPostureForMaturation(state: AttentionMaturationState): AgendaPosture {
  switch (state) {
    case "new":
      return "new";
    case "warming":
      return "warming";
    case "mature":
      return "ready_for_gate";
    case "held":
      return "held";
    case "prepared":
      return "prepared";
    case "suppressed":
      return "suppressed";
    case "expired":
      return "expired";
    case "rejected_stale":
      return "rejected_stale";
    case "decayed":
      return "held";
    case "expressed":
      return "admitted";
  }
}

function carePostureForMaturation(state: AttentionMaturationState): AgentCarePosture {
  switch (state) {
    case "mature":
    case "prepared":
      return "prepare";
    case "suppressed":
      return "silence";
    case "expired":
    case "rejected_stale":
      return "silence";
    case "held":
      return "hold";
    case "new":
    case "warming":
    case "decayed":
    case "expressed":
      return "watch";
  }
}

function agendaPostureToRuntimePosture(posture: AgendaPosture): RuntimeItem["posture"] {
  switch (posture) {
    case "new":
    case "warming":
    case "held":
      return "holding";
    case "prepared":
      return "watching";
    case "ready_for_gate":
      return "proposed";
    case "admitted":
      return "committed";
    case "suppressed":
      return "suppressed";
    case "expired":
      return "safe_to_forget";
    case "rejected_stale":
      return "stale";
  }
}

function stalenessStateForEvidence(evidenceRefs: CompanionAutonomySourceRef[]): AgentAgendaItem["staleness_state"] {
  if (evidenceRefs.some((evidence) => evidence.lifecycle === "deleted" || evidence.lifecycle === "tombstone")) {
    return "rejected";
  }
  if (evidenceRefs.some((evidence) => evidence.lifecycle === "redacted")) {
    return "needs_regrounding";
  }
  return "current";
}

function unique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function currentStaleness(reason: string): RuntimeItem["staleness"] {
  const dimension = { outcome: "current" as const, reason };
  return {
    temporal: dimension,
    world: dimension,
    project: dimension,
    permission: dimension,
    relationship: dimension,
    surface: dimension,
    goal: dimension,
    assumption: dimension,
    session: dimension,
    browser_session: dimension,
    auth_handoff: dimension,
  };
}

function stalenessForAgenda(item: AgentAgendaItem): RuntimeItem["staleness"] {
  if (!item.needsRegrounding && item.staleness_state === "current") {
    return currentStaleness("agenda item derived from current typed attention evidence");
  }
  const dimension = {
    outcome: "needs_regrounding" as const,
    reason: item.staleness_state === "current"
      ? "agenda policy/scope requires regrounding before runtime admission"
      : `agenda staleness state is ${item.staleness_state}`,
  };
  return {
    temporal: dimension,
    world: dimension,
    project: dimension,
    permission: dimension,
    relationship: dimension,
    surface: dimension,
    goal: dimension,
    assumption: dimension,
    session: dimension,
    browser_session: dimension,
    auth_handoff: dimension,
  };
}
