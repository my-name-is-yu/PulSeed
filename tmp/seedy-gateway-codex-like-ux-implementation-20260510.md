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
- Independent review found that native-capable fallback final output could be rendered after `presenceProjector.stop()`, skipping final-imminent typing when no event-stream final had been delivered.
- Moved Telegram/Discord fallback final rendering before presence stop and prepared the fallback `assistant_final` output moment first. Rechecked fallback-safe adapters and reran:
  - `npx vitest run --config vitest.integration.config.ts src/runtime/gateway/__tests__/seedy-presence-projector.test.ts src/runtime/gateway/__tests__/telegram-gateway-adapter.test.ts src/runtime/gateway/__tests__/discord-gateway-adapter.test.ts src/runtime/gateway/__tests__/slack-channel-adapter.test.ts src/runtime/gateway/__tests__/signal-gateway-adapter.test.ts src/runtime/gateway/__tests__/whatsapp-gateway-adapter.test.ts`
  - `npx vitest run --config vitest.unit.config.ts src/interface/chat/__tests__/cross-platform-session.test.ts src/interface/chat/__tests__/chat-runner.test.ts`
- Independent re-review found fallback final delivery failures could still skip `presenceProjector.stop()` after native typing had started. Wrapped fallback final rendering in inner `try/finally` cleanup and added a Telegram regression where fallback `sendMessage` fails after `sendChatAction`.
- Reran:
  - `npx vitest run --config vitest.integration.config.ts src/runtime/gateway/__tests__/seedy-presence-projector.test.ts src/runtime/gateway/__tests__/telegram-gateway-adapter.test.ts src/runtime/gateway/__tests__/discord-gateway-adapter.test.ts src/runtime/gateway/__tests__/slack-channel-adapter.test.ts src/runtime/gateway/__tests__/signal-gateway-adapter.test.ts src/runtime/gateway/__tests__/whatsapp-gateway-adapter.test.ts`
  - `npx vitest run --config vitest.unit.config.ts src/interface/chat/__tests__/cross-platform-session.test.ts src/interface/chat/__tests__/chat-runner.test.ts`
  - `npm run typecheck`
  - `git diff --check`
- GitHub Codex review on PR #1876 found that `prepareForEvent` could start Telegram typing before events the Telegram adapter intentionally drops, such as `operation_progress` with `metadata.source === "agent_timeline_activity_summary"`.
- Added a typed `TelegramChatEventAdapter.shouldRender` guard and use it before native typing preparation, then added a regression proving dropped summary progress does not send `sendChatAction`.
- Reran:
  - `npx vitest run --config vitest.integration.config.ts src/runtime/gateway/__tests__/seedy-presence-projector.test.ts src/runtime/gateway/__tests__/telegram-gateway-adapter.test.ts src/runtime/gateway/__tests__/discord-gateway-adapter.test.ts src/runtime/gateway/__tests__/slack-channel-adapter.test.ts src/runtime/gateway/__tests__/signal-gateway-adapter.test.ts src/runtime/gateway/__tests__/whatsapp-gateway-adapter.test.ts`
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

## Slice #1855

Issue: https://github.com/my-name-is-yu/PulSeed/issues/1855

Base HEAD: `74e25d85a2488f9f2fd536dbab6e29f085ab61b5`

Branch: `yu/issue-1855-native-typing-timing`

PR: pending

### Design Decisions

- Native typing is no longer tied to generic turn-running presence updates. `received`, `thinking`, and `acting` presence can keep the turn alive without holding a platform spinner.
- Added an explicit `prepareForEvent` step on `SeedyPresenceProjector` so adapters can start native typing immediately before output-bearing events are rendered.
- Native typing now maps to output moments: user-visible commentary/status/progress, assistant deltas/final output, and delayed editable waiting status sends/edits.
- Waiting/status text remains the liveness mechanism for long work; native typing is started only around the actual status send/edit and then stopped.
- Assistant streaming keeps native typing active while final-answer deltas are being emitted, then stops on `assistant_final`/turn completion.
- Fallback channels with no native typing continue to use delayed fallback acknowledgements and final/progress delivery state.

