import {
  CorrectionRefSchema,
  EvidenceRefSchema,
  ForgetTombstoneSchema,
  MemoryClaimSchema,
  MemoryTruthMaintenanceStore,
  ProjectionRecordSchema,
  memoryTruthQueryHash,
  stableMemoryTruthId,
  type CorrectionRef,
  type CorrectionRefInput,
  type EvidenceRefInput,
  type MemoryClaim,
  type MemoryClaimInput,
  type MemoryClaimLifecycle,
  type MemoryClaimTrustState,
  type MemoryTruthMaintenanceStoreOptions,
  type ProjectionRecordInput,
  type RecallRecord,
} from "../../runtime/store/memory-truth-maintenance-store.js";
import {
  MemoryCorrectionTargetStateSchema,
  MemoryCorrectionEntrySchema,
  type MemoryCorrectionEntry,
} from "../corrections/memory-correction-ledger.js";
import type {
  MemoryProvenance,
  MemoryVerificationStatus,
} from "../corrections/memory-quarantine.js";
import type {
  AgentMemoryEntry,
  AgentMemoryStore,
  AgentMemoryType,
} from "./types/agent-memory.js";
import { AgentMemoryEntrySchema, AgentMemoryStoreSchema } from "./types/agent-memory.js";
import {
  DomainKnowledgeSchema,
  KnowledgeEntrySchema,
  SharedKnowledgeEntrySchema,
  type DomainKnowledge,
  type KnowledgeEntry,
  type SharedKnowledgeEntry,
} from "../../base/types/knowledge.js";

const AGENT_MEMORY_OWNER_KIND = "agent_memory";
const AGENT_MEMORY_OWNER_SCOPE = "default";
const DOMAIN_KNOWLEDGE_OWNER_KIND = "domain_knowledge";
const SHARED_KNOWLEDGE_OWNER_KIND = "shared_knowledge";

export function createMemoryTruthStore(
  baseDir: string,
  options: MemoryTruthMaintenanceStoreOptions = {},
): MemoryTruthMaintenanceStore {
  return new MemoryTruthMaintenanceStore(baseDir, options);
}

export async function loadAgentMemoryStoreFromTruth(baseDir: string): Promise<AgentMemoryStore> {
  const store = createMemoryTruthStore(baseDir);
  try {
    const claims = await store.listClaims({
      ownerKind: AGENT_MEMORY_OWNER_KIND,
      ownerScope: AGENT_MEMORY_OWNER_SCOPE,
      includeInactive: true,
    });
    const corrections = await store.listCorrections();
    const destructiveDeleteClaimIds = new Set(
      corrections
        .filter((correction) => correction.correction_kind === "forgotten")
        .filter((correction) => {
          const stored = correction.metadata["memory_correction_entry"];
          const parsed = MemoryCorrectionEntrySchema.safeParse(stored);
          return parsed.success && parsed.data.audit?.status === "destructive_delete_requested";
        })
        .map((correction) => correction.target_claim_id),
    );
    return AgentMemoryStoreSchema.parse({
      entries: claims
        .filter((claim) => !destructiveDeleteClaimIds.has(claim.claim_id))
        .sort((left, right) => left.created_at.localeCompare(right.created_at) || left.claim_id.localeCompare(right.claim_id))
        .map(agentMemoryEntryFromClaim)
        .filter(isAgentMemoryEntry),
      corrections: corrections
        .filter((correction) => correction.target_claim_id.length > 0)
        .map(agentMemoryCorrectionEntryFromRef),
      last_consolidated_at: null,
    });
  } finally {
    await store.close();
  }
}

