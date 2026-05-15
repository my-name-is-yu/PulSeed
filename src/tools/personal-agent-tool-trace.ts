import type { ToolCallContext, ToolResult } from "./types.js";
import {
  PersonalAgentRuntimeStore,
  buildPersonalAgentDecisionTrace,
  stableId,
  type CapabilityRegistryDecisionKind,
  type InterventionDecisionKind,
  type InterventionTargetEffect,
  type RuntimeGraphRef,
  type TaskCandidateTargetKind,
} from "../runtime/personal-agent/index.js";

export interface PersonalAgentToolTraceDeps {
  personalAgentRuntime?: Pick<PersonalAgentRuntimeStore, "recordTrace">;
  baseDir?: string | null;
}

export interface PersonalAgentToolDecisionOptions {
  decision: InterventionDecisionKind;
  decisionReason: string;
  capabilityDecision?: CapabilityRegistryDecisionKind;
  targetKind?: TaskCandidateTargetKind;
  targetRef?: RuntimeGraphRef;
  targetEffect?: InterventionTargetEffect;
  targetSummary: string;
  capabilityRefs?: RuntimeGraphRef[];
  currentRefs?: RuntimeGraphRef[];
  auditRefs?: RuntimeGraphRef[];
  outcomeSummary?: string;
}

export interface PersonalAgentToolGuardOptions extends Omit<PersonalAgentToolDecisionOptions, "decision" | "decisionReason" | "capabilityDecision" | "outcomeSummary"> {
  denialSummary?: string;
  denialMessage?: string;
}

