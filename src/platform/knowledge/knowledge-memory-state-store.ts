import { computeSoilChecksum } from "../soil/checksum.js";
import { SqliteSoilRepository } from "../soil/sqlite-repository.js";
import type {
  SoilChunk,
  SoilRecord,
  SoilRecordInput,
  SoilTombstone,
} from "../soil/contracts.js";
import {
  DomainKnowledgeSchema,
  KnowledgeEntrySchema,
  SharedKnowledgeEntrySchema,
  type DomainKnowledge,
  type KnowledgeEntry,
  type SharedKnowledgeEntry,
} from "../../base/types/knowledge.js";
import {
  AgentMemoryEntrySchema,
  AgentMemoryStoreSchema,
  type AgentMemoryEntry,
  type AgentMemoryStore,
} from "./types/agent-memory.js";
import {
  MemoryCorrectionEntrySchema,
  type MemoryCorrectionEntry,
} from "../corrections/memory-correction-ledger.js";
import {
  hasDomainKnowledgeTruth,
  hasSharedKnowledgeTruth,
  listDomainKnowledgeTruthGoalIds,
  loadAgentMemoryStoreFromTruth,
  loadDomainKnowledgeFromTruth,
  loadSharedKnowledgeFromTruth,
  saveAgentMemoryStoreToTruth,
  saveDomainKnowledgeToTruth,
  saveSharedKnowledgeToTruth,
} from "./memory-truth-adapter.js";

const SOURCE_DOMAIN_STATE = "knowledge_domain_state";
const SOURCE_DOMAIN_ENTRY = "knowledge_domain_entry";
const SOURCE_SHARED_ENTRY = "knowledge_shared_entry";
const SOURCE_AGENT_MEMORY_ENTRY = "knowledge_agent_memory_entry";
const SOURCE_AGENT_MEMORY_CORRECTION = "knowledge_agent_memory_correction";
const SOURCE_AGENT_MEMORY_STATE = "knowledge_agent_memory_state";

const STATE_SCHEMA_VERSION = "knowledge-memory-state-v1";

