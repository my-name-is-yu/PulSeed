# Runtime Control Plane

> Status: Design document. Verify behavior against source code and current operating docs before treating this as implementation guidance.

Status: runtime control plane layer design under
[Companion Autonomy Spine](../../core/autonomy/companion-autonomy-spine.md).

This document defines the internal runtime control plane for PulSeed's quiet
autonomy. It makes autonomous work inspectable, interruptible, resumable only
when safe, and auditable across chat, TUI, CLI, daemon snapshots, GUI, and
future surfaces.

## Purpose

PulSeed needs more than background task controls. It needs a shared control
substrate for what it is working on, watching, waiting for, holding, suppressing,
preparing, allowed to resume, or forbidden to use.

The runtime control plane answers:

```text
What is PulSeed internally doing or holding, what authority does it have, what
is stale, what can be controlled, and how can it explain itself?
```

It does not answer:

```text
How should this look in the GUI?
```

GUI and other surfaces consume this layer. They do not own the semantics.

## Spine Position

Runtime control sits after attention and before final outcomes.

```text
attention metabolism
  -> runtime control plane
  -> quiet work / action candidate / expression / silence
  -> audit
  -> correction
```

The boundary rule is:

```text
runtime event != notification
session memory != resumable session
valid urge != actionable item
visible state != inspectable state
```

## Non-Goals

This layer does not define:

- GUI layout
- dashboard views
- notification wording
- companion copywriting
- memory truth
- attention scoring
- task breakdowns or delivery boundaries

It defines runtime state, authority, staleness, control, visibility, and audit
semantics.

## Runtime Item Model

Runtime items are broader than tasks.

```text
RuntimeItem
  item_id
  type
  status
  posture
  source
  created_at
  updated_at
  related_goal_refs
  related_task_refs
  related_session_refs
  related_memory_refs
  related_surface_refs
  related_agenda_refs
  companion_state_refs
  companion_control_state
  authority
  staleness
  visibility_policy
  control_policy
  audit_trace_refs
```

Runtime item types:

```text
Run
Task
Session
Goal
Wait
Watch
Hold
UrgeCandidate
AgentAgendaItem
SurfaceProjection
PermissionBoundary
AuditTrace
DiffProposal
AuthHandoff
BrowserSession
GuardrailState
BackpressureState
```

Runtime items can be hidden from normal display and still be inspectable or
auditable.

## Current Production Boundaries

The runtime control plane attaches to existing production paths. It should not
be reimplemented independently by chat, TUI, daemon, or gateway adapters.

| Design object | Current production boundary | Design implication |
| --- | --- | --- |
| Runtime control request | `src/runtime/control/runtime-control-service.ts` | Shared owner for control admission and execution request records. |
| Runtime control intent | `src/runtime/control/runtime-control-intent.ts`, `src/interface/chat/ingress-router.ts` | Freeform routing may derive typed intent, but control execution remains runtime-owned. |
| Runtime operation store | `src/runtime/store/runtime-operation-store.ts`, `src/runtime/store/runtime-operation-schemas.ts` | Natural-language surfaces must write/read typed operation state rather than local summaries. |
| Runtime sessions and background runs | `src/runtime/session-registry/`, `src/interface/chat/chat-runner-runtime.ts` | Resume and stale-session behavior must use registry/session state, not latest-session fallback. |
| Chat ingress and reply target | `src/interface/chat/ingress-router.ts`, `src/interface/chat/chat-runner.ts`, `src/runtime/gateway/` | Chat/gateway supply actor, reply target, activity, and approval mode; they do not own runtime control semantics. |
| TUI surface | `src/interface/tui/entry.ts`, `src/interface/tui/chat-surface.ts`, `src/interface/tui/use-loop.ts` | TUI should consume the same runtime events and controls as chat. |
| Daemon and schedule runtime | `src/runtime/daemon/`, `src/runtime/schedule/engine.ts`, `src/runtime/schedule/` | Daemon/schedule emit runtime state and events; they must not bypass attention or Surface. |
| Grounding and Surface | `src/grounding/gateway.ts`, `src/grounding/contracts.ts`, grounding providers | Runtime actions depending on memory must reference the Surface assembled through this boundary. |
| Auth/browser/guardrails/backpressure | `src/runtime/control/`, `src/runtime/daemon/`, runtime safety stores | These remain hard safety inputs for authority, staleness, and companion state. |

