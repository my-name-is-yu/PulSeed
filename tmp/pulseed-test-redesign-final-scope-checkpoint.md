# PulSeed Test Redesign Final Scope Checkpoint

Started: 2026-05-13T11:58:59+0900
Branch: `codex/test-redesign-final-scope`
Base: `origin/main` at `ecb89650a52a691d099be8bbbcce0433bb3442e5`

## Phase

Harness pending-runner gate complete after Contract / Runner Reviewer findings; moving back to runtime queue block inventory.

## Current Evidence Read

- `tmp/pulseed-test-redesign-replacement-map.md`
- `tmp/pulseed-test-redesign-inventory.jsonl`
- `tmp/pulseed-test-redesign-inventory-summary.json`
- `tests/harness/golden-trace-runner.ts`
- `tests/harness/replay-runner.ts`
- `tests/golden-traces/p0/fixtures.json`
- `tests/replay/p0/fixtures.json`

Inventory summary currently reports:

- `test_like_files`: 783
- `classification_counts.replace`: 12
- `p0_trace_count`: 40
- `p0_mapped_trace_count`: 40
- `current_coverage_gap_count`: 0

Runner and fixture scan confirms the P0 fixture set records `runner_status: real_production_path`; `pending_real_runner` support still exists in harness code, but current replacement fixtures must not use it as deletion evidence.

## Remaining Scope

Primary old-test targets still present:

- `src/tools/fs/ReadTool/__tests__/ReadTool.test.ts`
- `src/runtime/queue/__tests__/journal-backed-queue.test.ts`
- `src/runtime/store/__tests__/attention-state-store.test.ts`
- `src/runtime/control/__tests__/runtime-control-service.test.ts`
- `src/runtime/__tests__/schedule-engine.test.ts`
- `src/runtime/__tests__/approval-broker.test.ts`
- `src/runtime/__tests__/daemon-runner.test.ts`
- `src/runtime/session-registry/__tests__/runtime-session-registry.test.ts`
- `src/interface/chat/__tests__/chat-runner.test.ts`
- `src/interface/chat/__tests__/chat-runner-tools.test.ts`
- `src/interface/chat/__tests__/setup-secret-intake.test.ts`
- `src/interface/chat/__tests__/cross-platform-session.test.ts`

Already absent:

- `src/tools/fs/FileWriteTool/__tests__/FileWriteTool.test.ts`; replacement map marks file-level deletion allowed. Need keep checking for stale inventory/map remnants and ensure no tests still import or expect the removed file.

## Deletion Candidates

Initial priority order from the goal:

1. `ReadTool`
2. `queue`
3. `attention-state-store`
4. `runtime-control-service`
5. `schedule-engine`
6. `approval-broker`
7. `daemon/session-registry`
8. `chat-runner`
9. `cross-platform-session`

Deletion is allowed only per block when replacement map records:

- old file
- old block / old line range
- classification
- replacement trace/replay/contract or obsolete rationale
- production entrypoint exercised
- exported artifact/assertion
- pre-delete command
- post-delete command
- deletion allowed

## Deleted Blocks

- `src/tools/fs/ReadTool/__tests__/ReadTool.test.ts`
  - Deleted direct relative-path `ReadTool.call` assertion; replacement is `tool_readonly_fs_no_write_approval_under_workspace`, which executes `ToolExecutor.execute("read", { file_path: "notes.txt" })` with a real workspace `cwd`.
  - Deleted direct normal-file `checkPermissions` allowed assertion; replacement is the same production tool-catalog trace with `approval_request_count=0` and `read_success=true`.

## Blocks Kept And Reason

- `src/tools/fs/ReadTool/__tests__/ReadTool.test.ts`
  - Kept and collapsed line-number/limit/offset/summary checks into `reads bounded line windows with stable line numbers and summaries`; this is focused user-visible unit behavior not covered by the readonly golden trace.
  - Kept EOF-offset summary check because it guards against negative line-range output.
  - Kept protected read approval checks as a parameterized unit because the golden trace only proves normal workspace reads do not request approval.

## Added Runner / Trace / Replay

- No new runner/trace/replay added yet.
- Hardened existing P0 golden/replay tests so current fixtures and runner results must be `real_production_path`; `pending_real_runner` now fails the P0 lanes instead of being accepted.

