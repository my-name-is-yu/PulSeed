import { describe, expect, it } from "vitest";
import {
  classifyAgentLoopCommandResult,
  taskAgentLoopResultToAgentResult,
} from "../index.js";

describe("classifyAgentLoopCommandResult", () => {
  it("marks declared verification-plan commands as evidence-eligible without command text heuristics", () => {
    expect(classifyAgentLoopCommandResult({
      toolName: "shell_command",
      command: "printf proof > evidence.txt",
      activityCategory: "command",
      verificationPlan: { requiredCommands: ["printf proof > evidence.txt"] },
    })).toMatchObject({
      category: "verification",
      evidenceEligible: true,
      evidenceSource: "verification_plan",
    });
  });

  it("marks typed test-category tool results as evidence-eligible", () => {
    expect(classifyAgentLoopCommandResult({
      toolName: "verify",
      command: "arbitrary verification",
      activityCategory: "test",
    })).toMatchObject({
      category: "verification",
      evidenceEligible: true,
      evidenceSource: "tool_activity_category",
    });
  });

  it("rejects keyword-looking stale commands that are not in the typed verification plan", () => {
    expect(classifyAgentLoopCommandResult({
      toolName: "shell_command",
      command: "test -f old-target.ts",
      activityCategory: "command",
      verificationPlan: { requiredCommands: ["printf proof > evidence.txt"] },
    })).toMatchObject({
      category: "other",
      evidenceEligible: false,
    });
  });

  it("uses typed read/search activity categories for observations", () => {
    expect(classifyAgentLoopCommandResult({
      toolName: "grep",
      command: "grep marker README.md",
      activityCategory: "search",
    })).toMatchObject({
      category: "observation",
      evidenceEligible: false,
    });
  });
});

describe("taskAgentLoopResultToAgentResult command evidence filtering", () => {
  it("only promotes verification-eligible command results into completion evidence", () => {
    const agentResult = taskAgentLoopResultToAgentResult({
      success: true,
      output: {
        status: "done",
        finalAnswer: "done",
        summary: "",
        filesChanged: [],
        testsRun: [],
        completionEvidence: [],
        verificationHints: [],
        blockers: [],
      },
      finalText: "",
      stopReason: "completed",
      elapsedMs: 10,
      modelTurns: 2,
      toolCalls: 2,
      compactions: 0,
      filesChanged: false,
      changedFiles: [],
      commandResults: [
        {
          toolName: "shell_command",
          command: "pwd",
          cwd: "/tmp",
          success: true,
          category: "observation",
          evidenceEligible: false,
          outputSummary: "Command succeeded",
          durationMs: 1,
        },
        {
          toolName: "shell_command",
          command: "test -f src/app.ts",
          cwd: "/tmp",
          success: true,
          category: "verification",
          evidenceEligible: true,
          evidenceSource: "verification_plan",
          outputSummary: "Command succeeded",
          durationMs: 1,
        },
      ],
      traceId: "trace-1",
      sessionId: "session-1",
      turnId: "turn-1",
    });

    expect(agentResult.agentLoop?.completionEvidence).toEqual(["verified command: test -f src/app.ts"]);
  });

  it("preserves cancelled native agent-loop results as cancelled task execution", () => {
    const agentResult = taskAgentLoopResultToAgentResult({
      success: false,
      output: null,
      finalText: "Agent loop stopped: operator stop aborted active model work.",
      stopReason: "cancelled",
      elapsedMs: 10,
      modelTurns: 0,
      toolCalls: 0,
      compactions: 0,
      filesChanged: false,
      changedFiles: [],
      commandResults: [],
      traceId: "trace-1",
      sessionId: "session-1",
      turnId: "turn-1",
    });

    expect(agentResult.success).toBe(false);
    expect(agentResult.stopped_reason).toBe("cancelled");
    expect(agentResult.error).toContain("operator stop");
  });
});
