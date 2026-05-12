# PulSeed Test Redesign Replacement Map

Generated: 2026-05-12T15:57:57.021Z

Deletion gate: old tests may only be deleted after the mapped replacement trace has landed and the old test plus new trace passed in the same checkout.

## P0 Trace Coverage

- Mapped P0 traces: 40/40
- Unmapped P0 traces: 0

## Old Test Blocks

### src/interface/chat/__tests__/chat-runner.test.ts

- Production boundary: Gateway ingress -> ChatRunner -> ChatEvent stream
- State artifact: chat session transcript, visible surface events
- Replacement traces:
  - gateway_ordinary_chat_first_visible_no_progress
  - gateway_assistant_delta_before_model_terminal
  - gateway_runtime_status_uses_tool_evidence_not_guidance
  - gateway_final_visible_suppresses_late_progress_and_typing
  - tool_unavailable_returned_to_model_before_final
- Simultaneous pass evidence: 2026-05-13: `npm run test:golden-traces` passed 40 traces, `npm run test:replay` passed 7 replay fixtures, and `npx vitest run src/interface/chat/__tests__/chat-runner.test.ts src/interface/chat/__tests__/chat-runner-tools.test.ts src/interface/chat/__tests__/setup-secret-intake.test.ts src/tools/fs/ReadTool/__tests__/ReadTool.test.ts src/tools/fs/FileWriteTool/__tests__/FileWriteTool.test.ts --config vitest.unit.config.ts` passed 5 files / 185 tests.
- Delete condition: keep until all mapped traces and the old file pass together in this checkout.

### src/interface/chat/__tests__/chat-runner-tools.test.ts

- Production boundary: Gateway ingress -> ChatRunner -> readonly workspace tool boundary
- State artifact: tool request/result envelope, chat event stream
- Replacement traces:
  - gateway_read_workspace_under_protected_paths_no_approval
- Simultaneous pass evidence: 2026-05-13: `npm run test:golden-traces` passed 40 traces, `npm run test:replay` passed 7 replay fixtures, and the mapped unit batch passed 5 files / 185 tests.
- Delete condition: keep until all mapped traces and the old file pass together in this checkout.

### src/interface/chat/__tests__/setup-secret-intake.test.ts

- Production boundary: Gateway secret setup intake -> typed secret writer -> redacted chat state
- State artifact: secret setup state, redacted transcript/event artifact
- Replacement traces:
  - gateway_secret_setup_redacts_token_and_confirms_write
- Simultaneous pass evidence: 2026-05-13: `npm run test:golden-traces` passed 40 traces, `npm run test:replay` passed 7 replay fixtures, and the mapped unit batch passed 5 files / 185 tests.
- Delete condition: keep until all mapped traces and the old file pass together in this checkout.

### src/interface/chat/__tests__/cross-platform-session.test.ts

- Production boundary: Gateway adapter -> CrossPlatformChatSessionManager.processIncomingMessage
- State artifact: reply target state, run spec draft state, approval origin state
- Replacement traces:
  - gateway_routed_ingress_preserves_reply_target_after_restart
  - gateway_runspec_draft_pending_no_same_turn_start
  - gateway_runspec_epoch_changed_rejects_start
  - approval_origin_bound_stale_reply_rejected
  - approval_delivery_unavailable_denies_not_executes
- Simultaneous pass evidence: 2026-05-13: `npm run test:golden-traces` passed 40 traces, `npm run test:replay` passed 7 replay fixtures, and `npx vitest run src/interface/chat/__tests__/cross-platform-session.test.ts --config vitest.unit.config.ts` passed 1 file / 89 tests.
- Delete condition: keep until all mapped traces and the old file pass together in this checkout.

### src/runtime/control/__tests__/runtime-control-service.test.ts

- Production boundary: Gateway/CLI runtime-control request -> RuntimeControlService -> runtime_operations
- State artifact: runtime_operations, background_runs, runtime events
- Replacement traces:
  - runtime_control_pause_current_run_conversation_scoped
  - runtime_control_latest_other_conversation_blocked
  - runtime_control_terminal_run_stale_blocked
  - runtime_control_resume_after_companion_revival_requires_readmission
  - runtime_control_cancel_after_revival_blocks_stale_run
  - runtime_control_finalize_records_proposal_without_external_action
- Simultaneous pass evidence: 2026-05-13: `npm run test:golden-traces` passed 40 traces, `npm run test:replay` passed 7 replay fixtures, and the mapped runtime integration batch passed 6 files / 260 tests.
- Delete condition: keep until all mapped traces and the old file pass together in this checkout.

### src/runtime/__tests__/schedule-engine.test.ts

- Production boundary: ScheduleEngine.tick() -> schedule store/history -> attention projection
- State artifact: schedule entries/history, attention projections, notification outbox
- Replacement traces:
  - schedule_wait_resume_before_due_no_attention_or_notification
  - schedule_wait_resume_due_creates_held_attention_artifact
  - schedule_wait_resume_retry_same_due_idempotent
  - schedule_side_effect_crash_replay_no_duplicate_execution
