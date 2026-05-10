# Slice 3: DriveSystem Schedule State

## Evidence

- Fresh worktree is based on `origin/main` at `33fa214f`.
- `src/platform/drive/drive-system.ts` still owned durable activation schedule state through `schedule/<goalId>.json`.
- Runtime event files remain in scope for Slice 4 and are not changed here.

## Plan

1. Add a typed control DB table for DriveSystem goal activation schedules.
2. Rework DriveSystem schedule read/write paths to use the typed store.
3. Keep legacy `schedule/*.json` as explicit doctor/repair import input only.
4. Update guard classification so normal runtime no longer carries schedule file debt.
5. Add caller-path coverage for activation snapshots, due/not-due behavior, schedule updates, doctor import, and daemon maintenance schedule snapshots.

## Implementation Notes

- Added `goal_drive_schedules` to the control DB as schema version 24.
- Added `DriveGoalScheduleStateStore` for normal schedule persistence.
- Updated `DriveSystem.getSchedule`, `updateSchedule`, `isScheduleDue`, and `getGoalActivationSnapshot` to use typed control DB state.
- Added `importLegacyDriveGoalScheduleState` and wired it into `doctor --repair`.
- Removed the normal runtime `DriveSystem` schedule JSON allowlist; only the explicit repair import boundary may reference legacy `schedule/*.json`.
- Left `events/*.json` and `events/archive/*.json` untouched for Slice 4.

## Validation

- `npm ci`: passed after creating the fresh worktree.
- `npx vitest run --config vitest.unit.config.ts src/platform/drive/__tests__/drive-system.test.ts src/interface/cli/__tests__/cli-doctor.test.ts src/interface/cli/__tests__/database-first-legacy-store-check.test.ts src/runtime/store/control-db/__tests__/control-db.test.ts --reporter dot`: passed, 150 tests.
- `npx vitest run --config vitest.integration.config.ts src/runtime/store/control-db/__tests__/control-db.test.ts --reporter dot`: passed, 9 tests.
- `node scripts/check-database-first-legacy-stores.mjs --json`: ok=true, findings=0; DriveSystem schedule removed from direct-file debt.
- `npm run typecheck`: passed.
- `npm run lint:boundaries`: passed with existing warnings, 0 errors.
- `npm run build`: passed.
- `git diff --check`: passed.

## Review Notes

- Fallback review found a material guard issue: `src/platform/drive/drive-system.ts` was still allowlisted for legacy schedule JSON matches.
- Fixed by removing the normal runtime `DriveSystem` schedule allowlist and adding guard regression coverage that rejects `schedule/*.json` ownership in `DriveSystem`.
