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
import {
  CriterionSchema,
  ScopeBoundarySchema,
  TaskArtifactContractSchema,
  TaskRiskProfileSchema,
  TaskSchema,
} from "../../../base/types/task.js";
import { DurationSchema, ReversibilityEnum } from "../../../base/types/core.js";
import { DESCRIPTION } from "./prompt.js";
import { TAGS, READ_ONLY, PERMISSION_LEVEL } from "./constants.js";
import {
  PersonalAgentRuntimeStore,
  buildPersonalAgentDecisionTrace,
  stableId,
  type InterventionDecisionKind,
} from "../../../runtime/personal-agent/index.js";

const TaskMutationCriterionInputSchema = CriterionSchema.strict();
const TaskMutationScopeBoundaryInputSchema = ScopeBoundarySchema.strict();
const TaskMutationDurationInputSchema = DurationSchema.strict();

export const TaskCreateInputSchema = z.object({
  goalId: z.string().min(1, "goalId is required"),
  strategyId: z.string().nullable().optional(),
  targetDimensions: z.array(z.string()).min(1, "at least one target dimension is required"),
  primaryDimension: z.string().min(1, "primaryDimension is required"),
  work_description: z.string().min(1, "work_description is required"),
  rationale: z.string().default("Created manually via task_create"),
  approach: z.string().default("Delegate to a sub-agent and record results back into the task."),
  success_criteria: z.array(TaskMutationCriterionInputSchema).default([]),
  scope_boundary: TaskMutationScopeBoundaryInputSchema.default({
    in_scope: [],
    out_of_scope: [],
    blast_radius: "unknown",
  }),
  constraints: z.array(z.string()).default([]),
  risk_profile: TaskRiskProfileSchema.optional(),
  artifact_contract: TaskArtifactContractSchema.optional(),
  reversibility: ReversibilityEnum.default("unknown"),
  intended_direction: z.enum(["increase", "decrease", "neutral"]).optional(),
  estimated_duration: TaskMutationDurationInputSchema.nullable().default(null),
  task_category: z
    .enum(["normal", "knowledge_acquisition", "verification", "observation", "capability_acquisition"])
    .default("normal"),
}).strict();
export type TaskCreateInput = z.infer<typeof TaskCreateInputSchema>;

