# Runtime

> Status: Current operating guide. This page describes runtime surfaces and operator boundaries for the current implementation.

This page describes the current runtime surfaces. For exact command
syntax, see [CLI Reference](../reference/cli.md).

## Entry Points

PulSeed installs the `pulseed` binary.

```bash
pulseed
```

The bare command launches the interactive TUI after provider setup. It is the
default user-facing entry point.

Stateless helpers:

```bash
pulseed --version
pulseed help
pulseed setup
```

## Runtime Surfaces

PulSeed currently exposes these surfaces:

- CLI and scriptable subcommands
- interactive TUI
- chat runner and slash commands
- daemon and runtime registry
- schedules and cron entries
- gateway channels
- plugins, skills, memory, and diagnostics

They share local state under `~/.pulseed/` unless `PULSEED_HOME` is set.

## Goal And Task Operation

Common scriptable goal flow:

```bash
pulseed goal add "Increase test coverage to 90%"
pulseed goal list
pulseed goal show <goal-id>
pulseed run --goal <goal-id>
pulseed status --goal <goal-id>
pulseed report --goal <goal-id>
pulseed task list --goal <goal-id>
```

`pulseed run --goal <id>` executes DurableLoop for one goal. Use
`--max-iterations <n>` for a bounded run or `--resident` for resident policy.
Use `--workspace <path>` when the goal should operate against a specific
workspace.

## Chat And TUI

The TUI exposes chat, progress, approvals, and runtime control in one terminal
surface. Chat turns are handled by `ChatRunner` and can use AgentLoop when the
provider/adapter supports the current route.

Supported slash-command groups:

- Session: `/help`, `/clear`, `/sessions`, `/history [id|title]`,
  `/title <title>`, `/resume [id|title]`, `/cleanup [--dry-run]`, `/compact`,
  `/context`, `/exit`
- Goals and tasks: `/status [goal-id] [--details]`, `/goals [--details]`,
  `/tasks [goal-id]`, `/task <task-id> [goal-id]`, `/track`, `/tend`
- Configuration: `/config`, `/model`, `/model <model> [effort]`,
  `/permissions`, `/plugins`
- Usage: `/usage [session|goal <goal-id>|daemon <goal-id>|schedule [24h|7d|2w]]`
- Review/session management: `/review`, `/fork [title]`, `/undo`

`/retry` is intentionally not supported yet because PulSeed does not have a
safe replay contract for the previous turn.

## Daemon

Daemon mode is the resident host for background goal work, gateway channels,
schedules, approval broadcast, runtime health, and recovery.

Common commands:

```bash
pulseed daemon start --goal <goal-id>
pulseed daemon start --goal <goal-id> --resident
pulseed daemon status
pulseed daemon ping
pulseed daemon restart
pulseed daemon stop
```

Top-level aliases are also available:

```bash
pulseed start --goal <goal-id>
pulseed stop
```

The daemon event server defaults to port `41700`. Configuration includes check
intervals, crash recovery, max concurrent goals, run policy, adaptive sleep, log
rotation, runtime root, and workspace root.

External event and trigger ingress is a production signal path. Accepted
EventServer/DriveSystem events record an `external_signal` SituationFrame,
InitiativeEvent sequence, attention transition, TaskCandidate, Capability
Registry decision, and InterventionPolicy decision before the bounded event
spool can enqueue or replay the signal.

Daemon goal activation and lifecycle control are admitted runtime paths. The
daemon goal-cycle loop records a goal-run admission trace before calling
DurableLoop; daemon goal pause/stop commands record runtime-control admission
before mutating daemon state; and supervisor mode records admission before
maintenance queues activation and again before a worker executes the queued run.
TUI `/start` and `/stop` commands record explicit-command admission before
daemon or standalone loop start/stop side effects.
These traces are diagnostic; normal daemon status output does not expose raw
trace IDs or policy internals.

## Runtime Diagnostics

Runtime diagnostics expose sessions, background runs, evidence, budgets, and
operator-facing state.

