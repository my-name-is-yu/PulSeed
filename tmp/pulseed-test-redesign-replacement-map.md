# PulSeed Test Redesign Replacement Map

Generated: 2026-05-12T23:11:34.298Z

Deletion gate: pending_real_runner is never deletion evidence. Old test files may only be deleted after every mapped replacement trace records runner.status=real_production_path, a production entrypoint, an exported state artifact source, and old/new tests passing in the same checkout. Individual old test blocks may be deleted when their specific high-value assertion is covered by a real_production_path trace and any remaining pure unit value stays in place.

## P0 Trace Coverage

- Mapped P0 traces: 40/40
- Unmapped P0 traces: 0

## Old Test Blocks

### src/interface/chat/__tests__/chat-runner.test.ts

- Production boundary: Gateway ingress -> ChatRunner -> ChatEvent stream
- State artifact: chat session transcript, visible surface events
- Old test file deletion allowed: no
- No reason: File-level deletion still requires an assertion inventory; delete only recorded old-test blocks whose specific assertion is covered by real_production_path evidence.
- Replacement evidence:
  - Replacement trace name: gateway_ordinary_chat_first_visible_no_progress
    - Real production entrypoint used: golden: Gateway ingress -> ChatRunner -> ChatEvent stream
    - Exported state artifact/assertion: golden: state/gateway/gateway_ordinary_chat_first_visible_no_progress.json; assertions assistant_delta_before_final, final_count, no_progress_after_final, visible_event_count
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: File-level deletion still requires an assertion inventory; delete only recorded old-test blocks whose specific assertion is covered by real_production_path evidence.
  - Replacement trace name: gateway_assistant_delta_before_model_terminal
    - Real production entrypoint used: golden: Gateway ingress -> ChatRunner -> ChatEvent stream
    - Exported state artifact/assertion: golden: state/gateway/gateway_assistant_delta_before_model_terminal.json; assertions assistant_delta_before_final, final_count, no_progress_after_final, visible_event_count
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: File-level deletion still requires an assertion inventory; delete only recorded old-test blocks whose specific assertion is covered by real_production_path evidence.
  - Replacement trace name: gateway_runtime_status_uses_tool_evidence_not_guidance
    - Real production entrypoint used: golden: Gateway ingress -> runtime status tool evidence -> ChatEvent stream
    - Exported state artifact/assertion: golden: state/gateway/gateway_runtime_status_uses_tool_evidence_not_guidance.json; assertions contains_run_id, generic_guidance_returned, status_line_count, typed_runtime_evidence_used
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: File-level deletion still requires an assertion inventory; delete only recorded old-test blocks whose specific assertion is covered by real_production_path evidence.
  - Replacement trace name: gateway_final_visible_suppresses_late_progress_and_typing
    - Real production entrypoint used: golden: Gateway ingress -> ChatRunner -> visible surface projector
    - Exported state artifact/assertion: golden: state/gateway/gateway_final_visible_suppresses_late_progress_and_typing.json; assertions assistant_delta_before_final, final_count, no_progress_after_final, visible_event_count
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: File-level deletion still requires an assertion inventory; delete only recorded old-test blocks whose specific assertion is covered by real_production_path evidence.
  - Replacement trace name: tool_unavailable_returned_to_model_before_final
    - Real production entrypoint used: golden: ChatRunner tool executor -> structured tool error -> model continuation
    - Exported state artifact/assertion: golden: state/tool/tool_unavailable_returned_to_model_before_final.json; assertions model_continuation_after_tool_error, structured_tool_error_returned, unavailable_tool_executed
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: File-level deletion still requires an assertion inventory; delete only recorded old-test blocks whose specific assertion is covered by real_production_path evidence.
- Simultaneous pass evidence: 2026-05-13: `npm run test:golden-traces` passed 42 tests (40 fixtures), `npm run test:replay` passed 9 tests (7 fixtures), and `npx vitest run src/interface/chat/__tests__/chat-runner.test.ts src/interface/chat/__tests__/chat-runner-tools.test.ts src/interface/chat/__tests__/setup-secret-intake.test.ts src/tools/fs/ReadTool/__tests__/ReadTool.test.ts src/tools/fs/FileWriteTool/__tests__/FileWriteTool.test.ts --config vitest.unit.config.ts` passed 5 files / 184 tests.
- Delete condition: delete a whole file only when the old test file deletion gate above says yes; delete an individual block only when it is recorded under Deleted old-test blocks with real replacement evidence.

