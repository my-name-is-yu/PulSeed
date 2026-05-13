# PulSeed Test Redesign Final Scope Checkpoint

Started: 2026-05-13T11:58:59+0900
Branch: `codex/test-redesign-final-scope`
Base: `origin/main` at `ecb89650a52a691d099be8bbbcce0433bb3442e5`

## Phase

Approval stale-origin/no-delivery P0 traces upgraded; next is schedule goal-trigger public tick evidence.

## Current Evidence Read

- `tmp/pulseed-test-redesign-replacement-map.md`
- `tmp/pulseed-test-redesign-inventory.jsonl`
- `tmp/pulseed-test-redesign-inventory-summary.json`
- `tests/harness/golden-trace-runner.ts`
- `tests/harness/replay-runner.ts`
- `tests/golden-traces/p0/fixtures.json`
- `tests/replay/p0/fixtures.json`

Inventory summary currently reports:

- `test_like_files`: 784
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
- `src/runtime/queue/__tests__/journal-backed-queue.test.ts`
  - Removed the standalone `read APIs reflect writes from another queue instance` block after moving its value into the stronger multi-instance lock/reload test.
- `src/tools/fs/FileWriteTool/__tests__/FileWriteTool.test.ts`
  - Recovered already-deleted FileWrite blocks with a contract that executes real `ToolExecutor.execute("file_write")` calls through `PermissionWaitPlanStore` and `FileWriteTool.call`.
  - Covered unsafe path traversal, `.env`, credentials, and `node_modules` writes under `preApproved=true`; all fail without approval prompts, artifacts, or filesystem mutation.
- `src/runtime/store/__tests__/attention-state-store.test.ts`
  - Removed raw legacy DB row insertion block for old agenda shapes; moved the meaningful default/regrounding/admission assertion to `tests/regression/companion-autonomy-contracts.test.ts`.
- `src/runtime/control/__tests__/runtime-control-service.test.ts`
  - Recovered the resume-after-companion-lift readmission block by upgrading the golden runner to execute `suspend_companion -> resume_companion -> resume_run` through `RuntimeControlService`; the final resume is blocked with `resume_rejected_safety` and executor count stays zero.
- `src/runtime/__tests__/approval-broker.test.ts`
  - Recovered stale conversational origin evidence by trying channel, conversation, user, session, and turn mismatches; the approval remains pending and no mutation is recorded.
  - Recovered no-delivery evidence with an `ApprovalBroker` that has no `deliverConversationalApproval` callback; request resolves false, record is denied, and the reason is `approval_channel_unreachable`.

## Blocks Kept And Reason

- `src/tools/fs/ReadTool/__tests__/ReadTool.test.ts`
  - Kept and collapsed line-number/limit/offset/summary checks into `reads bounded line windows with stable line numbers and summaries`; this is focused user-visible unit behavior not covered by the readonly golden trace.
  - Kept EOF-offset summary check because it guards against negative line-range output.
  - Kept protected read approval checks as a parameterized unit because the golden trace only proves normal workspace reads do not request approval.
- `src/runtime/queue/__tests__/journal-backed-queue.test.ts`
  - Kept durable accept/claim/renew/ack, pending dedupe, dedupe after completion, deadletter/requeue, and filtered claim units because these are mock-free queue primitives used by EventDispatcher/LoopSupervisor and not fully replaced by the existing P0 eventserver/queue traces.
  - Kept finite fractional lease persistence because LoopSupervisor retry backoff can call `JournalBackedQueue.renew` with fractional duration.
  - Rewrote the multi-instance read refresh assertion into the lock/reload test so the file no longer has a separate convenience-API block for the same durability behavior.
- `src/runtime/store/__tests__/attention-state-store.test.ts`
  - Kept migration table inventory, full-cycle restart rehydration, legacy/current projection merge, replay-key dedupe, malformed-row fail-closed behavior, and durable suppress/invalidate/admitted-history controls as mock-free store contracts.

## Added Runner / Trace / Replay

