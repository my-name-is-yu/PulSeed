# Status

Current public status as of 2026-04-12.

This page stays intentionally short.
For the conceptual model, see [Mechanism](mechanism.md).
For runtime surfaces, see [Runtime](runtime.md).
For broader navigation, see [Architecture Map](architecture-map.md).

## In active use

- long-lived `DurableLoop` control
- bounded `AgentLoop` execution
- shared tool substrate
- Soil as a long-lived memory surface
- CLI, chat, TUI, daemon, and cron runtime surfaces

## Publicly supported direction

- use `pulseed` as the main entry point
- perform the normal workflow in natural language
- keep lower-level subcommands for scripting, diagnostics, and compatibility

## Still evolving

- scheduler heuristics
- provider defaults
- native AgentLoop quality and policy
- design notes under `docs/design/`

## Safety Boundary

PulSeed has software-level approval and verification gates. Native `agent_loop`
task execution can use git worktree isolation, and supported CLI adapters can be
wrapped with a Docker terminal backend. These boundaries are configurable and do
not cover every execution path: local backends and plugins still run with the
user's privileges. For high-risk or untrusted goals, use Docker, a containerized
PulSeed process, or a VM boundary. See [Security](../SECURITY.md).

## Capability Projection

Companion capability status is not derived from import or registry presence
alone. Public and operator-facing labels are derived from readiness snapshots,
then annotated with explicit admission and autonomy decisions when those
decisions match the same operation scope.

Normal companion surfaces should not expose a capability catalog or raw policy
state. They project the next best safe action, such as suggest, prepare a draft,
ask for approval, execute an already admitted operation, or offer a safe
alternative. Operator, status, and debug surfaces may show readiness, admission,
autonomy, evidence, and warning details so degraded or blocked state remains
inspectable.

## Source of truth

When public docs disagree, prefer the more specific page:

1. [README](../README.md)
2. [docs/index.md](index.md)
3. [Getting Started](getting-started.md)
4. [Mechanism](mechanism.md)
5. [Runtime](runtime.md)
6. [Architecture Map](architecture-map.md)
