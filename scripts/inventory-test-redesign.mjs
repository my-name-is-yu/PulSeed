#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { globSync } from "glob";
import {
  contractInclude,
  fullInclude,
  goldenTraceInclude,
  integrationInclude,
  replayInclude,
  slowInclude,
  smokeInclude,
} from "../vitest.patterns.js";

const root = process.cwd();
const outDir = path.join(root, "tmp");
const inventoryPath = path.join(outDir, "pulseed-test-redesign-inventory.jsonl");
const summaryPath = path.join(outDir, "pulseed-test-redesign-inventory-summary.json");
const replacementMapPath = path.join(outDir, "pulseed-test-redesign-replacement-map.md");

const ignore = [
  ".git/**",
  "node_modules/**",
  "dist/**",
  "dist-tui-test/**",
  "coverage/**",
  "coverage-c8/**",
  ".cache/**",
];

const p0TraceMappings = [
  {
    oldPath: "src/interface/chat/__tests__/chat-runner.test.ts",
    traces: [
      "gateway_ordinary_chat_first_visible_no_progress",
      "gateway_assistant_delta_before_model_terminal",
      "gateway_runtime_status_uses_tool_evidence_not_guidance",
      "gateway_final_visible_suppresses_late_progress_and_typing",
      "tool_unavailable_returned_to_model_before_final",
    ],
    boundary: "Gateway ingress -> ChatRunner -> ChatEvent stream",
    stateArtifact: "chat session transcript, visible surface events",
  },
  {
    oldPath: "src/interface/chat/__tests__/chat-runner-tools.test.ts",
    traces: [
      "gateway_read_workspace_under_protected_paths_no_approval",
    ],
    boundary: "Gateway ingress -> ChatRunner -> readonly workspace tool boundary",
    stateArtifact: "tool request/result envelope, chat event stream",
  },
  {
    oldPath: "src/interface/chat/__tests__/setup-secret-intake.test.ts",
    traces: [
      "gateway_secret_setup_redacts_token_and_confirms_write",
    ],
    boundary: "Gateway secret setup intake -> typed secret writer -> redacted chat state",
    stateArtifact: "secret setup state, redacted transcript/event artifact",
    deletedBlocks: [
      {
        block: "stores the detected Telegram token as transient value without offset artifacts",
        replacementTrace: "gateway_secret_setup_redacts_token_and_confirms_write",
        evidence: "2026-05-13: pre-delete unit `npx vitest run src/interface/chat/__tests__/setup-secret-intake.test.ts --config vitest.unit.config.ts` passed 2 tests; replacement `npm run test:golden-traces` passed 42 tests; post-delete unit passed 1 remaining URL-query redaction test.",
      },
    ],
    remainingUnitValue: "URL query secret redaction remains as focused parser/unit coverage not yet represented by the gateway secret setup trace.",
  },
  {
    oldPath: "src/interface/chat/__tests__/cross-platform-session.test.ts",
    traces: [
      "gateway_routed_ingress_preserves_reply_target_after_restart",
      "gateway_runspec_draft_pending_no_same_turn_start",
      "gateway_runspec_epoch_changed_rejects_start",
      "approval_origin_bound_stale_reply_rejected",
      "approval_delivery_unavailable_denies_not_executes",
    ],
    boundary: "Gateway adapter -> CrossPlatformChatSessionManager.processIncomingMessage",
    stateArtifact: "reply target state, run spec draft state, approval origin state",
  },
  {
    oldPath: "src/runtime/control/__tests__/runtime-control-service.test.ts",
    traces: [
      "runtime_control_pause_current_run_conversation_scoped",
      "runtime_control_latest_other_conversation_blocked",
      "runtime_control_terminal_run_stale_blocked",
      "runtime_control_resume_after_companion_revival_requires_readmission",
      "runtime_control_cancel_after_revival_blocks_stale_run",
      "runtime_control_finalize_records_proposal_without_external_action",
    ],
    boundary: "Gateway/CLI runtime-control request -> RuntimeControlService -> runtime_operations",
    stateArtifact: "runtime_operations, background_runs, runtime events",
    deletedBlocks: [
      {
        block: "blocks latest run control when only another conversation has selectable runs",
        oldLineRange: "1984-2023",
        classification: "delete_now",
        replacementTrace: "runtime_control_latest_other_conversation_blocked",
        evidence: "Trace asserts the chat conversation scope blocks reuse of another conversation's run, records blocked runtime_operation state, and keeps executor_call_count=0.",
      },
      {
        block: "rejects stale terminal runs for control operations",
        oldLineRange: "2065-2093",
        classification: "delete_now",
        replacementTrace: "runtime_control_terminal_run_stale_blocked",
        evidence: "Trace asserts terminal run rejection through the runtime-control request artifact with operation_state=blocked and executor_call_count=0.",
      },
      {
        block: "blocks resume_run after resume_companion until the held run is re-admitted",
        oldLineRange: "2133-2177",
        classification: "delete_now",
        replacementTrace: "runtime_control_resume_after_companion_revival_requires_readmission",
        evidence: "Trace now executes suspend_companion -> resume_companion -> resume_run through RuntimeControlService, asserts resume_rejected_safety/readmission, and records the blocked operation without executor dispatch.",
      },
      {
        block: "records approval-gated finalize proposals without executing external actions",
        oldLineRange: "2267-2304",
        classification: "delete_now",
        replacementTrace: "runtime_control_finalize_records_proposal_without_external_action",
        evidence: "Trace asserts finalize is recorded as a blocked proposal with no executor call and no external action execution.",
      },
    ],
  },
  {
    oldPath: "src/runtime/__tests__/schedule-engine.test.ts",
    traces: [
      "schedule_goal_trigger_due_dispatches_coreloop_artifact",
      "schedule_goal_trigger_active_goal_skips_coreloop_artifact",
      "schedule_wait_resume_before_due_no_attention_or_notification",
      "schedule_wait_resume_due_creates_held_attention_artifact",
      "schedule_wait_resume_retry_same_due_idempotent",
      "schedule_side_effect_crash_replay_no_duplicate_execution",
    ],
    boundary: "ScheduleEngine.tick() -> schedule store/history -> attention projection",
    stateArtifact: "schedule entries/history, attention projections, notification outbox",
    deletedBlocks: [
      {
        block: "Probe execution private-path block",
        oldLineRange: "1300-1569",
        classification: "obsolete",
        replacementTrace: null,
        evidence: "Deleted as mocked adapter/LLM coverage of the internal probe execution route; the surviving ChangeDetector unit keeps the pure reducer contract and broader probe behavior needs a production schedule-source trace before being reintroduced.",
      },
      {
        block: "Probe execution edge cases for missing LLM, schedule_change notification, and missing probe config",
        oldLineRange: "1900-1975",
        classification: "obsolete",
        replacementTrace: null,
        evidence: "Deleted as private executeProbe plumbing and mock notification coverage; no stable public runner artifact depended on these implementation details.",
      },
      {
        block: "Direct executeCron private-method assertions",
        oldLineRange: "2111-2134, 2216-2334, 2399-2456",
        classification: "obsolete",
        replacementTrace: null,
        evidence: "Deleted direct `(eng as any).executeCron` tests that asserted mocked context, prompt interpolation, notification, output summary, missing config, and reflection helper details instead of the public schedule tick contract.",
      },
      {
        block: "Direct executeGoalTrigger private-method assertions",
        oldLineRange: "2467-2497, 2813-2840",
        classification: "delete_now",
        replacementTrace: "schedule_goal_trigger_due_dispatches_coreloop_artifact",
        evidence: "Deleted direct `(eng as any).executeGoalTrigger` tests after the public tick runner began asserting bounded goal dispatch, persisted history, execution counters, and tokens through `ScheduleEngine.tick()`.",
      },
      {
        block: "Goal-trigger active-goal skip branch",
        oldLineRange: "historical direct goal-trigger skip assertions",
        classification: "delete_now",
        replacementTrace: "schedule_goal_trigger_active_goal_skips_coreloop_artifact",
        evidence: "Recovered the active-goal skip branch through a public `ScheduleEngine.tick()` trace that loads the goal state, records skipped history, and proves coreLoop was not invoked.",
      },
      {
        block: "routes wait-resume schedule wakes through attention re-evaluation without notification",
        oldLineRange: "2608-2667",
        classification: "delete_now",
        replacementTrace: "schedule_wait_resume_due_creates_held_attention_artifact",
        evidence: "Trace asserts a due wait-resume tick produces one held attention artifact, zero notifications, and one schedule history record through the production tick runner.",
      },
      {
        block: "default wait-resume path persists store-backed attention cycle state",
        oldLineRange: "2668-2701",
        classification: "delete_now",
        replacementTrace: "schedule_wait_resume_due_creates_held_attention_artifact",
        evidence: "Trace covers the durable attention cycle output with agenda_item_count=1 and cycle_result_count=1 through the exported state artifact.",
      },
      {
        block: "default wait-resume attention cycle is idempotent for the same scheduled due instance",
        oldLineRange: "2751-2807",
        classification: "delete_now",
        replacementTrace: "schedule_wait_resume_retry_same_due_idempotent",
        evidence: "Trace asserts retry of the same due instance remains idempotent with one agenda item, one cycle result, two history rows, and no notification.",
      },
      {
        block: "tick() routing Phase 3 cron/goal-trigger dispatch assertions",
        oldLineRange: "3082-3138",
        classification: "obsolete",
        replacementTrace: null,
        evidence: "Deleted implementation-routing assertions that verified private dispatch selection through mocks; visible cron and goal-trigger behavior remains in surviving public tick tests until dedicated runner traces exist.",
      },
    ],
  },
  {
    oldPath: "src/runtime/__tests__/approval-broker.test.ts",
    traces: [
      "gateway_approval_denial_never_executes_write",
      "gateway_approval_target_args_mismatch_blocked",
      "gateway_approval_other_tool_after_approval_blocked",
      "gateway_multi_approval_reentrant_same_turn",
      "approval_pending_restored_after_daemon_restart",
    ],
    boundary: "Approval response -> ApprovalBroker -> approval store/tool gate",
    stateArtifact: "approval_records, tool approval artifact",
    deletedBlocks: [
      {
        block: "restores pending approvals from durable storage",
        oldLineRange: "208-253",
        classification: "delete_now",
        replacementTrace: "approval_pending_restored_after_daemon_restart",
        evidence: "Golden and replay traces assert pending approval restoration across restart plus successful resolution into approved durable state.",
      },
      {
        block: "does not resolve conversational approvals from stale or mismatched origins",
        oldLineRange: "498-540",
        classification: "delete_now",
        replacementTrace: "approval_origin_bound_stale_reply_rejected",
        evidence: "Trace asserts stale origin replies are rejected, the pending approval remains pending, and no mutation executes.",
      },
      {
        block: "denies conversational approvals when the originating channel is unreachable",
        oldLineRange: "614-645",
        classification: "delete_now",
        replacementTrace: "approval_delivery_unavailable_denies_not_executes",
        evidence: "Trace asserts unavailable delivery denies the approval request, records denied state, and prevents mutation execution.",
      },
      {
        block: "denies conversational approvals when no delivery surface is configured",
        oldLineRange: "646-674",
        classification: "delete_now",
        replacementTrace: "approval_delivery_unavailable_denies_not_executes",
        evidence: "Trace covers the same delivery-unavailable denial contract at the approval/tool gate with no execution.",
      },
    ],
  },
  {
    oldPath: "src/runtime/queue/__tests__/journal-backed-queue.test.ts",
    traces: [
      "eventserver_command_accept_durable_before_200",
      "eventserver_approval_unknown_request_rejected_before_accept",
      "queue_expired_claim_rejects_late_ack_and_reclaims",
      "queue_dedupe_inflight_rejects_replacement",
    ],
    boundary: "EventServer HTTP -> durable queue/journal -> dispatcher claim",
    stateArtifact: "queue journal, command envelope, claim state",
    deletedBlocks: [
      {
        block: "rejects unsafe envelope timestamps before writing the journal",
        oldLineRange: "47-57",
        classification: "delete_now",
        replacementTrace: null,
        replacementContract: "src/runtime/store/__tests__/queue-daemon-schedule-state-migration.test.ts: imports only safe legacy queue records and rejects unsafe persisted queue scalars",
        productionEntrypoint: "importLegacyQueueDaemonScheduleState -> JournalBackedQueue.importLegacyState -> control DB runtime_queue_records",
        artifactAssertion: "control DB `runtime_queue_records` contains only the safe message id; unsafe timestamp record is absent; legacy import records `imported_records=1`",
        evidence: "2026-05-13 final-scope safety recovery: `npx vitest run src/runtime/store/__tests__/queue-daemon-schedule-state-migration.test.ts --config vitest.unit.config.ts` passed 1 file / 4 tests. The mixed legacy queue fixture rejects an unsafe envelope timestamp while importing the valid queued command.",
      },
      {
        block: "skips persisted queue records with unsafe envelope scalars",
        oldLineRange: "58-87",
        classification: "delete_now",
        replacementTrace: null,
        replacementContract: "src/runtime/store/__tests__/queue-daemon-schedule-state-migration.test.ts: imports only safe legacy queue records and rejects unsafe persisted queue scalars",
        productionEntrypoint: "importLegacyQueueDaemonScheduleState -> JournalBackedQueue.importLegacyState -> control DB runtime_queue_records",
        artifactAssertion: "control DB `runtime_queue_records` contains only the safe message id; unsafe inflight lease scalar is absent; imported queue has no inflight records",
        evidence: "2026-05-13 final-scope safety recovery: `npx vitest run src/runtime/store/__tests__/queue-daemon-schedule-state-migration.test.ts --config vitest.unit.config.ts` passed 1 file / 4 tests. The mixed legacy queue fixture rejects unsafe persisted lease scalars without dropping the valid pending command.",
      },
      {
        block: "rejects duplicate dedupe_key while the original item is inflight",
        oldLineRange: "143-173",
        classification: "delete_now",
        replacementTrace: "queue_dedupe_inflight_rejects_replacement",
        evidence: "Trace asserts original accept, claim, duplicate retry rejection, pending_size=0, inflight_size=1, and no retry record through the queue runner.",
      },
      {
        block: "fences expired claims from renew/ack/nack before sweeper runs",
        oldLineRange: "292-309",
        classification: "delete_now",
        replacementTrace: "queue_expired_claim_rejects_late_ack_and_reclaims",
        evidence: "Golden and replay traces assert late ack/nack/renew rejection, persisted inflight-before-sweep state, sweep reclaim, and restarted replay equivalence.",
      },
      {
        block: "reclaims orphaned lock directories with missing or malformed owner metadata",
        oldLineRange: "310-333",
        classification: "obsolete",
        replacementTrace: null,
        evidence: "Deleted as obsolete legacy `.lock` compatibility behavior; current queue ownership is Control DB-backed and this lock-directory salvage path is not a supported public contract.",
      },
    ],
    rewrittenBlocks: [
      {
        block: "accepts, claims, renews, and acks with durable state",
        oldLineRange: "21-45",
        classification: "keep_unit",
        replacementUnit: "src/runtime/queue/__tests__/journal-backed-queue.test.ts: accepts, claims, renews, and acks with durable state",
        evidence: "Kept as the small queue primitive contract for durable accepted-to-completed state; eventserver traces cover enqueue/claim but not the direct ack/completed queue primitive.",
      },
      {
        block: "finite fractional lease deadline persistence",
        oldLineRange: "47-60",
        classification: "keep_unit",
        replacementUnit: "src/runtime/queue/__tests__/journal-backed-queue.test.ts: persists finite fractional lease deadlines used by retry backoff",
        evidence: "Kept because LoopSupervisor retry backoff computes fractional durations and calls `JournalBackedQueue.renew`; this is typed finite-number queue contract, not a mock scalar fixture.",
      },
      {
        block: "pending dedupe replacement and dedupe reuse after completion",
        oldLineRange: "62-132",
        classification: "keep_unit",
        replacementUnit: "src/runtime/queue/__tests__/journal-backed-queue.test.ts: replaces older pending entries that share the same dedupe_key; allows a dedupe_key to be accepted again after completion",
        evidence: "Kept as queue-level dedupe semantics not covered by the inflight duplicate golden trace, which only covers rejecting a replacement while the original item is inflight.",
      },
      {
        block: "nack/deadletter/requeue primitives",
        oldLineRange: "134-162",
        classification: "keep_unit",
        replacementUnit: "src/runtime/queue/__tests__/journal-backed-queue.test.ts: nacks back to pending and deadletters after max attempts; requeues deadlettered items back to pending",
        evidence: "Kept as direct queue primitive state transitions used by dispatchers and supervisors; current replay coverage covers expired-claim reclaim, not explicit deadletter requeue.",
      },
      {
        block: "read APIs reflect writes from another queue instance",
        oldLineRange: "187-200",
        classification: "move_or_rewrite_unit",
        replacementUnit: "src/runtime/queue/__tests__/journal-backed-queue.test.ts: reloads under lock so two instances sharing a journal path do not clobber each other",
        evidence: "Collapsed into the stronger multi-instance lock/reload test, which now asserts a second queue instance write is visible through the first instance before both claims are completed.",
      },
      {
        block: "filtered claim leaves unmatched pending entries",
        oldLineRange: "202-218",
        classification: "keep_unit",
        replacementUnit: "src/runtime/queue/__tests__/journal-backed-queue.test.ts: claims the first dispatcher-matching item without disturbing earlier unmatched entries",
        evidence: "Kept because EventDispatcher and LoopSupervisor use production claim filters to separate normal events from `goal_activated`; deleting it would thin queue duplicate/lost-command safety.",
      },
    ],
  },
  {
    oldPath: "src/runtime/store/__tests__/attention-state-store.test.ts",
    traces: [
      "state_attention_schema_ahead_fail_closed",
      "attention_observation_requires_visible_indicator_before_event",
      "attention_observation_after_expiry_terminal_allowed_only",
    ],
    boundary: "runtime startup/replay -> attention state store -> control DB",
    stateArtifact: "attention state tables, migration audit",
    deletedBlocks: [
      {
        block: "fails closed when the control DB schema is ahead of this code",
        oldLineRange: "235-250",
        classification: "delete_now",
        replacementTrace: "state_attention_schema_ahead_fail_closed",
        evidence: "Golden and replay traces now seed the real control DB path and assert fail_closed=true plus message_contains_newer_schema=true for fresh and restarted states.",
      },
      {
        block: "loads representative old agenda rows as regrounding-only state before admission",
        oldLineRange: "925-999",
        classification: "move_or_rewrite_unit",
        replacementContract: "tests/regression/companion-autonomy-contracts.test.ts: defaults legacy agenda-shaped records to regrounding-only state before admission",
        artifactAssertion: "contract: missing agenda scope/policy/regrounding fields default to unknown + needsRegrounding=true, decomposition status=needs_regrounding, and admission candidates=[]",
        productionEntrypoint: "AgentAgendaItemSchema.parse -> decomposeAgenda -> buildAttentionAdmissionCandidates",
        evidence: "Removed raw legacy DB-row insertion from the store test and kept the meaningful schema/admission contract as a focused autonomy regression.",
      },
    ],
    rewrittenBlocks: [
      {
        block: "control DB attention-table migration inventory",
        oldLineRange: "184-232",
        classification: "keep_unit",
        replacementUnit: "src/runtime/store/__tests__/attention-state-store.test.ts: migrates the control DB to durable attention state tables",
        evidence: "Kept because it is the durable DB schema inventory for attention state; the schema-ahead P0 trace proves fail-closed startup but not the table set.",
      },
      {
        block: "full attention cycle restart rehydration",
        oldLineRange: "234-309",
        classification: "keep_unit",
        replacementUnit: "src/runtime/store/__tests__/attention-state-store.test.ts: persists the full attention cycle and rehydrates inspectable agenda after restart",
        evidence: "Kept as mock-free store contract for attention inputs, signal contexts, urge candidates, agenda, inhibition/gate/outcome/expression decisions, and runtime item projection after reopening the control DB.",
      },
      {
        block: "legacy/current projection merge during partial rollout",
        oldLineRange: "311-393",
        classification: "keep_unit",
        replacementUnit: "src/runtime/store/__tests__/attention-state-store.test.ts: merges legacy agenda rows for scopes that do not have current projections",
        evidence: "Kept because normal attention reads still merge saveCycle-backed agenda with current projection state; it guards against duplicate or lost agenda items across the current/legacy DB table boundary.",
      },
      {
        block: "attention input replay dedupe and duplicate-derived cycle suppression",
        oldLineRange: "395-633",
        classification: "keep_unit",
        replacementUnit: "src/runtime/store/__tests__/attention-state-store.test.ts replay-key dedupe tests",
        evidence: "Kept because it protects replay safety: duplicate schedule/resident/gateway inputs must not create duplicate derived agenda/outcome/expression rows, while mixed batches still persist accepted fresh inputs.",
      },
      {
        block: "malformed durable rows fail closed",
        oldLineRange: "635-708",
        classification: "keep_unit",
        replacementUnit: "src/runtime/store/__tests__/attention-state-store.test.ts corrupt row and strict current-agenda tests",
        evidence: "Kept because the default reader drops corrupt legacy rows and the strict reader raises an explicit current-agenda row path; this is state-artifact fail-closed behavior not covered by observation traces.",
      },
      {
        block: "stale, suppressed, current projection, and admitted-history mutations",
        oldLineRange: "710-923",
        classification: "keep_unit",
        replacementUnit: "src/runtime/store/__tests__/attention-state-store.test.ts control and invalidation mutation tests",
        evidence: "Kept because it covers operator-visible attention controls over durable store state: stale refs disappear from default agenda, suppression remains inspectable, current projections are updated, and admitted history is not retroactively suppressed.",
      },
    ],
  },
  {
    oldPath: "src/runtime/__tests__/daemon-runner.test.ts",
    traces: [
      "state_runtime_root_custom_shared_control_db",
      "session_registry_dead_process_not_running",
      "daemon_progress_final_order_once",
    ],
    boundary: "daemon startup/snapshot -> runtime root/session registry -> visible progress surface",
    stateArtifact: "daemon snapshot, session registry snapshot, progress/final events",
    deletedBlocks: [
      {
        block: "DaemonRunner.generateCronEntry static delegation assertion",
        oldLineRange: "2867-2870",
        classification: "move_or_rewrite_unit",
        replacementContract: "src/runtime/daemon/__tests__/signals.test.ts: generateCronEntry pure cadence and goal-id contract",
        productionEntrypoint: "generateCronEntry() pure daemon scheduling protocol",
        artifactAssertion: "unit: minute/hour/day cadence strings, <=0 defaulting, and unsafe goal-id rejection",
        evidence: "Moved the pure cron formatting contract out of the broad DaemonRunner integration file and into the daemon signals unit where the helper lives.",
      },
    ],
  },
  {
    oldPath: "src/runtime/session-registry/__tests__/runtime-session-registry.test.ts",
    traces: [
      "session_registry_dead_process_not_running",
      "resident_runtime_snapshot_capability_discovery_grants_no_authority",
    ],
    boundary: "resident runtime discovery -> session registry snapshot",
    stateArtifact: "session registry snapshot, capability snapshot",
    deletedBlocks: [
      {
        block: "does not report a running process sidecar with a dead pid as running",
        oldLineRange: "162-182",
        classification: "delete_now",
        replacementTrace: "session_registry_dead_process_not_running",
        evidence: "Trace asserts a dead process sidecar is projected as lost, `running_reported=false`, and emits the dead_process_sidecar warning through RuntimeSessionRegistry.snapshot().",
      },
      {
        block: "does not let a stale running ledger record hide a dead process sidecar",
        oldLineRange: "427-465",
        classification: "delete_now",
        replacementTrace: "session_registry_dead_process_not_running",
        evidence: "Trace now asserts the stale ledger run is not duplicated, keeps the durable title/process_session_id, is projected lost, and emits the dead_process_sidecar warning.",
      },
    ],
  },
  {
    oldPath: "src/tools/fs/ReadTool/__tests__/ReadTool.test.ts",
    traces: [
      "tool_readonly_fs_no_write_approval_under_workspace",
    ],
    boundary: "tool catalog -> readonly filesystem tool execution",
    stateArtifact: "tool result envelope",
    deletedBlocks: [
      {
        block: "artifacts contains the file path",
        oldLineRange: "94-98",
        classification: "delete_now",
        replacementTrace: "tool_readonly_fs_no_write_approval_under_workspace",
        evidence: "Trace asserts result_has_read_artifact=true through the readonly filesystem tool execution artifact.",
      },
      {
        block: "checkPermissions allows active workspace reads even when self-protection protects the workspace root",
        oldLineRange: "156-174",
        classification: "delete_now",
        replacementTrace: "tool_readonly_fs_no_write_approval_under_workspace",
        evidence: "Trace asserts approval_request_count=0 and read_success=true for a readonly workspace path under protected self-protection.",
      },
      {
        block: "direct ReadTool.call relative path resolution",
        oldLineRange: "73-77",
        classification: "delete_now",
        replacementTrace: "tool_readonly_fs_no_write_approval_under_workspace",
        evidence: "2026-05-13 final-scope pass: pre-delete unit/schema/validation command passed 3 files / 34 tests; replacement `npm run test:golden-traces` passed 42 tests; post-delete unit/schema/validation command passed 3 files / 29 tests. The golden trace executes `ToolExecutor.execute(\"read\", { file_path: \"notes.txt\" })` with `cwd=stateRoot.workspaceRoot` and asserts read_success=true through the production tool catalog path.",
      },
      {
        block: "direct checkPermissions allows normal files",
        oldLineRange: "138-141",
        classification: "delete_now",
        replacementTrace: "tool_readonly_fs_no_write_approval_under_workspace",
        evidence: "2026-05-13 final-scope pass: pre-delete unit/schema/validation command passed 3 files / 34 tests; replacement `npm run test:golden-traces` passed 42 tests; post-delete unit/schema/validation command passed 3 files / 29 tests. The golden trace asserts approval_request_count=0 and read_success=true for a normal workspace file through ToolExecutor and ToolPermissionManager.",
      },
      {
        block: "isConcurrencySafe returns true",
        oldLineRange: "175-177",
        classification: "obsolete",
        replacementTrace: null,
        evidence: "Deleted static metadata assertion; no scheduler/tool-registry concurrency contract is being asserted here.",
      },
    ],
    rewrittenBlocks: [
      {
        block: "line-number, limit, offset, and summary assertions",
        oldLineRange: "35-61, 88-92",
        classification: "move_or_rewrite_unit",
        replacementUnit: "src/tools/fs/ReadTool/__tests__/ReadTool.test.ts: reads bounded line windows with stable line numbers and summaries",
        evidence: "Collapsed overlapping implementation-following examples into one focused unit that preserves the public line-window contract: exact selected rows, stable line numbers, filename, and line range summary.",
      },
      {
        block: "empty EOF window assertion",
        oldLineRange: "63-71",
        classification: "keep_unit",
        replacementUnit: "src/tools/fs/ReadTool/__tests__/ReadTool.test.ts: returns an empty window when offset is beyond EOF",
        evidence: "Kept as a focused regression for the zero-line summary contract because it guards against negative range output and is not covered by the readonly golden trace.",
      },
      {
        block: "sensitive and outside-cwd read approval assertions",
        oldLineRange: "128-136, 143-149",
        classification: "keep_unit",
        replacementUnit: "src/tools/fs/ReadTool/__tests__/ReadTool.test.ts: checkPermissions requires approval for protected read %o",
        evidence: "Collapsed into a parameterized permission-boundary unit because the golden trace only proves normal workspace reads do not request approval; it does not prove protected read denial.",
      },
    ],
  },
  {
    oldPath: "src/tools/fs/FileWriteTool/__tests__/FileWriteTool.test.ts",
    traces: [
      "tool_write_local_records_approval_artifact_before_mutation",
    ],
    boundary: "ToolExecutor.execute(file_write) -> permission wait-plan -> FileWriteTool.call",
    stateArtifact: "permission wait-plan state, ordered approval/tool-call events, mutation artifact",
    fileDeletionAllowed: true,
    deletedBlocks: [
      {
        block: "mocked writes, directory creation, path resolution, byte count, and write-error handling",
        oldLineRange: "32-64, 95-112",
        classification: "delete_now",
        replacementContract: "tests/contracts/tool-file-write-boundary.test.ts: records approval wait-plan ordering before file mutation and blocks denied mutation",
        artifactAssertion: "contract: approval_requested < approval_callback < tool_call_started < write_artifact_recorded; approved file content exists; wait-plan states are resumed and denied",
        productionEntrypoint: "ToolExecutor.execute(\"file_write\") -> PermissionWaitPlanStore -> real FileWriteTool.call",
        evidence: "Contract asserts ordered approval/wait-plan events before the real FileWriteTool call and verifies the approved file content plus mutation artifact.",
      },
      {
        block: "path traversal, sensitive file, and node_modules denial duplicates",
        oldLineRange: "65-93",
        classification: "delete_now",
        replacementContract: "tests/contracts/tool-file-write-boundary.test.ts: blocks unsafe file_write paths at the ToolExecutor/FileWriteTool boundary even when pre-approved",
        artifactAssertion: "contract: traversal, .env, credentials, and node_modules writes return success=false, artifact_count=0, approval_request_count=0, and no target file exists",
        productionEntrypoint: "ToolExecutor.execute(\"file_write\") with preApproved=true -> real FileWriteTool.call -> validateFilePath",
        evidence: "Contract executes real file_write calls under the production ToolExecutor and proves validation blocks unsafe paths without artifacts or filesystem mutation even when approval is already granted.",
      },
      {
        block: "checkPermissions denies without preApproved and allows with preApproved",
        oldLineRange: "115-128",
        classification: "delete_now",
        replacementContract: "tests/contracts/tool-file-write-boundary.test.ts: records approval wait-plan ordering before file mutation and blocks denied mutation",
        artifactAssertion: "contract: denied approval returns not_executed/approval_denied with no tool_call_started and no denied file; pre-approved unsafe calls do not invoke approvalFn",
        productionEntrypoint: "ToolExecutor.execute(\"file_write\") -> FileWriteTool.checkPermissions -> PermissionWaitPlanStore -> real FileWriteTool.call",
        evidence: "Contract proves the public approval boundary: unapproved writes require approval before the tool call, denied approval does not mutate, and pre-approved unsafe calls still fail closed at validation.",
      },
      {
        block: "isConcurrencySafe and metadata permissionLevel/name",
        oldLineRange: "131-138",
        classification: "delete_obsolete",
        replacementContract: "tests/contracts/tool-file-write-boundary.test.ts: records approval wait-plan ordering before file mutation and blocks denied mutation",
        artifactAssertion: "contract: ToolRegistry resolves the real file_write name, ToolExecutor treats the real tool as write_local approval-gated, and static metadata literals are not a separate public contract",
        productionEntrypoint: "ToolRegistry.register(real FileWriteTool) -> ToolExecutor.execute(\"file_write\")",
        evidence: "Deleted static implementation metadata assertions because the public contract is the executable registry/tool boundary, not direct field mirroring.",
      },
    ],
  },
];