### src/interface/chat/__tests__/chat-runner-tools.test.ts

- Production boundary: Gateway ingress -> ChatRunner -> readonly workspace tool boundary
- State artifact: tool request/result envelope, chat event stream
- Old test file deletion allowed: no
- No reason: File-level deletion still requires an assertion inventory; delete only recorded old-test blocks whose specific assertion is covered by real_production_path evidence.
- Replacement evidence:
  - Replacement trace name: gateway_read_workspace_under_protected_paths_no_approval
    - Real production entrypoint used: golden: Gateway ingress -> ChatRunner -> readonly workspace tool boundary
    - Exported state artifact/assertion: golden: state/gateway/gateway_read_workspace_under_protected_paths_no_approval.json; assertions assistant_delta_before_final, final_count, no_progress_after_final, visible_event_count
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: File-level deletion still requires an assertion inventory; delete only recorded old-test blocks whose specific assertion is covered by real_production_path evidence.
- Simultaneous pass evidence: 2026-05-13: `npm run test:golden-traces` passed 42 tests (40 fixtures), `npm run test:replay` passed 9 tests (7 fixtures), and the mapped unit batch passed 5 files / 184 tests.
- Delete condition: delete a whole file only when the old test file deletion gate above says yes; delete an individual block only when it is recorded under Deleted old-test blocks with real replacement evidence.

### src/interface/chat/__tests__/setup-secret-intake.test.ts

- Production boundary: Gateway secret setup intake -> typed secret writer -> redacted chat state
- State artifact: secret setup state, redacted transcript/event artifact
- Old test file deletion allowed: no
- No reason: URL query secret redaction remains as focused parser/unit coverage not yet represented by the gateway secret setup trace.
- Deleted old-test blocks:
  - Block: stores the detected Telegram token as transient value without offset artifacts
    - Replacement trace: gateway_secret_setup_redacts_token_and_confirms_write
    - Deletion allowed: yes
    - Evidence: 2026-05-13: pre-delete unit `npx vitest run src/interface/chat/__tests__/setup-secret-intake.test.ts --config vitest.unit.config.ts` passed 2 tests; replacement `npm run test:golden-traces` passed 42 tests; post-delete unit passed 1 remaining URL-query redaction test.
- Replacement evidence:
  - Replacement trace name: gateway_secret_setup_redacts_token_and_confirms_write
    - Real production entrypoint used: golden: Gateway secret setup intake -> typed secret writer -> redacted chat state
    - Exported state artifact/assertion: golden: state/gateway/gateway_secret_setup_redacts_token_and_confirms_write.json; assertions config_written, redacted_text_contains_secret, secret_count, token_value_persisted
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: URL query secret redaction remains as focused parser/unit coverage not yet represented by the gateway secret setup trace.
- Simultaneous pass evidence: 2026-05-13: `npm run test:golden-traces` passed 42 tests (40 fixtures), `npm run test:replay` passed 9 tests (7 fixtures), and the mapped unit batch passed 5 files / 184 tests.
- Delete condition: delete a whole file only when the old test file deletion gate above says yes; delete an individual block only when it is recorded under Deleted old-test blocks with real replacement evidence.

### src/interface/chat/__tests__/cross-platform-session.test.ts

