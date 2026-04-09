# Runtime Auto-Recovery

This document describes the production runtime recovery design for PulSeed's long-lived daemon. It replaces the earlier in-memory queue design with a durable single-node runtime that can recover from daemon, dispatcher, and worker failures without allowing duplicate execution for the same goal.

## Summary

PulSeed runs under a two-process model:

1. A `RuntimeWatchdog` parent process owns the visible daemon PID and restarts the child when health stops advancing.
2. A single runtime daemon child acquires a leader lock, accepts ingress durably, dispatches commands and events, and supervises goal execution.

The runtime is single-node by design. It does not require Redis or another external broker.

## Goals

- Restart automatically after daemon failure.
- Preserve accepted commands and events across process crashes.
- Prevent concurrent execution of the same `goal_id`.
- Preserve pending approvals across restarts.
- Allow clients to catch up from a durable outbox instead of depending on live SSE only.

## Non-Goals

- Multi-node consensus or distributed scheduling.
- Exactly-once delivery for arbitrary external side effects.
- Forcibly interrupting an in-flight goal iteration on `goal_stop`.

## Architecture

```text
RuntimeWatchdog
  └── Runtime Daemon
        ├── Gateway / EventServer ingress
        ├── JournalBackedQueue
        ├── CommandDispatcher
        ├── EventDispatcher
        ├── LoopSupervisor
        ├── ApprovalBroker
        └── Runtime health + outbox stores
```

Persistent runtime data lives under `~/.pulseed/runtime/` by default:

```text
runtime/
  approvals/
  health/
  leader/
  leases/
  outbox/
  queue.json
```

## Core Invariants

### 1. Single daemon leader

Only one daemon may hold the runtime leader lock at a time. PID files are no longer the source of truth for exclusivity.

### 2. Durable accept before processing

Ingress only becomes visible to the runtime after the envelope is written to the journal-backed queue.

### 3. Claim before execute

Workers do not execute a goal until they successfully claim a `goal_activated` envelope.

### 4. Lease plus fencing for goal ownership

Execution ownership is tracked per goal through `GoalLeaseManager`. A worker must still own the lease at commit time or its write is rejected by the state write fence.

### 5. At-least-once delivery

Commands and events may be retried after crash recovery. Handlers must therefore be idempotent or safely deduplicated.

## Data Flow

### Ingress

- HTTP and file-based ingress are normalized into `Envelope` records.
- The daemon writes each envelope into `JournalBackedQueue`.
- `CommandDispatcher` claims command envelopes.
- `EventDispatcher` claims non-execution events.
- `LoopSupervisor` claims `goal_activated` envelopes and assigns them to workers.

### Goal execution

- `goal_start` and schedule-derived activations are converted into `goal_activated`.
- `LoopSupervisor` acquires a per-goal lease before starting work.
- The worker renews both queue claim and goal lease while executing.
- On success, the queue claim is acknowledged.
- On failure, the claim is retried with backoff or dead-lettered after the retry budget is exhausted.

### Approvals and outbound events

- Approval requests are stored durably in `approvals/`.
- Runtime-facing client events are mirrored into the durable outbox so reconnecting clients can catch up.

## Recovery Behavior

### Daemon crash

If the daemon dies or stops renewing health, the watchdog starts a replacement child. The new daemon:

- re-acquires the leader lock,
- sweeps expired queue claims,
- reclaims expired goal leases,
- reloads pending approvals,
- resumes command and event dispatch from the durable queue.

### Dispatcher crash

Dispatchers are stateless consumers. After restart they simply continue claiming uncompleted queue items.

### Worker crash

If a worker dies mid-execution, its queue claim and goal lease expire. A later daemon instance, or a later sweep inside the same daemon, reclaims the activation and retries it.

### Client disconnect

SSE is treated as a transport, not as durable state. Clients are expected to resume from the outbox instead of relying on a live connection to remain uninterrupted.

## Operational Notes

- The runtime is intentionally single-node. Horizontal scaling would require a different leader and lease backend.
- `goal_stop` prevents future reactivation for that goal, but it does not abort the currently running iteration.
- The legacy `runtime_journal_v2` config field is kept only as a compatibility alias for older config files. The durable runtime is always on.

## Why This Design

The earlier in-memory queue design could lose accepted work on process crash and only prevented duplicate goal execution inside one process. The current design moves the source of truth for runtime coordination onto disk:

- leader state is durable,
- queue state is durable,
- approval state is durable,
- goal ownership is durable.

That gives PulSeed automatic recovery without introducing an external broker in the single-node deployment target.
