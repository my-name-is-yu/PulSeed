import { describe, expect, it, vi } from "vitest";
import { verifyExecutionWithGitDiff } from "../task/task-execution-helpers.js";
import type { ToolExecutor } from "../../../tools/executor.js";

function makeToolExecutor(data: string): ToolExecutor {
  return {
    execute: vi.fn().mockResolvedValue({
      success: true,
      data,
      summary: "diff",
      durationMs: 1,
    }),
  } as unknown as ToolExecutor;
}

describe("verifyExecutionWithGitDiff", () => {
  it("trusts captured filesystem evidence instead of running a git-only diff check", async () => {
    const toolExecutor = makeToolExecutor("");

    const result = await verifyExecutionWithGitDiff(toolExecutor, "goal-filesystem", {
      success: true,
      output: "done",
      error: null,
      exit_code: 0,
      elapsed_ms: 1,
      stopped_reason: "completed",
      filesChanged: true,
      filesChangedPaths: ["reports/result.json"],
      diffEvidenceSource: "filesystem_artifact",
    });

    expect(result).toEqual({
      verified: true,
      diffSummary: "1 file changed via filesystem evidence",
      source: "filesystem_artifact",
    });
    expect(toolExecutor.execute).not.toHaveBeenCalled();
  });

  it("runs git diff from the AgentLoop execution workspace when filesystem evidence is unavailable", async () => {
    const toolExecutor = makeToolExecutor("diff --git a/file.txt b/file.txt\n");

    const result = await verifyExecutionWithGitDiff(toolExecutor, "goal-git", {
      success: true,
      output: "done",
      error: null,
      exit_code: 0,
      elapsed_ms: 1,
      stopped_reason: "completed",
      agentLoop: {
        traceId: "trace-1",
        sessionId: "session-1",
        turnId: "turn-1",
        stopReason: "completed",
        modelTurns: 1,
        toolCalls: 0,
        compactions: 0,
        executionCwd: "/tmp/pulseed-workspace",
      },
    });

    expect(result).toEqual({
      verified: true,
      diffSummary: "1 file changed",
      source: "git",
    });
    expect(toolExecutor.execute).toHaveBeenCalledWith(
      "git_diff",
      { target: "unstaged", maxLines: 200 },
      expect.objectContaining({ cwd: "/tmp/pulseed-workspace", goalId: "goal-git" }),
    );
  });
});
