/**
 * Tests for Phase 4-B: StrategyManager workspace context + per-iteration cache.
 *
 * Tests cover:
 * - WorkspaceContextCache: get(), invalidate(), isValid()
 * - buildWorkspaceContext: happy path, tool failure fallback
 * - formatWorkspaceContext: string formatting
 * - generateCandidates: workspace context injection into prompt
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import { makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { createMockLLMClient } from "../../../../tests/helpers/mock-llm.js";
import { StateManager } from "../../../base/state/state-manager.js";
import { StrategyManager } from "../strategy-manager.js";
import {
  buildWorkspaceContext,
  WorkspaceContextCache,
  formatWorkspaceContext,
} from "../strategy-workspace.js";
import type { WorkspaceContext } from "../strategy-workspace.js";
import type { ToolExecutor } from "../../../tools/executor.js";
import type { ToolCallContext, ToolResult } from "../../../tools/types.js";

// ─── Fixtures ───

const CANDIDATE_RESPONSE = `\`\`\`json
[
  {
    "hypothesis": "Add unit tests for the trust-manager module",
    "expected_effect": [
      { "dimension": "test_coverage", "direction": "increase", "magnitude": "medium" }
    ],
    "resource_estimate": {
      "sessions": 3,
      "duration": { "value": 2, "unit": "days" },
      "llm_calls": null
    },
    "allocation": 0.8
  }
]
\`\`\``;

const MOCK_TOOL_CALL_CONTEXT: ToolCallContext = {
  cwd: "/tmp/test-project",
  goalId: "goal-1",
  trustBalance: 50,
  preApproved: false,
  approvalFn: async () => false,
};

// ─── Mock ToolExecutor builder ───

function makeToolResult(overrides: Partial<ToolResult>): ToolResult {
  return {
    success: true,
    data: null,
    summary: "ok",
    durationMs: 5,
    ...overrides,
  };
}

function createMockExecutor(
  results: ToolResult[],
): ToolExecutor {
  let callIndex = 0;
  return {
    execute: vi.fn().mockImplementation(async () => {
      const r = results[callIndex] ?? makeToolResult({ success: false, data: null, summary: "no more results" });
      callIndex++;
      return r;
    }),
    executeBatch: vi.fn().mockImplementation(async (calls: unknown[]) => {
      return calls.map(() => {
        const r = results[callIndex] ?? makeToolResult({ success: false, data: null, summary: "no more results" });
        callIndex++;
        return r;
      });
    }),
  } as unknown as ToolExecutor;
}

function makeWorkspaceResults(overrides: Partial<{
  rootFiles: string[];
  srcFiles: string[];
  gitLog: string;
  pkgJson: string;
  testFiles: string[];
}> = {}): ToolResult[] {
  const rootFiles = overrides.rootFiles ?? ["package.json", "tsconfig.json", "README.md"];
  const srcFiles = overrides.srcFiles ?? ["src/index.ts", "src/core.ts"];
  const gitLog = overrides.gitLog ?? "abc1234 fix: bug\ndef5678 feat: new feature";
  const pkgJson = overrides.pkgJson ?? JSON.stringify({
    scripts: { build: "tsc", test: "vitest run" },
    dependencies: { zod: "^3.0.0", vitest: "^1.0.0" },
  });
  const testFiles = overrides.testFiles ?? ["src/__tests__/core.test.ts"];

  return [
    makeToolResult({ success: true, data: rootFiles }),
    makeToolResult({ success: true, data: srcFiles }),
    makeToolResult({ success: true, data: { stdout: gitLog, stderr: "", exitCode: 0 } }),
    makeToolResult({ success: true, data: pkgJson }),
    makeToolResult({ success: true, data: testFiles }),
  ];
}

// ─── Test Suite ───

let tempDir: string;
let stateManager: StateManager;

beforeEach(() => {
  tempDir = makeTempDir();
  stateManager = new StateManager(tempDir);
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

// ─── buildWorkspaceContext ───

describe("buildWorkspaceContext", () => {
  it("populates all fields from successful tool calls", async () => {
    const executor = createMockExecutor(makeWorkspaceResults());
    const ctx = await buildWorkspaceContext(executor, MOCK_TOOL_CALL_CONTEXT);

    expect(ctx.rootFiles).toContain("package.json");
    expect(ctx.sourceTree).toContain("src/index.ts");
    expect(ctx.recentCommits).toHaveLength(2);
    expect(ctx.scripts).toEqual({ build: "tsc", test: "vitest run" });
    expect(ctx.dependencies).toContain("zod");
    expect(ctx.testFiles).toContain("src/__tests__/core.test.ts");
  });

  it("returns empty arrays when tool calls fail", async () => {
    const failResults: ToolResult[] = Array.from({ length: 5 }, () =>
      makeToolResult({ success: false, data: null, summary: "tool failed" }),
    );
    const executor = createMockExecutor(failResults);
    const ctx = await buildWorkspaceContext(executor, MOCK_TOOL_CALL_CONTEXT);

    expect(ctx.rootFiles).toEqual([]);
    expect(ctx.sourceTree).toEqual([]);
    expect(ctx.recentCommits).toEqual([]);
    expect(ctx.scripts).toEqual({});
    expect(ctx.dependencies).toEqual([]);
    expect(ctx.testFiles).toEqual([]);
  });

  it("handles malformed package.json gracefully", async () => {
    const results = makeWorkspaceResults({ pkgJson: "not valid json {{{" });
    const executor = createMockExecutor(results);
    const ctx = await buildWorkspaceContext(executor, MOCK_TOOL_CALL_CONTEXT);

    // Other fields should still populate
    expect(ctx.rootFiles).toContain("package.json");
    // Scripts/deps fall back to empty
    expect(ctx.scripts).toEqual({});
    expect(ctx.dependencies).toEqual([]);
  });

  it("handles git log output with trailing newline", async () => {
    const results = makeWorkspaceResults({
      gitLog: "abc1234 fix: bug\ndef5678 feat: feature\n",
    });
    const executor = createMockExecutor(results);
    const ctx = await buildWorkspaceContext(executor, MOCK_TOOL_CALL_CONTEXT);

    // filter(Boolean) removes empty strings from split
    expect(ctx.recentCommits).toHaveLength(2);
    expect(ctx.recentCommits).not.toContain("");
  });

  it("calls executeBatch with 5 tool calls", async () => {
    const executor = createMockExecutor(makeWorkspaceResults());
    await buildWorkspaceContext(executor, MOCK_TOOL_CALL_CONTEXT);

    const batchFn = executor.executeBatch as ReturnType<typeof vi.fn>;
    expect(batchFn).toHaveBeenCalledOnce();
    const [calls] = batchFn.mock.calls[0] as [Array<{ toolName: string }>];
    expect(calls).toHaveLength(5);
    const toolNames = calls.map((c) => c.toolName);
    expect(toolNames).toContain("glob");
    expect(toolNames).toContain("shell");
    expect(toolNames).toContain("read");
  });
});

// ─── WorkspaceContextCache ───

describe("WorkspaceContextCache", () => {
  it("builds context on first get()", async () => {
    const executor = createMockExecutor(makeWorkspaceResults());
    const cache = new WorkspaceContextCache();

    const ctx = await cache.get(1, executor, MOCK_TOOL_CALL_CONTEXT);
    expect(ctx.rootFiles).toContain("package.json");
  });

  it("returns cached result on same iteration without re-calling executor", async () => {
    const executor = createMockExecutor([
      ...makeWorkspaceResults(),
      ...makeWorkspaceResults(), // extra results that should NOT be consumed
    ]);
    const cache = new WorkspaceContextCache();

    const ctx1 = await cache.get(1, executor, MOCK_TOOL_CALL_CONTEXT);
    const ctx2 = await cache.get(1, executor, MOCK_TOOL_CALL_CONTEXT);

    // executeBatch should only have been called once
    const batchFn = executor.executeBatch as ReturnType<typeof vi.fn>;
    expect(batchFn).toHaveBeenCalledOnce();
    // Both should return the same object reference
    expect(ctx1).toBe(ctx2);
  });

  it("rebuilds context when iteration advances", async () => {
    const results1 = makeWorkspaceResults({ rootFiles: ["file-iter-1.ts"] });
    const results2 = makeWorkspaceResults({ rootFiles: ["file-iter-2.ts"] });
    const executor = createMockExecutor([...results1, ...results2]);
    const cache = new WorkspaceContextCache();

    const ctx1 = await cache.get(1, executor, MOCK_TOOL_CALL_CONTEXT);
    const ctx2 = await cache.get(2, executor, MOCK_TOOL_CALL_CONTEXT);

    expect(ctx1.rootFiles).toContain("file-iter-1.ts");
    expect(ctx2.rootFiles).toContain("file-iter-2.ts");
    const batchFn = executor.executeBatch as ReturnType<typeof vi.fn>;
    expect(batchFn).toHaveBeenCalledTimes(2);
  });

  it("invalidate() forces rebuild on next get()", async () => {
    const executor = createMockExecutor([
      ...makeWorkspaceResults({ rootFiles: ["before.ts"] }),
      ...makeWorkspaceResults({ rootFiles: ["after.ts"] }),
    ]);
    const cache = new WorkspaceContextCache();

    const ctx1 = await cache.get(1, executor, MOCK_TOOL_CALL_CONTEXT);
    expect(ctx1.rootFiles).toContain("before.ts");

    cache.invalidate();

    const ctx2 = await cache.get(1, executor, MOCK_TOOL_CALL_CONTEXT);
    expect(ctx2.rootFiles).toContain("after.ts");
  });

  it("isValid() returns false before first get()", () => {
    const cache = new WorkspaceContextCache();
    expect(cache.isValid(1)).toBe(false);
  });

  it("isValid() returns true after get() for same iteration", async () => {
    const executor = createMockExecutor(makeWorkspaceResults());
    const cache = new WorkspaceContextCache();

    await cache.get(1, executor, MOCK_TOOL_CALL_CONTEXT);
    expect(cache.isValid(1)).toBe(true);
    expect(cache.isValid(2)).toBe(false);
  });

  it("isValid() returns false after invalidate()", async () => {
    const executor = createMockExecutor(makeWorkspaceResults());
    const cache = new WorkspaceContextCache();

    await cache.get(1, executor, MOCK_TOOL_CALL_CONTEXT);
    cache.invalidate();
    expect(cache.isValid(1)).toBe(false);
  });
});

// ─── formatWorkspaceContext ───

describe("formatWorkspaceContext", () => {
  const sample: WorkspaceContext = {
    rootFiles: ["package.json", "tsconfig.json"],
    sourceTree: ["src/index.ts", "src/core.ts"],
    recentCommits: ["abc1234 fix: bug", "def5678 feat: feature"],
    scripts: { build: "tsc", test: "vitest run" },
    dependencies: ["zod", "vitest"],
    testFiles: ["src/__tests__/core.test.ts"],
  };

  it("includes workspace context header", () => {
    const out = formatWorkspaceContext(sample);
    expect(out).toContain("=== Workspace Context ===");
  });

  it("includes root files", () => {
    const out = formatWorkspaceContext(sample);
    expect(out).toContain("package.json");
    expect(out).toContain("tsconfig.json");
  });

  it("includes recent commits", () => {
    const out = formatWorkspaceContext(sample);
    expect(out).toContain("abc1234 fix: bug");
  });

  it("includes scripts", () => {
    const out = formatWorkspaceContext(sample);
    expect(out).toContain("build: tsc");
  });

  it("includes test file count", () => {
    const out = formatWorkspaceContext(sample);
    expect(out).toContain("1 files");
  });

  it("handles empty WorkspaceContext gracefully", () => {
    const empty: WorkspaceContext = {
      rootFiles: [],
      sourceTree: [],
      recentCommits: [],
      scripts: {},
      dependencies: [],
      testFiles: [],
    };
    const out = formatWorkspaceContext(empty);
    expect(out).toContain("=== Workspace Context ===");
    // Should not throw
  });

  it("truncates source tree preview to 20 entries", () => {
    const manyFiles = Array.from({ length: 25 }, (_, i) => `src/file-${i}.ts`);
    const ctx: WorkspaceContext = { ...sample, sourceTree: manyFiles };
    const out = formatWorkspaceContext(ctx);
    expect(out).toContain("5 more");
  });
});

// ─── StrategyManager integration: workspace context injected into prompt ───

describe("StrategyManager.generateCandidates with workspace context", () => {
  it("calls executeBatch when toolExecutor + toolContext are provided", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE]);
    const manager = new StrategyManager(stateManager, mock);

    const executor = createMockExecutor(makeWorkspaceResults());
    manager.setToolExecutor(executor);

    await manager.generateCandidates(
      "goal-1",
      "test_coverage",
      ["test_coverage"],
      { currentGap: 0.7, pastStrategies: [] },
      undefined,
      { toolCallContext: MOCK_TOOL_CALL_CONTEXT, iteration: 1 },
    );

    const batchFn = executor.executeBatch as ReturnType<typeof vi.fn>;
    expect(batchFn).toHaveBeenCalledOnce();
  });

  it("skips workspace gathering when no toolExecutor is set", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE]);
    const manager = new StrategyManager(stateManager, mock);
    // No setToolExecutor() call

    // Should succeed without error
    const candidates = await manager.generateCandidates(
      "goal-1",
      "test_coverage",
      ["test_coverage"],
      { currentGap: 0.7, pastStrategies: [] },
      undefined,
      { toolCallContext: MOCK_TOOL_CALL_CONTEXT, iteration: 1 },
    );

    expect(candidates).toHaveLength(1);
  });

  it("skips workspace gathering when no toolContext is provided", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE]);
    const manager = new StrategyManager(stateManager, mock);

    const executor = createMockExecutor(makeWorkspaceResults());
    manager.setToolExecutor(executor);

    // No toolContext argument
    const candidates = await manager.generateCandidates(
      "goal-1",
      "test_coverage",
      ["test_coverage"],
      { currentGap: 0.7, pastStrategies: [] },
    );

    expect(candidates).toHaveLength(1);
    // executeBatch should NOT have been called
    const batchFn = executor.executeBatch as ReturnType<typeof vi.fn>;
    expect(batchFn).not.toHaveBeenCalled();
  });

  it("caches workspace context across calls in same iteration", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE, CANDIDATE_RESPONSE]);
    const manager = new StrategyManager(stateManager, mock);

    const executor = createMockExecutor([
      ...makeWorkspaceResults(),
      ...makeWorkspaceResults(), // should not be consumed
    ]);
    manager.setToolExecutor(executor);

    // First call
    await manager.generateCandidates(
      "goal-1",
      "test_coverage",
      ["test_coverage"],
      { currentGap: 0.7, pastStrategies: [] },
      undefined,
      { toolCallContext: MOCK_TOOL_CALL_CONTEXT, iteration: 1 },
    );

    // Second call same iteration — cache hit
    await manager.generateCandidates(
      "goal-1",
      "test_coverage",
      ["test_coverage"],
      { currentGap: 0.5, pastStrategies: [] },
      undefined,
      { toolCallContext: MOCK_TOOL_CALL_CONTEXT, iteration: 1 },
    );

    // executeBatch called only once despite two generateCandidates calls
    const batchFn = executor.executeBatch as ReturnType<typeof vi.fn>;
    expect(batchFn).toHaveBeenCalledOnce();
  });

  it("rebuilds workspace context when iteration advances", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE, CANDIDATE_RESPONSE]);
    const manager = new StrategyManager(stateManager, mock);

    const executor = createMockExecutor([
      ...makeWorkspaceResults(),
      ...makeWorkspaceResults(),
    ]);
    manager.setToolExecutor(executor);

    await manager.generateCandidates(
      "goal-1",
      "test_coverage",
      ["test_coverage"],
      { currentGap: 0.7, pastStrategies: [] },
      undefined,
      { toolCallContext: MOCK_TOOL_CALL_CONTEXT, iteration: 1 },
    );

    await manager.generateCandidates(
      "goal-1",
      "test_coverage",
      ["test_coverage"],
      { currentGap: 0.5, pastStrategies: [] },
      undefined,
      { toolCallContext: MOCK_TOOL_CALL_CONTEXT, iteration: 2 },
    );

    const batchFn = executor.executeBatch as ReturnType<typeof vi.fn>;
    expect(batchFn).toHaveBeenCalledTimes(2);
  });

  it("continues gracefully when workspace tool calls throw", async () => {
    const mock = createMockLLMClient([CANDIDATE_RESPONSE]);
    const manager = new StrategyManager(stateManager, mock);

    // executor.executeBatch throws
    const brokenExecutor = {
      executeBatch: vi.fn().mockRejectedValue(new Error("network error")),
      execute: vi.fn(),
    } as unknown as ToolExecutor;
    manager.setToolExecutor(brokenExecutor);

    // Should not throw — workspace error is non-fatal
    const candidates = await manager.generateCandidates(
      "goal-1",
      "test_coverage",
      ["test_coverage"],
      { currentGap: 0.7, pastStrategies: [] },
      undefined,
      { toolCallContext: MOCK_TOOL_CALL_CONTEXT, iteration: 1 },
    );

    expect(candidates).toHaveLength(1);
  });
});
