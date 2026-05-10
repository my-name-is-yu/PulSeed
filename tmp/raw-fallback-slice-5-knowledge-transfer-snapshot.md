# Raw Fallback Slice 5: Knowledge Transfer Snapshot

## Evidence

- Base: fresh `origin/main` at `f629ded5 Move learning runtime state to typed store (#1804)`.
- Guard state: `ok=true`, `findings=0`.
- Remaining Slice 5 debt: `knowledge-transfer-snapshot-raw-caller`, `matchCount=7`, owner `Knowledge transfer typed store / Soil transfer store`.
- Runtime raw callers are in `src/platform/knowledge/transfer/knowledge-transfer.ts` for:
  - `knowledge-transfer/snapshot.json`
  - `meta-patterns/last_aggregated_at.json`

## Classification

- `knowledge-transfer/snapshot.json`: typed-store migrate now. It is durable runtime transfer history/state.
- `meta-patterns/last_aggregated_at.json`: typed-store migrate now. It is durable runtime aggregation watermark state.
- Legacy files remain migration-only inputs through `doctor --repair`.

## Plan

- Add a typed `KnowledgeTransferStateStore` backed by the control DB.
- Route `StateManager.readRaw/writeRaw` compatibility for the two legacy paths to typed store methods.
- Move `KnowledgeTransfer` persistence to the typed store port and remove normal-code raw fallback calls.
- Add a repair/import boundary for legacy snapshot and watermark files with `control_legacy_imports` bookkeeping.
- Add caller-path tests that fail if stale legacy files remain authoritative.
- Update docs and guard debt expectations so Slice 5 disappears from `debtReport`.

## Validation

- `npx vitest run src/runtime/store/__tests__/knowledge-transfer-state-store.test.ts src/platform/knowledge/__tests__/knowledge-transfer-persistence.test.ts src/platform/knowledge/__tests__/knowledge-transfer-incremental.test.ts src/platform/knowledge/__tests__/m16-integration.test.ts src/interface/cli/__tests__/cli-doctor.test.ts src/base/state/__tests__/state-manager.test.ts --reporter=dot` -> 6 files / 198 tests passed.
- `npx vitest run src/interface/cli/__tests__/database-first-legacy-store-check.test.ts --reporter=dot` -> 10 tests passed.
- `node scripts/check-database-first-legacy-stores.mjs --json` -> `ok=true`, `findings=0`; Slice 5 debt removed.
- Remaining debt entries: Slice 6 transfer trust, Slice 7 capability dependency, Slice 8 task grounding raw task read.
- `npm run typecheck` -> passed.
- `npm run lint:boundaries` -> passed with existing warnings only, 0 errors.
- `npm run build` -> passed.
- `git diff --check` -> passed.
- GitHub review found one material blocker: duplicate-slash raw paths could route through `StateManager` as knowledge-transfer paths but fail typed store exact matching and fall back to file I/O.
- Fixed by normalizing duplicate slash raw paths in `KnowledgeTransferStateStore` and adding a `StateManager` compatibility caller-path regression test.
- Post-fix focused check: `npx vitest run src/runtime/store/__tests__/knowledge-transfer-state-store.test.ts src/platform/knowledge/__tests__/knowledge-transfer-persistence.test.ts src/platform/knowledge/__tests__/knowledge-transfer-incremental.test.ts src/interface/cli/__tests__/database-first-legacy-store-check.test.ts --reporter=dot` -> 4 files / 34 tests passed.
