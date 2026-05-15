import type { Task } from "../../../base/types/task.js";
import {
  buildPersonalAgentDecisionTrace,
  type CapabilityRegistryDecisionKind,
  type InterventionDecisionKind,
  type InterventionTargetEffect,
  type PersonalAgentRuntimeStore,
  type RuntimeGraphRef,
} from "../../../runtime/personal-agent/index.js";

export type TaskPreExecutionPolicyGate =
  | "ethics_reject"
  | "ethics_flag"
  | "capability_check"
  | "irreversible_approval"
  | "guardrail_before"
  | "guardrail_after";

export interface TaskPreExecutionPolicyDecisionInput {
  gate: TaskPreExecutionPolicyGate;
  replayStage: string;
  decision: InterventionDecisionKind;
  reason: string;
  capabilityDecision?: CapabilityRegistryDecisionKind;
  capabilityRefs?: RuntimeGraphRef[];
  permissionRequired?: boolean;
  targetEffect?: InterventionTargetEffect;
  policyRef?: RuntimeGraphRef;
  currentRefs?: RuntimeGraphRef[];
  auditRefs?: RuntimeGraphRef[];
  targetSummary?: string;
  outcomeSummary?: string;
}

export type TaskPreExecutionPolicyRecorder = (
  task: Task,
  decision: TaskPreExecutionPolicyDecisionInput,
) => Promise<void>;

type TaskPreExecutionTraceSink = Pick<PersonalAgentRuntimeStore, "recordTrace">;

export async function recordTaskPreExecutionPolicyDecision(
  personalAgentRuntime: TaskPreExecutionTraceSink | undefined,
  task: Task,
  input: TaskPreExecutionPolicyDecisionInput,
): Promise<void> {
  if (!personalAgentRuntime) {
    return;
  }

  const capabilityRefs = input.capabilityRefs ?? [];
  const permissionRequired = input.permissionRequired ?? input.decision === "confirm_required";
  const targetEffect = input.targetEffect ?? "execute_tool";
  const targetRef: RuntimeGraphRef = { kind: "task", ref: task.id };
  const replayKey = [
    "task_pre_execution_policy",
    input.gate,
    input.replayStage,
    input.decision,
    task.goal_id,
    task.id,
    task.consecutive_failure_count,
  ].join(":");

  await personalAgentRuntime.recordTrace(buildPersonalAgentDecisionTrace({
    callerPath: "task_execution",
    source: {
      sourceKind: "task_execution",
      sourceId: `${task.id}:${input.gate}`,
      emittedAt: new Date().toISOString(),
      sourceEpoch: `${task.status}:${input.gate}:${input.replayStage}`,
      highWatermark: `${task.consecutive_failure_count}:${input.decision}:${task.started_at ?? "not_started"}`,
      replayKey,
      summary: `Task ${task.id} reached pre-execution policy gate ${input.gate}.`,
      sourceRef: targetRef,
    },
    target: {
      kind: targetEffect === "hold_concern" ? "attention_only" : "tool_call",
      ref: targetRef,
      effect: targetEffect,
      summary: input.targetSummary ?? task.work_description,
    },
    decision: input.decision,
    decisionReason: input.reason,
    capabilityDecision: input.capabilityDecision,
    capabilityRefs,
    policyRef: input.policyRef ?? { kind: "intervention_policy", ref: "policy:task-pre-execution-v1" },
    permissionRequired,
    currentRefs: [
      { kind: "goal", ref: task.goal_id },
      targetRef,
      { kind: "task_dimension", ref: task.primary_dimension },
      { kind: "task_status", ref: task.status },
      { kind: "task_reversibility", ref: task.reversibility },
      { kind: "task_category", ref: task.task_category },
      ...capabilityRefs,
      ...(input.currentRefs ?? []),
    ],
    auditRefs: input.auditRefs,
    outcomeEvent: input.outcomeSummary
      ? {
          type: "action_outcome",
          summary: input.outcomeSummary,
          targetRef,
        }
      : undefined,
  }));
}
