import { execFileSync as _execFileSync } from "node:child_process";
import type { Logger } from "../../../runtime/logger.js";
import {
  runShellCommand as _runShellCommand,
  runPostExecutionHealthCheck as _runPostExecutionHealthCheck,
} from "./task-health-check.js";
import type { StateManager } from "../../../base/state/state-manager.js";
import type { ILLMClient } from "../../../base/llm/llm-client.js";
import type { SessionManager } from "../session-manager.js";
import type { TrustManager } from "../../../platform/traits/trust-manager.js";
import type { StrategyManager } from "../../strategy/strategy-manager.js";
import type { StallDetector } from "../../../platform/drive/stall-detector.js";
import {
  selectTargetDimension as _selectTargetDimension,
  type DimensionSelectionOptions,
} from "../context/dimension-selector.js";
import type { Task, VerificationResult } from "../../../base/types/task.js";
import type { GapVector } from "../../../base/types/gap.js";
import type { DriveContext } from "../../../base/types/drive.js";
import type { Dimension } from "../../../base/types/goal.js";
import type { EthicsGate } from "../../../platform/traits/ethics-gate.js";
import type { CapabilityDetector } from "../../../platform/observation/capability-detector.js";
import {
  verifyTask as _verifyTask,
  handleVerdict as _handleVerdict,
  handleFailure as _handleFailure,
  type VerdictResult,
  type FailureResult,
  type CompletionJudgerConfig,
  type VerdictHandlingContext,
} from "./task-verifier.js";
export type { CompletionJudgerConfig } from "./task-verifier.js";
export type {
  ExecutorReport,
  VerdictResult,
  FailureResult,
} from "./task-verifier.js";

import type { AgentTask, AgentResult, IAdapter } from "../adapter-layer.js";
import { AdapterRegistry } from "../adapter-layer.js";
export type { AgentTask, AgentResult, IAdapter };
export { AdapterRegistry };

import type { TaskPipeline } from "../../../base/types/pipeline.js";

export { LLMGeneratedTaskSchema } from "./task-generation.js";
import { generateTask as _generateTask } from "./task-generation.js";
import { durationToMs } from "./task-executor.js";
import { executeTaskWithGuards, verifyExecutionWithGitDiff } from "./task-execution-helpers.js";
import {
  deriveTaskAgentLoopBudget,
  failNativeCodeTaskWithoutFileChanges,
  isExternalActionTask,
  resolveArcAgi3AgentLoopToolPolicy,
  shouldDeferAgentLoopTerminalUntilVerification,
  shouldKeepDaemonShutdownInterruptedTaskRunning,
  taskApprovalHandoffId,
} from "./task-lifecycle-policies.js";
import { runPipelineTaskCycle as runPipelineTaskCycleFn } from "./task-pipeline-cycle.js";
import type { PipelineCycleOptions } from "./task-pipeline-types.js";
import type { KnowledgeTransfer } from "../../../platform/knowledge/transfer/knowledge-transfer.js";
import type { KnowledgeManager } from "../../../platform/knowledge/knowledge-manager.js";
import type { MemoryLifecycleManager } from "../../../platform/knowledge/memory/memory-lifecycle.js";
import { captureExecutionDiffArtifacts, captureExecutionDiffBaseline } from "./task-diff-capture.js";
import { resolveGoalWorkspacePath, resolveTaskWorkspacePath } from "./task-workspace.js";
import type { GuardrailRunner } from "../../../platform/traits/guardrail-runner.js";
import type { HookManager } from "../../../runtime/hook-manager.js";
import type { ToolExecutor } from "../../../tools/executor.js";
import type { TaskAgentLoopRunner } from "../agent-loop/task-agent-loop-runner.js";
import { taskAgentLoopResultToAgentResult } from "../agent-loop/task-agent-loop-result.js";
import type { IPromptGateway } from "../../../prompt/gateway.js";
import type { ExecutionModeState } from "../../../platform/time/execution-mode.js";
import type { LearningPriorPhaseProjection } from "../../../runtime/learning/index.js";
import type {
  RuntimeOperatorHandoffStore,
  RuntimeOperatorHandoffTrigger,
} from "../../../runtime/store/operator-handoff-store.js";
import {
  formatPlaybookHints,
  formatPatternHints,
  formatWorkflowHints,
  loadDreamActivationState,
  loadDreamPlaybookRecords,
  loadDreamWorkflows,
  loadLearnedPatterns,
  selectPlaybookHints,
  selectPatternHints,
  selectWorkflowHints,
} from "../../../platform/dream/dream-activation.js";

export type { TaskCycleResult } from "./task-execution-types.js";
export type {
  PipelineCycleDeps,
  PipelineCycleOptions,
  SelectTargetDimensionFn,
  GenerateTaskFn,
} from "./task-pipeline-types.js";
import type { TaskCycleResult } from "./task-execution-types.js";
import { appendTaskOutcomeEvent } from "./task-outcome-ledger.js";
import { runTaskLifecycleCycle } from "./task-lifecycle-runner.js";
import { recordTaskPreExecutionPolicyDecision } from "./task-pre-execution-policy-trace.js";
import type { TaskPreExecutionPolicyDecisionInput } from "./task-pre-execution-policy-trace.js";
import {
  PersonalAgentRuntimeStore,
  buildPersonalAgentDecisionTrace,
  type RuntimeGraphRef,
} from "../../../runtime/personal-agent/index.js";

export interface TaskLifecycleCoreDeps {
  stateManager: StateManager;
  llmClient: ILLMClient;
  sessionManager: SessionManager;
  trustManager: TrustManager;
  strategyManager: StrategyManager;
  stallDetector: StallDetector;
}