export class TaskCreateTool implements ITool<TaskCreateInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "task_create",
    aliases: ["create_task"],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: READ_ONLY,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 1,
    maxOutputChars: 4000,
    tags: [...TAGS],
  };

  readonly inputSchema = TaskCreateInputSchema;

  constructor(
    private readonly stateManager: StateManager,
    private readonly personalAgentRuntime?: Pick<PersonalAgentRuntimeStore, "recordTrace">,
  ) {}

  description(_context?: ToolDescriptionContext): string {
    return DESCRIPTION;
  }

  async call(input: TaskCreateInput, _context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const normalized = this.inputSchema.parse(input);
      const now = new Date().toISOString();
      const taskId = taskCreateId(normalized, _context);
      if (!_context.preApproved) {
        await this.recordTaskDecision(normalized, _context, {
          taskId,
          now,
          decision: "confirm_required",
          reason: "Task creation requires InterventionPolicy confirmation before durable task state is mutated.",
        });
        return {
          success: false,
          data: null,
          summary: "Task creation requires approval before execution.",
          execution: {
            status: "not_executed",
            reason: "permission_denied",
            message: "task_create requires approval before creating a durable task.",
          },
          durationMs: Date.now() - startTime,
        };
      }
      await this.recordTaskDecision(normalized, _context, {
        taskId,
        now,
        decision: "allow",
        reason: "Task creation was allowed by InterventionPolicy after Capability Registry confirmed durable task write capability.",
      });
      const existing = typeof this.stateManager.loadTask === "function"
        ? await this.stateManager.loadTask(normalized.goalId, taskId).catch(() => null)
        : null;
      if (existing) {
        return {
          success: true,
          data: {
            taskId: existing.id,
            goalId: existing.goal_id,
            status: existing.status,
          },
          summary: `Task already exists: ${existing.id}`,
          durationMs: Date.now() - startTime,
        };
      }
      const task = TaskSchema.parse({
        id: taskId,
        goal_id: normalized.goalId,
        strategy_id: normalized.strategyId ?? null,
        target_dimensions: normalized.targetDimensions,
        primary_dimension: normalized.primaryDimension,
        work_description: normalized.work_description,
        rationale: normalized.rationale,
        approach: normalized.approach,
        success_criteria: normalized.success_criteria,
        scope_boundary: normalized.scope_boundary,
        constraints: normalized.constraints,
        risk_profile: normalized.risk_profile,
        artifact_contract: normalized.artifact_contract,
        reversibility: normalized.reversibility,
        intended_direction: normalized.intended_direction,
        estimated_duration: normalized.estimated_duration,
        task_category: normalized.task_category,
        status: "pending",
        created_at: now,
      });

      await this.stateManager.saveTask(task);

      return {
        success: true,
        data: {
          taskId: task.id,
          goalId: task.goal_id,
          status: task.status,
        },
        summary: `Task created: ${task.id}`,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: `TaskCreateTool failed: ${(err as Error).message}`,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(_input: TaskCreateInput, context: ToolCallContext): Promise<PermissionCheckResult> {
    return context.preApproved
      ? { status: "allowed" }
      : { status: "needs_approval", reason: "task_create creates durable task state" };
  }

  isConcurrencySafe(): boolean {
    return false;
  }

  private async recordTaskDecision(
    input: TaskCreateInput,
    context: ToolCallContext,
    decision: {
      taskId: string;
      now: string;
      decision: InterventionDecisionKind;
      reason: string;
    },
  ): Promise<void> {
    const baseDir = typeof this.stateManager.getBaseDir === "function" ? this.stateManager.getBaseDir() : null;
    const store = this.personalAgentRuntime
      ?? (baseDir ? new PersonalAgentRuntimeStore(baseDir, { controlBaseDir: baseDir }) : null);
    if (!store) return;
    const traceContext = context.personalAgentTrace;
    await store.recordTrace(buildPersonalAgentDecisionTrace({
      callerPath: traceContext?.callerPath ?? "explicit_user_command",
      source: {
        sourceKind: traceContext?.sourceKind ?? "explicit_command",
        sourceId: traceContext?.sourceId ?? context.callId ?? context.turnId ?? decision.taskId,
        emittedAt: decision.now,
        sourceEpoch: traceContext?.sourceEpoch ?? context.turnId ?? context.callId ?? "tool-call",
        highWatermark: traceContext?.highWatermark ?? input.goalId,
        replayKey: traceContext?.replayKey
          ? `${traceContext.replayKey}:task-materialization`
          : taskCreateReplayKey(input, context),
        summary: traceContext?.summary ?? "task_create requested durable task creation.",
        sourceRef: traceContext?.sourceRef ?? { kind: "tool_call", ref: context.callId ?? "task_create" },
      },
      target: {
        kind: "task",
        ref: { kind: "task", ref: decision.taskId },
        effect: "create_task",
        summary: input.work_description,
      },
      decision: decision.decision,
      decisionReason: decision.reason,
      capabilityDecision: decision.decision === "allow" ? "available" : "permission_required",
      capabilityRefs: [{ kind: "capability", ref: "durable_task_state_write" }],
      policyRef: { kind: "intervention_policy", ref: "policy:tool-materialization-v1" },
      permissionRequired: decision.decision !== "allow",
      currentRefs: [
        { kind: "goal", ref: input.goalId },
        { kind: "tool_call", ref: "task_create" },
      ],
      auditRefs: [
        { kind: "tool_call", ref: context.callId ?? "task_create" },
        ...(context.turnId ? [{ kind: "turn", ref: context.turnId }] : []),
        ...(traceContext?.auditRefs ?? []),
      ],
      ...(decision.decision === "allow"
        ? {
            outcomeEvent: {
              type: "action_outcome",
              summary: "task_create materialized a durable task.",
              targetRef: { kind: "task", ref: decision.taskId },
            },
          }
        : {}),
    }));
  }
}

function taskCreateId(input: TaskCreateInput, context: ToolCallContext): string {
  return `task:tool:task_create:${stableId(taskCreateReplayKey(input, context))}`;
}

function taskCreateReplayKey(input: TaskCreateInput, context: ToolCallContext): string {
  return [
    "tool:task_create",
    input.goalId,
    input.strategyId ?? "",
    input.primaryDimension,
    input.work_description.trim(),
    context.conversationSessionId ?? context.sessionId ?? "session:none",
    context.turnId ?? context.callId ?? context.cwd,
  ].join(":");
}
