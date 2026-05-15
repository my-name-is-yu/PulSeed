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

export const DeleteGoalInputSchema = z.object({
  goalId: z.string().min(1, "goalId is required"),
}).strict();
export type DeleteGoalInput = z.infer<typeof DeleteGoalInputSchema>;

export class DeleteGoalTool implements ITool<DeleteGoalInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "delete_goal",
    aliases: ["remove_goal"],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: READ_ONLY,
    isDestructive: true,
    shouldDefer: true,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: 4000,
    tags: [...TAGS],
  };
  readonly inputSchema = DeleteGoalInputSchema;

  constructor(
    private readonly stateManager: StateManager,
    private readonly personalAgentRuntime?: Pick<PersonalAgentRuntimeStore, "recordTrace">,
  ) {}

  description(_context?: ToolDescriptionContext): string {
    return DESCRIPTION;
  }

  async call(input: DeleteGoalInput, context: ToolCallContext): Promise<ToolResult> {
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
          targetSummary: `Delete goal ${input.goalId}`,
          capabilityRefs: [
            { kind: "capability", ref: "tool:delete_goal" },
            { kind: "capability", ref: "durable_goal_state_write" },
          ],
          currentRefs: [{ kind: "goal", ref: input.goalId }],
          denialMessage: "delete_goal requires approval before mutating durable goal state.",
        },
      );
      if (denied) return denied;
      await recordAllowedPersonalAgentToolCall(
        traceDeps,
        this.metadata.name,
        input,
        context,
        {
          targetSummary: `Delete goal ${input.goalId}`,
          capabilityRefs: [
            { kind: "capability", ref: "tool:delete_goal" },
            { kind: "capability", ref: "durable_goal_state_write" },
          ],
          currentRefs: [{ kind: "goal", ref: input.goalId }],
          outcomeSummary: "delete_goal was admitted to mutate durable goal state.",
        },
      );

      const deleted = await this.stateManager.deleteGoal(input.goalId);
      if (!deleted) {
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
        summary: "Goal permanently deleted: " + input.goalId,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: "DeleteGoalTool failed: " + (err as Error).message,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(_input: DeleteGoalInput, context: ToolCallContext): Promise<PermissionCheckResult> {
    if (context.preApproved) return { status: "allowed" };
    return {
      status: "needs_approval",
      reason: "Permanently deleting a goal is irreversible and requires user confirmation",
    };
  }

  isConcurrencySafe(_input?: DeleteGoalInput): boolean {
    return false;
  }
}