- Simultaneous pass evidence: 2026-05-13: `npm run test:golden-traces` passed 40 traces, `npm run test:replay` passed 7 replay fixtures, and the mapped runtime integration batch passed 6 files / 260 tests.
- Delete condition: keep until all mapped traces and the old file pass together in this checkout.

### src/runtime/__tests__/approval-broker.test.ts

- Production boundary: Approval response -> ApprovalBroker -> approval store/tool gate
- State artifact: approval_records, tool approval artifact
- Replacement traces:
  - gateway_approval_denial_never_executes_write
  - gateway_approval_target_args_mismatch_blocked
  - gateway_approval_other_tool_after_approval_blocked
  - gateway_multi_approval_reentrant_same_turn
  - approval_pending_restored_after_daemon_restart
- Simultaneous pass evidence: 2026-05-13: `npm run test:golden-traces` passed 40 traces, `npm run test:replay` passed 7 replay fixtures, and the mapped runtime integration batch passed 6 files / 260 tests.
- Delete condition: keep until all mapped traces and the old file pass together in this checkout.

### src/runtime/queue/__tests__/journal-backed-queue.test.ts

- Production boundary: EventServer HTTP -> durable queue/journal -> dispatcher claim
- State artifact: queue journal, command envelope, claim state
- Replacement traces:
  - eventserver_command_accept_durable_before_200
  - eventserver_approval_unknown_request_rejected_before_accept
  - queue_expired_claim_rejects_late_ack_and_reclaims
  - queue_dedupe_inflight_rejects_replacement
- Simultaneous pass evidence: 2026-05-13: `npm run test:golden-traces` passed 40 traces, `npm run test:replay` passed 7 replay fixtures, and the mapped runtime integration batch passed 6 files / 260 tests.
- Delete condition: keep until all mapped traces and the old file pass together in this checkout.

### src/runtime/store/__tests__/attention-state-store.test.ts

- Production boundary: runtime startup/replay -> attention state store -> control DB
- State artifact: attention state tables, migration audit
- Replacement traces:
  - state_attention_schema_ahead_fail_closed
  - attention_observation_requires_visible_indicator_before_event
  - attention_observation_after_expiry_terminal_allowed_only
- Simultaneous pass evidence: 2026-05-13: `npm run test:golden-traces` passed 40 traces, `npm run test:replay` passed 7 replay fixtures, and the mapped runtime integration batch passed 6 files / 260 tests.
- Delete condition: keep until all mapped traces and the old file pass together in this checkout.

### src/runtime/__tests__/daemon-runner.test.ts

- Production boundary: daemon startup/snapshot -> runtime root/session registry -> visible progress surface
- State artifact: daemon snapshot, session registry snapshot, progress/final events
- Replacement traces:
  - state_runtime_root_custom_shared_control_db
  - session_registry_dead_process_not_running
  - daemon_progress_final_order_once
- Simultaneous pass evidence: 2026-05-13: `npm run test:golden-traces` passed 40 traces, `npm run test:replay` passed 7 replay fixtures, and the mapped runtime integration batch passed 6 files / 260 tests.
- Delete condition: keep until all mapped traces and the old file pass together in this checkout.

### src/runtime/session-registry/__tests__/runtime-session-registry.test.ts

- Production boundary: resident runtime discovery -> session registry snapshot
- State artifact: session registry snapshot, capability snapshot
- Replacement traces:
  - session_registry_dead_process_not_running
  - resident_runtime_snapshot_capability_discovery_grants_no_authority
- Simultaneous pass evidence: 2026-05-13: `npm run test:golden-traces` passed 40 traces, `npm run test:replay` passed 7 replay fixtures, and `npx vitest run src/runtime/session-registry/__tests__/runtime-session-registry.test.ts --config vitest.integration.config.ts` passed 1 file / 21 tests.
- Delete condition: keep until all mapped traces and the old file pass together in this checkout.

### src/tools/fs/ReadTool/__tests__/ReadTool.test.ts

- Production boundary: tool catalog -> readonly filesystem tool execution
- State artifact: tool result envelope
- Replacement traces:
  - tool_readonly_fs_no_write_approval_under_workspace
- Simultaneous pass evidence: 2026-05-13: `npm run test:golden-traces` passed 40 traces, `npm run test:replay` passed 7 replay fixtures, and the mapped unit batch passed 5 files / 185 tests.
- Delete condition: keep until all mapped traces and the old file pass together in this checkout.

### src/tools/fs/FileWriteTool/__tests__/FileWriteTool.test.ts

- Production boundary: tool approval gate -> local write mutation
- State artifact: approval artifact, mutation artifact
- Replacement traces:
  - tool_write_local_records_approval_artifact_before_mutation
- Simultaneous pass evidence: 2026-05-13: `npm run test:golden-traces` passed 40 traces, `npm run test:replay` passed 7 replay fixtures, and the mapped unit batch passed 5 files / 185 tests.
- Delete condition: keep until all mapped traces and the old file pass together in this checkout.

