# Public Documentation Map

This page is the public entry point for PulSeed documentation.
It defines the reading order, the source-of-truth policy, and the boundaries between start, concept, operation, reference, direction, design, and archived material.

## Reading order

1. [README](../README.md)
2. [Positioning](positioning.md)
3. [Getting Started](getting-started.md)
4. [Runtime](runtime.md)
5. [Mechanism](mechanism.md)
6. [Configuration](configuration.md)
7. [Architecture Map](architecture-map.md)
8. [Module Map](module-map.md)
9. [Vision](vision.md)
10. [Use Cases](usecase.md)
11. [Roadmap](roadmap.md)
12. [Status](status.md)
13. [Design Index](design/index.md)

## Source of truth

When public docs overlap, prefer the most specific page for the topic:

- `README.md` for project entry, short overview, and first link out
- `positioning.md` for the canonical short explanation of product category,
  current wedge, and north star
- `getting-started.md` for installation and first run
- `runtime.md` for runtime surfaces and operational commands
- `mechanism.md` for the conceptual execution model
- `configuration.md` for config keys and setup details
- `architecture-map.md` and `module-map.md` for navigation and reference
- `status.md` for current public status and capability projection boundaries
- `docs/design/` for design notes, proposals, and implementation-facing background

If a public doc and a design note disagree, the public doc wins for user-facing behavior and navigation.
If code and docs disagree, treat code and tests as the higher-priority source.

## Categories

### Start

Start here:

- `README.md`
- `positioning.md`
- `getting-started.md`

### Concepts

Conceptual explanation:

- `mechanism.md`

### Operations

Runtime and current state:

- `runtime.md`
- `status.md`

### Reference

Lookup material:

- `configuration.md`
- `architecture-map.md`
- `module-map.md`

### Direction

Product direction and narrative examples:

- `positioning.md`
- `vision.md`
- `usecase.md`
- `roadmap.md`

### Contributor / Testing

Contributor and testing notes should live here only when they are maintained as public docs.
Historical testing notes belong in the ignored local archive.

### Design Notes

`docs/design/` is for design notes and implementation-facing discussion.
It may mix current, proposal, and historical material.
Use the public docs first, then the design notes when you need subsystem detail or background.

### Archive

`docs/archive/` is an ignored local holding area for legacy notes.
It is not part of normal navigation and should not be treated as current guidance.

If archived material needs to become public again, move it out of `docs/archive/` and link it from this map.

## Naming rules

Use these names consistently in public docs:

- `PulSeed` for the product
- `pulseed` for the CLI and npm package
- `pulseed.dev` for the website
- `PulSeed` for the GitHub repository name when referencing the repo itself
- `SeedPulse` only for legacy references or the local directory name

Do not mix `SeedPulse` into current product prose unless the text is explicitly about history or the filesystem location.
