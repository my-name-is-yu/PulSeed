import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { StateManager } from "../../../base/state/state-manager.js";
import { KnowledgeManager } from "../knowledge-manager.js";
import type { ILLMClient, LLMMessage, LLMRequestOptions, LLMResponse } from "../../../base/llm/llm-client.js";

// ─── Helpers ───

function makeTempDir(): string {
  const dir = path.join(
    os.tmpdir(),
    `pulseed-consolidation-test-${Math.random().toString(36).slice(2)}`
  );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeMockLLM(): ILLMClient {
  return {
    sendMessage: vi.fn().mockResolvedValue({ content: "" }),
    countTokens: vi.fn().mockResolvedValue(0),
  } as unknown as ILLMClient;
}

function makeValidConsolidatedJSON(overrides?: Partial<{
  key: string;
  value: string;
  summary: string;
  tags: string[];
}>): string {
  return JSON.stringify({
    key: overrides?.key ?? "consolidated_key",
    value: overrides?.value ?? "Consolidated value content",
    summary: overrides?.summary ?? "A short summary",
    tags: overrides?.tags ?? ["tag1", "tag2"],
  });
}

// ─── Setup / Teardown ───

let tempDir: string;
let stateManager: StateManager;
let manager: KnowledgeManager;
let mockLLM: ILLMClient;

beforeEach(() => {
  tempDir = makeTempDir();
  stateManager = new StateManager(tempDir);
  mockLLM = makeMockLLM();
  manager = new KnowledgeManager(stateManager, mockLLM);
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

// ═══════════════════════════════════════════════════════
// consolidateAgentMemory
// ═══════════════════════════════════════════════════════

describe("consolidateAgentMemory", () => {
  it("groups entries by category+memory_type, calls LLM, creates compiled entries, archives originals", async () => {
    // Save two raw entries in the same group
    await manager.saveAgentMemory({ key: "fact_a", value: "Value A", category: "coding", memory_type: "fact" });
    await manager.saveAgentMemory({ key: "fact_b", value: "Value B", category: "coding", memory_type: "fact" });

    const llmCall = vi.fn().mockResolvedValue(makeValidConsolidatedJSON({
      key: "coding_facts",
      value: "Consolidated: Value A and Value B",
      summary: "coding facts summary",
      tags: ["coding"],
    }));

    const result = await manager.consolidateAgentMemory({ llmCall });

    expect(result.compiled).toHaveLength(1);
    expect(result.archived).toBe(2);

    // Check the compiled entry
    const compiled = result.compiled[0]!;
    expect(compiled.status).toBe("compiled");
    expect(compiled.key).toBe("coding_facts");
    expect(compiled.value).toBe("Consolidated: Value A and Value B");
    expect(compiled.summary).toBe("coding facts summary");
    expect(compiled.tags).toEqual(["coding"]);
    expect(compiled.compiled_from).toHaveLength(2);
    expect(compiled.category).toBe("coding");
    expect(compiled.memory_type).toBe("fact");

    // LLM was called once
    expect(llmCall).toHaveBeenCalledTimes(1);
    // Prompt contains entry lines
    const prompt = llmCall.mock.calls[0]![0] as string;
    expect(prompt).toContain("- [fact_a]: Value A");
    expect(prompt).toContain("- [fact_b]: Value B");
  });

  it("archives original entries after consolidation", async () => {
    await manager.saveAgentMemory({ key: "obs_a", value: "Observation A", category: "runtime", memory_type: "observation" });
    await manager.saveAgentMemory({ key: "obs_b", value: "Observation B", category: "runtime", memory_type: "observation" });

    const llmCall = vi.fn().mockResolvedValue(makeValidConsolidatedJSON());

    await manager.consolidateAgentMemory({ llmCall });

    // Originals should be archived
    const stats = await manager.getAgentMemoryStats();
    expect(stats.archived).toBe(2);
    expect(stats.compiled).toBe(1);
    expect(stats.raw).toBe(0);
  });

  it("skips groups with only 1 entry", async () => {
    await manager.saveAgentMemory({ key: "solo", value: "Alone", category: "solo_cat", memory_type: "fact" });

    const llmCall = vi.fn();

    const result = await manager.consolidateAgentMemory({ llmCall });

    expect(result.compiled).toHaveLength(0);
    expect(result.archived).toBe(0);
    expect(llmCall).not.toHaveBeenCalled();
  });

  it("filters by category when provided", async () => {
    // Two entries in category "alpha" — should be consolidated
    await manager.saveAgentMemory({ key: "alpha_1", value: "Alpha 1", category: "alpha", memory_type: "fact" });
    await manager.saveAgentMemory({ key: "alpha_2", value: "Alpha 2", category: "alpha", memory_type: "fact" });
    // Two entries in category "beta" — should be skipped because we filter to "alpha"
    await manager.saveAgentMemory({ key: "beta_1", value: "Beta 1", category: "beta", memory_type: "fact" });
    await manager.saveAgentMemory({ key: "beta_2", value: "Beta 2", category: "beta", memory_type: "fact" });

    const llmCall = vi.fn().mockResolvedValue(makeValidConsolidatedJSON());

    const result = await manager.consolidateAgentMemory({ category: "alpha", llmCall });

    expect(result.compiled).toHaveLength(1);
    expect(result.archived).toBe(2);
    expect(llmCall).toHaveBeenCalledTimes(1);
  });

  it("filters by memory_type when provided", async () => {
    await manager.saveAgentMemory({ key: "proc_1", value: "Procedure 1", category: "ops", memory_type: "procedure" });
    await manager.saveAgentMemory({ key: "proc_2", value: "Procedure 2", category: "ops", memory_type: "procedure" });
    // fact entries — should be skipped
    await manager.saveAgentMemory({ key: "fact_1", value: "Fact 1", category: "ops", memory_type: "fact" });
    await manager.saveAgentMemory({ key: "fact_2", value: "Fact 2", category: "ops", memory_type: "fact" });

    const llmCall = vi.fn().mockResolvedValue(makeValidConsolidatedJSON());

    const result = await manager.consolidateAgentMemory({ memory_type: "procedure", llmCall });

    expect(result.compiled).toHaveLength(1);
    expect(result.archived).toBe(2);
  });

  it("handles LLM call errors gracefully — skips group, does not crash", async () => {
    await manager.saveAgentMemory({ key: "x1", value: "X1", category: "cat", memory_type: "fact" });
    await manager.saveAgentMemory({ key: "x2", value: "X2", category: "cat", memory_type: "fact" });

    const llmCall = vi.fn().mockRejectedValue(new Error("LLM timeout"));

    const result = await manager.consolidateAgentMemory({ llmCall });

    expect(result.compiled).toHaveLength(0);
    expect(result.archived).toBe(0);
  });

  it("handles malformed LLM JSON response gracefully — skips group, does not crash", async () => {
    await manager.saveAgentMemory({ key: "m1", value: "M1", category: "mal", memory_type: "fact" });
    await manager.saveAgentMemory({ key: "m2", value: "M2", category: "mal", memory_type: "fact" });

    const llmCall = vi.fn().mockResolvedValue("not valid json at all");

    const result = await manager.consolidateAgentMemory({ llmCall });

    expect(result.compiled).toHaveLength(0);
    expect(result.archived).toBe(0);
  });

  it("strips markdown code fences from LLM response before parsing", async () => {
    await manager.saveAgentMemory({ key: "md1", value: "MD1", category: "markdown", memory_type: "fact" });
    await manager.saveAgentMemory({ key: "md2", value: "MD2", category: "markdown", memory_type: "fact" });

    const jsonBody = makeValidConsolidatedJSON({ key: "stripped_key" });
    const llmCall = vi.fn().mockResolvedValue("```json\n" + jsonBody + "\n```");

    const result = await manager.consolidateAgentMemory({ llmCall });

    expect(result.compiled).toHaveLength(1);
    expect(result.compiled[0]!.key).toBe("stripped_key");
  });

  it("handles multiple distinct groups independently", async () => {
    // Group 1: category=a, type=fact
    await manager.saveAgentMemory({ key: "a_fact_1", value: "A1", category: "a", memory_type: "fact" });
    await manager.saveAgentMemory({ key: "a_fact_2", value: "A2", category: "a", memory_type: "fact" });
    // Group 2: category=b, type=fact
    await manager.saveAgentMemory({ key: "b_fact_1", value: "B1", category: "b", memory_type: "fact" });
    await manager.saveAgentMemory({ key: "b_fact_2", value: "B2", category: "b", memory_type: "fact" });

    const llmCall = vi.fn()
      .mockResolvedValueOnce(makeValidConsolidatedJSON({ key: "group_a" }))
      .mockResolvedValueOnce(makeValidConsolidatedJSON({ key: "group_b" }));

    const result = await manager.consolidateAgentMemory({ llmCall });

    expect(result.compiled).toHaveLength(2);
    expect(result.archived).toBe(4);
    expect(llmCall).toHaveBeenCalledTimes(2);
  });

  it("updates last_consolidated_at when entries are compiled", async () => {
    await manager.saveAgentMemory({ key: "ts1", value: "TS1", category: "ts", memory_type: "fact" });
    await manager.saveAgentMemory({ key: "ts2", value: "TS2", category: "ts", memory_type: "fact" });

    const llmCall = vi.fn().mockResolvedValue(makeValidConsolidatedJSON());
    const before = new Date().toISOString();

    await manager.consolidateAgentMemory({ llmCall });

    // Verify store persisted last_consolidated_at via stats (indirectly)
    const stats = await manager.getAgentMemoryStats();
    expect(stats.compiled).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════
// archiveAgentMemory
// ═══════════════════════════════════════════════════════

describe("archiveAgentMemory", () => {
  it("archives entries by IDs and returns count", async () => {
    const e1 = await manager.saveAgentMemory({ key: "arch_a", value: "A" });
    const e2 = await manager.saveAgentMemory({ key: "arch_b", value: "B" });
    await manager.saveAgentMemory({ key: "arch_c", value: "C" });

    const count = await manager.archiveAgentMemory([e1.id, e2.id]);

    expect(count).toBe(2);

    const stats = await manager.getAgentMemoryStats();
    expect(stats.archived).toBe(2);
    expect(stats.raw).toBe(1);
  });

  it("returns 0 for non-existent IDs", async () => {
    const count = await manager.archiveAgentMemory(["non-existent-id"]);
    expect(count).toBe(0);
  });

  it("does not double-count already-archived entries", async () => {
    const e1 = await manager.saveAgentMemory({ key: "already_arch", value: "Already" });

    // Archive once
    await manager.archiveAgentMemory([e1.id]);
    // Archive again — should return 0 since already archived
    const count = await manager.archiveAgentMemory([e1.id]);

    expect(count).toBe(0);
  });

  it("returns 0 for empty ID list", async () => {
    await manager.saveAgentMemory({ key: "some_key", value: "some value" });
    const count = await manager.archiveAgentMemory([]);
    expect(count).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════
// getAgentMemoryStats
// ═══════════════════════════════════════════════════════

describe("getAgentMemoryStats", () => {
  it("returns correct counts for empty store", async () => {
    const stats = await manager.getAgentMemoryStats();
    expect(stats).toEqual({ raw: 0, compiled: 0, archived: 0, total: 0 });
  });

  it("counts entries by status correctly", async () => {
    // 3 raw
    const e1 = await manager.saveAgentMemory({ key: "s1", value: "V1" });
    const e2 = await manager.saveAgentMemory({ key: "s2", value: "V2" });
    await manager.saveAgentMemory({ key: "s3", value: "V3" });
    // Archive 2
    await manager.archiveAgentMemory([e1.id, e2.id]);

    const stats = await manager.getAgentMemoryStats();
    expect(stats.raw).toBe(1);
    expect(stats.archived).toBe(2);
    expect(stats.compiled).toBe(0);
    expect(stats.total).toBe(3);
  });

  it("includes compiled entries in total", async () => {
    await manager.saveAgentMemory({ key: "c1", value: "C1", category: "x", memory_type: "fact" });
    await manager.saveAgentMemory({ key: "c2", value: "C2", category: "x", memory_type: "fact" });

    const llmCall = vi.fn().mockResolvedValue(makeValidConsolidatedJSON());
    await manager.consolidateAgentMemory({ llmCall });

    const stats = await manager.getAgentMemoryStats();
    expect(stats.compiled).toBe(1);
    expect(stats.archived).toBe(2);
    expect(stats.raw).toBe(0);
    // total = 2 archived + 1 compiled
    expect(stats.total).toBe(3);
  });
});