function nonEmptyText(value: string, fallback: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function tokenCount(text: string): number {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  return parts.length;
}

function isoOrNow(value: string | null | undefined): string {
  if (value && !Number.isNaN(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  return new Date().toISOString();
}

function isoOrNull(value: string | null | undefined): string | null {
  return value && !Number.isNaN(Date.parse(value)) ? new Date(value).toISOString() : null;
}

function reliabilityScore(source: KnowledgeEntry["sources"][number]): number {
  switch (source.reliability) {
    case "high": return 0.9;
    case "medium": return 0.6;
    case "low": return 0.3;
  }
}

function sourceReliability(sources: KnowledgeEntry["sources"]): number | null {
  if (sources.length === 0) return null;
  return sources.reduce((sum, source) => sum + reliabilityScore(source), 0) / sources.length;
}

function recordId(sourceType: string, sourceId: string): string {
  return `${sourceType}:${sourceId}`;
}

function recordKey(sourceType: string, sourceId: string): string {
  return `${sourceType}:${sourceId}`;
}

function domainSourceRef(goalId: string): string {
  return `soil-sqlite://knowledge/domain/${goalId}`;
}

function sharedSourceRef(): string {
  return "soil-sqlite://knowledge/shared";
}

function agentMemorySourceRef(): string {
  return "soil-sqlite://memory/agent";
}

function chunkForRecord(input: {
  recordId: string;
  soilId: string;
  text: string;
  createdAt: string;
}): SoilChunk {
  return {
    chunk_id: `${input.recordId}:chunk:0`,
    record_id: input.recordId,
    soil_id: input.soilId,
    chunk_index: 0,
    chunk_kind: "paragraph",
    heading_path_json: [],
    chunk_text: nonEmptyText(input.text, input.recordId),
    token_count: tokenCount(input.text),
    checksum: computeSoilChecksum(input.text),
    created_at: input.createdAt,
  };
}

function tombstoneForRecord(record: SoilRecord): SoilTombstone {
  return {
    record_id: record.record_id,
    record_key: record.record_key,
    version: record.version,
    reason: "knowledge memory state overwritten by typed Soil store",
    deleted_at: new Date().toISOString(),
  };
}

function metadataEntry<T>(record: SoilRecord, key: string, parse: (value: unknown) => T): T | null {
  const value = record.metadata_json[key];
  try {
    return parse(value);
  } catch {
    return null;
  }
}

function metadataSortOrder(record: SoilRecord): number {
  const value = record.metadata_json["sort_order"];
  return typeof value === "number" && Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

function soilStatusForAgentMemory(entry: AgentMemoryEntry): SoilRecord["status"] {
  if (entry.correction_state?.active === false) {
    switch (entry.correction_state.status) {
      case "corrected": return "corrected";
      case "superseded": return "superseded";
      case "retracted": return "retracted";
      case "forgotten": return "forgotten";
      case "quarantined": return "quarantined";
      case "conflicted": return "conflicted";
      case "active": return "active";
    }
  }
  switch (entry.status) {
    case "archived": return "archived";
    case "corrected": return "corrected";
    case "superseded": return "superseded";
    case "retracted": return "retracted";
    case "forgotten": return "forgotten";
    case "quarantined": return "quarantined";
    case "conflicted": return "conflicted";
    case "raw":
    case "compiled":
      return "active";
  }
}

function isActiveAgentMemoryEntry(entry: AgentMemoryEntry): boolean {
  return (entry.status === "raw" || entry.status === "compiled")
    && (entry.correction_state?.active ?? true);
}

function lifecycleStateForAgentMemory(entry: AgentMemoryEntry): "active" | "superseded" | "archived" | "tombstoned" {
  if (entry.correction_state?.active === false) {
    if (entry.correction_state.status === "corrected" || entry.correction_state.status === "superseded") return "superseded";
    if (entry.correction_state.status === "forgotten" || entry.correction_state.status === "retracted") return "tombstoned";
    return "archived";
  }
  if (entry.status === "corrected" || entry.status === "superseded") return "superseded";
  if (entry.status === "forgotten" || entry.status === "retracted") return "tombstoned";
  if (entry.status === "conflicted") return "archived";
  if (entry.status === "archived" || entry.status === "quarantined") return "archived";
  return "active";
}

function recordForDomainState(domainKnowledge: DomainKnowledge): SoilRecordInput {
  const sourceId = domainKnowledge.goal_id;
  const id = recordId(SOURCE_DOMAIN_STATE, sourceId);
  const updatedAt = isoOrNow(domainKnowledge.last_updated);
  const canonical = `Domain knowledge state for ${domainKnowledge.goal_id}: ${domainKnowledge.domain}`;
  return {
    record_id: id,
    record_key: recordKey(SOURCE_DOMAIN_STATE, sourceId),
    version: 1,
    record_type: "state",
    soil_id: `knowledge/domain/${domainKnowledge.goal_id}/state`,
    title: `Domain knowledge state: ${domainKnowledge.goal_id}`,
    summary: `${domainKnowledge.entries.length} entries for ${domainKnowledge.domain}`,
    canonical_text: canonical,
    goal_id: domainKnowledge.goal_id,
    task_id: null,
    status: "active",
    confidence: null,
    importance: null,
    source_reliability: null,
    valid_from: null,
    valid_to: null,
    supersedes_record_id: null,
    is_active: true,
    source_type: SOURCE_DOMAIN_STATE,
    source_id: sourceId,
    metadata_json: {
      schema_version: STATE_SCHEMA_VERSION,
      domain_state: {
        goal_id: domainKnowledge.goal_id,
        domain: domainKnowledge.domain,
        last_updated: domainKnowledge.last_updated,
      },
      source_ref: domainSourceRef(domainKnowledge.goal_id),
    },
    last_used_at: null,
    use_count: 0,
    validated_count: 0,
    negative_outcome_count: 0,
    created_at: updatedAt,
    updated_at: updatedAt,
  };
}

function recordForDomainEntry(goalId: string, entry: KnowledgeEntry, sortOrder: number): SoilRecordInput {
  const sourceId = `${goalId}:${entry.entry_id}`;
  const id = recordId(SOURCE_DOMAIN_ENTRY, sourceId);
  const acquiredAt = isoOrNow(entry.acquired_at);
  const active = entry.superseded_by === null;
  const canonical = active
    ? nonEmptyText(`${entry.question}\n\n${entry.answer}`, `Knowledge entry ${entry.entry_id}`)
    : `Knowledge entry ${entry.entry_id} is superseded and withheld from normal Soil retrieval.`;
  return {
    record_id: id,
    record_key: recordKey(SOURCE_DOMAIN_ENTRY, sourceId),
    version: 1,
    record_type: "fact",
    soil_id: `knowledge/domain/${goalId}/${entry.entry_id}`,
    title: nonEmptyText(entry.question, `Knowledge entry ${entry.entry_id}`),
    summary: active
      ? nonEmptyText(entry.answer, `Knowledge entry ${entry.entry_id}`)
      : `Superseded knowledge entry ${entry.entry_id}`,
    canonical_text: canonical,
    goal_id: goalId,
    task_id: entry.acquisition_task_id,
    status: entry.superseded_by ? "superseded" : "active",
    confidence: entry.confidence,
    importance: null,
    source_reliability: sourceReliability(entry.sources),
    valid_from: acquiredAt,
    valid_to: null,
    supersedes_record_id: null,
    is_active: active,
    source_type: SOURCE_DOMAIN_ENTRY,
    source_id: sourceId,
    metadata_json: {
      schema_version: STATE_SCHEMA_VERSION,
      entry,
      status: entry.superseded_by ? "superseded" : "active",
      lifecycle_state: entry.superseded_by ? "superseded" : "active",
      visible_to_normal_surface: active,
      sort_order: sortOrder,
      source_ref: `${domainSourceRef(goalId)}#${entry.entry_id}`,
    },
    last_used_at: null,
    use_count: 0,
    validated_count: 0,
    negative_outcome_count: 0,
    created_at: acquiredAt,
    updated_at: acquiredAt,
  };
}

function recordForSharedEntry(entry: SharedKnowledgeEntry, sortOrder: number): SoilRecordInput {
  const sourceId = entry.entry_id;
  const id = recordId(SOURCE_SHARED_ENTRY, sourceId);
  const acquiredAt = isoOrNow(entry.acquired_at);
  const active = entry.superseded_by === null;
  const canonical = active
    ? nonEmptyText(`${entry.question}\n\n${entry.answer}`, `Shared knowledge entry ${entry.entry_id}`)
    : `Shared knowledge entry ${entry.entry_id} is superseded and withheld from normal Soil retrieval.`;
  return {
    record_id: id,
    record_key: recordKey(SOURCE_SHARED_ENTRY, sourceId),
    version: 1,
    record_type: "fact",
    soil_id: `knowledge/shared/${entry.entry_id}`,
    title: nonEmptyText(entry.question, `Shared knowledge entry ${entry.entry_id}`),
    summary: active
      ? nonEmptyText(entry.answer, `Shared knowledge entry ${entry.entry_id}`)
      : `Superseded shared knowledge entry ${entry.entry_id}`,
    canonical_text: canonical,
    goal_id: null,
    task_id: entry.acquisition_task_id,
    status: entry.superseded_by ? "superseded" : "active",
    confidence: entry.confidence,
    importance: null,
    source_reliability: sourceReliability(entry.sources),
    valid_from: acquiredAt,
    valid_to: isoOrNull(entry.revalidation_due_at),
    supersedes_record_id: null,
    is_active: active,
    source_type: SOURCE_SHARED_ENTRY,
    source_id: sourceId,
    metadata_json: {
      schema_version: STATE_SCHEMA_VERSION,
      entry,
      status: entry.superseded_by ? "superseded" : "active",
      lifecycle_state: entry.superseded_by ? "superseded" : "active",
      visible_to_normal_surface: active,
      sort_order: sortOrder,
      source_ref: `${sharedSourceRef()}#${entry.entry_id}`,
    },
    last_used_at: null,
    use_count: 0,
    validated_count: 0,
    negative_outcome_count: 0,
    created_at: acquiredAt,
    updated_at: acquiredAt,
  };
}

function recordForAgentMemoryEntry(entry: AgentMemoryEntry, sortOrder: number): SoilRecordInput {
  const sourceId = entry.id;
  const id = recordId(SOURCE_AGENT_MEMORY_ENTRY, sourceId);
  const createdAt = isoOrNow(entry.created_at);
  const updatedAt = isoOrNow(entry.updated_at);
  const active = isActiveAgentMemoryEntry(entry);
  const status = soilStatusForAgentMemory(entry);
  const canonical = active
    ? nonEmptyText(`${entry.key}\n\n${entry.summary ?? ""}\n\n${entry.value}`, `Agent memory ${entry.id}`)
    : `Agent memory ${entry.id} is ${status} and withheld from normal Soil retrieval.`;
  return {
    record_id: id,
    record_key: recordKey(SOURCE_AGENT_MEMORY_ENTRY, sourceId),
    version: 1,
    record_type: entry.memory_type === "procedure"
      ? "workflow"
      : entry.memory_type === "preference"
        ? "preference"
        : entry.memory_type,
    soil_id: `memory/agent/${entry.id}`,
    title: nonEmptyText(entry.key, `Agent memory ${entry.id}`),
    summary: active
      ? entry.summary ?? entry.value
      : `Agent memory ${status}; retained for operator audit.`,
    canonical_text: canonical,
    goal_id: null,
    task_id: null,
    status,
    confidence: null,
    importance: null,
    source_reliability: null,
    valid_from: createdAt,
    valid_to: null,
    supersedes_record_id: null,
    is_active: active,
    source_type: SOURCE_AGENT_MEMORY_ENTRY,
    source_id: sourceId,
    metadata_json: {
      schema_version: STATE_SCHEMA_VERSION,
      entry,
      status,
      lifecycle_state: lifecycleStateForAgentMemory(entry),
      visible_to_normal_surface: active,
      sort_order: sortOrder,
      source_ref: `${agentMemorySourceRef()}#${entry.id}`,
    },
    last_used_at: null,
    use_count: 0,
    validated_count: 0,
    negative_outcome_count: 0,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

function recordForAgentMemoryCorrection(correction: MemoryCorrectionEntry, sortOrder: number): SoilRecordInput {
  const sourceId = correction.correction_id;
  const id = recordId(SOURCE_AGENT_MEMORY_CORRECTION, sourceId);
  const createdAt = isoOrNow(correction.created_at);
  const canonical = `Agent memory correction ${correction.correction_id} is retained for operator audit.`;
  return {
    record_id: id,
    record_key: recordKey(SOURCE_AGENT_MEMORY_CORRECTION, sourceId),
    version: 1,
    record_type: "state",
    soil_id: `memory/agent/corrections/${correction.correction_id}`,
    title: `Agent memory correction: ${correction.correction_id}`,
    summary: `Agent memory correction ${correction.correction_kind}; operator audit only.`,
    canonical_text: canonical,
    goal_id: null,
    task_id: null,
    status: correction.correction_kind,
    confidence: correction.provenance.confidence ?? null,
    importance: null,
    source_reliability: correction.provenance.confidence ?? null,
    valid_from: createdAt,
    valid_to: null,
    supersedes_record_id: null,
    is_active: false,
    source_type: SOURCE_AGENT_MEMORY_CORRECTION,
    source_id: sourceId,
    metadata_json: {
      schema_version: STATE_SCHEMA_VERSION,
      correction,
      status: correction.correction_kind,
      lifecycle_state: correction.correction_kind === "forgotten" || correction.correction_kind === "retracted"
        ? "tombstoned"
        : correction.correction_kind === "corrected" || correction.correction_kind === "superseded"
          ? "superseded"
          : "archived",
      visible_to_normal_surface: false,
      sort_order: sortOrder,
      source_ref: `${agentMemorySourceRef()}#correction:${correction.correction_id}`,
    },
    last_used_at: null,
    use_count: 0,
    validated_count: 0,
    negative_outcome_count: 0,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

function recordForAgentMemoryState(store: AgentMemoryStore): SoilRecordInput {
  const timestamp = isoOrNow(store.last_consolidated_at
    ?? store.entries.map((entry) => entry.updated_at).sort().at(-1)
    ?? null);
  const id = recordId(SOURCE_AGENT_MEMORY_STATE, "current");
  const canonical = `Agent memory state: ${store.entries.length} entries, ${store.corrections.length} corrections`;
  return {
    record_id: id,
    record_key: recordKey(SOURCE_AGENT_MEMORY_STATE, "current"),
    version: 1,
    record_type: "state",
    soil_id: "memory/agent/state",
    title: "Agent memory state",
    summary: canonical,
    canonical_text: canonical,
    goal_id: null,
    task_id: null,
    status: "active",
    confidence: null,
    importance: null,
    source_reliability: null,
    valid_from: null,
    valid_to: null,
    supersedes_record_id: null,
    is_active: true,
    source_type: SOURCE_AGENT_MEMORY_STATE,
    source_id: "current",
    metadata_json: {
      schema_version: STATE_SCHEMA_VERSION,
      state: {
        last_consolidated_at: store.last_consolidated_at,
      },
      source_ref: `${agentMemorySourceRef()}#state`,
    },
    last_used_at: null,
    use_count: 0,
    validated_count: 0,
    negative_outcome_count: 0,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

export class KnowledgeMemoryStateStore {
  constructor(private readonly baseDir: string) {}

  async ensureReady(): Promise<void> {
    const repo = await this.openRepository();
    repo.close();
  }

  async loadDomainKnowledge(goalId: string): Promise<DomainKnowledge> {
    const truth = await loadDomainKnowledgeFromTruth(this.baseDir, goalId);
    if (truth.entries.length > 0) return truth;
    if (await hasDomainKnowledgeTruth(this.baseDir, goalId)) return truth;
    const repo = await this.openRepository();
    try {
      const stateRecords = await repo.loadRecords({
        source_types: [SOURCE_DOMAIN_STATE],
        source_ids: [goalId],
      });
      const state = stateRecords
        .map((record) => metadataEntry(record, "domain_state", (value) => DomainKnowledgeSchema.pick({
          goal_id: true,
          domain: true,
          last_updated: true,
        }).parse({ ...(typeof value === "object" && value !== null ? value : {}), entries: [] })))
        .find((value): value is Pick<DomainKnowledge, "goal_id" | "domain" | "last_updated"> => value !== null);
      const entries = (await repo.loadRecords({
        source_types: [SOURCE_DOMAIN_ENTRY],
        goal_ids: [goalId],
      }))
        .map((record) => ({ record, entry: metadataEntry(record, "entry", (value) => KnowledgeEntrySchema.parse(value)) }))
        .filter((item): item is { record: SoilRecord; entry: KnowledgeEntry } => item.entry !== null)
        .sort((left, right) => metadataSortOrder(left.record) - metadataSortOrder(right.record))
        .map((item) => item.entry);
      return DomainKnowledgeSchema.parse({
        goal_id: goalId,
        domain: state?.domain ?? goalId,
        entries,
        last_updated: state?.last_updated ?? new Date().toISOString(),
      });
    } finally {
      repo.close();
    }
  }

  async listDomainKnowledgeGoalIds(): Promise<string[]> {
    const repo = await this.openRepository();
    try {
      const soilGoalIds = (await repo.loadRecords({ source_types: [SOURCE_DOMAIN_STATE] }))
        .map((record) => record.source_id)
      const truthGoalIds = await listDomainKnowledgeTruthGoalIds(this.baseDir);
      return [...new Set([...soilGoalIds, ...truthGoalIds])].sort((left, right) => left.localeCompare(right));
    } finally {
      repo.close();
    }
  }

  async saveDomainKnowledge(domainKnowledge: DomainKnowledge): Promise<void> {
    const parsed = DomainKnowledgeSchema.parse(domainKnowledge);
    const repo = await this.openRepository();
    try {
      const existing = await repo.loadRecords({
        source_types: [SOURCE_DOMAIN_ENTRY, SOURCE_DOMAIN_STATE],
        goal_ids: [parsed.goal_id],
      });
      const nextSourceIds = new Set<string>([
        parsed.goal_id,
        ...parsed.entries.map((entry) => `${parsed.goal_id}:${entry.entry_id}`),
      ]);
      const records = [
        recordForDomainState(parsed),
        ...parsed.entries.map((entry, index) => recordForDomainEntry(parsed.goal_id, entry, index)),
      ];
      const chunks = records.map((record) => chunkForRecord({
        recordId: record.record_id,
        soilId: record.soil_id,
        text: record.canonical_text,
        createdAt: record.created_at,
      }));
      await repo.applyMutation({
        records,
        chunks,
        tombstones: existing
          .filter((record) => !nextSourceIds.has(record.source_id))
          .map(tombstoneForRecord),
      });
      await saveDomainKnowledgeToTruth(this.baseDir, parsed);
    } finally {
      repo.close();
    }
  }

  async deleteDomainKnowledge(goalId: string): Promise<void> {
    const repo = await this.openRepository();
    try {
      const existing = await repo.loadRecords({
        source_types: [SOURCE_DOMAIN_ENTRY, SOURCE_DOMAIN_STATE],
        goal_ids: [goalId],
      });
      await saveDomainKnowledgeToTruth(this.baseDir, DomainKnowledgeSchema.parse({
        goal_id: goalId,
        domain: goalId,
        entries: [],
        last_updated: new Date().toISOString(),
      }));
      await repo.applyMutation({ tombstones: existing.map(tombstoneForRecord) });
    } finally {
      repo.close();
    }
  }

  async loadSharedKnowledgeEntries(): Promise<SharedKnowledgeEntry[]> {
    const truth = await loadSharedKnowledgeFromTruth(this.baseDir);
    if (truth.length > 0) return truth;
    if (await hasSharedKnowledgeTruth(this.baseDir)) return truth;
    const repo = await this.openRepository();
    try {
      const entries = (await repo.loadRecords({ source_types: [SOURCE_SHARED_ENTRY] }))
        .map((record) => ({ record, entry: metadataEntry(record, "entry", (value) => SharedKnowledgeEntrySchema.parse(value)) }))
        .filter((item): item is { record: SoilRecord; entry: SharedKnowledgeEntry } => item.entry !== null)
        .sort((left, right) => metadataSortOrder(left.record) - metadataSortOrder(right.record))
        .map((item) => item.entry);
      return entries;
    } finally {
      repo.close();
    }
  }

  async saveSharedKnowledgeEntries(entries: SharedKnowledgeEntry[]): Promise<void> {
    const parsed = entries.map((entry) => SharedKnowledgeEntrySchema.parse(entry));
    const repo = await this.openRepository();
    try {
      const existing = await repo.loadRecords({ source_types: [SOURCE_SHARED_ENTRY] });
      const nextSourceIds = new Set(parsed.map((entry) => entry.entry_id));
      const records = parsed.map((entry, index) => recordForSharedEntry(entry, index));
      await repo.applyMutation({
        records,
        chunks: records.map((record) => chunkForRecord({
          recordId: record.record_id,
          soilId: record.soil_id,
          text: record.canonical_text,
          createdAt: record.created_at,
        })),
        tombstones: existing
          .filter((record) => !nextSourceIds.has(record.source_id))
          .map(tombstoneForRecord),
      });
      await saveSharedKnowledgeToTruth(this.baseDir, parsed);
    } finally {
      repo.close();
    }
  }

  async loadAgentMemoryStore(): Promise<AgentMemoryStore> {
    const truth = AgentMemoryStoreSchema.parse(await loadAgentMemoryStoreFromTruth(this.baseDir));
    if (truth.entries.length > 0 || truth.corrections.length > 0) return truth;
    const repo = await this.openRepository();
    try {
      const entryRecords = await repo.loadRecords({
        source_types: [SOURCE_AGENT_MEMORY_ENTRY],
        active_only: false,
      });
      const correctionRecords = await repo.loadRecords({
        source_types: [SOURCE_AGENT_MEMORY_CORRECTION],
        active_only: false,
      });
      const stateRecord = (await repo.loadRecords({
        source_types: [SOURCE_AGENT_MEMORY_STATE],
        source_ids: ["current"],
      })).at(0);
      const entries = entryRecords
        .map((record) => ({ record, entry: metadataEntry(record, "entry", (value) => AgentMemoryEntrySchema.parse(value)) }))
        .filter((item): item is { record: SoilRecord; entry: AgentMemoryEntry } => item.entry !== null)
        .sort((left, right) => metadataSortOrder(left.record) - metadataSortOrder(right.record))
        .map((item) => item.entry);
      const corrections = correctionRecords
        .map((record) => ({ record, correction: metadataEntry(record, "correction", (value) => MemoryCorrectionEntrySchema.parse(value)) }))
        .filter((item): item is { record: SoilRecord; correction: MemoryCorrectionEntry } => item.correction !== null)
        .sort((left, right) => metadataSortOrder(left.record) - metadataSortOrder(right.record))
        .map((item) => item.correction);
      const state = stateRecord?.metadata_json["state"];
      const lastConsolidatedAt = state && typeof state === "object" && !Array.isArray(state)
        && typeof (state as Record<string, unknown>)["last_consolidated_at"] === "string"
        ? (state as Record<string, string>)["last_consolidated_at"]
        : null;
      return AgentMemoryStoreSchema.parse({
        entries,
        corrections,
        last_consolidated_at: lastConsolidatedAt,
      });
    } finally {
      repo.close();
    }
  }

  async saveAgentMemoryStore(
    store: AgentMemoryStore,
    options: { persistTruth?: boolean } = {},
  ): Promise<void> {
    const parsed = AgentMemoryStoreSchema.parse(store);
    const repo = await this.openRepository();
    try {
      const existing = await repo.loadRecords({
        source_types: [SOURCE_AGENT_MEMORY_ENTRY, SOURCE_AGENT_MEMORY_CORRECTION, SOURCE_AGENT_MEMORY_STATE],
      });
      const nextSourceIds = new Set<string>([
        "current",
        ...parsed.entries.map((entry) => entry.id),
        ...parsed.corrections.map((correction) => correction.correction_id),
      ]);
      const records = [
        recordForAgentMemoryState(parsed),
        ...parsed.entries.map((entry, index) => recordForAgentMemoryEntry(entry, index)),
        ...parsed.corrections.map((correction, index) => recordForAgentMemoryCorrection(correction, index)),
      ];
      await repo.applyMutation({
        records,
        chunks: records.map((record) => chunkForRecord({
          recordId: record.record_id,
          soilId: record.soil_id,
          text: record.canonical_text,
          createdAt: record.created_at,
        })),
        tombstones: existing
          .filter((record) => !nextSourceIds.has(record.source_id))
          .map(tombstoneForRecord),
      });
      if (options.persistTruth !== false) {
        await saveAgentMemoryStoreToTruth(this.baseDir, parsed);
      }
    } finally {
      repo.close();
    }
  }

  private async openRepository(): Promise<SqliteSoilRepository> {
    return SqliteSoilRepository.create({ rootDir: `${this.baseDir}/soil` });
  }
}
