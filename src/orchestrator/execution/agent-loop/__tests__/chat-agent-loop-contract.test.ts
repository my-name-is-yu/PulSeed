import { describe, expect, it, vi } from "vitest";
import * as os from "node:os";
import { z } from "zod";
import { ChatAgentLoopRunner } from "../chat-agent-loop-runner.js";
import { buildAgentLoopBaseInstructions, buildChatStructuredOutputInstructions } from "../agent-loop-prompts.js";
import type {
  AgentLoopModelClient,
  AgentLoopModelInfo,
  AgentLoopModelRegistry,
  AgentLoopModelRef,
} from "../agent-loop-model.js";
import type { BoundedAgentLoopRunner } from "../bounded-agent-loop-runner.js";
import { defaultAgentLoopCapabilities } from "../index.js";
import type { AgentLoopCommandResult, AgentLoopToolResultSummary } from "../agent-loop-result.js";

function makeModelRef(): AgentLoopModelRef {
  return { providerId: "test", modelId: "model" };
}

function makeModelInfo(): AgentLoopModelInfo {
  return {
    ref: makeModelRef(),
    displayName: "test/model",
    capabilities: { ...defaultAgentLoopCapabilities },
  };
}

function makeRunner(
  returnOutput: unknown,
  finalText = JSON.stringify(returnOutput),
  commandResults: AgentLoopCommandResult[] = [],
  toolResults: AgentLoopToolResultSummary[] = commandResults.map((entry) => ({
    toolName: entry.toolName,
    success: entry.success,
    ...(entry.execution ? { execution: entry.execution } : {}),
    outputSummary: entry.outputSummary,
    durationMs: entry.durationMs,
  })),
) {
  const modelInfo = makeModelInfo();
  const boundedRunner = {
    run: vi.fn().mockResolvedValue({
      success: true,
      output: returnOutput,
      finalText,
      stopReason: "completed",
      traceId: "trace-1",
      sessionId: "session-1",
      turnId: "turn-1",
      modelTurns: 1,
      toolCalls: 0,
      usage: undefined,
      compactions: 0,
      changedFiles: [],
      toolResults,
      commandResults,
    }),
  } as unknown as BoundedAgentLoopRunner;
  const modelClient = {
    getModelInfo: vi.fn().mockResolvedValue(modelInfo),
  } as unknown as AgentLoopModelClient;
  const modelRegistry = {
    defaultModel: vi.fn().mockResolvedValue(modelInfo.ref),
  } as unknown as AgentLoopModelRegistry;

  return {
    runner: new ChatAgentLoopRunner({ boundedRunner, modelClient, modelRegistry }),
    boundedRunner,
  };
}

