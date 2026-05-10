# Seedy Gateway Codex-Like UX Implementation

Date: 2026-05-10

## Issue Order

1. #1850 Require real tool evidence for runtime-aware gateway status answers
2. #1849 Improve long-wait Seedy status from generic activity labels
3. #1851 Reduce first meaningful text latency for gateway turns
4. #1852 Stream assistant output incrementally across gateway display surfaces
5. #1855 Refine native typing timing to signal imminent text output

## Slice #1850

Issue: https://github.com/my-name-is-yu/PulSeed/issues/1850

Base HEAD: `8266cd128659fabc8f0159807e50ee65fff6d5a6`

Branch: `yu/issue-1850-runtime-evidence-gated-status`

PR: https://github.com/my-name-is-yu/PulSeed/pull/1859

### Design Decisions

- Track same-turn runtime/tool evidence in `ChatRunnerEventBridge` from grounded completion/progress events such as successful `tool_end`, `operation_progress`, and tool `agent_timeline` items.
- Add a structured final-answer gate for agent-loop and tool-loop routes. When a final answer makes a current runtime/local status claim without same-turn evidence, or when the checker cannot produce a structured decision, replace it before persistence and gateway projection with bounded uncertainty.
- Keep the gate client separate from other route/approval classifiers so tests and production callers do not accidentally consume unrelated classifier responses.
- Add a model-visible runtime evidence rule to the turn context so the agent loop is instructed not to claim daemon, gateway, command, process, watchdog, runtime, session, or local machine status without trusted evidence.
- Keep the semantic decision in a structured LLM boundary checker rather than keyword, regex, `includes`, or title matching.

### Commands Run

- `git fetch origin main --prune`
- `git switch main`
- `git merge --ff-only origin/main`
- `git worktree add -b yu/issue-1850-runtime-evidence-gated-status /Users/yuyoshimuta/Documents/dev/PulSeed-worktrees/issue-1850-runtime-evidence-gated-status 8266cd128659fabc8f0159807e50ee65fff6d5a6`
- `npm ci`
- `npx vitest run --config vitest.unit.config.ts src/interface/chat/__tests__/cross-platform-session.test.ts --testNamePattern "runtime status"`
- `npx vitest run --config vitest.unit.config.ts src/interface/chat/__tests__/cross-platform-session.test.ts`
- `npx vitest run --config vitest.unit.config.ts src/interface/chat/__tests__/chat-runner.test.ts --testNamePattern "persists assistant message only after streaming completes"`
- `npx vitest run --config vitest.unit.config.ts src/interface/chat/__tests__/cross-platform-session.test.ts src/interface/chat/__tests__/chat-runner.test.ts`
- `npm run typecheck`
- `git diff --check`
- `npm run lint:boundaries -- --quiet`
- `npx vitest run --config vitest.unit.config.ts src/interface/chat/__tests__/chat-boundary-contract.test.ts`
- `npx vitest run --config vitest.unit.config.ts src/orchestrator/execution/__tests__/task-lifecycle-execution.test.ts --testNamePattern "filters diff evidence when adapter reports failure"`
- `npx vitest run --config vitest.unit.config.ts src/interface/chat/__tests__/cross-platform-session.test.ts src/interface/chat/__tests__/chat-boundary-contract.test.ts src/interface/chat/__tests__/chat-runner.test.ts`
- `npm run test:unit`
- `gh pr checks 1859 --watch --interval 10`

### Verification

- Focused runtime status evidence tests: passed.
- Full `cross-platform-session.test.ts`: passed.
- `cross-platform-session.test.ts` + `chat-runner.test.ts`: passed.
- Typecheck: passed.
- Diff whitespace check: passed.
- Boundary lint with `--quiet`: passed.
- Full unit suite: passed after the Codex review fix (`510 passed | 3 skipped`, `8078 passed | 3 skipped`).
- GitHub CI for PR #1859: unit and integration passed after the boundary-test fix.
- Independent review found a material issue in the first draft: unrelated tool/progress evidence could bypass the final-answer gate. Fixed by always running the structured checker when available and passing same-turn evidence refs into that checker. Added a regression test for unrelated failed tool evidence.
- Independent re-review found a tool-loop pre-final leak risk. Fixed gateway tool-loop LLM calls so raw model text is buffered until the gateway evidence gate runs, then only the gated output is projected.
- GitHub Codex review found a material issue: classifier failures were fail-open. Fixed by failing closed to bounded uncertainty and added a regression test for classifier failure.

### Deferred

- Live Telegram dogfood was not run for this slice before PR creation.
- Later slices will address early commentary, streaming, long-wait wording, and native typing timing.

## Slice #1849

Issue: https://github.com/my-name-is-yu/PulSeed/issues/1849

Base HEAD: `cd04e8493793b57b9b7c019b8fd91f39b9e42683`

Branch: `yu/issue-1849-natural-long-wait-status`

PR: https://github.com/my-name-is-yu/PulSeed/pull/1863

