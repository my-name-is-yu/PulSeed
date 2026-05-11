# Guide

Use this section when you want to operate PulSeed after installation.

## Recommended Path

1. [Getting Started](index.md)
2. [Run an interactive session](#run-an-interactive-session)
3. [Create and run a goal](#create-and-run-a-goal)
4. [Use daemon mode](#use-daemon-mode)
5. [Configure providers and state](#configure-providers-and-state)
6. [Inspect status and diagnostics](#inspect-status-and-diagnostics)

Guide pages describe practical workflows and point to reference pages for exact
command lists or schema details.

## Run An Interactive Session

The default user-facing path is the interactive TUI:

```bash
pulseed
```

Use this when you want chat, approvals, progress, and runtime control in one
terminal surface. The TUI uses the same provider configuration described in
[Configuration](../operate/configuration.md). For slash-command groups, see
[Runtime](../operate/runtime.md#chat-and-tui).

## Create And Run A Goal

For scriptable operation, create a goal and run it explicitly:

```bash
pulseed goal add "Increase test coverage to 90%"
pulseed goal list
pulseed goal show <goal-id>
pulseed run --goal <goal-id>
```

Use `--workspace <path>` when the goal should operate against a specific
workspace, and `--max-iterations <n>` when you want a bounded run. See
[Runtime](../operate/runtime.md#goal-and-task-operation) and
[CLI Reference](../reference/cli.md#goals-and-tasks) for the full command
surface.

## Use Daemon Mode

Daemon mode hosts background goal work, gateway channels, schedules, approval
broadcast, runtime health, and recovery:

```bash
pulseed daemon start --goal <goal-id>
pulseed daemon status
pulseed daemon ping
pulseed daemon stop
```

Use `--resident` when the goal should keep resident policy. See
[Runtime](../operate/runtime.md#daemon) and
[Runtime State Reference](../reference/runtime-state.md) for operational state
paths.

## Schedule Work

PulSeed schedules can run preset or configured entries:

```bash
pulseed schedule list
pulseed schedule add --preset daily_brief
pulseed schedule history <id> --limit 10
```

Use [Schedule Reference](../reference/schedules.md) for layers, triggers,
presets, and the full schedule command set.

## Configure Gateway Or Telegram

Gateway setup configures messaging channels that forward typed envelopes into
PulSeed chat/runtime paths:

```bash
pulseed gateway setup
pulseed telegram setup
```

See [Runtime](../operate/runtime.md#gateway-channels) for current builtin channel names
and the boundary between gateway ingress and notification routing.

## Configure Providers And State

Run the setup wizard first:

```bash
pulseed setup
```

Provider configuration normally lives in `~/.pulseed/provider.json`, or under
the directory selected by `PULSEED_HOME`. Use [Configuration](../operate/configuration.md)
for provider defaults, model resolution, adapter selection, state paths, and
worktree policy.

## Inspect Status And Diagnostics

Use these commands when you need to inspect current state:

```bash
pulseed status --goal <goal-id>
pulseed report --goal <goal-id>
pulseed runtime sessions --active
pulseed runtime runs --active
pulseed doctor
```

Use [Status](../operate/status.md) for the current implementation summary, and use
[Package Scripts Reference](../reference/package-scripts.md) for repository
checks.
