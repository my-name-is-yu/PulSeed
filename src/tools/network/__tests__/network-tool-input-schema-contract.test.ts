import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { toToolDefinition } from "../../tool-definition-adapter.js";
import { HttpFetchInputSchema, HttpFetchTool } from "../HttpFetchTool/HttpFetchTool.js";
import { McpCallToolInputSchema, McpCallToolTool, McpListToolsInputSchema, McpListToolsTool } from "../McpStdioTool/McpStdioTool.js";
import { WebSearchInputSchema, WebSearchTool, type ISearchClient } from "../WebSearchTool/WebSearchTool.js";

type ToolDefinitionInput = Parameters<typeof toToolDefinition>[0];

interface NetworkToolSchemaCase {
  name: string;
  schema: z.ZodTypeAny;
  validInput: Record<string, unknown>;
  tool: ToolDefinitionInput;
}

const searchClientStub: ISearchClient = {
  search: vi.fn().mockResolvedValue([]),
};

const NETWORK_TOOL_SCHEMA_CASES: NetworkToolSchemaCase[] = [
  { name: "http_fetch", schema: HttpFetchInputSchema, validInput: { url: "https://example.com" }, tool: new HttpFetchTool() },
  { name: "mcp_call_tool", schema: McpCallToolInputSchema, validInput: { command: "node", tool_name: "tool" }, tool: new McpCallToolTool() },
  { name: "mcp_list_tools", schema: McpListToolsInputSchema, validInput: { command: "node" }, tool: new McpListToolsTool() },
  { name: "web_search", schema: WebSearchInputSchema, validInput: { query: "TypeScript" }, tool: new WebSearchTool(searchClientStub) },
];

describe("network tool input schema contracts", () => {
  it.each(NETWORK_TOOL_SCHEMA_CASES)("$name rejects unknown runtime fields", ({ schema, validInput }) => {
    expect(schema.safeParse(validInput).success).toBe(true);
    expect(schema.safeParse({ ...validInput, unexpected: true }).success).toBe(false);
  });

  it.each(NETWORK_TOOL_SCHEMA_CASES)("$name exports a closed model-facing schema", ({ tool }) => {
    const parameters = toToolDefinition(tool).function.parameters as Record<string, unknown>;
    expect(parameters.additionalProperties).toBe(false);
  });
});
