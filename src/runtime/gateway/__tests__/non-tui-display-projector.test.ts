import { describe, expect, it, vi } from "vitest";
import type { ChatEvent } from "../../../interface/chat/chat-events.js";
import {
  LIMITED_GATEWAY_DISPLAY_CAPABILITIES,
  TELEGRAM_GATEWAY_DISPLAY_CONTRACT,
  createGatewayDisplayPolicy,
  resolveGatewayChannelDisplayContract,
} from "../channel-display-policy.js";
import { NonTuiDisplayProjector, type NonTuiDisplayTransport } from "../non-tui-display-projector.js";

const base = {
  runId: "run-1",
  turnId: "turn-1",
  createdAt: "2026-05-07T00:00:00.000Z",
};

const timelineBase = {
  id: "timeline-item-1",
  sourceEventId: "timeline-1",
  sourceType: "tool_call_finished" as const,
  sessionId: "session-1",
  traceId: "trace-1",
  turnId: "turn-1",
  goalId: "goal-1",
  createdAt: base.createdAt,
  visibility: "user" as const,
};

function createTransport(): NonTuiDisplayTransport & { calls: string[] } {
  let nextId = 0;
  const calls: string[] = [];
  return {
    calls,
    sendProgress: vi.fn(async (text: string) => {
      calls.push(`sendProgress:${text}`);
      nextId += 1;
      return { id: `progress-${nextId}` };
    }),
    editProgress: vi.fn(async (_ref, text: string) => {
      calls.push(`editProgress:${text}`);
    }),
    deleteProgress: vi.fn(async () => {
      calls.push("deleteProgress");
    }),
    sendFinal: vi.fn(async (text: string) => {
      calls.push(`sendFinal:${text}`);
      nextId += 1;
      return { id: `final-${nextId}` };
    }),
    editFinal: vi.fn(async (_ref, text: string) => {
      calls.push(`editFinal:${text}`);
    }),
  };
}

