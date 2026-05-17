# Event-Sourced Runtime Projection Inventory

This inventory is the completeness audit for PR #2003. It is intentionally not
a defense of the first diff: every required domain is classified by replay/apply
behavior and by whether the current-state row is actually a rebuild target.

## Classification Legend

- `already event-sourced before this PR`: the production write path already
  appended a typed runtime event and RuntimeGraph linkage before this PR.
- `newly converted in this PR`: this PR added the typed event append and
  RuntimeGraph linkage before the projection/current-state write.
- `current-state apply-supported`: `pulseed runtime event-log rebuild` without
  `--dry-run` and without `--trace` deterministically restores the relevant
  current-state rows from the full `runtime_events` set and RuntimeGraph
  evidence.
- `rebuild-summary-only`: rebuild emits deterministic operator/debug summary
  snapshots, but does not rewrite current-state owner/queue/history rows.
- `true narrow owner table`: the table owns live state directly by design and is
  not hidden replay-derived projection truth.
- `remaining blocker`: a production current-state projection that should be
  event-rebuildable but is not closed.

## Required Domain Classification

| Domain / table | Event-source status | Rebuild/apply classification | Chain and rationale |
| --- | --- | --- | --- |
| `goal_records` | Already event-sourced before this PR through `GoalTaskStateStore.recordGoalTaskMutation()`. | Current-state apply-supported, newly broadened in this PR. | `GoalTaskStateStore.save/archive/delete` appends `runtime-event-payload/goal-task-mutation/v1`; the event linker writes RuntimeGraph event/target evidence; the store writes `goal_records` and goal/milestone RuntimeGraph source-of-truth nodes; apply now restores `goal_records` plus goal/milestone RuntimeGraph source-of-truth nodes from the final typed mutation event. No external side effect is replayed; repeated apply reuses the same projection rebuild event. |
| `task_records` | Already event-sourced before this PR through `GoalTaskStateStore.recordGoalTaskMutation()`. | Current-state apply-supported, newly broadened in this PR. | Task save/delete appends `runtime-event-payload/goal-task-mutation/v1`; RuntimeGraph event/target evidence is linked; the store writes `task_records` and task RuntimeGraph source-of-truth nodes; apply now restores `task_records`, task nodes, and goal-task edges from typed task mutation events. No external side effect is replayed; repeated apply is idempotent. |
| `interaction_authority_decisions` | Already event-sourced before this PR through `InteractionAuthorityStore.recordDecision()`. | Current-state apply-supported, newly broadened in this PR. | `recordDecision()` appends `runtime-event-payload/authority-decision/v1`; RuntimeGraph links authority and side-effect refs; the store writes `interaction_authority_decisions`; apply now restores the decision row from the typed authority payload. Duplicate side effects are suppressed by the authority store's side-effect-guard disposition and replay metadata. |
| `runtime_operations` | Newly converted in this PR. | Current-state apply-supported. | `RuntimeOperationStore.save()` now appends `runtime-event-payload/runtime-control-operation/v1` before the `runtime_operations` write when the operation transition is not a no-op; RuntimeGraph links source/target/projection refs; apply restores the latest terminal/current operation row from typed events. Runtime-control operation rows are projection state only, and repeated rebuild apply reuses the same projection event. |
| `attention_commitment_candidates` | Newly converted in this PR. | Current-state apply-supported. | `AttentionStateStore.saveCommitmentCandidates()` and commitment lifecycle control append `runtime-event-payload/attention-commitment/v1` before candidate projection writes; RuntimeGraph links commitment/materialization/feedback/suppression refs; apply restores the final candidate row from typed events. Replay is guarded by commitment replay keys and does not duplicate commitment materialization side effects. |
| Shadow-held / ask-confirmation / watching / active-care commitment refs | Newly converted in this PR as part of the attention commitment lifecycle event. | Current-state apply-supported for the candidate row; lifecycle/materialization/feedback/suppression summaries are rebuild-summary-only. | The current candidate row is restored from the final commitment event. Operator lifecycle summaries expose materialization, feedback, and suppression refs without replaying transport or user-visible effects. |
| Notification/outbox dedupe projection and `outbox_records` | Already event-sourced before this PR through outbox admission traces. | Rebuild-summary-only for `notification_outbox_dedupe_state`; `outbox_records` is a side-effect queue/dedupe owner, not apply-supported. | `OutboxStore.append()` records a personal-agent trace before enqueue and dedupes by correlation/payload. Rebuild derives notification/outbox dedupe state from events/RuntimeGraph. Apply intentionally does not recreate `outbox_records`; the broader apply test deletes the queue, rebuilds summaries, and proves the queue stays empty while dedupe evidence is present. Replay tests prove duplicate appends reuse the existing queue item and distinct side-effect refs stay distinct. |
| Peer delivery projection and peer delivery tables | Already event-sourced before this PR through interaction authority and peer delivery traces. | Rebuild-summary-only for `peer_delivery_state`; `peer_initiatives`, `peer_deliveries`, feedback, and calibration tables are true narrow delivery owners. | Authority decisions append event evidence before send/notify authority is recorded; RuntimeGraph links delivery/transport refs. Rebuild summarizes peer delivery state. Apply does not rewrite peer delivery owner rows because doing so would resurrect transport receipts; replay tests prove duplicate peer delivery is suppressed while distinct delivery refs remain append-only evidence. |
| Schedule wake execution projection | Already event-sourced before this PR through scheduled wake personal-agent traces. | Rebuild-summary-only for `schedule_wake_execution_summary`; `schedule_entries` and `schedule_run_history` are true scheduler owner/history tables. | Scheduled wake execution appends trace evidence with schedule refs and RuntimeGraph linkage. Rebuild summarizes wake executions. Apply does not rewrite scheduler rows because schedule ownership and due-time mutation belong to `ScheduleEngine`; replay tests prove restart/replay does not run an already-handled due wake again. |
| Tool execution outcome projection | Already event-sourced before this PR through ToolExecutor admission/outcome traces and authority decisions. | Rebuild-summary-only for `tool_execution_outcome_summary`; tool call effects are not current-state apply targets. | Tool admission/outcome appends typed trace/authority evidence before or instead of execution. Rebuild summarizes admitted/blocked/executed outcomes from events/RuntimeGraph. Apply does not rerun tools or write a tool-effect table; replay tests prove denied calls are not executed again. |
| Memory projection records and memory truth projection records | Already event-sourced before this PR through `MemoryTruthMaintenanceStore` runtime events and memory correction authority traces. | Rebuild-summary-only for `memory_correction_invalidation_summary` and `memory_truth_maintenance_summary`; memory truth tables and `memory_projection_records` are true narrow owner/projection records, not event-log apply targets. | `MemoryTruthMaintenanceStore` commits claims, correction refs, tombstones, conflict sets, recall records, and projection records transactionally, and appends `runtime-event-payload/memory-truth-maintenance/v1` evidence in that transaction. Rebuild summarizes correction invalidation and truth maintenance evidence. Apply does not rewrite memory truth rows because those owner rows are the canonical correction/tombstone state, and replaying event evidence as truth would risk reactivating stale or explicitly forgotten memory. Existing memory truth replay/product tests prove stale Soil/projection records do not override owner truth. |
| Approval resume outcomes | Already event-sourced before this PR through authority decisions and approval resume events. | Rebuild-summary-only for `approval_resume_outcomes`; `permission_wait_plans` and `approval_records` are true wait/approval owner tables. | Approval resume appends authority/resume evidence and mutates wait-plan owner state through the canonical approval path. Rebuild summarizes outcomes. Apply does not rewrite wait plans because resume ownership is state-machine-controlled; replay tests prove already-resumed approvals are not resumed twice. |
| Session/run/daemon status projections used by normal/operator surfaces | RuntimeGraph/session snapshots existed before this PR, but liveness/status rows are not event-log projections. | True narrow owner/status tables and compatibility/status boundary, not current-state apply-supported. | `background_runs`, process-session snapshots, daemon health, supervisor snapshots, leases, and locks represent live coordination and liveness. Applying them from historical events would resurrect stale liveness. Normal/operator surfaces should read the status owners or RuntimeGraph/session registry projections, not hidden event-log replay rows. Existing session-registry tests prove durable ledger records beat synthetic process projections for the same run id. |

