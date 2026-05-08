import { describe, expect, it, vi } from "vitest";
import { finalizeSuccessfulExecution } from "../task/task-post-execution.js";
import type { AgentResult } from "../task/task-lifecycle.js";

function makeExecutionResult(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    success: true,
    output: "Task completed successfully",
    error: null,
    exit_code: 0,
    elapsed_ms: 100,
    stopped_reason: "completed",
    ...overrides,
  };
}

describe("finalizeSuccessfulExecution", () => {
  it("marks execution as failed when the health check fails and skips git diff verification", async () => {
    const verifyWithGitDiff = vi.fn();
    const executionResult = makeExecutionResult();

    const result = await finalizeSuccessfulExecution({
      executionResult,
      goalId: "goal-1",
      healthCheck: {
        enabled: true,
        run: vi.fn().mockResolvedValue({ healthy: false, output: "Build failed" }),
      },
      successVerification: {
        toolExecutor: {} as never,
        verifyWithGitDiff,
      },
    });

    expect(result.success).toBe(false);
    expect(String(result.output)).toContain("[Health Check Failed]");
    expect(verifyWithGitDiff).not.toHaveBeenCalled();
  });

  it("runs git diff verification after a successful health check", async () => {
    const verifyWithGitDiff = vi.fn().mockResolvedValue({
      verified: true,
      diffSummary: "1 file changed",
    });

    await finalizeSuccessfulExecution({
      executionResult: makeExecutionResult(),
      goalId: "goal-2",
      healthCheck: {
        enabled: true,
        run: vi.fn().mockResolvedValue({ healthy: true, output: "ok" }),
      },
      successVerification: {
        toolExecutor: {} as never,
        verifyWithGitDiff,
      },
    });

    expect(verifyWithGitDiff).toHaveBeenCalledWith(expect.anything(), "goal-2", expect.objectContaining({
      success: true,
    }));
  });

  it("reports filesystem diff evidence without emitting the old git-only no-change warning", async () => {
    const verifyWithGitDiff = vi.fn().mockResolvedValue({
      verified: true,
      diffSummary: "1 file changed via filesystem evidence",
      source: "filesystem_artifact",
    });
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
    };

    await finalizeSuccessfulExecution({
      executionResult: makeExecutionResult({
        filesChanged: true,
        filesChangedPaths: ["reports/result.json"],
        diffEvidenceSource: "filesystem_artifact",
      }),
      goalId: "goal-filesystem",
      healthCheck: {
        enabled: false,
        run: vi.fn(),
      },
      successVerification: {
        toolExecutor: {} as never,
        verifyWithGitDiff,
      },
      logger: logger as never,
    });

    expect(verifyWithGitDiff).toHaveBeenCalledWith(expect.anything(), "goal-filesystem", expect.objectContaining({
      diffEvidenceSource: "filesystem_artifact",
      filesChangedPaths: ["reports/result.json"],
    }));
    expect(logger.info).toHaveBeenCalledWith(
      "[TaskLifecycle] Post-execution diff verification: 1 file changed via filesystem evidence",
      { verified: true, source: "filesystem_artifact" },
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
