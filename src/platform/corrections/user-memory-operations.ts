import path from "node:path";
import { z } from "zod/v3";
import type { StateManager } from "../../base/state/state-manager.js";
import { RuntimeEvidenceLedger } from "../../runtime/store/evidence-ledger.js";
import {
  MemoryCorrectionEntrySchema,
  MemoryCorrectionTargetKindSchema,
  memoryCorrectionTargetKey,
  type MemoryCorrectionEntry,
  type MemoryCorrectionKind,
  type MemoryCorrectionTargetRef,
} from "./memory-correction-ledger.js";
import {
  projectUserFacingMemoryInspect,
  type UserFacingMemoryInspectProjection,
} from "./memory-inspect-projection.js";
import {
  AgentMemoryStoreSchema,
  type AgentMemoryEntry,
} from "../knowledge/types/agent-memory.js";
import {
  loadAgentMemoryStore as loadAgentMemoryStoreFromOwner,
  projectAgentMemory,
  saveAgentMemoryStore as saveAgentMemoryStoreToOwner,
} from "../knowledge/knowledge-manager-internals.js";
import { commitAgentMemoryCorrectionToTruth } from "../knowledge/memory-truth-adapter.js";
import {
  applyAgentMemoryCorrection,
  listAgentMemoryCorrectionHistory,
  type AgentMemoryHost,
} from "../knowledge/knowledge-manager-agent-memory.js";
import type { ILLMClient } from "../../base/llm/llm-client.js";
import {
  PersonalAgentRuntimeStore,
  buildPersonalAgentDecisionTrace,
  stableId,
  type RuntimeGraphRef,
} from "../../runtime/personal-agent/index.js";
import { InteractionAuthorityStore } from "../../runtime/control/interaction-authority-store.js";
import { projectMemoryCorrectionAuthority } from "../../runtime/control/execution-authority-decision.js";

export const UserMemoryOperationSchema = z.enum(["correct", "forget", "retract", "history"]);
export type UserMemoryOperation = z.infer<typeof UserMemoryOperationSchema>;

const RefPattern = /^(agent_memory|soil_record|runtime_evidence|dream_checkpoint):(.+)$/;

export function parseMemoryCorrectionRef(value: string): MemoryCorrectionTargetRef {
  const match = RefPattern.exec(value);
  if (!match) {
    throw new Error("memory ref must use <kind>:<id>, where kind is agent_memory, soil_record, runtime_evidence, or dream_checkpoint");
  }
  return {
    kind: MemoryCorrectionTargetKindSchema.parse(match[1]),
    id: match[2]!,
  };
}

export interface UserMemoryOperationInput {
  operation: UserMemoryOperation;
  targetRef: MemoryCorrectionTargetRef;
  reason?: string;
  replacementValue?: string;
  replacementRef?: MemoryCorrectionTargetRef | null;
  replacementKey?: string;
  goalId?: string;
  runId?: string;
  taskId?: string;
  now?: string;
}

export interface UserMemoryOperationResult {
  operation: UserMemoryOperation;
  target_ref: MemoryCorrectionTargetRef;
  correction: MemoryCorrectionEntry | null;
  history: MemoryCorrectionEntry[];
  replacement?: { ref: MemoryCorrectionTargetRef; entry?: AgentMemoryEntry };
}

export interface UserMemoryInspectInput {
  targetRef: MemoryCorrectionTargetRef;
  goalId?: string;
  runId?: string;
  taskId?: string;
}

function correctionKindForOperation(operation: Exclude<UserMemoryOperation, "history">): MemoryCorrectionKind {
  if (operation === "correct") return "corrected";
  if (operation === "forget") return "forgotten";
  return "retracted";
}

function scopeFor(input: UserMemoryOperationInput): { goal_id?: string; run_id?: string; task_id?: string } {
  return {
    ...(input.goalId ? { goal_id: input.goalId } : {}),
    ...(input.runId ? { run_id: input.runId } : {}),
    ...(input.taskId ? { task_id: input.taskId } : {}),
  };
}

function correctionReason(input: UserMemoryOperationInput): string {
  return input.reason ?? `User requested ${input.operation} for ${input.targetRef.kind}:${input.targetRef.id}`;
}

function stateManagerAgentMemoryHost(stateManager: StateManager): AgentMemoryHost {
  const llmClient = {} as ILLMClient;
  return {
    llmClient,
    baseDir: stateManager.getBaseDir(),
    loadAgentMemoryStore: async () => {
      return AgentMemoryStoreSchema.parse(await loadAgentMemoryStoreFromOwner(stateManager));
    },
    saveAgentMemoryStore: async (store) => {
      await saveAgentMemoryStoreToOwner(stateManager, store);
    },
    commitAgentMemoryCorrection: async (store, result) => {
      await commitAgentMemoryCorrectionToTruth(stateManager.getBaseDir(), {
        store,
        correction: result.correction,
        target: result.target,
        replacement: result.replacement,
      });
      await projectAgentMemory(stateManager, store);
    },
  };
}

