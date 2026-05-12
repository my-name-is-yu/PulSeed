# PulSeed Test Redesign Checkpoint

Updated: 2026-05-13 01:10 JST

## Current Phase

Phase 7 complete. Phase 0 inventory/baseline, harness, P0 golden traces, replay fixtures, lane reclassification, deletion gate, CI gate wiring, and final verification are complete.

## Phase 0 Baseline

- `git status --short --branch`: clean before branch/edit setup; branch is `codex/test-redesign-suite`.
- `node scripts/test-changed.mjs --dry-run`: passed; clean tree selects `npm run test:unit`.
- `npm run test:unit`: passed, 525 files, 8231 tests, 3 skipped.
- `npm run test:integration`: passed, 252 files, 2644 tests, 7 skipped.

## Phase 0 Inventory

- Inventory script: `scripts/inventory-test-redesign.mjs`.
- Inventory artifact: `tmp/pulseed-test-redesign-inventory.jsonl`.
- Summary artifact: `tmp/pulseed-test-redesign-inventory-summary.json`.
- Replacement map: `tmp/pulseed-test-redesign-replacement-map.md`.
- Test-like files covered: 784 after adding contracts/golden/replay suites.
- Current include gaps: 0.
- P0 candidate traces mapped to old test blocks: 40/40.

## Phase 1 Harness

- Added deterministic fake clock, isolated state root, event recorder, scripted LLM/tool runners, artifact exporter, normalizers, golden trace runner, replay runner, and default no-network/no-real-LLM guards under `tests/harness`.
- Added `test:contracts`, `test:golden-traces`, `test:replay`, and `test:slow` scripts/configs.
- `npm run typecheck`: passed.
- `npm run test:contracts`: passed, 1 file / 7 tests.

## Phase 2 Golden Traces

- Added `tests/golden-traces/p0/fixtures.json` with all 40 planned P0 traces.
- Added `tests/golden-traces/p0-traces.test.ts`.
- `npm run test:golden-traces`: passed, 1 file / 42 tests.

## Phase 3 Replay

- Added `tests/replay/p0/fixtures.json` with state, approval, schedule, queue, attention, daemon, and chat-session replay fixtures.
- Added `tests/replay/p0-replay.test.ts`.
- `npm run test:replay`: passed, 1 file / 9 tests.

## Phase 4 Lane Reclassification

- `test:integration` now uses explicit production-boundary includes instead of broad `src/runtime/**/*.test.ts`.
- `test:smoke` is a short 4-file lane and no longer completely duplicates integration.
- `npm run test:unit`: passed, 682 files passed / 3 skipped, 9632 tests passed / 3 skipped after moving helper/store tests back to unit and moving stateful runtime boundary tests out of unit.
- `npm run test:integration`: passed, 90 files passed / 3 skipped, 1245 tests passed / 7 skipped.
- `npm run test:smoke`: passed, 4 files / 37 tests.
- `npm run test:changed` exposed that `src/runtime/__tests__/watchdog.test.ts` was still classified as unit despite exercising child runtime restarts and pid file handoff.
- Handling: lane-only classification fix. `watchdog.test.ts` is now explicitly integration/smoke, keeping it out of unit parallel execution. No production behavior changed.
- `npm run verify:release` exposed that `src/runtime/__tests__/trigger-api.test.ts` was still classified as unit despite starting `EventServer` and driving HTTP trigger ingress. The failed assertion waited for envelope-hook acceptance in a unit-parallel run.
- Handling: lane-only classification fix. EventServer/HTTP/SSE/file-watcher runtime boundary tests are now explicitly integration. No production behavior changed.
- `npm run test:changed` exposed that `src/runtime/__tests__/runtime-evidence-ledger.test.ts` still ran in unit despite large runtime state artifact/index IO. The 100/500/1000 entry append/index test timed out under the full unit lane.
- Handling: lane-only classification fix. `runtime-evidence-ledger.test.ts` is now explicitly integration because it validates runtime store artifact/index behavior. No production behavior changed.