export interface TaskLifecycleOptions {
  approvalFn?: (task: Task) => Promise<boolean>;
  ethicsGate?: EthicsGate;
  capabilityDetector?: CapabilityDetector;
  logger?: Logger;
  /** Optional adapter registry for L1 mechanical verification command execution */
  adapterRegistry?: AdapterRegistry;
  /** Enable post-execution build/test health check (disabled by default) */
  healthCheckEnabled?: boolean;
  /** Injectable execFileSync for testing (defaults to node:child_process execFileSync) */
  execFileSyncFn?: (cmd: string, args: string[], opts: { cwd: string; encoding: "utf-8" }) => string;
  /** Timeout + retry config for the completion judgment LLM call */
  completionJudgerConfig?: CompletionJudgerConfig;
  /** Optional KnowledgeTransfer for realtime candidate detection before task generation */
  knowledgeTransfer?: KnowledgeTransfer;
  /** Optional KnowledgeManager for reflection generation and retrieval */
  knowledgeManager?: KnowledgeManager;
  /** Optional MemoryLifecycleManager for lessons learned during task generation */
  memoryLifecycle?: MemoryLifecycleManager;
  /** Optional guardrail runner for before_tool/after_tool hooks */
  guardrailRunner?: GuardrailRunner;
  /** Optional HookManager for lifecycle hook events */
  hookManager?: HookManager;
  /** Optional ToolExecutor for post-execution git diff verification (read-only) */
  toolExecutor?: ToolExecutor;
  /** Native task-level agentloop runner. When present, runTaskCycle executes tasks through this path. */
  agentLoopRunner?: TaskAgentLoopRunner;
  /** Optional PromptGateway used for task generation and verifier review. */
  gateway?: IPromptGateway;
  /** Optional explicit workspace root for git-based revert operations. */
  revertCwd?: string;
  /** Optional explicit workspace root for post-execution health checks. */
  healthCheckCwd?: string;
  /** Optional durable operator handoff store for approval-required execution gates. */
  operatorHandoffStore?: RuntimeOperatorHandoffStore;
  /** Durable personal-agent runtime trace recorder. */
  personalAgentRuntime?: Pick<PersonalAgentRuntimeStore, "recordTrace">;
}

export interface TaskCycleRunOptions {
  targetDimensionOverride?: string;
  knowledgeContextPrefix?: string;
  learningProjection?: Extract<LearningPriorPhaseProjection, { phase: "task_generation" }>;
  learningPriorConsumptionRef?: string;
  executionMode?: ExecutionModeState;
  runControlRecommendationContext?: string;
  abortSignal?: AbortSignal;
}

export interface TaskLifecycleDeps extends TaskLifecycleCoreDeps {
  options?: TaskLifecycleOptions;
}

// ─── TaskLifecycle ───

/**
 * TaskLifecycle manages the full lifecycle of tasks:
 * select target dimension -> generate task -> approval check -> execute -> verify -> handle verdict.
 */
export class TaskLifecycle {
  private readonly stateManager: StateManager;
  private readonly llmClient: ILLMClient;
  private readonly sessionManager: SessionManager;
  private readonly trustManager: TrustManager;
  private readonly strategyManager: StrategyManager;
  private readonly stallDetector: StallDetector;
  private readonly approvalFn: (task: Task) => Promise<boolean>;
  private readonly ethicsGate?: EthicsGate;
  private readonly capabilityDetector?: CapabilityDetector;
  private readonly logger?: Logger;
  private readonly adapterRegistry?: AdapterRegistry;
  private readonly healthCheckEnabled: boolean;
  private readonly execFileSyncFn: (cmd: string, args: string[], opts: { cwd: string; encoding: "utf-8" }) => string;
  private readonly completionJudgerConfig?: CompletionJudgerConfig;
  private readonly knowledgeTransfer?: KnowledgeTransfer;
  private readonly knowledgeManager?: KnowledgeManager;
  private readonly memoryLifecycle?: MemoryLifecycleManager;
  private readonly guardrailRunner?: GuardrailRunner;
  private readonly hookManager?: HookManager;
  private readonly toolExecutor?: ToolExecutor;
  private readonly agentLoopRunner?: TaskAgentLoopRunner;
  private readonly gateway?: IPromptGateway;
  private readonly revertCwd?: string;
  private readonly healthCheckCwd?: string;
  private readonly operatorHandoffStore?: RuntimeOperatorHandoffStore;
  private readonly personalAgentRuntime: Pick<PersonalAgentRuntimeStore, "recordTrace">;
  private onTaskComplete?: (strategyId: string) => void;