export async function saveAgentMemoryStoreToTruth(baseDir: string, input: AgentMemoryStore): Promise<void> {
  const parsed = AgentMemoryStoreSchema.parse(input);
  const store = createMemoryTruthStore(baseDir, { appendRuntimeEvents: true });
  try {
    await store.saveOwnerSnapshot({
      ownerKind: AGENT_MEMORY_OWNER_KIND,
      ownerScope: AGENT_MEMORY_OWNER_SCOPE,
      claims: parsed.entries.map(agentMemoryClaimInput),
      evidenceRefs: parsed.entries.map(agentMemoryEvidenceInput),
      corrections: parsed.corrections.map(agentMemoryCorrectionInput),
      tombstones: parsed.corrections
        .filter((correction) => correction.correction_kind === "forgotten")
        .map((correction) => ForgetTombstoneSchema.parse({
          tombstone_id: `agent-memory-tombstone-${correction.correction_id}`,
          claim_id: correction.target_ref.id,
          idempotency_key: correction.correction_id,
          source_evidence_ref: `evidence:agent-memory:${correction.target_ref.id}`,
          reason: correction.reason,
          created_at: correction.created_at,
        })),
      projections: parsed.entries.flatMap(agentMemoryProjectionInputs),
      tombstoneReason: "Agent memory owner snapshot removed this claim.",
      dropRemovedClaimIds: parsed.corrections
        .filter((correction) => correction.correction_kind === "forgotten"
          && correction.audit?.status === "destructive_delete_requested")
        .map((correction) => correction.target_ref.id),
    });
  } finally {
    await store.close();
  }
}

export async function commitAgentMemoryCorrectionToTruth(
  baseDir: string,
  input: {
    store: AgentMemoryStore;
    correction: MemoryCorrectionEntry;
    target: AgentMemoryEntry;
    replacement: AgentMemoryEntry | null;
    failureAfterStep?: "replacement_claim" | "correction" | "target_update" | "tombstone" | "conflict" | "recall" | "projection";
  },
): Promise<void> {
  const parsedStore = AgentMemoryStoreSchema.parse(input.store);
  const correction = MemoryCorrectionEntrySchema.parse(input.correction);
  const truthStore = createMemoryTruthStore(baseDir, { appendRuntimeEvents: true });
  try {
    await truthStore.applyCorrectionTransaction({
      correction: agentMemoryCorrectionInput(correction),
      replacementClaim: input.replacement ? agentMemoryClaimInput(input.replacement) : null,
      replacementEvidenceRefs: input.replacement ? [agentMemoryEvidenceInput(input.replacement)] : [],
      tombstone: correction.correction_kind === "forgotten"
        ? ForgetTombstoneSchema.parse({
          tombstone_id: `agent-memory-tombstone-${correction.correction_id}`,
          claim_id: correction.target_ref.id,
          idempotency_key: correction.correction_id,
          source_evidence_ref: `evidence:agent-memory:${correction.target_ref.id}`,
          reason: correction.reason,
          created_at: correction.created_at,
        })
        : null,
      projectionRecords: [
        ...agentMemoryProjectionInputs(input.target),
        ...(input.replacement ? agentMemoryProjectionInputs(input.replacement) : []),
      ],
      failureAfterStep: input.failureAfterStep,
    });
    await truthStore.saveOwnerSnapshot({
      ownerKind: AGENT_MEMORY_OWNER_KIND,
      ownerScope: AGENT_MEMORY_OWNER_SCOPE,
      claims: parsedStore.entries.map(agentMemoryClaimInput),
      evidenceRefs: parsedStore.entries.map(agentMemoryEvidenceInput),
      corrections: parsedStore.corrections.map(agentMemoryCorrectionInput),
      tombstones: parsedStore.corrections
        .filter((entry) => entry.correction_kind === "forgotten")
        .map((entry) => ForgetTombstoneSchema.parse({
          tombstone_id: `agent-memory-tombstone-${entry.correction_id}`,
          claim_id: entry.target_ref.id,
          idempotency_key: entry.correction_id,
          source_evidence_ref: `evidence:agent-memory:${entry.target_ref.id}`,
          reason: entry.reason,
          created_at: entry.created_at,
        })),
      projections: parsedStore.entries.flatMap(agentMemoryProjectionInputs),
      tombstoneReason: "Agent memory correction commit removed this claim.",
      dropRemovedClaimIds: parsedStore.corrections
        .filter((entry) => entry.correction_kind === "forgotten"
          && entry.audit?.status === "destructive_delete_requested")
        .map((entry) => entry.target_ref.id),
      emitRuntimeEvent: false,
    });
  } finally {
    await truthStore.close();
  }
}