- No new runner/trace/replay added yet.
- Hardened existing P0 golden/replay tests so current fixtures and runner results must be `real_production_path`; `pending_real_runner` now fails the P0 lanes instead of being accepted.
- Added a migration contract test for legacy `runtime/queue.json` mixed safe/unsafe import through `importLegacyQueueDaemonScheduleState` and the control DB queue store.
- Added `tests/contracts/tool-file-write-boundary.test.ts` as production-boundary contract evidence for ordered approval-before-mutation and unsafe FileWrite path denial.
- Added focused autonomy regression coverage for legacy agenda-shaped records defaulting to regrounding-only state before admission.
- Upgraded the existing `runtime_control_resume_after_companion_revival_requires_readmission` golden trace to exercise the real companion-control sequence before the blocked `resume_run`.
- Upgraded approval golden traces for origin-bound mismatch variants and missing delivery callback fail-closed behavior.

## Replacement Map Updates

- `scripts/inventory-test-redesign.mjs`
  - Added ReadTool final-scope deleted block evidence for direct relative-path resolution and normal-file permission.
  - Added `rewrittenBlocks` rendering so retained/reworked old blocks and their classification are preserved in `tmp/pulseed-test-redesign-replacement-map.md`.
  - Updated the deletion gate text to state that P0 golden/replay tests must fail on `pending_real_runner`.
  - Added queue final-scope retained/reworked block classifications and updated queue same-checkout evidence.
  - Reclassified the already-deleted unsafe legacy queue scalar blocks as `delete_now` covered by the new queue migration contract instead of unresolved obsolete rationale.
  - Replaced FileWrite post-hoc deletion evidence with explicit contract evidence for ordered approval/wait-plan/tool-call events and unsafe path denial.
  - Added attention-state-store assertion inventory, including retained high-value store contracts and the moved old agenda-shape block.
- Regenerated the runtime-control replacement evidence after the readmission fixture gained `companion_suspend_recorded`, `companion_resume_recorded`, `resume_outcome`, and `resume_requires_readmission` assertions.
- Regenerated the approval replacement evidence after the origin fixture gained mismatch field assertions and the delivery fixture switched from delivered=false callback to no delivery callback.
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
- `npx vitest run src/runtime/queue/__tests__/journal-backed-queue.test.ts --config vitest.unit.config.ts` -> pre-rewrite passed 1 file / 9 tests
- `npm run test:golden-traces` -> queue pre-rewrite passed 1 file / 43 tests
- `npm run test:replay` -> queue pre-rewrite passed 1 file / 9 tests
- `npx vitest run src/runtime/queue/__tests__/journal-backed-queue.test.ts --config vitest.unit.config.ts` -> post-rewrite passed 1 file / 8 tests
- `npm run test:golden-traces` -> queue post-rewrite passed 1 file / 43 tests
- `npm run test:replay` -> queue post-rewrite passed 1 file / 9 tests
- `node scripts/inventory-test-redesign.mjs` -> after queue rewrite regenerated 783 inventory records, 0 current include gaps, 40/40 P0 mapped traces
- `npx vitest run src/runtime/store/__tests__/queue-daemon-schedule-state-migration.test.ts --config vitest.unit.config.ts` -> first attempt failed because the test assumed a fixed legacy-import ordering
- `npx vitest run src/runtime/store/__tests__/queue-daemon-schedule-state-migration.test.ts --config vitest.unit.config.ts` -> after assertion fix passed 1 file / 4 tests
- `node scripts/inventory-test-redesign.mjs` -> after queue migration safety recovery regenerated 783 inventory records, 0 current include gaps, 40/40 P0 mapped traces
- `npx vitest run tests/contracts/tool-file-write-boundary.test.ts --config vitest.contracts.config.ts` -> passed 1 file / 2 tests
- `node scripts/inventory-test-redesign.mjs` -> after FileWrite contract evidence regenerated 784 inventory records, 0 current include gaps, 40/40 P0 mapped traces
- `npm run test:contracts` -> passed 2 files / 9 tests
- `npm run test:replay` -> after FileWrite contract passed 1 file / 9 tests
- `npm run test:golden-traces` -> after one transient mismatch retry passed 1 file / 43 tests
- `npm run typecheck` -> passed after FileWrite contract addition
- `npx vitest run src/runtime/store/__tests__/attention-state-store.test.ts --config vitest.unit.config.ts` -> pre-rewrite passed 1 file / 13 tests
- `npx vitest run src/runtime/store/__tests__/attention-state-store.test.ts tests/regression/companion-autonomy-contracts.test.ts --config vitest.unit.config.ts` -> post-rewrite passed 2 files / 23 tests
- `node scripts/inventory-test-redesign.mjs` -> after attention-state-store rewrite regenerated 784 inventory records, 0 current include gaps, 40/40 P0 mapped traces
- `npm run test:replay` -> after attention rewrite passed 1 file / 9 tests
- `npm run test:golden-traces` -> after attention rewrite passed 1 file / 43 tests
- `npm run typecheck` -> passed after attention rewrite
- `npm run test:golden-traces` -> first runtime-control readmission runner upgrade attempt failed expectedly because the fixture still described the old single failed-run resume path
- `npm run test:golden-traces` -> after fixture update passed 1 file / 43 tests
- `node scripts/inventory-test-redesign.mjs` -> after runtime-control readmission recovery regenerated 784 inventory records, 0 current include gaps, 40/40 P0 mapped traces
- `npm run typecheck` -> passed after runtime-control readmission runner update
- `npm run test:replay` -> passed after runtime-control readmission runner update
- `npm run test:golden-traces` -> first approval runner upgrade attempt failed expectedly because the fixtures still described the older weaker approval outputs
- `npm run test:golden-traces` -> after approval fixture update passed 1 file / 43 tests
- `npm run typecheck` -> passed after approval runner update
- `npm run test:replay` -> passed after approval runner update
- `node scripts/inventory-test-redesign.mjs` -> after approval runner update regenerated 784 inventory records, 0 current include gaps, 40/40 P0 mapped traces

