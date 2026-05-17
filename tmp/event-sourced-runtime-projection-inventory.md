# Event-Sourced Runtime Projection Inventory

This inventory is the working classification for the event-sourced runtime projection closure.

## Classification Legend

- `event-sourced projection`: current state is derived from typed runtime events linked into RuntimeGraph.
- `narrow owner table`: a table that owns durable state directly by design, with explicit rationale.
- `compatibility/migration/debug/config/workspace boundary`: a direct write allowed because it is not runtime projection truth.
- `blocker`: a production projection/current-state write that cannot be closed in this PR, with a filed follow-up.

## Required Domains

| Domain | Classification | Notes |
| --- | --- | --- |
| Interaction authority decisions | event-sourced projection | `InteractionAuthorityStore.recordDecision()` appends `runtime-event-payload/authority-decision/v1` through `RuntimeEventLogStore` before writing `interaction_authority_decisions`. |
| Approval resume outcomes | event-sourced projection | `ToolExecutor` approval resume emits authority decisions before wait-plan resume mutation. Replay suppresses duplicate approval resumes by typed event idempotency and resume state. |
| Notification/outbox dedupe | event-sourced projection | `OutboxStore.append()` records a personal-agent notification trace before enqueue; `outbox_records` keeps the current queue/dedupe projection. |
| Peer delivery state | event-sourced projection plus narrow transport receipt owner | Telegram peer delivery/callback authority appends typed authority events. `peer_deliveries` and transport receipts remain delivery current-state projections with side-effect refs. |
| Memory correction and truth maintenance projection | narrow owner table with event-sourced projection records | `MemoryTruthMaintenanceStore` owns typed claims/corrections/tombstones/conflicts/recalls. Runtime Event Log summaries consume memory truth events and projection records; the claim tables are owner truth, not replay-derived projections. |
| Schedule wake execution | event-sourced projection | Scheduled wake production paths record personal-agent traces and rebuild `schedule_wake_execution_summary`; `schedule_entries` is the scheduler owner table. |
| Tool execution outcome | event-sourced projection | Tool admission/outcome traces and approval authority events rebuild `tool_execution_outcome_summary`; replay tests prove denied calls are not re-executed. |
| Goal/task mutation | event-sourced projection | `GoalTaskStateStore` appends `runtime-event-payload/goal-task-mutation/v1` before `goal_records` and `task_records` writes. |
| Runtime-control operation projection | event-sourced projection | `RuntimeOperationStore.save()` now appends `runtime-event-payload/runtime-control-operation/v1` and RuntimeGraph linkage before `runtime_operations` and operation audit writes. |
| Session/run/daemon status projection | narrow owner table / compatibility boundary | `background_runs`, process-session snapshots, daemon health, supervisor snapshots, and locks remain owner/status tables. They are not replay-derived normal projections in this PR. |
| Attention-led commitment candidate lifecycle | event-sourced projection | `AttentionStateStore.saveCommitmentCandidates()` now appends `runtime-event-payload/attention-commitment/v1` before `attention_commitment_candidates`. Duplicate replay keys return the existing candidate instead of overwriting newer lifecycle state. |
| Shadow-held / ask-confirmation / watching / active-care commitment transitions | event-sourced projection | `AttentionStateStore.applyCommitmentControl()` appends typed commitment lifecycle events before projection updates; rebuild exposes previous/current materialization state. |
| Commitment operation materialization refs | event-sourced projection | Commitment events include `materialization_ref` and RuntimeGraph commitment/materialization target refs; replay policy is projection-only and deduped by typed idempotency key. |
| Commitment feedback/suppression refs | event-sourced projection | Commitment lifecycle events include typed `feedback_ref`, `feedback_refs`, and `suppression_refs` in the rebuild summary. |
| Resident proactive commitment operation selection | event-sourced projection plus delivery owner tables | Replay coverage runs resident commitment selection through the production resident caller path and proves duplicate replay does not produce an extra peer operation. |
| ChatRunner/gateway commitment shadow intake | event-sourced projection | Chat shadow intake writes commitment candidates through `AttentionStateStore`; the candidate write is now event-sourced and replay-key guarded. |

## Inventory Evidence

## Rebuild / Apply Coverage

`pulseed runtime event-log rebuild` supports both trace-scoped rebuilds and whole-control-DB rebuilds. Without `--dry-run`, it records the rebuild event first, restores event-backed current-state rows for `runtime_operations` and `attention_commitment_candidates` from typed runtime event payloads, and writes deterministic projection snapshots into `runtime_event_projection_snapshots`.

Applied projection names:

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

## Guard

`npm run check:database-first-legacy-stores` now includes an event-sourced projection write guard for:

- `attention_commitment_candidates`
- `goal_records`
- `interaction_authority_decisions`
- `memory_projection_records`
- `runtime_event_projection_snapshots`
- `runtime_operations`
- `task_records`

New production writes to those tables fail unless the same module uses the Runtime Event Log append path.

## Remaining Narrow Owner Tables

- `memory_claims`, `memory_correction_refs`, `memory_forget_tombstones`, `memory_conflict_sets`, and `memory_recall_records`: memory truth owner tables from #1998.
- `schedule_entries` and `schedule_run_history`: scheduler owner/history tables; wake execution summaries are rebuildable from events.
- `background_runs`, `runtime_health_records`, daemon/supervisor/process-session snapshots, leases, and locks: runtime status/coordination owners, not projection truth for visible side effects.
- `permission_wait_plans` and `approval_records`: approval/wait owner tables; resume outcomes are event-sourced through authority decisions.
- `peer_initiatives`, `peer_deliveries`, and peer feedback/calibration tables: delivery and feedback current-state owners; visible delivery authority is event-sourced.
