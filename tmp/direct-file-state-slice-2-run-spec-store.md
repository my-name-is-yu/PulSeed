# Slice 2: RunSpec Store

## Evidence

- `origin/main` after Slice 1 still reports RunSpec direct file debt.
- `src/runtime/run-spec/store.ts` wrote `run-specs/<id>.json` with `atomicWrite` before this slice.
- Chat, TUI, and runtime handoff callers use `createRunSpecStore(stateManager)`.

## Plan

1. Add a typed control DB RunSpec table/store with schema migration.
2. Rework `RunSpecStore` to use the typed DB store for normal save/load.
3. Keep legacy `run-specs/*.json` as explicit migration/doctor input only if needed.
4. Update guard classification so normal runtime no longer has RunSpec direct-file debt.
5. Add caller-path coverage for draft/confirmation/start/cancel/update flows.

## Implementation Notes

- Added `run_spec_records` to the control DB as schema version 23.
- Replaced normal RunSpec save/load/list with the typed control DB store.
- Removed normal runtime references to `run-specs/<id>.json`; legacy files are ignored by the normal store.
- Kept the `run-specs` guard rule so any new normal runtime file owner fails unless explicitly classified as a migration/doctor boundary.
- Added `run_spec` as a runtime source-ref kind so background runs point to the typed DB record instead of a JSON artifact path.

## Validation

- `npx vitest run --config vitest.unit.config.ts src/interface/chat/__tests__/chat-runner.test.ts src/tools/runtime/__tests__/RunSpecHandoffTools.test.ts src/interface/chat/__tests__/cross-platform-session.test.ts src/interface/cli/__tests__/database-first-legacy-store-check.test.ts --reporter dot`: passed, 236 tests.
- `npx vitest run --config vitest.integration.config.ts src/runtime/run-spec/__tests__/run-spec.test.ts src/runtime/store/control-db/__tests__/control-db.test.ts --reporter dot`: passed, 34 tests.
- `node scripts/check-database-first-legacy-stores.mjs --json`: ok=true, findings=0; RunSpec removed from direct-file debt.
- `npm run typecheck`: passed.
- `npm run lint:boundaries`: passed with existing warnings, 0 errors.
- `npm run build`: passed.
- `git diff --check`: passed.

## Review Follow-up

- GitHub Codex review found that the new `conversation_id` index column used `origin.session_id` instead of `links.conversation_id`.
- Fixed the indexed value and added an integration test with distinct conversation and origin session ids.
