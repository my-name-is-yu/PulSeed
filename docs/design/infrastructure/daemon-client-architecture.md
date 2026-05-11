# Daemon-Client Architecture

> Status: Design document. Verify behavior against source code and current operating docs before treating this as implementation guidance.

**Status:** Design
**Author:** Auto-generated
**Date:** 2026-04-05

> Current implementation note: the runtime has evolved beyond the exact TUI/daemon split described below. TUI, chat, daemon, and schedule flows now all sit on top of the shared DurableLoop + AgentLoop runtime stack. Read this document as a direction for daemon/client ownership, not a line-by-line map of the current interface code.

## Overview

This design makes the daemon the single owner of long-lived goal execution, with TUI and future clients acting as disposable surfaces over the same runtime state.

## Architecture

```
┌─────────────┐   ┌─────────────┐   ┌─────────────┐
│   TUI (Ink)  │   │  Remote UI  │   │  Telegram   │
│   client     │   │  client     │   │  client     │
└──────┬───────┘   └──────┬───────┘   └──────┬───────┘
       │                  │                  │
       └──────── SSE + REST ─────────────────┘
                          │
              ┌───────────▼───────────┐
              │   Daemon Process       │
              │   ┌─────────────────┐ │
              │   │ EventServer     │ │
              │   │ :41700          │ │
              │   ├─────────────────┤ │
              │   │ DurableLoop(s)     │ │
              │   │ per-goal        │ │
              │   ├─────────────────┤ │
              │   │ ApprovalQueue   │ │
              │   │ pending→client  │ │
              │   └─────────────────┘ │
              │   ~/.pulseed/ (state) │
              └───────────────────────┘
```

## Protocol: SSE for push, REST for commands

**Why SSE over WebSocket:**
- Daemon→client is one-directional push (state changes, approval status, log lines)
- Client→daemon commands are request/response (start goal, chat, runtime control) — REST is natural
- SSE reconnects automatically (built into EventSource API and trivial to implement server-side)
- No additional dependencies — Node.js `http` module suffices

## Event Types (SSE)

| Event | Data | When |
|-------|------|------|
| `iteration_complete` | `{ goalId, iteration, gapScore, driveScore }` | After each DurableLoop iteration |
| `goal_updated` | `{ goalId, status, progress }` | Goal state changes |
| `approval_required` | `{ requestId, goalId, task, description }` | Daemon needs human approval; clients may display status only |
| `approval_resolved` | `{ requestId, approved }` | Approval answered |
| `chat_response` | `{ goalId, message }` | Response to chat command |
| `daemon_status` | `{ status, activeGoals[], uptime }` | Periodic heartbeat (every 30s) |
| `error` | `{ goalId?, message, code }` | Errors during execution |

## REST API Endpoints (EventServer extension)

### Existing (unchanged)
- `GET /health` — daemon health check
- `POST /events` — external event injection
- `POST /triggers` — trigger evaluation
- `GET /goals` — list all goals
- `GET /goals/:id` — get single goal

### New: Streaming
- `GET /stream` — SSE event stream. Supports `Last-Event-ID` for reconnection. Each event has an incrementing ID.

### New: Control
- `POST /goals/:id/start` — start running a goal
- `POST /goals/:id/stop` — stop running a goal
- `POST /goals/:id/chat` — `{ message: string }` — send chat message for goal context
- `GET /daemon/status` — daemon state (active goals, uptime, PID)

## Approval Bridge

Current state: approval records are owned by `ApprovalBroker` and persisted through the runtime approval store. User-facing approval decisions are conversational: the broker routes the structured approval prompt back to the originating conversation channel, and replies are interpreted by the shared conversational approval decision contract before any high-risk action resumes.

Conversational approval flow:
1. Runtime encounters an action requiring approval.
2. `ApprovalBroker` writes a pending approval record with origin metadata for channel, conversation, session, user, and reply target.
3. The broker delivers the approval prompt through the originating conversation adapter.
4. DurableLoop or runtime-control execution blocks while the approval remains pending.
5. A reply in the same conversation is classified as `approve`, `reject`, `clarify`, or `unknown` with the active approval context.
6. Only an origin-matched `approve` or `reject` resolves the stored approval; `clarify` and `unknown` keep the original record pending.
7. The broker emits status/audit events such as `approval_required` and `approval_resolved`.

TUI and daemon clients may show `approval_required` as status or timeline context, but they must not provide a separate button, overlay, prompt parser, or REST wrapper that resolves approval outside the originating conversation path.

**Timeout:** If no conversation reply resolves the approval within the configured timeout, deny or pause by default. Unreachable delivery must never imply approval.

## Key Components

### EventServer Changes (~150 lines added)
- Add SSE client tracking (Set of response objects)
- Add `GET /stream` handler with keep-alive
- Add `broadcast(event, data)` method
- Add REST control endpoints
- Add approval queue (Map<requestId, {resolve, timeout}>)

### DaemonRunner Changes (~80 lines added)
- EventServer always-on (remove optional gate)
- After each `coreLoop.run()`: `eventServer.broadcast('iteration_complete', {...})`
- After state save: `eventServer.broadcast('goal_updated', {...})`
- Wire `approvalFn` to use EventServer approval queue
- Heartbeat timer for `daemon_status` events

### New: daemon-client.ts (~200 lines)
Client library for TUI/Web to connect to daemon:
- `DaemonClient.connect(port)` — establish SSE connection
- `DaemonClient.on(event, handler)` — event subscription
- `DaemonClient.startGoal(goalId)` — REST wrapper
- `DaemonClient.stopGoal(goalId)` — REST wrapper
- `DaemonClient.chat(goalId, message)` — REST wrapper
- `DaemonClient.getStatus()` — REST wrapper
- Auto-reconnect with exponential backoff

### TUI entry.ts Changes (rewrite ~200 lines)
Startup flow:
1. `ensureProviderConfig()`
2. Check `daemon-state.json` + probe PID → daemon running?
3. If NO: spawn daemon (`daemon start --detach`) → wait for `/health` ready
4. Create `DaemonClient` → connect to daemon
5. Render `<App>` with `daemonClient` instead of `coreLoop`

### TUI use-loop.ts Changes (rewrite ~200 lines)
- Subscribe to DaemonClient SSE events instead of polling
- `LoopController.start()` → `daemonClient.startGoal()` instead of `coreLoop.run()`
- Approval: listen for `approval_required` → append status/timeline notice only; approval decisions stay in the originating conversation channel
- Chat: `daemonClient.chat()` instead of direct `chatRunner.execute()`

## Migration Strategy

**Backward compatibility:** Keep `pulseed run --goal <id>` as standalone DurableLoop execution (no daemon). Only `pulseed` (TUI) uses daemon mode.

**Standalone fallback:** If daemon can't start (port conflict, etc.), TUI falls back to current standalone mode with a warning.

## Implementation Order

1. EventServer SSE + REST endpoints (no daemon changes yet — testable standalone)
2. DaemonRunner always-on EventServer + event emission
3. daemon-client.ts (testable against running daemon)
4. TUI entry.ts daemon detection + auto-start
5. TUI use-loop.ts SSE-driven
6. Integration test: full flow
