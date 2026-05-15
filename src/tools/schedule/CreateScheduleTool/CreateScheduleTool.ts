import { z } from "zod/v3";
import type {
  ITool,
  ToolResult,
  ToolCallContext,
  PermissionCheckResult,
  ToolMetadata,
  ToolDescriptionContext,
} from "../../types.js";
import type { ScheduleEngine } from "../../../runtime/schedule/engine.js";
import type { ScheduleEntry } from "../../../runtime/types/schedule.js";
import {
  stableId,
  type PersonalAgentRuntimeStore,
} from "../../../runtime/personal-agent/index.js";
import {
  buildSchedulePresetEntry,
} from "../../../runtime/schedule/presets.js";
import {
  ScheduleToolCronConfigInputSchema,
  ScheduleToolEscalationConfigInputSchema,
  ScheduleToolGoalTriggerConfigInputSchema,
  ScheduleToolHeartbeatConfigInputSchema,
  ScheduleToolPresetInputSchema,
  ScheduleToolProbeConfigInputSchema,
  ScheduleToolTriggerInputSchema,
} from "../schedule-tool-input-schemas.js";
import {
  getPersonalAgentToolTraceBaseDir,
  recordAllowedPersonalAgentToolCall,
  rejectUnapprovedPersonalAgentToolCall,
} from "../../personal-agent-tool-trace.js";
import { DESCRIPTION } from "./prompt.js";
import { TAGS, CATEGORY as _CATEGORY, READ_ONLY, PERMISSION_LEVEL } from "./constants.js";

const BaseCreateScheduleInputSchema = z.object({
  name: z.string().min(1, "name is required"),
  trigger: ScheduleToolTriggerInputSchema,
  enabled: z.boolean().default(true),
  escalation: ScheduleToolEscalationConfigInputSchema.optional(),
  metadata: z.object({
    source: z.enum(["manual", "dream"]).default("manual"),
    dream_suggestion_id: z.string().optional(),
    dependency_hints: z.array(z.string()).default([]),
    note: z.string().optional(),
  }).strict().optional(),
}).strict();

const ExplicitCreateScheduleInputSchema = z.discriminatedUnion("layer", [
  BaseCreateScheduleInputSchema.extend({
    layer: z.literal("heartbeat"),
    heartbeat: ScheduleToolHeartbeatConfigInputSchema,
  }).strict(),
  BaseCreateScheduleInputSchema.extend({
    layer: z.literal("probe"),
    probe: ScheduleToolProbeConfigInputSchema,
  }).strict(),
  BaseCreateScheduleInputSchema.extend({
    layer: z.literal("cron"),
    cron: ScheduleToolCronConfigInputSchema,
  }).strict(),
  BaseCreateScheduleInputSchema.extend({
    layer: z.literal("goal_trigger"),
    goal_trigger: ScheduleToolGoalTriggerConfigInputSchema,
  }).strict(),
]);

export const CreateScheduleInputSchema = z.union([
  ExplicitCreateScheduleInputSchema,
  ScheduleToolPresetInputSchema,
]);

export type CreateScheduleInput = z.infer<typeof CreateScheduleInputSchema>;

export interface CreateScheduleOutput {
  entry: ScheduleEntry;
}

export class CreateScheduleTool implements ITool<CreateScheduleInput, CreateScheduleOutput> {
  readonly metadata: ToolMetadata = {
    name: "create_schedule",
    aliases: [],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: READ_ONLY,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: 4000,
    tags: [...TAGS],
  };

  readonly inputSchema = CreateScheduleInputSchema;

  constructor(
    private readonly scheduleEngine: ScheduleEngine,
    private readonly personalAgentRuntime?: Pick<PersonalAgentRuntimeStore, "recordTrace">,
  ) {}

  description(_context?: ToolDescriptionContext): string {
    return DESCRIPTION;
  }

  async call(input: CreateScheduleInput, context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();

    try {
      const traceDeps = {
        personalAgentRuntime: this.personalAgentRuntime,
        baseDir: getPersonalAgentToolTraceBaseDir(this.scheduleEngine),
      };
      const denied = await rejectUnapprovedPersonalAgentToolCall(
        traceDeps,
        this.metadata.name,
        input,
        context,
        startTime,
        {
          targetSummary: "Create persistent schedule",
          capabilityRefs: [
            { kind: "capability", ref: "tool:create_schedule" },
            { kind: "capability", ref: "durable_schedule_state_write" },
          ],
          denialMessage: "create_schedule requires approval before mutating durable schedule state.",
        },
      );
      if (denied) return denied;
      await recordAllowedPersonalAgentToolCall(
        traceDeps,
        this.metadata.name,
        input,
        context,
        {
          targetSummary: "Create persistent schedule",
          capabilityRefs: [
            { kind: "capability", ref: "tool:create_schedule" },
            { kind: "capability", ref: "durable_schedule_state_write" },
          ],
          outcomeSummary: "create_schedule was admitted to mutate durable schedule state.",
        },
      );

      const entryInput = attachCreateScheduleReplayKey(
        "preset" in input ? buildSchedulePresetEntry(input) : input,
        input,
        context,
      );
      const entry = await this.scheduleEngine.addEntry(entryInput);

      return {
        success: true,
        data: { entry },
        summary: `Created schedule: ${entry.name} (${entry.layer})`,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: "CreateScheduleTool failed: " + (err as Error).message,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(
    _input: CreateScheduleInput,
    context: ToolCallContext,
  ): Promise<PermissionCheckResult> {
    return context.preApproved
      ? { status: "allowed" }
      : {
          status: "needs_approval",
          reason: "Creating a persistent schedule changes background automation and requires approval",
        };
  }

  isConcurrencySafe(_input: CreateScheduleInput): boolean {
    return false;
  }
}

type ScheduleAddEntryInput = Parameters<ScheduleEngine["addEntry"]>[0];

function attachCreateScheduleReplayKey(
  entryInput: ScheduleAddEntryInput,
  originalInput: CreateScheduleInput,
  context: ToolCallContext,
): ScheduleAddEntryInput {
  const replayKey = createScheduleReplayKey(originalInput, context);
  return {
    ...entryInput,
    metadata: {
      source: "preset" in originalInput ? "preset" : "manual",
      dependency_hints: [],
      ...entryInput.metadata,
      personal_agent_replay_key: replayKey,
    },
  };
}

function createScheduleReplayKey(input: CreateScheduleInput, context: ToolCallContext): string {
  const sourceReplayKey = context.personalAgentTrace?.replayKey
    ?? [
      "tool",
      "create_schedule",
      stableJson(input),
      context.conversationSessionId ?? context.sessionId ?? "session:none",
      context.turnId ?? context.callId ?? context.cwd,
    ].join(":");
  return `create_schedule:${stableId(sourceReplayKey)}`;
}

function stableJson(value: unknown): string {
  return JSON.stringify(normalizeForStableJson(value));
}

function normalizeForStableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeForStableJson(item));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, normalizeForStableJson(record[key])]),
    );
  }
  return value;
}
