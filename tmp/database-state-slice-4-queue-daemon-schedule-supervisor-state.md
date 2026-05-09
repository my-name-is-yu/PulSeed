# Database State Slice 4: Queue, Daemon, Schedule, Supervisor State

## Target Design

Move queue, daemon lifecycle, shutdown marker, supervisor snapshot, schedule entries,
schedule history, and wait-resume schedule projections into `pulseed-control.sqlite`.
Legacy JSON files are explicit import inputs only; normal runtime callers use typed
store APIs backed by Control DB tables.

## Initial Evidence

- `JournalBackedQueue` owns `queue.json` and `queue.json.lock` in the normal daemon path.
- `daemon/persistence.ts` owns `daemon-state.json` and `shutdown-state.json`.
- `LoopSupervisor` writes and reads `supervisor-state.json`.
- `ScheduleEntryStore` owns `schedules.json` and `schedules.json.lock`.
- `ScheduleHistoryStore` owns `schedule-history.json`.
- `WaitDeadlineResolver` reads wait projections through `StateManager.readRaw("schedules.json")`.

## Implementation Plan

1. Add Control DB schema version 4 tables for queue, daemon/shutdown, supervisor,
   schedule entries, and schedule history.
2. Add typed stores and explicit legacy import helper.
3. Route normal runtime callers through typed stores without dual-write JSON.
4. Update CLI/status/doctor/read-model surfaces to read the typed stores.
5. Add migration and caller-path tests, then run typecheck, boundary lint, build,
   and focused Vitest lanes.

## Implementation Summary

- Added Control DB schema version 4 tables for queue records, daemon state,
  shutdown markers, supervisor snapshots, schedule entries, schedule DB locks,
  and schedule run history.
- Moved normal queue, daemon state, shutdown marker, supervisor, schedule entry,
  schedule history, wait projection, CLI status/doctor/usage, and Soil projection
  reads/writes to typed Control DB stores.
- Kept legacy JSON file names isolated to explicit import/migration helpers and
  compatibility constructor arguments used only to derive runtime roots.
- Replaced schedule file lock behavior with a Control DB lease row.
- Wired legacy queue/daemon/schedule/supervisor JSON import and legacy
  `scheduled-tasks.json` migration into the explicit `doctor --repair`
  compatibility boundary.
- Added explicit queue/daemon/schedule/supervisor legacy import coverage and
  caller-path regression coverage for daemon client, daemon runner, scheduler,
  CLI, wait, ownership, and registry projections.

## Validation

