# PulSeed Test Redesign Replacement Map

Generated: 2026-05-12T21:41:26.885Z

Deletion gate: old tests may only be deleted after the mapped replacement trace has landed and the old test plus new trace passed in the same checkout.

## P0 Trace Coverage

- Mapped P0 traces: 40/40
- Unmapped P0 traces: 0

## Old Test Blocks

### src/interface/chat/__tests__/chat-runner.test.ts

- Production boundary: Gateway ingress -> ChatRunner -> ChatEvent stream
- State artifact: chat session transcript, visible surface events
- Old test file deletion allowed: no
- No reason: Mapped traces still include pending_real_runner or missing runner evidence: gateway_ordinary_chat_first_visible_no_progress, gateway_assistant_delta_before_model_terminal, gateway_runtime_status_uses_tool_evidence_not_guidance, gateway_final_visible_suppresses_late_progress_and_typing, tool_unavailable_returned_to_model_before_final.
- Replacement evidence:
  - Replacement trace name: gateway_ordinary_chat_first_visible_no_progress
    - Real production entrypoint used: golden: pending_real_runner at Gateway ingress -> ChatRunner -> ChatEvent stream
    - Exported state artifact/assertion: golden: state/gateway/gateway_ordinary_chat_first_visible_no_progress.json; pending_real_runner (No conformance runner is wired to Gateway ingress -> ChatRunner -> ChatEvent stream; this fixture is not deletion-gate evidence.)
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: Mapped traces still include pending_real_runner or missing runner evidence: gateway_ordinary_chat_first_visible_no_progress, gateway_assistant_delta_before_model_terminal, gateway_runtime_status_uses_tool_evidence_not_guidance, gateway_final_visible_suppresses_late_progress_and_typing, tool_unavailable_returned_to_model_before_final.
  - Replacement trace name: gateway_assistant_delta_before_model_terminal
    - Real production entrypoint used: golden: pending_real_runner at Gateway ingress -> ChatRunner -> ChatEvent stream
    - Exported state artifact/assertion: golden: state/gateway/gateway_assistant_delta_before_model_terminal.json; pending_real_runner (No conformance runner is wired to Gateway ingress -> ChatRunner -> ChatEvent stream; this fixture is not deletion-gate evidence.)
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: Mapped traces still include pending_real_runner or missing runner evidence: gateway_ordinary_chat_first_visible_no_progress, gateway_assistant_delta_before_model_terminal, gateway_runtime_status_uses_tool_evidence_not_guidance, gateway_final_visible_suppresses_late_progress_and_typing, tool_unavailable_returned_to_model_before_final.
  - Replacement trace name: gateway_runtime_status_uses_tool_evidence_not_guidance
    - Real production entrypoint used: golden: pending_real_runner at Gateway ingress -> runtime status tool evidence -> ChatEvent stream
    - Exported state artifact/assertion: golden: state/gateway/gateway_runtime_status_uses_tool_evidence_not_guidance.json; pending_real_runner (No conformance runner is wired to Gateway ingress -> runtime status tool evidence -> ChatEvent stream; this fixture is not deletion-gate evidence.)
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: Mapped traces still include pending_real_runner or missing runner evidence: gateway_ordinary_chat_first_visible_no_progress, gateway_assistant_delta_before_model_terminal, gateway_runtime_status_uses_tool_evidence_not_guidance, gateway_final_visible_suppresses_late_progress_and_typing, tool_unavailable_returned_to_model_before_final.
  - Replacement trace name: gateway_final_visible_suppresses_late_progress_and_typing
    - Real production entrypoint used: golden: pending_real_runner at Gateway ingress -> ChatRunner -> visible surface projector
    - Exported state artifact/assertion: golden: state/gateway/gateway_final_visible_suppresses_late_progress_and_typing.json; pending_real_runner (No conformance runner is wired to Gateway ingress -> ChatRunner -> visible surface projector; this fixture is not deletion-gate evidence.)
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: Mapped traces still include pending_real_runner or missing runner evidence: gateway_ordinary_chat_first_visible_no_progress, gateway_assistant_delta_before_model_terminal, gateway_runtime_status_uses_tool_evidence_not_guidance, gateway_final_visible_suppresses_late_progress_and_typing, tool_unavailable_returned_to_model_before_final.
  - Replacement trace name: tool_unavailable_returned_to_model_before_final
    - Real production entrypoint used: golden: pending_real_runner at ChatRunner tool executor -> structured tool error -> model continuation
    - Exported state artifact/assertion: golden: state/tool/tool_unavailable_returned_to_model_before_final.json; pending_real_runner (No conformance runner is wired to ChatRunner tool executor -> structured tool error -> model continuation; this fixture is not deletion-gate evidence.)
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: Mapped traces still include pending_real_runner or missing runner evidence: gateway_ordinary_chat_first_visible_no_progress, gateway_assistant_delta_before_model_terminal, gateway_runtime_status_uses_tool_evidence_not_guidance, gateway_final_visible_suppresses_late_progress_and_typing, tool_unavailable_returned_to_model_before_final.
- Simultaneous pass evidence: 2026-05-13: `npm run test:golden-traces` passed 40 traces, `npm run test:replay` passed 7 replay fixtures, and `npx vitest run src/interface/chat/__tests__/chat-runner.test.ts src/interface/chat/__tests__/chat-runner-tools.test.ts src/interface/chat/__tests__/setup-secret-intake.test.ts src/tools/fs/ReadTool/__tests__/ReadTool.test.ts src/tools/fs/FileWriteTool/__tests__/FileWriteTool.test.ts --config vitest.unit.config.ts` passed 5 files / 185 tests.
- Delete condition: delete only when the old test file deletion gate above says yes.

