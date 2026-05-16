import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StateManager } from "../../../base/state/state-manager.js";
import type { KnowledgeEntry, SharedKnowledgeEntry } from "../../../base/types/knowledge.js";
import { createMockLLMClient } from "../../../../tests/helpers/mock-llm.js";
import { cleanupTempDir, makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { importLegacyKnowledgeMemoryState } from "../../../runtime/store/knowledge-memory-state-migration.js";
import { openControlDatabase } from "../../../runtime/store/control-db/index.js";
import { MemoryTruthMaintenanceStore } from "../../../runtime/store/memory-truth-maintenance-store.js";
import { SqliteSoilRepository } from "../../soil/sqlite-repository.js";
import { KnowledgeMemoryStateStore } from "../knowledge-memory-state-store.js";
import { KnowledgeManager } from "../knowledge-manager.js";
import { saveDomainKnowledgeToTruth, saveSharedKnowledgeToTruth } from "../memory-truth-adapter.js";
import { AgentMemoryStoreSchema } from "../types/agent-memory.js";

const fixedNow = "2026-05-09T12:00:00.000Z";

function makeKnowledgeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return {
    entry_id: overrides.entry_id ?? "entry-1",
    question: overrides.question ?? "What does the storage refactor require?",
    answer: overrides.answer ?? "Durable internal state uses typed SQLite stores.",
    sources: overrides.sources ?? [{ type: "document", reference: "design", reliability: "high" }],
    confidence: overrides.confidence ?? 0.9,
    acquired_at: overrides.acquired_at ?? fixedNow,
    acquisition_task_id: overrides.acquisition_task_id ?? "task-1",
    superseded_by: overrides.superseded_by ?? null,
    tags: overrides.tags ?? ["database-first", "soil"],
    embedding_id: overrides.embedding_id ?? null,
  };
}

function makeSharedKnowledgeEntry(overrides: Partial<SharedKnowledgeEntry> = {}): SharedKnowledgeEntry {
  return {
    ...makeKnowledgeEntry(overrides),
    source_goal_ids: overrides.source_goal_ids ?? ["goal-1"],
    domain_stability: overrides.domain_stability ?? "moderate",
    revalidation_due_at: overrides.revalidation_due_at ?? null,
  };
}

