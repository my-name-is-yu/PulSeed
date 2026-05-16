import { createHash, randomUUID } from "node:crypto";
import { z } from "zod/v3";
import type { ILLMClient } from "../../base/llm/llm-client.js";
import {
  MemoryCorrectionEntrySchema,
  correctionStateForTarget,
  memoryCorrectionTargetKey,
  summarizeMemoryCorrectionState,
  type MemoryCorrectionEntry,
  type MemoryCorrectionEntryInput,
  type MemoryCorrectionKind,
  type MemoryCorrectionTargetRef,
} from "../corrections/memory-correction-ledger.js";
import { MemoryQuarantineStateSchema, type MemoryQuarantineState } from "../corrections/memory-quarantine.js";
import type { MemoryProvenance, MemoryVerificationStatus } from "../corrections/memory-quarantine.js";
import {
  isSensitivityAllowed,
  MemoryGovernanceSchema,
  type MemoryGovernance,
  type MemoryGovernanceInput,
  type MemorySensitivity,
} from "../corrections/memory-governance.js";
import { recordAgentMemoryRecall } from "./memory-truth-adapter.js";
import {
  AgentMemoryEntrySchema,
  AgentMemoryStatusEnum,
} from "./types/agent-memory.js";
import type { AgentMemoryEntry, AgentMemoryStatus, AgentMemoryStore, AgentMemoryType } from "./types/agent-memory.js";
import { cosineSimilarity } from "./embedding-client.js";
import type { IEmbeddingClient } from "./embedding-client.js";

export const AgentMemoryPhysicalDeleteManifestSchema = z.object({
  caller: z.literal("memory_repair"),
  targetKey: z.string().min(1),
  reason: z.string().min(1),
  manifestRef: z.string().min(1),
  approvedAt: z.string().datetime(),
}).strict();
export type AgentMemoryPhysicalDeleteManifest = z.infer<typeof AgentMemoryPhysicalDeleteManifestSchema>;

export const AgentMemoryRecallModeSchema = z.enum(["exact", "lexical", "semantic", "graph"]);
export type AgentMemoryRecallMode = z.infer<typeof AgentMemoryRecallModeSchema>;

export interface AgentMemoryHost {
  llmClient: ILLMClient;
  embeddingClient?: IEmbeddingClient;
  baseDir?: string;
  loadAgentMemoryStore(): Promise<AgentMemoryStore>;
  saveAgentMemoryStore(store: AgentMemoryStore): Promise<void>;
  commitAgentMemoryCorrection?(
    store: AgentMemoryStore,
    result: AgentMemoryCorrectionResult,
  ): Promise<void>;
}

const inactiveAgentMemoryStatuses = new Set<AgentMemoryStatus>([
  "archived",
  "corrected",
  "superseded",
  "retracted",
  "forgotten",
  "quarantined",
  "conflicted",
]);

function isAgentMemoryEntryActive(entry: AgentMemoryEntry): boolean {
  return !inactiveAgentMemoryStatuses.has(entry.status);
}

export async function saveAgentMemoryEntry(
  host: AgentMemoryHost,
  entry: {
    key: string;
    value: string;
    tags?: string[];
    category?: string;
    memory_type?: AgentMemoryType;
    verification_status?: MemoryVerificationStatus;
    provenance?: MemoryProvenance;
    governance?: MemoryGovernanceInput;
  }
): Promise<AgentMemoryEntry> {
  const store = await host.loadAgentMemoryStore();
  const now = new Date().toISOString();
  const existingActive = store.entries.findIndex((e) => e.key === entry.key && isAgentMemoryEntryActive(e));
  const existing = existingActive >= 0
    ? existingActive
    : store.entries.findIndex((e) => e.key === entry.key);

  let saved: AgentMemoryEntry;
  if (existing >= 0) {
    const prev = store.entries[existing]!;
    saved = AgentMemoryEntrySchema.parse({
      ...prev,
      value: entry.value,
      tags: entry.tags ?? prev.tags,
      category: entry.category ?? prev.category,
      memory_type: entry.memory_type ?? prev.memory_type,
      verification_status: entry.verification_status ?? prev.verification_status,
      provenance: entry.provenance ?? prev.provenance,
      governance: entry.governance ? MemoryGovernanceSchema.parse(entry.governance) : prev.governance,
      status: prev.status,
      updated_at: now,
    });
    store.entries[existing] = saved;
  } else {
    saved = AgentMemoryEntrySchema.parse({
      id: crypto.randomUUID(),
      key: entry.key,
      value: entry.value,
      tags: entry.tags ?? [],
      category: entry.category,
      memory_type: entry.memory_type ?? "fact",
      verification_status: entry.verification_status,
      provenance: entry.provenance,
      governance: entry.governance ? MemoryGovernanceSchema.parse(entry.governance) : undefined,
      created_at: now,
      updated_at: now,
    });
    store.entries.push(saved);
  }

  await host.saveAgentMemoryStore(store);
  return saved;
}

