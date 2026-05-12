import { z } from "zod";
import type {
  AgentAgendaItem,
  AutonomyCheck,
  CompanionAutonomyRef,
  CompanionAutonomySourceRef,
  OutcomeClass,
  OutcomeDecision,
} from "../types/companion-autonomy.js";
import type { RuntimeItem } from "../types/companion-state.js";
import type { RuntimeControlOperation } from "../store/runtime-operation-schemas.js";
import { AttentionStateStore } from "../store/attention-state-store.js";
import { FeedbackIngestionStore } from "../store/feedback-ingestion-store.js";
import { RuntimeOperationStore } from "../store/runtime-operation-store.js";
import type { FeedbackIngestionEffect } from "./feedback-ingestion.js";

const QUIET_OUTCOMES = new Set<OutcomeClass>([
  "silence",
  "keep_watching",
  "hold_in_agenda",
  "prepare_silently",
  "prepare_action_candidate",
  "run_authorized_work",
  "delegate_bounded_work",
  "write_governed_memory_candidate",
  "add_to_digest",
]);

const PREPARATION_OUTCOMES = new Set<OutcomeClass>([
  "prepare_silently",
  "prepare_action_candidate",
  "run_authorized_work",
  "delegate_bounded_work",
  "write_governed_memory_candidate",
]);

export const AttentionContinuityWarningSchema = z.object({
  code: z.enum([
    "held_outcomes_present",
    "quiet_work_pending",
    "suppressed_or_silent_items_present",
    "stale_attention_refs_present",
    "missing_runtime_item_ref",
    "ambiguous_control_state",
    "future_epoch",
  ]),
  severity: z.enum(["info", "warning", "fail_closed"]),
  detail: z.string().min(1),
  ref: z.string().min(1).optional(),
}).strict();
export type AttentionContinuityWarning = z.infer<typeof AttentionContinuityWarningSchema>;

export const AttentionContinuityAgendaEntrySchema = z.object({
  agenda_item_id: z.string().min(1),
  kind: z.string().min(1),
  origin: z.string().min(1),
  subject: z.string().min(1),
  current_posture: z.string().min(1),
  control_state: z.string().min(1),
  staleness_state: z.string().min(1),
  revisit_kind: z.string().min(1),
  revisit_due_at: z.string().nullable(),
  updated_at: z.string(),
  stale_ref_count: z.number().int().nonnegative(),
  invalidation_ref_count: z.number().int().nonnegative(),
}).strict();
export type AttentionContinuityAgendaEntry = z.infer<typeof AttentionContinuityAgendaEntrySchema>;

export const AttentionContinuityOutcomeEntrySchema = z.object({
  outcome_decision_id: z.string().min(1),
  admission_status: z.string().min(1),
  requested_outcome: z.string().min(1),
  final_outcome: z.string().nullable(),
  decided_at: z.string(),
  stale_check_count: z.number().int().nonnegative(),
  runtime_item_refs: z.array(z.string().min(1)),
}).strict();
export type AttentionContinuityOutcomeEntry = z.infer<typeof AttentionContinuityOutcomeEntrySchema>;

export const AttentionContinuityFeedbackEntrySchema = z.object({
  effect_id: z.string().min(1),
  effect_kind: z.string().min(1),
  target_ref: z.string().min(1),
  created_at: z.string(),
}).strict();
export type AttentionContinuityFeedbackEntry = z.infer<typeof AttentionContinuityFeedbackEntrySchema>;

