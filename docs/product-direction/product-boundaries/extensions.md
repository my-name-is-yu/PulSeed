# Capability Expansion Model

> Status: Product extension design. Items here are not current behavior unless
> they also appear in current operating docs backed by current code.
> Doc status: active_design_contract
> Grounding use: design_context

Primary map: [Product Boundaries](./product-boundaries-map.md).

This page describes how PulSeed's companion-software contract expands beyond the
current local single-user runtime. The purpose is not to list delivery work.
Each extension area strengthens one of the same product properties: durable
memory, proactive help, safe intervention, and a growing pocket of capabilities.

---

## Identity And Scope

Companion software needs clear ownership of whose goals, memory, approvals, and
capabilities are in play. The current design assumes a single local operator.
Any multi-user or remote surface must preserve per-identity state boundaries,
authenticated access, and auditable authority before it can share a runtime.

## Capability Discovery

PulSeed grows more useful when it can discover a relevant capability without
making the user translate every need into a command. Two extension surfaces serve
that contract:

- schema assistance for turning natural-language observation dimensions into
  typed measurement structures
- discoverable plugin and integration registries for data sources, notifiers,
  adapters, and companion capabilities

The extension must still preserve explicit readiness and permission state.
Discoverable does not mean automatically trusted.

## Capability Reliability

A companion runtime should degrade predictably when an adapter, provider, or
agent path fails. Circuit breakers, backpressure, and concurrency caps are
reliability controls for the pocket of capabilities PulSeed can bring into a
goal. They keep failed integrations from polluting evidence and keep high-drive
goal sets from over-consuming local or provider capacity.

## Live Observation

Some goals depend on changing external signals. Streaming data sources such as
WebSocket, SSE, or Kafka feeds extend observation beyond pull-based
`DataSourceAdapter` checks. The design requirement is the same as the current
runtime: streaming evidence must be typed, bounded, attributable, and safe to
ignore or replay when the source becomes noisy.

## Reusable Goal Structures

Goal templates are reusable companion patterns, not magic workflows. A template
can propose dimensions, thresholds, and strategy hints for common goals such as
maintaining code health or tracking a business KPI. The user still owns the
goal, approval boundary, data sources, and irreversible decisions.