### src/interface/chat/__tests__/chat-runner-tools.test.ts

- Production boundary: Gateway ingress -> ChatRunner -> readonly workspace tool boundary
- State artifact: tool request/result envelope, chat event stream
- Old test file deletion allowed: no
- No reason: Mapped traces still include pending_real_runner or missing runner evidence: gateway_read_workspace_under_protected_paths_no_approval.
- Replacement evidence:
  - Replacement trace name: gateway_read_workspace_under_protected_paths_no_approval
    - Real production entrypoint used: golden: pending_real_runner at Gateway ingress -> ChatRunner -> readonly workspace tool boundary
    - Exported state artifact/assertion: golden: state/gateway/gateway_read_workspace_under_protected_paths_no_approval.json; pending_real_runner (No conformance runner is wired to Gateway ingress -> ChatRunner -> readonly workspace tool boundary; this fixture is not deletion-gate evidence.)
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: Mapped traces still include pending_real_runner or missing runner evidence: gateway_read_workspace_under_protected_paths_no_approval.
- Simultaneous pass evidence: 2026-05-13: `npm run test:golden-traces` passed 40 traces, `npm run test:replay` passed 7 replay fixtures, and the mapped unit batch passed 5 files / 185 tests.
- Delete condition: delete only when the old test file deletion gate above says yes.

### src/interface/chat/__tests__/setup-secret-intake.test.ts

- Production boundary: Gateway secret setup intake -> typed secret writer -> redacted chat state
- State artifact: secret setup state, redacted transcript/event artifact
- Old test file deletion allowed: no
- No reason: Mapped traces still include pending_real_runner or missing runner evidence: gateway_secret_setup_redacts_token_and_confirms_write.
- Replacement evidence:
  - Replacement trace name: gateway_secret_setup_redacts_token_and_confirms_write
    - Real production entrypoint used: golden: pending_real_runner at Gateway secret setup intake -> typed secret writer -> redacted chat state
    - Exported state artifact/assertion: golden: state/gateway/gateway_secret_setup_redacts_token_and_confirms_write.json; pending_real_runner (No conformance runner is wired to Gateway secret setup intake -> typed secret writer -> redacted chat state; this fixture is not deletion-gate evidence.)
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: Mapped traces still include pending_real_runner or missing runner evidence: gateway_secret_setup_redacts_token_and_confirms_write.
- Simultaneous pass evidence: 2026-05-13: `npm run test:golden-traces` passed 40 traces, `npm run test:replay` passed 7 replay fixtures, and the mapped unit batch passed 5 files / 185 tests.
- Delete condition: delete only when the old test file deletion gate above says yes.

### src/interface/chat/__tests__/cross-platform-session.test.ts