export const AttentionContinuityInspectionSchema = z.object({
  schema_version: z.literal("attention-continuity-inspection-v1"),
  generated_at: z.string().datetime(),
  status: z.enum(["ok", "needs_operator_review", "fail_closed"]),
  summary: z.object({
    attention_input_count: z.number().int().nonnegative(),
    agenda_item_count: z.number().int().nonnegative(),
    pending_agenda_count: z.number().int().nonnegative(),
    held_agenda_count: z.number().int().nonnegative(),
    suppressed_agenda_count: z.number().int().nonnegative(),
    stale_agenda_count: z.number().int().nonnegative(),
    held_outcome_count: z.number().int().nonnegative(),
    quiet_outcome_count: z.number().int().nonnegative(),
    suppressed_outcome_count: z.number().int().nonnegative(),
    stale_decision_count: z.number().int().nonnegative(),
    quiet_preparation_count: z.number().int().nonnegative(),
    pending_runtime_operation_count: z.number().int().nonnegative(),
    runtime_event_count: z.number().int().nonnegative(),
    runtime_item_count: z.number().int().nonnegative(),
    hidden_runtime_item_count: z.number().int().nonnegative(),
    stale_runtime_item_count: z.number().int().nonnegative(),
    feedback_effect_count: z.number().int().nonnegative(),
    warning_count: z.number().int().nonnegative(),
  }).strict(),
  pending_agenda: z.array(AttentionContinuityAgendaEntrySchema),
  held_outcomes: z.array(AttentionContinuityOutcomeEntrySchema),
  quiet_outcomes: z.array(AttentionContinuityOutcomeEntrySchema),
  suppressed_outcomes: z.array(AttentionContinuityOutcomeEntrySchema),
  quiet_preparations: z.array(AttentionContinuityOutcomeEntrySchema),
  recent_feedback_effects: z.array(AttentionContinuityFeedbackEntrySchema),
  pending_runtime_operations: z.array(z.object({
    operation_id: z.string().min(1),
    kind: z.string().min(1),
    state: z.string().min(1),
    updated_at: z.string(),
  }).strict()),
  presence_status: z.object({
    runtime_item_count: z.number().int().nonnegative(),
    active_refs: z.array(z.string().min(1)),
    hidden_inspectable_refs: z.array(z.string().min(1)),
    stale_refs: z.array(z.string().min(1)),
    pending_runtime_operation_ids: z.array(z.string().min(1)),
    runtime_event_count: z.number().int().nonnegative(),
  }).strict(),
  warnings: z.array(AttentionContinuityWarningSchema),
}).strict();
export type AttentionContinuityInspection = z.infer<typeof AttentionContinuityInspectionSchema>;

export interface InspectAttentionContinuityInput {
  runtimeRoot: string;
  controlBaseDir: string;
  now?: string;
  feedbackEffectLimit?: number;
}

export async function inspectAttentionContinuity(
  input: InspectAttentionContinuityInput
): Promise<AttentionContinuityInspection> {
  const attentionStore = new AttentionStateStore(input.runtimeRoot, { controlBaseDir: input.controlBaseDir });
  const feedbackStore = new FeedbackIngestionStore(input.runtimeRoot, { controlBaseDir: input.controlBaseDir });
  const operationStore = new RuntimeOperationStore(input.runtimeRoot, { controlBaseDir: input.controlBaseDir });
  const now = input.now ?? new Date().toISOString();

  const [
    chain,
    attentionRuntimeItems,
    operationRuntimeItems,
    feedbackEffects,
    pendingRuntimeOperations,
    runtimeEvents,
  ] = await Promise.all([
    attentionStore.loadDecisionChainSnapshotStrict({ includeSuppressed: true, includeTerminal: true }),
    attentionStore.listRuntimeItemsStrict(now),
    operationStore.listRuntimeItems(),
    feedbackStore.listEffects(),
    operationStore.listPending(),
    operationStore.listRuntimeEvents(),
  ]);

  return createAttentionContinuityInspection({
    generatedAt: now,
    attentionInputCount: chain.attention_inputs.length,
    agendaItems: chain.agenda_items,
    outcomeDecisions: chain.outcome_decisions,
    inhibitionDecisions: chain.inhibition_decisions,
    initiativeGateDecisions: chain.initiative_gate_decisions,
    runtimeItems: uniqueRuntimeItems([...attentionRuntimeItems, ...operationRuntimeItems]),
    feedbackEffects,
    pendingRuntimeOperations,
    runtimeEventCount: runtimeEvents.length,
    feedbackEffectLimit: input.feedbackEffectLimit,
  });
}

