import { describe, expect, it, vi } from "vitest";
import { ReviewAgentLoopRunner } from "../review-agent-loop-runner.js";
import type { AgentLoopResult } from "../agent-loop-result.js";
import type { ReviewAgentLoopOutput } from "../review-agent-loop-runner.js";

describe("ReviewAgentLoopRunner", () => {
  it("runs with review posture and formats the returned review", async () => {
    const run = vi.fn(async (turn: {
      toolPolicy: { allowedTools?: readonly string[] };
      profileName?: string;
      reasoningEffort?: string;
      executionPolicy?: { sandboxMode: string; approvalPolicy: string; networkAccess: boolean };
      messages: Array<{ role: string; content: string }>;
    }): Promise<AgentLoopResult<ReviewAgentLoopOutput>> => ({
      success: true,
      output: {
        status: "needs_attention",
        summary: "Two issues found",
        findings: ["Missing regression test"],
        suggestedChecks: ["Run targeted unit tests"],
        evidence: ["git diff shows new behavior without coverage"],
      },
      finalText: "",
      stopReason: "completed",
      elapsedMs: 1,
      modelTurns: 1,
      toolCalls: 0,
      compactions: 0,
      changedFiles: [],
      commandResults: [],
      traceId: "trace-1",
      sessionId: "session-1",
      turnId: "turn-1",
    }));
    const runner = new ReviewAgentLoopRunner({
      boundedRunner: { run } as never,
      modelClient: {
        getModelInfo: vi.fn().mockResolvedValue({
          ref: { providerId: "openai", modelId: "gpt-5.4-mini" },
          displayName: "openai/gpt-5.4-mini",
          capabilities: {
            toolCalling: true,
            parallelToolCalls: true,
            streaming: false,
            structuredOutput: true,
            reasoning: true,
            attachments: false,
            interleavedThinking: false,
            inputModalities: ["text"],
            outputModalities: ["text"],
          },
        }),
      } as never,
      modelRegistry: {
        defaultModel: vi.fn().mockResolvedValue({ providerId: "openai", modelId: "gpt-5.4-mini" }),
      } as never,
      defaultToolPolicy: {
        allowedTools: ["git_diff", "grep", "test-runner"],
      },
      defaultReasoningEffort: "medium",
      defaultExecutionPolicy: {
        sandboxMode: "read_only",
        approvalPolicy: "never",
        networkAccess: false,
        workspaceRoot: "/repo",
        protectedPaths: [],
        trustProjectInstructions: true,
      },
      profile: {
        name: "review",
        budget: {
          maxModelTurns: 6,
          maxToolCalls: 10,
          maxWallClockMs: 60_000,
          maxConsecutiveToolErrors: 2,
          maxRepeatedToolCalls: 2,
          maxSchemaRepairAttempts: 1,
          maxCompletionValidationAttempts: 1,
          maxCompactions: 1,
          compactionMaxMessages: 6,
        },
        toolPolicy: { allowedTools: ["git_diff", "grep", "test-runner"] },
        executionPolicy: {
          sandboxMode: "read_only",
          approvalPolicy: "never",
          networkAccess: false,
          workspaceRoot: "/repo",
          protectedPaths: [],
          trustProjectInstructions: true,
        },
      },
    });

    const result = await runner.execute({
      cwd: "/repo",
      diffStat: " src/file.ts | 2 +-",
      executionPolicy: {
        sandboxMode: "read_only",
        approvalPolicy: "never",
        networkAccess: false,
        workspaceRoot: "/repo",
        protectedPaths: [],
        trustProjectInstructions: true,
      },
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain("status: needs_attention");
    expect(result.output).toContain("findings:");
    expect(result.output).toContain("Missing regression test");
    const turn = run.mock.calls[0]?.[0] as {
      toolPolicy: { allowedTools?: readonly string[] };
      profileName?: string;
      reasoningEffort?: string;
      executionPolicy?: { sandboxMode: string; approvalPolicy: string; networkAccess: boolean };
      messages: Array<{ role: string; content: string }>;
    };
    expect(turn.toolPolicy.allowedTools).toEqual(["git_diff", "grep", "test-runner"]);
    expect(turn.messages[0]?.content).toContain("review agentloop");
    expect(turn.messages[1]?.content).toContain("sandbox_mode: read_only");
    expect(turn.profileName).toBe("review");
    expect(turn.reasoningEffort).toBe("medium");
    expect(turn.executionPolicy).toMatchObject({
      sandboxMode: "read_only",
      approvalPolicy: "never",
      networkAccess: false,
    });
  });
});
