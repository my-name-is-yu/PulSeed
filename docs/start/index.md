# Getting Started

> Status: Current getting-started guide. This page describes the supported first-run path for the current repository and package.

This page is the shortest current path from install to a first PulSeed session.

For the complete docs map, see [PulSeed Documentation](../index.md).

## Requirements

- Node.js 22 or 24
- npm from the selected Node.js installation
- A local shell that can run the `pulseed` binary

PulSeed stores local runtime state under `~/.pulseed/` by default. Set
`PULSEED_HOME` when you need an isolated state directory for testing or
automation.

## Before You Run It

PulSeed is local-first, but it can still call model providers, execute local
commands through configured adapters, and load user-installed plugins. Make these
decisions before your first real goal:

- **Provider and API key**: `pulseed` or `pulseed setup` asks for provider
  configuration when none exists. OpenAI, Anthropic, and Ollama paths are
  supported, but live cloud providers require credentials.
- **Cost**: cloud model calls may incur provider charges. Use a low-risk test
  goal first and inspect usage with `pulseed usage goal <goal-id>` or
  `pulseed usage schedule --period 7d` where available.
- **Data flow**: prompts, goal text, file excerpts, and tool observations may be
  sent to the configured provider or adapter. Do not point PulSeed at private or
  regulated data until you understand the selected provider and adapter path.
- **Local state**: PulSeed keeps provider config, control databases, report and
  debug artifacts, schedules, chat data, plugins, skills, memory, and related
  files under `~/.pulseed/` by default. Durable runtime truth is DB-first; do
  not treat every feature directory as an authoritative JSON store.
- **Local permissions**: approval and verification gates reduce risk, but they
  are not an OS sandbox. Shell commands, local backends, provider tools, and
  plugins may still act with your user's privileges.
- **Isolation for testing**: use a temporary home for experiments:

```bash
export PULSEED_HOME="$(mktemp -d)"
pulseed
```

Remove that temporary directory when you are finished. Do not delete
`~/.pulseed/` unless you intentionally want to remove your real PulSeed state.

## Install

macOS / Linux:

```bash
curl -fsSL https://raw.githubusercontent.com/my-name-is-yu/PulSeed/main/scripts/install.sh | bash
```

Windows / PowerShell:

```powershell
irm https://raw.githubusercontent.com/my-name-is-yu/PulSeed/main/scripts/install.ps1 | iex
```

The macOS/Linux installer can bootstrap Node.js 24 through nvm when Node.js/npm
are missing or unsupported. The Windows installer can attempt a Node.js LTS
bootstrap through `winget`.

To pin a release tag:

```bash
curl -fsSL https://raw.githubusercontent.com/my-name-is-yu/PulSeed/refs/tags/<tag>/scripts/install.sh | bash
```

```powershell
irm https://raw.githubusercontent.com/my-name-is-yu/PulSeed/refs/tags/<tag>/scripts/install.ps1 | iex
```

Fallback npm install:

```bash
npm install -g pulseed
```

If global npm install fails with a permission error, use a user-local npm
prefix:

```bash
mkdir -p ~/.npm-global
npm config set prefix ~/.npm-global
export PATH="$HOME/.npm-global/bin:$PATH"
npm install -g pulseed
```

```powershell
$prefix = "$HOME\.npm-global"
npm config set prefix $prefix
$env:Path = "$prefix;$env:Path"
[Environment]::SetEnvironmentVariable("Path", "$prefix;" + [Environment]::GetEnvironmentVariable("Path", "User"), "User")
npm install -g pulseed
```

Installer options:

```bash
curl -fsSL https://raw.githubusercontent.com/my-name-is-yu/PulSeed/main/scripts/install.sh | bash -s -- --version x.y.z --dry-run
```

```powershell
$installer = irm https://raw.githubusercontent.com/my-name-is-yu/PulSeed/main/scripts/install.ps1
& ([ScriptBlock]::Create($installer)) -Version x.y.z -DryRun
```

## Launch PulSeed

Run:

```bash
pulseed
```

The bare command launches the interactive TUI. If provider setup is missing,
PulSeed guides setup first.

Check the installed version:

```bash
pulseed --version
```

Run the setup wizard directly when you want a scriptable first step:

```bash
pulseed setup
```

## Create Or Run Goal Work

The primary first-run path is interactive: launch `pulseed`, then describe what
you want to work on.

Scriptable examples:

```bash
pulseed goal add "Increase test coverage to 90%"
pulseed goal list
pulseed run --goal <goal-id>
pulseed status --goal <goal-id>
pulseed report --goal <goal-id>
```

Use daemon mode when you want resident background operation:

```bash
pulseed daemon start --goal <goal-id>
pulseed daemon status
pulseed daemon stop
```

## Where State Lives

PulSeed uses `~/.pulseed/` as the local state root. Durable runtime truth is
owned by typed SQLite/Soil/control DB stores; feature directories may contain
configuration, user-authored content, reports, logs, projections, workspace
artifacts, or legacy migration inputs.

Common state paths:

- `~/.pulseed/provider.json`
- `~/.pulseed/goals/`
- `~/.pulseed/tasks/`
- `~/.pulseed/reports/`
- `~/.pulseed/runtime/`
- `~/.pulseed/schedule/`
- `~/.pulseed/chat/`
- `~/.pulseed/plugins/`
- `~/.pulseed/skills/`

## Next

- [Guide](guide.md)
- [Runtime](../operate/runtime.md)
- [Configuration](../operate/configuration.md)
- [Concepts](../concepts/index.md)
- [Reference](../reference/index.md)
