# Runtime State Reference

> Status: Current runtime-state reference. This page separates typed store ownership from config, export, workspace, and debug files.

PulSeed stores local state under `~/.pulseed/` by default. Set `PULSEED_HOME` to
use a different root.

Common paths and boundaries:

- `provider.json`: provider, model, adapter, and native AgentLoop settings
- `.env`: optional provider environment fallback values
- `state/pulseed-control.sqlite`: control database used by current runtime
  ownership paths
- `state/pulseed-memory.sqlite` and Soil SQLite stores: typed memory,
  knowledge, retrieval, and projection metadata where enabled
- `goals/`, `tasks/`, `runtime/`, `schedule/`, and `chat/`: logical feature
  areas that may contain compatibility inputs, summaries, logs, or artifacts;
  current durable runtime truth belongs to typed stores unless a file boundary is
  explicitly documented
- `reports/`: generated goal reports and reproducibility artifacts
- `plugins/`: installed PulSeed-native plugins
- `plugins-imported-disabled/`: quarantined foreign plugin imports
- `skills/`: imported local skills
- `memory/`: memory, knowledge, and Soil projection artifacts
- `logs/`: daemon/runtime logs
- `datasources/`: configured data source records

Do not treat every file under the state root as a documented contract. Docs
only promise the documented command surfaces and high-level storage boundaries.

## State Truth Boundary

Current durable runtime state is owned by typed SQLite/Soil/control DB stores.
Legacy JSON, JSONL, lock, sidecar, and raw `StateManager` fallback paths are not
authoritative normal runtime state unless they are explicitly categorized as
configuration, user-authored content, workspace content, debug/export output,
bounded IPC spool, Soil import/publish artifact, reproducibility artifact, or
doctor/repair migration input.

Bounded event-spool files are IPC payloads, not the decision authority for
acting on a signal. EventServer and DriveSystem event ingress records the
personal-agent `external_signal` trace in the control DB before enqueue/replay.

## Memory / Soil / Knowledge Truth Maintenance

Memory truth maintenance currently stores agent memory, domain knowledge, and
shared knowledge production state in `MemoryTruthMaintenanceStore` control-DB
tables. The owner tables cover memory claims, evidence refs, correction refs,
forget tombstones, conflict sets, recall records, projection records,
procedure/preference/relationship memory records, and memory projection
metadata.

`StateManager` is a root, config, debug, import/export, migration, and
compatibility boundary for these paths. Normal production memory/knowledge
mutations do not use raw `StateManager.writeRaw` as truth. The DB-first guard
fails new production raw memory, knowledge, or Soil `StateManager.writeRaw`
callers unless they are explicitly categorized as a non-production boundary.

Correction, forget, and retract operations for agent memory use one typed
transaction that updates the correction row, replacement claim, target claim
lifecycle, forget tombstone, conflict records, recall/projection records, and
Runtime Event Log linkage. Post-transaction Soil projection for those correction
paths writes projection state without re-saving truth, so `CorrectionRef`
Runtime Event Log and RuntimeGraph refs remain owned by the transaction. Later
owner snapshots also preserve those refs when they mirror older correction
entries. If post-commit trace persistence fails for a user memory correction,
the committed truth transaction remains authoritative and the caller receives
the committed correction result.

Conflict resolution restores the selected claim's previous lifecycle and
normal-projection eligibility, while losing claims are archived and remain
withheld from normal surfaces. Domain knowledge deletion writes an empty typed
owner snapshot before tombstoning Soil compatibility records, so normal
knowledge loads cannot fall back to stale Soil rows after delete.

Recall results carry an explicit mode: `exact`,
`lexical`, `semantic`, `semantic_unavailable`, or `graph`. Semantic recall
without an embedding index returns `semantic_unavailable`; it is not reported as
a semantic result backed by lexical matching. Goal-scoped semantic knowledge
queries filter vector hits by typed domain owner scope before returning entries.

Normal projections expose active user-facing memory only. A memory entry is
normal-surface eligible only when its lifecycle status is active and
`correction_state.active` is not false. Operator/debug surfaces may show claim
IDs, evidence refs, correction refs, tombstones, conflict sets, recall mode, and
RuntimeGraph/Event Log refs.

## Runtime Event Log And RuntimeGraph

The current source-of-truth path for major runtime event evidence is the
append-only `runtime_events` control-DB table plus RuntimeGraph linkage in
`personal_agent_runtime_graph_nodes` and
`personal_agent_runtime_graph_edges`. Existing current-state tables remain
their production write projections, indexes, or compatibility views unless this
page names them as a write owner for a narrower domain. This PR adds
deterministic event-log summary rebuilds; it does not yet rewrite every legacy
projection table from replay.