```bash
pulseed runtime sessions [--json] [--active]
pulseed runtime runs [--json] [--active] [--attention]
pulseed runtime session <id> [--json]
pulseed runtime run <id> [--json]
pulseed runtime evidence <goal-id|run-id> [--json]
pulseed runtime postmortem <goal-id|run-id> [--json]
pulseed runtime dream-review <run-id> [--json]
pulseed runtime budgets [--json]
pulseed runtime budget <id> [--json]
pulseed runtime experiment-queues [--json]
pulseed runtime experiment-queue <id> [--json]
pulseed runtime bindings [--json]
pulseed runtime proactive-quality [--json]
pulseed runtime proactive-calibration [--json]
pulseed runtime peer-initiative-capability [--json]
pulseed runtime proactive-feedback --intervention <id> --outcome accepted
pulseed runtime proactive-feedback --intervention <id> --outcome overreach --overreach-indicator too_frequent --reason "Too frequent"
pulseed runtime situation-frame <frame-id> [--json]
pulseed runtime initiative-trace <trace-or-task-run-action-ref> [--json]
pulseed runtime attention-state [--json]
pulseed runtime intervention-decision <decision-id> [--json]
pulseed runtime capability-decision <decision-id> [--json]
pulseed runtime runtime-graph <node-id-or-ref> [--json]
pulseed runtime graph explain <trace-id> [--json]
pulseed runtime event-log rebuild [--dry-run] [--trace <trace-id>] [--json]
pulseed runtime replay --trace <trace-id> [--json]
pulseed runtime memory-provenance [--json]
```

These are operator and debugging surfaces. They may expose raw IDs and
diagnostic labels that normal user-facing chat should hide by default.
`event-log rebuild --trace` is inspection-only and must be combined with
`--dry-run`; current-state apply uses the full event log with no trace filter.
`peer-initiative-capability` is the exception that deliberately narrows the
current product claim: resident peer initiative delivery is Telegram-only.

The personal-agent diagnostic commands inspect the durable decision trace:
SituationFrame, InitiativeEvent sequence, attention transitions, TaskCandidate,
Capability Registry decision, InterventionPolicy decision, RuntimeGraph
lineage, and Relationship Memory provenance/correction/invalidation/conflict
records.
They are not normal chat/status output and may include trace IDs, internal refs,
policy reasons, and memory provenance needed to answer why a decision was
allowed, held, blocked, suppressed, or confirmed.

The runtime event log is the append-only source-of-truth path for major runtime
event evidence and side-effect boundaries. The event envelope links each trace
to a causation ID, correlation ID, idempotency key, caller path, actor, source
refs, target refs, authority decision refs, RuntimeGraph refs, side-effect refs,
and typed payload schema/version. `runtime graph explain` reads those events
and RuntimeGraph edges to answer what caused the trace, what admitted or blocked
it, what it touched, whether replay/dedupe was involved, and which summary
projections can be rebuilt. `runtime event-log rebuild --dry-run`
deterministically rebuilds the current interaction-authority, approval-resume,
outbox/notification, peer-delivery, memory-correction, memory-truth,
schedule-wake, tool-outcome, runtime-control operation, and attention
commitment summaries from events plus RuntimeGraph evidence without writing a
rebuild event; without `--dry-run`, the rebuild itself is recorded as a
projection event before event-backed current-state rows are restored for
goals, tasks, interaction authority decisions, runtime-control operations, and
attention commitments, and the summaries are then applied as typed projection
snapshots. It does not rewrite side-effect queues, transport receipts, scheduler
owner/history rows, memory truth owner rows, approval wait rows, tool effects,
or live daemon/session status rows.
Goal/task mutations routed through `GoalTaskStateStore` append typed mutation
events before their current-state projection writes. Runtime-control operations
and attention-led commitment candidate lifecycle transitions use the same event
append -> RuntimeGraph link -> projection update ordering. Replays with the same
event type, idempotency key, replay policy, and side-effect ref resolve to the
already recorded runtime event and side-effect-guarded authority callers
suppress the duplicate boundary instead of executing it again. Distinct
transport/side-effect refs remain append-only outcome evidence.

