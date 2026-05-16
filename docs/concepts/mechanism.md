# Mechanism

> Status: Current mechanism overview. This page explains the implemented execution model at a conceptual level.

This page explains the current PulSeed execution model. For commands, see
[Runtime](../operate/runtime.md) and [CLI Reference](../reference/cli.md).

## DurableLoop And AgentLoop

PulSeed is built around two cooperating loops.

### DurableLoop

`DurableLoop` is the long-running controller. It manages durable decisions about
goal progress, scheduling, stall handling, reprioritization, verification, and
completion.

DurableLoop answers questions such as:

- what goal or task should be worked on next
- whether the goal is stalled, waiting, progressing, or complete
- whether the next step should continue, refine, pivot, verify, or stop
- whether a bounded AgentLoop phase should gather targeted evidence

### AgentLoop

`AgentLoop` is the bounded tool-using executor. It handles short-lived work
where the system needs to choose tools, inspect results, and stop with a bounded
outcome.

AgentLoop is used for:

- native `agent_loop` task execution
- chat turns
- selected DurableLoop phases that need targeted evidence gathering
- review or diagnostic postures when exposed by the current runtime surface

## Tool Substrate

Tools are the execution substrate for observation, verification, state queries,
and bounded work. PulSeed uses tools for filesystem and git inspection, shell
and test execution, goal/task/session lookup, knowledge and memory access,
schedule management, Soil queries, and runtime diagnostics.

The current implementation separates tool policy by surface and purpose. A tool
being available in one surface does not mean it is available with the same
permissions everywhere.

## State And Memory

PulSeed stores local runtime state under `~/.pulseed/` by default.

Important memory/state surfaces:

- goals, tasks, reports, runtime state, and schedules
- chat sessions and runtime sessions
- Soil projections and readable knowledge surfaces
- Dream-backed playbooks from verified successful runs
- memory correction ledger and governance export

Soil is the readable long-term memory surface. It helps bounded runs use durable
state without treating every historical artifact as active instruction.

Dream-backed playbooks are inspectable memory artifacts. They are not
auto-generated `SKILL.md` files and do not silently overwrite user skills.

## Verification

Verification is separate from execution. PulSeed treats direct evidence as the
strongest signal available.

Current verification sources include:

- direct tool evidence
- command and test results
- task-level structured verification
- runtime evidence ledgers
- optional model-based verification passes

The documented claim is evidence-grounded verification, not that every delegated
result is automatically correct.

## Schedules And Waiting

Schedules provide heartbeat, probe, cron, and goal-trigger entries. DurableLoop
can also create internal wait-resume projections that are hidden from normal
schedule lists unless `--all` is used.

Waiting is part of the runtime model. When a goal is waiting for evidence,
elapsed time, or an external condition, the runtime should preserve that state
instead of treating the goal as silently stalled.

## Capability And Safety Boundary

Capability status is projected from separate readiness, admission, and autonomy
contracts:

- readiness: the operation substrate is present and verified for the scope
- admission: actor, surface, target, permission, privacy, runtime-control, and
  notification policy allow the operation
- autonomy: PulSeed may initiate or execute after readiness and admission match

This keeps `can execute` separate from `may initiate`. Normal surfaces should
show only the user-facing `CompanionActionProjection` view: the action kind,
next safe action, and optional brief reason. Debug, operator, and status
surfaces can expose raw policy details.

## Why The Split Matters

DurableLoop manages goal control over time. AgentLoop manages bounded tool use.
The split lets PulSeed keep long-running goals alive across sessions without
turning every action into an unbounded autonomous run.

Future companion-agent scenarios build on this mechanism, but they are not
current operating behavior unless the runtime and docs say exactly how to run them.
