# Status

Current status snapshot: 2026-05-11.

This page summarizes current behavior. For exact commands, use
[CLI Reference](reference/cli.md). For current package version and release
history, see [CHANGELOG](../CHANGELOG.md).

## Recommended Today

Use these first when you want the current, best-supported path:

- npm package `pulseed` with Node.js 22/24 support
- bare `pulseed` interactive TUI entry point
- `pulseed setup` provider configuration for OpenAI, Anthropic, and Ollama paths
- long-running goal operation through `DurableLoop`
- bounded tool-using work through `AgentLoop` when the selected provider/model
  and adapter support it
- local state under `~/.pulseed/`, or an isolated directory via `PULSEED_HOME`
- CLI inspection through `pulseed status`, `pulseed report`, `pulseed runtime`,
  `pulseed logs`, and `pulseed doctor`
- docs link checking through `npm run check:docs`

## Advanced Or Operator-Facing

These surfaces exist, but they are better treated as operator or integration
interfaces than as the first thing a new user should try:

- daemon and resident background operation
- schedule layers for heartbeat, probe, cron, and goal-trigger entries
- gateway channel configuration for Telegram, WhatsApp webhook, Signal bridge,
  and Discord bot paths
- notification routing
- plugin, skill, playbook, datasource, knowledge, memory, profile, usage, and
  runtime diagnostic commands
- non-destructive memory correction/governance commands

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
- design documents under `docs/design/`
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

## Not Current Operating Behavior

The following belong in roadmap or design documents until code-backed behavior is
present and documented:

- multi-year autonomous companion scenarios as user-ready workflows
- external sensor or business-system integrations that are not configured in
  current plugin/gateway paths
- plugin marketplace and curated registry UX
- autonomous capability acquisition beyond current approval and compatibility
  boundaries
