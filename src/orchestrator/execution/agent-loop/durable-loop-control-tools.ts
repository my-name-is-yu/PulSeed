import { z } from "zod";
import type { StateManager } from "../../../base/state/state-manager.js";
import type { Goal } from "../../../base/types/goal.js";
import { DaemonClient, isDaemonRunning, type DaemonStartGoalOptions } from "../../../runtime/daemon/client.js";
import type { ITool, PermissionCheckResult, ToolCallContext, ToolMetadata, ToolResult } from "../../../tools/types.js";
import {
  PersonalAgentRuntimeStore,
  buildPersonalAgentDecisionTrace,
  stableId,
  type InterventionDecisionKind,
  type InterventionTargetEffect,
  type RuntimeGraphRef,
  type TaskCandidateTargetKind,
} from "../../../runtime/personal-agent/index.js";

export interface DurableLoopControlToolset {
  goalStatus(input: { goalId: string }, context?: ToolCallContext): Promise<unknown>;
  goalCreate?(input: { description: string }, context?: ToolCallContext): Promise<unknown>;
  tendGoal?(input: { description: string; parentSessionId?: string; notifyPolicy?: "silent" | "done_only" | "state_changes" }, context?: ToolCallContext): Promise<unknown>;
  goalStart?(input: { goalId: string; backgroundRunId?: string; parentSessionId?: string; notifyPolicy?: "silent" | "done_only" | "state_changes" }, context?: ToolCallContext): Promise<unknown>;
  goalPause?(input: { goalId: string }, context?: ToolCallContext): Promise<unknown>;
  goalResume?(input: { goalId: string }, context?: ToolCallContext): Promise<unknown>;
  goalCancel?(input: { goalId: string }, context?: ToolCallContext): Promise<unknown>;
  taskStatus?(input: { goalId: string; taskId?: string }, context?: ToolCallContext): Promise<unknown>;
  taskPrioritize?(input: { goalId: string; taskId: string; priority: number }, context?: ToolCallContext): Promise<unknown>;
  runCycle?(input: { goalId: string; maxIterations?: number }, context?: ToolCallContext): Promise<unknown>;
}

/** @deprecated Use DurableLoopControlToolset. */
export type CoreLoopControlToolset = DurableLoopControlToolset;

const DurableLoopControlSafeNumberSchema = z.number().finite().safe();
const DurableLoopControlPositiveSafeIntegerSchema = z.number()
  .finite()
  .int()
  .min(1)
  .max(Number.MAX_SAFE_INTEGER);

const schemas = {
  core_goal_status: z.object({ goalId: z.string().min(1) }),
  core_goal_create: z.object({ description: z.string().min(1) }),
  core_tend_goal: z.object({
    description: z.string().min(1),
    parentSessionId: z.string().optional(),
    notifyPolicy: z.enum(["silent", "done_only", "state_changes"]).optional(),
  }),
  core_goal_start: z.object({
    goalId: z.string().min(1),
    backgroundRunId: z.string().optional(),
    parentSessionId: z.string().optional(),
    notifyPolicy: z.enum(["silent", "done_only", "state_changes"]).optional(),
  }),
  core_goal_pause: z.object({ goalId: z.string().min(1) }),
  core_goal_resume: z.object({ goalId: z.string().min(1) }),
  core_goal_cancel: z.object({ goalId: z.string().min(1) }),
  core_task_status: z.object({ goalId: z.string().min(1), taskId: z.string().optional() }),
  core_task_prioritize: z.object({
    goalId: z.string().min(1),
    taskId: z.string().min(1),
    priority: DurableLoopControlSafeNumberSchema,
  }),
  core_run_cycle: z.object({
    goalId: z.string().min(1),
    maxIterations: DurableLoopControlPositiveSafeIntegerSchema.optional(),
  }),
};

type CoreToolName = keyof typeof schemas;

export interface DurableLoopControlToolsOptions {
  personalAgentRuntime?: Pick<PersonalAgentRuntimeStore, "recordTrace">;
  baseDir?: string;
}

