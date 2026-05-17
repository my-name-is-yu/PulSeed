# Event-Sourced Runtime Projection Closure Status

## Goal

Complete the runtime projection/current-state source-of-truth closure so in-scope production mutations follow:

runtime signal or mutation -> typed runtime event append -> RuntimeGraph linkage -> projection/current-state update -> rebuild/replay can reproduce the same safe visible state without duplicate side effects.

## Current Status

- Branch: `yu/event-sourced-runtime-projection-closure`
- Base: `origin/main`
- PR state: draft PR #2003; moved back to draft for the additional completeness audit before requesting a fresh GitHub Codex review.
- Session language: Japanese
- GitHub-facing artifacts: English

## Checkpoints

- [x] Read goal prompt.
- [x] Confirm Node `v24.15.0`.
- [x] Fetch latest `origin/main`.
- [x] Inspect open and recent merged PR list.
- [x] Create draft PR.
- [x] Complete initial current-state inventory.
- [x] Implement shared event append -> RuntimeGraph link -> projection update path for runtime-control operations and attention commitments.
- [x] Add rebuild apply path.
- [x] Add direct-write guard.
- [x] Add replay/rebuild contract coverage.
- [x] Update docs.
- [x] Run required full verification.
- [x] Complete sub-agent review.
- [x] Re-audit completeness against the original closure prompt.
- [x] Expand current-state apply beyond runtime operations and attention commitments to goals, tasks, and interaction authority decisions.
- [x] Reclassify summary-only and narrow owner domains in the inventory.
- [x] Re-run full verification after the completeness pass.
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
- A prior `npm run test:integration` attempt observed a first-visible-latency assertion above 2s. The test now restores leaked mocks before each direct-chat latency case; the focused test, focused file, and later full integration rerun passed.
- First sub-agent review found material gaps in projection apply ordering, apply-to-current-state completeness, and resident commitment caller-path evidence. Follow-up fixes now append the rebuild event before projection writes, restore event-backed rows for `runtime_operations` and `attention_commitment_candidates`, and tag resident commitment writes with `caller_path: resident_proactive`.
- Second sub-agent review found a material deterministic rebuild gap: prior `projection.rebuild.recorded` events were recursively included as source evidence and `rebuilt_at` changed the rebuild idempotency key. Follow-up fixes exclude rebuild-record events from projection source events, derive rebuild idempotency from the stable rebuild payload without `rebuilt_at`, and add repeated-apply contract coverage.
- Third sub-agent review returned `No material findings.`
- Additional completion criteria required this PR not to treat classification as closure. The follow-up pass now restores `goal_records`, `task_records`, `interaction_authority_decisions`, `runtime_operations`, and `attention_commitment_candidates`, including goal/task RuntimeGraph source-of-truth nodes and edges. The inventory now explicitly separates apply-supported projections from rebuild-summary-only side-effect/owner domains.
- Completeness-pass verification passed:
  - `npm run typecheck`
  - `npm run check:database-first-legacy-stores`
  - `npm run check:docs`
  - `git diff --check`
  - `npm run test:contracts -- --run tests/contracts/runtime-event-log-source-of-truth.test.ts`
  - `npm run test:replay -- --run tests/replay/runtime-event-log-source-of-truth-replay.test.ts`
  - `npm run test:contracts`
  - `npm run test:replay`
  - `npm run test:product-gauntlet`
  - `npm run test:integration` (first attempt hit a single direct-chat latency outlier at 3269ms; focused file and full rerun passed)
  - `npm run test:smoke`
  - `npm run check:public-contracts`
  - `npm run lint:boundaries` (0 errors, existing warnings only)
  - `npm run test:unit -- --run src/interface/cli/__tests__/runtime-command.test.ts`
- `npm run test:changed` was not used as a completion gate after this pass: its related-unit expansion pulled in a broad unrelated unit lane and produced many failures outside the touched runtime projection scope before it was stopped. The directly touched CLI/runtime paths were verified through focused unit/contract tests plus the standard full contract/replay/product/integration/smoke lanes above.
- GitHub Codex review on `7029a6f3` found:
  - P1: rebuild summary/snapshot and current-state apply could read different event snapshots.
  - P2: apply latest-row selection used lexicographic timestamp comparison.
- Follow-up fixes compute rebuild, snapshots, and current-state apply from one transaction-local source event snapshot and compare apply timestamps by parsed instants. Focused verification passed:
  - `npm run typecheck`
  - `npm run test:contracts -- --run tests/contracts/runtime-event-log-source-of-truth.test.ts`
  - `npm run test:replay -- --run tests/replay/runtime-event-log-source-of-truth-replay.test.ts`
  - `npm run check:database-first-legacy-stores`
  - `git diff --check`
