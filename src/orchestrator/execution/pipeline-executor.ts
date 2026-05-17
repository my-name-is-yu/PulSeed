// ─── PipelineExecutor ───
//
// Executes a TaskPipeline sequentially with persistence and idempotency.
// Phase 2: Plan Approval Gate, 3-stage escalation, strategy feedback.

import type { Logger } from "../../runtime/logger.js";
import type { StateManager } from "../../base/state/state-manager.js";
import type { AgentTask, AgentResult, IAdapter } from "./adapter-layer.js";
import { AdapterRegistry } from "./adapter-layer.js";
import type { TaskPipeline, PipelineStage, PipelineState, StageResult } from "../../base/types/pipeline.js";
import { PipelineStateSchema } from "../../base/types/pipeline.js";
import type { Verdict } from "../../base/types/core.js";
import { ToolExecutor } from "../../tools/executor.js";
import { ToolRegistry } from "../../tools/registry.js";
import { ToolPermissionManager } from "../../tools/permission.js";
import { ConcurrencyController } from "../../tools/concurrency.js";
import type { ToolCallContext } from "../../tools/types.js";
import { RunAdapterTool } from "../../tools/execution/RunAdapterTool/RunAdapterTool.js";
import {
  PersonalAgentRuntimeStore,
  buildPersonalAgentDecisionTrace,
  stableId,
  type CapabilityRegistryDecisionKind,
  type InterventionDecisionKind,
  type PersonalAgentRuntimeStore as PersonalAgentRuntimeStoreType,
  type RuntimeGraphRef,
} from "../../runtime/personal-agent/index.js";

// ─── Types ───

export interface PlanApprovalResult {
  approved: boolean;
  plan: string;
  modified_plan?: string;
}

export interface PipelineExecutorDeps {
  stateManager: StateManager;
  adapterRegistry: AdapterRegistry;
  logger?: Logger;
  /** Optional ToolExecutor. Pipeline adapter execution is admitted through run-adapter when supplied. */
  toolExecutor?: ToolExecutor;
  /** Durable personal-agent runtime trace recorder for pipeline execution admission. */
  personalAgentRuntime?: Pick<PersonalAgentRuntimeStoreType, "recordTrace">;
  /** Plan gate: called when plan_required=true and trust < HIGH_TRUST_THRESHOLD */
  approvalFn?: (plan: string) => Promise<boolean>;
  /** Strategy feedback: called at pipeline completion when strategy_id is set */
  strategyFeedbackFn?: (strategyId: string, verdict: string) => void;
  /** Escalation: find an alternative adapter for a domain, excluding a failed one */
  findAlternativeAdapter?: (domain: string, excludeAdapter: string) => string | null;
  /** Max retries per stage (default: 3) */
  maxRetries?: number;
}

export interface PipelineRunResult {
  pipeline_id: string;
  final_verdict: Verdict;
  stage_results: StageResult[];
  status: PipelineState["status"];
}

export interface PipelineRunContext {
  goalId?: string;
}

type TaskPipelineExt = TaskPipeline & { plan_required?: boolean };
type PipelineAdapterExecutionPurpose = "plan" | "stage";

interface PipelineAdapterExecutionContext {
  goalId: string;
  taskId: string;
  pipelineId: string;
  stageIndex: number;
  stageRole: PipelineStage["role"];
  purpose: PipelineAdapterExecutionPurpose;
  idempotencyKey?: string;
}

type PipelineApprovalGate = "plan_approval" | "final_retry_approval";

const HIGH_TRUST_THRESHOLD = 20;
const PLAN_MODE_PREFIX = "Generate a plan for the following task. Do NOT execute — output the plan only.\n\n";

// ─── PipelineExecutor ───

export class PipelineExecutor {
  private readonly stateManager: StateManager;
  private readonly adapterRegistry: AdapterRegistry;
  private readonly logger?: Logger;
  private readonly toolExecutor: ToolExecutor;
  private readonly personalAgentRuntime: Pick<PersonalAgentRuntimeStoreType, "recordTrace">;
  private readonly traceBaseDir: string;
  private readonly approvalFn?: (plan: string) => Promise<boolean>;
  private readonly strategyFeedbackFn?: (strategyId: string, verdict: string) => void;
  private readonly findAlternativeAdapter?: (domain: string, excludeAdapter: string) => string | null;
  private readonly maxRetries: number;

