# PulSeed Vision

> Status: Product vision and design direction. This page is not a
> current operating capability reference. Use [Runtime](../operate/runtime.md) and
> [Status](../operate/status.md) for behavior that exists in the current code.

---

## 1. In a Nutshell

PulSeed is Your Personal Agentic Friend: companion software that remembers your
goals, watches the world with you, and brings the right help into the moment.

The goal is that you can tell PulSeed what matters, and it can stay with that
context for days, months, or years. It can still pursue explicit goals, but the
center of the product is broader: a steady agentic friend that notices, prepares,
asks, helps, and backs off when that is the better move. PulSeed is not meant to
be an "assistant waiting for instructions." It should remember what matters,
observe what changes, and keep moving toward the life or outcome you want.

PulSeed's current strongest technical foundation is long-running goal
orchestration: holding goals, delegating bounded work to agents, verifying
progress, and keeping a local runtime alive across time. That foundation now
sits inside the broader agentic-friend contract: durable personal context,
presence, proactive dialogue, safe intervention, and a growing pocket of
capabilities it can bring to the user at the right time. See
[Positioning](positioning.md) for the short canonical framing.

---

## 2. The Problem It Solves

You have goals you want to achieve. But nothing autonomously pursues them on your behalf.

AI assistants answer questions. Agents execute tasks. Automation tools run workflows. None of them take ownership of your goals and chase them persistently over the long term.

Monitoring the health of a chronically ill dog. Doubling revenue. Getting a new business off the ground. These goals don't end with a single instruction. Situations change, new problems emerge, and strategies need to be revised. Right now, humans have to make those judgments and issue new instructions every time.

What's missing is not a smarter chatbot. It is **a personal agentic friend that
carries your goals and context over time, understands the surrounding situation,
and reaches for the right capability when help is needed**.

---

## 3. The World PulSeed Enables

The examples in this section describe product design direction, not complete workflows
available in the current package. They are not medical, veterinary, financial,
legal, or business advice. Current behavior is documented in
[Runtime](../operate/runtime.md), [Configuration](../operate/configuration.md), and
[Status](../operate/status.md).

### Tell It Your Goal, Then Let Go

In the product direction, a user can say "I want to live happily with my dog" or
"I want to double revenue" and PulSeed treats that as a long-running context to
carry, not a single prompt to answer. The intended behavior is to help clarify
what needs to be done, coordinate bounded agent work when permitted, observe
evidence, and suggest the next action over time.

### Operating for Years

PulSeed is not designed as a one-time task runner. A future companion workflow for
an elderly dog with chronic illness would aim to preserve continuity for years:
daily summaries if a verified data source exists, escalation suggestions when
configured thresholds are crossed, and stage-appropriate prompts that remain
under human and professional judgment.

### Reporting Proactively, Asking When Needed

The intended companion posture is not silent background work. Depending on
configured permissions and risk, PulSeed should be able to prepare morning
summaries, propose strategy shifts, and request attention when something
important changes. Safety-sensitive or emergency-like notifications require
explicit integrations, thresholds, and human responsibility; this page is not a
claim that the current package provides emergency monitoring.

### Negotiating Honestly

In a business-growth scenario, PulSeed should not blindly accept unrealistic
targets. If a user says "I want to 10x revenue in six months," the desired design
is honest negotiation: explain uncertainty, propose a more realistic target when
the evidence supports it, and keep consequential business decisions with the
human operator.

### Connecting to the Real World

PulSeed's product direction is not confined to codebases. With explicit
integrations and permissions, it should be able to treat external data sources
such as wearable sensors, business metrics, and APIs as evidence about progress.
The architectural question is not only "did the tests pass?" but "is the goal
state improving?"

### Acquiring Knowledge Autonomously

PulSeed should not pretend to start with all domain knowledge. The design calls
for bounded research, evidence capture, correction, and user-visible uncertainty
when a goal requires new knowledge. In regulated or safety-sensitive domains,
that knowledge can inform questions and preparation, not replace qualified
advice.

### Sourcing Needed Tools Autonomously

