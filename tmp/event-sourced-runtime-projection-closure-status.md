# Event-Sourced Runtime Projection Closure Status

## Goal

Complete the runtime projection/current-state source-of-truth closure so in-scope production mutations follow:

runtime signal or mutation -> typed runtime event append -> RuntimeGraph linkage -> projection/current-state update -> rebuild/replay can reproduce the same safe visible state without duplicate side effects.

## Current Status

- Branch: `yu/event-sourced-runtime-projection-closure`
- Base: `origin/main`
- PR state: draft PR will be opened before broad implementation begins.
- Session language: Japanese
- GitHub-facing artifacts: English

## Checkpoints

- [x] Read goal prompt.
- [x] Confirm Node `v24.15.0`.
- [x] Fetch latest `origin/main`.
- [x] Inspect open and recent merged PR list.
- [ ] Create draft PR.
- [ ] Complete current-state inventory.
- [ ] Implement shared event append -> RuntimeGraph link -> projection update path.
- [ ] Add rebuild apply path.
- [ ] Add direct-write guard.
- [ ] Add replay/rebuild/product coverage.
- [ ] Update docs.
- [ ] Run required verification.
- [ ] Complete sub-agent review.
- [ ] Request and clear GitHub Codex review.

## Notes

- Open PR at kickoff: #1989 Dependabot `@types/node`.
- Relevant recent merged PRs include #1996, #1997, #1998, #1999, #2000, and #2001.
