import { describe, it, expect, vi, beforeEach } from "vitest";
import { lintAgentMemory } from "../knowledge-manager-lint.js";
import { KnowledgeManager } from "../knowledge-manager.js";
import { AgentMemoryEntrySchema, type AgentMemoryEntry } from "../types/agent-memory.js";
import { StateManager } from "../../../base/state/state-manager.js";
import type { ILLMClient } from "../../../base/llm/llm-client.js";
import { cleanupTempDir, makeTempDir } from "../../../../tests/helpers/temp-dir.js";

// ─── Mock helpers ───

function makeEntry(overrides: Partial<AgentMemoryEntry> & { id: string; key: string }): AgentMemoryEntry {
  return AgentMemoryEntrySchema.parse({
    id: overrides.id,
    key: overrides.key,
    value: overrides.value ?? "some value",
    summary: overrides.summary,
    tags: overrides.tags ?? [],
    category: overrides.category,
    memory_type: overrides.memory_type ?? "fact",
    status: overrides.status ?? "compiled",
    verification_status: overrides.verification_status,
    provenance: overrides.provenance,
    quarantine_state: overrides.quarantine_state,
    compiled_from: overrides.compiled_from,
    created_at: overrides.created_at ?? "2026-01-01T00:00:00.000Z",
    updated_at: overrides.updated_at ?? "2026-01-01T00:00:00.000Z",
  });
}

function makeKM(entries: AgentMemoryEntry[] = []): {
  km: KnowledgeManager;
  listAgentMemory: ReturnType<typeof vi.fn>;
  saveAgentMemory: ReturnType<typeof vi.fn>;
  archiveAgentMemory: ReturnType<typeof vi.fn>;
  deleteAgentMemory: ReturnType<typeof vi.fn>;
  correctAgentMemory: ReturnType<typeof vi.fn>;
  quarantineAgentMemory: ReturnType<typeof vi.fn>;
} {
  const listAgentMemory = vi.fn().mockResolvedValue(entries);
  const saveAgentMemory = vi.fn().mockImplementation(async (entry: Partial<AgentMemoryEntry>) =>
    makeEntry({ id: "new-id", key: entry.key ?? "x", ...entry })
  );
  const archiveAgentMemory = vi.fn().mockResolvedValue(1);
  const deleteAgentMemory = vi.fn().mockResolvedValue(true);
  const correctAgentMemory = vi.fn().mockResolvedValue({
    correction: { correction_id: "correction-1" },
    target: entries[0] ?? null,
    replacement: makeEntry({ id: "replacement-id", key: "replacement" }),
  });
  const quarantineAgentMemory = vi.fn().mockResolvedValue(1);

  return {
    km: {
      listAgentMemory,
      saveAgentMemory,
      archiveAgentMemory,
      deleteAgentMemory,
      correctAgentMemory,
      quarantineAgentMemory,
    } as unknown as KnowledgeManager,
    listAgentMemory,
    saveAgentMemory,
    archiveAgentMemory,
    deleteAgentMemory,
    correctAgentMemory,
    quarantineAgentMemory,
  };
}

function makeLlmCall(response: string) {
  return vi.fn().mockResolvedValue(response);
}

function emptyFindings() {
  return JSON.stringify({ findings: [] });
}

// ─── Tests ───

