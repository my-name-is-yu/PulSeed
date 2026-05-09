# Mechanism

This page is the canonical conceptual explanation of how PulSeed works.
For runtime surfaces and commands, see [Runtime](runtime.md). For the public map, see [docs/index.md](index.md).

## DurableLoop and AgentLoop

PulSeed is easiest to understand as two cooperating loops.

### DurableLoop

`DurableLoop` is the long-lived controller.
It owns durable decisions about goal progress, scheduling, stall handling, reprioritization, verification, and completion.

DurableLoop answers questions such as:

- Is the goal still viable?
- What should be worked on next?
- Is the system stalled?
- Should the next step continue, refine, pivot, or verify?

It works across goals, tasks, memory, schedules, and runtime state.

### AgentLoop

`AgentLoop` is the bounded executor.
It handles short-lived work where the system needs to choose tools, inspect results, and stop with a bounded outcome.

AgentLoop is used for:

- task execution through the native `agent_loop` path
- chat turns
- selected DurableLoop phases that need targeted evidence gathering

## Tools

Tools are the execution substrate for both loops.
They are not an add-on layer.

PulSeed uses tools for:

- filesystem and git inspection
- shell and test execution
- goal, task, and session state queries
- knowledge and memory access
- schedule management
- Soil queries and maintenance

The practical rule is simple: when PulSeed inspects, verifies, or updates state, it usually does so through tools rather than by relying on narration alone.

## Soil

Soil is PulSeed's long-lived, human-readable memory surface.
It makes durable knowledge available to bounded runs through memory recall, knowledge queries, session history, and `soil_query`.

That is how a short AgentLoop run can still make use of state accumulated over a much longer horizon.

## Procedural memory

PulSeed can also retain verified procedural knowledge as Dream-backed playbooks.

These playbooks are:

- derived from verifier-backed successful execution
- stored as inspectable memory artifacts under the PulSeed state directory
- injected back into task generation as bounded hints when they are promoted

They are not the same thing as skills.
PulSeed does not auto-generate or auto-overwrite `SKILL.md` files as part of this path.

## Verification

Verification is a separate step from execution.
PulSeed treats direct evidence as the strongest signal available.

Current verification sources include:

- direct tool evidence
- task-level structured verification
- execution command results
- optional model-based verification passes

The important point is that verification is not just self-report. It is grounded in observed results.

## Companion Capabilities

Companion capabilities are projected through separate readiness, admission, and
autonomy contracts. Readiness answers whether the operation substrate has been
stored, configured, authenticated, and verified for that exact operation.
Admission answers whether the current actor, surface, target, permissions,
quieting, privacy, runtime-control, and notification policies allow it.
Autonomy answers whether the companion may initiate or execute after readiness
and admission have already matched the same operation scope.

That separation keeps `can execute` different from `may initiate`. Normal
companion UX should turn the combined decision into the next best safe action,
while operator and debug surfaces may show the underlying readiness, admission,
autonomy, evidence, and blocked/degraded state.

## Completion

PulSeed uses satisficing rather than endless execution.
Completion is decided from a combination of:

- goal thresholds
- confidence
- verification state
- stall and error boundaries

AgentLoop stops when the bounded task or chat turn is done.
DurableLoop stops when the longer-running goal or iteration plan is done.

## Bounded phases inside DurableLoop

DurableLoop can invoke bounded AgentLoop phases for targeted evidence and planning support.

The current public phases are:

- `observe_evidence`
- `knowledge_refresh`
- `replanning_options`
- `stall_investigation`
- `verification_evidence`

These phases provide input to deterministic control.
They do not replace it.

## Why the split matters

The split keeps two concerns separate:

- DurableLoop manages durable control over a goal over time
- AgentLoop manages local tool use over a bounded window

That separation is what lets PulSeed keep running across sessions while still doing short, tool-driven work inside a single turn or task.
