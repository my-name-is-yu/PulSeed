import {
  assertExternalAdapterBoolean,
  assertExternalAdapterIntegerInRange,
  assertExternalAdapterNonEmptyString,
  assertExternalAdapterStringArray,
  assertExternalAdapterStringMap,
  loadExternalAdapterConfigJson,
} from "pulseed";

const MIN_PORT = 1;
const MAX_PORT = 65_535;

export interface DiscordBotConfig {
  application_id: string;
  public_key_hex?: string;
  bot_token: string;
  channel_id: string;
  identity_key: string;
  allowed_sender_ids: string[];
  denied_sender_ids: string[];
  allowed_conversation_ids: string[];
  denied_conversation_ids: string[];
  runtime_control_allowed_sender_ids: string[];
  conversation_goal_map: Record<string, string>;
  sender_goal_map: Record<string, string>;
  default_goal_id?: string;
  command_name: string;
  host: string;
  port: number;
  ephemeral: boolean;
}

export function loadConfig(pluginDir: string): DiscordBotConfig {
  return validateConfig(loadExternalAdapterConfigJson(pluginDir, "discord-bot"));
}

function validateConfig(cfg: Record<string, unknown>): DiscordBotConfig {
  const commandName = cfg["command_name"] ?? "pulseed";
  const host = cfg["host"] ?? "127.0.0.1";
  const port = cfg["port"] ?? 8787;
  const ephemeral = cfg["ephemeral"] ?? false;
  const runtimeControlAllowedSenderIds = cfg["runtime_control_allowed_sender_ids"] ?? [];
  const allowedSenderIds = cfg["allowed_sender_ids"] ?? cfg["allow_from"] ?? [];
  const deniedSenderIds = cfg["denied_sender_ids"] ?? cfg["deny_from"] ?? [];
  const allowedConversationIds = cfg["allowed_conversation_ids"] ?? [];
  const deniedConversationIds = cfg["denied_conversation_ids"] ?? [];
  const conversationGoalMap = cfg["conversation_goal_map"] ?? cfg["goal_routes"] ?? {};
  const senderGoalMap = cfg["sender_goal_map"] ?? {};

  assertExternalAdapterNonEmptyString(cfg["application_id"], "discord-bot: application_id must be a non-empty string");
  assertExternalAdapterNonEmptyString(cfg["bot_token"], "discord-bot: bot_token must be a non-empty string");
  assertExternalAdapterNonEmptyString(cfg["channel_id"], "discord-bot: channel_id must be a non-empty string");
  assertExternalAdapterNonEmptyString(cfg["identity_key"], "discord-bot: identity_key must be a non-empty string");
  assertExternalAdapterNonEmptyString(commandName, "discord-bot: command_name must be a non-empty string");
  assertExternalAdapterNonEmptyString(host, "discord-bot: host must be a non-empty string");
  assertExternalAdapterIntegerInRange(port, MIN_PORT, MAX_PORT, `discord-bot: port must be a safe integer between ${MIN_PORT} and ${MAX_PORT}`);
  assertExternalAdapterBoolean(ephemeral, "discord-bot: ephemeral must be a boolean");
  assertExternalAdapterStringArray(runtimeControlAllowedSenderIds, "discord-bot: runtime_control_allowed_sender_ids must be an array of non-empty strings");
  for (const [key, value] of Object.entries({
    allowed_sender_ids: allowedSenderIds,
    denied_sender_ids: deniedSenderIds,
    allowed_conversation_ids: allowedConversationIds,
    denied_conversation_ids: deniedConversationIds,
  })) {
    assertExternalAdapterStringArray(value, `discord-bot: ${key} must be an array of non-empty strings`);
  }
  for (const [key, value] of Object.entries({
    conversation_goal_map: conversationGoalMap,
    sender_goal_map: senderGoalMap,
  })) {
    assertExternalAdapterStringMap(value, `discord-bot: ${key} must be an object mapping IDs to goal IDs`);
  }
  if (cfg["default_goal_id"] !== undefined) {
    assertExternalAdapterNonEmptyString(cfg["default_goal_id"], "discord-bot: default_goal_id must be a non-empty string when set");
  }
  if (cfg["public_key_hex"] !== undefined && typeof cfg["public_key_hex"] !== "string") {
    throw new Error("discord-bot: public_key_hex must be a string when set");
  }

  return {
    application_id: cfg["application_id"] as string,
    public_key_hex: cfg["public_key_hex"] as string | undefined,
    bot_token: cfg["bot_token"] as string,
    channel_id: cfg["channel_id"] as string,
    identity_key: cfg["identity_key"] as string,
    allowed_sender_ids: allowedSenderIds as string[],
    denied_sender_ids: deniedSenderIds as string[],
    allowed_conversation_ids: allowedConversationIds as string[],
    denied_conversation_ids: deniedConversationIds as string[],
    runtime_control_allowed_sender_ids: runtimeControlAllowedSenderIds as string[],
    conversation_goal_map: conversationGoalMap as Record<string, string>,
    sender_goal_map: senderGoalMap as Record<string, string>,
    default_goal_id: cfg["default_goal_id"] as string | undefined,
    command_name: commandName,
    host,
    port,
    ephemeral,
  };
}
