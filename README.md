<div align="center">

<img src="assets/seedy.png" alt="Seedy - PulSeed mascot" width="120" />

# PulSeed

PulSeed is a lifelong personal agent that remembers your goals, watches the world with you, and keeps helping move your life forward.

[![Website](https://img.shields.io/badge/Website-pulseed.dev-blue?style=for-the-badge)](https://pulseed.dev)
[![npm](https://img.shields.io/npm/v/pulseed.svg?style=for-the-badge)](https://www.npmjs.com/package/pulseed)
[![Downloads](https://img.shields.io/npm/dm/pulseed.svg?style=for-the-badge)](https://www.npmjs.com/package/pulseed)
[![CI](https://img.shields.io/github/actions/workflow/status/my-name-is-yu/PulSeed/ci.yml?branch=main&style=for-the-badge&label=CI)](https://github.com/my-name-is-yu/PulSeed/actions/workflows/ci.yml)
[![Node.js 22/24](https://img.shields.io/badge/node-22%20%2F%2024-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![MIT License](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](LICENSE)

</div>

PulSeed is a lifelong personal agent for goals that take time.
Tell it what matters, and it remembers the goal, watches what changes,
delegates work to agents, verifies progress, and keeps moving your life forward.

Its current technical wedge is long-running goal orchestration, but that is not
the final category. PulSeed is being built toward a lifelong companion agent
with durable personal context, presence, proactive dialogue, and safe
delegation. See [Positioning](docs/positioning.md).

The primary entry point is `pulseed`. The normal flow is natural language, not a
menu of subcommands.

## Get Started

PulSeed supports Node.js 22 or 24.

Quick install (macOS / Linux):

```bash
curl -fsSL https://raw.githubusercontent.com/my-name-is-yu/PulSeed/main/scripts/install.sh | bash
```

Quick install (Windows / PowerShell):

```powershell
irm https://raw.githubusercontent.com/my-name-is-yu/PulSeed/main/scripts/install.ps1 | iex
```

Then start PulSeed:

```bash
pulseed
```

For pinned-tag installs, fallback npm installs, and installer flags, see [Getting Started](docs/getting-started.md).

Then describe the goal in natural language:

- `Increase test coverage to 90%.`
- `Show me the current progress.`
- `Keep this goal moving in the background.`

PulSeed will guide provider and adapter setup when needed.

## Links

- [Get Started](docs/getting-started.md)
- [Positioning](docs/positioning.md)
- [Docs Index](docs/index.md)
- [Runtime](docs/runtime.md)
- [Configuration](docs/configuration.md)
- [Status](docs/status.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)

## Why PulSeed?

- Lifelong personal-agent orchestration for goals that take time
- Honest goal negotiation when a target is not realistic as stated
- Bounded agent execution with verification around delegated work
- Verified playbook memory that turns successful runs into reusable planning hints
- Local persistent state under `~/.pulseed/`
- Multiple runtime surfaces: CLI, chat, TUI, daemon, and cron
- Support for OpenAI, Anthropic, Ollama, and adapter-based execution paths

## What It Does

- `DurableLoop` keeps a goal moving and decides whether to continue, refine,
  verify, or stop
- `AgentLoop` handles bounded tool-using work for task execution, chat, and
  selected runtime phases
- Centralized AgentLoop profiles keep task execution isolated by default,
  narrow chat permissions, and run `/review` through a dedicated read-only
  review posture
- Dream-backed playbooks can feed verified workflow hints into later task
  generation without auto-writing executable skills
- State, reports, schedules, and local memory live under `~/.pulseed/`
- Software-level approval and verification gates protect delegated work

## Common Surfaces

- `pulseed` for the primary interactive workflow
- `pulseed tui` for the terminal UI
- `pulseed start` and `pulseed stop` for daemon control
- `pulseed schedule ...` for schedule management
- Lower-level commands for scripting, diagnostics, and compatibility

## Achievements

PulSeed completed a 30-hour autonomous dogfood run on
[Kaggle Playground Series S6E4](https://www.kaggle.com/competitions/playground-series-s6e4).

| Area | Result |
| --- | --- |
| Long-running workflow | Ran continuously for about 30 hours, with operator intervention only for deadline-bound submissions. |
| Final Kaggle result | Finished with `0.97057` balanced accuracy, ranked `1,303 / 4,325` teams, approximately the top `30%`. |
| Local validation | Improved OOF balanced accuracy from early 0.45-level baselines to a 0.970+ candidate set. |
| Autonomous exploration | Generated, tested, and compared hypotheses across CatBoost variants, probability adjustment, class weighting, and post-OOF calibration. |
| Evidence preserved | Kept logs, metrics, OOF predictions, submission candidates, and follow-up engineering issues from the run; a redacted public evidence log is available at [pulseed-kaggle-s6e4-evidence-log](https://github.com/my-name-is-yu/pulseed-kaggle-s6e4-evidence-log). |

## Docs and Community

Start with the public doc map:

- [Getting Started](docs/getting-started.md)
- [Runtime](docs/runtime.md)
- [Mechanism](docs/mechanism.md)
- [Configuration](docs/configuration.md)
- [Architecture Map](docs/architecture-map.md)

For project participation:

- read [Contributing](CONTRIBUTING.md) before opening a pull request
- use [Issues](https://github.com/my-name-is-yu/PulSeed/issues) for bugs and
  feature proposals
- follow the [Code of Conduct](CODE_OF_CONDUCT.md)

## Safety Boundary

PulSeed uses approval gates and verification around delegated work. Native
`agent_loop` task execution can use isolated git worktrees, and supported CLI
adapters can be wrapped with a Docker terminal backend. These reduce blast
radius, but local backends and plugins still run with the user's privileges. See
[Security](SECURITY.md).

## License

MIT
