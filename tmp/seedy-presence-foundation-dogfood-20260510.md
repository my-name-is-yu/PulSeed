# Seedy Presence Foundation Final Audit And Dogfood

Date: 2026-05-10
Base: `origin/main` at `94707daf` after PR #1813.
Scope: Slice 10, final integration audit and simulated dogfood for the Seedy presence foundation.

## Summary

The Seedy presence foundation is implemented across the contract, GUI-ready view model, channel capability policy, shared gateway projector, production chat runner presence events, native Telegram/Discord presence, Slack editable status projection, send-only fallback acknowledgement, and waiting heartbeat/status query.

This slice adds a focused renderer audit test so gateway presence text cannot accidentally leak raw model, provider, tool-catalog, trace, compaction, or command-output details from typed presence metadata.

## Implemented Paths

- Contract: `SeedyTurnPresence` and `presence_update` provide the typed per-turn state.
- GUI substrate: `renderSeedyPresenceViewModel` maps typed phases to body state, compact status, and surface hints without building the GUI app.
- Channel policy: Telegram and Discord resolve to native ephemeral presence; Slack resolves to editable status; WhatsApp and Signal resolve to delayed send-only fallback; webhook remains diagnostic/final-only.
- Projector: `SeedyPresenceProjector` coordinates native typing, editable status, send-on-delay fallback, cleanup on final/error, and suppression of repeated send-only heartbeat messages.
- Production ingress: gateway adapters and `ChatRunner` emit `received` and `orienting` before route/model/tool work.
- Waiting heartbeat: active turn state emits typed `waiting` after stale `last_activity_at` and exposes typed active status without granting proactive expression authority.

## Simulated Dogfood Scenarios

| Scenario | Verified path | Result |
| --- | --- | --- |
| Short direct question | Fast final in Slack, WhatsApp, Signal, Telegram adapter tests | Final output appears without fixed artificial delay or extra status spam. |
| Status/progress question | `getActiveSeedyTurnStatus` and formatter tests | Status reports phase, subject, elapsed activity, waiting, blocked, and action-required state from typed presence. |
| Tool-using turn | Gateway progress/projector tests and adapter progress tests | Meaningful progress cancels delayed fallback and stays separate from final answer content. |
| 30s+ wait | ChatRunner waiting heartbeat test | Typed `waiting` emits from elapsed `last_activity_at`, then later visible activity moves the turn back out of waiting. |
| Blocked/failure | ChatRunner lifecycle error/failure paths and renderer audit | Blocked/action-required presence is represented as user-input needed, not raw logs. |
| Telegram or closest channel | Telegram adapter tests | Native typing starts through the shared projector before dispatch work and stops on final/error cleanup. |

## Guardrail Audit

- Presence remains downstream of user-initiated/admitted turns. `SeedyTurnPresence` does not create `OutcomeDecision`, `ExpressionDecision`, or visibility-policy authority.
- Channel adapters provide capabilities and transport operations; they do not infer Seedy state from message text.
- Renderer wording is owned by gateway rendering and is generic. It does not copy typed metadata such as model names, provider ids, tool catalog names, trace ids, compaction summaries, or command output.
- Fast final answers are not delayed by a global artificial sleep.
- Text-only channels degrade by capability and suppress repeated send-only heartbeat messages.

## Remaining Follow-Up Suggestions

- Run one live Telegram dogfood pass against a real bot token before a user-facing release.
- Add persistent restart recovery for active presence only if daemon restart UX proves confusing in real use.
- Connect the future GUI body to the existing `SeedyPresenceViewModel` stream without adding local autonomy admission logic in the GUI.
