import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defaultExecutionPolicy } from "../../../orchestrator/execution/agent-loop/execution-policy.js";
import type { ITool, ToolCallContext, ToolResult } from "../../../tools/types.js";
import {
  buildChatModelRequest,
} from "../model-request-builder.js";
import {
  buildChatTurnContext,
  type ChatTurnContext,
} from "../turn-context.js";
import { createTextUserInput } from "../user-input.js";

function makeTurnContext(): ChatTurnContext {
  return buildChatTurnContext({
    eventContext: { runId: "run-model", turnId: "turn-model" },
    startedAt: new Date("2026-05-06T08:30:00.000Z"),
    timezone: "Asia/Tokyo",
    sessionId: "session-model",
    cwd: "/repo",
    gitRoot: "/repo",
    executionCwd: "/repo",
    nativeAgentLoopStatePath: "chat/agentloop/session-model.state.json",
    selectedRoute: {
      kind: "gateway_model_loop",
      reason: "direct_model_tool_loop",
      replyTargetPolicy: "turn_reply_target",
      eventProjectionPolicy: "turn_only",
      concurrencyPolicy: "session_serial",
    },
    input: "Check the workspace state",
    userInput: createTextUserInput("Check the workspace state"),
    priorTurns: [
      { role: "user", content: "Earlier question", timestamp: "2026-05-06T08:29:00.000Z", turnIndex: 0 },
      { role: "assistant", content: "Earlier answer", timestamp: "2026-05-06T08:29:01.000Z", turnIndex: 1 },
    ],
    basePrompt: "Check the workspace state",
    prompt: "Previous conversation:\nUser: Earlier question\nAssistant: Earlier answer\n\nCurrent message:\nCheck the workspace state",
    systemPrompt: "Base instructions",
    agentLoopSystemPrompt: "Agent loop instructions",
    runtimeControlContext: null,
    executionPolicy: defaultExecutionPolicy("/repo"),
    setupDialogue: null,
    runSpecConfirmation: null,
    setupSecretIntake: null,
    activatedTools: new Set(),
  });
}

function makeTool(name: string): ITool {
  return {
    metadata: {
      name,
      aliases: [],
      permissionLevel: "read_only",
      isReadOnly: true,
      isDestructive: false,
      shouldDefer: false,
      alwaysLoad: false,
      maxConcurrency: 0,
      maxOutputChars: 4000,
      tags: [],
    },
    inputSchema: z.object({
      scope: z.enum(["workspace", "session"]),
    }),
    description: () => "Read typed workspace status.",
    call: vi.fn(async (_input: unknown, _context: ToolCallContext): Promise<ToolResult> => ({
      success: true,
      data: null,
      summary: "ok",
      durationMs: 1,
    })),
    checkPermissions: vi.fn().mockResolvedValue({ status: "allowed" }),
    isConcurrencySafe: () => true,
  } as unknown as ITool;
}

describe("buildChatModelRequest", () => {
  it("builds ordinary chat requests without requiring schema-shaped final JSON", () => {
    const request = buildChatModelRequest({
      purpose: "ordinary_chat",
      turnContext: makeTurnContext(),
      systemPrompt: "Answer normally.",
    });

    expect(request.purpose).toBe("ordinary_chat");
    expect(request.toolMode).toBe("none");
    expect(request.structuredOutput).toEqual({
      finalJsonRequired: false,
      reason: "ordinary_text",
    });
    expect(request.toolDefinitions).toEqual([]);
    expect(request.options.tools).toBeUndefined();
    expect(request.options.system).toContain("## Turn Context");
    expect(request.options.system).not.toContain("Return only JSON");
    expect(request.messages).toEqual([
      { role: "user", content: "Earlier question" },
      { role: "assistant", content: "Earlier answer" },
      { role: "user", content: "Check the workspace state" },
    ]);
  });

  it("builds native tool-call requests from typed tool schemas", () => {
    const request = buildChatModelRequest({
      purpose: "tool_call",
      turnContext: makeTurnContext(),
      systemPrompt: "Use tools when needed.",
      availableTools: [makeTool("workspace_status")],
      supportsNativeToolCalling: true,
    });

    expect(request.toolMode).toBe("native");
    expect(request.structuredOutput).toEqual({
      finalJsonRequired: false,
      reason: "native_tool_calls",
    });
    expect(request.options.tools?.[0]).toMatchObject({
      type: "function",
      function: {
        name: "workspace_status",
        description: "Read typed workspace status.",
      },
    });
    expect(request.options.tools?.[0]?.function.parameters).toMatchObject({
      type: "object",
      properties: {
        scope: expect.objectContaining({ enum: ["workspace", "session"] }),
      },
      required: ["scope"],
    });
    expect(request.options.system).toContain("## Turn Context");
    expect(request.options.system).not.toContain("return exactly one JSON object");
  });

  it("keeps prompted tool JSON mode explicit for clients without native tool calling", () => {
    const request = buildChatModelRequest({
      purpose: "tool_call",
      turnContext: makeTurnContext(),
      systemPrompt: "Use tools when needed.",
      availableTools: [makeTool("workspace_status")],
      supportsNativeToolCalling: false,
    });

    expect(request.toolMode).toBe("prompted");
    expect(request.structuredOutput).toEqual({
      finalJsonRequired: true,
      reason: "prompted_tool_protocol",
    });
    expect(request.options.tools).toBeUndefined();
    expect(request.options.system).toContain("workspace_status");
    expect(request.options.system).toContain("return exactly one JSON object");
  });
});
