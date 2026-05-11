# Positioning

> Status: Product positioning and direction. This page frames why PulSeed
> exists; it is not the command or capability reference for current behavior.
> Use [Runtime](../runtime.md) and [Status](../status.md) for current behavior.

This page is the short canonical framing for PulSeed.
Use it when explaining PulSeed to a person or agent that has no prior project
context.

## One-Sentence Definition

PulSeed is companion software that remembers what matters to a person, follows
changing context over time, and brings the right capability into the moment when
help is needed.

## What PulSeed Is

PulSeed is designed for goals and life contexts that do not fit into a single
chat session, automation trigger, or task ticket.

It should stay with one person over long periods, carry durable context about
their goals, preferences, relationship, and situation, notice important changes,
and act or ask at the right time. The target category is closer to a practical
everyday companion with a pocket of capabilities than to a task runner.

## Current Wedge

PulSeed's current strongest implementation wedge is long-running goal
orchestration.

It can hold goals, run a local runtime, delegate bounded work to agents, verify
progress, preserve state under `~/.pulseed/`, and keep work moving through
surfaces such as chat, CLI, TUI, daemon, and schedules.

That wedge is necessary, but it is not the final category. Long-running task
execution is one capability PulSeed needs in order to become reliable companion
software.

## What PulSeed Is Not

PulSeed is not primarily:

- a chat assistant that only answers the current prompt
- a one-shot task runner
- a project-management bot that only tracks work
- a generic automation workflow that only follows predefined triggers
- a coding-agent orchestrator limited to software repositories

Those capabilities can appear inside PulSeed, but they are subordinate to the
longer-lived relationship between the user, their goals, and the changing world
around them.

## North Star

PulSeed should eventually behave like a durable everyday companion:

- remember the user's long-term goals and life context
- distinguish task memory from personal-context memory
- observe relevant changes in the world, tools, data sources, and user state
- keep a pocket of practical capabilities: tools, agents, automations,
  integrations, and learned knowledge
- choose the right capability for the current situation instead of making the
  user translate every need into a command
- decide when to stay quiet, when to report, when to ask, and when to act
- delegate work to agents and systems while preserving approval and safety
  boundaries
- learn from outcomes, corrections, and preference changes over time

In short: orchestration is the engine PulSeed is building first; dependable
everyday companionship is the product it is trying to become.

## How To Summarize PulSeed

Good short summary:

> PulSeed is companion software for goals that take time. Its current wedge is
> long-running goal orchestration: it remembers goals, brings in tools and
> agents, verifies progress, and keeps moving across time.

Incomplete summary:

> PulSeed is a long-running task execution orchestrator.

That description captures one important implementation capability, but misses
the product direction: durable personal context, presence, proactive dialogue,
the ability to bring the right capability into the moment, and life-scale goal
pursuit.
