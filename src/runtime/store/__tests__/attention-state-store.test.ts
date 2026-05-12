import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import {
  admitInitiativeGateDecision,
  buildSignalContextFromAttentionInputs,
  createAttentionInput,
  createExpressionDecisionForOutcome,
  createUrgeCandidate,
  decideInhibition,
  mergeUrgesIntoAgenda,
  ref,
  selectInitiativeGateDecision,
} from "../../attention/index.js";
import type {
  AgentAgendaItem,
  AutonomyCheck,
  CompanionAutonomyRef,
} from "../../types/companion-autonomy.js";
import { AttentionStateStore } from "../attention-state-store.js";
import {
  CONTROL_DB_MIGRATIONS,
  CONTROL_DB_SCHEMA_VERSION,
  openControlDatabase,
} from "../control-db/index.js";

const NOW = "2026-05-12T00:00:00.000Z";
const LATER = "2026-05-12T00:05:00.000Z";

function check(kind: AutonomyCheck["kind"], status: AutonomyCheck["status"] = "passed"): AutonomyCheck {
  return {
    check_id: `${kind}:${status}:attention-store`,
    kind,
    status,
    reason: `${kind} ${status} for durable attention store test`,
    evidence_refs: [],
  };
}

function attentionInputFor(
  sourceKind: Parameters<typeof createAttentionInput>[0]["source_kind"],
  id: string,
) {
  return createAttentionInput({
    source_kind: sourceKind,
    source_id: id,
    source_epoch: `${sourceKind}:epoch:1`,
    high_watermark: `${sourceKind}:watermark:1`,
    emitted_at: NOW,
    payload_class: `test.${sourceKind}`,
    summary: `Test ${sourceKind} attention input.`,
    current_goal_refs: [ref("goal", "goal:attention-store")],
  });
}

function durableAttentionCycle(input: {
  agendaIdSuffix?: string;
  targetRef?: CompanionAutonomyRef;
  origin?: Parameters<typeof createUrgeCandidate>[0]["origin"];
  sourceKind?: Parameters<typeof createAttentionInput>[0]["source_kind"];
} = {}) {
  const attentionInput = attentionInputFor(
    input.sourceKind ?? "schedule",
    `${input.sourceKind ?? "schedule"}:${input.agendaIdSuffix ?? "primary"}`,
  );
  const signalContext = buildSignalContextFromAttentionInputs({
    signal_context_id: `signal:attention-store:${input.agendaIdSuffix ?? "primary"}`,
    assembled_at: NOW,
    inputs: [attentionInput],
    current_goal_refs: [ref("goal", "goal:attention-store")],
  });
  const urge = createUrgeCandidate({
    urge_id: `urge:attention-store:${input.agendaIdSuffix ?? "primary"}`,
    signal_context: signalContext,
    origin: input.origin ?? "schedule",
    target: input.targetRef ?? ref("goal", "goal:attention-store"),
    feeling: "care",
    subject: "Keep the non-GUI autonomy agenda durable across restart.",
    strength: 0.82,
    confidence: 0.9,
    expected_user_benefit: "PulSeed can revisit quiet attention without notifying or acting.",
    maturation_state: "mature",
  });
  const [agendaItem] = mergeUrgesIntoAgenda({
    now: NOW,
    urges: [urge],
  });
  if (!agendaItem) throw new Error("expected agenda item");
  const inhibition = decideInhibition({
    decision_id: `inhibition:attention-store:${input.agendaIdSuffix ?? "primary"}`,
    decided_at: NOW,
    candidate: agendaItem,
    permission_checks: [check("permission")],
    staleness_checks: [check("staleness")],
    safety_checks: [check("safety")],
  });
  const runtimeControlRef = ref("runtime_control", `attention-store-admission:${input.agendaIdSuffix ?? "primary"}`);
  const gate = selectInitiativeGateDecision({
    decision_id: `gate:attention-store:${input.agendaIdSuffix ?? "primary"}`,
    decided_at: NOW,
    candidate: agendaItem,
    inhibition_decision: inhibition,
    requested_outcome: "express_to_user",
    permission_checks: [check("permission")],
    staleness_checks: [check("staleness")],
    side_effect_checks: [check("authority")],
    required_runtime_control_refs: [runtimeControlRef],
  });
  const visibilityPolicyRef = ref("visibility_policy", `visibility:attention-store:${input.agendaIdSuffix ?? "primary"}`);
  const outcome = admitInitiativeGateDecision({
    outcome_decision_id: `outcome:attention-store:${input.agendaIdSuffix ?? "primary"}`,
    gate_decision: gate,
    decided_at: NOW,
    admitted_runtime_control_refs: [runtimeControlRef],
    runtime_item_refs: [ref("runtime_item", agendaItem.agenda_item_id)],
    authority_checks: [check("authority")],
    staleness_checks: [check("staleness")],
    companion_control_checks: [check("companion_control")],
    safety_checks: [check("safety")],
    visibility_checks: [check("visibility")],
    visibility_policy_ref: visibilityPolicyRef,
  });
  if (!outcome) throw new Error("expected admitted outcome");
  const expression = createExpressionDecisionForOutcome({
    expression_decision_id: `expression:attention-store:${input.agendaIdSuffix ?? "primary"}`,
    outcome_decision: outcome,
    created_at: NOW,
    target_surface_classes: ["tui", "gateway"],
    visibility_policy_ref: visibilityPolicyRef,
    user_facing_rationale: "The admitted outcome can be projected by shared text surfaces.",
  });
  if (!expression) throw new Error("expected expression decision");
  return {
    attentionInput,
    signalContext,
    urge,
    agendaItem,
    inhibition,
    gate,
    outcome,
    expression,
  };
}

