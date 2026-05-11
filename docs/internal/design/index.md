# Internal Design Notes

This directory holds design notes, proposal material, active implementation
contracts, and historical rationale. It is intentionally separate from the
public documentation path in [PulSeed Documentation](../../index.md).

Use public-current docs first:

1. [README](../../../README.md)
2. [PulSeed Documentation](../../index.md)
3. [Getting Started](../../getting-started.md)
4. [Runtime](../../runtime.md)
5. [Mechanism](../../mechanism.md)
6. [Architecture Map](../../architecture-map.md)
7. [Module Map](../../module-map.md)

## Reading Model

Files under `docs/internal/design/` may describe active contracts, current
implementation background, proposals, or historical rationale. Every design note
has an internal-design status banner, but the exact implementation truth is
still the current code and public-current docs.

## Active Interaction Contracts

- [Companion Autonomy Spine](core/companion-autonomy-spine.md)
- [Relationship Memory And Surface](core/relationship-memory-surface.md)
- [Attention Metabolism And Initiative](core/attention-metabolism-initiative.md)
- [Runtime Control Plane](infrastructure/runtime-control-plane.md)
- [Database-First State Ownership](infrastructure/database-first-state-ownership.md)
- [Companion Capability Runtime](infrastructure/companion-capability-runtime.md)
- [Codex-Like User Interaction Contract](execution/codex-like-interaction-contract.md)
- [Exact Protocol Grammar Boundaries](execution/exact-protocol-boundaries.md)
- [Runtime Auth, Browser Session, And Guardrail Control Model](infrastructure/runtime-auth-browser-guardrails.md)

## Archived Or Historical Design Notes

Some old notes are retained under [Internal Archive](../archive/index.md) when
they are useful for context but should not be read as current architecture.

## Organizing Rule

Prefer public docs before reading subsystem-specific design notes. The design
index is a pointer into background material, not a replacement for the public
documentation map.
