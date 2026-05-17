# Configuration

> Status: Current configuration guide. This page describes supported configuration keys, setup paths, and local-state boundaries.

This page reflects the current configuration surface.

## First-Run Path

For most users:

```bash
pulseed
```

or:

```bash
pulseed setup
```

The setup wizard writes provider configuration to `~/.pulseed/provider.json`
unless `PULSEED_HOME` points to another state directory.

## Code Defaults Vs Setup Recommendations

The provider-config code default is:

- provider: `openai`
- model: `gpt-5.4-mini`
- adapter: `openai_codex_cli`

The interactive setup flow may recommend `agent_loop` for providers and models
that support native bounded tool use. Treat `agent_loop` as the preferred native
runtime path for many PulSeed workflows, not as the hard-coded default in
`provider.json`.

## Provider Config File

Typical `~/.pulseed/provider.json` shape:

```json
{
  "provider": "openai",
  "model": "gpt-5.5",
  "reasoning_effort": "low",
  "adapter": "agent_loop",
  "api_key": "sk-...",
  "agent_loop": {
    "security": {
      "sandbox_mode": "workspace_write",
      "approval_policy": "on_request",
      "network_access": false,
      "trust_project_instructions": true
    },
    "worktree": {
      "enabled": true,
      "base_dir": "~/.pulseed/worktrees",
      "keep_for_debug": false,
      "cleanup_policy": "on_success"
    }
  }
}
```

Important fields:

- `provider`: `openai`, `anthropic`, or `ollama`
- `model`: provider-specific model name
- `light_model`: optional lighter model for routine work
- `reasoning_effort`: OpenAI effort `none`, `minimal`, `low`, `medium`,
  `high`, or `xhigh`
- `adapter`: `agent_loop`, `openai_codex_cli`, `openai_api`,
  `claude_code_cli`, or `claude_api`
- `api_key`: provider key when required
- `base_url`: optional OpenAI-compatible or Ollama endpoint override
- `codex_cli_path`: optional Codex CLI path for `openai_codex_cli`
- `terminal_backend`: optional local/Docker backend for supported CLI adapters
- `agent_loop`: native AgentLoop security and worktree policy

## Environment Overrides

Environment variable behavior is intentionally split by field:

- `PULSEED_PROVIDER`, `PULSEED_LLM_PROVIDER`, `PULSEED_ADAPTER`, and
  `PULSEED_DEFAULT_ADAPTER` are process-environment overrides for the provider
  and adapter selected in `provider.json`.
- `provider.json` wins for `model` when it has an explicit model. `PULSEED_MODEL`
  and provider-specific model variables are fallbacks only when `provider.json`
  does not specify `model`.
- The provider `.env` file is not a general provider/model/adapter override
  file. It is used by selected downstream fields such as API keys, base URLs,
  light model, and reasoning effort.

| Variable | Meaning |
| --- | --- |
| `PULSEED_HOME` | Override the local state directory, default `~/.pulseed` |
| `PULSEED_WORKSPACE_ROOT` | Override the PulSeed-managed workspace root |
| `PULSEED_PROVIDER` | Process environment provider override: `openai`, `anthropic`, `ollama`, or compatibility alias `codex` |
| `PULSEED_LLM_PROVIDER` | Process environment provider override alias |
| `PULSEED_ADAPTER` | Process environment adapter override |
| `PULSEED_DEFAULT_ADAPTER` | Process environment adapter override alias |
| `PULSEED_MODEL` | Model fallback when file model is absent |
| `OPENAI_MODEL` | OpenAI model fallback when file model is absent |
| `ANTHROPIC_MODEL` | Anthropic model fallback when file model is absent |
| `OLLAMA_MODEL` | Ollama model fallback when file model is absent |
| `OPENAI_API_KEY` | OpenAI key |
| `ANTHROPIC_API_KEY` | Anthropic key |
| `OPENAI_BASE_URL` | Optional OpenAI-compatible endpoint |
| `OLLAMA_BASE_URL` | Optional Ollama endpoint |
| `PULSEED_LIGHT_MODEL` | Optional lighter model override |
| `PULSEED_REASONING_EFFORT` | OpenAI reasoning effort override |
| `OPENAI_REASONING_EFFORT` | OpenAI reasoning effort alias |

Provider, adapter, and model resolution reads process environment variables.
The provider `.env` file participates in API key, base URL, light model, and
reasoning-effort resolution.

## Supported Models And Adapters

Known model compatibility is maintained in the model registry. Current
providers:

- OpenAI models can use `openai_codex_cli`, `openai_api`, or `agent_loop`.
- Anthropic models can use `claude_code_cli`, `claude_api`, or `agent_loop`.
- Ollama uses dynamic local models and can use `agent_loop` or OpenAI-compatible
  API paths where configured.

Unknown/custom models are allowed, but validation may warn when a model and
adapter combination is incompatible.

## Terminal Backend

Supported CLI execution adapters can run through a local process backend or a
Docker backend.

```json
{
  "adapter": "openai_codex_cli",
  "terminal_backend": {
    "type": "docker",
    "docker": {
      "image": "node:22",
      "network": "none",
      "workdir": "/workspace"
    }
  }
}
```

This backend applies to CLI adapters. Native `agent_loop` isolation is configured
separately through `agent_loop.security` and `agent_loop.worktree`.

## Worktree Policy

Native `agent_loop` task execution can prepare a dedicated git worktree.

Public knobs:

- `enabled`
- `base_dir`
- `keep_for_debug`
- `cleanup_policy`: `on_success`, `always`, or `never`

Worktree isolation prevents accidental writes to the primary checkout. It is not
an OS sandbox. For untrusted goals, use Docker, a containerized PulSeed process,
or a VM boundary.

## Local State Layout

PulSeed stores runtime state under `~/.pulseed/` by default.

Common entries:

- `provider.json`
- `.env`
- `goals/`
- `tasks/`
- `reports/`
- `runtime/`
- `state/pulseed-control.sqlite`
- `schedule/`
- `chat/`
- `plugins/`
- `plugins-imported-disabled/`
- `skills/`
- `memory/`
- `logs/`
- `datasources/`

Depending on enabled features, you may also see checkpoints, runtime evidence,
Dream playbooks, Soil projections, gateway channel config, and compatibility
reports.

## Gateway Routing Config

Bundled chat/gateway plugins accept allow/deny and route settings while
preserving existing config fields.

Common fields:

- `allowed_sender_ids` / `denied_sender_ids`
- `allowed_conversation_ids` / `denied_conversation_ids`
- `runtime_control_allowed_sender_ids`
- `conversation_goal_map`, `sender_goal_map`, and `default_goal_id`

Telegram also supports numeric legacy field names:

- `allowed_user_ids`, `denied_user_ids`
- `allowed_chat_ids`, `denied_chat_ids`
- `runtime_control_allowed_user_ids`
- `chat_goal_map`, `user_goal_map`, and `default_goal_id`

## Related

- [Getting Started](../../getting-started/first-run.md)
- Runtime
- [CLI Reference](../command-reference/cli-commands/cli.md)
- [Status](./status.md)
