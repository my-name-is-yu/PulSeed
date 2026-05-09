import type { UserInput } from "../../interface/chat/user-input.js";
import type { ExternalSurfaceDecision } from "./channel-policy.js";

export type GatewayChatEventHandler = <T extends { type?: unknown; text?: unknown }>(event: T) => void | Promise<void>;

export interface GatewayChatDispatchInput {
  text: string;
  userInput?: UserInput;
  platform: string;
  identity_key?: string;
  conversation_id: string;
  sender_id: string;
  message_id?: string;
  goal_id?: string;
  cwd?: string;
  metadata?: Record<string, unknown>;
  externalSurface?: ExternalSurfaceDecision;
  onEvent?: GatewayChatEventHandler;
}

export interface GatewayChatSessionPort {
  processIncomingMessage(input: GatewayChatDispatchInput): Promise<unknown>;
}

export type GatewayChatSessionPortGetter = () => Promise<GatewayChatSessionPort>;

interface PulseedRuntimeGlobal {
  __pulseedGetGlobalCrossPlatformChatSessionManager?: GatewayChatSessionPortGetter;
}

let registeredGetter: GatewayChatSessionPortGetter | undefined;

export function registerGatewayChatSessionPort(getter: GatewayChatSessionPortGetter): void {
  registeredGetter = getter;
}

export function getRegisteredGatewayChatSessionPort(): GatewayChatSessionPortGetter | undefined {
  return registeredGetter;
}

export function exposeRegisteredGatewayChatSessionPort(): void {
  const runtimeGlobal = globalThis as typeof globalThis & PulseedRuntimeGlobal;
  if (registeredGetter) {
    runtimeGlobal.__pulseedGetGlobalCrossPlatformChatSessionManager = registeredGetter;
    return;
  }
  delete runtimeGlobal.__pulseedGetGlobalCrossPlatformChatSessionManager;
}

export function clearRegisteredGatewayChatSessionPort(): void {
  registeredGetter = undefined;
  delete (globalThis as typeof globalThis & PulseedRuntimeGlobal).__pulseedGetGlobalCrossPlatformChatSessionManager;
}
