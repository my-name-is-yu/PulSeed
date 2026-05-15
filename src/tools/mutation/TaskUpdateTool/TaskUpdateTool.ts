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
import { CriterionSchema, ScopeBoundarySchema, TaskSchema } from "../../../base/types/task.js";
import { DurationSchema, ReversibilityEnum, TaskStatusEnum, VerdictEnum } from "../../../base/types/core.js";
import type { PersonalAgentRuntimeStore } from "../../../runtime/personal-agent/index.js";
import {
  getPersonalAgentToolTraceBaseDir,
  recordAllowedPersonalAgentToolCall,
  rejectUnapprovedPersonalAgentToolCall,
} from "../../personal-agent-tool-trace.js";
import { upsertTaskHistory } from "../task-history-utils.js";
import { DESCRIPTION } from "./prompt.js";
import { TAGS, READ_ONLY, PERMISSION_LEVEL } from "./constants.js";

const TaskMutationCriterionInputSchema = CriterionSchema.strict();
const TaskMutationScopeBoundaryInputSchema = ScopeBoundarySchema.strict();
const TaskMutationDurationInputSchema = DurationSchema.strict();

export const TaskUpdateInputSchema = z.object({
  goalId: z.string().min(1, "goalId is required"),
  taskId: z.string().min(1, "taskId is required"),
  status: TaskStatusEnum.optional(),
  work_description: z.string().optional(),
  rationale: z.string().optional(),
  approach: z.string().optional(),
  success_criteria: z.array(TaskMutationCriterionInputSchema).optional(),
  scope_boundary: TaskMutationScopeBoundaryInputSchema.optional(),
  constraints: z.array(z.string()).optional(),
  estimated_duration: TaskMutationDurationInputSchema.nullable().optional(),
  plateau_until: z.string().nullable().optional(),
  started_at: z.string().nullable().optional(),
  completed_at: z.string().nullable().optional(),
  timeout_at: z.string().nullable().optional(),
  heartbeat_at: z.string().nullable().optional(),
  consecutive_failure_count: z.number().finite().int().safe().min(0).optional(),
  reversibility: ReversibilityEnum.optional(),
  intended_direction: z.enum(["increase", "decrease", "neutral"]).optional(),
  verification_verdict: VerdictEnum.optional(),
  verification_evidence: z.array(z.string()).optional(),
  verificationVerdict: VerdictEnum.optional(),
  verificationEvidence: z.array(z.string()).optional(),
  appendExecutionOutput: z.string().optional(),
}).strict();
export type TaskUpdateInput = z.infer<typeof TaskUpdateInputSchema>;

const LIFECYCLE_OWNED_SELF_UPDATE_FIELDS = new Set([
  "status",
  "started_at",
  "completed_at",
  "timeout_at",
  "heartbeat_at",
  "consecutive_failure_count",
  "verification_verdict",
  "verification_evidence",
  "verificationVerdict",
  "verificationEvidence",
]);

function lifecycleOwnedSelfUpdateFields(
  input: TaskUpdateInput,
  context: ToolCallContext,
): string[] {
  if (!context.taskId || context.taskId !== input.taskId || context.goalId !== input.goalId) {
    return [];
  }
  return Object.keys(input).filter((key) => LIFECYCLE_OWNED_SELF_UPDATE_FIELDS.has(key));
}

function lifecycleOwnedSelfUpdateReason(fields: readonly string[]): string {
  return `Task lifecycle owns the active task's ${fields.join(", ")} field(s) while the task agent loop is running; return final JSON instead.`;
}