describe("KnowledgeMemoryStateStore database ownership", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0)) {
      cleanupTempDir(dir);
    }
  });

  function tempHome(prefix: string): string {
    const dir = makeTempDir(prefix);
    tempDirs.push(dir);
    return dir;
  }

  it("routes KnowledgeManager domain, shared, and agent memory state to Soil SQLite without legacy JSON sidecars", async () => {
    const baseDir = tempHome("pulseed-knowledge-memory-soil-");
    const stateManager = new StateManager(baseDir);
    await stateManager.init();
    const manager = new KnowledgeManager(stateManager, createMockLLMClient([]));
    const entry = makeKnowledgeEntry();

    await manager.saveKnowledge("goal-1", entry);
    const shared = await manager.saveToSharedKnowledgeBase(entry, "goal-1");
    const memory = await manager.saveAgentMemory({
      key: "runtime.storage.owner",
      value: "Knowledge memory state is owned by Soil SQLite.",
      tags: ["database-first"],
      memory_type: "preference",
    });

    expect(await manager.loadKnowledge("goal-1")).toEqual([entry]);
    expect(await manager.querySharedKnowledge(["database-first"], "goal-1")).toMatchObject([
      { entry_id: shared.entry_id, source_goal_ids: ["goal-1"] },
    ]);
    expect(await manager.recallAgentMemory("runtime.storage.owner", { exact: true })).toMatchObject([
      { id: memory.id, key: "runtime.storage.owner" },
    ]);

    expect(fs.existsSync(path.join(baseDir, "goals", "goal-1", "domain_knowledge.json"))).toBe(false);
    expect(fs.existsSync(path.join(baseDir, "memory", "shared-knowledge", "entries.json"))).toBe(false);
    expect(fs.existsSync(path.join(baseDir, "memory", "agent-memory", "entries.json"))).toBe(false);
    expect(fs.existsSync(path.join(baseDir, "soil", ".index", "soil.sqlite"))).toBe(true);

    const repo = await SqliteSoilRepository.openExisting({ rootDir: path.join(baseDir, "soil") });
    expect(repo).not.toBeNull();
    try {
      const records = await repo!.loadRecords({
        source_types: [
          "knowledge_domain_entry",
          "knowledge_shared_entry",
          "knowledge_agent_memory_entry",
        ],
      });
      expect(records.map((record) => record.source_type).sort()).toEqual([
        "knowledge_agent_memory_entry",
        "knowledge_domain_entry",
        "knowledge_shared_entry",
      ]);
      const lexical = await repo!.searchLexical({
        query: "typed SQLite stores",
        limit: 5,
        record_filter: { source_types: ["knowledge_domain_entry"] },
      });
      expect(lexical.map((candidate) => candidate.record_id)).toContain("knowledge_domain_entry:goal-1:entry-1");
    } finally {
      repo?.close();
    }
  });

  it("saves agent memory truth once before writing Soil projection records", async () => {
    const baseDir = tempHome("pulseed-agent-memory-single-truth-write-");
    const stateManager = new StateManager(baseDir);
    await stateManager.init();
    const manager = new KnowledgeManager(stateManager, createMockLLMClient([]));
    const saveSnapshotSpy = vi.spyOn(MemoryTruthMaintenanceStore.prototype, "saveOwnerSnapshot");

    await manager.saveAgentMemory({
      key: "runtime.storage.owner",
      value: "Agent memory truth is owned by MemoryTruthMaintenanceStore.",
      memory_type: "fact",
    });

    expect(saveSnapshotSpy).toHaveBeenCalledTimes(1);
    expect(saveSnapshotSpy).toHaveBeenCalledWith(expect.objectContaining({
      ownerKind: "agent_memory",
      ownerScope: "default",
    }));
  });

  it("treats correction_state inactive entries as withheld across recall, truth, and Soil", async () => {
    const baseDir = tempHome("pulseed-knowledge-memory-inactive-state-");
    const stateManager = new StateManager(baseDir);
    await stateManager.init();
    const manager = new KnowledgeManager(stateManager, createMockLLMClient([]));
    const inactiveStore = AgentMemoryStoreSchema.parse({
      entries: [{
        id: "memory-inactive",
        key: "favorite-shell",
        value: "The user prefers tcsh forever.",
        tags: ["preference"],
        memory_type: "preference",
        status: "compiled",
        correction_state: {
          target_ref: { kind: "agent_memory", id: "memory-inactive" },
          status: "corrected",
          active: false,
          latest_correction_id: "correction:inactive",
          replacement_ref: null,
          retained_for_audit: true,
          reason: "Corrected by user.",
          updated_at: fixedNow,
        },
        governance: {
          sensitivity: "local",
          consent: {
            scope_id: "local",
            allowed_contexts: ["local_planning"],
            source_actor: "user",
            collection_context: "chat",
          },
          retention: {
            policy_id: "retain_until_retracted",
            retain_until: null,
            review_after: null,
            delete_requires_approval: false,
          },
          export_visibility: "listed",
          owner_ref: "user",
        },
        created_at: fixedNow,
        updated_at: fixedNow,
      }],
      corrections: [],
      last_consolidated_at: null,
    });

    await manager.saveAgentMemoryStore(inactiveStore);

    expect(await manager.recallAgentMemory("favorite-shell", { exact: true })).toEqual([]);

    const truthStore = new MemoryTruthMaintenanceStore(baseDir);
    try {
      await expect(truthStore.getClaim("memory-inactive")).resolves.toMatchObject({
        lifecycle: "corrected",
        visible_to_normal_surface: false,
        invalidated_by: "correction:inactive",
      });
    } finally {
      await truthStore.close();
    }

    const repo = await SqliteSoilRepository.openExisting({ rootDir: path.join(baseDir, "soil") });
    expect(repo).not.toBeNull();
    try {
      const [record] = await repo!.loadRecords({
        active_only: false,
        source_types: ["knowledge_agent_memory_entry"],
        source_ids: ["memory-inactive"],
      });
      expect(record).toMatchObject({
        status: "corrected",
        is_active: false,
        canonical_text: "Agent memory memory-inactive is corrected and withheld from normal Soil retrieval.",
      });
      const lexical = await repo!.searchLexical({
        query: "tcsh forever",
        limit: 5,
        record_filter: { source_types: ["knowledge_agent_memory_entry"] },
      });
      expect(lexical.map((candidate) => candidate.record_id)).not.toContain("knowledge_agent_memory_entry:memory-inactive");
    } finally {
      repo?.close();
    }
  });

  it("imports legacy knowledge and memory JSON only through the explicit migration boundary", async () => {
    const baseDir = tempHome("pulseed-legacy-knowledge-memory-import-");
    const entry = makeKnowledgeEntry({ entry_id: "legacy-entry" });
    fs.mkdirSync(path.join(baseDir, "goals", "goal-legacy"), { recursive: true });
    fs.mkdirSync(path.join(baseDir, "memory", "shared-knowledge"), { recursive: true });
    fs.mkdirSync(path.join(baseDir, "memory", "agent-memory"), { recursive: true });
    fs.writeFileSync(path.join(baseDir, "goals", "goal-legacy", "domain_knowledge.json"), JSON.stringify({
      goal_id: "goal-legacy",
      domain: "legacy",
      entries: [entry],
      last_updated: fixedNow,
    }));
    fs.writeFileSync(path.join(baseDir, "memory", "shared-knowledge", "entries.json"), JSON.stringify([{
      ...entry,
      source_goal_ids: ["goal-legacy"],
      domain_stability: "moderate",
      revalidation_due_at: null,
    }]));
    fs.writeFileSync(path.join(baseDir, "memory", "agent-memory", "entries.json"), JSON.stringify({
      entries: [{
        id: "memory-legacy",
        key: "legacy.owner",
        value: "Legacy files are migration inputs only.",
        tags: ["legacy"],
        memory_type: "fact",
        status: "compiled",
        created_at: fixedNow,
        updated_at: fixedNow,
      }],
      corrections: [],
      last_consolidated_at: fixedNow,
    }));

    const report = await importLegacyKnowledgeMemoryState(baseDir);
    expect(report).toMatchObject({
      domainKnowledge: 1,
      sharedKnowledgeEntries: 1,
      agentMemoryEntries: 1,
      blockedSources: [],
    });

    fs.rmSync(path.join(baseDir, "goals"), { recursive: true, force: true });
    fs.rmSync(path.join(baseDir, "memory"), { recursive: true, force: true });

    const stateManager = new StateManager(baseDir);
    await stateManager.init();
    const manager = new KnowledgeManager(stateManager, createMockLLMClient([]));
    expect(await manager.loadKnowledge("goal-legacy")).toMatchObject([{ entry_id: "legacy-entry" }]);
    expect(await manager.querySharedKnowledge(["database-first"], "goal-legacy")).toMatchObject([{ entry_id: "legacy-entry" }]);
    expect(await manager.recallAgentMemory("legacy.owner", { exact: true })).toMatchObject([{ id: "memory-legacy" }]);

    const controlDb = await openControlDatabase({ baseDir });
    try {
      expect(controlDb.listLegacyImports().filter((record) => record.migration_name === "knowledge-memory-soil-state"))
        .toHaveLength(3);
    } finally {
      controlDb.close();
    }
  });

  it("blocks mismatched domain legacy files until the path and payload identity agree", async () => {
    const baseDir = tempHome("pulseed-legacy-knowledge-domain-mismatch-");
    const entry = makeKnowledgeEntry({ entry_id: "domain-retry-entry" });
    fs.mkdirSync(path.join(baseDir, "goals", "goal-path"), { recursive: true });
    const legacyPath = path.join(baseDir, "goals", "goal-path", "domain_knowledge.json");
    fs.writeFileSync(legacyPath, JSON.stringify({
      goal_id: "goal-payload",
      domain: "legacy",
      entries: [entry],
      last_updated: fixedNow,
    }));

    const blocked = await importLegacyKnowledgeMemoryState(baseDir);
    expect(blocked.domainKnowledge).toBe(0);
    expect(blocked.blockedSources).toMatchObject([
      { sourceKind: "knowledge_domain_state", sourcePath: "goals/goal-path/domain_knowledge.json" },
    ]);

    fs.writeFileSync(legacyPath, JSON.stringify({
      goal_id: "goal-path",
      domain: "legacy",
      entries: [entry],
      last_updated: fixedNow,
    }));
    const retried = await importLegacyKnowledgeMemoryState(baseDir);
    expect(retried.domainKnowledge).toBe(1);

    expect(await new KnowledgeMemoryStateStore(baseDir).loadDomainKnowledge("goal-path")).toMatchObject({
      goal_id: "goal-path",
      entries: [{ entry_id: "domain-retry-entry" }],
    });
    const controlDb = await openControlDatabase({ baseDir });
    try {
      expect(controlDb.listLegacyImports()).toContainEqual(expect.objectContaining({
        migration_name: "knowledge-memory-soil-state",
        source_kind: "knowledge_domain_state",
        source_id: "goal-path",
        status: "imported",
      }));
    } finally {
      controlDb.close();
    }
  });

  it("blocks invalid shared legacy files instead of importing empty state", async () => {
    const baseDir = tempHome("pulseed-legacy-shared-knowledge-invalid-");
    const entry = makeKnowledgeEntry({ entry_id: "shared-retry-entry" });
    fs.mkdirSync(path.join(baseDir, "memory", "shared-knowledge"), { recursive: true });
    const legacyPath = path.join(baseDir, "memory", "shared-knowledge", "entries.json");
    fs.writeFileSync(legacyPath, JSON.stringify({ entries: [] }));

    const blocked = await importLegacyKnowledgeMemoryState(baseDir);
    expect(blocked.sharedKnowledgeEntries).toBe(0);
    expect(blocked.blockedSources).toMatchObject([
      { sourceKind: "knowledge_shared_state", sourcePath: "memory/shared-knowledge/entries.json" },
    ]);

    fs.writeFileSync(legacyPath, JSON.stringify([{
      ...entry,
      source_goal_ids: ["goal-shared"],
      domain_stability: "moderate",
      revalidation_due_at: null,
    }]));
    const retried = await importLegacyKnowledgeMemoryState(baseDir);
    expect(retried.sharedKnowledgeEntries).toBe(1);

    expect(await new KnowledgeMemoryStateStore(baseDir).loadSharedKnowledgeEntries()).toMatchObject([
      { entry_id: "shared-retry-entry" },
    ]);
    const controlDb = await openControlDatabase({ baseDir });
    try {
      expect(controlDb.listLegacyImports()).toContainEqual(expect.objectContaining({
        migration_name: "knowledge-memory-soil-state",
        source_kind: "knowledge_shared_state",
        source_id: "shared",
        status: "imported",
      }));
    } finally {
      controlDb.close();
    }
  });

  it("does not resurrect inactive domain truth from stale Soil compatibility records", async () => {
    const baseDir = tempHome("pulseed-domain-truth-no-soil-resurrection-");
    const stateManager = new StateManager(baseDir);
    await stateManager.init();
    const active = makeKnowledgeEntry({
      entry_id: "domain-stale",
      question: "Which editor is current?",
      answer: "Atom",
      tags: ["editor"],
    });
    const store = new KnowledgeMemoryStateStore(baseDir);
    await store.saveDomainKnowledge({
      goal_id: "goal-1",
      domain: "goal-1",
      entries: [active],
      last_updated: fixedNow,
    });
    await saveDomainKnowledgeToTruth(baseDir, {
      goal_id: "goal-1",
      domain: "goal-1",
      entries: [{ ...active, superseded_by: "domain-replacement" }],
      last_updated: fixedNow,
    });

    const manager = new KnowledgeManager(stateManager, createMockLLMClient([]));
    await expect(store.loadDomainKnowledge("goal-1")).resolves.toMatchObject({ entries: [] });
    await expect(manager.loadKnowledge("goal-1")).resolves.toEqual([]);

    const repo = await SqliteSoilRepository.openExisting({ rootDir: path.join(baseDir, "soil") });
    expect(repo).not.toBeNull();
    try {
      const staleSoil = await repo!.searchLexical({
        query: "Atom",
        limit: 5,
        record_filter: { source_types: ["knowledge_domain_entry"] },
      });
      expect(staleSoil.map((candidate) => candidate.record_id)).toContain("knowledge_domain_entry:goal-1:domain-stale");
    } finally {
      repo?.close();
    }
  });

  it("tombstones domain knowledge truth when deleting the production domain owner", async () => {
    const baseDir = tempHome("pulseed-domain-delete-truth-tombstone-");
    const stateManager = new StateManager(baseDir);
    await stateManager.init();
    const manager = new KnowledgeManager(stateManager, createMockLLMClient([]));
    const entry = makeKnowledgeEntry({
      entry_id: "entry-delete",
      question: "Which deleted fact must not return?",
      answer: "This domain fact was deleted.",
      tags: ["delete"],
    });

    await manager.saveKnowledge("goal-delete", entry);
    await expect(manager.loadKnowledge("goal-delete")).resolves.toEqual([entry]);

    const store = new KnowledgeMemoryStateStore(baseDir);
    await store.deleteDomainKnowledge("goal-delete");

    await expect(manager.loadKnowledge("goal-delete")).resolves.toEqual([]);
    const truthStore = new MemoryTruthMaintenanceStore(baseDir);
    try {
      await expect(truthStore.listClaims({
        ownerKind: "domain_knowledge",
        ownerScope: "goal-delete",
        includeInactive: true,
      })).resolves.toEqual([
        expect.objectContaining({
          claim_id: "knowledge:domain:goal-delete:entry-delete",
          lifecycle: "forgotten",
          visible_to_normal_surface: false,
        }),
      ]);
    } finally {
      await truthStore.close();
    }

    const repo = await SqliteSoilRepository.openExisting({ rootDir: path.join(baseDir, "soil") });
    expect(repo).not.toBeNull();
    try {
      const lexical = await repo!.searchLexical({
        query: "deleted fact",
        limit: 5,
        record_filter: { source_types: ["knowledge_domain_entry"] },
      });
      expect(lexical.map((candidate) => candidate.record_id)).not.toContain("knowledge_domain_entry:goal-delete:entry-delete");
    } finally {
      repo?.close();
    }
  });

  it("does not resurrect inactive shared truth from stale Soil compatibility records", async () => {
    const baseDir = tempHome("pulseed-shared-truth-no-soil-resurrection-");
    const stateManager = new StateManager(baseDir);
    await stateManager.init();
    const active = makeSharedKnowledgeEntry({
      entry_id: "shared-stale",
      question: "Which editor is current?",
      answer: "Atom",
      tags: ["editor"],
      source_goal_ids: ["goal-1"],
    });
    const store = new KnowledgeMemoryStateStore(baseDir);
    await store.saveSharedKnowledgeEntries([active]);
    await saveSharedKnowledgeToTruth(baseDir, [{ ...active, superseded_by: "shared-replacement" }]);

    const manager = new KnowledgeManager(stateManager, createMockLLMClient([]));
    await expect(store.loadSharedKnowledgeEntries()).resolves.toEqual([]);
    await expect(manager.querySharedKnowledge(["editor"], "goal-1")).resolves.toEqual([]);

    const repo = await SqliteSoilRepository.openExisting({ rootDir: path.join(baseDir, "soil") });
    expect(repo).not.toBeNull();
    try {
      const staleSoil = await repo!.searchLexical({
        query: "Atom",
        limit: 5,
        record_filter: { source_types: ["knowledge_shared_entry"] },
      });
      expect(staleSoil.map((candidate) => candidate.record_id)).toContain("knowledge_shared_entry:shared-stale");
    } finally {
      repo?.close();
    }
  });
});
