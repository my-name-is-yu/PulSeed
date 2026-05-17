# Concepts

> Status: Current concepts index. This page explains code-backed concepts before readers enter design history.
> Doc status: active_design_contract
> Grounding use: design_context

Use this page when you want to understand how PulSeed works before reading
design documents or source code.

PulSeed's current implementation has a small set of code-backed concepts:

- **DurableLoop** keeps long-running goals alive across turns, sessions, daemon
  runs, schedules, and verification cycles.
- **AgentLoop** handles bounded tool-using work for chat turns, task execution,
  and selected runtime phases.
- **Local state** lives under `~/.pulseed/` by default, or under the directory
  selected by `PULSEED_HOME`.
- **Evidence and verification** separate "a task ran" from "the goal moved
  closer to completion."
- **Runtime surfaces** expose the same core state through CLI, TUI, daemon,
  schedules, gateway channels, and diagnostics.

Terminology bridge:

- [Glossary](glossary.md)

Read next:

- [Mechanism](./mechanism.md)
- [Source Orientation](./source-orientation-map.md)

Concept pages explain current behavior. Product-direction narrative belongs in
product-direction docs, and implementation contracts belong in design-contract docs.
