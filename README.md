# Motiva

AI agent orchestrator that gives existing agents "motivation" — goal-driven task discovery, autonomous progress observation, and satisficing completion judgment.

---

## What is Motiva?

Motiva is a **task discovery engine**. You give it a long-term goal — "double revenue in 6 months," "keep my dog healthy and happy" — and it pursues that goal autonomously, indefinitely. It observes the real world, calculates the gap between the goal and current reality, generates the next task to close that gap, delegates it to an AI agent (CLI-type, API-type, or a custom adapter — e.g., Claude Code, OpenAI Codex CLI, Browser Use), and verifies the result. Then it loops.

The key distinction from existing tools: Motiva doesn't execute. It orchestrates. It makes agents think, then verifies that their thinking produced real progress. Every action is delegated; Motiva's direct operations are limited to LLM calls (for reasoning) and state file read/write.

Motiva is built on a **4-element model**: a Goal (with measurable thresholds), Current State (observed with confidence scores), the Gap between them, and Constraints that govern how tasks may be executed. The **core loop** — observe → gap → score → task → execute → verify — runs until the goal is satisfied or the system escalates to a human.

Motiva knows when to stop. Rather than pursuing perfection, it applies *satisficing*: when all goal dimensions cross their thresholds with sufficient evidence, the goal is complete. No runaway loops. No premature completion on self-reported progress alone.

---

## Quick Start

**Requirements:** Node.js 18+, an OpenAI or Anthropic API key.

### Installation

```bash
npm install -g motiva

# Set your API key (OpenAI is the default provider)
export OPENAI_API_KEY=sk-...

# Or use Anthropic instead
export MOTIVA_LLM_PROVIDER=anthropic
export ANTHROPIC_API_KEY=sk-ant-...
```

### First Run

```bash
# Register a goal (Motiva assesses feasibility and proposes measurable dimensions)
motiva goal add "Create a comprehensive README for this project"

# Run one iteration of the core loop
motiva run

# Check current goal progress
motiva status

# List all registered goals
motiva goal list

# Display the latest report
motiva report
```

On first run, Motiva initializes its state directory at `~/.motiva/`.

### Development Installation

```bash
git clone https://github.com/yuyoshimuta/motiva.git
cd motiva
npm install
npm run build
export OPENAI_API_KEY=sk-...
npx tsx src/index.ts goal add "Your goal here"
npx tsx src/index.ts run
```

---

## Programmatic Usage

```typescript
import { CoreLoop, StateManager, GoalNegotiator } from "motiva";

// Initialize state
const stateManager = new StateManager("~/.motiva");

// Run one loop iteration
const loop = new CoreLoop({ stateManager, /* ...adapters */ });
await loop.runOnce();
```

---

## Architecture

### System Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                          User                                        │
│   Goals: "2x revenue"  "keep my dog healthy"                         │
│   Constraints: "don't share customer data"  "respect vet's judgment" │
│   Capabilities: API keys, sensor access, DB connections              │
└───────────────┬─────────────────────────────┬───────────────────────┘
                │ goal + constraints           │ reports + approval requests
                ↓                             ↑
