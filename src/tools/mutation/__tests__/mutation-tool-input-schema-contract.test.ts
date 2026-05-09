import { describe, expect, it } from "vitest";
import type { z } from "zod";
import type { StateManager } from "../../../base/state/state-manager.js";
import type { TrustManager } from "../../../platform/traits/trust-manager.js";
import { toToolDefinition } from "../../tool-definition-adapter.js";
import { ArchiveGoalInputSchema, ArchiveGoalTool } from "../ArchiveGoalTool/ArchiveGoalTool.js";
import {
  ConfigureNotificationRoutingInputSchema,
  ConfigureNotificationRoutingTool,
} from "../ConfigureNotificationRoutingTool/ConfigureNotificationRoutingTool.js";
import { DeleteGoalInputSchema, DeleteGoalTool } from "../DeleteGoalTool/DeleteGoalTool.js";
import { ResetTrustInputSchema, ResetTrustTool } from "../ResetTrustTool/ResetTrustTool.js";
import { SetGoalInputSchema, SetGoalTool } from "../SetGoalTool/SetGoalTool.js";
import { TaskCreateInputSchema, TaskCreateTool } from "../TaskCreateTool/TaskCreateTool.js";
import { TaskOutputInputSchema, TaskOutputTool } from "../TaskOutputTool/TaskOutputTool.js";
import { TaskStopInputSchema, TaskStopTool } from "../TaskStopTool/TaskStopTool.js";
import { TaskUpdateInputSchema, TaskUpdateTool } from "../TaskUpdateTool/TaskUpdateTool.js";
import { TogglePluginInputSchema, TogglePluginTool } from "../TogglePluginTool/TogglePluginTool.js";
import { UpdateConfigInputSchema, UpdateConfigTool } from "../UpdateConfigTool/UpdateConfigTool.js";
import { UpdateGoalInputSchema, UpdateGoalTool } from "../UpdateGoalTool/UpdateGoalTool.js";

type ToolDefinitionInput = Parameters<typeof toToolDefinition>[0];

interface MutationToolSchemaCase {
  name: string;
  schema: z.ZodTypeAny;
  validInput: Record<string, unknown>;
  tool: ToolDefinitionInput;
}

const stateManagerStub = {} as unknown as StateManager;
const trustManagerStub = {} as unknown as TrustManager;

const MUTATION_TOOL_SCHEMA_CASES: MutationToolSchemaCase[] = [
  {
    name: "archive_goal",
    schema: ArchiveGoalInputSchema,
    validInput: { goalId: "goal-1" },
    tool: new ArchiveGoalTool(stateManagerStub),
  },
  {
    name: "configure_notification_routing",
    schema: ConfigureNotificationRoutingInputSchema,
    validInput: { instruction: "Send weekly reports to Discord" },
    tool: new ConfigureNotificationRoutingTool(),
  },
  {
    name: "delete_goal",
    schema: DeleteGoalInputSchema,
    validInput: { goalId: "goal-1" },
    tool: new DeleteGoalTool(stateManagerStub),
  },
  {
    name: "reset_trust",
    schema: ResetTrustInputSchema,
    validInput: { domain: "filesystem", balance: 0 },
    tool: new ResetTrustTool(trustManagerStub),
  },
  {
    name: "set_goal",
    schema: SetGoalInputSchema,
    validInput: { description: "Improve PulSeed quality" },
    tool: new SetGoalTool(stateManagerStub),
  },
  {
    name: "task_create",
    schema: TaskCreateInputSchema,
    validInput: {
      goalId: "goal-1",
      targetDimensions: ["quality"],
      primaryDimension: "quality",
      work_description: "Run focused regression tests",
    },
    tool: new TaskCreateTool(stateManagerStub),
  },
  {
    name: "task_output",
    schema: TaskOutputInputSchema,
    validInput: { goalId: "goal-1", taskId: "task-1", content: "Completed focused tests." },
    tool: new TaskOutputTool(stateManagerStub),
  },
  {
    name: "task_stop",
    schema: TaskStopInputSchema,
    validInput: { goalId: "goal-1", taskId: "task-1" },
    tool: new TaskStopTool(stateManagerStub),
  },
  {
    name: "task_update",
    schema: TaskUpdateInputSchema,
    validInput: { goalId: "goal-1", taskId: "task-1", status: "running" },
    tool: new TaskUpdateTool(stateManagerStub),
  },
  {
    name: "toggle_plugin",
    schema: TogglePluginInputSchema,
    validInput: { pluginId: "plugin-1", enabled: true },
    tool: new TogglePluginTool(),
  },
  {
    name: "update_config",
    schema: UpdateConfigInputSchema,
    validInput: { key: "runtime.maxConcurrency", value: 2 },
    tool: new UpdateConfigTool(),
  },
  {
    name: "update_goal",
    schema: UpdateGoalInputSchema,
    validInput: { goalId: "goal-1", status: "active" },
    tool: new UpdateGoalTool(stateManagerStub),
  },
];

describe("mutation tool input schema contracts", () => {
  it.each(MUTATION_TOOL_SCHEMA_CASES)("$name rejects unknown runtime fields", ({ schema, validInput }) => {
    expect(schema.safeParse(validInput).success).toBe(true);
    expect(schema.safeParse({ ...validInput, unexpected: true }).success).toBe(false);
  });

  it.each(MUTATION_TOOL_SCHEMA_CASES)("$name exports a closed model-facing schema", ({ tool }) => {
    const parameters = toToolDefinition(tool).function.parameters as Record<string, unknown>;
    expect(parameters.additionalProperties).toBe(false);
  });

  it.each([
    {
      schema: TaskCreateInputSchema,
      baseInput: {
        goalId: "goal-1",
        targetDimensions: ["quality"],
        primaryDimension: "quality",
        work_description: "Run focused regression tests",
      },
    },
    {
      schema: TaskUpdateInputSchema,
      baseInput: {
        goalId: "goal-1",
        taskId: "task-1",
      },
    },
  ])(
    "rejects unknown fields inside nested task mutation inputs",
    ({ schema, baseInput }) => {
      expect(schema.safeParse({
        ...baseInput,
        success_criteria: [{
          description: "Focused tests pass",
          verification_method: "vitest",
          unexpected: true,
        }],
      }).success).toBe(false);

      expect(schema.safeParse({
        ...baseInput,
        scope_boundary: {
          in_scope: ["runtime validation"],
          out_of_scope: ["release"],
          blast_radius: "tools only",
          unexpected: true,
        },
      }).success).toBe(false);

      expect(schema.safeParse({
        ...baseInput,
        estimated_duration: {
          value: 1,
          unit: "hours",
          unexpected: true,
        },
      }).success).toBe(false);
    }
  );
});
