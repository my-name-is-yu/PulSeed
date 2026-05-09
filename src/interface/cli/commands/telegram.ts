// ─── pulseed telegram setup — Telegram Bot gateway configuration wizard ───
//
// Guides the user through configuring the Telegram Bot gateway channel:
//   1. Bot token (from @BotFather) — verified via getMe API
//   2. allowed_user_ids (optional, comma-separated)
//   3. home chat_id (optional) — can be set later by sending /sethome
//   4. identity_key (optional) — share one PulSeed session across chat platforms
//
// Writes config to ~/.pulseed/gateway/channels/telegram-bot/config.json

import * as readline from "node:readline";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { getGatewayChannelDir } from "../../../base/utils/paths.js";
import { parseExactTelegramInteger, parseTelegramIntegerList } from "./telegram-id-parser.js";

// ─── Readline helpers ───

function createInterface(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

async function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

// ─── Telegram API verification ───

interface TelegramUser {
  id: number;
  username?: string;
  first_name: string;
}

interface TelegramGetMeResponse {
  ok: boolean;
  result?: TelegramUser;
  description?: string;
}

async function verifyBotToken(token: string): Promise<TelegramUser | null> {
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = (await resp.json()) as TelegramGetMeResponse;
    if (data.ok && data.result) {
      return data.result;
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Gateway channel directory helpers ───

function getChannelDir(): string {
  return getGatewayChannelDir("telegram-bot");
}

async function ensureChannelDir(channelDir: string): Promise<void> {
  await fsp.mkdir(channelDir, { recursive: true });
}

const TELEGRAM_SETUP_HELP_TEXT = `
Usage: pulseed telegram setup

Interactive Telegram Bot gateway setup.

What it configures:
  - Bot token from @BotFather
  - Allowed Telegram user IDs
  - Runtime-control user IDs
  - Optional home chat ID, or set it later with /sethome
  - Optional cross-platform identity key

After setup:
  pulseed daemon start
  pulseed daemon status
  Send /sethome to the bot if you skipped home chat setup.
`.trim();

const TELEGRAM_HELP_TEXT = `
Usage: pulseed telegram <command>

Telegram Bot gateway commands.

Available commands:
  setup    Configure the Telegram Bot gateway channel

Common next steps:
  pulseed telegram setup
  pulseed telegram setup --help
  pulseed daemon start
  pulseed daemon status
`.trim();

function isHelpRequest(arg: string | undefined): boolean {
  return arg === undefined || arg === "--help" || arg === "-h" || arg === "help";
}

// ─── Public entry point ───

export async function cmdTelegram(args: string[]): Promise<number> {
  const subcommand = args[0];
  if (isHelpRequest(subcommand)) {
    console.log(TELEGRAM_HELP_TEXT);
    return 0;
  }

  if (subcommand === "setup") {
    return cmdTelegramSetup(args.slice(1));
  }

  console.error(`Unknown telegram subcommand: "${subcommand}"`);
  console.error("Available: telegram setup");
  return 1;
}

export async function cmdTelegramSetup(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(TELEGRAM_SETUP_HELP_TEXT);
    return 0;
  }

  console.log("\nPulSeed — Telegram Bot Setup\n");

  const rl = createInterface();

  try {
    // Step 1: Bot token
    console.log("Step 1: Bot token");
    console.log("  Create a bot via @BotFather on Telegram and copy the token.\n");

    const token = await ask(rl, "Enter bot token: ");
    if (!token) {
      console.error("Error: bot token cannot be empty.");
      return 1;
    }

    process.stdout.write("  Verifying token...");
    const botInfo = await verifyBotToken(token);
    if (!botInfo) {
      console.log(" failed.");
      console.error("Error: token verification failed. Check the token and try again.");
      return 1;
    }
    console.log(` OK (@${botInfo.username ?? botInfo.first_name})\n`);

    // Step 2: allowed_user_ids (optional)
    console.log("\nStep 2: Allowed user IDs (recommended)");
    console.log("  Comma-separated Telegram user IDs that may send commands to the bot.");
    console.log("  Hermes-style setup uses user IDs for access control instead of requiring chat_id up front.");
    console.log("  Message @userinfobot if you need your numeric user ID.\n");

    const allowedStr = await ask(rl, "Allowed user IDs (e.g. 123456,789012) or press Enter to bind first /sethome sender later: ");
    const allowedResult = parseTelegramIntegerList(allowedStr);
    if (!allowedResult.ok) {
      console.error(`Error: allowed user IDs must be comma-separated exact integers. Invalid value: ${allowedResult.invalidValue || "(empty)"}.`);
      return 1;
    }
    const allowedUserIds = allowedResult.values;
    let allowAll = false;
    if (allowedUserIds.length === 0) {
      console.log("\nNo allowed users were entered. By default, PulSeed will keep Telegram chat access closed until the first /sethome sender is bound.");
      const unrestricted = await ask(rl, "Type ALLOW ALL to intentionally allow any Telegram user who can reach this bot: ");
      allowAll = unrestricted === "ALLOW ALL";
    }

    console.log("\nRuntime control (optional)");
    console.log("  Runtime-control permission is separate from ordinary Telegram chat access.");
    console.log("  Leave blank to disable Telegram runtime-control approval.\n");
    const runtimeControlStr = await ask(rl, "Runtime-control user IDs (comma-separated) or press Enter to disable: ");
    const runtimeControlResult = parseTelegramIntegerList(runtimeControlStr);
    if (!runtimeControlResult.ok) {
      console.error(`Error: runtime-control user IDs must be comma-separated exact integers. Invalid value: ${runtimeControlResult.invalidValue || "(empty)"}.`);
      return 1;
    }
    const runtimeControlAllowedUserIds = runtimeControlResult.values;

    // Step 3: home chat_id (optional)
    console.log("\nStep 3: Home chat (optional)");
    console.log("  Leave empty now, then send /sethome to the bot from Telegram after the daemon is running.");
    console.log("  Notifications will use that chat.\n");

    const chatIdStr = await ask(rl, "Home chat_id (number) or press Enter to set later with /sethome: ");
    let chatId: number | undefined;
    if (chatIdStr) {
      const parsed = parseExactTelegramInteger(chatIdStr);
      if (parsed === undefined) {
        console.error("Error: chat_id must be an exact integer when provided.");
        return 1;
      }
      chatId = parsed;
    }

    // Step 4: identity_key (optional)
    console.log("\nStep 4: Cross-platform identity (optional)");
    console.log("  Use the same key in Telegram, Discord, WhatsApp, and Signal configs");
    console.log("  when they should continue the same PulSeed chat session.");
    console.log("  Leave empty to keep this Telegram chat separate.\n");

    const identityKey = await ask(rl, "Identity key (e.g. personal) or press Enter to skip: ");

    // Step 5: Write config
    const channelDir = getChannelDir();
    await ensureChannelDir(channelDir);

    const config = {
      bot_token: token,
      allowed_user_ids: allowedUserIds,
      runtime_control_allowed_user_ids: runtimeControlAllowedUserIds,
      allow_all: allowAll,
      polling_timeout: 30,
      ...(chatId !== undefined ? { chat_id: chatId } : {}),
      ...(identityKey ? { identity_key: identityKey } : {}),
    };

    const configPath = path.join(channelDir, "config.json");
    await fsp.writeFile(configPath, JSON.stringify(config, null, 2), "utf8");

    // Summary
    console.log("\nTelegram Bot setup complete!");
    console.log(`  Config: ${configPath}`);
    console.log(`  Bot:    @${botInfo.username ?? botInfo.first_name}`);
    console.log(`  Home:   ${chatId !== undefined ? chatId : "(send /sethome to set later)"}`);
    if (allowedUserIds.length > 0) {
      console.log(`  Allowed users: ${allowedUserIds.join(", ")}`);
    } else if (allowAll) {
      console.log("  Allowed users: (all; explicitly confirmed)");
    } else {
      console.log("  Allowed users: (closed until first /sethome binding)");
    }
    if (identityKey) {
      console.log(`  Identity key: ${identityKey}`);
    } else {
      console.log("  Identity key: (not set)");
    }
    console.log(`  Runtime-control users: ${runtimeControlAllowedUserIds.length > 0 ? runtimeControlAllowedUserIds.join(", ") : "(disabled)"}`);
    console.log("\nThe daemon will pick this up automatically as a built-in gateway channel.");

    return 0;
  } finally {
    rl.close();
  }
}
