# Tool Integration Design

## 1. Overview

PulSeed's tool system unifies interactive (AgentLoop) and autonomous (CoreLoop) execution through shared tool primitives, inspired by Claude Code's architecture.

Two loops, one tool layer:

```
┌─────────────────────────────────┐
│       Shared Tool Layer         │
│  ReadState, WriteState, ...     │
└──────────┬──────────┬───────────┘
           │          │
    ┌──────▼──────┐  ┌▼────────────┐
    │  AgentLoop  │  │  CoreLoop   │
    │  LLM-driven │  │  Goal-driven│
    │  free pick  │  │  fixed seq  │
    └─────────────┘  └─────────────┘
```

**AgentLoop** (interactive): LLM freely picks tools, stops at end_turn. Used for single-task, conversational sessions.

**CoreLoop** (autonomous): fixed sequence — ReadState → QueryDataSource → (gap calc in code) → RunAdapter → QueryDataSource (verify). Stops when satisficing judge clears the gap.

**Handoff**: Future `track` command transfers context from AgentLoop to CoreLoop.

---

## 2. Tool Definition Type

Follows Claude Code's `buildTool()` pattern — each tool owns its prompt, UI rendering, and execution:

```typescript
// src/tools/tool-types.ts
import { z } from 'zod';

interface ToolDef<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  parameters: z.ZodSchema<TInput>;
  isReadOnly?: boolean;          // default: false (safe side)
  isConcurrencySafe?: boolean;   // default: false (exclusive execution)
  isDestructive?: boolean;       // default: false
  statusVerb: string;            // e.g., "Reading state", "Running adapter"
  statusArgKey?: string;         // param key for status display
  maxResultSizeChars?: number;   // overflow → disk + preview
  prompt: () => string;          // system prompt fragment injected per-tool
  call: (input: TInput, ctx: ToolContext) => Promise<ToolResult<TOutput>>;
  renderToolUse?: (input: TInput) => string;    // TUI display
  renderToolResult?: (result: ToolResult<TOutput>) => string;
}

interface ToolResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;               // errors as data, not exceptions
}

interface ToolContext {
  stateManager: StateManager;
  llmClient: LLMClient;
  approvalFn?: (desc: string) => Promise<boolean>;
  onStatus?: (text: string) => void;
}

function buildTool<TInput, TOutput>(def: ToolDef<TInput, TOutput>): Tool<TInput, TOutput> {
  return {
    isReadOnly: false,
    isConcurrencySafe: false,
    isDestructive: false,
    maxResultSizeChars: 50_000,
    ...def,
  };
}
```

---

## 3. Tool Inventory

13 tools across 6 categories. Granularity is CC-level: primitive operations, not domain-composite.

### State (read)

| Tool | Description | readOnly | concurrent | statusVerb |
|------|------------|----------|-----------|------------|
| ReadState | Read goal, session, trust, config, or plugin state by target+id | true | true | Reading |
| ListStates | List goals, sessions, or plugins with optional filters | true | true | Listing |

### State (write)

| Tool | Description | readOnly | concurrent | statusVerb |
|------|------------|----------|-----------|------------|
| WriteState | Create, update, delete, or archive a goal/config/trust | false | false | Updating |

Note: only irreversible/damaging operations (delete, reset_trust) get rich LLM descriptions with risk warnings (MutationToolMeta). Other mutations proceed without extra description to maintain execution speed.

### Execution

| Tool | Description | readOnly | concurrent | statusVerb |
|------|------------|----------|-----------|------------|
| RunAdapter | Execute a command via an adapter (Claude, Codex, etc.) | false | false | Running |
| SpawnSession | Create a new agent session for a goal | false | false | Spawning |

### Data

| Tool | Description | readOnly | concurrent | statusVerb |
|------|------------|----------|-----------|------------|
| QueryDataSource | Query a data source (shell command, file check, API) | true | true | Querying |

### Knowledge

| Tool | Description | readOnly | concurrent | statusVerb |
|------|------------|----------|-----------|------------|
| SearchKnowledge | Semantic search across PulSeed's knowledge base | true | true | Searching |
| WriteKnowledge | Store or update a knowledge entry | false | false | Storing |

### File

| Tool | Description | readOnly | concurrent | statusVerb |
|------|------------|----------|-----------|------------|
| ReadPulseedFile | Read a file from ~/.pulseed/ | true | true | Reading |
| WritePulseedFile | Write a file to ~/.pulseed/ | false | false | Writing |

### Interaction

| Tool | Description | readOnly | concurrent | statusVerb |
|------|------------|----------|-----------|------------|
| AskHuman | Ask the user a question and wait for response | true | false | Asking |

### Planning

| Tool | Description | readOnly | concurrent | statusVerb |
|------|------------|----------|-----------|------------|
| CreatePlan | Create or update a task plan | false | false | Planning |
| ReadPlan | Read current task plan | true | true | Reading plan |