export class TaskUpdateTool implements ITool<TaskUpdateInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "task_update",
    aliases: ["update_task", "edit_task"],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: READ_ONLY,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: 4000,
    tags: [...TAGS],
  };

  readonly inputSchema = TaskUpdateInputSchema;

  constructor(
    private readonly stateManager: StateManager,
    private readonly personalAgentRuntime?: Pick<PersonalAgentRuntimeStore, "recordTrace">,
  ) {}

  description(_context?: ToolDescriptionContext): string {
    return DESCRIPTION;
  }

  async call(input: TaskUpdateInput, context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const ignoredFields = lifecycleOwnedSelfUpdateFields(input, context);
      const effectiveInput: TaskUpdateInput = { ...input };
      for (const field of ignoredFields) {
        delete (effectiveInput as Record<string, unknown>)[field];
      }
      if (ignoredFields.length > 0 && Object.keys(effectiveInput).every((key) => key === "goalId" || key === "taskId")) {
        const reason = lifecycleOwnedSelfUpdateReason(ignoredFields);
        return {
          success: true,
          data: {
            taskId: input.taskId,
            goalId: input.goalId,
            ignoredFields,
            reason,
          },
          summary: `TaskUpdateTool ignored active task lifecycle fields: ${ignoredFields.join(", ")}`,
          durationMs: Date.now() - startTime,
        };
      }

      const traceDeps = {
        personalAgentRuntime: this.personalAgentRuntime,
        baseDir: getPersonalAgentToolTraceBaseDir(this.stateManager),
      };
      const denied = await rejectUnapprovedPersonalAgentToolCall(
        traceDeps,
        this.metadata.name,
        effectiveInput,
        context,
        startTime,
        {
          targetSummary: `Update task ${effectiveInput.taskId} for goal ${effectiveInput.goalId}`,
          capabilityRefs: [
            { kind: "capability", ref: "tool:task_update" },
            { kind: "capability", ref: "durable_task_state_write" },
          ],
          currentRefs: [
            { kind: "goal", ref: effectiveInput.goalId },
            { kind: "task", ref: effectiveInput.taskId },
          ],
          denialMessage: "task_update requires approval before mutating durable task state.",
        },
      );
      if (denied) return denied;
      await recordAllowedPersonalAgentToolCall(
        traceDeps,
        this.metadata.name,
        effectiveInput,
        context,
        {
          targetSummary: `Update task ${effectiveInput.taskId} for goal ${effectiveInput.goalId}`,
          capabilityRefs: [
            { kind: "capability", ref: "tool:task_update" },
            { kind: "capability", ref: "durable_task_state_write" },
          ],
          currentRefs: [
            { kind: "goal", ref: effectiveInput.goalId },
            { kind: "task", ref: effectiveInput.taskId },
          ],
          outcomeSummary: "task_update was admitted to mutate durable task state.",
        },
      );

      const raw = await this.stateManager.loadTask(effectiveInput.goalId, effectiveInput.taskId);
      if (raw == null) {
        return {
          success: false,
          data: null,
          summary: `Task not found: ${effectiveInput.taskId} for goal ${effectiveInput.goalId}`,
          error: `Task not found: ${effectiveInput.taskId} for goal ${effectiveInput.goalId}`,
          durationMs: Date.now() - startTime,
        };
      }

      const parsed = TaskSchema.safeParse(raw);
      if (!parsed.success) {
        return {
          success: false,
          data: null,
          summary: `Task parse failed: ${effectiveInput.taskId}`,
          error: parsed.error.message,
          durationMs: Date.now() - startTime,
        };
      }

      const updates = Object.fromEntries(
        Object.entries(effectiveInput).filter(([key, value]) => key !== "goalId" && key !== "taskId" && value !== undefined)
      );

      if (updates["verificationVerdict"] !== undefined) {
        updates["verification_verdict"] = updates["verificationVerdict"];
        delete updates["verificationVerdict"];
      }
      if (updates["verificationEvidence"] !== undefined) {
        updates["verification_evidence"] = updates["verificationEvidence"];
        delete updates["verificationEvidence"];
      }

      const existingOutput = parsed.data.execution_output ?? "";
      if (typeof updates["appendExecutionOutput"] === "string") {
        const appended = `${existingOutput}${updates["appendExecutionOutput"]}`;
        updates["execution_output"] = appended.slice(-2000);
        delete updates["appendExecutionOutput"];
      }

      if (updates["status"] === "running" && parsed.data.started_at == null && updates["started_at"] === undefined) {
        updates["started_at"] = new Date().toISOString();
      }
      if (
        (updates["status"] === "completed" || updates["status"] === "error" || updates["status"] === "timed_out") &&
        parsed.data.completed_at == null &&
        updates["completed_at"] === undefined
      ) {
        updates["completed_at"] = new Date().toISOString();
      }
      if (updates["status"] === "timed_out" && parsed.data.timeout_at == null && updates["timeout_at"] === undefined) {
        updates["timeout_at"] = new Date().toISOString();
      }

      const updatedTask = TaskSchema.parse({
        ...parsed.data,
        ...updates,
      });

      await this.stateManager.saveTask(updatedTask);
      await upsertTaskHistory(this.stateManager, updatedTask);

      return {
        success: true,
        data: {
          taskId: updatedTask.id,
          goalId: updatedTask.goal_id,
          status: updatedTask.status,
          verification_verdict: updatedTask.verification_verdict,
        },
        summary: `Task updated: ${updatedTask.id} (${updatedTask.status})`,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: `TaskUpdateTool failed: ${(err as Error).message}`,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(input: TaskUpdateInput, context: ToolCallContext): Promise<PermissionCheckResult> {
    const ignoredFields = lifecycleOwnedSelfUpdateFields(input, context);
    const effectiveInput: TaskUpdateInput = { ...input };
    for (const field of ignoredFields) {
      delete (effectiveInput as Record<string, unknown>)[field];
    }
    if (ignoredFields.length > 0 && Object.keys(effectiveInput).every((key) => key === "goalId" || key === "taskId")) {
      return { status: "allowed" };
    }
    return context.preApproved
      ? { status: "allowed" }
      : { status: "needs_approval", reason: "task_update mutates durable task state" };
  }

  isConcurrencySafe(): boolean {
    return false;
  }
}
