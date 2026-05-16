# Companion Surface Closure

> Status: Active public design decision. Last checked against implementation:
> 2026-05-16.

This document records the public boundary between companion diagnostics,
ordinary user-facing chat, Telegram delivery, memory inspection, and relationship
review. It explains why PulSeed exposes some companion state through explicit
operator commands while keeping normal chat and gateway output free of raw
internal refs.

## Personal-Agent Normal Surface

`PersonalAgentNormalSurfaceProjection` remains connected through the explicit
operator diagnostic path:

- `pulseed runtime initiative-trace <ref> --normal [--json]`
- existing personal-agent trace store and projection contracts

Automatic display in chat or Telegram is not enabled in the current
implementation. The safe integration point is an explicit user command or opt-in
surface that requests a specific trace summary. Passive auto-display would
introduce two risks:

- a normal user payload could receive raw trace, policy, evidence, or capability
  internals before the owning surface has redaction tests;
- a resident proactive message could look like new action authority instead of a
  read-only explanation.

Further integration must stay on the existing chat/Telegram/runtime surface
owners and prove, with caller-path tests, that raw refs are hidden and action
authority is unchanged.

## Memory Inspect And Relationship Review

`pulseed memory inspect <kind:id> [--json]` stays a read-only correction and
governance inspection command. It should not become the relationship review UX.

Current relationship review state already flows through the cognition and memory
lifecycle path:

- `CompanionCognitionService` builds `RelationshipStateProjection`;
- cognition replay records preserve refs-only stable output;
- `pulseed runtime cognition-replay --view normal [--json]` exposes read-only
  review inbox and relationship memory summaries without raw memory refs.

Broad relationship review UX requires a product surface that can show "used",
"withheld", "correct", "suppress", and "forget" affordances together. Expanding
`memory inspect` into that role would duplicate the cognition review path and
mix one-record correction inspection with turn-scoped relationship context.

## Research Evidence Boundary

`ResearchBrief`, `SourceRecord`, and `EvaluatorReport` are contract-only
artifacts over existing `RuntimeEvidenceEntry` data. They do not create a
separate research runtime. Source records are aliases of existing runtime
evidence research sources, and evaluator reports consume runtime evidence entry
ids.

## Peer Initiative Current Claim

Peer initiative current capability is Telegram-only outbound delivery. Additional
surfaces remain contract-only until channel budgets, explicit opt-in, and
feedback calibration exist.