  constructor(deps: TaskLifecycleDeps);
  constructor(
    stateManager: StateManager,
    llmClient: ILLMClient,
    sessionManager: SessionManager,
    trustManager: TrustManager,
    strategyManager: StrategyManager,
    stallDetector: StallDetector,
    options?: TaskLifecycleOptions
  );
  constructor(
    stateManagerOrDeps: StateManager | TaskLifecycleDeps,
    llmClient?: ILLMClient,
    sessionManager?: SessionManager,
    trustManager?: TrustManager,
    strategyManager?: StrategyManager,
    stallDetector?: StallDetector,
    options?: TaskLifecycleOptions
  ) {
    const resolved = TaskLifecycle.isDepsObject(stateManagerOrDeps)
      ? stateManagerOrDeps
      : {
          stateManager: stateManagerOrDeps,
          llmClient: llmClient!,
          sessionManager: sessionManager!,
          trustManager: trustManager!,
          strategyManager: strategyManager!,
          stallDetector: stallDetector!,
          options,
        };
    const resolvedOptions = resolved.options;

    this.stateManager = resolved.stateManager;
    this.llmClient = resolved.llmClient;
    this.sessionManager = resolved.sessionManager;
    this.trustManager = resolved.trustManager;
    this.strategyManager = resolved.strategyManager;
    this.stallDetector = resolved.stallDetector;
    this.approvalFn = resolvedOptions?.approvalFn ?? ((_task: Task) => Promise.resolve(false));
    this.ethicsGate = resolvedOptions?.ethicsGate;
    this.capabilityDetector = resolvedOptions?.capabilityDetector;
    this.logger = resolvedOptions?.logger;
    this.adapterRegistry = resolvedOptions?.adapterRegistry;
    this.healthCheckEnabled = resolvedOptions?.healthCheckEnabled ?? false;
    this.execFileSyncFn = resolvedOptions?.execFileSyncFn ?? _execFileSync;
    this.completionJudgerConfig = resolvedOptions?.completionJudgerConfig;
    this.knowledgeTransfer = resolvedOptions?.knowledgeTransfer;
    this.knowledgeManager = resolvedOptions?.knowledgeManager;
    this.memoryLifecycle = resolvedOptions?.memoryLifecycle;
    this.guardrailRunner = resolvedOptions?.guardrailRunner;
    this.hookManager = resolvedOptions?.hookManager;
    this.toolExecutor = resolvedOptions?.toolExecutor;
    this.agentLoopRunner = resolvedOptions?.agentLoopRunner;
    this.gateway = resolvedOptions?.gateway;
    this.revertCwd = resolvedOptions?.revertCwd;
    this.healthCheckCwd = resolvedOptions?.healthCheckCwd;
    this.operatorHandoffStore = resolvedOptions?.operatorHandoffStore;
    this.personalAgentRuntime = resolvedOptions?.personalAgentRuntime ?? new PersonalAgentRuntimeStore(
      this.stateManager.getBaseDir(),
      { controlBaseDir: this.stateManager.getBaseDir() },
    );
  }

  /** Register a callback invoked when a task completes successfully (used by PortfolioManager). */
  setOnTaskComplete(callback: (strategyId: string) => void): void {
    this.onTaskComplete = callback;
  }

  /** Select highest-priority dimension to work on, weighted by confidence tier. */
  selectTargetDimension(
    gapVector: GapVector,
    driveContext: DriveContext,
    dimensions?: Dimension[],
    options?: DimensionSelectionOptions
  ): string {
    return _selectTargetDimension(gapVector, driveContext, dimensions, options);
  }

  /** Generate a task for the given goal and target dimension via LLM. */
  async generateTask(
    goalId: string,
    targetDimension: string,
    strategyId?: string,
    knowledgeContext?: string,
    adapterType?: string,
    existingTasks?: string[],
    workspaceContext?: string,
    executionMode?: ExecutionModeState
  ): Promise<Task | null> {
    const result = await this._generateTaskWithTokens(goalId, targetDimension, strategyId, knowledgeContext, adapterType, existingTasks, workspaceContext, executionMode);
    return result.task;
  }

  /** Internal: generate task and return token count alongside the task. */
  private async _generateTaskWithTokens(
    goalId: string,
    targetDimension: string,
    strategyId?: string,
    knowledgeContext?: string,
    adapterType?: string,
    existingTasks?: string[],
    workspaceContext?: string,
    executionMode?: ExecutionModeState
  ): Promise<{ task: Task | null; tokensUsed: number; playbookIdsUsed: string[] }> {
    let resolvedKnowledgeContext = knowledgeContext;
    const playbookIdsUsed = new Set<string>();
    try {
      const baseDir = this.stateManager.getBaseDir();
      const dreamActivation = await loadDreamActivationState(baseDir);
      const verifiedPlannerHintsOnly = dreamActivation.flags.verifiedPlannerHintsOnly ?? true;
      if (
        dreamActivation.flags.learnedPatternHints ||
        dreamActivation.flags.playbookHints ||
        dreamActivation.flags.workflowHints
      ) {
        const goal = await this.stateManager.loadGoal(goalId);
        const query = [
          goal?.title ?? "",
          goal?.description ?? "",
          targetDimension,
          knowledgeContext ?? "",
        ].join(" ");

        if (dreamActivation.flags.learnedPatternHints && !verifiedPlannerHintsOnly) {
          const patterns = await loadLearnedPatterns(baseDir, goalId);
          const hints = selectPatternHints(patterns, query);
          const formattedHints = formatPatternHints(hints);
          if (formattedHints) {
            resolvedKnowledgeContext = resolvedKnowledgeContext
              ? `${resolvedKnowledgeContext}\n\n${formattedHints}`
              : formattedHints;
          }
        }

        if (dreamActivation.flags.playbookHints) {
          const playbooks = await loadDreamPlaybookRecords(baseDir);
          const hints = selectPlaybookHints(playbooks, query, { goalId, targetDimension });
          const formattedHints = formatPlaybookHints(hints);
          if (formattedHints) {
            for (const hint of hints) {
              playbookIdsUsed.add(hint.playbook_id);
            }
            resolvedKnowledgeContext = resolvedKnowledgeContext
              ? `${resolvedKnowledgeContext}\n\n${formattedHints}`
              : formattedHints;
          }
        }

        if (dreamActivation.flags.workflowHints && !verifiedPlannerHintsOnly) {
          const workflows = await loadDreamWorkflows(baseDir);
          const hints = selectWorkflowHints(workflows, query, { goalId, targetDimension });
          const formattedHints = formatWorkflowHints(hints);
          if (formattedHints) {
            resolvedKnowledgeContext = resolvedKnowledgeContext
              ? `${resolvedKnowledgeContext}\n\n${formattedHints}`
              : formattedHints;
          }
        }
      }
    } catch {
      // Non-fatal: proceed without Dream activation hints.
    }

    const repoRoot = await resolveGoalWorkspacePath({
      stateManager: this.stateManager,
      goalId,
      fallbackCwd: this.revertCwd,
    });
    await this.recordTaskCandidateTrace({
      goalId,
      targetDimension,
      strategyId,
      adapterType,
      existingTasks,
      workspaceContext,
      executionMode,
      repoRoot,
      playbookIdsUsed: [...playbookIdsUsed],
    });

    const generated = await _generateTask(
      {
        stateManager: this.stateManager,
        llmClient: this.llmClient,
        strategyManager: this.strategyManager,
        logger: this.logger,
        knowledgeManager: this.knowledgeManager,
        memoryLifecycle: this.memoryLifecycle,
        gateway: this.gateway,
        toolExecutor: this.toolExecutor,
        personalAgentRuntime: this.personalAgentRuntime,
      },
      goalId,
      targetDimension,
      strategyId,
      resolvedKnowledgeContext,
      adapterType,
      existingTasks,
      workspaceContext,
      executionMode,
      repoRoot
    );
    return {
      ...generated,
      playbookIdsUsed: [...playbookIdsUsed],
    };
  }