- Production boundary: Gateway adapter -> CrossPlatformChatSessionManager.processIncomingMessage
- State artifact: reply target state, run spec draft state, approval origin state
- Old test file deletion allowed: no
- No reason: Mapped traces still include pending_real_runner or missing runner evidence: gateway_routed_ingress_preserves_reply_target_after_restart, gateway_runspec_draft_pending_no_same_turn_start, gateway_runspec_epoch_changed_rejects_start, approval_origin_bound_stale_reply_rejected, approval_delivery_unavailable_denies_not_executes.
- Replacement evidence:
  - Replacement trace name: gateway_routed_ingress_preserves_reply_target_after_restart
    - Real production entrypoint used: golden: pending_real_runner at Gateway adapter -> CrossPlatformChatSessionManager.processIncomingMessage; replay: pending_real_runner at Gateway adapter -> CrossPlatformChatSessionManager.processIncomingMessage
    - Exported state artifact/assertion: golden: state/gateway/gateway_routed_ingress_preserves_reply_target_after_restart.json; pending_real_runner (No conformance runner is wired to Gateway adapter -> CrossPlatformChatSessionManager.processIncomingMessage; this fixture is not deletion-gate evidence.); replay: state/chat-session/gateway_routed_ingress_preserves_reply_target_after_restart.json; pending_real_runner (No startup/replay/migration runner is wired to Gateway adapter -> CrossPlatformChatSessionManager.processIncomingMessage; this fixture is not deletion-gate evidence.)
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13; `npm run test:replay` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: Mapped traces still include pending_real_runner or missing runner evidence: gateway_routed_ingress_preserves_reply_target_after_restart, gateway_runspec_draft_pending_no_same_turn_start, gateway_runspec_epoch_changed_rejects_start, approval_origin_bound_stale_reply_rejected, approval_delivery_unavailable_denies_not_executes.
  - Replacement trace name: gateway_runspec_draft_pending_no_same_turn_start
    - Real production entrypoint used: golden: pending_real_runner at Gateway ingress -> RunSpec draft state -> durable run gate
    - Exported state artifact/assertion: golden: state/gateway/gateway_runspec_draft_pending_no_same_turn_start.json; pending_real_runner (No conformance runner is wired to Gateway ingress -> RunSpec draft state -> durable run gate; this fixture is not deletion-gate evidence.)
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: Mapped traces still include pending_real_runner or missing runner evidence: gateway_routed_ingress_preserves_reply_target_after_restart, gateway_runspec_draft_pending_no_same_turn_start, gateway_runspec_epoch_changed_rejects_start, approval_origin_bound_stale_reply_rejected, approval_delivery_unavailable_denies_not_executes.
  - Replacement trace name: gateway_runspec_epoch_changed_rejects_start
    - Real production entrypoint used: golden: pending_real_runner at Gateway ingress -> RunSpec confirmation epoch gate
    - Exported state artifact/assertion: golden: state/gateway/gateway_runspec_epoch_changed_rejects_start.json; pending_real_runner (No conformance runner is wired to Gateway ingress -> RunSpec confirmation epoch gate; this fixture is not deletion-gate evidence.)
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: Mapped traces still include pending_real_runner or missing runner evidence: gateway_routed_ingress_preserves_reply_target_after_restart, gateway_runspec_draft_pending_no_same_turn_start, gateway_runspec_epoch_changed_rejects_start, approval_origin_bound_stale_reply_rejected, approval_delivery_unavailable_denies_not_executes.
  - Replacement trace name: approval_origin_bound_stale_reply_rejected
    - Real production entrypoint used: golden: pending_real_runner at Approval response -> origin-bound approval broker
    - Exported state artifact/assertion: golden: state/approval/approval_origin_bound_stale_reply_rejected.json; pending_real_runner (No conformance runner is wired to Approval response -> origin-bound approval broker; this fixture is not deletion-gate evidence.)
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: Mapped traces still include pending_real_runner or missing runner evidence: gateway_routed_ingress_preserves_reply_target_after_restart, gateway_runspec_draft_pending_no_same_turn_start, gateway_runspec_epoch_changed_rejects_start, approval_origin_bound_stale_reply_rejected, approval_delivery_unavailable_denies_not_executes.
  - Replacement trace name: approval_delivery_unavailable_denies_not_executes
    - Real production entrypoint used: golden: pending_real_runner at Gateway approval delivery -> channel availability gate
    - Exported state artifact/assertion: golden: state/approval/approval_delivery_unavailable_denies_not_executes.json; pending_real_runner (No conformance runner is wired to Gateway approval delivery -> channel availability gate; this fixture is not deletion-gate evidence.)
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: Mapped traces still include pending_real_runner or missing runner evidence: gateway_routed_ingress_preserves_reply_target_after_restart, gateway_runspec_draft_pending_no_same_turn_start, gateway_runspec_epoch_changed_rejects_start, approval_origin_bound_stale_reply_rejected, approval_delivery_unavailable_denies_not_executes.
- Simultaneous pass evidence: 2026-05-13: `npm run test:golden-traces` passed 40 traces, `npm run test:replay` passed 7 replay fixtures, and `npx vitest run src/interface/chat/__tests__/cross-platform-session.test.ts --config vitest.unit.config.ts` passed 1 file / 89 tests.
- Delete condition: delete only when the old test file deletion gate above says yes.

### src/runtime/control/__tests__/runtime-control-service.test.ts

