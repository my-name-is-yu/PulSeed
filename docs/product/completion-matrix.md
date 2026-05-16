# Product Completion Scenario Matrix

> Status: Product design boundary document. This page separates current code-backed behavior from operator/debug behavior, design-only or future direction, migration/debug/export/config/workspace boundaries, and unsupported/overclaim territory.

PulSeed's product-completion boundary is the line between ordinary use and
internal machinery. Normal runtime behavior must be backed by typed contracts,
SQLite/Soil/control DB stores, deterministic tests, isolated state roots, fake
clocks, and production caller paths. Normal user-facing surfaces should show a
small user-facing projection, not raw memory, autonomy, readiness, admission,
capability catalog, policy rationale, or evidence refs. The machine-checkable
[Product Claim Ledger](claim-ledger.md) records the concrete docs claims that
were audited into current, operator/debug, design-only, boundary, or unsupported
classes.

## Boundary Classes

| Class | Meaning | Default reader treatment |
| --- | --- | --- |
| Current operating behavior | The repo has code, tests, and docs for this behavior today. | Safe to describe in README, start, operate, and reference docs. |
| Operator/debug behavior | The behavior exists for inspection, diagnostics, repair, or explicit operator commands. | Keep behind commands such as details, JSON, doctor, runtime diagnostics, logs, or operator status. |
| Design-only or future direction | The product direction is valid design material but is not a user-ready package claim. | Keep under product or design docs with a status banner. |
| Migration/debug/export/config/workspace boundary | File-backed or artifact-backed behavior is intentional and not authoritative hidden runtime state. | Keep explicit in DB-first and runtime-state docs; guard with categorized checks. |
| Unsupported/overclaim | The repo does not currently back the claim with an implementation and verification path. | Do not put in README, start, operate, or status docs as current behavior. |

## Scenario Matrix