---

## 4. Tool Registration

No registry class — CC pattern uses a plain function returning an array:

```typescript
// src/tools/index.ts
export function getAllTools(): Tool[] {
  return [
    readStateTool,
    listStatesTool,
    writeStateTool,
    runAdapterTool,
    spawnSessionTool,
    queryDataSourceTool,
    searchKnowledgeTool,
    writeKnowledgeTool,
    readPulseedFileTool,
    writePulseedFileTool,
    askHumanTool,
    createPlanTool,
    readPlanTool,
  ];
}
```

---

## 5. Real-Time Status Display

Each tool's `statusVerb` + `statusArgKey` generates a one-line status emitted via `ToolContext.onStatus`:

```
⚡ Reading goal:improve-test-coverage
⚡ Running adapter:claude-code-cli
⚡ Searching knowledge:test patterns
```

Separate from spinner verbs (shown during LLM thinking). New TUI component:

```typescript
// src/interface/tui/tool-status.tsx
const ToolStatusLine: FC<{ status: string | null }> = ({ status }) => {
  if (!status) return null;
  return <Text dimColor>  ⚡ {status}</Text>;
};
```

---

## 6. Implementation Phases

### Phase A: Tool Foundation

Scope: create tool layer, wire into ChatRunner (AgentLoop foundation).

- Create `src/tools/tool-types.ts` — ToolDef, ToolResult, ToolContext, buildTool
- Create `src/tools/index.ts` — getAllTools
- Implement: ReadState, ListStates, WriteState (migrate from self-knowledge-tools + mutation-tool-defs)
- Wire into ChatRunner's `executeWithTools`
- Create `src/interface/tui/tool-status.tsx`
- Files: 5 new, 3 modified | Tests: tool-types.test.ts + per-tool unit tests

Migration: self-knowledge-tools.ts and mutation-tool-defs.ts become shims re-exporting from new tool layer. No breaking changes.

### Phase B: Execution & Data Tools

Scope: remaining 10 tools, AgentLoop fully functional.

- Implement: RunAdapter, SpawnSession, QueryDataSource
- Implement: SearchKnowledge, WriteKnowledge
- Implement: ReadPulseedFile, WritePulseedFile, AskHuman, CreatePlan, ReadPlan
- ChatRunner switches to getAllTools()
- Files: 10 new, 2 modified | Tests: per-tool unit tests + AgentLoop integration test

Old files deprecated; new tools are source of truth.

### Phase C: CoreLoop Migration

Scope: refactor CoreLoop to call tool primitives instead of modules directly.

- CoreLoop calls ReadState instead of `stateManager.getGoal()` directly
- CoreLoop calls QueryDataSource instead of `observationEngine.observe()` directly
- Both loops verified sharing tools correctly
- Files: 3-5 modified (core-loop.ts, observation-engine.ts, etc.)
- Tests: CoreLoop integration tests with tool layer

Each module change is independently testable. No API changes to callers.

### Phase D: Concurrency & Polish

Scope: performance optimizations, no API changes.

- Concurrent execution for isConcurrencySafe tools (parallel reads)
- Result overflow to disk (maxResultSizeChars exceeded → disk + preview)
- Tool-owned prompt() fragments injected into system prompt
- Deferred tool loading for scale
- Files: 2-3 modified | Tests: concurrency tests, overflow tests

---

## 7. File Impact Summary

| File | Phase | Action |
|------|-------|--------|
| src/tools/tool-types.ts | A | Create |
| src/tools/index.ts | A | Create |
| src/tools/read-state.ts | A | Create |
| src/tools/list-states.ts | A | Create |
| src/tools/write-state.ts | A | Create |
| src/interface/chat/chat-runner.ts | A | Modify (wire tools) |
| src/interface/tui/tool-status.tsx | A | Create |
| src/tools/run-adapter.ts | B | Create |
| src/tools/spawn-session.ts | B | Create |
| src/tools/query-datasource.ts | B | Create |
| src/tools/search-knowledge.ts | B | Create |
| src/tools/write-knowledge.ts | B | Create |
| src/tools/read-pulseed-file.ts | B | Create |
| src/tools/write-pulseed-file.ts | B | Create |
| src/tools/ask-human.ts | B | Create |
| src/tools/create-plan.ts | B | Create |
| src/tools/read-plan.ts | B | Create |
| src/orchestrator/loop/core-loop.ts | C | Modify |
| src/orchestrator/observation/observation-engine.ts | C | Modify |

---

## 8. Test Strategy

- **Unit**: each tool tested independently with mock ToolContext
- **Integration (AgentLoop)**: user input → tool calls → result, end-to-end
- **Integration (CoreLoop)**: CoreLoop with tool layer, full round-trip
- **Concurrency**: parallel read-only tools execute simultaneously; write tools are exclusive
- **Overflow**: results exceeding maxResultSizeChars persisted to disk, preview returned