If existing tools are insufficient, the long-term design allows PulSeed to
propose or delegate bounded tool-building work through approved agents. Health
monitoring scripts, data analysis pipelines, and notification integrations are
examples of possible artifacts, not bundled current workflows. PulSeed's role is
to judge what is needed, preserve the approval boundary, and verify completion
evidence.

### The Human Role Changes

From "implement this" and "look into that" to "I want things to be in this
state." From task instructor to goal setter. From one-time requester to someone
with software that can stay beside the goal.

---

## 4. How PulSeed Differs from Existing Approaches

This table is a positioning map, not a market-exclusivity claim. The
code-backed foundation is local long-running goal orchestration; the product
contract is durable companion software.

| Approach | Current strength | Gap for long-running goals | PulSeed contract |
|----------|------------------|----------------------------|----------------|
| AI assistants (ChatGPT, Claude) | Answer questions and process session-scoped tasks | Context, initiative, and ownership usually reset when the session ends | Preserve goal state and evidence outside a single chat turn |
| AI agents (Claude Code, Devin, task agents) | Execute bounded tasks with tools | Work is usually scoped to a task, repository, or session rather than a life-scale goal | Use agents as capabilities inside a longer-running goal loop |
| Autonomous-agent experiments | Decompose and pursue broad objectives | Completion quality, safety, and divergence are hard to govern | Combine autonomy with explicit approval, verification, and satisficing boundaries |
| Business automation (Zapier, n8n) | Run predefined workflows and integrations | Does not normally discover strategy from an ambiguous goal | Work backward from the desired outcome, then choose tools or agents |
| Project-management AI | Organize tasks and status | Optimizes coordination more than execution and verification | Treat tasks as artifacts inside a live goal runtime |
| **PulSeed today** | **Runs a local DurableLoop, delegates bounded work, verifies evidence, and keeps goal state under `~/.pulseed/`** | **The current package does not cover every companion scenario** | **Use code-backed persistent goal orchestration as the foundation for durable context, presence, and safe intervention** |

The differentiation is not that every individual component is unique. It is the
combination PulSeed makes explicit: persistent goal pursuit, evidence-backed
verification, satisficing instead of endless looping, and a local-first runtime
that can bring tools and agents into the goal over time.

---

## 5. Design as an Autonomous Partner

This section describes the product architecture PulSeed is designed toward. It
is not a current-package capability list. Current supported behavior remains the
local DurableLoop, bounded AgentLoop execution, typed tools, runtime stores, and
operator surfaces described in [Runtime](../operate/runtime.md) and
[Status](../operate/status.md).

### 5.1 The Scale of Goals

The goals PulSeed is designed for are ambiguous, long-term, and require
multi-stage decomposition, such as "live happily with my dog" or "double
revenue."

"Implement feature X" is not the product-level goal. It is one bounded task that
may emerge along the path to a larger outcome. The intended PulSeed role is to
help discover that path, propose bounded work, coordinate approved capabilities,
and verify evidence without pretending that every domain workflow is already
packaged.

### 5.2 Recursive Goal Tree

The design model decomposes goals into an N-level tree structure.

Each node has its own state, completion criteria, and satisficing threshold. The
state of a parent goal is determined by aggregating the states of its child
goals. The goal tree is not a static plan; it is a dynamic structure that can be
discovered, modified, and pruned during execution.

Example: live happily with dog -> observe health signals -> prepare a monitoring
script -> analyze configured data with human review

Example: 2x revenue → halve churn rate → improve onboarding → implement tutorial

### 5.3 Capability Registry (Dynamic Capability Management)

PulSeed should not assume all capabilities are available by default. Each time a
user grants permissions, tools, or data sources, the capability graph can expand.

Sensor data from a dog's collar, a SaaS database, the Stripe API, IoT devices,
and business dashboards are examples of possible capability sources. They become
usable only when configured, verified, permissioned, and scoped.

The product direction also includes capability acquisition: PulSeed can propose
delegating code or tool-building work to agents when the existing capability set
is insufficient. That delegation remains behind approval, workspace policy, and
verification.

