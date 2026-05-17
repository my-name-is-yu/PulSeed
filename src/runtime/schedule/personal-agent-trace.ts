import {
  CompanionCognitionKernel,
  type CompanionCognitionInput,
  type CompanionCognitionOutput,
  type CognitionEventRef,
} from "../cognition/index.js";
import { descriptorFromScheduleEntry } from "../capability-plane.js";
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
  updated_at?: string | null;
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

interface ScheduleKernelDecisionInput {
  entry: ScheduleTraceEntry;
  firedAt: string;
  scheduledFor?: string | null;
  sourceType: "goal_run" | "job" | "wait_resume";
  actionKind: string;
  decision: InterventionDecisionKind;
  currentRefs?: RuntimeGraphRef[];
  staleRefs?: RuntimeGraphRef[];
  auditRefs?: RuntimeGraphRef[];
  goalId?: string;
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
  const cognition = await evaluateScheduleKernelDecision({
    entry: input.entry,
    firedAt: input.firedAt,
    scheduledFor,
    sourceType: "goal_run",
    actionKind: input.mode,
    decision: input.decision,
    goalId: input.goalId,
    currentRefs: [
      scheduleRef,
      goalRef,
      { kind: "schedule_wake", ref: `${input.entry.id}:${scheduledFor}` },
    ],
  });
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
      ...scheduleCapabilityDescriptorRefs(input.entry, input.mode),
      { kind: "capability", ref: "durable_loop_goal_run" },
      { kind: "capability", ref: `schedule:${input.entry.layer}` },
    ],
    policyRef: cognitionPolicyRef(cognition, "policy:schedule-goal-run-v1"),
    permissionRequired: false,
    cognitionSituation: cognition.situation_model,
    currentRefs: [
      scheduleRef,
      goalRef,
      { kind: "schedule_wake", ref: `${input.entry.id}:${scheduledFor}` },
      { kind: "cognition_response_plan", ref: cognition.response_plan.plan_id },
      ...(input.entry.metadata?.strategy_id ? [{ kind: "strategy", ref: input.entry.metadata.strategy_id }] : []),
      ...(input.entry.metadata?.wait_strategy_id ? [{ kind: "strategy", ref: input.entry.metadata.wait_strategy_id }] : []),
      ...(input.reason ? [{ kind: "schedule_run_reason", ref: input.reason }] : []),
    ],
    auditRefs: [
      scheduleRef,
      goalRef,
      { kind: "schedule_wake", ref: `${input.entry.id}:${scheduledFor}` },
      { kind: "cognition_audit", ref: `${cognition.cognition_id}:audit` },
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
  const cognition = await evaluateScheduleKernelDecision({
    entry: input.entry,
    firedAt: input.firedAt,
    scheduledFor,
    sourceType: "job",
    actionKind: input.actionKind,
    decision: input.decision,
    currentRefs: [
      scheduleRef,
      { kind: "schedule_wake", ref: `${input.entry.id}:${scheduledFor}` },
      ...(input.currentRefs ?? []),
    ],
  });
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
      ...scheduleCapabilityDescriptorRefs(input.entry, `${input.jobKind}:${input.actionKind}`),
      { kind: "capability", ref: `schedule:${input.entry.layer}` },
      { kind: "capability", ref: `schedule_job:${input.jobKind}:${input.actionKind}` },
      ...(input.capabilityRefs ?? []),
    ],
    policyRef: cognitionPolicyRef(cognition, "policy:schedule-job-action-v1"),
    permissionRequired: false,
    cognitionSituation: cognition.situation_model,
    currentRefs: [
      scheduleRef,
      { kind: "schedule_wake", ref: `${input.entry.id}:${scheduledFor}` },
      { kind: "cognition_response_plan", ref: cognition.response_plan.plan_id },
      ...(input.currentRefs ?? []),
    ],
    auditRefs: [
      scheduleRef,
      { kind: "schedule_wake", ref: `${input.entry.id}:${scheduledFor}` },
      { kind: "cognition_audit", ref: `${cognition.cognition_id}:audit` },
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
  const cognition = await evaluateScheduleKernelDecision({
    entry: input.entry,
    firedAt: input.firedAt,
    scheduledFor,
    sourceType: "wait_resume",
    actionKind: "wait_resume",
    decision: input.decision,
    goalId: input.goalId,
    currentRefs: [
      scheduleRef,
      goalRef,
      signalRef,
      { kind: "schedule_wake", ref: `${input.entry.id}:${scheduledFor}` },
      ...(input.currentRefs ?? []),
    ],
    staleRefs: input.staleRefs,
    auditRefs: input.auditRefs,
  });
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
      ...scheduleCapabilityDescriptorRefs(input.entry, "wait_resume"),
      { kind: "capability", ref: "schedule_wait_resume_attention" },
      { kind: "capability", ref: `schedule:${input.entry.layer}` },
    ],
    policyRef: cognitionPolicyRef(cognition, "policy:schedule-wait-resume-v1"),
    permissionRequired: false,
    cognitionSituation: cognition.situation_model,
    currentRefs: [
      scheduleRef,
      goalRef,
      signalRef,
      { kind: "schedule_wake", ref: `${input.entry.id}:${scheduledFor}` },
      { kind: "cognition_response_plan", ref: cognition.response_plan.plan_id },
      ...(input.entry.metadata?.strategy_id ? [{ kind: "strategy", ref: input.entry.metadata.strategy_id }] : []),
      ...(input.entry.metadata?.wait_strategy_id ? [{ kind: "strategy", ref: input.entry.metadata.wait_strategy_id }] : []),
      ...(input.currentRefs ?? []),
    ],
    staleRefs: input.staleRefs,
    auditRefs: [
      scheduleRef,
      goalRef,
      signalRef,
      { kind: "cognition_audit", ref: `${cognition.cognition_id}:audit` },
      ...(input.auditRefs ?? []),
    ],
  }));
}

