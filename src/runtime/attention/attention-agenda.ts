import {
  AgentAgendaItemSchema,
  type AgentAgendaItem,
  type AgentAgendaItemKind,
  type AgendaPosture,
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

export function runtimeItemsForAgenda(items: AgentAgendaItem[], now: string): RuntimeItem[] {
  return items.map((item) => ({
    schema_version: "runtime-item-v1",
    item_id: item.agenda_item_id,
    type: "agent_agenda_item",
    status: item.current_posture === "ready_for_gate" ? "mature" : "active",
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
    staleness: currentStaleness("agenda item derived from current typed attention evidence"),
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
      repair_options: ["reground_item", "require_confirmation"],
      reason: "agenda runtime mirror is inspection-only before admission",
    },
    audit_trace_refs: item.audit_refs.map((candidate) => candidate.id),
  }));
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
