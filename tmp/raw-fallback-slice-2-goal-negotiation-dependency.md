# Raw Fallback Slice 2: Goal Negotiation And Dependency Graph State

## Scope

- Move normal `goals/<id>/negotiation-log.json` persistence off
  `StateManager.readRaw/writeRaw`.
- Move normal `dependency-graph.json` persistence off
  `StateManager.readRaw/writeRaw`.
- Keep this slice limited to goal negotiation and dependency graph state.

## Strategy

- Add `GoalOrchestrationStateStore` backed by the control DB.
- Add control DB schema version 17 with tables for negotiation logs and the
  current dependency graph.
- Update `GoalNegotiator` and `GoalDependencyGraph` to use the typed store
  directly.
- Treat legacy files as non-authoritative for normal runtime callers.
- Add `importLegacyGoalOrchestrationState` and wire it into `doctor --repair`
  so legacy files are explicit repair/import inputs with
  `control_legacy_imports` bookkeeping.

## Raw Fallback Boundary

- Removed normal-code `StateManager.readRaw/writeRaw` callers from:
  - `src/orchestrator/goal/goal-negotiator.ts`
  - `src/orchestrator/goal/goal-dependency-graph.ts`
- Existing guard classifications remain so reintroducing raw callers in those
  owners is reported as slice-2 `migrate now` debt.

## Verification Plan

- Focused store tests for control DB persistence and legacy file absence.
- Caller-path tests through `GoalNegotiator.negotiate/getNegotiationLog`.
- Caller-path tests through `GoalDependencyGraph.addEdge/init`.
- Guard check, typecheck, boundary lint, diff check, and build.

## Review Finding Fixed

- Fresh review found a material blocker: the initial implementation moved
  normal runtime state to DB-only but did not add the explicit repair/import
  boundary required by the database-first design.
- Fixed by adding `goal-orchestration-state-migration.ts`, doctor repair wiring,
  legacy import bookkeeping, and tests proving normal runtime ignores legacy
  files while `doctor --repair` imports them.
- Fresh re-review found a second material blocker: repeated repair could
  re-import stale legacy files over newer DB state.
- Fixed by skipping sources that already have an imported
  `control_legacy_imports` record for the goal orchestration migration, and by
  adding an idempotency test that proves newer typed state is not overwritten.
- Final review found the same overwrite risk still existed for first repair
  when typed DB rows already existed but import bookkeeping did not.
- Fixed by retiring those legacy sources instead of importing them when typed
  state is already present, and by adding a regression test for first-repair
  typed-state precedence.
- GitHub CI initially found unhandled rejections in unit and integration lanes
  from existing tests that called the now-async `GoalDependencyGraph.addEdge`
  without awaiting persistence before temp directory cleanup.
- Fixed by aligning those production caller-path tests with the async API in
  session-manager, cross-goal portfolio, and milestone5 semantic E2E coverage.

## Validation Results

- `npm exec vitest -- run src/runtime/store/__tests__/goal-orchestration-state-store.test.ts src/orchestrator/goal/__tests__/goal-negotiator-negotiate.test.ts src/orchestrator/goal/__tests__/goal-dependency-graph.test.ts`
  - passed before repair import fix: 3 files, 89 tests
- `npm exec vitest -- run src/runtime/store/__tests__/goal-orchestration-state-store.test.ts src/orchestrator/goal/__tests__/goal-negotiator-negotiate.test.ts src/orchestrator/goal/__tests__/goal-dependency-graph.test.ts src/interface/cli/__tests__/database-first-legacy-store-check.test.ts`
  - passed after repair import fix: 4 files, 101 tests
- `npm exec vitest -- run src/interface/cli/__tests__/cli-doctor.test.ts`
  - passed: 1 file, 67 tests
- `npm exec vitest -- run src/interface/cli/__tests__/database-first-legacy-store-check.test.ts`
  - passed: 1 file, 10 tests
- `node scripts/check-database-first-legacy-stores.mjs --json`
  - `ok=true`, `findings=0`
  - debt remaining: slice 3 stall detector, slice 4 learning runtime, slice 5
    knowledge transfer, slice 6 transfer trust, slice 7 capability dependency,
    slice 8 task grounding raw task read
  - slice 2 `goal-negotiation-log-raw-caller` and
    `goal-dependency-graph-raw-caller` are absent from `debtReport`
- `npm run typecheck`
  - passed
- `npm run lint:boundaries`
  - passed with existing warnings, 0 errors
- `git diff --check`
  - passed
- `npm run build`
  - passed
- `npm run test:unit`
  - passed after CI fix: 508 files passed, 8001 tests passed, 3 skipped
- `npm exec vitest -- run tests/e2e/milestone5-semantic.test.ts`
  - passed after CI fix: 1 file, 17 tests
- `npm run test:integration`
  - passed after CI fix: 228 files passed, 2339 tests passed, 7 skipped
