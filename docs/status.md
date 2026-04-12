# Implementation Status

Current repository snapshot as of 2026-04-12.

This document now tracks the current runtime shape and the codebase surfaces that are actively in use. Older stage-by-stage implementation history has been retained in `docs/archive/`.

## Current Baseline

- Runtime model: `CoreLoop` for long-lived control, `AgentLoop` for bounded execution
- Primary code split: `src/base/`, `src/orchestrator/`, `src/platform/`, `src/interface/`, `src/tools/`, `src/runtime/`
- Current implementation-facing design reference: [docs/design/current-baseline.md](design/current-baseline.md)

## What Exists Now

- Goal orchestration and tree handling under `src/orchestrator/goal/`
- Core loop control under `src/orchestrator/loop/`
- Task lifecycle, verification, sessions, and adapter layer under `src/orchestrator/execution/`
- Observation, drive, Soil, memory, runtime, and traits support under `src/platform/`
- CLI, chat, TUI, and MCP surfaces under `src/interface/`
- Built-in tool surfaces under `src/tools/`

## User-Facing Surfaces

- CLI entrypoint: `dist/interface/cli/cli-runner.js`
- Chat runtime: `src/interface/chat/`
- TUI runtime: `src/interface/tui/`
- Long-lived runtime and scheduling: `src/runtime/`

## Documentation Status

- Public docs in `docs/` describe the current runtime and usage model
- `docs/design/current-baseline.md` is the implementation-facing source of truth for runtime shape
- Some detailed design docs still include proposal or historical material; when they conflict with code, prefer code and update the docs
- Historical implementation progress is archived under `docs/archive/`

## Validation

Recommended validation for current changes:

```bash
npm run build
npm test
```

CI remains the authoritative integration check for pull requests.
