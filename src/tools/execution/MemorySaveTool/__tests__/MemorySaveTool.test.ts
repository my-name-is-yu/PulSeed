import { describe, it, expect, vi, beforeEach } from "vitest";
import { MemorySaveTool } from "../MemorySaveTool.js";
import type { KnowledgeManager } from "../../../../platform/knowledge/knowledge-manager.js";
import type { ToolCallContext } from "../../../types.js";
import type { AgentMemoryEntry } from "../../../../platform/knowledge/types/agent-memory.js";

const makeContext = (): ToolCallContext => ({
  cwd: "/tmp",
  goalId: "goal-1",
  trustBalance: 50,
  preApproved: false,
  approvalFn: async () => false,
  sessionId: "session-1",
});

function makeSavedEntry(key: string): AgentMemoryEntry {
  return {
    id: "entry-id-1",
    key,
    value: "some value",
    tags: [],
    memory_type: "fact",
    status: "raw",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    summary: "",
  } as AgentMemoryEntry;
}

function makeMockKM(overrides: Partial<KnowledgeManager> = {}): KnowledgeManager {
  return {
    saveAgentMemory: vi.fn().mockImplementation((entry: { key: string }) =>
      Promise.resolve(makeSavedEntry(entry.key))
    ),
    ...overrides,
  } as unknown as KnowledgeManager;
}

describe("MemorySaveTool", () => {
  let km: KnowledgeManager;
  let tool: MemorySaveTool;

  beforeEach(() => {
    km = makeMockKM();
    tool = new MemorySaveTool(km);
  });

  describe("metadata", () => {
    it("has correct name", () => {
      expect(tool.metadata.name).toBe("memory_save");
    });

    it("is not read-only", () => {
      expect(tool.metadata.isReadOnly).toBe(false);
    });

    it("is not destructive", () => {
      expect(tool.metadata.isDestructive).toBe(false);
    });

    it("has write_local permission", () => {
      expect(tool.metadata.permissionLevel).toBe("write_local");
    });

    it("has memory and save tags", () => {
      expect(tool.metadata.tags).toContain("memory");
      expect(tool.metadata.tags).toContain("save");
    });
  });

  describe("isConcurrencySafe", () => {
    it("returns false", () => {
      expect(tool.isConcurrencySafe({ key: "k", value: "v", memory_type: "fact" })).toBe(false);
    });
  });

  describe("checkPermissions", () => {
    it("always returns allowed", async () => {
      const result = await tool.checkPermissions(
        { key: "k", value: "v", memory_type: "fact" },
        makeContext()
      );
      expect(result.status).toBe("allowed");
    });
  });

  describe("description", () => {
    it("returns non-empty string", () => {
      expect(tool.description()).toBeTruthy();
    });
  });

  describe("successful execution", () => {
    it("calls saveAgentMemory and returns id + key", async () => {
      const result = await tool.call({ key: "my-key", value: "my-value", memory_type: "fact" }, makeContext());

      expect(result.success).toBe(true);
      const data = result.data as { id: string; key: string };
      expect(data.key).toBe("my-key");
      expect(typeof data.id).toBe("string");
      expect(vi.mocked(km.saveAgentMemory)).toHaveBeenCalledWith(
        expect.objectContaining({ key: "my-key", value: "my-value" })
      );
    });

    it("passes category and tags to saveAgentMemory", async () => {
      await tool.call(
        { key: "k", value: "v", memory_type: "fact", category: "infra", tags: ["t1"] },
        makeContext()
      );
      expect(vi.mocked(km.saveAgentMemory)).toHaveBeenCalledWith(
        expect.objectContaining({ category: "infra", tags: ["t1"] })
      );
    });

    it("passes memory_type to saveAgentMemory", async () => {
      await tool.call({ key: "k", value: "v", memory_type: "procedure" }, makeContext());
      expect(vi.mocked(km.saveAgentMemory)).toHaveBeenCalledWith(
        expect.objectContaining({ memory_type: "procedure" })
      );
    });
  });

  describe("error handling", () => {
    it("returns failure when saveAgentMemory throws", async () => {
      vi.mocked(km.saveAgentMemory).mockRejectedValue(new Error("disk full"));
      const result = await tool.call({ key: "k", value: "v", memory_type: "fact" }, makeContext());
      expect(result.success).toBe(false);
      expect(result.error).toContain("disk full");
    });
  });
});
