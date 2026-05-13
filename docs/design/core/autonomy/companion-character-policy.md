# Companion Character Policy Projection

> Status: Implemented control-plane projection slice. The persistence owner
> remains `CharacterConfigManager`; execution, approval, guardrail, and
> autonomy owners are unchanged.

PulSeed's character configuration is stored as user-editable configuration, but
ordinary companion behavior should not consume it as raw personality text or a
prompt dump. The canonical bridge is
`src/runtime/decision/companion-character-policy-projection.ts`, which projects
`CharacterConfig` into typed dialogue strategy, companion-decision policy hints,
and ordinary-surface policy.

## Canonical Paths

| Concern | Canonical path |
| --- | --- |
| character config schema | `src/platform/traits/types/character.ts` |
| character config persistence | `src/platform/traits/character-config.ts` |
| shared character numeric policy hints | `src/platform/traits/character-policy.ts` |
| companion character policy projection | `src/runtime/decision/companion-character-policy-projection.ts` |
| companion decision refs | `src/runtime/decision/companion-decision-contract.ts` |
| reporting surface formatting consumer | `src/reporting/report-formatters.ts` |
| goal feasibility and stall substrate consumers | `src/orchestrator/goal/negotiator-feasibility.ts`, `src/platform/drive/stall-detector/thresholds.ts` |

## Projection Contract

`CompanionCharacterPolicyProjection` contains:

- `dialogue_strategy`: directness, response shape, initiative posture, and
  clarification bias.
- `decision_policy`: caution and stall-response hints, plus explicit false
  flags proving character cannot relax safety, approval, or autonomy gates.
- `surface_policy`: ordinary companion reason detail, report verbosity,
  escalation suggestion policy, and explicit false flags for raw policy state,
  capability catalogs, debug state, and raw character knob disclosure.
- `source_refs`: typed refs back to stored config or runtime setup.

The projection can create `character_config_policy` input and policy refs for a
`CompanionDecisionFrame`. The frame receives typed refs, not raw personality
text, and model text is never authority for bypassing readiness, admission,
autonomy, approval, guardrails, or runtime control.

## Current Wiring

Reporting now consumes the projection for surface-level choices that were
previously computed directly from raw character fields:

- execution summary verbosity
- whether escalation notifications include default suggested next actions

Goal feasibility and stall thresholds consume the shared numeric hint helpers in
`src/platform/traits/character-policy.ts`. Those remain execution-planning
substrate knobs, not ordinary-surface policy, so the companion projection
exposes them as decision hints rather than using them to grant autonomy.

## Invariants

- Character policy is a hint layer. It cannot grant autonomy, execute tools,
  approve side effects, or weaken guardrails.
- Ordinary companion surfaces must not reveal raw readiness, admission,
  autonomy, policy-debug state, capability catalogs, or raw character knobs.
- The projection is structured data and schemas, not freeform keyword matching
  and not a prompt dump.
- Character config remains user-editable state; the companion decision layer
  consumes only the typed projection or typed refs to it.

## Follow-Up Boundary

A larger future slice can wire this projection into the first-class gateway chat
decision assembler once the chat decision frame is production-wired. That work
should reuse the same `character_config_policy` input and policy refs instead
of adding another personality or surface-policy path.
