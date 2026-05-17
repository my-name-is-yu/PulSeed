# Event-Sourced Runtime Projection Inventory

This inventory is the working classification for the event-sourced runtime projection closure.

## Classification Legend

- `event-sourced projection`: current state is derived from typed runtime events linked into RuntimeGraph.
- `narrow owner table`: a table that owns durable state directly by design, with explicit rationale.
- `compatibility/migration/debug/config/workspace boundary`: a direct write allowed because it is not runtime projection truth.
- `blocker`: a production projection/current-state write that cannot be closed in this PR, with a filed follow-up.

## Required Domains

| Domain | Initial status | Notes |
| --- | --- | --- |
| Interaction authority decisions | Pending inspection | Verify current owner and projection writes. |
| Approval resume outcomes | Pending inspection | Verify stale resume rejection and replay behavior. |
| Notification/outbox dedupe | Pending inspection | Verify idempotency and duplicate side-effect guard. |
| Peer delivery state | Pending inspection | Verify event/log owner vs delivery current state. |
| Memory correction and truth maintenance projection | Pending inspection | Includes #1998 surfaces. |
| Schedule wake execution | Pending inspection | Verify replay does not re-run wakes. |
| Tool execution outcome | Pending inspection | Verify replay does not re-run tools. |
| Goal/task mutation | Pending inspection | Verify current-state owner and event linkage. |
| Runtime-control operation projection | Pending inspection | Verify operation projection owner. |
| Session/run/daemon status projection | Pending inspection | Classify where relevant. |
| Attention-led commitment candidate lifecycle | Pending inspection | Includes #2000 production surface. |
| Shadow-held / ask-confirmation / watching / active-care commitment transitions | Pending inspection | Includes #2000 production surface. |
| Commitment operation materialization refs | Pending inspection | Includes #2000 production surface. |
| Commitment feedback/suppression refs | Pending inspection | Includes #2000 production surface. |
| Resident proactive commitment operation selection | Pending inspection | Includes #2000 production surface. |
| ChatRunner/gateway commitment shadow intake | Pending inspection | Includes #2000 production surface. |

## Inventory Evidence

Detailed file/table/function evidence will be filled before broad implementation.
