import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCognitionReplayRecord, type CompanionCognitionOutput } from "../../runtime/cognition/index.js";
import { runDreamConsolidation } from "../dream-consolidation.js";
import {
  FileCognitionWritebackQueueStore,
  decideCognitionWritebackQueueEntry,
} from "../index.js";

let tempDir: string | null = null;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("dream consolidation cognition input", () => {
  it("consumes cognition replay records as reflection input without granting runtime authority", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "pulseed-cognition-reflection-"));
    const eventRef = {
      ref: "chat:event:1",
      source_store: "chat_history" as const,
      source_event_type: "user_input",
      schema_version: 1,
      source_epoch: "turn:1",
      redaction_policy: "metadata_only" as const,
    };
    const output: CompanionCognitionOutput = {
      cognition_id: "cognition:chat:1",
      caller_path: "chat_user_turn",
      situation_model: {
        situation_id: "situation:1",
        summary_ref: eventRef,
        caller_path: "chat_user_turn",
        tool_trace_refs: [],
        approval_refs: [],
        current_target_refs: [],
        stale_target_refs: [],
        protocol_bypass: false,
        confidence: 0.7,
      },
      relationship_state: {
        projection_id: "relationship:1",
        relationship_refs: [],
        withheld_memory_refs: [],
        conflict_refs: [],
        overreach_risk: "unknown",
        ordinary_surface_debug_visible: false,
      },
      selected_intention: null,
      response_plan: {
        plan_id: "response:1",
        guidance_kind: "continue_route",
        public_summary: "Continue route.",
        surface_target: "internal_audit",
        quieting_applied: false,
        operator_debug_refs: [],
        hidden_policy_state_visible_to_normal_user: false,
      },
      tool_candidates: [],
      authorization_requests: [],
      memory_writeback: [{
        proposal_id: "writeback:1",
        proposal_kind: "episode",
        source_event_refs: [eventRef],
        proposed_target: "dream",
        admission_state: "pending_review",
        auto_apply: false,
        source_content_materialized: false,
      }],
      reflection_hints: [],
      audit_refs: ["audit:1"],
      uncertainty: [],
    };
    const record = createCognitionReplayRecord({
      recordId: "replay:1",
      createdAt: "2026-05-14T00:00:00.000Z",
      input: {
        cognition_id: "cognition:chat:1",
        caller_path: "chat_user_turn",
        event_refs: [eventRef],
      },
      output,
    });

    const queue = new FileCognitionWritebackQueueStore(tempDir);
    const report = await runDreamConsolidation({
      stateManager: {
        listGoalIds: vi.fn().mockResolvedValue([]),
      } as never,
      baseDir: tempDir,
      cognitionReplayRecords: [record],
      cognitionWritebackQueue: queue,
    });

    expect(report.cognition_writeback_inputs_read).toBe(1);
    expect(report.cognition_writeback_queue_entries_evaluated).toBe(1);
    expect(report.cognition_runtime_authority_granted).toBe(false);
    expect(report.cognition_writeback_owner_writes_performed).toBe(false);
    expect(await queue.list()).toMatchObject([{
      owner: "dream",
      state: "ready_for_owner_review",
      owner_write_performed: false,
    }]);
    const [queued] = await queue.list();
    await queue.update(decideCognitionWritebackQueueEntry({
      entry: queued!,
      decidedAt: "2026-05-14T00:01:00.000Z",
      decision: {
        kind: "accepted_by_owner",
        reason: "dream owner accepted the replay writeback",
        ownerDecisionRef: { kind: "dream_decision", ref: "dream:accepted:1" },
      },
    }));

    await runDreamConsolidation({
      stateManager: {
        listGoalIds: vi.fn().mockResolvedValue([]),
      } as never,
      baseDir: tempDir,
      cognitionReplayRecords: [record],
      cognitionWritebackQueue: queue,
    });

    expect(await queue.list()).toMatchObject([{
      owner: "dream",
      state: "accepted_by_owner",
      owner_decision_ref: { kind: "dream_decision", ref: "dream:accepted:1" },
      owner_write_performed: false,
    }]);
  });

  it("keeps writeback queue entries distinct for replay records sharing a cognition id", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "pulseed-cognition-reflection-"));
    const eventRef = {
      ref: "chat:event:shared",
      source_store: "chat_history" as const,
      source_event_type: "user_input",
      schema_version: 1,
      source_epoch: "turn:shared",
      redaction_policy: "metadata_only" as const,
    };
    const output = (proposalId: string): CompanionCognitionOutput => ({
      cognition_id: "cognition:chat:shared",
      caller_path: "chat_user_turn",
      situation_model: {
        situation_id: "situation:shared",
        summary_ref: eventRef,
        caller_path: "chat_user_turn",
        tool_trace_refs: [],
        approval_refs: [],
        current_target_refs: [],
        stale_target_refs: [],
        protocol_bypass: false,
        confidence: 0.7,
      },
      relationship_state: {
        projection_id: "relationship:shared",
        relationship_refs: [],
        withheld_memory_refs: [],
        conflict_refs: [],
        overreach_risk: "unknown",
        ordinary_surface_debug_visible: false,
      },
      selected_intention: null,
      response_plan: {
        plan_id: "response:shared",
        guidance_kind: "continue_route",
        public_summary: "Continue route.",
        surface_target: "internal_audit",
        quieting_applied: false,
        operator_debug_refs: [],
        hidden_policy_state_visible_to_normal_user: false,
      },
      tool_candidates: [],
      authorization_requests: [],
      memory_writeback: [{
        proposal_id: proposalId,
        proposal_kind: "episode",
        source_event_refs: [eventRef],
        proposed_target: "dream",
        admission_state: "pending_review",
        auto_apply: false,
        source_content_materialized: false,
      }],
      reflection_hints: [],
      audit_refs: ["audit:shared"],
      uncertainty: [],
    });
    const records = [
      createCognitionReplayRecord({
        recordId: "replay:shared:1",
        createdAt: "2026-05-14T00:00:00.000Z",
        input: {
          cognition_id: "cognition:chat:shared",
          caller_path: "chat_user_turn",
          event_refs: [eventRef],
        },
        output: output("writeback:shared:1"),
      }),
      createCognitionReplayRecord({
        recordId: "replay:shared:2",
        createdAt: "2026-05-14T00:01:00.000Z",
        input: {
          cognition_id: "cognition:chat:shared",
          caller_path: "chat_user_turn",
          event_refs: [eventRef],
        },
        output: output("writeback:shared:2"),
      }),
    ];
    const queue = new FileCognitionWritebackQueueStore(tempDir);

    const report = await runDreamConsolidation({
      stateManager: {
        listGoalIds: vi.fn().mockResolvedValue([]),
      } as never,
      baseDir: tempDir,
      cognitionReplayRecords: records,
      cognitionWritebackQueue: queue,
    });

    const entries = await queue.list();
    expect(report.cognition_writeback_inputs_read).toBe(2);
    expect(report.cognition_writeback_queue_entries_evaluated).toBe(2);
    expect(entries.map((entry) => entry.queue_entry_id)).toEqual([
      "reflection-input:replay:shared:1:queue:1",
      "reflection-input:replay:shared:2:queue:1",
    ]);
    expect(entries.map((entry) => entry.proposal.proposal_id)).toEqual([
      "writeback:shared:1",
      "writeback:shared:2",
    ]);
  });
});