export async function recallAgentMemoryEntries(
  host: AgentMemoryHost,
  query: string,
  opts?: {
    mode?: AgentMemoryRecallMode;
    exact?: boolean;
    category?: string;
    memory_type?: AgentMemoryType;
    limit?: number;
    include_archived?: boolean;
    semantic?: boolean;
    consent_scope?: string;
    max_sensitivity?: MemorySensitivity;
  }
): Promise<AgentMemoryEntry[]> {
  return (await recallAgentMemoryEntriesWithRecord(host, query, opts)).entries;
}

export interface AgentMemoryRecallWithRecord {
  entries: AgentMemoryEntry[];
    recall: {
      mode: AgentMemoryRecallMode | "semantic_unavailable";
      semanticIndexStatus: "available" | "unavailable" | "not_requested";
      safeForNormalProjection: boolean;
      recallId: string | null;
      resultClaims: Array<{
        claim_id: string;
        mode: AgentMemoryRecallMode | "semantic_unavailable";
        evidence_refs: string[];
        correction_status: string;
        invalidation_status: string;
        confidence: number | null;
        trust_state: string;
        safe_for_normal_projection: boolean;
      }>;
      withheldClaimIds: string[];
    };
}

export async function recallAgentMemoryEntriesWithRecord(
  host: AgentMemoryHost,
  query: string,
  opts?: {
    mode?: AgentMemoryRecallMode;
    exact?: boolean;
    category?: string;
    memory_type?: AgentMemoryType;
    limit?: number;
    include_archived?: boolean;
    semantic?: boolean;
    consent_scope?: string;
    max_sensitivity?: MemorySensitivity;
  }
): Promise<AgentMemoryRecallWithRecord> {
  const store = await host.loadAgentMemoryStore();
  const {
    category,
    memory_type,
    limit = 10,
    include_archived = false,
    consent_scope,
    max_sensitivity,
  } = opts ?? {};
  const mode = opts?.mode
    ?? (opts?.exact ? "exact" : opts?.semantic ? "semantic" : "lexical");

  const scopedEntries = store.entries.filter((e) => {
    if (consent_scope && !e.governance.consent.allowed_contexts.includes(consent_scope)) return false;
    if (max_sensitivity && !isSensitivityAllowed(e.governance.sensitivity, max_sensitivity)) return false;
    const matchesCategory = category ? e.category === category : true;
    const matchesType = memory_type ? e.memory_type === memory_type : true;
    return matchesCategory && matchesType;
  });
  const candidates = scopedEntries.filter((e) => include_archived || isAgentMemoryEntryActive(e));
  const inactiveConflicts = scopedEntries.filter((e) => !isAgentMemoryEntryActive(e) && (
    e.status === "conflicted" || e.correction_state?.status === "conflicted"
  ));

  if (mode === "semantic") {
    if (!host.embeddingClient) {
      const recall = await maybeRecordRecall(host, {
        mode: "semantic_unavailable",
        query,
        entries: [],
        semanticIndexStatus: "unavailable",
      });
      return {
        entries: [],
        recall: {
          mode: "semantic_unavailable",
          semanticIndexStatus: "unavailable",
          safeForNormalProjection: true,
          recallId: recall?.recall_id ?? null,
          resultClaims: recall?.result_claims ?? [],
          withheldClaimIds: recall?.withheld_claim_ids ?? [],
        },
      };
    }
    const semanticPool = include_archived ? scopedEntries : [...candidates, ...inactiveConflicts];
    if (semanticPool.length === 0) {
      const recall = await maybeRecordRecall(host, {
        mode: "semantic",
        query,
        entries: [],
        semanticIndexStatus: "available",
      });
      return {
        entries: [],
        recall: {
          mode: "semantic",
          semanticIndexStatus: "available",
          safeForNormalProjection: true,
          recallId: recall?.recall_id ?? null,
          resultClaims: recall?.result_claims ?? [],
          withheldClaimIds: recall?.withheld_claim_ids ?? [],
        },
      };
    }
    const texts = semanticPool.map((e) => {
      const base = `${e.key}: ${e.value}`;
      return e.summary ? `${base} (${e.summary})` : base;
    });
    const queryVec = await host.embeddingClient.embed(query);
    const candidateVecs = await host.embeddingClient.batchEmbed(texts);
    const scored = semanticPool
      .map((e, i) => ({ entry: e, score: cosineSimilarity(queryVec, candidateVecs[i]!) }))
      .filter((s) => s.score >= 0.3);
    scored.sort((a, b) => b.score - a.score);
    const entries = scored
      .filter((s) => include_archived || isAgentMemoryEntryActive(s.entry))
      .slice(0, limit)
      .map((s) => s.entry);
    const withheldClaimIds = include_archived
      ? []
      : scored
        .filter((s) => s.entry.status === "conflicted" || s.entry.correction_state?.status === "conflicted")
        .map((s) => s.entry.id);
    const recall = await maybeRecordRecall(host, {
      mode: "semantic",
      query,
      entries,
      semanticIndexStatus: "available",
      withheldClaimIds,
    });
    return {
      entries,
      recall: {
        mode: "semantic",
        semanticIndexStatus: "available",
        safeForNormalProjection: withheldClaimIds.length === 0,
        recallId: recall?.recall_id ?? null,
        resultClaims: recall?.result_claims ?? [],
        withheldClaimIds: recall?.withheld_claim_ids ?? [],
      },
    };
  }

  const lower = query.toLowerCase();
  const results = candidates.filter((e) => mode === "exact"
    ? exactAgentMemoryMatch(e, query)
    : mode === "graph"
      ? graphAgentMemoryMatch(e, query)
      : lexicalAgentMemoryMatch(e, lower)
  );

  results.sort((a, b) => {
    const aIsCompiled = a.status === "compiled" ? 0 : 1;
    const bIsCompiled = b.status === "compiled" ? 0 : 1;
    if (aIsCompiled !== bIsCompiled) return aIsCompiled - bIsCompiled;
    return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
  });
  const entries = results.slice(0, limit);
  const withheldClaimIds = include_archived
    ? []
    : inactiveConflicts
      .filter((e) => mode === "exact"
        ? exactAgentMemoryMatch(e, query)
        : mode === "graph"
          ? graphAgentMemoryMatch(e, query)
          : lexicalAgentMemoryMatch(e, lower))
      .map((entry) => entry.id);
  const recall = await maybeRecordRecall(host, {
    mode,
    query,
    entries,
    semanticIndexStatus: "not_requested",
    withheldClaimIds,
  });
  return {
    entries,
    recall: {
      mode,
      semanticIndexStatus: "not_requested",
      safeForNormalProjection: withheldClaimIds.length === 0,
      recallId: recall?.recall_id ?? null,
      resultClaims: recall?.result_claims ?? [],
      withheldClaimIds: recall?.withheld_claim_ids ?? [],
    },
  };
}

