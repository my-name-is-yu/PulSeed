# Relationship Memory And Surface

> Status: Public design reference. This page explains PulSeed design intent and architecture rationale; exact runtime behavior is owned by current source code, tests, and operating docs.

> Scope: Relationship memory and Surface layer within [Companion Autonomy Spine](./companion-autonomy-spine.md).

This document defines the governed memory and Surface layer for PulSeed's
companion autonomy. It keeps personal context from becoming a profile store,
prompt dump, generic retrieval layer, or permission shortcut.

## Purpose

Relationship memory exists so PulSeed can preserve continuity while keeping the
right distance.

It answers:

```text
What should PulSeed remember, avoid using, keep uncertain, or project now so it
can care, wait, ask, work, speak, or stay silent without overreach?
```

The layer does not answer:

```text
How can PulSeed know more about the user?
```

Knowing more is not the goal. Relating better is the goal.

## Spine Position

This layer sits between raw evidence and attention:

```text
Dream / traces / observations / goals
  -> governed memory and relationship context
  -> scoped Surface projection
  -> companion state and signal context
  -> urge and agenda formation
```

The boundary rule is:

```text
remembered != usable
usable != speakable
speakable != actionable
actionable != resumable
```

Surface is the current governed projection. It is not the whole memory store
and not permission to act.

## Non-Goals

This layer does not define:

- a generic profile database
- a vector-only memory system
- raw chat log storage
- prompt text assembly as memory truth
- emotional intimacy scoring
- engagement optimization
- notification or UI behavior
- task breakdowns or delivery boundaries

## Existing Sources Of Truth

PulSeed already separates runtime truth, retrieval, and offline compilation.

| Source | Role in this design |
| --- | --- |
| Runtime stores | Authoritative writes for durable domain records |
| Dream | Offline compiler from traces to typed update intent |
| Soil records | Canonical retrieval units over committed truth |
| Soil pages | Human-readable projections, not write truth |
| Surface | Current allowed runtime projection |
| Runtime control plane | Authority, staleness, audit, and control over use |

If a new memory class has no owning runtime store, the design must define that
owner before treating Soil or Markdown as persistence.

## Ownership Decision

This design chooses a layered owner model rather than putting all personal
context into one profile file.

| Record kind | Source-of-truth owner | Current production bridge |
| --- | --- | --- |
| `stable_profile_fact` | Relationship Memory owner under the profile platform boundary | `src/platform/profile/relationship-profile.ts` currently stores `identity_fact` and `life_context` items. |
| `preference` | Relationship Memory owner for user-level preference; domain owner only for subsystem-specific executable configuration | `src/platform/profile/relationship-profile.ts` currently stores `preference`, `communication_style`, `notification_preference`, and `dislike`. |
| `routine` | Relationship Memory owner for the routine fact and permission; runtime/schedule owner for any executable cadence | Current bridge is split between profile items and schedule/runtime state; executable cadence must remain in runtime/schedule stores. |
| `boundary` | Relationship Memory owner for user boundary; runtime control owner for live enforcement state | `src/platform/profile/relationship-profile.ts` stores `boundary`; runtime enforcement must project into runtime authority and Surface. |
| `intervention_policy` | Relationship Memory owner for when PulSeed may interrupt, digest, ask, or stay silent | `src/platform/profile/relationship-profile.ts` already has `intervention_policy`; future attention policy must consume it through Surface. |
| `episodic_event` | Runtime evidence/session owner for raw event; Relationship Memory owner only for digested future-behavior meaning | Runtime state, chat/session history, evidence ledgers, Dream, and Soil may preserve event evidence; raw episodic history must not become profile truth by default. |
| `promise` | Relationship Memory owner for relational commitment; goal/task/runtime owner for executable commitment | Promise records may reference runtime goals, tasks, or sessions but must remain governed by allowed uses. |
| `correction` | Owning store of corrected record plus audit/correction ledger | Profile corrections go through profile proposals/retractions; Soil and runtime corrections must invalidate Surface. |
| `relationship_posture` | Relationship Memory owner | Current bridge is profile relationship state; it must remain permission/posture, not scalar intimacy. |
| `consent_scope` | Relationship Memory owner for user consent; runtime control owner for live enforcement | Current bridge is profile `allowed_scopes`; runtime checks must project it into authority and Surface. |
| `work_commitment` | WorkMemory or runtime/goal owner for executable work; Relationship Memory owner for the promise-like relational meaning | Current bridge is goal/task/session state plus profile promise or preference records when relevant. |
| `project_fact` / `knowledge_fact` | Knowledge/Soil owner | `src/platform/soil/` and knowledge managers own retrieval records and projections. |
| `open_tension` | Relationship Memory owner when it governs distance, uncertainty, or posture; Knowledge/WorkMemory owner when it is purely project reasoning | Current bridge is profile boundary/posture records or Soil knowledge records depending on allowed use. |
| `anti_memory_rule` | Relationship Memory owner when it governs relation; domain owner when it blocks a specific subsystem | Current bridge is profile boundary/avoidance state plus runtime control blockers. |
| `seed_candidate` | Dream or proposal owner until accepted by an owning store | Reflection/Dream may propose; the accepted owner must be profile, runtime, knowledge, or Soil. |