Each runtime event uses the typed `runtime-event-envelope/v1` contract. The
envelope records event ID, event type, schema version, occurrence time, trace
ID, causation ID, correlation ID, idempotency key, actor, caller path, surface,
goal/task/run/session scope where available, source/target refs, authority
decision refs, RuntimeGraph refs, side-effect refs, replay policy, and a typed
payload schema/version. Payload JSON is accepted only behind typed payload
schemas such as `runtime-event-payload/personal-agent-trace/v1`,
`runtime-event-payload/authority-decision/v1`, and
`runtime-event-payload/projection-rebuild/v1`, and
`runtime-event-payload/goal-task-mutation/v1`.

Production callers that write the canonical personal-agent trace or interaction
authority path now append the event before the projection row update. That
covers ToolExecutor admission/approval resume/denial, runtime-control
pause/resume/cancel requests, schedule cron/probe/goal-trigger/wait-resume
wakes, notification/outbox enqueue and suppression decisions, Telegram peer
delivery and callback authority, memory correction/forget/recall-impact
invalidation, goal/task mutation traces already routed through the runtime
stores, daemon resident peer initiative, and gateway/chat ingress traces that
trigger runtime action. If a future caller bypasses those canonical stores, it
must either append its own typed event before side effects or be documented as a
contract-only/future surface.

RuntimeGraph edges are the causal index for those events. The current event-log
linker records `caused_by`, `decided_by`, `approved_by`, `blocked_by`,
`projected_to`, `executed_by`, `delivered_to`, `invalidated_by`, and
`deduplicated_by` where the typed refs are present. Event nodes carry
`runtime_graph_role=source_of_truth`; generic source/target/side-effect ref
nodes created by the event-log linker are causal-index nodes, not authoritative
payload replacements. Existing graph edges such as `supersedes` and `resumes`
still belong to the owning runtime stores. Replay inspection rebuilds the key
summary projections below from `runtime_events` plus RuntimeGraph evidence
instead of reading the current-state projection tables as hidden truth.
Rebuild output includes RuntimeGraph node/edge evidence for the events used as
projection input.
The event log enforces one event per event type, idempotency key, replay policy,
and side-effect ref, so replay with a new event ID returns the existing
source-of-truth event instead of creating a duplicate side-effect boundary,
while legitimate outcome events with new transport/side-effect refs remain
append-only evidence.

Rebuildable projections currently include:

- interaction authority summary
- approval resume outcomes
- notification/outbox dedupe state
- peer delivery state
- memory correction invalidation summary
- schedule wake execution summary
- tool execution outcome summary

Operator/debug inspection commands:

```bash
pulseed runtime graph explain <trace-id> [--json]
pulseed runtime event-log rebuild [--dry-run] [--trace <trace-id>] [--json]
pulseed runtime replay --trace <trace-id> [--json]
```

These commands may expose raw event IDs, graph IDs, authority refs,
idempotency keys, and internal evidence. Normal chat/status/gateway surfaces
must consume redacted projections and must not expose those internals.

## Personal-Agent Runtime Trace

The current durable personal-agent runtime trace is stored in the control DB,
not in normal chat/status output. The trace records the decision path for
non-trivial production decisions:

- `personal_agent_situation_frames`: typed SituationFrame assembled for a
  caller path.
- `personal_agent_initiative_events`: append-only InitiativeEvent sequence for
  signals, wakes, observations, candidates, policy decisions, outcomes,
  reflections, memory updates, and restart recovery.
- `personal_agent_attention_transitions`: durable attention state changes for
  observed, held, blocked, suppressed, admitted, or terminal concerns.
- `personal_agent_task_candidates`: candidate records before task/run/action or
  notification materialization.
- `personal_agent_capability_decisions` and
  `personal_agent_intervention_decisions`: Capability Registry and
  InterventionPolicy audit records.
- `personal_agent_runtime_graph_nodes` and
  `personal_agent_runtime_graph_edges`: RuntimeGraph nodes and lineage for
  goals, sessions, runs, tasks, process sessions, commitments, milestones,
  artifacts, reply targets, frames, events, candidates, decisions, and memory
  records. Event-log nodes with `runtime_graph_role=source_of_truth` carry the
  event-log source-of-truth payload; generic event-log ref nodes are causal
  index nodes. Goal/task/milestone writes update graph
  authority in the same transaction as legacy query/index projection tables.
  Goal/task mutations routed through `GoalTaskStateStore` append typed
  `goal.mutation.recorded` / `task.mutation.recorded` events before those
  projection writes, while event-log replay explains their causal relationship
  to the current projection. The session registry syncs conversations, agent/coreloop/process
  runs, process sessions, artifacts, reply targets, and parent/child lineage
  into RuntimeGraph and reads the graph authority back for session/run
  snapshots; projection reads are compatibility fallbacks for pre-migration
  databases or unavailable graph sync.