export function createDurableLoopControlTools(
  service: DurableLoopControlToolset,
  options: DurableLoopControlToolsOptions = {},
): ITool[] {
  const tools: ITool[] = [
    new DurableLoopControlTool("core_goal_status", "Read DurableLoop goal status.", "read_only", (input, context) => service.goalStatus(input, context), schemas.core_goal_status, options),
  ];
  if (service.goalCreate) tools.push(new DurableLoopControlTool("core_goal_create", "Create a DurableLoop goal.", "write_local", (input, context) => service.goalCreate!(input, context), schemas.core_goal_create, options));
  if (service.tendGoal) tools.push(new DurableLoopControlTool("core_tend_goal", "Create a DurableLoop goal and start it in the daemon for long-running background execution.", "write_local", (input, context) => service.tendGoal!(input, context), schemas.core_tend_goal, options));
  if (service.goalStart) tools.push(new DurableLoopControlTool("core_goal_start", "Start or resume a DurableLoop goal in the daemon.", "write_local", (input, context) => service.goalStart!(input, context), schemas.core_goal_start, options));
  if (service.goalPause) tools.push(new DurableLoopControlTool("core_goal_pause", "Pause a DurableLoop goal.", "write_local", (input, context) => service.goalPause!(input, context), schemas.core_goal_pause, options));
  if (service.goalResume) tools.push(new DurableLoopControlTool("core_goal_resume", "Start or resume a DurableLoop goal in the daemon.", "write_local", (input, context) => service.goalResume!(input, context), schemas.core_goal_resume, options));
  if (service.goalCancel) tools.push(new DurableLoopControlTool("core_goal_cancel", "Cancel a DurableLoop goal.", "write_local", (input, context) => service.goalCancel!(input, context), schemas.core_goal_cancel, options));
  if (service.taskStatus) tools.push(new DurableLoopControlTool("core_task_status", "Read DurableLoop task status.", "read_only", (input, context) => service.taskStatus!(input, context), schemas.core_task_status, options));
  if (service.taskPrioritize) tools.push(new DurableLoopControlTool("core_task_prioritize", "Set DurableLoop task priority.", "write_local", (input, context) => service.taskPrioritize!(input, context), schemas.core_task_prioritize, options));
  if (service.runCycle) tools.push(new DurableLoopControlTool("core_run_cycle", "Run one bounded DurableLoop cycle.", "write_local", (input, context) => service.runCycle!(input, context), schemas.core_run_cycle, options));
  return tools;
}

/** @deprecated Use createDurableLoopControlTools. */
export const createCoreLoopControlTools = createDurableLoopControlTools;

class DurableLoopControlTool<TInput> implements ITool<TInput> {
  readonly metadata: ToolMetadata;

  constructor(
    private readonly toolName: CoreToolName,
    private readonly toolDescription: string,
    permissionLevel: ToolMetadata["permissionLevel"],
    private readonly handler: (input: TInput, context: ToolCallContext) => Promise<unknown>,
    readonly inputSchema: z.ZodType<TInput, z.ZodTypeDef, unknown>,
    private readonly options: DurableLoopControlToolsOptions = {},
  ) {
    this.metadata = {
      name: this.toolName,
      aliases: [],
      permissionLevel,
      isReadOnly: permissionLevel === "read_only",
      isDestructive: this.toolName === "core_goal_cancel",
      shouldDefer: false,
      alwaysLoad: false,
      maxConcurrency: permissionLevel === "read_only" ? 0 : 1,
      maxOutputChars: 8000,
      tags: ["agentloop", "coreloop"],
    };
  }

  description(): string {
    return this.toolDescription;
  }

  async call(input: TInput, _context: ToolCallContext): Promise<ToolResult> {
    const started = Date.now();
    try {
      if (!this.metadata.isReadOnly && !_context.preApproved) {
        await recordDurableLoopToolDecision(this.options, this.toolName, input, _context, {
          decision: "confirm_required",
          targetKind: "tool_call",
          targetRef: { kind: "tool_call", ref: this.toolName },
          targetEffect: "execute_tool",
          decisionReason: `${this.toolName} requires InterventionPolicy confirmation before DurableLoop state changes.`,
          permissionRequired: true,
        });
        return {
          success: false,
          data: null,
          summary: `${this.toolName} requires approval before execution`,
          execution: {
            status: "not_executed",
            reason: "permission_denied",
            message: `${this.toolName} requires approval before changing DurableLoop state.`,
          },
          durationMs: Date.now() - started,
        };
      }
      const data = await this.handler(input, _context);
      return {
        success: true,
        data,
        summary: `${this.toolName} completed`,
        durationMs: Date.now() - started,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: `${this.toolName} failed`,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - started,
      };
    }
  }

