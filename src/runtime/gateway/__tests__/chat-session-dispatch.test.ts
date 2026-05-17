import { afterEach, describe, expect, it } from "vitest";
import { dispatchGatewayChatInput, dispatchGatewayChatInputResult } from "../chat-session-dispatch.js";
import { renderGatewayAgentTimelineItem } from "../chat-event-rendering.js";
import {
  clearRegisteredGatewayChatSessionPort,
  registerGatewayChatSessionPort,
  type GatewayChatDispatchInput,
} from "../chat-session-port.js";
import {
  buildExternalSurfaceDecision,
  evaluateChannelAccess,
  resolveChannelRoute,
} from "../channel-policy.js";
import { createSurfaceProjection, operatorSourceEventRef } from "../../surface-projection-protocol.js";

const baseInput = {
  text: "status?",
  platform: "telegram",
  conversation_id: "chat-1",
  sender_id: "user-1",
};

afterEach(() => {
  clearRegisteredGatewayChatSessionPort();
});

describe("dispatchGatewayChatInput display contract", () => {
  it("projects answer-shaped fallback strings to gateway display text", async () => {
    registerGatewayChatSessionPort(async () => ({
      processIncomingMessage: async () => JSON.stringify({
        answer: "Gateway **Markdown** answer.",
      }),
    }));

    const result = await dispatchGatewayChatInput(baseInput);

    expect(result).toBe("Gateway **Markdown** answer.");
    expect(result).not.toContain("\"answer\"");
  });

  it("preserves plain text fallback objects from gateway session ports", async () => {
    registerGatewayChatSessionPort(async () => ({
      processIncomingMessage: async () => ({ text: "Plain gateway reply." }),
    }));

    await expect(dispatchGatewayChatInput(baseInput)).resolves.toBe("Plain gateway reply.");
  });

  it("formats structured fallback objects without exposing raw schema payloads", async () => {
    registerGatewayChatSessionPort(async () => ({
      processIncomingMessage: async () => ({
        status: "done",
        message: "",
        finalAnswer: {
          summary: "Runtime evidence is current.",
          sections: [{ title: "Checks", bullets: ["Read the active run record."] }],
          evidence: ["run:active matched the selected session"],
          blockers: [],
          nextActions: ["Continue monitoring the run."],
        },
      }),
    }));

    const result = await dispatchGatewayChatInput(baseInput);

    expect(result).toContain("Runtime evidence is current.");
    expect(result).toContain("### Checks");
    expect(result).toContain("### Evidence");
    expect(result).toContain("### Next steps");
    expect(result).not.toContain("\"finalAnswer\"");
  });

  it("redacts raw internal memory, autonomy, policy, capability, and evidence refs on the gateway dispatch path", async () => {
    registerGatewayChatSessionPort(async () => ({
      processIncomingMessage: async () => ({
        status: "done",
        finalAnswer: {
          summary: "The gateway answer is ready.",
          sections: [{
            title: "Checks",
            bullets: [
              "Read the current status projection.",
              "RAW_MEMORY_SLOT autonomy=approval_required readiness=degraded admission=approval_required",
            ],
          }],
          evidence: ["evidence:raw trace:raw", "run:coreloop:raw", "Checked the public status projection."],
          blockers: ["policy:deny capability:notify", "No user action is needed."],
          nextActions: ["Continue from the current goal."],
        },
        internal_payload: {
          source_refs: ["session:agent:raw"],
        },
      }),
    }));

    const result = await dispatchGatewayChatInput(baseInput);

    expect(result).toContain("The gateway answer is ready.");
    expect(result).toContain("Read the current status projection.");
    expect(result).toContain("Checked the public status projection.");
    expect(result).toContain("No user action is needed.");
    expect(result).toContain("Continue from the current goal.");
    for (const marker of [
      "RAW_MEMORY_SLOT",
      "autonomy=approval_required",
      "readiness=degraded",
      "admission=approval_required",
      "policy:deny",
      "capability:notify",
      "evidence:raw",
      "trace:raw",
      "run:coreloop:raw",
      "session:agent:raw",
      "internal_payload",
    ]) {
      expect(result).not.toContain(marker);
    }
  });

  it("does not invent display text for unwrappable manager objects", async () => {
    registerGatewayChatSessionPort(async () => ({
      processIncomingMessage: async () => ({ internal_payload: { raw: true } }),
    }));

    await expect(dispatchGatewayChatInput(baseInput)).resolves.toBeNull();
    await expect(dispatchGatewayChatInputResult(baseInput)).resolves.toEqual({
      status: "empty",
      error: "Gateway chat dispatcher did not return displayable assistant text.",
    });
  });

  it("returns an explicit error result when the dispatcher fails", async () => {
    registerGatewayChatSessionPort(async () => ({
      processIncomingMessage: async () => {
        throw new Error("session port unavailable");
      },
    }));

    await expect(dispatchGatewayChatInputResult(baseInput)).resolves.toEqual({
      status: "error",
      error: "session port unavailable",
    });
    await expect(dispatchGatewayChatInput(baseInput)).resolves.toBeNull();
  });

  it("preserves typed external surface boundaries through gateway chat dispatch", async () => {
    const context = { platform: "telegram", senderId: "user-1", conversationId: "chat-1" };
    const access = evaluateChannelAccess({ allowAll: true }, context);
    const route = resolveChannelRoute({ defaultGoalId: "goal-1" }, context);
    const externalSurface = buildExternalSurfaceDecision(context, access, route);
    const received: { current?: GatewayChatDispatchInput } = {};
    registerGatewayChatSessionPort(async () => ({
      processIncomingMessage: async (input) => {
        received.current = input;
        return "ok";
      },
    }));

    await dispatchGatewayChatInput({
      ...baseInput,
      externalSurface,
      metadata: { routed_goal_id: "goal-1" },
    });

    expect(received.current?.externalSurface).toEqual(externalSurface);
    expect(received.current?.metadata?.external_surface).toEqual(externalSurface);
    expect(received.current?.externalSurface?.notification_route_policy).toMatchObject({
      configured: true,
      may_notify: false,
    });
    expect(received.current?.externalSurface?.autonomy_authority.may_initiate).toBe(false);
  });

  it("does not promote metadata-only external surfaces into trusted dispatch context", async () => {
    const context = { platform: "telegram", senderId: "user-1", conversationId: "chat-1" };
    const externalSurface = buildExternalSurfaceDecision(
      context,
      evaluateChannelAccess({ allowAll: true, runtimeControlAllowedSenderIds: ["user-1"] }, context),
      resolveChannelRoute({ defaultGoalId: "goal-1" }, context)
    );
    const received: { current?: GatewayChatDispatchInput } = {};
    registerGatewayChatSessionPort(async () => ({
      processIncomingMessage: async (input) => {
        received.current = input;
        return "ok";
      },
    }));

    await dispatchGatewayChatInput({
      ...baseInput,
      metadata: {
        external_surface: externalSurface,
        runtime_control_approved: true,
      },
    });

    expect(received.current?.externalSurface).toBeUndefined();
    expect(received.current?.metadata?.external_surface).toBeUndefined();
    expect(received.current?.metadata?.runtime_control_approved).toBe(true);
  });

  it("does not trust operator/debug projections returned by a gateway session port", async () => {
    const operatorProjection = createSurfaceProjection({
      surface: "gateway",
      view: "operator_debug",
      purpose: "Debug-only gateway trace.",
      redaction_class: "operator_debug",
      projected_at: "2026-05-17T00:00:00.000Z",
      replay_key: "gateway:operator-debug",
      source_event_refs: [operatorSourceEventRef({
        kind: "runtime_trace",
        ref: "trace:raw",
        event_type: "debug_trace",
      })],
      panels: [{ panel_id: "debug", body: "Debug output" }],
    });
    registerGatewayChatSessionPort(async () => ({
      processIncomingMessage: async () => ({
        text: "Normal reply.",
        surface_projection: operatorProjection,
      }),
    }));

    const result = await dispatchGatewayChatInputResult(baseInput);

    expect(result).toMatchObject({
      status: "ok",
      text: "Normal reply.",
      surface_projection: expect.objectContaining({
        surface: "gateway",
        view: "normal",
      }),
    });
    if (result.status === "ok") {
      expect(result.surface_projection?.operator_debug_view).toBeUndefined();
      expect(result.surface_projection?.source_event_refs).toEqual(expect.arrayContaining([
        expect.objectContaining({ visibility: "normal_safe" }),
      ]));
    }
  });

  it("renders denied typed tool observations as gateway display text", () => {
    const result = renderGatewayAgentTimelineItem({
      id: "agent-timeline:observation-1",
      sourceEventId: "observation-1",
      sourceType: "tool_observation",
      sessionId: "session-1",
      traceId: "trace-1",
      turnId: "turn-1",
      goalId: "goal-1",
      createdAt: "2026-05-10T00:00:00.000Z",
      visibility: "user",
      kind: "tool_observation",
      callId: "call-1",
      toolName: "apply_patch",
      state: "denied",
      success: false,
      outputPreview: "TOOL NOT EXECUTED (approval_denied): write access was denied.",
      durationMs: 1,
      observation: {
        type: "tool_observation",
        callId: "call-1",
        toolName: "apply_patch",
        arguments: {},
        state: "denied",
        success: false,
        execution: {
          status: "not_executed",
          reason: "approval_denied",
          message: "write access was denied.",
        },
        durationMs: 1,
        output: {
          content: "TOOL NOT EXECUTED (approval_denied): write access was denied.",
        },
      },
    });

    expect(result).toBe("Blocked on the requested tool action: write access was denied.");
    expect(result).not.toContain("Approval is needed");
    expect(result).not.toContain("\"observation\"");
    expect(result).not.toContain("TOOL NOT EXECUTED");
  });
});