Relationship Memory is therefore a governed orchestration layer over current
profile records, runtime/session evidence, and Soil/knowledge records. It is
not a raw event log and not a Markdown persistence surface. Soil remains the
readable retrieval/projection layer; current profile files are the compatibility
bridge for relationship-owned facts until a broader Relationship Memory store
exists.

## Current Production Boundaries

The design must attach to current caller paths before later schemas are added.

| Boundary | Current files | Design implication |
| --- | --- | --- |
| Profile relationship store | `src/platform/profile/relationship-profile.ts` | Compatibility owner for relationship-owned `record_kind` values. |
| Profile change proposals | `src/platform/profile/profile-change-proposal.ts` | Memory writes, corrections, and retractions should enter as proposals unless already user-approved. |
| Relationship retrieval context | `src/platform/profile/retrieval-context.ts` | Profile items enter grounding only through scoped retrieval context. |
| Grounding assembly | `src/grounding/gateway.ts`, `src/grounding/contracts.ts`, `src/grounding/providers/knowledge-provider.ts`, `src/grounding/providers/soil-provider.ts` | Surface generation should extend this boundary rather than bypass it with prompt text. |
| Soil records and projections | `src/platform/soil/contracts.ts`, `src/platform/soil/sqlite-repository.ts`, `src/platform/soil/runtime-rebuild.ts` | Soil is retrieval/projection; it is not the write owner for all relationship memory. |
| Chat/session source evidence | `src/interface/chat/chat-session-store.ts`, `src/interface/chat/chat-history.ts`, `src/interface/chat/turn-context.ts` | Episodic evidence may be sourced here, but promotion into memory requires governance. |
| Runtime control | `src/runtime/control/runtime-control-service.ts`, `src/runtime/store/runtime-operation-store.ts`, `src/runtime/session-registry/` | Action, resume, authority, and stale runtime decisions stay in runtime control. |

Later code may rename files or move stores, but it must preserve the owner
split: profile/relationship owner for relationship records, runtime owner for
live authority and episodic evidence, Soil owner for retrieval projection, and
grounding owner for Surface assembly.

## Memory Roles

PulSeed memory is grouped by future behavioral role.

| Role | Meaning | Runtime effect |
| --- | --- | --- |
| Knowledge | What PulSeed knows | Reasoning, grounding, comparison |
| WorkMemory | What PulSeed is working on | Goal continuity, open loops, commitments |
| Relationship | How PulSeed should relate | Permission, inhibition, expression choice |
| Seed | Digested candidate that may mature | Future-behavior potential |
| Boundary | Explicit limit on use, speech, action, or inference | Blocks or narrows behavior |
| Promise | Commitment PulSeed should honor | Continuity and accountability |
| AntiMemory | Memory retained to prevent use or overreach | Suppression and safety |
| Tension | Open design or relationship tension | Preserves ambiguity and prevents false closure |

The same source event can produce multiple roles. A conversation about a design
direction can produce Knowledge, WorkMemory, Relationship, Boundary, and
Tension records. The roles must stay distinct because they affect future
behavior differently.

## Record Kinds

Role is not the same as concrete record kind.

`role` describes the behavioral lane a memory affects. `record_kind` describes
the contract shape and domain semantics of the recorded thing. The same
`record_kind` can appear under different roles when its behavioral use differs.

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

Examples:

- A `preference` may be a Relationship record when it governs expression mode,
  or WorkMemory when it governs how to run a recurring work process.
- A `boundary` may be its own role when it blocks use directly, or an
  AntiMemory rule when retained mainly to prevent reintroduction.
- An `episodic_event` should usually stay use-limited unless elevated into a
  promise, correction, stable fact, or tension.
- An `intervention_policy` records when PulSeed may interrupt, ask, digest,
  or stay silent; it must not be collapsed into a general preference.

Minimum record-kind contract requirements:

| Record kind | Required contract |
| --- | --- |
| `stable_profile_fact` | subject, statement, provenance, confidence, scope, validity, correction state |
| `preference` | preference target, strength or confidence, scope, allowed uses, decay or review condition |
| `routine` | trigger or cadence, scope, permission, staleness rule, interruption policy |
| `boundary` | prohibited use or behavior, scope, authority source, override rule if any |
| `intervention_policy` | allowed routes, forbidden routes, confirmation requirement, cooldown or review rule |
| `episodic_event` | event time, source, participants or subject, sensitivity, allowed future uses |
| `promise` | promisor, promise statement, scope, fulfillment condition, expiry or review condition |
| `correction` | corrected target, replacement or retraction, affected uses, invalidation rule |
| `relationship_posture` | context, permitted posture, forbidden posture, evidence, confidence, review condition |
| `consent_scope` | scope, allowed uses, forbidden uses, authority source, expiry or revocation rule |
| `work_commitment` | commitment statement, linked goal/task/session refs, authority, fulfillment condition |
| `project_fact` | project scope, statement, source, confidence, validity, supersession rule |
| `knowledge_fact` | knowledge domain, statement, source reliability, confidence, validity, correction rule |
| `anti_memory_rule` | blocked content/use/inference, scope, owner, enforcement route, review condition |
| `open_tension` | tension statement, uncertainty status, allowed reasoning uses, forbidden inference uses |
| `seed_candidate` | proposed target role/kind, source evidence, confidence, allowed maturation path, rejection rule |

This layer's typed contracts for stable facts, preferences, routines,
boundaries, intervention policy, and episodic events are satisfied by
`record_kind`, not by overloading `role`. `role` remains the companion-behavior
lane; `record_kind` remains the storage and validation contract.

## Governed Memory Record

A governed memory record should preserve enough structure for later selection,
inhibition, correction, and audit.

```text
GovernedMemory
  memory_id
  logical_key
  version
  owning_store_ref
  role
  record_kind
  statement
  epistemic_status
  scope
  subject_refs
  domain_fields
  source_refs
  source_reliability
  confidence
  sensitivity
  valid_from
  valid_to
  allowed_uses
  not_allowed_uses
  correction_state
  supersedes_memory_id
  superseded_by_memory_id
  forgetting_state
  projection_policy
  audit_refs
```

The fields that matter most for companion behavior are `role`,
`record_kind`, `epistemic_status`, `scope`, `allowed_uses`,
`not_allowed_uses`, `correction_state`, `forgetting_state`, and
`projection_policy`.

`domain_fields` must be validated by `record_kind`. A Surface selector may use
`role` to decide which lane a memory can influence, but it must use
`record_kind` and `domain_fields` when checking contract-specific staleness,
projection, correction, and invalidation rules.

No governed memory may omit `owning_store_ref`. If ownership is ambiguous, the
record remains a `seed_candidate` or proposal and cannot enter active Surface
as stable context.

## Epistemic Status

Relationship memory must preserve uncertainty. It should not convert values,
motivations, tensions, or relationship signals into hard claims.

Possible epistemic statuses:

```text
explicit_user_instruction
explicit_promise
explicit_boundary
observed_behavior
repeated_pattern
inferred_preference
design_tension
relationship_tension
low_confidence_hypothesis
corrected_assumption
superseded_understanding
```

Interpretive records should be scoped and use-limited. A design tension such as
"PulSeed should feel alive without creating dependency" is not a claim about
the user's personality. It is a constraint on PulSeed's design and behavior.

## Allowed Uses

`allowed_uses` describes what a memory may influence.

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
surface_projection
never_use_directly
```

Allowed use is not sufficient by itself. The current Surface, relationship
permission, staleness checks, companion state, and runtime authority still have
to allow the use.

## Forbidden Uses

`not_allowed_uses` blocks specific forms of misuse.

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
raw_prompt_injection
cross_scope_reuse
```

A forbidden use wins over a broad allowed use. For example, a record may be
allowed for design grounding and behavioral inhibition while forbidden for
user-facing reference or proactive action.

## Relationship Permission Matrix

Relationship state is contextual permission, not closeness.

```text
RelationshipPermission
  permission_id
  context_scope
  memory_role_scope
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
  valid_from
  valid_to
  review_condition
  source_refs
```

Permission examples:

- A topic can be remembered but not proactively raised.
- A correction can be used for inhibition but not quoted back.
- A goal can be watched quietly but not resumed without re-grounding.
- A memory can adapt tone but not trigger action.
- A boundary can block expression and action even when the urge is mature.

## Forgetting And Lifecycle

Forgetting is lifecycle governance, not only deletion.

```text
active
planted
matured
decayed
retired
suppressed
superseded
retracted
tombstoned
deleted
archived
```