async function maybeRecordRecall(
  host: AgentMemoryHost,
  input: {
    mode: AgentMemoryRecallWithRecord["recall"]["mode"];
    query: string;
    entries: AgentMemoryEntry[];
    semanticIndexStatus: AgentMemoryRecallWithRecord["recall"]["semanticIndexStatus"];
    withheldClaimIds?: string[];
  },
): Promise<Awaited<ReturnType<typeof recordAgentMemoryRecall>>> {
  if (!host.baseDir) return null;
  return recordAgentMemoryRecall({
    baseDir: host.baseDir,
    mode: input.mode,
    query: input.query,
    entries: input.entries,
    semanticIndexStatus: input.semanticIndexStatus,
    withheldClaimIds: input.withheldClaimIds ?? [],
  });
}

function exactAgentMemoryMatch(entry: AgentMemoryEntry, query: string): boolean {
  return entry.key === query;
}

function graphAgentMemoryMatch(entry: AgentMemoryEntry, query: string): boolean {
  return entry.id === query || entry.supersedes_memory_id === query || entry.compiled_from?.includes(query) === true;
}

function lexicalAgentMemoryMatch(entry: AgentMemoryEntry, lowerQuery: string): boolean {
  return entry.key.toLowerCase().includes(lowerQuery)
    || entry.value.toLowerCase().includes(lowerQuery)
    || entry.tags.some((tag) => tag.toLowerCase().includes(lowerQuery));
}