- `personal_agent_relationship_memory_audits`: memory read/withhold/correction,
  invalidation, allowed/forbidden use, uncertainty, lifecycle/correction state,
  surface projection, and conflict provenance used by production decisions.
- `interaction_authority_decisions`: unified authority decisions for
  prepare/execute/send/notify/ask/hold/suppress/callback/feedback boundaries.
  These rows connect surface, target binding, channel policy, delivery,
  transport message, approval, feedback, quieting, and normal projection refs
  before a caller performs a direct side effect.

Production callers that currently write this trace include fail-closed
chat/gateway turns, TUI turns and explicit TUI `/start`/`/stop`/goal creation
paths, CLI goal/run/improve mutation paths, MCP goal/trigger tools,
EventServer/DriveSystem external signal ingress, wait-resume attention
re-evaluation, cron/probe job, goal-trigger schedule wakes, CLI/daemon schedule
mutations and run-now commands, daemon goal-cycle admission, daemon goal
pause/stop lifecycle commands, supervisor maintenance admission, supervisor
worker admission before DurableLoop execution, resident attention/proactive
curiosity and dream-suggestion schedule application, goal-gap task generation,
task execution, runtime-control requests, notification interruption decisions,
runtime outbox enqueue, Soil grounding through ToolExecutor admission,
reflection report persistence, user memory corrections before memory-store or
evidence-ledger commit, crash/restart recovery, mutating builtin tools, generic
  ToolExecutor calls before `tool.call()` plus post-call `action_outcome`
  InitiativeEvents, host-policy blocks before `tool.call()`,
`/tend`, and `/track`.
Explicit user commands may still start work, but the diagnostic trace records
the SituationFrame and InitiativeEvent path used by the runtime before durable
goal/task/run materialization.

Goal-gap and knowledge-gap task generation materialize concrete generated tasks
through the `task_create` ToolExecutor path after the candidate trace. Task,
pipeline-stage, capability-acquisition, and adapter-backed mechanical
verification execution materialize adapter side effects only through
`run-adapter`; blocked, missing, or failed tool admission returns a
non-executed result rather than falling back to direct adapter execution.

## Interaction Authority Kernel

`ExecutionAuthorityDecision` is the common contract for execution-adjacent
authority. It separates `can_prepare`, `can_execute`, `can_send`, `can_notify`,
`can_ask`, `can_hold`, `can_suppress`, `requires_approval`, `fail_closed`,
`stale_target_rejected`, `suppressed`, and `memory_withheld`.

Production callers use this vocabulary for outbound conversations, Telegram
callback handling, peer initiative delivery, notification suppression,
ToolExecutor approval resume checks, feedback mutation, memory correction,
ToolExecutor admission, and resident daemon peer delivery. Runtime-control and
schedule wake decisions use the same authority vocabulary through durable
PersonalAgentRuntimeStore projection evidence instead of InteractionAuthorityStore
rows because their mutation owners are RuntimeOperationStore/ScheduleEngine, not
user transports. Product gauntlet coverage verifies those traces exist before
runtime-control executor handoff and before schedule data/model/report/baseline/
notification side effects.
Telegram is the current peer initiative delivery implementation. Other
surfaces remain contract-only future work unless a caller path explicitly owns
mutation and writes the same authority decision before transport.

Normal surfaces consume redacted projections. They may show ordinary user text,
delivery status, or feedback affordances, but they must not expose raw trace
IDs, source refs, evidence refs, policy internals, memory correction internals,
or capability catalogs. Operator/debug surfaces may inspect those internals
through explicit diagnostic commands or local failure artifacts such as the
product gauntlet `tmp/eval-failures/<scenario-id>/` output.

Normal user-facing surfaces should not print trace IDs, source refs, policy
internals, raw provenance, or memory correction internals. Use `pulseed runtime
situation-frame`, `pulseed runtime initiative-trace`, `pulseed runtime
attention-state`, `pulseed runtime intervention-decision`, `pulseed runtime
capability-decision`, `pulseed runtime runtime-graph`, and `pulseed runtime
memory-provenance` for diagnostic inspection.

Runtime outbox append records notification interruption admission before
enqueue, stores a durable dedupe key, and backfills legacy control-DB outbox
rows that predate the dedupe column before replay append checks. Direct outbox
`save` is enforced as an explicit migration/import/debug/test seeding boundary
and is not the production notification path.

Notification do-not-disturb, cooldown, no-route, and channel-filter outcomes
write durable `suppress` InterventionPolicy decisions before delivery is
dropped. CoreLoop observation has no production direct observation fallback:
`observe-goal` ToolExecutor denial/failure leaves the current goal state
unchanged instead of calling the observation engine directly.

Run `npm run check:database-first-legacy-stores` to verify that boundary. The
machine-readable `allowlistReport`, `debtReport`, `directFileOwnerReport`, and
`directFileDebtReport` from the guard define the current non-debt file-backed
surfaces.