export function getPersonalAgentToolTraceBaseDir(source: unknown): string | null {
  const candidate = source as { getBaseDir?: unknown };
  if (typeof candidate.getBaseDir !== "function") return null;
  const value = candidate.getBaseDir.call(source);
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function rejectUnapprovedPersonalAgentToolCall(
  deps: PersonalAgentToolTraceDeps,
  toolName: string,
  input: unknown,
  context: ToolCallContext,
  startTime: number,
  options: PersonalAgentToolGuardOptions,
): Promise<ToolResult | null> {
  if (context.preApproved) return null;
  await recordPersonalAgentToolDecision(deps, toolName, input, context, {
    ...options,
    decision: "confirm_required",
    capabilityDecision: "permission_required",
    decisionReason: `${toolName} requires InterventionPolicy confirmation before execution.`,
  });
  const denied: ToolResult = {
    success: false,
    data: null,
    summary: options.denialSummary ?? `${toolName} requires approval before execution.`,
    execution: {
      status: "not_executed",
      reason: "permission_denied",
      message: options.denialMessage ?? `${toolName} requires approval before execution.`,
    },
    durationMs: Date.now() - startTime,
  };
  await recordPersonalAgentToolDecision(deps, toolName, input, context, {
    ...options,
    decision: "block",
    capabilityDecision: "blocked",
    decisionReason: `${toolName} was blocked because InterventionPolicy confirmation was not present.`,
    outcomeSummary: `${toolName} action outcome: not_executed reason=${denied.execution?.reason}. ${denied.summary}`,
  });
  return denied;
}

export async function recordAllowedPersonalAgentToolCall(
  deps: PersonalAgentToolTraceDeps,
  toolName: string,
  input: unknown,
  context: ToolCallContext,
  options: Omit<PersonalAgentToolDecisionOptions, "decision" | "decisionReason" | "capabilityDecision"> & {
    decisionReason?: string;
  },
): Promise<void> {
  await recordPersonalAgentToolDecision(deps, toolName, input, context, {
    ...options,
    decision: "allow",
    capabilityDecision: "available",
    decisionReason: options.decisionReason
      ?? `${toolName} was allowed by InterventionPolicy after Capability Registry evaluation.`,
  });
}

export async function recordPersonalAgentToolDecision(
  deps: PersonalAgentToolTraceDeps,
  toolName: string,
  input: unknown,
  context: ToolCallContext,
  options: PersonalAgentToolDecisionOptions,
): Promise<void> {
  const store = resolvePersonalAgentRuntimeStore(deps);
  if (!store) return;

  const emittedAt = new Date().toISOString();
  const inputKey = stableJson(input);
  const traceContext = context.personalAgentTrace;
  const sourceId = traceContext?.sourceId ?? context.callId ?? context.turnId ?? `${toolName}:${stableId(inputKey)}`;
  const targetRef = options.targetRef ?? {
    kind: "tool_call",
    ref: `${toolName}:${stableId([
      toolName,
      inputKey,
      context.conversationSessionId ?? context.sessionId ?? "session:none",
      context.turnId ?? context.callId ?? context.cwd,
    ].join(":"))}`,
  };
  const toolReplayKey = [
    "tool",
    toolName,
    inputKey,
    context.conversationSessionId ?? context.sessionId ?? "session:none",
    context.turnId ?? context.callId ?? context.cwd,
    targetRef.kind,
    targetRef.ref,
  ].join(":");
  const replayKey = [
    traceContext?.replayKey ?? toolReplayKey,
    "decision",
    options.decision,
    options.capabilityDecision ?? "capability:derived",
  ].join(":");
  const currentRefs = [
    ...contextRuntimeRefs(context, toolName),
    ...(traceContext?.currentRefs ?? []),
    ...(options.currentRefs ?? []),
  ];
  const auditRefs = [
    { kind: "tool_call", ref: context.callId ?? toolName },
    ...(context.turnId ? [{ kind: "turn", ref: context.turnId }] : []),
    ...(traceContext?.auditRefs ?? []),
    ...(options.auditRefs ?? []),
  ];

  await store.recordTrace(buildPersonalAgentDecisionTrace({
    callerPath: traceContext?.callerPath ?? "explicit_user_command",
    source: {
      sourceKind: traceContext?.sourceKind ?? "explicit_command",
      sourceId,
      emittedAt,
      sourceEpoch: traceContext?.sourceEpoch ?? context.turnId ?? context.callId ?? "tool-call",
      highWatermark: traceContext?.highWatermark ?? context.sessionId ?? context.conversationSessionId ?? context.goalId ?? "session:none",
      replayKey,
      summary: traceContext?.summary ?? `${toolName} requested production tool execution.`,
      sourceRef: traceContext?.sourceRef ?? { kind: "tool_call", ref: context.callId ?? toolName },
    },
    target: {
      kind: options.targetKind ?? "tool_call",
      ref: targetRef,
      effect: options.targetEffect ?? "execute_tool",
      summary: options.targetSummary,
    },
    decision: options.decision,
    decisionReason: options.decisionReason,
    capabilityDecision: options.capabilityDecision,
    capabilityRefs: options.capabilityRefs ?? [{ kind: "capability", ref: `tool:${toolName}` }],
    policyRef: { kind: "intervention_policy", ref: "policy:tool-execution-v1" },
    permissionRequired: options.decision !== "allow",
    currentRefs,
    auditRefs,
    ...(options.outcomeSummary
      ? {
          outcomeEvent: {
            type: "action_outcome" as const,
            summary: options.outcomeSummary,
            targetRef,
          },
        }
      : {}),
  }));
}

function resolvePersonalAgentRuntimeStore(
  deps: PersonalAgentToolTraceDeps,
): Pick<PersonalAgentRuntimeStore, "recordTrace"> | null {
  if (deps.personalAgentRuntime) return deps.personalAgentRuntime;
  if (!deps.baseDir) return null;
  return new PersonalAgentRuntimeStore(deps.baseDir, { controlBaseDir: deps.baseDir });
}

function contextRuntimeRefs(context: ToolCallContext, toolName: string): RuntimeGraphRef[] {
  return [
    { kind: "tool_call", ref: context.callId ?? toolName },
    ...(context.goalId ? [{ kind: "goal", ref: context.goalId }] : []),
    ...(context.taskId ? [{ kind: "task", ref: context.taskId }] : []),
    ...(context.runId ? [{ kind: "run", ref: context.runId }] : []),
    ...(context.sessionId ? [{ kind: "session", ref: context.sessionId }] : []),
  ];
}

function stableJson(value: unknown): string {
  return JSON.stringify(normalizeForStableJson(value));
}

function normalizeForStableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeForStableJson(item));
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, normalizeForStableJson(record[key])]),
    );
  }
  return value;
}
