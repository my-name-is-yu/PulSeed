import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import {
  admitInitiativeGateDecision,
  buildSignalContextFromAttentionInputs,
  createAttentionInput,
  createAttentionContinuityInspection,
  createUrgeCandidate,
  decideInhibition,
  inspectAttentionContinuity,
  mergeUrgesIntoAgenda,
  ref,
  selectInitiativeGateDecision,
} from "../index.js";
import { AttentionStateStore } from "../../store/attention-state-store.js";
import { FeedbackIngestionStore } from "../../store/feedback-ingestion-store.js";
import { RuntimeOperationStore } from "../../store/runtime-operation-store.js";
import {
  CONTROL_DB_SCHEMA_VERSION,
} from "../../store/control-db/index.js";
import {
  AgentAgendaItemSchema,
  OutcomeDecisionSchema,
  type AgentAgendaItem,
  type AutonomyCheck,
  type OutcomeClass,
} from "../../types/companion-autonomy.js";

const NOW = "2026-05-12T00:00:00.000Z";
const LATER = "2026-05-12T00:05:00.000Z";

function check(kind: AutonomyCheck["kind"], status: AutonomyCheck["status"] = "passed"): AutonomyCheck {
  return {
    check_id: `${kind}:${status}:continuity`,
    kind,
    status,
    reason: `${kind} ${status} for continuity inspection`,
    evidence_refs: [],
  };
}

function attentionInputFor(sourceKind: Parameters<typeof createAttentionInput>[0]["source_kind"], id: string) {
  return createAttentionInput({
    source_kind: sourceKind,
    source_id: id,
    source_epoch: `${sourceKind}:epoch:1`,
    high_watermark: `${sourceKind}:watermark:1`,
    emitted_at: NOW,
    payload_class: `test.${sourceKind}`,
    summary: `Test ${sourceKind} attention input.`,
    current_goal_refs: [ref("goal", `goal:continuity:${id}`)],
  });
}

function durableAttentionCycle(input: {
  suffix: string;
  requestedOutcome?: OutcomeClass;
  sourceKind?: Parameters<typeof createAttentionInput>[0]["source_kind"];
}): {
  attentionInput: ReturnType<typeof createAttentionInput>;
  signalContext: ReturnType<typeof buildSignalContextFromAttentionInputs>;
  urge: ReturnType<typeof createUrgeCandidate>;
  agendaItem: AgentAgendaItem;
  inhibition: ReturnType<typeof decideInhibition>;
  gate: ReturnType<typeof selectInitiativeGateDecision>;
  outcome: NonNullable<ReturnType<typeof admitInitiativeGateDecision>>;
} {
  const sourceKind = input.sourceKind ?? "schedule";
  const attentionInput = attentionInputFor(sourceKind, `${sourceKind}:continuity:${input.suffix}`);
  const signalContext = buildSignalContextFromAttentionInputs({
    signal_context_id: `signal:continuity:${input.suffix}`,
    assembled_at: NOW,
    inputs: [attentionInput],
    current_goal_refs: [ref("goal", `goal:continuity:${input.suffix}`)],
  });
  const urge = createUrgeCandidate({
    urge_id: `urge:continuity:${input.suffix}`,
    signal_context: signalContext,
    origin: sourceKind === "runtime_event" ? "runtime_event" : "schedule",
    target: ref("goal", `goal:continuity:${input.suffix}`),
    feeling: "care",
    subject: "Keep pending autonomy state inspectable across restart.",
    strength: 0.82,
    confidence: 0.9,
    expected_user_benefit: "Quiet work can rehydrate without flushing to the user.",
    maturation_state: "mature",
  });
  const [agendaItem] = mergeUrgesIntoAgenda({ now: NOW, urges: [urge] });
  if (!agendaItem) throw new Error("expected agenda item");
  const inhibition = decideInhibition({
    decision_id: `inhibition:continuity:${input.suffix}`,
    decided_at: NOW,
    candidate: agendaItem,
    permission_checks: [check("permission")],
    staleness_checks: [check("staleness")],
    safety_checks: [check("safety")],
  });
  const runtimeControlRef = ref("runtime_control", `continuity-admission:${input.suffix}`);
  const gate = selectInitiativeGateDecision({
    decision_id: `gate:continuity:${input.suffix}`,
    decided_at: NOW,
    candidate: agendaItem,
    inhibition_decision: inhibition,
    requested_outcome: input.requestedOutcome ?? "express_to_user",
    permission_checks: [check("permission")],
    staleness_checks: [check("staleness")],
    side_effect_checks: [check("authority")],
    required_runtime_control_refs: [runtimeControlRef],
  });
  const outcome = admitInitiativeGateDecision({
    outcome_decision_id: `outcome:continuity:${input.suffix}`,
    gate_decision: gate,
    decided_at: NOW,
    admitted_runtime_control_refs: [runtimeControlRef],
    runtime_item_refs: [ref("runtime_item", agendaItem.agenda_item_id)],
    authority_checks: [check("authority")],
    staleness_checks: [check("staleness")],
    companion_control_checks: [check("companion_control")],
    safety_checks: [check("safety")],
    visibility_checks: [check("visibility")],
    visibility_policy_ref: ref("visibility_policy", `visibility:continuity:${input.suffix}`),
  });
  if (!outcome) throw new Error("expected admitted outcome");
  return { attentionInput, signalContext, urge, agendaItem, inhibition, gate, outcome };
}

