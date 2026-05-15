import { describe, expect, it } from "vitest";
import type { z } from "zod/v3";
import { toToolDefinition } from "../../tool-definition-adapter.js";
import { CodeReadContextInputSchema, CodeReadContextTool } from "../CodeReadContextTool/CodeReadContextTool.js";
import { CodeSearchRepairInputSchema, CodeSearchRepairTool } from "../CodeSearchRepairTool/CodeSearchRepairTool.js";
import { CodeSearchInputSchema, CodeSearchTool } from "../CodeSearchTool/CodeSearchTool.js";

type ToolDefinitionInput = Parameters<typeof toToolDefinition>[0];

interface CodeIntelligenceToolSchemaCase {
  name: string;
  schema: z.ZodTypeAny;
  validInput: Record<string, unknown>;
  tool: ToolDefinitionInput;
}

const CODE_INTELLIGENCE_TOOL_SCHEMA_CASES: CodeIntelligenceToolSchemaCase[] = [
  {
    name: "code_search",
    schema: CodeSearchInputSchema,
    validInput: { task: "Find the failing test", budget: { maxFiles: 10 } },
    tool: new CodeSearchTool(),
  },
  {
    name: "code_read_context",
    schema: CodeReadContextInputSchema,
    validInput: { queryId: "query-1", candidateIds: ["candidate-1"] },
    tool: new CodeReadContextTool(),
  },
  {
    name: "code_search_repair",
    schema: CodeSearchRepairInputSchema,
    validInput: {
      priorTask: { task: "Fix the failing test", intent: "bugfix" },
      verificationOutput: "FAIL src/example.test.ts > fails",
    },
    tool: new CodeSearchRepairTool(),
  },
];

describe("code intelligence tool input schema contracts", () => {
  it.each(CODE_INTELLIGENCE_TOOL_SCHEMA_CASES)("$name rejects unknown runtime fields", ({ schema, validInput }) => {
    expect(schema.safeParse(validInput).success).toBe(true);
    expect(schema.safeParse({ ...validInput, unexpected: true }).success).toBe(false);
  });

  it.each(CODE_INTELLIGENCE_TOOL_SCHEMA_CASES)("$name exports a closed model-facing schema", ({ tool }) => {
    const parameters = toToolDefinition(tool).function.parameters as Record<string, unknown>;
    expect(parameters.additionalProperties).toBe(false);
  });

  it("keeps code_search budget controls closed", () => {
    expect(CodeSearchInputSchema.safeParse({
      task: "Find the failing test",
      budget: { maxFiles: 10, unexpected: true },
    }).success).toBe(false);

    const parameters = toToolDefinition(new CodeSearchTool()).function.parameters as {
      properties?: {
        budget?: {
          additionalProperties?: unknown;
        };
      };
    };
    expect(parameters.properties?.budget?.additionalProperties).toBe(false);
  });

  it("keeps code_search_repair priorTask controls closed", () => {
    expect(CodeSearchRepairInputSchema.safeParse({
      priorTask: { task: "Fix the failing test", unexpected: true },
      verificationOutput: "FAIL src/example.test.ts > fails",
    }).success).toBe(false);

    const parameters = toToolDefinition(new CodeSearchRepairTool()).function.parameters as {
      properties?: {
        priorTask?: {
          additionalProperties?: unknown;
        };
      };
    };
    expect(parameters.properties?.priorTask?.additionalProperties).toBe(false);
  });
});
