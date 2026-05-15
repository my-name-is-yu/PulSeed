import { describe, expect, it } from "vitest";
import type { z } from "zod/v3";
import { toToolDefinition } from "../../tool-definition-adapter.js";
import { ApplyPatchInputSchema, ApplyPatchTool } from "../ApplyPatchTool/ApplyPatchTool.js";
import { FileEditInputSchema, FileEditTool } from "../FileEditTool/FileEditTool.js";
import { FileWriteInputSchema, FileWriteTool } from "../FileWriteTool/FileWriteTool.js";
import { WritePulseedFileInputSchema, WritePulseedFileTool } from "../WritePulseedFileTool/WritePulseedFileTool.js";

type ToolDefinitionInput = Parameters<typeof toToolDefinition>[0];

interface MutationToolSchemaCase {
  name: string;
  schema: z.ZodTypeAny;
  validInput: Record<string, unknown>;
  tool: ToolDefinitionInput;
}

const MUTATION_TOOL_SCHEMA_CASES: MutationToolSchemaCase[] = [
  { name: "apply_patch", schema: ApplyPatchInputSchema, validInput: { patch: "diff --git a/file b/file" }, tool: new ApplyPatchTool() },
  {
    name: "file_edit",
    schema: FileEditInputSchema,
    validInput: { path: "file.txt", oldText: "before", newText: "after" },
    tool: new FileEditTool(),
  },
  { name: "file_write", schema: FileWriteInputSchema, validInput: { path: "file.txt", content: "body" }, tool: new FileWriteTool() },
  {
    name: "write-pulseed-file",
    schema: WritePulseedFileInputSchema,
    validInput: { path: "config.json", content: "{}" },
    tool: new WritePulseedFileTool(),
  },
];

describe("file mutation tool input schema contracts", () => {
  it.each(MUTATION_TOOL_SCHEMA_CASES)("$name rejects unknown runtime fields", ({ schema, validInput }) => {
    expect(schema.safeParse(validInput).success).toBe(true);
    expect(schema.safeParse({ ...validInput, unexpected: true }).success).toBe(false);
  });

  it.each(MUTATION_TOOL_SCHEMA_CASES)("$name exports a closed model-facing schema", ({ tool }) => {
    const parameters = toToolDefinition(tool).function.parameters as Record<string, unknown>;
    expect(parameters.additionalProperties).toBe(false);
  });
});
