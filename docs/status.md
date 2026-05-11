# Status

Current public status snapshot: 2026-05-11.

This page summarizes current public behavior. For exact commands, use
[CLI Reference](reference/cli.md). For current package version and release
history, see [CHANGELOG](../CHANGELOG.md).

## In Active Use

- npm package `pulseed` with Node.js 22/24 support
- bare `pulseed` interactive TUI entry point
- long-running `DurableLoop` control
- bounded `AgentLoop` execution
- provider setup for OpenAI, Anthropic, and Ollama paths
- CLI, TUI, chat, daemon, schedule, gateway, plugin, skill, memory, and runtime
  diagnostic surfaces
- local state under `~/.pulseed/`
- schedule layers for heartbeat, probe, cron, and goal-trigger entries
- gateway channel configuration for Telegram, WhatsApp webhook, Signal bridge,
  and Discord bot paths
- non-destructive memory correction/governance commands
- docs link checking through `npm run check:docs`

## Supported Direction

- Use `pulseed` for the normal interactive entry point.
- Use scriptable commands for automation, diagnostics, and reproducibility.
- Treat `agent_loop` as the native bounded tool-use path when the selected
  provider/model supports it.
- Treat code, package scripts, runtime schemas, and tests as the source of truth
  when docs disagree.

## Still Evolving

- provider/model recommendations
- native AgentLoop quality, policy, and tool budgets
- gateway channel breadth and setup ergonomics
- schedule suggestions and proactive behavior
- companion capability projection and autonomy policy
- design notes under `docs/internal/`
- future product direction under `docs/roadmap/`

## Safety Boundary

PulSeed has approval and verification gates. Native `agent_loop` task execution
can use git worktree isolation, and supported CLI adapters can be wrapped with a
Docker terminal backend.

These boundaries are configurable and do not cover every execution path. Local
backends, shell commands, provider tools, and plugins can still run with the
user's privileges. Use Docker, a containerized PulSeed process, or a VM for
high-risk or untrusted goals.

## Capability Projection

Companion capability status is derived from readiness snapshots and explicit
admission/autonomy decisions when they match the same operation scope. A
configured plugin, imported foreign plugin, or legacy capability record is
discovery evidence, not proof that the operation is safe to execute or initiate.

Normal user-facing surfaces should show the next safe action. Operator and debug
surfaces may show raw readiness, admission, autonomy, warning, and evidence
details.

## Not Public-Current

The following belong in roadmap or internal docs until code-backed behavior is
present and documented:

- multi-year autonomous companion scenarios as user-ready workflows
- external sensor or business-system integrations that are not configured in
  current plugin/gateway paths
- plugin marketplace and curated registry UX
- autonomous capability acquisition beyond current approval and compatibility
  boundaries