## Reviewer Findings Applied

- Contract / Runner Reviewer found that P0 lane tests accepted `pending_real_runner` even though current fixtures do not contain it. Applied a fail-closed test gate before using further traces as deletion evidence.
- Same reviewer warned that several existing traces overstate their production entrypoints. Queue traces used for the current queue slice are still runner-computed queue/eventserver state; for later approval/resident/observation/daemon/chat deletions, do not cite the flagged weak traces for broader caller-path claims unless upgraded.
- Deletion Reviewer recommendations are available for queue, attention-store, runtime-control, schedule, approval, daemon/session-registry, chat-runner, and cross-platform-session. Use them as candidates, but verify with real file contents and safety reviewer before deleting.
- Runtime Safety Reviewer found blocker coverage gaps that must be recovered before final completion:
  - Unsafe legacy queue import/scalar rejection from already-deleted queue blocks needed a queue migration contract through `runtime/queue.json` -> control DB import. Recovered by `src/runtime/store/__tests__/queue-daemon-schedule-state-migration.test.ts`.
  - Unsafe FileWrite path denial from already-deleted FileWrite blocks needed production tool-boundary evidence. Recovered by `tests/contracts/tool-file-write-boundary.test.ts`.
  - FileWrite approval-before-mutation evidence needed ordered event/state evidence, not a post-hoc boolean. Recovered by `tests/contracts/tool-file-write-boundary.test.ts`.
  - Approval stale-origin mismatch and no-delivery branches needed stronger coverage before deleting related approval-broker blocks. Recovered by upgrading `approval_origin_bound_stale_reply_rejected` and `approval_delivery_unavailable_denies_not_executes`.
  - `resume_companion` -> `resume_run` readmission gate needed a real RuntimeControlService trace before deleting that runtime-control block. Recovered by upgrading `runtime_control_resume_after_companion_revival_requires_readmission`.
  - Schedule goal-trigger dispatch and active-goal skip need public `ScheduleEngine.tick()` artifacts before relying on already-deleted private goal-trigger blocks.

## Commands Failing

- Initial pre-`npm ci` `npx vitest ... --config vitest.unit.config.ts` failed because `vitest` was not installed in this worktree.
- Initial pre-`npm ci` `npm run test:golden-traces` failed because `vitest` was not installed in this worktree.
- One parallel `npm run test:golden-traces` attempt reported a mismatch in `approval_delivery_unavailable_denies_not_executes`; direct expected-vs-actual comparison for that fixture matched byte-for-byte, and the immediate rerun passed 43/43. No active failing command remains from this attempt.

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

Recover the remaining Safety Reviewer blocker before deleting corresponding old blocks: schedule goal-trigger public tick artifacts.