- Production boundary: Gateway/CLI runtime-control request -> RuntimeControlService -> runtime_operations
- State artifact: runtime_operations, background_runs, runtime events
- Old test file deletion allowed: no
- No reason: Mapped traces still include pending_real_runner or missing runner evidence: runtime_control_pause_current_run_conversation_scoped, runtime_control_latest_other_conversation_blocked, runtime_control_terminal_run_stale_blocked, runtime_control_resume_after_companion_revival_requires_readmission, runtime_control_cancel_after_revival_blocks_stale_run, runtime_control_finalize_records_proposal_without_external_action.
- Replacement evidence:
  - Replacement trace name: runtime_control_pause_current_run_conversation_scoped
    - Real production entrypoint used: golden: pending_real_runner at Gateway runtime-control request -> RuntimeControlService -> runtime_operations
    - Exported state artifact/assertion: golden: state/runtime-control/runtime_control_pause_current_run_conversation_scoped.json; pending_real_runner (No conformance runner is wired to Gateway runtime-control request -> RuntimeControlService -> runtime_operations; this fixture is not deletion-gate evidence.)
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: Mapped traces still include pending_real_runner or missing runner evidence: runtime_control_pause_current_run_conversation_scoped, runtime_control_latest_other_conversation_blocked, runtime_control_terminal_run_stale_blocked, runtime_control_resume_after_companion_revival_requires_readmission, runtime_control_cancel_after_revival_blocks_stale_run, runtime_control_finalize_records_proposal_without_external_action.
  - Replacement trace name: runtime_control_latest_other_conversation_blocked
    - Real production entrypoint used: golden: pending_real_runner at Gateway runtime-control request -> conversation-scoped run resolver
    - Exported state artifact/assertion: golden: state/runtime-control/runtime_control_latest_other_conversation_blocked.json; pending_real_runner (No conformance runner is wired to Gateway runtime-control request -> conversation-scoped run resolver; this fixture is not deletion-gate evidence.)
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: Mapped traces still include pending_real_runner or missing runner evidence: runtime_control_pause_current_run_conversation_scoped, runtime_control_latest_other_conversation_blocked, runtime_control_terminal_run_stale_blocked, runtime_control_resume_after_companion_revival_requires_readmission, runtime_control_cancel_after_revival_blocks_stale_run, runtime_control_finalize_records_proposal_without_external_action.
  - Replacement trace name: runtime_control_terminal_run_stale_blocked
    - Real production entrypoint used: golden: pending_real_runner at Gateway runtime-control request -> terminal run guard
    - Exported state artifact/assertion: golden: state/runtime-control/runtime_control_terminal_run_stale_blocked.json; pending_real_runner (No conformance runner is wired to Gateway runtime-control request -> terminal run guard; this fixture is not deletion-gate evidence.)
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: Mapped traces still include pending_real_runner or missing runner evidence: runtime_control_pause_current_run_conversation_scoped, runtime_control_latest_other_conversation_blocked, runtime_control_terminal_run_stale_blocked, runtime_control_resume_after_companion_revival_requires_readmission, runtime_control_cancel_after_revival_blocks_stale_run, runtime_control_finalize_records_proposal_without_external_action.
  - Replacement trace name: runtime_control_resume_after_companion_revival_requires_readmission
    - Real production entrypoint used: golden: pending_real_runner at Companion resume -> runtime-control readmission gate
    - Exported state artifact/assertion: golden: state/runtime-control/runtime_control_resume_after_companion_revival_requires_readmission.json; pending_real_runner (No conformance runner is wired to Companion resume -> runtime-control readmission gate; this fixture is not deletion-gate evidence.)
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: Mapped traces still include pending_real_runner or missing runner evidence: runtime_control_pause_current_run_conversation_scoped, runtime_control_latest_other_conversation_blocked, runtime_control_terminal_run_stale_blocked, runtime_control_resume_after_companion_revival_requires_readmission, runtime_control_cancel_after_revival_blocks_stale_run, runtime_control_finalize_records_proposal_without_external_action.
  - Replacement trace name: runtime_control_cancel_after_revival_blocks_stale_run
    - Real production entrypoint used: golden: pending_real_runner at Attention-visible revival -> runtime-control current admission gate
    - Exported state artifact/assertion: golden: state/runtime-control/runtime_control_cancel_after_revival_blocks_stale_run.json; pending_real_runner (No conformance runner is wired to Attention-visible revival -> runtime-control current admission gate; this fixture is not deletion-gate evidence.)
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: Mapped traces still include pending_real_runner or missing runner evidence: runtime_control_pause_current_run_conversation_scoped, runtime_control_latest_other_conversation_blocked, runtime_control_terminal_run_stale_blocked, runtime_control_resume_after_companion_revival_requires_readmission, runtime_control_cancel_after_revival_blocks_stale_run, runtime_control_finalize_records_proposal_without_external_action.
  - Replacement trace name: runtime_control_finalize_records_proposal_without_external_action
    - Real production entrypoint used: golden: pending_real_runner at Gateway finalize request -> runtime_operations proposal store
    - Exported state artifact/assertion: golden: state/runtime-control/runtime_control_finalize_records_proposal_without_external_action.json; pending_real_runner (No conformance runner is wired to Gateway finalize request -> runtime_operations proposal store; this fixture is not deletion-gate evidence.)
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: Mapped traces still include pending_real_runner or missing runner evidence: runtime_control_pause_current_run_conversation_scoped, runtime_control_latest_other_conversation_blocked, runtime_control_terminal_run_stale_blocked, runtime_control_resume_after_companion_revival_requires_readmission, runtime_control_cancel_after_revival_blocks_stale_run, runtime_control_finalize_records_proposal_without_external_action.
- Simultaneous pass evidence: 2026-05-13: `npm run test:golden-traces` passed 40 traces, `npm run test:replay` passed 7 replay fixtures, and the mapped runtime integration batch passed 6 files / 260 tests.
- Delete condition: delete only when the old test file deletion gate above says yes.

### src/runtime/__tests__/schedule-engine.test.ts

