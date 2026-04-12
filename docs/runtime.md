# Runtime

This page covers the runtime surfaces and operations exposed by PulSeed.
For the conceptual model behind the runtime, see [Mechanism](mechanism.md).

## Surfaces

PulSeed currently exposes these runtime surfaces:

- CLI
- chat
- TUI
- daemon and cron

They share the same underlying state and orchestration model.

## CLI entry

The CLI entry point is `pulseed`.

The primary command is:

```bash
pulseed
```

From there, the normal workflow is natural language: create goals, ask for progress, run the next step, inspect reports, or control background operation by asking for it.
Lower-level subcommands remain available for scriptable and diagnostic use, but they are not the primary public path.

## Chat and TUI

`pulseed` is the interactive natural-language surface on top of the same runtime.
It follows the AgentLoop boundary described in [Mechanism](mechanism.md) and can expose chat, approvals, progress, reports, and loop control without requiring users to memorize subcommands.

## Daemon operations

Daemon mode is the resident host for continuous operation.
It keeps the runtime alive for long-running goal work and recovery.

The normal user-facing path is to ask PulSeed to keep a goal moving in the background.
Scriptable daemon and cron subcommands remain lower-level controls.

## What runtime does not explain

This page does not restate the loop model, verification model, or completion model in full.
Those concepts live in [Mechanism](mechanism.md).

## Related reference

- [docs/index.md](index.md)
- [Architecture Map](architecture-map.md)
- [Module Map](module-map.md)
