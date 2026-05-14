import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { upsertRelationshipProfileItem } from "../../../platform/profile/relationship-profile.js";
import {
  evaluateResidentOperationBoundary,
  residentOperationBoundaryActivityMetadata,
} from "../../capability-operation-planner.js";
import { FileCognitionAuditSink } from "../../cognition/index.js";
import { FileCognitiveReplayIndexStore } from "../../visibility/index.js";
import { evaluateResidentProactiveCognition } from "../runner-resident-proactive.js";

const residentCognitionIdPattern = /^cognition:resident:gate:1:evaluation:[0-9a-f-]+$/;
const residentCognitionReplayIdPattern = /^cognition:resident:gate:1:evaluation:[0-9a-f-]+:replay$/;
const residentCognitionReplayIndexIdPattern = /^cognition:resident:gate:1:evaluation:[0-9a-f-]+:replay-index$/;

function blockedAttentionAdmission() {
  return {
    action: "preemptive_check" as const,
    source_kind: "resident_proactive_maintenance" as const,
    attention_input_id: "attention:input:1",
    signal_context_id: "signal:1",
    urge_id: "urge:1",
    agenda_item_id: "agenda:1",
    inhibition_decision_id: "inhibition:1",
    initiative_gate_decision_id: "gate:1",
    replay_disposition: "accepted" as const,
    requested_outcome: "prepare_action_candidate" as const,
    admission_status: "admitted" as const,
    branch_admitted: true,
    summary: "Resident proactive maintenance selected a preemptive check.",
  };
}

function blockedOperationActivityMetadata() {
  return {
    operation_plan_status: "fail_closed" as const,
    operation_plan_reason: "operation boundary blocked preparation",
    operation_preparation_allowed: false,
    operation_execution_allowed: false,
  };
}

function testLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as never;
}

describe("resident proactive cognition", () => {
  it("records hold-only cognition metadata when the resident operation boundary blocks preparation", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-resident-cognition-memory-"));
    await upsertRelationshipProfileItem(baseDir, {
      stableKey: "resident.preemptive_boundary",
      kind: "intervention_policy",
      value: "Only suggest proactive checks after runtime gates admit preparation.",
      source: "cli_update",
      allowedScopes: ["resident_behavior"],
      sensitivity: "private",
      now: "2026-05-14T00:00:00.000Z",
    });
    const metadata = await evaluateResidentProactiveCognition({
      attentionAdmission: blockedAttentionAdmission(),
      operationActivityMetadata: blockedOperationActivityMetadata(),
      surfaceActivityMetadata: {},
      baseDir,
      logger: testLogger(),
    });

    expect(metadata).toMatchObject({
      cognition_id: expect.stringMatching(residentCognitionIdPattern),
      cognition_delivery_kind: "hold",
      cognition_writeback_proposal_count: 1,
      cognition_replay_record_id: expect.stringMatching(residentCognitionReplayIdPattern),
      cognition_replay_index_entry_id: expect.stringMatching(residentCognitionReplayIndexIdPattern),
    });
    expect(await new FileCognitionAuditSink(baseDir).list()).toMatchObject([{
      record_id: expect.stringMatching(residentCognitionReplayIdPattern),
      retention_policy: {
        materialized_content: false,
        refs_only: true,
        invalidates_on_source_tombstone: true,
      },
    }]);
    expect(await new FileCognitiveReplayIndexStore(baseDir).list()).toMatchObject([{
      caller_path: "resident_proactive_check",
      owner_store: "attention_ledger",
      normal_surface_visible: false,
      cognition_service_is_owner: false,
    }]);
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it("preserves replay history across repeated resident cognition evaluations for the same gate", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-resident-cognition-replay-"));
    const attentionAdmission = blockedAttentionAdmission();
    const operationActivityMetadata = blockedOperationActivityMetadata();

    const first = await evaluateResidentProactiveCognition({
      attentionAdmission,
      operationActivityMetadata,
      surfaceActivityMetadata: {},
      baseDir,
      logger: testLogger(),
    });
    const second = await evaluateResidentProactiveCognition({
      attentionAdmission,
      operationActivityMetadata,
      surfaceActivityMetadata: {},
      baseDir,
      logger: testLogger(),
    });
    const records = await new FileCognitionAuditSink(baseDir).list();
    const indexEntries = await new FileCognitiveReplayIndexStore(baseDir).list();

    expect(first.cognition_id).toEqual(expect.stringMatching(residentCognitionIdPattern));
    expect(second.cognition_id).toEqual(expect.stringMatching(residentCognitionIdPattern));
    expect(second.cognition_id).not.toBe(first.cognition_id);
    expect(records.map((record) => record.record_id).sort()).toEqual([
      first.cognition_replay_record_id,
      second.cognition_replay_record_id,
    ].sort());
    expect(indexEntries.map((entry) => entry.index_entry_id).sort()).toEqual([
      first.cognition_replay_index_entry_id,
      second.cognition_replay_index_entry_id,
    ].sort());
    expect(records).toHaveLength(2);
    expect(indexEntries).toHaveLength(2);
    fs.rmSync(baseDir, { recursive: true, force: true });
  });

  it("builds cognition tool candidates only through the existing gadget planning path", async () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-resident-cognition-gadget-"));
    const attentionAdmission = {
      action: "suggest_goal" as const,
      source_kind: "resident_proactive_maintenance" as const,
      attention_input_id: "attention:input:gadget",
      signal_context_id: "signal:gadget",
      urge_id: "urge:gadget",
      agenda_item_id: "agenda:gadget",
      inhibition_decision_id: "inhibition:gadget",
      initiative_gate_decision_id: "gate:gadget",
      outcome_decision_id: "outcome:gadget",
      replay_disposition: "accepted" as const,
      requested_outcome: "prepare_action_candidate" as const,
      final_outcome: "prepare_silently" as const,
      admission_status: "admitted" as const,
      branch_admitted: true,
      summary: "Resident proactive maintenance selected a goal suggestion.",
    };
    const operationBoundary = evaluateResidentOperationBoundary({
      admission: attentionAdmission,
      assembledAt: "2026-05-14T00:00:00.000Z",
      goalId: "goal-1",
      details: { goal_id: "goal-1" },
    });
    const metadata = await evaluateResidentProactiveCognition({
      attentionAdmission,
      operationBoundary,
      operationActivityMetadata: residentOperationBoundaryActivityMetadata(operationBoundary),
      surfaceActivityMetadata: {},
      baseDir,
      goalId: "goal-1",
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });
    const records = await new FileCognitionAuditSink(baseDir).list();

    expect(metadata.cognition_tool_candidate_count).toBe(1);
    expect(records[0]?.stable_output?.tool_candidates).toMatchObject([{
      authority_stage: "suggest",
      can_execute: false,
      may_execute: false,
      memory_is_authority: false,
      model_text_is_authority: false,
    }]);
    expect(JSON.stringify(records[0]?.stable_output?.tool_candidates)).toContain("admission");
    expect(JSON.stringify(records[0]?.stable_output?.tool_candidates)).toContain("autonomy");
    fs.rmSync(baseDir, { recursive: true, force: true });
  });
});