- Production boundary: ScheduleEngine.tick() -> schedule store/history -> attention projection
- State artifact: schedule entries/history, attention projections, notification outbox
- Old test file deletion allowed: no
- No reason: Mapped traces still include pending_real_runner or missing runner evidence: schedule_wait_resume_before_due_no_attention_or_notification, schedule_wait_resume_due_creates_held_attention_artifact, schedule_wait_resume_retry_same_due_idempotent, schedule_side_effect_crash_replay_no_duplicate_execution.
- Replacement evidence:
  - Replacement trace name: schedule_wait_resume_before_due_no_attention_or_notification
    - Real production entrypoint used: golden: pending_real_runner at ScheduleEngine.tick() -> schedule store/history -> attention projection
    - Exported state artifact/assertion: golden: state/schedule/schedule_wait_resume_before_due_no_attention_or_notification.json; pending_real_runner (No conformance runner is wired to ScheduleEngine.tick() -> schedule store/history -> attention projection; this fixture is not deletion-gate evidence.)
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: Mapped traces still include pending_real_runner or missing runner evidence: schedule_wait_resume_before_due_no_attention_or_notification, schedule_wait_resume_due_creates_held_attention_artifact, schedule_wait_resume_retry_same_due_idempotent, schedule_side_effect_crash_replay_no_duplicate_execution.
  - Replacement trace name: schedule_wait_resume_due_creates_held_attention_artifact
    - Real production entrypoint used: golden: pending_real_runner at ScheduleEngine.tick() -> wait-resume attention projection
    - Exported state artifact/assertion: golden: state/schedule/schedule_wait_resume_due_creates_held_attention_artifact.json; pending_real_runner (No conformance runner is wired to ScheduleEngine.tick() -> wait-resume attention projection; this fixture is not deletion-gate evidence.)
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: Mapped traces still include pending_real_runner or missing runner evidence: schedule_wait_resume_before_due_no_attention_or_notification, schedule_wait_resume_due_creates_held_attention_artifact, schedule_wait_resume_retry_same_due_idempotent, schedule_side_effect_crash_replay_no_duplicate_execution.
  - Replacement trace name: schedule_wait_resume_retry_same_due_idempotent
    - Real production entrypoint used: golden: pending_real_runner at ScheduleEngine.tick() replay -> due idempotency guard
    - Exported state artifact/assertion: golden: state/schedule/schedule_wait_resume_retry_same_due_idempotent.json; pending_real_runner (No conformance runner is wired to ScheduleEngine.tick() replay -> due idempotency guard; this fixture is not deletion-gate evidence.)
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: Mapped traces still include pending_real_runner or missing runner evidence: schedule_wait_resume_before_due_no_attention_or_notification, schedule_wait_resume_due_creates_held_attention_artifact, schedule_wait_resume_retry_same_due_idempotent, schedule_side_effect_crash_replay_no_duplicate_execution.
  - Replacement trace name: schedule_side_effect_crash_replay_no_duplicate_execution
    - Real production entrypoint used: golden: pending_real_runner at ScheduleEngine.tick() crash replay -> side effect ledger; replay: pending_real_runner at ScheduleEngine.tick() crash replay -> side effect ledger
    - Exported state artifact/assertion: golden: state/schedule/schedule_side_effect_crash_replay_no_duplicate_execution.json; pending_real_runner (No conformance runner is wired to ScheduleEngine.tick() crash replay -> side effect ledger; this fixture is not deletion-gate evidence.); replay: state/schedule/schedule_side_effect_crash_replay_no_duplicate_execution.json; pending_real_runner (No startup/replay/migration runner is wired to ScheduleEngine.tick() crash replay -> side effect ledger; this fixture is not deletion-gate evidence.)
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13; `npm run test:replay` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: Mapped traces still include pending_real_runner or missing runner evidence: schedule_wait_resume_before_due_no_attention_or_notification, schedule_wait_resume_due_creates_held_attention_artifact, schedule_wait_resume_retry_same_due_idempotent, schedule_side_effect_crash_replay_no_duplicate_execution.
- Simultaneous pass evidence: 2026-05-13: `npm run test:golden-traces` passed 40 traces, `npm run test:replay` passed 7 replay fixtures, and the mapped runtime integration batch passed 6 files / 260 tests.
- Delete condition: delete only when the old test file deletion gate above says yes.

### src/runtime/__tests__/approval-broker.test.ts

- Production boundary: Approval response -> ApprovalBroker -> approval store/tool gate
- State artifact: approval_records, tool approval artifact
- Old test file deletion allowed: no
- No reason: Mapped traces still include pending_real_runner or missing runner evidence: gateway_approval_denial_never_executes_write, gateway_approval_target_args_mismatch_blocked, gateway_approval_other_tool_after_approval_blocked, gateway_multi_approval_reentrant_same_turn, approval_pending_restored_after_daemon_restart.
- Replacement evidence:
  - Replacement trace name: gateway_approval_denial_never_executes_write
    - Real production entrypoint used: golden: pending_real_runner at Gateway approval reply -> tool approval gate -> mutation executor
    - Exported state artifact/assertion: golden: state/approval/gateway_approval_denial_never_executes_write.json; pending_real_runner (No conformance runner is wired to Gateway approval reply -> tool approval gate -> mutation executor; this fixture is not deletion-gate evidence.)
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: Mapped traces still include pending_real_runner or missing runner evidence: gateway_approval_denial_never_executes_write, gateway_approval_target_args_mismatch_blocked, gateway_approval_other_tool_after_approval_blocked, gateway_multi_approval_reentrant_same_turn, approval_pending_restored_after_daemon_restart.
  - Replacement trace name: gateway_approval_target_args_mismatch_blocked
    - Real production entrypoint used: golden: pending_real_runner at Gateway approval reply -> exact tool/args scope gate
    - Exported state artifact/assertion: golden: state/approval/gateway_approval_target_args_mismatch_blocked.json; pending_real_runner (No conformance runner is wired to Gateway approval reply -> exact tool/args scope gate; this fixture is not deletion-gate evidence.)
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: Mapped traces still include pending_real_runner or missing runner evidence: gateway_approval_denial_never_executes_write, gateway_approval_target_args_mismatch_blocked, gateway_approval_other_tool_after_approval_blocked, gateway_multi_approval_reentrant_same_turn, approval_pending_restored_after_daemon_restart.
  - Replacement trace name: gateway_approval_other_tool_after_approval_blocked
    - Real production entrypoint used: golden: pending_real_runner at Gateway approval reply -> tool identity scope gate
    - Exported state artifact/assertion: golden: state/approval/gateway_approval_other_tool_after_approval_blocked.json; pending_real_runner (No conformance runner is wired to Gateway approval reply -> tool identity scope gate; this fixture is not deletion-gate evidence.)
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: Mapped traces still include pending_real_runner or missing runner evidence: gateway_approval_denial_never_executes_write, gateway_approval_target_args_mismatch_blocked, gateway_approval_other_tool_after_approval_blocked, gateway_multi_approval_reentrant_same_turn, approval_pending_restored_after_daemon_restart.
  - Replacement trace name: gateway_multi_approval_reentrant_same_turn
    - Real production entrypoint used: golden: pending_real_runner at Gateway turn approval manager -> approval_records
    - Exported state artifact/assertion: golden: state/approval/gateway_multi_approval_reentrant_same_turn.json; pending_real_runner (No conformance runner is wired to Gateway turn approval manager -> approval_records; this fixture is not deletion-gate evidence.)
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: Mapped traces still include pending_real_runner or missing runner evidence: gateway_approval_denial_never_executes_write, gateway_approval_target_args_mismatch_blocked, gateway_approval_other_tool_after_approval_blocked, gateway_multi_approval_reentrant_same_turn, approval_pending_restored_after_daemon_restart.
  - Replacement trace name: approval_pending_restored_after_daemon_restart
    - Real production entrypoint used: golden: pending_real_runner at daemon restart -> ApprovalBroker -> approval store; replay: pending_real_runner at daemon restart -> ApprovalBroker -> approval store
    - Exported state artifact/assertion: golden: state/approval/approval_pending_restored_after_daemon_restart.json; pending_real_runner (No conformance runner is wired to daemon restart -> ApprovalBroker -> approval store; this fixture is not deletion-gate evidence.); replay: state/approval/approval_pending_restored_after_daemon_restart.json; pending_real_runner (No startup/replay/migration runner is wired to daemon restart -> ApprovalBroker -> approval store; this fixture is not deletion-gate evidence.)
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13; `npm run test:replay` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: Mapped traces still include pending_real_runner or missing runner evidence: gateway_approval_denial_never_executes_write, gateway_approval_target_args_mismatch_blocked, gateway_approval_other_tool_after_approval_blocked, gateway_multi_approval_reentrant_same_turn, approval_pending_restored_after_daemon_restart.
- Simultaneous pass evidence: 2026-05-13: `npm run test:golden-traces` passed 40 traces, `npm run test:replay` passed 7 replay fixtures, and the mapped runtime integration batch passed 6 files / 260 tests.
- Delete condition: delete only when the old test file deletion gate above says yes.

