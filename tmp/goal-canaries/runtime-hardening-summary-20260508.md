# Goal Canary Runtime Hardening Summary

Date: 2026-05-08 JST

Worktree: `/Users/yuyoshimuta/Documents/dev/PulSeed-worktrees/goal-canary-runtime-hardening-20260507225047`
Branch: `yu/goal-canary-runtime-hardening-20260507225047`
Base: `origin/main` at `ac96df37`

## Canary Scenarios

| scenario | evidence root | goal | task | final state | classification |
| --- | --- | --- | --- | --- | --- |
| artifact-contract-exactness | `tmp/goal-canaries/20260507T234855/artifact-contract-exactness` | `goal_1778165335980` | `90733294-ca46-4c47-8c11-60e55d6dad2c` | completed | task_succeeded |
| task-lifecycle-reconciliation | `tmp/goal-canaries/20260507T234855/task-lifecycle-reconciliation` | `goal_1778165573464` | `e99e8cde-3e88-4df5-bd5f-bc2aea1c196a` | completed | task_succeeded |
| agentloop-final-output-schema | `tmp/goal-canaries/20260507T234855/agentloop-final-output-schema` | `goal_1778165780013` | `3b1eaad2-1788-4bec-bf7f-1c77a8be3056` | blocked | terminal_error |
| agentloop-final-output-schema | `tmp/goal-canaries/20260508T000144/agentloop-final-output-schema` | `goal_1778166104589` | `d5ea1a66-6ef2-441e-80a0-61b5fc612459` | blocked | terminal_error |
| agentloop-final-output-schema | `tmp/goal-canaries/20260508T000601/agentloop-final-output-schema` | `goal_1778166361754` | `7fdf940d-40d5-462c-88d9-54713dc0dcbc` | completed | task_succeeded |
| agentloop-final-output-schema | `tmp/goal-canaries/20260508T001637/agentloop-final-output-schema` | `goal_1778166997832` | `c06b5e0b-0d6c-4485-862f-36b6aed3edd9` | blocked | terminal_error |
| agentloop-final-output-schema | `tmp/goal-canaries/20260508T002442/agentloop-final-output-schema` | `goal_1778167483881` | `f434baaf-4741-4f72-b299-965f3005adfd` | completed | task_succeeded |

Final daemon check for the last scenario reported `Status: stopped` with a historical stale worker explicitly marked as historical, not live.

## Blockers Fixed

- External Codex-backed task AgentLoop runs were forced through PulSeed's prompted tool protocol and default required code-search tools even though PulSeed cannot observe those internal external-agent tool calls.
- Core loop phases could run with write-capable model/runtime posture before task generation.
- Task execution cwd was not propagated into the external Codex CLI request, so disposable workspace tasks were created against the wrong path.
- Ignored disposable workspaces under `tmp/` lost changed-file evidence because git-only diff capture ignored them.
- Generic `artifact_contract.required=true` forced Kaggle-style `metrics_json` plus `submission_csv` kinds even for non-Kaggle local canaries.
- Final JSON completions with valid `finalAnswer` and `completionEvidence` could be downgraded to task error when PulSeed could not observe external-agent verification commands.
- Explicit typed JSON artifact contracts could be rejected solely because the `metrics_json` object had no numeric fields.
- External-agent success with changed files could write a task `succeeded` ledger event before PulSeed-owned mechanical/artifact verification had observed the result.

## Production Paths Changed

- LLM request options now carry per-turn `cwd` and sandbox policy to Codex CLI.
- External agent runtimes opt out of PulSeed prompted tool-call wrapping.
- Core phase model calls use read-only sandbox posture.
- AgentLoop changed-file capture now falls back to filesystem snapshots for ignored/non-git disposable workspaces.
- Task diff capture now records filesystem diffs when git cannot see ignored workspace files.
- Task artifact contract verification only requires Kaggle artifact kind pairs for Kaggle/profile constraints.
- Completion gate can hand external-agent completion evidence to downstream verification when native tool calls are not observable, but task status and `succeeded` ledger writes are deferred until PulSeed-owned verification records the terminal result.
- `metrics_json` numeric-field enforcement is now implicit only when no explicit required field/type contract is declared.

## Verification

- `npm ci`
- `npm run build`
- Focused baseline unit lane: 8 files, 188 tests passed
- Updated focused regression lane: 8 files, 172 tests passed
- Post-review focused regression lane: 9 files, 206 tests passed
- `npm run typecheck`
- `npm run build`
- `npm run verify:packaged-artifacts`
- `npm run lint:boundaries` exited 0 with pre-existing warnings

## Follow-up Candidates

- `verifyExecutionWithGitDiff` still logs a confusing git-only `0 files changed` warning for ignored disposable workspaces even when filesystem diff evidence succeeds.
- Task outcome ledger can report tiny negative `completed_to_verification_ms` values when completion and verification timestamps are written in the same millisecond window.
- Minimal canaries can spend 90s+ in knowledge refresh before task generation; consider a bounded or skip path for isolated goal canaries.
- Continue scenario queue coverage for completion-judger fallback, non-git workspace handoff, daemon stop/restart, observation freshness, and CLI packaging/build.
