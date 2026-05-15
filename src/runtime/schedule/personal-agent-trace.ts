import {
  buildPersonalAgentDecisionTrace,
  stableId,
  type CapabilityRegistryDecisionKind,
  type InterventionDecisionKind,
  type InterventionTargetEffect,
  type PersonalAgentRuntimeStore,
  type RuntimeGraphRef,
} from "../personal-agent/index.js";
import type { ScheduleEntry } from "../types/schedule.js";
import type { ScheduleRunReason } from "./history.js";

type PersonalAgentRuntimeTraceSink = Pick<PersonalAgentRuntimeStore, "recordTrace">;

interface ScheduleTraceEntry {
  id: string;
  name: string;
  layer: ScheduleEntry["layer"] | "escalation";
  metadata?: ScheduleEntry["metadata"];
}

export interface ScheduleGoalRunTraceInput {
  personalAgentRuntime?: PersonalAgentRuntimeTraceSink;
  entry: ScheduleTraceEntry;
  goalId: string;
  firedAt: string;
  scheduledFor?: string | null;
  reason?: ScheduleRunReason | "escalation_goal";
  mode: "goal_trigger" | "escalation_goal";
  runPolicy: "bounded" | "resident";
  maxIterations?: number | null;
  decision: InterventionDecisionKind;
  capabilityDecision?: CapabilityRegistryDecisionKind;
  decisionReason: string;
}

export interface ScheduleJobDecisionTraceInput {
  personalAgentRuntime?: PersonalAgentRuntimeTraceSink;
  entry: ScheduleTraceEntry;
  firedAt: string;
  scheduledFor?: string | null;
  jobKind: "cron" | "probe" | "goal_trigger";
  actionKind: string;
  decision: InterventionDecisionKind;
  capabilityDecision?: CapabilityRegistryDecisionKind;
  targetEffect?: InterventionTargetEffect;
  decisionReason: string;
  capabilityRefs?: RuntimeGraphRef[];
  currentRefs?: RuntimeGraphRef[];
}

export interface ScheduleWaitResumeDecisionTraceInput {
  personalAgentRuntime?: PersonalAgentRuntimeTraceSink;
  entry: ScheduleTraceEntry;
  goalId: string;
  firedAt: string;
  scheduledFor?: string | null;
  signalContextId: string;
  decision: InterventionDecisionKind;
  capabilityDecision?: CapabilityRegistryDecisionKind;
  decisionReason: string;
  currentRefs?: RuntimeGraphRef[];
  staleRefs?: RuntimeGraphRef[];
  auditRefs?: RuntimeGraphRef[];
}

export async function recordScheduleGoalRunDecision(input: ScheduleGoalRunTraceInput): Promise<void> {
  if (!input.personalAgentRuntime) return;
  const scheduledFor = input.scheduledFor ?? input.firedAt;
  const replayKey = [
    "schedule_goal_run",
    input.mode,
    input.entry.id,
    scheduledFor,
    input.goalId,
    input.runPolicy,
    input.maxIterations ?? "none",
  ].join(":");
  const runRef: RuntimeGraphRef = {
    kind: "run",
    ref: `run:schedule:${stableId(replayKey)}`,
  };
  const scheduleRef: RuntimeGraphRef = {
    kind: "schedule_entry",
    ref: input.entry.id,
  };
  const goalRef: RuntimeGraphRef = {
    kind: "goal",
    ref: input.goalId,
  };
  await input.personalAgentRuntime.recordTrace(buildPersonalAgentDecisionTrace({
    callerPath: "scheduled_wake",
    source: {
      sourceKind: "schedule_wake",
      sourceId: `${input.entry.id}:${input.goalId}`,
      emittedAt: input.firedAt,
      sourceEpoch: scheduledFor,
      highWatermark: scheduledFor,
      replayKey,
      summary: input.mode === "escalation_goal"
        ? `Schedule escalation "${input.entry.name}" requested goal run ${input.goalId}.`
        : `Schedule goal trigger "${input.entry.name}" requested goal run ${input.goalId}.`,
      sourceRef: scheduleRef,
    },
    target: {
      kind: "run",
      ref: runRef,
      effect: "create_run",
      summary: `Run goal ${input.goalId} from ${input.mode}.`,
    },
    decision: input.decision,
    decisionReason: input.decisionReason,
    capabilityDecision: input.capabilityDecision ?? (input.decision === "block" ? "missing" : "available"),
    capabilityRefs: [
      { kind: "capability", ref: "durable_loop_goal_run" },
      { kind: "capability", ref: `schedule:${input.entry.layer}` },
    ],
    policyRef: { kind: "intervention_policy", ref: "policy:schedule-goal-run-v1" },
    permissionRequired: false,
    currentRefs: [
      scheduleRef,
      goalRef,
      { kind: "schedule_wake", ref: `${input.entry.id}:${scheduledFor}` },
      ...(input.entry.metadata?.strategy_id ? [{ kind: "strategy", ref: input.entry.metadata.strategy_id }] : []),
      ...(input.entry.metadata?.wait_strategy_id ? [{ kind: "strategy", ref: input.entry.metadata.wait_strategy_id }] : []),
      ...(input.reason ? [{ kind: "schedule_run_reason", ref: input.reason }] : []),
    ],
    auditRefs: [
      scheduleRef,
      goalRef,
      { kind: "schedule_wake", ref: `${input.entry.id}:${scheduledFor}` },
    ],
  }));
}