- Production boundary: Gateway adapter -> CrossPlatformChatSessionManager.processIncomingMessage
- State artifact: reply target state, run spec draft state, approval origin state
- Old test file deletion allowed: no
- No reason: File-level deletion still requires an assertion inventory; delete only recorded old-test blocks whose specific assertion is covered by real_production_path evidence.
- Replacement evidence:
  - Replacement trace name: gateway_routed_ingress_preserves_reply_target_after_restart
    - Real production entrypoint used: golden: Gateway adapter -> CrossPlatformChatSessionManager.processIncomingMessage; replay: Gateway adapter -> CrossPlatformChatSessionManager.processIncomingMessage
    - Exported state artifact/assertion: golden: state/gateway/gateway_routed_ingress_preserves_reply_target_after_restart.json; assertions reply_target_after_restart, reply_target_preserved, transcript_reloaded; replay: state/chat-session/gateway_routed_ingress_preserves_reply_target_after_restart.json; assertions fresh_restarted_equal, startup_replay_path
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13; `npm run test:replay` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: File-level deletion still requires an assertion inventory; delete only recorded old-test blocks whose specific assertion is covered by real_production_path evidence.
  - Replacement trace name: gateway_runspec_draft_pending_no_same_turn_start
    - Real production entrypoint used: golden: Gateway ingress -> RunSpec draft state -> durable run gate
    - Exported state artifact/assertion: golden: state/gateway/gateway_runspec_draft_pending_no_same_turn_start.json; assertions background_run_started, pending_confirmation_written, same_turn_start_blocked
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: File-level deletion still requires an assertion inventory; delete only recorded old-test blocks whose specific assertion is covered by real_production_path evidence.
  - Replacement trace name: gateway_runspec_epoch_changed_rejects_start
    - Real production entrypoint used: golden: Gateway ingress -> RunSpec confirmation epoch gate
    - Exported state artifact/assertion: golden: state/gateway/gateway_runspec_epoch_changed_rejects_start.json; assertions background_run_started, epoch_changed_rejected, stale_confirmation_consumed
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: File-level deletion still requires an assertion inventory; delete only recorded old-test blocks whose specific assertion is covered by real_production_path evidence.
  - Replacement trace name: approval_origin_bound_stale_reply_rejected
    - Real production entrypoint used: golden: Approval response -> origin-bound approval broker
    - Exported state artifact/assertion: golden: state/approval/approval_origin_bound_stale_reply_rejected.json; assertions mutation_executed, pending_after_resolution, request_result, resolved, resolved_state, stale_reply_rejected
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: File-level deletion still requires an assertion inventory; delete only recorded old-test blocks whose specific assertion is covered by real_production_path evidence.
  - Replacement trace name: approval_delivery_unavailable_denies_not_executes
    - Real production entrypoint used: golden: Gateway approval delivery -> channel availability gate
    - Exported state artifact/assertion: golden: state/approval/approval_delivery_unavailable_denies_not_executes.json; assertions mutation_executed, pending_after_resolution, request_result, resolved, resolved_state, stale_reply_rejected
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: File-level deletion still requires an assertion inventory; delete only recorded old-test blocks whose specific assertion is covered by real_production_path evidence.
- Simultaneous pass evidence: 2026-05-13: `npm run test:golden-traces` passed 42 tests (40 fixtures), `npm run test:replay` passed 9 tests (7 fixtures), and `npx vitest run src/interface/chat/__tests__/cross-platform-session.test.ts --config vitest.unit.config.ts` passed 1 file / 89 tests.
- Delete condition: delete a whole file only when the old test file deletion gate above says yes; delete an individual block only when it is recorded under Deleted old-test blocks with real replacement evidence.

### src/runtime/control/__tests__/runtime-control-service.test.ts

