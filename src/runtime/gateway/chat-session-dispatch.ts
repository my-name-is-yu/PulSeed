import {
  getRegisteredGatewayChatSessionPort,
  type GatewayChatDispatchInput,
} from "./chat-session-port.js";
import { normalizeAssistantDisplayText } from "../../orchestrator/execution/agent-loop/chat-display-output.js";
import { EXTERNAL_SURFACE_METADATA_KEY } from "./channel-policy.js";
import {
  normalRuntimeGraphRef,
  normalSourceEventRef,
  projectTextSurface,
  SurfaceProjectionSchema,
  type SurfaceProjection,
} from "../surface-projection-protocol.js";

export type { GatewayChatDispatchInput } from "./chat-session-port.js";

export type GatewayChatDispatchResult =
  | { status: "ok"; text: string; surface_projection?: SurfaceProjection }
  | { status: "empty"; error: string }
  | { status: "error"; error: string };

export const GATEWAY_CHAT_DISPATCH_FAILURE_MESSAGE = "PulSeed could not complete this gateway turn. The message was received, but the chat dispatcher did not return a terminal assistant response.";

export function formatGatewayChatDispatchFailure(error: string): string {
  const detail = error.trim();
  if (!detail) return GATEWAY_CHAT_DISPATCH_FAILURE_MESSAGE;
  return `${GATEWAY_CHAT_DISPATCH_FAILURE_MESSAGE}\n\nError: ${detail}`;
}

export async function dispatchGatewayChatInputResult(
  input: GatewayChatDispatchInput
): Promise<GatewayChatDispatchResult> {
  try {
    const portGetter = getRegisteredGatewayChatSessionPort();
    if (!portGetter) {
      return {
        status: "error",
        error: "Gateway chat dispatcher is unavailable.",
      };
    }
    const port = await portGetter();
    const metadata = input.metadata ? { ...input.metadata } : undefined;
    if (metadata && !input.externalSurface) {
      delete metadata[EXTERNAL_SURFACE_METADATA_KEY];
    }
    if (metadata && input.externalSurface) {
      metadata[EXTERNAL_SURFACE_METADATA_KEY] = input.externalSurface;
    }
    const result = await port.processIncomingMessage({
      text: input.text,
      userInput: input.userInput,
      platform: input.platform,
      identity_key: input.identity_key,
      conversation_id: input.conversation_id,
      sender_id: input.sender_id,
      message_id: input.message_id,
      goal_id: input.goal_id,
      cwd: input.cwd,
      metadata,
      ...(input.externalSurface ? { externalSurface: input.externalSurface } : {}),
      onEvent: input.onEvent,
    });
    const normalized = normalizeManagerResult(result);
    if (normalized === null) {
      return {
        status: "empty",
        error: "Gateway chat dispatcher did not return displayable assistant text.",
      };
    }
    return {
      status: "ok",
      text: normalized.text,
      surface_projection: normalized.surfaceProjection ?? projectGatewayDispatchSurface(input, normalized.text),
    };
  } catch (error) {
    return {
      status: "error",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function dispatchGatewayChatInput(
  input: GatewayChatDispatchInput
): Promise<string | null> {
  const result = await dispatchGatewayChatInputResult(input);
  if (result.status !== "ok") {
    return null;
  }
  return result.text;
}

function normalizeManagerResult(result: unknown): { text: string; surfaceProjection?: SurfaceProjection } | null {
  if (typeof result === "string") {
    const text = normalizeAssistantDisplayText({ finalText: result, output: null });
    return text === null ? null : { text };
  }
  if (typeof result === "object" && result !== null) {
    const record = result as Record<string, unknown>;
    const parsedProjection = SurfaceProjectionSchema.safeParse(record["surface_projection"]);
    const text = normalizeAssistantDisplayText({ output: record });
    if (text === null) return null;
    const surfaceProjection = parsedProjection.success && parsedProjection.data.view === "normal"
      ? parsedProjection.data
      : undefined;
    return {
      text,
      ...(surfaceProjection ? { surfaceProjection } : {}),
    };
  }
  return null;
}

function projectGatewayDispatchSurface(input: GatewayChatDispatchInput, text: string): SurfaceProjection {
  const replayKey = [
    "gateway-chat-dispatch",
    input.platform,
    input.conversation_id,
    input.message_id ?? "no-message",
  ].join(":");
  return projectTextSurface({
    surface: "gateway",
    text,
    purpose: "gateway chat dispatch assistant output",
    projectedAt: new Date().toISOString(),
    replayKey,
    sourceEventRefs: [
      normalSourceEventRef({
        kind: "gateway_message",
        ref: `${input.platform}:${input.conversation_id}:${input.message_id ?? "no-message"}`,
        event_type: "assistant_final",
        replay_key: replayKey,
      }),
    ],
    runtimeGraphRefs: [
      normalRuntimeGraphRef({
        kind: "gateway_conversation",
        ref: `${input.platform}:${input.conversation_id}`,
        role: "target",
      }),
    ],
  });
}
