import { describe, expect, it } from "vitest";
import type { z } from "zod";
import type { StateManager } from "../../../base/state/state-manager.js";
import type { KnowledgeManager } from "../../../platform/knowledge/knowledge-manager.js";
import { toToolDefinition } from "../../tool-definition-adapter.js";
import type { ITool } from "../../types.js";
import {
  GoalStateInputSchema,
  GoalStateTool,
} from "../GoalStateTool/GoalStateTool.js";
import {
  KnowledgeQueryInputSchema,
  KnowledgeQueryTool,
} from "../KnowledgeQueryTool/KnowledgeQueryTool.js";
import {
  MemoryRecallInputSchema,
  MemoryRecallTool,
} from "../MemoryRecallTool/MemoryRecallTool.js";
import {
  ProgressHistoryInputSchema,
  ProgressHistoryTool,
} from "../ProgressHistoryTool/ProgressHistoryTool.js";
import {
  SessionHistoryInputSchema,
  SessionHistoryTool,
} from "../SessionHistoryTool/SessionHistoryTool.js";
import {
  TaskGetInputSchema,
  TaskGetTool,
} from "../TaskGetTool/TaskGetTool.js";
import {
  TaskListInputSchema,
  TaskListTool,
} from "../TaskListTool/TaskListTool.js";
import {
  TrustStateInputSchema,
  TrustStateTool,
} from "../TrustStateTool/TrustStateTool.js";

interface StateQueryToolSchemaCase {
  name: string;
  schema: z.ZodTypeAny;
  validInput: Record<string, unknown>;
  tool: ITool;
}

const stateManager = {} as unknown as StateManager;
const knowledgeManager = {} as unknown as KnowledgeManager;

const STATE_QUERY_TOOL_SCHEMA_CASES: StateQueryToolSchemaCase[] = [
  {
    name: "goal_state",
    schema: GoalStateInputSchema,
    validInput: { goalId: "goal-1", includeTree: true },
    tool: new GoalStateTool(stateManager),
  },
  {
    name: "task_list",
    schema: TaskListInputSchema,
    validInput: { goalId: "goal-1", limit: 10, status: "running" },
    tool: new TaskListTool(stateManager),
  },
  {
    name: "task_get",
    schema: TaskGetInputSchema,
    validInput: { goalId: "goal-1", taskId: "task-1" },
    tool: new TaskGetTool(stateManager),
  },
  {
    name: "trust_state",
    schema: TrustStateInputSchema,
    validInput: { adapterId: "shell" },
    tool: new TrustStateTool(stateManager),
  },
  {
    name: "session_history",
    schema: SessionHistoryInputSchema,
    validInput: { goalId: "goal-1", limit: 5, includeObservations: true },
    tool: new SessionHistoryTool(stateManager),
  },
  {
    name: "progress_history",
    schema: ProgressHistoryInputSchema,
    validInput: { goalId: "goal-1", limit: 10, dimensionName: "accuracy" },
    tool: new ProgressHistoryTool(stateManager),
  },
  {
    name: "knowledge_query",
    schema: KnowledgeQueryInputSchema,
    validInput: { query: "deployment", goalId: "goal-1", limit: 5, type: "keyword" },
    tool: new KnowledgeQueryTool(knowledgeManager),
  },
  {
    name: "memory_recall",
    schema: MemoryRecallInputSchema,
    validInput: { query: "deployment", limit: 10, mode: "keyword" },
    tool: new MemoryRecallTool(knowledgeManager),
  },
];

describe("state query tool input schema contracts", () => {
  it.each(STATE_QUERY_TOOL_SCHEMA_CASES)("$name rejects unknown runtime fields", ({ schema, validInput }) => {
    expect(schema.safeParse(validInput).success).toBe(true);
    expect(schema.safeParse({ ...validInput, unexpected: true }).success).toBe(false);
  });

  it.each(STATE_QUERY_TOOL_SCHEMA_CASES)("$name exports a closed model-facing schema", ({ tool }) => {
    const parameters = toToolDefinition(tool).function.parameters as Record<string, unknown>;
    expect(parameters.additionalProperties).toBe(false);
  });
});