| Scenario | Class | Current coverage | Product boundary |
| --- | --- | --- | --- |
| DB-first runtime-state ownership | Current operating behavior | `npm run check:database-first-legacy-stores`, `directFileOwnerReport`, `debtReport`, `src/interface/cli/__tests__/database-first-legacy-store-check.test.ts` | Normal durable runtime state belongs to typed SQLite/Soil/control DB stores. JSON, JSONL, lock, and sidecar files are non-debt only when categorized as config, user-authored content, workspace content, migration input, bounded IPC spool, Soil import/publish artifact, debug/export, or reproducibility artifact. |
| Memory / Soil / Knowledge truth maintenance | Current operating behavior | `src/runtime/store/__tests__/memory-truth-maintenance-store.test.ts`, `tests/replay/memory-truth-maintenance-replay.test.ts`, `tests/product-gauntlet/memory-truth-maintenance-gauntlet.test.ts`, `src/tools/query/MemoryRecallTool/__tests__/MemoryRecallTool.test.ts`, `src/tools/query/KnowledgeQueryTool/__tests__/KnowledgeQueryTool.test.ts`, `src/platform/soil/__tests__/soil-runtime-rebuild-import.test.ts`, `src/interface/cli/commands/__tests__/memory.test.ts`, `src/platform/corrections/__tests__/user-memory-operations.test.ts`, and `src/interface/cli/__tests__/database-first-legacy-store-check.test.ts` | Agent memory, domain knowledge, and shared knowledge production paths use `MemoryTruthMaintenanceStore` typed claims, evidence refs, corrections, forget tombstones, conflicts, recall records, and projection records. StateManager is a root/config/compatibility boundary for these paths. Soil projections and Runtime Event Log summaries consume the typed lifecycle, correction refs retain Event Log/RuntimeGraph linkage after projection and later owner snapshots, runtime rebuild does not reproject inactive truth from stale Soil compatibility records, active-looking entries with inactive correction state are withheld from normal recall/projection, conflicted memory is withheld from normal recall/export, and new raw memory/knowledge `StateManager.writeRaw` production writes fail the DB-first guard. |
| restart/replay equivalence | Current operating behavior | `npm run test:replay`; replay fixtures for approval restore, schedule crash replay, queue reclaim, attention blocks, session registry liveness, and gateway reply-target restoration | Fresh and restarted state must produce equivalent visible runtime outcomes through production replay boundaries. |
| stale target rejection | Current operating behavior | Golden traces for RunSpec epoch changes, origin-bound stale approval replies, runtime-control stale terminal runs, and other-conversation current-target rejection | Current/latest/selected targets are accepted only when typed state and scope evidence match the current operation. |
| duplicate queue/schedule prevention | Current operating behavior | Golden/replay fixtures for schedule crash idempotence, wait-resume retry idempotence, queue dedupe while inflight, and expired-claim reclaim | Queue and schedule execution must be idempotent across persisted state and restart paths. |
| durable personal-agent runtime spine | Current operating behavior | `tests/contracts/personal-agent-runtime.test.ts`, `src/runtime/personal-agent/*`, and Control DB migration `personal-agent-runtime-state` | Non-trivial production decisions are represented as typed decision trace records before task, run, action, notification, or other materialized effects. |
| runtime event log source-of-truth | Current operating behavior | `tests/contracts/runtime-event-log-source-of-truth.test.ts`, `tests/replay/runtime-event-log-source-of-truth-replay.test.ts`, `npm run test:product-gauntlet`, `src/runtime/store/runtime-event-log.ts`, and Control DB migration `runtime-event-log-source-of-truth` | The append-only `runtime_events` table plus RuntimeGraph linkage is the source-of-truth path for major runtime decisions, causal explanation, replay/dedupe evidence, and deterministic projection rebuilds. Current-state tables are projections, indexes, or compatibility views unless a narrower owner is explicitly documented. |
| interaction authority kernel | Current operating behavior | `npm run test:product-gauntlet`, `src/runtime/control/execution-authority-decision.ts`, `src/runtime/control/interaction-authority-store.ts`, and Control DB migration `interaction-authority-runtime-state` | Execution-adjacent caller paths share typed authority vocabulary for prepare, execute, send, notify, ask, hold, suppress, approval requirement, stale-target rejection, fail-closed decisions, memory withholding, and normal-surface projection. Direct side effects should have an authority decision or explicit projection before transport or mutation. |
| production ingress and admission traces | Current operating behavior | Caller-path trace writes from chat/gateway fail-closed paths, TUI `/start`/`/stop`, schedule wait-resume admission, cron/probe jobs, goal-trigger wakes, CLI/daemon schedule mutations, daemon/supervisor goal-run admission, and daemon goal pause/stop lifecycle commands | Ingress paths must create durable evidence before resuming work or starting new work, so a user-facing command does not bypass runtime control. |
| task, tool, and capability execution traces | Current operating behavior | Goal-gap and knowledge-gap task generation through `task_create`, task/pipeline/capability/mechanical-verification adapter execution through `run-adapter`, generic ToolExecutor pre-call admission/outcome traces, host-policy blocks, and mutating builtin-tool tests | Execution-capable paths must record what was proposed, admitted, blocked, executed, and verified rather than exposing raw authority to ordinary surfaces. |
| runtime graph and relationship-memory provenance | Current operating behavior | RuntimeGraph source-of-truth node tests, relationship-memory projection tests, SituationFrame preservation, and memory audit history | Goals, tasks, milestones, sessions, runs, process sessions, artifacts, reply targets, relationship-memory commitments, lineage, allowed/forbidden memory uses, uncertainty, lifecycle/correction state, invalidation, surface projection, and provenance stay in durable internal state. |
| replay and dedupe keys | Current operating behavior | Replay fixtures plus runtime outbox, notification suppression, schedule creation, generated task creation, ToolExecutor outcome, and migrated legacy outbox tests | Restart/replay must not duplicate notifications, schedules, tasks, or action-outcome records when the durable input has already been handled. |
| normal-surface redaction | Current operating behavior | Contract tests for product-completion surfaces, companion user-facing projection tests, chat/status tests, TUI-adjacent report tests, and secret setup redaction traces | Normal chat, gateway, CLI, status, report, and TUI-adjacent surfaces expose user-facing projections only. Raw memory, autonomy, readiness, admission, capability catalog, policy rationale, and evidence refs stay internal or operator/debug-only. |
| Telegram peer initiative authority | Current operating behavior | Product gauntlet scenarios for Telegram peer delivery, stale/wrong callback rejection, callback failure offset progress, digest-only holds, quiet-mode suppression, feedback mutation, and replay dedupe | Telegram is the current peer initiative delivery implementation. Non-Telegram peer initiative surfaces are contract-only future work unless a production caller path owns mutation and writes the same authority decision before transport. |
| first-run/package smoke | Current operating behavior | `npm run test:smoke` and `npm run verify:packaged-artifacts` packaged CLI version smoke with temp `PULSEED_HOME` | The package can be verified without real network access or provider API keys. |
| docs/current-claim truth audit | Current operating behavior | `npm run check:docs` validates the product claim ledger against README, start, operate, reference, product, and design docs | Concrete docs claims must be classified as current, operator/debug, design-only, boundary, or unsupported, and public current docs must not silently promote design-only claims into current behavior. |
| Runtime diagnostics and evidence inspection | Operator/debug behavior | `pulseed runtime ...`, `pulseed runtime situation-frame`, `pulseed runtime initiative-trace`, `pulseed runtime attention-state`, `pulseed runtime intervention-decision`, `pulseed runtime capability-decision`, `pulseed runtime runtime-graph`, `pulseed runtime graph explain`, `pulseed runtime event-log rebuild`, `pulseed runtime replay`, `pulseed runtime memory-provenance`, `pulseed doctor`, `pulseed logs`, `pulseed operator-binding-status` style projections, and `--json`/details surfaces | Raw IDs, trace IDs, event IDs, graph IDs, idempotency keys, evidence refs, readiness/admission/autonomy labels, policy details, capability decisions, memory provenance, invalidation state, RuntimeGraph lineage, projection rebuild evidence, and repair records are allowed only in explicit operator/debug surfaces. |
| Configuration, credentials, plugin manifests, gateway channel files, user-authored profiles, workspace artifacts, reports, logs, PID files, and bounded event spool payloads | Migration/debug/export/config/workspace boundary | DB-first guard allowlist and direct-file owner inventory | File-backed boundaries must remain explicit and must not become hidden authoritative runtime state. Event-spool payload files are bounded IPC payloads; EventServer/DriveSystem ingress records the production signal admission trace in the control DB before enqueue/replay. |
| GUI/mobile/visual companion workflows | Design-only or future direction | Product and design docs only | Do not describe as current package behavior. |
| Plugin marketplace UX, curated registry UX, external sensor/business-system integrations, and autonomous capability acquisition beyond current approval/compatibility gates | Design-only or future direction | Product and design docs only | Keep as product direction unless code-backed operating docs and tests exist. |
| Turnkey personal-life automation, complete OS sandboxing, or medical/financial/legal/business-decision advice | Unsupported/overclaim | README and status docs explicitly avoid these claims | Do not present as supported current behavior. |