export async function loadDomainKnowledgeFromTruth(baseDir: string, goalId: string): Promise<DomainKnowledge> {
  const store = createMemoryTruthStore(baseDir);
  try {
    const claims = await store.listClaims({
      ownerKind: DOMAIN_KNOWLEDGE_OWNER_KIND,
      ownerScope: goalId,
      includeInactive: true,
      claimType: "knowledge",
    });
    const entries = claims.map(knowledgeEntryFromClaim).filter(isKnowledgeEntry);
    const updatedAt = entries.map((entry) => entry.acquired_at).sort().at(-1) ?? new Date(0).toISOString();
    return DomainKnowledgeSchema.parse({
      goal_id: goalId,
      domain: goalId,
      entries,
      last_updated: updatedAt,
    });
  } finally {
    await store.close();
  }
}

export async function saveDomainKnowledgeToTruth(baseDir: string, input: DomainKnowledge): Promise<void> {
  const parsed = DomainKnowledgeSchema.parse(input);
  const store = createMemoryTruthStore(baseDir, { appendRuntimeEvents: true });
  try {
    await store.saveOwnerSnapshot({
      ownerKind: DOMAIN_KNOWLEDGE_OWNER_KIND,
      ownerScope: parsed.goal_id,
      claims: parsed.entries.map((entry) => knowledgeClaimInput(parsed.goal_id, entry)),
      evidenceRefs: parsed.entries.flatMap((entry) => knowledgeEvidenceInputs(parsed.goal_id, entry)),
      projections: parsed.entries.flatMap((entry) =>
        knowledgeProjectionInputs(DOMAIN_KNOWLEDGE_OWNER_KIND, parsed.goal_id, domainKnowledgeClaimId(parsed.goal_id, entry.entry_id))),
      tombstoneReason: "Domain knowledge owner snapshot removed this claim.",
    });
  } finally {
    await store.close();
  }
}

export async function loadSharedKnowledgeFromTruth(baseDir: string): Promise<SharedKnowledgeEntry[]> {
  const store = createMemoryTruthStore(baseDir);
  try {
    const claims = await store.listClaims({
      ownerKind: SHARED_KNOWLEDGE_OWNER_KIND,
      ownerScope: "global",
      includeInactive: true,
      claimType: "shared_knowledge",
    });
    return claims.map(sharedKnowledgeEntryFromClaim).filter(isSharedKnowledgeEntry);
  } finally {
    await store.close();
  }
}

export async function saveSharedKnowledgeToTruth(baseDir: string, entries: SharedKnowledgeEntry[]): Promise<void> {
  const parsed = entries.map((entry) => SharedKnowledgeEntrySchema.parse(entry));
  const store = createMemoryTruthStore(baseDir, { appendRuntimeEvents: true });
  try {
    await store.saveOwnerSnapshot({
      ownerKind: SHARED_KNOWLEDGE_OWNER_KIND,
      ownerScope: "global",
      claims: parsed.map(sharedKnowledgeClaimInput),
      evidenceRefs: parsed.flatMap((entry) => knowledgeEvidenceInputs("shared", entry)),
      projections: parsed.flatMap((entry) =>
        knowledgeProjectionInputs(SHARED_KNOWLEDGE_OWNER_KIND, "global", sharedKnowledgeClaimId(entry.entry_id))),
      tombstoneReason: "Shared knowledge owner snapshot removed this claim.",
    });
  } finally {
    await store.close();
  }
}

