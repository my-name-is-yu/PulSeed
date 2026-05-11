# PulSeed Documentation

This is the entry point for PulSeed documentation.

PulSeed docs are organized by reader need:

- **Getting Started**: install PulSeed and run the first interactive session.
- **Guide**: operate goals, runtime surfaces, daemon mode, schedules, and
  gateway/chat workflows.
- **Concepts**: understand the current execution model.
- **Reference**: look up commands, configuration, runtime state, and package
  checks.
- **Architecture**: navigate the current source tree and stable subsystem map.
- **Roadmap**: read product direction and future scenarios without treating them
  as current behavior.
- **Design**: read design documents, implementation contracts, audits,
  and design history without treating them as operating instructions.

## First-Reader Path

1. [README](../README.md)
2. [Getting Started](getting-started.md)
3. [Guide](guide.md)
4. [Runtime](runtime.md)
5. [Configuration](configuration.md)
6. [Status](status.md)

The current operating path should only describe behavior that exists in the current
repository or package. If a page describes product direction, a proposal, or a
historical implementation note, it must say so before the reader reaches the
details.

## Documentation Sections

### Getting Started

- [Getting Started](getting-started.md)

### Guide

- [Guide](guide.md)
- [Runtime](runtime.md)

### Concepts

- [Concepts](concepts.md)
- [Mechanism](mechanism.md)

### Reference

- [Reference Index](reference/index.md)
- [Configuration](configuration.md)
- [Status](status.md)

### Architecture

- [Architecture](architecture.md)
- [Architecture Map](architecture-map.md)
- [Module Map](module-map.md)

### Roadmap And Future Direction

- [Roadmap Index](roadmap/index.md)
- [Positioning](roadmap/positioning.md)
- [Vision](roadmap/vision.md)
- [Use Cases](roadmap/use-cases.md)
- [Future Work](roadmap/future-work.md)

### Design Documents

- [Design Index](design/index.md)

## Retired Thin Paths

The docs tree intentionally avoids folders that only exist to hold a single
`index.md`. These paths were flattened in favor of direct pages:

- `docs/start/index.md` -> [Getting Started](getting-started.md)
- `docs/guide/index.md` -> [Guide](guide.md)
- `docs/concepts/index.md` -> [Concepts](concepts.md)
- `docs/architecture/index.md` -> [Architecture](architecture.md)
- `docs/design/audits/docs-audit/` -> `docs/design/audits/`
- `docs/design/archive/design/` -> `docs/design/archive/`
- `docs/internal/` -> [Design Documentation](design/index.md), which links to
  design archive material when needed

Do not recreate those directories as compatibility-only stubs unless the docs
hosting layer gains real redirects. A placeholder folder makes the source tree
look deeper than the reader path actually is.

## Source Of Truth

When docs overlap, prefer the most specific page for the topic:

- `README.md` for project entry, short overview, and first link out
- `docs/getting-started.md` for installation and first run
- `docs/runtime.md` for runtime surfaces and operational commands
- `docs/mechanism.md` for the conceptual execution model
- `docs/configuration.md` for configuration keys and setup details
- `docs/status.md` for current status
- `docs/architecture-map.md` and `docs/module-map.md` for code navigation
- `docs/design/` for design documents and design history, not
  current operating behavior

If code and docs disagree, treat the current code, CLI registry, package
scripts, runtime schemas, and tests as the implementation truth. Fix the docs or
move the uncertain claim to roadmap or design-history material.

## Naming Rules

Use these names consistently:

- `PulSeed` for the product and repository
- `pulseed` for the CLI and npm package
- `pulseed.dev` for the website
- `SeedPulse` only for legacy references or explicitly historical context
