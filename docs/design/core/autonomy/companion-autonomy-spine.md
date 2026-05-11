# Companion Autonomy Spine

> Status: Design document. Verify behavior against source code and current operating docs before treating this as implementation guidance.

Status: companion autonomy spine design.

This document defines the shared design spine for PulSeed's living-feeling
autonomy. It is intentionally not a delivery plan, first-release cut, or task
decomposition. Its job is to keep the whole concept stable enough that later
concrete schemas, stores, and runtime changes can attach to one coherent
behavioral contract.

For the initial contract lane issue-to-module ownership map, merge order, and test-harness
placement, see [Companion Autonomy Implementation Map](companion-autonomy-implementation-map.md).

## Purpose

PulSeed should become a quiet autonomous companion, not a notification bot,
profile database, job dashboard, or engagement-maximizing companion product.

The central design question is:

```text
How can PulSeed remember, notice, care, wait, suppress, prepare, surface,
resume, and explain itself while preserving user agency and the right distance?
```

The spine answer is:

```text
Dream / traces / observations / goals
  -> governed memory and relationship context
  -> scoped Surface projection
  -> companion state and signal context
  -> urge and agenda formation
  -> attention metabolism
  -> runtime control plane
  -> quiet work, preparation, action candidate, expression, or silence
  -> feedback and correction
  -> governed memory / policy update
```

No layer after memory may treat remembered context as direct permission to
act, speak, resume, notify, or update long-term state. PulSeed becomes more
alive by developing internal continuity and restraint, not by increasing visible
activity.

## Source Design Lanes

The design lanes are not four independent products. They define adjacent layers of
one pipeline.

| Spine role | Layer design |
| --- | --- |
| Relationship memory, living context, governed Surface selection | [Relationship Memory And Surface](relationship-memory-surface.md) |
| Attention metabolism, urge maturation, initiative gating, expression choice | [Attention Metabolism And Initiative](attention-metabolism-initiative.md) |
| Runtime control plane, posture, authority, staleness, inspectability, audit | [Runtime Control Plane](../../infrastructure/runtime/runtime-control-plane.md) |
| Runtime safety substrate for auth, browser sessions, guardrails, backpressure | [Runtime Auth, Browser Session, And Guardrail Control Model](../../infrastructure/runtime/runtime-auth-browser-guardrails.md) |

The future GUI layer is intentionally downstream. It can render or embody the output of this
spine, but it must not redefine the semantics of memory use, attention,
authority, staleness, control, or audit.

## Non-Goals

This document does not define:

- task breakdowns
- GUI layout or visual presence
- notification UX
- companion copywriting
- concrete storage migration steps
- a final TypeScript schema for every object

It does define the conceptual objects and boundary rules that later schemas,
stores, routers, and surfaces must preserve.

## Existing Foundations

The spine should connect existing PulSeed design primitives rather than replace
them.

| Existing design | Spine interpretation |
| --- | --- |
| `dream-mode.md` | Offline compiler that turns traces into typed update intent |
| `soil-system.md` | Online retrieval and Markdown projection over typed records |
| `memory-lifecycle.md` | Accumulation, compression, staleness, and relevance management |
| `drive-scoring.md` | Measures what deserves care, not what deserves interruption |
| `curiosity.md` | Creates internal proposals and questions, not direct user prompts |
| `wait-strategy.md` | Schedules re-evaluation and strategic delay, not notification |
| `runtime-auth-browser-guardrails.md` | Fail-closed safety domain for external automation and guardrails |

The most important integration rule:

```text
Runtime stores remain write truth.
Soil is retrieval/projection.
Dream compiles traces into typed update intent.
Surface is the current governed projection.
Companion state modulates thresholds, work admission, and expression.
Attention decides whether projected context becomes work, expression, or silence.
Runtime control keeps autonomous activity inspectable and interruptible.
```

## Continuity Contract

PulSeed remembers enough to preserve continuity, forgets enough to remain safe,
and stays uncertain enough to preserve the user's freedom.

The desired behavioral feel is not:

```text
PulSeed remembers, so it gets closer.
```

It is:

```text
PulSeed remembers, so it gets the distance right.
```

Distance is not coldness. It means PulSeed knows what it may use, what it may
say, what it may act on, what it should hold, what it should suppress, and when
it must ask again.

## Core Invariants

These invariants are the spine. Later concrete details can change, but
these must not drift.