describe("chat agentloop final-answer contract", () => {
  it("defaults to display text mode and returns final markdown without structured output", async () => {
    const { runner, boundedRunner } = makeRunner(null, "Plain **Markdown** answer.");

    const result = await runner.execute({ message: "test" });

    expect(result.success).toBe(true);
    expect(result.output).toBe("Plain **Markdown** answer.");
    expect(result.structuredOutput).toBeUndefined();
    expect(boundedRunner.run).toHaveBeenCalledWith(expect.objectContaining({
      finalOutputMode: "display_text",
    }));
  });

  it("expands tilde cwd before building the turn context", async () => {
    const { runner, boundedRunner } = makeRunner(null, "ok");

    await runner.execute({ message: "test", cwd: "~" });

    expect(boundedRunner.run).toHaveBeenCalledWith(expect.objectContaining({
      cwd: os.homedir(),
      toolCallContext: expect.objectContaining({ cwd: os.homedir() }),
    }));
  });

  it("uses DurableLoop naming in model-facing chat instructions", async () => {
    const { runner, boundedRunner } = makeRunner(null, "ok");

    await runner.execute({ message: "check status" });

    const runInput = vi.mocked(boundedRunner.run).mock.calls[0]?.[0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const systemPrompt = runInput.messages.find((message) => message.role === "system")?.content ?? "";
    expect(systemPrompt).toContain("operate DurableLoop only through tools");
    expect(systemPrompt).toContain("Do not call DurableLoop internals directly");
    expect(systemPrompt).not.toContain("CoreLoop");
  });

  it("keeps parsed structured output separate when structured mode is explicit", async () => {
    const structured = {
      status: "done",
      answer: "Structured answer text.",
      payload: { ok: true },
    };
    const schema = z.object({
      status: z.literal("done"),
      answer: z.string(),
      payload: z.object({ ok: z.boolean() }),
    });
    const { runner, boundedRunner } = makeRunner(structured);

    const result = await runner.execute({
      message: "test",
      outputMode: { kind: "structured", schema },
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe("Structured answer text.");
    expect(result.structuredOutput).toEqual(structured);
    expect(boundedRunner.run).toHaveBeenCalledWith(expect.objectContaining({
      finalOutputMode: "schema",
      outputSchema: schema,
    }));
  });

  it("renders the structured finalAnswer object as concise markdown", async () => {
    const { runner, boundedRunner } = makeRunner({
      status: "done",
      message: "Updated the contract slice.",
      evidence: ["Verified the new JSON contract.", "Kept the legacy fields working."],
      blockers: [],
      finalAnswer: {
        summary: "Updated the contract slice.",
        sections: [
          { title: "What changed", bullets: ["Added a nested finalAnswer object.", "Kept flat output fields for compatibility."] },
        ],
        evidence: ["Verified the new JSON contract."],
        blockers: [],
        nextActions: ["Ship the change behind the current chat output path."],
      },
    });

    const result = await runner.execute({ message: "test" });

    expect(boundedRunner.run).toHaveBeenCalledOnce();
    expect(result.success).toBe(true);
    expect(result.output.startsWith("Updated the contract slice.")).toBe(true);
    expect(result.output).toContain("### What changed");
    expect(result.output).toContain("### Evidence");
    expect(result.output).toContain("### Next steps");
  });

  it("keeps legacy flat outputs working", async () => {
    const { runner } = makeRunner({
      status: "done",
      message: "Legacy summary",
      evidence: ["legacy evidence"],
      blockers: ["legacy blocker"],
    });

    const result = await runner.execute({ message: "test" });

    expect(result.success).toBe(true);
    expect(result.output.startsWith("Legacy summary")).toBe(true);
    expect(result.output).toContain("### Evidence");
    expect(result.output).toContain("### Blockers");
  });

  it("unwraps answer-only structured chat output into plain assistant text", async () => {
    const { runner } = makeRunner({
      status: "done",
      answer: "I am Codex. I work on code in your local workspace.",
    });

    const result = await runner.execute({ message: "Who are you?" });

    expect(result.success).toBe(true);
    expect(result.output).toBe("I am Codex. I work on code in your local workspace.");
    expect(result.output).not.toContain('"answer"');
  });

  it("unwraps JSON strings in message fields before display", async () => {
    const { runner } = makeRunner({
      status: "done",
      message: JSON.stringify({ answer: "Display only the body, not the JSON string." }),
      evidence: [],
      blockers: [],
    });

    const result = await runner.execute({ message: "test" });

    expect(result.success).toBe(true);
    expect(result.output).toBe("Display only the body, not the JSON string.");
    expect(result.output).not.toContain('"answer"');
  });

  it("unwraps finalAnswer.summary JSON strings before display", async () => {
    const { runner } = makeRunner({
      status: "done",
      message: "",
      evidence: [],
      blockers: [],
      finalAnswer: {
        summary: JSON.stringify({ message: "Display only the summary body." }),
        sections: [],
        evidence: [],
        blockers: [],
        nextActions: [],
      },
    });

    const result = await runner.execute({ message: "test" });

    expect(result.success).toBe(true);
    expect(result.output).toBe("Display only the summary body.");
    expect(result.output).not.toContain('"message"');
  });

  it("unwraps finalText finalAnswer.summary objects before display", async () => {
    const modelInfo = makeModelInfo();
    const boundedRunner = {
      run: vi.fn().mockResolvedValue({
        success: true,
        output: { status: "done", message: "", evidence: [], blockers: [] },
        finalText: JSON.stringify({ finalAnswer: { summary: "This body came from finalText." } }),
        stopReason: "completed",
        traceId: "trace-1",
        sessionId: "session-1",
        turnId: "turn-1",
        modelTurns: 1,
        toolCalls: 0,
        usage: undefined,
        compactions: 0,
        changedFiles: [],
        toolResults: [],
        commandResults: [],
      }),
    } as unknown as BoundedAgentLoopRunner;
    const modelClient = {
      getModelInfo: vi.fn().mockResolvedValue(modelInfo),
    } as unknown as AgentLoopModelClient;
    const modelRegistry = {
      defaultModel: vi.fn().mockResolvedValue(modelInfo.ref),
    } as unknown as AgentLoopModelRegistry;
    const runner = new ChatAgentLoopRunner({ boundedRunner, modelClient, modelRegistry });

    const result = await runner.execute({ message: "test" });

    expect(result.success).toBe(true);
    expect(result.output).toBe("This body came from finalText.");
    expect(result.output).not.toContain("finalAnswer");
  });

  it("does not display unwrappable JSON objects as normal chat text", async () => {
    const { runner } = makeRunner({
      status: "done",
      message: JSON.stringify({ detail: "internal shape" }),
      evidence: [],
      blockers: [],
    });

    const result = await runner.execute({ message: "test" });

    expect(result.success).toBe(true);
    expect(result.output).toBe("(no response)");
    expect(result.output).not.toContain("internal shape");
    expect(result.output).not.toContain("{");
  });

  it("keeps raw JSON final text in display mode when it is the answer body", async () => {
    const finalText = JSON.stringify({ foo: "bar" });
    const { runner } = makeRunner(null, finalText);

    const result = await runner.execute({ message: "Return JSON." });

    expect(result.success).toBe(true);
    expect(result.output).toBe(finalText);
    expect(result.structuredOutput).toBeUndefined();
  });

  it("does not surface fabricated success after an approval-denied side-effect tool was not executed", async () => {
    const { runner } = makeRunner(
      null,
      "I restarted the daemon and reproduced the EPERM error.",
      [{
        toolName: "dangerous_side_effect",
        command: "restart-service",
        cwd: "/tmp",
        success: false,
        execution: {
          status: "not_executed",
          reason: "approval_denied",
          message: "Side-effect tool requires approval.",
        },
        category: "other",
        evidenceEligible: false,
        outputSummary: "TOOL NOT EXECUTED (approval_denied): Side-effect tool requires approval.",
        durationMs: 1,
      }],
    );

    const result = await runner.execute({ message: "restart it" });

    expect(result.success).toBe(true);
    expect(result.output).toContain("Approval was denied");
    expect(result.output).toContain("operation was not executed");
    expect(result.output).not.toContain("restarted the daemon");
    expect(result.output).not.toContain("EPERM");
  });

  it("still returns genuine executed command failures for model summarization", async () => {
    const finalText = "The command executed and failed with stderr: EPERM.";
    const { runner } = makeRunner(
      null,
      finalText,
      [{
        toolName: "generic_side_effect",
        command: "restart-service",
        cwd: "/tmp",
        success: false,
        execution: { status: "executed" },
        category: "other",
        evidenceEligible: false,
        outputSummary: "stderr: EPERM",
        durationMs: 1,
      }],
    );

    const result = await runner.execute({ message: "restart it" });

    expect(result.success).toBe(true);
    expect(result.output).toBe(finalText);
  });

  it("guards approval-denied non-command tools that do not appear in command results", async () => {
    const { runner } = makeRunner(
      null,
      "I completed the side effect.",
      [],
      [{
        toolName: "spawn-session",
        success: false,
        execution: {
          status: "not_executed",
          reason: "approval_denied",
          message: "Session mutation requires approval.",
        },
        outputSummary: "TOOL NOT EXECUTED (approval_denied): Session mutation requires approval.",
        durationMs: 1,
      }],
    );

    const result = await runner.execute({ message: "start a new session" });

    expect(result.output).toContain("Approval was denied");
    expect(result.output).toContain("operation was not executed");
    expect(result.output).not.toContain("completed the side effect");
  });

  it("keeps deterministic executed-result summaries when a denied tool also occurred", async () => {
    const { runner } = makeRunner(
      null,
      "Everything was restarted successfully.",
      [],
      [{
        toolName: "side_effect_tool",
        success: false,
        execution: {
          status: "not_executed",
          reason: "approval_denied",
          message: "Restart requires approval.",
        },
        outputSummary: "TOOL NOT EXECUTED (approval_denied): Restart requires approval.",
        durationMs: 1,
      }, {
        toolName: "status_reader",
        success: true,
        execution: { status: "executed" },
        outputSummary: "status is running",
        durationMs: 1,
      }],
    );

    const result = await runner.execute({ message: "restart and check status" });

    expect(result.output).toContain("operation was not executed");
    expect(result.output).toContain("Executed tool results:");
    expect(result.output).toContain("status_reader succeeded: status is running");
    expect(result.output).not.toContain("Everything was restarted successfully");
  });

  it("forwards typed bounded-runner failure reasons through native chat results", async () => {
    const modelInfo = makeModelInfo();
    const boundedRunner = {
      run: vi.fn().mockResolvedValue({
        success: false,
        output: null,
        finalText: "provider text for display",
        stopReason: "fatal_error",
        failureReason: "provider_failure",
        failureDetail: "localized provider detail",
        traceId: "trace-1",
        sessionId: "session-1",
        turnId: "turn-1",
        modelTurns: 1,
        toolCalls: 0,
        usage: undefined,
        compactions: 0,
        changedFiles: [],
        toolResults: [],
        commandResults: [],
      }),
    } as unknown as BoundedAgentLoopRunner;
    const modelClient = {
      getModelInfo: vi.fn().mockResolvedValue(modelInfo),
    } as unknown as AgentLoopModelClient;
    const modelRegistry = {
      defaultModel: vi.fn().mockResolvedValue(modelInfo.ref),
    } as unknown as AgentLoopModelRegistry;
    const runner = new ChatAgentLoopRunner({ boundedRunner, modelClient, modelRegistry });

    const result = await runner.execute({ message: "test" });

    expect(result.success).toBe(false);
    expect(result.agentLoop?.failureReason).toBe("provider_failure");
    expect(result.agentLoop?.failureDetail).toBe("localized provider detail");
  });

  it("keeps setup error text display-only unless structured timeout fields are present", async () => {
    const modelInfo = makeModelInfo();
    const boundedRunner = {
      run: vi.fn(),
    } as unknown as BoundedAgentLoopRunner;
    const modelClient = {
      getModelInfo: vi.fn().mockResolvedValue(modelInfo),
    } as unknown as AgentLoopModelClient;
    const modelRegistry = {
      defaultModel: vi.fn().mockRejectedValue(new Error("timeout-looking provider text")),
    } as unknown as AgentLoopModelRegistry;
    const runner = new ChatAgentLoopRunner({ boundedRunner, modelClient, modelRegistry });

    const result = await runner.execute({ message: "test" });

    expect(result.success).toBe(false);
    expect(result.stopped_reason).toBe("error");
    expect(result.agentLoop?.stopReason).toBe("fatal_error");
    expect(result.agentLoop?.failureReason).toBe("provider_failure");
    expect(result.output).toContain("model request failed");
    expect(boundedRunner.run).not.toHaveBeenCalled();
  });

  it("maps structured setup timeout fields to typed timeout failure", async () => {
    const modelInfo = makeModelInfo();
    const timeoutError = new Error("provider response did not arrive");
    timeoutError.name = "TimeoutError";
    const boundedRunner = {
      run: vi.fn(),
    } as unknown as BoundedAgentLoopRunner;
    const modelClient = {
      getModelInfo: vi.fn().mockResolvedValue(modelInfo),
    } as unknown as AgentLoopModelClient;
    const modelRegistry = {
      defaultModel: vi.fn().mockRejectedValue(timeoutError),
    } as unknown as AgentLoopModelRegistry;
    const runner = new ChatAgentLoopRunner({ boundedRunner, modelClient, modelRegistry });

    const result = await runner.execute({ message: "test" });

    expect(result.success).toBe(false);
    expect(result.stopped_reason).toBe("timeout");
    expect(result.agentLoop?.stopReason).toBe("timeout");
    expect(result.agentLoop?.failureReason).toBe("model_request_timeout");
    expect(result.output).toContain("codex_timeout_ms");
    expect(boundedRunner.run).not.toHaveBeenCalled();
  });

  it("biases chat mode prompts toward display markdown by default", () => {
    const chatPrompt = buildAgentLoopBaseInstructions({ mode: "chat" });
    const taskPrompt = buildAgentLoopBaseInstructions({ mode: "task" });
    const structuredPrompt = buildChatStructuredOutputInstructions();

    expect(chatPrompt).toContain("user-visible Markdown");
    expect(chatPrompt).toContain("Do not wrap the final answer in JSON");
    expect(chatPrompt).toContain("short headings and bullets");
    expect(chatPrompt).toContain("Emit short user-facing commentary");
    expect(chatPrompt).toContain("before edits");
    expect(chatPrompt).toContain("before verification");
    expect(chatPrompt).toContain("Do not summarize tool output as commentary");
    expect(chatPrompt).not.toContain("finalAnswer");
    expect(taskPrompt).not.toContain("Do not wrap the final answer in JSON");
    expect(structuredPrompt).toContain("Return only JSON");
    expect(structuredPrompt).toContain("requested schema");
  });
});
