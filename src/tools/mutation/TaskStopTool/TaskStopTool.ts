import { z } from "zod/v3";
import type {
  ITool,
  PermissionCheckResult,
  ToolCallContext,
  ToolDescriptionContext,
  ToolMetadata,
  ToolResult,
} from "../../types.js";
import type { StateManager } from "../../../base/state/state-manager.js";
import { TaskSchema } from "../../../base/types/task.js";
import { appendTaskOutcomeEvent } from "../../../orchestrator/execution/task/task-outcome-ledger.js";
import type { PersonalAgentRuntimeStore } from "../../../runtime/personal-agent/index.js";
import {
  getPersonalAgentToolTraceBaseDir,
  recordAllowedPersonalAgentToolCall,
  rejectUnapprovedPersonalAgentToolCall,
} from "../../personal-agent-tool-trace.js";
import { upsertTaskHistory } from "../task-history-utils.js";
import { DESCRIPTION } from "./prompt.js";
import { TAGS, READ_ONLY, PERMISSION_LEVEL } from "./constants.js";

export const TaskStopInputSchema = z.object({
  goalId: z.string().min(1, "goalId is required"),
  taskId: z.string().min(1, "taskId is required"),
  reason: z.string().default("Stopped manually"),
}).strict();
export type TaskStopInput = z.infer<typeof TaskStopInputSchema>;

export class TaskStopTool implements ITool<TaskStopInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "task_stop",
    aliases: ["stop_task", "cancel_task"],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: READ_ONLY,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: 4000,
    tags: [...TAGS],
  };

  readonly inputSchema = TaskStopInputSchema;

  constructor(
    private readonly stateManager: StateManager,
    private readonly personalAgentRuntime?: Pick<PersonalAgentRuntimeStore, "recordTrace">,
  ) {}

  description(_context?: ToolDescriptionContext): string {
    return DESCRIPTION;
  }

  async call(input: TaskStopInput, context: ToolCallContext): Promise<ToolResult> {
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
          targetSummary: `Stop task ${input.taskId} for goal ${input.goalId}`,
          capabilityRefs: [
            { kind: "capability", ref: "tool:task_stop" },
            { kind: "capability", ref: "durable_task_state_write" },
          ],
          currentRefs: [
            { kind: "goal", ref: input.goalId },
            { kind: "task", ref: input.taskId },
          ],
          denialMessage: "task_stop requires approval before mutating durable task state.",
        },
      );
      if (denied) return denied;
      await recordAllowedPersonalAgentToolCall(
        traceDeps,
        this.metadata.name,
        input,
        context,
        {
          targetSummary: `Stop task ${input.taskId} for goal ${input.goalId}`,
          capabilityRefs: [
            { kind: "capability", ref: "tool:task_stop" },
            { kind: "capability", ref: "durable_task_state_write" },
          ],
          currentRefs: [
            { kind: "goal", ref: input.goalId },
            { kind: "task", ref: input.taskId },
          ],
          outcomeSummary: "task_stop was admitted to mutate durable task state.",
        },
      );

      const raw = await this.stateManager.loadTask(input.goalId, input.taskId);
      if (raw == null) {
        return {
          success: false,
          data: null,
          summary: `Task not found: ${input.taskId} for goal ${input.goalId}`,
          error: `Task not found: ${input.taskId} for goal ${input.goalId}`,
          durationMs: Date.now() - startTime,
        };
      }

      const parsed = TaskSchema.safeParse(raw);
      if (!parsed.success) {
        return {
          success: false,
          data: null,
          summary: `Task parse failed: ${input.taskId}`,
          error: parsed.error.message,
          durationMs: Date.now() - startTime,
        };
      }

      const existingOutput = parsed.data.execution_output?.trim();
      const stopLine = `[STOPPED] ${input.reason}`;
      const now = new Date().toISOString();
      const updatedTask = TaskSchema.parse({
        ...parsed.data,
        status: "error",
        completed_at: parsed.data.completed_at ?? now,
        timeout_at: parsed.data.timeout_at ?? null,
        execution_output: existingOutput ? `${existingOutput}\n\n${stopLine}` : stopLine,
      });

      await this.stateManager.saveTask(updatedTask);
      await appendTaskOutcomeEvent(this.stateManager, {
        task: updatedTask,
        type: "abandoned",
        action: "stop",
        reason: input.reason,
        stoppedReason: "cancelled",
      });
      await upsertTaskHistory(this.stateManager, updatedTask);

      return {
        success: true,
        data: {
          taskId: updatedTask.id,
          goalId: updatedTask.goal_id,
          status: updatedTask.status,
        },
        summary: `Task stopped: ${updatedTask.id}`,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: `TaskStopTool failed: ${(err as Error).message}`,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(_input: TaskStopInput, context: ToolCallContext): Promise<PermissionCheckResult> {
    return context.preApproved
      ? { status: "allowed" }
      : { status: "needs_approval", reason: "task_stop mutates durable task state" };
  }

  isConcurrencySafe(): boolean {
    return false;
  }
}
