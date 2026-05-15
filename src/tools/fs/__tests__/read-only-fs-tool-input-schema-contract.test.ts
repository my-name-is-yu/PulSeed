import { describe, expect, it } from "vitest";
import type { z } from "zod/v3";
import { toToolDefinition } from "../../tool-definition-adapter.js";
import { GlobInputSchema, GlobTool } from "../GlobTool/GlobTool.js";
import { GrepInputSchema, GrepTool } from "../GrepTool/GrepTool.js";
import { JsonQueryInputSchema, JsonQueryTool } from "../JsonQueryTool/JsonQueryTool.js";
import { ListDirInputSchema, ListDirTool } from "../ListDirTool/ListDirTool.js";
import { ReadPulseedFileInputSchema, ReadPulseedFileTool } from "../ReadPulseedFileTool/ReadPulseedFileTool.js";
import { ReadInputSchema, ReadTool } from "../ReadTool/ReadTool.js";

type ToolDefinitionInput = Parameters<typeof toToolDefinition>[0];

interface FsToolSchemaCase {
  name: string;
  schema: z.ZodTypeAny;
  validInput: Record<string, unknown>;
  tool: ToolDefinitionInput;
}

const FS_TOOL_SCHEMA_CASES: FsToolSchemaCase[] = [
  { name: "glob", schema: GlobInputSchema, validInput: { pattern: "**/*.ts" }, tool: new GlobTool() },
  { name: "grep", schema: GrepInputSchema, validInput: { pattern: "needle" }, tool: new GrepTool() },
  { name: "json_query", schema: JsonQueryInputSchema, validInput: { file_path: "package.json", query: "name" }, tool: new JsonQueryTool() },
  { name: "list_dir", schema: ListDirInputSchema, validInput: { path: "." }, tool: new ListDirTool() },
  { name: "read", schema: ReadInputSchema, validInput: { file_path: "README.md" }, tool: new ReadTool() },
  { name: "read-pulseed-file", schema: ReadPulseedFileInputSchema, validInput: { path: "provider.json" }, tool: new ReadPulseedFileTool() },
];

describe("read-only fs tool input schema contracts", () => {
  it.each(FS_TOOL_SCHEMA_CASES)("$name rejects unknown runtime fields", ({ schema, validInput }) => {
    expect(schema.safeParse(validInput).success).toBe(true);
    expect(schema.safeParse({ ...validInput, unexpected: true }).success).toBe(false);
  });

  it.each(FS_TOOL_SCHEMA_CASES)("$name exports a closed model-facing schema", ({ tool }) => {
    const parameters = toToolDefinition(tool).function.parameters as Record<string, unknown>;
    expect(parameters.additionalProperties).toBe(false);
  });
});
