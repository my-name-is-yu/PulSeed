# Database-First State Ownership

Status: implementation ownership map for the database-first durable state refactor.

PulSeed's durable internal state is owned by typed SQLite stores. Legacy JSON,
JSONL, lock-file, and whole-file mutation surfaces are compatibility inputs for
explicit migration or debug/export outputs, not normal runtime owners.

## Ownership Boundary

`~/.pulseed/state/pulseed-control.sqlite` owns control-plane and runtime data:

- daemon, shutdown, supervisor, queue, schedule, and schedule history state
- approvals, permission grants, wait plans, guardrails, outbox, safe pauses,
  leader locks, goal leases, and goal state write locks
- runtime operations, background runs, health snapshots, sessions, chat
  sessions, AgentLoop session state, traces, usage, compaction records, and route
  metadata
- goal, task, checkpoint, verification, pipeline, ledger, stall, runtime
  evidence, strategy, dream, reflection, plugin runtime, channel health, channel
  binding, imported plugin review, and runtime asset registry rows
- operator handoffs, runtime budgets, experiment queues, capability
  verification/audit refs, browser automation sessions, runtime auth handoffs,
  proactive intervention events, curiosity runtime state, trust runtime state,
  ethics logs, and relationship-profile proposal workflow state
- schema version, migration history, and legacy import bookkeeping

`~/.pulseed/state/pulseed-memory.sqlite` and Soil-owned SQLite storage own memory,
knowledge, learning, relationship-profile, and projection metadata where those
records belong to the companion runtime rather than a user export.

Configuration stays file-backed:

- provider, daemon, notification, gateway/channel, datasource, hook, and MCP
  server config
- character configuration
- credentials and auth files
- plugin manifests and package metadata

Real user and workspace content stays file-backed:

- Git checkouts, user workspaces, task deliverables, exported reports, debug
  exports, reproducibility artifacts, package files, and repository files
- relationship profile content that is explicitly authored or approved by the
  user

## Migration Boundary

`doctor --repair` is the compatibility boundary for legacy runtime state. It may
read legacy files, validate them, import typed rows, and record
`control_legacy_imports`. Normal runtime code must not silently keep legacy files
in sync with SQLite and must not fall back to legacy JSON as the authoritative
path.

Migration helpers are allowed to keep legacy filename constants so imports remain
deterministic and testable. Those helpers should be the only place that reads
legacy runtime files after the owning store has moved to SQLite.

## Current Store Owners

The database-first state slices added typed owners for these areas:

- `ControlDatabase` schema and migrations for `pulseed-control.sqlite`
- runtime operation, background run, health, projection, approval, permission,
  guardrail, outbox, lease, queue, daemon, supervisor, and schedule stores
- chat session and AgentLoop data-plane stores
- goal, task, checkpoint, verification, pipeline, ledger, DurableLoop evidence,
  negotiation log, dependency graph, stall state, runtime evidence, strategy, dream,
  reflection, knowledge, memory, learning, profile, plugin runtime, channel
  health, channel binding, foreign plugin compatibility, and runtime asset stores
- execution sessions used by `SessionManager`, session history grounding, and
  `SessionHistoryTool`

`scripts/check-database-first-legacy-stores.mjs` blocks new normal-path durable
JSON/JSONL runtime stores unless the file is a documented compatibility boundary,
config surface, workspace/export/debug artifact, or explicitly ranked follow-up
debt.

The guard keeps every allowlisted boundary machine-readable in `allowlistReport`.
Entries must be categorized as one of:

- migrate now
- migration-only input
- debug/export output
- config/secret
- workspace/user artifact
- Soil import/publish artifact
- product decision needed

`debtReport` is reserved for unresolved follow-up debt, currently categories
such as `migrate now` or `product decision needed`, or entries with an explicit
rank/slice. Final artifact, debug/export, migration-only, config, secret,
workspace, user-content, and Soil import/publish boundaries are not debt.

`node scripts/check-database-first-legacy-stores.mjs --json` emits both
`allowlistReport` and `debtReport`. New durable JSON/JSONL/lock or path-shaped
runtime owners must move to a typed store, or be recorded as product-decision
debt with a precise owner, category, and follow-up slice.

The guard also treats normal-code `StateManager.readRaw` / `StateManager.writeRaw`
calls as raw fallback boundary usage. Existing callers must be classified as one
of the categories above. Final closure leaves no `migrate now` raw callers;
allowed config/report/export callers remain visible in `allowlistReport`
without being counted as debt.

## Final Audit

Remaining known non-database file surfaces are intentionally allowlisted in the
guard so the repository can prevent new ad hoc stores while preserving an
explicit final audit list. A completed closure pass should leave `debtReport`
empty. The remaining non-debt `allowlistReport` entries are migration inputs,
config/user content, debug/export outputs, workspace artifacts, or Soil
import/publish artifacts. `StateManager.readRaw` and `StateManager.writeRaw`
route legacy logical paths through typed stores first, then reject any
unclassified fallback path outside explicit config/user-authored content and
debug/export artifact boundaries:

- `src/base/state/legacy-state-wal.ts` and
  `src/base/state/legacy-state-manager-wal-recovery.ts`: explicit legacy goal
  WAL import/repair inputs reached through `doctor --repair`; normal
  StateManager writes do not append `wal.jsonl`