Future `OutcomeDecision`, `ExpressionDecision`, `SurfaceInvalidationEvent`, and
`CompanionStateSnapshot` stores should be placed at the runtime/grounding
boundary, not inside a single adapter. `ExpressionDecision` is shared runtime
state: expression policy creates it after runtime admission, and chat, TUI,
daemon snapshots, gateways, and future GUI surfaces consume it. Surfaces may
render state differently, but they must consume the same typed runtime item,
control policy, visibility policy, expression decision, and audit records.

## Status And Posture

Status is mechanical. Posture is relational.

Status examples:

```text
pending
running
completed
failed
cancelled
paused
expired
blocked
superseded
```

Posture examples:

```text
working
watching
waiting
holding
cooling_down
blocked_by_boundary
needs_user
ready_to_digest
safe_to_forget
stale
suspended
suppressed
proposed
committed
rejected
```

Examples:

- A run can be `completed` but still `needs_user` for review.
- A session can be `active` but `stale` for action.
- An urge can be `mature` but `suppressed`.
- A memory can be `active` but `blocked_by_boundary` for speech.
- A watch can be `running` while PulSeed as a whole is `holding_back`.

## Authority

Authority separates what can be inspected, resumed, acted on, spoken, or
mutated.

```text
Authority
  inspectable
  resumable
  actionable
  speakable
  can_create_urge
  can_update_surface
  can_write_memory
  can_delegate_work
  requires_confirmation
  approval_scope
  authority_reason
```

Authority is derived from:

- runtime state
- Surface projection
- relationship permission
- safety substrate
- staleness checks
- user approval or correction
- reversibility and side-effect risk

Authority must fail closed when the relevant state is missing, stale, ambiguous,
or superseded.

## Staleness

Staleness is multi-dimensional.

```text
Staleness
  temporal
  world
  project
  permission
  relationship
  surface
  goal
  assumption
  session
  browser_session
  auth_handoff
```

Staleness outcomes:

```text
current
needs_review
needs_regrounding
inspect_only
summary_only
not_resumable
not_actionable
rejected
```

Rules:

- A stale session may be inspectable but not resumable.
- A stale Surface may block action while allowing audit.
- A stale browser session must not fall back to latest implicitly.
- A stale permission must require renewed confirmation.
- A stale assumption may be summarized without becoming current.

## Control Policy

Control policy states what can be done to a runtime item.

```text
ControlPolicy
  allowed_controls
  forbidden_controls
  required_confirmation
  repair_options
  reason
```

Controls must be specific. `cancel` and `resume` are too broad as semantic
primitives.

## Control Vocabulary

Companion-wide controls:

```text
inspect_companion_state
enter_quiet_mode
leave_quiet_mode
pause_proactivity
resume_proactivity
suspend_companion
resume_companion
stop_all_quiet_work
stop_all_watches
suppress_nonessential_agenda
require_confirmation_for_proactivity
```

Companion-wide controls apply to PulSeed's overall proactive posture. They are
not substitutes for per-item controls; they are higher-level user agency
controls that can force global quieting, suspend nonessential autonomous work,
or require confirmation before new proactive outcomes are admitted.

Companion-wide controls are checked before lower-level outcome admission.
Ambiguous or missing companion-control state fails closed.

| Control | Runtime admission effect |
| --- | --- |
| `inspect_companion_state` | Read-only inspection of companion mode, budgets, held agenda, active global controls, affected runtime items, and redacted audit references. It must not change admission state or expose deleted content. |
| `enter_quiet_mode` | Rejects new proactive expression; permits already-authorized quiet work only while it remains inspectable and interruptible. |
| `leave_quiet_mode` | Reopens expression admission for future decisions, but does not release held pings, digest items, approvals, or messages automatically. Each held item must be re-gated with current Surface, permission, staleness, companion-state, and visibility checks. |
| `pause_proactivity` | Rejects new agent-origin outcomes; user-origin commands can proceed through normal authority checks. |
| `resume_proactivity` | Allows new agent-origin outcome admission only after re-evaluation. Suppressed, decayed, or expired urges do not restart automatically; held agenda items may be reconsidered only through normal runtime admission. |
| `stop_all_quiet_work` | Pauses or cancels active quiet runs, delegated work, and silent preparation; records each affected item. Only fail-closed cleanup may continue: cancellation bookkeeping, redaction or deletion propagation, and safety-state recording. It must not start or continue preparation, delegation, watch work, memory writing, Surface refresh, external automation, or user-facing expression. |
| `stop_all_watches` | Stops watch items and prevents watch events from creating new urges. |
| `suppress_nonessential_agenda` | Marks nonessential agenda and urge items suppressed, decayed, or held, and prevents low-value maturation while active. It preserves audit state and does not block user-origin commands. |
| `suspend_companion` | Rejects new self-initiated work, expression, watch, memory write, Surface update, resume, and delegation; allows only user-initiated inspect, correction, deletion, revoke, and resume-from-suspend controls. |
| `resume_companion` | Exits suspend only through an explicit user-initiated control. Quiet work, watches, waits, delegated runs, memory-write candidates, pending expressions, approval requests, and resume attempts remain stopped, held, rejected, or expired until individually re-admitted or re-grounded. |
| `require_confirmation_for_proactivity` | Downgrades new proactive outcomes to approval-required candidates. |