  /** Check whether the task requires human approval and request it if so. */
  async checkIrreversibleApproval(task: Task, confidence: number = 0.5): Promise<boolean> {
    const domain = task.task_category;
    const trustNeedsApproval = await this.trustManager.requiresApproval(
      task.reversibility,
      domain,
      confidence,
      task.task_category
    );
    const externalAction = isExternalActionTask(task);
    if (!trustNeedsApproval && !externalAction) {
      return true;
    }

    const handoffId = taskApprovalHandoffId(task);
    const approvalCapabilityRefs: RuntimeGraphRef[] = [
      { kind: "approval_gate", ref: "task_execution" },
      ...(trustNeedsApproval ? [{ kind: "trust_policy", ref: "approval_required" }] : []),
      ...(externalAction
        ? [{
            kind: "external_action",
            ref: task.risk_profile?.external_action.action_kind ?? "unknown",
          }]
        : []),
    ];
    const approvalReason = externalAction
      ? "Task execution requires operator confirmation because the typed risk profile marks it as an external action."
      : "Task execution requires operator confirmation because reversibility/trust policy requires approval.";
    await this.recordTaskPreExecutionPolicyDecision(task, {
      gate: "irreversible_approval",
      replayStage: "confirm_required",
      decision: "confirm_required",
      capabilityDecision: "permission_required",
      reason: approvalReason,
      permissionRequired: true,
      targetEffect: "execute_tool",
      capabilityRefs: approvalCapabilityRefs,
      policyRef: { kind: "intervention_policy", ref: "policy:task-irreversible-approval-v1" },
      currentRefs: [
        { kind: "operator_handoff", ref: handoffId },
      ],
    });
    const recordedHandoffId = await this.recordApprovalHandoff(task, handoffId, {
      trustNeedsApproval,
      externalAction,
    });
    const approved = await this.approvalFn({
      ...task,
      approval_request_id: handoffId,
      operator_handoff_id: handoffId,
    } as Task);
    if (recordedHandoffId) {
      await this.resolveApprovalHandoff(recordedHandoffId, approved);
    }
    await this.recordTaskPreExecutionPolicyDecision(task, {
      gate: "irreversible_approval",
      replayStage: approved ? "approval_granted" : "approval_denied",
      decision: approved ? "allow" : "block",
      capabilityDecision: approved ? "available" : "blocked",
      reason: approved
        ? "Operator approved task execution at the irreversible/external-action gate."
        : "Operator denied task execution at the irreversible/external-action gate.",
      permissionRequired: true,
      targetEffect: "execute_tool",
      capabilityRefs: approvalCapabilityRefs,
      policyRef: { kind: "intervention_policy", ref: "policy:task-irreversible-approval-v1" },
      currentRefs: [
        { kind: "operator_handoff", ref: handoffId },
      ],
      outcomeSummary: approved
        ? undefined
        : "Task execution was blocked because operator confirmation was denied.",
    });
    return approved;
  }

  private async recordTaskPreExecutionPolicyDecision(
    task: Task,
    decision: TaskPreExecutionPolicyDecisionInput,
  ): Promise<void> {
    await recordTaskPreExecutionPolicyDecision(this.personalAgentRuntime, task, decision);
  }