- `npx vitest run src/runtime/queue/__tests__/journal-backed-queue.test.ts src/runtime/queue/__tests__/queue-claim-sweeper.test.ts src/runtime/schedule/__tests__/entry-store.test.ts src/runtime/schedule/__tests__/history.test.ts src/runtime/__tests__/schedule-engine.test.ts src/runtime/__tests__/wait-deadline-resolver.test.ts src/runtime/store/__tests__/queue-daemon-schedule-state-migration.test.ts src/runtime/__tests__/runtime-ownership.test.ts src/runtime/__tests__/daemon-client.test.ts src/runtime/__tests__/daemon-runner.test.ts src/runtime/__tests__/daemon-runner-bus.test.ts src/runtime/__tests__/daemon-runner-shutdown.test.ts src/runtime/__tests__/loop-supervisor.test.ts src/runtime/session-registry/__tests__/runtime-session-registry.test.ts src/interface/cli/__tests__/cli-daemon-status.test.ts src/interface/cli/__tests__/cli-daemon-ping.test.ts src/interface/cli/__tests__/cli-doctor.test.ts src/interface/cli/__tests__/cli-usage.test.ts src/interface/chat/__tests__/chat-runner-state.test.ts` passed, 19 files / 397 tests.
- `npx vitest run src/runtime/daemon/__tests__/runtime-root.test.ts src/runtime/__tests__/event-server.test.ts src/interface/cli/__tests__/cli-daemon-status.test.ts src/interface/cli/__tests__/cli-doctor.test.ts` passed, 4 files / 135 tests.
- `npm run test:integration -- src/runtime/daemon/__tests__/runtime-root.test.ts` passed, 5 tests.
- `npx vitest run src/runtime/queue/__tests__/journal-backed-queue.test.ts src/runtime/queue/__tests__/queue-claim-sweeper.test.ts src/runtime/schedule/__tests__/entry-store.test.ts src/runtime/schedule/__tests__/history.test.ts src/runtime/__tests__/schedule-engine.test.ts src/runtime/__tests__/wait-deadline-resolver.test.ts src/runtime/store/__tests__/queue-daemon-schedule-state-migration.test.ts src/runtime/__tests__/runtime-ownership.test.ts src/runtime/__tests__/daemon-client.test.ts src/runtime/__tests__/daemon-runner.test.ts src/runtime/__tests__/daemon-runner-bus.test.ts src/runtime/__tests__/daemon-runner-shutdown.test.ts src/runtime/__tests__/loop-supervisor.test.ts src/runtime/session-registry/__tests__/runtime-session-registry.test.ts src/interface/cli/__tests__/cli-daemon-status.test.ts src/interface/cli/__tests__/cli-daemon-ping.test.ts src/interface/cli/__tests__/cli-doctor.test.ts src/interface/cli/__tests__/cli-usage.test.ts src/interface/chat/__tests__/chat-runner-state.test.ts src/runtime/daemon/__tests__/runtime-root.test.ts src/runtime/__tests__/event-server.test.ts` passed, 21 files / 456 tests after latest startup-path fix.
- `npx vitest run src/runtime/queue/__tests__/journal-backed-queue.test.ts src/runtime/queue/__tests__/queue-claim-sweeper.test.ts src/runtime/schedule/__tests__/entry-store.test.ts src/runtime/schedule/__tests__/history.test.ts src/runtime/__tests__/schedule-engine.test.ts src/runtime/__tests__/wait-deadline-resolver.test.ts src/runtime/store/__tests__/queue-daemon-schedule-state-migration.test.ts src/runtime/__tests__/runtime-ownership.test.ts src/runtime/__tests__/daemon-client.test.ts src/runtime/__tests__/daemon-runner.test.ts src/runtime/__tests__/daemon-runner-bus.test.ts src/runtime/__tests__/daemon-runner-shutdown.test.ts src/runtime/__tests__/loop-supervisor.test.ts src/runtime/session-registry/__tests__/runtime-session-registry.test.ts src/interface/cli/__tests__/cli-daemon-status.test.ts src/interface/cli/__tests__/cli-daemon-ping.test.ts src/interface/cli/__tests__/cli-doctor.test.ts src/interface/cli/__tests__/cli-usage.test.ts src/interface/chat/__tests__/chat-runner-state.test.ts src/runtime/daemon/__tests__/runtime-root.test.ts src/runtime/__tests__/event-server.test.ts src/platform/soil/__tests__/soil-runtime-rebuild-import.test.ts src/platform/soil/__tests__/soil-projections.test.ts` passed, 23 files / 462 tests after rebase and DB-backed Soil provenance fix.
- `npm run test:integration -- src/runtime/__tests__/daemon-client.test.ts` passed, 19 tests.
- `npm run typecheck` passed.
- `npm run lint:boundaries` passed with existing warnings, 0 errors.
- `npm run build` passed.
- `git diff --check` passed.
- `npx vitest run src/interface/cli/__tests__/cli-doctor.test.ts` passed, 57 tests, after fixing custom runtime-root repair import coverage.
- `npx vitest run src/runtime/store/__tests__/queue-daemon-schedule-state-migration.test.ts` passed, 3 tests, after adding stale legacy overwrite protection and invalid-source retry coverage.
- `npx vitest run src/interface/cli/__tests__/cli-doctor.test.ts src/runtime/store/__tests__/queue-daemon-schedule-state-migration.test.ts` passed, 2 files / 60 tests.
- `npx vitest run src/runtime/__tests__/daemon-runner.test.ts` passed, 34 tests, after asserting startup persists `runtime_root`.
- `npx vitest run src/platform/soil/__tests__/soil-runtime-rebuild-import.test.ts src/platform/soil/__tests__/soil-projections.test.ts` passed, 2 files / 6 tests, after changing schedule Soil projection provenance to typed Control DB references.