1. Memory is not permission.
2. Runtime events are not notifications.
3. Curiosity is not interruption.
4. Drive score is not exposure score.
5. A scheduler wakeup means re-evaluate, not speak.
6. A remembered session may be inspectable without being resumable.
7. A usable memory may be unspeakable and unactionable.
8. A valid urge may be suppressed.
9. Expression is not the only useful outcome; authorized quiet work is first-class.
10. Per-item runtime state is not enough; companion-wide state must modulate the loop.
11. Internal state should be inspectable, not always visible.
12. Every side-effecting action remains approval-bound when authority requires it.
13. User correction changes policy conservatively; it must not be debated as a
    preference optimization problem.
14. Positive feedback must not automatically make PulSeed more interruptive.
15. Negative feedback should make PulSeed more careful.
16. No scalar closeness, intimacy, or attachment score may drive behavior.
17. Relationship state is a contextual permission matrix.
18. Tombstoned content exposes only non-content metadata everywhere.
19. Deleted content must not be readable through Surface, audit, debug,
    inspection, runtime snapshots, or derived artifacts.

## Layer 1: Trace and Dream Inputs

Raw experience starts as traces, observations, runtime events, chat turns,
task outcomes, corrections, decisions, and suppressed alternatives.

These inputs are not memory by default. They are evidence.

Dream is the offline compiler that may transform evidence into typed update
intent. Dream may propose durable records, supersessions, tombstones, and
activation artifacts, but it must not become the online query path or bypass
the owning runtime store.

Important distinction:

```text
trace != memory
candidate != governed memory
governed memory != active Surface
active Surface != permission to act
```

Trace products should preserve enough provenance for later audit:

- source event or run
- observed time
- actor or surface
- confidence source
- sensitivity
- correction state
- supersession or tombstone relationship
- whether the event was expressed or withheld

## Layer 2: Governed Memory

PulSeed memory is organized by future behavioral role, not only by data type.

| Memory role | Meaning | Primary behavioral effect |
| --- | --- | --- |
| Knowledge | What PulSeed knows | Reasoning and design grounding |
| WorkMemory | What PulSeed is working on | Goal continuity and open-loop tracking |
| Relationship | How PulSeed should relate | Permission, inhibition, expression mode |
| Seed | Digested candidate that may mature | Future-behavior potential |
| AntiMemory | What PulSeed should avoid using or doing | Suppression and boundary protection |

Relationship memory is not a profile layer. It is a distance-preserving layer.
It exists so PulSeed can honor promises, remember boundaries, preserve
uncertainty, avoid stale assumptions, and inhibit overreach.

Every governed memory should be able to express:

```text
memory_id
owning_store_ref
role
record_kind
statement
epistemic_status
scope
domain_fields
sensitivity
provenance
confidence
validity
allowed_uses
not_allowed_uses
correction_state
supersession_state
forgetting_state
```

`role` describes the behavioral lane: Knowledge, WorkMemory, Relationship,
Seed, Boundary, Promise, Tension, or AntiMemory. `record_kind` describes the
typed contract: stable profile fact, preference, routine, boundary,
intervention policy, episodic event, promise, correction, relationship posture,
consent scope, work commitment, project fact, knowledge fact, open tension,
anti-memory rule, or seed
candidate. The same source event can yield multiple records with different
roles and record kinds.

Spine-level `record_kind` vocabulary mirrors the relationship-memory layer contract:

```text
stable_profile_fact
preference
routine
boundary
intervention_policy
episodic_event
promise
correction
relationship_posture
consent_scope
work_commitment
project_fact
knowledge_fact
open_tension
anti_memory_rule
seed_candidate
```

This split matters because relationship-memory requirements are not satisfied by
memory roles alone. Stable facts, preferences, routines, boundaries,
intervention policy, and episodic events each need their own contract fields,
staleness behavior, correction behavior, and Surface invalidation behavior.
If ownership is ambiguous, the item remains a seed or proposal and must not be
projected as stable Surface context.

`allowed_uses` is not decorative metadata. It is a runtime boundary.

Example use classes:

```text
runtime_grounding
design_grounding
behavioral_inhibition
attention_prioritization
expression_mode_selection
tone_adaptation
goal_planning
ask_for_confirmation
proactive_action_candidate
user_facing_reference
memory_write_candidate
never_use_directly
```

Example forbidden use classes:

```text
user_personality_labeling
diagnosis
motivation_claim
emotional_leverage
engagement_optimization
attachment_optimization
proactive_trigger
side_effect_authorization
stale_session_authorization
```

## Layer 3: Relationship Permission Matrix

Relationship state must not be represented as scalar closeness, scalar trust,
or relationship maturity.

The spine uses contextual permission:

```text
RelationshipPermission
  context_scope
  observation_permission
  memory_use_permission
  speakability
  proactive_permission
  interruption_tolerance
  autonomy_level
  confirmation_requirement
  emotional_language_boundary
  correction_sensitivity
  preferred_expression_modes
  forbidden_moves
  expiry_or_review_condition
```

Trust in this layer does not mean intimacy. It means permission in a specific
context for a specific class of use.

Examples:

- PulSeed may use a correction for inhibition but not mention it directly.
- PulSeed may remember an old project goal but require re-grounding before
  resuming work from it.
- PulSeed may use a relationship boundary to choose silence, but not use it as
  evidence for a personality claim.
- PulSeed may prepare a proposal silently while lacking permission to notify.

## Layer 4: Surface Projection

Surface is the current governed projection of memory and context into a
runtime situation.

Surface is not:

- the whole memory store
- a prompt dump
- a Markdown page used as truth
- automatic permission to speak or act

Surface answers:

```text
What context is currently allowed to influence this runtime decision?
```

A Surface projection should carry:

```text
surface_id
version
scope
created_at
expires_at_or_review_condition
invalidation_policy_ref
source_memory_refs
source_runtime_refs
source_permission_refs
dependent_runtime_item_refs
dependent_agenda_refs
dependent_outcome_refs
dependent_expression_refs
dependent_memory_write_candidate_refs
included_context
excluded_context
permission_matrix_refs
allowed_runtime_uses
not_allowed_runtime_uses
staleness_checks
invalidation_state
projection_rationale
```

Surface selection is the boundary where broad memory becomes operational
context. It must reject stale, superseded, out-of-scope, sensitive, or
insufficiently permitted memory even when that memory is relevant.

Surface must also define how it becomes invalid. Memory correction, retraction,
supersession, tombstone, deletion, permission revocation, boundary changes,
intervention-policy changes, stale sessions, stale runtime items, and source
redaction can invalidate the Surface and all dependent agenda, outcome,
expression, resume, and memory-write candidates. Regeneration must rerun the
Surface gates from source refs; it must not trust old `included_context`.

## Layer 5: Signal Context

Signals are facts that something may deserve attention. They can come from:

- runtime events
- goal state
- task state
- session state
- schedule ticks
- wait strategy expiry
- Drive scoring
- curiosity proposals
- Dream activation artifacts
- Soil retrieval
- user correction
- external automation state
- guardrail and backpressure state

Signals do not cause expression. They are assembled into a `SignalContext`:

```text
SignalContext
  signal_refs
  active_surface_id
  current_session_ref
  current_goal_refs
  runtime_state_refs
  relationship_permission_refs
  user_activity_state
  timing_context
  safety_context
  stale_target_context
```

The signal context is the input to urge and agenda formation. It should be
explainable enough to answer why PulSeed noticed something.

## Layer 6: Companion State

PulSeed needs whole-companion state in addition to per-item runtime posture.
Without it, the system degrades into queues, policies, and visibility rules
without an organism-like loop.

Companion state is not a UI status label. It is an internal state vector that
modulates attention thresholds, work admission, waiting behavior, expression
choice, and overload protection.

```text
CompanionState
  snapshot_id
  computed_at
  source_event_high_watermark
  mode
  active_surface_refs
  invalidated_surface_refs
  active_goal_refs
  active_runtime_item_refs
  global_control_state_ref
  control_overlays
  pre_suspend_mode
  current_capacity
  interruption_budget
  quiet_work_budget
  attention_thresholds
  expression_thresholds
  cooldowns
  waiting_conditions
  blocked_by_boundary_refs
  needs_user_refs
  active_watch_refs
  active_wait_refs
  active_quiet_work_refs
  derivation_trace_ref
  last_meaningful_user_contact_at
  last_self_initiated_expression_at
```

Possible modes:

```text
sleeping
resting
quieted
proactivity_paused
suspended
watching
curious
concerned
working
waiting
holding_back
cooling_down
overloaded
needs_user
reaching_out
escalating
```

