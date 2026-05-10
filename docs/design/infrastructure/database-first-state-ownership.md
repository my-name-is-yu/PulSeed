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
- schema version, migration history, and legacy import bookkeeping

`~/.pulseed/state/pulseed-memory.sqlite` and Soil-owned SQLite storage own memory,
knowledge, learning, relationship-profile, and projection metadata where those
records belong to the companion runtime rather than a user export.

Configuration stays file-backed:

- provider, daemon, notification, gateway/channel, datasource, hook, and MCP
  server config
- credentials and auth files
- plugin manifests and package metadata

Real user and workspace content stays file-backed:

- Git checkouts, user workspaces, task deliverables, exported reports, debug
  exports, reproducibility artifacts, package files, and repository files

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
  runtime evidence, strategy, dream, reflection, knowledge, memory, learning,
  profile, plugin runtime, channel health, channel binding, foreign plugin
  compatibility, and runtime asset stores
- execution sessions used by `SessionManager`, session history grounding, and
  `SessionHistoryTool`

`scripts/check-database-first-legacy-stores.mjs` blocks new normal-path durable
JSON/JSONL runtime stores unless the file is a documented compatibility boundary,
config surface, workspace/export/debug artifact, or existing follow-up surface.

The guard prints a classified debt report for follow-up surfaces that are still
temporarily allowlisted. Each entry must be categorized as one of:

- migrate now
- migration-only input
- debug/export output
- config/secret
- workspace/user artifact
- Soil import/publish artifact
- product decision needed

`node scripts/check-database-first-legacy-stores.mjs --json` emits the same
inventory as machine-readable `debtReport` data. New durable JSON/JSONL/lock or
path-shaped runtime owners must either move to a typed store or be added to that
report with a precise owner, category, and follow-up slice.

## Final Audit

Remaining known follow-up surfaces are intentionally allowlisted in the guard so
the repository can prevent new ad hoc stores while preserving an explicit audit
list:

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
- task verifier, task lifecycle, checkpoint, strategy, current gap, wait
  metadata, and wait-deadline callers use typed `StateManager` APIs over
  control DB stores; legacy logical filename adapters remain only as
  migration/compatibility test boundaries inside the owning stores
- capability registry availability checks used by wait strategy decisions use
  the typed control DB capability registry store; legacy
  `capability_registry.json` is a repair import input only
- `src/orchestrator/execution/agent-loop/agent-loop-session-factory.ts`:
  path-shaped AgentLoop resume option compatibility
- dream filesystem metrics and memory-persistence compatibility maps
- capability registry, curiosity, and supervisor state surfaces already called
  out as future typed-store work
- Soil import overlay queue and publish state, which are import/publish artifact
  surfaces rather than normal runtime owners

Future durable internal state must add a typed store API and schema migration.
Adding a new JSON/JSONL sidecar requires documenting why it is config,
credential, workspace content, export, debug output, or an explicit migration
fixture.
