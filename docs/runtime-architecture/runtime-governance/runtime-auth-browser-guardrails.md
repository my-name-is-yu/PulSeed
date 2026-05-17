# Runtime Auth, Browser Session, And Guardrail Control Model

> Status: Active design contract. Verify exact behavior against source code and current operating docs.

Primary map: [Runtime Governance](./runtime-governance-map.md).

Status: runtime auth, browser session, and guardrail design proposal.

This document defines the runtime model for auth handoffs, browser authenticated
sessions, guardrail and backpressure state, observability, and operator
controls. It replaces older implementation-shaped work with a smaller set of
contract-first implementation increments.

## Goals

- Treat auth handoffs as first-class durable runtime objects instead of encoding
  them indirectly as browser sessions.
- Share browser session selection and stale-state rejection across browser read
  and workflow tools.
- Make guardrail and backpressure state observable and controllable through
  production runtime entrypoints.
- Preserve typed approval, stale-target rejection, and audit trails across chat,
  TUI, CLI, daemon snapshot, and future GUI surfaces.
- Avoid keyword, regex, title, or language-specific matching for operator
  decisions. Freeform requests must route through typed runtime control intent
  classification and then through typed runtime stores.

## Current Implementation Map

The current code already has useful primitives, but they are not yet unified as
one runtime contract.

- Browser workflow tools live in
  `src/tools/automation/InteractiveAutomationTools.ts`.
- Browser session persistence lives in
  `src/runtime/interactive-automation/browser-session-store.ts`.
- Browser session, circuit breaker, and backpressure schemas currently live in
  `src/runtime/store/runtime-schemas.ts`.
- Circuit breaker and backpressure controllers live in
  `src/runtime/guardrails/circuit-breaker.ts` and
  `src/runtime/guardrails/backpressure-controller.ts`.
- Runtime control requests are recorded by
  `src/runtime/control/runtime-control-service.ts` and
  `src/runtime/store/runtime-operation-store.ts`.
- Daemon runtime-control dispatch goes through
  `src/runtime/control/daemon-runtime-control-executor.ts`,
  `src/runtime/event/server-command-handler.ts`, and
  `src/runtime/daemon/runner-commands.ts`.
- Runtime sessions and runs are projected by
  `src/runtime/session-registry/registry.ts`.
- Daemon snapshot currently exposes auth and guardrail data through
  `src/runtime/event/server-snapshot-reader.ts`.
- Chat `/status` renders pending auth handoffs and guardrails through
  `src/interface/chat/chat-runner-commands.ts`.
- Model-visible setup/runtime tools live in
  `src/tools/runtime/SetupRuntimeControlTools.ts`; run pause/resume/cancel
  already require an observed run epoch before mutating state.

The existing tests prove the default behavior paths work:

- `src/tools/automation/__tests__/InteractiveAutomationTools.test.ts`
- `src/runtime/control/__tests__/runtime-control-service.test.ts`
- `src/runtime/control/__tests__/runtime-target-resolver.test.ts`
- `src/runtime/gateway/__tests__/ingress-runtime-control-contract.test.ts`
- `src/runtime/__tests__/event-server.test.ts`
- `src/interface/chat/__tests__/chat-runner-gateway-runtime-control.test.ts`

## Current Debt

The current implementation is a good default behavior, but several seams will become
operational debt if extended directly.

### Auth Handoff Is Mixed Into Browser Session State

`BrowserAutomationSessionRecord.state` includes `auth_required`. That makes a
pending human login challenge look like a browser session. This causes three
problems:

- Sessionful and sessionless login challenges need different lifecycle data, but
  both are squeezed into `session_id`.
- Operator actions such as complete, cancel, expire, or supersede are not
  explicit lifecycle transitions.
- Status surfaces must reconstruct pending handoffs from browser session state.

Auth handoff state should be split into a first-class runtime object. Browser
session state should describe only the browser session.

### Browser Tool Session Selection Is Not Shared

`browser_run_workflow` can resolve a latest authenticated session when
`sessionId` is omitted. `browser_get_state` currently passes the supplied
session id directly to the provider and has no equivalent resolver.

