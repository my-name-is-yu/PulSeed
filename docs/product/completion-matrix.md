# Product Completion Scenario Matrix

> Status: Product design boundary document. This page separates current code-backed behavior from operator/debug behavior, design-only or future direction, migration/debug/export/config/workspace boundaries, and unsupported/overclaim territory.

PulSeed's product-completion boundary is the line between ordinary use and
internal machinery. Normal runtime behavior must be backed by typed contracts,
SQLite/Soil/control DB stores, deterministic tests, isolated state roots, fake
clocks, and production caller paths. Normal user-facing surfaces should show a
small user-facing projection, not raw memory, autonomy, readiness, admission,
capability catalog, policy rationale, or evidence refs. The machine-checkable
[Product Claim Ledger](claim-ledger.json) records the concrete docs claims that
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
| restart/replay equivalence | Current operating behavior | `npm run test:replay`; replay fixtures for approval restore, schedule crash replay, queue reclaim, attention blocks, session registry liveness, and gateway reply-target restoration | Fresh and restarted state must produce equivalent visible runtime outcomes through production replay boundaries. |
| stale target rejection | Current operating behavior | Golden traces for RunSpec epoch changes, origin-bound stale approval replies, runtime-control stale terminal runs, and other-conversation current-target rejection | Current/latest/selected targets are accepted only when typed state and scope evidence match the current operation. |
| duplicate queue/schedule prevention | Current operating behavior | Golden/replay fixtures for schedule crash idempotence, wait-resume retry idempotence, queue dedupe while inflight, and expired-claim reclaim | Queue and schedule execution must be idempotent across persisted state and restart paths. |
| durable personal-agent runtime spine | Current operating behavior | `tests/contracts/personal-agent-runtime.test.ts`, `src/runtime/personal-agent/*`, Control DB migration `personal-agent-runtime-state`, and production caller-path trace writes from fail-closed chat/gateway, TUI `/start`/`/stop`, schedule wait-resume admission before attention re-evaluation, cron/probe job, goal-trigger wakes, CLI/daemon schedule mutations and run-now commands, daemon/supervisor goal-run admission, daemon goal pause/stop lifecycle commands, resident attention and dream-suggestion schedule application, goal-gap and knowledge-gap task generation through `task_create`, task, pipeline-stage, capability-acquisition, and mechanical-verification adapter execution through `run-adapter`, runtime-control, notifications/runtime outbox enqueue, Soil grounding through ToolExecutor admission, reflection, pre-commit memory correction, crash/restart recovery, generic ToolExecutor pre-call admission/outcome traces and host-policy blocks plus mutating builtin tools, `/tend`, `/track`, explicit CLI/TUI/MCP/daemon goal/run commands, and EventServer/DriveSystem external signal ingress | Non-trivial production decisions are represented as SituationFrame -> InitiativeEvent -> AttentionTransition -> TaskCandidate -> Capability/Intervention decision trace before task/run/action/notification/materialized effects. RuntimeGraph source-of-truth nodes cover goals, tasks, milestones, sessions, runs, process sessions, artifacts, reply targets, commitment-like relationship memory, and lineage; legacy projection tables remain compatibility/query projections. Relationship memory conflicts plus actual allowed/forbidden uses, uncertainty, lifecycle/correction state, invalidation, surface projection, and provenance are preserved in SituationFrame and memory audit history. Replay uses deterministic trace/idempotency keys so the same durable input does not create duplicate events. Runtime outbox append, notification suppression, schedule creation, generated task creation, and ToolExecutor outcomes use durable dedupe/decision keys, including migrated legacy outbox rows, so replay does not create duplicate notification, schedule, task, or action-outcome records. |
| normal-surface redaction | Current operating behavior | Contract tests for product-completion surfaces, companion user-facing projection tests, chat/status tests, TUI-adjacent report tests, and secret setup redaction traces | Normal chat, gateway, CLI, status, report, and TUI-adjacent surfaces expose user-facing projections only. Raw memory, autonomy, readiness, admission, capability catalog, policy rationale, and evidence refs stay internal or operator/debug-only. |
| first-run/package smoke | Current operating behavior | `npm run test:smoke` and `npm run verify:packaged-artifacts` packaged CLI version smoke with temp `PULSEED_HOME` | The package can be verified without real network access or provider API keys. |
| docs/current-claim truth audit | Current operating behavior | `npm run check:docs` validates the product claim ledger against README, start, operate, reference, product, and design docs | Concrete docs claims must be classified as current, operator/debug, design-only, boundary, or unsupported, and public current docs must not silently promote design-only claims into current behavior. |
| Runtime diagnostics and evidence inspection | Operator/debug behavior | `pulseed runtime ...`, `pulseed runtime situation-frame`, `pulseed runtime initiative-trace`, `pulseed runtime attention-state`, `pulseed runtime intervention-decision`, `pulseed runtime capability-decision`, `pulseed runtime runtime-graph`, `pulseed runtime memory-provenance`, `pulseed doctor`, `pulseed logs`, `pulseed operator-binding-status` style projections, and `--json`/details surfaces | Raw IDs, trace IDs, evidence refs, readiness/admission/autonomy labels, policy details, capability decisions, memory provenance, invalidation state, RuntimeGraph lineage, and repair records are allowed only in explicit operator/debug surfaces. |
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
  restart/recovery, replay, and packaged artifacts
- keep docs/current-claim truth checks in `npm run check:docs`
- delete or convert weak tests only when replacement production-path evidence
  exists in the same checkout
