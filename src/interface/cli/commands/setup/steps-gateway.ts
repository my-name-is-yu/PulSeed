import * as p from "@clack/prompts";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readJsonFileOrNull, writeJsonFileAtomic } from "../../../../base/utils/json-io.js";
import { getGatewayChannelDir } from "../../../../base/utils/paths.js";
import {
  BUILTIN_GATEWAY_CHANNEL_NAMES,
  type BuiltinGatewayChannelName,
} from "../../../../runtime/gateway/builtin-channel-names.js";
import type { TelegramGatewayConfig } from "../../../../runtime/gateway/telegram-gateway-adapter.js";
import type { DiscordGatewayConfig } from "../../../../runtime/gateway/discord-gateway-adapter.js";
import type { WhatsAppGatewayConfig } from "../../../../runtime/gateway/whatsapp-gateway-adapter.js";
import type { SignalGatewayConfig } from "../../../../runtime/gateway/signal-gateway-adapter.js";
import { guardCancel } from "./utils.js";

interface TelegramVerifyResponse {
  ok: boolean;
  result?: {
    id: number;
    username?: string;
    first_name: string;
  };
}

export interface GatewayChannelConfigs {
  "telegram-bot"?: TelegramGatewayConfig;
  "discord-bot"?: DiscordGatewayConfig;
  "whatsapp-webhook"?: WhatsAppGatewayConfig;
  "signal-bridge"?: SignalGatewayConfig;
}

export interface GatewaySetupResult {
  selectedChannels: BuiltinGatewayChannelName[];
  channelConfigs: GatewayChannelConfigs;
}

export async function stepGatewayChannels(baseDir: string): Promise<GatewaySetupResult | null> {
  const existingSummary = await summarizeExistingGatewayChannels(baseDir);
  p.note(formatExistingGatewaySummary(existingSummary), "Configured messaging channels");

  const selectedChannels = guardCancel(
    await p.multiselect<BuiltinGatewayChannelName>({
      message: "Which messaging platforms should PulSeed configure now?",
      required: false,
      options: BUILTIN_GATEWAY_CHANNEL_NAMES.map((channelName) => ({
        value: channelName,
        label: gatewayChannelLabel(channelName),
        hint: existingSummary[channelName],
      })),
    })
  );

  if (selectedChannels.length === 0) {
    return null;
  }

  const channelConfigs: GatewayChannelConfigs = {};

  for (const channelName of selectedChannels) {
    switch (channelName) {
      case "telegram-bot":
        channelConfigs["telegram-bot"] = await promptTelegramChannelConfig(baseDir);
        break;
      case "discord-bot":
        channelConfigs["discord-bot"] = await promptDiscordChannelConfig(baseDir);
        break;
      case "whatsapp-webhook":
        channelConfigs["whatsapp-webhook"] = await promptWhatsAppChannelConfig(baseDir);
        break;
      case "signal-bridge":
        channelConfigs["signal-bridge"] = await promptSignalChannelConfig(baseDir);
        break;
    }
  }

  return { selectedChannels, channelConfigs };
}

export async function saveGatewayChannels(baseDir: string, setup: GatewaySetupResult): Promise<string[]> {
  const savedPaths: string[] = [];

  for (const channelName of setup.selectedChannels) {
    const config = setup.channelConfigs[channelName];
    if (!config) continue;
    const configPath = path.join(getGatewayChannelDir(channelName, baseDir), "config.json");
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await writeJsonFileAtomic(configPath, config);
    savedPaths.push(configPath);
  }

  return savedPaths;
}

export function formatGatewaySetupSummary(setup: GatewaySetupResult | null | undefined): string {
  if (!setup || setup.selectedChannels.length === 0) {
    return "none";
  }
  return setup.selectedChannels.map(gatewayChannelLabel).join(", ");
}

async function summarizeExistingGatewayChannels(baseDir: string): Promise<Record<BuiltinGatewayChannelName, string>> {
  const entries = await Promise.all(
    BUILTIN_GATEWAY_CHANNEL_NAMES.map(async (channelName) => {
      const config = await readJsonFileOrNull<Record<string, unknown>>(path.join(getGatewayChannelDir(channelName, baseDir), "config.json"));
      const summary = config ? summarizeChannelConfig(channelName, config) : "not configured";
      return [channelName, summary] as const;
    })
  );
  return Object.fromEntries(entries) as Record<BuiltinGatewayChannelName, string>;
}

