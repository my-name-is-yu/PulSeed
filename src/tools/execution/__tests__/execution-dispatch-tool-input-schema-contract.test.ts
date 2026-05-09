import { describe, expect, it } from "vitest";
import type { z } from "zod";
import type { AdapterRegistry } from "../../../orchestrator/execution/adapter-layer.js";
import type { SessionManager } from "../../../orchestrator/execution/session-manager.js";
import type { ObservationEngine } from "../../../platform/observation/observation-engine.js";
import { toToolDefinition } from "../../tool-definition-adapter.js";
import { QueryDataSourceInputSchema, QueryDataSourceTool } from "../QueryDataSourceTool/QueryDataSourceTool.js";
import { RunAdapterInputSchema, RunAdapterTool } from "../RunAdapterTool/RunAdapterTool.js";
import { SpawnSessionInputSchema, SpawnSessionTool } from "../SpawnSessionTool/SpawnSessionTool.js";

type ToolDefinitionInput = Parameters<typeof toToolDefinition>[0];

interface ExecutionDispatchToolSchemaCase {
  name: string;
  schema: z.ZodTypeAny;
  validInput: Record<string, unknown>;
  tool: ToolDefinitionInput;
}

const adapterRegistryStub = {} as unknown as AdapterRegistry;
const observationEngineStub = {} as unknown as ObservationEngine;
const sessionManagerStub = {} as unknown as SessionManager;

const EXECUTION_DISPATCH_TOOL_SCHEMA_CASES: ExecutionDispatchToolSchemaCase[] = [
  {
    name: "query-data-source",
    schema: QueryDataSourceInputSchema,
    validInput: { goal_id: "goal-1", dimension_name: "accuracy", source_id: "source-1" },
    tool: new QueryDataSourceTool(observationEngineStub),
  },
  {
    name: "run-adapter",
    schema: RunAdapterInputSchema,
    validInput: { adapter_id: "codex", task_description: "Run focused tests" },
    tool: new RunAdapterTool(adapterRegistryStub),
  },
  {
    name: "spawn-session",
    schema: SpawnSessionInputSchema,
    validInput: { session_type: "task_execution", goal_id: "goal-1" },
    tool: new SpawnSessionTool(sessionManagerStub),
  },
];

describe("execution dispatch tool input schema contracts", () => {
  it.each(EXECUTION_DISPATCH_TOOL_SCHEMA_CASES)("$name rejects unknown runtime fields", ({ schema, validInput }) => {
    expect(schema.safeParse(validInput).success).toBe(true);
    expect(schema.safeParse({ ...validInput, unexpected: true }).success).toBe(false);
  });

  it.each(EXECUTION_DISPATCH_TOOL_SCHEMA_CASES)("$name exports a closed model-facing schema", ({ tool }) => {
    const parameters = toToolDefinition(tool).function.parameters as Record<string, unknown>;
    expect(parameters.additionalProperties).toBe(false);
  });
});