function heldOutcomeFrom(cycle: ReturnType<typeof durableAttentionCycle>) {
  const {
    final_outcome: _finalOutcome,
    expression_decision_ref: _expressionDecisionRef,
    ...withoutFinalOutcome
  } = cycle.outcome;
  return OutcomeDecisionSchema.parse({
    ...withoutFinalOutcome,
    outcome_decision_id: `${cycle.outcome.outcome_decision_id}:held`,
    admission_status: "held",
  });
}

function suppressedAgenda(item: AgentAgendaItem): AgentAgendaItem {
  return AgentAgendaItemSchema.parse({
    ...item,
    current_posture: "suppressed",
    control_state: "suppressed",
    maturation: {
      ...item.maturation,
      state: "suppressed",
    },
    revisit_condition: {
      kind: "manual_review",
      refs: [],
      reason: "operator suppressed this agenda item",
    },
    updated_at: LATER,
  });
}

function staleAgenda(item: AgentAgendaItem): AgentAgendaItem {
  return AgentAgendaItemSchema.parse({
    ...item,
    staleness_state: "needs_regrounding",
    revisit_condition: {
      kind: "staleness_change",
      refs: [ref("goal", "goal:continuity")],
      reason: "stored evidence must be regrounded after restart",
    },
    updated_at: LATER,
  });
}

