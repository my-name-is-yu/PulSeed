# Positioning

> Status: Product positioning and direction. This page frames why PulSeed
> exists; it is not the command or capability reference for current behavior.
> Use [Runtime](../runtime.md) and [Status](../status.md) for current behavior.

This page is the short canonical framing for PulSeed.
Use it when explaining PulSeed to a person or agent that has no prior project
context.

## One-Sentence Definition

PulSeed is a lifelong personal companion agent that remembers what matters to a
person, observes changing context over time, and keeps helping move their life
forward.

## What PulSeed Is

PulSeed is designed for goals and life contexts that do not fit into a single
chat session or task ticket.

It should stay with one person over long periods, carry durable context about
their goals, preferences, relationship, and situation, notice important changes,
and act or ask at the right time. The target product category is closer to a
lifelong companion agent than a task runner.

## Current Wedge

PulSeed's current strongest implementation wedge is long-running goal
orchestration.

It can hold goals, run a local runtime, delegate bounded work to agents, verify
progress, preserve state under `~/.pulseed/`, and keep work moving through
surfaces such as chat, CLI, TUI, daemon, and schedules.

That wedge is necessary, but it is not the final category. Long-running task
execution is one capability PulSeed needs in order to become a reliable
lifelong companion agent.

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

PulSeed should eventually behave like a durable personal partner:

- remember the user's long-term goals and life context
- distinguish task memory from personal-context memory
- observe relevant changes in the world, tools, data sources, and user state
- decide when to stay quiet, when to report, when to ask, and when to act
- delegate work to agents and systems while preserving approval and safety
  boundaries
- learn from outcomes, corrections, and preference changes over time

In short: orchestration is the engine PulSeed is building first; lifelong
companionship is the product it is trying to become.

## How To Summarize PulSeed

Good short summary:

> PulSeed is a lifelong personal companion agent. Its current wedge is
> long-running goal orchestration: it remembers goals, delegates work, verifies
> progress, and keeps moving across time.

Incomplete summary:

> PulSeed is a long-running task execution orchestrator.

That description captures one important implementation capability, but misses
the product direction: durable personal context, presence, proactive dialogue,
and life-scale goal pursuit.