- Production boundary: Gateway/CLI runtime-control request -> RuntimeControlService -> runtime_operations
- State artifact: runtime_operations, background_runs, runtime events
- Old test file deletion allowed: no
- No reason: File-level deletion still requires an assertion inventory; delete only recorded old-test blocks whose specific assertion is covered by real_production_path evidence.
- Replacement evidence:
  - Replacement trace name: runtime_control_pause_current_run_conversation_scoped
    - Real production entrypoint used: golden: Gateway runtime-control request -> RuntimeControlService -> runtime_operations
    - Exported state artifact/assertion: golden: state/runtime-control/runtime_control_pause_current_run_conversation_scoped.json; assertions blocked_reason, executor_call_count, operation_count, operation_state, reply_target_conversation, result_success, target_run_id
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: File-level deletion still requires an assertion inventory; delete only recorded old-test blocks whose specific assertion is covered by real_production_path evidence.
  - Replacement trace name: runtime_control_latest_other_conversation_blocked
    - Real production entrypoint used: golden: Gateway runtime-control request -> conversation-scoped run resolver
    - Exported state artifact/assertion: golden: state/runtime-control/runtime_control_latest_other_conversation_blocked.json; assertions blocked_reason, executor_call_count, operation_count, operation_state, reply_target_conversation, result_success, target_run_id
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: File-level deletion still requires an assertion inventory; delete only recorded old-test blocks whose specific assertion is covered by real_production_path evidence.
  - Replacement trace name: runtime_control_terminal_run_stale_blocked
    - Real production entrypoint used: golden: Gateway runtime-control request -> terminal run guard
    - Exported state artifact/assertion: golden: state/runtime-control/runtime_control_terminal_run_stale_blocked.json; assertions blocked_reason, executor_call_count, operation_count, operation_state, reply_target_conversation, result_success, target_run_id
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: File-level deletion still requires an assertion inventory; delete only recorded old-test blocks whose specific assertion is covered by real_production_path evidence.
  - Replacement trace name: runtime_control_resume_after_companion_revival_requires_readmission
    - Real production entrypoint used: golden: Companion resume -> runtime-control readmission gate
    - Exported state artifact/assertion: golden: state/runtime-control/runtime_control_resume_after_companion_revival_requires_readmission.json; assertions blocked_reason, executor_call_count, operation_count, operation_state, reply_target_conversation, result_success, target_run_id
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: File-level deletion still requires an assertion inventory; delete only recorded old-test blocks whose specific assertion is covered by real_production_path evidence.
  - Replacement trace name: runtime_control_cancel_after_revival_blocks_stale_run
    - Real production entrypoint used: golden: Attention-visible revival -> runtime-control current admission gate
    - Exported state artifact/assertion: golden: state/runtime-control/runtime_control_cancel_after_revival_blocks_stale_run.json; assertions blocked_reason, executor_call_count, operation_count, operation_state, reply_target_conversation, result_success, target_run_id
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: File-level deletion still requires an assertion inventory; delete only recorded old-test blocks whose specific assertion is covered by real_production_path evidence.
  - Replacement trace name: runtime_control_finalize_records_proposal_without_external_action
    - Real production entrypoint used: golden: Gateway finalize request -> runtime_operations proposal store
    - Exported state artifact/assertion: golden: state/runtime-control/runtime_control_finalize_records_proposal_without_external_action.json; assertions blocked_reason, executor_call_count, operation_count, operation_state, reply_target_conversation, result_success, target_run_id
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: File-level deletion still requires an assertion inventory; delete only recorded old-test blocks whose specific assertion is covered by real_production_path evidence.
- Simultaneous pass evidence: 2026-05-13: `npm run test:golden-traces` passed 42 tests (40 fixtures), `npm run test:replay` passed 9 tests (7 fixtures), and `npx vitest run src/runtime/control/__tests__/runtime-control-service.test.ts --config vitest.integration.config.ts` passed 1 file / 41 tests.
- Delete condition: delete a whole file only when the old test file deletion gate above says yes; delete an individual block only when it is recorded under Deleted old-test blocks with real replacement evidence.

### src/runtime/__tests__/schedule-engine.test.ts

- Production boundary: ScheduleEngine.tick() -> schedule store/history -> attention projection
- State artifact: schedule entries/history, attention projections, notification outbox
- Old test file deletion allowed: no
- No reason: File-level deletion still requires an assertion inventory; delete only recorded old-test blocks whose specific assertion is covered by real_production_path evidence.
- Replacement evidence:
  - Replacement trace name: schedule_wait_resume_before_due_no_attention_or_notification
    - Real production entrypoint used: golden: ScheduleEngine.tick() -> schedule store/history -> attention projection
    - Exported state artifact/assertion: golden: state/schedule/schedule_wait_resume_before_due_no_attention_or_notification.json; assertions due_result_count, next_fire_in_future, notification_count
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: File-level deletion still requires an assertion inventory; delete only recorded old-test blocks whose specific assertion is covered by real_production_path evidence.
  - Replacement trace name: schedule_wait_resume_due_creates_held_attention_artifact
    - Real production entrypoint used: golden: ScheduleEngine.tick() -> wait-resume attention projection
    - Exported state artifact/assertion: golden: state/schedule/schedule_wait_resume_due_creates_held_attention_artifact.json; assertions agenda_item_count, cycle_result_count, first_result_status, history_count, notification_count, second_result_count
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: File-level deletion still requires an assertion inventory; delete only recorded old-test blocks whose specific assertion is covered by real_production_path evidence.
  - Replacement trace name: schedule_wait_resume_retry_same_due_idempotent
    - Real production entrypoint used: golden: ScheduleEngine.tick() replay -> due idempotency guard
    - Exported state artifact/assertion: golden: state/schedule/schedule_wait_resume_retry_same_due_idempotent.json; assertions agenda_item_count, cycle_result_count, first_result_status, history_count, notification_count, second_result_count
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: File-level deletion still requires an assertion inventory; delete only recorded old-test blocks whose specific assertion is covered by real_production_path evidence.
  - Replacement trace name: schedule_side_effect_crash_replay_no_duplicate_execution
    - Real production entrypoint used: golden: ScheduleEngine.tick() crash replay -> side effect ledger; replay: ScheduleEngine.tick() crash replay -> side effect ledger
    - Exported state artifact/assertion: golden: state/schedule/schedule_side_effect_crash_replay_no_duplicate_execution.json; assertions agenda_item_count, cycle_result_count, first_result_status, history_count, notification_count, second_result_count; replay: state/schedule/schedule_side_effect_crash_replay_no_duplicate_execution.json; assertions fresh_restarted_equal, startup_replay_path
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13; `npm run test:replay` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: File-level deletion still requires an assertion inventory; delete only recorded old-test blocks whose specific assertion is covered by real_production_path evidence.
- Simultaneous pass evidence: 2026-05-13: `npm run test:golden-traces` passed 42 tests (40 fixtures), `npm run test:replay` passed 9 tests (7 fixtures), and `npx vitest run src/runtime/__tests__/approval-broker.test.ts src/runtime/__tests__/schedule-engine.test.ts --config vitest.integration.config.ts` passed 2 files / 142 tests.
- Delete condition: delete a whole file only when the old test file deletion gate above says yes; delete an individual block only when it is recorded under Deleted old-test blocks with real replacement evidence.