The Interaction Authority Kernel is the shared contract for side-effect
authority across execution-adjacent surfaces. It records whether a caller may
prepare, execute, send, notify, ask, hold, or suppress, and it records typed
refs for target binding, channel policy, approval, feedback, quieting, delivery,
transport message, and normal-surface projection. Current Telegram peer
initiative delivery, Telegram callbacks, notification suppression, ToolExecutor
approval resume checks, ToolExecutor admission, memory correction save/recall/
inspect, and resident daemon peer delivery write or project this contract before
mutation. Runtime-control and schedule execution are current operating behavior
through PersonalAgentRuntimeStore projection evidence: they record typed
SituationFrame, TaskCandidate, CapabilityDecision, and InterventionDecision
before executor handoff, schedule data-source queries, model calls, report
generation, baseline updates, notification attempts, or daemon resident work.
Non-Telegram peer initiative surfaces are not current delivery implementations;
they are contract-only future surfaces until a production caller path owns
mutation and writes the same authority decision.

RuntimeGraph nodes with `runtime_graph_role=source_of_truth` are the durable
authority for runtime entities. Goal, task, and milestone writes update graph
authority in the same transaction as legacy query/index projections; goal/task
store mutations also append runtime events before those writes. The
runtime session registry syncs conversations, agent/coreloop/process runs,
process sessions, artifacts, reply targets, and parent/child lineage into the
graph, then reads the graph authority for diagnostic session/run snapshots.
Projection reads remain compatibility fallbacks for pre-migration databases or
unavailable graph sync. Relationship-memory audits preserve the actual
allowed/forbidden uses, uncertainty, lifecycle/correction state, surface
projection, conflicts, and provenance used by the decision. ToolExecutor
records pre-call admission and appends post-call `action_outcome`
InitiativeEvents to the same trace.

## Schedules

PulSeed schedules are managed by the ScheduleEngine. Current layers are
`heartbeat`, `probe`, `cron`, and `goal_trigger`; triggers are `cron` or
`interval`.

```bash
pulseed schedule list
pulseed schedule list --all
pulseed schedule show <id>
pulseed schedule add --preset daily_brief
pulseed schedule edit <id>
pulseed schedule pause <id>
pulseed schedule resume <id>
pulseed schedule run <id>
pulseed schedule history <id> --limit 10
pulseed schedule cost --period 7d
pulseed schedule remove <id>
pulseed schedule presets
pulseed schedule suggestions list
```

Implemented presets include `daily_brief`, `weekly_review`,
`dream_consolidation`, `soil_publish`, and `goal_probe`.

Internal wait-resume projections are hidden from `pulseed schedule list` by
default. Use `--all` when you need to inspect internal entries.

Cron/probe schedule jobs record personal-agent job-action admission before data
source queries, model calls, report generation, baseline updates, and
notification attempts. Goal-trigger schedule wakes and escalation target goals
record personal-agent goal-run admission before DurableLoop execution. Schedule
wait-resume wakes record attention-only admission before the attention
re-evaluation port runs. Schedule notification payloads are normalized into
Report-shaped records before they route through the notification interruption
decision path.

CoreLoop observation uses the `observe-goal` tool path. If ToolExecutor is
unavailable or the tool is denied/fails, the loop keeps the current goal state
and records/logs the failure boundary; it does not call the observation engine
directly from production loop preparation.

Goal-gap and knowledge-gap task generation record the candidate before the LLM
call and then materialize the concrete generated task through `task_create`
via ToolExecutor. The generated task ID is derived from the replayable typed
input, so retrying the same durable generation request returns the existing
task instead of creating a duplicate.

Task execution, pipeline-stage execution, capability-acquisition adapter work,
and adapter-backed mechanical verification use the `run-adapter` ToolExecutor
path. If admission is blocked, the tool is missing, or the tool fails before
returning an adapter result, PulSeed records a non-executed result and does not
call the adapter directly outside the `run-adapter` tool implementation.
The Capability Plane also records descriptor-backed refs for adapter, schedule,
gateway-channel, plugin, MCP, file, and runtime-control operations. Dangerous
side-effecting descriptors require authority and approval fingerprint checks
before execution; missing descriptors and direct adapter production bypasses
fail closed.

