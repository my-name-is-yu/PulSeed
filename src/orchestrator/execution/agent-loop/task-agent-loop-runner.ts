import type { Task } from "../../../base/types/task.js";
import type { Goal } from "../../../base/types/goal.js";
import { getPulseedDirPath } from "../../../base/utils/paths.js";
import type { AgentResult } from "../adapter-layer.js";
import type { AgentLoopBudget } from "./agent-loop-budget.js";
import type {
  AgentLoopModelClient,
  AgentLoopModelRef,
  AgentLoopModelRegistry,
  AgentLoopReasoningEffort,
} from "./agent-loop-model.js";
import { BoundedAgentLoopRunner } from "./bounded-agent-loop-runner.js";
import { createAgentLoopSession, type AgentLoopSession } from "./agent-loop-session.js";
import type { AgentLoopResult } from "./agent-loop-result.js";
import type { AgentLoopToolPolicy } from "./agent-loop-turn-context.js";
import { AgentLoopContextAssembler, type SoilPrefetchQuery, type SoilPrefetchResult } from "./agent-loop-context-assembler.js";
import { buildTaskAgentLoopTurnContext } from "./task-agent-loop-context.js";
import {
  collectTaskAgentLoopNotExecutedBlockers,
  taskAgentLoopResultToAgentResult,
  type TaskAgentLoopOutput,
} from "./task-agent-loop-result.js";
import type { AgentLoopSessionState } from "./agent-loop-session-state.js";
import type { AgentLoopWorkspaceInfo } from "./agent-loop-result.js";
import { isTaskRelevantVerificationCommand } from "./task-agent-loop-verification.js";
import {
  prepareTaskAgentLoopWorkspace,
  type AgentLoopWorktreePolicy,
} from "./task-agent-loop-worktree.js";
import type { ToolCallContext } from "../../../tools/types.js";
import type { ExecutionPolicy, SubagentRole } from "./execution-policy.js";
import {
  CompanionCognitionService,
  createRelationshipProfileCognitionMemoryPort,
  type CompanionCognitionOutput,
} from "../../../runtime/cognition/index.js";

export interface TaskAgentLoopRunnerDeps {
  boundedRunner: BoundedAgentLoopRunner;
  modelClient: AgentLoopModelClient;
  modelRegistry: AgentLoopModelRegistry;
  defaultModel?: AgentLoopModelRef;
  defaultBudget?: Partial<AgentLoopBudget>;
  defaultToolPolicy?: AgentLoopToolPolicy;
  defaultToolCallContext?: Partial<ToolCallContext>;
  defaultWorktreePolicy?: AgentLoopWorktreePolicy;
  defaultReasoningEffort?: AgentLoopReasoningEffort;
  defaultProfileName?: string;
  defaultExecutionPolicy?: ExecutionPolicy;
  cognitionMemoryBaseDir?: string;
  contextAssembler?: AgentLoopContextAssembler;
  soilPrefetch?: (query: SoilPrefetchQuery) => Promise<SoilPrefetchResult | null>;
  cwd?: string;
  createSession?: (input: { task: Task }) => AgentLoopSession;
}

export interface TaskAgentLoopRunInput {
  task: Task;
  artifactGoal?: Pick<Goal, "constraints"> | null;
  workspaceContext?: string;
  knowledgeContext?: string;
  model?: AgentLoopModelRef;
  cwd?: string;
  budget?: Partial<AgentLoopBudget>;
  toolPolicy?: AgentLoopToolPolicy;
  worktreePolicy?: AgentLoopWorktreePolicy;
  resumeState?: AgentLoopSessionState;
  abortSignal?: AbortSignal;
  role?: SubagentRole;
}

export class TaskAgentLoopRunner {
  constructor(private readonly deps: TaskAgentLoopRunnerDeps) {}

  private cognitionMemoryBaseDir(): string {
    return this.deps.cognitionMemoryBaseDir
      ?? this.deps.defaultToolCallContext?.providerConfigBaseDir
      ?? getPulseedDirPath();
  }

