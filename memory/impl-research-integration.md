# Motive Layer — Integration Research

_Researched: 2026-03-09_

---

## 1. Claude Code Integration

### Hook System (Confirmed)

Claude Code exposes 17+ lifecycle hook events, configured via JSON in `.claude/settings.json` or `~/.claude/settings.json`. Hook handlers can be shell commands, HTTP endpoints, LLM prompts, or spawned subagents.

**Directly usable by Motive Layer:**

| Hook | Motive Layer use |
|---|---|
| `UserPromptSubmit` | Read incoming prompt, inject goal/gap context into it or block off-topic requests |
| `PreToolUse` | Check if tool call aligns with current goal; can block (exit 2) or modify tool input |
| `PostToolUse` | Update "current state" observation after each tool action; update progress estimate |
| `PostToolUseFailure` | Detect stall; increment failure counter; trigger stall-recovery heuristic |
| `Stop` | Score session against goal thresholds; emit completion/incomplete signal |
| `TaskCompleted` | Confirm goal completion; persist confidence score |
| `SubagentStart` / `SubagentStop` | Track parallel sub-goal execution; aggregate state |
| `SessionStart` | Load active goals and constraints into context |
| `SessionEnd` | Persist final state snapshot |

**Input format:** Hooks receive JSON on stdin with `tool_name` and `tool_input`. `PreToolUse` hooks can return modified `tool_input` to alter execution without blocking.

**Handler types available:** `command` (shell), `prompt` (LLM single-turn), `agent` (full subagent with Read/Grep/Glob).

### CLAUDE.md as Configuration Surface (Confirmed)

The `InstructionsLoaded` hook fires whenever a CLAUDE.md or `.claude/rules/*.md` file is loaded. Motive Layer could:
- Maintain a `.claude/rules/motive.md` that injects current goal + gap summary into every session context automatically.
- The hook could rewrite this file before each session based on persisted state.

### MCP Server Integration (Confirmed)

Claude Code natively supports MCP servers. A Motive Layer MCP server would be auto-discovered and its tools available to the agent without any hook configuration. This is the lowest-friction entry point (see Section 3).

### Custom Skills/Slash Commands (Confirmed)

Claude Code Skills can bundle their own hooks in frontmatter. A `motive` skill package could activate the full hook set + inject CLAUDE.md rules as a single install step.

---

## 2. Generic Agent Framework Integration

### LangChain / LangGraph (Confirmed)

Extension mechanism: `BaseCallbackHandler` subclass, passed to any chain/agent at instantiation.

Key callback methods Motive Layer would implement:
- `on_llm_start` / `on_llm_end` — track LLM invocations, measure progress
- `on_tool_start` / `on_tool_end` — observe tool use against goal constraints
- `on_chain_start` / `on_chain_end` — session-level goal tracking
- `on_agent_action` / `on_agent_finish` — gap and completion assessment

LangGraph additionally exposes node-level streaming (`astream_events`), which provides finer-grained state observation per graph node. **Confirmed as best integration point for LangGraph.**

### OpenAI Agents SDK (Confirmed)

Lifecycle hook interface with typed context objects:
- `on_agent_start` / `on_agent_end` — receives `AgentHookContext`
- `on_llm_start` / `on_llm_end` — receives `RunContextWrapper`
- `on_tool_start` / `on_tool_end` — receives `RunContextWrapper`

Implementation: subclass the hook interface and pass to the `Runner`. Clean and strongly typed — the **easiest framework to integrate with**.

### CrewAI (Confirmed)

Four integration surfaces:
- `before_kickoff_callbacks` — inject goal context into crew inputs
- `after_kickoff_callbacks` — assess final output against completion threshold
- `step_callback` — per-agent-iteration hook; best for stall detection
- `task_callback` — per-task completion; update current state observation
- Tool hooks via `BaseTool` subclass — intercept tool execution pre/post

### AutoGen / Microsoft Agent Framework (Likely)

AutoGen merged into Microsoft Agent Framework (GA Q1 2026). Extension points are event-driven through middleware registered on the agent runtime. Specific hook API has changed post-merge — exact interface requires verification against current docs.

