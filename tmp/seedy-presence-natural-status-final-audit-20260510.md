# Seedy Presence Natural Status Final Audit

Date: 2026-05-10
Repository: `/Users/yuyoshimuta/Documents/dev/PulSeed`
Audited HEAD: `3eed9d4a5526915ef6800caf594f77cee25df89d`

## Scope

This audit closes the live Telegram dogfood follow-up for issues #1821, #1822, and #1823, then checks the remaining Seedy Presence Foundation goal:

> During longer work, Seedy should naturally explain what it is doing in user-level language without leaking raw PulSeed/runtime/model/tool internals.

The audit is limited to text-channel and typed state behavior. No GUI implementation was added.

## Merged PRs

| PR | Merge commit | Result |
| --- | --- | --- |
| #1829 Suppress final-candidate progress in Telegram gateway | `b1cb48d8d30d85f028477fd5b05eb8181969333f` | Fixes #1821. |
| #1831 Fail closed on unsupported control DB schema | `8465095823c2bbca6f99867136ec359cb7fe9fc7` | Fixes #1822. |
| #1835 Prefer live daemon status in runtime evidence answers | `7d87d012a813fa6b7e16ff74f7327660ce3bfbf5` | Fixes #1823. |
| #1838 Render natural Seedy waiting status | `84fd3b324ec32b989fee52546804e6ab0c847241` | Replaces fixed waiting placeholder text with typed, natural Seedy wording. |
| #1841 Improve active Seedy status wording | `3eed9d4a5526915ef6800caf594f77cee25df89d` | Aligns active status-query wording with the same safe typed activity renderer. |

## Issue Closure

| Issue | Status | Closed at |
| --- | --- | --- |
| #1821 Telegram gateway briefly exposes finalizing progress before the final answer | Closed | 2026-05-10T11:35:54Z |
| #1822 Daemon schema drift can silently break Telegram turns until the runtime is rebuilt | Closed | 2026-05-10T12:07:24Z |
| #1823 Runtime-aware Telegram self-check can report stale daemon status after recovery | Closed | 2026-05-10T12:32:35Z |

## Design Target Audit

| Target | Current result |
| --- | --- |
| `SeedyTurnPresence` remains typed state, not raw logs | Implemented. Presence and active status continue to flow through typed `SeedyTurnPresence` / `SeedyActiveTurnStatus`. |
| `GatewayPublicProgress` remains meaningful progress, not native typing | Implemented. Native typing is still handled by presence projection; meaningful progress remains a separate public progress contract. |
| Long-running turns emit `waiting` after stale threshold based on activity age | Implemented. `ChatRunnerEventBridge` emits a typed waiting heartbeat after the stale threshold using `last_activity_at` and elapsed metadata. |
| Waiting text sounds like Seedy and explains user-level activity | Implemented. Gateway and active status query render `I'm still working on it...` with safe typed activity when available. |
| If exact activity is unavailable, fallback is honest | Implemented. Unsafe or unavailable activity falls back to `I don't have a new visible update yet.` |
| Telegram uses native typing immediately and editable status only when meaningful | Implemented in the presence projector and channel presence policy; no Telegram GUI work was added. |
| Final answer and progress/status remain separate | Implemented. #1821 suppresses final-imminent `final_candidate` leakage without removing waiting/tool/blocker progress. |
| Fast final answers are not delayed | Preserved. No fixed response delay was added. |
| Text-only channels do not spam | Covered by existing projector no-spam tests for repeated waiting heartbeats and send-only fallback behavior. |
| No model/provider/tool catalog/trace/raw command output leaks | Improved. Shared `safeSeedyPresenceActivity` filters unsafe model/provider/token/command/path-like typed fragments before rendering public status text. |
| Downstream of companion-autonomy expression/visibility policy | Preserved. The work only renders admitted user-initiated turn state and does not add proactive speech authority. |

## Remaining Risk

- Live Telegram dogfood was not re-run in this final audit PR. The code path is covered by focused gateway/chat tests and GitHub CI, but the final user-visible Telegram timing should still be spot-checked on the Mac mini.
- Internal lifecycle labels such as `Finalizing response...` still exist inside chat-runner code for internal state progression. The user-facing leak fixed in #1821 was the non-TUI/TG projection of final-imminent progress, not removal of all internal lifecycle labels.
- The shared safe text helper intentionally filters only public rendering fragments. It should not be reused as a semantic classifier for freeform intent.

## Suggested User-Assisted Telegram Dogfood

Run from the Mac mini checkout at `/Users/yuyoshimuta/PulSeed` after syncing latest `main`, rebuilding, and restarting the daemon/gateway there. Do not start the daemon on the MacBook.

Suggested scenarios:

1. Short direct answer: send `今いる？`
2. Status/progress question: send `今なにしてる？`
3. Runtime-aware turn: send `今のPulSeedの状態を軽く確認して`
4. Long wait: send a request likely to run longer than 35 seconds, then ask `今なにしてる？` while it is active
5. Blocked or approval-like path: use an operation that requires approval or another safe controlled blocker

Expected result:

- Native typing appears promptly when Telegram supports it.
- Fast final answers are final-only or near-final-only.
- Long work shows at most one meaningful editable waiting status after the stale threshold.
- Status text should use user-level wording such as `I'm still working on it. Last visible activity: ...`.
- Unsafe model/provider/tool/command/path details should not appear in public status text.
