# Core Companion Memory Projection

> Status: Active design contract for the typed companion-memory projection in
> `src/runtime/decision/`. It does not define a new memory store and does not
> replace Surface, Soil, KnowledgeManager, or the correction/quarantine
> substrate.
> Doc status: active_design_contract
> Grounding use: design_context

Primary map: [Relationship And Memory Surface](./relationship-memory-map.md).

## Purpose

`CoreCompanionMemoryProjection` is the governed memory view that
`CompanionCognitionOutput` can cite when chat turns, task execution, or resident
attention need governed continuity.

It answers:

```text
Which already-governed memories may influence this companion decision, and only
for which kind of use?
```

It does not answer:

```text
What should PulSeed remember globally?
```

Global memory ownership stays with the current owners.

## Canonical Inputs

The projection composes current code paths instead of adding a parallel memory
plane.

| Area | Canonical path | Projection role |
| --- | --- | --- |
| Governed memory contract | `src/platform/profile/governed-memory.ts` | Defines record role, record kind, lifecycle, correction state, allowed uses, forbidden uses, sensitivity, and use audit. |
| Relationship profile store | `src/platform/profile/relationship-profile.ts` | Current owner bridge for relationship profile items, boundaries, preferences, and intervention policy. |
| Surface projection | `src/grounding/surface-contracts.ts` | Canonical contract for memory entering a runtime situation. The Surface runtime admission and invalidation helpers in this file are contract-only until a production caller path wires them explicitly. |
| Profile Surface bridge | `src/grounding/profile-surface.ts` | Converts relationship profile records into Surface source refs and permissions. |
| KnowledgeManager memory | `src/platform/knowledge/knowledge-manager-agent-memory.ts` | Existing agent memory lifecycle, correction, quarantine, and governance substrate. |
| Soil retrieval | `src/platform/soil/`, `src/grounding/providers/soil-provider.ts` | Knowledge/projection retrieval owner; not a universal write owner for relationship memory. |
| Corrections and quarantine | `src/platform/corrections/` | Keeps corrected, retracted, forgotten, suspicious, and quarantined memory from being treated as current. |
| Grounding profiles | `src/grounding/profiles.ts` | Selects the caller profile that produced the Surface and grounding bundle evidence. |
| Companion cognition | `src/runtime/cognition/contracts.ts` | Reads the memory projection as a typed `memory_projection` context ref, not prompt text. |

## Contract Boundary

`CoreCompanionMemoryProjection` lives in
`src/runtime/decision/core-companion-memory-projection.ts`.

The projection carries:

- `source_refs`: Surface, grounding profile, grounding bundle, relationship
  profile, profile proposal, runtime session, KnowledgeManager, Soil, Dream
  seed, and correction ledger refs.
- `included_entries`: Surface-admitted memory entries with available excerpts.
- `restricted_entries`: remembered-but-withheld refs for stale, superseded,
  corrected, sensitive, out-of-scope, redacted, permission-blocked, or forbidden
  memory.
- `use_policy`: the decision-facing distinction between remembered, usable,
  speakable, actionable, inhibition-only, planning-only, and forbidden memory.
- `ordinary_surface_policy`: a fail-closed declaration that ordinary companion
  surfaces do not receive raw memory dumps or raw correction state.

The projection includes a `prompt_dump: never` guard so callers cannot smuggle a
raw memory block through this contract.

## Use Classes

The projection keeps these distinctions explicit:

- `remembered`: a memory ref may be retained for governance or audit.
- `usable`: the current Surface allows it to influence the decision.
- `speakable`: the memory may be referenced to the user now.
- `actionable`: the memory may inform an action candidate now.
- `inhibition_only`: the memory can suppress or narrow behavior but cannot be
  spoken or acted on.
- `planning_only`: the memory can guide planning, attention, or confirmation but
  cannot be spoken or acted on directly.
- `forbidden`: the memory can be retained only as a non-use/refusal/invalidation
  fact for the requested use.

Memory is never runtime authority. Even an actionable memory entry carries
`memory_is_runtime_authority=false`; execution still belongs to admission,
autonomy, approval, runtime control, and the relevant caller path.

Surface runtime admission and invalidation helpers such as
`evaluateSurfaceRuntimeAdmission`,
`invalidateSurfaceProjectionFromMemoryCorrection`, and
`revalidateSurfaceMemoryWriteCandidateAfterInvalidation` are intentionally
contract-only here. They define the fail-closed shape that production caller
paths must use, but they do not by themselves perform runtime execution, write
owner memory, or mutate live replay state.

## Exclusion Rules

Surface remains the first gate. The core projection refuses to include entries
whose source ref is sensitive, redacted, stale, inactive, corrected,
superseded, or replaced.

Restricted entries retain only typed refs and restriction reasons. They can
inhibit overreach or explain audit state, but they do not expose content to
ordinary companion surfaces.

The current restriction reasons are:

```text
stale
superseded
corrected
sensitive
out_of_scope
redacted
lifecycle_ineligible
permission_blocked
forbidden_use
not_allowed_for_requested_use
stale_or_missing_surface
```

## Caller Path

`createCoreCompanionMemoryProjectionFromSurface` builds the projection from an
existing `SurfaceProjection`. `createCoreCompanionMemoryProjectionCognitionRef`
returns the typed `memory_projection` context ref for Companion Cognition.

This keeps caller adoption incremental:

1. Existing grounding and Surface builders stay canonical.
2. Companion Cognition outputs cite the projection ref.
3. Future chat/task/resident caller paths can persist or inspect the projection
   without reimplementing memory selection.
4. Gadget planning can use the same use policy without letting memory authorize
   tools, notifications, or side effects.

## Tests

Focused coverage lives in
`src/runtime/decision/__tests__/core-companion-memory-projection.test.ts`.

The tests prove:

- Soil/Knowledge/profile source refs remain owner-specific while Surface stays
  the projection gate.
- The projection can become a `memory_projection` cognition context ref.
- remembered, usable, speakable, actionable, inhibition-only, planning-only,
  and forbidden states are distinct.
- stale, superseded, corrected, sensitive, out-of-scope, and deleted memory is
  withheld before decision use.
- direct included-entry bypasses for sensitive or corrected memory are rejected.