Global controls must also define what happens to pending expressions, digest
items, approval requests, memory-write candidates, and resume attempts. If the
effect is not explicitly allowed, the runtime control plane holds or rejects the
item and records the reason.

Leaving quiet, proactivity pause, or suspend must not flush a backlog of
notifications, digest entries, approval requests, memory writes, or resume
attempts. Ambiguous companion-control state fails closed. Runtime records which
items stayed held, expired, rejected, or re-entered admission.

Execution controls:

```text
start_run
pause_run
cancel_run
retry_run
inspect_run
```

Task and goal controls:

```text
pause_task
resume_task
cancel_task
pause_goal
resume_goal
close_goal
narrow_goal_scope
inspect_goal_state
```

Watch and wait controls:

```text
start_watch
pause_watch
stop_watch
inspect_watch
schedule_wait
cancel_wait
reschedule_wait
```

Urge and agenda controls:

```text
hold_urge
suppress_urge
mature_urge
decay_urge
convert_urge_to_digest
convert_urge_to_ping_candidate
mark_urge_not_relevant
inspect_agenda_item
```

Memory and Surface controls:

```text
inspect_surface_projection
refresh_surface
clear_surface_projection
demote_memory
prevent_memory_from_action
prevent_memory_from_speech
suppress_context
forget_context
```

Permission controls:

```text
allow_once
allow_for_scope
revoke_permission
inspect_permission_boundary
require_user_confirmation
mark_boundary_hit
```

Session controls:

```text
inspect_session
resume_session
reject_session_resume
mark_session_stale
re_ground_session
summarize_session_without_resuming
```

Audit controls:

```text
audit_decision
audit_run
audit_session
audit_goal
audit_memory_use
audit_permission_check
audit_suppression
audit_surface_projection
```

Surface-specific adapters can present natural language, but the shared runtime
boundary must preserve these distinctions.

## Visibility Policy

Inspectability is not the same as visibility.

```text
VisibilityPolicy
  hidden_by_default
  visible_in_gui
  visible_in_chat
  visible_in_tui
  visible_in_cli
  visible_in_audit
  visible_in_debug
  digest_only
  never_directly_show
```

Usually internal:

- low-confidence urges
- raw scoring details
- relationship-risk estimates
- suppressed alternatives
- sensitive memory eligibility calculations

Possibly visible on inspection:

- why PulSeed waited
- why something cannot resume
- what permission boundary blocked an action
- what memory was used or withheld
- what action candidate was prepared but not executed

Possibly visible normally:

- active authorized work
- needs permission
- draft ready
- watch active
- stale context detected
- blocked by guardrail

## Runtime Events

Runtime events are typed facts, not UI strings.

```text
RuntimeEvent
  event_id
  event_type
  item_ref
  occurred_at
  source
  posture_before
  posture_after
  authority_delta
  staleness_delta
  companion_control_delta
  surface_refs
  companion_state_refs
  audit_refs
```

Presence-like events are internal state transitions:

```text
observing
holding_urge
waiting
working
blocked_by_boundary
chose_silence
needs_permission
ready_to_digest
stale_context_detected
resume_requires_regrounding
quiet_work_continued
action_candidate_prepared
```

Surfaces may render them differently, but the runtime event meaning is shared.

## Companion State Inputs

Runtime control supplies the typed inputs for `CompanionStateReducer`. It does
not ask a model to label PulSeed's mood.

```text
CompanionStateRuntimeInput
  runtime_items
  recent_runtime_events
  active_surface_ref
  surface_invalidation_events
  global_control_state
  active_goal_refs
  active_watch_refs
  active_wait_refs
  active_quiet_work_refs
  control_overlays
  pre_suspend_mode
  authority_blockers
  staleness_blockers
  safety_blockers
  user_activity_refs
  feedback_refs
  event_high_watermark
```

