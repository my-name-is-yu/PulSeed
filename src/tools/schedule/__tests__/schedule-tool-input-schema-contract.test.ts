import { describe, expect, it } from "vitest";
import {
  CreateScheduleInputSchema,
  CreateScheduleTool,
} from "../CreateScheduleTool/CreateScheduleTool.js";
import {
  GetScheduleInputSchema,
  GetScheduleTool,
} from "../GetScheduleTool/GetScheduleTool.js";
import {
  ListSchedulesInputSchema,
  ListSchedulesTool,
} from "../ListSchedulesTool/ListSchedulesTool.js";
import {
  PauseScheduleInputSchema,
  PauseScheduleTool,
} from "../PauseScheduleTool/PauseScheduleTool.js";
import {
  RemoveScheduleInputSchema,
  RemoveScheduleTool,
} from "../RemoveScheduleTool/RemoveScheduleTool.js";
import {
  ResumeScheduleInputSchema,
  ResumeScheduleTool,
} from "../ResumeScheduleTool/ResumeScheduleTool.js";
import {
  RunScheduleInputSchema,
  RunScheduleTool,
} from "../RunScheduleTool/RunScheduleTool.js";
import {
  UpdateScheduleInputSchema,
  UpdateScheduleTool,
} from "../UpdateScheduleTool/UpdateScheduleTool.js";
import { toToolDefinition } from "../../tool-definition-adapter.js";
import type { ITool } from "../../types.js";
import type { ScheduleEngine } from "../../../runtime/schedule-engine.js";
import type { z } from "zod";

type JsonObject = Record<string, unknown>;

const scheduleEngine = {} as unknown as ScheduleEngine;

function asRecord(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function collectSchemaObjects(value: unknown, output: JsonObject[] = []): JsonObject[] {
  const record = asRecord(value);
  if (record) {
    output.push(record);
    for (const child of Object.values(record)) {
      collectSchemaObjects(child, output);
    }
    return output;
  }

  if (Array.isArray(value)) {
    for (const child of value) {
      collectSchemaObjects(child, output);
    }
  }

  return output;
}

function propertyNames(schema: JsonObject): string[] {
  const properties = asRecord(schema.properties);
  return properties ? Object.keys(properties) : [];
}

function assertRuntimeRejectsUnknownField<T extends z.ZodTypeAny>(
  schema: T,
  validInput: z.input<T>,
): void {
  expect(schema.safeParse(validInput).success).toBe(true);
  expect(schema.safeParse({ ...validInput, unexpected: true }).success).toBe(false);
}

function assertModelFacingSchemaClosed(tool: ITool): void {
  const parameters = toToolDefinition(tool).function.parameters as JsonObject;
  expect(parameters.additionalProperties).toBe(false);
}

describe("schedule tool input schema contract", () => {
  it("rejects unknown top-level runtime fields", () => {
    const cases: Array<[z.ZodTypeAny, JsonObject]> = [
      [
        CreateScheduleInputSchema,
        {
          name: "heartbeat",
          layer: "heartbeat",
          trigger: { type: "interval", seconds: 60 },
          heartbeat: {
            check_type: "http",
            check_config: { url: "https://example.com/health" },
          },
        },
      ],
      [CreateScheduleInputSchema, { preset: "daily_brief" }],
      [GetScheduleInputSchema, { schedule_id: "schedule-1" }],
      [ListSchedulesInputSchema, { layer: "cron", due_only: true }],
      [PauseScheduleInputSchema, { schedule_id: "schedule-1" }],
      [RemoveScheduleInputSchema, { schedule_id: "schedule-1" }],
      [ResumeScheduleInputSchema, { schedule_id: "schedule-1" }],
      [RunScheduleInputSchema, { schedule_id: "schedule-1", allow_escalation: true }],
      [
        UpdateScheduleInputSchema,
        {
          schedule_id: "schedule-1",
          trigger: { type: "interval", seconds: 60 },
        },
      ],
    ];

    for (const [schema, input] of cases) {
      assertRuntimeRejectsUnknownField(schema, input);
    }
  });

  it("rejects unknown nested runtime fields for schedule config payloads", () => {
    expect(CreateScheduleInputSchema.safeParse({
      name: "heartbeat",
      layer: "heartbeat",
      trigger: { type: "interval", seconds: 60, unexpected: true },
      heartbeat: {
        check_type: "http",
        check_config: { url: "https://example.com/health" },
      },
    }).success).toBe(false);

    expect(CreateScheduleInputSchema.safeParse({
      name: "heartbeat",
      layer: "heartbeat",
      trigger: { type: "interval", seconds: 60 },
      heartbeat: {
        check_type: "http",
        check_config: { url: "https://example.com/health", unexpected: true },
        unexpected: true,
      },
    }).success).toBe(false);

    expect(CreateScheduleInputSchema.safeParse({
      name: "cron",
      layer: "cron",
      trigger: { type: "cron", expression: "0 9 * * *" },
      cron: {
        prompt_template: "Summarize updates.",
        unexpected: true,
      },
    }).success).toBe(false);

    expect(CreateScheduleInputSchema.safeParse({
      name: "probe",
      layer: "probe",
      trigger: { type: "interval", seconds: 60 },
      probe: {
        data_source_id: "source-1",
        change_detector: { mode: "presence", unexpected: true },
      },
    }).success).toBe(false);

    expect(UpdateScheduleInputSchema.safeParse({
      schedule_id: "schedule-1",
      escalation: { enabled: true, unexpected: true },
    }).success).toBe(false);

    expect(CreateScheduleInputSchema.safeParse({
      preset: "daily_brief",
      trigger: { type: "interval", seconds: 3600, unexpected: true },
    }).success).toBe(false);
  });

  it("exports closed model-facing schemas for schedule tool inputs", () => {
    const tools = [
      new GetScheduleTool(scheduleEngine),
      new ListSchedulesTool(scheduleEngine),
      new PauseScheduleTool(scheduleEngine),
      new RemoveScheduleTool(scheduleEngine),
      new ResumeScheduleTool(scheduleEngine),
      new RunScheduleTool(scheduleEngine),
      new UpdateScheduleTool(scheduleEngine),
    ];

    for (const tool of tools) {
      assertModelFacingSchemaClosed(tool);
    }
  });

  it("exports closed model-facing branches for create_schedule inputs", () => {
    const parameters = toToolDefinition(new CreateScheduleTool(scheduleEngine)).function
      .parameters as JsonObject;
    const objectSchemas = collectSchemaObjects(parameters);
    const branchSchemas = objectSchemas.filter((schema) => {
      const names = propertyNames(schema);
      return names.includes("layer") || names.includes("preset");
    });
    const nestedPayloadSchemas = objectSchemas.filter((schema) => {
      const names = propertyNames(schema);
      return (
        names.includes("check_type") ||
        names.includes("check_config") ||
        names.includes("expression") ||
        names.includes("seconds") ||
        names.includes("change_detector") ||
        names.includes("prompt_template") ||
        names.includes("goal_id")
      );
    });

    expect(branchSchemas.length).toBeGreaterThan(0);
    expect(nestedPayloadSchemas.length).toBeGreaterThan(0);

    for (const schema of [...branchSchemas, ...nestedPayloadSchemas]) {
      expect(schema.additionalProperties).toBe(false);
    }
  });
});
