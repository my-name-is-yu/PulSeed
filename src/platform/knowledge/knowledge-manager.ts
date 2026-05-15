import type { StateManager } from "../../base/state/state-manager.js";
import type { ILLMClient } from "../../base/llm/llm-client.js";
import type { IPromptGateway } from "../../prompt/gateway.js";
import type { Task } from "../../base/types/task.js";
import { z } from "zod/v3";
import { KnowledgeEntrySchema } from "../../base/types/knowledge.js";
import type {
  KnowledgeEntry,
  DomainKnowledge,
  KnowledgeGapSignal,
  ContradictionResult,
  SharedKnowledgeEntry,
  DomainStability,
  DecisionRecord,
} from "../../base/types/knowledge.js";
import type { VectorIndex } from "./vector-index.js";
import type { IEmbeddingClient } from "./embedding-client.js";
import {
  searchKnowledge,
  searchAcrossGoals,
  searchByEmbedding,
  querySharedKnowledge,
  loadDomainKnowledge,
} from "./knowledge-search.js";
import {
  classifyDomainStability,
  getStaleEntries,
  generateRevalidationTasks,
} from "./knowledge-revalidation.js";
import {
  recordDecision,
  enrichDecisionRecord,
  queryDecisions,
  updateDecisionOutcome,
  purgeOldDecisions,
} from "./knowledge-decisions.js";
import {
  detectKnowledgeGap as _detectKnowledgeGap,
  generateAcquisitionTask as _generateAcquisitionTask,
  checkContradiction as _checkContradiction,
} from "./knowledge-manager-query.js";
import type { ToolExecutor } from "../../tools/executor.js";
import type { ToolCallContext } from "../../tools/types.js";
import type { PersonalAgentRuntimeStore } from "../../runtime/personal-agent/index.js";
import type { AgentMemoryEntry, AgentMemoryStore, AgentMemoryType } from "./types/agent-memory.js";
import {
  loadAgentMemoryStore,
  projectAgentMemory,
  projectDomainKnowledge,
  projectSharedKnowledge,
  saveAgentMemoryStore,
} from "./knowledge-manager-internals.js";
import {
  archiveAgentMemoryEntries,
  applyAgentMemoryCorrection,
  autoConsolidateAgentMemory,
  consolidateAgentMemoryEntries,
  deleteAgentMemoryEntry,
  exportAgentMemoryGovernance,
  getAgentMemoryStatsForHost,
  listAgentMemoryCorrectionHistory,
  listAgentMemoryEntries,
  quarantineAgentMemoryEntries,
  recallAgentMemoryEntries,
  saveAgentMemoryEntry,
  type AgentMemoryPhysicalDeleteManifest,
  type AgentMemoryRecallMode,
} from "./knowledge-manager-agent-memory.js";
import type { MemoryQuarantineState } from "../corrections/memory-quarantine.js";
import type { MemoryProvenance, MemoryVerificationStatus } from "../corrections/memory-quarantine.js";
import type { MemoryGovernanceInput, MemorySensitivity } from "../corrections/memory-governance.js";
import {
  formatRelationshipProfileRetrievalContext,
  type RelationshipProfileRetrievalContext,
} from "../profile/retrieval-context.js";
import type {
  MemoryCorrectionEntry,
  MemoryCorrectionKind,
  MemoryCorrectionTargetRef,
} from "../corrections/memory-correction-ledger.js";
import {
  saveDomainKnowledgeEntry,
  saveSharedKnowledgeEntry,
} from "./knowledge-manager-store.js";

export * from "./public-api.js";

const ToolAcquisitionPlanCallSchema = z.object({
  toolName: z.string(),
  input: z.unknown().optional(),
});

const ToolAcquisitionSynthesisSchema = z.object({
  answer: z.string(),
  confidence: z.number().finite().nonnegative(),
  tags: z.array(z.string()).nullish().transform((tags) => tags ?? []),
});

function parseJsonUnknown(content: string): unknown | null {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return null;
  }
}

function parseToolAcquisitionPlan(content: string, maxToolCalls: number): Array<{ toolName: string; input: unknown }> {
  const raw = parseJsonUnknown(content);
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, maxToolCalls)
    .map((call) => ToolAcquisitionPlanCallSchema.safeParse(call))
    .filter((parsed): parsed is { success: true; data: z.infer<typeof ToolAcquisitionPlanCallSchema> } => parsed.success)
    .map((parsed) => ({ toolName: parsed.data.toolName, input: parsed.data.input }));
}