  constructor(deps: PipelineExecutorDeps) {
    this.stateManager = deps.stateManager;
    this.adapterRegistry = deps.adapterRegistry;
    this.logger = deps.logger;
    this.traceBaseDir = stateManagerBaseDir(deps.stateManager);
    this.personalAgentRuntime = deps.personalAgentRuntime
      ?? new PersonalAgentRuntimeStore(this.traceBaseDir, { controlBaseDir: this.traceBaseDir });
    this.toolExecutor = deps.toolExecutor ?? createRunAdapterToolExecutor({
      adapterRegistry: this.adapterRegistry,
      baseDir: this.traceBaseDir,
      personalAgentRuntime: this.personalAgentRuntime,
    });
    this.approvalFn = deps.approvalFn;
    this.strategyFeedbackFn = deps.strategyFeedbackFn;
    this.findAlternativeAdapter = deps.findAlternativeAdapter;
    this.maxRetries = deps.maxRetries ?? 3;
  }

  async run(
    taskId: string,
    task: AgentTask,
    pipeline: TaskPipelineExt,
    observationContext?: string,
    trustScore?: number,
    runContext?: PipelineRunContext
  ): Promise<PipelineRunResult> {
    let state = await this.restoreState(taskId);
    const isResume = state !== null && state.status === "interrupted";
    const goalId = runContext?.goalId ?? `pipeline:${taskId}`;

    if (!isResume) {
      const now = new Date().toISOString();
      state = {
        pipeline_id: deterministicPipelineId(taskId, pipeline),
        task_id: taskId,
        current_stage_index: 0,
        completed_stages: [],
        status: "running",
        started_at: now,
        updated_at: now,
      };
    } else {
      this.logger?.info("[PipelineExecutor] Resuming interrupted pipeline", {
        taskId, fromStage: state!.current_stage_index,
      });
      state = { ...state!, status: "running", updated_at: new Date().toISOString() };
    }

    await this.persistState(taskId, state!);

    for (let i = state!.current_stage_index; i < pipeline.stages.length; i++) {
      const stage = pipeline.stages[i];
      const idempotencyKey = `${taskId}:${i}:0`;

      if (state!.completed_stages.some((r) => r.idempotency_key === idempotencyKey)) {
        this.logger?.info("[PipelineExecutor] Skipping completed stage", { stage: i });
        continue;
      }

      // Plan Approval Gate
      if (stage.role === "implementor" && pipeline.plan_required) {
        const gate = await this.runPlanApprovalGate(
          stage,
          task,
          pipeline,
          observationContext,
          trustScore,
          {
            goalId,
            taskId,
            pipelineId: state!.pipeline_id,
            stageIndex: i,
            stageRole: stage.role,
            purpose: "plan",
          },
        );
        if (!gate.approved) {
          this.logger?.info("[PipelineExecutor] Plan not approved — aborting", { stage: i });
          state = { ...state!, status: "failed", updated_at: new Date().toISOString() };
          await this.persistState(taskId, state);
          break;
        }
        if (gate.modified_plan) {
          pipeline = { ...pipeline, shared_context: gate.modified_plan };
        }
      }

      const stageResult = await this.executeWithEscalation(
        i,
        stage,
        task,
        pipeline,
        observationContext,
        idempotencyKey,
        {
          goalId,
          taskId,
          pipelineId: state!.pipeline_id,
          stageIndex: i,
          stageRole: stage.role,
          purpose: "stage",
          idempotencyKey,
        },
      );

      state = {
        ...state!,
        current_stage_index: i + 1,
        completed_stages: [...state!.completed_stages, stageResult],
        updated_at: new Date().toISOString(),
      };
      await this.persistState(taskId, state);

      this.logger?.info("[PipelineExecutor] Stage complete", { stage: i, role: stage.role, verdict: stageResult.verdict });

      if (pipeline.fail_fast && stageResult.verdict === "fail") {
        state = { ...state, status: "failed", updated_at: new Date().toISOString() };
        await this.persistState(taskId, state);
        break;
      }
    }

    if (state!.status === "running") {
      state = { ...state!, status: "completed", updated_at: new Date().toISOString() };
      await this.persistState(taskId, state);
    }

    const lastStage = state!.completed_stages[state!.completed_stages.length - 1];
    const finalVerdict: Verdict = lastStage?.verdict ?? "fail";

    if (pipeline.strategy_id && this.strategyFeedbackFn) {
      this.strategyFeedbackFn(pipeline.strategy_id, finalVerdict);
    }

    return {
      pipeline_id: state!.pipeline_id,
      final_verdict: finalVerdict,
      stage_results: state!.completed_stages,
      status: state!.status,
    };
  }

