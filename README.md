<div align="center">

<img src="assets/seedy.png" alt="Seedy - PulSeed mascot" width="120" />

# PulSeed

PulSeed is a local-first personal agent runtime for goals that take time.

[![Website](https://img.shields.io/badge/Website-pulseed.dev-blue?style=for-the-badge)](https://pulseed.dev)
[![npm](https://img.shields.io/npm/v/pulseed.svg?style=for-the-badge)](https://www.npmjs.com/package/pulseed)
[![Downloads](https://img.shields.io/npm/dm/pulseed.svg?style=for-the-badge)](https://www.npmjs.com/package/pulseed)
[![CI](https://img.shields.io/github/actions/workflow/status/my-name-is-yu/PulSeed/ci.yml?branch=main&style=for-the-badge&label=CI)](https://github.com/my-name-is-yu/PulSeed/actions/workflows/ci.yml)
[![Node.js 22/24](https://img.shields.io/badge/node-22%20%2F%2024-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![MIT License](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](LICENSE)

</div>

PulSeed keeps goal work alive across sessions. It stores local state, runs a
DurableLoop over goals, delegates bounded work through AgentLoop or configured
adapters, verifies progress from evidence, and exposes the runtime through the
CLI, TUI, daemon, schedules, chat, and gateway surfaces.

The current implementation is a long-running goal orchestration runtime. The
larger product direction is a lifelong personal companion agent, but future
direction is documented separately from current behavior.

## Quick Start

PulSeed supports Node.js 22 or 24.

macOS / Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/my-name-is-yu/PulSeed/main/scripts/install.sh | bash
```

Windows / PowerShell:

```powershell
irm https://raw.githubusercontent.com/my-name-is-yu/PulSeed/main/scripts/install.ps1 | iex
```

Then launch PulSeed:

```bash
pulseed
```

The bare `pulseed` command opens the interactive TUI after provider setup. For
pinned versions, npm fallback installs, and first-run details, see
[Getting Started](docs/getting-started.md).

## What Exists Now

- `DurableLoop` controls long-running goal progress, continuation,
  verification, stall handling, and completion decisions.
- `AgentLoop` handles bounded tool-using work for tasks, chat turns, and selected
  runtime phases.
- Local state lives under `~/.pulseed/` by default and can be overridden with
  `PULSEED_HOME`.
- Runtime surfaces include CLI, TUI, daemon, schedules, chat, gateway channels,
  plugins, memory correction commands, and operational diagnostics.
- Provider configuration supports OpenAI, Anthropic, and Ollama paths with
  adapter-specific compatibility.
- Approval, worktree, verification, and policy gates reduce risk around
  delegated work, but local backends and plugins still run with the user's
  privileges.

## Common Commands

```bash
pulseed
pulseed --version
pulseed setup
pulseed goal add "Increase test coverage to 90%"
pulseed run --goal <goal-id>
pulseed status --goal <goal-id>
pulseed report --goal <goal-id>
pulseed daemon start --goal <goal-id>
pulseed schedule list
pulseed gateway setup
pulseed memory history <kind:id>
```

For the complete command surface, use `pulseed help` or see the docs:

- [Docs Map](docs/index.md)
- [Getting Started](docs/getting-started.md)
- [Runtime](docs/runtime.md)
- [Configuration](docs/configuration.md)
- [Status](docs/status.md)
- [Architecture Map](docs/architecture-map.md)
- [Module Map](docs/module-map.md)

## Public Vs Future Docs

Start with the public-current docs when you want to use PulSeed today:

- [Start](docs/start/index.md)
- [Guide](docs/guide/index.md)
- [Concepts](docs/concepts/index.md)
- [Reference](docs/reference/index.md)
- [Architecture](docs/architecture/index.md)

Product direction, north-star examples, and non-current plans live under
[Roadmap And Future Direction](docs/roadmap/index.md). Maintainer-facing design
notes and audits live under [Internal Documentation](docs/internal/index.md).

## Evidence

PulSeed has been dogfooded on long-running work, including a 30-hour autonomous
Kaggle Playground Series S6E4 run. A redacted evidence log is available at
[pulseed-kaggle-s6e4-evidence-log](https://github.com/my-name-is-yu/pulseed-kaggle-s6e4-evidence-log).

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. For
security issues, see [SECURITY.md](SECURITY.md).

## Safety Boundary

PulSeed has software-level approval and verification gates. Native `agent_loop`
task execution can use git worktree isolation, and supported CLI adapters can be
wrapped with a Docker terminal backend. These are not a complete OS sandbox:
local backends, shell commands, provider tools, and plugins may still act with
the user's privileges.

## License

MIT