This creates inconsistent stale-state behavior between read and workflow tools.
The same session-selection contract must be used by both.

### Explicit Session IDs Need Fail-Closed Validation

Implicit session selection already excludes expired sessions. Explicit session
ids should not bypass safety. If an explicit session id points at an expired,
auth-required, blocked, unavailable, superseded, or actor/workspace-mismatched
record, the tool should return a typed not-executed stale-state result instead
of falling back to latest or calling the provider.

### Guardrail State Is Observable But Not Fully Operable

Circuit breaker and backpressure state are persisted and surfaced in snapshot
and `/status`, but operators cannot yet reset, pause, unpause, or expire related
state through production runtime-control entrypoints.

### Backpressure Is Tool-Local

Backpressure currently protects browser workflow tool admission. It does not yet
shape daemon scheduling, degraded-mode behavior, or blocked-work projection. The
next model should keep the existing lease controller but expose blocked work and
retry timing so daemon scheduling can consume it.

## Target Runtime Model

The target model has four separate durable domains:

1. Auth handoffs: human login or credential continuation requests.
2. Browser sessions: provider-owned browser sessions and their reuse state.
3. Guardrails: circuit breaker state for provider/service pairs.
4. Backpressure: active leases, throttled admissions, and blocked work.

These domains are joined by typed scope, not by overloaded string state.

```ts
type RuntimeAutomationScope = {
  provider_id: string;
  service_key: string;
  workspace: string;
  actor_key: string;
};
```

`provider_id` and `service_key` define the automation target. `workspace` and
`actor_key` prevent authenticated session reuse across unrelated projects,
conversations, or users.

## Auth Handoff Records

Add a durable store under `runtime/auth-handoffs/`.

```ts
type RuntimeAuthHandoffState =
  | "requested"
  | "pending_operator"
  | "in_progress"
  | "completed"
  | "cancelled"
  | "expired"
  | "superseded"
  | "blocked";

type RuntimeAuthHandoffRecord = {
  schema_version: "runtime-auth-handoff-v1";
  handoff_id: string;
  provider_id: string;
  service_key: string;
  workspace: string;
  actor_key: string;
  state: RuntimeAuthHandoffState;
  requested_at: string;
  updated_at: string;
  expires_at?: string | null;
  completed_at?: string | null;
  browser_session_id?: string | null;
  resumable_session_id?: string | null;
  supersedes_handoff_id?: string | null;
  superseded_by_handoff_id?: string | null;
  reply_target?: RuntimeControlReplyTarget | null;
  requested_by?: RuntimeControlActor | null;
  failure_code?: string | null;
  failure_message?: string | null;
  resume_hint?: {
    tool_name: "browser_run_workflow";
    input_ref?: string;
    task_summary: string;
  } | null;
  evidence_refs: Array<{ kind: string; ref: string; observed_at?: string }>;
};
```

Lifecycle rules:

- A provider auth failure creates `requested`, then `pending_operator`.
- A human explicitly starts login or opens the provider session as
  `in_progress`.
- A human completion action marks the handoff `completed` and links the
  authenticated browser session.
- Timeout or explicit expiry marks it `expired`.
- Operator cancellation marks it `cancelled`.
- A newer handoff for the same scope may mark older active handoffs
  `superseded`.
- Failed validation marks it `blocked`.

The old `BrowserAutomationSessionRecord.state === "auth_required"` should be
treated as a legacy projection during migration, not the source of truth for new
handoffs.

## Browser Session Records

Keep the existing browser session store, but narrow its responsibility.

Recommended states:

```ts
type BrowserAutomationSessionState =
  | "fresh"
  | "authenticated"
  | "expired"
  | "blocked"
  | "unavailable"
  | "superseded";
```

The legacy `auth_required` value can remain parseable during migration, but new
code should create auth handoff records instead.

Browser session records should add provenance and supersession fields:

- `auth_handoff_id?: string | null`
- `superseded_by_session_id?: string | null`
- `last_verified_at?: string | null`
- `reply_target?: RuntimeControlReplyTarget | null`

## Browser Session Resolver