  // ─── Plan Approval Gate ───

  private async runPlanApprovalGate(
    stage: PipelineStage,
    task: AgentTask,
    pipeline: TaskPipeline,
    observationContext: string | undefined,
    trustScore: number | undefined,
    executionContext: PipelineAdapterExecutionContext
  ): Promise<PlanApprovalResult> {
    const planTask = this.buildStagePrompt(
      { ...stage, prompt_override: PLAN_MODE_PREFIX },
      task, observationContext, pipeline.shared_context
    );

    let plan = "";
    try {
      const adapter = this.selectAdapter(stage);
      const result = await this.executeAdapterWithCircuitBreaker(adapter, planTask, executionContext);
      if (!result.success) {
        this.logger?.warn("[PipelineExecutor] Plan generation failed", { error: result.error ?? "unknown failure" });
        return { approved: false, plan: "" };
      }
      plan = result.output;
    } catch (err) {
      this.logger?.warn("[PipelineExecutor] Plan generation failed", { error: err instanceof Error ? err.message : String(err) });
      return { approved: false, plan: "" };
    }

    if (trustScore !== undefined && trustScore >= HIGH_TRUST_THRESHOLD) {
      this.logger?.info("[PipelineExecutor] Plan auto-approved (high trust)", { trustScore });
      await this.recordPipelineApprovalDecision(executionContext, {
        gate: "plan_approval",
        replayStage: "high_trust_auto_approved",
        decision: "allow",
        capabilityDecision: "available",
        reason: `Pipeline plan was auto-approved because trust score ${trustScore} meets the high-trust threshold.`,
        targetSummary: "Pipeline plan approval gate was admitted by trust policy.",
      });
      return { approved: true, plan };
    }

    if (this.approvalFn) {
      await this.recordPipelineApprovalDecision(executionContext, {
        gate: "plan_approval",
        replayStage: "confirm_required",
        decision: "confirm_required",
        capabilityDecision: "permission_required",
        reason: "Pipeline plan requires operator confirmation before implementor execution.",
        targetSummary: "Pipeline plan approval requires confirmation before execution continues.",
        permissionRequired: true,
      });
      const approved = await this.approvalFn(plan);
      await this.recordPipelineApprovalDecision(executionContext, {
        gate: "plan_approval",
        replayStage: approved ? "approval_granted" : "approval_denied",
        decision: approved ? "allow" : "block",
        capabilityDecision: approved ? "available" : "blocked",
        reason: approved
          ? "Operator approved the pipeline plan."
          : "Operator denied the pipeline plan.",
        targetSummary: approved
          ? "Pipeline plan approval gate was admitted by operator confirmation."
          : "Pipeline plan approval gate was blocked by operator denial.",
        permissionRequired: true,
        outcomeSummary: approved
          ? undefined
          : "Pipeline execution was blocked because the plan approval was denied.",
      });
      return { approved, plan };
    }

    this.logger?.warn("[PipelineExecutor] No approvalFn configured — plan denied");
    await this.recordPipelineApprovalDecision(executionContext, {
      gate: "plan_approval",
      replayStage: "approval_unavailable",
      decision: "block",
      capabilityDecision: "blocked",
      reason: "Pipeline plan requires confirmation, but no approval function is configured.",
      targetSummary: "Pipeline plan approval gate was blocked because confirmation was unavailable.",
      permissionRequired: true,
      outcomeSummary: "Pipeline execution was blocked because no approval function was configured.",
    });
    return { approved: false, plan };
  }

