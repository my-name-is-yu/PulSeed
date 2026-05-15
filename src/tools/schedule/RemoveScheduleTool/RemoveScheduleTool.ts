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
import { resolveScheduleEntry } from "../../../runtime/schedule/entry-resolver.js";
import type { PersonalAgentRuntimeStore } from "../../../runtime/personal-agent/index.js";
import {
  getPersonalAgentToolTraceBaseDir,
  recordAllowedPersonalAgentToolCall,
  rejectUnapprovedPersonalAgentToolCall,
} from "../../personal-agent-tool-trace.js";
import { DESCRIPTION } from "./prompt.js";
import { TAGS, CATEGORY as _CATEGORY, READ_ONLY, PERMISSION_LEVEL } from "./constants.js";

export const RemoveScheduleInputSchema = z.object({
  schedule_id: z.string().min(1),
}).strict();
export type RemoveScheduleInput = z.infer<typeof RemoveScheduleInputSchema>;

export interface RemoveScheduleOutput {
  removed: true;
  entry: {
    id: string;
    name: string;
  };
}

export class RemoveScheduleTool implements ITool<RemoveScheduleInput, RemoveScheduleOutput> {
  readonly metadata: ToolMetadata = {
    name: "remove_schedule",
    aliases: ["delete_schedule"],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: READ_ONLY,
    isDestructive: true,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: 4000,
    tags: [...TAGS],
  };

  readonly inputSchema = RemoveScheduleInputSchema;

  constructor(
    private readonly scheduleEngine: ScheduleEngine,
    private readonly personalAgentRuntime?: Pick<PersonalAgentRuntimeStore, "recordTrace">,
  ) {}

  description(_context?: ToolDescriptionContext): string {
    return DESCRIPTION;
  }

  async call(input: RemoveScheduleInput, context: ToolCallContext): Promise<ToolResult> {
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
          targetSummary: `Remove schedule ${input.schedule_id}`,
          capabilityRefs: [
            { kind: "capability", ref: "tool:remove_schedule" },
            { kind: "capability", ref: "durable_schedule_state_write" },
          ],
          currentRefs: [{ kind: "schedule", ref: input.schedule_id }],
          denialMessage: "remove_schedule requires approval before mutating durable schedule state.",
        },
      );
      if (denied) return denied;
      await recordAllowedPersonalAgentToolCall(
        traceDeps,
        this.metadata.name,
        input,
        context,
        {
          targetSummary: `Remove schedule ${input.schedule_id}`,
          capabilityRefs: [
            { kind: "capability", ref: "tool:remove_schedule" },
            { kind: "capability", ref: "durable_schedule_state_write" },
          ],
          currentRefs: [{ kind: "schedule", ref: input.schedule_id }],
          outcomeSummary: "remove_schedule was admitted to mutate durable schedule state.",
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

      const removed = await this.scheduleEngine.removeEntry(existingEntry.id);
      if (!removed) {
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
        data: {
          removed: true,
          entry: {
            id: existingEntry.id,
            name: existingEntry.name,
          },
        },
        summary: `Removed schedule: ${existingEntry.name}`,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: `RemoveScheduleTool failed: ${(err as Error).message}`,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(
    _input: RemoveScheduleInput,
    context: ToolCallContext,
  ): Promise<PermissionCheckResult> {
    if (context.preApproved) return { status: "allowed" };
    return {
      status: "needs_approval",
      reason: "Removing a persistent schedule is irreversible and requires approval",
    };
  }

  isConcurrencySafe(_input: RemoveScheduleInput): boolean {
    return false;
  }
}
