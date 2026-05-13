# Companion Cognitive Architecture

> Status: Active design contract for the local-first companion cognition
> architecture. Code, schemas, and tests remain the source of truth for exact
> behavior.

PulSeed's cognitive architecture is the set of local-first contracts that make
companion behavior replayable, correctable, and bounded by the owners that
already control memory, runtime authority, approval, reflection, and surfaces.

The `CompanionCognitionService` is only the turn-scoped advisory layer over that
architecture. It may assemble typed situation, relationship, intention,
response, tool-candidate, writeback, and audit refs for a caller path. It does
not execute work, grant approval, write canonical memory, own notifications, or
replace caller-specific route ownership.

## Ownership Matrix

| Subsystem | Owns | Does not own |
| --- | --- | --- |
| Working context | Current input, route, reply target, session, run, goal, resident, and operation refs | Durable user facts or execution authority |
| Cognitive replay index | Owner-neutral replay entries over existing local stores, retention and redaction metadata, source invalidation status | A physical monolithic event store or cross-store writes |
| Relationship/Profile surface | Governed relationship memory, projection policy, corrections, supersession, and deletion for profile data | Tool authorization or runtime execution |
| Soil/Knowledge | Project and knowledge facts under their owner schemas | Direct companion action authority |
| Intention state | Commitment refs, lifecycle transitions, stale-target rejection, permission-wait continuity, and regrounding reasons | Task execution or route selection |
| Admission, autonomy, approval, and runtime control | Side-effect authority, permission waits, control state, exact-scope approval, and execution gates | Memory truth, user-facing wording, or semantic relationship policy |
| Companion action projection | Normal-surface safe presentation of action decisions | Internal policy dumps or execution |
| Reflection | Writeback queueing, owner routing, proposal evaluation, and audit of accepted, rejected, superseded, or blocked proposals | Runtime authority or direct writes to owner memory without owner admission |
| Visibility and inspection | Redacted operator views, normal-surface suppression, repair options, and deletion-aware rendering | Raw prompt, raw memory, or hidden policy disclosure to ordinary surfaces |
| Cloud boundary | Explicit external-service authorization, redaction refs, local-only blocking, and audit refs for model-visible context | Memory ownership or execution authority |

## Current Invariants

- Cognition outputs are advisory and refs-only where replay durability matters.
- Memory is evidence, never runtime authority.
- Model text and character configuration cannot grant execution authority.
- Resident proactive cognition is downgrade-only from attention and operation
  boundaries.
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
| Reflection input | Dream/reflection report store |

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