Add a shared resolver used by both `browser_run_workflow` and
`browser_get_state`.

Before `browser_get_state` can use implicit latest-session reuse, its input
contract must carry a browser service scope. The current read tool accepts only
`providerId` and optional `sessionId`; that is enough for explicit reads, but
not enough to safely choose a host-scoped session. Extend the read input with an
exact scope field such as `serviceKey` or `startUrl`, then derive the same
`RuntimeAutomationScope` shape that `browser_run_workflow` uses. If the caller
omits both `sessionId` and service scope, the resolver must return an
ambiguous/no-scope result and the read tool must fail closed instead of reading
an arbitrary latest browser session.

```ts
type BrowserSessionResolution =
  | { status: "resolved"; session_id: string; source: "explicit" | "latest" }
  | { status: "none"; reason: "no_matching_session" }
  | { status: "stale"; reason: string; record?: BrowserAutomationSessionRecord }
  | { status: "ambiguous"; candidates: BrowserAutomationSessionRecord[] };
```

Resolution rules:

- Explicit `sessionId` wins only if the record exists and is valid for the
  provider, service, workspace, actor, and state.
- Explicit invalid state returns `stale`; it must not fall back to latest.
- Implicit latest considers only matching `authenticated` sessions whose
  `expires_at` is absent or in the future.
- `auth_required`, `expired`, `blocked`, `unavailable`, and `superseded` records
  are never selected implicitly.
- A newer completed auth handoff or superseding session invalidates older
  matching sessions.
- Sessionless workflows may proceed without a session id when no valid session
  exists.
- Read and workflow tools must call the same resolver with the same scope after
  the read tool has an explicit service scope contract.
- Read tests must cover omitted scope, ambiguous scope, explicit stale session,
  and implicit latest authenticated-session reuse.

This mirrors the existing observed-run epoch pattern: stale state must fail
closed at the production caller path, not only in lower-level tests.

## Guardrail Model

Keep `GuardrailStore`, `CircuitBreakerController`, and
`BackpressureController`, but make guardrails a runtime-control domain.

Circuit breaker controls:

- inspect provider/service breaker
- reset breaker to closed
- pause breaker manually
- unpause breaker
- expire cooldown and move to half-open

Backpressure controls:

- inspect active leases and recent throttles
- expire stale leases
- reset provider/service leases
- pause or unpause new work admission for a provider/service

All controls should write a `RuntimeControlOperation` or successor operation
record and append runtime evidence when a run or goal is in scope.

## Runtime Automation Snapshot

Add a typed snapshot object, exposed through daemon snapshot and reusable by
chat, CLI, TUI, and future GUI.

```ts
type RuntimeAutomationSnapshot = {
  schema_version: "runtime-automation-snapshot-v1";
  generated_at: string;
  auth_handoffs: {
    pending: RuntimeAuthHandoffRecord[];
    stale: RuntimeAuthHandoffRecord[];
    recent_terminal: RuntimeAuthHandoffRecord[];
  };
  browser_sessions: {
    authenticated: BrowserAutomationSessionRecord[];
    stale: BrowserAutomationSessionRecord[];
  };
  guardrails: {
    open_breakers: CircuitBreakerRecord[];
    paused_breakers: CircuitBreakerRecord[];
    half_open_breakers: CircuitBreakerRecord[];
  };
  backpressure: {
    active: BackpressureLease[];
    throttled: Array<{
      provider_id: string;
      service_key: string;
      reason: string;
      at: string;
    }>;
  };
  blocked_work: Array<{
    kind: "auth_wait" | "guardrail_open" | "backpressure" | "provider_unavailable";
    provider_id: string;
    service_key: string;
    run_id?: string | null;
    goal_id?: string | null;
    handoff_id?: string | null;
    reason: string;
    since: string;
    retry_after?: string | null;
  }>;
};
```

During migration, keep existing `auth_sessions` and `guardrails` fields on
`DaemonSnapshot` as compatibility projections, but make `runtime_automation`
the typed source for new callers.

## Runtime Control Shape

The current `RuntimeControlOperationKind` enum can remain for compatibility, but
it should not keep growing as a flat list. Add a domain/action payload for new
operations.