### Commands Run

- `git fetch origin main --prune`
- `git switch main`
- `git merge --ff-only origin/main`
- `git worktree add -b yu/issue-1855-native-typing-timing /Users/yuyoshimuta/Documents/dev/PulSeed-worktrees/issue-1855-native-typing-timing origin/main`
- `npm ci`
- Initial focused tests failed before `npm ci` because the fresh worktree had no local `node_modules`; reran after install.
- `npx vitest run --config vitest.integration.config.ts src/runtime/gateway/__tests__/seedy-presence-projector.test.ts src/runtime/gateway/__tests__/telegram-gateway-adapter.test.ts src/runtime/gateway/__tests__/slack-channel-adapter.test.ts`
- `npx vitest run --config vitest.unit.config.ts src/interface/chat/__tests__/cross-platform-session.test.ts src/interface/chat/__tests__/chat-runner.test.ts`
- `npm run typecheck`
- `git diff --check`

### Verification

- Long wait-only presence test shows native typing is not held continuously.
- Commentary/status output test shows native typing starts near rendered status output and stops after delivery.
- Waiting heartbeat/status test shows typing starts only when the delayed status is actually sent.
- Final streaming test shows typing starts for assistant deltas and stops on final output.
- Telegram adapter test now confirms `presence_update(received)` alone does not send `sendChatAction`, while a rendered commentary/final output event does.
- Slack/fallback behavior remains covered by existing projector and adapter tests.
- Independent review material issue on fallback final typing was fixed; gateway adapter regression tests passed after the fix.
- Independent re-review material issue on fallback delivery failure cleanup was fixed; Telegram regression confirms typing does not refresh again after fallback send failure.
- GitHub Codex P2 on typing for dropped Telegram summary events was fixed; the latest focused gateway/unit tests, typecheck, and diff whitespace check passed.

### Deferred

- Live Telegram dogfood has not been rerun for this slice yet.

## Slice #1852

Issue: https://github.com/my-name-is-yu/PulSeed/issues/1852

Base HEAD: `52f6dc1353bd95ba7baed7d8a655fc31caf434e0`

Branch: `yu/issue-1852-gateway-assistant-streaming`

PR: https://github.com/my-name-is-yu/PulSeed/pull/1871

### Design Decisions

- Preserve existing `assistant_delta` events as the shared chat/gateway streaming contract.
- Keep final-answer streaming separate from progress/commentary/status surfaces; progress still uses the progress surface and assistant text uses the final-answer surface.
- Add projector-side stable-boundary buffering for edit-stream surfaces. Partial fragments are held until a newline or sentence boundary is available, and incomplete fenced code blocks are not emitted mid-fence.
- Add simple backpressure for partial edits: after the first stable chunk, edit updates are rate-limited unless the buffered backlog grows enough to catch up.
- Keep edit-capable transports on one final-answer surface: a stable partial chunk sends the final surface once, later stable/final text edits the same surface.
- Preserve send-once/chunked fallback behavior for transports without streaming support.
- Bridge native agent-loop `final_candidate` snapshots into `assistant_delta` events for non-gateway-gated turns using full event content, not the truncated timeline preview.
- Keep gateway runtime-evidence-gated agent-loop turns from streaming final-candidate text before the full evidence gate has allowed the final answer; this prevents unverified runtime/status claims from leaking through partial deltas.
- Treat complete trailing fenced code blocks as stable assistant text so edit-stream transports do not temporarily render closed code blocks as unclosed partial Markdown.

### Commands Run