`mode` is the primary whole-companion posture. Global controls are also stored
as `control_overlays` so quiet, pause, or confirmation-required state does not
disappear when PulSeed is also working, waiting, or watching. Suspend is the
exception: when `suspend_companion` is active, `mode` must be `suspended`.
Previous working, waiting, or watching posture is preserved only as
`pre_suspend_mode` and held refs, not as the active primary mode.

Companion state answers:

```text
What is PulSeed as a whole currently doing, withholding, waiting for, or able
to take on?
```

Examples:

- `working` can lower admission for curiosity-only agenda while preserving
  user-authorized goal work.
- `quieted` can block new proactive expression without treating PulSeed as
  absent or dead.
- `proactivity_paused` can block new agent-origin outcomes while allowing
  user-origin work to continue.
- `suspended` can force the whole companion loop fail-closed until the user
  explicitly resumes it.
- `holding_back` can keep a mature urge from surfacing while allowing silent
  preparation.
- `cooling_down` can suppress repeated suggestions after a dismissal.
- `needs_user` can block resume or external action until permission is renewed.
- `overloaded` can prefer digest, narrowing, or stopping work over adding more
  active watches.

Companion state must be derived from typed runtime state, Surface projections,
attention history, user activity, and correction history. It must not be
invented from freeform mood text.

The derivation is a reducer, not a vibe classifier:

```text
runtime_items
  + recent_runtime_events
  + active_surface
  + surface_invalidation_events
  + global_controls
  + active_goals
  + attention_history
  + user_activity
  + feedback
  + safety_context
  -> CompanionStateSnapshot
```

Reducer precedence:

1. Global controls set hard overlays first: suspend, quiet, pause,
   confirmation-required, and stop controls.
   Suspend always forces `mode = suspended`.
2. Safety, authority, deletion, permission, and stale-Surface blockers can
   force `suspended`, `needs_user`, `holding_back`, or `overloaded`.
3. Feedback and cooldowns raise thresholds before new urges are considered.
4. Active authorized work and waits can produce `working`, `waiting`, or
   `watching`.
5. Curiosity, concern, and agenda pressure may modulate thresholds only after
   the above gates are known.

`CompanionStateSnapshot` must include a derivation trace with input refs,
selected mode, active control overlays, rejected modes, threshold changes,
budget changes, and reasons. If the reducer lacks required inputs or sees
contradictory state, it fails closed instead of asking an LLM to invent a
mood.

## Layer 7: Urge and Agenda Formation

An urge is an internal impulse candidate. An agenda item is a more durable
object of care, preparation, monitoring, or later surfacing.

Neither is a user task. Neither authorizes speech or action.

```text
UrgeCandidate
  id
  origin
  target
  feeling
  strength
  confidence
  urgency
  expected_user_benefit
  user_cost
  relationship_risk
  evidence_refs
  surface_ref
  allowed_moves
  forbidden_moves
  maturation_state
  first_seen_at
  last_reinforced_at
  expires_at_or_decay_rule
```

```text
AgentAgendaItem
  id
  origin
  kind
  subject
  why_pulseed_cares
  expected_user_benefit
  drive_basis
  curiosity_basis
  related_goal_refs
  related_memory_refs
  related_runtime_refs
  confidence
  intrusion_cost
  allowed_moves
  forbidden_moves
  evidence_refs
  staleness_state
  control_state
```

Possible agenda kinds:

```text
goal_stewardship
project_drift
commitment_guard
memory_conflict
preparation_opportunity
stall_concern
decay_risk
curiosity_followup
unresolved_decision
permission_boundary
surface_staleness
user_overload
self_maintenance
```

Drive scoring influences how much PulSeed should care. Curiosity influences
what PulSeed may inspect, question, or prepare. Neither may bypass the
attention layer.

## Layer 8: Attention Metabolism

Attention metabolism decides what happens to urges and agenda items over time.

It is not a notification router. It is the internal behavioral process by which
PulSeed notices, warms, holds, suppresses, prepares, waits, or admits a
candidate to the Initiative Gate.

The pipeline is:

```text
signals
  -> candidate urges / agenda items
  -> merge and deduplicate
  -> stale target rejection
  -> maturation or decay
  -> inhibition
  -> initiative gate
  -> outcome decision
  -> outcome feedback
```

Maturation states:

```text
new
warming
mature
held
prepared
decayed
suppressed
expressed
expired
rejected_stale
```