## Current-State Apply Targets

`pulseed runtime event-log rebuild` without `--dry-run` and without `--trace`
now records the rebuild event first, then restores these event-backed
current-state rows:

- `goal_records`
- `task_records`
- goal/task/milestone RuntimeGraph source-of-truth nodes and edges
- `interaction_authority_decisions`
- `runtime_operations`
- `attention_commitment_candidates`

The apply path is deterministic over the full `runtime_events` set and
RuntimeGraph evidence, preserving event append order with a persisted
`event_sequence` when multiple source events have the same timestamp.
`event_sequence` is allocated from the `runtime_event_sequence_counter`
write-locked counter, and allocation catches up to the current maximum event
sequence if a repaired/imported row has advanced the log. It does not read
current-state projection tables as hidden truth. Trace-scoped rebuild remains
an operator/debug inspection path only;
applying current-state rows from a single trace is rejected because traces are
action-scoped and do not contain full entity history.

## Rebuild-Summary-Only Projections

These projection snapshots are deterministic operator/debug summaries. They are
not current-state row apply targets:

- `interaction_authority_summary`
- `approval_resume_outcomes`
- `notification_outbox_dedupe_state`
- `peer_delivery_state`
- `memory_correction_invalidation_summary`
- `memory_truth_maintenance_summary`
- `schedule_wake_execution_summary`
- `tool_execution_outcome_summary`
- `runtime_control_operation_summary`
- `attention_commitment_lifecycle_summary`