Lifecycle meanings:

- `active`: eligible for projection when scope and permission allow.
- `planted`: accepted as a candidate but not stable enough for broad use.
- `matured`: stable enough for its scoped allowed uses.
- `decayed`: lower relevance or confidence over time.
- `retired`: preserved historically but normally excluded from Surface.
- `suppressed`: retained but blocked from active use.
- `superseded`: replaced by newer understanding.
- `retracted`: corrected as wrong or unsafe.
- `tombstoned`: content erased or unavailable, with minimal non-content audit
  metadata retained to avoid reintroducing it.
- `deleted`: content and normal inspection material removed because it should no
  longer exist.
- `archived`: stored for history or audit, not normal projection.

Surface selection must exclude retired, suppressed, superseded, retracted,
tombstoned, deleted, and archived records. Inspection or audit may access
retired, suppressed, superseded, retracted, and archived content when authority
allows it. Tombstoned records expose only minimal non-content metadata. Deleted
records must not be projected or made readable through normal inspection or
audit.

Deletion and tombstone rules apply across derived artifacts:

- Surface snapshots must not retain deleted content.
- Runtime audit must not quote or reconstruct deleted content.
- Debug views must not bypass deletion.
- Derived traces containing deleted content must be redacted or invalidated.
- Tombstones may preserve only non-content metadata needed to avoid
  reintroducing the deleted material.

## Surface Projection

Surface is the scoped, governed projection of memory into a runtime situation.

```text
SurfaceProjection
  surface_id
  version
  scope
  created_at
  expires_at
  review_condition
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
  allowed_runtime_uses
  not_allowed_runtime_uses
  staleness_checks
  sensitivity_checks
  invalidation_state
  projection_rationale
  audit_refs
```

Surface answers:

```text
What context is currently allowed to influence this runtime decision?
```

Surface does not answer:

```text
What does PulSeed know in general?
```

## Surface Selection Rules

Surface selection must apply these gates in order:

1. Scope gate: is the memory relevant to the current context?
2. Lifecycle gate: is the memory active or otherwise eligible?
3. Staleness gate: is the memory temporally and contextually current?
4. Sensitivity gate: is the memory safe to use in this context?
5. Permission gate: does relationship permission allow this use?
6. Use gate: does `allowed_uses` include the requested use?
7. Forbidden-use gate: does `not_allowed_uses` block the requested use?
8. Projection gate: should the memory be included, summarized, withheld, or
   represented only as an inhibition?
9. Audit gate: can the projection be explained later?

Relevance is not enough. A relevant memory can still be excluded.

## Surface Invalidation

Surface invalidation must be typed because stale Surface is one of the easiest
ways for long-lived autonomy to become unsafe.

```text
SurfaceInvalidationPolicy
  policy_id
  surface_ref
  source_memory_refs
  source_permission_refs
  source_runtime_refs
  invalidation_triggers
  affected_runtime_item_policy
  affected_agenda_policy
  affected_outcome_policy
  affected_expression_policy
  affected_memory_write_policy
  regeneration_policy
  audit_policy
```

Invalidation triggers:

```text
memory_corrected
memory_retracted
memory_superseded
memory_tombstoned
memory_deleted
permission_revoked
permission_scope_narrowed
boundary_added
intervention_policy_changed
source_event_redacted
runtime_item_stale
session_marked_stale
goal_scope_changed
surface_expired
```

Invalidation effects:

| Affected object | Required effect |
| --- | --- |
| Surface snapshot | Mark `invalid`, `expired`, or `needs_review`; never keep deleted content. |
| Runtime item | Mark memory-dependent authority stale until re-grounded. |
| Agenda item | Hold, suppress, decay, or re-gate if its evidence changed. |
| Outcome decision | Expire or mark needs re-admission when selected under old Surface. |
| Expression decision | Hold or withdraw when visibility depended on old Surface. |
| Memory-write candidate | Revalidate ownership, permission, and source evidence. |
| Session resume | Require Surface compatibility or re-grounding before use. |

Regeneration rules:

- Surface regeneration must rerun scope, lifecycle, staleness, sensitivity,
  permission, use, forbidden-use, projection, and audit gates.
- Regeneration must not copy `included_context` forward as trusted context.
- Tombstoned sources may contribute only non-content metadata.
- Deleted sources must not be reconstructed from old Surface snapshots,
  agenda rationale, outcome rationale, audit text, or debug traces.
- If the invalidation trigger is ambiguous, dependent action, expression,
  resume, and memory-write candidates fail closed.

The invalidation graph is directional:

```text
memory / permission / runtime correction
  -> Surface invalidation
  -> dependent agenda and runtime item re-check
  -> outcome re-admission or expiry
  -> expression hold, withdrawal, or regeneration
```

## Surface Contents

A Surface can include multiple lanes.

```text
Surface
  Knowledge lane
  WorkMemory lane
  Relationship lane
  Boundary lane
  Promise lane
  Tension lane
  AntiMemory lane
  Exclusion lane
```

Surface lanes are role lanes. Each included item still carries `record_kind`
and any required `domain_fields`. A Surface must not flatten a `routine`,
`intervention_policy`, `boundary`, or `episodic_event` into generic prose
because each kind has different staleness, permission, and correction rules.

The Exclusion lane is important. It records meaningful context that was
considered but withheld, suppressed, or blocked from a particular use.

Example:

```text
Included:
  WorkMemory: current design task is relationship memory design.
  Boundary: do not turn relationship memory into engagement optimization.
  Tension: PulSeed should feel alive while preserving user agency.

Excluded:
  Prior broad personal-context discussions were not projected as user
  personality facts.
```

## Relationship To Attention

Memory can shape attention in three ways:

1. It can make something noticeable.
2. It can create or strengthen an urge candidate.
3. It can inhibit, suppress, or narrow an urge.

Memory must not directly cause:

- notification
- user-facing speech
- external action
- session resume
- Surface update
- Soil write

Those require downstream attention, companion state, runtime control, authority,
and audit.

## Relationship To Companion State

Surface informs `CompanionState`, but does not define it alone.

Examples:

- A promise in Surface may raise attention for a follow-up.
- A boundary in Surface may put PulSeed into `holding_back`.
- A stale WorkMemory record may cause `needs_user` before resume.
- A sensitive relationship record may raise expression thresholds or reduce
  expression eligibility for inhibition, not make proactive speech easier.

Companion state must combine Surface with runtime state, active goals, user
activity, correction history, and current capacity.

## Relationship To Runtime Control

Runtime control should treat Surface as an authority input.

Runtime items that use memory should record:

```text
related_surface_refs
related_memory_refs
permission_checks
staleness_checks
use_class
blocked_use_refs
audit_trace_refs
```

Resume, action, memory write, Surface refresh, and proactive expression must
all be rejectable when Surface is stale, missing, or not authorized for that
use.

## Correction And Repair

User correction can affect memory in several ways:

- correct the statement
- narrow the scope
- revoke a use
- suppress projection
- mark as stale
- supersede with new understanding
- retract entirely
- delete

Correction must not become a debate over engagement. It is governance input.

When correction changes a memory, the Surface using the old memory should be
invalidated or marked for review. The invalidation policy must also identify
dependent agenda items, outcome decisions, runtime items, expression decisions,
and memory-write candidates that were admitted under the old Surface.

## Audit Requirements

A memory-use audit should answer:

- which memory was considered
- whether it was included or excluded from Surface
- which use was requested
- which permission allowed or blocked it
- whether it was stale, superseded, or sensitive
- whether it influenced notice, urge, inhibition, expression, work, or action
- whether the user can correct, suppress, revoke, or forget it

When a memory is tombstoned or deleted, audit answers must use the redacted
metadata allowed by the lifecycle state. They must not expose erased content.

Audit should include non-use. For relationship memory, what PulSeed chose not
to use is often the trust-relevant fact.

## End-To-End Flow

```text
Trace:
  User corrects a PulSeed design direction.

Dream:
  Identifies the correction as potentially durable relationship context.

Governed memory:
  Creates a scoped Boundary or Tension record with provenance and allowed uses.

Surface:
  Projects it for future related design sessions as design grounding and
  behavioral inhibition, but not as a personality label.

Attention:
  Uses it to suppress a design direction that would optimize attachment.

Runtime control:
  Records that the suppression occurred and remains inspectable.

Expression:
  Either stays silent, or briefly explains the boundary if the user asks why.

Feedback:
  User correction updates the memory or narrows the Surface scope.
```

## Design Drift Checks

Use these checks when extending this layer:

1. Does this turn memory into direct permission?
2. Does this make Soil or Markdown the write truth?
3. Does this treat Surface as a prompt dump?
4. Does this store an interpretation as a user fact?
5. Does this optimize closeness, attachment, or engagement?
6. Does this make relevance sufficient for projection?
7. Does this omit forbidden uses?
8. Does this forget to record excluded or suppressed context?
9. Does this let stale memory enter Surface without review?
10. Does this hide correction, supersession, or forgetting from audit?

If yes, the design is drifting away from relationship memory and Surface.