export async function recordAgentMemoryRecall(input: {
  baseDir: string;
  mode: "exact" | "lexical" | "semantic" | "semantic_unavailable" | "graph";
  query: string;
  entries: AgentMemoryEntry[];
  semanticIndexStatus?: "available" | "unavailable" | "not_requested";
}): Promise<RecallRecord | null> {
  const store = createMemoryTruthStore(input.baseDir);
  const now = new Date().toISOString();
  try {
    return await store.recordRecall({
      recall_id: stableMemoryTruthId("memory-recall", {
        mode: input.mode,
        query: input.query,
        entry_ids: input.entries.map((entry) => entry.id),
        now,
      }),
      mode: input.mode,
      query: input.query,
      query_hash: memoryTruthQueryHash(input.query),
      result_claims: input.entries.map((entry) => ({
        claim_id: entry.id,
        mode: input.mode,
        evidence_refs: [`evidence:agent-memory:${entry.id}`],
        correction_status: lifecycleForAgentMemory(entry),
        invalidation_status: invalidationStatusForEntry(entry),
        confidence: entry.provenance?.reliability ?? null,
        trust_state: trustStateForVerification(entry.verification_status),
        safe_for_normal_projection: entry.status === "raw" || entry.status === "compiled",
      })),
      withheld_claim_ids: [],
      semantic_index_status: input.semanticIndexStatus ?? "not_requested",
      safe_for_normal_projection: input.entries.every((entry) => entry.status === "raw" || entry.status === "compiled"),
      created_at: now,
    });
  } finally {
    await store.close();
  }
}

function agentMemoryClaimInput(entry: AgentMemoryEntry): MemoryClaimInput {
  return MemoryClaimSchema.parse({
    claim_id: entry.id,
    owner_kind: AGENT_MEMORY_OWNER_KIND,
    owner_scope: AGENT_MEMORY_OWNER_SCOPE,
    claim_type: claimTypeForAgentMemory(entry.memory_type),
    subject: entry.key,
    predicate: "has_value",
    object: {
      value: entry.value,
      summary: entry.summary ?? null,
      tags: entry.tags,
      category: entry.category ?? null,
      memory_type: entry.memory_type,
    },
    source_evidence_refs: [`evidence:agent-memory:${entry.id}`],
    confidence: entry.provenance?.reliability ?? null,
    trust_state: trustStateForVerification(entry.verification_status),
    sensitivity: entry.governance.sensitivity,
    consent_scope: entry.governance.consent.scope_id,
    lifecycle: lifecycleForAgentMemory(entry),
    created_at: entry.created_at,
    updated_at: entry.updated_at,
    invalidated_by: entry.correction_state?.latest_correction_id ?? null,
    superseded_by: entry.supersedes_memory_id ?? entry.correction_state?.replacement_ref?.id ?? null,
    visible_to_normal_surface: entry.status === "raw" || entry.status === "compiled",
    operator_explanation_refs: [
      ...(entry.correction_state?.latest_correction_id ? [entry.correction_state.latest_correction_id] : []),
      `evidence:agent-memory:${entry.id}`,
    ],
    metadata: { agent_memory_entry: entry },
  });
}

function agentMemoryEvidenceInput(entry: AgentMemoryEntry): EvidenceRefInput {
  const provenance = entry.provenance;
  return EvidenceRefSchema.parse({
    evidence_id: `evidence:agent-memory:${entry.id}`,
    claim_id: entry.id,
    owner_kind: AGENT_MEMORY_OWNER_KIND,
    owner_scope: AGENT_MEMORY_OWNER_SCOPE,
    source_kind: provenance?.source_type ?? "unknown",
    source_ref: provenance?.source_ref ?? entry.id,
    raw_refs: provenance?.raw_refs ?? [],
    reliability: provenance?.reliability ?? null,
    verification_status: trustStateForVerification(provenance?.verification_status),
    created_at: entry.created_at,
  });
}

function agentMemoryCorrectionInput(correction: MemoryCorrectionEntry): CorrectionRefInput {
  return CorrectionRefSchema.parse({
    correction_id: correction.correction_id,
    target_claim_id: correction.target_ref.id,
    correction_kind: correction.correction_kind,
    replacement_claim_id: correction.replacement_ref?.id ?? null,
    idempotency_key: correction.correction_id,
    actor: correction.actor,
    reason: correction.reason,
    created_at: correction.created_at,
    evidence_refs: [
      correction.provenance.evidence_ref,
      correction.provenance.source_ref,
    ].filter(isString),
    metadata: { memory_correction_entry: correction },
  });
}