function gatewayChannelLabel(channelName: BuiltinGatewayChannelName): string {
  switch (channelName) {
    case "telegram-bot":
      return "Telegram";
    case "discord-bot":
      return "Discord";
    case "whatsapp-webhook":
      return "WhatsApp";
    case "signal-bridge":
      return "Signal";
  }
}

function formatExistingGatewaySummary(summary: Record<BuiltinGatewayChannelName, string>): string {
  return BUILTIN_GATEWAY_CHANNEL_NAMES
    .map((channelName) => `${gatewayChannelLabel(channelName)}: ${summary[channelName]}`)
    .join("\n");
}

function summarizeChannelConfig(channelName: BuiltinGatewayChannelName, config: Record<string, unknown>): string {
  switch (channelName) {
    case "telegram-bot":
      return typeof config["bot_token"] === "string"
        ? `configured (${typeof config["chat_id"] === "number" ? "home chat set" : "/sethome later"})`
        : "not configured";
    case "discord-bot":
      return typeof config["application_id"] === "string"
        ? `configured (${String(config["host"] ?? "127.0.0.1")}:${String(config["port"] ?? 8787)})`
        : "not configured";
    case "whatsapp-webhook":
      return typeof config["phone_number_id"] === "string"
        ? `configured (${String(config["host"] ?? "127.0.0.1")}:${String(config["port"] ?? 8788)}${String(config["path"] ?? "/webhook")})`
        : "not configured";
    case "signal-bridge":
      return typeof config["bridge_url"] === "string"
        ? `configured (${String(config["bridge_url"])})`
        : "not configured";
  }
}

async function promptTelegramChannelConfig(baseDir: string): Promise<TelegramGatewayConfig> {
  p.note(
    [
      "Hermes-style Telegram onboarding:",
      "1. Enter a bot token from @BotFather",
      "2. Optionally restrict by Telegram user ID",
      "3. Optionally defer the home chat and use /sethome later",
    ].join("\n"),
    "Telegram"
  );

  const configPath = path.join(getGatewayChannelDir("telegram-bot", baseDir), "config.json");
  const current = await readJsonFileOrNull<TelegramGatewayConfig>(configPath);
  const token = await promptTelegramBotToken(current?.bot_token);
  const allowedUserIds = parseIntegerList(
    guardCancel(
      await p.text({
        message: "Allowed Telegram user IDs (comma-separated, blank = allow all)",
        placeholder: "123456789,987654321",
        initialValue: current?.allowed_user_ids.join(",") ?? "",
      })
    )
  );
  const chatIdInput = guardCancel(
    await p.text({
      message: "Home chat ID (optional, blank = use /sethome later)",
      placeholder: "-1001234567890",
      initialValue: current?.chat_id !== undefined ? String(current.chat_id) : "",
      validate: (value) => {
        if (value === undefined) return "Chat ID is required.";
        if (value.trim().length === 0) return undefined;
        return Number.isInteger(Number(value)) ? undefined : "Chat ID must be an integer.";
      },
    })
  );
  const identityKey = guardCancel(
    await p.text({
      message: "Identity key (optional, same key shares a session across platforms)",
      placeholder: "personal",
      initialValue: current?.identity_key ?? "",
    })
  ).trim();

  return {
    bot_token: token,
    ...(chatIdInput.trim().length > 0 ? { chat_id: Number(chatIdInput) } : {}),
    allowed_user_ids: allowedUserIds,
    denied_user_ids: current?.denied_user_ids ?? [],
    allowed_chat_ids: current?.allowed_chat_ids ?? [],
    denied_chat_ids: current?.denied_chat_ids ?? [],
    runtime_control_allowed_user_ids: allowedUserIds,
    chat_goal_map: current?.chat_goal_map ?? {},
    user_goal_map: current?.user_goal_map ?? {},
    default_goal_id: current?.default_goal_id,
    allow_all: allowedUserIds.length === 0,
    polling_timeout: current?.polling_timeout ?? 30,
    ...(identityKey ? { identity_key: identityKey } : {}),
  };
}

