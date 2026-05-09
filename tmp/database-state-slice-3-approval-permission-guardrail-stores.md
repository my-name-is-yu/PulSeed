# Database-First State Refactor Slice 3

## Scope

Move approval, permission, guardrail, outbox, safe-pause, leader-lock, and goal-lease runtime ownership from scattered JSON / lock-file stores into typed `pulseed-control.sqlite` tables.

## Base

- Base branch: `origin/main`
- Worktree: `/Users/yuyoshimuta/Documents/dev/PulSeed-worktrees/database-state-slice-3-approval-permission-guardrail-stores-20260509223931`
- Branch: `codex/database-state-slice-3-approval-permission-guardrail-stores-20260509223931`

## Storage Ownership Changes

- Added control DB schema migration v3 for:
  - `approval_records`
  - `permission_grants`
  - `permission_wait_plans`
  - `outbox_records`
  - `runtime_safe_pauses`
  - `guardrail_breakers`
  - `guardrail_backpressure_snapshots`
  - `leader_locks`
  - `goal_leases`
- Rewrote the corresponding stores/managers to use typed SQLite rows as the normal runtime path.
- Kept legacy path helpers as migration source paths only.

## Migration Boundary

- Added `importLegacyRuntimeControlStateStores`.
- Legacy JSON/JSONL files are imported explicitly and recorded in `control_legacy_imports`.
- Normal stores do not fall back to legacy JSON files.

## Focused Validation

- `npm run typecheck`
- `npx vitest run src/runtime/__tests__/approval-store.test.ts src/runtime/__tests__/outbox-store.test.ts src/runtime/__tests__/permission-grant-store.test.ts src/runtime/__tests__/permission-wait-plan-store.test.ts src/runtime/__tests__/guardrail-store.test.ts src/runtime/__tests__/leader-lock-manager.test.ts src/runtime/__tests__/goal-lease-manager.test.ts src/runtime/daemon/__tests__/runner-commands-safe-pause.test.ts src/runtime/__tests__/runtime-store-basics.test.ts`
- `npx vitest run src/runtime/store/__tests__/runtime-control-state-migration.test.ts`
- `npx vitest run src/runtime/__tests__/approval-broker.test.ts src/runtime/__tests__/event-server-approval.test.ts src/interface/cli/__tests__/cli-runner.test.ts src/runtime/__tests__/watchdog.test.ts src/runtime/__tests__/daemon-runner-approval.test.ts src/runtime/control/__tests__/runtime-control-service.test.ts src/runtime/__tests__/runtime-control-result-routing.test.ts`
- `npx vitest run src/runtime/__tests__/approval-store.test.ts src/runtime/__tests__/outbox-store.test.ts src/runtime/__tests__/permission-grant-store.test.ts src/runtime/__tests__/permission-wait-plan-store.test.ts src/runtime/__tests__/guardrail-store.test.ts src/runtime/__tests__/leader-lock-manager.test.ts src/runtime/__tests__/goal-lease-manager.test.ts src/runtime/daemon/__tests__/runner-commands-safe-pause.test.ts src/runtime/__tests__/runtime-store-basics.test.ts src/runtime/store/__tests__/runtime-control-state-migration.test.ts src/runtime/__tests__/approval-broker.test.ts src/runtime/__tests__/event-server-approval.test.ts src/interface/cli/__tests__/cli-runner.test.ts src/runtime/__tests__/watchdog.test.ts src/runtime/__tests__/daemon-runner-approval.test.ts src/runtime/control/__tests__/runtime-control-service.test.ts src/runtime/__tests__/runtime-control-result-routing.test.ts`
- `npm run lint:boundaries`
- `npm run build`
- `git diff --check`

## Review

- Fresh review agent: no material blockers found.
- Review focus: normal-path legacy JSON/JSONL reads/writes, dual-write compatibility, path-shaped runtime identity, missing migration tests, missing production caller-path tests, and semantic keyword/regex/includes/title-matching bypasses.

## Current Notes

- Approval CLI no longer scans legacy approval JSON files for malformed records on the normal list path.
- Watchdog tests now seed leader state through the typed DB manager instead of writing `leader.json`.
- Safe-pause daemon command tests pass `stateManager` so runtime-root state stores resolve to the configured control DB base.