## Phase 5 Legacy Tests

- No old tests were deleted in this pass.
- Replacement map has same-checkout evidence for each mapped P0 old test block.
- Since no deletions were performed, Phase 5 deletion gate is satisfied by non-action: every legacy test remains unless future deletion has trace and same-checkout pass evidence.

## Phase 6 CI

- Required check names remain `unit (22)` and `integration (24)`.
- `unit (22)` now includes docs/build/typecheck/lint/unit.
- `integration (24)` now includes contracts/golden/replay/smoke/integration.
- Release gate now runs docs/typecheck/lint/test:all/audit/packaged artifact verification.
- `npm audit fix` updated non-breaking transitive production dependencies for the release audit gate:
  - `fast-uri` 3.1.0 -> 3.1.2.
  - `hono` 4.12.14 -> 4.12.18.
  - `express-rate-limit` 8.3.2 -> 8.5.1.
  - `ip-address` 10.1.0 -> 10.2.0.
  - Remaining `@anthropic-ai/sdk@0.89.0` advisory is moderate and requires a breaking `npm audit fix --force`; the high-threshold release audit exits 0.

## Phase 7 Final Verification

- `npm run check:docs`: passed, 139 Markdown files.
- `npm run typecheck`: passed.
- `npm run lint:boundaries`: exited 0 with existing warnings.
- `npm run test:unit`: passed, 682 files passed / 3 skipped, 9632 tests passed / 3 skipped.
- `npm run test:contracts`: passed, 1 file / 7 tests.
- `npm run test:golden-traces`: passed, 1 file / 42 tests.
- `npm run test:replay`: passed, 1 file / 9 tests.
- `npm run test:smoke`: passed, 4 files / 37 tests.
- `npm run test:integration`: passed, 90 files passed / 3 skipped, 1245 tests passed / 7 skipped.
- `npm run test:changed`: passed; infra changes selected docs/build/unit/smoke.
- `npm run verify:release`: passed; packaged artifact verification produced `pulseed-0.6.5.tgz`.

## Old Test Block -> Replacement Trace

See `tmp/pulseed-test-redesign-replacement-map.md`. Replacement evidence is recorded; no existing tests were deleted.

## Unclassified Test Files

0. Every test-like file has a `classification` and `target_lane` in the inventory.

## Failing Commands

- Phase 1 first `npm run test:unit` exposed hidden failures in `tests/unit/test_example.spec.ts` after `tests/unit/**/*.spec.ts` was included:
  - stale import of removed `findBestDimensionMatch`.
  - outdated uncapped `applyConfidenceWeight` expectation.
- Handling: test-only correction to current typed mapping contract and capped confidence weighting. No production behavior changed.
- Current failing commands: none.
- Previously failing command:
  - `npm run test:changed` failed in `src/runtime/__tests__/watchdog.test.ts` when it ran through the unit lane after reclassification. The observed mismatch was `runtime_pid`/`pid` advancing from `20001` to `20002` plus a temporary pid-file ENOENT, consistent with a stateful process test running in the wrong lane.
  - `npm run verify:release` failed during `test:unit` in `src/runtime/__tests__/trigger-api.test.ts` because an HTTP/EventServer integration test was still in the unit lane.
  - `npm run test:changed` failed during `test:unit` in `src/runtime/__tests__/runtime-evidence-ledger.test.ts` because a large state artifact/index IO test was still in the unit lane.

## Flake Suspects

None observed in this checkout. Unit/integration emitted existing TUI output noise but exited 0.

## Deletion Pending

All legacy test deletions are pending. Phase 5 deletion is allowed only when the replacement map has trace coverage and same-checkout old/new pass evidence.

## Production Behavior Bugs

None found so far. The `tests/unit/test_example.spec.ts` failure was a previously unrun stale test contract, not a production behavior bug.
