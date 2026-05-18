import type { Task } from "../../../base/types/task.js";
import type { Goal } from "../../../base/types/goal.js";
import type { Logger } from "../../../runtime/logger.js";
import type { AgentLoopResult } from "../agent-loop/agent-loop-result.js";

export interface TaskCompletionArtifactFinalizerInput {
  task: Task;
  goal?: Pick<Goal, "constraints"> | null;
  agentLoopResult: AgentLoopResult<unknown>;
  logger?: Logger;
  abortSignal?: AbortSignal;
}

export interface TaskCompletionArtifactFinalizerResult {
  handled: boolean;
  success: boolean;
  summary: string;
  artifacts?: string[];
  error?: string;
}

export type TaskCompletionArtifactFinalizer = (
  input: TaskCompletionArtifactFinalizerInput
) => Promise<TaskCompletionArtifactFinalizerResult>;

export async function runTaskCompletionArtifactFinalizers(input: {
  finalizers: readonly TaskCompletionArtifactFinalizer[];
  task: Task;
  goal?: Pick<Goal, "constraints"> | null;
  agentLoopResult: AgentLoopResult<unknown>;
  logger?: Logger;
  abortSignal?: AbortSignal;
}): Promise<TaskCompletionArtifactFinalizerResult[]> {
  const results: TaskCompletionArtifactFinalizerResult[] = [];
  for (const finalizer of input.finalizers) {
    const startedAt = Date.now();
    try {
      const result = await finalizer({
        task: input.task,
        goal: input.goal,
        agentLoopResult: input.agentLoopResult,
        logger: input.logger,
        abortSignal: input.abortSignal,
      });
      if (!result.handled) continue;
      results.push(result);
      input.agentLoopResult.toolResults ??= [];
      input.agentLoopResult.toolResults.push({
        toolName: "completion_artifact_finalizer",
        success: result.success,
        artifacts: result.artifacts ?? [],
        outputSummary: result.summary,
        durationMs: Date.now() - startedAt,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const result: TaskCompletionArtifactFinalizerResult = {
        handled: true,
        success: false,
        summary: `Completion artifact finalizer failed: ${message}`,
        error: message,
      };
      results.push(result);
      input.agentLoopResult.toolResults ??= [];
      input.agentLoopResult.toolResults.push({
        toolName: "completion_artifact_finalizer",
        success: false,
        outputSummary: result.summary,
        durationMs: Date.now() - startedAt,
      });
    }
  }
  return results;
}
