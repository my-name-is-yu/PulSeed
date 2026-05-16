import {
  assertExternalAdapterIntegerInRange,
  assertExternalAdapterNonEmptyString,
  assertExternalAdapterStringArray,
  assertExternalAdapterStringMap,
  loadExternalAdapterConfigJson,
} from "pulseed";

const MIN_POLL_INTERVAL_MS = 1_000;
const MIN_RECEIVE_TIMEOUT_MS = 250;
const MAX_SIGNAL_TIMER_MS = 60_000;

export interface SignalBridgeConfig {
  bridge_url: string;
  account: string;
  recipient_id: string;
  identity_key: string;
  allowed_sender_ids: string[];
  denied_sender_ids: string[];
  allowed_conversation_ids: string[];
  denied_conversation_ids: string[];
  runtime_control_allowed_sender_ids: string[];
  conversation_goal_map: Record<string, string>;
  sender_goal_map: Record<string, string>;
  default_goal_id?: string;
  poll_interval_ms: number;
  receive_timeout_ms: number;
}

export function loadConfig(pluginDir: string): SignalBridgeConfig {
  return validateConfig(loadExternalAdapterConfigJson(pluginDir, "signal-bridge"));
}

function validateConfig(cfg: Record<string, unknown>): SignalBridgeConfig {
  const pollInterval = cfg["poll_interval_ms"] ?? 5000;
  const receiveTimeout = cfg["receive_timeout_ms"] ?? 2000;
  const runtimeControlAllowedSenderIds = cfg["runtime_control_allowed_sender_ids"] ?? [];
  const allowedSenderIds = cfg["allowed_sender_ids"] ?? cfg["allow_from"] ?? [];
  const deniedSenderIds = cfg["denied_sender_ids"] ?? cfg["deny_from"] ?? [];
  const allowedConversationIds = cfg["allowed_conversation_ids"] ?? [];
  const deniedConversationIds = cfg["denied_conversation_ids"] ?? [];
  const conversationGoalMap = cfg["conversation_goal_map"] ?? cfg["goal_routes"] ?? {};
  const senderGoalMap = cfg["sender_goal_map"] ?? {};

  assertExternalAdapterNonEmptyString(cfg["bridge_url"], "signal-bridge: bridge_url must be a non-empty string");
  assertExternalAdapterNonEmptyString(cfg["account"], "signal-bridge: account must be a non-empty string");
  assertExternalAdapterNonEmptyString(cfg["recipient_id"], "signal-bridge: recipient_id must be a non-empty string");
  assertExternalAdapterNonEmptyString(cfg["identity_key"], "signal-bridge: identity_key must be a non-empty string");
  assertExternalAdapterIntegerInRange(
    pollInterval,
    MIN_POLL_INTERVAL_MS,
    MAX_SIGNAL_TIMER_MS,
    `signal-bridge: poll_interval_ms must be a safe integer between ${MIN_POLL_INTERVAL_MS} and ${MAX_SIGNAL_TIMER_MS}`
  );
  assertExternalAdapterIntegerInRange(
    receiveTimeout,
    MIN_RECEIVE_TIMEOUT_MS,
    MAX_SIGNAL_TIMER_MS,
    `signal-bridge: receive_timeout_ms must be a safe integer between ${MIN_RECEIVE_TIMEOUT_MS} and ${MAX_SIGNAL_TIMER_MS}`
  );
  assertExternalAdapterStringArray(runtimeControlAllowedSenderIds, "signal-bridge: runtime_control_allowed_sender_ids must be an array of non-empty strings");
  for (const [key, value] of Object.entries({
    allowed_sender_ids: allowedSenderIds,
    denied_sender_ids: deniedSenderIds,
    allowed_conversation_ids: allowedConversationIds,
    denied_conversation_ids: deniedConversationIds,
  })) {
    assertExternalAdapterStringArray(value, `signal-bridge: ${key} must be an array of non-empty strings`);
  }
  for (const [key, value] of Object.entries({
    conversation_goal_map: conversationGoalMap,
    sender_goal_map: senderGoalMap,
  })) {
    assertExternalAdapterStringMap(value, `signal-bridge: ${key} must be an object mapping IDs to goal IDs`);
  }
  if (cfg["default_goal_id"] !== undefined) {
    assertExternalAdapterNonEmptyString(cfg["default_goal_id"], "signal-bridge: default_goal_id must be a non-empty string when set");
  }

  return {
    bridge_url: cfg["bridge_url"] as string,
    account: cfg["account"] as string,
    recipient_id: cfg["recipient_id"] as string,
    identity_key: cfg["identity_key"] as string,
    allowed_sender_ids: allowedSenderIds as string[],
    denied_sender_ids: deniedSenderIds as string[],
    allowed_conversation_ids: allowedConversationIds as string[],
    denied_conversation_ids: deniedConversationIds as string[],
    runtime_control_allowed_sender_ids: runtimeControlAllowedSenderIds as string[],
    conversation_goal_map: conversationGoalMap as Record<string, string>,
    sender_goal_map: senderGoalMap as Record<string, string>,
    default_goal_id: cfg["default_goal_id"] as string | undefined,
    poll_interval_ms: pollInterval,
    receive_timeout_ms: receiveTimeout,
  };
}
