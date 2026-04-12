# Current Design Baseline

Implementation-facing baseline for the current PulSeed runtime.

Use this document as the starting point when changing code. Public docs explain the system at a higher level; subsystem design docs often include proposals, alternatives, or historical notes. This file is the shortest path to "what shape the code is in now."

## 1. Documentation Boundary

- Public docs in `docs/` explain current behavior for users and contributors.
- This file explains the current implementation baseline for engineers.
- Detailed files in `docs/design/` should be read as subsystem notes. Some are current, some are mixed current-plus-proposal, and some are future design only.

If a design note conflicts with code, prefer the code and update the design note.

## 2. Runtime Shape

PulSeed currently has two loops:

1. `CoreLoop`
   Long-lived control loop for goal progress, prioritization, stall handling, and re-planning.
2. `AgentLoop`
   Bounded execution loop where the model chooses tools, reads tool results, and decides the next action until it can produce a final answer or termination signal.

The intended relationship is:

- `CoreLoop` decides what kind of work is needed next.
- `CoreLoop` may execute deterministic phases directly.
- `CoreLoop` may also invoke bounded agentic phases that behave like `AgentLoop`.
- Chat/TUI/Telegram style task execution is driven by `AgentLoop`.

This is the baseline to preserve when implementing further core-loop integration.

## 3. Current Execution Boundary

The current runtime boundary is:

- PulSeed can directly read and inspect through tools.
- PulSeed can directly query memory and Soil.
- Bounded `AgentLoop` runs are used for short-to-medium execution.
- Long-lived autonomous control remains in `CoreLoop`.

Read-only and query-style operations live well inside PulSeed. Mutations, multi-step execution, and user-facing task completion flow through `AgentLoop`, task lifecycle orchestration, or adapters depending on the surface.

## 4. Current Code Map

### Foundation

- `src/base/`
  Shared types, LLM client foundation, state management, config, utilities.

### Orchestration

- `src/orchestrator/loop/`
  Core loop control and iteration helpers.
- `src/orchestrator/execution/`
  Task lifecycle, adapter layer, session management, parallel execution, verification.
- `src/orchestrator/goal/`
  Goal negotiation, refinement, goal tree management, tree loop orchestration.
- `src/orchestrator/strategy/`
  Strategy and portfolio management.
- `src/orchestrator/knowledge/`
  Knowledge management and transfer orchestration.

### Platform services

- `src/platform/observation/`
  Observation engine and observation-related helpers.
- `src/platform/soil/`
  Soil generation, publishing, and retrieval support.
- `src/platform/drive/`
  Gap, drive, stall, and satisficing primitives.
- `src/platform/runtime/`, `src/runtime/`
  Daemon, queue, schedule, gateway, and process runtime support.

### Interfaces

- `src/interface/chat/`
  Chat runner, tend command, chat verification, self-knowledge tools.
- `src/interface/cli/`
  CLI entrypoints and commands.
- `src/interface/tui/`
  TUI application and chat surface.

### Tools

- `src/tools/`
  Built-in tools used by bounded execution loops.
- Important families:
  - `src/tools/query/` for state, history, Soil, and knowledge queries
  - `src/tools/fs/` for file inspection and controlled edits
  - `src/tools/system/` for shell, sleep, test, and process tools
  - `src/tools/mutation/` and `src/tools/schedule/` for controlled state changes

## 5. Soil in the Current Baseline

Soil is part of the current baseline, not an optional future idea.

- Soil storage and publishing live under `src/platform/soil/`.
- Tool access is exposed through `src/tools/query/SoilQueryTool/` and related execution tools.
- The design direction is that both `AgentLoop` and bounded core-loop phases can use Soil as a first-class context source.

When making loop changes, preserve this assumption.

## 6. Current Entry Points

- CLI runner: `src/interface/cli/cli-runner.ts`
- Chat command: `src/interface/cli/commands/chat.ts`
- Chat runtime: `src/interface/chat/chat-runner.ts`
- TUI chat: `src/interface/tui/chat.tsx`
- Core loop implementation: `src/orchestrator/loop/`

## 7. How To Read `docs/design`

Read in this order:

1. This file
2. `docs/architecture-map.md`
3. `docs/runtime.md`
4. `docs/module-map.md`
5. Subsystem design notes that match the area you are changing

Recommended subsystem notes for current runtime work:

- `docs/design/execution/task-lifecycle.md`
- `docs/design/execution/chat-mode.md`
- `docs/design/goal/goal-tree.md`
- `docs/design/knowledge/soil-system.md`
- `docs/design/infrastructure/schedule-engine.md`
- `docs/design/core/tool-system.md`

Treat the following categories carefully:

- Comparative or inspiration docs: useful for rationale, not source of truth
- Large future architecture proposals: useful for direction, not current behavior
- Historical documents that still mention old paths or old single-loop framing

## 8. Change Rule

When implementation changes the runtime shape, update this file first or in the same change.
