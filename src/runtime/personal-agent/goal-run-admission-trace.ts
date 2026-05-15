import {
  type PersonalAgentCallerPath,
  type PersonalAgentSourceKind,
  type RuntimeGraphRef,
} from "./contracts.js";
import { PersonalAgentRuntimeStore } from "./store.js";
import { buildPersonalAgentDecisionTrace, stableId } from "./trace-builder.js";

export type GoalRunAdmissionSource =
  | "daemon_goal_cycle"
  | "supervisor_maintenance"
  | "supervisor_worker";

export type GoalRunAdmissionTriggerKind =
  | "schedule_due"
  | "wait_resume"
  | "external_signal"
  | "resident_cycle"
  | "manual_or_queued_activation";

type GoalRunAdmissionTraceSink = Pick<PersonalAgentRuntimeStore, "recordTrace">;

export interface RecordGoalRunAdmissionDecisionInput {
  personalAgentRuntime?: GoalRunAdmissionTraceSink;
  baseDir?: string;
  source: GoalRunAdmissionSource;
  triggerKind: GoalRunAdmissionTriggerKind;
  goalId: string;
  sourceId: string;
  emittedAt?: string;
  sourceEpoch: string;
  highWatermark?: string;
  runPolicy: "bounded" | "resident";
  maxIterations?: number | null;
  decisionReason: string;
  targetRunRef?: RuntimeGraphRef;
  currentRefs?: RuntimeGraphRef[];
  auditRefs?: RuntimeGraphRef[];
}

export async function recordGoalRunAdmissionDecision(
  input: RecordGoalRunAdmissionDecisionInput,
): Promise<void> {
  const store = input.personalAgentRuntime
    ?? (input.baseDir ? new PersonalAgentRuntimeStore(input.baseDir, { controlBaseDir: input.baseDir }) : null);
  if (!store) {
    return;
  }

  const sourceMapping = sourceMappingFor(input.triggerKind);
  const replayKey = [
    "goal_run_admission",
    input.source,
    input.triggerKind,
    input.sourceId,
    input.sourceEpoch,
    input.goalId,
    input.runPolicy,
    input.maxIterations ?? "none",
  ].join(":");
  const runRef = input.targetRunRef ?? {
    kind: "run",
    ref: `run:goal-admission:${stableId(replayKey)}`,
  };
  const sourceRef: RuntimeGraphRef = {
    kind: input.source,
    ref: input.sourceId,
  };
  const goalRef: RuntimeGraphRef = {
    kind: "goal",
    ref: input.goalId,
  };
  const triggerRef: RuntimeGraphRef = {
    kind: "goal_run_admission_trigger",
    ref: input.triggerKind,
  };
  const runPolicyRef: RuntimeGraphRef = {
    kind: "run_policy",
    ref: `${input.runPolicy}:${input.maxIterations ?? "none"}`,
  };
  const currentRefs = [
    goalRef,
    sourceRef,
    triggerRef,
    runPolicyRef,
    ...(input.currentRefs ?? []),
  ];
  const auditRefs = [
    goalRef,
    sourceRef,
    triggerRef,
    ...(input.auditRefs ?? []),
  ];

  await store.recordTrace(buildPersonalAgentDecisionTrace({
    callerPath: sourceMapping.callerPath,
    source: {
      sourceKind: sourceMapping.sourceKind,
      sourceId: input.sourceId,
      emittedAt: input.emittedAt,
      sourceEpoch: input.sourceEpoch,
      highWatermark: input.highWatermark ?? input.sourceEpoch,
      replayKey,
      summary: summaryFor(input.source, input.triggerKind, input.goalId),
      sourceRef,
    },
    target: {
      kind: "run",
      ref: runRef,
      effect: "create_run",
      summary: `Run goal ${input.goalId} from ${input.source}.`,
    },
    decision: "allow",
    decisionReason: input.decisionReason,
    capabilityDecision: "available",
    capabilityRefs: [
      { kind: "capability", ref: "durable_loop_goal_run" },
    ],
    policyRef: { kind: "intervention_policy", ref: "policy:goal-run-admission-v1" },
    permissionRequired: false,
    currentRefs,
    auditRefs,
  }));
}

function sourceMappingFor(triggerKind: GoalRunAdmissionTriggerKind): {
  callerPath: PersonalAgentCallerPath;
  sourceKind: PersonalAgentSourceKind;
} {
  switch (triggerKind) {
    case "schedule_due":
    case "wait_resume":
      return {
        callerPath: "scheduled_wake",
        sourceKind: "schedule_wake",
      };
    case "external_signal":
      return {
        callerPath: "external_signal",
        sourceKind: "external_signal",
      };
    case "manual_or_queued_activation":
      return {
        callerPath: "task_execution",
        sourceKind: "task_execution",
      };
    case "resident_cycle":
    default:
      return {
        callerPath: "resident_proactive",
        sourceKind: "resident_observation",
      };
  }
}

function summaryFor(
  source: GoalRunAdmissionSource,
  triggerKind: GoalRunAdmissionTriggerKind,
  goalId: string,
): string {
  return `${source} observed ${triggerKind} and requested DurableLoop admission for goal ${goalId}.`;
}
