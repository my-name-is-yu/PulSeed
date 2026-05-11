# CLI Reference

This page lists the current `pulseed` command surface. It is derived from
the CLI command registry and help text.

## Global

```bash
pulseed
pulseed --version
pulseed help
pulseed --yes ...
pulseed --dev ...
```

Bare `pulseed` launches the TUI. `--yes` / `-y` auto-approves supported prompts
for commands that accept it. `--dev` enables development mode for the current
process.

## Setup And Configuration

```bash
pulseed setup
pulseed provider show
pulseed provider set --llm <provider> --adapter <adapter>
pulseed config show
pulseed config set <key> <value>
pulseed config get <key>
pulseed config character --show
```

## Goals And Tasks

```bash
pulseed goal add "Goal description"
pulseed goal add --title "tsc zero" --dim "tsc_error_count:min:0"
pulseed goal add "Goal description" --no-refine
pulseed goal list [--archived] [--details]
pulseed goal show <goal-id>
pulseed goal archive <goal-id>
pulseed goal remove <goal-id>
pulseed goal reset <goal-id>
pulseed task list --goal <goal-id>
pulseed task show <task-id> --goal <goal-id>
```

## Run And Inspect

```bash
pulseed run --goal <goal-id>
pulseed run --goal <goal-id> --max-iterations <n>
pulseed run --goal <goal-id> --resident
pulseed run --goal <goal-id> --workspace <path>
pulseed status --goal <goal-id> [--details]
pulseed report --goal <goal-id>
pulseed log --goal <goal-id>
pulseed approval list [--resolved]
```

## Daemon

```bash
pulseed start --goal <goal-id>
pulseed stop
pulseed daemon start --goal <goal-id>
pulseed daemon start --goal <goal-id> --resident
pulseed daemon stop
pulseed daemon restart
pulseed daemon status
pulseed daemon ping
pulseed cron --goal <goal-id>
```

## Runtime Diagnostics

```bash
pulseed runtime bindings [--json]
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
pulseed runtime proactive-quality [--json]
pulseed runtime proactive-feedback ...
```

## Schedules

```bash
pulseed schedule list [--all]
pulseed schedule show <id>
pulseed schedule add ...
pulseed schedule edit <id>
pulseed schedule pause <id>
pulseed schedule resume <id>
pulseed schedule run <id>
pulseed schedule history <id> [--limit <n>]
pulseed schedule cost [--period <24h|7d|2w>]
pulseed schedule remove <id>
pulseed schedule presets
pulseed schedule suggestions <list|apply|reject|dismiss>
```

## Gateway And Notifications

```bash
pulseed gateway setup
pulseed telegram setup
pulseed notify add slack --webhook-url <url>
pulseed notify add webhook --url <url>
pulseed notify list
pulseed notify remove <index>
pulseed notify test ...
pulseed notify route ...
```

## Plugins, Skills, Playbooks, And Memory

```bash
pulseed plugin list
pulseed plugin install <path|package>
pulseed plugin update <name>
pulseed plugin search <keyword>
pulseed plugin remove <name>
pulseed skills list
pulseed skills search <query>
pulseed skills show <id>
pulseed skills install <path>
pulseed playbook list
pulseed playbook show <id>
pulseed playbook promote <id>
pulseed playbook demote <id>
pulseed playbook disable <id>
pulseed playbook delete <id>
pulseed memory correct <kind:id> --value "..."
pulseed memory forget <kind:id> --reason "..."
pulseed memory retract <kind:id> --reason "..."
pulseed memory history <kind:id>
pulseed memory export [--consent-scope id] [--include-secret]
```

## Data, Knowledge, Profiles, And Diagnostics

```bash
pulseed datasource add <file|http_api|database> ...
pulseed datasource list
pulseed datasource remove <id>
pulseed datasource dedup
pulseed capability list
pulseed capability remove <name>
pulseed knowledge list
pulseed knowledge search <query>
pulseed knowledge stats
pulseed profile ...
pulseed usage <scope>
pulseed doctor
pulseed logs
pulseed logs --follow
pulseed install --goal <goal-id>
pulseed uninstall
pulseed mcp-server
```

## Project Improvement Helpers

```bash
pulseed suggest "<context>"
pulseed improve [path]
```

These are lower-level project improvement helpers. They are not the normal
first-reader path.