function runtimeEvidenceLedgerForState(stateManager: StateManager): RuntimeEvidenceLedger {
  return new RuntimeEvidenceLedger(path.join(stateManager.getBaseDir(), "runtime"));
}

function assertRuntimeScope(input: UserMemoryOperationInput): void {
  const scope = scopeFor(input);
  if (!scope.goal_id && !scope.run_id) {
    throw new Error("non-agent memory operations require --goal or --run so the audit entry can be scoped");
  }
}

export async function runUserMemoryOperation(
  stateManager: StateManager,
  input: UserMemoryOperationInput
): Promise<UserMemoryOperationResult> {
  if (input.operation === "history") {
    return {
      operation: input.operation,
      target_ref: input.targetRef,
      correction: null,
      history: await readCorrectionHistory(stateManager, input),
    };
  }

  const correctionKind = correctionKindForOperation(input.operation);
  const correctionId = deterministicMemoryCorrectionId(input, correctionKind);
  if (input.targetRef.kind === "agent_memory") {
    const result = await applyAgentMemoryCorrection(stateManagerAgentMemoryHost(stateManager), {
      targetId: input.targetRef.id,
      correctionKind: correctionKind as "corrected" | "forgotten" | "retracted",
      reason: correctionReason(input),
      correctionId,
      replacementValue: input.replacementValue,
      replacementId: input.replacementValue
        ? deterministicAgentMemoryReplacementId(input, correctionId)
        : undefined,
      replacementKey: input.replacementKey,
      actor: "user",
      createdAt: input.now,
      provenanceRef: "pulseed memory command",
    });
    await recordMemoryCorrectionTrace(stateManager, input, result.correction, {
      memoryRef: { kind: "memory", ref: input.targetRef.id },
      replacementRef: result.replacement ? { kind: "memory", ref: result.replacement.id } : null,
    });
    return {
      operation: input.operation,
      target_ref: input.targetRef,
      correction: result.correction,
      history: await listAgentMemoryCorrectionHistory(stateManagerAgentMemoryHost(stateManager), input.targetRef),
      ...(result.replacement
        ? { replacement: { ref: { kind: "agent_memory", id: result.replacement.id }, entry: result.replacement } }
        : {}),
    };
  }

  const now = input.now ?? new Date().toISOString();
  assertRuntimeScope(input);
  const scopedTarget: MemoryCorrectionTargetRef = {
    ...input.targetRef,
    ...(Object.keys(scopeFor(input)).length > 0 ? { scope: scopeFor(input) } : {}),
  };
  const correction = MemoryCorrectionEntrySchema.parse({
    correction_id: correctionId,
    target_ref: scopedTarget,
    correction_kind: correctionKind,
    replacement_ref: input.replacementRef ?? null,
    actor: "user",
    reason: correctionReason(input),
    created_at: now,
    provenance: { source: "user", source_ref: "pulseed memory command", confidence: 1 },
  });
  const ledger = runtimeEvidenceLedgerForState(stateManager);
  await recordMemoryCorrectionTrace(stateManager, input, correction, {
    memoryRef: { kind: input.targetRef.kind, ref: input.targetRef.id },
    replacementRef: input.replacementRef
      ? { kind: input.replacementRef.kind, ref: input.replacementRef.id }
      : null,
  });
  await ledger.appendCorrection({
    ...correction,
    scope: scopeFor(input),
  });
  return {
    operation: input.operation,
    target_ref: scopedTarget,
    correction,
    history: await readCorrectionHistory(stateManager, { ...input, targetRef: scopedTarget }),
  };
}

export async function inspectUserMemory(
  stateManager: StateManager,
  input: UserMemoryInspectInput,
): Promise<UserFacingMemoryInspectProjection> {
  const history = await readCorrectionHistory(stateManager, {
    operation: "history",
    targetRef: input.targetRef,
    goalId: input.goalId,
    runId: input.runId,
    taskId: input.taskId,
  });
  if (input.targetRef.kind !== "agent_memory") {
    return projectUserFacingMemoryInspect({
      targetKind: input.targetRef.kind,
      history,
    });
  }
  const store = await stateManagerAgentMemoryHost(stateManager).loadAgentMemoryStore();
  return projectUserFacingMemoryInspect({
    targetKind: input.targetRef.kind,
    history,
    agentMemoryEntry: store.entries.find((entry) => entry.id === input.targetRef.id) ?? null,
  });
}

function deterministicMemoryCorrectionId(
  input: UserMemoryOperationInput,
  correctionKind: MemoryCorrectionKind,
): string {
  const targetRef = {
    ...input.targetRef,
    ...(Object.keys(scopeFor(input)).length > 0 ? { scope: scopeFor(input) } : {}),
  };
  return `user-memory-correction-${stableId(stableJson({
    operation: input.operation,
    correctionKind,
    targetRef,
    reason: correctionReason(input),
    replacementValue: input.replacementValue,
    replacementRef: input.replacementRef ?? null,
    replacementKey: input.replacementKey,
  }))}`;
}

