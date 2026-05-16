import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";
import { KnowledgeQueryTool } from "../KnowledgeQueryTool.js";
import { StateManager } from "../../../../base/state/state-manager.js";
import type { ILLMClient } from "../../../../base/llm/llm-client.js";
import { KnowledgeManager } from "../../../../platform/knowledge/knowledge-manager.js";
import type { VectorIndex } from "../../../../platform/knowledge/vector-index.js";
import type { ToolCallContext } from "../../../types.js";
import type { KnowledgeEntry } from "../../../../base/types/knowledge.js";
import { cleanupTempDir, makeTempDir } from "../../../../../tests/helpers/temp-dir.js";

const makeContext = (): ToolCallContext => ({
  cwd: "/tmp",
  goalId: "goal-1",
  trustBalance: 50,
  preApproved: false,
  approvalFn: async () => false,
});

function makeEntry(overrides: Partial<KnowledgeEntry> = {}): KnowledgeEntry {
  return {
    entry_id: "entry-1",
    question: "What is TypeScript?",
    answer: "A typed superset of JavaScript",
    sources: [{ type: "web", reference: "https://example.com", reliability: "high" }],
    confidence: 0.9,
    acquired_at: new Date().toISOString(),
    acquisition_task_id: "task-1",
    superseded_by: null,
    tags: ["typescript", "language"],
    embedding_id: null,
    ...overrides,
  };
}

function makeSharedEntry(overrides: Partial<KnowledgeEntry> = {}) {
  return {
    ...makeEntry(overrides),
    source_goal_ids: ["goal-1"],
    domain_stability: "moderate" as const,
    revalidation_due_at: new Date().toISOString(),
  };
}

