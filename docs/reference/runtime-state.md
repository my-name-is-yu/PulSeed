# Runtime State Reference

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
  records. Nodes with `runtime_graph_role=source_of_truth` carry the
  authoritative runtime payload. Goal/task/milestone writes update graph
  authority in the same transaction as the legacy query/index projection
  tables. The session registry syncs conversations, agent/coreloop/process
  runs, process sessions, artifacts, reply targets, and parent/child lineage
  into RuntimeGraph and reads the graph authority back for session/run
  snapshots; projection reads are compatibility fallbacks for pre-migration
  databases or unavailable graph sync.
- `personal_agent_relationship_memory_audits`: memory read/withhold/correction,
  invalidation, allowed/forbidden use, uncertainty, lifecycle/correction state,
  surface projection, and conflict provenance used by production decisions.

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