describe("lintAgentMemory", () => {
  describe("early exit", () => {
    it("returns empty findings when 0 compiled entries exist", async () => {
      const { km } = makeKM([]);
      const llmCall = makeLlmCall(emptyFindings());

      const result = await lintAgentMemory({ km, llmCall });

      expect(result.findings).toHaveLength(0);
      expect(result.repairs_applied).toBe(0);
      expect(result.entries_flagged).toBe(0);
      expect(llmCall).not.toHaveBeenCalled();
    });

    it("returns empty findings when only 1 compiled entry", async () => {
      const entries = [makeEntry({ id: "e1", key: "only-one" })];
      const { km } = makeKM(entries);
      const llmCall = makeLlmCall(emptyFindings());

      const result = await lintAgentMemory({ km, llmCall });

      expect(result.findings).toHaveLength(0);
      expect(llmCall).not.toHaveBeenCalled();
    });

    it("ignores non-compiled entries when counting", async () => {
      // listAgentMemory returns entries but only 1 is compiled
      const entries = [
        makeEntry({ id: "e1", key: "raw-one", status: "raw" }),
        makeEntry({ id: "e2", key: "compiled-one", status: "compiled" }),
      ];
      const { km } = makeKM(entries);
      const llmCall = makeLlmCall(emptyFindings());

      const result = await lintAgentMemory({ km, llmCall });

      expect(result.findings).toHaveLength(0);
      expect(llmCall).not.toHaveBeenCalled();
    });
  });

  describe("LLM call and response parsing", () => {
    it("calls LLM with compiled entries and parses findings correctly", async () => {
      const entries = [
        makeEntry({ id: "e1", key: "pref-editor", value: "vim", category: "prefs" }),
        makeEntry({ id: "e2", key: "pref-editor-2", value: "emacs", category: "prefs" }),
      ];
      const { km } = makeKM(entries);

      const finding = {
        type: "contradiction",
        entry_ids: ["e1", "e2"],
        description: "Different editor preferences",
        confidence: 0.9,
        suggested_action: "auto_resolve_newest",
      };
      const llmCall = makeLlmCall(JSON.stringify({ findings: [finding] }));

      const result = await lintAgentMemory({ km, llmCall });

      expect(llmCall).toHaveBeenCalledOnce();
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]!.type).toBe("contradiction");
      expect(result.findings[0]!.entry_ids).toEqual(["e1", "e2"]);
    });

    it("handles LLM returning no findings (empty array)", async () => {
      const entries = [
        makeEntry({ id: "e1", key: "key1" }),
        makeEntry({ id: "e2", key: "key2" }),
      ];
      const { km } = makeKM(entries);
      const llmCall = makeLlmCall(emptyFindings());

      const result = await lintAgentMemory({ km, llmCall });

      expect(result.findings).toHaveLength(0);
      expect(result.repairs_applied).toBe(0);
      expect(result.entries_flagged).toBe(0);
    });

    it("handles malformed LLM response gracefully without crashing", async () => {
      const entries = [
        makeEntry({ id: "e1", key: "key1" }),
        makeEntry({ id: "e2", key: "key2" }),
      ];
      const { km } = makeKM(entries);
      const llmCall = makeLlmCall("this is not valid json at all!!!");

      const result = await lintAgentMemory({ km, llmCall });

      // Should return empty findings, not throw
      expect(result.findings).toHaveLength(0);
      expect(result.repairs_applied).toBe(0);
    });

    it("strips markdown fences from LLM response before parsing", async () => {
      const entries = [
        makeEntry({ id: "e1", key: "key1" }),
        makeEntry({ id: "e2", key: "key2" }),
      ];
      const { km } = makeKM(entries);

      const finding = {
        type: "redundancy",
        entry_ids: ["e1", "e2"],
        description: "Similar content",
        confidence: 0.7,
        suggested_action: "merge",
      };
      const llmCall = makeLlmCall(`\`\`\`json\n${JSON.stringify({ findings: [finding] })}\n\`\`\``);

      const result = await lintAgentMemory({ km, llmCall });

      expect(result.findings).toHaveLength(1);
      expect(result.findings[0]!.type).toBe("redundancy");
    });
  });

  describe("autoRepair=false (default)", () => {
    it("flags entries without modifying them when autoRepair is false", async () => {
      const entries = [
        makeEntry({ id: "e1", key: "key1" }),
        makeEntry({ id: "e2", key: "key2" }),
      ];
      const { km, archiveAgentMemory, saveAgentMemory, deleteAgentMemory } = makeKM(entries);

      const finding = {
        type: "contradiction",
        entry_ids: ["e1", "e2"],
        description: "Conflict",
        confidence: 0.8,
        suggested_action: "flag_review",
      };
      const llmCall = makeLlmCall(JSON.stringify({ findings: [finding] }));

      const result = await lintAgentMemory({ km, llmCall, autoRepair: false });

      expect(result.findings).toHaveLength(1);
      expect(result.entries_flagged).toBe(2);
      expect(result.repairs_applied).toBe(0);
      expect(archiveAgentMemory).not.toHaveBeenCalled();
      expect(saveAgentMemory).not.toHaveBeenCalled();
      expect(deleteAgentMemory).not.toHaveBeenCalled();
    });
  });

  describe("autoRepair=true", () => {
    it("flags low-confidence findings instead of repairing when below threshold", async () => {
      const newer = makeEntry({ id: "e1", key: "pref-editor", value: "vim", updated_at: "2026-03-01T00:00:00.000Z" });
      const older = makeEntry({ id: "e2", key: "pref-editor-2", value: "emacs", updated_at: "2026-01-01T00:00:00.000Z" });
      const { km, archiveAgentMemory } = makeKM([newer, older]);

      const finding = {
        type: "contradiction",
        entry_ids: ["e1", "e2"],
        description: "Different editors",
        confidence: 0.6,
        suggested_action: "auto_resolve_newest",
      };
      const llmCall = makeLlmCall(JSON.stringify({ findings: [finding] }));

      const result = await lintAgentMemory({
        km,
        llmCall,
        autoRepair: true,
        minAutoRepairConfidence: 0.8,
      });

      expect(archiveAgentMemory).not.toHaveBeenCalled();
      expect(result.repairs_applied).toBe(0);
      expect(result.entries_flagged).toBe(2);
    });

    it("flags high-confidence findings when suggested action is review-only", async () => {
      const newer = makeEntry({ id: "e1", key: "pref-editor", value: "vim", updated_at: "2026-03-01T00:00:00.000Z" });
      const older = makeEntry({ id: "e2", key: "pref-editor-2", value: "emacs", updated_at: "2026-01-01T00:00:00.000Z" });
      const { km, archiveAgentMemory } = makeKM([newer, older]);

      const finding = {
        type: "contradiction",
        entry_ids: ["e1", "e2"],
        description: "Different editors",
        confidence: 0.95,
        suggested_action: "flag_review",
      };
      const llmCall = makeLlmCall(JSON.stringify({ findings: [finding] }));

      const result = await lintAgentMemory({
        km,
        llmCall,
        autoRepair: true,
        minAutoRepairConfidence: 0.8,
      });

      expect(archiveAgentMemory).not.toHaveBeenCalled();
      expect(result.repairs_applied).toBe(0);
      expect(result.entries_flagged).toBe(2);
    });

    it("contradiction: archives older entries, keeps newest", async () => {
      const newer = makeEntry({ id: "e1", key: "pref-editor", value: "vim", updated_at: "2026-03-01T00:00:00.000Z" });
      const older = makeEntry({ id: "e2", key: "pref-editor-2", value: "emacs", updated_at: "2026-01-01T00:00:00.000Z" });
      const { km, archiveAgentMemory } = makeKM([newer, older]);
      archiveAgentMemory.mockResolvedValue(1);

      const finding = {
        type: "contradiction",
        entry_ids: ["e1", "e2"],
        description: "Different editors",
        confidence: 0.9,
        suggested_action: "auto_resolve_newest",
      };
      const llmCall = makeLlmCall(JSON.stringify({ findings: [finding] }));

      const result = await lintAgentMemory({ km, llmCall, autoRepair: true });

      expect(archiveAgentMemory).toHaveBeenCalledOnce();
      // Should archive the older entry (e2)
      expect(archiveAgentMemory).toHaveBeenCalledWith(["e2"]);
      expect(result.repairs_applied).toBe(1);
    });

    it("staleness: records a correction-ledger replacement without physical deletion", async () => {
      const stale = makeEntry({
        id: "e1",
        key: "stale-fact",
        value: "old value",
        tags: ["important"],
        category: "work",
        memory_type: "fact",
      });
      const other = makeEntry({ id: "e2", key: "other-fact" });
      const { km, correctAgentMemory, deleteAgentMemory, saveAgentMemory } = makeKM([stale, other]);

      const finding = {
        type: "staleness",
        entry_ids: ["e1"],
        description: "Outdated fact",
        confidence: 0.75,
        suggested_action: "mark_stale",
      };
      const llmCall = makeLlmCall(JSON.stringify({ findings: [finding] }));

      const result = await lintAgentMemory({ km, llmCall, autoRepair: true });

      expect(correctAgentMemory).toHaveBeenCalledWith(
        expect.objectContaining({
          targetId: "e1",
          correctionKind: "corrected",
          reason: "Outdated fact",
          replacementKey: "stale-fact",
          replacementValue: "old value",
          replacementTags: expect.arrayContaining(["important", "needs-reverification"]),
          replacementStatus: "raw",
          actor: "dream_lint",
          provenanceRef: "memory_lint:auto_repair:staleness",
        })
      );
      expect(deleteAgentMemory).not.toHaveBeenCalled();
      expect(saveAgentMemory).not.toHaveBeenCalled();
      expect(result.repairs_applied).toBe(1);
    });

    it("staleness repair keeps later saves on the active replacement for the same key", async () => {
      const tmpDir = makeTempDir("pulseed-lint-stale-repair-");
      try {
        const stateManager = new StateManager(tmpDir);
        await stateManager.init();
        const km = new KnowledgeManager(stateManager, {} as ILLMClient);
        await km.saveAgentMemory({
          key: "stale-fact",
          value: "old value",
          tags: ["important"],
          category: "work",
          memory_type: "fact",
        });
        await km.saveAgentMemory({
          key: "other-fact",
          value: "other value",
          category: "work",
          memory_type: "fact",
        });
        const seededStore = await km.loadAgentMemoryStore();
        seededStore.entries = seededStore.entries.map((entry) => ({
          ...entry,
          status: "compiled",
        }));
        await km.saveAgentMemoryStore(seededStore);
        const staleId = seededStore.entries.find((entry) => entry.key === "stale-fact")!.id;
        const llmCall = makeLlmCall(JSON.stringify({
          findings: [{
            type: "staleness",
            entry_ids: [staleId],
            description: "Outdated fact",
            confidence: 0.9,
            suggested_action: "mark_stale",
          }],
        }));

        await lintAgentMemory({ km, llmCall, autoRepair: true });
        await km.saveAgentMemory({
          key: "stale-fact",
          value: "fresh value",
          tags: ["important", "fresh"],
          category: "work",
          memory_type: "fact",
        });

        expect(await km.recallAgentMemory("stale-fact", { exact: true })).toEqual([
          expect.objectContaining({
            key: "stale-fact",
            value: "fresh value",
            tags: expect.arrayContaining(["fresh"]),
          }),
        ]);
        const store = await km.loadAgentMemoryStore();
        expect(store.entries.find((entry) => entry.id === staleId)).toMatchObject({
          status: "corrected",
          value: "old value",
        });
        expect(store.entries.filter((entry) => entry.key === "stale-fact")).toHaveLength(2);
      } finally {
        cleanupTempDir(tmpDir);
      }
    });

    it("redundancy: keeps longest value entry, archives shorter ones", async () => {
      const rich = makeEntry({ id: "e1", key: "rich-entry", value: "a very long and detailed value with lots of content" });
      const lean = makeEntry({ id: "e2", key: "lean-entry", value: "short" });
      const { km, archiveAgentMemory } = makeKM([rich, lean]);
      archiveAgentMemory.mockResolvedValue(1);

      const finding = {
        type: "redundancy",
        entry_ids: ["e1", "e2"],
        description: "Similar content",
        confidence: 0.8,
        suggested_action: "merge",
      };
      const llmCall = makeLlmCall(JSON.stringify({ findings: [finding] }));

      const result = await lintAgentMemory({ km, llmCall, autoRepair: true });

      expect(archiveAgentMemory).toHaveBeenCalledOnce();
      // Should archive the shorter entry (e2)
      expect(archiveAgentMemory).toHaveBeenCalledWith(["e2"]);
      expect(result.repairs_applied).toBe(1);
    });
  });

  describe("category filtering", () => {
    it("filters entries by categories when provided", async () => {
      const workEntry1 = makeEntry({ id: "e1", key: "work-1", category: "work" });
      const workEntry2 = makeEntry({ id: "e2", key: "work-2", category: "work" });
      const personalEntry = makeEntry({ id: "e3", key: "personal-1", category: "personal" });
      const { km } = makeKM([workEntry1, workEntry2, personalEntry]);
      const llmCall = makeLlmCall(emptyFindings());

      await lintAgentMemory({ km, llmCall, categories: ["work"] });

      // LLM should only see 2 work entries (not personal)
      const userPrompt = llmCall.mock.calls[0]![0] as string;
      expect(userPrompt).toContain("work-1");
      expect(userPrompt).toContain("work-2");
      expect(userPrompt).not.toContain("personal-1");
    });

    it("returns early if category filter leaves fewer than 2 entries", async () => {
      const workEntry = makeEntry({ id: "e1", key: "work-1", category: "work" });
      const personalEntry = makeEntry({ id: "e2", key: "personal-1", category: "personal" });
      const { km } = makeKM([workEntry, personalEntry]);
      const llmCall = makeLlmCall(emptyFindings());

      const result = await lintAgentMemory({ km, llmCall, categories: ["work"] });

      expect(result.findings).toHaveLength(0);
      expect(llmCall).not.toHaveBeenCalled();
    });
  });

  describe("quarantine candidates", () => {
    it("flags explicitly unverified provenance without raw refs without deleting memory", async () => {
      const suspicious = makeEntry({
        id: "e1",
        key: "unsupported-claim",
        provenance: {
          source_type: "unknown",
          raw_refs: [],
          verification_status: "unverified",
          risk_signals: [],
        },
      });
      const { km, deleteAgentMemory, archiveAgentMemory } = makeKM([suspicious]);
      const llmCall = makeLlmCall(emptyFindings());

      const result = await lintAgentMemory({ km, llmCall });

      expect(result.findings).toEqual([
        expect.objectContaining({
          type: "quarantine",
          entry_ids: ["e1"],
          suggested_action: "quarantine",
        }),
      ]);
      expect(result.entries_flagged).toBe(1);
      expect(deleteAgentMemory).not.toHaveBeenCalled();
      expect(archiveAgentMemory).not.toHaveBeenCalled();
    });

    it("auto-quarantines prompt-injection-like risk signals without physical deletion", async () => {
      const injected = makeEntry({
        id: "e1",
        key: "captured-web-instruction",
        provenance: {
          source_type: "web",
          source_ref: "https://example.invalid/page",
          raw_refs: ["web-snapshot:1"],
          verification_status: "suspicious",
          risk_signals: ["prompt_injection_like"],
          reliability: 0.2,
        },
      });
      const { km, quarantineAgentMemory, deleteAgentMemory } = makeKM([injected]);
      const llmCall = makeLlmCall(emptyFindings());

      const result = await lintAgentMemory({ km, llmCall, autoRepair: true, minAutoRepairConfidence: 0.8 });

      expect(result.repairs_applied).toBe(1);
      expect(quarantineAgentMemory).toHaveBeenCalledWith(
        expect.objectContaining({
          targetIds: ["e1"],
          source: "memory_lint",
          confidence: 0.9,
          inspectionRefs: ["agent_memory:e1"],
        })
      );
      expect(deleteAgentMemory).not.toHaveBeenCalled();
    });
  });
});