### src/runtime/__tests__/approval-broker.test.ts

- Production boundary: Approval response -> ApprovalBroker -> approval store/tool gate
- State artifact: approval_records, tool approval artifact
- Old test file deletion allowed: no
- No reason: File-level deletion still requires an assertion inventory; delete only recorded old-test blocks whose specific assertion is covered by real_production_path evidence.
- Replacement evidence:
  - Replacement trace name: gateway_approval_denial_never_executes_write
    - Real production entrypoint used: golden: Gateway approval reply -> tool approval gate -> mutation executor
    - Exported state artifact/assertion: golden: state/approval/gateway_approval_denial_never_executes_write.json; assertions mutation_executed, pending_after_resolution, request_result, resolved, resolved_state, stale_reply_rejected
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: File-level deletion still requires an assertion inventory; delete only recorded old-test blocks whose specific assertion is covered by real_production_path evidence.
  - Replacement trace name: gateway_approval_target_args_mismatch_blocked
    - Real production entrypoint used: golden: Gateway approval reply -> exact tool/args scope gate
    - Exported state artifact/assertion: golden: state/approval/gateway_approval_target_args_mismatch_blocked.json; assertions mutation_executed, pending_after_resolution, request_result, resolved, resolved_state, stale_reply_rejected
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: File-level deletion still requires an assertion inventory; delete only recorded old-test blocks whose specific assertion is covered by real_production_path evidence.
  - Replacement trace name: gateway_approval_other_tool_after_approval_blocked
    - Real production entrypoint used: golden: Gateway approval reply -> tool identity scope gate
    - Exported state artifact/assertion: golden: state/approval/gateway_approval_other_tool_after_approval_blocked.json; assertions mutation_executed, pending_after_resolution, request_result, resolved, resolved_state, stale_reply_rejected
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: File-level deletion still requires an assertion inventory; delete only recorded old-test blocks whose specific assertion is covered by real_production_path evidence.
  - Replacement trace name: gateway_multi_approval_reentrant_same_turn
    - Real production entrypoint used: golden: Gateway turn approval manager -> approval_records
    - Exported state artifact/assertion: golden: state/approval/gateway_multi_approval_reentrant_same_turn.json; assertions assistant_delta_before_final, final_count, no_progress_after_final, visible_event_count
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: File-level deletion still requires an assertion inventory; delete only recorded old-test blocks whose specific assertion is covered by real_production_path evidence.
  - Replacement trace name: approval_pending_restored_after_daemon_restart
    - Real production entrypoint used: golden: daemon restart -> ApprovalBroker -> approval store; replay: daemon restart -> ApprovalBroker -> approval store
    - Exported state artifact/assertion: golden: state/approval/approval_pending_restored_after_daemon_restart.json; assertions pending_restored_event_count, request_result, resolved, resolved_state; replay: state/approval/approval_pending_restored_after_daemon_restart.json; assertions fresh_restarted_equal, startup_replay_path
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13; `npm run test:replay` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: File-level deletion still requires an assertion inventory; delete only recorded old-test blocks whose specific assertion is covered by real_production_path evidence.
- Simultaneous pass evidence: 2026-05-13: `npm run test:golden-traces` passed 42 tests (40 fixtures), `npm run test:replay` passed 9 tests (7 fixtures), and `npx vitest run src/runtime/__tests__/approval-broker.test.ts src/runtime/__tests__/schedule-engine.test.ts --config vitest.integration.config.ts` passed 2 files / 142 tests.
- Delete condition: delete a whole file only when the old test file deletion gate above says yes; delete an individual block only when it is recorded under Deleted old-test blocks with real replacement evidence.

