import type { Logger } from "../../../runtime/logger.js";
import { StateManager } from "../../../base/state/state-manager.js";
import { SessionManager } from "../session-manager.js";
import {
  adapterExecutionHasCapabilityPlaneAdmission,
  blockedDirectAdapterExecutionResult,
  type AgentTask,
  type AgentResult,
  type IAdapter,
} from "../adapter-layer.js";
import type { Task } from "../../../base/types/task.js";
import { TaskSchema } from "../../../base/types/task.js";
import type { Strategy } from "../../../base/types/strategy.js";
import { appendTaskOutcomeEvent } from "./task-outcome-ledger.js";
import { validateProtectedPath } from "../../../tools/fs/FileValidationTool/protected-path-policy.js";
import { loadProviderConfig } from "../../../base/llm/provider-config.js";
import { captureExecutionDiffArtifacts, captureExecutionDiffBaseline } from "./task-diff-capture.js";
import type { ExecutionDiffBaseline } from "./task-diff-capture.js";
import { resolveTaskWorkspacePath } from "./task-workspace.js";
const DEBUG = process.env.PULSEED_DEBUG === "true";

// ─── Deps interface ───

export interface TaskExecutorDeps {
  stateManager: StateManager;
  sessionManager: SessionManager;
  logger?: Logger;
  execFileSyncFn: (cmd: string, args: string[], opts: { cwd: string; encoding: "utf-8" }) => string;
  fallbackCwd?: string;
}

interface ExecuteTaskOptions {
  diffBaseline?: ExecutionDiffBaseline;
}

// ─── durationToMs ───

export function durationToMs(duration: { value: number; unit: string }): number {
  const multipliers: Record<string, number> = {
    minutes: 60 * 1000,
    hours: 60 * 60 * 1000,
    days: 24 * 60 * 60 * 1000,
    weeks: 7 * 24 * 60 * 60 * 1000,
  };
  return duration.value * (multipliers[duration.unit] ?? 60 * 60 * 1000);
}

// ─── executeTask ───

/**
 * Execute a task via the given adapter.
 *
 * Creates a session, builds context, converts to AgentTask, executes
 * via adapter, ends session, and updates task status based on result.
 */