describe("attention continuity inspection", () => {
  it("rehydrates held, suppressed, quiet, feedback, stale, and presence evidence without flushing backlog", async () => {
    const tmpDir = makeTempDir("pulseed-attention-continuity-");
    try {
      const runtimeRoot = path.join(tmpDir, "runtime");
      const attentionStore = new AttentionStateStore(runtimeRoot, { controlBaseDir: tmpDir });
      const pending = durableAttentionCycle({ suffix: "pending" });
      const held = durableAttentionCycle({ suffix: "held" });
      const quiet = durableAttentionCycle({ suffix: "quiet", requestedOutcome: "prepare_silently" });
      const suppressed = durableAttentionCycle({ suffix: "suppressed", requestedOutcome: "silence" });
      const stale = durableAttentionCycle({ suffix: "stale" });

      await attentionStore.saveCycle({
        attentionInputs: [pending.attentionInput, held.attentionInput, quiet.attentionInput, suppressed.attentionInput, stale.attentionInput],
        signalContext: pending.signalContext,
        urgeCandidates: [pending.urge, held.urge, quiet.urge, suppressed.urge, stale.urge],
        agendaItems: [
          pending.agendaItem,
          held.agendaItem,
          quiet.agendaItem,
          suppressedAgenda(suppressed.agendaItem),
          staleAgenda(stale.agendaItem),
        ],
        inhibitionDecisions: [pending.inhibition, held.inhibition, quiet.inhibition, suppressed.inhibition, stale.inhibition],
        initiativeGateDecisions: [pending.gate, held.gate, quiet.gate, suppressed.gate, stale.gate],
        outcomeDecisions: [
          pending.outcome,
          heldOutcomeFrom(held),
          quiet.outcome,
          suppressed.outcome,
        ],
        recordedAt: NOW,
      });

      const operationStore = new RuntimeOperationStore(runtimeRoot, { controlBaseDir: tmpDir });
      await operationStore.save({
        operation_id: "runtime-op:quiet",
        kind: "inspect_companion_state",
        state: "pending",
        requested_at: NOW,
        updated_at: LATER,
        requested_by: { surface: "cli" },
        reply_target: { surface: "cli", channel: "cli" },
        reason: "operator inspection",
        expected_health: { daemon_ping: false, gateway_acceptance: false },
      });
      await new FeedbackIngestionStore(runtimeRoot, { controlBaseDir: tmpDir }).ingest({
        source: "runtime",
        feedback_kind: "runtime_outcome",
        outcome: "runtime_failure",
        target: { kind: "runtime_operation", id: "runtime-op:quiet" },
        runtime_ref: "runtime-op:quiet",
        recorded_at: LATER,
        reason: "quiet preparation failed and must narrow future confidence",
      });

      const first = await inspectAttentionContinuity({
        runtimeRoot,
        controlBaseDir: tmpDir,
        now: LATER,
      });
      const second = await inspectAttentionContinuity({
        runtimeRoot,
        controlBaseDir: tmpDir,
        now: LATER,
      });

      expect(first.status).toBe("needs_operator_review");
      expect(first.summary.pending_agenda_count).toBeGreaterThanOrEqual(4);
      expect(first.summary.held_outcome_count).toBe(1);
      expect(first.summary.quiet_preparation_count).toBe(1);
      expect(first.summary.suppressed_agenda_count).toBe(1);
      expect(first.summary.suppressed_outcome_count).toBe(1);
      expect(first.summary.stale_agenda_count).toBe(1);
      expect(first.summary.pending_runtime_operation_count).toBe(1);
      expect(first.summary.runtime_event_count).toBe(1);
      expect(first.summary.feedback_effect_count).toBeGreaterThan(0);
      expect(first.presence_status.hidden_inspectable_refs).toEqual(expect.arrayContaining([
        pending.agendaItem.agenda_item_id,
      ]));
      expect(first.presence_status.pending_runtime_operation_ids).toEqual(["runtime-op:quiet"]);
      expect(first.warnings.map((warning) => warning.code)).toEqual(expect.arrayContaining([
        "held_outcomes_present",
        "quiet_work_pending",
        "suppressed_or_silent_items_present",
        "stale_attention_refs_present",
      ]));

      expect(second.summary).toEqual(first.summary);
      await expect(operationStore.listPending()).resolves.toHaveLength(1);
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("fails closed when the control DB schema is ahead of this code", async () => {
    const tmpDir = makeTempDir("pulseed-attention-continuity-ahead-schema-");
    try {
      fs.mkdirSync(path.join(tmpDir, "state"), { recursive: true });
      const db = new Database(path.join(tmpDir, "state", "pulseed-control.sqlite"));
      db.pragma(`user_version = ${CONTROL_DB_SCHEMA_VERSION + 1}`);
      db.close();

      await expect(inspectAttentionContinuity({
        runtimeRoot: path.join(tmpDir, "runtime"),
        controlBaseDir: tmpDir,
        now: LATER,
      })).rejects.toThrow("newer than supported version");
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("marks ambiguous control state and missing runtime refs fail-closed", () => {
    const cycle = durableAttentionCycle({ suffix: "fail-closed" });
    const ambiguousAgenda = AgentAgendaItemSchema.parse({
      ...cycle.agendaItem,
      control_state: "suppressed",
      current_posture: "held",
    });
    const missingRuntimeOutcome = OutcomeDecisionSchema.parse({
      ...cycle.outcome,
      runtime_item_refs: [ref("runtime_item", "runtime-item:missing")],
    });

    const inspection = createAttentionContinuityInspection({
      generatedAt: LATER,
      attentionInputCount: 1,
      agendaItems: [ambiguousAgenda],
      outcomeDecisions: [missingRuntimeOutcome],
      inhibitionDecisions: [cycle.inhibition],
      initiativeGateDecisions: [cycle.gate],
      runtimeItems: [],
      feedbackEffects: [],
      pendingRuntimeOperations: [],
      runtimeEventCount: 0,
    });

    expect(inspection.status).toBe("fail_closed");
    expect(inspection.warnings.map((warning) => warning.code)).toEqual(expect.arrayContaining([
      "ambiguous_control_state",
      "missing_runtime_item_ref",
    ]));
  });

  it("reports agenda stale and invalidation refs from typed staleness evidence", () => {
    const currentCycle = durableAttentionCycle({ suffix: "current-ref-counts" });
    const staleCycle = durableAttentionCycle({ suffix: "stale-ref-counts" });
    const currentWithRuntimeAndSurfaceRefs = AgentAgendaItemSchema.parse({
      ...currentCycle.agendaItem,
      related_runtime_refs: [ref("runtime_item", "runtime-item:current")],
      related_surface_refs: [ref("surface", "surface:current")],
      staleness_state: "current",
    });
    const staleWithGoalAndMemoryRefs = AgentAgendaItemSchema.parse({
      ...staleCycle.agendaItem,
      related_goal_refs: [ref("goal", "goal:stale")],
      related_memory_refs: [ref("memory", "memory:stale")],
      staleness_state: "needs_regrounding",
      revisit_condition: {
        kind: "staleness_change",
        refs: [ref("memory", "memory:stale")],
        reason: "memory evidence must be regrounded before action",
      },
    });

    const inspection = createAttentionContinuityInspection({
      generatedAt: LATER,
      attentionInputCount: 2,
      agendaItems: [currentWithRuntimeAndSurfaceRefs, staleWithGoalAndMemoryRefs],
      outcomeDecisions: [],
      inhibitionDecisions: [currentCycle.inhibition, staleCycle.inhibition],
      initiativeGateDecisions: [currentCycle.gate, staleCycle.gate],
      runtimeItems: [],
      feedbackEffects: [],
      pendingRuntimeOperations: [],
      runtimeEventCount: 0,
    });

    const currentEntry = inspection.pending_agenda.find((item) =>
      item.agenda_item_id === currentWithRuntimeAndSurfaceRefs.agenda_item_id
    );
    const staleEntry = inspection.pending_agenda.find((item) =>
      item.agenda_item_id === staleWithGoalAndMemoryRefs.agenda_item_id
    );

    expect(currentEntry).toMatchObject({
      stale_ref_count: 0,
      invalidation_ref_count: 0,
    });
    expect(staleEntry?.stale_ref_count).toBeGreaterThanOrEqual(2);
    expect(staleEntry).toMatchObject({
      invalidation_ref_count: 1,
    });
  });
});