export async function listAgentMemoryEntries(
  host: AgentMemoryHost,
  opts?: {
    category?: string;
    memory_type?: AgentMemoryType;
    limit?: number;
    include_archived?: boolean;
    consent_scope?: string;
    max_sensitivity?: MemorySensitivity;
  }
): Promise<AgentMemoryEntry[]> {
  const store = await host.loadAgentMemoryStore();
  const { category, memory_type, limit = 10, include_archived = false, consent_scope, max_sensitivity } = opts ?? {};

  const results = store.entries.filter((e) => {
    if (!include_archived && !isAgentMemoryEntryActive(e)) return false;
    if (consent_scope && !e.governance.consent.allowed_contexts.includes(consent_scope)) return false;
    if (max_sensitivity && !isSensitivityAllowed(e.governance.sensitivity, max_sensitivity)) return false;
    const matchesCategory = category ? e.category === category : true;
    const matchesType = memory_type ? e.memory_type === memory_type : true;
    return matchesCategory && matchesType;
  });

  results.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
  return results.slice(0, limit);
}

export async function deleteAgentMemoryEntry(
  host: AgentMemoryHost,
  key: string,
  manifest?: AgentMemoryPhysicalDeleteManifest
): Promise<boolean> {
  if (!manifest) {
    throw new Error("physical agent memory deletion requires an explicit memory_repair manifest");
  }
  const parsedManifest = AgentMemoryPhysicalDeleteManifestSchema.parse(manifest);
  if (parsedManifest.targetKey !== key) {
    throw new Error("physical agent memory deletion manifest targetKey does not match the requested key");
  }

  const store = await host.loadAgentMemoryStore();
  const activeIdx = store.entries.findIndex((e) => e.key === key && isAgentMemoryEntryActive(e));
  const idx = activeIdx >= 0
    ? activeIdx
    : store.entries.findIndex((e) => e.key === key);
  if (idx < 0) return false;
  const target = store.entries[idx]!;
  store.corrections.push(MemoryCorrectionEntrySchema.parse({
    correction_id: `agent-memory-physical-delete-${randomUUID()}`,
    target_ref: agentMemoryRef(target.id),
    correction_kind: "forgotten",
    replacement_ref: null,
    actor: "manual_tool",
    reason: parsedManifest.reason,
    created_at: parsedManifest.approvedAt,
    provenance: {
      source: "manual_tool",
      source_ref: parsedManifest.manifestRef,
      confidence: 1,
      note: "Repair-only physical delete manifest retained for audit.",
    },
    audit: {
      status: "destructive_delete_requested",
      retained_for_audit: true,
      destructive_delete_approved_at: parsedManifest.approvedAt,
    },
  }));
  store.entries.splice(idx, 1);
  await host.saveAgentMemoryStore(store);
  return true;
}

export interface AgentMemoryQuarantineInput {
  targetIds: string[];
  reason: string;
  source?: MemoryQuarantineState["source"];
  confidence: number;
  inspectionRefs: string[];
  createdAt?: string;
}

export async function quarantineAgentMemoryEntries(
  host: AgentMemoryHost,
  input: AgentMemoryQuarantineInput
): Promise<number> {
  const store = await host.loadAgentMemoryStore();
  const targetIds = new Set(input.targetIds);
  const now = input.createdAt ?? new Date().toISOString();
  const quarantineState = MemoryQuarantineStateSchema.parse({
    status: "quarantined",
    active: false,
    reason: input.reason,
    source: input.source ?? "memory_lint",
    confidence: input.confidence,
    inspection_refs: input.inspectionRefs ?? [],
    created_at: now,
  });
  let quarantined = 0;
  store.entries = store.entries.map((entry) => {
    if (!targetIds.has(entry.id) || entry.status === "quarantined") return entry;
    quarantined++;
    return AgentMemoryEntrySchema.parse({
      ...entry,
      status: "quarantined",
      verification_status: entry.verification_status ?? "suspicious",
      quarantine_state: quarantineState,
      updated_at: now,
    });
  });
  if (quarantined > 0) {
    await host.saveAgentMemoryStore(store);
  }
  return quarantined;
}