export function createAttentionContinuityInspection(input: {
  generatedAt: string;
  attentionInputCount: number;
  agendaItems: readonly AgentAgendaItem[];
  outcomeDecisions: readonly OutcomeDecision[];
  inhibitionDecisions: readonly { decision_id: string; decision: string; evidence_refs?: readonly unknown[] }[];
  initiativeGateDecisions: readonly { decision_id: string; status: string; staleness_checks?: readonly AutonomyCheck[] }[];
  runtimeItems: readonly RuntimeItem[];
  feedbackEffects: readonly FeedbackIngestionEffect[];
  pendingRuntimeOperations: readonly RuntimeControlOperation[];
  runtimeEventCount: number;
  feedbackEffectLimit?: number;
}): AttentionContinuityInspection {
  const pendingAgenda = input.agendaItems.filter(isPendingAgenda);
  const heldAgenda = input.agendaItems.filter((item) =>
    item.control_state === "held" || item.current_posture === "held" || item.current_posture === "prepared"
  );
  const suppressedAgenda = input.agendaItems.filter((item) =>
    item.control_state === "suppressed" || item.current_posture === "suppressed"
  );
  const staleAgenda = input.agendaItems.filter(isStaleAgenda);
  const heldOutcomes = input.outcomeDecisions.filter((decision) => decision.admission_status === "held");
  const quietOutcomes = input.outcomeDecisions.filter((decision) =>
    decision.final_outcome ? QUIET_OUTCOMES.has(decision.final_outcome) : false
  );
  const suppressedOutcomes = input.outcomeDecisions.filter(isSuppressedOutcome);
  const quietPreparations = input.outcomeDecisions.filter((decision) =>
    decision.final_outcome ? PREPARATION_OUTCOMES.has(decision.final_outcome) : false
  );
  const staleDecisionCount = input.outcomeDecisions.filter(outcomeHasStaleDecisionEvidence).length
    + input.inhibitionDecisions.filter((decision) => decision.decision === "reject_stale").length
    + input.initiativeGateDecisions.filter((decision) => (decision.staleness_checks ?? []).some(checkFailedOrUnknown)).length;
  const hiddenRuntimeItemRefs = input.runtimeItems
    .filter((item) => item.visibility_policy.display === "hidden" && item.visibility_policy.inspectable)
    .map((item) => item.item_id);
  const staleRuntimeItemRefs = input.runtimeItems
    .filter((item) => Object.values(item.staleness).some((value) => value.outcome !== "current"))
    .map((item) => item.item_id);
  const warnings = continuityWarnings({
    generatedAt: input.generatedAt,
    agendaItems: input.agendaItems,
    staleAgenda,
    heldOutcomes,
    quietPreparations,
    suppressedAgenda,
    suppressedOutcomes,
    outcomeDecisions: input.outcomeDecisions,
    runtimeItems: input.runtimeItems,
    pendingRuntimeOperations: input.pendingRuntimeOperations,
  });
  const status = warnings.some((warning) => warning.severity === "fail_closed")
    ? "fail_closed"
    : warnings.length > 0
      ? "needs_operator_review"
      : "ok";

  return AttentionContinuityInspectionSchema.parse({
    schema_version: "attention-continuity-inspection-v1",
    generated_at: input.generatedAt,
    status,
    summary: {
      attention_input_count: input.attentionInputCount,
      agenda_item_count: input.agendaItems.length,
      pending_agenda_count: pendingAgenda.length,
      held_agenda_count: heldAgenda.length,
      suppressed_agenda_count: suppressedAgenda.length,
      stale_agenda_count: staleAgenda.length,
      held_outcome_count: heldOutcomes.length,
      quiet_outcome_count: quietOutcomes.length,
      suppressed_outcome_count: suppressedOutcomes.length,
      stale_decision_count: staleDecisionCount,
      quiet_preparation_count: quietPreparations.length,
      pending_runtime_operation_count: input.pendingRuntimeOperations.length,
      runtime_event_count: input.runtimeEventCount,
      runtime_item_count: input.runtimeItems.length,
      hidden_runtime_item_count: hiddenRuntimeItemRefs.length,
      stale_runtime_item_count: staleRuntimeItemRefs.length,
      feedback_effect_count: input.feedbackEffects.length,
      warning_count: warnings.length,
    },
    pending_agenda: pendingAgenda.map(agendaEntry),
    held_outcomes: heldOutcomes.map(outcomeEntry),
    quiet_outcomes: quietOutcomes.map(outcomeEntry),
    suppressed_outcomes: suppressedOutcomes.map(outcomeEntry),
    quiet_preparations: quietPreparations.map(outcomeEntry),
    recent_feedback_effects: input.feedbackEffects
      .slice(-Math.max(0, input.feedbackEffectLimit ?? 20))
      .map(feedbackEntry),
    pending_runtime_operations: input.pendingRuntimeOperations.map((operation) => ({
      operation_id: operation.operation_id,
      kind: operation.kind,
      state: operation.state,
      updated_at: operation.updated_at,
    })),
    presence_status: {
      runtime_item_count: input.runtimeItems.length,
      active_refs: input.runtimeItems.filter((item) => item.status === "active").map((item) => item.item_id),
      hidden_inspectable_refs: hiddenRuntimeItemRefs,
      stale_refs: staleRuntimeItemRefs,
      pending_runtime_operation_ids: input.pendingRuntimeOperations.map((operation) => operation.operation_id),
      runtime_event_count: input.runtimeEventCount,
    },
    warnings,
  });
}