  async checkPermissions(_input: TInput, context: ToolCallContext): Promise<PermissionCheckResult> {
    if (this.metadata.isReadOnly) return { status: "allowed" };
    return context.preApproved
      ? { status: "allowed" }
      : { status: "needs_approval", reason: `${this.metadata.name} changes DurableLoop state` };
  }

  isConcurrencySafe(_input: TInput): boolean {
    return this.metadata.isReadOnly;
  }
}

export interface DaemonBackedDurableLoopControlDeps {
  stateManager: StateManager;
  host?: string;
  daemonClientFactory?: () => Promise<Pick<DaemonClient, "startGoal" | "stopGoal" | "pauseGoal" | "resumeGoal" | "getSnapshot">>;
  personalAgentRuntime?: Pick<PersonalAgentRuntimeStore, "recordTrace">;
}

/** @deprecated Use DaemonBackedDurableLoopControlDeps. */
export type DaemonBackedCoreLoopControlDeps = DaemonBackedDurableLoopControlDeps;

export function createDaemonBackedDurableLoopControlToolset(
  deps: DaemonBackedDurableLoopControlDeps,
): DurableLoopControlToolset {
  const baseDir = getStateManagerBaseDir(deps.stateManager);
  const createGoal = async (
    description: string,
    context?: ToolCallContext,
  ): Promise<{ goalId: string; goal: Goal }> => {
    const normalizedDescription = description.trim();
    if (!normalizedDescription) {
      throw new Error("DurableLoop goal description is required.");
    }
    const now = new Date().toISOString();
    const goalId = `goal:tool:core_goal:${stableId(durableLoopReplayKey("core_goal_create", { description: normalizedDescription }, context))}`;
    await recordDurableLoopToolDecision({ personalAgentRuntime: deps.personalAgentRuntime, baseDir }, "core_goal_create", { description: normalizedDescription }, context, {
      decision: "allow",
      targetKind: "goal",
      targetRef: { kind: "goal", ref: goalId },
      targetEffect: "create_goal",
      decisionReason: "DurableLoop goal creation was allowed by InterventionPolicy before durable goal state was written.",
      permissionRequired: false,
      currentRefs: [{ kind: "goal", ref: goalId }],
      outcomeSummary: "core_goal_create materialized a durable goal.",
    });
    const existing = await deps.stateManager.loadGoal(goalId).catch(() => null);
    if (existing) return { goalId, goal: existing };
    const goal: Goal = {
      id: goalId,
      parent_id: null,
      node_type: "goal",
      title: normalizedDescription.slice(0, 120),
      description: normalizedDescription,
      status: "active",
      dimensions: [],
      gap_aggregation: "max",
      dimension_mapping: null,
      constraints: ["source: agentloop core_tend_goal"],
      children_ids: [],
      target_date: null,
      origin: "manual",
      pace_snapshot: null,
      deadline: null,
      confidence_flag: null,
      user_override: false,
      feasibility_note: null,
      uncertainty_weight: 1.0,
      decomposition_depth: 0,
      specificity_score: null,
      loop_status: "idle",
      created_at: now,
      updated_at: now,
    };
    await deps.stateManager.saveGoal(goal);
    return { goalId, goal };
  };

  const getDaemonClient = async (): Promise<Pick<DaemonClient, "startGoal" | "stopGoal" | "pauseGoal" | "resumeGoal" | "getSnapshot">> => {
    if (deps.daemonClientFactory) return deps.daemonClientFactory();

    const baseDir = getStateManagerBaseDir(deps.stateManager);
    if (!baseDir) {
      throw new Error("DurableLoop daemon control requires a StateManager with getBaseDir().");
    }
    const info = await isDaemonRunning(baseDir);
    if (!info.running) {
      throw new Error("PulSeed daemon is not running; DurableLoop start/stop was not requested.");
    }
    return new DaemonClient({
      host: deps.host ?? "127.0.0.1",
      port: info.port,
      authToken: info.authToken,
      baseDir,
    });
  };

  const startGoal = async (input: {
    goalId: string;
    backgroundRunId?: string;
    parentSessionId?: string;
    notifyPolicy?: "silent" | "done_only" | "state_changes";
  }, context?: ToolCallContext): Promise<unknown> => {
    const goal = await deps.stateManager.loadGoal(input.goalId);
    if (!goal) throw new Error(`Goal not found: ${input.goalId}`);

    const backgroundRunId = input.backgroundRunId?.trim()
      || `run:coreloop:${stableId(durableLoopReplayKey("core_goal_start", input, context))}`;
    await recordDurableLoopToolDecision({ personalAgentRuntime: deps.personalAgentRuntime, baseDir }, "core_goal_start", input, context, {
      decision: "allow",
      targetKind: "run",
      targetRef: { kind: "background_run", ref: backgroundRunId },
      targetEffect: "create_run",
      decisionReason: "DurableLoop background run start was allowed by InterventionPolicy before daemon execution.",
      permissionRequired: false,
      currentRefs: [{ kind: "goal", ref: input.goalId }],
      outcomeSummary: "core_goal_start requested daemon background execution.",
    });
    const options: DaemonStartGoalOptions = {
      backgroundRun: {
        backgroundRunId,
        ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
        notifyPolicy: input.notifyPolicy ?? "state_changes",
        replyTargetSource: input.parentSessionId ? "parent_session" : "none",
      },
    };
    const client = await getDaemonClient();
    const response = await client.startGoal(input.goalId, options);
    return {
      ...response,
      goalId: input.goalId,
      backgroundRunId,
      title: goal.title,
    };
  };

  return {
    async goalStatus(input) {
      const goal = await deps.stateManager.loadGoal(input.goalId);
      if (!goal) throw new Error(`Goal not found: ${input.goalId}`);
      let daemonSnapshot: unknown = null;
      try {
        daemonSnapshot = await (await getDaemonClient()).getSnapshot();
      } catch {
        daemonSnapshot = null;
      }
      return {
        goal: {
          id: goal.id,
          title: goal.title,
          status: goal.status,
          loop_status: goal.loop_status,
          dimension_count: goal.dimensions.length,
          updated_at: goal.updated_at,
        },
        daemonSnapshot,
      };
    },
    async goalCreate(input, context) {
      return createGoal(input.description, context);
    },
    async tendGoal(input, context) {
      const created = await createGoal(input.description, context);
      const started = await startGoal({
        goalId: created.goalId,
        ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
        notifyPolicy: input.notifyPolicy ?? "state_changes",
      }, context);
      return { ...created, started };
    },
    goalStart: startGoal,
    async goalResume(input, context) {
      await recordDurableLoopToolDecision({ personalAgentRuntime: deps.personalAgentRuntime, baseDir }, "core_goal_resume", input, context, {
        decision: "allow",
        targetKind: "runtime_control",
        targetRef: { kind: "goal", ref: input.goalId },
        targetEffect: "mutate_runtime_control",
        decisionReason: "DurableLoop goal resume was allowed by InterventionPolicy before daemon execution.",
        permissionRequired: false,
        currentRefs: [{ kind: "goal", ref: input.goalId }],
        outcomeSummary: "core_goal_resume requested daemon resume.",
      });
      const client = await getDaemonClient();
      return { ...(await client.resumeGoal(input.goalId)), goalId: input.goalId };
    },
    async goalPause(input, context) {
      await recordDurableLoopToolDecision({ personalAgentRuntime: deps.personalAgentRuntime, baseDir }, "core_goal_pause", input, context, {
        decision: "allow",
        targetKind: "runtime_control",
        targetRef: { kind: "goal", ref: input.goalId },
        targetEffect: "mutate_runtime_control",
        decisionReason: "DurableLoop goal pause was allowed by InterventionPolicy before daemon execution.",
        permissionRequired: false,
        currentRefs: [{ kind: "goal", ref: input.goalId }],
        outcomeSummary: "core_goal_pause requested daemon pause.",
      });
      const client = await getDaemonClient();
      return { ...(await client.pauseGoal(input.goalId)), goalId: input.goalId };
    },
    async goalCancel(input, context) {
      await recordDurableLoopToolDecision({ personalAgentRuntime: deps.personalAgentRuntime, baseDir }, "core_goal_cancel", input, context, {
        decision: "allow",
        targetKind: "runtime_control",
        targetRef: { kind: "goal", ref: input.goalId },
        targetEffect: "mutate_runtime_control",
        decisionReason: "DurableLoop goal cancel was allowed by InterventionPolicy before daemon execution.",
        permissionRequired: false,
        currentRefs: [{ kind: "goal", ref: input.goalId }],
        outcomeSummary: "core_goal_cancel requested daemon cancellation.",
      });
      const client = await getDaemonClient();
      return { ...(await client.stopGoal(input.goalId)), goalId: input.goalId };
    },
    async taskStatus(input) {
      if (input.taskId) {
        const task = await deps.stateManager.loadTask(input.goalId, input.taskId, { includeArchive: true });
        if (!task) throw new Error(`Task not found: ${input.taskId}`);
        return { task };
      }
      return { tasks: await deps.stateManager.listTasks(input.goalId, { includeArchive: true }) };
    },
  };
}