## Review Notes

- Initial review found the explicit legacy import helper was not wired into a
  production caller path. Fixed by routing legacy imports through `doctor --repair`
  and adding CLI repair coverage that imports legacy queue and schedule state.
- Re-review found legacy `scheduled-tasks.json` migration had no production caller
  and runtime-ownership tests still seeded supervisor JSON. Fixed by routing legacy
  cron migration through `doctor --repair`, recording the migration in the Control
  DB legacy import ledger, and updating runtime-ownership tests to seed
  `SupervisorStateStore`.
- Final review found daemon-client integration still seeded legacy daemon JSON.
  Fixed by moving `isDaemonRunning` tests to `DaemonStateStore` fixtures and
  keeping invalid persisted-state coverage through a raw Control DB row.
- Follow-up review found event snapshots derived the Control DB base from the
  event directory string, daemon status/doctor re-derived runtime root from
  config instead of persisted daemon state, and runtime-root tests still seeded
  legacy daemon JSON. Fixed by adding explicit EventServer control-base wiring,
  preferring persisted daemon `runtime_root`, and updating runtime-root tests to
  use typed Control DB state and raw DB rows for malformed-state coverage.
- Final review found `doctor --repair` imported queue/supervisor legacy files
  only from the default runtime root. Fixed by resolving the repair runtime root
  from Control DB daemon state, legacy daemon-state import input, then daemon
  config, and added a CLI repair caller-path test for a configured custom
  runtime root.
- Final re-review found repeated `doctor --repair` could replay stale legacy
  JSON over authoritative Control DB rows. Fixed by making legacy import
  DB-empty-only per source, treating already-imported/blocked/retired sources
  as terminal, recording skipped stale imports as blocked, and adding a
  regression test that stale queue/daemon/shutdown/supervisor/schedule/history
  files cannot overwrite current Control DB state.
- Follow-up review found invalid-but-present legacy files were incorrectly
  recorded as terminal blocked imports even with no authoritative DB rows.
  Fixed invalid source handling to stay retryable as validated
  `invalid_legacy_source`, with a regression that malformed legacy files can be
  corrected and imported on a later repair run.
- Final startup-path review found daemon startup replaced persisted state without
  carrying `runtime_root`, breaking Control DB runtime identity. Fixed startup
  state construction to persist `context.runtimeRoot` and extended the daemon
  startup caller-path test to assert the stored runtime root.
- Rebase review found DB-backed schedule Soil projections used a `control-db:`
  provenance string that the runtime rebuild pruner still treated as a missing
  local file path. Fixed schedule Soil frontmatter to use `runtime_db` /
  `control_db` provenance, shared local-source resolution between rebuild and
  doctor, and updated the rebuild caller-path test to seed schedules through
  `ScheduleEntryStore`.
- CI broad lanes then found remaining file-era test fixtures in CLI/chat,
  schedule, daemon, and e2e coverage. Fixed those fixtures to seed typed
  Control DB stores (`ScheduleHistoryStore`, `SupervisorStateStore`,
  `DaemonStateStore`) or explicit migration helpers instead of normal-path
  JSON reads/writes.
- The safe-pause dispatcher regression also exposed a DB-first test isolation
  issue: `queue.json` and `real-queue.json` now intentionally resolve to the
  same Control DB queue for one runtime root. The default queued activation
  fixture was made explicit per test so the real dispatcher/supervisor path
  is not polluted by unrelated setup state.