### src/runtime/queue/__tests__/journal-backed-queue.test.ts

- Production boundary: EventServer HTTP -> durable queue/journal -> dispatcher claim
- State artifact: queue journal, command envelope, claim state
- Old test file deletion allowed: no
- No reason: Mapped traces still include pending_real_runner or missing runner evidence: eventserver_command_accept_durable_before_200, eventserver_approval_unknown_request_rejected_before_accept.
- Replacement evidence:
  - Replacement trace name: eventserver_command_accept_durable_before_200
    - Real production entrypoint used: golden: pending_real_runner at EventServer HTTP -> durable queue/journal -> 200 response
    - Exported state artifact/assertion: golden: state/queue/eventserver_command_accept_durable_before_200.json; pending_real_runner (No conformance runner is wired to EventServer HTTP -> durable queue/journal -> 200 response; this fixture is not deletion-gate evidence.)
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: Mapped traces still include pending_real_runner or missing runner evidence: eventserver_command_accept_durable_before_200, eventserver_approval_unknown_request_rejected_before_accept.
  - Replacement trace name: eventserver_approval_unknown_request_rejected_before_accept
    - Real production entrypoint used: golden: pending_real_runner at EventServer approval response -> approval request resolver -> queue reject
    - Exported state artifact/assertion: golden: state/queue/eventserver_approval_unknown_request_rejected_before_accept.json; pending_real_runner (No conformance runner is wired to EventServer approval response -> approval request resolver -> queue reject; this fixture is not deletion-gate evidence.)
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: Mapped traces still include pending_real_runner or missing runner evidence: eventserver_command_accept_durable_before_200, eventserver_approval_unknown_request_rejected_before_accept.
  - Replacement trace name: queue_expired_claim_rejects_late_ack_and_reclaims
    - Real production entrypoint used: golden: JournalBackedQueue claim -> sweeper -> late ack reject; replay: JournalBackedQueue claim -> sweeper -> late ack reject
    - Exported state artifact/assertion: golden: state/queue/queue_expired_claim_rejects_late_ack_and_reclaims.json; assertions accepted, initial_claim, late_ack_accepted, late_nack_accepted, persisted_before_sweep_status, post_sweep_snapshot, renew_after_expiry_returned_claim, sweep_result; replay: state/queue/queue_expired_claim_rejects_late_ack_and_reclaims.json; assertions fresh_restarted_equal, startup_replay_path
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13; `npm run test:replay` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: Mapped traces still include pending_real_runner or missing runner evidence: eventserver_command_accept_durable_before_200, eventserver_approval_unknown_request_rejected_before_accept.
  - Replacement trace name: queue_dedupe_inflight_rejects_replacement
    - Real production entrypoint used: golden: JournalBackedQueue enqueue -> inflight dedupe guard
    - Exported state artifact/assertion: golden: state/queue/queue_dedupe_inflight_rejects_replacement.json; assertions claimed_message_id, inflight_size, original_accept, pending_size, retry_accept, retry_record_present, snapshot
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: Mapped traces still include pending_real_runner or missing runner evidence: eventserver_command_accept_durable_before_200, eventserver_approval_unknown_request_rejected_before_accept.
- Simultaneous pass evidence: 2026-05-13: `npm run test:golden-traces` passed 40 traces, `npm run test:replay` passed 7 replay fixtures, and the mapped runtime integration batch passed 6 files / 260 tests.
- Delete condition: delete only when the old test file deletion gate above says yes.

### src/runtime/store/__tests__/attention-state-store.test.ts

