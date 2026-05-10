# Raw Fallback Slice 7: Capability Dependency State

- Worktree: `/Users/yuyoshimuta/Documents/dev/PulSeed-worktrees/raw-fallback-slice-7-capability-dependency-state-20260510193925`
- Branch: `codex/raw-fallback-slice-7-capability-dependency-state-20260510193925`
- Base: fresh `origin/main` at `e6100a0991f2be2bff0ca49a6fe1180efd3b5917`
- Guard at slice start: `ok=true`, `findings=0`; debt entries are Slice 7 `capability-dependencies-raw-caller` (3 matches) and Slice 8 `task-state-provider-raw-task-read` (1 match).

## Evidence

- `src/platform/observation/capability-dependencies.ts` reads and writes `capability_dependencies.json` through `StateManager.readRaw/writeRaw`.
- Capability dependency ordering is used by capability gap acquisition ordering; it belongs with the capability registry/control-plane store.
- Existing capability registry state already has a typed control DB owner in `CapabilityRegistryStateStore`.

## Plan

- Extend typed capability registry ownership with a control DB table for capability dependencies.
- Route `StateManager.readRaw/writeRaw` compatibility for `capability_dependencies.json` to the typed store.
- Update `capability-dependencies.ts` to use the typed store API directly.
- Add `doctor --repair` migration for legacy `capability_dependencies.json`.
- Add caller-path tests proving stale legacy files are not authoritative until imported.

## Implementation

- Added control DB schema version 22 with `capability_dependency_metadata` and `capability_dependency_entries`.
- Extended `CapabilityRegistryStateStore` with typed dependency APIs plus raw-path compatibility for `capability_dependencies.json`.
- Updated normal capability dependency callers to use the typed store API instead of `StateManager.readRaw/writeRaw`.
- Added `importLegacyCapabilityDependencyState` and wired it into `doctor --repair`; typed state, including an intentionally empty dependency map, retires stale legacy input.
- Expanded the database-first guard so the typed compatibility route and store logical-path parser are classified, while the old normal raw caller debt is removed.

## Validation

- `npm ci` with Node 24.15.0.
- `npx vitest run src/runtime/store/__tests__/capability-registry-state-store.test.ts` -> 1 file / 6 tests passed.
- `npx vitest run --config vitest.unit.config.ts src/base/state/__tests__/state-manager.test.ts src/platform/observation/__tests__/capability-dependency.test.ts` -> 2 files / 118 tests passed.
- `npx vitest run --config vitest.unit.config.ts src/interface/cli/__tests__/cli-doctor.test.ts` -> 1 file / 72 tests passed.
- `node scripts/check-database-first-legacy-stores.mjs --json` -> `ok=true`, `findings=0`; remaining `debtReport` only Slice 8 `task-state-provider-raw-task-read` (1 match).
- `npm run typecheck` -> passed.
- `npm run lint:boundaries` -> passed with existing warnings, 0 errors.
- `npm run build` -> passed.
- `git diff --check` -> passed.