function agentMemoryCorrectionEntryFromRef(correction: CorrectionRef): MemoryCorrectionEntry {
  const stored = correction.metadata["memory_correction_entry"];
  const parsed = MemoryCorrectionEntrySchema.safeParse(stored);
  if (parsed.success) return parsed.data;
  return MemoryCorrectionEntrySchema.parse({
    schema_version: "memory-correction-entry-v1",
    correction_id: correction.correction_id,
    target_ref: { kind: "agent_memory", id: correction.target_claim_id },
    correction_kind: correction.correction_kind,
    replacement_ref: correction.replacement_claim_id
      ? { kind: "agent_memory", id: correction.replacement_claim_id }
      : null,
    actor: correction.actor === "system" ? "runtime_verification" : correction.actor,
    reason: correction.reason,
    created_at: correction.created_at,
    provenance: {
      source: correction.actor === "system" ? "runtime_verification" : correction.actor,
      source_ref: correction.runtime_event_ref ?? undefined,
      confidence: 1,
    },
    audit: {
      status: "active",
      retained_for_audit: true,
    },
  });
}

function agentMemoryProjectionInputs(entry: AgentMemoryEntry): ProjectionRecordInput[] {
  const safe = entry.status === "raw" || entry.status === "compiled";
  const now = entry.updated_at;
  return [
    ProjectionRecordSchema.parse({
      projection_id: `projection:agent-memory:${entry.id}:normal`,
      claim_id: entry.id,
      owner_kind: AGENT_MEMORY_OWNER_KIND,
      owner_scope: AGENT_MEMORY_OWNER_SCOPE,
      projection_kind: "normal_surface",
      surface: "normal",
      safe_for_normal_surface: safe,
      explanation_refs: safe ? [] : [entry.correction_state?.latest_correction_id].filter(isString),
      payload: {
        key: safe ? entry.key : null,
        summary: safe ? entry.summary ?? entry.value : null,
        lifecycle: lifecycleForAgentMemory(entry),
      },
      created_at: now,
    }),
    ProjectionRecordSchema.parse({
      projection_id: `projection:agent-memory:${entry.id}:soil`,
      claim_id: entry.id,
      owner_kind: AGENT_MEMORY_OWNER_KIND,
      owner_scope: AGENT_MEMORY_OWNER_SCOPE,
      projection_kind: "soil",
      surface: "soil",
      safe_for_normal_surface: safe,
      explanation_refs: [entry.correction_state?.latest_correction_id, `evidence:agent-memory:${entry.id}`].filter(isString),
      payload: {
        source_claim_id: entry.id,
        source_lifecycle: lifecycleForAgentMemory(entry),
        source_status: entry.status,
        visible_to_normal_surface: safe,
      },
      created_at: now,
    }),
    ProjectionRecordSchema.parse({
      projection_id: `projection:agent-memory:${entry.id}:operator`,
      claim_id: entry.id,
      owner_kind: AGENT_MEMORY_OWNER_KIND,
      owner_scope: AGENT_MEMORY_OWNER_SCOPE,
      projection_kind: "operator_debug",
      surface: "operator_debug",
      safe_for_normal_surface: false,
      explanation_refs: [entry.correction_state?.latest_correction_id, `evidence:agent-memory:${entry.id}`].filter(isString),
      payload: {
        entry,
        lifecycle: lifecycleForAgentMemory(entry),
      },
      created_at: now,
    }),
  ];
}