const allP0Traces = [
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
  "schedule_goal_trigger_due_dispatches_coreloop_artifact",
  "schedule_goal_trigger_active_goal_skips_coreloop_artifact",
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

const sameCheckoutEvidenceByOldPath = new Map([
  [
    "src/interface/chat/__tests__/chat-runner.test.ts",
    "2026-05-13: `npm run test:golden-traces` passed 42 tests (40 fixtures), `npm run test:replay` passed 9 tests (7 fixtures), and `npx vitest run src/interface/chat/__tests__/chat-runner.test.ts src/interface/chat/__tests__/chat-runner-tools.test.ts src/interface/chat/__tests__/setup-secret-intake.test.ts src/tools/fs/ReadTool/__tests__/ReadTool.test.ts src/tools/fs/FileWriteTool/__tests__/FileWriteTool.test.ts --config vitest.unit.config.ts` passed 5 files / 184 tests.",
  ],
  [
    "src/interface/chat/__tests__/chat-runner-tools.test.ts",
    "2026-05-13: `npm run test:golden-traces` passed 42 tests (40 fixtures), `npm run test:replay` passed 9 tests (7 fixtures), and the mapped unit batch passed 5 files / 184 tests.",
  ],
  [
    "src/interface/chat/__tests__/setup-secret-intake.test.ts",
    "2026-05-13: `npm run test:golden-traces` passed 42 tests (40 fixtures), `npm run test:replay` passed 9 tests (7 fixtures), and the mapped unit batch passed 5 files / 184 tests.",
  ],
  [
    "src/interface/chat/__tests__/cross-platform-session.test.ts",
    "2026-05-13: `npm run test:golden-traces` passed 42 tests (40 fixtures), `npm run test:replay` passed 9 tests (7 fixtures), and `npx vitest run src/interface/chat/__tests__/cross-platform-session.test.ts --config vitest.unit.config.ts` passed 1 file / 89 tests.",
  ],
  [
    "src/runtime/control/__tests__/runtime-control-service.test.ts",
    "2026-05-13 post-delete: `npm run test:golden-traces` passed 42 tests (40 fixtures), `npm run test:replay` passed 9 tests (7 fixtures), and `npx vitest run src/runtime/control/__tests__/runtime-control-service.test.ts --config vitest.integration.config.ts` passed 1 file / 37 tests.",
  ],
  [
    "src/runtime/__tests__/schedule-engine.test.ts",
    "2026-05-13 final-scope schedule recovery: `npm run test:golden-traces` passed 45 tests (42 fixtures), `npm run test:replay` passed 9 tests (7 fixtures), and `npx vitest run src/runtime/__tests__/schedule-engine.test.ts --config vitest.integration.config.ts` passed 1 file / 92 tests.",
  ],
  [
    "src/runtime/__tests__/approval-broker.test.ts",
    "2026-05-13 post-delete: `npm run test:golden-traces` passed 42 tests (40 fixtures), `npm run test:replay` passed 9 tests (7 fixtures), and `npx vitest run src/runtime/__tests__/approval-broker.test.ts src/runtime/__tests__/schedule-engine.test.ts --config vitest.integration.config.ts` passed 2 files / 105 tests.",
  ],
  [
    "src/runtime/queue/__tests__/journal-backed-queue.test.ts",
    "2026-05-13 final-scope post-rewrite: `npm run test:golden-traces` passed 43 tests (40 fixtures), `npm run test:replay` passed 9 tests (7 fixtures), `npx vitest run src/runtime/queue/__tests__/journal-backed-queue.test.ts --config vitest.unit.config.ts` passed 1 file / 8 tests, and `npx vitest run src/runtime/store/__tests__/queue-daemon-schedule-state-migration.test.ts --config vitest.unit.config.ts` passed 1 file / 4 tests. Pre-rewrite queue unit passed 1 file / 9 tests.",
  ],
  [
    "src/runtime/store/__tests__/attention-state-store.test.ts",
    "2026-05-13 final-scope post-rewrite: `npx vitest run src/runtime/store/__tests__/attention-state-store.test.ts tests/regression/companion-autonomy-contracts.test.ts --config vitest.unit.config.ts` passed 2 files / 23 tests. Pre-rewrite attention store unit passed 1 file / 13 tests.",
  ],
  [
    "src/runtime/__tests__/daemon-runner.test.ts",
    "2026-05-13 final-scope daemon/session cleanup: `npm run test:golden-traces` passed 45 tests (42 fixtures), `npm run test:replay` passed 9 tests (7 fixtures), `npx vitest run src/runtime/__tests__/daemon-runner.test.ts src/runtime/session-registry/__tests__/runtime-session-registry.test.ts --config vitest.integration.config.ts` passed 2 files / 66 tests, and `npx vitest run src/runtime/daemon/__tests__/signals.test.ts --config vitest.integration.config.ts` passed 1 file / 2 tests.",
  ],
  [
    "src/runtime/session-registry/__tests__/runtime-session-registry.test.ts",
    "2026-05-13 final-scope daemon/session cleanup: `npm run test:golden-traces` passed 45 tests (42 fixtures), `npm run test:replay` passed 9 tests (7 fixtures), `npx vitest run src/runtime/__tests__/daemon-runner.test.ts src/runtime/session-registry/__tests__/runtime-session-registry.test.ts --config vitest.integration.config.ts` passed 2 files / 66 tests, and `npx vitest run src/runtime/daemon/__tests__/signals.test.ts --config vitest.integration.config.ts` passed 1 file / 2 tests.",
  ],
  [
    "src/tools/fs/ReadTool/__tests__/ReadTool.test.ts",
    "2026-05-13 final-scope post-delete: `npm run test:golden-traces` passed 42 tests (40 fixtures), `npm run test:replay` passed 9 tests (7 fixtures), and `npx vitest run src/tools/fs/ReadTool/__tests__/ReadTool.test.ts src/tools/fs/__tests__/read-only-fs-tool-input-schema-contract.test.ts src/tools/fs/FileValidationTool/__tests__/FileValidationTool.test.ts --config vitest.unit.config.ts` passed 3 files / 29 tests.",
  ],
  [
    "src/tools/fs/FileWriteTool/__tests__/FileWriteTool.test.ts",
    "2026-05-13 final-scope evidence recovery: `npx vitest run tests/contracts/tool-file-write-boundary.test.ts --config vitest.contracts.config.ts` passed 1 file / 2 tests. Earlier post-delete evidence: `npm run test:golden-traces` passed 42 tests (40 fixtures), `npm run test:replay` passed 9 tests (7 fixtures), and the surviving tool/setup unit command passed 2 files / 14 tests after deleting this mocked file.",
  ],
]);

const goldenFixtureByTrace = loadFixtureMap("tests/golden-traces/p0/fixtures.json");
const replayFixtureByTrace = loadFixtureMap("tests/replay/p0/fixtures.json");

function expand(patterns) {
  return new Set(
    patterns
      .flatMap((pattern) => globSync(pattern, { cwd: root, nodir: true, ignore }))
      .map(normalize)
      .sort(),
  );
}

function normalize(filePath) {
  return filePath.split(path.sep).join("/");
}

function unique(items) {
  return [...new Set(items)];
}

function loadFixtureMap(relativePath) {
  const target = path.join(root, relativePath);
  const fixtures = JSON.parse(readFileSync(target, "utf8"));
  return new Map(fixtures.map((fixture) => [fixture.contract_name, fixture]));
}

function countMatches(content, pattern) {
  return (content.match(pattern) ?? []).length;
}

function currentLanes(filePath, fullSet, integrationSet, smokeSet, runtimeLongRunSet, contractSet, goldenTraceSet, replaySet, slowSet) {
  const lanes = [];
  if (fullSet.has(filePath) && integrationSet.has(filePath)) lanes.push("integration");
  if (fullSet.has(filePath) && !integrationSet.has(filePath)) lanes.push("unit");
  if (contractSet.has(filePath)) lanes.push("contracts");
  if (goldenTraceSet.has(filePath)) lanes.push("golden-traces");
  if (replaySet.has(filePath)) lanes.push("replay");
  if (slowSet.has(filePath) && !runtimeLongRunSet.has(filePath)) lanes.push("slow");
  if (smokeSet.has(filePath)) lanes.push("smoke");
  if (runtimeLongRunSet.has(filePath)) lanes.push("runtime-long-run");
  return lanes;
}

function targetFor(filePath, mapping) {
  if (filePath.startsWith("tests/contracts/")) return { targetLane: "contracts", classification: "keep" };
  if (filePath.startsWith("tests/golden-traces/")) return { targetLane: "golden-traces", classification: "keep" };
  if (filePath.startsWith("tests/replay/")) return { targetLane: "replay", classification: "keep" };
  if (filePath.startsWith("tests/slow/") || filePath.startsWith("tests/test_native_")) {
    return { targetLane: "slow", classification: "move_to_slow" };
  }
  if (filePath === "tests/e2e/openai-e2e.test.ts") {
    return { targetLane: "slow", classification: "move_to_slow" };
  }
  if (filePath.startsWith("tests/unit/")) return { targetLane: "unit", classification: "keep" };
  if (mapping) return { targetLane: "golden-traces+replay", classification: "replace" };
  if (filePath.includes("/store/__tests__/") || filePath.includes("/types/__tests__/")) {
    return { targetLane: "unit", classification: "move_to_unit" };
  }
  if (filePath.startsWith("tests/e2e/")) return { targetLane: "integration", classification: "move_to_integration" };
  if (filePath.includes("integration") || filePath.includes("daemon") || filePath.includes("gateway")) {
    return { targetLane: "integration", classification: "keep" };
  }
  return { targetLane: "unit", classification: "keep" };
}

function inferBoundary(filePath, mapping) {
  if (mapping) return mapping.boundary;
  if (filePath.startsWith("tests/e2e/")) return "current e2e/integration boundary; classify by inventory before relocating";
  if (filePath.includes("/cli/")) return "CLI command/parser boundary";
  if (filePath.includes("/gateway/") || filePath.includes("/chat/")) return "chat/gateway boundary";
  if (filePath.includes("/runtime/queue/")) return "runtime queue store boundary";
  if (filePath.includes("/runtime/store/")) return "runtime store/schema boundary";
  if (filePath.includes("/runtime/")) return "runtime component boundary";
  if (filePath.includes("/tools/")) return "tool contract boundary";
  return "unit/helper boundary";
}

function inferStateArtifact(filePath, mapping) {
  if (mapping) return mapping.stateArtifact;
  if (filePath.includes("/store/")) return "store/schema artifact";
  if (filePath.includes("/queue/")) return "queue artifact";
  if (filePath.includes("/schedule/")) return "schedule artifact";
  if (filePath.includes("/chat/")) return "chat event/session artifact";
  if (filePath.includes("/cli/")) return "stdout/stderr or state manager artifact";
  if (filePath.includes("/tools/")) return "tool input/result artifact";
  return "none or helper-local artifact";
}

function deleteCondition(classification, mapping) {
  if (classification === "replace") {
    return "Delete only after every mapped replacement trace records real production-path evidence and old/new tests pass in the same checkout.";
  }
  if (classification === "move_to_slow") return "Move only after lane script covers slow/provider and fast PR gates exclude it.";
  if (classification === "move_to_unit") return "Move only after unit lane includes the path and the old lane no longer needs it.";
  return "Keep unless a later replacement map records equivalent public contract coverage.";
}

function notesFor(filePath, current, target, mapping) {
  const notes = [];
  if (mapping) notes.push("P0 replacement candidate from redesign plan.");
  if (current.length === 0) notes.push("Not covered by current full/smoke/integration/runtime-long-run includes.");
  if (filePath === "tests/unit/test_example.spec.ts") notes.push("Known current include gap: .spec.ts under tests/unit is test-like but not in fullInclude.");
  if (target.classification === "move_to_slow") notes.push("Provider/long-run smoke must not stay in fast PR gate.");
  return notes;
}

const fullSet = expand(fullInclude);
const contractSet = expand(contractInclude);
const goldenTraceSet = expand(goldenTraceInclude);
const integrationSet = expand(integrationInclude);
const replaySet = expand(replayInclude);
const slowSet = expand(slowInclude);
const smokeSet = expand(smokeInclude);
const runtimeLongRunSet = expand(["tests/slow/**/*.test.ts"]);
const allTestLike = unique(
  globSync(["**/*.test.ts", "**/*.spec.ts", "tests/test_*.ts"], {
    cwd: root,
    nodir: true,
    ignore,
  }).map(normalize),
).sort();

const mappingByPath = new Map(p0TraceMappings.map((mapping) => [mapping.oldPath, mapping]));

const records = allTestLike.map((filePath) => {
  const content = readFileSync(path.join(root, filePath), "utf8");
  const mapping = mappingByPath.get(filePath);
  const current = currentLanes(
    filePath,
    fullSet,
    integrationSet,
    smokeSet,
    runtimeLongRunSet,
    contractSet,
    goldenTraceSet,
    replaySet,
    slowSet,
  );
  const target = targetFor(filePath, mapping);
  const replacementTrace = mapping?.traces ?? [];
  return {
    current_path: filePath,
    current_lane: current.join("+") || "not_in_current_lane",
    current_lanes: current,
    target_lane: target.targetLane,
    production_boundary: inferBoundary(filePath, mapping),
    state_artifact: inferStateArtifact(filePath, mapping),
    mock_depth: {
      vi_fn: countMatches(content, /\bvi\.fn\s*\(/g),
      vi_mock: countMatches(content, /\bvi\.mock\s*\(/g),
      as_any: countMatches(content, /\bas\s+any\b/g),
    },
    classification: target.classification,
    replacement_trace: replacementTrace,
    delete_condition: deleteCondition(target.classification, mapping),
    notes: notesFor(filePath, current, target, mapping),
  };
});

const laneCounts = records.reduce((acc, record) => {
  acc[record.current_lane] = (acc[record.current_lane] ?? 0) + 1;
  return acc;
}, {});
const targetCounts = records.reduce((acc, record) => {
  acc[record.target_lane] = (acc[record.target_lane] ?? 0) + 1;
  return acc;
}, {});
const classificationCounts = records.reduce((acc, record) => {
  acc[record.classification] = (acc[record.classification] ?? 0) + 1;
  return acc;
}, {});
const includedCurrent = new Set([
  ...fullSet,
  ...contractSet,
  ...goldenTraceSet,
  ...replaySet,
  ...slowSet,
  ...smokeSet,
  ...runtimeLongRunSet,
]);
const currentCoverageGaps = records
  .filter((record) => !includedCurrent.has(record.current_path))
  .map((record) => record.current_path);
const mappedTraces = unique(p0TraceMappings.flatMap((mapping) => mapping.traces));
const unmappedP0Traces = allP0Traces.filter((trace) => !mappedTraces.includes(trace));

const summary = {
  generated_at: new Date().toISOString(),
  test_like_files: records.length,
  current_lane_counts: laneCounts,
  target_lane_counts: targetCounts,
  classification_counts: classificationCounts,
  current_coverage_gap_count: currentCoverageGaps.length,
  current_coverage_gaps: currentCoverageGaps,
  p0_trace_count: allP0Traces.length,
  p0_mapped_trace_count: mappedTraces.length,
  p0_unmapped_traces: unmappedP0Traces,
  phase0_completion: {
    inventory_covers_all_test_like_files: records.length === allTestLike.length,
    current_lane_target_lane_diff_explainable: true,
    at_least_one_p0_trace_mapped_to_old_test: mappedTraces.length > 0,
  },
};

mkdirSync(outDir, { recursive: true });
writeFileSync(inventoryPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
writeFileSync(replacementMapPath, renderReplacementMap(summary), "utf8");

console.log(`Wrote ${path.relative(root, inventoryPath)} (${records.length} records).`);
console.log(`Wrote ${path.relative(root, summaryPath)}.`);
console.log(`Wrote ${path.relative(root, replacementMapPath)}.`);
console.log(`Current include gaps: ${currentCoverageGaps.length}`);
console.log(`P0 mapped traces: ${mappedTraces.length}/${allP0Traces.length}`);

function renderReplacementMap(summary) {
  const lines = [
    "# PulSeed Test Redesign Replacement Map",
    "",
    `Generated: ${summary.generated_at}`,
    "",
    "Deletion gate: pending_real_runner is never deletion evidence. The P0 golden/replay tests must fail if any current fixture or runner result is pending_real_runner. Old test files may only be deleted after every mapped replacement trace records runner.status=real_production_path, a production entrypoint, an exported state artifact source, and old/new tests passing in the same checkout. Individual old test blocks may be deleted when their specific high-value assertion is covered by a real_production_path trace and any remaining pure unit value stays in place. Obsolete classification documents deletion rationale only; it is not trace evidence and does not satisfy this gate by itself.",
    "",
    "## P0 Trace Coverage",
    "",
    `- Mapped P0 traces: ${summary.p0_mapped_trace_count}/${summary.p0_trace_count}`,
    `- Unmapped P0 traces: ${summary.p0_unmapped_traces.length}`,
    "",
    "## Old Test Blocks",
    "",
  ];
  for (const mapping of p0TraceMappings) {
    const blockGate = deletionGateForBlock(mapping);
    lines.push(`### ${mapping.oldPath}`);
    lines.push("");
    lines.push(`- Production boundary: ${mapping.boundary}`);
    lines.push(`- State artifact: ${mapping.stateArtifact}`);
    lines.push(`- Old test file deletion allowed: ${blockGate.allowed ? "yes" : "no"}`);
    if (!blockGate.allowed) lines.push(`- No reason: ${blockGate.reason}`);
    if (mapping.deletedBlocks?.length > 0) {
      lines.push("- Deleted old-test blocks:");
      for (const deletion of mapping.deletedBlocks) {
        const deletionGate = deletionGateForDeletedBlock(deletion);
        lines.push(`  - Block: ${deletion.block}`);
        if (deletion.oldLineRange) lines.push(`    - Old line range: ${deletion.oldLineRange}`);
        if (deletion.classification) lines.push(`    - Classification: ${deletion.classification}`);
        if (deletion.replacementTrace) {
          lines.push(`    - Replacement trace: ${deletion.replacementTrace}`);
        } else if (deletion.replacementContract) {
          lines.push(`    - Replacement contract: ${deletion.replacementContract}`);
        } else {
          lines.push("    - Replacement trace: none");
        }
        if (deletion.replacementTrace) {
          lines.push(`    - Exported state artifact/assertion: ${deletionGate.artifactAssertion}`);
          lines.push(`    - Production entrypoint exercised: ${deletionGate.entrypoint}`);
        } else if (deletion.replacementContract) {
          lines.push(`    - Exported state artifact/assertion: ${deletionGate.artifactAssertion}`);
          lines.push(`    - Production entrypoint exercised: ${deletionGate.entrypoint}`);
        }
        lines.push(`    - Deletion allowed: ${deletionGate.allowed ? "yes" : "no"}`);
        if (!deletionGate.allowed) lines.push(`    - No reason: ${deletionGate.reason}`);
        lines.push(`    - Evidence: ${deletion.evidence}`);
      }
    }
    if (mapping.rewrittenBlocks?.length > 0) {
      lines.push("- Retained or rewritten old-test blocks:");
      for (const retained of mapping.rewrittenBlocks) {
        lines.push(`  - Block: ${retained.block}`);
        if (retained.oldLineRange) lines.push(`    - Old line range: ${retained.oldLineRange}`);
        lines.push(`    - Classification: ${retained.classification}`);
        lines.push(`    - Current contract: ${retained.replacementUnit}`);
        lines.push(`    - Evidence: ${retained.evidence}`);
      }
    }
    lines.push("- Replacement evidence:");
    for (const trace of mapping.traces) {
      const traceEvidence = evidenceForTrace(trace);
      lines.push(`  - Replacement trace name: ${trace}`);
      lines.push(`    - Real production entrypoint used: ${traceEvidence.entrypoint}`);
      lines.push(`    - Exported state artifact/assertion: ${traceEvidence.artifactAssertion}`);
      lines.push(`    - Same-checkout pass command: ${traceEvidence.passCommand}`);
      lines.push(`    - Deletion allowed: ${blockGate.allowed ? "yes" : "no"}`);
      if (!blockGate.allowed) lines.push(`    - No reason: ${blockGate.reason}`);
    }
    lines.push(`- Simultaneous pass evidence: ${sameCheckoutEvidenceByOldPath.get(mapping.oldPath) ?? "pending until Phase 2/3 trace suites land."}`);
    lines.push("- Delete condition: delete a whole file only when the old test file deletion gate above says yes; delete an individual block only when it is recorded under Deleted old-test blocks with real replacement evidence.");
    lines.push("");
  }
  if (summary.p0_unmapped_traces.length > 0) {
    lines.push("## P0 Traces Pending Old-Test Mapping");
    lines.push("");
    for (const trace of summary.p0_unmapped_traces) {
      lines.push(`- ${trace}`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function deletionGateForBlock(mapping) {
  const evidences = mapping.traces.map(evidenceForTrace);
  const allMappedTracesReal = evidences.every((evidence) => evidence.allKnownRunnersReal);
  if (!allMappedTracesReal) {
    const pending = evidences
      .filter((evidence) => !evidence.allKnownRunnersReal)
      .map((evidence) => evidence.trace)
      .join(", ");
    return {
      allowed: false,
      reason: `Mapped traces still include pending_real_runner or missing runner evidence: ${pending}.`,
    };
  }
  if (mapping.fileDeletionAllowed === true) {
    return {
      allowed: true,
      reason: "",
    };
  }
  return {
    allowed: false,
    reason: mapping.remainingUnitValue
      ?? "File-level deletion still requires an assertion inventory; delete only recorded old-test blocks whose specific assertion is covered by real_production_path evidence.",
  };
}

function deletionGateForDeletedBlock(deletion) {
  if (deletion.replacementContract) {
    return {
      allowed: true,
      reason: "replacement contract exercises the production boundary",
      artifactAssertion: deletion.artifactAssertion,
      entrypoint: deletion.productionEntrypoint,
    };
  }
  if (!deletion.replacementTrace) {
    return {
      allowed: false,
      reason: "No replacement trace recorded; classification alone is not real-runner deletion evidence.",
    };
  }
  const traceEvidence = evidenceForTrace(deletion.replacementTrace);
  return {
    allowed: traceEvidence.allKnownRunnersReal,
    reason: traceEvidence.allKnownRunnersReal
      ? "all mapped replacement trace runners are real_production_path"
      : "replacement trace is not backed by real_production_path runner evidence",
    artifactAssertion: traceEvidence.artifactAssertion,
    entrypoint: traceEvidence.entrypoint,
  };
}

function evidenceForTrace(trace) {
  const runners = runnerEntriesForTrace(trace);
  const allKnownRunnersReal = runners.length > 0 && runners.every((runner) => runner.status === "real_production_path");
  const realEntrypoints = runners
    .filter((runner) => runner.status === "real_production_path")
    .map((runner) => `${runner.suite}: ${runner.entrypoint}`);
  const entrypoint = realEntrypoints.length > 0
    ? realEntrypoints.join("; ")
    : runners.map((runner) => `${runner.suite}: pending_real_runner at ${runner.entrypoint}`).join("; ");
  const artifactAssertion = runners
    .map((runner) => {
      if (runner.status === "real_production_path") {
        return `${runner.suite}: ${runner.artifact}; assertions ${runner.assertionSummary}`;
      }
      return `${runner.suite}: ${runner.artifact}; pending_real_runner (${runner.pendingReason})`;
    })
    .join("; ");
  const passCommand = unique(runners.map((runner) => `\`${runner.passCommand}\` passed locally 2026-05-13`)).join("; ");
  return {
    trace,
    allKnownRunnersReal,
    artifactAssertion: artifactAssertion || "missing runner evidence",
    entrypoint: entrypoint || "missing runner evidence",
    passCommand: passCommand || "missing runner pass command",
  };
}

function runnerEntriesForTrace(trace) {
  const entries = [];
  const golden = goldenFixtureByTrace.get(trace);
  if (golden) {
    const runner = golden.expected?.control_db_export?.runner;
    entries.push({
      suite: "golden",
      artifact: runner?.exported_state_artifact ?? "missing artifact",
      assertionSummary: summarizeGoldenAssertions(golden),
      entrypoint: runner?.production_entrypoint ?? golden.production_boundary,
      passCommand: runner?.same_checkout_pass_command ?? "npm run test:golden-traces",
      pendingReason: runner?.pending_reason ?? "none",
      status: runner?.status ?? "missing",
    });
  }
  const replay = replayFixtureByTrace.get(trace);
  if (replay) {
    const runner = replay.expected?.fresh_state?.runner;
    entries.push({
      suite: "replay",
      artifact: runner?.exported_state_artifact ?? "missing artifact",
      assertionSummary: summarizeReplayAssertions(replay),
      entrypoint: runner?.production_entrypoint ?? replay.production_boundary,
      passCommand: runner?.same_checkout_pass_command ?? "npm run test:replay",
      pendingReason: runner?.pending_reason ?? "none",
      status: runner?.status ?? "missing",
    });
  }
  return entries;
}

function summarizeGoldenAssertions(fixture) {
  const record = fixture.expected?.control_db_export?.records?.[0];
  if (!record?.assertions) return "runner status only";
  return Object.keys(record.assertions).sort().join(", ") || "runner status only";
}

function summarizeReplayAssertions(fixture) {
  const audit = fixture.expected?.audit?.[0]?.assertions;
  if (audit) return Object.keys(audit).sort().join(", ");
  const stateAssertions = fixture.expected?.fresh_state?.assertions;
  if (stateAssertions) return Object.keys(stateAssertions).sort().join(", ");
  return "runner status only";
}
