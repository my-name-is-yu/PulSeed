# Gateway Progress Narration

> Status: Public design reference. This page explains PulSeed design intent and architecture rationale; exact runtime behavior is owned by current source code, tests, and operating docs.

Primary map: [Operator Narration](./operator-narration-map.md).

PulSeed non-TUI gateway progress uses a typed public narration contract. Default chat surfaces should show short liveness updates derived from event kind, phase, audience, importance, verbosity, and activity category. They must not render diagnostic model/provider/tool-catalog/turn-context details unless a debug surface explicitly asks for them.

## Surface Matrix

| Surface | Consumer | Progress capability | Default policy |
| --- | --- | --- | --- |
| Telegram/Seedy builtin | `src/runtime/gateway/telegram-gateway-adapter.ts` | editable message | shared `NonTuiDisplayProjector`, delete transient progress on completion |
| Telegram plugin | `plugins/telegram-bot/src/telegram-chat-event-adapter.ts` | editable message | shared `NonTuiDisplayProjector`, delete transient progress on completion |
| Slack builtin | `src/runtime/gateway/slack-channel-adapter.ts` | editable threaded messages | shared `NonTuiDisplayProjector`, delete transient progress on completion |
| Discord builtin | `src/runtime/gateway/discord-gateway-adapter.ts` | editable interaction followups | shared `NonTuiDisplayProjector`, delete transient progress on completion |
| Discord plugin | `plugins/discord-bot/src/webhook-server.ts` | followup messages only | shared `NonTuiDisplayProjector`, one concise status at a time |
| Signal builtin | `src/runtime/gateway/signal-gateway-adapter.ts` | send-only | final output only by default |
| WhatsApp builtin | `src/runtime/gateway/whatsapp-gateway-adapter.ts` | send-only | final output only by default |
| HTTP/webhook | `src/runtime/gateway/http-channel-adapter.ts` | no chat display projector | envelope/event path only |
| Notifications | `src/runtime/gateway/core-channel-notification.ts` and notifier plugins | notification text | separate notification formatter, no agent progress transcript |

## Contract

- `GatewayPublicProgress` is the public display input: `audience`, `phase`, `importance`, `verbosity`, `subject`, `reason`, and optional elapsed activity metadata.
- Internal lifecycle, turn-context, model-request, compaction, and ordinary commentary events are not gateway progress.
- Tool and agent timeline events are narrated from typed `activityCategory`, item kind, status, and observation state. Raw command previews, output previews, model names, and tool counts stay diagnostic.
- Approval and action-required states remain visible because they are user decisions, not passive diagnostics.
- Waiting or stale-progress text comes from typed elapsed metadata, not message text matching.
