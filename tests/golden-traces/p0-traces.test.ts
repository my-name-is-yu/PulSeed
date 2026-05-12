import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertGoldenTraceResult, runGoldenTrace } from "../harness/golden-trace-runner.js";
import type { GoldenTraceFixture } from "../harness/types.js";

const expectedP0TraceNames = [
  "gateway_ordinary_chat_first_visible_no_progress",
  "gateway_assistant_delta_before_model_terminal",
  "gateway_read_workspace_under_protected_paths_no_approval",
  "gateway_runtime_status_uses_tool_evidence_not_guidance",
  "gateway_secret_setup_redacts_token_and_confirms_write",
  "gateway_routed_ingress_preserves_reply_target_after_restart",
  "gateway_runspec_draft_pending_no_same_turn_start",
  "gateway_runspec_epoch_changed_rejects_start",
  "gateway_final_visible_suppresses_late_progress_and_typing",
  "gateway_approval_denial_never_executes_write",
  "gateway_approval_target_args_mismatch_blocked",
  "gateway_approval_other_tool_after_approval_blocked",
  "gateway_multi_approval_reentrant_same_turn",
  "approval_origin_bound_stale_reply_rejected",
  "approval_pending_restored_after_daemon_restart",
  "approval_delivery_unavailable_denies_not_executes",
  "runtime_control_pause_current_run_conversation_scoped",
  "runtime_control_latest_other_conversation_blocked",
  "runtime_control_terminal_run_stale_blocked",
  "runtime_control_resume_after_companion_revival_requires_readmission",
  "runtime_control_cancel_after_revival_blocks_stale_run",
  "runtime_control_finalize_records_proposal_without_external_action",
  "eventserver_command_accept_durable_before_200",
  "eventserver_approval_unknown_request_rejected_before_accept",
  "schedule_wait_resume_before_due_no_attention_or_notification",
  "schedule_wait_resume_due_creates_held_attention_artifact",
  "schedule_wait_resume_retry_same_due_idempotent",
  "schedule_side_effect_crash_replay_no_duplicate_execution",
  "queue_expired_claim_rejects_late_ack_and_reclaims",
  "queue_dedupe_inflight_rejects_replacement",
  "tool_readonly_fs_no_write_approval_under_workspace",
  "tool_write_local_records_approval_artifact_before_mutation",
  "tool_unavailable_returned_to_model_before_final",
  "state_attention_schema_ahead_fail_closed",
  "state_runtime_root_custom_shared_control_db",
  "session_registry_dead_process_not_running",
  "attention_observation_requires_visible_indicator_before_event",
  "attention_observation_after_expiry_terminal_allowed_only",
  "resident_runtime_snapshot_capability_discovery_grants_no_authority",
  "daemon_progress_final_order_once",
];

const fixturesPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "p0", "fixtures.json");
const fixtures = JSON.parse(readFileSync(fixturesPath, "utf8")) as GoldenTraceFixture[];

describe("P0 golden trace catalog", () => {
  it("covers every planned P0 trace exactly once", () => {
    expect(fixtures.map((fixture) => fixture.contract_name).sort()).toEqual([...expectedP0TraceNames].sort());
    expect(new Set(fixtures.map((fixture) => fixture.contract_name)).size).toBe(expectedP0TraceNames.length);
  });

  it("keeps fast trace fixtures off real network and real providers", () => {
    for (const fixture of fixtures) {
      expect(fixture.input.allow_network).not.toBe(true);
      expect(fixture.input.allow_real_llm).not.toBe(true);
      expect(fixture.input.entrypoint).not.toMatch(/^private:/);
      expect(fixture.production_boundary).not.toMatch(/^private:/);
      expect(fixture.expected.artifact_tree.length).toBeGreaterThan(0);
    }
  });
});

describe.each(fixtures)("P0 golden trace: $contract_name", (fixture) => {
  it("matches the normalized event, surface, and state artifacts", async () => {
    const result = await runGoldenTrace(fixture);
    assertGoldenTraceResult(fixture, result);
    expect(result.events.map((event) => event.type)).toContain("assistant_final");
  });
});
