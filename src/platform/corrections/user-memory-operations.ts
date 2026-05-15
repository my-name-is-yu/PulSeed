import { randomUUID } from "node:crypto";
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
  AgentMemoryStoreSchema,
  type AgentMemoryEntry,
} from "../knowledge/types/agent-memory.js";
import { knowledgeMemoryStoreForStateManager } from "../knowledge/knowledge-manager-internals.js";
import {
  applyAgentMemoryCorrection,
  listAgentMemoryCorrectionHistory,
  type AgentMemoryHost,
} from "../knowledge/knowledge-manager-agent-memory.js";
import type { ILLMClient } from "../../base/llm/llm-client.js";

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
  const store = knowledgeMemoryStoreForStateManager(stateManager);
  return {
    llmClient,
    loadAgentMemoryStore: async () => {
      return AgentMemoryStoreSchema.parse(await store.loadAgentMemoryStore());
    },
    saveAgentMemoryStore: async (store) => {
      await knowledgeMemoryStoreForStateManager(stateManager).saveAgentMemoryStore(store);
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
  if (input.targetRef.kind === "agent_memory") {
    const result = await applyAgentMemoryCorrection(stateManagerAgentMemoryHost(stateManager), {
      targetId: input.targetRef.id,
      correctionKind: correctionKind as "corrected" | "forgotten" | "retracted",
      reason: correctionReason(input),
      replacementValue: input.replacementValue,
      replacementKey: input.replacementKey,
      actor: "user",
      createdAt: input.now,
      provenanceRef: "pulseed memory command",
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
    correction_id: `user-memory-correction-${randomUUID()}`,
    target_ref: scopedTarget,
    correction_kind: correctionKind,
    replacement_ref: input.replacementRef ?? null,
    actor: "user",
    reason: correctionReason(input),
    created_at: now,
    provenance: { source: "user", source_ref: "pulseed memory command", confidence: 1 },
  });
  const ledger = runtimeEvidenceLedgerForState(stateManager);
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
