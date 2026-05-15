import {
  buildPersonalAgentDecisionTrace,
  stableId,
} from "./trace-builder.js";
import type {
  CapabilityRegistryDecisionKind,
  InterventionDecisionKind,
  InterventionTargetEffect,
  RuntimeGraphRef,
  TaskCandidateTargetKind,
} from "./contracts.js";
import { PersonalAgentRuntimeStore } from "./store.js";

type ExplicitCommandTraceSink = Pick<PersonalAgentRuntimeStore, "recordTrace">;

export interface ExplicitCommandDecisionTarget {
  kind: TaskCandidateTargetKind;
  ref: RuntimeGraphRef;
  effect: InterventionTargetEffect;
  summary: string;
}

export interface RecordExplicitCommandDecisionInput {
  baseDir: string;
  personalAgentRuntime?: ExplicitCommandTraceSink;
  surface: "cli" | "tui" | "mcp" | "daemon";
  command: string;
  sourceId?: string;
  sourceEpoch?: string;
  highWatermark?: string;
  emittedAt?: string;
  replayKey?: string;
  summary?: string;
  target: ExplicitCommandDecisionTarget;
  decision?: InterventionDecisionKind;
  decisionReason?: string;
  capabilityDecision?: CapabilityRegistryDecisionKind;
  capabilityRefs?: RuntimeGraphRef[];
  currentRefs?: RuntimeGraphRef[];
  auditRefs?: RuntimeGraphRef[];
  outcomeSummary?: string;
}

export async function recordExplicitCommandDecision(
  input: RecordExplicitCommandDecisionInput,
): Promise<void> {
  const store = input.personalAgentRuntime ?? new PersonalAgentRuntimeStore(input.baseDir, { controlBaseDir: input.baseDir });
  const emittedAt = input.emittedAt ?? new Date().toISOString();
  const sourceId = input.sourceId ?? `${input.surface}:${input.command}:${stableId(stableJson({
    command: input.command,
    surface: input.surface,
    target: input.target.ref,
    currentRefs: input.currentRefs ?? [],
  }))}`;
  const replayKey = input.replayKey ?? [
    "explicit_command",
    input.surface,
    input.command,
    sourceId,
    input.sourceEpoch ?? "epoch:none",
    input.target.kind,
    input.target.ref.kind,
    input.target.ref.ref,
  ].join(":");
  const decision = input.decision ?? "allow";
  const capabilityDecision = input.capabilityDecision
    ?? (decision === "allow" ? "available" : decision === "confirm_required" ? "permission_required" : "blocked");
  const commandRef: RuntimeGraphRef = {
    kind: `${input.surface}_command`,
    ref: input.command,
  };

  await store.recordTrace(buildPersonalAgentDecisionTrace({
    callerPath: "explicit_user_command",
    source: {
      sourceKind: "explicit_command",
      sourceId,
      emittedAt,
      sourceEpoch: input.sourceEpoch ?? input.command,
      highWatermark: input.highWatermark ?? input.sourceEpoch ?? input.command,
      replayKey,
      summary: input.summary ?? `${input.surface} command "${input.command}" requested production runtime action.`,
      sourceRef: commandRef,
    },
    target: input.target,
    decision,
    decisionReason: input.decisionReason ?? `${input.surface} command "${input.command}" was admitted by InterventionPolicy.`,
    capabilityDecision,
    capabilityRefs: input.capabilityRefs ?? [{ kind: "capability", ref: `command:${input.surface}:${input.command}` }],
    policyRef: { kind: "intervention_policy", ref: "policy:explicit-command-runtime-v1" },
    permissionRequired: decision === "confirm_required",
    currentRefs: [commandRef, ...(input.currentRefs ?? [])],
    auditRefs: [commandRef, ...(input.auditRefs ?? [])],
    ...(input.outcomeSummary
      ? {
          outcomeEvent: {
            type: "action_outcome" as const,
            summary: input.outcomeSummary,
            targetRef: input.target.ref,
          },
        }
      : {}),
  }));
}

export async function allocateDeterministicGoalId(
  seed: unknown,
  goalExists: (goalId: string) => Promise<boolean>,
): Promise<string> {
  const baseId = `goal_${stableId(stableJson(seed)).slice(0, 16)}`;
  for (let suffix = 0; suffix < 1000; suffix++) {
    const candidate = suffix === 0 ? baseId : `${baseId}_${suffix}`;
    if (!(await goalExists(candidate))) return candidate;
  }
  throw new Error(`unable to allocate deterministic goal id for seed ${baseId}`);
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