export interface AgentMemoryCorrectionInput {
  targetId: string;
  correctionKind: Extract<MemoryCorrectionKind, "corrected" | "forgotten" | "retracted">;
  reason: string;
  correctionId?: string;
  replacementValue?: string;
  replacementId?: string;
  replacementKey?: string;
  replacementTags?: string[];
  replacementStatus?: Extract<AgentMemoryStatus, "raw" | "compiled">;
  actor?: MemoryCorrectionEntry["actor"];
  createdAt?: string;
  provenanceRef?: string;
  beforeCommit?: (result: AgentMemoryCorrectionResult) => Promise<void> | void;
}

export interface AgentMemoryCorrectionResult {
  correction: MemoryCorrectionEntry;
  target: AgentMemoryEntry;
  replacement: AgentMemoryEntry | null;
}

function agentMemoryRef(id: string): MemoryCorrectionTargetRef {
  return { kind: "agent_memory", id };
}

function statusForAgentMemoryCorrection(kind: AgentMemoryCorrectionInput["correctionKind"]): AgentMemoryEntry["status"] {
  if (kind === "corrected") return "corrected";
  if (kind === "forgotten") return "forgotten";
  return "retracted";
}

function redactsAgentMemoryContentForGovernanceExport(entry: AgentMemoryEntry): boolean {
  return entry.governance.export_visibility === "redacted"
    || !isAgentMemoryEntryActive(entry)
    || entry.correction_state?.active === false;
}

export async function applyAgentMemoryCorrection(
  host: AgentMemoryHost,
  input: AgentMemoryCorrectionInput
): Promise<AgentMemoryCorrectionResult> {
  const store = await host.loadAgentMemoryStore();
  const targetIndex = store.entries.findIndex((entry) => entry.id === input.targetId);
  if (targetIndex < 0) {
    throw new Error(`agent memory not found: ${input.targetId}`);
  }

  const now = input.createdAt ?? new Date().toISOString();
  const target = store.entries[targetIndex]!;
  const correctionId = input.correctionId ?? deterministicAgentMemoryCorrectionId(input);
  const replacementId = input.replacementId ?? deterministicAgentMemoryReplacementId(input, correctionId);
  const existingCorrection = store.corrections.find((correction) => correction.correction_id === correctionId);
  if (existingCorrection) {
    const currentTarget = store.entries.find((entry) => entry.id === target.id) ?? target;
    const existingReplacement = existingCorrection.replacement_ref?.kind === "agent_memory"
      ? store.entries.find((entry) => entry.id === existingCorrection.replacement_ref?.id) ?? null
      : null;
    return {
      correction: existingCorrection,
      target: currentTarget,
      replacement: existingReplacement,
    };
  }

  let replacement: AgentMemoryEntry | null = null;
  if (input.correctionKind === "corrected") {
    if (!input.replacementValue) {
      throw new Error("replacementValue is required for corrected agent memory");
    }
    replacement = AgentMemoryEntrySchema.parse({
      id: replacementId,
      key: input.replacementKey ?? `${target.key}.corrected.${now.replace(/[^0-9]/g, "").slice(0, 14)}`,
      value: input.replacementValue,
      tags: input.replacementTags ?? target.tags,
      category: target.category,
      memory_type: target.memory_type,
      governance: target.governance,
      provenance: target.provenance,
      verification_status: target.verification_status,
      status: input.replacementStatus
        ? AgentMemoryStatusEnum.extract(["raw", "compiled"]).parse(input.replacementStatus)
        : target.status === "compiled" ? "compiled" : "raw",
      supersedes_memory_id: target.id,
      created_at: now,
      updated_at: now,
    });
    store.entries.push(replacement);
  }

  const correction = MemoryCorrectionEntrySchema.parse({
    correction_id: correctionId,
    target_ref: agentMemoryRef(target.id),
    correction_kind: input.correctionKind,
    replacement_ref: replacement ? agentMemoryRef(replacement.id) : null,
    actor: input.actor ?? "user",
    reason: input.reason,
    created_at: now,
    provenance: {
      source: input.actor ?? "user",
      ...(input.provenanceRef ? { source_ref: input.provenanceRef } : {}),
      confidence: 1,
    },
  } satisfies MemoryCorrectionEntryInput);
  store.corrections.push(correction);
  const correctionState = summarizeMemoryCorrectionState(store.corrections);
  const targetState = correctionStateForTarget(correctionState, agentMemoryRef(target.id));
  const updatedTarget = AgentMemoryEntrySchema.parse({
    ...target,
    status: statusForAgentMemoryCorrection(input.correctionKind),
    correction_state: targetState,
    updated_at: now,
  });
  store.entries[targetIndex] = updatedTarget;
  await input.beforeCommit?.({ correction, target: updatedTarget, replacement });
  if (host.commitAgentMemoryCorrection) {
    await host.commitAgentMemoryCorrection(store, { correction, target: updatedTarget, replacement });
  } else {
    await host.saveAgentMemoryStore(store);
  }
  return { correction, target: updatedTarget, replacement };
}