function isPendingAgenda(item: AgentAgendaItem): boolean {
  return item.control_state !== "stopped"
    && item.control_state !== "expired"
    && item.control_state !== "suppressed"
    && item.current_posture !== "admitted"
    && item.current_posture !== "expired"
    && item.current_posture !== "rejected_stale";
}

function isStaleAgenda(item: AgentAgendaItem): boolean {
  return item.staleness_state !== "current"
    || item.current_posture === "rejected_stale"
    || item.control_state === "expired";
}

function isSuppressedOutcome(decision: OutcomeDecision): boolean {
  return decision.final_outcome === "silence"
    || decision.downgrade_or_rejection_reason?.code === "control_suppressed";
}

function outcomeHasStaleDecisionEvidence(decision: OutcomeDecision): boolean {
  return decision.staleness_checks.some(checkFailedOrUnknown)
    || decision.downgrade_or_rejection_reason?.code === "stale_target";
}

function checkFailedOrUnknown(check: AutonomyCheck): boolean {
  return check.status === "failed" || check.status === "unknown";
}

function agendaEntry(item: AgentAgendaItem): AttentionContinuityAgendaEntry {
  return {
    agenda_item_id: item.agenda_item_id,
    kind: item.kind,
    origin: item.origin,
    subject: item.subject,
    current_posture: item.current_posture,
    control_state: item.control_state,
    staleness_state: item.staleness_state,
    revisit_kind: item.revisit_condition.kind,
    revisit_due_at: item.revisit_condition.due_at ?? null,
    updated_at: item.updated_at,
    stale_ref_count: agendaStaleRefKeys(item).length,
    invalidation_ref_count: agendaInvalidationRefKeys(item).length,
  };
}

function outcomeEntry(decision: OutcomeDecision): AttentionContinuityOutcomeEntry {
  return {
    outcome_decision_id: decision.outcome_decision_id,
    admission_status: decision.admission_status,
    requested_outcome: decision.requested_outcome,
    final_outcome: decision.final_outcome ?? null,
    decided_at: decision.decided_at,
    stale_check_count: decision.staleness_checks.filter(checkFailedOrUnknown).length,
    runtime_item_refs: decision.runtime_item_refs.map((candidate) => candidate.id),
  };
}

function feedbackEntry(effect: FeedbackIngestionEffect): AttentionContinuityFeedbackEntry {
  return {
    effect_id: effect.effect_id,
    effect_kind: effect.effect_kind,
    target_ref: effect.target_ref,
    created_at: effect.created_at,
  };
}