## Gauntlet Requirements

Product-completion coverage should remain deterministic and local:

- use fake providers or scripted model clients
- use temp `PULSEED_HOME`, isolated runtime roots, and fake clocks
- block real network/API-key requirements in CI lanes
- exercise production caller paths for chat, gateway, CLI/status/report, queue,
  schedule cron/probe/goal-trigger/wait-resume wakes, TUI start/stop,
  daemon/supervisor goal-run admission, daemon pause/stop lifecycle commands, resident attention, task
  generation/execution, runtime-control, notification/runtime outbox enqueue,
  pre-commit memory correction,
  memory truth-maintenance save/correction/forget/recall/inspect/Soil/replay,
  restart/recovery, replay, and packaged artifacts
- include the Interaction Authority product gauntlet for Telegram peer delivery,
  stale callback rejection, callback failure offset progress, digest-only holds,
  ToolExecutor approval-resume old/stale/expired rejection, quiet-mode
  suppression, memory correction propagation through save/recall/inspect,
  ToolExecutor non-execution, restart/replay dedupe across peer delivery,
  runtime outbox, and memory correction, production caller-path normal-surface
  redaction, and runtime-control/schedule projection evidence before mutation
- keep docs/current-claim truth checks in `npm run check:docs`
- delete or convert weak tests only when replacement production-path evidence
  exists in the same checkout