function deterministicAgentMemoryCorrectionId(input: AgentMemoryCorrectionInput): string {
  return `agent-memory-correction-${stableId(stableJson({
    targetId: input.targetId,
    correctionKind: input.correctionKind,
    reason: input.reason,
    replacementValue: input.replacementValue,
    replacementKey: input.replacementKey,
    replacementTags: input.replacementTags,
    replacementStatus: input.replacementStatus,
    actor: input.actor ?? "user",
    provenanceRef: input.provenanceRef,
  }))}`;
}

function deterministicAgentMemoryReplacementId(
  input: AgentMemoryCorrectionInput,
  correctionId: string,
): string {
  return `agent-memory-replacement-${stableId(stableJson({
    correctionId,
    targetId: input.targetId,
    replacementValue: input.replacementValue,
    replacementKey: input.replacementKey,
  }))}`;
}

function stableId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 20);
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

export async function listAgentMemoryCorrectionHistory(
  host: AgentMemoryHost,
  target?: MemoryCorrectionTargetRef
): Promise<MemoryCorrectionEntry[]> {
  const store = await host.loadAgentMemoryStore();
  const corrections = [...(store.corrections ?? [])].sort((a, b) => a.created_at.localeCompare(b.created_at));
  if (!target) return corrections;
  const targetKey = memoryCorrectionTargetKey(target);
  return corrections.filter((correction) => memoryCorrectionTargetKey(correction.target_ref) === targetKey);
}

export async function exportAgentMemoryGovernance(
  host: AgentMemoryHost,
  opts?: {
    consent_scope?: string;
    include_secret?: boolean;
  }
): Promise<Array<{
  id: string;
  key: string;
  summary: string | null;
  status: AgentMemoryEntry["status"];
  governance: AgentMemoryEntry["governance"];
  provenance: AgentMemoryEntry["provenance"] | null;
}>> {
  const store = await host.loadAgentMemoryStore();
  return store.entries
    .filter((entry) => opts?.include_secret || entry.governance.sensitivity !== "secret")
    .filter((entry) => !opts?.consent_scope || entry.governance.consent.allowed_contexts.includes(opts.consent_scope))
    .filter((entry) => entry.governance.export_visibility !== "hidden")
    .map((entry) => {
      const redacted = redactsAgentMemoryContentForGovernanceExport(entry);
      return {
        id: entry.id,
        key: redacted ? "[redacted]" : entry.key,
        summary: redacted ? null : entry.summary ?? entry.value,
        status: entry.status,
        governance: entry.governance,
        provenance: entry.provenance ?? null,
      };
    });
}

