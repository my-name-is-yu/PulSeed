# Living Autonomy Direct-Path Inventory

Status: Slice 0 inventory for the non-GUI Living-Feeling Autonomy foundation.

This inventory classifies the current paths that can start work, speak, notify,
enqueue, or execute before the full attention loop is wired end-to-end. The
machine-readable source is `src/runtime/attention/direct-path-inventory.ts`, and
`src/runtime/attention/__tests__/direct-path-inventory.test.ts` keeps the
classification complete.

## Classification Rules

- `already_user_authorized_existing_behavior`: explicit user-created or
  user-directed behavior that exists today and is preserved for compatibility.
- `convert_to_attention_operationplan_admission`: must move through
  `AttentionInput`, urge/agenda, inhibition, initiative gate, admitted outcome,
  and delivery or execution boundary before outward effects.
- `quarantine_until_attention`: must not run until the attention boundary exists.
- `explicitly_out_of_scope`: outside this non-GUI foundation.

Outward effects are `speak`, `notify`, `enqueue`, `execute`, and `start_work`.
The inventory separates current direct effects from the allowed pre-gate policy.
For non-exception paths, allowed pre-gate behavior is limited to
`internal_signal` and `quiet_audit`. When current runtime code still does more
than that, the row carries explicit current debt.

## Current Paths

| Path | Classification | Current Direct Effects | Allowed Before Admission | Current Debt |
| --- | --- | --- | --- | --- |
| `schedule.goal_trigger` | already user-authorized existing behavior | start work, execute, quiet audit | start work, execute, quiet audit | none |
| `schedule.wait_resume` | convert to attention / OperationPlan / admission | internal signal, quiet audit | internal signal, quiet audit | none |
| `schedule.cron_probe_notification` | already user-authorized existing behavior | notify, quiet audit | notify, quiet audit | none |
| `daemon.proactive_tick` | convert to attention / OperationPlan / admission | internal signal, quiet audit, start work | internal signal, quiet audit | proactive dispatcher can still call workful resident branches |
| `resident.curiosity` | convert to attention / OperationPlan / admission | internal signal, quiet audit, start work | internal signal, quiet audit | curiosity proposals are still generated directly from resident paths |
| `resident.proactive_maintenance` | convert to attention / OperationPlan / admission | internal signal, quiet audit, start work, enqueue | internal signal, quiet audit | idle dream maintenance can still mutate schedules through `scheduleEngine.addEntry()` |
| `gateway.outbound` | convert to attention / OperationPlan / admission | speak, notify, quiet audit | quiet audit | non-TUI adapters and WebSocket reply channels can still project chat events directly |
| `notification.outbox` | convert to attention / OperationPlan / admission | notify, enqueue, quiet audit | quiet audit | outbox delivery needs admitted delivery refs except explicit schedule exceptions |
| `runtime_control.executor` | convert to attention / OperationPlan / admission | execute, start work, quiet audit | quiet audit | resident-initiated use still needs attention outcome refs |
| `event_server.trigger_create_task` | convert to attention / OperationPlan / admission | internal signal, enqueue, start work, quiet audit | internal signal, quiet audit | trigger `create_task` writes event-spool records and goal-linked observe/wake events can activate work directly |
| `event_server.command_goal_lifecycle` | convert to attention / OperationPlan / admission | start work, enqueue, notify, quiet audit | quiet audit | goal lifecycle command envelopes and broadcasts need admission/delivery refs |
| `event_server.command_approval_response` | convert to attention / OperationPlan / admission | execute, start work, enqueue, notify, quiet audit | quiet audit | approval responses can resolve and resume held runtime work before feedback/admission refs exist |
| `event_server.command_schedule_run_now` | convert to attention / OperationPlan / admission | start work, enqueue, notify, quiet audit | quiet audit | schedule run-now command envelopes and broadcasts need admission/delivery refs |
| `event_server.command_runtime_control` | convert to attention / OperationPlan / admission | enqueue, notify, quiet audit | quiet audit | `/daemon/runtime-control` command envelopes and broadcasts need admission/delivery refs |
| `event_server.post_events` | convert to attention / OperationPlan / admission | internal signal, enqueue, start work, quiet audit | internal signal, quiet audit | `POST /events` can enqueue event-spool records and activate goal-linked events |
| `event_server.file_ingestion` | convert to attention / OperationPlan / admission | internal signal, enqueue, start work, quiet audit | internal signal, quiet audit | goal-linked event files can activate work before attention replay disposition is stored |
| `event_server.sse_outbox_broadcast` | convert to attention / OperationPlan / admission | notify, enqueue, quiet audit | quiet audit | SSE/outbox writes externally visible event-stream frames without admitted delivery refs |
| `tui_chat_gateway.direct_route` | convert to attention / OperationPlan / admission | speak, execute, quiet audit | quiet audit | direct ChatRunner events do not yet carry admitted delivery projection refs |

## Slice 0 Invariant

The allowed policy permits only explicit user-authorized exceptions to have
outward effects before the shared attention/delivery slices. Internal,
agent-origin, and unclosed user-ingress paths may write quiet audit or internal
signals, but they must require typed admission before speaking, notifying,
enqueueing, executing, or starting work.

The current direct implementation still contains legacy runtime branches, listed
as current debt above, that later slices must wire into this contract. Until
those slices land, this file and the typed inventory are the owner map and
regression guard for finding bypasses.
