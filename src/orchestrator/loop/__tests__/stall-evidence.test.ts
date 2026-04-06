import { describe, it, expect, vi } from "vitest";
import { gatherStallEvidence } from "../stall-evidence.js";
import type { ToolExecutor } from "../../../tools/executor.js";
import type { ToolCallContext, ToolResult } from "../../../tools/types.js";

// ─── Fixtures ───

const baseContext: ToolCallContext = {
  cwd: "/tmp",
  goalId: "goal-1",
  trustBalance: 0,
  preApproved: true,
  approvalFn: async () => false,
};

function makeToolResult(success: boolean, data: unknown): ToolResult {
  return { success, data, summary: "ok", durationMs: 1 };
}

function makeExecutor(
  responses: Record<string, ToolResult>,
): ToolExecutor {
  return {
    execute: vi.fn().mockImplementation((toolName: string) => {
      if (toolName in responses) {
        return Promise.resolve(responses[toolName]);
      }
      return Promise.resolve(makeToolResult(false, null));
    }),
    executeBatch: vi.fn(),
  } as unknown as ToolExecutor;
}

// ─── gatherStallEvidence ───

describe("gatherStallEvidence", () => {
  it("hasWorkspaceChanges=false when git-diff returns empty string", async () => {
    const executor = makeExecutor({
      "git-diff": makeToolResult(true, ""),
    });
    const result = await gatherStallEvidence(executor, baseContext);
    expect(result.hasWorkspaceChanges).toBe(false);
    expect(result.toolErrors).toHaveLength(0);
  });

  it("hasWorkspaceChanges=true when git-diff returns content", async () => {
    const executor = makeExecutor({
      "git-diff": makeToolResult(true, "diff --git a/foo.ts b/foo.ts\n+added line"),
    });
    const result = await gatherStallEvidence(executor, baseContext);
    expect(result.hasWorkspaceChanges).toBe(true);
  });

  it("hasWorkspaceChanges=true (optimistic default) when git-diff fails", async () => {
    const executor = makeExecutor({
      "git-diff": makeToolResult(false, null),
    });
    const result = await gatherStallEvidence(executor, baseContext);
    // success=false means we don't update the optimistic default
    expect(result.hasWorkspaceChanges).toBe(true);
    expect(result.toolErrors).toHaveLength(0);
  });

  it("captures error in toolErrors when git-diff throws", async () => {
    const executor = {
      execute: vi.fn().mockRejectedValue(new Error("git not available")),
      executeBatch: vi.fn(),
    } as unknown as ToolExecutor;
    const result = await gatherStallEvidence(executor, baseContext);
    expect(result.toolErrors).toHaveLength(1);
    expect(result.toolErrors[0]).toContain("git-diff");
    expect(result.toolErrors[0]).toContain("git not available");
    // Defaults preserved
    expect(result.hasWorkspaceChanges).toBe(true);
    expect(result.targetArtifactsExist).toBe(true);
  });

  it("targetArtifactsExist=false when glob returns empty string", async () => {
    const executor = makeExecutor({
      "git-diff": makeToolResult(true, "some changes"),
      "glob": makeToolResult(true, ""),
    });
    const result = await gatherStallEvidence(executor, baseContext, ".", "dist/**/*.js");
    expect(result.targetArtifactsExist).toBe(false);
  });

  it("targetArtifactsExist=true when glob returns content", async () => {
    const executor = makeExecutor({
      "git-diff": makeToolResult(true, ""),
      "glob": makeToolResult(true, "dist/index.js\ndist/cli.js"),
    });
    const result = await gatherStallEvidence(executor, baseContext, ".", "dist/**/*.js");
    expect(result.targetArtifactsExist).toBe(true);
  });

  it("does not call glob when no targetPattern provided", async () => {
    const executeFn = vi.fn().mockResolvedValue(makeToolResult(true, ""));
    const executor = { execute: executeFn, executeBatch: vi.fn() } as unknown as ToolExecutor;

    await gatherStallEvidence(executor, baseContext);

    const calls = executeFn.mock.calls.map((c: unknown[]) => c[0]);
    expect(calls).not.toContain("glob");
  });

  it("captures glob error in toolErrors without affecting other evidence", async () => {
    let callCount = 0;
    const executor = {
      execute: vi.fn().mockImplementation((toolName: string) => {
        callCount++;
        if (toolName === "git-diff") {
          return Promise.resolve(makeToolResult(true, "change"));
        }
        return Promise.reject(new Error("glob failed"));
      }),
      executeBatch: vi.fn(),
    } as unknown as ToolExecutor;

    const result = await gatherStallEvidence(executor, baseContext, ".", "*.ts");
    expect(result.hasWorkspaceChanges).toBe(true);
    expect(result.toolErrors).toHaveLength(1);
    expect(result.toolErrors[0]).toContain("glob");
    expect(result.targetArtifactsExist).toBe(true); // optimistic default preserved
  });
});
