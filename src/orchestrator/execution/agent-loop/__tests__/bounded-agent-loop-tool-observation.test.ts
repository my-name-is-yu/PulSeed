import { describe, expect, it } from "vitest";
import type { AgentLoopToolCall } from "../agent-loop-model.js";
import type { AgentLoopToolOutput } from "../agent-loop-tool-output.js";
import {
  agentLoopToolObservationExecution,
  agentLoopToolObservationState,
  createAgentLoopToolObservation,
  readToolResultCheckOnly,
} from "../bounded-agent-loop-tool-observation.js";

function makeToolOutput(overrides: Partial<AgentLoopToolOutput> = {}): AgentLoopToolOutput {
  return {
    callId: "call-1",
    toolName: "shell_command",
    success: true,
    content: "ok",
    durationMs: 12,
    ...overrides,
  };
}

describe("bounded agent loop tool observation helpers", () => {
  it("classifies tool observation state from execution reasons and batch timeout state", () => {
    expect(agentLoopToolObservationState(makeToolOutput({ execution: { status: "executed", reason: "timed_out" } }), false)).toBe("timed_out");
    expect(agentLoopToolObservationState(makeToolOutput({ disposition: "cancelled" }), true)).toBe("timed_out");
    expect(agentLoopToolObservationState(makeToolOutput({ disposition: "cancelled" }), false)).toBe("interrupted");
    expect(agentLoopToolObservationState(makeToolOutput({ execution: { status: "not_executed", reason: "approval_denied" } }), false)).toBe("denied");
    expect(agentLoopToolObservationState(makeToolOutput({ execution: { status: "not_executed", reason: "policy_blocked" } }), false)).toBe("blocked");
    expect(agentLoopToolObservationState(makeToolOutput({ success: false }), false)).toBe("failure");
    expect(agentLoopToolObservationState(makeToolOutput({ success: true }), false)).toBe("success");
  });

  it("creates fallback execution metadata for interrupted and timed out observations", () => {
    expect(agentLoopToolObservationExecution(makeToolOutput({ content: "stopped" }), "interrupted")).toEqual({
      status: "executed",
      reason: "interrupted",
      message: "stopped",
    });
    expect(agentLoopToolObservationExecution(makeToolOutput({ content: "late" }), "timed_out")).toEqual({
      status: "executed",
      reason: "timed_out",
      message: "late",
    });
    expect(agentLoopToolObservationExecution(makeToolOutput(), "success")).toEqual({ status: "executed" });
  });

  it("preserves model-facing tool observation contract fields", () => {
    const sourceCall: AgentLoopToolCall = {
      id: "call-1",
      name: "apply_patch",
      input: { patch: "*** Begin Patch" },
    };
    const observation = createAgentLoopToolObservation({
      sourceCall,
      toolBatchTimedOut: false,
      result: makeToolOutput({
        toolName: "apply_patch",
        rawResult: {
          success: true,
          summary: "patched",
          durationMs: 12,
          data: { checkOnly: false },
        },
        command: "apply_patch",
        cwd: "/repo",
        artifacts: ["src/file.ts"],
        truncated: { originalChars: 1_200, overflowPath: "tmp/out.txt" },
        activityCategory: "file_modify",
      }),
    });

    expect(observation).toMatchObject({
      type: "tool_observation",
      callId: "call-1",
      toolName: "apply_patch",
      arguments: { patch: "*** Begin Patch" },
      state: "success",
      success: true,
      execution: { status: "executed" },
      output: {
        content: "ok",
        summary: "patched",
        data: { checkOnly: false },
      },
      command: "apply_patch",
      cwd: "/repo",
      artifacts: ["src/file.ts"],
      truncated: { originalChars: 1_200, overflowPath: "tmp/out.txt" },
      activityCategory: "file_modify",
    });
  });

  it("extracts check-only status only from apply_patch tool result data", () => {
    expect(readToolResultCheckOnly(makeToolOutput({
      toolName: "apply_patch",
      rawResult: { success: true, summary: "checked", durationMs: 1, data: { checkOnly: true } },
    }))).toBe(true);
    expect(readToolResultCheckOnly(makeToolOutput({
      toolName: "shell_command",
      rawResult: { success: true, summary: "checked", durationMs: 1, data: { checkOnly: true } },
    }))).toBeUndefined();
    expect(readToolResultCheckOnly(makeToolOutput({
      toolName: "apply_patch",
      rawResult: { success: true, summary: "checked", durationMs: 1, data: { checkOnly: "true" } },
    }))).toBeUndefined();
  });
});