Mutating schedule commands (`add`, `edit`, `pause`, `resume`, `remove`, `run`,
and dream-suggestion `apply`) execute through the Schedule tools and
ToolExecutor admission path. Created schedule entries carry a personal-agent
replay key so a retried durable create decision returns the existing entry
instead of creating a duplicate schedule.

Runtime outbox `append` is also a production notification decision path: it
records notification interruption admission before enqueue and deduplicates
replayed notification inputs, including legacy rows that were migrated from a
schema before durable outbox dedupe keys existed. Direct outbox `save` is
restricted to explicit migration/import/debug/test seeding boundaries, not the
normal notification delivery path.

Notification do-not-disturb, cooldown, no-route, and channel-filter outcomes
are represented as durable `suppress` InterventionPolicy decisions before a
channel delivery is dropped. Mixed outcomes can therefore have both an
admission trace for delivered/plugin routes and a suppression trace for the
held channel concern.
Accepted notification channels and plugin notifier routes are represented as
gateway-channel CapabilityDescriptors before delivery. A descriptor admission
block produces a non-delivery result instead of calling the transport.

Operators can inspect descriptors with:

```bash
pulseed runtime capability explain <capability-id> [--json]
```

That command is not a normal user-facing surface; it may show rollback plans,
verification refs, credential-scope class, approval-fingerprint inputs, and
RuntimeGraph refs for debugging.

Run `npm run test:product-gauntlet` before broad authority, gateway,
notification, approval, memory-correction, or peer initiative changes. The
gauntlet uses fake providers/transports and temp `PULSEED_HOME` roots, so it
does not require real Telegram, network access, LLM calls, or user secrets. In
debug mode it writes failure artifacts under
`tmp/eval-failures/<scenario-id>/`: the scenario input, authority decision
snapshot, normal projection, operator/debug evidence, DB table summary, replay
summary, and a short candidate fix plan.

## Gateway Channels

Gateway setup configures messaging channels that forward typed envelopes into
PulSeed chat/runtime paths.

```bash
pulseed gateway setup
pulseed telegram setup
```

Core builtin gateway channel names are:

- `telegram-bot`
- `whatsapp-webhook`
- `signal-bridge`
- `discord-bot`

Slack exists as a gateway adapter/notifier surface, but it is not one of the
core builtin gateway channel names.

## Plugins, Skills, Playbooks, And Memory

Current scriptable surfaces include:

```bash
pulseed plugin list
pulseed plugin install <path|package>
pulseed plugin search <keyword>
pulseed skills list
pulseed playbook list
pulseed memory correct <kind:id> --value "Prefer concise reports"
pulseed memory forget <kind:id> --reason "No longer true"
pulseed memory retract <kind:id> --reason "Added by mistake"
pulseed memory history <kind:id>
pulseed memory export
```

User memory correction commands record the personal-agent memory-correction
trace before committing agent-memory store changes or runtime evidence-ledger
corrections, so corrected or invalidated memory cannot be applied silently.
Correction and replacement IDs are derived from the typed correction input; a
retry of the same correction updates the same durable records instead of
duplicating future memory effects.

Tool execution records a personal-agent tool admission decision after typed
tool/permission checks and before `tool.call()` runs. Tool traces are diagnostic
runtime evidence; normal chat/status output should not print raw trace IDs or
policy internals.

Soil grounding uses the same ToolExecutor admission path for production memory
reads. The previous agent-loop Soil prefetch callback path has been removed
from production task grounding.

Ordinary chat and gateway turns fail closed before model/tool execution when
the durable SituationFrame/InitiativeEvent trace cannot be written.

Foreign plugin imports are compatibility evidence until reviewed. They are not
directly runtime-loadable just because a manifest was imported.
Native plugin manifests are proposal-first too: install/import records plugin
state and descriptor proposals, but entry points are not imported by default.
Enable/run requires descriptor mapping, operator review, approval fingerprint
checks for side effects, and operation-specific verification.

## What This Page Does Not Claim

This page describes the current local runtime. It does not claim that every
future companion-agent scenario, marketplace flow, external sensor workflow, or
multi-year autonomous intervention path is implemented. Those belong in
[Product Design](../product/index.md) or design-history documents
until the current code supports them.