- `src/base/state/legacy-archived-goal-recovery.ts`: explicit legacy archived
  goal recovery inspection; normal archive ownership is DB-backed
- `src/runtime/store/execution-session-state-migration.ts`: explicit legacy
  `sessions/*.json` and `sessions/index.json` import/validation boundary reached
  through `doctor --repair`; normal execution session create/get/end/list and
  history reads use the control DB execution session store
- `src/runtime/store/runtime-journal-state-migration.ts`: explicit legacy
  RuntimeJournal JSON and proactive `events.jsonl` import boundary reached
  through `doctor --repair`; normal operator handoff, budget, experiment queue,
  capability verification/audit, browser session, auth handoff, and proactive
  intervention event writes use control DB tables
- `src/runtime/store/curiosity-state-migration.ts`: explicit legacy
  `curiosity/state.json` import/validation boundary reached through
  `doctor --repair`; normal curiosity proposal, learning record, exploration
  timestamp, and rejection-cooldown writes use control DB tables
- `src/runtime/store/trust-state-migration.ts`,
  `src/runtime/store/ethics-log-migration.ts`, and
  `src/runtime/store/relationship-profile-proposal-state-migration.ts`:
  explicit legacy `trust/trust-store.json`, `ethics/ethics-log.json`, and
  `relationship-profile-proposals.json` import/validation boundaries reached
  through `doctor --repair`; normal trust balance/gate/override, ethics log,
  trust grounding/tool, and profile proposal workflow reads and writes use
  control DB tables
- task verifier, task lifecycle, checkpoint, strategy, current gap, wait
  metadata, and wait-deadline callers use typed `StateManager` APIs over
  control DB stores; legacy logical filename adapters remain only as
  migration/compatibility test boundaries inside the owning stores
- capability registry availability checks and capability dependency ordering use
  the typed control DB capability registry store; legacy
  `capability_registry.json` and `capability_dependencies.json` are repair
  import inputs only
- AgentLoop normal resume and trace construction use typed control DB session
  and trace stores keyed by session id; legacy `chat/agentloop/*.state.json`
  and `traces/agentloop/*.jsonl` files are explicit `doctor --repair`
  migration inputs only
- relationship profile content remains file-backed as user-authored profile
  content; character config remains file-backed as user-editable configuration
- memory lifecycle short-term entries, long-term lessons, indexes,
  statistics, and close archives use control DB tables; the old
  `memory/short-term/**`, `memory/long-term/**`, and memory persistence file
  helpers are explicit `doctor --repair` import inputs only, not normal
  runtime owners
- KnowledgeManager, dream consolidation, Soil sync, CLI memory operations, and
  user memory correction flows use direct Soil memory store APIs for
  domain/shared/agent memory; StateManager no longer routes
  `memory/*/entries.json` or `domain_knowledge.json` logical paths for normal
  callers
- dream decision heuristics use a typed control DB table; legacy
  `dream/decision-heuristics.json` is an explicit `doctor --repair` import
  input only
- dream filesystem counters in operational reports are diagnostic/export
  metrics over artifacts and legacy fixtures, not authoritative runtime state
- Soil import overlay queue and publish state, which are import/publish artifact
  surfaces rather than normal runtime owners
- goal negotiation logs and dependency graph state use the typed control DB
  `GoalOrchestrationStateStore`; legacy `goals/<id>/negotiation-log.json` and
  `dependency-graph.json` files are no longer authoritative normal runtime
  state and are explicit `doctor --repair` import inputs only
- stall detector state uses the typed control DB `StallStateStore`; legacy
  `stalls/<goalId>.json` files are no longer authoritative normal runtime
  state and are explicit `doctor --repair` import inputs only
- learning runtime logs, learned patterns, feedback entries, and structural
  feedback use the typed control DB `LearningRuntimeStateStore`; legacy
  learning files are no longer authoritative normal runtime state and are
  explicit `doctor --repair` import inputs only
- knowledge transfer snapshot and meta-pattern aggregation watermark state use
  the typed control DB `KnowledgeTransferStateStore`; legacy
  `knowledge-transfer/snapshot.json` and
  `meta-patterns/last_aggregated_at.json` files are explicit
  `doctor --repair` import inputs only
- transfer trust score, history, and index state use the typed control DB
  `TransferTrustStateStore`; legacy `transfer-trust/*.json`,
  `transfer-trust-history/*.json`, and `transfer-trust/_index.json` files are
  explicit `doctor --repair` import inputs only
- capability dependency state uses the typed control DB
  `CapabilityRegistryStateStore`; legacy `capability_dependencies.json` is an
  explicit `doctor --repair` import input only, and normal capability detection
  caller paths no longer read stale legacy files as authoritative state
- task grounding uses typed `StateManager.listTasks()` over the control DB task
  store; legacy `tasks/<goalId>/<taskId>.json` files are no longer read as
  authoritative grounding state
- character config, MCP server config, and generated reports are explicitly
  classified non-debt raw fallback boundaries; other fallback paths fail in
  normal runtime code and in the legacy-store guard

Future durable internal state must add a typed store API and schema migration.
Adding a new JSON/JSONL sidecar requires documenting why it is config,
credential, workspace content, export, debug output, or an explicit migration
fixture.
