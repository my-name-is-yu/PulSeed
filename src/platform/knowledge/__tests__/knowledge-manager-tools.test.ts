import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { KnowledgeManager } from "../knowledge-manager.js";
import { StateManager } from "../../../base/state/state-manager.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ToolCallContext } from "../../../tools/types.js";

// Mock helpers
function createMockLLMClient(responses: string[]) {
  let callIndex = 0;
  return {
    sendMessage: vi.fn().mockImplementation(async () => ({
      content: responses[callIndex++] ?? "{}",
      usage: { input_tokens: 10, output_tokens: 10 },
      stop_reason: "end_turn",
    })),
    parseJSON: vi.fn(),
  };
}

function createMockToolExecutor(results: Array<{ success: boolean; summary: string; data: unknown }>) {
  return {
    execute: vi.fn(),
    executeBatch: vi.fn().mockResolvedValue(results),
  };
}

function makeContext(cwd = "/tmp/test"): ToolCallContext {
  return {
    cwd,
    goalId: "goal-1",
    trustBalance: 50,
    preApproved: true,
    approvalFn: async () => true,
  };
}

describe("KnowledgeManager.acquireWithTools", () => {
  let tmpDir: string;
  let stateManager: StateManager;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "km-tools-"));
    stateManager = new StateManager(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns knowledge entries when tools succeed", async () => {
    const llm = createMockLLMClient([
      // Step 1: plan
      JSON.stringify([{ toolName: "grep", input: { pattern: "test", path: "." } }]),
      // Step 4: synthesis
      JSON.stringify({ answer: "Found 10 test files", confidence: 0.85, tags: ["testing"] }),
    ]);
    const executor = createMockToolExecutor([
      { success: true, summary: "grep found matches", data: "file1.ts\nfile2.ts" },
    ]);
    const km = new KnowledgeManager(stateManager, llm as any);
    const ctx = makeContext();

    const entries = await km.acquireWithTools("How many test files?", "goal-1", executor as any, ctx);

    expect(entries).toHaveLength(1);
    expect(entries[0].question).toBe("How many test files?");
    expect(entries[0].answer).toBe("Found 10 test files");
    expect(entries[0].confidence).toBe(0.85);
    expect(entries[0].acquisition_task_id).toBe("tool_direct");
    expect(entries[0].sources[0].type).toBe("data_analysis");
    expect(entries[0].sources[0].reference).toBe("tool:grep");
    expect(entries[0].tags).toEqual(["testing"]);
  });

  it("caps confidence at 0.92", async () => {
    const llm = createMockLLMClient([
      JSON.stringify([{ toolName: "read", input: { file_path: "/test.ts" } }]),
      JSON.stringify({ answer: "Answer", confidence: 0.99, tags: [] }),
    ]);
    const executor = createMockToolExecutor([
      { success: true, summary: "file content", data: "content here" },
    ]);
    const km = new KnowledgeManager(stateManager, llm as any);

    const entries = await km.acquireWithTools("Q?", "goal-1", executor as any, makeContext());

    expect(entries[0].confidence).toBe(0.92);
  });

  it("normalizes recoverable synthesis values before validating the knowledge entry", async () => {
    const llm = createMockLLMClient([
      JSON.stringify([{ toolName: "read", input: { file_path: "/test.ts" } }]),
      JSON.stringify({ answer: "Answer", confidence: 1.2, tags: null }),
    ]);
    const executor = createMockToolExecutor([
      { success: true, summary: "file content", data: "content here" },
    ]);
    const km = new KnowledgeManager(stateManager, llm as any);

    const entries = await km.acquireWithTools("Q?", "goal-1", executor as any, makeContext());

    expect(entries).toHaveLength(1);
    expect(entries[0].confidence).toBe(0.92);
    expect(entries[0].tags).toEqual([]);
  });

  it("returns empty when LLM plan is unparseable", async () => {
    const llm = createMockLLMClient(["not json at all"]);
    const executor = createMockToolExecutor([]);
    const km = new KnowledgeManager(stateManager, llm as any);

    const entries = await km.acquireWithTools("Q?", "goal-1", executor as any, makeContext());

    expect(entries).toEqual([]);
    expect(executor.executeBatch).not.toHaveBeenCalled();
  });

  it("returns empty when LLM plans no tool calls", async () => {
    const llm = createMockLLMClient(["[]"]);
    const executor = createMockToolExecutor([]);
    const km = new KnowledgeManager(stateManager, llm as any);

    const entries = await km.acquireWithTools("Q?", "goal-1", executor as any, makeContext());

    expect(entries).toEqual([]);
  });

  it("returns empty when all tools fail", async () => {
    const llm = createMockLLMClient([
      JSON.stringify([{ toolName: "grep", input: {} }]),
    ]);
    const executor = createMockToolExecutor([
      { success: false, summary: "error", data: null },
    ]);
    const km = new KnowledgeManager(stateManager, llm as any);

    const entries = await km.acquireWithTools("Q?", "goal-1", executor as any, makeContext());

    expect(entries).toEqual([]);
  });

  it("returns empty when synthesis response is unparseable", async () => {
    const llm = createMockLLMClient([
      JSON.stringify([{ toolName: "glob", input: { pattern: "*.ts" } }]),
      "not valid json for synthesis",
    ]);
    const executor = createMockToolExecutor([
      { success: true, summary: "found files", data: "a.ts\nb.ts" },
    ]);
    const km = new KnowledgeManager(stateManager, llm as any);

    const entries = await km.acquireWithTools("Q?", "goal-1", executor as any, makeContext());

    expect(entries).toEqual([]);
  });

  it("returns empty when synthesis response violates the knowledge entry contract", async () => {
    const llm = createMockLLMClient([
      JSON.stringify([{ toolName: "glob", input: { pattern: "*.ts" } }]),
      JSON.stringify({ answer: "Found files", confidence: "high", tags: ["files"] }),
    ]);
    const executor = createMockToolExecutor([
      { success: true, summary: "found files", data: "a.ts\nb.ts" },
    ]);
    const km = new KnowledgeManager(stateManager, llm as any);

    const entries = await km.acquireWithTools("Q?", "goal-1", executor as any, makeContext());

    expect(entries).toEqual([]);
  });

  it("passes correct context to executeBatch", async () => {
    const llm = createMockLLMClient([
      JSON.stringify([{ toolName: "shell", input: { command: "wc -l" } }]),
      JSON.stringify({ answer: "100 lines", confidence: 0.8, tags: [] }),
    ]);
    const executor = createMockToolExecutor([
      { success: true, summary: "line count", data: "100" },
    ]);
    const km = new KnowledgeManager(stateManager, llm as any);
    const ctx = makeContext("/workspace");

    await km.acquireWithTools("How many lines?", "goal-1", executor as any, ctx);

    expect(executor.executeBatch).toHaveBeenCalledWith(
      [{ toolName: "shell", input: { command: "wc -l" } }],
      ctx,
    );
  });

  it("uses system prompt via options, not message role", async () => {
    const llm = createMockLLMClient([
      JSON.stringify([{ toolName: "read", input: { file_path: "/f" } }]),
      JSON.stringify({ answer: "A", confidence: 0.5, tags: [] }),
    ]);
    const executor = createMockToolExecutor([
      { success: true, summary: "ok", data: "data" },
    ]);
    const km = new KnowledgeManager(stateManager, llm as any);

    await km.acquireWithTools("Q?", "goal-1", executor as any, makeContext());

    // Both calls should use options.system, not role: "system"
    const calls = llm.sendMessage.mock.calls;
    expect(calls).toHaveLength(2);
    // First call: plan
    expect(calls[0][0][0].role).toBe("user");
    expect(calls[0][1]).toHaveProperty("system");
    // Second call: synthesis
    expect(calls[1][0][0].role).toBe("user");
    expect(calls[1][1]).toHaveProperty("system");
  });

  it("truncates tool data to 2000 chars", async () => {
    const longData = "x".repeat(5000);
    const llm = createMockLLMClient([
      JSON.stringify([{ toolName: "read", input: { file_path: "/big" } }]),
      JSON.stringify({ answer: "Big file", confidence: 0.7, tags: [] }),
    ]);
    const executor = createMockToolExecutor([
      { success: true, summary: "read big file", data: longData },
    ]);
    const km = new KnowledgeManager(stateManager, llm as any);

    await km.acquireWithTools("Read big?", "goal-1", executor as any, makeContext());

    // Verify the synthesis call has truncated data
    const synthesisCall = llm.sendMessage.mock.calls[1];
    const content = synthesisCall[0][0].content;
    // summary + "\n" + truncated data = "read big file\n" + "x" * 2000
    expect(content.length).toBeLessThan(5100); // well under full 5000 data
  });

  it("handles multiple tool calls with mixed success", async () => {
    const llm = createMockLLMClient([
      JSON.stringify([
        { toolName: "grep", input: { pattern: "TODO" } },
        { toolName: "read", input: { file_path: "/missing" } },
        { toolName: "glob", input: { pattern: "*.md" } },
      ]),
      JSON.stringify({ answer: "Found TODOs and docs", confidence: 0.75, tags: ["todo", "docs"] }),
    ]);
    const executor = createMockToolExecutor([
      { success: true, summary: "grep results", data: "TODO: fix" },
      { success: false, summary: "file not found", data: null },
      { success: true, summary: "glob results", data: "README.md" },
    ]);
    const km = new KnowledgeManager(stateManager, llm as any);

    const entries = await km.acquireWithTools("Find TODOs?", "goal-1", executor as any, makeContext());

    expect(entries).toHaveLength(1);
    // Sources should include ALL planned tools (not just successful)
    expect(entries[0].sources).toHaveLength(3);
    expect(entries[0].tags).toEqual(["todo", "docs"]);
  });
});