function makeMockKnowledgeManager(
  overrides: Partial<KnowledgeManager> = {}
): KnowledgeManager {
  return {
    loadKnowledge: vi.fn().mockResolvedValue([]),
    querySharedKnowledge: vi.fn().mockResolvedValue([]),
    searchKnowledge: vi.fn().mockResolvedValue([]),
    searchByEmbedding: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as KnowledgeManager;
}

describe("KnowledgeQueryTool", () => {
  let km: KnowledgeManager;
  let tool: KnowledgeQueryTool;
  const tempDirs: string[] = [];

  beforeEach(() => {
    km = makeMockKnowledgeManager();
    tool = new KnowledgeQueryTool(km);
  });

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      cleanupTempDir(dir);
    }
  });

  describe("metadata", () => {
    it("has correct name", () => {
      expect(tool.metadata.name).toBe("knowledge_query");
    });

    it("is read_only", () => {
      expect(tool.metadata.permissionLevel).toBe("read_only");
      expect(tool.metadata.isReadOnly).toBe(true);
    });

    it("is not destructive", () => {
      expect(tool.metadata.isDestructive).toBe(false);
    });
  });

  describe("checkPermissions", () => {
    it("always returns allowed", async () => {
      const result = await tool.checkPermissions({ query: "test", limit: 5, type: "keyword" }, makeContext());
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
  });

  describe("keyword search — with goalId", () => {
    it("returns matching entries", async () => {
      const entry = makeEntry({ question: "What is TypeScript?" });
      vi.mocked(km.loadKnowledge).mockResolvedValue([entry]);

      const result = await tool.call(
        { query: "TypeScript", goalId: "goal-1", limit: 5, type: "keyword" },
        makeContext()
      );

      expect(result.success).toBe(true);
      const data = result.data as { results: unknown[]; totalFound: number };
      expect(data.totalFound).toBe(1);
      expect(data.results[0]).toMatchObject({
        entryId: "entry-1",
        confidence: 0.9,
        goalId: "goal-1",
        mode: "keyword",
      });
      expect(data).toMatchObject({
        requestedMode: "keyword",
        mode: "keyword",
        semanticIndexStatus: "not_requested",
        lexicalFallbackUsed: false,
      });
    });

    it("filters non-matching entries", async () => {
      const entry = makeEntry({ question: "What is Python?", answer: "A language", tags: [] });
      vi.mocked(km.loadKnowledge).mockResolvedValue([entry]);

      const result = await tool.call(
        { query: "TypeScript", goalId: "goal-1", limit: 5, type: "keyword" },
        makeContext()
      );

      expect(result.success).toBe(true);
      const data = result.data as { results: unknown[]; totalFound: number };
      expect(data.totalFound).toBe(0);
    });

    it("matches by tags", async () => {
      const entry = makeEntry({ question: "Unrelated", answer: "answer", tags: ["typescript"] });
      vi.mocked(km.loadKnowledge).mockResolvedValue([entry]);

      const result = await tool.call(
        { query: "typescript", goalId: "goal-1", limit: 5, type: "keyword" },
        makeContext()
      );

      const data = result.data as { results: unknown[]; totalFound: number };
      expect(data.totalFound).toBe(1);
    });

    it("respects limit", async () => {
      const entries = [
        makeEntry({ entry_id: "e1", question: "Q1 TypeScript" }),
        makeEntry({ entry_id: "e2", question: "Q2 TypeScript" }),
        makeEntry({ entry_id: "e3", question: "Q3 TypeScript" }),
      ];
      vi.mocked(km.loadKnowledge).mockResolvedValue(entries);

      const result = await tool.call(
        { query: "TypeScript", goalId: "goal-1", limit: 2, type: "keyword" },
        makeContext()
      );

      const data = result.data as { results: unknown[]; totalFound: number };
      expect(data.totalFound).toBe(3);
      expect(data.results.length).toBe(2);
      expect(result.summary).toContain("showing first 2");
    });
  });

  describe("keyword search — without goalId (shared KB)", () => {
    it("searches shared KB", async () => {
      const shared = makeSharedEntry({ question: "TypeScript question" });
      vi.mocked(km.querySharedKnowledge).mockResolvedValue([shared]);

      const result = await tool.call(
        { query: "TypeScript", limit: 5, type: "keyword" },
        makeContext()
      );

      expect(result.success).toBe(true);
      const data = result.data as { results: unknown[]; totalFound: number };
      expect(data.totalFound).toBe(1);
    });
  });

  describe("semantic search", () => {
    it("uses searchKnowledge for goalId", async () => {
      const entry = makeEntry();
      vi.mocked(km.searchKnowledge).mockResolvedValue([entry]);

      const result = await tool.call(
        { query: "TypeScript", goalId: "goal-1", limit: 5, type: "semantic" },
        makeContext()
      );

      expect(result.success).toBe(true);
      expect(vi.mocked(km.searchKnowledge)).toHaveBeenCalledWith("TypeScript", 5, { goalId: "goal-1" });
      const data = result.data as { results: Array<{ mode: string }>; totalFound: number; mode: string; semanticIndexStatus: string; lexicalFallbackUsed: boolean };
      expect(data.totalFound).toBe(1);
      expect(data).toMatchObject({
        mode: "semantic",
        semanticIndexStatus: "available",
        lexicalFallbackUsed: false,
      });
      expect(data.results[0]?.mode).toBe("semantic");
    });

    it("keeps goal-scoped semantic results inside the requested typed owner scope", async () => {
      const tmpDir = makeTempDir("pulseed-knowledge-query-scope-");
      tempDirs.push(tmpDir);
      const stateManager = new StateManager(tmpDir);
      await stateManager.init();
      const vectorIndex = {
        size: 2,
        add: vi.fn().mockResolvedValue(undefined),
        remove: vi.fn().mockResolvedValue(true),
        search: vi.fn().mockResolvedValue([
          { id: "goal-b-entry", similarity: 0.99, metadata: { goal_id: "goal-b" } },
          { id: "goal-a-entry", similarity: 0.98, metadata: { goal_id: "goal-a" } },
        ]),
      } as unknown as VectorIndex;
      const manager = new KnowledgeManager(stateManager, {} as ILLMClient, vectorIndex);
      await manager.saveKnowledge("goal-a", makeEntry({
        entry_id: "goal-a-entry",
        question: "How should goal A store truth?",
        answer: "Goal A uses typed owner stores.",
      }));
      await manager.saveKnowledge("goal-b", makeEntry({
        entry_id: "goal-b-entry",
        question: "How should goal B store truth?",
        answer: "Goal B uses a different owner scope.",
      }));
      const scopedTool = new KnowledgeQueryTool(manager);

      const result = await scopedTool.call(
        { query: "truth owner", goalId: "goal-a", limit: 1, type: "semantic" },
        makeContext()
      );

      expect(result.success).toBe(true);
      expect(vectorIndex.search).toHaveBeenCalledWith("truth owner", 2);
      const data = result.data as { results: Array<{ entryId: string; goalId: string | null; mode: string }>; totalFound: number; mode: string };
      expect(data).toMatchObject({
        totalFound: 1,
        mode: "semantic",
      });
      expect(data.results).toEqual([
        expect.objectContaining({
          entryId: "goal-a-entry",
          goalId: "goal-a",
          mode: "semantic",
        }),
      ]);
      expect(data.results.map((item) => item.entryId)).not.toContain("goal-b-entry");
    });

    it("reports semantic_unavailable when the semantic index is unavailable and labels fallback results as keyword", async () => {
      km = makeMockKnowledgeManager({
        hasKnowledgeSemanticIndex: vi.fn().mockReturnValue(false),
      });
      tool = new KnowledgeQueryTool(km);
      const entry = makeEntry({ question: "TypeScript fallback" });
      vi.mocked(km.loadKnowledge).mockResolvedValue([entry]);

      const result = await tool.call(
        { query: "TypeScript", goalId: "goal-1", limit: 5, type: "semantic" },
        makeContext()
      );

      expect(result.success).toBe(true);
      const data = result.data as {
        results: Array<{ mode: string }>;
        totalFound: number;
        requestedMode: string;
        mode: string;
        semanticIndexStatus: string;
        lexicalFallbackUsed: boolean;
      };
      expect(data.totalFound).toBe(1);
      expect(data).toMatchObject({
        requestedMode: "semantic",
        mode: "semantic_unavailable",
        semanticIndexStatus: "unavailable",
        lexicalFallbackUsed: true,
      });
      expect(data.results[0]?.mode).toBe("keyword");
      expect(vi.mocked(km.searchKnowledge)).not.toHaveBeenCalled();
      expect(result.summary).toContain("Semantic knowledge search unavailable");
    });

    it("returns semantic available with no results instead of silently using keyword fallback", async () => {
      km = makeMockKnowledgeManager({
        hasKnowledgeSemanticIndex: vi.fn().mockReturnValue(true),
      });
      tool = new KnowledgeQueryTool(km);
      vi.mocked(km.searchKnowledge).mockResolvedValue([]);
      const entry = makeEntry({ question: "TypeScript fallback" });
      vi.mocked(km.loadKnowledge).mockResolvedValue([entry]);

      const result = await tool.call(
        { query: "TypeScript", goalId: "goal-1", limit: 5, type: "semantic" },
        makeContext()
      );

      expect(result.success).toBe(true);
      const data = result.data as { results: unknown[]; totalFound: number; mode: string; semanticIndexStatus: string; lexicalFallbackUsed: boolean };
      expect(data).toMatchObject({
        results: [],
        totalFound: 0,
        mode: "semantic",
        semanticIndexStatus: "available",
        lexicalFallbackUsed: false,
      });
      expect(vi.mocked(km.loadKnowledge)).not.toHaveBeenCalled();
    });

    it("uses searchByEmbedding for cross-goal", async () => {
      const shared = makeSharedEntry();
      vi.mocked(km.searchByEmbedding).mockResolvedValue([{ entry: shared, similarity: 0.85 }]);

      const result = await tool.call(
        { query: "TypeScript", limit: 5, type: "semantic" },
        makeContext()
      );

      expect(result.success).toBe(true);
      const data = result.data as { results: Array<{ relevance?: number }>; totalFound: number };
      expect(data.totalFound).toBe(1);
      expect(data.results[0]?.relevance).toBe(0.85);
    });
  });

  describe("error handling", () => {
    it("returns failure on exception", async () => {
      vi.mocked(km.loadKnowledge).mockRejectedValue(new Error("disk error"));

      const result = await tool.call(
        { query: "test", goalId: "goal-1", limit: 5, type: "keyword" },
        makeContext()
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("disk error");
    });
  });
});