Inhibition decisions:

```text
suppress
hold
watch
wait_for_opportunity
decay
reject_stale
allow_to_gate
```

Inhibition does not choose outward expression or action. It either blocks,
delays, narrows, or admits the candidate to the Initiative Gate.

The default posture is restraint:

```text
stay silent unless there is a sufficiently mature, permitted, timely, useful,
and explainable reason to become visible.
```

Attention metabolism must weigh:

- expected user benefit
- companion state
- confidence
- timing fit
- user interruption cost
- relationship permission
- sensitivity
- stale target risk
- repetition cost
- recent correction or dismissal
- reversibility and side-effect risk
- whether silence, digest, or silent preparation is enough

## Layer 9: Runtime Control Plane

The runtime control plane makes quiet autonomy structurally legible and
controllable.

It is not a GUI. It is not a dashboard. It is not a log stream. It is the typed
substrate that lets PulSeed hold, wait, watch, work, suppress, resume, and
explain itself without forcing all state into user-visible output.

Runtime items are broader than tasks:

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

Runtime item shape:

```text
RuntimeItem
  id
  type
  status
  posture
  source
  created_at
  updated_at
  related_goal_refs
  related_session_refs
  related_memory_refs
  related_surface_refs
  authority
  staleness
  companion_state_refs
  visibility_policy
  control_policy
  audit_trace_refs
```

Posture is distinct from status. Status says what mechanically happened.
Posture says how PulSeed is currently relating to the item.

Possible postures:

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

Authority should explicitly separate:

```text
inspectable
resumable
actionable
speakable
can_create_urge
can_update_surface
can_write_memory
requires_confirmation
```

Staleness should explicitly separate:

```text
temporal
world
project
permission
relationship
surface
goal
assumption
session
```

This is the layer that prevents old context from silently becoming current
again.

## Layer 10: Control Verbs

Control verbs must not collapse into generic `cancel` or `resume`.

PulSeed needs precise control over execution, attention, memory, permission,
Surface, and session authority.

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

Companion-wide controls are the user's emergency and posture controls over
PulSeed as a whole. They must override lower-level agenda, watch, wait, and
quiet-work admission unless a narrower safety rule requires a more conservative
state.

Companion-wide effects:

| Control | Effect |
| --- | --- |
| `inspect_companion_state` | Read-only inspection of mode, budgets, held agenda, active controls, and redacted audit references. It must not release held work, expose deleted content, or change thresholds. |
| `enter_quiet_mode` | Blocks new self-initiated user-facing expression; existing authorized quiet work may continue if still auditable and interruptible. |
| `leave_quiet_mode` | Allows expression admission to be reconsidered, but does not flush held pings, digest items, approvals, or messages automatically. Each held item must pass fresh Surface, permission, staleness, companion-state, and visibility checks. |
| `pause_proactivity` | Blocks new agent-origin agenda outcomes; user-initiated work can continue under normal authority. |
| `resume_proactivity` | Allows new agent-origin outcomes only after re-evaluation. Suppressed, decayed, or expired urges do not restart automatically; held agenda items may re-enter the normal gate only with current grounding. |
| `stop_all_quiet_work` | Pauses or cancels active quiet runs, delegated work, and silent preparation. Only fail-closed cleanup may continue: cancellation bookkeeping, redaction or deletion propagation, and safety-state recording. It must not start or continue preparation, delegation, watch work, memory writing, Surface refresh, external automation, or user-facing expression. |
| `stop_all_watches` | Stops watch-driven observation and prevents watch signals from creating new urges. |
| `suppress_nonessential_agenda` | Moves nonessential agenda items into suppressed, decayed, or held states and prevents low-value urges from maturing while the suppression is active. It does not delete audit state or override user-initiated work. |
| `suspend_companion` | Fail-closed global state: no new self-initiated work, expression, watch, memory write, Surface update, or resume; only user-initiated inspect, correction, deletion, revoke, and resume-from-suspend controls remain available. |
| `resume_companion` | Exits suspend only through an explicit user-initiated control. Quiet work, watches, waits, delegated runs, memory-write candidates, pending expressions, approval requests, and resume attempts are not restored automatically; each must be individually re-admitted or re-grounded. |
| `require_confirmation_for_proactivity` | Converts new proactive outcomes into approval-required candidates before work, expression, or delegation. |