async function evaluateScheduleKernelDecision(input: ScheduleKernelDecisionInput): Promise<CompanionCognitionOutput> {
  const scheduledFor = input.scheduledFor ?? input.firedAt;
  const eventRef: CognitionEventRef = {
    ref: `${input.entry.id}:${input.sourceType}:${input.actionKind}:${scheduledFor}`,
    source_store: "schedule",
    source_event_type: "schedule_wake",
    schema_version: 1,
    source_epoch: scheduledFor,
    replay_key: [
      "schedule_kernel",
      input.sourceType,
      input.entry.id,
      input.actionKind,
      scheduledFor,
    ].join(":"),
    redaction_policy: "metadata_only",
  };
  const cognitionId = `cognition:schedule:${stableId(eventRef.replay_key!)}`;
  const cognitionInput: CompanionCognitionInput = {
    cognition_id: cognitionId,
    caller_path: "schedule_wake",
    event_refs: [eventRef],
    working_context: {
      input_ref: eventRef,
      route_ref: { kind: "schedule_action", ref: input.actionKind },
      runtime_graph_refs: input.currentRefs ?? [],
      uncertainty_refs: input.staleRefs ?? [],
      turn_started_at: input.firedAt,
      hidden_prompt_content_materialized: false,
    },
    runtime_context: {
      runtime_item_refs: [
        { kind: "schedule_entry", ref: input.entry.id },
        ...(input.goalId ? [{ kind: "goal", ref: input.goalId }] : []),
      ],
      phase_ref: { kind: "schedule_wake", ref: `${input.entry.id}:${scheduledFor}` },
    },
    goal_context: input.goalId
      ? {
          active_goals: [{
            goal_id: input.goalId,
            goal_ref: { kind: "goal", ref: input.goalId },
            lifecycle: input.decision === "block" ? "blocked" : "active",
            priority: "unknown",
          }],
          active_intention_refs: [],
          stale_target_refs: input.staleRefs ?? [],
        }
      : undefined,
    memory_context_request: {
      request_id: `${cognitionId}:memory-request`,
      requested_uses: ["attention_prioritization", "runtime_grounding"],
      caller_path: "schedule_wake",
      query_ref: eventRef,
      surface_projection_required: true,
      side_effect_authorization_allowed: false,
      include_sensitive_content: false,
    },
    surface_target: "internal_audit",
  };
  return new CompanionCognitionKernel().evaluateScheduleWake(cognitionInput);
}

function cognitionPolicyRef(
  cognition: CompanionCognitionOutput,
  fallback: string,
): RuntimeGraphRef {
  return cognition.response_plan?.plan_id
    ? { kind: "response_plan", ref: cognition.response_plan.plan_id }
    : { kind: "intervention_policy", ref: fallback };
}

function scheduleCapabilityDescriptorRefs(entry: ScheduleTraceEntry, actionKind: string): RuntimeGraphRef[] {
  const descriptor = descriptorFromScheduleEntry(entry, actionKind);
  return [
    { kind: "capability", ref: descriptor.capability_id },
    { kind: "capability_provider", ref: descriptor.provider_ref },
    { kind: "capability_operation", ref: descriptor.runtime_graph_refs.operation_ref },
    { kind: "capability_readiness", ref: descriptor.readiness_state },
  ];
}