The reducer output is a `CompanionStateSnapshot` referenced by later runtime
items and outcome decisions. Runtime control must preserve the event
high-watermark so the same inputs produce the same snapshot and so stale
snapshots can be rejected.

Companion-state derivation is fail-closed:

- missing global-control state blocks proactive admission
- invalid Surface blocks memory-dependent action, expression, resume, and
  memory write
- contradictory runtime item posture forces `needs_user` or `overloaded`
- deleted source content forces redaction and dependent item re-check
- suspension forces `mode = suspended` regardless of urge pressure or previous
  work posture; previous posture may only be retained as `pre_suspend_mode` and
  held runtime refs

## Quiet Work

Quiet work is a first-class runtime outcome.

Quiet work can include:

- continuing an authorized run
- observing a watch target
- preparing a bounded proposal
- refreshing evidence
- drafting an action candidate
- preparing a digest item
- updating a runtime item posture

Quiet work must still be:

- authorized
- bounded
- inspectable
- interruptible
- auditable
- visible through appropriate inspection surfaces

Quiet means no unnecessary user-facing expression. It does not mean hidden from
runtime control.

## Resume Semantics

Resume is not a reload.

Resume requires:

- session is known
- session is not stale for the requested use
- Surface is current or re-grounded
- related permissions are current
- old assumptions have not been superseded
- side-effect authority is still valid
- companion state can admit the work
- the control policy allows resume

Possible outcomes:

```text
resume_allowed
resume_requires_regrounding
inspect_only
summary_only
resume_rejected_stale
resume_rejected_permission
resume_rejected_surface
resume_rejected_safety
```

A session may be remembered and inspectable while not resumable.

## Diff Semantics

Diff is not only file diff.

```text
DiffProposal
  diff_id
  diff_type
  subject_ref
  before_ref
  after_ref
  proposed_by
  authority_required
  staleness_checks
  reversible
  approval_required
  audit_refs
```

Diff types:

```text
file_diff
task_diff
goal_diff
memory_diff
surface_diff
permission_diff
plan_diff
runtime_posture_diff
```

This lets PulSeed represent possible changes before committing them.

## Audit Trace

Audit is explanation and repair, not raw logs.

```text
AuditTrace
  audit_id
  subject_ref
  trigger_refs
  surface_refs
  memory_refs
  permission_checks
  staleness_checks
  authority_checks
  safety_checks
  redaction_state
  attention_decision_refs
  companion_state_refs
  actions_taken
  actions_withheld
  quiet_work
  suppressed_alternatives
  user_visible_outputs
  repair_options
  created_at
```

Audit should answer:

- why this item exists
- why PulSeed worked, waited, held, suppressed, asked, or spoke
- what authority allowed or blocked it
- what Surface was active
- what memory was used or withheld
- what was stale or required re-grounding
- what was reversible
- what the user can stop, narrow, suppress, revoke, or forget

Audit must not become a deletion bypass:

- Tombstoned content can expose only non-content metadata.
- Deleted content must not be readable through audit, debug, inspection,
  runtime snapshots, Surface history, or derived traces.
- Runtime items and events that previously referenced deleted content must be
  redacted, invalidated, or rewritten to point only to tombstone metadata.

## Relationship To Attention

Attention selects candidate outcomes. Runtime control admits, rejects, records,
or constrains them.

Runtime control owns `OutcomeDecision`. It is the post-admission record that
surfaces consume before any expression rendering.

```text
OutcomeDecision
  outcome_id
  initiative_decision_ref
  requested_outcome
  final_outcome
  admission_status
  runtime_item_refs
  authority_checks
  staleness_checks
  companion_control_checks
  safety_checks
  downgrade_or_rejection_reason
  visibility_policy_ref
  expression_decision_ref
  audit_ref
```

`ExpressionDecision` is produced only when an admitted `OutcomeDecision`
requires user-facing or surface-facing expression. Rendering surfaces consume
it; they do not decide the outcome. The shared owner is the
runtime/grounding boundary, not an adapter-local renderer.

```text
attention outcome
  -> companion-wide control check
  -> runtime authority check
  -> staleness check
  -> control policy check
  -> OutcomeDecision
  -> runtime item/event
  -> audit trace
```