### src/runtime/queue/__tests__/journal-backed-queue.test.ts

- Production boundary: EventServer HTTP -> durable queue/journal -> dispatcher claim
- State artifact: queue journal, command envelope, claim state
- Old test file deletion allowed: no
- No reason: File-level deletion still requires an assertion inventory; delete only recorded old-test blocks whose specific assertion is covered by real_production_path evidence.
- Replacement evidence:
  - Replacement trace name: eventserver_command_accept_durable_before_200
    - Real production entrypoint used: golden: EventServer HTTP -> durable queue/journal -> 200 response
    - Exported state artifact/assertion: golden: state/queue/eventserver_command_accept_durable_before_200.json; assertions accepted_before_response, claimed_message_id, command_envelope_count, envelope_name, http_status, queue_pending_after_claim, response_ok
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: File-level deletion still requires an assertion inventory; delete only recorded old-test blocks whose specific assertion is covered by real_production_path evidence.
  - Replacement trace name: eventserver_approval_unknown_request_rejected_before_accept
    - Real production entrypoint used: golden: EventServer approval response -> approval request resolver -> queue reject
    - Exported state artifact/assertion: golden: state/queue/eventserver_approval_unknown_request_rejected_before_accept.json; assertions command_envelope_count, http_status, queue_pending_size, rejected_before_enqueue, response_ok
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: File-level deletion still requires an assertion inventory; delete only recorded old-test blocks whose specific assertion is covered by real_production_path evidence.
  - Replacement trace name: queue_expired_claim_rejects_late_ack_and_reclaims
    - Real production entrypoint used: golden: JournalBackedQueue claim -> sweeper -> late ack reject; replay: JournalBackedQueue claim -> sweeper -> late ack reject
    - Exported state artifact/assertion: golden: state/queue/queue_expired_claim_rejects_late_ack_and_reclaims.json; assertions accepted, initial_claim, late_ack_accepted, late_nack_accepted, persisted_before_sweep_status, post_sweep_snapshot, renew_after_expiry_returned_claim, sweep_result; replay: state/queue/queue_expired_claim_rejects_late_ack_and_reclaims.json; assertions fresh_restarted_equal, startup_replay_path
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13; `npm run test:replay` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: File-level deletion still requires an assertion inventory; delete only recorded old-test blocks whose specific assertion is covered by real_production_path evidence.
  - Replacement trace name: queue_dedupe_inflight_rejects_replacement
    - Real production entrypoint used: golden: JournalBackedQueue enqueue -> inflight dedupe guard
    - Exported state artifact/assertion: golden: state/queue/queue_dedupe_inflight_rejects_replacement.json; assertions claimed_message_id, inflight_size, original_accept, pending_size, retry_accept, retry_record_present, snapshot
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: File-level deletion still requires an assertion inventory; delete only recorded old-test blocks whose specific assertion is covered by real_production_path evidence.
- Simultaneous pass evidence: 2026-05-13: `npm run test:golden-traces` passed 42 tests (40 fixtures), `npm run test:replay` passed 9 tests (7 fixtures), and `npx vitest run src/runtime/queue/__tests__/journal-backed-queue.test.ts --config vitest.smoke.config.ts` passed 1 file / 15 tests.
- Delete condition: delete a whole file only when the old test file deletion gate above says yes; delete an individual block only when it is recorded under Deleted old-test blocks with real replacement evidence.

### src/runtime/store/__tests__/attention-state-store.test.ts