export async function recordScheduleJobDecision(input: ScheduleJobDecisionTraceInput): Promise<void> {
  if (!input.personalAgentRuntime) return;
  const scheduledFor = input.scheduledFor ?? input.firedAt;
  const replayKey = [
    "schedule_job",
    input.jobKind,
    input.actionKind,
    input.entry.id,
    scheduledFor,
  ].join(":");
  const scheduleRef: RuntimeGraphRef = {
    kind: "schedule_entry",
    ref: input.entry.id,
  };
  const actionRef: RuntimeGraphRef = {
    kind: "schedule_job_action",
    ref: `schedule-job:${stableId(replayKey)}`,
  };
  await input.personalAgentRuntime.recordTrace(buildPersonalAgentDecisionTrace({
    callerPath: "scheduled_wake",
    source: {
      sourceKind: "schedule_wake",
      sourceId: `${input.entry.id}:${input.actionKind}`,
      emittedAt: input.firedAt,
      sourceEpoch: scheduledFor,
      highWatermark: scheduledFor,
      replayKey,
      summary: `Schedule ${input.jobKind} "${input.entry.name}" requested ${input.actionKind}.`,
      sourceRef: scheduleRef,
    },
    target: {
      kind: "tool_call",
      ref: actionRef,
      effect: input.targetEffect ?? (input.decision === "allow" ? "execute_tool" : "none"),
      summary: `Execute schedule ${input.jobKind} action ${input.actionKind}.`,
    },
    decision: input.decision,
    decisionReason: input.decisionReason,
    capabilityDecision: input.capabilityDecision ?? (input.decision === "block" ? "missing" : "available"),
    capabilityRefs: [
      { kind: "capability", ref: `schedule:${input.entry.layer}` },
      { kind: "capability", ref: `schedule_job:${input.jobKind}:${input.actionKind}` },
      ...(input.capabilityRefs ?? []),
    ],
    policyRef: { kind: "intervention_policy", ref: "policy:schedule-job-action-v1" },
    permissionRequired: false,
    currentRefs: [
      scheduleRef,
      { kind: "schedule_wake", ref: `${input.entry.id}:${scheduledFor}` },
      ...(input.currentRefs ?? []),
    ],
    auditRefs: [
      scheduleRef,
      { kind: "schedule_wake", ref: `${input.entry.id}:${scheduledFor}` },
    ],
  }));
}

export async function recordScheduleWaitResumeDecision(input: ScheduleWaitResumeDecisionTraceInput): Promise<void> {
  if (!input.personalAgentRuntime) return;
  const scheduledFor = input.scheduledFor ?? input.firedAt;
  const replayKey = [
    "wait_resume",
    input.entry.id,
    scheduledFor,
  ].join(":");
  const scheduleRef: RuntimeGraphRef = {
    kind: "schedule_entry",
    ref: input.entry.id,
  };
  const goalRef: RuntimeGraphRef = {
    kind: "goal",
    ref: input.goalId,
  };
  const signalRef: RuntimeGraphRef = {
    kind: "signal_context",
    ref: input.signalContextId,
  };
  await input.personalAgentRuntime.recordTrace(buildPersonalAgentDecisionTrace({
    callerPath: "scheduled_wake",
    source: {
      sourceKind: "schedule_wake",
      sourceId: input.entry.id,
      emittedAt: input.firedAt,
      sourceEpoch: scheduledFor,
      highWatermark: scheduledFor,
      replayKey,
      summary: `Scheduled wait-resume wake "${input.entry.name}" requested attention re-evaluation.`,
      sourceRef: scheduleRef,
    },
    target: {
      kind: "attention_only",
      ref: signalRef,
      effect: input.decision === "block" ? "none" : "hold_concern",
      summary: `Re-evaluate wait-resume attention for goal ${input.goalId}.`,
    },
    decision: input.decision,
    decisionReason: input.decisionReason,
    capabilityDecision: input.capabilityDecision ?? (input.decision === "block" ? "blocked" : "available"),
    capabilityRefs: [
      { kind: "capability", ref: "schedule_wait_resume_attention" },
      { kind: "capability", ref: `schedule:${input.entry.layer}` },
    ],
    policyRef: { kind: "intervention_policy", ref: "policy:schedule-wait-resume-v1" },
    permissionRequired: false,
    currentRefs: [
      scheduleRef,
      goalRef,
      signalRef,
      { kind: "schedule_wake", ref: `${input.entry.id}:${scheduledFor}` },
      ...(input.entry.metadata?.strategy_id ? [{ kind: "strategy", ref: input.entry.metadata.strategy_id }] : []),
      ...(input.entry.metadata?.wait_strategy_id ? [{ kind: "strategy", ref: input.entry.metadata.wait_strategy_id }] : []),
      ...(input.currentRefs ?? []),
    ],
    staleRefs: input.staleRefs,
    auditRefs: [
      scheduleRef,
      goalRef,
      signalRef,
      ...(input.auditRefs ?? []),
    ],
  }));
}
