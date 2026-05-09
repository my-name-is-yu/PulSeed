import { z } from "zod";
import type {
  ITool,
  PermissionCheckResult,
  ToolCallContext,
  ToolDescriptionContext,
  ToolMetadata,
  ToolResult,
} from "../../types.js";
import type { StateManager } from "../../../base/state/state-manager.js";
import type { Task } from "../../../base/types/task.js";
import { TAGS, PERMISSION_LEVEL, MAX_OUTPUT_CHARS } from "./constants.js";
import { DESCRIPTION } from "./prompt.js";

export const TaskListInputSchema = z.object({
  goalId: z.string(),
  limit: z.number().int().positive().max(100).default(10),
  status: z.string().optional(),
});
export type TaskListInput = z.infer<typeof TaskListInputSchema>;

interface TaskListItem {
  id: string;
  goalId: string;
  status: string;
  category: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  verificationVerdict?: string;
  workDescription: string;
  primaryDimension: string;
}

export class TaskListTool implements ITool<TaskListInput, { tasks: TaskListItem[]; totalFound: number }> {
  readonly metadata: ToolMetadata = {
    name: "task_list",
    aliases: ["get_task_list", "observe_tasks"],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 0,
    maxOutputChars: MAX_OUTPUT_CHARS,
    tags: [...TAGS],
  };

  readonly inputSchema = TaskListInputSchema;

  constructor(private readonly stateManager: StateManager) {}

  description(_context?: ToolDescriptionContext): string {
    return DESCRIPTION;
  }

  async call(input: TaskListInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const tasks = await this.loadTasks(input.goalId);
      const filtered = input.status
        ? tasks.filter((task) => task.status === input.status)
        : tasks;
      const sorted = [...filtered].sort((a, b) => b.created_at.localeCompare(a.created_at));
      const limited = sorted.slice(0, input.limit).map((task) => this.toSummary(task));
      const suffix = filtered.length > limited.length ? `, showing latest ${limited.length}` : "";

      return {
        success: true,
        data: { tasks: limited, totalFound: filtered.length },
        summary: `Found ${filtered.length} task(s) for goal ${input.goalId}${suffix}`,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: `TaskListTool failed: ${(err as Error).message}`,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  private async loadTasks(goalId: string): Promise<Task[]> {
    return this.stateManager.listTasks(goalId);
  }

  private toSummary(task: Task): TaskListItem {
    return {
      id: task.id,
      goalId: task.goal_id,
      status: task.status,
      category: task.task_category,
      createdAt: task.created_at,
      startedAt: task.started_at,
      completedAt: task.completed_at,
      verificationVerdict: task.verification_verdict,
      workDescription: task.work_description,
      primaryDimension: task.primary_dimension,
    };
  }

  async checkPermissions(): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(): boolean {
    return true;
  }
}
