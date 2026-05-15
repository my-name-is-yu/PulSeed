import { z } from "zod/v3";
import type {
  ITool,
  PermissionCheckResult,
  ToolCallContext,
  ToolDescriptionContext,
  ToolMetadata,
  ToolResult,
} from "../../types.js";
import type { ScheduleEngine } from "../../../runtime/schedule/engine.js";
import type { ScheduleEntry } from "../../../runtime/types/schedule.js";
import { resolveScheduleEntry } from "../../../runtime/schedule/entry-resolver.js";
import type { PersonalAgentRuntimeStore } from "../../../runtime/personal-agent/index.js";
import {
  getPersonalAgentToolTraceBaseDir,
  recordAllowedPersonalAgentToolCall,
  rejectUnapprovedPersonalAgentToolCall,
} from "../../personal-agent-tool-trace.js";
import { DESCRIPTION } from "./prompt.js";
import { TAGS, CATEGORY as _CATEGORY, READ_ONLY, PERMISSION_LEVEL } from "./constants.js";

export const PauseScheduleInputSchema = z.object({
  schedule_id: z.string().min(1),
}).strict();
export type PauseScheduleInput = z.infer<typeof PauseScheduleInputSchema>;

export interface PauseScheduleOutput {
  entry: ScheduleEntry;
}

export class PauseScheduleTool implements ITool<PauseScheduleInput, PauseScheduleOutput> {
  readonly metadata: ToolMetadata = {
    name: "pause_schedule",
    aliases: ["disable_schedule"],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: READ_ONLY,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: 4000,
    tags: [...TAGS],
  };

  readonly inputSchema = PauseScheduleInputSchema;

  constructor(
    private readonly scheduleEngine: ScheduleEngine,
    private readonly personalAgentRuntime?: Pick<PersonalAgentRuntimeStore, "recordTrace">,
  ) {}

  description(_context?: ToolDescriptionContext): string {
    return DESCRIPTION;
  }

  async call(input: PauseScheduleInput, context: ToolCallContext): Promise<ToolResult> {
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
          targetSummary: `Pause schedule ${input.schedule_id}`,
          capabilityRefs: [
            { kind: "capability", ref: "tool:pause_schedule" },
            { kind: "capability", ref: "durable_schedule_state_write" },
          ],
          currentRefs: [{ kind: "schedule", ref: input.schedule_id }],
          denialMessage: "pause_schedule requires approval before mutating durable schedule state.",
        },
      );
      if (denied) return denied;
      await recordAllowedPersonalAgentToolCall(
        traceDeps,
        this.metadata.name,
        input,
        context,
        {
          targetSummary: `Pause schedule ${input.schedule_id}`,
          capabilityRefs: [
            { kind: "capability", ref: "tool:pause_schedule" },
            { kind: "capability", ref: "durable_schedule_state_write" },
          ],
          currentRefs: [{ kind: "schedule", ref: input.schedule_id }],
          outcomeSummary: "pause_schedule was admitted to mutate durable schedule state.",
        },
      );

      const existingEntry = resolveScheduleEntry(this.scheduleEngine.getEntries(), input.schedule_id);
      if (!existingEntry) {
        return {
          success: false,
          data: null,
          summary: `Schedule not found: ${input.schedule_id}`,
          error: `Schedule not found: ${input.schedule_id}`,
          durationMs: Date.now() - startTime,
        };
      }

      const entry = await this.scheduleEngine.updateEntry(existingEntry.id, { enabled: false });
      if (!entry) {
        return {
          success: false,
          data: null,
          summary: `Schedule not found: ${input.schedule_id}`,
          error: `Schedule not found: ${input.schedule_id}`,
          durationMs: Date.now() - startTime,
        };
      }

      return {
        success: true,
        data: { entry },
        summary: `Paused schedule: ${entry.name}`,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: `PauseScheduleTool failed: ${(err as Error).message}`,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(
    _input: PauseScheduleInput,
    context: ToolCallContext,
  ): Promise<PermissionCheckResult> {
    if (context.preApproved) return { status: "allowed" };
    return {
      status: "needs_approval",
      reason: "Pausing a persistent schedule changes background automation and requires approval",
    };
  }

  isConcurrencySafe(_input: PauseScheduleInput): boolean {
    return false;
  }
}
