# Runtime

This page describes the current runtime surfaces. For exact command
syntax, see [CLI Reference](reference/cli.md).

## Entry Points

PulSeed installs the `pulseed` binary.

```bash
pulseed
```

The bare command launches the interactive TUI after provider setup. It is the
default user-facing entry point.

Stateless helpers:

```bash
pulseed --version
pulseed help
pulseed setup
```

## Runtime Surfaces

PulSeed currently exposes these surfaces:

- CLI and scriptable subcommands
- interactive TUI
- chat runner and slash commands
- daemon and runtime registry
- schedules and cron entries
- gateway channels
- plugins, skills, memory, and diagnostics

They share local state under `~/.pulseed/` unless `PULSEED_HOME` is set.

## Goal And Task Operation

Common scriptable goal flow:

```bash
pulseed goal add "Increase test coverage to 90%"
pulseed goal list
pulseed goal show <goal-id>
pulseed run --goal <goal-id>
pulseed status --goal <goal-id>
pulseed report --goal <goal-id>
pulseed task list --goal <goal-id>
```

`pulseed run --goal <id>` executes DurableLoop for one goal. Use
`--max-iterations <n>` for a bounded run or `--resident` for resident policy.
Use `--workspace <path>` when the goal should operate against a specific
workspace.

## Chat And TUI

The TUI exposes chat, progress, approvals, and runtime control in one terminal
surface. Chat turns are handled by `ChatRunner` and can use AgentLoop when the
provider/adapter supports the current route.

Supported slash-command groups:

- Session: `/help`, `/clear`, `/sessions`, `/history [id|title]`,
  `/title <title>`, `/resume [id|title]`, `/cleanup [--dry-run]`, `/compact`,
  `/context`, `/exit`
- Goals and tasks: `/status [goal-id] [--details]`, `/goals [--details]`,
  `/tasks [goal-id]`, `/task <task-id> [goal-id]`, `/track`, `/tend`
- Configuration: `/config`, `/model`, `/model <model> [effort]`,
  `/permissions`, `/plugins`
- Usage: `/usage [session|goal <goal-id>|daemon <goal-id>|schedule [24h|7d|2w]]`
- Review/session management: `/review`, `/fork [title]`, `/undo`

`/retry` is intentionally not supported yet because PulSeed does not have a
safe replay contract for the previous turn.

## Daemon

Daemon mode is the resident host for background goal work, gateway channels,
schedules, approval broadcast, runtime health, and recovery.

Common commands:

```bash
pulseed daemon start --goal <goal-id>
pulseed daemon start --goal <goal-id> --resident
pulseed daemon status
pulseed daemon ping
pulseed daemon restart
pulseed daemon stop
```

Top-level aliases are also available:

```bash
pulseed start --goal <goal-id>
pulseed stop
```

The daemon event server defaults to port `41700`. Configuration includes check
intervals, crash recovery, max concurrent goals, run policy, adaptive sleep, log
rotation, runtime root, and workspace root.

## Runtime Diagnostics

Runtime diagnostics expose sessions, background runs, evidence, budgets, and
operator-facing state.

```bash
pulseed runtime sessions [--json] [--active]
pulseed runtime runs [--json] [--active] [--attention]
pulseed runtime session <id> [--json]
pulseed runtime run <id> [--json]
pulseed runtime evidence <goal-id|run-id> [--json]
pulseed runtime postmortem <goal-id|run-id> [--json]
pulseed runtime dream-review <run-id> [--json]
pulseed runtime budgets [--json]
pulseed runtime budget <id> [--json]
pulseed runtime experiment-queues [--json]
pulseed runtime experiment-queue <id> [--json]
pulseed runtime bindings [--json]
pulseed runtime proactive-quality [--json]
pulseed runtime proactive-feedback ...
```

These are operator and debugging surfaces. They may expose raw IDs and
diagnostic labels that normal user-facing chat should hide by default.

## Schedules

PulSeed schedules are managed by the ScheduleEngine. Current layers are
`heartbeat`, `probe`, `cron`, and `goal_trigger`; triggers are `cron` or
`interval`.

```bash
pulseed schedule list
pulseed schedule list --all
pulseed schedule show <id>
pulseed schedule add --preset daily_brief
pulseed schedule edit <id>
pulseed schedule pause <id>
pulseed schedule resume <id>
pulseed schedule run <id>
pulseed schedule history <id> --limit 10
pulseed schedule cost --period 7d
pulseed schedule remove <id>
pulseed schedule presets
pulseed schedule suggestions list
```

Implemented presets include `daily_brief`, `weekly_review`,
`dream_consolidation`, `soil_publish`, and `goal_probe`.

Internal wait-resume projections are hidden from `pulseed schedule list` by
default. Use `--all` when you need to inspect internal entries.

## Gateway Channels

Gateway setup configures messaging channels that forward typed envelopes into
PulSeed chat/runtime paths.

```bash
pulseed gateway setup
pulseed telegram setup
```

Core builtin gateway channel names are:

- `telegram-bot`
- `whatsapp-webhook`
- `signal-bridge`
- `discord-bot`

Slack exists as a gateway adapter/notifier surface, but it is not one of the
core builtin gateway channel names.

## Plugins, Skills, Playbooks, And Memory

Current scriptable surfaces include:

```bash
pulseed plugin list
pulseed plugin install <path|package>
pulseed plugin search <keyword>
pulseed skills list
pulseed playbook list
pulseed memory correct <kind:id> --value "..."
pulseed memory forget <kind:id> --reason "..."
pulseed memory retract <kind:id> --reason "..."
pulseed memory history <kind:id>
pulseed memory export
```

Foreign plugin imports are compatibility evidence until reviewed. They are not
directly runtime-loadable just because a manifest was imported.

## What This Page Does Not Claim

This page describes the current local runtime. It does not claim that every
future companion-agent scenario, marketplace flow, external sensor workflow, or
multi-year autonomous intervention path is implemented. Those belong in
[Roadmap And Future Direction](roadmap/index.md) or design-history documents
until the current code supports them.