function agentMemoryEntryFromClaim(claim: MemoryClaim): AgentMemoryEntry | null {
  const stored = claim.metadata["agent_memory_entry"];
  const parsed = AgentMemoryEntrySchema.safeParse(stored);
  if (parsed.success) {
    return AgentMemoryEntrySchema.parse({
      ...parsed.data,
      status: agentMemoryStatusForLifecycle(claim.lifecycle, parsed.data.status),
      correction_state: correctionStateFromClaim(claim, parsed.data.correction_state),
      updated_at: claim.updated_at,
    });
  }
  const object = claim.object && typeof claim.object === "object" && !Array.isArray(claim.object)
    ? claim.object as Record<string, unknown>
    : {};
  return AgentMemoryEntrySchema.parse({
    id: claim.claim_id,
    key: claim.subject,
    value: typeof object["value"] === "string" ? object["value"] : JSON.stringify(claim.object),
    summary: typeof object["summary"] === "string" ? object["summary"] : undefined,
    tags: Array.isArray(object["tags"]) ? object["tags"].filter(isString) : [],
    category: typeof object["category"] === "string" ? object["category"] : undefined,
    memory_type: agentMemoryTypeForClaimType(claim.claim_type),
    status: agentMemoryStatusForLifecycle(claim.lifecycle, "raw"),
    correction_state: correctionStateFromClaim(claim, undefined),
    provenance: MemoryProvenanceFromClaim(claim),
    created_at: claim.created_at,
    updated_at: claim.updated_at,
  });
}

function correctionStateFromClaim(
  claim: MemoryClaim,
  fallback: AgentMemoryEntry["correction_state"],
): AgentMemoryEntry["correction_state"] {
  if (claim.lifecycle === "active") return fallback;
  return MemoryCorrectionTargetStateSchema.parse({
    target_ref: { kind: "agent_memory", id: claim.claim_id },
    status: claim.lifecycle === "archived" ? "quarantined" : claim.lifecycle,
    active: false,
    latest_correction_id: claim.invalidated_by,
    replacement_ref: claim.superseded_by ? { kind: "agent_memory", id: claim.superseded_by } : null,
    retained_for_audit: true,
    updated_at: claim.updated_at,
  });
}

function knowledgeClaimInput(goalId: string, entry: KnowledgeEntry): MemoryClaimInput {
  return MemoryClaimSchema.parse({
    claim_id: domainKnowledgeClaimId(goalId, entry.entry_id),
    owner_kind: DOMAIN_KNOWLEDGE_OWNER_KIND,
    owner_scope: goalId,
    claim_type: "knowledge",
    subject: entry.question,
    predicate: "answers",
    object: {
      question: entry.question,
      answer: entry.answer,
      tags: entry.tags,
      entry,
    },
    source_evidence_refs: entry.sources.map((source, index) => `evidence:knowledge:${goalId}:${entry.entry_id}:${index}`),
    confidence: entry.confidence,
    trust_state: entry.confidence >= 0.8 ? "verified" : "unverified",
    sensitivity: "local",
    consent_scope: "local_planning",
    scope: { goal_id: goalId },
    lifecycle: entry.superseded_by ? "corrected" : "active",
    created_at: entry.acquired_at,
    updated_at: entry.acquired_at,
    superseded_by: entry.superseded_by,
    visible_to_normal_surface: entry.superseded_by === null,
    operator_explanation_refs: entry.sources.map((source) => source.reference),
    metadata: { knowledge_entry: entry },
  });
}

function sharedKnowledgeClaimInput(entry: SharedKnowledgeEntry): MemoryClaimInput {
  return MemoryClaimSchema.parse({
    claim_id: sharedKnowledgeClaimId(entry.entry_id),
    owner_kind: SHARED_KNOWLEDGE_OWNER_KIND,
    owner_scope: "global",
    claim_type: "shared_knowledge",
    subject: entry.question,
    predicate: "answers",
    object: {
      question: entry.question,
      answer: entry.answer,
      tags: entry.tags,
      entry,
    },
    source_evidence_refs: entry.sources.map((source, index) => `evidence:knowledge:shared:${entry.entry_id}:${index}`),
    confidence: entry.confidence,
    trust_state: entry.confidence >= 0.8 ? "verified" : "unverified",
    sensitivity: "local",
    consent_scope: "local_planning",
    scope: { source_goal_ids: entry.source_goal_ids },
    lifecycle: entry.superseded_by ? "corrected" : "active",
    created_at: entry.acquired_at,
    updated_at: entry.acquired_at,
    superseded_by: entry.superseded_by,
    visible_to_normal_surface: entry.superseded_by === null,
    operator_explanation_refs: entry.sources.map((source) => source.reference),
    metadata: { shared_knowledge_entry: entry },
  });
}

