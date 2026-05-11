# PulSeed Vision

> Status: Product vision and design direction. This page is not a
> current operating capability reference. Use [Runtime](../operate/runtime.md) and
> [Status](../operate/status.md) for behavior that exists in the current code.

---

## 1. In a Nutshell

PulSeed is companion software that remembers your goals, watches the world with
you, and brings the right help into the moment.

The goal is that you can tell PulSeed what you want to achieve, and it can stay
with that goal for days, months, or years. PulSeed is not meant to be an
"assistant waiting for instructions." It should remember what matters, observe
what changes, and keep moving toward the life or outcome you want.

PulSeed's current strongest technical foundation is long-running goal orchestration:
holding goals, delegating bounded work to agents, verifying progress, and
keeping a local runtime alive across time. That foundation makes the broader
companion-software contract observable: durable personal context, presence,
proactive dialogue, safe intervention, and a growing pocket of capabilities it
can bring to the user at the right time. See [Positioning](positioning.md) for
the short canonical framing.

---

## 2. The Problem It Solves

You have goals you want to achieve. But nothing autonomously pursues them on your behalf.

AI assistants answer questions. Agents execute tasks. Automation tools run workflows. None of them take ownership of your goals and chase them persistently over the long term.

Monitoring the health of a chronically ill dog. Doubling revenue. Getting a new business off the ground. These goals don't end with a single instruction. Situations change, new problems emerge, and strategies need to be revised. Right now, humans have to make those judgments and issue new instructions every time.

What's missing is not a smarter chatbot. It is **companion software that carries
your goals over time, understands the surrounding situation, and reaches for the
right capability when help is needed**.

---

## 3. The World PulSeed Enables

The examples in this section describe product design direction, not complete workflows
available in the current package. They are not medical, veterinary, financial,
legal, or business advice. Current behavior is documented in
[Runtime](../operate/runtime.md), [Configuration](../operate/configuration.md), and
[Status](../operate/status.md).

### Tell It Your Goal, Then Let Go

"I want to live happily with my dog." "I want to double revenue." — Just tell it your goal. PulSeed takes it on, figures out what needs to be done, delegates to agents, observes the results, and decides the next action. When a session ends, when a day passes, when a month passes — it keeps moving until the goal is achieved.

### Operating for Years

PulSeed is not a one-time task runner. If a dog owner who has a chronically ill elderly dog says, "I want to live happily with this dog," PulSeed works as a dedicated partner for three years until that dog's life comes to an end. Daily health reports, urgent notifications, stage-appropriate care recommendations. As long as the goal continues, so does PulSeed.

### Reporting Proactively, Asking When Needed

PulSeed doesn't just work silently. Morning reports, instant notifications of important changes, proposals for strategy shifts. Users don't need to check in on the situation. PulSeed reaches out at the right time with the right level of detail. In emergencies, it sends alerts immediately.

### Negotiating Honestly

When the CEO of a SaaS company says, "I want to 10x revenue in six months," PulSeed responds: "10x will be difficult, but 2x is achievable." Rather than following blindly, it evaluates feasibility and proposes a realistic target. Once a target is agreed upon, it pursues it with full effort.

### Connecting to the Real World

PulSeed's activity is not confined to codebases. It reads data from wearable sensors, monitors business metrics, and integrates with external APIs. A dog's breathing pattern, a SaaS company's churn rate, conversion numbers — the metrics PulSeed tracks are not "did the tests pass?" but "are we getting closer to the goal?"

### Acquiring Knowledge Autonomously

PulSeed doesn't start with all the knowledge needed to achieve a goal. But it researches, learns, and builds understanding. About care for dogs with respiratory disease. About techniques for reducing SaaS churn. Acquiring domain knowledge is part of pursuing the goal.

### Sourcing Needed Tools Autonomously

If existing tools are insufficient, PulSeed instructs agents to build them. Health monitoring code for dogs, data analysis pipelines, alert notification systems. Whatever is needed to achieve the goal is built through agents. PulSeed's role is to judge what is needed and to verify when the build is complete.

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

### 5.1 The Scale of Goals

Goals given to PulSeed are ambiguous, long-term, and require multi-stage decomposition — like "live happily with my dog" or "double revenue."

"Implement feature X" is not a goal. It's one task that emerges along the path to achieving a goal. PulSeed's job is to discover the path from an ambiguous high-level goal down to that task, build it, and realize it through agents.

### 5.2 Recursive Goal Tree

Goals are decomposed into an N-level tree structure.

Each node has its own state, completion criteria, and satisficing threshold. The state of a parent goal is determined by aggregating the states of its child goals. The goal tree is not a static plan — it's a dynamic structure that is discovered, modified, and pruned during execution.

Example: live happily with dog → continuous health monitoring → build monitoring code → analyze sensor data
Example: 2x revenue → halve churn rate → improve onboarding → implement tutorial

### 5.3 Capability Registry (Dynamic Capability Management)

PulSeed doesn't start with all capabilities. Each time a user grants permissions, tools, or data sources, what it can do expands.

Sensor data from a dog's collar, a SaaS database, the Stripe API, IoT devices, business dashboards — PulSeed understands these as "capabilities" and incorporates them into goal decomposition. When a new kind of capability is added, the architecture doesn't change.

Furthermore, PulSeed extends its own capabilities. It instructs agents to create needed code, delegates the building of needed tools, and keeps acquiring the means needed to achieve goals. PulSeed doesn't "build" — PulSeed "has things built."

### 5.4 Strategy Engine (Discovering and Executing Strategies)

"What should be done" is not given to PulSeed. PulSeed discovers it.

It generates hypotheses, prioritizes them, experiments, measures effectiveness, and decides whether to continue, retreat, or pivot. The criterion is not "was the task completed?" but "did we get closer to the goal?"

"Waiting" is also a judgment. It takes time for initiatives to show results after being launched. Knowing when to measure for meaningful results — this sense of timing is also part of strategy.

### 5.5 Portfolio Management

Multiple strategies are run in parallel and managed as a portfolio. Focus on what's working, cut what isn't. Not sequential execution, but optimization of resource allocation.

### 5.6 Time Horizon and Milestones

Goals have deadlines. For "2x revenue in 6 months," at the 3-month mark the pace is evaluated, and if insufficient, the strategy is changed. Make the best use of finite time.

Some goals have no deadline. "Live happily with my dog" has no end. PulSeed can handle this kind of goal too. Precisely because there's no end, operating at a sustainable pace becomes important.

### 5.7 Observing the External World

State observation is not limited to codebases.

Wearable sensors, databases, analytics, APIs, IoT devices, business metrics. The indicators PulSeed tracks are "is the dog's breathing stable?" "has churn rate decreased?" "have conversions increased?" It observes changes in the real world and judges progress toward the goal.

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

PulSeed (autonomous partner)
  │
  ├── Goal Tree (recursive goal hierarchy)
  │     Live happily with dog
  │     ├── Continuous health monitoring
  │     │    ├── Build monitoring code
  │     │    └── Set up emergency alerts
  │     └── Provide optimal care
  │          ├── Stage-appropriate care recommendations
  │          └── Coordination with vet
  │
  ├── Capability Registry (catalog of delegatable capabilities)
  │     Catalog of available delegation targets
  │     - AI agents (Claude Code CLI, Claude API, OpenAI Codex CLI, ...)
  │     - Data observation (sensors, DB, Analytics, ...)
  │     - External actions (notifications, API integrations, IoT, ...)
  │     - Tool acquisition (instruct agents to build)
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