- Production boundary: runtime startup/replay -> attention state store -> control DB
- State artifact: attention state tables, migration audit
- Old test file deletion allowed: no
- No reason: File-level deletion still requires an assertion inventory; delete only recorded old-test blocks whose specific assertion is covered by real_production_path evidence.
- Replacement evidence:
  - Replacement trace name: state_attention_schema_ahead_fail_closed
    - Real production entrypoint used: golden: runtime startup/replay -> attention state store -> control DB; replay: runtime startup/replay -> attention state store -> control DB
    - Exported state artifact/assertion: golden: state/state/state_attention_schema_ahead_fail_closed.json; assertions fail_closed, message_contains_newer_schema; replay: state/state/state_attention_schema_ahead_fail_closed.json; assertions fresh_restarted_equal, startup_replay_path
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13; `npm run test:replay` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: File-level deletion still requires an assertion inventory; delete only recorded old-test blocks whose specific assertion is covered by real_production_path evidence.
  - Replacement trace name: attention_observation_requires_visible_indicator_before_event
    - Real production entrypoint used: golden: observation event -> visible indicator gate -> attention state; replay: observation event -> visible indicator gate -> attention state
    - Exported state artifact/assertion: golden: state/attention/attention_observation_requires_visible_indicator_before_event.json; assertions capability_authority_granted, cycle_result_count, pending_block_count; replay: state/attention/attention_observation_requires_visible_indicator_before_event.json; assertions fresh_restarted_equal, startup_replay_path
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13; `npm run test:replay` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: File-level deletion still requires an assertion inventory; delete only recorded old-test blocks whose specific assertion is covered by real_production_path evidence.
  - Replacement trace name: attention_observation_after_expiry_terminal_allowed_only
    - Real production entrypoint used: golden: observation expiry -> terminal-only attention conversion
    - Exported state artifact/assertion: golden: state/attention/attention_observation_after_expiry_terminal_allowed_only.json; assertions capability_authority_granted, cycle_result_count, pending_block_count
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: File-level deletion still requires an assertion inventory; delete only recorded old-test blocks whose specific assertion is covered by real_production_path evidence.
- Simultaneous pass evidence: 2026-05-13: `npm run test:golden-traces` passed 42 tests (40 fixtures), `npm run test:replay` passed 9 tests (7 fixtures), and `npx vitest run src/runtime/store/__tests__/attention-state-store.test.ts --config vitest.unit.config.ts` passed 1 file / 14 tests.
- Delete condition: delete a whole file only when the old test file deletion gate above says yes; delete an individual block only when it is recorded under Deleted old-test blocks with real replacement evidence.

### src/runtime/__tests__/daemon-runner.test.ts

- Production boundary: daemon startup/snapshot -> runtime root/session registry -> visible progress surface
- State artifact: daemon snapshot, session registry snapshot, progress/final events
- Old test file deletion allowed: no
- No reason: File-level deletion still requires an assertion inventory; delete only recorded old-test blocks whose specific assertion is covered by real_production_path evidence.
- Replacement evidence:
  - Replacement trace name: state_runtime_root_custom_shared_control_db
    - Real production entrypoint used: golden: daemon startup -> runtime root resolver -> shared control DB
    - Exported state artifact/assertion: golden: state/state/state_runtime_root_custom_shared_control_db.json; assertions configured_runtime_root, entry_id_present, shared_control_agenda_count, split_control_agenda_count
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: File-level deletion still requires an assertion inventory; delete only recorded old-test blocks whose specific assertion is covered by real_production_path evidence.
  - Replacement trace name: session_registry_dead_process_not_running
    - Real production entrypoint used: golden: session registry snapshot -> process liveness verifier; replay: session registry snapshot -> process liveness verifier
    - Exported state artifact/assertion: golden: state/daemon/session_registry_dead_process_not_running.json; assertions dead_process_warning, projected_status, running_reported; replay: state/daemon/session_registry_dead_process_not_running.json; assertions fresh_restarted_equal, startup_replay_path
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13; `npm run test:replay` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: File-level deletion still requires an assertion inventory; delete only recorded old-test blocks whose specific assertion is covered by real_production_path evidence.
  - Replacement trace name: daemon_progress_final_order_once
    - Real production entrypoint used: golden: daemon/gateway progress projector -> final visibility gate
    - Exported state artifact/assertion: golden: state/daemon/daemon_progress_final_order_once.json; assertions final_count, final_is_last_visible_assistant_output, progress_after_final_count
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: File-level deletion still requires an assertion inventory; delete only recorded old-test blocks whose specific assertion is covered by real_production_path evidence.
- Simultaneous pass evidence: 2026-05-13: `npm run test:golden-traces` passed 42 tests (40 fixtures), `npm run test:replay` passed 9 tests (7 fixtures), and `npx vitest run src/runtime/__tests__/daemon-runner.test.ts src/runtime/session-registry/__tests__/runtime-session-registry.test.ts --config vitest.integration.config.ts` passed 2 files / 69 tests.
- Delete condition: delete a whole file only when the old test file deletion gate above says yes; delete an individual block only when it is recorded under Deleted old-test blocks with real replacement evidence.

### src/runtime/session-registry/__tests__/runtime-session-registry.test.ts