┌───────────────────────────────────────────────────────────────────────┐
│                                                                       │
│                    Motiva (Task Discovery Engine)                      │
│                                                                       │
│  ┌──────────────────────────────────────────────────────────────┐     │
│  │           Goal Negotiation                                    │     │
│  │  Ethics Gate (Step 0) → receive → decompose → baseline obs   │     │
│  │  → feasibility eval → accept / counter-propose / flag        │     │
│  └──────────────────────────┬───────────────────────────────────┘     │
│                              ↓ agreed goal                            │
│  ┌──────────────────────────────────────────────────────────────┐     │
│  │           Goal Tree (recursive)                               │     │
│  │     top-level goal                                            │     │
│  │      ├── sub-goal A ── each node holds its own state vector  │     │
│  │      │    ├── sub-goal A-1                                    │     │
│  │      │    └── sub-goal A-2                                    │     │
│  │      ├── sub-goal B                                           │     │
│  │      └── sub-goal C                                           │     │
│  └──────────────────────────┬───────────────────────────────────┘     │
│                              ↓ loop runs at each node                 │
│  ┌──────────────────────────────────────────────────────────────┐     │
│  │                   Core Loop                                   │     │
│  │                                                               │     │
│  │  ┌────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐       │     │
│  │  │ Observe│─→│  Gap     │─→│  Drive   │─→│  Task    │       │     │
│  │  │ (3-layer)  │ Calc     │  │ Scoring  │  │ Generate │       │     │
│  │  └────────┘  └──────────┘  └──────────┘  └────┬─────┘       │     │
│  │      ↑                                        │              │     │
│  │      │       ┌──────────┐  ┌──────────┐       │              │     │
│  │      └───────│  Verify  │←─│ Execute  │←──────┘              │     │
│  │              │ (3-layer)│  │ (agent)  │                      │     │
│  │              └──────────┘  └──────────┘                      │     │
│  └──────────────────────────────────────────────────────────────┘     │
│                                                                       │
│  ┌──── Cross-cutting ────────────────────────────────────────────┐    │
│  │  Trust & Safety │ Satisficing │ Stall Detection │ Ethics Gate │    │
│  │  Curiosity Engine │ Character Config │ Embedding / Vector KB  │    │
│  └───────────────────────────────────────────────────────────────┘    │
│                                                                       │
│  ┌──── Infrastructure ───────────────────────────────────────────┐    │
│  │  Drive System (4 triggers) │ Context Mgmt │ State (JSON)      │    │
│  │  Daemon/PID │ Event Server │ Notification │ Memory Lifecycle  │    │
│  └───────────────────────────────────────────────────────────────┘    │
│                                                                       │
└───────────────────────────────┬───────────────────────────────────────┘
                                │ task delegation
                                ↓
