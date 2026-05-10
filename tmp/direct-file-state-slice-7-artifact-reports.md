# Direct File State Slice 7: Artifact Reports And Reflection State

## Evidence

- Guard baseline on the fresh Slice 7 worktree reported `findings=0` and only one direct-file debt owner: `reflection-reports`.
- Existing artifact surfaces for runtime reports, manifests, postmortems, tool outputs, debug logs, pid files, and health diagnostics are already classified as artifact/workspace/debug boundaries in the inventory.
- Reflection reports are the only Slice 7 surface used as runtime input: evening catch-up reads the morning planning report before prompting.

## Plan

1. Add a typed `reflection_reports` control DB table.
2. Route morning/evening/weekly/dream runtime report persistence through a typed state store.
3. Load morning reports for evening catch-up from the typed store, not `reflections/*.json`.
4. Add a doctor/repair import for legacy `reflections/*.json` files.
5. Update guard, tests, and design docs so legacy reflection JSON is migration-only input.

## Result

- Reflection reports now persist in typed control DB state through `reflection_reports`.
- Evening catch-up reads the typed morning report, not legacy `reflections/*.json`.
- Legacy reflection report files are explicit doctor/repair import inputs through `importLegacyReflectionReportState`.
- The guard treats new normal-path reflection JSON owners as failures and only allows legacy reflection JSON in the repair import module.
- Runtime report, workspace artifact, and debug/log surfaces remain file-backed as explicit artifact/workspace/debug boundaries, not durable runtime state.

## Validation

- `nvm use 24.15.0 && npm ci`: passed
- `npx vitest run --config vitest.unit.config.ts src/reflection/__tests__/morning-planning.test.ts src/reflection/__tests__/evening-catchup.test.ts src/reflection/__tests__/weekly-review.test.ts src/reflection/__tests__/dream-consolidation.test.ts src/reflection/__tests__/reflection-report-state-store.test.ts`: passed, 32 tests
- `npx vitest run --config vitest.unit.config.ts src/interface/cli/__tests__/database-first-legacy-store-check.test.ts src/runtime/store/control-db/__tests__/control-db.test.ts`: passed, 19 tests
- Rebase rerun combined focused tests: passed, 51 tests
- GitHub Codex review P2 fixed: typed morning report prompt inclusion is bounded by byte size before evening prompt injection
- Fix rerun combined focused tests: passed, 52 tests
- CI integration failure on `fc2b6005` exposed tests that still asserted legacy `reflections/` files; updated e2e and schedule-engine coverage to assert typed reflection reports through `loadReflectionReport`.
- Integration rerun `npx vitest run --config vitest.integration.config.ts tests/e2e/dream-soil-sync.test.ts tests/e2e/phase-a-reflection.test.ts tests/e2e/phase-c-intelligence.test.ts src/runtime/__tests__/schedule-engine.test.ts`: passed, 183 tests
- `node scripts/check-database-first-legacy-stores.mjs --json`: ok=true, findings=0, `debtReport=[]`, `directFileDebtReport=[]`
- `npm run typecheck`: passed
- `npm run lint:boundaries`: passed with existing warnings, 0 errors
- `npm run build`: passed
- `git diff --check`: passed