Runtime control may reject or downgrade an attention outcome:

- `run_authorized_work` to `hold_in_agenda`
- `express_to_user` to `add_to_digest`
- `prepare_action_candidate` to `request_approval`
- `delegate_bounded_work` to `prepare_silently`
- `add_to_digest` to `hold_in_agenda`
- `escalate` to `request_approval` or `hold_in_agenda`

Both `requested_outcome` and `final_outcome` are attention `OutcomeClass`
values. Runtime posture states such as `needs_user` or `blocked_by_boundary`
belong to admission status, item posture, and rejection reason, not to
`final_outcome`. If runtime rejects or expires an outcome, `final_outcome` is
absent.

Session resume controls are runtime control decisions, not attention outcomes.
If PulSeed wants to revive old context proactively, attention may only propose
an outcome such as `prepare_action_candidate` or `request_approval`; the actual
session control must still pass runtime authority and staleness checks.

## Relationship To Surface

Runtime items that depend on memory must reference the Surface used.

Rules:

- No memory-dependent action without a current Surface.
- No resume from old context without Surface compatibility.
- No user-facing reference to a memory unless Surface permits speakability.
- No memory write without audit and owning-store authority.
- No Surface refresh from a stale session without re-grounding.
- No audit, debug, inspection, or Surface history path may expose deleted
  content.

Runtime control must subscribe to Surface invalidation.

```text
SurfaceInvalidationEvent
  event_id
  surface_ref
  trigger
  source_ref
  affected_runtime_item_refs
  affected_agenda_refs
  affected_outcome_refs
  affected_expression_refs
  affected_memory_write_candidate_refs
  required_rechecks
  audit_ref
```

Required runtime effects:

- Runtime items admitted under an invalid Surface become `stale` or
  `needs_user` for memory-dependent action.
- Watches, waits, and quiet work that depend on invalid Surface must be held,
  stopped, or re-gated before continuing.
- Outcome decisions selected under invalid Surface expire or require
  re-admission.
- Expression decisions depending on invalid Surface are held or withdrawn.
- Session resume requires Surface compatibility or re-grounding.
- Memory-write candidates require fresh owner, provenance, permission, and
  deletion checks.
- Deleted content must not be recovered from old runtime events, old Surface
  snapshots, audit text, or debug traces.

If a Surface invalidation event lacks enough dependency information, runtime
control fails closed for action, expression, resume, and memory write while
preserving inspectability through redacted audit.

## Safety Substrate

The runtime safety substrate is a concrete domain inside this control plane.

Auth handoffs, browser sessions, guardrails, and backpressure should behave as
runtime items with authority, staleness, control policy, visibility policy, and
audit.

Safety examples:

- an auth handoff is not a browser session
- an expired browser session is not resumable
- explicit stale session IDs fail closed
- guardrail state blocks or narrows work admission
- backpressure can create blocked-work runtime items
- automation blockers can create attention candidates but not bypass approval

## Multi-Surface Contract

Chat, TUI, CLI, daemon snapshots, GUI, and future surfaces should consume the
same runtime contract.

Surfaces may differ in:

- density
- wording
- visual presentation
- default visibility
- interaction style

Surfaces must not differ in:

- authority rules
- staleness rules
- control semantics
- audit truth
- Surface eligibility
- approval requirements

## End-To-End Flow

```text
Attention:
  Selects prepare_action_candidate for a useful but side-effecting browser task.

Runtime control:
  Creates a RuntimeItem with actionable=false and requires_confirmation=true.

Safety substrate:
  Browser session is stale, so action is rejected and re-grounding is required.

Posture:
  Item becomes needs_user and resume_requires_regrounding.

Visibility:
  Normal surface may show needs permission; audit surface can show the full
  stale-session reason.

User control:
  User can inspect, re-ground, cancel, or revoke the related permission.

Outcome:
  No external side effect occurs until authority is renewed.
```

## Design Drift Checks

Use these checks when extending this layer:

1. Does this treat UI visibility as runtime truth?
2. Does this collapse control verbs into generic cancel or resume?
3. Does this let stale sessions become current?
4. Does this let runtime events become notifications directly?
5. Does this hide quiet work from audit?
6. Does this make all internal state visible by default?
7. Does this treat logs as audit?
8. Does this bypass Surface for memory-dependent action?
9. Does this let a surface redefine authority or staleness?
10. Does this make autonomy harder for the user to interrupt?

If yes, the design is drifting away from the runtime control plane.
