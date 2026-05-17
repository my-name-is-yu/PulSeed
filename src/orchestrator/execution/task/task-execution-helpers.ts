import type { Logger } from "../../../runtime/logger.js";
import type { Task } from "../../../base/types/task.js";
import { AdapterRegistry, type AgentResult, type AgentTask, type IAdapter } from "../adapter-layer.js";
import type { GuardrailRunner } from "../../../platform/traits/guardrail-runner.js";
import { ToolExecutor } from "../../../tools/executor.js";
import { ToolRegistry } from "../../../tools/registry.js";
import { ToolPermissionManager } from "../../../tools/permission.js";
import { ConcurrencyController } from "../../../tools/concurrency.js";
import { RunAdapterTool } from "../../../tools/execution/RunAdapterTool/RunAdapterTool.js";
import {
  executeTask as executeTaskWithAdapterState,
} from "./task-executor.js";
import type { StateManager } from "../../../base/state/state-manager.js";
import type { SessionManager } from "../session-manager.js";
import { PersonalAgentRuntimeStore } from "../../../runtime/personal-agent/index.js";
import type { PersonalAgentRuntimeStore as PersonalAgentRuntimeStoreType } from "../../../runtime/personal-agent/index.js";
import { recordTaskPreExecutionPolicyDecision } from "./task-pre-execution-policy-trace.js";

const INVALID_RUN_ADAPTER_RESULT_REASON = "run-adapter returned invalid or truncated adapter result";

interface ExecuteTaskWithGuardsParams {
  task: Task;
  adapter: IAdapter;
  workspaceContext?: string;
  guardrailRunner?: GuardrailRunner;
  toolExecutor?: ToolExecutor;
  adapterRegistry?: AdapterRegistry;
  stateManager: StateManager;
  sessionManager: SessionManager;
  logger?: Logger;
  execFileSyncFn: (cmd: string, args: string[], opts: { cwd: string; encoding: "utf-8" }) => string;
  fallbackCwd?: string;
  personalAgentRuntime?: Pick<PersonalAgentRuntimeStoreType, "recordTrace">;
}

export async function executeTaskWithGuards(
  params: ExecuteTaskWithGuardsParams
): Promise<AgentResult> {
  const {
    task,
    adapter,
    workspaceContext,
    guardrailRunner,
    toolExecutor,
    adapterRegistry,
    stateManager,
    sessionManager,
    logger,
    execFileSyncFn,
    fallbackCwd,
  } = params;

  if (guardrailRunner) {
    const beforeResult = await guardrailRunner.run("before_tool", {
      checkpoint: "before_tool",
      goal_id: task.goal_id,
      task_id: task.id,
      input: { task, adapter_type: adapter.adapterType },
    });
    if (!beforeResult.allowed) {
      const reason = guardrailReasons(beforeResult.results);
      await recordGuardrailBlock(params, "guardrail_before", reason, 0);
      return {
        success: false,
        output: `Guardrail rejected: ${reason}`,
        error: "guardrail_rejected",
        exit_code: null,
        elapsed_ms: 0,
        stopped_reason: "error",
      };
    }
  }

  const executionToolExecutor = toolExecutor ?? createRunAdapterToolExecutor({
    stateManager,
    adapterRegistry,
    adapter,
  });
  const toolBackedAdapter = createToolBackedAdapter({
    adapter,
    task,
    stateManager,
    toolExecutor: executionToolExecutor,
  });

  let result: AgentResult;
  try {
    result = normalizeInvalidRunAdapterResult(await executeTaskWithAdapterState(
      { stateManager, sessionManager, logger, execFileSyncFn, fallbackCwd },
      task,
      toolBackedAdapter,
      workspaceContext,
    ));
    if (isInvalidRunAdapterResult(result)) {
      await stateManager.saveTask({
        ...task,
        status: "error",
        completed_at: new Date().toISOString(),
        execution_output: result.output,
      });
    }
  } catch (err) {
    const message = (err as Error).message;
    logger?.warn?.(`[TaskLifecycle] run-adapter tool threw; direct adapter fallback is disabled: ${message}`);
    result = buildNotExecutedAdapterResult("run_adapter_tool_error", `run-adapter admission failed: ${message}`, message);
  }
  recordAdapterCircuitOutcome(adapterRegistry, adapter.adapterType, result);

  if (guardrailRunner) {
    const afterResult = await guardrailRunner.run("after_tool", {
      checkpoint: "after_tool",
      goal_id: task.goal_id,
      task_id: task.id,
      input: { task, result, adapter_type: adapter.adapterType },
    });
    if (!afterResult.allowed) {
      const reason = guardrailReasons(afterResult.results);
      await recordGuardrailBlock(params, "guardrail_after", reason, result.elapsed_ms);
      return {
        success: false,
        output: `Guardrail rejected result: ${reason}`,
        error: "guardrail_rejected",
        exit_code: null,
        elapsed_ms: result.elapsed_ms,
        stopped_reason: "error",
      };
    }
  }

  return result;
}

