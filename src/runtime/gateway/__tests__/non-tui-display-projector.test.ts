import { describe, expect, it, vi } from "vitest";
import type { ChatEvent } from "../../../interface/chat/chat-events.js";
import {
  SurfaceDeliveryProjectionSchema,
  ref,
  type SurfaceDeliveryProjection,
} from "../../attention/index.js";
import {
  LIMITED_GATEWAY_DISPLAY_CAPABILITIES,
  TELEGRAM_GATEWAY_DISPLAY_CONTRACT,
  createGatewayDisplayPolicy,
  resolveGatewayChannelDisplayContract,
} from "../channel-display-policy.js";
import { NonTuiDisplayProjector, type NonTuiDisplayTransport } from "../non-tui-display-projector.js";
import type { GatewayChannelCapabilityAdmissionRecord } from "../gateway-channel-capability-admission.js";

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

function surfaceDelivery(input: {
  deliveryId: string;
  shouldRender: boolean;
  text?: string;
  reason?: string;
  auditRefs?: SurfaceDeliveryProjection["audit_refs"];
}): SurfaceDeliveryProjection {
  return SurfaceDeliveryProjectionSchema.parse({
    schema_version: "surface-delivery-projection-v1",
    delivery_id: input.deliveryId,
    rendered_at: base.createdAt,
    surface_class: "gateway",
    delivery_kind: input.shouldRender ? "express_to_user" : "silence",
    delivery_mode: input.shouldRender ? "body_message" : "quiet_audit",
    outcome_decision_ref: ref("outcome_decision", `outcome:${input.deliveryId}`),
    admission_status: "admitted",
    should_render: input.shouldRender,
    ...(input.shouldRender
      ? { user_facing_text: input.text ?? "Shared delivery text" }
      : { quiet_audit_reason: input.reason ?? "surface delivery is hidden by policy" }),
    audit_refs: input.auditRefs ?? [],
  });
}

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
  it("records descriptor admission before sending gateway display output", async () => {
    const transport = createTransport();
    const order: string[] = [];
    const recorder = vi.fn(async (record: GatewayChannelCapabilityAdmissionRecord) => {
      order.push(`record:${record.reportType}:${record.admission.status}`);
    });
    const projector = new NonTuiDisplayProjector({
      display: resolveGatewayChannelDisplayContract(TELEGRAM_GATEWAY_DISPLAY_CONTRACT),
      transport: {
        ...transport,
        sendFinal: vi.fn(async (text: string) => {
          order.push(`sendFinal:${text}`);
          return transport.sendFinal(text);
        }),
      },
      channelType: "telegram",
      capabilityDecisionRecorder: recorder,
    });

    await projector.handle({ ...base, type: "assistant_final", text: "hello", persisted: true });

    expect(order).toEqual(["record:final_send:allowed", "sendFinal:hello"]);
    expect(recorder).toHaveBeenCalledWith(expect.objectContaining({
      channelType: "telegram",
      reportType: "final_send",
      descriptor: expect.objectContaining({
        provider_kind: "gateway_channel_action",
        runtime_graph_refs: expect.objectContaining({
          capability_ref: "capability:gateway_channel_action:telegram:final_send",
        }),
      }),
      admission: expect.objectContaining({
        status: "allowed",
        capability_fingerprint: expect.any(String),
      }),
    }));
  });

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
    expect(transport.calls.at(-1)).toContain("Finalizing the tool-backed step so I can gather the result needed for the next step.");
    expect(transport.calls.join("\n")).not.toContain("found files");
  });

  it("streams partial assistant deltas immediately on the final-answer surface", async () => {
    const transport = createTransport();
    const projector = new NonTuiDisplayProjector({
      display: resolveGatewayChannelDisplayContract(TELEGRAM_GATEWAY_DISPLAY_CONTRACT),
      transport,
    });

    await projector.handle({ ...base, type: "activity", kind: "lifecycle", message: "Started" });
    await projector.handle({ ...base, type: "assistant_delta", delta: "Hel", text: "Hel" });
    await projector.handle({ ...base, type: "assistant_delta", delta: "lo", text: "Hello" });
    await projector.handle({ ...base, type: "assistant_final", text: "Hello", persisted: true });

    expect(transport.sendFinal).toHaveBeenCalledOnce();
    expect(transport.sendFinal).toHaveBeenCalledWith("Hel");
    expect(transport.editFinal).toHaveBeenCalledWith({ id: "final-1" }, "Hello");
    expect(transport.sendProgress).not.toHaveBeenCalled();
  });

  it("renders admitted surface delivery through the Telegram-shaped non-TUI final surface", async () => {
    const transport = createTransport();
    const projector = new NonTuiDisplayProjector({
      display: {
        capabilities: TELEGRAM_GATEWAY_DISPLAY_CONTRACT.capabilities,
        policy: {
          ...createGatewayDisplayPolicy(TELEGRAM_GATEWAY_DISPLAY_CONTRACT.capabilities),
          progressSurface: "editable",
          finalSurface: "edit_stream",
          cleanupPolicy: "collapse",
        },
      },
      transport,
    });

    await projector.handle({
      ...base,
      type: "surface_delivery",
      projection: surfaceDelivery({
        deliveryId: "surface-delivery:telegram:express",
        shouldRender: true,
        text: "The admitted outcome is ready.",
      }),
    });

    expect(transport.sendFinal).toHaveBeenCalledOnce();
    expect(transport.sendFinal).toHaveBeenCalledWith("The admitted outcome is ready.");
    expect(transport.sendProgress).not.toHaveBeenCalled();
    expect(projector.deliveredAssistantOutput).toBe(true);
  });

  it("renders only the admitted user-facing projection and never audit refs on non-TUI gateway channels", async () => {
    const transport = createTransport();
    const projector = new NonTuiDisplayProjector({
      display: resolveGatewayChannelDisplayContract(TELEGRAM_GATEWAY_DISPLAY_CONTRACT),
      transport,
    });

    await projector.handle({
      ...base,
      type: "surface_delivery",
      projection: surfaceDelivery({
        deliveryId: "surface-delivery:telegram:redaction",
        shouldRender: true,
        text: "The status update is ready.",
        auditRefs: [
          ref("audit_trace", "evidence:raw"),
          ref("policy", "policy:deny"),
        ],
      }),
    });

    expect(transport.sendFinal).toHaveBeenCalledWith("The status update is ready.");
    expect(transport.calls.join("\n")).not.toContain("evidence:raw");
    expect(transport.calls.join("\n")).not.toContain("policy:deny");
  });

  it("keeps quiet or hidden surface deliveries silent on Telegram-shaped non-TUI channels", async () => {
    const transport = createTransport();
    const projector = new NonTuiDisplayProjector({
      display: resolveGatewayChannelDisplayContract(TELEGRAM_GATEWAY_DISPLAY_CONTRACT),
      transport,
    });

    await projector.handle({
      ...base,
      type: "surface_delivery",
      projection: surfaceDelivery({
        deliveryId: "surface-delivery:telegram:silence",
        shouldRender: false,
        reason: "admitted outcome intentionally stays silent",
      }),
    });
    await projector.handle({
      ...base,
      type: "surface_delivery",
      projection: surfaceDelivery({
        deliveryId: "surface-delivery:telegram:hidden",
        shouldRender: false,
        reason: "surface delivery is hidden by the admitted visibility policy",
      }),
    });

    expect(transport.sendFinal).not.toHaveBeenCalled();
    expect(transport.sendProgress).not.toHaveBeenCalled();
    expect(projector.renderedAssistantOutput).toBe(true);
    expect(projector.deliveredAssistantOutput).toBe(false);
  });

  it("streams assistant chunks through one final-answer surface immediately", async () => {
    const transport = createTransport();
    const projector = new NonTuiDisplayProjector({
      display: resolveGatewayChannelDisplayContract(TELEGRAM_GATEWAY_DISPLAY_CONTRACT),
      transport,
    });

    await projector.handle({ ...base, type: "assistant_delta", delta: "Hello", text: "Hello" });
    await projector.handle({ ...base, type: "assistant_delta", delta: ". ", text: "Hello. " });
    await projector.handle({ ...base, type: "assistant_delta", delta: "Working", text: "Hello. Working" });
    await projector.handle({ ...base, type: "assistant_final", text: "Hello. Working now.", persisted: true });

    expect(transport.sendFinal).toHaveBeenCalledOnce();
    expect(transport.sendFinal).toHaveBeenCalledWith("Hello");
    expect(transport.editFinal).toHaveBeenCalledOnce();
    expect(transport.editFinal).toHaveBeenCalledWith({ id: "final-1" }, "Hello. Working now.");
    expect(transport.calls.filter((call) => call.startsWith("sendFinal:"))).toHaveLength(1);
  });

  it("does not render fixed lifecycle progress for ordinary gateway chat", async () => {
    const transport = createTransport();
    const projector = new NonTuiDisplayProjector({
      display: resolveGatewayChannelDisplayContract(TELEGRAM_GATEWAY_DISPLAY_CONTRACT),
      transport,
    });

    await projector.handle({
      ...base,
      type: "activity",
      kind: "lifecycle",
      message: "Calling model...",
      sourceId: "lifecycle:model",
    });

    expect(transport.sendProgress).not.toHaveBeenCalled();
    expect(projector.deliveredProgressOutput).toBe(false);
  });

  it("still renders real tool progress for gateway chat", async () => {
    const transport = createTransport();
    const projector = new NonTuiDisplayProjector({
      display: resolveGatewayChannelDisplayContract(TELEGRAM_GATEWAY_DISPLAY_CONTRACT),
      transport,
    });

    await projector.handle({
      ...base,
      type: "tool_start",
      toolCallId: "call-1",
      toolName: "read",
      args: { file_path: "README.md" },
      activityCategory: "read",
    });

    expect(transport.sendProgress).toHaveBeenCalledOnce();
    expect(projector.deliveredProgressOutput).toBe(true);
  });

  it("does not cut complete fenced code blocks into unclosed partial final text", async () => {
    const transport = createTransport();
    const projector = new NonTuiDisplayProjector({
      display: resolveGatewayChannelDisplayContract(TELEGRAM_GATEWAY_DISPLAY_CONTRACT),
      transport,
    });
    const codeBlock = "```ts\nconst ready = true;\n```";

    await projector.handle({ ...base, type: "assistant_delta", delta: codeBlock, text: codeBlock });

    expect(transport.sendFinal).toHaveBeenCalledOnce();
    expect(transport.sendFinal).toHaveBeenCalledWith(codeBlock);
    expect(transport.sendFinal).not.toHaveBeenCalledWith("```ts\nconst ready = true;");
  });

  it("deletes completed progress when the policy supports cleanup", async () => {
    const transport = createTransport();
    const projector = new NonTuiDisplayProjector({
      display: resolveGatewayChannelDisplayContract(TELEGRAM_GATEWAY_DISPLAY_CONTRACT),
      transport,
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
    await projector.handle({ ...base, type: "assistant_final", text: "Done.", persisted: true });
    await projector.handle({ ...base, type: "lifecycle_end", status: "completed", elapsedMs: 1, persisted: true });

    expect(transport.deleteProgress).toHaveBeenCalledOnce();
  });

  it("keeps immediate user-visible commentary perceptible when progress cleanup collapses", async () => {
    const transport = createTransport();
    const projector = new NonTuiDisplayProjector({
      display: {
        capabilities: TELEGRAM_GATEWAY_DISPLAY_CONTRACT.capabilities,
        policy: {
          ...createGatewayDisplayPolicy(TELEGRAM_GATEWAY_DISPLAY_CONTRACT.capabilities),
          progressSurface: "editable",
          finalSurface: "edit_stream",
          cleanupPolicy: "collapse",
        },
      },
      transport,
    });

    await projector.handle({
      ...base,
      type: "activity",
      kind: "commentary",
      message: "I will check the request before answering.",
      sourceId: "model-commentary:turn-1",
      presentation: { gatewayProgress: "user" },
    });
    await projector.handle({ ...base, type: "assistant_final", text: "Blocked final.", persisted: true });
    await projector.handle({ ...base, type: "lifecycle_end", status: "completed", elapsedMs: 12, persisted: true });

    expect(transport.sendProgress).toHaveBeenCalledOnce();
    expect(transport.sendFinal).toHaveBeenCalledWith("Blocked final.");
    expect(transport.deleteProgress).not.toHaveBeenCalled();
    expect(transport.editProgress).not.toHaveBeenCalledWith({ id: "progress-1" }, "Completed.");
    expect(projector.deliveredProgressOutput).toBe(true);
  });

  it("does not render progress after the final-answer surface is visible", async () => {
    const transport = createTransport();
    const projector = new NonTuiDisplayProjector({
      display: {
        capabilities: TELEGRAM_GATEWAY_DISPLAY_CONTRACT.capabilities,
        policy: {
          ...createGatewayDisplayPolicy(TELEGRAM_GATEWAY_DISPLAY_CONTRACT.capabilities),
          progressSurface: "editable",
          finalSurface: "edit_stream",
          cleanupPolicy: "collapse",
        },
      },
      transport,
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
    await projector.handle({ ...base, type: "assistant_delta", delta: "Done.", text: "Done." });
    await projector.handle({
      ...base,
      type: "operation_progress",
      item: {
        id: "operation-late",
        kind: "checked_status",
        operation: "gateway",
        title: "Late status after final",
        createdAt: base.createdAt,
      },
    });
    await projector.handle({ ...base, type: "assistant_final", text: "Done.", persisted: true });
    await projector.handle({ ...base, type: "lifecycle_end", status: "completed", elapsedMs: 1, persisted: true });

    expect(transport.calls).toEqual([
      "sendProgress:Checking gateway so I can confirm the current state before changing anything.",
      "sendFinal:Done.",
    ]);
    expect(transport.calls.join("\n")).not.toContain("Late status after final");
  });

  it("suppresses unchanged progress and final edits", async () => {
    const transport = createTransport();
    const projector = new NonTuiDisplayProjector({
      display: resolveGatewayChannelDisplayContract(TELEGRAM_GATEWAY_DISPLAY_CONTRACT),
      transport,
    });
    const event: ChatEvent = {
      ...base,
      type: "operation_progress",
      item: {
        id: "operation-1",
        kind: "checked_status",
        operation: "gateway",
        title: "Checked gateway status",
        createdAt: base.createdAt,
      },
    };

    await projector.handle(event);
    await projector.handle(event);
    await projector.handle({ ...base, type: "assistant_delta", delta: "Done.", text: "Done." });
    await projector.handle({ ...base, type: "assistant_final", text: "Done.", persisted: true });

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
    expect(transport.sendFinal).toHaveBeenCalledTimes(2);
    expect(transport.calls).toEqual([
      "sendFinal:Hello",
      "sendFinal:world",
    ]);
  });

  it("distinguishes buffered assistant text from delivered output on send-once channels", async () => {
    const transport = createTransport();
    const projector = new NonTuiDisplayProjector({
      display: {
        capabilities: {
          ...LIMITED_GATEWAY_DISPLAY_CAPABILITIES,
          maxMessageLength: 4_096,
        },
        policy: createGatewayDisplayPolicy({
          ...LIMITED_GATEWAY_DISPLAY_CAPABILITIES,
          maxMessageLength: 4_096,
        }),
      },
      transport,
    });

    await projector.handle({ ...base, type: "assistant_delta", delta: "Hel", text: "Hel" });

    expect(projector.renderedAssistantOutput).toBe(true);
    expect(projector.deliveredAssistantOutput).toBe(false);

    await projector.handle({ ...base, type: "assistant_final", text: "Hello", persisted: true });

    expect(projector.deliveredAssistantOutput).toBe(true);
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

  it("does not render internal runner lifecycle or model context to gateway progress", async () => {
    const transport = createTransport();
    const projector = new NonTuiDisplayProjector({
      display: resolveGatewayChannelDisplayContract(TELEGRAM_GATEWAY_DISPLAY_CONTRACT),
      transport,
    });

    await projector.handle({ ...base, type: "activity", kind: "lifecycle", message: "Calling model...", sourceId: "lifecycle:model" });
    await projector.handle({ ...base, type: "activity", kind: "checkpoint", message: "Tool activity started", sourceId: "checkpoint:execution" });
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

  it("renders explicitly user-facing commentary as progress, not final output", async () => {
    const transport = createTransport();
    const projector = new NonTuiDisplayProjector({
      display: resolveGatewayChannelDisplayContract(TELEGRAM_GATEWAY_DISPLAY_CONTRACT),
      transport,
    });

    await projector.handle({
      ...base,
      type: "activity",
      kind: "commentary",
      message: "I'll inspect the relevant project context before using tools.",
      sourceId: "preamble:agent_loop:turn-1",
      presentation: { gatewayProgress: "user" },
    });

    expect(transport.sendProgress).toHaveBeenCalledWith("I'll inspect the relevant project context before using tools.");
    expect(transport.sendFinal).not.toHaveBeenCalled();
  });

  it("does not expose assistant final candidates as transient progress", async () => {
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
        sourceEventId: "assistant-final-candidate-1",
        sourceType: "assistant_message",
        kind: "assistant_message",
        phase: "final_candidate",
        text: "Final answer draft",
        toolCallCount: 0,
      },
    });

    expect(transport.sendProgress).not.toHaveBeenCalled();
    expect(transport.editProgress).not.toHaveBeenCalled();
    expect(transport.calls.join("\n")).not.toContain("Finalizing");
  });

  it("renders explicit public narration from typed presentation even when the diagnostic message looks internal", async () => {
    const transport = createTransport();
    const projector = new NonTuiDisplayProjector({
      display: resolveGatewayChannelDisplayContract(TELEGRAM_GATEWAY_DISPLAY_CONTRACT),
      transport,
    });

    await projector.handle({
      ...base,
      type: "activity",
      kind: "lifecycle",
      message: "Calling model with openai/gpt-5.5 and 54 available tool(s).",
      sourceId: "diagnostic:model-request",
      presentation: {
        gatewayNarration: {
          audience: "user",
          phase: "checking",
          importance: "heartbeat",
          verbosity: "summary",
          subject: "the gateway display contract",
          reason: "confirm that user-facing progress is still visible",
          diagnosticRef: "diagnostic:model-request",
        },
      },
    });

    expect(transport.calls.join("\n")).toContain("Checking the gateway display contract so I can confirm that user-facing progress is still visible.");
    expect(transport.calls.join("\n")).not.toContain("Calling model");
    expect(transport.calls.join("\n")).not.toContain("openai/gpt");
    expect(transport.calls.join("\n")).not.toContain("54 available tool");
  });

  it("renders typed waiting status from elapsed activity metadata", async () => {
    const transport = createTransport();
    const projector = new NonTuiDisplayProjector({
      display: resolveGatewayChannelDisplayContract(TELEGRAM_GATEWAY_DISPLAY_CONTRACT),
      transport,
    });

    await projector.handle({
      ...base,
      type: "operation_progress",
      item: {
        id: "wait-1",
        kind: "checked_status",
        operation: "gateway",
        title: "Checked gateway status",
        createdAt: base.createdAt,
        publicProgress: {
          audience: "user",
          phase: "waiting",
          importance: "heartbeat",
          verbosity: "summary",
          subject: "the active process",
          lastActivityLabel: "a test run",
          elapsedMs: 45_000,
        },
      },
    });

    expect(transport.calls.join("\n")).toContain("This is taking longer than usual. The last visible activity was a test run 45 seconds ago, and the process is still active.");
  });

  it("does not fall back to raw operation text when typed public progress is silent", async () => {
    const transport = createTransport();
    const projector = new NonTuiDisplayProjector({
      display: resolveGatewayChannelDisplayContract(TELEGRAM_GATEWAY_DISPLAY_CONTRACT),
      transport,
    });

    await projector.handle({
      ...base,
      type: "operation_progress",
      item: {
        id: "internal-1",
        kind: "checked_status",
        operation: "gateway",
        title: "Prepared turn context with openai/gpt-5.5 and 54 tool(s).",
        createdAt: base.createdAt,
        publicProgress: {
          audience: "internal",
          phase: "checking",
          importance: "heartbeat",
          verbosity: "silent",
          subject: "turn context",
        },
      },
    });

    expect(transport.sendProgress).not.toHaveBeenCalled();
    expect(transport.calls.join("\n")).not.toContain("openai/gpt");
  });
});
