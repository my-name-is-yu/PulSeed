# Seedy Live Telegram Under 2s Final - Equivalent Measurement Results - 2026-05-11

## Scope

Direct live Telegram testing was not available from this Codex environment. I used the fake-Telegram equivalent path that enters through `dispatchGatewayChatInput`, uses `CrossPlatformChatSessionManager`, `ChatRunner`, the configured OAuth-backed Codex Responses client, `NonTuiDisplayProjector`, and a Telegram-shaped transport.

Measured fields:

- `inbound_admitted_at`
- `first_model_request_started_at`
- `first_model_delta_received_at`
- `first_telegram_send_or_edit_attempted_at`
- `first_telegram_visible_text_confirmed_or_api_returned_at`

## Implementation Status

- `openai_codex_cli` now uses OAuth-backed Codex Responses streaming only when the resolved provider credential is a valid Codex OAuth token. Plain `sk-...` OpenAI API keys remain on the `codex exec` path and are not sent to the ChatGPT backend.
- `sendMessage()` also uses the streaming Responses path when OAuth is available, so structured helper calls do not fall back to `codex exec`.
- Codex Responses function-call SSE parsing now deduplicates `item_id` / `call_id` events.
- Telegram turn timing now records the exact requested timing field names while keeping the previous fields for compatibility.
- Gateway model loop now uses a lighter ordinary-chat request when no tools are selected.
- Gateway model loop now retries a no-tool final when a structured contract check says the user asked for safe current-state evidence and a matching tool is available; the rejected provisional answer is not emitted to Telegram before the retry decision.
- Gateway model-loop no-tool contract failures now fail closed for unavailable/invalid/uncertain contract decisions, while ordinary non-gateway tool-loop behavior remains intact.
- Codex Responses streams that end without a terminal response now fail closed instead of being treated as completed output.
- Codex Responses `response.incomplete` terminal events now fail closed instead of surfacing partial output as a successful answer.
- Codex Responses raw text deltas are now separated from user-visible text deltas: raw deltas drive `first_model_delta_received_at`, while visible text is emitted only after a successful terminal response.
- The fake-Telegram smoke treats error output and missing `first_model_delta_received_at` as failures.

## Fake Telegram Equivalent Evidence

Command shape:

```sh
source ~/.nvm/nvm.sh
nvm use 24.15.0
PULSEED_LIGHT_MODEL=gpt-5.3-codex-spark \
PULSEED_HOME=$(mktemp -d /tmp/pulseed-direct-chat-smoke-live-XXXXXX) \
PULSEED_DIRECT_CHAT_SMOKE_PROVIDER_HOME=/Users/yuyoshimuta/.pulseed-telegram-dogfood-20260511 \
npx tsx src/runtime/gateway/direct-chat-latency-smoke.ts
```

Passing run before the final review fixes:

| Run | inbound_admitted_at | first_model_request_started_at | first_model_delta_received_at | first_telegram_send_or_edit_attempted_at | first_telegram_visible_text_confirmed_or_api_returned_at | Visible ms |
| --- | --- | --- | --- | --- | --- | ---: |
| 1 | 2026-05-11T06:17:27.732Z | 2026-05-11T06:17:27.751Z | 2026-05-11T06:17:28.732Z | 2026-05-11T06:17:28.732Z | 2026-05-11T06:17:28.732Z | 1000 |
| 2 | 2026-05-11T06:17:28.880Z | 2026-05-11T06:17:28.885Z | 2026-05-11T06:17:29.675Z | 2026-05-11T06:17:29.675Z | 2026-05-11T06:17:29.675Z | 795 |
| 3 | 2026-05-11T06:17:29.826Z | 2026-05-11T06:17:29.831Z | 2026-05-11T06:17:31.058Z | 2026-05-11T06:17:31.058Z | 2026-05-11T06:17:31.058Z | 1232 |

Repeat run with the same model showed provider-side variance:

| Run | inbound_admitted_at | first_model_request_started_at | first_model_delta_received_at | first_telegram_send_or_edit_attempted_at | first_telegram_visible_text_confirmed_or_api_returned_at | Visible ms |
| --- | --- | --- | --- | --- | --- | ---: |
| 1 | 2026-05-11T06:17:50.213Z | 2026-05-11T06:17:50.230Z | 2026-05-11T06:17:52.004Z | 2026-05-11T06:17:52.004Z | 2026-05-11T06:17:52.004Z | 1791 |
| 2 | 2026-05-11T06:17:52.152Z | 2026-05-11T06:17:52.156Z | 2026-05-11T06:17:56.970Z | 2026-05-11T06:17:56.970Z | 2026-05-11T06:17:56.970Z | 4818 |
| 3 | 2026-05-11T06:17:57.881Z | 2026-05-11T06:17:57.885Z | 2026-05-11T06:17:59.028Z | 2026-05-11T06:17:59.028Z | 2026-05-11T06:17:59.028Z | 1147 |