/** @deprecated Use createDaemonBackedDurableLoopControlToolset. */
export const createDaemonBackedCoreLoopControlToolset = createDaemonBackedDurableLoopControlToolset;

function getStateManagerBaseDir(stateManager: StateManager): string | undefined {
  const candidate = stateManager as StateManager & { getBaseDir?: unknown };
  return typeof candidate.getBaseDir === "function" ? candidate.getBaseDir() : undefined;
}

async function recordDurableLoopToolDecision(
  options: DurableLoopControlToolsOptions,
  toolName: CoreToolName,
  input: unknown,
  context: ToolCallContext | undefined,
  decision: {
    decision: InterventionDecisionKind;
    targetKind: TaskCandidateTargetKind;
    targetRef: RuntimeGraphRef;
    targetEffect: InterventionTargetEffect;
    decisionReason: string;
    permissionRequired: boolean;
    currentRefs?: RuntimeGraphRef[];
    outcomeSummary?: string;
  },
): Promise<void> {
  const store = options.personalAgentRuntime ?? (
    options.baseDir ? new PersonalAgentRuntimeStore(options.baseDir, { controlBaseDir: options.baseDir }) : null
  );
  if (!store) return;
  const now = new Date().toISOString();
  const replayKey = durableLoopReplayKey(toolName, input, context);
  await store.recordTrace(buildPersonalAgentDecisionTrace({
    callerPath: "explicit_user_command",
    source: {
      sourceKind: "explicit_command",
      sourceId: context?.callId ?? context?.turnId ?? toolName,
      emittedAt: now,
      sourceEpoch: context?.turnId ?? context?.callId ?? "tool-call",
      highWatermark: context?.sessionId ?? context?.conversationSessionId ?? "session:none",
      replayKey,
      summary: `${toolName} requested DurableLoop state transition.`,
      sourceRef: { kind: "tool_call", ref: context?.callId ?? toolName },
    },
    target: {
      kind: decision.targetKind,
      ref: decision.targetRef,
      effect: decision.targetEffect,
      summary: `${toolName} target ${decision.targetRef.ref}.`,
    },
    decision: decision.decision,
    decisionReason: decision.decisionReason,
    capabilityDecision: decision.permissionRequired ? "permission_required" : "available",
    capabilityRefs: [{ kind: "capability", ref: "durable_loop_control" }],
    policyRef: { kind: "intervention_policy", ref: "policy:durable-loop-control-v1" },
    permissionRequired: decision.permissionRequired,
    currentRefs: decision.currentRefs ?? [],
    auditRefs: [
      { kind: "tool_call", ref: context?.callId ?? toolName },
      ...(context?.turnId ? [{ kind: "turn", ref: context.turnId }] : []),
    ],
    ...(!decision.permissionRequired && decision.outcomeSummary
      ? {
          outcomeEvent: {
            type: "action_outcome",
            summary: decision.outcomeSummary,
            targetRef: decision.targetRef,
          },
        }
      : {}),
  }));
}

function durableLoopReplayKey(
  toolName: CoreToolName,
  input: unknown,
  context: ToolCallContext | undefined,
): string {
  return [
    "tool",
    toolName,
    stableJson(input),
    context?.conversationSessionId ?? context?.sessionId ?? "session:none",
    context?.turnId ?? context?.callId ?? context?.cwd ?? "cwd:none",
  ].join(":");
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortJson(nested)]),
  );
}
