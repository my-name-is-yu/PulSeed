# PulSeed Test Redesign Checkpoint

Updated: 2026-05-13 00:20 JST

## Current Phase

Phase 0 complete. Phase 1 next.

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
- Test-like files covered: 781.
- Current include gaps: 1, `tests/unit/test_example.spec.ts`.
- P0 candidate traces mapped to old test blocks: 40/40.

## Old Test Block -> Replacement Trace

See `tmp/pulseed-test-redesign-replacement-map.md`. Phase 0 only maps deletion conditions; no existing tests were deleted or rewritten.

## Unclassified Test Files

0. Every test-like file has a `classification` and `target_lane` in the inventory.

## Failing Commands

None in Phase 0.

## Flake Suspects

None observed in this checkout. Integration emitted TUI output noise but exited 0.

## Deletion Pending

All legacy test deletions are pending. Phase 5 deletion is allowed only when the replacement map has trace coverage and same-checkout old/new pass evidence.

## Production Behavior Bugs

None found in Phase 0. If a production behavior bug appears later, the fix must stay minimal and be recorded here with the reason it is necessary for the test redesign.