async function promptDiscordChannelConfig(baseDir: string): Promise<DiscordGatewayConfig> {
  p.note(
    [
      "Hermes-style Discord flow, adapted to PulSeed's current adapter:",
      "1. Create a Discord application and bot",
      "2. Enable Message Content + Server Members intents",
      "3. Point Discord interactions at the configured host/port through a tunnel or reverse proxy",
    ].join("\n"),
    "Discord"
  );

  const configPath = path.join(getGatewayChannelDir("discord-bot", baseDir), "config.json");
  const current = await readJsonFileOrNull<DiscordGatewayConfig>(configPath);
  const applicationId = await promptRequiredText("Discord application ID", current?.application_id);
  const botToken = await promptRequiredText("Discord bot token", current?.bot_token);
  const channelId = await promptRequiredText("Home channel ID for notifications", current?.channel_id);
  const publicKeyHex = guardCancel(
    await p.text({
      message: "Discord public key (optional, recommended for request verification)",
      placeholder: "hex string",
      initialValue: current?.public_key_hex ?? "",
    })
  ).trim();
  const allowedSenderIds = parseStringList(
    guardCancel(
      await p.text({
        message: "Allowed Discord user IDs (comma-separated, blank = allow all)",
        placeholder: "123456789012345678",
        initialValue: current?.allowed_sender_ids.join(",") ?? "",
      })
    )
  );
  const identityKey = await promptRequiredText("Identity key", current?.identity_key ?? "personal");
  const commandName = await promptRequiredText("Slash command name", current?.command_name ?? "pulseed");
  const host = await promptRequiredText("Webhook bind host", current?.host ?? "127.0.0.1");
  const port = await promptInteger("Webhook bind port", current?.port ?? 8787, 1024, 65535);
  const ephemeral = guardCancel(
    await p.confirm({
      message: "Use ephemeral slash-command replies?",
      initialValue: current?.ephemeral ?? false,
    })
  );

  return {
    application_id: applicationId,
    ...(publicKeyHex ? { public_key_hex: publicKeyHex } : {}),
    bot_token: botToken,
    channel_id: channelId,
    identity_key: identityKey,
    allowed_sender_ids: allowedSenderIds,
    denied_sender_ids: current?.denied_sender_ids ?? [],
    allowed_conversation_ids: current?.allowed_conversation_ids ?? [],
    denied_conversation_ids: current?.denied_conversation_ids ?? [],
    runtime_control_allowed_sender_ids: allowedSenderIds,
    conversation_goal_map: current?.conversation_goal_map ?? {},
    sender_goal_map: current?.sender_goal_map ?? {},
    default_goal_id: current?.default_goal_id,
    command_name: commandName,
    host,
    port,
    ephemeral,
  };
}

async function promptWhatsAppChannelConfig(baseDir: string): Promise<WhatsAppGatewayConfig> {
  p.note(
    [
      "PulSeed currently uses WhatsApp Cloud API webhook setup.",
      "This differs from Hermes's Baileys bridge, but the setup flow stays centralized in one wizard.",
    ].join("\n"),
    "WhatsApp"
  );

  const configPath = path.join(getGatewayChannelDir("whatsapp-webhook", baseDir), "config.json");
  const current = await readJsonFileOrNull<WhatsAppGatewayConfig>(configPath);
  const phoneNumberId = await promptRequiredText("WhatsApp phone number ID", current?.phone_number_id);
  const accessToken = await promptRequiredText("WhatsApp access token", current?.access_token);
  const verifyToken = await promptRequiredText("WhatsApp verify token", current?.verify_token);
  const recipientId = await promptRequiredText("Default recipient ID for notifications", current?.recipient_id);
  const appSecret = guardCancel(
    await p.text({
      message: "Meta app secret (optional, enables webhook signature verification)",
      initialValue: current?.app_secret ?? "",
    })
  ).trim();
  const allowedSenderIds = parseStringList(
    guardCancel(
      await p.text({
        message: "Allowed WhatsApp sender IDs (comma-separated, blank = allow all)",
        placeholder: "15551234567",
        initialValue: current?.allowed_sender_ids.join(",") ?? "",
      })
    )
  );
  const identityKey = await promptRequiredText("Identity key", current?.identity_key ?? "personal");
  const host = await promptRequiredText("Webhook bind host", current?.host ?? "127.0.0.1");
  const port = await promptInteger("Webhook bind port", current?.port ?? 8788, 1024, 65535);
  const webhookPath = await promptRequiredText("Webhook path", current?.path ?? "/webhook");

  return {
    phone_number_id: phoneNumberId,
    access_token: accessToken,
    verify_token: verifyToken,
    recipient_id: recipientId,
    identity_key: identityKey,
    allowed_sender_ids: allowedSenderIds,
    denied_sender_ids: current?.denied_sender_ids ?? [],
    runtime_control_allowed_sender_ids: allowedSenderIds,
    sender_goal_map: current?.sender_goal_map ?? {},
    default_goal_id: current?.default_goal_id,
    host,
    port,
    path: webhookPath,
    ...(appSecret ? { app_secret: appSecret } : {}),
  };
}

