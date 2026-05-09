import { describe, it, expect, vi } from "vitest";
import {
  CreateScheduleTool,
  CreateScheduleInputSchema,
  type CreateScheduleOutput,
} from "../CreateScheduleTool/CreateScheduleTool.js";
import { toToolDefinition } from "../../tool-definition-adapter.js";
import type { ToolCallContext } from "../../types.js";
import type { ScheduleEngine } from "../../../runtime/schedule-engine.js";
import { ScheduleEntrySchema } from "../../../runtime/types/schedule.js";

function makeContext(overrides: Partial<ToolCallContext> = {}): ToolCallContext {
  return {
    cwd: "/tmp",
    goalId: "test-goal",
    trustBalance: 50,
    preApproved: false,
    approvalFn: async () => false,
    ...overrides,
  };
}

function makeScheduleEntry() {
  return ScheduleEntrySchema.parse({
    id: "11111111-1111-4111-8111-111111111111",
    name: "daily digest",
    layer: "cron",
    trigger: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
    enabled: true,
    cron: {
      prompt_template: "Summarize the latest activity.",
      context_sources: ["memory://daily"],
      output_format: "notification",
      max_tokens: 1200,
    },
    escalation: {
      enabled: true,
      target_layer: "goal_trigger",
      target_entry_id: "22222222-2222-4222-8222-222222222222",
      cooldown_minutes: 15,
      max_per_hour: 4,
      circuit_breaker_threshold: 10,
    },
    baseline_results: [],
    created_at: "2026-04-08T00:00:00.000Z",
    updated_at: "2026-04-08T00:00:00.000Z",
    last_fired_at: null,
    next_fire_at: "2026-04-09T09:00:00.000Z",
    consecutive_failures: 0,
    last_escalation_at: null,
    escalation_timestamps: [],
    total_executions: 0,
    total_tokens_used: 0,
    max_tokens_per_day: 100000,
    tokens_used_today: 0,
    budget_reset_at: null,
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function findSchema(
  value: unknown,
  predicate: (schema: Record<string, unknown>) => boolean
): Record<string, unknown> | null {
  const record = asRecord(value);
  if (record && predicate(record)) return record;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findSchema(item, predicate);
      if (found) return found;
    }
    return null;
  }
  if (record) {
    for (const item of Object.values(record)) {
      const found = findSchema(item, predicate);
      if (found) return found;
    }
  }
  return null;
}

function resolveJsonSchemaRef(root: unknown, schema: unknown): Record<string, unknown> {
  let current: unknown = schema;
  const seen = new Set<string>();
  while (true) {
    const record = asRecord(current);
    const ref = typeof record?.["$ref"] === "string" ? record["$ref"] : null;
    if (!ref) {
      if (!record) throw new Error("schema node is not an object");
      return record;
    }
    if (seen.has(ref)) throw new Error(`circular schema ref: ${ref}`);
    seen.add(ref);
    current = resolveJsonPointer(root, ref);
  }
}

function resolveJsonPointer(root: unknown, ref: string): unknown {
  if (!ref.startsWith("#/")) throw new Error(`unsupported schema ref: ${ref}`);
  return ref.slice(2).split("/").reduce((current: unknown, token) => {
    const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
    return asRecord(current)?.[key] ?? (Array.isArray(current) ? current[Number(key)] : undefined);
  }, root);
}

describe("CreateScheduleTool", () => {
  it("has correct metadata", () => {
    const tool = new CreateScheduleTool({ addEntry: vi.fn() } as unknown as ScheduleEngine);

    expect(tool.metadata.name).toBe("create_schedule");
    expect(tool.metadata.permissionLevel).toBe("write_local");
    expect(tool.metadata.isReadOnly).toBe(false);
    expect(tool.metadata.isDestructive).toBe(false);
    expect(tool.metadata.tags).toContain("schedule");
  });

  it("description returns non-empty string", () => {
    const tool = new CreateScheduleTool({ addEntry: vi.fn() } as unknown as ScheduleEngine);

    expect(tool.description()).toBeTruthy();
  });

  it("checkPermissions returns needs_approval", async () => {
    const tool = new CreateScheduleTool({ addEntry: vi.fn() } as unknown as ScheduleEngine);
    const input = CreateScheduleInputSchema.parse({
      name: "heartbeat check",
      layer: "heartbeat",
      trigger: { type: "interval", seconds: 30 },
      heartbeat: {
        check_type: "http",
        check_config: { url: "https://example.com/health" },
      },
    });

    const result = await tool.checkPermissions(input, makeContext());

    expect(result.status).toBe("needs_approval");
    if (result.status === "needs_approval") {
      expect(result.reason).toContain("persistent schedule");
    }
  });

  it("isConcurrencySafe returns false", () => {
    const tool = new CreateScheduleTool({ addEntry: vi.fn() } as unknown as ScheduleEngine);
    const input = CreateScheduleInputSchema.parse({
      name: "probe watcher",
      layer: "probe",
      trigger: { type: "interval", seconds: 60 },
      probe: {
        data_source_id: "source-1",
        query_params: {},
        change_detector: { mode: "presence", baseline_window: 5 },
      },
    });

    expect(tool.isConcurrencySafe(input)).toBe(false);
  });

  it("applies enabled=true by default at schema level", () => {
    const parsed = CreateScheduleInputSchema.parse({
      name: "daily digest",
      layer: "cron",
      trigger: { type: "cron", expression: "0 9 * * *" },
      cron: {
        prompt_template: "Summarize the latest activity.",
      },
    });

    expect(parsed.enabled).toBe(true);
  });

  it("rejects mismatched layer and config at schema level", () => {
    const parsed = CreateScheduleInputSchema.safeParse({
      name: "bad input",
      layer: "heartbeat",
      trigger: { type: "interval", seconds: 15 },
      probe: {
        data_source_id: "source-1",
        query_params: {},
        change_detector: { mode: "presence", baseline_window: 5 },
      },
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects heartbeat check_config payloads that do not match check_type", () => {
    expect(CreateScheduleInputSchema.safeParse({
      name: "bad http heartbeat",
      layer: "heartbeat",
      trigger: { type: "interval", seconds: 15 },
      heartbeat: {
        check_type: "http",
        check_config: { command: "curl https://example.com" },
      },
    }).success).toBe(false);

    expect(CreateScheduleInputSchema.safeParse({
      name: "bad process heartbeat",
      layer: "heartbeat",
      trigger: { type: "interval", seconds: 15 },
      heartbeat: {
        check_type: "process",
        check_config: { pid: Number.MAX_SAFE_INTEGER + 1 },
      },
    }).success).toBe(false);

    expect(CreateScheduleInputSchema.safeParse({
      name: "bad tcp heartbeat",
      layer: "heartbeat",
      trigger: { type: "interval", seconds: 15 },
      heartbeat: {
        check_type: "tcp",
        check_config: { host: "127.0.0.1", port: 70_000 },
      },
    }).success).toBe(false);

    expect(CreateScheduleInputSchema.safeParse({
      name: "tcp heartbeat",
      layer: "heartbeat",
      trigger: { type: "interval", seconds: 15 },
      heartbeat: {
        check_type: "tcp",
        check_config: { host: "127.0.0.1", port: 443 },
      },
    }).success).toBe(true);
  });

  it("exports union branch contracts to the model-facing tool definition", () => {
    const tool = new CreateScheduleTool({ addEntry: vi.fn() } as unknown as ScheduleEngine);
    const parameters = toToolDefinition(tool).function.parameters;
    const branchSchema = parameters.anyOf ?? parameters.oneOf ?? parameters.allOf;

    expect(parameters.type).toBe("object");
    expect(Array.isArray(branchSchema)).toBe(true);
    expect(JSON.stringify(parameters)).toContain("\"preset\"");
    expect(JSON.stringify(parameters)).toContain("\"layer\"");
    expect(JSON.stringify(parameters)).toContain("\"daily_brief\"");
    expect(JSON.stringify(parameters)).toContain("\"heartbeat\"");
    expect(JSON.stringify(parameters)).toContain("\"check_config\"");
    expect(JSON.stringify(parameters)).toContain("\"url\"");
    expect(JSON.stringify(parameters)).toContain("\"pid\"");

    const processHeartbeatSchema = findSchema(parameters, (schema) => {
      const properties = asRecord(schema["properties"]);
      const checkType = asRecord(properties?.["check_type"]);
      const checkConfig = asRecord(properties?.["check_config"]);
      const checkConfigProperties = asRecord(checkConfig?.["properties"]);
      const checkTypeEnum = checkType?.["enum"];
      return Array.isArray(checkTypeEnum) &&
        checkTypeEnum.includes("process") &&
        checkConfigProperties?.["pid"] !== undefined;
    });
    expect(processHeartbeatSchema).not.toBeNull();

    const heartbeatProperties = asRecord(processHeartbeatSchema!["properties"])!;
    const checkConfig = asRecord(heartbeatProperties["check_config"])!;
    const checkConfigProperties = asRecord(checkConfig["properties"])!;
    const pidSchema = resolveJsonSchemaRef(parameters, checkConfigProperties["pid"]);
    expect(pidSchema).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
    });
  });

  it("calls scheduleEngine.addEntry with the validated input and returns the entry", async () => {
    const entry = makeScheduleEntry();
    const addEntry = vi.fn().mockResolvedValue(entry);
    const tool = new CreateScheduleTool({ addEntry } as unknown as ScheduleEngine);
    const approvalFn = vi.fn().mockResolvedValue(false);
    const input = CreateScheduleInputSchema.parse({
      name: "daily digest",
      layer: "cron",
      trigger: { type: "cron", expression: "0 9 * * *" },
      cron: {
        prompt_template: "Summarize the latest activity.",
        context_sources: ["memory://daily"],
        output_format: "notification",
        max_tokens: 1200,
      },
      escalation: {
        enabled: true,
        target_layer: "goal_trigger",
        target_entry_id: "22222222-2222-4222-8222-222222222222",
      },
    });

    const result = await tool.call(input, makeContext({ approvalFn }));

    expect(addEntry).toHaveBeenCalledTimes(1);
    expect(addEntry).toHaveBeenCalledWith(input);
    expect(approvalFn).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.summary).toContain("daily digest");
    expect((result.data as CreateScheduleOutput).entry).toEqual(entry);
  });

  it("expands preset inputs before calling scheduleEngine.addEntry", async () => {
    const entry = makeScheduleEntry();
    const addEntry = vi.fn().mockResolvedValue(entry);
    const tool = new CreateScheduleTool({ addEntry } as unknown as ScheduleEngine);
    const input = CreateScheduleInputSchema.parse({
      preset: "daily_brief",
    });

    const result = await tool.call(input, makeContext());

    expect(addEntry).toHaveBeenCalledTimes(1);
    expect(addEntry).toHaveBeenCalledWith(expect.objectContaining({
      name: "Daily brief",
      layer: "cron",
      metadata: expect.objectContaining({
        source: "preset",
        preset_key: "daily_brief",
      }),
      cron: expect.objectContaining({
        job_kind: "reflection",
        reflection_kind: "morning_planning",
      }),
    }));
    expect(result.success).toBe(true);
  });

  it("returns a failure result when scheduleEngine.addEntry throws", async () => {
    const addEntry = vi.fn().mockRejectedValue(new Error("disk full"));
    const tool = new CreateScheduleTool({ addEntry } as unknown as ScheduleEngine);
    const input = CreateScheduleInputSchema.parse({
      name: "goal resume",
      layer: "goal_trigger",
      trigger: { type: "interval", seconds: 300 },
      enabled: false,
      goal_trigger: {
        goal_id: "goal-123",
        max_iterations: 3,
        skip_if_active: true,
      },
    });

    const result = await tool.call(input, makeContext());

    expect(result.success).toBe(false);
    expect(result.error).toBe("disk full");
    expect(result.summary).toContain("disk full");
  });
});