### Design Decisions

- Treat generic internal labels such as `Taking action` and generic `tool activity` as unavailable user-level activity, instead of normalizing them to `the current action`.
- Keep safe typed labels such as `Checking the project state` visible through the same renderer.
- Change the unknown waiting fallback to `I'm still checking this. I don't have a more specific visible update yet.` so long waits remain honest without leaking internals.
- Preserve send-only no-spam behavior and keep this slice limited to status text rendering.

### Commands Run

- `git fetch origin main --prune`
- `git worktree add -b yu/issue-1849-natural-long-wait-status /Users/yuyoshimuta/Documents/dev/PulSeed-worktrees/issue-1849-natural-long-wait-status origin/main`
- `npm ci`
- `npx vitest run --config vitest.unit.config.ts src/interface/chat/__tests__/seedy-turn-presence.test.ts src/runtime/gateway/__tests__/seedy-presence-rendering.test.ts src/runtime/gateway/__tests__/seedy-presence-projector.test.ts src/interface/chat/__tests__/chat-runner.test.ts --testNamePattern "waiting|active status|does not spam fallback|presence"` (initially failed before `npm ci`; rerun after install)
- `npx vitest run --config vitest.unit.config.ts src/interface/chat/__tests__/seedy-turn-presence.test.ts src/runtime/gateway/__tests__/seedy-presence-rendering.test.ts src/runtime/gateway/__tests__/seedy-presence-projector.test.ts`
- `npx vitest run --config vitest.unit.config.ts src/interface/chat/__tests__/chat-runner.test.ts src/interface/chat/__tests__/cross-platform-session.test.ts`
- `npx vitest run --config vitest.integration.config.ts src/runtime/gateway/__tests__/seedy-presence-rendering.test.ts src/runtime/gateway/__tests__/seedy-presence-projector.test.ts`
- `npm run typecheck`
- `git diff --check`
- `gh pr checks 1863 --watch --interval 10`
- `gh pr comment 1863 --body '@codex review'`

### Verification

- Presence rendering unit tests: passed.
- Gateway runtime presence rendering/projector integration tests: passed.
- `chat-runner.test.ts` + `cross-platform-session.test.ts`: passed.
- Typecheck: passed.
- Diff whitespace check: passed.
- GitHub CI for PR #1863: unit and integration passed.
- GitHub Codex review for PR #1863: no major issues.

### Deferred

- Live Telegram dogfood has not been rerun for this slice yet.

## Slice #1851

Issue: https://github.com/my-name-is-yu/PulSeed/issues/1851

Initial base HEAD: `2f86bcbb87263ac6908e5f0d2a68831e203e1cc3`

Rebased base HEAD before PR checks: `5712811908a5ed3ddad9e1085f1243bf3523ceb2`

Slice HEAD after rebase: `869dafff96336fb06deb7a73ae6dbc2b105a4f4e`

Branch: `yu/issue-1851-gateway-early-commentary`

PR: https://github.com/my-name-is-yu/PulSeed/pull/1866

### Design Decisions

- Add a gateway commentary preamble generator for agent-loop and tool-loop gateway turns only. Fast direct adapter turns do not emit the extra preamble.
- Keep commentary as a typed `activity` event with `kind: "commentary"` and explicit `presentation.gatewayProgress: "user"`, distinct from final answers and waiting heartbeats.
- Generate the text through a separate light model call that is prompted to avoid runtime claims, raw logs, provider/model names, tool catalogs, trace ids, and secrets.
- Bound the preamble generation call to 1.5s and skip it on timeout/error so actual agent/tool work is not blocked by a slow commentary call.
- Return the generated preamble through a structured JSON contract with `display_text`, safety verdict, and explicit claim flags; unsafe or uncertain structured decisions are not rendered.
- Keep deterministic display-shape checks limited to exact formatting characters after the structured safety contract has allowed the preamble.
- Flush the accepted preamble event before entering the agent/tool execution path so the first meaningful text can render before tool work starts.
- Keep ordinary internal commentary hidden from default gateway progress unless the event explicitly opts into user-facing gateway progress.

### Commands Run

- `git fetch origin main --prune`
- `git worktree add -b yu/issue-1851-gateway-early-commentary /Users/yuyoshimuta/Documents/dev/PulSeed-worktrees/issue-1851-gateway-early-commentary origin/main`
- `npm ci`
- `npx vitest run --config vitest.unit.config.ts src/interface/chat/__tests__/cross-platform-session.test.ts src/interface/chat/__tests__/chat-runner.test.ts`
- `npx vitest run --config vitest.integration.config.ts src/runtime/gateway/__tests__/non-tui-display-projector.test.ts src/runtime/gateway/__tests__/telegram-gateway-adapter.test.ts src/runtime/gateway/__tests__/seedy-presence-projector.test.ts`
- `npm run typecheck`
- `git diff --check`
- GitHub Codex P1 review identified denylist/regex/includes semantic gating in the preamble safety path.
- Replaced the semantic denylist gate with a structured preamble contract and reran:
  - `npx vitest run --config vitest.unit.config.ts src/interface/chat/__tests__/cross-platform-session.test.ts src/interface/chat/__tests__/chat-runner.test.ts`
  - `npx vitest run --config vitest.integration.config.ts src/runtime/gateway/__tests__/non-tui-display-projector.test.ts src/runtime/gateway/__tests__/telegram-gateway-adapter.test.ts src/runtime/gateway/__tests__/seedy-presence-projector.test.ts`
  - `npm run typecheck`
  - `git diff --check`
