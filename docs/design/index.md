# Design Documentation

This directory holds design documents: proposal material, active
implementation contracts, architecture rationale, and design history. It is
separate from the current operating path in [PulSeed Documentation](../index.md)
so readers can distinguish what exists today from what explains design intent.

Use current operating docs first:

1. [README](../../README.md)
2. [PulSeed Documentation](../index.md)
3. [Getting Started](../start/index.md)
4. [Runtime](../operate/runtime.md)
5. [Mechanism](../concepts/mechanism.md)
6. [Architecture Map](../architecture/architecture-map.md)
7. [Module Map](../architecture/module-map.md)

## Reading Model

Files under `docs/design/` may describe active contracts, current implementation
background, proposals, or historical rationale. Every design document has a
status banner. The exact implementation truth is still the current code and
current operating docs.

## Active Interaction Contracts

These are the most useful entry points when reading PulSeed as a public design
corpus.

Start with Core Loop, Autonomy And Presence, and Runtime And Control Plane when
you want the main system contract. Use the later sections only when you need a
specific subsystem: extension loading, planning, memory, goal modeling, or
personality.

### Core Loop

- [Observation](core/loop/observation.md)
- [Drive System](core/loop/drive-system.md)
- [Drive Scoring](core/loop/drive-scoring.md)
- [Gap Calculation](core/loop/gap-calculation.md)
- [Satisficing](core/loop/satisficing.md)
- [Stall Detection](core/loop/stall-detection.md)
- [State Vector](core/loop/state-vector.md)
- [Time Horizon](core/loop/time-horizon.md)
- [Wait Strategy](core/loop/wait-strategy.md)

### Autonomy And Presence

- [Companion Autonomy Spine](core/autonomy/companion-autonomy-spine.md)
- [Companion Autonomy Implementation Map](core/autonomy/companion-autonomy-implementation-map.md)
- [Relationship Memory And Surface](core/autonomy/relationship-memory-surface.md)
- [Core Companion Memory Projection](core/autonomy/core-companion-memory-projection.md)
- [Companion Gadget Planning](core/autonomy/companion-gadget-planning.md)
- [Attention Metabolism And Initiative](core/autonomy/attention-metabolism-initiative.md)
- [Dream Mode](core/autonomy/dream-mode.md)

### Tool Substrate

- [Tool System](core/tools/tool-system.md)
- [Write Tool Integration](core/tools/write-tool-integration.md)
- [Self-Knowledge](core/tools/self-knowledge.md)

### Runtime And Control Plane

- [Runtime Control Plane](infrastructure/runtime/runtime-control-plane.md)
- [Daemon Client Architecture](infrastructure/runtime/daemon-client-architecture.md)
- [Runtime Auto-Recovery](infrastructure/runtime/runtime-auto-recovery.md)
- [Runtime Auth, Browser Session, And Guardrail Control Model](infrastructure/runtime/runtime-auth-browser-guardrails.md)
- [Companion Capability Runtime](infrastructure/runtime/companion-capability-runtime.md)

### Platform Services

- [Database-First State Ownership](infrastructure/platform/database-first-state-ownership.md)
- [LLM Fault Tolerance](infrastructure/platform/llm-fault-tolerance.md)
- [Reporting](infrastructure/platform/reporting.md)
- [Token Optimization](infrastructure/platform/token-optimization.md)

### Extensions And Scheduling

- [Plugin Architecture](infrastructure/extensions/plugin-architecture.md)
- [Plugin Development Guide](infrastructure/extensions/plugin-development-guide.md)
- [Schedule Engine](infrastructure/extensions/schedule-engine.md)

### Execution And Interaction

- [Codex-Like User Interaction Contract](execution/interaction/codex-like-interaction-contract.md)
- [Conversational Approval](execution/interaction/conversational-approval.md)
- [Exact Protocol Grammar Boundaries](execution/interaction/exact-protocol-boundaries.md)
- [Gateway Progress Narration](execution/interaction/gateway-progress-narration.md)
- [Tend Command](execution/interaction/tend-command.md)

### Planning And Context

- [Task Lifecycle](execution/planning/task-lifecycle.md)
- [Portfolio Management](execution/planning/portfolio-management.md)
- [Multi-Agent Delegation](execution/planning/multi-agent-delegation.md)
- [Session And Context](execution/context/session-and-context.md)
- [Data Source](execution/context/data-source.md)

### Goal Model

- [Goal Tree](goal/goal-tree.md)
- [Goal Negotiation](goal/goal-negotiation.md)
- [Goal Refinement Pipeline](goal/goal-refinement-pipeline.md)
- [Execution Boundary](goal/execution-boundary.md)
- [Goal Ethics](goal/goal-ethics.md)

### Knowledge And Memory

- [Hierarchical Memory](knowledge/hierarchical-memory.md)
- [Knowledge Acquisition](knowledge/knowledge-acquisition.md)
- [Knowledge Transfer](knowledge/knowledge-transfer.md)
- [Learning Pipeline](knowledge/learning-pipeline.md)
- [Memory Lifecycle](knowledge/memory-lifecycle.md)
- [Soil System](knowledge/soil-system.md)
- [Hypothesis Verification](knowledge/hypothesis-verification.md)

### Personality And Brand

- [Character](personality/character.md)
- [Curiosity](personality/curiosity.md)
- [Trust And Safety](personality/trust-and-safety.md)
- [Brand](personality/brand.md)

## Archived Or Historical Design Notes

Some old notes are retained under [Design Archive](archive/index.md) when
they are useful for context but should not be read as current architecture.

## Organizing Rule

Prefer current operating docs before reading subsystem-specific design documents.
The design index is a pointer into design context, not a replacement for the
documentation map.