  // ─── 3-Stage Escalation ───

  private async executeWithEscalation(
    stageIndex: number,
    stage: PipelineStage,
    task: AgentTask,
    pipeline: TaskPipeline,
    observationContext: string | undefined,
    idempotencyKey: string,
    executionContext: PipelineAdapterExecutionContext
  ): Promise<StageResult> {
    // Without escalation deps, run a single attempt (backward-compatible).
    const maxAttempts = (this.approvalFn ?? this.findAlternativeAdapter) ? this.maxRetries : 1;
    let lastError = "";
    let currentAdapter = this.selectAdapter(stage);
    const baseTask = this.buildStagePrompt(stage, task, observationContext, pipeline.shared_context);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Strike 2: try alternative adapter
      if (attempt === 1 && stage.capability_requirement?.domain && this.findAlternativeAdapter) {
        const alt = this.findAlternativeAdapter(
          stage.capability_requirement.domain,
          stage.capability_requirement.preferred_adapter ?? ""
        );
        if (alt) {
          try {
            currentAdapter = this.adapterRegistry.getAdapter(alt);
            this.logger?.info("[PipelineExecutor] Escalation: switching adapter", { stage: stageIndex, adapter: alt });
          } catch { /* keep existing */ }
        }
      }

      // Strike 3: human escalation
      if (attempt === this.maxRetries - 1 && this.approvalFn) {
        this.logger?.warn("[PipelineExecutor] Escalation: requesting human approval", { stage: stageIndex });
        const approvalPrompt = `Stage ${stageIndex} (${stage.role}) failed ${attempt} time(s).\nLast error: ${lastError}\n\nApprove to attempt final retry?`;
        await this.recordPipelineApprovalDecision(executionContext, {
          gate: "final_retry_approval",
          replayStage: "confirm_required",
          decision: "confirm_required",
          capabilityDecision: "permission_required",
          reason: "Pipeline final retry requires operator confirmation after repeated stage failures.",
          targetSummary: "Pipeline final retry approval requires confirmation before execution continues.",
          permissionRequired: true,
        });
        const ok = await this.approvalFn(approvalPrompt);
        await this.recordPipelineApprovalDecision(executionContext, {
          gate: "final_retry_approval",
          replayStage: ok ? "approval_granted" : "approval_denied",
          decision: ok ? "allow" : "block",
          capabilityDecision: ok ? "available" : "blocked",
          reason: ok
            ? "Operator approved the pipeline final retry."
            : "Operator denied the pipeline final retry.",
          targetSummary: ok
            ? "Pipeline final retry was admitted by operator confirmation."
            : "Pipeline final retry was blocked by operator denial.",
          permissionRequired: true,
          outcomeSummary: ok
            ? undefined
            : "Pipeline stage execution was blocked because final retry approval was denied.",
        });
        if (!ok) {
          return this.makeStageResult(stageIndex, stage, idempotencyKey, false, "", "Human escalation rejected");
        }
      }

      const retryTask = attempt === 0
        ? baseTask
        : { ...baseTask, prompt: `${baseTask.prompt}\n\nPREVIOUS ATTEMPT FAILED: ${lastError}\nPlease try again.` };

      let result: AgentResult;
      result = await this.executeAdapterWithCircuitBreaker(currentAdapter, retryTask, {
        ...executionContext,
        idempotencyKey: `${idempotencyKey}:${attempt}`,
      });

      if (this.mapResultToVerdict(result) !== "fail") {
        return this.makeStageResult(stageIndex, stage, idempotencyKey, result.success, result.output);
      }

      lastError = result.error ?? "unknown failure";
      this.logger?.warn("[PipelineExecutor] Stage attempt failed", { stage: stageIndex, attempt: attempt + 1, error: lastError });
    }