- Independent re-review identified that preamble delivery could still block agent/tool execution if the gateway event handler stalled.
- Added a bounded delivery wait for gateway preambles plus a production caller-path regression where commentary delivery waits on agent-loop start, then reran:
  - `npx vitest run --config vitest.unit.config.ts src/interface/chat/__tests__/cross-platform-session.test.ts src/interface/chat/__tests__/chat-runner.test.ts`
  - `npx vitest run --config vitest.integration.config.ts src/runtime/gateway/__tests__/non-tui-display-projector.test.ts src/runtime/gateway/__tests__/telegram-gateway-adapter.test.ts src/runtime/gateway/__tests__/seedy-presence-projector.test.ts`
  - `npm run typecheck`
  - `git diff --check`
- GitHub Codex P2 review identified provider reload overwriting explicitly injected gateway commentary clients.
- Preserved explicit `gatewayCommentaryClient` across provider reloads while still defaulting to the fresh provider client when no explicit commentary client was configured, then reran:
  - `npx vitest run --config vitest.unit.config.ts src/interface/chat/__tests__/cross-platform-session.test.ts src/interface/chat/__tests__/chat-runner.test.ts`
  - `npx vitest run --config vitest.integration.config.ts src/runtime/gateway/__tests__/non-tui-display-projector.test.ts src/runtime/gateway/__tests__/telegram-gateway-adapter.test.ts src/runtime/gateway/__tests__/seedy-presence-projector.test.ts`
  - `npm run typecheck`
  - `git diff --check`
- GitHub Codex P1 review then identified that the global cross-platform manager was passing primary `llmClient` as an explicit commentary client, which would pin stale commentary after `/model` reloads.
- Added a separate `defaultGatewayCommentaryClient` dependency so the global manager can provide a default commentary client without using the explicit `gatewayCommentaryClient` override slot; provider reloads update default clients but preserve explicitly injected clients.
- GitHub Codex P2 review identified that aborted turns could still start preamble generation before execution exits.
- Threaded the active abort signal into agent/tool preamble generation and delivery, with an aborted-turn regression ensuring no LLM call is made when the signal is already aborted.
- GitHub Codex P2 review then identified that preamble delivery's 300ms wait should also stop when the turn is aborted; the delivery wait now races against the active abort signal.
- Independent review agent pass, followed by fixes for bounded timeout and safety filtering, then re-review.
- `git fetch origin main --prune`
- `git rebase origin/main`
- `npx vitest run --config vitest.unit.config.ts src/interface/chat/__tests__/cross-platform-session.test.ts src/interface/chat/__tests__/chat-runner.test.ts`
- `npx vitest run --config vitest.integration.config.ts src/runtime/gateway/__tests__/non-tui-display-projector.test.ts src/runtime/gateway/__tests__/telegram-gateway-adapter.test.ts src/runtime/gateway/__tests__/seedy-presence-projector.test.ts`
- `npm run typecheck`
- `git diff --check`

### Verification

- `cross-platform-session.test.ts` + `chat-runner.test.ts`: passed.
- Gateway display/presence integration tests: passed.
- Typecheck: passed.
- Diff whitespace check: passed.
- Independent review: initial material issues fixed; re-review found no high-confidence material regressions.
- Rebase conflict against latest `origin/main` was resolved in `chat-runner.ts`; focused tests/typecheck/diff-check passed again after the rebase.
- GitHub Codex P1 on the original safety filter was fixed by moving safety to a structured model contract rather than keyword/regex/includes semantic matching; focused tests/typecheck/diff-check passed after the fix.
- A local P1 review on stalled gateway delivery was fixed by bounding the preamble delivery wait before agent/tool execution; focused tests/typecheck/diff-check passed after the fix.
- GitHub Codex P2 on provider reload clobbering explicit commentary clients was fixed and covered by a focused `chat-runner.test.ts` regression.
- GitHub Codex P1 on default manager commentary-client pinning was fixed by separating default commentary clients from explicit commentary clients in the typed dependency contract.
- GitHub Codex P2 on aborted-turn preamble generation was fixed by short-circuiting and racing preamble generation against the active abort signal.
- GitHub Codex P2 on aborted-turn preamble delivery waiting was fixed by making the bounded delivery wait abort-aware.

### Deferred

- Live Telegram dogfood has not been rerun for this slice yet.
