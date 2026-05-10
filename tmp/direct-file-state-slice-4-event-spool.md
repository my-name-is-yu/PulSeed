# Direct File State Slice 4: Event Spool

Started: 2026-05-10 23:22 JST
Base: origin/main @ 28f84556 Move DriveSystem schedules to control DB (#1853)
Branch: codex/direct-file-state-slice-4-event-spool-20260510232220
Worktree: /Users/yuyoshimuta/Documents/dev/PulSeed-worktrees/direct-file-state-slice-4-event-spool-20260510232220

## Classification

The DriveSystem/event-server `events/*.json` surface is a bounded IPC spool, not
authoritative durable runtime state. Goal/task/run ownership stays in typed
SQLite/Soil stores; event files are transient ingress envelopes used to wake,
notify, or dispatch runtime work and may be archived, quarantined, or pruned.

## Evidence

- `DriveSystem.getGoalActivationSnapshot` treats pending event files only as an
  activation signal; schedule state is already in `goal_drive_schedules`.
- `EventServer` dispatches HTTP/trigger/file events into `DriveSystem.writeEvent`
  or an envelope hook; durable runtime state is not recovered from processed
  event files.
- `EventServerFileIngestion` already had retry and failed-file quarantine. Slice
  4 centralizes the missing DriveSystem/MCP/trigger constraints.

## Change Plan

- Centralize event spool filename, size, pending-count, atomic-write, move, and
  retained-directory pruning logic in `src/base/utils/event-spool.ts`.
- Route DriveSystem, EventServer trigger writes, file ingestion moves, and MCP
  trigger writes through that shared boundary.
- Update guard and design docs so event files are classified as closed bounded
  IPC/spool with no Slice 4 debt.
- Add focused tests for utility invariants, DriveSystem activation/event queue
  behavior, and guard failure for unclassified event file owners.

## Validation

- `npm ci`: passed.
- `npx vitest run --config vitest.unit.config.ts src/base/utils/__tests__/event-spool.test.ts src/platform/drive/__tests__/drive-system.test.ts src/interface/cli/__tests__/database-first-legacy-store-check.test.ts --reporter dot`: passed, 85 tests.
- `npx vitest run --config vitest.integration.config.ts src/runtime/__tests__/event-file-watcher.test.ts src/runtime/__tests__/trigger-api.test.ts src/runtime/__tests__/event-server.test.ts --reporter dot`: passed, 92 tests.
- `node scripts/check-database-first-legacy-stores.mjs --json`: ok=true, findings=0; event spool is non-debt bounded IPC with `nextSlice: null`.
- `npm run typecheck`: passed.
- `npm run lint:boundaries`: passed with existing warnings, 0 errors.
- `git diff --check`: passed.
- PR #1858 CI follow-up: fixed MCP trigger explicit filename compatibility after `unit (22)` exposed the regression.
- Post-fix focused unit tests: passed, 93 tests.
- Post-fix runtime event integration tests: passed, 92 tests.
- Post-fix guard/typecheck/lint-boundaries/diff-check: passed.
