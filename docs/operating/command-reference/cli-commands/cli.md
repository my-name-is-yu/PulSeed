# CLI Reference

> Status: Current CLI reference. This page should track the CLI registry and help surface.

This page lists the current `pulseed` command surface. It is derived from
the CLI command registry and help text.

## Global

```bash
pulseed
pulseed --version
pulseed help
pulseed --yes run --goal <goal-id>
pulseed --dev status --goal <goal-id>
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
pulseed runtime proactive-calibration [--json]
pulseed runtime peer-initiative-capability [--json]
pulseed runtime proactive-feedback --intervention <id> --outcome <accepted|ignored|dismissed|corrected|overreach>
pulseed runtime proactive-feedback --intervention <id> --outcome overreach --overreach-indicator too_frequent --reason "Too frequent"
pulseed runtime capability explain <capability-id> [--json]
pulseed runtime graph explain <trace-id> [--json]
pulseed runtime event-log rebuild [--dry-run] [--trace <trace-id>] [--json]
pulseed runtime replay --trace <trace-id> [--json]
```

`proactive-feedback` also accepts `--follow-through-success` and `--json`.
Valid overreach indicators are `too_frequent`, `wrong_context`, `sensitive`, and
`unwanted_timing`.
`peer-initiative-capability` is a current-claim diagnostic: outbound peer
initiative delivery is Telegram-only until channel budgets, explicit opt-in, and
feedback calibration exist for other surfaces.
The event-log commands are operator/debug surfaces. They expose runtime event
IDs, RuntimeGraph lineage, idempotency keys, authority refs, and projection
rebuild evidence that normal chat/status surfaces intentionally redact.
`runtime capability explain` is also operator/debug-only. It prints the
`CapabilityDescriptor` for builtin tools, ToolExecutor-admitted actions,
stored plugin proposals, MCP tool mappings, runtime-control actions, and
synthetic gateway-channel sends. Normal surfaces must use redacted affordances
instead of exposing credential scopes, approval fingerprints, raw catalog
internals, or policy internals.
`runtime sessions --json` and `runtime runs --json` include a
`surface_projection` field that follows the shared
[Surface Projection Protocol](../operator-systems/surface-projection-protocol.md) contract for
status/report projection metadata.

## Schedules

```bash
pulseed schedule list [--all]
pulseed schedule show <id>
pulseed schedule add --preset daily_brief
pulseed schedule add --preset weekly_review --cron "0 9 * * 1"
pulseed schedule add --preset goal_probe --data-source-id <id> --probe-dimension <name>
pulseed schedule add --name api-health --type http --url https://example.com/health --interval 300
pulseed schedule add --name ssh-health --type tcp --host 127.0.0.1 --port 22 --threshold 3
pulseed schedule add --name free-space --type disk --path / --interval 3600
pulseed schedule add --name custom-check --type custom --command "npm run check:docs"
pulseed schedule edit <id>
pulseed schedule edit <id> --name "Daily brief" --cron "0 9 * * *"
pulseed schedule pause <id>
pulseed schedule resume <id>
pulseed schedule run <id> [--with-escalation]
pulseed schedule history <id> [--limit <n>]
pulseed schedule cost [--period <24h|7d|2w>]
pulseed schedule remove <id>
pulseed schedule presets
pulseed schedule suggestions list
pulseed schedule suggestions apply <suggestion-id>
pulseed schedule suggestions reject <suggestion-id> [reason]
pulseed schedule suggestions dismiss <suggestion-id> [reason]
```

`schedule add --preset goal_probe` requires `--data-source-id`. Optional
goal-probe flags include `--detector-mode <threshold|diff|presence>`,
`--threshold-value <number>`, `--baseline-window <n>`, `--llm-on-change`, and
`--llm-prompt-template <template>`.

## Gateway And Notifications

```bash
pulseed gateway setup
pulseed telegram setup
pulseed notify add slack --webhook-url <url>
pulseed notify add webhook --url <url>
pulseed notify add webhook --url <url> --header "Authorization: Bearer token"
pulseed notify add email --address <email> --smtp-host <host> [--smtp-port <port>]
pulseed notify list
pulseed notify remove <index>
pulseed notify test [index]
pulseed notify route "Send daily reports to Slack and urgent alerts to email"
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
pulseed memory correct <kind:id> --value "Prefer concise reports"
pulseed memory forget <kind:id> --reason "No longer true"
pulseed memory retract <kind:id> --reason "Added by mistake"
pulseed memory history <kind:id>
pulseed memory export [--consent-scope id] [--include-secret]
```

## Data, Knowledge, Profiles, And Diagnostics

```bash
pulseed datasource add file --path ./metrics.json
pulseed datasource add file_existence --path ./README.md
pulseed datasource add http_api --url https://example.com/metrics.json
pulseed datasource add database --connection-string postgresql://localhost:5432/analytics --query "SELECT count(*) FROM issues"
pulseed datasource add database --connection-string postgresql://localhost:5432/analytics --dimension open_issue_count --query "SELECT count(*) FROM issues WHERE state = 'open'"
pulseed datasource add postgres --connection-string postgresql://localhost:5432/app --query "SELECT 1"
pulseed datasource add github_issue --name repo-issues
pulseed datasource list
pulseed datasource remove <id>
pulseed datasource dedup
pulseed capability list
pulseed capability remove <name>
pulseed knowledge list
pulseed knowledge search <query>
pulseed knowledge stats
pulseed profile show [--scope <scope>] [--all] [--json]
pulseed profile update --kind preference --key report_style --value concise --scope user_facing_review
pulseed profile history <stable_key> [--json]
pulseed profile retract --key <stable_key> --reason "No longer true" [--json]
pulseed profile proposal list [--state <state>] [--json]
pulseed profile proposal inspect <proposal-id> [--json]
pulseed profile proposal approve <proposal-id> [--reason "Looks correct"] [--json]
pulseed profile proposal reject <proposal-id> --reason "Wrong context" [--json]
pulseed profile proposal apply <proposal-id> [--json]
pulseed usage session <session-id>
pulseed usage goal <goal-id>
pulseed usage daemon <goal-id>
pulseed usage schedule [--period <7d|24h|2w>]
pulseed doctor
pulseed logs
pulseed logs --follow
pulseed install --goal <goal-id>
pulseed uninstall
pulseed mcp-server
```

Profile scopes are `local_planning`, `resident_behavior`, `memory_retrieval`,
and `user_facing_review`. Profile kinds include `identity_fact`, `preference`,
`dislike`, `value`, `boundary`, `communication_style`,
`notification_preference`, `long_term_goal`, `life_context`, and
`intervention_policy`.

## Project Improvement Helpers

```bash
pulseed suggest "<context>"
pulseed improve [path]
```

These are lower-level project improvement helpers. They are not the normal
first-reader path.
