import { z } from "zod";
import type { ITool, ToolResult, ToolCallContext, PermissionCheckResult, ToolMetadata, ToolDescriptionContext } from "../../types.js";
import type { StateManager } from "../../../base/state/state-manager.js";
import type { PersonalAgentRuntimeStore } from "../../../runtime/personal-agent/index.js";
import {
  getPersonalAgentToolTraceBaseDir,
  recordAllowedPersonalAgentToolCall,
  rejectUnapprovedPersonalAgentToolCall,
} from "../../personal-agent-tool-trace.js";
import { DESCRIPTION } from "./prompt.js";
import { TAGS, CATEGORY as _CATEGORY, READ_ONLY, PERMISSION_LEVEL } from "./constants.js";

export const ArchiveGoalInputSchema = z.object({
  goalId: z.string().min(1, "goalId is required"),
  reason: z.string().optional(),
}).strict();
export type ArchiveGoalInput = z.infer<typeof ArchiveGoalInputSchema>;

export class ArchiveGoalTool implements ITool<ArchiveGoalInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "archive_goal",
    aliases: ["complete_goal"],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: READ_ONLY,
    isDestructive: false,
    shouldDefer: true,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: 4000,
    tags: [...TAGS],
  };
  readonly inputSchema = ArchiveGoalInputSchema;

  constructor(
    private readonly stateManager: StateManager,
    private readonly personalAgentRuntime?: Pick<PersonalAgentRuntimeStore, "recordTrace">,
  ) {}

  description(_context?: ToolDescriptionContext): string {
    return DESCRIPTION;
  }

  async call(input: ArchiveGoalInput, context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const traceDeps = {
        personalAgentRuntime: this.personalAgentRuntime,
        baseDir: getPersonalAgentToolTraceBaseDir(this.stateManager),
      };
      const denied = await rejectUnapprovedPersonalAgentToolCall(
        traceDeps,
        this.metadata.name,
        input,
        context,
        startTime,
        {
          targetSummary: `Archive goal ${input.goalId}`,
          capabilityRefs: [
            { kind: "capability", ref: "tool:archive_goal" },
            { kind: "capability", ref: "durable_goal_state_write" },
          ],
          currentRefs: [{ kind: "goal", ref: input.goalId }],
          denialMessage: "archive_goal requires approval before mutating durable goal state.",
        },
      );
      if (denied) return denied;
      await recordAllowedPersonalAgentToolCall(
        traceDeps,
        this.metadata.name,
        input,
        context,
        {
          targetSummary: `Archive goal ${input.goalId}`,
          capabilityRefs: [
            { kind: "capability", ref: "tool:archive_goal" },
            { kind: "capability", ref: "durable_goal_state_write" },
          ],
          currentRefs: [{ kind: "goal", ref: input.goalId }],
          outcomeSummary: "archive_goal was admitted to mutate durable goal state.",
        },
      );

      const archived = await this.stateManager.archiveGoal(input.goalId);
      if (!archived) {
        return {
          success: false,
          data: null,
          summary: "Goal not found: " + input.goalId,
          error: "Goal not found: " + input.goalId,
          durationMs: Date.now() - startTime,
        };
      }
      return {
        success: true,
        data: { goalId: input.goalId },
        summary: "Goal archived: " + input.goalId,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: "ArchiveGoalTool failed: " + (err as Error).message,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(_input: ArchiveGoalInput, context: ToolCallContext): Promise<PermissionCheckResult> {
    if (context.preApproved) return { status: "allowed" };
    return { status: "needs_approval", reason: "Archiving a goal requires user confirmation" };
  }

  isConcurrencySafe(_input?: ArchiveGoalInput): boolean {
    return false;
  }
}