┌───────────────────────────────────────────────────────────────────────┐
│                     Execution Layer (existing systems)                │
│                                                                       │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌──────────────┐     │
│  │ CLI Agent  │ │ LLM API    │ │ Browser Use│ │ Custom       │     │
│  │ (implement)│ │ (analysis) │ │ (web auto) │ │ Agents       │     │
│  └────────────┘ └────────────┘ └────────────┘ └──────────────┘     │
│  ┌────────────────────────────┐ ┌────────────────────────────────┐  │
│  │ A2A Protocol (remote)      │ │ Human (approve/decide)         │  │
│  └────────────────────────────┘ └────────────────────────────────┘  │
│                                                                       │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │ Data Sources: sensors, DB, analytics, CRM, external APIs, IoT  │  │
│  └────────────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────┘
```

### Implementation Layers

| Layer | Modules | Role |
|-------|---------|------|
| 0 | StateManager, AdapterLayer | Persistence and agent abstraction |
| 1 | GapCalculator, DriveSystem, TrustManager | Gap computation, event scheduling, trust tracking |
| 2 | ObservationEngine, DriveScorer, SatisficingJudge, StallDetector | Observation, scoring, completion and stall judgment |
| 3 | LLMClient, EthicsGate, SessionManager, StrategyManager, GoalNegotiator | LLM interface, ethics, session context, goal negotiation |
| 4 | TaskLifecycle | Full task lifecycle: select → generate → approve → execute → verify |
| 5 | CoreLoop, ReportingEngine | Orchestration loop, report generation |
| 6 | CLIRunner | Entry point, subcommand dispatch |
| 7 | TUI (Ink/React) | Terminal dashboard, approval UI, chat |
| 8 | KnowledgeManager | Knowledge acquisition and injection |
| 9 | PortfolioManager | Parallel strategy execution |
| 10 | DaemonRunner, PIDManager, Logger, EventServer, NotificationDispatcher, MemoryLifecycleManager | Persistent runtime, eventing, notifications |
| 11 | CuriosityEngine, CharacterConfigManager | Curiosity-driven exploration, ethics enforcement, character configuration |
| 12 | EmbeddingClient, VectorIndex, KnowledgeGraph, GoalDependencyGraph | Semantic embedding infrastructure, vector search, knowledge graph |
| 13 | CapabilityDetector, DataSourceAdapter | Autonomous capability acquisition, external data source connections |
| 14 | GoalTreeManager, CrossGoalPortfolio, LearningPipeline, KnowledgeTransfer | Cross-goal portfolio, learning, knowledge transfer |

---

## Core Loop

Each iteration moves a goal closer to its thresholds:

1. **Observe** — collect evidence using 3-layer observation: mechanical checks → independent LLM review → executor self-report. Higher layers override lower ones.
2. **Gap calculation** — compute `raw_gap` per dimension, normalize to `[0,1]`, apply confidence weighting (low confidence inflates the gap estimate).
3. **Drive scoring** — score three drives: dissatisfaction (gap magnitude), deadline urgency (exponential as deadline approaches), opportunity (time-decaying value). The highest score selects the priority dimension.
4. **Task generation** — an LLM concretizes "what to do": work description, verifiable success criteria, scope boundaries, inherited constraints.
5. **Execute** — delegate to the selected adapter. Motiva does not intervene during execution; it only monitors status, timeout, and heartbeat.
6. **Verify** — 3-layer result verification: mechanical checks → independent LLM reviewer → executor self-report. Verdict: `pass / partial / fail`. On failure: keep, discard, or escalate to human.

The loop repeats until: goal completed (SatisficingJudge), stall escalation, max iterations reached, or explicit stop.

---

## Key Design Principles

- **Evidence-based observation** — progress is never inferred from activity. Only verifiable evidence (test results, file diffs, metric readings) can advance a goal dimension. Self-report alone caps progress at 70%.
- **Satisficing** — Motiva stops when all dimensions cross their thresholds with sufficient confidence. It does not pursue perfection.
- **Trust balance (asymmetric)** — trust score is per-domain, range `[-100, +100]`. Success: `+3`. Failure: `-10`. Irreversible actions always require human approval, regardless of trust level.
- **Execution boundary** — Motiva reasons; agents act. The only direct operations Motiva performs are LLM calls and state file read/write.
- **Ethics gate** — every goal passes through a two-stage ethics check before negotiation begins. Goals that cross legal or ethical lines are rejected outright.
- **Stall detection** — four stall indicators trigger graduated responses: approach change → strategy pivot → human escalation.

---

## CLI Commands

| Command | Description |
|---------|-------------|
| `motiva goal add "<description>"` | Start goal negotiation. Motiva evaluates feasibility, decomposes into measurable dimensions, and registers the agreed goal. |
| `motiva goal list` | Display all registered goals with current status. |
| `motiva goal archive <id>` | Archive a completed goal. |
| `motiva run` | Execute one iteration of the core loop across active goals. |
| `motiva status` | Show current progress report: goal dimensions, gaps, trust scores, recent activity. |
| `motiva report` | Display the latest generated report. |
| `motiva cleanup` | Archive all completed goals and clean up state. |
| `motiva datasource add/list/remove` | Manage external data sources for mechanical observation. |

Exit codes: `0` normal completion, `1` error, `2` stall escalation requiring human input.

---

## Development

```bash
npm install
npm run build           # TypeScript → dist/
npm test                # Run all tests
npm run typecheck       # Type check without emit
npm run test:watch      # Watch mode
```

State files: `~/.motiva/`. Reports: `~/.motiva/reports/`. Ethics logs: `~/.motiva/ethics/`.

For detailed implementation status, see [`docs/status.md`](docs/status.md).

---

## License

MIT