  async runTask(input: TaskAgentLoopRunInput): Promise<AgentLoopResult<TaskAgentLoopOutput>> {
    const model = input.model ?? this.deps.defaultModel ?? await this.deps.modelRegistry.defaultModel();
    const modelInfo = await this.deps.modelClient.getModelInfo(model);
    const session = this.deps.createSession?.({ task: input.task }) ?? createAgentLoopSession();
    const requestedCwd = input.cwd ?? this.deps.cwd;
    const workspace = await prepareTaskAgentLoopWorkspace({
      task: input.task,
      cwd: requestedCwd,
      policy: { ...this.deps.defaultWorktreePolicy, ...input.worktreePolicy },
    });
    const contextAssembler = this.deps.contextAssembler ?? new AgentLoopContextAssembler();
    let finalizationInput = { success: false, changedFiles: [] as string[] };
    let finalResult: AgentLoopResult<TaskAgentLoopOutput> | null = null;
    let runError: unknown = null;
    let cognitionOutput: CompanionCognitionOutput | undefined;
    try {
      const executionPolicy = this.deps.defaultToolCallContext?.executionPolicy
        ?? this.deps.defaultExecutionPolicy;
      const assembled = await contextAssembler.assembleTask({
        task: input.task,
        workspaceContext: input.workspaceContext,
        knowledgeContext: input.knowledgeContext,
        cwd: workspace.executionCwd,
        soilPrefetch: this.deps.soilPrefetch,
        trustProjectInstructions: executionPolicy?.trustProjectInstructions,
      });
      cognitionOutput = await evaluateTaskAgentLoopCognition({
        task: input.task,
        cwd: assembled.cwd,
        phaseRef: "task-agent-loop:assemble",
        baseDir: this.cognitionMemoryBaseDir(),
      }).catch(() => undefined);
      const turn = buildTaskAgentLoopTurnContext({
        task: input.task,
        artifactGoal: input.artifactGoal,
        model,
        modelInfo,
        session,
        workspaceContext: input.workspaceContext,
        knowledgeContext: input.knowledgeContext,
        cwd: assembled.cwd,
        systemPrompt: assembled.systemPrompt,
        userPrompt: assembled.userPrompt,
        budget: { ...this.deps.defaultBudget, ...input.budget },
        toolPolicy: { ...this.deps.defaultToolPolicy, ...input.toolPolicy },
        toolCallContext: this.deps.defaultToolCallContext,
        ...(this.deps.defaultProfileName ? { profileName: this.deps.defaultProfileName } : {}),
        ...(this.deps.defaultReasoningEffort ? { reasoningEffort: this.deps.defaultReasoningEffort } : {}),
        ...(executionPolicy ? { executionPolicy } : {}),
        ...(input.resumeState ? { resumeState: input.resumeState } : {}),
        abortSignal: input.abortSignal,
        role: input.role,
      });
      const result = await this.deps.boundedRunner.run(turn);
      const success = result.success && collectTaskAgentLoopNotExecutedBlockers(result).length === 0;
      finalizationInput = {
        success,
        changedFiles: result.changedFiles,
      };
      const commandResults = result.commandResults.map((commandResult) => ({
        ...commandResult,
        relevantToTask: isTaskRelevantVerificationCommand(input.task, commandResult),
      }));
      const hasPulSeedObservedRuntimeVerification = commandResults.some((commandResult) =>
        commandResult.success &&
        commandResult.evidenceEligible &&
        commandResult.relevantToTask !== false
      );
      const requiresPostVerificationBeforeSuccessLedger =
        success &&
        modelInfo.capabilities.toolCalling === false &&
        result.changedFiles.length > 0 &&
        !hasPulSeedObservedRuntimeVerification;
      finalResult = {
        ...result,
        success,
        commandResults,
        activeBudgetMs: turn.budget.maxWallClockMs,
        requiresPostVerificationBeforeSuccessLedger,
        ...(cognitionOutput ? { cognitionOutput } : {}),
      };
    } catch (error) {
      runError = error;
    }
    let workspaceOutcome: AgentLoopWorkspaceInfo | undefined;
    try {
      workspaceOutcome = await workspace.finalize(finalizationInput);
    } catch (error) {
      if (!runError) {
        throw error;
      }
    }
    if (runError) {
      throw runError;
    }
    return {
      ...finalResult!,
      workspace: workspaceOutcome,
    };
  }

  async runTaskAsAgentResult(input: TaskAgentLoopRunInput): Promise<AgentResult> {
    return taskAgentLoopResultToAgentResult(await this.runTask(input));
  }
}

async function evaluateTaskAgentLoopCognition(input: {
  task: Task;
  cwd: string;
  phaseRef: string;
  baseDir: string;
}): Promise<CompanionCognitionOutput> {
  const cognitionId = `cognition:task:${input.task.id}`;
  const eventRef = {
    ref: input.task.id,
    source_store: "runtime_operation" as const,
    source_event_type: "task_agent_loop_context",
    schema_version: 1,
    source_epoch: input.task.started_at ?? input.task.created_at ?? input.task.id,
    redaction_policy: "metadata_only" as const,
  };
  return new CompanionCognitionService({
    memoryPort: createRelationshipProfileCognitionMemoryPort({
      baseDir: input.baseDir,
    }),
  }).evaluateTaskContext({
    cognition_id: cognitionId,
    caller_path: "long_running_task_turn",
    event_refs: [eventRef],
    working_context: {
      input_ref: eventRef,
      route_ref: {
        kind: "agent_loop",
        ref: "task_agent_loop",
      },
      session_ref: {
        kind: "workspace",
        ref: input.cwd,
      },
      hidden_prompt_content_materialized: false,
    },
    runtime_context: {
      runtime_item_refs: [{
        kind: "task",
        ref: input.task.id,
      }],
      approval_refs: [],
      last_tool_trace_refs: [],
      phase_ref: {
        kind: "task_phase",
        ref: input.phaseRef,
      },
    },
    goal_context: {
      active_goals: [{
        goal_id: input.task.goal_id,
        goal_ref: {
          kind: "goal",
          ref: input.task.goal_id,
        },
        lifecycle: input.task.status === "completed" ? "completed" : "active",
        priority: "unknown",
      }],
      active_intention_refs: [],
      stale_target_refs: [],
    },
    memory_context_request: {
      request_id: `${cognitionId}:memory-request`,
      requested_uses: ["runtime_grounding", "goal_planning"],
      caller_path: "long_running_task_turn",
      query_ref: eventRef,
      surface_projection_required: true,
      side_effect_authorization_allowed: false,
      include_sensitive_content: false,
    },
    surface_target: "internal_audit",
  });
}
