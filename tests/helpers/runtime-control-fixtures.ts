import type { RuntimeControlChatContext } from "../../src/interface/chat/chat-runner-contracts.js";
import type { ChatRunnerRuntimeDeps } from "../../src/interface/chat/chat-runner-runtime.js";
import type {
  RuntimeControlActor,
  RuntimeControlReplyTarget,
} from "../../src/runtime/store/runtime-operation-schemas.js";

export function makeRuntimeControlActor(overrides: Partial<RuntimeControlActor> = {}): RuntimeControlActor {
  return {
    surface: "gateway",
    platform: "telegram",
    conversation_id: "conversation-1",
    identity_key: "owner",
    user_id: "user-1",
    ...overrides,
  };
}

export function makeRuntimeReplyTarget(overrides: Partial<RuntimeControlReplyTarget> = {}): RuntimeControlReplyTarget {
  return {
    surface: "gateway",
    platform: "telegram",
    conversation_id: "conversation-1",
    identity_key: "owner",
    user_id: "user-1",
    message_id: "message-1",
    deliveryMode: "thread_reply",
    ...overrides,
  };
}

export function makeRuntimeControlChatContext(
  overrides: Partial<RuntimeControlChatContext> = {},
): RuntimeControlChatContext {
  return {
    actor: makeRuntimeControlActor(),
    replyTarget: makeRuntimeReplyTarget(),
    allowed: true,
    approvalMode: "interactive",
    explicit: true,
    approvalFn: async () => true,
    ...overrides,
  };
}

export function makeChatRunnerRuntimeDeps(
  overrides: Partial<ChatRunnerRuntimeDeps> = {},
): ChatRunnerRuntimeDeps {
  return {
    stateManager: {
      readRaw: async () => null,
    },
    ...overrides,
  };
}