describe("non-TUI display projector", () => {
  it("updates one progress surface for tool, activity, timeline, and operation events", async () => {
    const transport = createTransport();
    const projector = new NonTuiDisplayProjector({
      display: resolveGatewayChannelDisplayContract(TELEGRAM_GATEWAY_DISPLAY_CONTRACT),
      transport,
    });

    await projector.handle({ ...base, type: "tool_start", toolCallId: "tool-1", toolName: "rg", args: {} });
    await projector.handle({
      ...base,
      type: "activity",
      kind: "checkpoint",
      message: "Approval needed",
      sourceId: "approval:tool-1",
      presentation: { gatewayProgress: "user" },
    });
    await projector.handle({
      ...base,
      type: "operation_progress",
      item: {
        id: "operation-1",
        kind: "checked_status",
        operation: "gateway",
        title: "Checked gateway status",
        createdAt: base.createdAt,
      },
    });
    await projector.handle({
      ...base,
      type: "agent_timeline",
      item: {
        ...timelineBase,
        kind: "tool",
        status: "finished",
        callId: "tool-1",
        toolName: "rg",
        success: true,
        outputPreview: "found files",
      },
    });

    expect(transport.sendProgress).toHaveBeenCalledTimes(1);
    expect(transport.editProgress).toHaveBeenCalledTimes(3);
    expect(transport.sendFinal).not.toHaveBeenCalled();
    expect(transport.calls.join("\n")).toContain("Approval needed");
    expect(transport.calls.at(-1)).toContain("Finished rg: found files");
  });

  it("does not expose internal lifecycle progress while streaming assistant output", async () => {
    const transport = createTransport();
    const projector = new NonTuiDisplayProjector({
      display: resolveGatewayChannelDisplayContract(TELEGRAM_GATEWAY_DISPLAY_CONTRACT),
      transport,
    });

    await projector.handle({ ...base, type: "activity", kind: "lifecycle", message: "Started" });
    await projector.handle({ ...base, type: "assistant_delta", delta: "Hel", text: "Hel" });
    await projector.handle({ ...base, type: "assistant_delta", delta: "lo", text: "Hello" });
    await projector.handle({ ...base, type: "assistant_final", text: "Hello", persisted: true });

    expect(transport.sendProgress).not.toHaveBeenCalled();
    expect(transport.sendFinal).toHaveBeenCalledOnce();
    expect(transport.editFinal).toHaveBeenCalledOnce();
    expect(transport.editFinal).toHaveBeenCalledWith({ id: "final-1" }, "Hello");
  });

  it("deletes completed progress when the policy supports cleanup", async () => {
    const transport = createTransport();
    const projector = new NonTuiDisplayProjector({
      display: resolveGatewayChannelDisplayContract(TELEGRAM_GATEWAY_DISPLAY_CONTRACT),
      transport,
    });

    await projector.handle({ ...base, type: "activity", kind: "tool", message: "Running rg" });
    await projector.handle({ ...base, type: "assistant_final", text: "Done", persisted: true });
    await projector.handle({ ...base, type: "lifecycle_end", status: "completed", elapsedMs: 1, persisted: true });

    expect(transport.deleteProgress).toHaveBeenCalledOnce();
  });

  it("suppresses unchanged progress and final edits", async () => {
    const transport = createTransport();
    const projector = new NonTuiDisplayProjector({
      display: resolveGatewayChannelDisplayContract(TELEGRAM_GATEWAY_DISPLAY_CONTRACT),
      transport,
    });
    const event: ChatEvent = { ...base, type: "activity", kind: "tool", message: "Running rg", sourceId: "status" };

    await projector.handle(event);
    await projector.handle(event);
    await projector.handle({ ...base, type: "assistant_delta", delta: "Done", text: "Done" });
    await projector.handle({ ...base, type: "assistant_final", text: "Done", persisted: true });

    expect(transport.sendProgress).toHaveBeenCalledOnce();
    expect(transport.editProgress).not.toHaveBeenCalled();
    expect(transport.sendFinal).toHaveBeenCalledOnce();
    expect(transport.editFinal).not.toHaveBeenCalled();
  });

  it("falls back on limited channels without progress fanout and chunks final output", async () => {
    const transport = createTransport();
    const projector = new NonTuiDisplayProjector({
      display: {
        capabilities: {
          ...LIMITED_GATEWAY_DISPLAY_CAPABILITIES,
          maxMessageLength: 5,
        },
        policy: createGatewayDisplayPolicy({
          ...LIMITED_GATEWAY_DISPLAY_CAPABILITIES,
          maxMessageLength: 5,
        }),
      },
      transport,
    });

    await projector.handle({ ...base, type: "activity", kind: "tool", message: "Tool activity" });
    await projector.handle({ ...base, type: "tool_start", toolCallId: "tool-1", toolName: "rg", args: {} });
    await projector.handle({ ...base, type: "assistant_final", text: "Hello world", persisted: true });

    expect(transport.sendProgress).not.toHaveBeenCalled();
    expect(transport.editProgress).not.toHaveBeenCalled();
    expect(transport.sendFinal).toHaveBeenCalledTimes(3);
    expect(transport.calls).toEqual([
      "sendFinal:Hello",
      "sendFinal: worl",
      "sendFinal:d",
    ]);
  });

  it("does not render debug-only timeline items", async () => {
    const transport = createTransport();
    const projector = new NonTuiDisplayProjector({
      display: resolveGatewayChannelDisplayContract(TELEGRAM_GATEWAY_DISPLAY_CONTRACT),
      transport,
    });

    await projector.handle({
      ...base,
      type: "agent_timeline",
      item: {
        ...timelineBase,
        visibility: "debug",
        kind: "tool_observation",
        callId: "tool-1",
        toolName: "rg",
        state: "success",
        success: true,
        outputPreview: "debug-only output",
        durationMs: 1,
        observation: {
          type: "tool_observation",
          callId: "tool-1",
          toolName: "rg",
          arguments: {},
          state: "success",
          success: true,
          durationMs: 1,
          output: { content: "debug-only output" },
        },
      },
    });

    expect(transport.sendProgress).not.toHaveBeenCalled();
    expect(transport.editProgress).not.toHaveBeenCalled();
    expect(transport.calls.join("\n")).not.toContain("debug-only output");
  });

  it("does not render internal runner lifecycle, model context, or commentary to gateway progress", async () => {
    const transport = createTransport();
    const projector = new NonTuiDisplayProjector({
      display: resolveGatewayChannelDisplayContract(TELEGRAM_GATEWAY_DISPLAY_CONTRACT),
      transport,
    });

    await projector.handle({ ...base, type: "activity", kind: "commentary", message: "I understand the request.", sourceId: "intent:first-step" });
    await projector.handle({ ...base, type: "activity", kind: "lifecycle", message: "Calling model...", sourceId: "lifecycle:model" });
    await projector.handle({ ...base, type: "activity", kind: "checkpoint", message: "Working turn started", sourceId: "checkpoint:execution" });
    await projector.handle({
      ...base,
      type: "agent_timeline",
      item: {
        ...timelineBase,
        sourceEventId: "started-1",
        sourceType: "started",
        kind: "lifecycle",
        status: "started",
      },
    });
    await projector.handle({
      ...base,
      type: "agent_timeline",
      item: {
        ...timelineBase,
        sourceEventId: "turn-context-1",
        sourceType: "turn_context",
        kind: "turn_context",
        cwd: "/Users/yuyoshimuta/PulSeed",
        model: "openai/gpt-5.5",
        visibleTools: ["shell_command", "apply_patch"],
      },
    });
    await projector.handle({
      ...base,
      type: "agent_timeline",
      item: {
        ...timelineBase,
        sourceEventId: "model-request-1",
        sourceType: "model_request",
        kind: "model_request",
        model: "openai/gpt-5.5",
        toolCount: 54,
      },
    });
    await projector.handle({
      ...base,
      type: "agent_timeline",
      item: {
        ...timelineBase,
        sourceEventId: "assistant-commentary-1",
        sourceType: "assistant_message",
        kind: "assistant_message",
        phase: "commentary",
        text: "Reviewing the timeline path.",
        toolCallCount: 1,
      },
    });

    expect(transport.sendProgress).not.toHaveBeenCalled();
    expect(transport.editProgress).not.toHaveBeenCalled();
    expect(transport.calls.join("\n")).not.toContain("openai/gpt");
  });
});
