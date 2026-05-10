import { describe, expect, it } from "vitest";
import { toToolDefinition } from "../../../../tools/tool-definition-adapter.js";
import {
  createDurableLoopControlTools,
  type DurableLoopControlToolset,
} from "../durable-loop-control-tools.js";

function makeControlTools(service?: Partial<DurableLoopControlToolset>) {
  return createDurableLoopControlTools({
    goalStatus: async (input) => ({ goalId: input.goalId }),
    taskPrioritize: async (input) => input,
    runCycle: async (input) => input,
    ...service,
  });
}

function findTool(name: string) {
  const tool = makeControlTools().find((candidate) => candidate.metadata.name === name);
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return tool;
}

function propertySchema(toolName: string, propertyName: string): Record<string, unknown> {
  const parameters = toToolDefinition(findTool(toolName)).function.parameters as {
    properties?: Record<string, unknown>;
  };
  const property = parameters.properties?.[propertyName];
  if (!property || typeof property !== "object" || Array.isArray(property)) {
    throw new Error(`Property schema not found: ${toolName}.${propertyName}`);
  }
  return property as Record<string, unknown>;
}

describe("DurableLoop control tools", () => {
  it("rejects non-finite and unsafe task priority inputs", () => {
    const tool = findTool("core_task_prioritize");
    const validInput = { goalId: "goal-1", taskId: "task-1", priority: Number.MAX_SAFE_INTEGER };

    expect(tool.inputSchema.safeParse(validInput).success).toBe(true);
    expect(tool.inputSchema.safeParse({ ...validInput, priority: Infinity }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ ...validInput, priority: -Infinity }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ ...validInput, priority: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
  });

  it("rejects non-finite and unsafe run cycle iteration counts", () => {
    const tool = findTool("core_run_cycle");
    const validInput = { goalId: "goal-1", maxIterations: Number.MAX_SAFE_INTEGER };

    expect(tool.inputSchema.safeParse(validInput).success).toBe(true);
    expect(tool.inputSchema.safeParse({ goalId: "goal-1", maxIterations: 0 }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ goalId: "goal-1", maxIterations: 1.5 }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ goalId: "goal-1", maxIterations: Infinity }).success).toBe(false);
    expect(tool.inputSchema.safeParse({ goalId: "goal-1", maxIterations: Number.MAX_SAFE_INTEGER + 1 }).success).toBe(false);
  });

  it("exports safe numeric boundaries in model-facing tool schemas", () => {
    expect(propertySchema("core_task_prioritize", "priority")).toMatchObject({
      type: "number",
      minimum: -Number.MAX_SAFE_INTEGER,
      maximum: Number.MAX_SAFE_INTEGER,
    });
    expect(propertySchema("core_run_cycle", "maxIterations")).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
    });
  });
});
