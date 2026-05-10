# Raw Fallback Slice 3: Stall Detection State

## Scope

- Move normal `stalls/<goalId>.json` persistence off
  `StateManager.readRaw/writeRaw`.
- Preserve escalation and recovery state semantics.
- Keep legacy stall JSON files as explicit repair/import inputs only.

## Strategy

- Add `StallStateStore` backed by the control DB.
- Add control DB schema version 18 with a dedicated `stall_states` table.
- Backfill valid existing `goal_stall_records` rows into `stall_states`
  during schema migration so the previous untyped control DB route is not lost.
- Update `StallDetector` to load/save typed stall state through the store.
- Route `StateManager.readRaw/writeRaw("stalls/<goalId>.json")` to
  `StallStateStore` instead of the old untyped goal/task raw record table.
- Update goal cleanup to delete typed stall state as well as any old legacy
  file residue.
- Add `importLegacyStallState` and wire it into `doctor --repair`.

## Raw Fallback Boundary

- Remove normal-code `StateManager.readRaw/writeRaw` callers from
  `src/platform/drive/stall-detector.ts`.
- Runtime `StallDetector` must not read stale `stalls/<goalId>.json` files as
  authoritative state.

## Verification Plan

- Store tests for DB persistence, validation, delete, and legacy import.
- Caller-path tests through `StallDetector.getStallState`,
  `incrementEscalation`, and `resetEscalation`.
- A stale legacy-file test that would fail if runtime still read raw state.
- Guard check, typecheck, boundary lint, diff check, and build.

## Validation

- `npm exec vitest -- run src/runtime/store/__tests__/stall-state-store.test.ts src/platform/drive/__tests__/stall-detector.test.ts src/interface/cli/__tests__/cli-doctor.test.ts src/interface/cli/__tests__/database-first-legacy-store-check.test.ts`
  -> 4 files / 202 tests passed.
- `node scripts/check-database-first-legacy-stores.mjs --json`
  -> `ok=true`, `findings=0`; `stall-detector-raw-caller` absent from
  `debtReport`.
- Remaining debt entries: Slice 4 learning runtime, Slice 5 knowledge
  transfer snapshot/meta-pattern, Slice 6 transfer trust, Slice 7 capability
  dependencies, Slice 8 task grounding raw task read.
- `npm run typecheck` -> passed.
- `npm run lint:boundaries` -> passed with existing warnings, 0 errors.
- `npm run build` -> passed.
- `git diff --check` -> passed.
- Fresh review agent -> no material blockers.
