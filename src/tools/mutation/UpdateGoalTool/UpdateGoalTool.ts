import { z } from "zod/v3";
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

export const UpdateGoalInputSchema = z.object({
  goalId: z.string().min(1, "goalId is required"),
  description: z.string().optional(),
  status: z.enum(["active", "paused", "completed"]).optional(),
}).strict();
export type UpdateGoalInput = z.infer<typeof UpdateGoalInputSchema>;

export class UpdateGoalTool implements ITool<UpdateGoalInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "update_goal",
    aliases: ["edit_goal"],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: READ_ONLY,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: 4000,
    tags: [...TAGS],
  };
  readonly inputSchema = UpdateGoalInputSchema;

  constructor(
    private readonly stateManager: StateManager,
    private readonly personalAgentRuntime?: Pick<PersonalAgentRuntimeStore, "recordTrace">,
  ) {}

  description(_context?: ToolDescriptionContext): string {
    return DESCRIPTION;
  }

  async call(input: UpdateGoalInput, context: ToolCallContext): Promise<ToolResult> {
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
          targetSummary: `Update goal ${input.goalId}`,
          capabilityRefs: [
            { kind: "capability", ref: "tool:update_goal" },
            { kind: "capability", ref: "durable_goal_state_write" },
          ],
          currentRefs: [{ kind: "goal", ref: input.goalId }],
          denialMessage: "update_goal requires approval before mutating durable goal state.",
        },
      );
      if (denied) return denied;
      await recordAllowedPersonalAgentToolCall(
        traceDeps,
        this.metadata.name,
        input,
        context,
        {
          targetSummary: `Update goal ${input.goalId}`,
          capabilityRefs: [
            { kind: "capability", ref: "tool:update_goal" },
            { kind: "capability", ref: "durable_goal_state_write" },
          ],
          currentRefs: [{ kind: "goal", ref: input.goalId }],
          outcomeSummary: "update_goal was admitted to mutate durable goal state.",
        },
      );

      const goal = await this.stateManager.loadGoal(input.goalId);
      if (!goal) {
        return {
          success: false,
          data: null,
          summary: "Goal not found: " + input.goalId,
          error: "Goal not found: " + input.goalId,
          durationMs: Date.now() - startTime,
        };
      }

      const updated = { ...goal, updated_at: new Date().toISOString() };
      if (input.description !== undefined) updated.description = input.description;
      if (input.status !== undefined) (updated as Record<string, unknown>).status = input.status;

      await this.stateManager.saveGoal(updated);
      return {
        success: true,
        data: { goalId: input.goalId },
        summary: "Goal updated: " + input.goalId,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: "UpdateGoalTool failed: " + (err as Error).message,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(_input: UpdateGoalInput, context?: ToolCallContext): Promise<PermissionCheckResult> {
    return context?.preApproved
      ? { status: "allowed" }
      : { status: "needs_approval", reason: "update_goal mutates durable goal state" };
  }

  isConcurrencySafe(_input?: UpdateGoalInput): boolean {
    return false;
  }
}