`gpt-5.4-mini` also showed variance:

| Run | inbound_admitted_at | first_model_request_started_at | first_model_delta_received_at | first_telegram_send_or_edit_attempted_at | first_telegram_visible_text_confirmed_or_api_returned_at | Visible ms |
| --- | --- | --- | --- | --- | --- | ---: |
| 1 | 2026-05-11T06:16:59.247Z | 2026-05-11T06:16:59.265Z | 2026-05-11T06:17:00.850Z | 2026-05-11T06:17:00.957Z | 2026-05-11T06:17:00.957Z | 1710 |
| 2 | 2026-05-11T06:17:01.346Z | 2026-05-11T06:17:01.351Z | 2026-05-11T06:17:02.075Z | 2026-05-11T06:17:02.084Z | 2026-05-11T06:17:02.084Z | 738 |
| 3 | 2026-05-11T06:17:02.424Z | 2026-05-11T06:17:02.430Z | 2026-05-11T06:17:05.615Z | 2026-05-11T06:17:05.616Z | 2026-05-11T06:17:05.616Z | 3192 |

Passing run after the final review fixes and raw/visible delta split:

| Run | inbound_admitted_at | first_model_request_started_at | first_model_delta_received_at | first_telegram_send_or_edit_attempted_at | first_telegram_visible_text_confirmed_or_api_returned_at | Visible ms |
| --- | --- | --- | --- | --- | --- | ---: |
| 1 | 2026-05-11T06:47:56.180Z | 2026-05-11T06:47:56.197Z | 2026-05-11T06:47:57.543Z | 2026-05-11T06:47:57.616Z | 2026-05-11T06:47:57.616Z | 1436 |
| 2 | 2026-05-11T06:47:57.689Z | 2026-05-11T06:47:57.694Z | 2026-05-11T06:47:59.478Z | 2026-05-11T06:47:59.600Z | 2026-05-11T06:47:59.600Z | 1911 |
| 3 | 2026-05-11T06:47:59.670Z | 2026-05-11T06:47:59.675Z | 2026-05-11T06:48:01.013Z | 2026-05-11T06:48:01.065Z | 2026-05-11T06:48:01.065Z | 1395 |

## Interpretation

PulSeed is now starting the first model request within 5-17ms after fake Telegram admission in the latest run. The raw first model delta arrived within 1338-1789ms, and the fake Telegram transport API returned visible text within 1395-1911ms.

The latest equivalent run passed the 2s threshold for all three `やあ！` turns. Earlier repeat runs still showed provider-side `first_model_delta_received_at` variance, so this proves the PulSeed path can hit the target in this environment but does not prove a hard provider-side latency guarantee.

Because this is a fake Telegram transport, `first_telegram_visible_text_confirmed_or_api_returned_at` means "fake transport API returned". It does not prove real Telegram client visibility.

## Verification

- `npx vitest run --config vitest.unit.config.ts src/base/llm/__tests__/codex-llm-client.test.ts src/interface/chat/__tests__/cross-platform-session.test.ts -t "Codex Responses streaming|gateway default model-loop|fails closed without leaking"` passed.
- `npx vitest run --config vitest.unit.config.ts src/interface/chat/__tests__/tool-filtering.test.ts src/interface/chat/__tests__/cross-platform-session.test.ts -t "does not send deferred|sends alwaysLoad|fails closed without leaking"` passed.
- `npx vitest run --config vitest.unit.config.ts src/base/llm/__tests__/codex-llm-client.test.ts src/interface/chat/__tests__/cross-platform-session.test.ts src/interface/chat/__tests__/tool-filtering.test.ts` passed.
- `npx vitest run --config vitest.integration.config.ts src/runtime/gateway/__tests__/telegram-gateway-adapter.test.ts src/runtime/gateway/__tests__/direct-chat-first-visible-latency.test.ts` passed.
- `npm run test:changed` passed.
- `npm run typecheck` passed.
- `npm run build` passed.
- `npm run lint:boundaries` passed with existing warnings.
- `git diff --check` passed.
- `PULSEED_LIGHT_MODEL=gpt-5.3-codex-spark PULSEED_HOME=$(mktemp -d /tmp/pulseed-direct-chat-smoke-live-XXXXXX) PULSEED_DIRECT_CHAT_SMOKE_PROVIDER_HOME=/Users/yuyoshimuta/.pulseed-telegram-dogfood-20260511 npx tsx src/runtime/gateway/direct-chat-latency-smoke.ts` passed with visible ms values 1436, 1911, and 1395.
