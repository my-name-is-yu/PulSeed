# Design Documents

This directory holds design notes, proposal material, and historical implementation background.
It is intentionally separate from the public documentation path in [docs/index.md](../index.md).

Use the public docs first:

1. [README](../../README.md)
2. [docs/index.md](../index.md)
3. [Getting Started](../getting-started.md)
4. [Runtime](../runtime.md)
5. [Mechanism](../mechanism.md)
6. [Architecture Map](../architecture-map.md)
7. [Module Map](../module-map.md)

## Reading model

The files under `docs/design/` may mix:

- current implementation background
- active proposals
- historical notes

That mix is expected here, but it should not leak back into the public docs.

Public docs are the user-facing source of truth. Active interaction contracts are
the implementation and safety source of truth for the behavior they govern. When
they conflict, fix the stale public docs instead of weakening the active
contract.

## Archive

`docs/archive/` is an ignored local holding area for legacy material.
Do not treat it as current guidance.

## Organizing rule

Prefer the public docs before reading subsystem-specific design notes.
The design index is a pointer into background material, not a replacement for the public documentation map.

## Active Interaction Contracts

- [Companion Autonomy Spine](core/companion-autonomy-spine.md)
- [Relationship Memory And Surface](core/relationship-memory-surface.md)
- [Attention Metabolism And Initiative](core/attention-metabolism-initiative.md)
- [Runtime Control Plane](infrastructure/runtime-control-plane.md)
- [Companion Capability Runtime](infrastructure/companion-capability-runtime.md)
- [Companion Capability Runtime Gap Audit](infrastructure/companion-capability-runtime-gap-audit.md)
- [Codex-Like User Interaction Contract](execution/codex-like-interaction-contract.md)
- [Exact Protocol Grammar Boundaries](execution/exact-protocol-boundaries.md)
- [Runtime Auth, Browser Session, And Guardrail Control Model](infrastructure/runtime-auth-browser-guardrails.md)
