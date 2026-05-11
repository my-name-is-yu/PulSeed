import {
  getRegisteredGatewayChatSessionPort,
  type GatewayChatDispatchInput,
} from "./chat-session-port.js";
import { normalizeAssistantDisplayText } from "../../orchestrator/execution/agent-loop/chat-display-output.js";
import { EXTERNAL_SURFACE_METADATA_KEY } from "./channel-policy.js";

export type { GatewayChatDispatchInput } from "./chat-session-port.js";

export type GatewayChatDispatchResult =
  | { status: "ok"; text: string }
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
    const text = normalizeManagerResult(result);
    if (text === null) {
      return {
        status: "empty",
        error: "Gateway chat dispatcher did not return displayable assistant text.",
      };
    }
    return { status: "ok", text };
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

function normalizeManagerResult(result: unknown): string | null {
  if (typeof result === "string") {
    return normalizeAssistantDisplayText({ finalText: result, output: null });
  }
  if (typeof result === "object" && result !== null) {
    return normalizeAssistantDisplayText({ output: result as Record<string, unknown> });
  }
  return null;
}
