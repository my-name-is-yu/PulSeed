import { describe, expect, it } from "vitest";
import type { z } from "zod";
import type { PluginLoader } from "../../../runtime/plugin-loader.js";
import type { ToolRegistry } from "../../registry.js";
import { toToolDefinition } from "../../tool-definition-adapter.js";
import { ArchitectureTool, ArchitectureToolInputSchema } from "../ArchitectureTool/ArchitectureTool.js";
import { ConfigTool, ConfigToolInputSchema } from "../ConfigTool/ConfigTool.js";
import { PluginStateTool, PluginStateToolInputSchema } from "../PluginStateTool/PluginStateTool.js";
import { SkillSearchTool, SkillSearchInputSchema } from "../SkillSearchTool/SkillSearchTool.js";
import { ToolSearchTool, ToolSearchInputSchema } from "../ToolSearchTool/ToolSearchTool.js";

type ToolDefinitionInput = Parameters<typeof toToolDefinition>[0];

interface QueryMetadataToolSchemaCase {
  name: string;
  schema: z.ZodTypeAny;
  validInput: Record<string, unknown>;
  tool: ToolDefinitionInput;
}

const registryStub = {
  searchTools: () => [],
} as unknown as ToolRegistry;

const pluginLoaderStub = {
  loadAll: async () => [],
} as unknown as PluginLoader;

const QUERY_METADATA_TOOL_SCHEMA_CASES: QueryMetadataToolSchemaCase[] = [
  { name: "get_architecture", schema: ArchitectureToolInputSchema, validInput: {}, tool: new ArchitectureTool() },
  { name: "get_config", schema: ConfigToolInputSchema, validInput: {}, tool: new ConfigTool() },
  { name: "get_plugins", schema: PluginStateToolInputSchema, validInput: {}, tool: new PluginStateTool(pluginLoaderStub) },
  { name: "skill_search", schema: SkillSearchInputSchema, validInput: { query: "planning" }, tool: new SkillSearchTool() },
  { name: "tool_search", schema: ToolSearchInputSchema, validInput: { query: "read" }, tool: new ToolSearchTool(registryStub) },
];

describe("query metadata tool input schema contracts", () => {
  it.each(QUERY_METADATA_TOOL_SCHEMA_CASES)("$name rejects unknown runtime fields", ({ schema, validInput }) => {
    expect(schema.safeParse(validInput).success).toBe(true);
    expect(schema.safeParse({ ...validInput, unexpected: true }).success).toBe(false);
  });

  it.each(QUERY_METADATA_TOOL_SCHEMA_CASES)("$name exports a closed model-facing schema", ({ tool }) => {
    const parameters = toToolDefinition(tool).function.parameters as Record<string, unknown>;
    expect(parameters.additionalProperties).toBe(false);
  });
});