- `npx vitest run src/interface/cli/__tests__/cli-runner.test.ts src/interface/cli/__tests__/runtime-command.test.ts src/interface/cli/__tests__/schedule-command.test.ts src/interface/chat/__tests__/chat-runner.test.ts src/orchestrator/strategy/__tests__/strategy-manager-phase2.test.ts tests/e2e/dream-soil-sync.test.ts tests/e2e/milestone4-daemon.test.ts tests/e2e/phase-a-scheduling.test.ts src/runtime/__tests__/daemon-runner-approval.test.ts src/runtime/daemon/__tests__/runner-commands-safe-pause.test.ts` passed, 10 files / 398 tests after CI fixture repair.
- `npm run test:unit` passed, 481 files / 7762 tests.
- `npm run test:integration` passed, 207 files / 2210 tests.
- `npm run typecheck` passed after adding the explicit daemon Control DB state guard in the approval restart test.
- `npm run lint:boundaries` passed with 621 existing warnings, 0 errors.
- `npm run build` passed.
- `git diff --check` passed.
- CI-fix review found `runner-commands-safe-pause.test.ts` still persisted
  daemon state through `daemon-state.json`. Fixed the fixture and restart
  assertion to use `DaemonStateStore`.
- `npx vitest run src/runtime/daemon/__tests__/runner-commands-safe-pause.test.ts` passed, 1 file / 6 tests after the review fix.
- `npx vitest run src/interface/cli/__tests__/cli-runner.test.ts src/interface/cli/__tests__/runtime-command.test.ts src/interface/cli/__tests__/schedule-command.test.ts src/interface/chat/__tests__/chat-runner.test.ts src/orchestrator/strategy/__tests__/strategy-manager-phase2.test.ts tests/e2e/dream-soil-sync.test.ts tests/e2e/milestone4-daemon.test.ts tests/e2e/phase-a-scheduling.test.ts src/runtime/__tests__/daemon-runner-approval.test.ts src/runtime/daemon/__tests__/runner-commands-safe-pause.test.ts` passed again, 10 files / 398 tests.
- `npm run typecheck` passed after the review fix.
- `npm run lint:boundaries` passed with 621 existing warnings, 0 errors after the review fix.
- `npm run build` passed after the review fix.
- `git diff --check` passed after the review fix.
- GitHub CI passed `unit (22)` but failed `integration (24)` because
  `daemon-runner-approval.test.ts` hit the 30s test timeout on the first
  daemon-start/approval-request/stop setup. Narrowed the test to the durable
  restart boundary by seeding the pending approval through `ApprovalStore` and
  keeping the production daemon/EventServer restore plus HTTP approval path.
- `npx vitest run --config vitest.integration.config.ts src/runtime/__tests__/daemon-runner-approval.test.ts --reporter verbose` passed, 1 file / 1 test after the CI timeout fix.
- `npx vitest run src/interface/cli/__tests__/cli-runner.test.ts src/interface/cli/__tests__/runtime-command.test.ts src/interface/cli/__tests__/schedule-command.test.ts src/interface/chat/__tests__/chat-runner.test.ts src/orchestrator/strategy/__tests__/strategy-manager-phase2.test.ts tests/e2e/dream-soil-sync.test.ts tests/e2e/milestone4-daemon.test.ts tests/e2e/phase-a-scheduling.test.ts src/runtime/__tests__/daemon-runner-approval.test.ts src/runtime/daemon/__tests__/runner-commands-safe-pause.test.ts` passed, 10 files / 398 tests after the CI timeout fix.
- `npm run test:integration` passed, 207 files / 2210 tests after the CI timeout fix.
- `npm run typecheck` passed after the CI timeout fix.
- `npm run lint:boundaries` passed with 621 existing warnings, 0 errors after the CI timeout fix.
- `npm run build` passed after the CI timeout fix.
- `git diff --check` passed after the CI timeout fix.
- Fresh review found no material blockers after the CI timeout fix.