function knowledgeEvidenceInputs(goalId: string, entry: KnowledgeEntry): EvidenceRefInput[] {
  return entry.sources.map((source, index) => EvidenceRefSchema.parse({
    evidence_id: `evidence:knowledge:${goalId}:${entry.entry_id}:${index}`,
    claim_id: goalId === "shared" ? sharedKnowledgeClaimId(entry.entry_id) : domainKnowledgeClaimId(goalId, entry.entry_id),
    owner_kind: goalId === "shared" ? SHARED_KNOWLEDGE_OWNER_KIND : DOMAIN_KNOWLEDGE_OWNER_KIND,
    owner_scope: goalId === "shared" ? "global" : goalId,
    source_kind: source.type === "document" ? "knowledge" : source.type === "web" ? "web" : "external",
    source_ref: source.reference,
    reliability: reliabilityScore(source.reliability),
    verification_status: entry.confidence >= 0.8 ? "verified" : "unverified",
    created_at: entry.acquired_at,
  }));
}

function knowledgeProjectionInputs(ownerKind: string, ownerScope: string, claimId: string): ProjectionRecordInput[] {
  const now = new Date().toISOString();
  return [
    ProjectionRecordSchema.parse({
      projection_id: `projection:${ownerKind}:${ownerScope}:${claimId}:soil`,
      claim_id: claimId,
      owner_kind: ownerKind,
      owner_scope: ownerScope,
      projection_kind: "soil",
      surface: "soil",
      safe_for_normal_surface: true,
      payload: { source_claim_id: claimId, source_lifecycle: "active" },
      created_at: now,
    }),
    ProjectionRecordSchema.parse({
      projection_id: `projection:${ownerKind}:${ownerScope}:${claimId}:graph`,
      claim_id: claimId,
      owner_kind: ownerKind,
      owner_scope: ownerScope,
      projection_kind: "knowledge_graph",
      surface: "knowledge_graph",
      safe_for_normal_surface: false,
      payload: { source_claim_id: claimId },
      created_at: now,
    }),
  ];
}

function knowledgeEntryFromClaim(claim: MemoryClaim): KnowledgeEntry | null {
  const parsed = KnowledgeEntrySchema.safeParse(claim.metadata["knowledge_entry"]);
  if (parsed.success) return parsed.data;
  const object = claim.object && typeof claim.object === "object" && !Array.isArray(claim.object)
    ? claim.object as Record<string, unknown>
    : {};
  return KnowledgeEntrySchema.parse({
    entry_id: unqualifiedKnowledgeClaimId(claim.claim_id),
    question: claim.subject,
    answer: typeof object["answer"] === "string" ? object["answer"] : JSON.stringify(claim.object),
    sources: claim.operator_explanation_refs.map((ref) => ({ type: "document", reference: ref, reliability: "medium" })),
    confidence: claim.confidence ?? 0.5,
    acquired_at: claim.created_at,
    acquisition_task_id: claim.scope.goal_id ?? "memory-truth",
    superseded_by: claim.superseded_by,
    tags: Array.isArray(object["tags"]) ? object["tags"].filter(isString) : [],
    embedding_id: null,
  });
}

function sharedKnowledgeEntryFromClaim(claim: MemoryClaim): SharedKnowledgeEntry | null {
  const parsed = SharedKnowledgeEntrySchema.safeParse(claim.metadata["shared_knowledge_entry"]);
  if (parsed.success) return parsed.data;
  const entry = knowledgeEntryFromClaim(claim);
  if (!entry) return null;
  return SharedKnowledgeEntrySchema.parse({
    ...entry,
    source_goal_ids: claim.scope.source_goal_ids ?? [],
    domain_stability: "moderate",
    revalidation_due_at: null,
  });
}

