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

## Current baseline

For the implementation-facing baseline, start with [current-baseline.md](current-baseline.md).
That file should be treated as the current design anchor when you need a lower-level view of the system.

## Reading model

The files under `docs/design/` may mix:

- current implementation background
- active proposals
- historical notes

That mix is expected here, but it should not leak back into the public docs.

When a design note conflicts with the public docs, treat the public docs as the user-facing source of truth.

## Archive

`docs/archive/` is an ignored local holding area for legacy material.
Do not treat it as current guidance.

## Organizing rule

Prefer the public docs and the current baseline before reading subsystem-specific design notes.
The design index is a pointer into background material, not a replacement for the public documentation map.