function deterministicAgentMemoryReplacementId(
  input: UserMemoryOperationInput,
  correctionId: string,
): string {
  return `agent-memory-replacement-${stableId(stableJson({
    correctionId,
    targetRef: input.targetRef,
    replacementValue: input.replacementValue,
    replacementKey: input.replacementKey,
  }))}`;
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

async function readCorrectionHistory(
  stateManager: StateManager,
  input: UserMemoryOperationInput
): Promise<MemoryCorrectionEntry[]> {
  if (input.targetRef.kind === "agent_memory") {
    return listAgentMemoryCorrectionHistory(stateManagerAgentMemoryHost(stateManager), input.targetRef);
  }
  const ledger = runtimeEvidenceLedgerForState(stateManager);
  const summaries = await Promise.all([
    input.runId ? ledger.summarizeRun(input.runId).catch(() => null) : null,
    input.goalId ? ledger.summarizeGoal(input.goalId).catch(() => null) : null,
  ]);
  const deduped = new Map<string, MemoryCorrectionEntry>();
  for (const correction of summaries.flatMap((summary) => summary?.corrections ?? [])) {
    deduped.set(correction.correction_id, correction);
  }
  const expectedTarget = {
    ...input.targetRef,
    ...(Object.keys(scopeFor(input)).length > 0 ? { scope: scopeFor(input) } : {}),
  };
  const expectedKey = memoryCorrectionTargetKey(expectedTarget);
  return [...deduped.values()].filter((correction) =>
    memoryCorrectionTargetKey(correction.target_ref) === expectedKey
  );
}

async function recordMemoryCorrectionTrace(
  stateManager: StateManager,
  input: UserMemoryOperationInput,
  correction: MemoryCorrectionEntry,
  refs: {
    memoryRef: RuntimeGraphRef;
    replacementRef: RuntimeGraphRef | null;
  },
): Promise<void> {
  const store = new PersonalAgentRuntimeStore(stateManager.getBaseDir(), {
    controlBaseDir: stateManager.getBaseDir(),
  });
  const scopeRefs: RuntimeGraphRef[] = [
    ...(input.goalId ? [{ kind: "goal", ref: input.goalId }] : []),
    ...(input.runId ? [{ kind: "run", ref: input.runId }] : []),
    ...(input.taskId ? [{ kind: "task", ref: input.taskId }] : []),
  ];
  await store.recordTrace(buildPersonalAgentDecisionTrace({
    callerPath: "memory_correction",
    source: {
      sourceKind: "memory_operation",
      sourceId: correction.correction_id,
      emittedAt: correction.created_at,
      sourceEpoch: input.operation,
      highWatermark: memoryCorrectionTargetKey(correction.target_ref),
      replayKey: [
        "memory_correction",
        correction.correction_id,
        input.operation,
        memoryCorrectionTargetKey(correction.target_ref),
      ].join(":"),
      summary: `User ${input.operation} operation committed truth maintenance for ${input.targetRef.kind}:${input.targetRef.id}.`,
      sourceRef: { kind: "memory_correction", ref: correction.correction_id },
    },
    target: {
      kind: "memory_update",
      ref: refs.memoryRef,
      effect: "write_memory",
      summary: correction.reason,
    },
    decision: "allow",
    decisionReason: "User memory correction is allowed after the truth-maintenance commit and future decisions must treat the target memory as corrected or invalidated.",
    capabilityDecision: "available",
    capabilityRefs: [{ kind: "memory_correction_operation", ref: input.operation }],
    policyRef: { kind: "intervention_policy", ref: "policy:memory-correction-v1" },
    currentRefs: [
      refs.memoryRef,
      ...(refs.replacementRef ? [refs.replacementRef] : []),
      ...scopeRefs,
    ],
    staleRefs: [refs.memoryRef],
    auditRefs: [{ kind: "memory_correction", ref: correction.correction_id }],
    outcomeEvent: {
      type: "memory_updated",
      summary: "Memory correction/invalidation was committed before the memory can influence future decisions.",
      targetRef: refs.memoryRef,
    },
  }));
  await new InteractionAuthorityStore(stateManager.getBaseDir(), {
    controlBaseDir: stateManager.getBaseDir(),
  }).recordDecision(projectMemoryCorrectionAuthority({
    correctionId: correction.correction_id,
    targetRef: `${input.targetRef.kind}:${input.targetRef.id}`,
    decidedAt: correction.created_at,
    reason: "Memory correction was committed before the target can influence future recall or normal projection.",
    memoryWithheld: true,
    normalSurfaceProjectionRef: `normal-surface:memory-correction:${correction.correction_id}`,
  }));
}
