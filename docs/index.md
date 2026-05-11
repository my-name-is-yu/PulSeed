# PulSeed Documentation

This is the public entry point for PulSeed documentation.

PulSeed docs are organized by reader need:

- **Start**: install PulSeed and run the first interactive session.
- **Guide**: operate goals, runtime surfaces, daemon mode, schedules, and
  gateway/chat workflows.
- **Concepts**: understand the current execution model.
- **Reference**: look up commands, configuration, runtime state, and package
  checks.
- **Architecture**: navigate the current source tree and stable subsystem map.
- **Roadmap**: read product direction and future scenarios without treating them
  as current behavior.
- **Internal**: design notes, implementation contracts, audits, and archived
  material for maintainers.

## First-Reader Path

1. [README](../README.md)
2. [Getting Started](getting-started.md)
3. [Guide](guide/index.md)
4. [Runtime](runtime.md)
5. [Configuration](configuration.md)
6. [Status](status.md)

The public-current path should only describe behavior that exists in the current
repository or package. If a page describes product direction, a proposal, or a
historical implementation note, it must say so before the reader reaches the
details.

## Documentation Sections

### Start

- [Start Index](start/index.md)
- [Getting Started](getting-started.md)

### Guide

- [Guide Index](guide/index.md)
- [Runtime](runtime.md)

### Concepts

- [Concepts Index](concepts/index.md)
- [Mechanism](mechanism.md)

### Reference

- [Reference Index](reference/index.md)
- [Configuration](configuration.md)
- [Status](status.md)

### Architecture

- [Architecture Index](architecture/index.md)
- [Architecture Map](architecture-map.md)
- [Module Map](module-map.md)

### Roadmap And Future Direction

- [Roadmap Index](roadmap/index.md)
- [Positioning](roadmap/positioning.md)
- [Vision](roadmap/vision.md)
- [Use Cases](roadmap/use-cases.md)
- [Future Work](roadmap/future-work.md)

### Internal Design Notes

- [Internal Index](internal/index.md)
- [Internal Design Notes](internal/design/index.md)

## Source Of Truth

When public docs overlap, prefer the most specific page for the topic:

- `README.md` for project entry, short overview, and first link out
- `docs/getting-started.md` for installation and first run
- `docs/runtime.md` for runtime surfaces and operational commands
- `docs/mechanism.md` for the conceptual execution model
- `docs/configuration.md` for configuration keys and setup details
- `docs/status.md` for current public status
- `docs/architecture-map.md` and `docs/module-map.md` for code navigation
- `docs/internal/` for maintainer-facing background, not public-current
  behavior

If code and docs disagree, treat the current code, CLI registry, package
scripts, runtime schemas, and tests as the implementation truth. Fix the docs or
move the uncertain claim to roadmap/internal material.

## Naming Rules

Use these names consistently:

- `PulSeed` for the product and repository
- `pulseed` for the CLI and npm package
- `pulseed.dev` for the website
- `SeedPulse` only for legacy references or explicitly historical context
