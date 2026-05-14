# PulSeed Documentation

This is the entry point for PulSeed documentation.

PulSeed docs are organized by reader need:

- **Start**: install PulSeed and run the first interactive session.
- **Operate**: operate goals, runtime surfaces, daemon mode, schedules, and
  gateway/chat workflows.
- **Concepts**: understand the current execution model.
- **Reference**: look up commands, configuration, runtime state, and package
  checks.
- **Architecture**: navigate the current source tree and stable subsystem map.
- **Product Design**: read product design direction and product scenarios without treating them
  as current behavior.
- **Design**: read design documents, implementation contracts, audits,
  and design history without treating them as operating instructions.

## First-Reader Path

1. [README](../README.md)
2. [Getting Started](./start/index.md)
3. [Guide](./start/guide.md)
4. [Runtime](./operate/runtime.md)
5. [Configuration](./operate/configuration.md)
6. [Status](./operate/status.md)

The current operating path should only describe behavior that exists in the current
repository or package. If a page describes product design direction, a proposal, or a
historical implementation note, it must say so before the reader reaches the
details.

## Documentation Sections

### Start

- [Getting Started](./start/index.md)
- [Guide](./start/guide.md)

### Operate

- [Runtime](./operate/runtime.md)
- [Configuration](./operate/configuration.md)
- [Status](./operate/status.md)

### Concepts

- [Concepts](./concepts/index.md)
- [Mechanism](./concepts/mechanism.md)

### Reference

- [Reference Index](reference/index.md)
- [Configuration](./operate/configuration.md)
- [Status](./operate/status.md)

### Architecture

- [Architecture](./architecture/index.md)
- [Architecture Map](./architecture/architecture-map.md)
- [Module Map](./architecture/module-map.md)

### Product Design

- [Product Design Index](./product/index.md)
- [Product Completion Scenario Matrix](./product/completion-matrix.md)
- [Positioning](./product/positioning.md)
- [Vision](./product/vision.md)
- [Use Cases](./product/use-cases.md)
- [Extension Designs](./product/extensions.md)

### Design Documents

- [Design Index](design/index.md)

## Source Of Truth

When docs overlap, prefer the most specific page for the topic:

- `README.md` for project entry, short overview, and first link out
- `docs/start/index.md` for installation and first run
- `docs/start/guide.md` for practical workflows
- `docs/operate/runtime.md` for runtime surfaces and operational commands
- `docs/concepts/mechanism.md` for the conceptual execution model
- `docs/operate/configuration.md` for configuration keys and setup details
- `docs/operate/status.md` for current status
- `docs/architecture/architecture-map.md` and
  `docs/architecture/module-map.md` for code navigation
- `docs/design/` for design documents and design history, not
  current operating behavior

If code and docs disagree, treat the current code, CLI registry, package
scripts, runtime schemas, and tests as the implementation truth. Fix the docs or
move the uncertain claim to product-design or design-history material.

## Naming Rules

Use these names consistently:

- `PulSeed` for the product and repository
- `pulseed` for the CLI and npm package
- `pulseed.dev` for the website
- `SeedPulse` only for legacy references or explicitly historical context