async function promptSignalChannelConfig(baseDir: string): Promise<SignalGatewayConfig> {
  p.note(
    [
      "Hermes-style Signal usage usually starts with a linked device and a local signal-cli daemon.",
      "PulSeed expects a running bridge endpoint and will poll it for messages.",
    ].join("\n"),
    "Signal"
  );

  const configPath = path.join(getGatewayChannelDir("signal-bridge", baseDir), "config.json");
  const current = await readJsonFileOrNull<SignalGatewayConfig>(configPath);
  const bridgeUrl = await promptRequiredText("Signal bridge URL", current?.bridge_url ?? "http://127.0.0.1:8080");
  const account = await promptRequiredText("Signal account number", current?.account);
  const recipientId = await promptRequiredText("Default recipient ID", current?.recipient_id ?? account);
  const allowedSenderIds = parseStringList(
    guardCancel(
      await p.text({
        message: "Allowed Signal sender IDs (comma-separated, blank = allow all)",
        placeholder: "+15551234567",
        initialValue: current?.allowed_sender_ids.join(",") ?? "",
      })
    )
  );
  const allowedConversationIds = parseStringList(
    guardCancel(
      await p.text({
        message: "Allowed Signal conversation IDs (optional)",
        placeholder: "group-id-1,group-id-2",
        initialValue: current?.allowed_conversation_ids.join(",") ?? "",
      })
    )
  );
  const identityKey = await promptRequiredText("Identity key", current?.identity_key ?? "personal");
  const pollInterval = await promptInteger("Poll interval (ms)", current?.poll_interval_ms ?? 5000, 1000, 60000);
  const receiveTimeout = await promptInteger("Receive timeout (ms)", current?.receive_timeout_ms ?? 2000, 250, 60000);

  return {
    bridge_url: bridgeUrl,
    account,
    recipient_id: recipientId,
    identity_key: identityKey,
    allowed_sender_ids: allowedSenderIds,
    denied_sender_ids: current?.denied_sender_ids ?? [],
    allowed_conversation_ids: allowedConversationIds,
    denied_conversation_ids: current?.denied_conversation_ids ?? [],
    runtime_control_allowed_sender_ids: allowedSenderIds,
    conversation_goal_map: current?.conversation_goal_map ?? {},
    sender_goal_map: current?.sender_goal_map ?? {},
    default_goal_id: current?.default_goal_id,
    poll_interval_ms: pollInterval,
    receive_timeout_ms: receiveTimeout,
  };
}

async function promptTelegramBotToken(initialToken?: string): Promise<string> {
  for (;;) {
    const token = guardCancel(
      await p.text({
        message: "Telegram bot token",
        placeholder: "1234567890:AA...",
        initialValue: initialToken,
        validate: (value) => value !== undefined && value.trim().length > 0 ? undefined : "Bot token is required.",
      })
    ).trim();
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/getMe`);
      const payload = (await response.json()) as TelegramVerifyResponse;
      if (payload.ok && payload.result) {
        const displayName = payload.result.username ?? payload.result.first_name;
        p.log.success(`Verified Telegram bot @${displayName}`);
        return token;
      }
    } catch {
      // continue to retry
    }
    p.log.warn("Telegram token verification failed. Check the token and try again.");
  }
}

async function promptRequiredText(message: string, initialValue?: string): Promise<string> {
  return guardCancel(
    await p.text({
      message,
      initialValue,
      validate: (value) => value !== undefined && value.trim().length > 0 ? undefined : "This value is required.",
    })
  ).trim();
}

async function promptInteger(message: string, initialValue: number, min: number, max: number): Promise<number> {
  const value = guardCancel(
    await p.text({
      message,
      initialValue: String(initialValue),
      validate: (raw) => {
        const parsed = Number(raw);
        if (!Number.isInteger(parsed)) return "Enter a whole number.";
        if (parsed < min || parsed > max) return `Enter a value between ${min} and ${max}.`;
        return undefined;
      },
    })
  );
  return Number(value);
}

function parseStringList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseIntegerList(value: string): number[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item));
}