  private async recordApprovalHandoff(
    task: Task,
    handoffId: string,
    input: { trustNeedsApproval: boolean; externalAction: boolean }
  ): Promise<string | null> {
    if (!this.operatorHandoffStore) return null;
    const triggers: RuntimeOperatorHandoffTrigger[] = [];
    if (input.trustNeedsApproval) triggers.push("irreversible_action");
    if (input.externalAction) triggers.push("external_action");
    try {
      const record = await this.operatorHandoffStore.create({
        handoff_id: handoffId,
        goal_id: task.goal_id,
        triggers,
        title: `Approval required: ${task.work_description}`,
        summary: input.externalAction
          ? "Task appears to perform an external or submission action and cannot proceed without operator approval."
          : "Task reversibility/trust policy requires operator approval before execution.",
        current_status: `task=${task.id}, reversibility=${task.reversibility}, category=${task.task_category}`,
        recommended_action: "Review the task scope and approve only if the external or irreversible action is intended.",
        risks: [
          ...(input.externalAction ? ["External submission/publish/send actions can mutate systems outside local runtime state."] : []),
          ...(input.trustNeedsApproval ? ["Irreversible task execution may be difficult or impossible to roll back."] : []),
        ],
        required_approvals: [task.work_description],
        approval_request_id: handoffId,
        next_action: {
          label: task.work_description,
          approval_required: true,
        },
        gate: {
          autonomous_task_generation: "constrain",
          external_action_requires_approval: true,
        },
        evidence_refs: [{
          kind: "task",
          ref: `control-db://tasks/${task.goal_id}/${task.id}`,
          observed_at: task.created_at,
        }],
        created_at: task.created_at,
      });
      return record.handoff_id;
    } catch (err) {
      this.logger?.warn("TaskLifecycle: failed to record operator handoff", {
        goalId: task.goal_id,
        taskId: task.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  private async resolveApprovalHandoff(handoffId: string, approved: boolean): Promise<void> {
    if (!this.operatorHandoffStore) return;
    try {
      await this.operatorHandoffStore.resolve(handoffId, approved ? "approved" : "dismissed");
    } catch (err) {
      this.logger?.warn("TaskLifecycle: failed to resolve operator handoff", {
        handoffId,
        approved,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async buildDimensionSelectionBackoff(goalId: string): Promise<DimensionSelectionOptions> {
    const failureStatuses = new Set(["failed", "error", "timed_out", "abandoned", "discarded"]);
    const backoffCounts = new Map<string, number>();

    try {
      const rawHistory = await this.stateManager.loadTaskHistory(goalId);

      for (const entry of rawHistory.slice(-20) as Array<Record<string, unknown>>) {
        const dimension = typeof entry.primary_dimension === "string" ? entry.primary_dimension : null;
        if (!dimension) {
          continue;
        }

        const status = typeof entry.status === "string" ? entry.status : "";
        const verdict = typeof entry.verification_verdict === "string" ? entry.verification_verdict : "";
        const failureCount = typeof entry.consecutive_failure_count === "number"
          ? entry.consecutive_failure_count
          : 0;
        const failed =
          failureStatuses.has(status)
          || verdict === "fail"
          || verdict === "partial"
          || failureCount > 0;
        const passed = status === "completed" && verdict === "pass" && failureCount === 0;

        if (failed && !passed) {
          backoffCounts.set(dimension, (backoffCounts.get(dimension) ?? 0) + 1);
        }
      }
    } catch {
      return {};
    }

    if (backoffCounts.size === 0) {
      return {};
    }

    const backoffByDimension: Record<string, number> = {};
    for (const [dimension, count] of backoffCounts) {
      backoffByDimension[dimension] = Math.max(0.1, 1 / (count + 1));
    }
    return { backoffByDimension };
  }

  /** Execute a task via the given adapter. */
  async executeTask(task: Task, adapter: IAdapter, workspaceContext?: string): Promise<AgentResult> {
    await this.recordTaskExecutionTrace(task, {
      executionSurface: "adapter",
      capabilityRef: { kind: "adapter", ref: adapter.adapterType },
      workspaceContext,
    });
    return executeTaskWithGuards({
      task,
      adapter,
      workspaceContext,
      ...this.executionDeps(),
    });
  }

    /** Execute a task through the native task-level agentloop. */
  async executeTaskWithAgentLoop(
    task: Task,
    workspaceContext?: string,
    knowledgeContext?: string,
    abortSignal?: AbortSignal,
  ): Promise<AgentResult> {
    if (!this.agentLoopRunner) {
      throw new Error("TaskLifecycle: agentLoopRunner is required for native agentloop execution.");
    }

    const runningTask = { ...task, status: "running" as const, started_at: new Date().toISOString() };
    await this.recordTaskExecutionTrace(runningTask, {
      executionSurface: "agent_loop",
      capabilityRef: { kind: "agent_loop_runner", ref: "task-agent-loop" },
      workspaceContext,
    });
    await this.stateManager.saveTask(runningTask);
    await appendTaskOutcomeEvent(this.stateManager, {
      task: runningTask,
      type: "started",
      attempt: task.consecutive_failure_count + 1,
    });

    let result: AgentResult;
    try {
      const taskCwd = await resolveTaskWorkspacePath({
        stateManager: this.stateManager,
        task: runningTask,
        fallbackCwd: this.revertCwd,
      });
      const diffBaseline = captureExecutionDiffBaseline(this.execFileSyncFn, taskCwd ?? process.cwd());
      const artifactGoal = await this.stateManager.loadGoal(runningTask.goal_id).catch(() => null);
      const agentLoopBudget = deriveTaskAgentLoopBudget(runningTask, artifactGoal);
      const arcAgi3ToolPolicy = resolveArcAgi3AgentLoopToolPolicy(runningTask, artifactGoal);
      if (agentLoopBudget.reason === "profiled_estimate") {
        this.logger?.info?.("[TaskLifecycle] Aligning profiled task AgentLoop budget with generated estimate", {
          taskId: runningTask.id,
          generatedEstimateMs: agentLoopBudget.generatedEstimateMs,
          activeBudgetMs: agentLoopBudget.activeBudgetMs,
        });
      }
      const agentLoopResult = await this.agentLoopRunner.runTask({
        task: runningTask,
        artifactGoal,
        workspaceContext,
        knowledgeContext,
        cwd: taskCwd,
        ...(agentLoopBudget.budget ? { budget: agentLoopBudget.budget } : {}),
        ...(arcAgi3ToolPolicy ? { toolPolicy: arcAgi3ToolPolicy } : {}),
        ...(abortSignal ? { abortSignal } : {}),
      });
      agentLoopResult.activeBudgetMs ??= agentLoopBudget.activeBudgetMs;
      if (agentLoopBudget.generatedEstimateMs !== null) {
        agentLoopResult.generatedEstimateMs ??= agentLoopBudget.generatedEstimateMs;
      }
      result = taskAgentLoopResultToAgentResult(agentLoopResult);
      if (shouldKeepDaemonShutdownInterruptedTaskRunning(result, abortSignal)) {
        result.interruptedByDaemonShutdown = true;
      }
      if (result.stopped_reason === "timeout" && result.agentLoop) {
        const generated = result.agentLoop.generatedEstimateMs;
        const active = result.agentLoop.activeBudgetMs;
        const budgetDetail = [
          typeof generated === "number" ? `generated estimate ${generated}ms` : null,
          typeof active === "number" ? `active AgentLoop budget ${active}ms` : null,
        ].filter(Boolean).join("; ");
        if (budgetDetail) {
          result.error = [result.error, budgetDetail].filter(Boolean).join(" — ");
          result.output = [result.output, budgetDetail].filter(Boolean).join("\n");
        }
      }
      let capturedChangedPaths = [...new Set(agentLoopResult.changedFiles)];
      if (agentLoopResult.workspace?.executionCwd) {
        const fallbackChangedPaths = [
          ...new Set([
            ...agentLoopResult.changedFiles,
          ]),
        ];
        const diffArtifacts = captureExecutionDiffArtifacts(
          this.execFileSyncFn,
          agentLoopResult.workspace.executionCwd,
          { fallbackChangedPaths, baseline: diffBaseline },
        );
        result.diffEvidenceSource = diffArtifacts.evidenceSource;
        if (diffArtifacts.available) {
          capturedChangedPaths = diffArtifacts.changedPaths;
          result.filesChangedPaths = diffArtifacts.changedPaths;
          result.fileDiffs = diffArtifacts.fileDiffs;
          result.filesChanged = diffArtifacts.changedPaths.length > 0;
        }
      }
      failNativeCodeTaskWithoutFileChanges({ task: runningTask, result, capturedChangedPaths, logger: this.logger });
    } catch (err) {
      result = {
        success: false,
        output: "",
        error: err instanceof Error ? err.message : String(err),
        exit_code: null,
        elapsed_ms: 0,
        stopped_reason: "error",
      };
    }

    const completedAt = new Date().toISOString();
    const daemonShutdownInterruptedTask = shouldKeepDaemonShutdownInterruptedTaskRunning(result, abortSignal);
    const deferTerminalLedgerUntilVerification = shouldDeferAgentLoopTerminalUntilVerification(runningTask, result);
    const nextStatus =
      daemonShutdownInterruptedTask ? "running" as const :
      deferTerminalLedgerUntilVerification ? "running" as const :
      result.success ? "completed" as const :
      result.stopped_reason === "timeout" ? "timed_out" as const :
      result.stopped_reason === "cancelled" ? "cancelled" as const :
      result.stopped_reason === "blocked" || result.stopped_reason === "policy_blocked" ? "blocked" as const :
      "error" as const;
    await this.stateManager.saveTask({
      ...runningTask,
      status: nextStatus,
      execution_output: result.output,
      ...(nextStatus === "completed" ? { completed_at: completedAt } : {}),
      ...(nextStatus === "timed_out" ? { timeout_at: completedAt } : {}),
      ...(nextStatus === "cancelled" ? { stopped_at: completedAt } : {}),
      ...(nextStatus === "blocked" ? { stopped_at: completedAt } : {}),
    });

    if (daemonShutdownInterruptedTask || deferTerminalLedgerUntilVerification) {
      this.logger?.info("[TaskLifecycle] Deferring external AgentLoop terminal ledger event", {
        taskId: task.id,
        success: result.success,
        stoppedReason: result.stopped_reason,
        reason: daemonShutdownInterruptedTask ? "daemon_shutdown_interrupted" : "post_verification_required",
      });
    } else {
      await appendTaskOutcomeEvent(this.stateManager, {
        task: { ...runningTask, status: nextStatus },
        type: result.success ? "succeeded" : "failed",
        attempt: task.consecutive_failure_count + 1,
        reason: result.error ?? undefined,
        stoppedReason: result.success ? undefined : result.stopped_reason,
      });
    }

    return result;
  }

  /** Verify task execution results using 3-layer verification. */
  async verifyTask(
    task: Task,
    executionResult: AgentResult,
    preferredAdapterType?: string
  ): Promise<VerificationResult> {
    return _verifyTask(this.verifierDeps(preferredAdapterType), task, executionResult);
  }

  /** Handle a verification verdict (pass/partial/fail). */
  async handleVerdict(
    task: Task,
    verificationResult: VerificationResult,
    context?: VerdictHandlingContext
  ): Promise<VerdictResult> {
    return _handleVerdict(this.verifierDeps(), task, verificationResult, context);
  }

  /** Handle a task failure: increment failure count, record failure, decide keep/discard/escalate. */
  async handleFailure(
    task: Task,
    verificationResult: VerificationResult,
    context?: VerdictHandlingContext
  ): Promise<FailureResult> {
    return _handleFailure(this.verifierDeps(), task, verificationResult, context);
  }

  /** Run a full task cycle: select → generate → approve → execute → verify → verdict. */
  async runTaskCycle(
    goalId: string,
    gapVector: GapVector,
    driveContext: DriveContext,
    adapter: IAdapter,
    knowledgeContext?: string,
    existingTasks?: string[],
    workspaceContext?: string,
    options?: TaskCycleRunOptions
  ): Promise<TaskCycleResult> {
    return runTaskLifecycleCycle({
      goalId,
      gapVector,
      driveContext,
      adapter,
      knowledgeContext,
      existingTasks,
      workspaceContext,
      options,
      stateManager: this.stateManager,
      logger: this.logger,
      hookManager: this.hookManager,
      toolExecutor: this.toolExecutor,
      healthCheckEnabled: this.healthCheckEnabled,
      healthCheckCwd: this.healthCheckCwd,
      runPostExecutionHealthCheck: () => this.runPostExecutionHealthCheck(),
      verificationDeps: (preferredAdapterType) => this.verifierDeps(preferredAdapterType),
      sideEffectDeps: () => this.sideEffectDeps(),
      buildDimensionSelectionBackoff: (runGoalId) => this.buildDimensionSelectionBackoff(runGoalId),
      selectTargetDimension: (runGapVector, runDriveContext, dimensions, selectionOptions) =>
        this.selectTargetDimension(runGapVector, runDriveContext, dimensions, selectionOptions),
      generateTaskWithTokens: (runGoalId, targetDimension, strategyId, runKnowledgeContext, adapterType, runExistingTasks, runWorkspaceContext, executionMode) =>
        this._generateTaskWithTokens(runGoalId, targetDimension, strategyId, runKnowledgeContext, adapterType, runExistingTasks, runWorkspaceContext, executionMode),
      enrichmentDeps: () => this.enrichmentDeps(),
      checkIrreversibleApproval: (task) => this.checkIrreversibleApproval(task),
      preExecution: {
        ethicsGate: this.ethicsGate,
        capabilityDetector: this.capabilityDetector,
        approvalFn: this.approvalFn,
        recordPolicyDecision: (task, decision) => this.recordTaskPreExecutionPolicyDecision(task, decision),
      },
      hasNativeAgentLoop: Boolean(this.agentLoopRunner),
      executeTask: (task, runAdapter, runWorkspaceContext) => this.executeTask(task, runAdapter, runWorkspaceContext),
      executeTaskWithAgentLoop: (task, runWorkspaceContext, runKnowledgeContext, abortSignal) =>
        this.executeTaskWithAgentLoop(task, runWorkspaceContext, runKnowledgeContext, abortSignal),
      handleVerdict: (task, verificationResult, handleContext) => this.handleVerdict(task, verificationResult, handleContext),
    });
  }

  /**
   * Run a pipeline-based task cycle: select → generate → observe → approve → pipeline execute → map verdict.
   * Uses PipelineExecutor to orchestrate multi-role sequential execution.
   */
  async runPipelineTaskCycle(
    goalId: string,
    gapVector: GapVector,
    driveContext: DriveContext,
    adapter: IAdapter,
    pipeline: TaskPipeline,
    options?: PipelineCycleOptions
  ): Promise<TaskCycleResult> {
    return runPipelineTaskCycleFn(
      {
        stateManager: this.stateManager,
        sessionManager: this.sessionManager,
        llmClient: this.llmClient,
        ethicsGate: this.ethicsGate,
        capabilityDetector: this.capabilityDetector,
        approvalFn: this.approvalFn,
        adapterRegistry: this.adapterRegistry,
        toolExecutor: this.toolExecutor,
        personalAgentRuntime: this.personalAgentRuntime,
        logger: this.logger,
        knowledgeManager: this.knowledgeManager,
        checkIrreversibleApproval: (t) => this.checkIrreversibleApproval(t),
        selectTargetDimension: (gv, dc, dims) => this.selectTargetDimension(gv, dc, dims),
        generateTask: (gid, dim, sid, kc, at, et, wc) => this.generateTask(gid, dim, sid, kc, at, et, wc),
      },
      goalId,
      gapVector,
      driveContext,
      adapter,
      pipeline,
      options
    );
  }

  /** Build the VerifierDeps object passed to task-verifier.ts functions. */
  private verifierDeps(preferredAdapterType?: string) {
    return {
      stateManager: this.stateManager,
      llmClient: this.llmClient,
      sessionManager: this.sessionManager,
      trustManager: this.trustManager,
      stallDetector: this.stallDetector,
      adapterRegistry: this.adapterRegistry,
      preferredAdapterType,
      logger: this.logger,
      onTaskComplete: this.onTaskComplete,
      gateway: this.gateway,
      durationToMs: durationToMs,
      completionJudgerConfig: this.completionJudgerConfig,
      toolExecutor: this.toolExecutor,
      revertCwd: this.revertCwd,
    };
  }

  private executionDeps() {
    return {
      guardrailRunner: this.guardrailRunner,
      toolExecutor: this.toolExecutor,
      adapterRegistry: this.adapterRegistry,
      stateManager: this.stateManager,
      sessionManager: this.sessionManager,
      logger: this.logger,
      execFileSyncFn: this.execFileSyncFn,
      fallbackCwd: this.revertCwd,
      personalAgentRuntime: this.personalAgentRuntime,
    };
  }

  private enrichmentDeps() {
    return {
      knowledgeTransfer: this.knowledgeTransfer,
      knowledgeManager: this.knowledgeManager,
      stateManager: this.stateManager,
      logger: this.logger,
    };
  }

  private postExecutionDeps() {
    return {
      healthCheck: {
        enabled: this.healthCheckEnabled,
        run: () => this.runPostExecutionHealthCheck(),
      },
      successVerification: {
        toolExecutor: this.toolExecutor,
        verifyWithGitDiff: verifyExecutionWithGitDiff,
      },
    };
  }

  private sideEffectDeps() {
    return {
      stateManager: this.stateManager,
      sessionManager: this.sessionManager,
      llmClient: this.llmClient,
      knowledgeManager: this.knowledgeManager,
      logger: this.logger,
    };
  }

  /** Run build and test checks after successful task execution. Opt-in via healthCheckEnabled. */
  async runPostExecutionHealthCheck(): Promise<{ healthy: boolean; output: string }> {
    return _runPostExecutionHealthCheck(
      this.runShellCommand.bind(this),
      this.toolExecutor,
      this.healthCheckCwd,
    );
  }

  /** Run a shell command safely using execFile (not exec) to avoid shell injection. */
  async runShellCommand(
    argv: string[],
    options: { timeout: number; cwd: string }
  ): Promise<{ success: boolean; stdout: string; stderr: string }> {
    return _runShellCommand(argv, options);
  }

  private async recordTaskCandidateTrace(input: {
    goalId: string;
    targetDimension: string;
    strategyId?: string;
    adapterType?: string;
    existingTasks?: string[];
    workspaceContext?: string;
    executionMode?: ExecutionModeState;
    repoRoot?: string | null;
    playbookIdsUsed: string[];
  }): Promise<void> {
    const emittedAt = new Date().toISOString();
    const currentRefs: RuntimeGraphRef[] = [
      { kind: "goal", ref: input.goalId },
      { kind: "goal_dimension", ref: input.targetDimension },
      ...(input.strategyId ? [{ kind: "strategy", ref: input.strategyId }] : []),
      ...(input.adapterType ? [{ kind: "adapter", ref: input.adapterType }] : []),
      ...(input.repoRoot ? [{ kind: "workspace", ref: input.repoRoot }] : []),
      ...(input.executionMode ? [{ kind: "execution_mode", ref: `${input.executionMode.mode}:${input.executionMode.source}` }] : []),
      ...(input.existingTasks ?? []).map((taskId) => ({ kind: "task", ref: taskId })),
      ...input.playbookIdsUsed.map((playbookId) => ({ kind: "dream_playbook", ref: playbookId })),
    ];
    await this.personalAgentRuntime.recordTrace(buildPersonalAgentDecisionTrace({
      callerPath: "goal_gap_task_generation",
      source: {
        sourceKind: "goal_gap",
        sourceId: `${input.goalId}:${input.targetDimension}`,
        emittedAt,
        sourceEpoch: input.strategyId ?? input.executionMode?.mode ?? "strategy:none",
        highWatermark: [
          input.adapterType ?? "adapter:none",
          input.executionMode?.mode ?? "mode:none",
          input.existingTasks?.join(",") ?? "tasks:none",
        ].join(":"),
        replayKey: [
          "goal_gap_task_generation",
          input.goalId,
          input.targetDimension,
          input.strategyId ?? "",
          input.adapterType ?? "",
          input.executionMode?.mode ?? "",
          input.executionMode?.source ?? "",
          input.existingTasks?.join(",") ?? "",
        ].join(":"),
        summary: `Goal gap for dimension "${input.targetDimension}" proposed a task candidate.`,
        sourceRef: { kind: "goal", ref: input.goalId },
      },
      target: {
        kind: "task",
        ref: { kind: "goal_gap", ref: `${input.goalId}:${input.targetDimension}` },
        effect: "create_task",
        summary: `Task candidate for ${input.targetDimension}`,
      },
      decision: "allow",
      decisionReason: "Task generation may proceed only after the goal gap is represented as a durable TaskCandidate.",
      capabilityDecision: input.adapterType ? "available" : "not_applicable",
      capabilityRefs: input.adapterType ? [{ kind: "adapter", ref: input.adapterType }] : [],
      policyRef: { kind: "intervention_policy", ref: "policy:goal-gap-task-generation-v1" },
      currentRefs,
      memoryRefs: input.playbookIdsUsed.map((playbookId) => ({ kind: "dream_playbook", ref: playbookId })),
    }));
  }

  private async recordTaskExecutionTrace(
    task: Task,
    input: {
      executionSurface: "adapter" | "agent_loop";
      capabilityRef: RuntimeGraphRef;
      workspaceContext?: string;
    },
  ): Promise<void> {
    const emittedAt = task.started_at ?? new Date().toISOString();
    const permissionRequired = isExternalActionTask(task);
    await this.personalAgentRuntime.recordTrace(buildPersonalAgentDecisionTrace({
      callerPath: "task_execution",
      source: {
        sourceKind: "task_execution",
        sourceId: task.id,
        emittedAt,
        sourceEpoch: task.status,
        highWatermark: `${task.consecutive_failure_count}:${task.started_at ?? "not_started"}`,
        replayKey: [
          "task_execution",
          input.executionSurface,
          task.goal_id,
          task.id,
          task.consecutive_failure_count,
        ].join(":"),
        summary: `Task ${task.id} entered ${input.executionSurface} execution through Capability Registry.`,
        sourceRef: { kind: "task", ref: task.id },
      },
      target: {
        kind: "tool_call",
        ref: { kind: "task", ref: task.id },
        effect: "execute_tool",
        summary: task.work_description,
      },
      decision: "allow",
      decisionReason: permissionRequired
        ? "Task execution is allowed only after the external-action approval boundary has admitted it."
        : "Task execution is allowed by the task execution policy.",
      capabilityDecision: permissionRequired ? "permission_required" : "available",
      capabilityRefs: [
        input.capabilityRef,
        ...(permissionRequired ? [{ kind: "external_action", ref: task.risk_profile?.external_action.action_kind ?? "unknown" }] : []),
      ],
      policyRef: { kind: "intervention_policy", ref: "policy:task-execution-v1" },
      permissionRequired,
      currentRefs: [
        { kind: "goal", ref: task.goal_id },
        { kind: "task", ref: task.id },
        { kind: "task_dimension", ref: task.primary_dimension },
        ...(task.strategy_id ? [{ kind: "strategy", ref: task.strategy_id }] : []),
        ...(input.workspaceContext ? [{ kind: "workspace_context", ref: input.workspaceContext }] : []),
      ],
      outcomeEvent: {
        type: "action_outcome",
        summary: "Task execution trace was recorded before invoking the execution engine.",
        targetRef: { kind: "task", ref: task.id },
      },
    }));
  }

  private static isDepsObject(value: StateManager | TaskLifecycleDeps): value is TaskLifecycleDeps {
    return "stateManager" in value;
  }
}