If a companion-wide control conflicts with a lower-level control, the more
restrictive state wins.

Leaving quiet, proactivity pause, or suspend must not create a backlog burst.
Queued expression, digest, approval, memory-write, and resume candidates remain
held, expired, rejected, or re-gated according to current policy. Ambiguous
posture state fails closed and records an audit reason.

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

Surfaces may present simpler language, but the shared runtime boundary should
preserve these distinctions.

## Layer 11: Work, Action, Expression, and Visibility

Expression and silence are not the only outcomes of attention and runtime
control. The final companion must be able to pursue goals, prepare, observe,
delegate bounded work, and create action candidates quietly when authority
allows.

Outcome classes:

```text
silence
keep_watching
hold_in_agenda
prepare_silently
run_authorized_work
delegate_bounded_work
prepare_action_candidate
request_approval
write_governed_memory_candidate
update_surface_candidate
add_to_digest
express_to_user
escalate
```

Quiet work is first-class:

```text
PulSeed may continue authorized work without speaking when the current
authority, Surface, companion state, and runtime controls allow it.
```

Quiet work still must emit typed runtime state and audit. It is quiet in the
user-facing sense, not invisible to the control plane.

Action candidates are distinct from actions:

```text
prepared action candidate != approval
approval request != execution
execution != user-facing expression
```

External side effects, irreversible operations, stale-session resume, and
sensitive memory use remain blocked until the relevant authority and permission
checks pass.

Outcome ownership:

```text
InitiativeGateDecision
  -> proposes selected_outcome inside attention

Runtime control
  -> admits, rejects, or downgrades selected_outcome
  -> writes OutcomeDecision

Expression policy
  -> only if final outcome requires user-facing or surface-facing expression
  -> writes ExpressionDecision

VisibilityPolicy
  -> constrains which surfaces may show the resulting state
```

`OutcomeDecision` is the admitted runtime decision after authority, staleness,
companion-wide controls, and safety checks.

`requested_outcome` and `final_outcome` use only the attention `OutcomeClass`
vocabulary. Runtime posture states such as blocked, stale, or needs-user are
recorded through `admission_status`, runtime item posture, and
`downgrade_or_rejection_reason`, not by inventing new outcome values.
`final_outcome` is absent when the outcome is rejected or expired.

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

`ExpressionDecision` is only created for outcomes that actually need
surface-facing expression. It does not decide whether work is allowed.

```text
ExpressionDecision
  expression_id
  outcome_ref
  expression_mode
  target_surface_classes
  visibility_policy_ref
  user_facing_rationale
  suppressed_detail_refs
  audit_ref
```

Surfaces render `ExpressionDecision`; they must not recreate the outcome,
permission, staleness, or visibility decision locally.

`add_to_digest` is an outcome, not an expression mode. If runtime admits
`add_to_digest`, expression policy creates an `ExpressionDecision` with
`expression_mode = digest_item` and a digest-compatible `VisibilityPolicy`.
Digest surfaces consume that decision; they do not make local permission,
staleness, or visibility decisions.

Expression is the final user-visible or surface-visible form selected when an
admitted outcome is `add_to_digest`, `express_to_user`, `request_approval`, or
`escalate`.

Expression modes:

```text
digest_item
ambient_presence
soft_ping
direct_message
approval_request
urgent_alert
intervention
```

Visibility policy is separate from expression:

```text
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

Some states should remain hidden by default but inspectable when needed. Raw
urge scores, low-confidence interpretations, suppression calculations, and
relationship-risk estimates should usually not become normal user-facing UI.

Expression must carry a rationale:

```text
why_this
why_now
why_this_route
evidence_refs
policy_refs
confidence
staleness_checks
permission_checks
alternatives_considered
suppressed_alternatives
repair_options
```

The user-facing rationale can be short. The audit rationale should preserve the
full typed trail.

## Layer 12: Audit and Repair

Audit is not raw logging. Audit is the ability to explain and repair
autonomous behavior.

An audit trace should answer:

- what triggered this item
- what memories or Surface projections were used
- what permissions were checked
- what boundaries were hit
- what staleness checks passed or failed
- what urges or agenda items were formed
- what was suppressed
- what was expressed
- what was withheld
- what quiet work continued
- what action candidate was prepared but not executed
- what action was taken
- what action was not taken
- what changed in memory, Surface, runtime state, or permissions
- how the user can correct, suppress, revoke, re-ground, or forget it

Audit must include withheld behavior. For a companion, "I noticed and chose not
to speak" can matter as much as "I spoke."

Audit must respect deletion and tombstone redaction:

- Tombstoned content may appear only as non-content metadata such as an id,
  deletion time, deletion reason class, and affected scope.
- Deleted content must not appear in audit, debug output, runtime snapshots,
  Surface history, derived traces, or inspection views.
- When content is deleted, derived artifacts that contain the content must be
  redacted, invalidated, or replaced with non-content tombstone metadata.

## Layer 13: Feedback and Policy Update

Feedback is not engagement optimization. It is correction input.

Feedback types:

```text
accepted
ignored
dismissed
corrected
marked_overreach
too_frequent
wrong_timing
wrong_context
sensitive_unwanted
useful_followed_through
permission_revoked
scope_narrowed
memory_corrected
surface_rejected
```

Policy update rules:

- User correction is authoritative within its scope.
- Negative feedback should reduce intrusion or require confirmation.
- Positive feedback may preserve the behavior but must not automatically
  increase interruption.
- Missing feedback is not permission to become more proactive.
- Repeated dismissal should suppress or cool down similar items.
- Sensitive unwanted surfacing should tighten speakability and proactive
  permissions.
- Correction should update the relevant scope, not globally overfit.

Feedback can produce governed memory updates, permission changes, Surface
changes, control policy changes, or audit annotations. It must not silently
produce broader psychological claims about the user.

## Safety Substrate

Runtime safety is a concrete domain inside the broader spine.

Auth handoffs, browser sessions, guardrails, and backpressure are runtime items
with explicit authority, staleness, visibility, and control policies.

They demonstrate the same spine rules:

- an auth handoff is not a browser session
- an expired browser session is not resumable
- explicit stale session IDs fail closed
- guardrail and backpressure state are observable through typed runtime state
- operator control flows mutate typed runtime domains, not adapter-local text
- blocked automation can create attention candidates, but cannot bypass
  attention metabolism or approval gates

External automation and side-effecting work must pass through both the runtime
control plane and the relevant safety substrate.

## Boundary With GUI and Other Surfaces

Surfaces consume the spine. They do not redefine it.

Chat, TUI, CLI, daemon snapshots, GUI, mobile, voice, and future embodiment
clients may each choose different presentation, but they should all consume the
same typed state:

```text
SurfaceProjection
CompanionState
UrgeCandidate
AgentAgendaItem
InitiativeGateDecision
OutcomeDecision
RuntimeItem
RuntimePosture
Authority
Staleness
VisibilityPolicy
ControlPolicy
AuditTrace
ExpressionDecision
```

The GUI may make PulSeed feel present. The spine decides what presence is
allowed to mean.

## Design Drift Checks

Use these questions whenever extending the design:

1. Does this make memory direct permission to act, speak, resume, or notify?
2. Does this turn drive, curiosity, schedule, or runtime events into direct
   output?
3. Does this treat expression or silence as the only final outcome and omit
   quiet authorized work?
4. Does this model only per-item state and omit companion-wide state?
5. Does this model relationship as scalar closeness or attachment?
6. Does this make PulSeed more autonomous by making it harder to interrupt?
7. Does this expose internal state by default when inspectability would be
   enough?
8. Does this use logs as a substitute for audit?
9. Does this store ambiguous relational interpretation as fact?
10. Does this let old sessions become current without re-grounding?
11. Does this use user feedback as engagement optimization rather than
   correction?
12. Does this make GUI, TUI, chat, or CLI duplicate semantics that belong in
    the shared runtime contract?

If the answer to any question is yes, the design is drifting away from the
companion autonomy spine.

## Summary

PulSeed's living-feeling autonomy is a governed pipeline:

```text
evidence
  -> governed memory
  -> current Surface
  -> companion state
  -> urge / agenda
  -> attention metabolism
  -> runtime control
  -> quiet work / action candidate / expression / silence
  -> audit
  -> correction
```

The organism-like quality does not come from more messages, richer dashboards,
or emotional attachment mechanics. It comes from durable internal continuity,
permission-aware restraint, explainable initiative, and precise user control.

PulSeed should be able to hold context quietly, care about the right things,
work without unnecessary speech, wait for the right time, say less than it
knows, act only within authority, and make its autonomy inspectable whenever the
user needs to regain or refine control.