- Production boundary: runtime startup/replay -> attention state store -> control DB
- State artifact: attention state tables, migration audit
- Old test file deletion allowed: no
- No reason: Mapped traces still include pending_real_runner or missing runner evidence: state_attention_schema_ahead_fail_closed, attention_observation_requires_visible_indicator_before_event, attention_observation_after_expiry_terminal_allowed_only.
- Replacement evidence:
  - Replacement trace name: state_attention_schema_ahead_fail_closed
    - Real production entrypoint used: golden: pending_real_runner at runtime startup/replay -> attention state store -> control DB; replay: pending_real_runner at runtime startup/replay -> attention state store -> control DB
    - Exported state artifact/assertion: golden: state/state/state_attention_schema_ahead_fail_closed.json; pending_real_runner (No conformance runner is wired to runtime startup/replay -> attention state store -> control DB; this fixture is not deletion-gate evidence.); replay: state/state/state_attention_schema_ahead_fail_closed.json; pending_real_runner (No startup/replay/migration runner is wired to runtime startup/replay -> attention state store -> control DB; this fixture is not deletion-gate evidence.)
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13; `npm run test:replay` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: Mapped traces still include pending_real_runner or missing runner evidence: state_attention_schema_ahead_fail_closed, attention_observation_requires_visible_indicator_before_event, attention_observation_after_expiry_terminal_allowed_only.
  - Replacement trace name: attention_observation_requires_visible_indicator_before_event
    - Real production entrypoint used: golden: pending_real_runner at observation event -> visible indicator gate -> attention state; replay: pending_real_runner at observation event -> visible indicator gate -> attention state
    - Exported state artifact/assertion: golden: state/attention/attention_observation_requires_visible_indicator_before_event.json; pending_real_runner (No conformance runner is wired to observation event -> visible indicator gate -> attention state; this fixture is not deletion-gate evidence.); replay: state/attention/attention_observation_requires_visible_indicator_before_event.json; pending_real_runner (No startup/replay/migration runner is wired to observation event -> visible indicator gate -> attention state; this fixture is not deletion-gate evidence.)
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13; `npm run test:replay` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: Mapped traces still include pending_real_runner or missing runner evidence: state_attention_schema_ahead_fail_closed, attention_observation_requires_visible_indicator_before_event, attention_observation_after_expiry_terminal_allowed_only.
  - Replacement trace name: attention_observation_after_expiry_terminal_allowed_only
    - Real production entrypoint used: golden: pending_real_runner at observation expiry -> terminal-only attention conversion
    - Exported state artifact/assertion: golden: state/attention/attention_observation_after_expiry_terminal_allowed_only.json; pending_real_runner (No conformance runner is wired to observation expiry -> terminal-only attention conversion; this fixture is not deletion-gate evidence.)
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: Mapped traces still include pending_real_runner or missing runner evidence: state_attention_schema_ahead_fail_closed, attention_observation_requires_visible_indicator_before_event, attention_observation_after_expiry_terminal_allowed_only.
- Simultaneous pass evidence: 2026-05-13: `npm run test:golden-traces` passed 40 traces, `npm run test:replay` passed 7 replay fixtures, and the mapped runtime integration batch passed 6 files / 260 tests.
- Delete condition: delete only when the old test file deletion gate above says yes.

### src/runtime/__tests__/daemon-runner.test.ts

- Production boundary: daemon startup/snapshot -> runtime root/session registry -> visible progress surface
- State artifact: daemon snapshot, session registry snapshot, progress/final events
- Old test file deletion allowed: no
- No reason: Mapped traces still include pending_real_runner or missing runner evidence: state_runtime_root_custom_shared_control_db, session_registry_dead_process_not_running, daemon_progress_final_order_once.
- Replacement evidence:
  - Replacement trace name: state_runtime_root_custom_shared_control_db
    - Real production entrypoint used: golden: pending_real_runner at daemon startup -> runtime root resolver -> shared control DB
    - Exported state artifact/assertion: golden: state/state/state_runtime_root_custom_shared_control_db.json; pending_real_runner (No conformance runner is wired to daemon startup -> runtime root resolver -> shared control DB; this fixture is not deletion-gate evidence.)
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: Mapped traces still include pending_real_runner or missing runner evidence: state_runtime_root_custom_shared_control_db, session_registry_dead_process_not_running, daemon_progress_final_order_once.
  - Replacement trace name: session_registry_dead_process_not_running
    - Real production entrypoint used: golden: pending_real_runner at session registry snapshot -> process liveness verifier; replay: pending_real_runner at session registry snapshot -> process liveness verifier
    - Exported state artifact/assertion: golden: state/daemon/session_registry_dead_process_not_running.json; pending_real_runner (No conformance runner is wired to session registry snapshot -> process liveness verifier; this fixture is not deletion-gate evidence.); replay: state/daemon/session_registry_dead_process_not_running.json; pending_real_runner (No startup/replay/migration runner is wired to session registry snapshot -> process liveness verifier; this fixture is not deletion-gate evidence.)
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13; `npm run test:replay` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: Mapped traces still include pending_real_runner or missing runner evidence: state_runtime_root_custom_shared_control_db, session_registry_dead_process_not_running, daemon_progress_final_order_once.
  - Replacement trace name: daemon_progress_final_order_once
    - Real production entrypoint used: golden: pending_real_runner at daemon/gateway progress projector -> final visibility gate
    - Exported state artifact/assertion: golden: state/daemon/daemon_progress_final_order_once.json; pending_real_runner (No conformance runner is wired to daemon/gateway progress projector -> final visibility gate; this fixture is not deletion-gate evidence.)
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: Mapped traces still include pending_real_runner or missing runner evidence: state_runtime_root_custom_shared_control_db, session_registry_dead_process_not_running, daemon_progress_final_order_once.
- Simultaneous pass evidence: 2026-05-13: `npm run test:golden-traces` passed 40 traces, `npm run test:replay` passed 7 replay fixtures, and the mapped runtime integration batch passed 6 files / 260 tests.
- Delete condition: delete only when the old test file deletion gate above says yes.

