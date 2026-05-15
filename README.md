<div align="center">

<img src="assets/seedy.png" alt="Seedy - PulSeed mascot" width="120" />

# PulSeed

Your Personal Agentic Friend

[![Website](https://img.shields.io/badge/Website-pulseed.dev-blue?style=for-the-badge)](https://pulseed.dev)
[![npm](https://img.shields.io/npm/v/pulseed.svg?style=for-the-badge)](https://www.npmjs.com/package/pulseed)
[![Downloads](https://img.shields.io/npm/dm/pulseed.svg?style=for-the-badge)](https://www.npmjs.com/package/pulseed)
[![CI](https://img.shields.io/github/actions/workflow/status/my-name-is-yu/PulSeed/ci.yml?branch=main&style=for-the-badge&label=CI)](https://github.com/my-name-is-yu/PulSeed/actions/workflows/ci.yml)
[![Node.js 22/24](https://img.shields.io/badge/node-22%20%2F%2024-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org/)
[![MIT License](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](LICENSE)

</div>

PulSeed pairs a local long-running goal runtime with a companion-software
design direction: remembering what matters, noticing when the situation
changes, and bringing the right tool, agent, or workflow into the moment when
help is needed.

The current implementation focuses on long-running goal orchestration. It stores
local state, runs a DurableLoop over goals, delegates bounded work through
AgentLoop or configured adapters, verifies progress from evidence, and exposes
the runtime through the CLI, TUI, daemon, schedules, chat, and gateway surfaces.
The docs separate runnable operating instructions from product and subsystem
design, so readers can distinguish what the package does today from the broader
companion-software contract PulSeed is designed around.

In plain terms, PulSeed helps you keep goal work, state, progress checks, and
agent/tool runs organized across time from your local machine.

## Is PulSeed For Me?

Try PulSeed today if you want to:

- keep a long-running goal and its evidence outside a single chat session
- run goal work from a local CLI/TUI with inspectable state under `~/.pulseed/`
- use daemon, schedule, gateway, plugin, memory, and diagnostic surfaces while
  keeping current behavior separate from product design

PulSeed is not yet:

- a turnkey personal-life automation product
- a medical, financial, legal, or business-decision advisor
- a complete sandbox for untrusted commands, plugins, provider tools, or local
  backends

Recommended first step: install PulSeed, run `pulseed`, complete provider setup,
and try one low-risk goal in a disposable workspace.

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
[Getting Started](./docs/start/index.md).

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
- [Getting Started](./docs/start/index.md)
- [Runtime](./docs/operate/runtime.md)
- [Configuration](./docs/operate/configuration.md)
- [Status](./docs/operate/status.md)
- [Architecture Map](./docs/architecture/architecture-map.md)
- [Module Map](./docs/architecture/module-map.md)

## How The Docs Are Organized

Start with the current operating docs when you want to use PulSeed today:

- [Getting Started](./docs/start/index.md)
- [Guide](./docs/start/guide.md)
- [Concepts](./docs/concepts/index.md)
- [Reference](docs/reference/index.md)
- [Architecture](./docs/architecture/index.md)

Product direction, companion scenarios, and design boundaries live under
[Product Design](./docs/product/index.md), with a code-backed/current-vs-design
boundary in the
[Product Completion Scenario Matrix](./docs/product/completion-matrix.md).
Design documents,
audits, and design history live under [Design Documentation](docs/design/index.md).

## Evidence

The current public evidence is implementation evidence, not an external
traction claim. PulSeed has been dogfooded on long-running work, including a
30-hour autonomous Kaggle Playground Series S6E4 run. A redacted evidence log is
available at
[pulseed-kaggle-s6e4-evidence-log](https://github.com/my-name-is-yu/pulseed-kaggle-s6e4-evidence-log).

The repository also includes repeatable verification paths for the implemented
foundation: `npm run check:docs`, `npm run test:dogfood`,
`npm run dogfood:agentloop:real`, `npm run check:database-first-legacy-stores`,
packaged-artifact checks, and CI lanes for unit, contract, golden-trace, replay,
smoke, and integration coverage. These show that the product contract is being
tested through code-backed goal/runtime behavior. They do not claim customer
adoption, revenue, or broad market pull yet.

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
