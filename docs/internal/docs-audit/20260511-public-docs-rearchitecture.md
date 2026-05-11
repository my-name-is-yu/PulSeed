# Public Docs Rearchitecture Audit - 2026-05-11

This note records the audit basis for the docs rearchitecture PR. It is a
maintainer-facing artifact, not the public reader path.

## Evidence Priority

The rearchitecture treats implementation and executable project metadata as the
source of truth:

1. current source files under `src/`
2. current package metadata and scripts in `package.json`
3. current tracked docs and installer scripts
4. release history in `CHANGELOG.md`
5. external documentation information-architecture references

When docs conflict with code, the docs change. When a claim is plausible but not
clearly implemented, it moves out of public-current docs and into future,
roadmap, design, or archive material.

## Current Public-Docs Problems

- README and `docs/index.md` mix first-run guidance, product positioning,
  current operations, future direction, status snapshots, and internal design.
- `docs/vision.md` and `docs/usecase.md` describe north-star scenarios close to
  public-current docs and can be read as present-tense capability.
- `docs/status.md` is dated `2026-04-12`, while the current release history is
  at `0.6.5` from `2026-05-07`.
- `docs/design/**` mixes active contracts, proposals, historical notes, future
  plans, and gap audits behind one global warning.
- Public reference coverage is missing implemented surfaces such as `memory`,
  `usage`, `playbook`, `skills`, `runtime postmortem`, `runtime proactive-*`,
  `gateway setup`, `telegram setup`, and `daemon ping`.
- `docs/configuration.md` calls `agent_loop` the recommended default without
  separating recommendation from the code default config of OpenAI,
  `gpt-5.4-mini`, and `openai_codex_cli`.

## Current Implemented Surfaces To Reflect

- Package: npm `pulseed`, version `0.6.5`, ESM, `pulseed` binary, Node
  `>=22 <23 || >=24 <25`.
- Default CLI: bare `pulseed` launches the TUI after provider setup. Help and
  version are stateless.
- CLI registry: `run`, `goal`, `status`, `report`, `approval`, `runtime`,
  `log`, `start`, `daemon`, `stop`, `cron`, `schedule`, `skills`, `datasource`,
  `capability`, `plugin`, `cleanup`, `provider`, `config`, `suggest`,
  `improve`, `setup`, `knowledge`, `memory`, `profile`, `task`, `mcp-server`,
  `doctor`, `logs`, `install`, `uninstall`, `notify`, `gateway`, `telegram`,
  `playbook`, `usage`, and `tui`.
- Provider/config: code defaults to OpenAI, `gpt-5.4-mini`, and
  `openai_codex_cli`; setup can recommend `agent_loop`. Environment resolution
  includes provider, adapter, model, base URL, light model, and reasoning-effort
  overrides.
- Runtime: daemon, runtime session/run registry, evidence ledger, postmortem,
  schedules, gateway startup, approval broadcast, and command-envelope hook.
- Gateway: core builtin channels are `telegram-bot`, `whatsapp-webhook`,
  `signal-bridge`, and `discord-bot`; Slack is an adapter/notifier surface.
- Schedule: layers are `heartbeat`, `probe`, `cron`, and `goal_trigger`;
  triggers are `cron` and `interval`; presets include `daily_brief`,
  `weekly_review`, `dream_consolidation`, `soil_publish`, and `goal_probe`.
- Memory: `correct`, `forget`, `retract`, `history`, and `export` are
  auditable operations; destructive deletion is rejected by this command path.
- Plugins: native manifests support `plugin.yaml` and `plugin.json`; foreign
  plugin imports are compatibility/quarantine evidence until reviewed.

## Target Information Architecture

- Public first-read: README, docs map, install, first run, and next steps.
- Getting started and installation: command-focused setup.
- User guide / operating guide: run goals, inspect status, use daemon/schedule,
  and use chat/TUI/gateway without memorizing all lower-level commands.
- Concepts / explanation: DurableLoop, AgentLoop, tools, Soil, verification,
  schedules, companion capability projection, and safety boundaries.
- Reference: configuration, CLI, runtime, schedules, plugins, memory, package
  scripts, and status.
- Architecture overview: current source layout and stable module map.
- Internal design notes: active contracts and implementation notes.
- Roadmap / future: product direction and north-star scenarios.
- Archive: stale, historical, issue-order, and proposal material.
- Contributor docs: contribution workflow and docs update requirements.

## External References Considered

- Diataxis: split documentation by reader need: tutorial, how-to, reference,
  and explanation.
- Django: give first-time readers a clear first-steps path, then explain how
  the larger documentation set is organized.
- FastAPI: keep tutorial/user guide, advanced guide, deployment, recipes, and
  reference navigable as separate reader journeys.
- Kubernetes: use direct present-tense guidance and avoid current docs that will
  soon become stale.
- Astro: keep main docs aligned with current behavior and move older/future
  behavior into explicit upgrade, historical, or future pages.

## Planned Commits

1. `docs: audit current docs information architecture`
2. `docs: add public documentation structure`
3. `docs: rewrite README and first-reader path`
4. `docs: align public guides and references with current runtime`
5. `docs: separate internal design and future material`
6. `docs: tighten docs checks and polish links`
