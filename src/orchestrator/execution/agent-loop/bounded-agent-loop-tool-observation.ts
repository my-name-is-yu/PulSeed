import type {
  AgentLoopToolCall,
  AgentLoopToolObservation,
  AgentLoopToolObservationExecution,
  AgentLoopToolObservationState,
} from "./agent-loop-model.js";
import type { AgentLoopToolOutput } from "./agent-loop-tool-output.js";

export function readToolResultCheckOnly(result: AgentLoopToolOutput): boolean | undefined {
  const data = result.rawResult?.data;
  if (
    result.toolName === "apply_patch" &&
    data &&
    typeof data === "object" &&
    "checkOnly" in data &&
    typeof (data as { checkOnly?: unknown }).checkOnly === "boolean"
  ) {
    return (data as { checkOnly: boolean }).checkOnly;
  }
  return undefined;
}

export function createAgentLoopToolObservation(input: {
  result: AgentLoopToolOutput;
  sourceCall?: AgentLoopToolCall | undefined;
  toolBatchTimedOut: boolean;
}): AgentLoopToolObservation {
  const { result, sourceCall, toolBatchTimedOut } = input;
  const state = agentLoopToolObservationState(result, toolBatchTimedOut);
  const execution = agentLoopToolObservationExecution(result, state);
  const rawResult = result.rawResult;
  return {
    type: "tool_observation",
    callId: result.callId,
    toolName: result.toolName,
    arguments: sourceCall?.input ?? {},
    state,
    success: result.success,
    execution,
    durationMs: result.durationMs,
    output: {
      content: result.content,
      ...(rawResult?.summary ? { summary: rawResult.summary } : {}),
      ...(rawResult && Object.prototype.hasOwnProperty.call(rawResult, "data") ? { data: rawResult.data } : {}),
      ...(rawResult?.error ? { error: rawResult.error } : {}),
    },
    ...(result.command ? { command: result.command } : {}),
    ...(result.cwd ? { cwd: result.cwd } : {}),
    ...(result.artifacts ? { artifacts: result.artifacts } : {}),
    ...(result.truncated ? { truncated: result.truncated } : {}),
    ...(result.activityCategory ? { activityCategory: result.activityCategory } : {}),
  };
}

export function agentLoopToolObservationState(
  result: AgentLoopToolOutput,
  toolBatchTimedOut: boolean,
): AgentLoopToolObservationState {
  const reason = result.execution?.reason;
  if (reason === "timed_out" || (toolBatchTimedOut && result.disposition === "cancelled")) return "timed_out";
  if (reason === "interrupted" || result.disposition === "cancelled") return "interrupted";
  if (reason === "approval_denied" || reason === "permission_denied") return "denied";
  if (reason === "policy_blocked" || reason === "dry_run") return "blocked";
  return result.success ? "success" : "failure";
}

export function agentLoopToolObservationExecution(
  result: AgentLoopToolOutput,
  state: AgentLoopToolObservationState,
): AgentLoopToolObservationExecution {
  if (result.execution) return result.execution;
  if (state === "timed_out" || state === "interrupted") {
    return {
      status: "executed",
      reason: state === "timed_out" ? "timed_out" : "interrupted",
      message: result.content,
    };
  }
  return { status: "executed" };
}
