# Database-First Durable State Refactor - Slice 6

## Scope

Move goal, task, verification, checkpoint, pipeline, stall, and task outcome
ledger state into typed SQLite-backed ownership in `pulseed-control.sqlite`.
Keep exported reports and user-facing artifacts file-backed.

## Target Design

- `GoalTaskStateStore` owns DB-backed goal/task/DurableLoop data-plane state.
- `StateManager` remains the compatibility facade for migrated paths, but no
  longer owns migrated state as whole-file JSON or normal-path WAL replay.
- Legacy JSON inputs are imported only through explicit doctor/repair migration.
- Runtime callers that need task, pipeline, goal, or ledger projections use typed
  store APIs rather than scanning legacy directories.

## Storage Ownership Changes

- Added schema version 6 and tables for goals, goal trees, observations, gap
  history, tasks, task history, task outcome ledgers, verification results,
  checkpoints, pipelines, loop checkpoints, and stalls.
- Added `GoalTaskStateStore` and `importLegacyGoalTaskDurableLoopState()`.
- Routed CLI, MCP, chat, strategy, daemon recovery, and task outcome KPI reads
  through typed DB-backed projections.
- Stopped normal startup from replaying legacy goal WAL into runtime state.
- Kept `StateManager.readRaw()` / `writeRaw()` routing constrained to exact
  DB-owned durable paths so unrelated file-backed internal artifacts do not
  initialize the goal/task DB facade.

## Migration Boundary

- Doctor repair imports legacy goal/task/DurableLoop JSON into typed SQLite
  tables and records the import in `control_legacy_imports`.
- Doctor repair also imports legacy archived goal/task state; archived goals are
  represented as DB-owned rows rather than normal-path archive JSON reads.
- Normal runtime paths do not silently synchronize legacy JSON/JSONL stores.
- Raw path compatibility is limited to migrated StateManager facade paths and
  explicit remaining sidecar boundaries for later database-first slices.

## Review Blocker Fixes

- `goal list --archived` now loads DB-owned archived goal metadata instead of
  reading `archive/<goal>/goal/goal.json`.
- `StateManager.listArchivedGoals()` exposes only DB-owned archived goals;
  legacy archive directories remain visible through the explicit recoverability
  API used by migration/recovery.
- `StateManager.archiveGoal()` and `deleteGoal()` no longer fall back to
  legacy-only goal JSON when a goal is not present in the typed store.
- Chat `/tasks` and `/task` now use DB-backed `StateManager.listTasks()` only,
  so stale or unmigrated task JSON cannot appear in normal chat command output.
- Event-server `/snapshot`, `/goals`, and `/goals/:id` now read DB-owned goal
  and gap-history rows rather than `goals/<id>/goal.json`.
- Runtime long-run blocker detection now reads task outcome ledgers from the
  typed store instead of `tasks/<goal>/ledger/*.json`.
- `pulseed doctor` goal health now counts DB-owned active goals and treats
  legacy goal files as migration inputs rather than normal runtime state.

## Validation

- `npm run test:unit` passed: 486 files passed, 3 skipped; 7801 tests passed, 3 skipped.
- `npm run test:integration` passed: 210 files passed, 3 skipped; 2222 tests passed, 7 skipped.
- A prior full integration run after rebasing timed out once in
  `src/runtime/__tests__/daemon-runner.test.ts` for
  `initializes durable runtime state and does not create a PID file`; the
  focused rerun passed in 874ms and the subsequent full integration rerun
  passed.
- Focused blocker-fix tests passed:
  - `npx vitest run --config vitest.integration.config.ts src/runtime/__tests__/trigger-api.test.ts -t "GET /goals"`
  - `npx vitest run --config vitest.integration.config.ts src/runtime/__tests__/event-server.test.ts -t "DB-owned goal snapshot"`
  - `npx vitest run --config vitest.integration.config.ts src/runtime/__tests__/runtime-ownership.test.ts -t "active goal task blocker"`
  - `npx vitest run --config vitest.unit.config.ts src/interface/cli/__tests__/cli-doctor.test.ts -t "checkGoals"`
  - `npx vitest run --config vitest.integration.config.ts tests/e2e/phase-b-integration.test.ts -t "GET /goals"`
- `npm run typecheck` passed.
- `npm run lint:boundaries` passed with existing warnings only.
- `npm run build` passed.
- `git diff --check` passed.

## Notes

- Existing lint warning volume remains outside this slice.
- This branch was created from `origin/main` at `d140a1e1` and rebased onto the
  latest available `origin/main` before PR creation.
