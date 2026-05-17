# Event-Sourced Runtime Projection Closure Status

## Goal

Complete the runtime projection/current-state source-of-truth closure so in-scope production mutations follow:

runtime signal or mutation -> typed runtime event append -> RuntimeGraph linkage -> projection/current-state update -> rebuild/replay can reproduce the same safe visible state without duplicate side effects.

## Current Status

- Branch: `yu/event-sourced-runtime-projection-closure`
- Base: `origin/main`
- PR state: draft PR #2003 opened before broad implementation began.
- Session language: Japanese
- GitHub-facing artifacts: English

## Checkpoints

- [x] Read goal prompt.
- [x] Confirm Node `v24.15.0`.
- [x] Fetch latest `origin/main`.
- [x] Inspect open and recent merged PR list.
- [x] Create draft PR.
- [x] Complete current-state inventory.
- [x] Implement shared event append -> RuntimeGraph link -> projection update path for runtime-control operations and attention commitments.
- [x] Add rebuild apply path.
- [x] Add direct-write guard.
- [x] Add replay/rebuild contract coverage.
- [x] Update docs.
- [x] Run required full verification.
- [ ] Complete sub-agent review.
- [ ] Request and clear GitHub Codex review.

## Notes

- Draft PR: https://github.com/my-name-is-yu/PulSeed/pull/2003
- Open PR at kickoff: #1989 Dependabot `@types/node`.
- Relevant recent merged PRs include #1996, #1997, #1998, #1999, #2000, and #2001.
- Verification passed:
  - `npm run typecheck`
  - `npm run check:database-first-legacy-stores`
  - `npm run check:docs`
  - `npm run lint:boundaries` (0 errors, existing warnings only)
  - `npm run test:contracts -- --run tests/contracts/runtime-event-log-source-of-truth.test.ts`
  - `npm run test:replay -- --run tests/replay/runtime-event-log-source-of-truth-replay.test.ts`
  - `npm run test:contracts`
  - `npm run test:replay`
  - `npm run test:product-gauntlet`
  - `npm run test:integration`
  - `npm run test:smoke`
  - `npm run test:changed`
  - `npm run check:public-contracts`
  - `git diff --check`
- A prior `npm run test:integration` attempt observed a one-off first-visible-latency assertion above 2s. The focused rerun passed, and the later full integration rerun passed.