### 5.4 Strategy Engine (Discovering and Executing Strategies)

"What should be done" is not always given to PulSeed. The intended design helps
discover candidate strategies from the goal, evidence, and constraints.

PulSeed should generate hypotheses, prioritize them, run bounded experiments
when permitted, measure effectiveness, and recommend whether to continue,
retreat, or pivot. The criterion is not only "was the task completed?" but "did
we get closer to the goal?"

"Waiting" is also a judgment. It takes time for initiatives to show results after being launched. Knowing when to measure for meaningful results — this sense of timing is also part of strategy.

### 5.5 Portfolio Management

The product design supports multiple strategies being tracked as a portfolio:
focus on what is working, stop what is not, and make resource allocation
explicit. This is a design target, not a guarantee that every strategy class is
currently automated.

### 5.6 Time Horizon and Milestones

Goals may have deadlines. For a scenario like "2x revenue in 6 months," the
design should let PulSeed evaluate pace at a milestone and recommend a strategy
change when the evidence warrants it.

Some goals have no clear deadline. "Live happily with my dog" is a product
scenario for open-ended continuity, not a current veterinary workflow. Precisely
because there is no fixed end, the design emphasizes sustainable pace, explicit
authority, and human responsibility.

### 5.7 Observing the External World

In the product direction, state observation is not limited to codebases.

Wearable sensors, databases, analytics, APIs, IoT devices, and business metrics
are possible evidence sources when configured and permissioned. The indicators
PulSeed may reason about are goal-relative, such as stability signals, churn, or
conversion movement. It should treat these as evidence with uncertainty, not as
automatic advice or authority.

### 5.8 Delegation And Execution Boundary

To pursue goals, PulSeed can use agents, configured adapters, native tools, and
runtime services. The design question is not "does PulSeed ever execute
anything?" The current code has typed tool execution paths, including a Shell
tool that is not read-only. The question is which operations are allowed,
observable, reversible, and worth delegating.

PulSeed should stay the orchestrator: it decides what to ask for, which
capability to use, what evidence to require, and when to stop or ask the user.
Implementation, command execution, API calls, notifications, and external
effects must remain behind explicit tool contracts, workspace policy,
permission checks, approval gates, and inspection surfaces.

**Perception And Tool Layer**: PulSeed includes direct observation tools for
common low-risk reads, such as Glob, Grep, Read, HttpFetch, and JsonQuery. Shell
is a command-execution tool, not a read-only observation tool; it can support
mechanical observation when policy permits a safe command, but it must be
treated as an execution surface. Direct tools reduce latency and cost for
mechanical observation and verification. Agent delegation remains the right path
for mutations, complex reasoning, multi-step execution, and work that needs an
independent executor.

### 5.9 The Big Picture

```
User
  │
  ├── Goals: "I want to live happily with my dog" / "I want to double revenue"
  ├── Capabilities: sensor data, DB, API, agents, IoT, ...
  └── Constraints: "respect the vet's judgment" / "don't share customer data externally"

PulSeed product direction
  │
  ├── Goal Tree (recursive goal hierarchy)
  │     Live happily with dog
  │     ├── Observe configured health signals
  │     │    ├── Propose monitoring script
  │     │    └── Prepare approved escalation channel
  │     └── Support care planning
  │          ├── Stage-appropriate questions and summaries
  │          └── Human/vet coordination prompts
  │
  ├── Capability Registry (catalog of delegatable capabilities)
  │     Catalog of available delegation targets
  │     - AI agents (Claude Code CLI, Claude API, OpenAI Codex CLI, ...)
  │     - Data observation (sensors, DB, Analytics, ...)
  │     - Approved external actions (notifications, API integrations, IoT, ...)
  │     - Approved tool-building delegation
  │
  ├── Strategy Engine (strategy discovery + portfolio)
  │     Hypothesis generation → prioritization → parallel delegation → effectiveness measurement → rebalancing
  │
  ├── Delegation Layer
  │     Adapter selection → session launch → context provision → result observation
  │
  └── State (state management + external metrics)
        Goal progress + observation data + time elapsed + capability catalog
```
