import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemoryRecallTool } from "../MemoryRecallTool.js";
import type { KnowledgeManager } from "../../../../platform/knowledge/knowledge-manager.js";
import { KnowledgeManager as RealKnowledgeManager } from "../../../../platform/knowledge/knowledge-manager.js";
import type { ToolCallContext } from "../../../types.js";
import { AgentMemoryEntrySchema, type AgentMemoryEntry } from "../../../../platform/knowledge/types/agent-memory.js";
import { StateManager } from "../../../../base/state/state-manager.js";
import type { ILLMClient } from "../../../../base/llm/llm-client.js";
import { cleanupTempDir, makeTempDir } from "../../../../../tests/helpers/temp-dir.js";

const makeContext = (): ToolCallContext => ({
  cwd: "/tmp",
  goalId: "goal-1",
  trustBalance: 50,
  preApproved: false,
  approvalFn: async () => false,
});

function makeEntry(overrides: Partial<AgentMemoryEntry> = {}): AgentMemoryEntry {
  return AgentMemoryEntrySchema.parse({
    id: "mem-1",
    key: "user.language",
    value: "TypeScript",
    tags: ["language", "preference"],
    category: "project",
    memory_type: "preference",
    status: "raw",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  });
}

function makeMockKnowledgeManager(
  overrides: Partial<KnowledgeManager> = {}
): KnowledgeManager {
  return {
    recallAgentMemory: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as KnowledgeManager;
}

describe("MemoryRecallTool", () => {
  let km: KnowledgeManager;
  let tool: MemoryRecallTool;

  beforeEach(() => {
    km = makeMockKnowledgeManager();
    tool = new MemoryRecallTool(km);
  });

  describe("metadata", () => {
    it("has correct name", () => {
      expect(tool.metadata.name).toBe("memory_recall");
    });

    it("is read_only", () => {
      expect(tool.metadata.permissionLevel).toBe("read_only");
      expect(tool.metadata.isReadOnly).toBe(true);
    });

    it("is not destructive", () => {
      expect(tool.metadata.isDestructive).toBe(false);
    });

    it("has correct aliases", () => {
      expect(tool.metadata.aliases).toContain("recall_memory");
      expect(tool.metadata.aliases).toContain("remember_query");
    });
  });

  describe("checkPermissions", () => {
    it("always returns allowed", async () => {
      const result = await tool.checkPermissions(
        { query: "test" },
        makeContext()
      );
      expect(result.status).toBe("allowed");
    });
  });

  describe("isConcurrencySafe", () => {
    it("returns true", () => {
      expect(tool.isConcurrencySafe()).toBe(true);
    });
  });

  describe("description", () => {
    it("returns non-empty string", () => {
      expect(tool.description()).toBeTruthy();
    });

    it("mentions tiered retrieval", () => {
      expect(tool.description()).toContain("compiled");
    });
  });

  describe("lexical search", () => {
    it("returns matching entries for explicit lexical search", async () => {
      const entry = makeEntry({ key: "user.language", value: "TypeScript" });
      vi.mocked(km.recallAgentMemory).mockResolvedValue([entry]);

      const result = await tool.call({ query: "TypeScript", mode: "lexical" }, makeContext());

      expect(result.success).toBe(true);
      const data = result.data as { entries: AgentMemoryEntry[]; totalFound: number };
      expect(data.totalFound).toBe(1);
      expect(data.entries[0]).toMatchObject({ key: "user.language", value: "TypeScript" });
      expect(vi.mocked(km.recallAgentMemory)).toHaveBeenCalledWith(
        "TypeScript",
        expect.objectContaining({ mode: "lexical" })
      );
    });

    it("returns empty array when no matches", async () => {
      vi.mocked(km.recallAgentMemory).mockResolvedValue([]);

      const result = await tool.call({ query: "nonexistent" }, makeContext());

      expect(result.success).toBe(true);
      const data = result.data as { entries: AgentMemoryEntry[]; totalFound: number };
      expect(data.totalFound).toBe(0);
      expect(data.entries).toHaveLength(0);
    });
  });

  describe("exact match", () => {
    it("passes exact=true to recallAgentMemory", async () => {
      const entry = makeEntry({ key: "user.language" });
      vi.mocked(km.recallAgentMemory).mockResolvedValue([entry]);

      const result = await tool.call(
        { query: "user.language", exact: true },
        makeContext()
      );

      expect(result.success).toBe(true);
      const data = result.data as { entries: AgentMemoryEntry[]; totalFound: number };
      expect(data.totalFound).toBe(1);
      expect(vi.mocked(km.recallAgentMemory)).toHaveBeenCalledWith(
        "user.language",
        expect.objectContaining({ mode: "exact" })
      );
    });
  });

  describe("filtering", () => {
    it("filters by category", async () => {
      const entry = makeEntry({ category: "project" });
      vi.mocked(km.recallAgentMemory).mockResolvedValue([entry]);

      const result = await tool.call(
        { query: "", category: "project" },
        makeContext()
      );

      expect(result.success).toBe(true);
      expect(vi.mocked(km.recallAgentMemory)).toHaveBeenCalledWith(
        "",
        expect.objectContaining({ category: "project" })
      );
    });

    it("filters by memory_type", async () => {
      const entry = makeEntry({ memory_type: "procedure" });
      vi.mocked(km.recallAgentMemory).mockResolvedValue([entry]);

      const result = await tool.call(
        { query: "", memory_type: "procedure" },
        makeContext()
      );

      expect(result.success).toBe(true);
      expect(vi.mocked(km.recallAgentMemory)).toHaveBeenCalledWith(
        "",
        expect.objectContaining({ memory_type: "procedure" })
      );
    });

    it("respects limit", async () => {
      const entries = [
        makeEntry({ id: "m1", key: "key1" }),
        makeEntry({ id: "m2", key: "key2" }),
      ];
      vi.mocked(km.recallAgentMemory).mockResolvedValue(entries);

      const result = await tool.call({ query: "", limit: 2 }, makeContext());

      expect(result.success).toBe(true);
      expect(vi.mocked(km.recallAgentMemory)).toHaveBeenCalledWith(
        "",
        expect.objectContaining({ limit: 2 })
      );
      const data = result.data as { entries: AgentMemoryEntry[]; totalFound: number };
      expect(data.entries).toHaveLength(2);
    });

    it("defaults planning recall to local consent and local sensitivity", async () => {
      vi.mocked(km.recallAgentMemory).mockResolvedValue([]);

      await tool.call({ query: "preference" }, makeContext());

      expect(vi.mocked(km.recallAgentMemory)).toHaveBeenCalledWith(
        "preference",
        expect.objectContaining({
          consent_scope: "local_planning",
          max_sensitivity: "local",
        })
      );
    });

    it("passes explicit typed governance filters", async () => {
      vi.mocked(km.recallAgentMemory).mockResolvedValue([]);

      await tool.call(
        { query: "preference", consent_scope: "private_chat", max_sensitivity: "private" },
        makeContext()
      );

      expect(vi.mocked(km.recallAgentMemory)).toHaveBeenCalledWith(
        "preference",
        expect.objectContaining({
          consent_scope: "private_chat",
          max_sensitivity: "private",
        })
      );
    });
  });

  describe("tiered retrieval", () => {
    it("compiled entries rank before raw entries", async () => {
      const rawEntry = makeEntry({ id: "raw-1", key: "raw.key", status: "raw" });
      const compiledEntry = makeEntry({
        id: "compiled-1",
        key: "compiled.key",
        status: "compiled",
        summary: "A compiled summary",
      });
      // Mock returns compiled first (as recallAgentMemory is responsible for ordering)
      vi.mocked(km.recallAgentMemory).mockResolvedValue([compiledEntry, rawEntry]);

      const result = await tool.call({ query: "key" }, makeContext());

      expect(result.success).toBe(true);
      const data = result.data as { entries: AgentMemoryEntry[]; totalFound: number };
      expect(data.entries[0]!.status).toBe("compiled");
      expect(data.entries[1]!.status).toBe("raw");
    });

    it("archived entries excluded by default", async () => {
      vi.mocked(km.recallAgentMemory).mockResolvedValue([]);

      await tool.call({ query: "test" }, makeContext());

      const callArgs = vi.mocked(km.recallAgentMemory).mock.calls[0]!;
      const opts = callArgs[1] as { include_archived?: boolean };
      // include_archived should be falsy (false or undefined) when not explicitly set
      expect(opts.include_archived).toBeFalsy();
    });

    it("archived entries included when include_archived=true", async () => {
      const archivedEntry = makeEntry({
        id: "arch-1",
        key: "archived.key",
        status: "archived",
      });
      vi.mocked(km.recallAgentMemory).mockResolvedValue([archivedEntry]);

      const result = await tool.call(
        { query: "archived", include_archived: true },
        makeContext()
      );

      expect(result.success).toBe(true);
      expect(vi.mocked(km.recallAgentMemory)).toHaveBeenCalledWith(
        "archived",
        expect.objectContaining({ include_archived: true })
      );
      const data = result.data as { entries: AgentMemoryEntry[]; totalFound: number };
      expect(data.entries[0]!.status).toBe("archived");
    });

    it("compiled entries include summary field", async () => {
      const compiledEntry = makeEntry({
        id: "compiled-1",
        key: "compiled.key",
        status: "compiled",
        summary: "Short summary of compiled facts",
      });
      vi.mocked(km.recallAgentMemory).mockResolvedValue([compiledEntry]);

      const result = await tool.call({ query: "compiled" }, makeContext());

      expect(result.success).toBe(true);
      const data = result.data as { entries: AgentMemoryEntry[]; totalFound: number };
      expect(data.entries[0]!.summary).toBe("Short summary of compiled facts");
    });
  });

  describe("error handling", () => {
    it("returns failure on exception", async () => {
      vi.mocked(km.recallAgentMemory).mockRejectedValue(new Error("storage error"));

      const result = await tool.call({ query: "test" }, makeContext());

      expect(result.success).toBe(false);
      expect(result.error).toContain("storage error");
    });
  });

  describe("semantic mode", () => {
    it("passes semantic mode when mode='semantic'", async () => {
      vi.mocked(km.recallAgentMemory).mockResolvedValue([]);

      await tool.call({ query: "test", mode: "semantic" }, makeContext());

      expect(vi.mocked(km.recallAgentMemory)).toHaveBeenCalledWith(
        "test",
        expect.objectContaining({ mode: "semantic" })
      );
    });

    it("defaults to semantic mode when mode is not specified", async () => {
      vi.mocked(km.recallAgentMemory).mockResolvedValue([]);

      await tool.call({ query: "test" }, makeContext());

      expect(vi.mocked(km.recallAgentMemory)).toHaveBeenCalledWith(
        "test",
        expect.objectContaining({ mode: "semantic" })
      );
    });
  });

  describe("production recall path", () => {
    it("reports semantic recall unavailable instead of using lexical substring matches by default", async () => {
      const tmpDir = makeTempDir("pulseed-memory-recall-tool-");
      try {
        const stateManager = new StateManager(tmpDir);
        await stateManager.init();
        const realKm = new RealKnowledgeManager(stateManager, {} as ILLMClient);
        await realKm.saveAgentMemory({
          key: "user.language",
          value: "The user prefers TypeScript.",
          tags: ["typescript", "preference"],
        });
        const realTool = new MemoryRecallTool(realKm);

        const freeform = await realTool.call({ query: "TypeScript" }, makeContext());
        expect(freeform.success).toBe(false);
        expect(freeform.error).toContain("semantic agent memory recall requires an embedding client");

        const lexical = await realTool.call({ query: "TypeScript", mode: "lexical" }, makeContext());
        expect(lexical.success).toBe(true);
        expect((lexical.data as { entries: AgentMemoryEntry[] }).entries).toEqual([
          expect.objectContaining({ key: "user.language" }),
        ]);
      } finally {
        cleanupTempDir(tmpDir);
      }
    });
  });
});
