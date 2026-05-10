# Raw Fallback Slice 4: Learning Runtime State

## Scope

- Move normal learning runtime persistence off `StateManager.readRaw/writeRaw`.
- Target legacy logical files:
  - `learning/<goalId>_logs.json`
  - `learning/<goalId>_patterns.json`
  - `learning/<goalId>_feedback.json`
  - `learning/<goalId>_structural_feedback.json`
- Preserve learning analysis, learned pattern, feedback, structural feedback,
  cross-goal sharing, and auto-tuning behavior.

## Strategy

- Add a typed `LearningRuntimeStateStore` backed by the control DB.
- Add control DB schema version 19 with dedicated learning runtime tables.
- Update `LearningPipeline` and `learning-feedback.ts` to use the typed store
  instead of direct raw fallback calls.
- Route compatibility `StateManager.readRaw/writeRaw("learning/...")` paths to
  the typed store for tests and old logical callers, without file durability.
- Add `importLegacyLearningRuntimeState` and wire it into `doctor --repair` so
  legacy learning JSON files are migration inputs only.

## Raw Fallback Boundary

- Normal learning runtime code must not call `StateManager.readRaw/writeRaw`.
- Stale `learning/*.json` files must not be authoritative runtime state.

## Verification Plan

- Store tests for typed DB persistence, validation, delete, compatibility raw
  routing, legacy import, idempotency, and typed-state precedence.
- Production caller-path tests through `LearningPipeline.analyzeLogs`,
  `getPatterns`, `getFeedbackEntries`, and structural feedback APIs.
- Guard check, targeted tests, typecheck, boundary lint, diff check, and build.

## Implementation Evidence

- Added `LearningRuntimeStateStore` backed by control DB schema version 19:
  `learning_experience_logs`, `learning_patterns`,
  `learning_feedback_entries`, and `learning_structural_feedback`.
- Added `importLegacyLearningRuntimeState` as the explicit `doctor --repair`
  import boundary with import bookkeeping, idempotency, blocked-source records,
  and typed-state precedence.
- Routed `StateManager.readRaw/writeRaw` compatibility paths for `learning/*`
  to the typed store; no legacy files are created on writes.
- Removed normal-code raw fallback calls from `LearningPipeline`,
  `learning-feedback.ts`, and `learning-cross-goal.ts`.
- Updated dream activation learned-pattern loading to read from the typed store
  instead of legacy pattern files.
- Added caller-path coverage proving stale legacy learning files are ignored
  by `LearningPipeline.analyzeLogs` until imported through repair.

## Validation

- `npx vitest run src/runtime/store/__tests__/learning-runtime-state-store.test.ts --reporter=dot` -> 7 tests passed.
- `npx vitest run src/interface/cli/__tests__/cli-doctor.test.ts --reporter=dot` -> 69 tests passed.
- `npx vitest run src/runtime/store/__tests__/learning-runtime-state-store.test.ts src/interface/cli/__tests__/cli-doctor.test.ts --reporter=dot` -> 76 tests passed.
- `npx vitest run src/platform/knowledge/__tests__/learning-pipeline-feedback.test.ts src/platform/knowledge/__tests__/learning-pipeline-persistence.test.ts src/platform/knowledge/__tests__/learning-pipeline-extraction.test.ts --reporter=dot` -> 93 tests passed.
- `npx vitest run src/platform/knowledge/__tests__/learning-pipeline-sharing.test.ts src/platform/knowledge/__tests__/learning-cross-goal.test.ts src/platform/knowledge/__tests__/knowledge-transfer-incremental.test.ts --reporter=dot` -> 68 tests passed.
- `npx vitest run src/platform/knowledge/__tests__/learning-*.test.ts --reporter=dot` -> 6 files / 182 tests passed.
- `npx vitest run src/base/state/__tests__/state-manager.test.ts --reporter=dot` -> 95 tests passed.
- `node scripts/check-database-first-legacy-stores.mjs --json` -> `ok=true`, `findings=0`; `learning-runtime-raw-caller` absent from `debtReport`.
- Remaining debt entries: Slice 5 knowledge transfer snapshot/meta-pattern, Slice 6 transfer trust, Slice 7 capability dependency, Slice 8 task grounding raw task read.
- `npm run typecheck` -> passed.
- `npm run lint:boundaries` -> passed with existing warnings, 0 errors.
- `npm run build` -> passed.
- `git diff --check` -> passed.
- Rebased onto latest `origin/main` at `614668f8 Centralize process group signaling (#1801)`.
- Post-rebase `npx vitest run src/runtime/store/__tests__/learning-runtime-state-store.test.ts src/platform/knowledge/__tests__/learning-*.test.ts src/interface/cli/__tests__/cli-doctor.test.ts src/base/state/__tests__/state-manager.test.ts --reporter=dot` -> 9 files / 353 tests passed.
- Post-rebase guard/typecheck/lint/build/diff-check all passed; lint emitted existing warnings only, 0 errors.
- Final archive-behavior adjustment keeps learning history when a goal is archived, while explicit delete still cleans typed learning state; reran state manager/store tests, guard, typecheck, build, and diff-check successfully.
- CI unit failure on PR #1804 exposed a missed production caller path:
  `TaskLifecycle` learned-pattern hints still read legacy pattern files through
  dream activation. Fixed by routing `loadLearnedPatterns()` through
  `LearningRuntimeStateStore`; `task-lifecycle-generation.test.ts` now passes
  under the unit config.
