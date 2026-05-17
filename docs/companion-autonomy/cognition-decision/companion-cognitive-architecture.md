# Companion Cognitive Architecture

> Status: Active design contract for the local-first companion cognition
> architecture. Code, schemas, and tests remain the source of truth for exact
> behavior.

Primary map: [Cognition And Decision](./cognition-decision-map.md).

PulSeed's cognitive architecture is the set of local-first contracts that make
companion behavior replayable, correctable, and bounded by the owners that
already control memory, runtime authority, approval, reflection, and surfaces.

`CompanionCognitionKernel` is the shared advisory boundary over that
architecture. Chat turns, resident proactive checks, long-running task context,
schedule wakes, runtime-control responses, and memory-truth operations assemble
typed refs and pass them through the kernel before their owning route, authority,
delivery, or memory subsystem acts. The legacy `CompanionCognitionService` name
remains only as a compatibility facade over the kernel.

The kernel may assemble typed situation, relationship, intention, candidate
action, commitment handoff, response, memory-use audit, authority handoff,
writeback, replay, and audit refs for a caller path. It does not execute work,
grant approval, write canonical memory, own notifications, or replace
caller-specific route ownership.

## Ownership Matrix

| Subsystem | Owns | Does not own |
| --- | --- | --- |
| Working context | Current input, route, reply target, session, run, goal, resident, and operation refs | Durable user facts or execution authority |
| Cognitive replay index | Owner-neutral replay entries over existing local stores, retention and redaction metadata, source invalidation status | A physical monolithic event store or cross-store writes |
| Relationship/Profile surface | Governed relationship memory, projection policy, corrections, supersession, and deletion for profile data | Tool authorization or runtime execution |
| Soil/Knowledge | Project and knowledge facts under their owner schemas | Direct companion action authority |
| Intention state | Commitment refs, lifecycle transitions, stale-target rejection, permission-wait continuity, and regrounding reasons | Task execution or route selection |
| Attention and commitment | Attention input intake, `AttentionStateStore`, commitment candidates, commitment lifecycle controls, and operation selection | A second commitment classifier, lifecycle store, or hidden action executor |
| Admission, autonomy, approval, and runtime control | Side-effect authority, permission waits, control state, exact-scope approval, and execution gates | Memory truth, user-facing wording, or semantic relationship policy |
| Companion cognition kernel | Typed situation assembly, candidate action/no-op/hold/suppress, response-plan, memory-use audit, authority handoff, commitment handoff, reflection proposal, and replay correlation refs | Side effects, direct memory mutation, notification delivery, prompt ownership, or approval bypass |
| Companion action projection | Normal-surface safe presentation of action decisions | Internal policy dumps or execution |
| Reflection | Writeback queueing, owner routing, proposal evaluation, and audit of accepted, rejected, superseded, or blocked proposals | Runtime authority or direct writes to owner memory without owner admission |
| Visibility and inspection | Redacted operator views, normal-surface suppression, repair options, and deletion-aware rendering | Raw prompt, raw memory, or hidden policy disclosure to ordinary surfaces |
| Cloud boundary | Explicit external-service authorization, redaction refs, local-only blocking, and audit refs for model-visible context | Memory ownership or execution authority |

## Current Invariants

- Cognition outputs are advisory and refs-only where replay durability matters.
- Memory is evidence, never runtime authority.
- Model text and character configuration cannot grant execution authority.
- Direct production callers do not assemble companion behavioral prompt policy,
  memory-use policy, commitment policy, or action policy outside the kernel or
  explicitly approved provider/eval/diagnostic boundaries.
- Resident proactive cognition is downgrade-only from attention and operation
  boundaries.
- Schedule wakes, runtime-control responses, and memory truth operations enter
  the kernel with RuntimeGraph/Event Log, active control, authority, and memory
  truth refs, but their existing owners still decide and execute mutations.
- Normal user surfaces cannot receive operator debug refs, raw policy state, raw
  prompt material, or raw memory dumps.
- Replay and inspection fail closed when source refs are missing, deleted, or
  tombstoned.
- Cloud compute is optional external service use; local state remains primary.

## Replay Index Contract

The replay index is owner-neutral metadata over distributed local stores. Each
entry names the owning store, the cognition record or stable event ref, the
retention policy, redaction state, source refs, and invalidation refs. It is a
map for audit and reflection, not a new store owner.

Current caller mappings:

| Caller path | Owning store |
| --- | --- |
| Chat turn | Chat history or chat event journal |
| Long-running task turn | Runtime operation/session store |
| Resident proactive check | Attention ledger or resident activity store |
| Schedule wake | Schedule engine trace and personal-agent runtime store |
| Runtime-control response | Runtime operation store, approval/permission stores, and personal-agent runtime store |
| Memory truth operation | Memory Truth Maintenance, runtime evidence ledger, and personal-agent runtime store |
| Reflection input | Dream/reflection report store |

## Prompt And Policy Assembly Boundaries

Production caller paths should produce typed kernel input rather than
freeform behavioral prompt fragments. The approved direct assembly boundaries are:

- provider adapters that translate already-governed model-visible context into a
  provider request
- diagnostics, operator/debug commands, migration code, tests, and eval fixtures
- exact protocol parsing for slash commands, IDs, paths, enum values, schemas,
  feature flags, and wire tokens

Those boundaries may format strings, but they must not become the primary owner
for freeform user-intent classification, memory-use policy, commitment
lifecycle, action policy, quieting, suppression, stale-target reuse, or approval
decisions. The production guard `npm run check:companion-cognition-boundaries`
blocks new direct relationship-surface assembly, direct
`CompanionCognitionService` construction, and relationship-state projection
assembly outside the cognition boundary.

## Kernel Integration Flow

The current production flow is:

1. Surface, runtime, schedule, attention, memory truth, or task owners assemble
   `CompanionCognitionInput` with refs to SituationFrame-equivalent context,
   reply target/session/run refs, attention and commitment state, memory truth
   and projection refs, RuntimeGraph/Event Log refs, active runtime-control
   state, relationship permissions, stale/conflict/uncertainty refs, and the
   caller path.
2. `CompanionCognitionKernel` returns typed advisory output:
   `candidate_action`, `commitment_handoff`, `response_plan`,
   `memory_use_audit`, `authority_handoff`, writeback/reflection proposals, and
   replay/idempotency correlation refs.
3. The owning subsystem consumes only the part it owns. Interaction Authority,
   runtime control, tool policy, schedule, delivery, Memory Truth Maintenance,
   AttentionStateStore, Runtime Event Log, RuntimeGraph, and surface projection
   remain the side-effect and projection owners.
4. Normal surfaces receive only governed projections. Operator/debug surfaces may
   inspect raw refs and policy evidence explicitly.

## Boundary Rules

New code that touches companion cognition must extend the narrow owner contract
closest to the behavior. A profile change belongs to Profile/Surface. Runtime
authority belongs to admission, autonomy, approval, and runtime control. Task
execution belongs to AgentLoop and the tool substrate. Reflection can evaluate
and route proposals, but owner-specific acceptance, repair, rollback, and
deletion stay with the owning modules.

Semantic decisions over freeform user input must use typed model output, schema
validation, explicit confidence or unknown behavior, and caller-path coverage.
Exact protocol surfaces such as slash commands, IDs, paths, enum values, schema
validation, and wire tokens may use deterministic parsing.