### src/runtime/session-registry/__tests__/runtime-session-registry.test.ts

- Production boundary: resident runtime discovery -> session registry snapshot
- State artifact: session registry snapshot, capability snapshot
- Old test file deletion allowed: no
- No reason: Mapped traces still include pending_real_runner or missing runner evidence: session_registry_dead_process_not_running, resident_runtime_snapshot_capability_discovery_grants_no_authority.
- Replacement evidence:
  - Replacement trace name: session_registry_dead_process_not_running
    - Real production entrypoint used: golden: pending_real_runner at session registry snapshot -> process liveness verifier; replay: pending_real_runner at session registry snapshot -> process liveness verifier
    - Exported state artifact/assertion: golden: state/daemon/session_registry_dead_process_not_running.json; pending_real_runner (No conformance runner is wired to session registry snapshot -> process liveness verifier; this fixture is not deletion-gate evidence.); replay: state/daemon/session_registry_dead_process_not_running.json; pending_real_runner (No startup/replay/migration runner is wired to session registry snapshot -> process liveness verifier; this fixture is not deletion-gate evidence.)
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13; `npm run test:replay` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: Mapped traces still include pending_real_runner or missing runner evidence: session_registry_dead_process_not_running, resident_runtime_snapshot_capability_discovery_grants_no_authority.
  - Replacement trace name: resident_runtime_snapshot_capability_discovery_grants_no_authority
    - Real production entrypoint used: golden: pending_real_runner at resident runtime discovery -> capability snapshot -> authority gate
    - Exported state artifact/assertion: golden: state/resident/resident_runtime_snapshot_capability_discovery_grants_no_authority.json; pending_real_runner (No conformance runner is wired to resident runtime discovery -> capability snapshot -> authority gate; this fixture is not deletion-gate evidence.)
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: Mapped traces still include pending_real_runner or missing runner evidence: session_registry_dead_process_not_running, resident_runtime_snapshot_capability_discovery_grants_no_authority.
- Simultaneous pass evidence: 2026-05-13: `npm run test:golden-traces` passed 40 traces, `npm run test:replay` passed 7 replay fixtures, and `npx vitest run src/runtime/session-registry/__tests__/runtime-session-registry.test.ts --config vitest.integration.config.ts` passed 1 file / 21 tests.
- Delete condition: delete only when the old test file deletion gate above says yes.

### src/tools/fs/ReadTool/__tests__/ReadTool.test.ts

- Production boundary: tool catalog -> readonly filesystem tool execution
- State artifact: tool result envelope
- Old test file deletion allowed: no
- No reason: Mapped traces still include pending_real_runner or missing runner evidence: tool_readonly_fs_no_write_approval_under_workspace.
- Replacement evidence:
  - Replacement trace name: tool_readonly_fs_no_write_approval_under_workspace
    - Real production entrypoint used: golden: pending_real_runner at tool catalog -> readonly filesystem tool execution
    - Exported state artifact/assertion: golden: state/tool/tool_readonly_fs_no_write_approval_under_workspace.json; pending_real_runner (No conformance runner is wired to tool catalog -> readonly filesystem tool execution; this fixture is not deletion-gate evidence.)
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: Mapped traces still include pending_real_runner or missing runner evidence: tool_readonly_fs_no_write_approval_under_workspace.
- Simultaneous pass evidence: 2026-05-13: `npm run test:golden-traces` passed 40 traces, `npm run test:replay` passed 7 replay fixtures, and the mapped unit batch passed 5 files / 185 tests.
- Delete condition: delete only when the old test file deletion gate above says yes.

### src/tools/fs/FileWriteTool/__tests__/FileWriteTool.test.ts

- Production boundary: tool approval gate -> local write mutation
- State artifact: approval artifact, mutation artifact
- Old test file deletion allowed: no
- No reason: Mapped traces still include pending_real_runner or missing runner evidence: tool_write_local_records_approval_artifact_before_mutation.
- Replacement evidence:
  - Replacement trace name: tool_write_local_records_approval_artifact_before_mutation
    - Real production entrypoint used: golden: pending_real_runner at tool approval gate -> local write mutation
    - Exported state artifact/assertion: golden: state/tool/tool_write_local_records_approval_artifact_before_mutation.json; pending_real_runner (No conformance runner is wired to tool approval gate -> local write mutation; this fixture is not deletion-gate evidence.)
    - Same-checkout pass command: `npm run test:golden-traces` passed locally 2026-05-13
    - Deletion allowed: no
    - No reason: Mapped traces still include pending_real_runner or missing runner evidence: tool_write_local_records_approval_artifact_before_mutation.
- Simultaneous pass evidence: 2026-05-13: `npm run test:golden-traces` passed 40 traces, `npm run test:replay` passed 7 replay fixtures, and the mapped unit batch passed 5 files / 185 tests.
- Delete condition: delete only when the old test file deletion gate above says yes.