```ts
type RuntimeControlDomain =
  | "daemon"
  | "run"
  | "auth_handoff"
  | "browser_session"
  | "guardrail"
  | "backpressure";

type RuntimeControlAction =
  | "inspect"
  | "complete"
  | "cancel"
  | "expire"
  | "reset"
  | "pause"
  | "unpause";
```

Examples:

- `{ domain: "auth_handoff", action: "complete", target: { handoff_id } }`
- `{ domain: "browser_session", action: "expire", target: { session_id } }`
- `{ domain: "guardrail", action: "reset", target: { provider_id, service_key } }`
- `{ domain: "backpressure", action: "reset", target: { provider_id, service_key } }`

Freeform chat can still classify into typed runtime-control intent, but final
execution must use domain/action and target schemas. Ambiguous freeform target
selection should ask for clarification or fail closed.

## Operator Flows

### Auth Required To Completed

1. `browser_run_workflow` gets a typed auth-required provider result.
2. Runtime creates `RuntimeAuthHandoffRecord`.
3. Runtime creates or updates a linked browser session only if the provider
   returned a concrete session id.
4. Snapshot/status shows pending auth handoff and blocked work.
5. Operator completes login through chat/CLI/TUI runtime-control entrypoint.
6. Runtime validates the handoff is still pending, current, and not superseded.
7. Runtime marks handoff completed and records authenticated browser session.
8. A later browser workflow or read resolves that authenticated session through
   `BrowserSessionResolver`.

### Stale Handoff Rejection

If the operator attempts to complete an expired, cancelled, superseded, or
already completed handoff, runtime-control returns `not_executed` with
`reason: "stale_state"`. It must not update a browser session or resume work.

### Guardrail Recovery

1. Circuit breaker opens after repeated typed provider failures.
2. Snapshot/status exposes the provider/service, failure count, cooldown, and
   blocked work.
3. Operator can reset or pause/unpause through runtime-control.
4. Status updates immediately from the store, and the operation is audit-visible.

### Backpressure Degraded Mode

1. Browser workflow admission acquires a shared lease.
2. If caps are exceeded, runtime records throttled work with reason and time.
3. Snapshot/status shows active leases and throttled work.
4. Scheduler can later delay low-priority work instead of immediately retrying.

## Migration Plan

1. Add auth handoff store, browser session resolver, and tests while keeping old
   browser session records readable.
2. Write new auth handoff records from `browser_run_workflow`.
3. Update `browser_get_state` to use the resolver.
4. Add typed `runtime_automation` snapshot and keep compatibility projections.
5. Add operator controls for auth handoff, browser session, and guardrail state.
6. Lift backpressure into daemon scheduling/degraded-mode behavior.
7. Stop writing new `auth_required` browser session records once all callers use
   auth handoff records.

## Test Plan

Tests must use production entrypoint shapes, not only lower-level fake objects.

- Store tests for auth handoff lifecycle transitions.
- Tool contract tests proving `browser_run_workflow` creates handoff records and
  `browser_get_state` uses the shared resolver.
- Explicit stale session tests proving a stale explicit session does not fall
  back to latest.
- Two-turn chat/runtime-control tests for auth required, operator complete, and
  later reuse.
- Snapshot contract tests for `runtime_automation`.
- CLI or chat status tests proving blocked work, pending handoffs, breakers, and
  backpressure render through the real status path.
- Guardrail control tests for reset, pause, unpause, and stale target rejection.
- Daemon scheduling tests for backpressure/degraded-mode behavior when that
  slice lands.

## Implementation Slice Split

The design should be implemented as separate slices:

1. Add first-class runtime auth handoff records and lifecycle transitions.
2. Share browser session resolution across read and workflow tools.
3. Add typed runtime automation snapshot and status projection.
4. Add runtime-control operations for auth handoffs, browser sessions, and
   guardrails.
5. Lift browser backpressure into daemon scheduling and degraded-mode behavior.

Do not implement GUI-specific behavior in this slice chain. GUI work should
consume the typed snapshot and runtime-control contracts after they exist.