- Production boundary: resident runtime discovery -> session registry snapshot
- State artifact: session registry snapshot, capability snapshot
- Old test file deletion allowed: no
- No reason: File-level deletion still requires an assertion inventory; delete only recorded old-test blocks whose specific assertion is covered by real_production_path evidence.
- Replacement evidence:
  - Replacement trace name: session_registry_dead_process_not_running
    - Real production entrypoint used: golden: session registry snapshot -> process liveness verifier; replay: session registry snapshot -> process liveness verifier
    - Exported state artifact/assertion: golden: state/daemon/session_registry_dead_process_not_running.json; assertions dead_process_warning, projected_status, running_reported; replay: state/daemon/session_registry_dead_process_not_running.json; assertions fresh_restarted_equal, startup_replay_path
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13; `npm run test:replay` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: File-level deletion still requires an assertion inventory; delete only recorded old-test blocks whose specific assertion is covered by real_production_path evidence.
  - Replacement trace name: resident_runtime_snapshot_capability_discovery_grants_no_authority
    - Real production entrypoint used: golden: resident runtime discovery -> capability snapshot -> authority gate
    - Exported state artifact/assertion: golden: state/resident/resident_runtime_snapshot_capability_discovery_grants_no_authority.json; assertions capability_authority_granted, cycle_result_count, pending_block_count
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: File-level deletion still requires an assertion inventory; delete only recorded old-test blocks whose specific assertion is covered by real_production_path evidence.
- Simultaneous pass evidence: 2026-05-13: `npm run test:golden-traces` passed 42 tests (40 fixtures), `npm run test:replay` passed 9 tests (7 fixtures), and `npx vitest run src/runtime/__tests__/daemon-runner.test.ts src/runtime/session-registry/__tests__/runtime-session-registry.test.ts --config vitest.integration.config.ts` passed 2 files / 69 tests.
- Delete condition: delete a whole file only when the old test file deletion gate above says yes; delete an individual block only when it is recorded under Deleted old-test blocks with real replacement evidence.

### src/tools/fs/ReadTool/__tests__/ReadTool.test.ts

- Production boundary: tool catalog -> readonly filesystem tool execution
- State artifact: tool result envelope
- Old test file deletion allowed: no
- No reason: File-level deletion still requires an assertion inventory; delete only recorded old-test blocks whose specific assertion is covered by real_production_path evidence.
- Replacement evidence:
  - Replacement trace name: tool_readonly_fs_no_write_approval_under_workspace
    - Real production entrypoint used: golden: tool catalog -> readonly filesystem tool execution
    - Exported state artifact/assertion: golden: state/tool/tool_readonly_fs_no_write_approval_under_workspace.json; assertions approval_request_count, read_success, result_has_read_artifact, write_probe_exists
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: File-level deletion still requires an assertion inventory; delete only recorded old-test blocks whose specific assertion is covered by real_production_path evidence.
- Simultaneous pass evidence: 2026-05-13: `npm run test:golden-traces` passed 42 tests (40 fixtures), `npm run test:replay` passed 9 tests (7 fixtures), and the mapped unit batch passed 5 files / 184 tests.
- Delete condition: delete a whole file only when the old test file deletion gate above says yes; delete an individual block only when it is recorded under Deleted old-test blocks with real replacement evidence.

### src/tools/fs/FileWriteTool/__tests__/FileWriteTool.test.ts

- Production boundary: tool approval gate -> local write mutation
- State artifact: approval artifact, mutation artifact
- Old test file deletion allowed: no
- No reason: File-level deletion still requires an assertion inventory; delete only recorded old-test blocks whose specific assertion is covered by real_production_path evidence.
- Replacement evidence:
  - Replacement trace name: tool_write_local_records_approval_artifact_before_mutation
    - Real production entrypoint used: golden: tool approval gate -> local write mutation
    - Exported state artifact/assertion: golden: state/tool/tool_write_local_records_approval_artifact_before_mutation.json; assertions approval_before_mutation, approved_write_success, denied_execution_status, denied_mutation_exists, mutation_artifact_count, wait_plan_count
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: File-level deletion still requires an assertion inventory; delete only recorded old-test blocks whose specific assertion is covered by real_production_path evidence.
- Simultaneous pass evidence: 2026-05-13: `npm run test:golden-traces` passed 42 tests (40 fixtures), `npm run test:replay` passed 9 tests (7 fixtures), and the mapped unit batch passed 5 files / 184 tests.
- Delete condition: delete a whole file only when the old test file deletion gate above says yes; delete an individual block only when it is recorded under Deleted old-test blocks with real replacement evidence.