export async function consolidateAgentMemoryEntries(
  host: AgentMemoryHost,
  opts: {
    category?: string;
    memory_type?: AgentMemoryType;
    max_entries?: number;
    llmCall: (prompt: string) => Promise<string>;
  }
): Promise<{ compiled: AgentMemoryEntry[]; archived: number }> {
  const store = await host.loadAgentMemoryStore();
  const now = new Date().toISOString();
  const maxEntries = opts.max_entries ?? 50;

  let rawEntries = store.entries.filter((e) => e.status === "raw");
  if (opts.category) rawEntries = rawEntries.filter((e) => e.category === opts.category);
  if (opts.memory_type) rawEntries = rawEntries.filter((e) => e.memory_type === opts.memory_type);
  rawEntries = rawEntries.slice(0, maxEntries);

  const groups = new Map<string, AgentMemoryEntry[]>();
  for (const entry of rawEntries) {
    const groupKey = `${entry.category ?? "_"}::${entry.memory_type}`;
    const group = groups.get(groupKey) ?? [];
    group.push(entry);
    groups.set(groupKey, group);
  }

  const compiledSchema = z.object({
    key: z.string(),
    value: z.string(),
    summary: z.string(),
    tags: z.array(z.string()),
  });

  const compiled: AgentMemoryEntry[] = [];
  const archivedIds = new Set<string>();

  for (const [, group] of groups) {
    if (group.length < 2) continue;
    const entryLines = group.map((e) => `- [${e.key}]: ${e.value} (tags: ${e.tags.join(", ")})`).join("\n");
    const prompt = [
      "Consolidate the following memory entries into a single entry.",
      "Return ONLY a JSON object with these fields:",
      "- key: a descriptive key for the consolidated memory",
      "- value: the consolidated content (comprehensive but concise)",
      "- summary: a one-line summary (under 100 chars)",
      "- tags: relevant tags as string array",
      "",
      "Entries to consolidate:",
      entryLines,
    ].join("\n");

    let llmRaw: string;
    try {
      llmRaw = await opts.llmCall(prompt);
    } catch {
      continue;
    }

    let cleaned = llmRaw.trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) continue;
    cleaned = jsonMatch[0];

    let parsedResult: z.infer<typeof compiledSchema>;
    try {
      parsedResult = compiledSchema.parse(JSON.parse(cleaned));
    } catch {
      continue;
    }

    const firstEntry = group[0]!;
    const newEntry = AgentMemoryEntrySchema.parse({
      id: crypto.randomUUID(),
      key: parsedResult.key,
      value: parsedResult.value,
      summary: parsedResult.summary,
      tags: parsedResult.tags,
      category: firstEntry.category,
      memory_type: firstEntry.memory_type,
      status: "compiled",
      compiled_from: group.map((e) => e.id),
      created_at: now,
      updated_at: now,
    });

    compiled.push(newEntry);
    store.entries.push(newEntry);
    for (const src of group) archivedIds.add(src.id);
  }

  for (const entry of store.entries) {
    if (archivedIds.has(entry.id)) {
      entry.status = "archived";
      entry.updated_at = now;
    }
  }

  if (compiled.length > 0) {
    store.last_consolidated_at = now;
    await host.saveAgentMemoryStore(store);
  }

  return { compiled, archived: archivedIds.size };
}

export async function archiveAgentMemoryEntries(host: AgentMemoryHost, ids: string[]): Promise<number> {
  const store = await host.loadAgentMemoryStore();
  const now = new Date().toISOString();
  let count = 0;
  const idSet = new Set(ids);

  for (const entry of store.entries) {
    if (idSet.has(entry.id) && entry.status !== "archived") {
      entry.status = "archived";
      entry.updated_at = now;
      count++;
    }
  }

  if (count > 0) {
    await host.saveAgentMemoryStore(store);
  }
  return count;
}

export async function getAgentMemoryStatsForHost(host: AgentMemoryHost): Promise<{
  raw: number;
  compiled: number;
  archived: number;
  total: number;
}> {
  const store = await host.loadAgentMemoryStore();
  const stats = { raw: 0, compiled: 0, archived: 0, total: store.entries.length };
  for (const e of store.entries) {
    if (e.status === "raw") stats.raw++;
    else if (e.status === "compiled") stats.compiled++;
    else if (e.status === "archived") stats.archived++;
  }
  return stats;
}

export async function autoConsolidateAgentMemory(
  host: AgentMemoryHost,
  opts?: { rawThreshold?: number }
): Promise<{ consolidated: boolean; compiled?: number; archived?: number }> {
  try {
    const stats = await getAgentMemoryStatsForHost(host);
    if (stats.raw < (opts?.rawThreshold ?? 20)) {
      return { consolidated: false };
    }
    const llmCall = (prompt: string) =>
      host.llmClient.sendMessage([{ role: "user", content: prompt }]).then((r) => r.content);
    const result = await consolidateAgentMemoryEntries(host, { llmCall });
    return { consolidated: true, compiled: result.compiled.length, archived: result.archived };
  } catch {
    return { consolidated: false };
  }
}