async function recordGuardrailBlock(
  params: ExecuteTaskWithGuardsParams,
  gate: "guardrail_before" | "guardrail_after",
  reason: string,
  elapsedMs: number,
): Promise<void> {
  const store = params.personalAgentRuntime
    ?? new PersonalAgentRuntimeStore(params.stateManager.getBaseDir(), {
      controlBaseDir: params.stateManager.getBaseDir(),
    });
  await recordTaskPreExecutionPolicyDecision(store, params.task, {
    gate,
    replayStage: "guardrail_rejected",
    decision: "block",
    capabilityDecision: "blocked",
    reason: `${gate === "guardrail_before" ? "Before-tool" : "After-tool"} guardrail rejected task execution: ${reason}`,
    permissionRequired: false,
    targetEffect: "execute_tool",
    capabilityRefs: [
      { kind: "guardrail", ref: gate },
      { kind: "adapter", ref: params.adapter.adapterType },
    ],
    policyRef: { kind: "intervention_policy", ref: "policy:task-guardrail-v1" },
    outcomeSummary: `Task execution was blocked by ${gate} guardrail after ${elapsedMs}ms.`,
  });
}

function guardrailReasons(results: Array<{ reason?: string | null }>): string {
  return results.map((result) => result.reason).filter(Boolean).join("; ") || "guardrail rejected execution";
}

function createRunAdapterToolExecutor(input: {
  stateManager: StateManager;
  adapterRegistry?: AdapterRegistry;
  adapter: IAdapter;
}): ToolExecutor {
  const registry = new ToolRegistry();
  const adapterRegistry = input.adapterRegistry ?? new AdapterRegistry();
  adapterRegistry.register(input.adapter);
  registry.register(new RunAdapterTool(adapterRegistry));
  const baseDir = input.stateManager.getBaseDir();
  return new ToolExecutor({
    registry,
    permissionManager: new ToolPermissionManager({}),
    concurrency: new ConcurrencyController(),
    personalAgentRuntime: new PersonalAgentRuntimeStore(baseDir, { controlBaseDir: baseDir }),
    traceBaseDir: baseDir,
  });
}

function createToolBackedAdapter(input: {
  adapter: IAdapter;
  task: Task;
  stateManager: StateManager;
  toolExecutor: ToolExecutor;
}): IAdapter {
  const { adapter, task, stateManager, toolExecutor } = input;
  const baseDir = stateManager.getBaseDir();
  const traceStore = new PersonalAgentRuntimeStore(baseDir, { controlBaseDir: baseDir });
  return {
    adapterType: adapter.adapterType,
    capabilityPlaneBoundary: "run_adapter_tool",
    ...(adapter.capabilities !== undefined ? { capabilities: adapter.capabilities } : {}),
    ...(adapter.formatPrompt ? { formatPrompt: adapter.formatPrompt.bind(adapter) } : {}),
    ...(adapter.checkDuplicate ? { checkDuplicate: adapter.checkDuplicate.bind(adapter) } : {}),
    async execute(agentTask: AgentTask): Promise<AgentResult> {
      const toolResult = await toolExecutor.execute(
        "run-adapter",
        {
          adapter_id: adapter.adapterType,
          task_description: agentTask.prompt,
          goal_id: task.goal_id,
          timeout_ms: agentTask.timeout_ms,
          ...(agentTask.cwd !== undefined ? { cwd: agentTask.cwd } : {}),
          ...(agentTask.allowed_tools !== undefined ? { allowed_tools: [...agentTask.allowed_tools] } : {}),
          ...(agentTask.system_prompt !== undefined ? { system_prompt: agentTask.system_prompt } : {}),
        },
        {
          cwd: agentTask.cwd ?? process.cwd(),
          goalId: task.goal_id,
          taskId: task.id,
          trustBalance: 0,
          preApproved: true,
          approvalFn: async () => false,
          providerConfigBaseDir: baseDir,
          personalAgentRuntime: traceStore,
          personalAgentTrace: {
            callerPath: "task_execution",
            sourceKind: "task_execution",
            sourceId: task.id,
            sourceEpoch: task.started_at ?? task.created_at,
            highWatermark: `${task.goal_id}:${task.id}`,
            replayKey: `task_execution:run_adapter:${task.goal_id}:${task.id}`,
            summary: `Execute task ${task.id} through run-adapter.`,
            sourceRef: { kind: "task", ref: task.id },
            currentRefs: [
              { kind: "goal", ref: task.goal_id },
              { kind: "task", ref: task.id },
            ],
          },
        }
      );
      if (toolResult.data != null) {
        if (isAgentResult(toolResult.data)) {
          return toolResult.data;
        }
        return makeInvalidRunAdapterResult();
      }
      const policyReason = toolResult.execution?.reason;
      return buildNotExecutedAdapterResult(
        policyReason ?? (toolResult.error ? "run_adapter_tool_error" : "run_adapter_tool_blocked"),
        `run-adapter was not executed: ${toolResult.error ?? toolResult.summary}`,
        policyReason ? undefined : toolResult.error,
      );
    },
  };
}

