import type { Task } from "../../../base/types/task.js";
import type { AgentResult } from "../adapter-layer.js";
import { recordArcAgi3UsageForCompletionArtifacts, verifyArcAgi3CompletionArtifacts } from "../../../tools/arc-agi3/index.js";

export interface TaskCompletionArtifactVerification {
  applicable: boolean;
  passed: boolean;
  description: string;
  artifacts: string[];
  metricValues: Map<string, number>;
}

export async function verifyTaskCompletionArtifacts(
  executionResult: AgentResult,
): Promise<TaskCompletionArtifactVerification> {
  const arcResult = await verifyArcAgi3CompletionArtifacts(executionResult.completionArtifacts);
  if (arcResult.applicable) return arcResult;
  return {
    applicable: false,
    passed: false,
    description: "No task completion artifacts were produced.",
    artifacts: [],
    metricValues: new Map(),
  };
}

export async function attachTaskUsageToCompletionArtifacts(input: {
  task: Task;
  executionResult: AgentResult;
  taskCycleTokens: number;
}): Promise<string[]> {
  return recordArcAgi3UsageForCompletionArtifacts({
    artifacts: input.executionResult.completionArtifacts,
    usage: {
      modelTurns: input.executionResult.agentLoop?.modelTurns ?? null,
      toolCalls: input.executionResult.agentLoop?.toolCalls ?? null,
      inputTokens: input.executionResult.agentLoop?.usage?.inputTokens ?? null,
      outputTokens: input.executionResult.agentLoop?.usage?.outputTokens ?? null,
      agentLoopTotalTokens: input.executionResult.agentLoop?.usage?.totalTokens ?? null,
      taskCycleTotalTokens: input.taskCycleTokens,
    },
  });
}