### Most Universal Integration Surface

**Tool wrapping** is the single most universal pattern: every framework allows wrapping tool execution. A `MotiveTool` wrapper that decorates any tool with pre/post observation calls works across LangChain, OpenAI SDK, CrewAI, and AutoGen with no framework-specific code beyond the adapter.

---

## 3. MCP as Integration Layer

### Why MCP Works (Confirmed)

MCP is now adopted by Claude Code, OpenAI, Google DeepMind, and supported by all major agent frameworks. An MCP server is the most platform-agnostic integration surface available.

### Proposed Motive Layer MCP Server

**Tools (model-controlled, agent calls these):**
- `motive_get_goal` — returns current active goal, completion threshold, deadline
- `motive_report_progress` — agent reports observation; server updates confidence score and gap estimate
- `motive_check_constraints` — agent queries whether a planned action violates constraints
- `motive_request_handoff` — agent triggers human collaboration when confidence drops below threshold
- `motive_report_stall` — agent self-reports inability to proceed; server returns recovery strategy

**Resources (app-controlled, readable by agent):**
- `motive://state` — current state snapshot (goal, gap, confidence, priority score)
- `motive://constraints` — active constraint set (divergence limits, uncertainty ceiling)
- `motive://history` — recent action log for stall detection context

**Prompts (user-controlled, injected into context):**
- `motive_system_prompt` — standard motivation-aware system prompt template

### MCP Transport

HTTP/SSE or stdio. For local use (Claude Code), stdio is zero-config. For cloud agent deployments, HTTP with auth.

---

## 4. Architecture Recommendation

### Recommended: MCP-First with Hook Adapter Layer

**Tier 1 — MCP Server (universal core):**
Build Motive Layer as an MCP server in Python or TypeScript. All state management, gap analysis, stall detection, and human collaboration logic lives here. Any MCP-compatible agent gets full functionality.

**Tier 2 — Hook Adapters (platform-specific observation):**
Thin adapters that call the MCP server's tools at lifecycle events:
- Claude Code: `.claude/settings.json` hook config pointing to a local script that POSTs to the MCP server's HTTP endpoint
- LangChain/LangGraph: `BaseCallbackHandler` subclass making async calls to MCP server
- OpenAI SDK: Lifecycle hook subclass making async calls to MCP server
- CrewAI: `step_callback` + `task_callback` functions wrapping MCP tool calls

**Tier 3 — CLAUDE.md Injection (Claude Code only):**
`InstructionsLoaded` hook that rewrites `.claude/rules/motive.md` with current goal/gap state before each session.

### Rationale

- MCP server = single source of truth, no framework lock-in
- Hook adapters are <50 lines each, no business logic
- Claude Code gets the richest integration (hooks + MCP + CLAUDE.md)
- Other frameworks get full functionality via MCP tools alone, without hooks
- HTTP transport enables future cloud/multi-agent deployments

### Build Order

1. MCP server with `motive_get_goal`, `motive_report_progress`, `motive_check_constraints`
2. Claude Code hook adapter (highest daily use, validates core mechanics)
3. LangChain/LangGraph adapter (largest ecosystem)
4. OpenAI SDK adapter (cleanest API, good reference implementation)

---

## Gaps

- Microsoft Agent Framework (post-AutoGen merge) hook API not verified against current docs — **Uncertain**
- MCP server auth/session isolation for multi-agent concurrent use needs design decision
- Whether Claude Code `PreToolUse` hooks can read MCP server resources directly (vs. calling tool) needs testing

---

## Sources

- [Claude Code Hooks Reference](https://code.claude.com/docs/en/hooks)
- [LangChain BaseCallbackHandler](https://python.langchain.com/api_reference/core/callbacks/langchain_core.callbacks.base.BaseCallbackHandler.html)
- [OpenAI Agents SDK Lifecycle](https://openai.github.io/openai-agents-python/ref/lifecycle/)
- [CrewAI Tool Hooks](https://docs.crewai.com/en/learn/tool-hooks)
- [MCP Specification](https://modelcontextprotocol.io/specification/2025-11-25)
- [MCP GitHub Servers](https://github.com/modelcontextprotocol/servers)