function domainKnowledgeClaimId(goalId: string, entryId: string): string {
  return `knowledge:domain:${goalId}:${entryId}`;
}

function sharedKnowledgeClaimId(entryId: string): string {
  return `knowledge:shared:${entryId}`;
}

function unqualifiedKnowledgeClaimId(claimId: string): string {
  return claimId.split(":").at(-1) ?? claimId;
}

function claimTypeForAgentMemory(memoryType: AgentMemoryType): MemoryClaimInput["claim_type"] {
  if (memoryType === "preference") return "preference";
  if (memoryType === "procedure") return "procedure";
  if (memoryType === "observation") return "observation";
  return "fact";
}

function agentMemoryTypeForClaimType(claimType: MemoryClaim["claim_type"]): AgentMemoryType {
  if (claimType === "preference") return "preference";
  if (claimType === "procedure") return "procedure";
  if (claimType === "observation") return "observation";
  return "fact";
}

function lifecycleForAgentMemory(entry: AgentMemoryEntry): MemoryClaimLifecycle {
  if (entry.status === "corrected" || entry.status === "superseded") return "corrected";
  if (entry.status === "retracted") return "retracted";
  if (entry.status === "forgotten") return "forgotten";
  if (entry.status === "archived" || entry.status === "quarantined") return "archived";
  return "active";
}

function invalidationStatusForEntry(entry: AgentMemoryEntry): "valid" | "corrected" | "forgotten" | "retracted" | "conflicted" | "archived" {
  const lifecycle = lifecycleForAgentMemory(entry);
  if (lifecycle === "active") return "valid";
  if (lifecycle === "conflicted") return "conflicted";
  if (lifecycle === "corrected") return "corrected";
  if (lifecycle === "forgotten") return "forgotten";
  if (lifecycle === "retracted") return "retracted";
  return "archived";
}

function agentMemoryStatusForLifecycle(lifecycle: MemoryClaim["lifecycle"], fallback: AgentMemoryEntry["status"]): AgentMemoryEntry["status"] {
  if (lifecycle === "corrected") return fallback === "superseded" ? "superseded" : "corrected";
  if (lifecycle === "forgotten") return "forgotten";
  if (lifecycle === "retracted") return "retracted";
  if (lifecycle === "archived") return fallback === "quarantined" ? "quarantined" : "archived";
  return fallback;
}

function trustStateForVerification(status?: MemoryVerificationStatus): MemoryClaimTrustState {
  if (status === "verified") return "verified";
  if (status === "contradicted") return "contradicted";
  if (status === "suspicious") return "suspicious";
  if (status === "unverified") return "unverified";
  return "unknown";
}

function MemoryProvenanceFromClaim(claim: MemoryClaim): MemoryProvenance {
  return {
    source_type: "unknown",
    raw_refs: claim.source_evidence_refs,
    reliability: claim.confidence ?? undefined,
    verification_status: claim.trust_state === "contradicted" ? "contradicted"
      : claim.trust_state === "suspicious" ? "suspicious"
        : claim.trust_state === "verified" ? "verified"
          : claim.trust_state === "unverified" ? "unverified"
            : "unknown",
    risk_signals: claim.trust_state === "suspicious" ? ["low_provenance"] : [],
  };
}

function reliabilityScore(value: "high" | "medium" | "low"): number {
  if (value === "high") return 0.9;
  if (value === "medium") return 0.6;
  return 0.3;
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isAgentMemoryEntry(value: AgentMemoryEntry | null): value is AgentMemoryEntry {
  return value !== null;
}

function isKnowledgeEntry(value: KnowledgeEntry | null): value is KnowledgeEntry {
  return value !== null;
}

function isSharedKnowledgeEntry(value: SharedKnowledgeEntry | null): value is SharedKnowledgeEntry {
  return value !== null;
}