## Guard And Test Evidence

- `npm run check:database-first-legacy-stores` guards direct production writes
  to event-sourced projection tables:
  `attention_commitment_candidates`, `goal_records`,
  `interaction_authority_decisions`, `memory_projection_records`,
  `runtime_event_projection_snapshots`, `runtime_operations`, and
  `task_records`.
- `tests/contracts/runtime-event-log-source-of-truth.test.ts` now deletes
  `goal_records`, `task_records`, `interaction_authority_decisions`,
  `runtime_operations`, `attention_commitment_candidates`,
  `outbox_records`, and goal/task RuntimeGraph nodes, runs rebuild apply, and
  proves the five apply-supported current-state projections are restored while
  the side-effect outbox queue is not recreated.
- The same contract file proves goal re-parenting has a single current
  RuntimeGraph `parent_of` edge in the production write path and after rebuild
  apply, even if a stale parent edge is manually reintroduced before apply.
- The same contract test rejects trace-scoped current-state apply and proves
  no projection row is restored from partial trace history.
- Runtime operation contract coverage now proves same-timestamp content
  revisions append distinct event-backed revisions, exact no-op retries do not
  append duplicate operation events, and same-timestamp projection apply chooses
  the later event sequence rather than a lexicographic event ID or SQLite rowid.
- Commitment candidate contract coverage now proves same-timestamp payload
  revisions append distinct event-backed revisions, while exact no-op retries do
  not append duplicate commitment events.
- High-volume task projection coverage now proves current-state apply prunes
  stale task rows with a temp-key table instead of a large OR predicate, so
  rebuild apply does not hit SQLite expression-depth limits around large task
  histories.
- The database-first guard now requires a concrete event append API in the same
  production module before event-sourced projection writes are accepted. The
  guard parses real call expressions, so an import/reference, comment, or
  string containing an append API name no longer bypasses the guard. It also
  reports multiline SQL writes such as `INSERT`/`INTO runtime_operations`
  split across separate lines.
- `tests/replay/runtime-event-log-source-of-truth-replay.test.ts` proves replay
  does not duplicate outbox notifications, schedule runs, denied tool calls,
  peer deliveries, memory correction effects, or commitment operations while
  preserving distinct side-effect refs.
- `tests/replay/memory-truth-maintenance-replay.test.ts` and
  `tests/product-gauntlet/memory-truth-maintenance-gauntlet.test.ts` prove
  memory owner truth beats stale projection/Soil compatibility data.
- `src/runtime/session-registry/__tests__/runtime-session-registry.test.ts`
  proves durable runtime ledger records beat synthetic process projections for
  run status surfaces.

## Remaining Blockers

No domain is classified as an event-sourced current-state projection without
either apply support or an explicit owner/summary-only rationale. The
side-effect queues, transport receipts, scheduler rows, tool effects, memory
truth rows, approval wait rows, and daemon/session liveness rows are intentionally
not event-log apply targets in PR #2003.
