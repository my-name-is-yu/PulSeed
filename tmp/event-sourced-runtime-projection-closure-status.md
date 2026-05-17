# Event-Sourced Runtime Projection Closure Status

## Goal

Complete the runtime projection/current-state source-of-truth closure so in-scope production mutations follow:

runtime signal or mutation -> typed runtime event append -> RuntimeGraph linkage -> projection/current-state update -> rebuild/replay can reproduce the same safe visible state without duplicate side effects.

## Current Status

- Branch: `yu/event-sourced-runtime-projection-closure`
- Base: `origin/main`
- PR state: ready PR #2003; GitHub Codex review findings are being cleared before merge.
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
- [x] Request GitHub Codex review after the completeness pass.
- [ ] Clear latest GitHub Codex review.

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
- GitHub Codex review on `5a508fd8` found:
  - P1: pre-delete task events could be restored after a goal id was deleted and recreated.
  - P2: non-event-backed runtime operation rows survived whole-control apply.
  - P2: `AttentionStateStore.saveCommitmentCandidates()` used raw string timestamp comparison before event append.
- Follow-up fixes track goal delete generations during apply, prune stale whole-control current-state projection rows, and use parsed timestamp comparison before suppressing commitment candidate writes. Focused verification passed:
  - `npm run typecheck`
  - `npm run test:contracts -- --run tests/contracts/runtime-event-log-source-of-truth.test.ts`
  - `npm run test:replay -- --run tests/replay/runtime-event-log-source-of-truth-replay.test.ts`
  - `npm run check:database-first-legacy-stores`
  - `git diff --check`
- GitHub Codex review on `24901f87` found:
  - P1: trace-scoped rebuild apply could mutate current-state tables from partial action-scoped history.
  - P2: no-op runtime operation saves appended extra `runtime_control.operation.recorded` events.
- Follow-up fixes reject trace-scoped current-state apply at the store and CLI boundary, document trace rebuild as dry-run/inspection-only, and suppress runtime operation event append for unchanged state/updated-at transitions. Focused verification passed:
  - `node -v` -> `v24.15.0`
  - `npm run typecheck`
  - `npm run test:contracts -- --run tests/contracts/runtime-event-log-source-of-truth.test.ts`
  - `npm run test:replay -- --run tests/replay/runtime-event-log-source-of-truth-replay.test.ts`
  - `npm run test:contracts`
  - `npm run test:unit -- --run src/runtime/control/__tests__/runtime-control-service.test.ts src/runtime/__tests__/runtime-control-result-routing.test.ts src/runtime/store/__tests__/runtime-control-store-migration.test.ts`
  - `npm run check:database-first-legacy-stores`
  - `npm run check:docs`
  - `npm run lint:boundaries` (0 errors, existing warnings only)
  - `git diff --check`
