import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { StateManager } from "../../../base/state/state-manager.js";
import type { Goal } from "../../../base/types/goal.js";
import { DaemonClient, isDaemonRunning, type DaemonStartGoalOptions } from "../../../runtime/daemon/client.js";
import type { ITool, PermissionCheckResult, ToolCallContext, ToolMetadata, ToolResult } from "../../../tools/types.js";

export interface CoreLoopControlToolset {
  goalStatus(input: { goalId: string }): Promise<unknown>;
  goalCreate?(input: { description: string }): Promise<unknown>;
  tendGoal?(input: { description: string; parentSessionId?: string; notifyPolicy?: "silent" | "done_only" | "state_changes" }): Promise<unknown>;
  goalStart?(input: { goalId: string; backgroundRunId?: string; parentSessionId?: string; notifyPolicy?: "silent" | "done_only" | "state_changes" }): Promise<unknown>;
  goalPause?(input: { goalId: string }): Promise<unknown>;
  goalResume?(input: { goalId: string }): Promise<unknown>;
  goalCancel?(input: { goalId: string }): Promise<unknown>;
  taskStatus?(input: { goalId: string; taskId?: string }): Promise<unknown>;
  taskPrioritize?(input: { goalId: string; taskId: string; priority: number }): Promise<unknown>;
  runCycle?(input: { goalId: string; maxIterations?: number }): Promise<unknown>;
}

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
  core_task_prioritize: z.object({ goalId: z.string().min(1), taskId: z.string().min(1), priority: z.number() }),
  core_run_cycle: z.object({ goalId: z.string().min(1), maxIterations: z.number().int().positive().optional() }),
};

type CoreToolName = keyof typeof schemas;

export function createCoreLoopControlTools(service: CoreLoopControlToolset): ITool[] {
  return [
    new CoreLoopControlTool("core_goal_status", "Read CoreLoop goal status.", "read_only", (input) => service.goalStatus(input), schemas.core_goal_status),
    new CoreLoopControlTool("core_goal_create", "Create a CoreLoop goal.", "write_local", (input) => requireHandler(service.goalCreate, "goalCreate")(input), schemas.core_goal_create),
    new CoreLoopControlTool("core_tend_goal", "Create a CoreLoop goal and start it in the daemon for long-running background execution.", "write_local", (input) => requireHandler(service.tendGoal, "tendGoal")(input), schemas.core_tend_goal),
    new CoreLoopControlTool("core_goal_start", "Start or resume a CoreLoop goal in the daemon.", "write_local", (input) => requireHandler(service.goalStart, "goalStart")(input), schemas.core_goal_start),
    new CoreLoopControlTool("core_goal_pause", "Pause a CoreLoop goal.", "write_local", (input) => requireHandler(service.goalPause, "goalPause")(input), schemas.core_goal_pause),
    new CoreLoopControlTool("core_goal_resume", "Start or resume a CoreLoop goal in the daemon.", "write_local", (input) => requireHandler(service.goalResume, "goalResume")(input), schemas.core_goal_resume),
    new CoreLoopControlTool("core_goal_cancel", "Cancel a CoreLoop goal.", "write_local", (input) => requireHandler(service.goalCancel, "goalCancel")(input), schemas.core_goal_cancel),
    new CoreLoopControlTool("core_task_status", "Read CoreLoop task status.", "read_only", (input) => requireHandler(service.taskStatus, "taskStatus")(input), schemas.core_task_status),
    new CoreLoopControlTool("core_task_prioritize", "Set CoreLoop task priority.", "write_local", (input) => requireHandler(service.taskPrioritize, "taskPrioritize")(input), schemas.core_task_prioritize),
    new CoreLoopControlTool("core_run_cycle", "Run one bounded CoreLoop cycle.", "write_local", (input) => requireHandler(service.runCycle, "runCycle")(input), schemas.core_run_cycle),
  ];
}

class CoreLoopControlTool<TInput> implements ITool<TInput> {
  readonly metadata: ToolMetadata;

  constructor(
    name: CoreToolName,
    private readonly toolDescription: string,
    permissionLevel: ToolMetadata["permissionLevel"],
    private readonly handler: (input: TInput) => Promise<unknown>,
    readonly inputSchema: z.ZodType<TInput, z.ZodTypeDef, unknown>,
  ) {
    this.metadata = {
      name,
      aliases: [],
      permissionLevel,
      isReadOnly: permissionLevel === "read_only",
      isDestructive: name === "core_goal_cancel",
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
      const data = await this.handler(input);
      return {
        success: true,
        data,
        summary: `${this.metadata.name} completed`,
        durationMs: Date.now() - started,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: `${this.metadata.name} failed`,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - started,
      };
    }
  }

  async checkPermissions(_input: TInput, context: ToolCallContext): Promise<PermissionCheckResult> {
    if (this.metadata.isReadOnly) return { status: "allowed" };
    return context.preApproved
      ? { status: "allowed" }
      : { status: "needs_approval", reason: `${this.metadata.name} changes CoreLoop state` };
  }

  isConcurrencySafe(_input: TInput): boolean {
    return this.metadata.isReadOnly;
  }
}

function requireHandler<TInput>(handler: ((input: TInput) => Promise<unknown>) | undefined, name: string): (input: TInput) => Promise<unknown> {
  if (!handler) {
    return async () => {
      throw new Error(`CoreLoop control handler is not configured: ${name}`);
    };
  }
  return handler;
}

export interface DaemonBackedCoreLoopControlDeps {
  stateManager: StateManager;
  host?: string;
  daemonClientFactory?: () => Promise<Pick<DaemonClient, "startGoal" | "stopGoal" | "getSnapshot">>;
}

export function createDaemonBackedCoreLoopControlToolset(
  deps: DaemonBackedCoreLoopControlDeps,
): CoreLoopControlToolset {
  const createGoal = async (description: string): Promise<{ goalId: string; goal: Goal }> => {
    const normalizedDescription = description.trim();
    if (!normalizedDescription) {
      throw new Error("CoreLoop goal description is required.");
    }
    const now = new Date().toISOString();
    const goalId = randomUUID();
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

  const getDaemonClient = async (): Promise<Pick<DaemonClient, "startGoal" | "stopGoal" | "getSnapshot">> => {
    if (deps.daemonClientFactory) return deps.daemonClientFactory();

    const baseDir = deps.stateManager.getBaseDir();
    const info = await isDaemonRunning(baseDir);
    if (!info.running) {
      throw new Error("PulSeed daemon is not running; CoreLoop start/stop was not requested.");
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
  }): Promise<unknown> => {
    const goal = await deps.stateManager.loadGoal(input.goalId);
    if (!goal) throw new Error(`Goal not found: ${input.goalId}`);

    const backgroundRunId = input.backgroundRunId?.trim() || `run:coreloop:${randomUUID()}`;
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
    async goalCreate(input) {
      return createGoal(input.description);
    },
    async tendGoal(input) {
      const created = await createGoal(input.description);
      const started = await startGoal({
        goalId: created.goalId,
        ...(input.parentSessionId ? { parentSessionId: input.parentSessionId } : {}),
        notifyPolicy: input.notifyPolicy ?? "state_changes",
      });
      return { ...created, started };
    },
    goalStart: startGoal,
    async goalResume(input) {
      return startGoal(input);
    },
    async goalPause(input) {
      const client = await getDaemonClient();
      return { ...(await client.stopGoal(input.goalId)), goalId: input.goalId };
    },
    async goalCancel(input) {
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
