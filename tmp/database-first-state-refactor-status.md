# Database-First Durable State Ownership Refactor

## Session Rules

- Base repository: `/Users/yuyoshimuta/PulSeed`
- Slice branches are created from fresh `origin/main` worktrees.
- This session may merge only PRs created for this database-state goal.
- Release, version, changelog, npm publish, and deploy surfaces are out of scope.

## Slice Log

### Slice 1: SQLite Foundation And Migration Framework

- Branch: `codex/database-state-slice-1-sqlite-foundation-20260509213955`
- PR: #1635
- Merge commit on `origin/main`: `a96c9729738786366744dad794724cb88852707c`
- Status: merged by this session.

### Slice 2: Runtime Control-Plane Stores

- PR: #1640
- Merge commit on `origin/main`: `eb064246cee786434bdc09d14c05ce7a9659e59d`
- Status: merged by this session.

### Slice 3: Approval, Permission, Guardrail, Outbox, Lease Stores

- PR: #1650
- Merge commit on `origin/main`: `ecb5b8514ce00c970cb896c312d843fc21298119`
- Status: merged by this session.

### Slice 4: Queue, Daemon, Schedule, And Supervisor State

- PR: #1675
- Merge commit on `origin/main`: `cf418210ebeaf3163c0ad6729b0802ad01275f00`
- Status: merged by this session.

### Slice 5: Chat And AgentLoop Session Data Plane

- PR: #1685
- Merge commit on `origin/main`: `d140a1e1eba0c743fbc65c95a74ed922c8e503e4`
- Status: merged by this session.

### Slice 6: Goal, Task, Verification, Checkpoint, And DurableLoop State

- PR: #1696
- Merge commit on `origin/main`: `4db527e7178a30beca3b2aeedbcaf3d6614f4dfa`
- Status: merged by this session.

### Slice 7: Runtime Evidence, Strategy, Dream, And Reflection State

- PR: #1707
- Merge commit on `origin/main`: `a3780e97be31592715bbb5aaa17d580779c0b4d5`
- Status: merged by this session.

### Slice 8: Knowledge, Memory, Soil, Learning, And Profile State

- Worktree: `/Users/yuyoshimuta/Documents/dev/PulSeed-worktrees/database-state-slice-8-knowledge-memory-soil-learning-profile-state-20260510062628`
- Branch: `codex/database-state-slice-8-knowledge-memory-soil-learning-profile-state-20260510062628`
- Base: `origin/main` at `a3780e97`
- PR: #1712
- Merge commit on `origin/main`: `cac30769a05b3f16b331e917e507c8a7fd3ebcb6`
- Status: merged by this session.
- Scope:
  - Route domain knowledge, shared knowledge, and agent memory normal paths through a Soil-backed typed store.
  - Keep legacy JSON as explicit `doctor --repair` migration input.
  - Rebuild Soil knowledge/memory projections from Soil SQLite state rather than legacy JSON files.
- Validation:
  - `npm run test:unit -- src/platform/knowledge/__tests__/knowledge-memory-state-store.test.ts` passed.
  - `npm run test:unit -- src/interface/cli/__tests__/cli-doctor.test.ts` passed.
  - `npm run test:unit -- src/platform/knowledge` passed.
  - `npm run test:integration -- src/platform/soil/__tests__/soil-runtime-rebuild-import.test.ts src/platform/soil/__tests__/soil-content-projections.test.ts` passed.
  - `npm run test:unit` passed, 496 files / 7851 tests.
  - `npm run typecheck` passed.
  - `npm run lint:boundaries` passed with existing warnings, 0 errors.
  - `npm run build` passed.
  - `git diff --check` passed.
- Review:
  - Initial review found migration and caller-path coverage blockers; fixes were applied.
  - Fresh re-review found no material blockers.

### Slice 9: Plugin/Channel Runtime State, Legacy Guardrails, And Final Audit

- Worktree: `/Users/yuyoshimuta/Documents/dev/PulSeed-worktrees/database-state-slice-9-plugin-channel-runtime-state-legacy-guardrails-final-audit-20260510065909`
- Branch: `codex/database-state-slice-9-plugin-channel-runtime-state-legacy-guardrails-final-audit-20260510065909`
- Base: `origin/main` at `2671de60` after rebasing over #1713, #1714, #1715, #1717, #1716, and #1718.
- PR: #1720
- Status: implementation, validation, final re-review, and PR creation complete; CI rerun in progress after fixing a test fixture path assumption.
- Scope:
  - Route plugin runtime state, channel health/binding state, imported plugin compatibility review records, and runtime asset registry rows through `PluginChannelRuntimeStateStore`.
  - Keep plugin manifests and gateway/channel config files file-backed.
  - Add explicit doctor migration for legacy plugin/channel runtime files.
  - Add a database-first legacy-store guard and final ownership design note.
- Validation:
  - `npm run typecheck` passed.
  - Focused CLI unit tests passed: `database-first-legacy-store-check`, `setup-import`, `runtime-command`, `cli-doctor`.
  - Focused runtime integration tests passed: plugin/channel store, plugin loader, foreign plugin compatibility, Telegram gateway adapter.
  - `npm run test:unit` passed after the final rebase, 498 files / 7871 tests.
  - `npm run test:integration` passed after the final rebase, 213 files / 2235 tests.
  - An initial full integration run executed in parallel with full unit timed out one runtime-evidence summary-index test; the test passed when rerun in isolation, and the full integration lane passed when rerun alone.
  - `npm run lint:boundaries` passed with existing warnings, 0 errors.
  - `npm run build` passed.
  - `npm run check:docs` passed.
  - `npm run check:database-first-legacy-stores` passed.
  - `git diff --check` passed.
  - Initial GitHub `unit (22)` failed only in `database-first-legacy-store-check.test.ts` because the test fixture lived under `/tmp`, which the guard intentionally allowlists; the fixture now lives under the repo root, and `npm run test:unit` passes under Node 24.15.0.
  - GitHub `integration (24)` exposed CI-only timing in `daemon-runner.test.ts`; the affected tests now keep their first-tick behavior but avoid 50ms idle-loop reentry, and `npm run test:integration -- src/runtime/__tests__/daemon-runner.test.ts` passes under Node 24.15.0.
- Review:
  - Fresh review found no storage-boundary material blockers.
  - Review flagged stale `origin/main` twice; the branch was rebased onto current `origin/main`, then validation was rerun.
  - Final conflict resolution preserved main's plugin counter validation tests and this slice's SQLite persistence tests.
  - Final re-review found no high-confidence material blockers and confirmed the branch was up to date with `origin/main`.
