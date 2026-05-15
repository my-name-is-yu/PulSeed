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
import { DESCRIPTION } from "./prompt.js";
import { TAGS, CATEGORY as _CATEGORY, READ_ONLY, PERMISSION_LEVEL } from "./constants.js";

const BaseCreateScheduleInputSchema = z.object({
  name: z.string().min(1, "name is required"),
  trigger: ScheduleToolTriggerInputSchema,
  enabled: z.boolean().default(true),
  escalation: ScheduleToolEscalationConfigInputSchema.optional(),
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

  constructor(private readonly scheduleEngine: ScheduleEngine) {}

  description(_context?: ToolDescriptionContext): string {
    return DESCRIPTION;
  }

  async call(input: CreateScheduleInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();

    try {
      const entry = await this.scheduleEngine.addEntry(
        "preset" in input ? buildSchedulePresetEntry(input) : input
      );

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
    _context: ToolCallContext,
  ): Promise<PermissionCheckResult> {
    return {
      status: "needs_approval",
      reason: "Creating a persistent schedule changes background automation and requires approval",
    };
  }

  isConcurrencySafe(_input: CreateScheduleInput): boolean {
    return false;
  }
}