- `git fetch origin main --prune`
- `git switch main`
- `git merge --ff-only origin/main`
- `git worktree add -b yu/issue-1852-gateway-assistant-streaming /Users/yuyoshimuta/Documents/dev/PulSeed-worktrees/issue-1852-gateway-assistant-streaming origin/main`
- `npm ci`
- `npx vitest run --config vitest.integration.config.ts src/runtime/gateway/__tests__/non-tui-display-projector.test.ts`
- `npx vitest run --config vitest.unit.config.ts src/interface/chat/__tests__/cross-platform-session.test.ts src/interface/chat/__tests__/chat-runner.test.ts`
- `npx vitest run --config vitest.integration.config.ts src/runtime/gateway/__tests__/non-tui-display-projector.test.ts src/runtime/gateway/__tests__/telegram-gateway-adapter.test.ts src/runtime/gateway/__tests__/slack-channel-adapter.test.ts src/runtime/gateway/__tests__/seedy-presence-projector.test.ts`
- `npm run typecheck`
- `git diff --check`
- GitHub unit CI failed in `plugins/telegram-bot/__tests__/telegram-bot-plugin.test.ts` because the test still expected unstable short partial text to create an editable assistant message.
- Updated plugin Telegram tests to expect final-send fallback when no stable partial boundary was published, then reran:
  - `npx vitest run --config vitest.unit.config.ts plugins/telegram-bot/__tests__/telegram-bot-plugin.test.ts --testNamePattern "assistant|delta|stream|final|edit"`
  - `npx vitest run --config vitest.unit.config.ts src/interface/chat/__tests__/cross-platform-session.test.ts src/interface/chat/__tests__/chat-runner.test.ts plugins/telegram-bot/__tests__/telegram-bot-plugin.test.ts`
  - `npx vitest run --config vitest.integration.config.ts src/runtime/gateway/__tests__/non-tui-display-projector.test.ts src/runtime/gateway/__tests__/telegram-gateway-adapter.test.ts src/runtime/gateway/__tests__/slack-channel-adapter.test.ts src/runtime/gateway/__tests__/seedy-presence-projector.test.ts`
  - `npm run typecheck`
  - `git diff --check`
- GitHub Codex review on commit `46160d4e67` found three material issues: runtime-gated final-candidate streaming could leak unverified status claims, agent-loop streaming used truncated `contentPreview`, and complete fenced code blocks could be emitted as unclosed partials.
- Fixed those review findings, then reran:
  - `npx vitest run --config vitest.unit.config.ts src/interface/chat/__tests__/cross-platform-session.test.ts src/interface/chat/__tests__/chat-event-state.test.ts`
  - `npx vitest run --config vitest.integration.config.ts src/runtime/gateway/__tests__/non-tui-display-projector.test.ts src/runtime/gateway/__tests__/telegram-gateway-adapter.test.ts src/runtime/gateway/__tests__/slack-channel-adapter.test.ts src/runtime/gateway/__tests__/seedy-presence-projector.test.ts`
  - `npm run typecheck`
  - `git diff --check`
- GitHub unit CI then exposed a timing-sensitive approval test in `cross-platform-session.test.ts`; the test now waits for the pending approval record before sending the narrowed-grant reply.
- Reran:
  - `npx vitest run --config vitest.unit.config.ts src/interface/chat/__tests__/cross-platform-session.test.ts`
  - `npx vitest run --config vitest.unit.config.ts src/interface/chat/__tests__/chat-event-state.test.ts src/interface/chat/__tests__/cross-platform-session.test.ts`
  - `npm run typecheck`
  - `git diff --check`

### Verification

- Non-TUI display projector streaming/buffering tests: passed.
- Production gateway assist caller-path streaming test: passed with multiple `assistant_delta` events before `assistant_final`.
- Telegram/Slack gateway adapter display tests: passed.
- Seedy presence projector regression tests: passed.
- Typecheck: passed.
- Diff whitespace check: passed.
- Independent review identified a material blocker: native agent-loop output still only emitted a completed-output delta immediately before final. Fixed by streaming eligible `final_candidate` snapshots through the shared event bridge and adding a gateway agent-loop caller-path regression.
- GitHub unit CI failure in Telegram plugin tests was fixed by aligning plugin expectations with stable-boundary buffering; focused plugin and gateway tests passed.
- GitHub Codex P1/P2 findings on the latest review were fixed locally; focused unit/integration tests, typecheck, and diff whitespace check passed after the fix.
- GitHub unit CI timing failure in the approval-grant regression was fixed by making the test wait for the real pending approval record before submitting the reply.

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