    return this.makeStageResult(stageIndex, stage, idempotencyKey, false, "");
  }

  // ─── Private helpers ───

  private async executeAdapterWithCircuitBreaker(
    adapter: IAdapter,
    task: AgentTask,
    executionContext: PipelineAdapterExecutionContext
  ): Promise<AgentResult> {
    if (!this.adapterRegistry.isAvailable(adapter.adapterType)) {
      return {
        success: false,
        output: "",
        error: `Adapter circuit breaker is open for "${adapter.adapterType}"`,
        exit_code: null,
        elapsed_ms: 0,
        stopped_reason: "error",
      };
    }

    try {
      const result = await this.toolExecutor.execute(
        "run-adapter",
        {
          adapter_id: adapter.adapterType,
          task_description: task.prompt,
          goal_id: executionContext.goalId,
          timeout_ms: task.timeout_ms,
          ...(task.cwd !== undefined ? { cwd: task.cwd } : {}),
          ...(task.allowed_tools !== undefined ? { allowed_tools: [...task.allowed_tools] } : {}),
          ...(task.system_prompt !== undefined ? { system_prompt: task.system_prompt } : {}),
        },
        this.buildToolCallContext(adapter, task, executionContext),
      );
      if (result.data != null) {
        if (isAgentResult(result.data)) return result.data;
        return buildNotExecutedAdapterResult(
          "run_adapter_invalid_result",
          "run-adapter returned an invalid adapter result.",
        );
      }
      return buildNotExecutedAdapterResult(
        result.execution?.reason ?? (result.error ? "run_adapter_tool_error" : "run_adapter_tool_blocked"),
        `run-adapter was not executed: ${result.error ?? result.summary}`,
        result.execution?.reason ? undefined : result.error,
      );
    } catch (err) {
      return buildNotExecutedAdapterResult(
        "run_adapter_tool_error",
        "run-adapter admission failed.",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private async recordPipelineApprovalDecision(
    executionContext: PipelineAdapterExecutionContext,
    input: {
      gate: PipelineApprovalGate;
      replayStage: string;
      decision: InterventionDecisionKind;
      capabilityDecision: CapabilityRegistryDecisionKind;
      reason: string;
      targetSummary: string;
      permissionRequired?: boolean;
      outcomeSummary?: string;
    }
  ): Promise<void> {
    const sourceRef: RuntimeGraphRef = {
      kind: "pipeline_approval_gate",
      ref: `${executionContext.pipelineId}:${executionContext.stageIndex}:${input.gate}`,
    };
    const targetRef: RuntimeGraphRef = {
      kind: "pipeline_stage",
      ref: `${executionContext.pipelineId}:${executionContext.stageIndex}`,
    };
    const replayKey = [
      "pipeline_approval",
      input.gate,
      input.replayStage,
      input.decision,
      executionContext.goalId,
      executionContext.taskId,
      executionContext.pipelineId,
      executionContext.stageIndex,
    ].join(":");
    await this.personalAgentRuntime.recordTrace(buildPersonalAgentDecisionTrace({
      callerPath: "task_execution",
      source: {
        sourceKind: "task_execution",
        sourceId: sourceRef.ref,
        emittedAt: new Date().toISOString(),
        sourceEpoch: `${executionContext.stageRole}:${input.gate}:${input.replayStage}`,
        highWatermark: executionContext.idempotencyKey ?? `${executionContext.pipelineId}:${executionContext.stageIndex}`,
        replayKey,
        summary: `Pipeline ${executionContext.pipelineId} reached ${input.gate}.`,
        sourceRef,
      },
      target: {
        kind: "tool_call",
        ref: targetRef,
        effect: "execute_tool",
        summary: input.targetSummary,
      },
      decision: input.decision,
      decisionReason: input.reason,
      capabilityDecision: input.capabilityDecision,
      capabilityRefs: [
        { kind: "pipeline", ref: executionContext.pipelineId },
        { kind: "pipeline_stage", ref: String(executionContext.stageIndex) },
        { kind: "pipeline_gate", ref: input.gate },
      ],
      policyRef: { kind: "intervention_policy", ref: "policy:pipeline-approval-v1" },
      permissionRequired: input.permissionRequired ?? input.decision === "confirm_required",
      currentRefs: [
        { kind: "goal", ref: executionContext.goalId },
        { kind: "task", ref: executionContext.taskId },
        { kind: "pipeline", ref: executionContext.pipelineId },
        { kind: "pipeline_stage", ref: String(executionContext.stageIndex) },
        { kind: "pipeline_role", ref: executionContext.stageRole },
      ],
      ...(input.outcomeSummary
        ? {
            outcomeEvent: {
              type: "action_outcome" as const,
              summary: input.outcomeSummary,
              targetRef,
            },
          }
        : {}),
    }));
  }

  private buildToolCallContext(
    adapter: IAdapter,
    task: AgentTask,
    executionContext: PipelineAdapterExecutionContext,
  ): ToolCallContext {
    const replayKey = pipelineRunAdapterReplayKey(adapter, task, executionContext);
    return {
      cwd: task.cwd ?? this.traceBaseDir,
      goalId: executionContext.goalId,
      taskId: executionContext.taskId,
      trustBalance: 0,
      preApproved: true,
      approvalFn: async () => false,
      providerConfigBaseDir: this.traceBaseDir,
      personalAgentRuntime: this.personalAgentRuntime,
      callId: `pipeline-run-adapter:${stableId(replayKey)}`,
      sessionId: `goal:${executionContext.goalId}`,
      turnId: `pipeline:${executionContext.pipelineId}:${executionContext.stageIndex}:${executionContext.purpose}`,
      personalAgentTrace: {
        callerPath: "task_execution",
        sourceKind: "task_execution",
        sourceId: executionContext.taskId,
        sourceEpoch: executionContext.pipelineId,
        highWatermark: [
          executionContext.goalId,
          executionContext.taskId,
          executionContext.pipelineId,
          executionContext.idempotencyKey ?? executionContext.purpose,
        ].join(":"),
        replayKey,
        summary: `Execute pipeline ${executionContext.pipelineId} stage ${executionContext.stageIndex} through run-adapter.`,
        sourceRef: { kind: "task", ref: executionContext.taskId },
        currentRefs: [
          { kind: "goal", ref: executionContext.goalId },
          { kind: "task", ref: executionContext.taskId },
        ],
        auditRefs: [
          { kind: "pipeline", ref: executionContext.pipelineId },
          { kind: "pipeline_stage", ref: `${executionContext.stageIndex}:${executionContext.stageRole}` },
        ],
      },
    };
  }

  private makeStageResult(
    stageIndex: number,
    stage: PipelineStage,
    idempotencyKey: string,
    success: boolean,
    output: string,
    error?: string
  ): StageResult {
    const fakeResult: AgentResult = {
      success,
      output,
      error: error ?? null,
      exit_code: null,
      elapsed_ms: 0,
      stopped_reason: success ? "completed" : "error",
    };
    return {
      stage_index: stageIndex,
      role: stage.role,
      verdict: this.mapResultToVerdict(fakeResult),
      output,
      confidence: success ? 0.8 : 0.2,
      idempotency_key: idempotencyKey,
    };
  }

  private selectAdapter(stage: PipelineStage): IAdapter {
    const preferred = stage.capability_requirement?.preferred_adapter;
    if (preferred) {
      try { return this.adapterRegistry.getAdapter(preferred); } catch { /* fall through */ }
    }
    const types = this.adapterRegistry.listAdapters();
    if (types.length === 0) throw new Error("[PipelineExecutor] No adapters registered");
    return this.adapterRegistry.getAdapter(types[0]);
  }

  private buildStagePrompt(
    stage: PipelineStage,
    task: AgentTask,
    observationContext: string | undefined,
    sharedContext: string | undefined
  ): AgentTask {
    let prompt: string;

    switch (stage.role) {
      case "implementor":
      case "researcher": {
        const parts = [task.prompt];
        if (observationContext) parts.push(`\n\nOBSERVATION CONTEXT:\n${observationContext}`);
        if (sharedContext) parts.push(`\n\nSHARED CONTEXT:\n${sharedContext}`);
        prompt = parts.join("");
        break;
      }
      case "verifier": {
        prompt = task.prompt;
        if (sharedContext) prompt += `\n\nSHARED CONTEXT:\n${sharedContext}`;
        break;
      }
      default: {
        prompt = task.prompt;
      }
    }

    if (stage.prompt_override) prompt = `${stage.prompt_override}\n\n${prompt}`;
    return { ...task, prompt };
  }

  private async persistState(taskId: string, state: PipelineState): Promise<void> {
    await this.stateManager.savePipeline(taskId, state);
  }

  private async restoreState(taskId: string): Promise<PipelineState | null> {
    try {
      const state = await this.stateManager.loadPipeline(taskId);
      return state ? PipelineStateSchema.parse(state) : null;
    } catch {
      return null;
    }
  }

  private mapResultToVerdict(result: AgentResult): Verdict {
    if (result.stopped_reason === "error" || result.stopped_reason === "timeout") return "fail";
    if (result.success) return "pass";
    return "partial";
  }
}

function createRunAdapterToolExecutor(input: {
  adapterRegistry: AdapterRegistry;
  baseDir: string;
  personalAgentRuntime: Pick<PersonalAgentRuntimeStoreType, "recordTrace">;
}): ToolExecutor {
  const registry = new ToolRegistry();
  registry.register(new RunAdapterTool(input.adapterRegistry));
  return new ToolExecutor({
    registry,
    permissionManager: new ToolPermissionManager({}),
    concurrency: new ConcurrencyController(),
    personalAgentRuntime: input.personalAgentRuntime,
    traceBaseDir: input.baseDir,
  });
}

function stateManagerBaseDir(stateManager: StateManager): string {
  return stateManager.getBaseDir();
}

function deterministicPipelineId(taskId: string, pipeline: TaskPipelineExt): string {
  return `pipeline:${stableId(stableJson({
    taskId,
    stages: pipeline.stages,
    failFast: pipeline.fail_fast ?? null,
    sharedContext: pipeline.shared_context ?? null,
    strategyId: pipeline.strategy_id ?? null,
    planRequired: pipeline.plan_required ?? null,
  }))}`;
}

function pipelineRunAdapterReplayKey(
  adapter: IAdapter,
  task: AgentTask,
  executionContext: PipelineAdapterExecutionContext,
): string {
  return [
    "pipeline_task_execution:run_adapter",
    executionContext.goalId,
    executionContext.taskId,
    executionContext.pipelineId,
    String(executionContext.stageIndex),
    executionContext.purpose,
    executionContext.idempotencyKey ?? "",
    adapter.adapterType,
    stableId(stableJson({
      prompt: task.prompt,
      timeoutMs: task.timeout_ms ?? null,
      cwd: task.cwd ?? null,
      allowedTools: task.allowed_tools ?? null,
      systemPrompt: task.system_prompt ?? null,
    })),
  ].join(":");
}

function buildNotExecutedAdapterResult(reason: string, output: string, errorOverride?: string): AgentResult {
  return {
    success: false,
    output,
    error: errorOverride ?? reason,
    exit_code: null,
    elapsed_ms: 0,
    stopped_reason: "error",
  };
}

function isAgentResult(value: unknown): value is AgentResult {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Partial<AgentResult>;
  return typeof record.success === "boolean"
    && typeof record.output === "string"
    && (typeof record.elapsed_ms === "number" || record.elapsed_ms === undefined)
    && (record.stopped_reason === "completed"
      || record.stopped_reason === "timeout"
      || record.stopped_reason === "error"
      || record.stopped_reason === "cancelled"
      || record.stopped_reason === "blocked"
      || record.stopped_reason === "policy_blocked"
      || record.stopped_reason === undefined);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
