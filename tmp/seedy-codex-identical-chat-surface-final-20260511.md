# Seedy Codex-Identical Chat Surface Final - 2026-05-11

## Status

Merged. Live Telegram dogfood environment prepared on the Mac mini; live messages remain user-driven.

## Heads

- Base HEAD: `d8d368ceb7799a776eb7811932b8a76a5ee77543`
- Final HEAD: `2680718f9cd6b9beb5ad9df800ed2f8a5389dd1d`
- PR: `#1918`
- Merged commit: `cc9c6d23df9935bbbf89993aff2d47dc506c5369`
- Main artifact HEAD: `9c960cf6aa2a7992821ff24da76f57c5023d6a96`

## Architecture Changes

- Added a real `gateway_model_loop` route for default gateway ordinary chat.
- Gateway ordinary chat now prefers one model/tool-choice loop when LLM and tool registry are available.
- The gateway default loop avoids pre-model `buildChatContext()`, `groundingGateway.build()`, native coding-agent context, `classifyFreeformRouteIntent()`, and `deriveRunSpecFromText()`.
- Natural-language setup/run-spec/tool-needed requests stay inside the default tool-choice loop instead of pre-model semantic route splitting.
- Tool-call preambles from the model are projected as model-authored commentary; no-tool text is projected as final-answer deltas.
- The gateway catalog is curated to read/search/setup/runtime/run-spec handoff tools instead of the full native coding-agent catalog.

## Safety And Rendering

- Evidence gate now supports `allow`, `repair`, and `block`.
- Safe repairs preserve conversational text while removing unsupported workspace/runtime claims.
- Classifier unavailable or malformed output fails closed instead of using local keyword fallback.
- Gateway final streaming uses sentence/newline buffering and same-turn evidence checks before displaying spans.
- Fixed route/lifecycle narration such as `intent:first-step` and `lifecycle:*` is suppressed from ordinary gateway progress.
- Real tool/wait/block progress remains renderable.
- Telegram native typing starts immediately after inbound admission.

## Verification

- `npm run typecheck`
- `npm run build`
- `npm run lint:boundaries` (passed with existing warnings)
- `git diff --check`
- `npx vitest run --config vitest.unit.config.ts src/interface/chat/__tests__/cross-platform-session.test.ts src/interface/chat/__tests__/ingress-router.test.ts src/interface/chat/__tests__/model-request-builder.test.ts`
- `npx vitest run --config vitest.integration.config.ts src/runtime/gateway/__tests__/non-tui-display-projector.test.ts src/runtime/gateway/__tests__/seedy-presence-projector.test.ts src/runtime/gateway/__tests__/telegram-gateway-adapter.test.ts`
- `npx vitest run --config vitest.unit.config.ts src/interface/chat/__tests__/cross-platform-session.test.ts src/interface/chat/__tests__/ingress-router.test.ts src/interface/chat/__tests__/chat-runner.test.ts --testNamePattern "gateway|runtime evidence|agent loop and native tool protocol routing"`
- `npx vitest run --config vitest.unit.config.ts plugins/telegram-bot/__tests__/telegram-bot-plugin.test.ts src/runtime/gateway/__tests__/non-tui-display-projector.test.ts src/runtime/gateway/__tests__/seedy-presence-projector.test.ts src/runtime/gateway/__tests__/telegram-gateway-adapter.test.ts`

## Review Outcome

- Fresh review agent found two material issues:
  - external-surface runtime policy still triggered pre-model runtime-control classification for ordinary Telegram gateway turns
  - evidence-gate classifier outage fallback could fail open through local keyword misses
- Both issues were fixed.
- Fresh re-review found no material findings.
- GitHub CI initially failed because the Telegram plugin test still expected fixed `intent:first-step` progress to render; the fixture was updated to model-authored commentary.
- GitHub Codex review on latest commit `2680718f9c` returned no material comments.
- GitHub CI after the fix:
  - `unit (22)`: passed
  - `integration (24)`: passed

## Live Telegram Dogfood

Prepared on the Mac mini without sending Telegram messages.

- Worktree: `/Users/yuyoshimuta/PulSeed-live-telegram-dogfood-20260511`
- Home: `/Users/yuyoshimuta/.pulseed-telegram-dogfood-20260511`
- Worktree HEAD: `9c960cf6aa2a7992821ff24da76f57c5023d6a96`
- Build: `npm run build` passed on the Mac mini.
- Daemon: restarted in the isolated home with Node v24.15.0 and `--detach`.
- Daemon status: idle, runtime health ok, Telegram and HTTP gateway adapters started.
- Baseline observation: `outbox_records` latest seq `505`; no runtime operation or queue records before the live-message pass.

Ask the user to send:

1. `やあ！`
2. `このリポジトリにREADMEがあるかだけ軽く見て`
3. `今のPulSeedの状態を軽く確認して`
4. `PulSeedの進捗だけ軽く教えて`

Codex should inspect logs/control DB/timing before and after each user message. Codex must not send Telegram messages itself.

## Remaining Risks

- Live Telegram dogfood message responses are still required because local tests and daemon preparation cannot prove real bot/channel timing and edit behavior.
- `npm run lint:boundaries` still reports existing repository warnings, but exits successfully with no errors.
