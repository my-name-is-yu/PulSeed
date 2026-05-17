# Capability Runtime And Plugins

> Status: Active design contract for capabilities, plugins, skills, channels,
> MCP, readiness, admission, and autonomy boundaries.

Primary map: [Extension Runtime](./extension-runtime-map.md).

PulSeed's friend-like behavior depends on a pocket of capabilities. A capability
can be a tool, agent, plugin, schedule, channel, data source, browser session,
auth handoff, knowledge surface, or external adapter.

Capability design has one central rule:

> Available does not mean admitted, and admitted does not mean autonomous.

```mermaid
flowchart LR
  Discovery["Discovery"]
  Readiness["Readiness"]
  Admission["Admission"]
  Autonomy["Autonomy"]
  Projection["User-facing projection"]
  Action["Execution or suggestion"]

  Discovery --> Readiness
  Readiness --> Admission
  Admission --> Autonomy
  Autonomy --> Projection
  Projection --> Action
```

## Implementation Anchors

- `src/runtime/capability-execution-resolver.ts`
- `src/runtime/capability-operation-planner.ts`
- `src/runtime/control/capability-status-projection.ts`
- `src/runtime/store/capability-registry-state-store.ts`
- `src/runtime/plugin-loader.ts`
- `src/runtime/foreign-plugins/`
- `src/runtime/mcp/`
- `src/runtime/skills/`
- `src/platform/runtime/plugin-loader.ts`
- `src/interface/cli/commands/config.ts`
- `src/interface/cli/commands/plugin.ts`

## Capability Layers

| Layer | Question | Example |
| --- | --- | --- |
| Discovery | What might exist? | plugin manifest, skill file, data source config |
| Readiness | Is the substrate configured and healthy? | token present, adapter reachable |
| Admission | May this actor use it for this target now? | permissions, privacy, runtime-control |
| Autonomy | May PulSeed initiate it without a direct command? | proactivity policy, confirmation mode |
| Projection | What should the user see? | next safe action, brief reason |
| Execution | How does it run? | ToolExecutor, adapter, gateway, schedule |

## Plugin Runtime

Plugins should provide capabilities without becoming privileged side channels.

Plugin-related surfaces include:

- plugin list/search/install/remove/update commands
- foreign-plugin compatibility
- manifest reading
- channel runtime state
- gateway channel adapters
- notification dispatchers
- MCP compatibility
- skill parsing and registry

Plugins can expand what PulSeed can do, but action-bearing use still needs
readiness, admission, autonomy, and audit.

## Skills

Skills are reusable local instructions or capability bundles. They help PulSeed
choose and operate tools consistently, but they are not permissions by
themselves.

Skill design should preserve:

- explicit activation context
- version and source identity
- safe parsing
- no silent overwrite of user-owned skill content
- compatibility with ToolExecutor and runtime-control policy

## Gateway Channels

Gateway channels are capabilities and surfaces at the same time.

Current built-in channel families include:

- Telegram
- Discord
- WhatsApp webhook
- Signal bridge
- Slack
- HTTP/WebSocket channel adapters

Each channel must preserve identity, conversation, reply target, delivery mode,
and channel policy.

## Capability Projection

Normal surfaces should not render raw capability state. They should render a
companion action projection:

- user-visible action kind
- next best safe action
- optional brief reason

Operator/debug surfaces may expose raw readiness, admission, autonomy, evidence,
and warnings.

## Tool Acquisition

PulSeed can reason about missing tools and ask agents or users to provide them.
That does not mean it should autonomously install or build arbitrary tools
without approval.

Tool acquisition should preserve:

- capability gap
- proposed source
- permission requirements
- verification plan
- rollback or disable path
- user-facing reason

## Design Risks

Review capability changes for:

- treating configured integrations as executable permission
- showing raw capability internals in normal chat
- bypassing runtime-control admission
- storing secret material in public docs or memory
- missing channel identity checks
- missing replay or idempotency keys
- plugin code paths that mutate state outside ToolExecutor
