# Raw Fallback Slice 6: Transfer Trust State

- Worktree: `/Users/yuyoshimuta/Documents/dev/PulSeed-worktrees/raw-fallback-slice-6-transfer-trust-state-20260510190608`
- Branch: `codex/raw-fallback-slice-6-transfer-trust-state-20260510190608`
- Base: fresh `origin/main` at `94707dafdd11b5854522239aaf841a068cd1f5e1`
- Guard at slice start: `ok=true`, `findings=0`; debt entries are Slice 6 `transfer-trust-raw-caller` (10 matches), Slice 7 `capability-dependencies-raw-caller` (3 matches), and Slice 8 `task-state-provider-raw-task-read` (1 match).

## Evidence

- `src/platform/knowledge/transfer/transfer-trust.ts` reads/writes `transfer-trust/<domainPair>.json`, `transfer-trust-history/<domainPair>.json`, and `transfer-trust/_index.json` through `StateManager.readRaw/writeRaw`.
- `TransferTrustManager` is on production transfer candidate scoring, auto-apply, and effectiveness evaluation paths.
- Existing tests cover score updates, invalidation semantics, and simple persistence, but persistence currently exercises raw JSON fallback.

## Plan

- Add a typed control DB store for transfer trust scores, bounded history, and index entries.
- Route `StateManager.readRaw/writeRaw` compatibility for transfer trust paths to the typed store.
- Update `TransferTrustManager` to depend on the typed store API and stop using raw fallback during normal runtime.
- Add `doctor --repair` migration for legacy transfer trust score/history/index files.
- Add caller-path tests proving stale legacy files are not authoritative until imported, and preserving history-window invalidation semantics.

## Implementation

- Added `TransferTrustStateStore` over control DB schema version 21 for scores, bounded history, and index entries.
- Routed `StateManager.readRaw/writeRaw` compatibility for `transfer-trust/*.json`, `transfer-trust-history/*.json`, and `transfer-trust/_index.json` to the typed store.
- Updated `TransferTrustManager` to use the typed store port directly; normal runtime candidate scoring, auto-apply, and effectiveness evaluation no longer call raw fallback through transfer trust.
- Added `importLegacyTransferTrustState` and wired it into `doctor --repair`.
- Updated the guard and database-first ownership docs so transfer trust is a typed-store boundary and no longer Slice 6 debt.

## Validation

- `npx vitest run src/runtime/store/__tests__/transfer-trust-state-store.test.ts src/platform/knowledge/__tests__/transfer-trust.test.ts src/interface/cli/__tests__/cli-doctor.test.ts src/interface/cli/__tests__/database-first-legacy-store-check.test.ts --reporter=dot` -> 4 files / 103 tests passed.
- `npx vitest run src/platform/knowledge/__tests__/m16-integration.test.ts src/platform/knowledge/__tests__/knowledge-transfer-auto-apply.test.ts src/platform/knowledge/__tests__/knowledge-transfer-incremental.test.ts --reporter=dot` -> 3 files / 37 tests passed.
- `node scripts/check-database-first-legacy-stores.mjs --json` -> `ok=true`, `findings=0`; `transfer-trust-raw-caller` absent from `debtReport`.
- Remaining debt entries: Slice 7 `capability-dependencies-raw-caller`, Slice 8 `task-state-provider-raw-task-read`.
- `npm run typecheck` -> passed.
- `npm run lint:boundaries` -> passed with existing warnings, 0 errors.
- `npm run build` -> passed.
- `git diff --check` -> passed.