async function saveCycle(
  store: AttentionStateStore,
  cycle = durableAttentionCycle(),
): Promise<AgentAgendaItem> {
  await store.saveCycle({
    attentionInputs: [cycle.attentionInput],
    signalContext: cycle.signalContext,
    urgeCandidates: [cycle.urge],
    agendaItems: [cycle.agendaItem],
    inhibitionDecisions: [cycle.inhibition],
    initiativeGateDecisions: [cycle.gate],
    outcomeDecisions: [cycle.outcome],
    expressionDecisions: [cycle.expression],
    recordedAt: NOW,
  });
  return cycle.agendaItem;
}

describe("AttentionStateStore", () => {
  it("migrates the control DB to durable attention state tables", async () => {
    const tmpDir = makeTempDir("pulseed-attention-store-migration-");
    try {
      const legacyMigrations = CONTROL_DB_MIGRATIONS.filter((migration) => migration.version < 28);
      const legacyDb = await openControlDatabase({ baseDir: tmpDir, migrations: legacyMigrations });
      try {
        expect(legacyDb.schemaVersion()).toBe(27);
      } finally {
        legacyDb.close();
      }

      const upgraded = await openControlDatabase({ baseDir: tmpDir });
      try {
        expect(CONTROL_DB_SCHEMA_VERSION).toBe(29);
        expect(upgraded.schemaVersion()).toBe(29);
        const tables = upgraded.read((sqlite) =>
          sqlite.prepare(`
            SELECT name
            FROM sqlite_master
            WHERE type = 'table' AND name LIKE 'attention_%'
            ORDER BY name
          `).all() as Array<{ name: string }>
        ).map((row) => row.name);
        expect(tables).toEqual([
          "attention_agenda_items",
          "attention_expression_decisions",
          "attention_inhibition_decisions",
          "attention_initiative_gate_decisions",
          "attention_input_replay_records",
          "attention_inputs",
          "attention_outcome_decisions",
          "attention_signal_contexts",
          "attention_urge_candidates",
        ]);
      } finally {
        upgraded.close();
      }
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("fails closed when the control DB schema is ahead of this code", async () => {
    const tmpDir = makeTempDir("pulseed-attention-store-ahead-");
    try {
      const dbPath = path.join(tmpDir, "state", "pulseed-control.sqlite");
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      const db = new Database(dbPath);
      db.pragma("user_version = 999");
      db.close();

      const store = new AttentionStateStore(path.join(tmpDir, "runtime"));
      await expect(store.ensureReady()).rejects.toThrow("newer than supported version");
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("persists the full attention cycle and rehydrates inspectable agenda after restart", async () => {
    const tmpDir = makeTempDir("pulseed-attention-store-restart-");
    try {
      const cycle = durableAttentionCycle();
      const firstDb = await openControlDatabase({ baseDir: tmpDir });
      try {
        const firstStore = new AttentionStateStore(path.join(tmpDir, "runtime"), { controlDb: firstDb });
        await saveCycle(firstStore, cycle);
        expect(firstDb.read((sqlite) =>
          sqlite.prepare("SELECT COUNT(*) AS count FROM attention_outcome_decisions").get()
        )).toEqual({ count: 1 });
        expect(firstDb.read((sqlite) =>
          sqlite.prepare("SELECT COUNT(*) AS count FROM attention_expression_decisions").get()
        )).toEqual({ count: 1 });
      } finally {
        firstDb.close();
      }

      const secondDb = await openControlDatabase({ baseDir: tmpDir });
      try {
        const restartedStore = new AttentionStateStore(path.join(tmpDir, "runtime"), { controlDb: secondDb });
        await expect(restartedStore.listAttentionInputs()).resolves.toHaveLength(1);
        const agenda = await restartedStore.listAgendaItems();
        expect(agenda).toHaveLength(1);
        expect(agenda[0]).toMatchObject({
          current_posture: "ready_for_gate",
          control_state: "held",
          staleness_state: "current",
        });
        const runtimeItems = await restartedStore.listRuntimeItems(LATER);
        expect(runtimeItems).toHaveLength(1);
        expect(runtimeItems[0]).toMatchObject({
          type: "agent_agenda_item",
          item_id: agenda[0]!.agenda_item_id,
          authority: expect.objectContaining({
            actionable: false,
            speakable: false,
            requires_confirmation: true,
          }),
          visibility_policy: expect.objectContaining({
            display: "hidden",
            inspectable: true,
          }),
        });
        const snapshot = await restartedStore.loadDecisionChainSnapshot();
        expect(snapshot.attention_inputs.map((input) => input.attention_input_id)).toEqual([
          cycle.attentionInput.attention_input_id,
        ]);
        expect(snapshot.signal_contexts.map((context) => context.signal_context_id)).toEqual([
          "signal:attention-store:primary",
        ]);
        expect(snapshot.urge_candidates.map((candidate) => candidate.urge_id)).toEqual([
          "urge:attention-store:primary",
        ]);
        expect(snapshot.agenda_items.map((item) => item.agenda_item_id)).toEqual([
          agenda[0]!.agenda_item_id,
        ]);
        expect(snapshot.inhibition_decisions.map((decision) => decision.decision_id)).toEqual([
          "inhibition:attention-store:primary",
        ]);
        expect(snapshot.initiative_gate_decisions.map((decision) => decision.decision_id)).toEqual([
          "gate:attention-store:primary",
        ]);
        expect(snapshot.outcome_decisions.map((decision) => decision.outcome_decision_id)).toEqual([
          "outcome:attention-store:primary",
        ]);
        expect(snapshot.expression_decisions.map((decision) => decision.expression_decision_id)).toEqual([
          "expression:attention-store:primary",
        ]);
      } finally {
        secondDb.close();
      }
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("deduplicates schedule, proactive, and gateway replay keys durably", async () => {
    const tmpDir = makeTempDir("pulseed-attention-store-replay-");
    try {
      const inputs = [
        attentionInputFor("schedule", "schedule:wait-resume:duplicate"),
        attentionInputFor("resident_proactive_maintenance", "resident:maintenance:duplicate"),
        attentionInputFor("gateway_user_activity", "telegram:user-activity:duplicate"),
      ];
      const firstDb = await openControlDatabase({ baseDir: tmpDir });
      try {
        const firstStore = new AttentionStateStore(path.join(tmpDir, "runtime"), { controlDb: firstDb });
        const first = await firstStore.appendAttentionInputs(inputs, NOW);
        expect(first.accepted).toHaveLength(3);
        expect(first.duplicates).toHaveLength(0);
      } finally {
        firstDb.close();
      }

      const secondDb = await openControlDatabase({ baseDir: tmpDir });
      try {
        const restartedStore = new AttentionStateStore(path.join(tmpDir, "runtime"), { controlDb: secondDb });
        const second = await restartedStore.appendAttentionInputs(inputs, LATER);
        expect(second.accepted).toHaveLength(0);
        expect(second.duplicates.map((record) => record.duplicate_of)).toEqual(
          inputs.map((input) => input.attention_input_id),
        );
        expect(secondDb.read((sqlite) =>
          sqlite.prepare(`
            SELECT disposition, COUNT(*) AS count
            FROM attention_input_replay_records
            GROUP BY disposition
            ORDER BY disposition
          `).all()
        )).toEqual([
          { disposition: "accepted", count: 3 },
          { disposition: "duplicate_replay_key", count: 3 },
        ]);
      } finally {
        secondDb.close();
      }
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("does not persist derived agenda or decisions for duplicate saveCycle inputs after restart", async () => {
    const tmpDir = makeTempDir("pulseed-attention-store-cycle-replay-");
    try {
      for (const sourceKind of ["schedule", "resident_proactive_maintenance", "gateway_user_activity"] as const) {
        const firstDb = await openControlDatabase({ baseDir: tmpDir });
        const original = durableAttentionCycle({
          agendaIdSuffix: `${sourceKind}:original`,
          sourceKind,
        });
        try {
          const firstStore = new AttentionStateStore(path.join(tmpDir, "runtime"), { controlDb: firstDb });
          const intake = await firstStore.saveCycle({
            attentionInputs: [original.attentionInput],
            signalContext: original.signalContext,
            urgeCandidates: [original.urge],
            agendaItems: [original.agendaItem],
            inhibitionDecisions: [original.inhibition],
            initiativeGateDecisions: [original.gate],
            outcomeDecisions: [original.outcome],
            expressionDecisions: [original.expression],
            recordedAt: NOW,
          });
          expect(intake?.accepted).toHaveLength(1);
        } finally {
          firstDb.close();
        }

        const secondDb = await openControlDatabase({ baseDir: tmpDir });
        const duplicate = durableAttentionCycle({
          agendaIdSuffix: `${sourceKind}:derived-duplicate`,
          sourceKind,
          targetRef: ref("goal", `goal:${sourceKind}:derived-duplicate`),
        });
        try {
          const restartedStore = new AttentionStateStore(path.join(tmpDir, "runtime"), { controlDb: secondDb });
          const intake = await restartedStore.saveCycle({
            attentionInputs: [original.attentionInput],
            signalContext: duplicate.signalContext,
            urgeCandidates: [duplicate.urge],
            agendaItems: [duplicate.agendaItem],
            inhibitionDecisions: [duplicate.inhibition],
            initiativeGateDecisions: [duplicate.gate],
            outcomeDecisions: [duplicate.outcome],
            expressionDecisions: [duplicate.expression],
            recordedAt: LATER,
          });

          expect(intake).toMatchObject({
            accepted: [],
            duplicates: [
              expect.objectContaining({
                duplicate_of: original.attentionInput.attention_input_id,
              }),
            ],
          });
          const agendaIds = (await restartedStore.listAgendaItems({ includeTerminal: true }))
            .map((item) => item.agenda_item_id);
          expect(agendaIds).toContain(original.agendaItem.agenda_item_id);
          expect(agendaIds).not.toContain(duplicate.agendaItem.agenda_item_id);
          expect(secondDb.read((sqlite) =>
            sqlite.prepare("SELECT 1 FROM attention_outcome_decisions WHERE outcome_decision_id = ?").get(original.outcome.outcome_decision_id)
          )).toEqual({ 1: 1 });
          expect(secondDb.read((sqlite) =>
            sqlite.prepare("SELECT 1 FROM attention_outcome_decisions WHERE outcome_decision_id = ?").get(duplicate.outcome.outcome_decision_id)
          )).toBeUndefined();
          expect(secondDb.read((sqlite) =>
            sqlite.prepare("SELECT 1 FROM attention_expression_decisions WHERE expression_decision_id = ?").get(original.expression.expression_decision_id)
          )).toEqual({ 1: 1 });
          expect(secondDb.read((sqlite) =>
            sqlite.prepare("SELECT 1 FROM attention_expression_decisions WHERE expression_decision_id = ?").get(duplicate.expression.expression_decision_id)
          )).toBeUndefined();
          expect(secondDb.read((sqlite) =>
            sqlite.prepare(`
              SELECT disposition, COUNT(*) AS count
              FROM attention_input_replay_records
              WHERE replay_key = ?
              GROUP BY disposition
              ORDER BY disposition
            `).all(original.attentionInput.source.replay_key)
          )).toEqual([
            { disposition: "accepted", count: 1 },
            { disposition: "duplicate_replay_key", count: 1 },
          ]);
        } finally {
          secondDb.close();
        }
      }
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("continues cycle persistence for accepted inputs in a mixed duplicate replay batch", async () => {
    const tmpDir = makeTempDir("pulseed-attention-store-mixed-cycle-replay-");
    try {
      const original = durableAttentionCycle({
        agendaIdSuffix: "mixed-original",
        sourceKind: "schedule",
      });
      const firstDb = await openControlDatabase({ baseDir: tmpDir });
      try {
        const firstStore = new AttentionStateStore(path.join(tmpDir, "runtime"), { controlDb: firstDb });
        const intake = await firstStore.saveCycle({
          attentionInputs: [original.attentionInput],
          signalContext: original.signalContext,
          urgeCandidates: [original.urge],
          agendaItems: [original.agendaItem],
          inhibitionDecisions: [original.inhibition],
          initiativeGateDecisions: [original.gate],
          outcomeDecisions: [original.outcome],
          expressionDecisions: [original.expression],
          recordedAt: NOW,
        });
        expect(intake?.accepted).toHaveLength(1);
      } finally {
        firstDb.close();
      }

      const secondDb = await openControlDatabase({ baseDir: tmpDir });
      try {
        const accepted = durableAttentionCycle({
          agendaIdSuffix: "mixed-accepted",
          sourceKind: "gateway_user_activity",
          targetRef: ref("goal", "goal:attention-store:mixed-accepted"),
        });
        const restartedStore = new AttentionStateStore(path.join(tmpDir, "runtime"), { controlDb: secondDb });
        const intake = await restartedStore.saveCycle({
          attentionInputs: [original.attentionInput, accepted.attentionInput],
          signalContext: accepted.signalContext,
          urgeCandidates: [accepted.urge],
          agendaItems: [accepted.agendaItem],
          inhibitionDecisions: [accepted.inhibition],
          initiativeGateDecisions: [accepted.gate],
          outcomeDecisions: [accepted.outcome],
          expressionDecisions: [accepted.expression],
          recordedAt: LATER,
        });

        expect(intake?.accepted.map((input) => input.attention_input_id)).toEqual([
          accepted.attentionInput.attention_input_id,
        ]);
        expect(intake?.duplicates).toEqual([
          expect.objectContaining({
            duplicate_of: original.attentionInput.attention_input_id,
          }),
        ]);
        const snapshot = await restartedStore.loadDecisionChainSnapshot({ includeTerminal: true });
        expect(snapshot.agenda_items.map((item) => item.agenda_item_id)).toEqual(expect.arrayContaining([
          original.agendaItem.agenda_item_id,
          accepted.agendaItem.agenda_item_id,
        ]));
        expect(snapshot.outcome_decisions.map((decision) => decision.outcome_decision_id)).toEqual(
          expect.arrayContaining([
            original.outcome.outcome_decision_id,
            accepted.outcome.outcome_decision_id,
          ])
        );
        expect(snapshot.expression_decisions.map((decision) => decision.expression_decision_id)).toEqual(
          expect.arrayContaining([
            original.expression.expression_decision_id,
            accepted.expression.expression_decision_id,
          ])
        );
        expect(secondDb.read((sqlite) =>
          sqlite.prepare(`
            SELECT attention_input_id, disposition, duplicate_of
            FROM attention_input_replay_records
            WHERE replay_key IN (?, ?)
            ORDER BY recorded_at ASC, disposition ASC, attention_input_id ASC
          `).all(original.attentionInput.source.replay_key, accepted.attentionInput.source.replay_key)
        )).toEqual([
          {
            attention_input_id: original.attentionInput.attention_input_id,
            disposition: "accepted",
            duplicate_of: null,
          },
          {
            attention_input_id: accepted.attentionInput.attention_input_id,
            disposition: "accepted",
            duplicate_of: null,
          },
          {
            attention_input_id: original.attentionInput.attention_input_id,
            disposition: "duplicate_replay_key",
            duplicate_of: original.attentionInput.attention_input_id,
          },
        ]);
      } finally {
        secondDb.close();
      }
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("fails closed for wrong-shaped agenda rows instead of flushing corrupt backlog", async () => {
    const tmpDir = makeTempDir("pulseed-attention-store-corrupt-");
    try {
      const db = await openControlDatabase({ baseDir: tmpDir });
      try {
        const store = new AttentionStateStore(path.join(tmpDir, "runtime"), { controlDb: db });
        const agendaItem = await saveCycle(store);
        db.transaction((sqlite) => {
          sqlite.prepare(`
            UPDATE attention_agenda_items
            SET agenda_json = json(?)
            WHERE agenda_item_id = ?
          `).run(JSON.stringify({ wrong_shape: true }), agendaItem.agenda_item_id);
        });

        await expect(store.listAgendaItems({ includeSuppressed: true, includeTerminal: true })).resolves.toEqual([]);
        await expect(store.listRuntimeItems(LATER)).resolves.toEqual([]);
      } finally {
        db.close();
      }
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("invalidates stale refs and excludes them from default agenda rehydrate", async () => {
    const tmpDir = makeTempDir("pulseed-attention-store-stale-");
    try {
      const db = await openControlDatabase({ baseDir: tmpDir });
      try {
        const store = new AttentionStateStore(path.join(tmpDir, "runtime"), { controlDb: db });
        const agendaItem = await saveCycle(store);
        const invalidated = await store.invalidateRefs({
          refs: [ref("goal", "goal:attention-store")],
          reason: "goal snapshot epoch drifted",
          now: LATER,
        });

        expect(invalidated).toEqual({
          invalidated_count: 1,
          agenda_item_ids: [agendaItem.agenda_item_id],
        });
        await expect(store.listAgendaItems()).resolves.toEqual([]);
        const [staleItem] = await store.listAgendaItems({ includeTerminal: true });
        expect(staleItem).toMatchObject({
          current_posture: "rejected_stale",
          control_state: "expired",
          staleness_state: "rejected",
        });
      } finally {
        db.close();
      }
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("suppresses resident agenda while keeping it inspectable and not auto-flushed", async () => {
    const tmpDir = makeTempDir("pulseed-attention-store-suppress-");
    try {
      const db = await openControlDatabase({ baseDir: tmpDir });
      try {
        const store = new AttentionStateStore(path.join(tmpDir, "runtime"), { controlDb: db });
        const agendaItem = await saveCycle(store, durableAttentionCycle({
          agendaIdSuffix: "curiosity",
          origin: "curiosity",
          sourceKind: "resident_curiosity",
        }));

        const suppressed = await store.suppressAgendaForControl({
          control: "suppress_nonessential_agenda",
          reason: "operator asked for quiet attention",
          now: LATER,
        });

        expect(suppressed).toEqual({
          suppressed_count: 1,
          agenda_item_ids: [agendaItem.agenda_item_id],
        });
        await expect(store.listAgendaItems()).resolves.toEqual([]);
        const [suppressedItem] = await store.listAgendaItems({ includeSuppressed: true });
        expect(suppressedItem).toMatchObject({
          current_posture: "suppressed",
          control_state: "suppressed",
          maturation: expect.objectContaining({ state: "suppressed" }),
          revisit_condition: expect.objectContaining({ kind: "manual_review" }),
        });
        const [runtimeItem] = await store.listRuntimeItems(LATER);
        expect(runtimeItem).toMatchObject({
          item_id: agendaItem.agenda_item_id,
          type: "agent_agenda_item",
          status: "blocked",
          posture: "suppressed",
          authority: expect.objectContaining({
            actionable: false,
            speakable: false,
          }),
        });
      } finally {
        db.close();
      }
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("does not retroactively suppress admitted agenda history", async () => {
    const tmpDir = makeTempDir("pulseed-attention-store-admitted-suppress-");
    try {
      const db = await openControlDatabase({ baseDir: tmpDir });
      try {
        const store = new AttentionStateStore(path.join(tmpDir, "runtime"), { controlDb: db });
        const cycle = durableAttentionCycle({
          agendaIdSuffix: "admitted-history",
          origin: "curiosity",
          sourceKind: "resident_curiosity",
        });
        const admittedAgenda = {
          ...cycle.agendaItem,
          current_posture: "admitted" as const,
          maturation: {
            ...cycle.agendaItem.maturation,
            state: "expressed" as const,
          },
          updated_at: LATER,
        };
        await saveCycle(store, {
          ...cycle,
          agendaItem: admittedAgenda,
        });

        const suppressed = await store.suppressAgendaForControl({
          control: "suppress_nonessential_agenda",
          reason: "do not mutate admitted history",
          now: "2026-05-12T00:10:00.000Z",
        });

        expect(suppressed).toEqual({
          suppressed_count: 0,
          agenda_item_ids: [],
        });
        const [rehydrated] = await store.listAgendaItems({ includeSuppressed: true });
        expect(rehydrated).toMatchObject({
          agenda_item_id: admittedAgenda.agenda_item_id,
          current_posture: "admitted",
          maturation: expect.objectContaining({ state: "expressed" }),
        });
      } finally {
        db.close();
      }
    } finally {
      cleanupTempDir(tmpDir);
    }
  });
});
