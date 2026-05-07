import type { Logger } from "../../../runtime/logger.js";
import type { Task } from "../../../base/types/task.js";
import type { AdapterRegistry, AgentResult, IAdapter } from "../adapter-layer.js";
import type { GuardrailRunner } from "../../../platform/traits/guardrail-runner.js";
import type { ToolExecutor } from "../../../tools/executor.js";
import {
  applyPostExecutionDiffScopeChecks,
  executeTask as executeTaskDirect,
} from "./task-executor.js";
import { captureExecutionDiffBaseline } from "./task-diff-capture.js";
import type { ExecutionDiffBaseline } from "./task-diff-capture.js";
import type { StateManager } from "../../../base/state/state-manager.js";
import type { SessionManager } from "../session-manager.js";
import { resolveTaskWorkspacePath } from "./task-workspace.js";

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
      return {
        success: false,
        output: `Guardrail rejected: ${beforeResult.results.map((r) => r.reason).filter(Boolean).join("; ")}`,
        error: "guardrail_rejected",
        exit_code: null,
        elapsed_ms: 0,
        stopped_reason: "error",
      };
    }
  }

  let directFallbackDiffBaseline: ExecutionDiffBaseline | undefined;
  if (toolExecutor) {
    try {
      const workspaceCwd = await resolveTaskWorkspacePath({ stateManager, task, fallbackCwd });
      let trustBalance = 0;
      try {
        await stateManager.loadGoal(task.goal_id);
      } catch {
        // non-fatal, keep default trust balance
      }
      const toolCtx = {
        cwd: workspaceCwd ?? process.cwd(),
        goalId: task.goal_id,
        trustBalance,
        preApproved: true,
        approvalFn: async () => false,
      };
      const diffBaseline = captureExecutionDiffBaseline(execFileSyncFn, toolCtx.cwd);
      directFallbackDiffBaseline = diffBaseline;
      const toolResult = await toolExecutor.execute(
        "run-adapter",
        {
          adapter_id: adapter.adapterType,
          task_description: task.work_description ?? "",
          goal_id: task.goal_id,
          ...(workspaceCwd !== undefined ? { cwd: workspaceCwd } : {}),
        },
        toolCtx
      );
      if (toolResult.data != null) {
        if (isAgentResult(toolResult.data)) {
          const result = toolResult.data;
          await applyPostExecutionDiffScopeChecks({
            result,
            taskId: task.id,
            cwd: workspaceCwd ?? process.cwd(),
            execFileSyncFn,
            logger,
            fallbackChangedPaths: result.filesChangedPaths,
            baseline: diffBaseline,
          });
          return result;
        }

        logger?.warn?.("[TaskLifecycle] run-adapter tool returned an invalid adapter result after execution");
        return await buildInvalidRunAdapterResult({
          taskId: task.id,
          cwd: workspaceCwd ?? process.cwd(),
          execFileSyncFn,
          logger,
          baseline: diffBaseline,
          reason: "run-adapter returned invalid or truncated adapter result",
        });
      } else {
        logger?.warn?.(`[TaskLifecycle] run-adapter tool failed, falling back to direct call: ${toolResult.error ?? "unknown"}`);
      }
    } catch (err) {
      logger?.warn?.(`[TaskLifecycle] run-adapter tool threw, falling back to direct call: ${(err as Error).message}`);
    }
  }

  const result = await executeTaskDirect(
    {
      stateManager,
      sessionManager,
      logger,
      execFileSyncFn,
      fallbackCwd,
    },
    task,
    adapter,
    workspaceContext,
    undefined,
    { diffBaseline: directFallbackDiffBaseline },
  );
  recordAdapterCircuitOutcome(adapterRegistry, adapter.adapterType, result);

  if (guardrailRunner) {
    const afterResult = await guardrailRunner.run("after_tool", {
      checkpoint: "after_tool",
      goal_id: task.goal_id,
      task_id: task.id,
      input: { task, result, adapter_type: adapter.adapterType },
    });
    if (!afterResult.allowed) {
      return {
        success: false,
        output: `Guardrail rejected result: ${afterResult.results.map((r) => r.reason).filter(Boolean).join("; ")}`,
        error: "guardrail_rejected",
        exit_code: null,
        elapsed_ms: result.elapsed_ms,
        stopped_reason: "error",
      };
    }
  }

  return result;
}

async function buildInvalidRunAdapterResult(input: {
  taskId: string;
  cwd: string;
  execFileSyncFn: ExecuteTaskWithGuardsParams["execFileSyncFn"];
  logger?: Logger;
  baseline?: ExecutionDiffBaseline;
  reason: string;
}): Promise<AgentResult> {
  const result: AgentResult = {
    success: true,
    output: "",
    error: null,
    exit_code: null,
    elapsed_ms: 0,
    stopped_reason: "completed",
  };
  await applyPostExecutionDiffScopeChecks({
    result,
    taskId: input.taskId,
    cwd: input.cwd,
    execFileSyncFn: input.execFileSyncFn,
    logger: input.logger,
    baseline: input.baseline,
  });

  const scopeError = result.error;
  result.success = false;
  result.error = scopeError ? `${input.reason}; ${scopeError}` : input.reason;
  result.output = [
    result.output,
    `[Execution Result] ${input.reason}`,
  ].filter((value) => value.length > 0).join("\n");
  result.exit_code = null;
  result.stopped_reason = "error";
  return result;
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