function makeInvalidRunAdapterResult(): AgentResult {
  return {
    success: true,
    output: "",
    structuredOutput: { pulseedRunAdapterInvalidResult: true },
    error: null,
    exit_code: null,
    elapsed_ms: 0,
    stopped_reason: "completed",
  };
}

function isInvalidRunAdapterResult(result: AgentResult): boolean {
  return Boolean(
    result.structuredOutput
    && typeof result.structuredOutput === "object"
    && (result.structuredOutput as { pulseedRunAdapterInvalidResult?: unknown }).pulseedRunAdapterInvalidResult === true
  );
}

function normalizeInvalidRunAdapterResult(result: AgentResult): AgentResult {
  if (!isInvalidRunAdapterResult(result)) return result;
  const scopeError = result.error;
  return {
    ...result,
    success: false,
    output: [
      result.output,
      `[Execution Result] ${INVALID_RUN_ADAPTER_RESULT_REASON}`,
    ].filter((value) => value.length > 0).join("\n"),
    error: scopeError ? `${INVALID_RUN_ADAPTER_RESULT_REASON}; ${scopeError}` : INVALID_RUN_ADAPTER_RESULT_REASON,
    exit_code: null,
    stopped_reason: "error",
  };
}

function buildNotExecutedAdapterResult(reason: string, message: string, errorOverride?: string): AgentResult {
  return {
    success: false,
    output: message,
    error: errorOverride ?? reason,
    exit_code: null,
    elapsed_ms: 0,
    stopped_reason: "error",
  };
}

function isAgentResult(value: unknown): value is AgentResult {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<AgentResult>;
  return (
    typeof candidate.success === "boolean"
    && typeof candidate.output === "string"
    && (typeof candidate.error === "string" || candidate.error === null)
    && (typeof candidate.exit_code === "number" || candidate.exit_code === null)
    && typeof candidate.elapsed_ms === "number"
    && typeof candidate.stopped_reason === "string"
  );
}

function recordAdapterCircuitOutcome(
  adapterRegistry: AdapterRegistry | undefined,
  adapterType: string,
  result: AgentResult
): void {
  if (!adapterRegistry) return;
  if (result.stopped_reason === "error" || result.stopped_reason === "timeout") {
    adapterRegistry.recordFailure(adapterType);
    return;
  }
  adapterRegistry.recordSuccess(adapterType);
}

export async function verifyExecutionWithGitDiff(
  toolExecutor: ToolExecutor | undefined,
  goalId: string,
  executionResult?: AgentResult,
): Promise<{ verified: boolean; diffSummary: string; source: "filesystem_artifact" | "git" | "unavailable" | "skipped" }> {
  const filesystemChangedPaths = [
    ...(executionResult?.filesChangedPaths ?? []),
    ...(executionResult?.agentLoop?.filesChangedPaths ?? []),
    ...(executionResult?.fileDiffs?.map((diff) => diff.path) ?? []),
  ].filter((value, index, values) => value.length > 0 && values.indexOf(value) === index);
  if (executionResult?.diffEvidenceSource === "filesystem_artifact" && filesystemChangedPaths.length > 0) {
    return {
      verified: true,
      diffSummary: `${filesystemChangedPaths.length} file${filesystemChangedPaths.length !== 1 ? "s" : ""} changed via filesystem evidence`,
      source: "filesystem_artifact",
    };
  }

  if (!toolExecutor) return { verified: true, diffSummary: "", source: "skipped" };

  try {
    const result = await toolExecutor.execute(
      "git_diff",
      { target: "unstaged", maxLines: 200 },
      {
        cwd: executionResult?.agentLoop?.executionCwd ?? executionResult?.agentLoop?.requestedCwd ?? process.cwd(),
        goalId,
        trustBalance: 0,
        preApproved: true,
        approvalFn: async () => true,
      }
    );

    if (!result.success) return { verified: true, diffSummary: "diff unavailable", source: "unavailable" };

    const diffText = typeof result.data === "string" ? result.data : "";
    if (!diffText.trim()) {
      return { verified: false, diffSummary: "no changes detected", source: "git" };
    }

    const filesChanged = (diffText.match(/^diff --git /gm) ?? []).length;
    return {
      verified: filesChanged > 0,
      diffSummary: `${filesChanged} file${filesChanged !== 1 ? "s" : ""} changed`,
      source: "git",
    };
  } catch {
    return { verified: true, diffSummary: "diff check failed", source: "unavailable" };
  }
}
