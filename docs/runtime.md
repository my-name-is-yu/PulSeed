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

Supported chat slash commands:

- Session: `/help`, `/clear`, `/sessions`, `/history [id|title]`, `/title <title>`, `/resume [id|title]`, `/cleanup [--dry-run]`, `/compact`, `/exit`
- Goals and tasks: `/status [goal-id]`, `/goals`, `/tasks [goal-id]`, `/task <task-id> [goal-id]`, `/track`, `/tend`
- Configuration: `/config`, `/model`, `/model <model> [effort]`, `/plugins`
- Usage: `/usage [session|goal <goal-id>|daemon <goal-id>|schedule [24h|7d|2w]]`

`/compact` summarizes older chat turns into the saved session summary and keeps the latest user and assistant turns available for continuation.
`/config` is read-only and masks secrets. `/model` mirrors Codex-style model selection: without arguments it shows the active model and available choices; `/model <model> [effort]` updates the OpenAI model and optional reasoning effort for subsequent chat turns.

Deferred command: `/retry` is intentionally not supported yet.

## Daemon operations

Daemon mode is the resident host for continuous operation.
It keeps the runtime alive for long-running goal work and recovery.

The normal user-facing path is to ask PulSeed to keep a goal moving in the background.
Scriptable daemon and cron subcommands remain lower-level controls.

Operator and debug status surfaces can show companion capability readiness,
admission, autonomy, and execution labels. These labels are diagnostic: normal
chat and GUI companion surfaces should show the next best safe action instead of
listing a capability catalog or raw policy state.

## Schedule Operations

PulSeed schedules are managed by the ScheduleEngine, which supports heartbeat,
probe, cron, and goal-trigger entries. The scriptable lifecycle commands are:

```bash
pulseed schedule list
pulseed schedule show <id>
pulseed schedule add --preset daily_brief
pulseed schedule edit <id> --name "Morning brief" --cron "0 9 * * *" --timezone Asia/Tokyo
pulseed schedule pause <id>
pulseed schedule resume <id>
pulseed schedule run <id>
pulseed schedule history <id> --limit 10
pulseed schedule remove <id>
```

Internal wait-resume projections are also stored in the ScheduleEngine, but they
are hidden from `pulseed schedule list` by default so operator views stay
focused on user-managed schedules. Use `pulseed schedule list --all` to inspect
those internal entries, and `pulseed schedule show <id>` to see the
`internal_projection` block for a projected wait-resume entry.

`run` executes an entry immediately and records it as manual history. When the
daemon is running, the request is accepted by the daemon and runs inside the
resident ScheduleEngine; otherwise the CLI falls back to a local validation run.
It does not resume a paused schedule unless `resume` is used separately.

Schedule history also records internal wait-resume activations. A projected wait
re-entry appears with `internal` history and `activation=wait_resume:<strategy>`
metadata so operators can trace which wait strategy caused the goal to resume.

## What runtime does not explain

This page does not restate the loop model, verification model, or completion model in full.
Those concepts live in [Mechanism](mechanism.md).

## Related reference

- [docs/index.md](index.md)
- [Architecture Map](architecture-map.md)
- [Module Map](module-map.md)