function parseToolAcquisitionSynthesis(content: string): z.infer<typeof ToolAcquisitionSynthesisSchema> | null {
  const raw = parseJsonUnknown(content);
  const parsed = ToolAcquisitionSynthesisSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

// ─── KnowledgeManager ───

/**
 * KnowledgeManager detects knowledge gaps, generates research tasks,
 * and persists/retrieves domain knowledge entries.
 *
 * Durable state layout:
 *   Soil SQLite records own domain knowledge, shared knowledge, and agent memory.
 *   Legacy JSON knowledge/memory files are explicit doctor/migration inputs only;
 *   normal runtime callers use KnowledgeMemoryStateStore directly.
 */
export class KnowledgeManager {
  private readonly stateManager: StateManager;
  private readonly llmClient: ILLMClient;
  private readonly vectorIndex?: VectorIndex;
  private readonly embeddingClient?: IEmbeddingClient;
  private readonly gateway?: IPromptGateway;
  private readonly toolExecutor?: ToolExecutor;
  private readonly personalAgentRuntime?: Pick<PersonalAgentRuntimeStore, "recordTrace">;

  constructor(
    stateManager: StateManager,
    llmClient: ILLMClient,
    vectorIndex?: VectorIndex,
    embeddingClient?: IEmbeddingClient,
    gateway?: IPromptGateway,
    toolExecutor?: ToolExecutor,
    personalAgentRuntime?: Pick<PersonalAgentRuntimeStore, "recordTrace">,
  ) {
    this.stateManager = stateManager;
    this.llmClient = llmClient;
    this.vectorIndex = vectorIndex;
    this.embeddingClient = embeddingClient;
    this.gateway = gateway;
    this.toolExecutor = toolExecutor;
    this.personalAgentRuntime = personalAgentRuntime;
  }

  // ─── detectKnowledgeGap ───

  async detectKnowledgeGap(context: {
    observations: unknown[];
    strategies: unknown[] | null | undefined;
    confidence: number;
  }): Promise<KnowledgeGapSignal | null> {
    return _detectKnowledgeGap(
      {
        llmClient: this.llmClient,
        gateway: this.gateway,
        stateManager: this.stateManager,
        toolExecutor: this.toolExecutor,
        personalAgentRuntime: this.personalAgentRuntime,
      },
      context
    );
  }

  // ─── generateAcquisitionTask ───

  async generateAcquisitionTask(
    signal: KnowledgeGapSignal,
    goalId: string
  ): Promise<Task> {
    return _generateAcquisitionTask(
      {
        llmClient: this.llmClient,
        gateway: this.gateway,
        stateManager: this.stateManager,
        toolExecutor: this.toolExecutor,
        personalAgentRuntime: this.personalAgentRuntime,
      },
      signal,
      goalId
    );
  }

  // ─── saveKnowledge ───

  async saveKnowledge(goalId: string, entry: KnowledgeEntry): Promise<void> {
    await saveDomainKnowledgeEntry(this.knowledgeStoreHost(), goalId, entry);
  }

  // ─── loadKnowledge ───

  /**
   * Load knowledge entries for a goal, optionally filtered by tags (exact match).
   *
   * An entry matches if ALL provided tags appear in the entry's tags array.
   */
  async loadKnowledge(
    goalId: string,
    tags?: string[]
  ): Promise<KnowledgeEntry[]> {
    const domainKnowledge = await this._loadDomainKnowledge(goalId);
    const entries = domainKnowledge.entries;

    if (!tags || tags.length === 0) {
      return entries;
    }

    return entries.filter((entry) =>
      tags.every((tag) => entry.tags.includes(tag))
    );
  }

  // ─── checkContradiction ───

  async checkContradiction(
    goalId: string,
    newEntry: KnowledgeEntry
  ): Promise<ContradictionResult> {
    return _checkContradiction(
      { llmClient: this.llmClient, gateway: this.gateway, stateManager: this.stateManager },
      goalId,
      newEntry
    );
  }

  // ─── getRelevantKnowledge ───

  /**
   * Returns knowledge entries whose tags include the given dimension name.
   */
  async getRelevantKnowledge(
    goalId: string,
    dimensionName: string,
    options: { relationshipProfileContext?: RelationshipProfileRetrievalContext } = {}
  ): Promise<KnowledgeEntry[]> {
    const entries = await this.loadKnowledge(goalId, [dimensionName]);
    const profileEntries = this.relationshipProfileContextToKnowledgeEntries(
      goalId,
      options.relationshipProfileContext
    );
    return [...profileEntries, ...entries];
  }

  // ─── searchKnowledge (Phase 2) ───

  /**
   * Semantic search within a single goal's knowledge entries via VectorIndex.
   * Falls back to an empty array when no VectorIndex is configured.
   */
  async searchKnowledge(
    query: string,
    topK: number = 5,
    options: {
      relationshipProfileContext?: RelationshipProfileRetrievalContext;
      relationshipProfilePromptContext?: string;
    } = {}
  ): Promise<KnowledgeEntry[]> {
    const profileEntries = this.relationshipProfileContextToKnowledgeEntries(
      null,
      options.relationshipProfileContext
    );
    let profileQuery = "";
    if (typeof options.relationshipProfilePromptContext === "string") {
      profileQuery = options.relationshipProfilePromptContext;
    } else if (options.relationshipProfileContext) {
      profileQuery = formatRelationshipProfileRetrievalContext(options.relationshipProfileContext);
    }
    return searchKnowledge(
      { stateManager: this.stateManager, vectorIndex: this.vectorIndex },
      [query, profileQuery].filter((part) => part.trim().length > 0).join("\n"),
      topK
    ).then((entries) => [...profileEntries, ...entries]);
  }

  private relationshipProfileContextToKnowledgeEntries(
    goalId: string | null,
    context?: RelationshipProfileRetrievalContext
  ): KnowledgeEntry[] {
    if (!context || context.items.length === 0) return [];
    const acquiredAt = new Date(0).toISOString();
    return context.items.map((item) => ({
      entry_id: `relationship-profile:${item.id}`,
      question: `Relationship profile context: ${item.stable_key}`,
      answer: item.value,
      sources: [{
        type: "document",
        reference: item.provenance.evidence_ref ?? item.id,
        reliability: item.confidence >= 0.8 ? "high" : item.confidence >= 0.5 ? "medium" : "low",
      }],
      confidence: item.confidence,
      acquired_at: acquiredAt,
      acquisition_task_id: "relationship-profile",
      superseded_by: null,
      embedding_id: null,
      tags: [item.kind, context.scope, ...(goalId ? [goalId] : [])],
    }));
  }

  // ─── searchAcrossGoals (Phase 2) ───

  /**
   * Cross-goal semantic search. Leverages the VectorIndex which is global
   * across all goals. Returns entries from any goal ordered by similarity.
   * Falls back to an empty array when no VectorIndex is configured.
   */
  async searchAcrossGoals(
    query: string,
    topK: number = 5
  ): Promise<KnowledgeEntry[]> {
    return searchAcrossGoals(
      { stateManager: this.stateManager, vectorIndex: this.vectorIndex },
      query,
      topK
    );
  }

  // ─── 5.1a: Shared Knowledge Base ───

  /**
   * Save a KnowledgeEntry into the shared knowledge base, associating it with
   * the given goalId. If VectorIndex is available the entry is also embedded
   * and the embedding_id is stored on the returned SharedKnowledgeEntry.
   */
  async saveToSharedKnowledgeBase(
    entry: KnowledgeEntry,
    goalId: string
  ): Promise<SharedKnowledgeEntry> {
    return saveSharedKnowledgeEntry(this.knowledgeStoreHost(), entry, goalId);
  }

  /**
   * Query the shared knowledge base by tags (AND logic).
   * Optionally filter to entries contributed by a specific goal.
   */
  async querySharedKnowledge(
    tags: string[],
    goalId?: string
  ): Promise<SharedKnowledgeEntry[]> {
    return querySharedKnowledge(this.stateManager, tags, goalId);
  }

  // ─── 5.1b: Vector Search for Knowledge Sharing ───

  /**
   * Semantic search across the shared knowledge base using VectorIndex.
   * Falls back to an empty array when no VectorIndex is configured.
   */
  async searchByEmbedding(
    query: string,
    topK: number = 5
  ): Promise<{ entry: SharedKnowledgeEntry; similarity: number }[]> {
    return searchByEmbedding(
      { stateManager: this.stateManager, vectorIndex: this.vectorIndex },
      query,
      topK
    );
  }

  // ─── 5.1c: Domain Stability Auto-Revalidation ───

  /**
   * Classify the domain stability of a set of knowledge entries via LLM.
   * Returns "stable", "moderate", or "volatile".
   */
  async classifyDomainStability(
    domain: string,
    entries: KnowledgeEntry[]
  ): Promise<DomainStability> {
    return classifyDomainStability(
      { stateManager: this.stateManager, llmClient: this.llmClient },
      domain,
      entries
    );
  }

  /**
   * Return shared knowledge entries whose revalidation_due_at is in the past.
   */
  async getStaleEntries(): Promise<SharedKnowledgeEntry[]> {
    return getStaleEntries(this.stateManager);
  }

  /**
   * Generate KnowledgeAcquisitionTask-style Task objects for each stale entry,
   * re-asking the original question.
   */
  async generateRevalidationTasks(staleEntries: SharedKnowledgeEntry[]): Promise<Task[]> {
    return generateRevalidationTasks(staleEntries);
  }

  // ─── Decision History (M14-S3) ───

  /**
   * Save a DecisionRecord to ~/.pulseed/decisions/<goalId>-<timestamp>.json
   * For completed records (outcome !== "pending"), enriches with LLM-extracted
   * what_worked/what_failed/suggested_next before saving.
   */
  async recordDecision(record: DecisionRecord): Promise<void> {
    return recordDecision(
      { stateManager: this.stateManager, llmClient: this.llmClient },
      record
    );
  }

  /**
   * Enrich a completed DecisionRecord by extracting what_worked/what_failed/suggested_next via LLM.
   * Falls back to default empty arrays on LLM failure.
   */
  async enrichDecisionRecord(record: DecisionRecord): Promise<DecisionRecord> {
    return enrichDecisionRecord(
      { stateManager: this.stateManager, llmClient: this.llmClient },
      record
    );
  }

  /**
   * Load decision records filtered by goal_type, sorted by recency.
   * Applies time-decay scoring (1.0 at day 0, 0.0 at day 30+).
   */
  async queryDecisions(goalType: string, limit: number = 20): Promise<DecisionRecord[]> {
    return queryDecisions(
      { stateManager: this.stateManager, llmClient: this.llmClient },
      goalType,
      limit
    );
  }

  /**
   * Update the outcome of a DecisionRecord identified by strategy_id.
   * Finds the most recent pending record for the given strategy and rewrites it.
   * No-op when no matching pending record is found.
   */
  async updateDecisionOutcome(
    strategyId: string,
    outcome: "success" | "failure"
  ): Promise<void> {
    return updateDecisionOutcome(
      { stateManager: this.stateManager, llmClient: this.llmClient },
      strategyId,
      outcome
    );
  }

  /**
   * Remove decision records older than 90 days.
   * Returns the count of purged records.
   */
  async purgeOldDecisions(): Promise<number> {
    return purgeOldDecisions({
      stateManager: this.stateManager,
      llmClient: this.llmClient,
    });
  }

  // ─── Agent Memory ───

  /**
   * Upsert an agent memory entry by key.
   * If a matching key exists, update value/tags/category/memory_type/updated_at.
   * If not, create a new entry with a UUID id and timestamps.
   */
  async saveAgentMemory(entry: {
    key: string;
    value: string;
    tags?: string[];
    category?: string;
    memory_type?: AgentMemoryType;
    verification_status?: MemoryVerificationStatus;
    provenance?: MemoryProvenance;
    governance?: MemoryGovernanceInput;
  }): Promise<AgentMemoryEntry> {
    return saveAgentMemoryEntry(this.agentMemoryHost(), entry);
  }

  /**
   * Search agent memory entries by explicit recall mode.
   * mode="exact": filter where entry.key === query.
   * mode="lexical": case-insensitive substring match on key + value + tags.
   * mode="semantic": embedding-based similarity; no lexical fallback.
   * Optionally filter by category and/or memory_type.
   * Excludes archived entries unless include_archived=true.
   * Tiered sort: compiled entries first, then raw, both by updated_at desc.
   */
  async recallAgentMemory(
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
    return recallAgentMemoryEntries(this.agentMemoryHost(), query, opts);
  }

  /**
   * List all agent memory entries, optionally filtered by category and/or memory_type.
   * Sorted by updated_at desc.
   */
  async listAgentMemory(opts?: {
    category?: string;
    memory_type?: AgentMemoryType;
    limit?: number;
    include_archived?: boolean;
    consent_scope?: string;
    max_sensitivity?: MemorySensitivity;
  }): Promise<AgentMemoryEntry[]> {
    return listAgentMemoryEntries(this.agentMemoryHost(), opts);
  }

  /**
   * Physically delete an agent memory entry by key.
   * This is repair-only and requires an explicit manifest; user-facing memory
   * operations must use correct/forget/retract so audit history is retained.
   * Returns true if the entry was found and removed, false otherwise.
   */
  async deleteAgentMemory(key: string, manifest?: AgentMemoryPhysicalDeleteManifest): Promise<boolean> {
    return deleteAgentMemoryEntry(this.agentMemoryHost(), key, manifest);
  }

  async correctAgentMemory(input: {
    targetId: string;
    correctionKind: Extract<MemoryCorrectionKind, "corrected" | "forgotten" | "retracted">;
    reason: string;
    replacementValue?: string;
    replacementKey?: string;
    replacementTags?: string[];
    replacementStatus?: "raw" | "compiled";
    actor?: "user" | "dream_lint" | "runtime_verification" | "manual_tool";
    provenanceRef?: string;
  }): Promise<Awaited<ReturnType<typeof applyAgentMemoryCorrection>>> {
    return applyAgentMemoryCorrection(this.agentMemoryHost(), input);
  }

  async listAgentMemoryCorrectionHistory(target?: MemoryCorrectionTargetRef): Promise<MemoryCorrectionEntry[]> {
    return listAgentMemoryCorrectionHistory(this.agentMemoryHost(), target);
  }

  async exportAgentMemoryGovernance(opts?: {
    consent_scope?: string;
    include_secret?: boolean;
  }): Promise<Awaited<ReturnType<typeof exportAgentMemoryGovernance>>> {
    return exportAgentMemoryGovernance(this.agentMemoryHost(), opts);
  }

  async quarantineAgentMemory(input: {
    targetIds: string[];
    reason: string;
    source?: MemoryQuarantineState["source"];
    confidence: number;
    inspectionRefs: string[];
    createdAt?: string;
  }): Promise<number> {
    return quarantineAgentMemoryEntries(this.agentMemoryHost(), input);
  }

  // ─── consolidateAgentMemory ───

  /**
   * Consolidate raw agent memory entries into compiled entries via LLM.
   * Groups entries by category+memory_type; groups with 2+ entries are consolidated.
   * Source entries are archived after consolidation.
   */
  async consolidateAgentMemory(opts: {
    category?: string;
    memory_type?: AgentMemoryType;
    max_entries?: number;
    llmCall: (prompt: string) => Promise<string>;
  }): Promise<{ compiled: AgentMemoryEntry[]; archived: number }> {
    return consolidateAgentMemoryEntries(this.agentMemoryHost(), opts);
  }

  // ─── archiveAgentMemory ───

  /**
   * Archive agent memory entries by IDs.
   * Returns the count of entries actually archived (skips already-archived).
   */
  async archiveAgentMemory(ids: string[]): Promise<number> {
    return archiveAgentMemoryEntries(this.agentMemoryHost(), ids);
  }

  // ─── getAgentMemoryStats ───

  /**
   * Return counts of agent memory entries grouped by status.
   */
  async getAgentMemoryStats(): Promise<{
    raw: number;
    compiled: number;
    archived: number;
    total: number;
  }> {
    return getAgentMemoryStatsForHost(this.agentMemoryHost());
  }

  // ─── autoConsolidate ───

  /**
   * Automatically consolidate agent memory if raw entry count exceeds threshold.
   * Non-fatal: errors are caught and logged; the loop continues regardless.
   */
  async autoConsolidate(opts?: { rawThreshold?: number }): Promise<{ consolidated: boolean; compiled?: number; archived?: number }> {
    return autoConsolidateAgentMemory(this.agentMemoryHost(), opts);
  }

    // ─── Private Helpers ───

  private async _loadAgentMemoryStore(): Promise<AgentMemoryStore> {
    return loadAgentMemoryStore(this.stateManager);
  }

  private async _loadDomainKnowledge(goalId: string): Promise<DomainKnowledge> {
    return loadDomainKnowledge(this.stateManager, goalId);
  }

  private async _projectDomainKnowledgeToSoil(goalId: string, domainKnowledge: DomainKnowledge): Promise<void> {
    await projectDomainKnowledge(this.stateManager, goalId, domainKnowledge);
  }

  private async _projectSharedKnowledgeToSoil(entries: SharedKnowledgeEntry[]): Promise<void> {
    await projectSharedKnowledge(this.stateManager, entries);
  }

  private async _projectAgentMemoryToSoil(store: AgentMemoryStore): Promise<void> {
    await projectAgentMemory(this.stateManager, store);
  }

  async loadAgentMemoryStore(): Promise<AgentMemoryStore> {
    return this._loadAgentMemoryStore();
  }

  async saveAgentMemoryStore(store: AgentMemoryStore): Promise<void> {
    await saveAgentMemoryStore(this.stateManager, store);
    await this._projectAgentMemoryToSoil(store);
  }

  private agentMemoryHost() {
    return {
      llmClient: this.llmClient,
      embeddingClient: this.embeddingClient,
      loadAgentMemoryStore: () => this._loadAgentMemoryStore(),
      saveAgentMemoryStore: (store: AgentMemoryStore) => this.saveAgentMemoryStore(store),
    };
  }

  private knowledgeStoreHost() {
    return {
      stateManager: this.stateManager,
      vectorIndex: this.vectorIndex,
      loadDomainKnowledge: (goalId: string) => this._loadDomainKnowledge(goalId),
      projectDomainKnowledge: (goalId: string, domainKnowledge: DomainKnowledge) =>
        this._projectDomainKnowledgeToSoil(goalId, domainKnowledge),
      projectSharedKnowledge: (entries: SharedKnowledgeEntry[]) =>
        this._projectSharedKnowledgeToSoil(entries),
    };
  }


  // ─── acquireWithTools (Phase 3-B) ───

  /**
   * Acquire knowledge by planning and executing tool calls, then synthesizing results via LLM.
   * Uses read-only tools (glob, grep, read, http_fetch, json_query, shell) to gather data.
   */
  async acquireWithTools(
    question: string,
    goalId: string,
    toolExecutor: ToolExecutor,
    context: ToolCallContext,
  ): Promise<KnowledgeEntry[]> {
    // Step 1: Plan tool calls via LLM
    const planResponse = await this.llmClient.sendMessage(
      [{ role: "user", content: `Question: ${question}\nWorkspace: ${context.cwd}` }],
      { system: "You are a research planner. Given a question, plan tool calls to gather information.\nAvailable read-only tools: glob (find files), grep (search content), read (read file), http_fetch (GET URL), json_query (query JSON file), shell (read-only commands like wc, git log, npm ls).\nReturn a JSON array of { toolName, input } objects. Return [] if the question cannot be answered with these tools." }
    );

    // Step 2: Parse plan, return [] on error or empty
    const MAX_TOOL_CALLS = 10;
    const validCalls = parseToolAcquisitionPlan(planResponse.content, MAX_TOOL_CALLS);
    if (validCalls.length === 0) return [];

    // Step 3: Execute batch
    const results = await toolExecutor.executeBatch(validCalls, context);
    const successfulResults = results
      .filter((r) => r.success)
      .map((r) => r.summary + "\n" + String(r.data).slice(0, 2000));
    if (successfulResults.length === 0) return [];

    // Step 4: Synthesize via LLM
    const synthesisResponse = await this.llmClient.sendMessage(
      [{ role: "user", content: `Question: ${question}\n\nTool outputs:\n${successfulResults.join("\n---\n")}` }],
      { system: "Synthesize the following tool outputs to answer the question. Return a JSON object with: { answer: string, confidence: number (0-1), tags: string[] }" }
    );
    const synthesis = parseToolAcquisitionSynthesis(synthesisResponse.content);
    if (!synthesis) return [];
    try {
      return [KnowledgeEntrySchema.parse({
        entry_id: crypto.randomUUID(),
        question,
        answer: synthesis.answer,
        sources: validCalls.map((tc) => ({
          type: "data_analysis" as const,
          reference: `tool:${tc.toolName}`,
          reliability: "high" as const,
        })),
        confidence: Math.min(synthesis.confidence, 0.92),
        acquired_at: new Date().toISOString(),
        acquisition_task_id: "tool_direct",
        superseded_by: null,
        tags: synthesis.tags ?? [],
        embedding_id: null,
      })];
    } catch { return []; }
  }

}