export async function executeTask(
  deps: TaskExecutorDeps,
  task: Task,
  adapter: IAdapter,
  workspaceContext?: string,
  activeStrategy?: Strategy,
  options?: ExecuteTaskOptions,
): Promise<AgentResult> {
  const { stateManager, sessionManager, logger, execFileSyncFn, fallbackCwd } = deps;

  const workspaceCwd = await resolveTaskWorkspacePath({ stateManager, task, fallbackCwd });
  const diffBaseline =
    options?.diffBaseline ?? captureExecutionDiffBaseline(execFileSyncFn, workspaceCwd ?? process.cwd());

  // Create execution session
  const session = await sessionManager.createSession(
    "task_execution",
    task.goal_id,
    task.id
  );

  // Build context
  const contextSlots = sessionManager.buildTaskExecutionContext(
    task.goal_id,
    task.id
  );

  // Convert to AgentTask
  // If the adapter provides formatPrompt, delegate prompt construction to it.
  // Otherwise use the default builder.
  let prompt: string;
  if (adapter.formatPrompt) {
    prompt = adapter.formatPrompt(task, workspaceContext);
  } else {
    // Build prompt with task description as primary content
    const scopeConstraints =
      `\n\nSCOPE CONSTRAINTS (CRITICAL — violations will cause task failure):\n` +
      `- ONLY modify files directly related to the task\n` +
      `- Do NOT modify: config files (*.config.*, package.json, tsconfig.json), CI/CD files, build configuration, dependency files\n` +
      `- Do NOT change function visibility (private→export) or imports in unrelated files\n` +
      `- If a file contains the target pattern inside a string literal or template, leave it as-is`;
    const contextSection = workspaceContext
      ? `\n\nWORKSPACE CONTEXT (use these specific locations):\n${workspaceContext}`
      : "";
    const taskDescription = `You are an AI agent executing a task.\n\nTask: ${task.work_description}\n\nApproach: ${task.approach}\n\nSuccess Criteria:\n${task.success_criteria.map((c) => `- ${c.description}`).join("\n")}${scopeConstraints}${contextSection}`;

    const contextContent = contextSlots
      .filter((slot) => slot.content.trim().length > 0) // Skip empty slots
      .sort((a, b) => a.priority - b.priority)
      .map((slot) => `[${slot.label}]\n${slot.content}`)
      .join("\n\n");

    prompt = contextContent
      ? `${taskDescription}\n\n--- Context ---\n${contextContent}`
      : taskDescription;
  }

  const timeoutMs = task.estimated_duration
    ? durationToMs(task.estimated_duration)
    : 30 * 60 * 1000; // default 30 minutes

  // Resolve allowed_tools from the active strategy (if any).
  // If toolset_locked=true, the strategy must have allowed_tools defined — log a warning if not.
  if (activeStrategy?.toolset_locked && !activeStrategy.allowed_tools?.length) {
    logger?.warn(`[TaskExecutor] Strategy ${activeStrategy.id} has toolset_locked=true but no allowed_tools defined`, {
      taskId: task.id,
    });
  }
  const allowedTools = activeStrategy?.allowed_tools?.length ? activeStrategy.allowed_tools : undefined;

  const agentTask: AgentTask = {
    prompt,
    timeout_ms: timeoutMs,
    adapter_type: adapter.adapterType,
    ...(allowedTools !== undefined ? { allowed_tools: allowedTools } : {}),
    ...(workspaceCwd !== undefined ? { cwd: workspaceCwd } : {}),
  };

  // Update task status to running
  const runningTask = { ...task, status: "running" as const, started_at: new Date().toISOString() };
  await stateManager.saveTask(runningTask);
  await appendTaskOutcomeEvent(stateManager, {
    task: runningTask,
    type: "started",
    attempt: task.consecutive_failure_count + 1,
  });

  // Execute
  let result: AgentResult;
  try {
    // Generic dedup check — any adapter may optionally implement checkDuplicate
    if (adapter.checkDuplicate) {
      try {
        const isDuplicate = await adapter.checkDuplicate(agentTask);
        if (isDuplicate) {
          // Return synthetic result — task already exists, skip execution
          result = {
            success: true,
            output: 'Skipped: duplicate task detected by adapter',
            error: null,
            exit_code: 0,
            elapsed_ms: 0,
            stopped_reason: 'completed',
          };
          // End session and update task status without calling adapter.execute
          const skipSummary = 'Task skipped: duplicate detected by adapter';
          await sessionManager.endSession(session.id, skipSummary);
          const skipNow = new Date().toISOString();
          const skippedTask = { ...runningTask, status: 'completed' as const, completed_at: skipNow };
          await stateManager.saveTask(skippedTask);
          return result;
        }
      } catch { /* non-fatal: proceed with execution if dedup check fails */ }
    }
    if (!adapterExecutionHasCapabilityPlaneAdmission(agentTask, adapter)) {
      result = blockedDirectAdapterExecutionResult(adapter.adapterType);
    } else {
      result = await adapter.execute(agentTask);
    }
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

  await applyPostExecutionDiffScopeChecks({
    result,
    taskId: task.id,
    cwd: workspaceCwd ?? process.cwd(),
    execFileSyncFn,
    logger,
    fallbackChangedPaths: result.filesChangedPaths,
    baseline: diffBaseline,
  });

  // End session
  const summary = result.success
    ? `Task completed successfully. Output length: ${result.output.length}`
    : `Task failed: ${result.stopped_reason}. Error: ${result.error ?? "unknown"}`;
  await sessionManager.endSession(session.id, summary);

  // Update task status based on result
  const now = new Date().toISOString();
  let newStatus: "completed" | "timed_out" | "error";
  if (result.stopped_reason === "timeout") {
    newStatus = "timed_out";
  } else if (result.stopped_reason === "error" || !result.success) {
    newStatus = "error";
  } else {
    newStatus = "completed";
  }

  const updatedTask = {
    ...runningTask,
    status: newStatus,
    completed_at: now,
    ...(newStatus === "timed_out" ? { timeout_at: now } : {}),
    execution_output: result.output ? result.output.slice(0, 2000) : undefined,
  };
  await stateManager.saveTask(updatedTask);

  return result;
}

export async function applyPostExecutionDiffScopeChecks(input: {
  result: AgentResult;
  taskId: string;
  cwd: string;
  execFileSyncFn: TaskExecutorDeps["execFileSyncFn"];
  logger?: Logger;
  fallbackChangedPaths?: string[];
  baseline?: ExecutionDiffBaseline;
}): Promise<void> {
  try {
    const initiallySuccessful = input.result.success;
    const diffArtifacts = captureExecutionDiffArtifacts(input.execFileSyncFn, input.cwd, {
      fallbackChangedPaths: input.fallbackChangedPaths,
      baseline: input.baseline,
    });
    input.result.diffEvidenceSource = diffArtifacts.evidenceSource;
    if (diffArtifacts.available) {
      const changedFiles = diffArtifacts.changedPaths;
      input.result.filesChangedPaths = changedFiles;
      input.result.fileDiffs = diffArtifacts.fileDiffs;
      input.result.filesChanged = changedFiles.length > 0;
      if (initiallySuccessful && !input.result.filesChanged) {
        input.logger?.warn(
          "[TaskLifecycle] Adapter reported success but no files were modified",
          { taskId: input.taskId }
        );
        input.result.success = false;
        input.result.error = "No files were modified";
        input.result.stopped_reason = "completed";
      }
    }

    if (initiallySuccessful && diffArtifacts.available && diffArtifacts.changedPaths.length > 0) {
      const providerConfig = await loadProviderConfig({ saveMigration: false });
      const protectedPaths = providerConfig.agent_loop?.security?.protected_paths;
      const protectedChanges = diffArtifacts.changedPaths.filter((changedFile) =>
        !validateProtectedPath(changedFile, {
          cwd: input.cwd,
          workspaceRoot: input.cwd,
          protectedPaths,
        }).valid
      );

      if (protectedChanges.length > 0) {
        input.result.success = false;
        input.result.error = `Protected files were modified: ${protectedChanges.join(", ")}`;
        input.result.output = (input.result.output || "") +
          `\n[Scope Check] Protected files were modified: ${protectedChanges.join(", ")}`;
        input.result.stopped_reason = "error";
      }
    }
  } catch {
    // Non-fatal: scope check failure should not break execution.
  }
}

// ─── reloadTaskFromDisk ───

/**
 * Reload a task from disk (falls back to in-memory task if unavailable).
 */
export async function reloadTaskFromDisk(stateManager: StateManager, task: Task): Promise<Task> {
  try {
    const stored = await stateManager.loadTask(task.goal_id, task.id);
    if (stored) return TaskSchema.parse(stored);
  } catch { /* fall back to in-memory task */ }
  return task;
}