function continuityWarnings(input: {
  generatedAt: string;
  agendaItems: readonly AgentAgendaItem[];
  staleAgenda: readonly AgentAgendaItem[];
  heldOutcomes: readonly OutcomeDecision[];
  quietPreparations: readonly OutcomeDecision[];
  suppressedAgenda: readonly AgentAgendaItem[];
  suppressedOutcomes: readonly OutcomeDecision[];
  outcomeDecisions: readonly OutcomeDecision[];
  runtimeItems: readonly RuntimeItem[];
  pendingRuntimeOperations: readonly RuntimeControlOperation[];
}): AttentionContinuityWarning[] {
  const warnings: AttentionContinuityWarning[] = [];
  if (input.heldOutcomes.length > 0) {
    warnings.push({
      code: "held_outcomes_present",
      severity: "warning",
      detail: `${input.heldOutcomes.length} outcome decision(s) are held and must not flush on restart.`,
    });
  }
  if (input.quietPreparations.length > 0 || input.pendingRuntimeOperations.length > 0) {
    warnings.push({
      code: "quiet_work_pending",
      severity: "info",
      detail: `${input.quietPreparations.length} quiet preparation outcome(s), ${input.pendingRuntimeOperations.length} pending runtime operation(s).`,
    });
  }
  if (input.suppressedAgenda.length > 0 || input.suppressedOutcomes.length > 0) {
    warnings.push({
      code: "suppressed_or_silent_items_present",
      severity: "info",
      detail: `${input.suppressedAgenda.length} suppressed agenda item(s), ${input.suppressedOutcomes.length} suppressed/silent outcome(s).`,
    });
  }
  if (input.staleAgenda.length > 0) {
    warnings.push({
      code: "stale_attention_refs_present",
      severity: "warning",
      detail: `${input.staleAgenda.length} agenda item(s) carry stale or regrounding-required evidence.`,
    });
  }

  const runtimeRefs = new Set([
    ...input.runtimeItems.map((item) => item.item_id),
    ...input.runtimeItems.flatMap((item) =>
      item.item_id.startsWith("runtime-control:") ? [item.item_id.slice("runtime-control:".length)] : []
    ),
    ...input.pendingRuntimeOperations.map((operation) => operation.operation_id),
    ...input.pendingRuntimeOperations.map((operation) => `runtime-control:${operation.operation_id}`),
  ]);
  for (const decision of input.outcomeDecisions) {
    for (const runtimeRef of decision.runtime_item_refs) {
      if (!runtimeRefs.has(runtimeRef.id)) {
        warnings.push({
          code: "missing_runtime_item_ref",
          severity: "fail_closed",
          ref: `${runtimeRef.kind}:${runtimeRef.id}`,
          detail: `Outcome ${decision.outcome_decision_id} references runtime item ${runtimeRef.id}, but no durable runtime item or operation currently rehydrates it.`,
        });
      }
    }
  }

  for (const item of input.agendaItems) {
    if (ambiguousAgendaControlState(item)) {
      warnings.push({
        code: "ambiguous_control_state",
        severity: "fail_closed",
        ref: item.agenda_item_id,
        detail: `Agenda ${item.agenda_item_id} has posture ${item.current_posture} with control state ${item.control_state}.`,
      });
    }
    if (new Date(item.updated_at).getTime() > new Date(input.generatedAt).getTime()) {
      warnings.push({
        code: "future_epoch",
        severity: "fail_closed",
        ref: item.agenda_item_id,
        detail: `Agenda ${item.agenda_item_id} has updated_at after inspection time.`,
      });
    }
  }
  return warnings;
}

function ambiguousAgendaControlState(item: AgentAgendaItem): boolean {
  if (item.control_state === "suppressed") return item.current_posture !== "suppressed";
  if (item.control_state === "expired") {
    return item.current_posture !== "expired" && item.current_posture !== "rejected_stale";
  }
  if (item.control_state === "active") {
    return item.current_posture === "suppressed"
      || item.current_posture === "expired"
      || item.current_posture === "rejected_stale";
  }
  return false;
}

function uniqueRuntimeItems(items: readonly RuntimeItem[]): RuntimeItem[] {
  const byId = new Map<string, RuntimeItem>();
  for (const item of items) byId.set(item.item_id, item);
  return [...byId.values()];
}

function agendaStaleRefKeys(item: AgentAgendaItem): string[] {
  if (item.staleness_state === "current") return [];
  return uniqueStrings([
    ...item.related_goal_refs.map(autonomyRefKey),
    ...item.related_memory_refs.map(autonomyRefKey),
    ...item.related_runtime_refs.map(autonomyRefKey),
    ...item.related_surface_refs.map(autonomyRefKey),
    ...item.revisit_condition.refs.map(autonomyRefKey),
    ...(item.merge_trace?.reinforced_by_refs ?? []).map((source) => autonomyRefKey(source.ref)),
  ]);
}

function agendaInvalidationRefKeys(item: AgentAgendaItem): string[] {
  if (item.staleness_state === "current") return [];
  const revisitRefs = item.revisit_condition.kind === "staleness_change"
    || item.revisit_condition.kind === "surface_refresh"
    || item.revisit_condition.kind === "permission_change"
    ? item.revisit_condition.refs
    : [];
  const invalidatedEvidenceRefs = (item.merge_trace?.reinforced_by_refs ?? [])
    .filter((source) => sourceRefInvalidates(source))
    .map((source) => source.ref);
  return uniqueStrings([
    ...revisitRefs.map(autonomyRefKey),
    ...invalidatedEvidenceRefs.map(autonomyRefKey),
  ]);
}

function sourceRefInvalidates(source: CompanionAutonomySourceRef): boolean {
  return source.lifecycle === "deleted"
    || source.lifecycle === "redacted"
    || source.lifecycle === "tombstone";
}

function autonomyRefKey(ref: CompanionAutonomyRef): string {
  return `${ref.kind}:${ref.id}`;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}
