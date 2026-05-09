import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { toToolDefinition } from "../../tool-definition-adapter.js";
import { EnvInputSchema, EnvTool } from "../EnvTool/EnvTool.js";
import { GitDiffInputSchema, GitDiffTool } from "../GitDiffTool/GitDiffTool.js";
import { GitLogInputSchema, GitLogTool } from "../GitLogTool/GitLogTool.js";
import { ProcessStatusInputSchema, ProcessStatusTool } from "../ProcessStatusTool/ProcessStatusTool.js";
import { ShellCommandInputSchema, ShellCommandTool } from "../ShellCommandTool/ShellCommandTool.js";
import { ShellInputSchema, ShellTool } from "../ShellTool/ShellTool.js";
import { SleepInputSchema, SleepTool } from "../SleepTool/SleepTool.js";
import { TestRunnerInputSchema, TestRunnerTool } from "../TestRunnerTool/TestRunnerTool.js";
import { UpdatePlanInputSchema, UpdatePlanTool } from "../UpdatePlanTool/UpdatePlanTool.js";

type ToolDefinitionInput = Parameters<typeof toToolDefinition>[0];

interface SystemToolSchemaCase {
  name: string;
  schema: z.ZodTypeAny;
  validInput: Record<string, unknown>;
  tool: ToolDefinitionInput;
}

const SYSTEM_TOOL_SCHEMA_CASES: SystemToolSchemaCase[] = [
  { name: "env_info", schema: EnvInputSchema, validInput: {}, tool: new EnvTool() },
  { name: "git_diff", schema: GitDiffInputSchema, validInput: {}, tool: new GitDiffTool() },
  { name: "git_log", schema: GitLogInputSchema, validInput: {}, tool: new GitLogTool() },
  { name: "process-status", schema: ProcessStatusInputSchema, validInput: { pid: 1 }, tool: new ProcessStatusTool() },
  { name: "shell", schema: ShellInputSchema, validInput: { command: "echo ok" }, tool: new ShellTool() },
  { name: "shell_command", schema: ShellCommandInputSchema, validInput: { command: "echo ok" }, tool: new ShellCommandTool() },
  { name: "sleep", schema: SleepInputSchema, validInput: { durationMs: 100 }, tool: new SleepTool() },
  { name: "test_runner", schema: TestRunnerInputSchema, validInput: {}, tool: new TestRunnerTool() },
  {
    name: "update_plan",
    schema: UpdatePlanInputSchema,
    validInput: { steps: [{ step: "Inspect changed files", status: "pending" }] },
    tool: new UpdatePlanTool(),
  },
];

describe("system tool input schema contracts", () => {
  it.each(SYSTEM_TOOL_SCHEMA_CASES)("$name rejects unknown runtime fields", ({ schema, validInput }) => {
    expect(schema.safeParse(validInput).success).toBe(true);
    expect(schema.safeParse({ ...validInput, unexpected: true }).success).toBe(false);
  });

  it.each(SYSTEM_TOOL_SCHEMA_CASES)("$name exports a closed model-facing schema", ({ tool }) => {
    const parameters = toToolDefinition(tool).function.parameters as Record<string, unknown>;
    expect(parameters.additionalProperties).toBe(false);
  });

  it("keeps update_plan step objects closed in model-facing schema", () => {
    expect(UpdatePlanInputSchema.safeParse({
      steps: [{ step: "Inspect changed files", status: "pending", unexpected: true }],
    }).success).toBe(false);

    const parameters = toToolDefinition(new UpdatePlanTool()).function.parameters as {
      properties?: {
        steps?: {
          items?: {
            additionalProperties?: unknown;
          };
        };
      };
    };

    expect(parameters.properties?.steps?.items?.additionalProperties).toBe(false);
  });
});
