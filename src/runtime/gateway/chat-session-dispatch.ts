import {
  getRegisteredGatewayChatSessionPort,
  type GatewayChatDispatchInput,
} from "./chat-session-port.js";
import { normalizeAssistantDisplayText } from "../../orchestrator/execution/agent-loop/chat-display-output.js";
import { EXTERNAL_SURFACE_METADATA_KEY } from "./channel-policy.js";

export type { GatewayChatDispatchInput } from "./chat-session-port.js";

export async function dispatchGatewayChatInput(
  input: GatewayChatDispatchInput
): Promise<string | null> {
  try {
    const portGetter = getRegisteredGatewayChatSessionPort();
    if (!portGetter) return null;
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
    return normalizeManagerResult(result);
  } catch {
    return null;
  }
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