## Replacement Map Updates

- `scripts/inventory-test-redesign.mjs`
  - Added ReadTool final-scope deleted block evidence for direct relative-path resolution and normal-file permission.
  - Added `rewrittenBlocks` rendering so retained/reworked old blocks and their classification are preserved in `tmp/pulseed-test-redesign-replacement-map.md`.
  - Updated the deletion gate text to state that P0 golden/replay tests must fail on `pending_real_runner`.
- Regenerated `tmp/pulseed-test-redesign-replacement-map.md`, `tmp/pulseed-test-redesign-inventory.jsonl`, and `tmp/pulseed-test-redesign-inventory-summary.json`.

## Commands Passed

- `git fetch origin main --prune`
- `git switch -c codex/test-redesign-final-scope origin/main`
- `node -v` -> `v24.15.0`
- `npm -v` -> `11.12.1`
- `npm ci` -> installed dependencies; audit reports 1 moderate advisory and suggests breaking `npm audit fix --force`
- `npx vitest run src/tools/fs/ReadTool/__tests__/ReadTool.test.ts src/tools/fs/__tests__/read-only-fs-tool-input-schema-contract.test.ts src/tools/fs/FileValidationTool/__tests__/FileValidationTool.test.ts --config vitest.unit.config.ts` -> pre-delete passed 3 files / 34 tests
- `npm run test:golden-traces` -> pre-delete passed 1 file / 42 tests
- `npx vitest run src/tools/fs/ReadTool/__tests__/ReadTool.test.ts src/tools/fs/__tests__/read-only-fs-tool-input-schema-contract.test.ts src/tools/fs/FileValidationTool/__tests__/FileValidationTool.test.ts --config vitest.unit.config.ts` -> post-delete passed 3 files / 29 tests
- `npm run test:golden-traces` -> post-delete passed 1 file / 42 tests
- `npm run test:replay` -> post-delete passed 1 file / 9 tests
- `node scripts/inventory-test-redesign.mjs` -> regenerated 783 inventory records, 0 current include gaps, 40/40 P0 mapped traces
- `npm run test:golden-traces` -> after pending-runner gate passed 1 file / 43 tests
- `npm run test:replay` -> after pending-runner gate passed 1 file / 9 tests
- `node scripts/inventory-test-redesign.mjs` -> after pending-runner gate regenerated 783 inventory records, 0 current include gaps, 40/40 P0 mapped traces

## Reviewer Findings Applied

- Contract / Runner Reviewer found that P0 lane tests accepted `pending_real_runner` even though current fixtures do not contain it. Applied a fail-closed test gate before using further traces as deletion evidence.
- Same reviewer warned that several existing traces overstate their production entrypoints. Queue traces used for the current queue slice are still runner-computed queue/eventserver state; for later approval/resident/observation/daemon/chat deletions, do not cite the flagged weak traces for broader caller-path claims unless upgraded.
- Deletion Reviewer recommendations are available for queue, attention-store, runtime-control, schedule, approval, daemon/session-registry, chat-runner, and cross-platform-session. Use them as candidates, but verify with real file contents and safety reviewer before deleting.

## Commands Failing

- Initial pre-`npm ci` `npx vitest ... --config vitest.unit.config.ts` failed because `vitest` was not installed in this worktree.
- Initial pre-`npm ci` `npm run test:golden-traces` failed because `vitest` was not installed in this worktree.

## Verification Commands To Run

Targeted by phase:

- `npx vitest run <target files> --config vitest.unit.config.ts`
- `npx vitest run <target files> --config vitest.integration.config.ts`
- `npm run test:golden-traces`
- `npm run test:replay`

Final required gates:

- `npm run check:docs`
- `npm run typecheck`
- `npm run lint:boundaries`
- `npm run test:contracts`
- `npm run test:golden-traces`
- `npm run test:replay`
- `npm run test:unit`
- `npm run test:integration`
- `npm run test:smoke`
- `npm run test:changed`
- `npm run verify:release`

## Next

Build assertion-level inventory for `src/runtime/queue/__tests__/journal-backed-queue.test.ts`, confirm which remaining queue invariants are already covered by eventserver/queue golden and replay traces, then delete or keep with explicit P0 duplicate/lost-command reasoning.
