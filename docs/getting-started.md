# Getting Started

This page is the shortest current path from install to a first PulSeed session.

For the complete docs map, see [PulSeed Documentation](index.md).

## Requirements

- Node.js 22 or 24
- npm from the selected Node.js installation
- A local shell that can run the `pulseed` binary

PulSeed stores local runtime state under `~/.pulseed/` by default. Set
`PULSEED_HOME` when you need an isolated state directory for testing or
automation.

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

PulSeed writes local state under `~/.pulseed/`, including provider config,
goals, tasks, runtime state, reports, schedules, chat sessions, skills, plugins,
memory, and Soil projections.

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
- [Runtime](runtime.md)
- [Configuration](configuration.md)
- [Concepts](concepts.md)
- [Reference](reference/index.md)
